import { createHash } from "node:crypto";
import { buildModel } from "./build";
import modelsSourceJson from "./models.json" with { type: "text" };
import type { Api, Model, ModelSpec, Usage } from "./types";

/**
 * Static bundled model registry loaded from `models.json` (compile-time defaults).
 * For runtime-aware resolution, use `createModelManager()` or `resolveProviderModels()`.
 */

/**
 * Shape of the generated `models.json`, declared independently of the import:
 * the source arrives as text so its bytes can feed the snapshot fingerprint,
 * and parsing waits until a consumer actually builds the registry (a snapshot
 * hit never parses the catalog at all).
 */
type BundledProviderModels = { readonly [modelId: string]: ModelSpec<Api> };
type BundledModelsJson = { readonly [provider: string]: BundledProviderModels };

export type GeneratedProvider = Extract<keyof BundledModelsJson, string>;

// The json import resolves through the file itself rather than a sibling
// declaration, so its value arrives typed as the literal document; one cast
// pins it to the text this module treats it as.
const modelsSource = modelsSourceJson as unknown as string;

/**
 * Persisted enriched-registry snapshot format version. Bump whenever resolved
 * `buildModel` output contracts change to invalidate stale snapshots.
 */
const ENRICHED_REGISTRY_FORMAT_VERSION = 2;
let modelRegistry: Map<string, Map<string, Model<Api>>> | undefined;
let parsedModels: BundledModelsJson | undefined;
let catalogDigest: string | undefined;
/**
 * Persistence for the enriched registry, installed by whoever owns a profile
 * directory. This module stays a leaf on purpose: every consumer of the
 * bundled catalog imports it, so a filesystem and logging dependency here
 * lands in every one of those module graphs.
 */
export interface EnrichedRegistrySnapshotStore {
	read(fingerprint: string): Map<string, Map<string, Model<Api>>> | null;
	write(registry: Map<string, Map<string, Model<Api>>>, fingerprint: string): void;
}

let snapshotStore: EnrichedRegistrySnapshotStore | undefined;

export function setEnrichedRegistrySnapshotStore(store: EnrichedRegistrySnapshotStore | undefined): void {
	snapshotStore = store;
}

/**
 * Stable content digest of the bundled catalog text. Registry-level snapshots
 * (for example the coding-agent model registry's persisted static stage) fold
 * it into their fingerprints so a catalog regeneration invalidates them.
 */
export function bundledCatalogDigest(): string {
	catalogDigest ??= createHash("sha256").update(modelsSource).digest("hex");
	return catalogDigest;
}

/** Content hash of the bundled catalog plus the snapshot format version. */
export function enrichedRegistryFingerprint(): string {
	return `v${ENRICHED_REGISTRY_FORMAT_VERSION}:${bundledCatalogDigest()}`;
}

function buildRegistry(source: BundledModelsJson): Map<string, Map<string, Model<Api>>> {
	const registry = new Map<string, Map<string, Model<Api>>>();
	for (const [provider, models] of Object.entries(source)) {
		const providerModels = new Map<string, Model<Api>>();
		for (const [id, model] of Object.entries(models)) {
			providerModels.set(id, buildModel(model));
		}
		registry.set(provider, providerModels);
	}
	return registry;
}

/** Build (once) and return the enriched bundled-model registry. */
function getModelRegistry(): Map<string, Map<string, Model<Api>>> {
	if (modelRegistry !== undefined) return modelRegistry;
	const fingerprint = enrichedRegistryFingerprint();
	const restored = snapshotStore?.read(fingerprint) ?? null;
	if (restored) {
		modelRegistry = restored;
		return modelRegistry;
	}
	parsedModels ??= JSON.parse(modelsSource) as BundledModelsJson;
	modelRegistry = buildRegistry(parsedModels);
	snapshotStore?.write(modelRegistry, fingerprint);
	return modelRegistry;
}

export function getBundledModel<TApi extends Api = Api>(provider: GeneratedProvider, modelId: string): Model<TApi> {
	const providerModels = getModelRegistry().get(provider);
	return providerModels?.get(modelId) as Model<TApi>;
}

export function getBundledProviders(): GeneratedProvider[] {
	// Keys come from the built/restored registry rather than the raw source so a
	// snapshot hit answers without parsing the catalog text. JSON round-trips
	// preserve insertion order for non-numeric keys, so provider order matches
	// `Object.keys` on the source either way.
	return [...getModelRegistry().keys()];
}

export function getBundledModels(provider: GeneratedProvider): Model<Api>[] {
	const models = getModelRegistry().get(provider);
	return models ? ([...models.values()] as Model<Api>[]) : [];
}

/**
 * Model per-token pricing status, distinguishing known priced or free models
 * from unpriced models that lack pricing data.
 */
export type ModelPricing = "priced" | "free" | "unpriced";

/**
 * Checks for explicit `:free` model ID suffix markers used by providers like OpenRouter.
 */
function hasFreeMarker(modelId: string): boolean {
	return modelId.endsWith(":free");
}

/**
 * Classify model pricing into `"priced"`, `"free"`, or `"unpriced"` based on
 * cost values, metadata flags, and ID markers.
 */
export function getModelPricing<TApi extends Api>(
	model: Pick<Model<TApi>, "id" | "cost"> & { pricing?: "published" | "unknown" },
): ModelPricing {
	const cost = model.cost;
	if (cost && (cost.input > 0 || cost.output > 0)) return "priced";

	// A recorded fact beats a guess. Discovery marks `pricing: "unknown"` when the
	// upstream published nothing, and a model we were never told the price of is
	// not free however its id happens to end. Without this an OpenRouter-style
	// `:free` id arriving from a provider that simply omits pricing would be
	// announced as free on no evidence at all.
	if (model.pricing === "unknown") return "unpriced";

	// A zero cost the upstream DID publish is a real zero.
	if (model.pricing === "published") return "free";

	// No marker: the entry predates the field, so the id suffix is all there is.
	return hasFreeMarker(model.id) ? "free" : "unpriced";
}

export function calculateCost<TApi extends Api>(model: Model<TApi>, usage: Usage): Usage["cost"] {
	const orchestration = usage.orchestration;
	usage.cost.input = (model.cost.input / 1000000) * (usage.input + (orchestration?.input ?? 0));
	usage.cost.output = (model.cost.output / 1000000) * (usage.output + (orchestration?.output ?? 0));
	usage.cost.cacheRead = (model.cost.cacheRead / 1000000) * (usage.cacheRead + (orchestration?.cacheRead ?? 0));
	usage.cost.cacheWrite = (model.cost.cacheWrite / 1000000) * usage.cacheWrite;
	recomputeCostTotal(usage);
	return usage.cost;
}

/**
 * Sum {@link Usage.cost}'s total from input, output, cache buckets, and discarded attempts.
 */
export function recomputeCostTotal(usage: Usage): number {
	usage.cost.total =
		usage.cost.input +
		usage.cost.output +
		usage.cost.cacheRead +
		usage.cost.cacheWrite +
		(usage.discarded?.cost ?? 0);
	return usage.cost.total;
}

/**
 * Scale usage cost buckets by a provider billing multiplier (e.g. service tier)
 * and update `cost.total`.
 */
export function scaleUsageCost(usage: Usage, multiplier: number): void {
	if (multiplier === 1) return;
	usage.cost.input *= multiplier;
	usage.cost.output *= multiplier;
	usage.cost.cacheRead *= multiplier;
	usage.cost.cacheWrite *= multiplier;
	recomputeCostTotal(usage);
}

/**
 * Carry token counts and spend from discarded attempts (e.g. retries, aborted streams)
 * into replacement usage under `Usage.discarded`.
 */
export function discardAttemptUsage<TApi extends Api>(model: Model<TApi>, discarded: Usage, next: Usage): Usage {
	const billed = discarded.input + discarded.output + discarded.cacheRead + discarded.cacheWrite;
	const carried = discarded.discarded;
	if (billed === 0 && carried === undefined) return next;
	next.discarded ??= { attempts: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	const bucket = next.discarded;
	if (billed > 0) bucket.attempts += 1;
	bucket.attempts += carried?.attempts ?? 0;
	bucket.input += discarded.input + (carried?.input ?? 0);
	bucket.output += discarded.output + (carried?.output ?? 0);
	bucket.cacheRead += discarded.cacheRead + (carried?.cacheRead ?? 0);
	bucket.cacheWrite += discarded.cacheWrite + (carried?.cacheWrite ?? 0);
	bucket.cost += discardedAttemptCost(model, discarded);
	recomputeCostTotal(next);
	return next;
}

/**
 * Calculate the cost of a discarded attempt using existing cost totals or
 * computing from the serving model.
 */
function discardedAttemptCost<TApi extends Api>(model: Model<TApi>, discarded: Usage): number {
	if (discarded.cost.total !== 0) return discarded.cost.total;
	return calculateCost(model, { ...discarded, cost: emptyCost() }).total;
}

/**
 * Preserve discarded attempt accounting and premium request counts when replacing
 * usage objects during streaming updates.
 */
export function inheritUsageCarryovers(previous: Usage, next: Usage): Usage {
	if (previous.discarded !== undefined) next.discarded = previous.discarded;
	if (previous.premiumRequests !== undefined) next.premiumRequests ??= previous.premiumRequests;
	return next;
}

/**
 * A fresh, fully-zeroed {@link Usage.cost}: every cost bucket set to 0. This is
 * the ONE owner for the zeroed cost object providers install before
 * {@link calculateCost} overwrites it with real per-token costs. A new object
 * is returned on every call, so mutation never leaks between turns.
 */
export function emptyCost(): Usage["cost"] {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
}

/**
 * Returns true if any cost bucket (input, output, cacheRead, cacheWrite) is non-zero.
 */
export function hasBillableCost(cost: {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}): boolean {
	return cost.input !== 0 || cost.output !== 0 || cost.cacheRead !== 0 || cost.cacheWrite !== 0;
}

/**
 * Returns a new zero-initialized {@link Usage} object with all token and cost fields set to 0.
 */
export function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: emptyCost(),
	};
}
/**
 * Check if two models are equal by comparing both their id and provider.
 * Returns false if either model is null or undefined.
 */
export function modelsAreEqual<TApi extends Api>(
	a: Model<TApi> | null | undefined,
	b: Model<TApi> | null | undefined,
): boolean {
	if (!a || !b) return false;
	return a.id === b.id && a.provider === b.provider;
}
