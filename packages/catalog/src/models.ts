import { buildModel } from "./build";
import MODELS from "./models.json" with { type: "json" };
import type { Api, Model, ModelSpec, Usage } from "./types";

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

export function getBundledProviders(): GeneratedProvider[] {
	return Object.keys(MODELS) as GeneratedProvider[];
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
	recomputeCostTotal(usage);
	return usage.cost;
}

/**
 * Sum {@link Usage.cost}'s total from its buckets plus whatever already-discarded
 * attempts cost.
 *
 * This is the ONE owner of that sum. Providers that rescale the buckets after
 * pricing (a Codex or OpenAI service-tier multiplier) call this instead of adding
 * the four fields themselves, because a hand-written sum silently drops the spend
 * of every retried attempt: the buckets price the delivered tokens only.
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
 * Scale every priced bucket by a billing multiplier the provider applied after
 * the fact (an OpenAI or Codex service tier), then re-total.
 *
 * The scale-and-total step is the same operation for every biller, and it is the
 * step that keeps losing money: written out by hand it ends in a four-field sum
 * that drops what discarded attempts cost. A multiplier of 1 is a no-op, so a
 * caller can hand over whatever it resolved without guarding first.
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
 * Carry the spend of an attempt whose output is being thrown away into the usage
 * that replaces it.
 *
 * Every in-provider retry discards the attempt's text, which is correct (it is
 * not replayable), and used to discard its billed tokens with it, which is not:
 * the provider bills a stream that died after `message_start` for the whole
 * prompt, including the cache write, and bills an aborted thinking loop for every
 * token it sampled. Dropping that spend understates cost and, for providers whose
 * limit window is measured locally from observed cost, understates how much of
 * the operator's quota is already gone.
 *
 * The discarded tokens never join the delivered token fields, so the context
 * meter still describes the message that survived. They land in
 * {@link Usage.discarded} with their price folded into `cost.total`.
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
 * What a discarded attempt cost. An attempt its provider already priced keeps
 * that number, so a service-tier multiplier the provider applied is not
 * recomputed away; an attempt that died before pricing is priced here at the
 * model that served it. A zero for a free or unpriced model is a real zero and
 * pricing it again changes nothing.
 */
function discardedAttemptCost<TApi extends Api>(model: Model<TApi>, discarded: Usage): number {
	if (discarded.cost.total !== 0) return discarded.cost.total;
	return calculateCost(model, { ...discarded, cost: emptyCost() }).total;
}

/**
 * Install a freshly built token accounting on a message without destroying the
 * facts a replacement is not allowed to lose.
 *
 * Providers that receive the whole accounting in one wire field (Google's
 * `usageMetadata`, an OpenAI Responses `response.usage`) rebuild `usage` from
 * scratch on every update rather than adding to it. That wholesale assignment
 * destroys anything an earlier step put on the object: what discarded attempts
 * billed, and Copilot's premium-request counter. Both had to be hand-restored at
 * one site each, which is how the next carried field gets lost, so the
 * replacement itself is the thing with an owner.
 *
 * `next` is returned so a call site can keep the single assignment it already had.
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
 * Does this cost object carry a non-zero price in any bucket?
 *
 * Read this as "are there numbers here to use", NOT as "is the model paid". An all-zero cost is
 * ambiguous by construction, which is what {@link ModelSpec.costKnown} exists to disambiguate: a
 * provider that publishes no pricing produces the same object as a genuinely free model. Callers
 * use this to decide whether to go looking for pricing somewhere else (the Codex entries take
 * theirs from the matching OpenAI model, and the stats database falls back through the bundled
 * catalog), so the ambiguity is harmless there: trying a fallback for a free model finds nothing
 * and changes nothing. Do not use it to label a model free in any user-facing surface.
 *
 * The parameter is structural so the generator's `ModelSpec["cost"]`, a {@link Usage} cost with
 * its extra `total`, and the stats row shape all pass. It had a copy in `catalog`'s generator and
 * another in `stats`, spelled identically down to the bucket order.
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
