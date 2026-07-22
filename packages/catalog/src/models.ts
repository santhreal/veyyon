import { buildModel } from "./build";
import MODELS from "./models.json" with { type: "json" };
import type { Api, KnownProvider, Model, ModelSpec, Usage } from "./types";

/**
 * Static bundled model registry loaded from `models.json`.
 *
 * This module intentionally exposes compile-time defaults only.
 * It does not include runtime discovery, models.dev overlays, or on-disk cache state.
 *
 * For runtime-aware resolution, use `createModelManager()` / `resolveProviderModels()`.
 */
let modelRegistry: Map<string, Map<string, Model<Api>>> | undefined;

/** Build (once) and return the enriched bundled-model registry. Lazy: enrichment of ~12K models is deferred off module load. */
function getModelRegistry(): Map<string, Map<string, Model<Api>>> {
	if (modelRegistry === undefined) {
		modelRegistry = new Map();
		for (const [provider, models] of Object.entries(MODELS)) {
			const providerModels = new Map<string, Model<Api>>();
			for (const [id, model] of Object.entries(models)) {
				providerModels.set(id, buildModel(model as ModelSpec<Api>));
			}
			modelRegistry.set(provider, providerModels);
		}
	}
	return modelRegistry;
}

export type GeneratedProvider = keyof typeof MODELS;

export function getBundledModel<TApi extends Api = Api>(provider: GeneratedProvider, modelId: string): Model<TApi> {
	const providerModels = getModelRegistry().get(provider);
	return providerModels?.get(modelId) as Model<TApi>;
}

export function getBundledProviders(): KnownProvider[] {
	return Object.keys(MODELS) as KnownProvider[];
}

export function getBundledModels(provider: GeneratedProvider): Model<Api>[] {
	const models = getModelRegistry().get(provider);
	return models ? (Array.from(models.values()) as Model<Api>[]) : [];
}

/**
 * What we actually know about a model's per-token price.
 *
 * `unpriced` is the important one. Discovery fills `cost` with zeros whenever a
 * provider's `/models` endpoint carries no pricing, which is most of them, so an
 * all-zero cost means "we were never told" far more often than it means "this
 * costs nothing". Treating the two as the same thing is how a paid model ends up
 * displayed as free.
 */
export type ModelPricing = "priced" | "free" | "unpriced";

/**
 * Positive evidence that a model is free, as opposed to merely unpriced.
 *
 * OpenRouter is the one provider that marks its free tier in the model id, with
 * a `:free` suffix, and it does so consistently: in the bundled catalog every
 * `:free` model has a zero cost and no priced model carries the suffix. That
 * marker is the only free signal we have, so it is the only one trusted here.
 */
function hasFreeMarker(modelId: string): boolean {
	return modelId.endsWith(":free");
}

/**
 * Classify a model's pricing.
 *
 * This is the one owner of the "is it free or do we just not know" question.
 * Anything rendering or reasoning about price asks here rather than testing
 * `cost.input === 0` itself, because that test cannot tell the two apart.
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
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
	return usage.cost;
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
 * A fresh, fully-zeroed {@link Usage}: every required token bucket and every
 * cost field set to 0, optional fields (orchestration, reasoningTokens, cttl,
 * server, premiumRequests) left absent. This is the ONE owner for the zeroed
 * Usage every provider needs, both as a "no tokens reported" result and as the
 * starting accumulator a streaming provider increments field by field.
 *
 * A new object is returned on every call, so mutating the result (the streaming
 * accumulator pattern) never leaks into another turn's usage.
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
