import { createHash } from "node:crypto";
import { buildModel } from "./build";
import modelsSourceJson from "./models.json" with { type: "text" };
import type { Api, Model, ModelSpec, Usage } from "./types";

type BundledProviderModels = { readonly [modelId: string]: ModelSpec<Api> };
type BundledModelsJson = { readonly [provider: string]: BundledProviderModels };

export type GeneratedProvider = Extract<keyof BundledModelsJson, string>;

const modelsSource = modelsSourceJson as unknown as string;

const ENRICHED_REGISTRY_FORMAT_VERSION = 2;
let modelRegistry: Map<string, Map<string, Model<Api>>> | undefined;
let parsedModels: BundledModelsJson | undefined;
let catalogDigest: string | undefined;
export interface EnrichedRegistrySnapshotStore {
	read(fingerprint: string): Map<string, Map<string, Model<Api>>> | null;
	write(registry: Map<string, Map<string, Model<Api>>>, fingerprint: string): void;
}

let snapshotStore: EnrichedRegistrySnapshotStore | undefined;

export function setEnrichedRegistrySnapshotStore(store: EnrichedRegistrySnapshotStore | undefined): void {
	snapshotStore = store;
}

export function bundledCatalogDigest(): string {
	catalogDigest ??= createHash("sha256").update(modelsSource).digest("hex");
	return catalogDigest;
}

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
	return Array.from(getModelRegistry().keys());
}

export function getBundledModels(provider: GeneratedProvider): Model<Api>[] {
	const models = getModelRegistry().get(provider);
	return models ? (Array.from(models.values()) as Model<Api>[]) : [];
}

export type ModelPricing = "priced" | "free" | "unpriced";

function hasFreeMarker(modelId: string): boolean {
	return modelId.endsWith(":free");
}

export function getModelPricing<TApi extends Api>(
	model: Pick<Model<TApi>, "id" | "cost"> & { pricing?: "published" | "unknown" },
): ModelPricing {
	const cost = model.cost;
	if (cost && (cost.input > 0 || cost.output > 0)) return "priced";

	if (model.pricing === "unknown") return "unpriced";

	if (model.pricing === "published") return "free";

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

export function recomputeCostTotal(usage: Usage): number {
	usage.cost.total =
		usage.cost.input +
		usage.cost.output +
		usage.cost.cacheRead +
		usage.cost.cacheWrite +
		(usage.discarded?.cost ?? 0);
	return usage.cost.total;
}

export function scaleUsageCost(usage: Usage, multiplier: number): void {
	if (multiplier === 1) return;
	usage.cost.input *= multiplier;
	usage.cost.output *= multiplier;
	usage.cost.cacheRead *= multiplier;
	usage.cost.cacheWrite *= multiplier;
	recomputeCostTotal(usage);
}

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

function discardedAttemptCost<TApi extends Api>(model: Model<TApi>, discarded: Usage): number {
	if (discarded.cost.total !== 0) return discarded.cost.total;
	return calculateCost(model, { ...discarded, cost: emptyCost() }).total;
}

export function inheritUsageCarryovers(previous: Usage, next: Usage): Usage {
	if (previous.discarded !== undefined) next.discarded = previous.discarded;
	if (previous.premiumRequests !== undefined) next.premiumRequests ??= previous.premiumRequests;
	return next;
}

export function emptyCost(): Usage["cost"] {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
}

export function hasBillableCost(cost: {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}): boolean {
	return cost.input !== 0 || cost.output !== 0 || cost.cacheRead !== 0 || cost.cacheWrite !== 0;
}

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
export function modelsAreEqual<TApi extends Api>(
	a: Model<TApi> | null | undefined,
	b: Model<TApi> | null | undefined,
): boolean {
	if (!a || !b) return false;
	return a.id === b.id && a.provider === b.provider;
}
