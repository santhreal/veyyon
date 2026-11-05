/**
 * Model resolution, scoping, and initial selection.
 *
 * Layering:
 * - `matchModelExactly` and `matchModelLoosely` are the matching engine.
 *   Exact: `provider/id` reference (with variant-alias and OpenRouter
 *   routed/date fallbacks) → bare id → Bedrock inference profile → retired
 *   variant alias. Loose: provider-scoped fuzzy → substring with
 *   alias-vs-dated pick.
 * - `parseModelPatternWithContext`/`parseModelPattern` layer the selector
 *   grammar on top: trailing `:level` thinking suffixes (`splitThinkingSuffix`)
 *   and `@upstream` provider routing (`splitUpstreamRouting`). Loose matching
 *   runs only after the suffix is split off, so a suffix never picks the model.
 * - Everything else (`resolveModelFromString`, `resolveModelOverride*`,
 *   `resolveModelSelectorValue`, `resolveModelScope`, `resolveCliModel`)
 *   adapts inputs — settings patterns, CLI flags, scope globs — onto that
 *   pipeline.
 */

// The owner, not the barrel: see the note in `../thinking.ts`.
import { ThinkingLevel } from "@veyyon/agent-core/thinking";
import type { Api, KnownProvider, Model, ModelSpec } from "@veyyon/ai";
import { buildModel } from "@veyyon/catalog/build";
import { modelMatchesHost } from "@veyyon/catalog/hosts";
import { buildModelProviderPriorityRank } from "@veyyon/catalog/identity";
import { stripThinkingVariantToken } from "@veyyon/catalog/identity/family";
import { modelsAreEqual } from "@veyyon/catalog/models";
import { DEFAULT_MODEL_PER_PROVIDER } from "@veyyon/catalog/provider-models";
import { resolveBareVariantAlias, resolveVariantAlias } from "@veyyon/catalog/variant-collapse";
import { AgentStorage } from "@veyyon/kernel/session/agent-storage";
import { logger } from "@veyyon/utils";
import { fuzzyMatch } from "@veyyon/utils/fuzzy";
import {
	AUTO_THINKING,
	type ConfiguredThinkingLevel,
	concreteThinkingLevel,
	parseThinkingLevel,
	resolveThinkingLevelForModel,
} from "../thinking";
import { hasUsableCredential } from "./auth-state";
import { normalizeModelPatternList } from "./model-pattern-list";
import type { ModelRegistry } from "./model-registry";
import { type ModelRegistryView, modelResolutionFailureMessage } from "./model-resolution-failure";
import type { Settings } from "./settings";

/**
 * `*` as a whole pattern or as the id after `provider/`. It names no model: a
 * glob scope is matched by `matchingGlobModels`, never by the model matcher.
 */
const PROVIDER_WILDCARD_ID = "*";

function isKnownProvider(provider: string): provider is KnownProvider {
	return provider in DEFAULT_MODEL_PER_PROVIDER;
}

/**
 * Pick the first provider-default model in availability order.
 *
 * If multiple providers expose that same default id, rank only that shared-id
 * group by canonical provider priority so native/OAuth transports beat mirrors
 * without changing unrelated provider fallback precedence.
 */
export function pickDefaultAvailableModel(availableModels: Model<Api>[]): Model<Api> | undefined {
	const firstDefault = availableModels.find(
		model => isKnownProvider(model.provider) && DEFAULT_MODEL_PER_PROVIDER[model.provider] === model.id,
	);
	if (!firstDefault) return availableModels[0];

	const providerPriority = buildModelProviderPriorityRank();
	const sharedDefaultMatches = availableModels.filter(
		model =>
			model.id === firstDefault.id &&
			isKnownProvider(model.provider) &&
			DEFAULT_MODEL_PER_PROVIDER[model.provider] === model.id,
	);
	return sharedDefaultMatches.slice().sort((a, b) => {
		const aRank = providerPriority.get(a.provider.toLowerCase()) ?? Number.POSITIVE_INFINITY;
		const bRank = providerPriority.get(b.provider.toLowerCase()) ?? Number.POSITIVE_INFINITY;
		if (aRank !== bRank) return aRank - bRank;
		return availableModels.indexOf(a) - availableModels.indexOf(b);
	})[0];
}

export interface ScopedModel {
	model: Model<Api>;
	thinkingLevel?: ThinkingLevel;
	explicitThinkingLevel: boolean;
}

interface ThinkingSuffixOptions {
	allowMaxSuffix?: boolean;
	allowAutoAlias?: boolean;
}

interface ModelStringParseOptions extends ThinkingSuffixOptions {
	isLiteralModelId?: (provider: string, id: string) => boolean;
}
// Suffix recognition for the model-pattern parser: `:max` is a real thinking
// level and `:auto` maps to the auto sentinel. Both are gated behind flags
// (and the literal-id / exact-match guards on the callers) because real model
// ids end in `:max` (e.g. `glm-4.7:max`) — an ungated split would silently
// reinterpret them as a thinking suffix.
const MAX_THINKING_SUFFIX_OPTIONS: ThinkingSuffixOptions = { allowMaxSuffix: true, allowAutoAlias: true };

function parseThinkingSuffix(value: string, options?: ThinkingSuffixOptions): ConfiguredThinkingLevel | undefined {
	const level = parseThinkingLevel(value);
	if (level === ThinkingLevel.Max) return options?.allowMaxSuffix === true ? level : undefined;
	if (level !== undefined) return level;
	if (options?.allowAutoAlias === true && value === AUTO_THINKING) return AUTO_THINKING;
	return undefined;
}

/**
 * Split a trailing `:<level>` thinking selector off a model pattern.
 *
 * `level` is set when the suffix parses as a concrete thinking level (or, when
 * the caller opts in via `allowMaxSuffix`/`allowAutoAlias`, the guarded `:max`
 * level / `:auto` sentinel); `base` then has the suffix stripped. Otherwise
 * `base` is the input.
 * `minColonIndex` requires the colon to appear strictly after that index.
 */
function splitThinkingSuffix(
	pattern: string,
	minColonIndex = -1,
	options?: ThinkingSuffixOptions,
): { base: string; level?: ConfiguredThinkingLevel } {
	const colonIdx = pattern.lastIndexOf(":");
	if (colonIdx <= minColonIndex) return { base: pattern };
	const level = parseThinkingSuffix(pattern.slice(colonIdx + 1), options);
	return level ? { base: pattern.slice(0, colonIdx), level } : { base: pattern };
}

/** Whether a scope pattern is a glob (`openai/*`, `*sonnet*`) rather than one model selector. */
function isGlobPattern(pattern: string): boolean {
	return pattern.includes("*") || pattern.includes("?") || pattern.includes("[");
}

function matchingGlobModels(pattern: string, availableModels: readonly Model<Api>[]): Model<Api>[] {
	const glob = new Bun.Glob(pattern.toLowerCase());
	return availableModels.filter(model => {
		const fullId = `${model.provider}/${model.id}`;
		return glob.match(fullId.toLowerCase()) || glob.match(model.id.toLowerCase());
	});
}

function resolveGlobScopePattern(
	pattern: string,
	availableModels: readonly Model<Api>[],
): { models: Model<Api>[]; thinkingLevel?: ThinkingLevel; explicitThinkingLevel: boolean } {
	// Glob scopes describe which models are enabled, not per-model thinking.
	// Coerce the `auto` sentinel to a concrete-only view so scope callers stay
	// typed on `ThinkingLevel` and `enabledModels: [\"openai/*:auto\"]` doesn't
	// pin a stray per-model level.
	const strictSuffix = splitThinkingSuffix(pattern);
	if (strictSuffix.level !== undefined) {
		const thinkingLevel = concreteThinkingLevel(strictSuffix.level);
		return {
			models: matchingGlobModels(strictSuffix.base, availableModels),
			thinkingLevel,
			explicitThinkingLevel: thinkingLevel !== undefined,
		};
	}

	const maxSuffix = splitThinkingSuffix(pattern, -1, MAX_THINKING_SUFFIX_OPTIONS);
	if (maxSuffix.level !== undefined) {
		const literalMatches = matchingGlobModels(pattern, availableModels);
		if (literalMatches.length > 0) {
			return { models: literalMatches, thinkingLevel: undefined, explicitThinkingLevel: false };
		}
		const thinkingLevel = concreteThinkingLevel(maxSuffix.level);
		return {
			models: matchingGlobModels(maxSuffix.base, availableModels),
			thinkingLevel,
			explicitThinkingLevel: thinkingLevel !== undefined,
		};
	}

	return {
		models: matchingGlobModels(pattern, availableModels),
		thinkingLevel: undefined,
		explicitThinkingLevel: false,
	};
}

/** A `provider/modelId` string split into its parts, with any thinking-level suffix. */
export interface ParsedModelString {
	provider: string;
	id: string;
	thinkingLevel?: ConfiguredThinkingLevel;
}

/**
 * Parse a model string in "provider/modelId" format.
 * Returns undefined if the format is invalid, which includes a selector that
 * names a provider and no model (`openai/`, `openai/:high`): an empty id
 * matches nothing, so returning one hands every caller a selector that fails
 * later at model lookup instead of failing here where the text is still visible.
 */
export function parseModelString(modelStr: string, options?: ModelStringParseOptions): ParsedModelString | undefined {
	const slashIdx = modelStr.indexOf("/");
	if (slashIdx <= 0) return undefined;
	const id = modelStr.slice(slashIdx + 1);
	if (!id) return undefined;
	const provider = modelStr.slice(0, slashIdx);
	// Strip strict thinking level suffixes first (e.g. "claude-sonnet-4-6:high" -> id "claude-sonnet-4-6", thinkingLevel "high").
	const strict = splitThinkingSuffix(id);
	if (strict.level) return strict.base ? { provider, id: strict.base, thinkingLevel: strict.level } : undefined;
	// `max` is a real thinking level, but real model IDs can also end in
	// `:max`. Context-aware callers pass a literal lookup so those models win.
	const maxAlias = splitThinkingSuffix(id, -1, options);
	if (maxAlias.level) {
		if (options?.isLiteralModelId?.(provider, id) === true) return { provider, id };
		return maxAlias.base ? { provider, id: maxAlias.base, thinkingLevel: maxAlias.level } : undefined;
	}
	return { provider, id };
}

/**
 * Format a model as "provider/modelId" string.
 */
export function formatModelString(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

function getSingleRoutingOnly(routing: unknown): string | undefined {
	if (!routing || typeof routing !== "object" || !("only" in routing) || !Array.isArray(routing.only)) {
		return undefined;
	}
	if (routing.only.length !== 1) return undefined;
	const upstream = routing.only[0];
	return typeof upstream === "string" && upstream ? upstream : undefined;
}

function getSingleUpstreamRoute(model: Model<Api>): string | undefined {
	const compat = model.compat;
	if (!compat || typeof compat !== "object") return undefined;
	if (modelMatchesHost(model, "vercelAIGateway") && "vercelGatewayRouting" in compat) {
		return getSingleRoutingOnly(compat.vercelGatewayRouting);
	}
	if (modelMatchesHost(model, "openrouter") && "openRouterRouting" in compat) {
		return getSingleRoutingOnly(compat.openRouterRouting);
	}
	return undefined;
}

export function formatModelStringWithRouting(model: Model<Api>): string {
	const selector = formatModelString(model);
	const upstream = getSingleUpstreamRoute(model);
	return upstream ? `${selector}@${upstream}` : selector;
}

export function formatModelSelectorValue(selector: string, thinkingLevel: ConfiguredThinkingLevel | undefined): string {
	return thinkingLevel && thinkingLevel !== ThinkingLevel.Inherit ? `${selector}:${thinkingLevel}` : selector;
}

function getOpenRouterRouteSuffix(modelId: string): { baseId: string; suffix: string } | undefined {
	const colonIdx = modelId.lastIndexOf(":");
	if (colonIdx === -1) {
		return undefined;
	}

	const suffix = modelId.slice(colonIdx + 1).trim();
	// `max` is a thinking-level suffix, never an OpenRouter route suffix, so
	// `openrouter/<id>:max` falls through to the max-aware selector split instead of
	// being cloned into a literal `<id>:max` model id with the reasoning level lost.
	if (!suffix || parseThinkingSuffix(suffix, MAX_THINKING_SUFFIX_OPTIONS)) {
		return undefined;
	}

	return { baseId: modelId.slice(0, colonIdx), suffix };
}

function stripOpenRouterDateSuffix(modelId: string): string | undefined {
	const stripped = modelId.replace(/-\d{8}(?=$|:)/i, "");
	return stripped !== modelId ? stripped : undefined;
}

function getOpenRouterFallbackModelIds(modelId: string): string[] {
	const orderedCandidates: string[] = [];
	const queue = [modelId];
	const seen = new Set<string>();

	while (queue.length > 0) {
		const candidate = queue.shift();
		if (!candidate || seen.has(candidate)) {
			continue;
		}
		seen.add(candidate);
		orderedCandidates.push(candidate);

		const routedSuffix = getOpenRouterRouteSuffix(candidate);
		if (routedSuffix) {
			queue.push(routedSuffix.baseId);
		}

		const strippedDate = stripOpenRouterDateSuffix(candidate);
		if (strippedDate) {
			queue.push(strippedDate);
		}
	}

	return orderedCandidates;
}

function cloneModelWithRequestedId(model: Model<Api>, requestedId: string): Model<Api> {
	return {
		...model,
		id: requestedId,
		...(model.name === model.id ? { name: requestedId } : {}),
	};
}

const AMAZON_BEDROCK_PROVIDER = "amazon-bedrock";
const BEDROCK_INFERENCE_PROFILE_ARN =
	/^arn:aws(?:-[a-z]+)*:bedrock:[a-z0-9-]+:[0-9]*:(?:application-inference-profile|inference-profile)\/[a-z0-9][a-z0-9._:-]*$/i;

function hasBedrockInferenceProfileThinkingSuffix(modelId: string): boolean {
	const { base, level } = splitThinkingSuffix(modelId);
	return level !== undefined && BEDROCK_INFERENCE_PROFILE_ARN.test(base.trim());
}

function resolveBedrockInferenceProfileModelId(
	modelId: string,
	availableModels: readonly Model<Api>[],
): Model<Api> | undefined {
	const requestedId = modelId.trim();
	if (hasBedrockInferenceProfileThinkingSuffix(requestedId) || !BEDROCK_INFERENCE_PROFILE_ARN.test(requestedId)) {
		return undefined;
	}

	const template = availableModels.find(model => model.provider.toLowerCase() === AMAZON_BEDROCK_PROVIDER);
	if (!template) return undefined;

	return buildModel({
		id: requestedId,
		name: "Bedrock inference profile",
		api: "bedrock-converse-stream",
		provider: AMAZON_BEDROCK_PROVIDER,
		baseUrl: template.baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: null,
		maxTokens: null,
	});
}

function resolveBedrockInferenceProfileReference(
	provider: string,
	modelId: string,
	availableModels: readonly Model<Api>[],
): Model<Api> | undefined {
	if (provider.toLowerCase() !== AMAZON_BEDROCK_PROVIDER) return undefined;
	return resolveBedrockInferenceProfileModelId(modelId, availableModels);
}

const UPSTREAM_ROUTING_SLUG = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i;

/**
 * Split a trailing `@<upstream>` provider-routing selector off a model pattern.
 *
 * This is a purely SYNTACTIC split: `openrouter/z-ai/glm-4.7@cerebras` -> base
 * `openrouter/z-ai/glm-4.7`, upstream `cerebras`. A `:thinking` suffix after the
 * slug is kept on the base (`...@cerebras:high` -> base `...:high`). Returns
 * undefined only when there is no `@`, the `@` is at position 0, or the suffix
 * after `@` is not a bare provider slug (so `workers-ai/@cf/meta/llama` is not
 * split because `cf/meta/llama` contains a slash).
 *
 * It does NOT know which ids legitimately end in `@<slug>`: a Vertex id like
 * `anthropic/claude-opus-4-8@default` IS split here (into base
 * `anthropic/claude-opus-4-8`, upstream `default`) because `default` is a valid
 * slug. Honoring that split is the CALLER's decision: both call sites only apply
 * the routing when the base resolves to an aggregator model that supports
 * per-request upstream routing (OpenRouter / Vercel Gateway, see
 * {@link supportsUpstreamRouting}). For every other provider the split result is
 * discarded and the `@` stays part of the id. Keep this function syntactic; do
 * not special-case slugs like `default` here, or aggregator routing to an
 * upstream named `default` would break.
 */
export function splitUpstreamRouting(pattern: string): { base: string; upstream: string } | undefined {
	const at = pattern.lastIndexOf("@");
	if (at <= 0) return undefined;
	const rest = pattern.slice(at + 1);
	const colon = rest.indexOf(":");
	const upstream = colon === -1 ? rest : rest.slice(0, colon);
	if (!UPSTREAM_ROUTING_SLUG.test(upstream)) return undefined;
	const trailing = colon === -1 ? "" : rest.slice(colon);
	return { base: pattern.slice(0, at) + trailing, upstream };
}

/** OpenRouter and Vercel AI Gateway are the aggregators that honor per-request upstream routing. */
function supportsUpstreamRouting(model: Model<Api>): boolean {
	return modelMatchesHost(model, "openrouter") || modelMatchesHost(model, "vercelAIGateway");
}

/** Pin a resolved aggregator model to a single upstream provider via its compat routing block. */
function applyUpstreamRouting(model: Model<Api>, upstream: string): Model<Api> {
	const aggregatorModel = model as Model<"openai-completions">;
	const routing = { only: [upstream] };
	return buildModel({
		...model,
		compat: modelMatchesHost(model, "vercelAIGateway")
			? { ...aggregatorModel.compatConfig, vercelGatewayRouting: routing }
			: { ...aggregatorModel.compatConfig, openRouterRouting: routing },
	} as ModelSpec<Api>);
}

const kProviderModelIndex = Symbol("model-resolver.providerIndex");
type ModelsWithProviderIndex = readonly Model<Api>[] & {
	[kProviderModelIndex]?: Map<string, Model<Api> | null>;
};

function getProviderModelIndex(availableModels: readonly Model<Api>[]): Map<string, Model<Api> | null> {
	const tagged = availableModels as ModelsWithProviderIndex;
	const cached = tagged[kProviderModelIndex];
	if (cached) return cached;
	const index = new Map<string, Model<Api> | null>();
	for (const m of availableModels) {
		const key = `${m.provider.toLowerCase()}\u0000${m.id.toLowerCase()}`;
		if (index.has(key)) {
			index.set(key, null); // ambiguous sentinel; do not overwrite back
		} else {
			index.set(key, m);
		}
	}
	tagged[kProviderModelIndex] = index;
	return index;
}

export function resolveProviderModelReference(
	provider: string,
	modelId: string,
	availableModels: readonly Model<Api>[],
): Model<Api> | undefined {
	const normalizedProvider = provider.trim().toLowerCase();
	const normalizedModelId = modelId.trim().toLowerCase();
	if (!normalizedProvider || !normalizedModelId) {
		return undefined;
	}

	const index = getProviderModelIndex(availableModels);
	const exact = index.get(`${normalizedProvider}\u0000${normalizedModelId}`);
	if (exact === null) {
		return undefined; // ambiguous
	}
	if (exact !== undefined) {
		return exact;
	}

	// Retired effort-tier variant ids resolve to their collapsed logical
	// model: hand-table aliases first, then the `X-thinking` → `X` grammar
	// for auto-derived pairs. Exact lookup above always wins while raw is live.
	const variantAliasId =
		resolveVariantAlias(normalizedProvider, normalizedModelId) ?? stripThinkingVariantToken(normalizedModelId);
	if (variantAliasId) {
		const aliased = index.get(`${normalizedProvider}\u0000${variantAliasId.toLowerCase()}`);
		if (aliased) {
			return aliased;
		}
	}

	const bedrockInferenceProfile = resolveBedrockInferenceProfileReference(provider, modelId, availableModels);
	if (bedrockInferenceProfile) {
		return bedrockInferenceProfile;
	}

	if (normalizedProvider !== "openrouter") {
		return undefined;
	}

	for (const fallbackId of getOpenRouterFallbackModelIds(modelId).slice(1)) {
		const fallback = index.get(`${normalizedProvider}\u0000${fallbackId.toLowerCase()}`);
		if (fallback === null) {
			return undefined;
		}
		if (fallback !== undefined) {
			return cloneModelWithRequestedId(fallback, modelId);
		}
	}

	return undefined;
}

export interface ModelMatchPreferences {
	/** Most-recently-used model keys (provider/modelId) to prefer when ambiguous. */
	usageOrder?: string[];
	/** Provider precedence used for ambiguous unqualified model patterns. */
	providerOrder?: readonly string[];
	/** Providers to deprioritize when no recent usage or provider priority is available. */
	deprioritizeProviders?: string[];
	/**
	 * Credential check used to break ambiguous matches toward providers the
	 * user can actually call. A credential-less provider is never the right
	 * pick when an authenticated one exposes the same model.
	 */
	hasConfiguredAuth?: (model: Model<Api>) => boolean;
}

export type ModelLookupRegistry = Pick<ModelRegistry, "getAvailable">;
type CliModelRegistry = Pick<ModelRegistry, "getAll"> &
	Partial<Pick<ModelRegistry, "hasConfiguredAuth" | "getAvailable" | "getError" | "getProviderModels">>;

interface ModelPreferenceContext {
	modelUsageRank: Map<string, number>;
	providerUsageRank: Map<string, number>;
	providerPriorityRank: Map<string, number>;
	deprioritizedProviders: Set<string>;
	modelOrder: Map<string, number>;
	hasConfiguredAuth?: (model: Model<Api>) => boolean;
}

function buildPreferenceContext(
	availableModels: readonly Model<Api>[],
	preferences: ModelMatchPreferences | undefined,
): ModelPreferenceContext {
	const modelUsageRank = new Map<string, number>();
	const providerUsageRank = new Map<string, number>();
	const usageOrder = preferences?.usageOrder ?? [];
	for (let i = 0; i < usageOrder.length; i += 1) {
		const key = usageOrder[i];
		if (!modelUsageRank.has(key)) {
			modelUsageRank.set(key, i);
		}
		const parsed = parseModelString(key);
		if (parsed && !providerUsageRank.has(parsed.provider)) {
			providerUsageRank.set(parsed.provider, i);
		}
	}
	const providerPriorityRank = buildModelProviderPriorityRank(preferences?.providerOrder);
	const deprioritizedProviders = new Set(preferences?.deprioritizeProviders ?? []);
	const modelOrder = new Map<string, number>();
	for (let i = 0; i < availableModels.length; i += 1) {
		modelOrder.set(formatModelString(availableModels[i]), i);
	}

	return {
		modelUsageRank,
		providerUsageRank,
		providerPriorityRank,
		deprioritizedProviders,
		modelOrder,
		hasConfiguredAuth: preferences?.hasConfiguredAuth,
	};
}

export function getModelMatchPreferences(
	settings?: Partial<Pick<Settings, "get" | "getAgentDir">>,
): ModelMatchPreferences {
	const agentDir = settings?.getAgentDir?.();
	return {
		usageOrder: agentDir ? AgentStorage.forAgentDir(agentDir)?.getModelUsageOrder() : undefined,
		providerOrder: settings?.get?.("modelProviderOrder"),
	};
}

function mergeModelMatchPreferences(
	settings: Settings | undefined,
	preferences: ModelMatchPreferences | undefined,
): ModelMatchPreferences {
	const settingsPreferences = getModelMatchPreferences(settings);
	return {
		usageOrder: preferences?.usageOrder ?? settingsPreferences.usageOrder,
		providerOrder: preferences?.providerOrder ?? settingsPreferences.providerOrder,
		deprioritizeProviders: preferences?.deprioritizeProviders,
		hasConfiguredAuth: preferences?.hasConfiguredAuth,
	};
}

function pickPreferredModel(candidates: Model<Api>[], context: ModelPreferenceContext): Model<Api> {
	if (candidates.length <= 1) return candidates[0];
	return candidates.slice().sort((a, b) => {
		if (context.hasConfiguredAuth) {
			const aAuth = context.hasConfiguredAuth(a);
			const bAuth = context.hasConfiguredAuth(b);
			if (aAuth !== bAuth) {
				return aAuth ? -1 : 1;
			}
		}

		const aKey = formatModelString(a);
		const bKey = formatModelString(b);
		const aUsage = context.modelUsageRank.get(aKey);
		const bUsage = context.modelUsageRank.get(bKey);
		if (aUsage !== undefined || bUsage !== undefined) {
			return (aUsage ?? Number.POSITIVE_INFINITY) - (bUsage ?? Number.POSITIVE_INFINITY);
		}

		const aProviderPriority = context.providerPriorityRank.get(a.provider.toLowerCase());
		const bProviderPriority = context.providerPriorityRank.get(b.provider.toLowerCase());
		if (aProviderPriority !== undefined || bProviderPriority !== undefined) {
			return (aProviderPriority ?? Number.POSITIVE_INFINITY) - (bProviderPriority ?? Number.POSITIVE_INFINITY);
		}

		const aProviderUsage = context.providerUsageRank.get(a.provider);
		const bProviderUsage = context.providerUsageRank.get(b.provider);
		if (aProviderUsage !== undefined || bProviderUsage !== undefined) {
			return (aProviderUsage ?? Number.POSITIVE_INFINITY) - (bProviderUsage ?? Number.POSITIVE_INFINITY);
		}

		const aDeprioritized = context.deprioritizedProviders.has(a.provider);
		const bDeprioritized = context.deprioritizedProviders.has(b.provider);
		if (aDeprioritized !== bDeprioritized) {
			return aDeprioritized ? 1 : -1;
		}

		const aOrder = context.modelOrder.get(aKey) ?? 0;
		const bOrder = context.modelOrder.get(bKey) ?? 0;
		return aOrder - bOrder;
	})[0];
}

/**
 * Helper to check if a model ID looks like an alias (no date suffix)
 * Dates are typically in format: -20241022 or -20250929
 */
function isAlias(id: string): boolean {
	// Check if ID ends with -latest
	if (id.endsWith("-latest")) return true;

	// Check if ID ends with a date pattern (-YYYYMMDD)
	const datePattern = /-\d{8}$/;
	return !datePattern.test(id);
}

function includeSyntheticAllowedModels(available: Model<Api>[], allowedModels: Iterable<Model<Api>>): Model<Api>[] {
	const allowedByKey = new Map<string, Model<Api>>();
	for (const model of allowedModels) {
		const key = formatModelString(model);
		if (!allowedByKey.has(key)) {
			allowedByKey.set(key, model);
		}
	}
	if (allowedByKey.size === 0) return [];

	const result: Model<Api>[] = [];
	for (const model of available) {
		if (allowedByKey.delete(formatModelString(model))) {
			result.push(model);
		}
	}

	for (const model of allowedByKey.values()) result.push(model);
	return result;
}

/**
 * Find an exact explicit provider/model match.
 */
function findExactModelReferenceMatch(
	modelReference: string,
	availableModels: readonly Model<Api>[],
): Model<Api> | undefined {
	const trimmedReference = modelReference.trim();
	if (!trimmedReference) {
		return undefined;
	}

	const slashIndex = trimmedReference.indexOf("/");
	if (slashIndex !== -1) {
		const provider = trimmedReference.substring(0, slashIndex).trim();
		const modelId = trimmedReference.substring(slashIndex + 1).trim();
		if (provider && modelId) {
			return resolveProviderModelReference(provider, modelId, availableModels);
		}
	}
	return undefined;
}
/**
 * The exact stages of model matching, in order:
 * 1. exact `provider/id` reference (variant-alias and OpenRouter routed/date
 *    fallbacks included),
 * 2. exact bare id (preference-ranked),
 * 3. Bedrock inference profile id,
 * 4. retired effort-tier variant alias (collapsed catalog entries).
 */
function matchModelExactly(
	modelPattern: string,
	availableModels: readonly Model<Api>[],
	context: ModelPreferenceContext,
): Model<Api> | undefined {
	// An empty pattern is a substring of every id and a `*` here is not a glob
	// (glob scope is `matchingGlobModels`): either would pick the first model of
	// the whole registry, or of a provider, in silence.
	if (!modelPattern || modelPattern === PROVIDER_WILDCARD_ID) return undefined;
	const exactRefMatch = findExactModelReferenceMatch(modelPattern, availableModels);
	if (exactRefMatch) {
		return exactRefMatch;
	}

	// Exact ID match (case-insensitive) — this must happen before provider-scoped
	// fuzzy matching so raw IDs that contain slashes (for example OpenRouter model
	// IDs like "openai/gpt-4o:extended") still resolve as IDs instead of being
	// misread as a provider-qualified selector.
	const lowerPattern = modelPattern.toLowerCase();
	const exactMatches = availableModels.filter(m => m.id.toLowerCase() === lowerPattern);
	if (exactMatches.length > 0) {
		return pickPreferredModel(exactMatches, context);
	}

	const bedrockInferenceProfile = resolveBedrockInferenceProfileModelId(modelPattern, availableModels);
	if (bedrockInferenceProfile) {
		return bedrockInferenceProfile;
	}

	// Retired effort-tier variant ids (bare, no provider prefix) resolve to
	// their collapsed logical model; models from the providers whose table
	// declared the alias win ties. Auto-derived `X-thinking` pairs resolve
	// through the grammar fallback.
	const bareAlias = resolveBareVariantAlias(modelPattern);
	const bareAliasTargetId = bareAlias?.id ?? stripThinkingVariantToken(modelPattern);
	if (bareAliasTargetId) {
		const lowerAliasTarget = bareAliasTargetId.toLowerCase();
		const aliasMatches = availableModels.filter(m => m.id.toLowerCase() === lowerAliasTarget);
		if (aliasMatches.length > 0) {
			const preferred = bareAlias ? aliasMatches.filter(m => bareAlias.providers.includes(m.provider)) : [];
			return pickPreferredModel(preferred.length > 0 ? preferred : aliasMatches, context);
		}
	}
	return undefined;
}

/**
 * The loose stages of model matching, tried only after every exact stage failed:
 * 1. provider-scoped fuzzy match,
 * 2. substring match with the alias-vs-dated pick.
 */
function matchModelLoosely(
	modelPattern: string,
	availableModels: readonly Model<Api>[],
	context: ModelPreferenceContext,
): Model<Api> | undefined {
	if (!modelPattern || modelPattern === PROVIDER_WILDCARD_ID) return undefined;
	const lowerPattern = modelPattern.toLowerCase();
	// Check for provider/modelId format — fuzzy match within provider only.
	const slashIndex = modelPattern.indexOf("/");
	if (slashIndex !== -1) {
		const provider = modelPattern.substring(0, slashIndex);
		const modelId = modelPattern.substring(slashIndex + 1);
		const lowerProvider = provider.toLowerCase();
		const providerModels = availableModels.filter(m => m.provider.toLowerCase() === lowerProvider);
		if (providerModels.length === 0) {
			// The prefix is not a known provider in this candidate set, so treat the
			// slash as part of the raw model ID and continue with generic matching.
		} else if (!modelId || modelId === PROVIDER_WILDCARD_ID) {
			// `openai/` and `openai/*` name a provider and no model; fuzzy-matching
			// the empty id ranked every model of the provider and returned the oldest.
			return undefined;
		} else {
			// Let the routing fallback apply `@upstream` before fuzzy matching can consume the
			// slug — but only for aggregator providers (OpenRouter / Vercel Gateway). Other
			// providers have ids that legitimately end in `@` (Vertex `claude-opus-4-8@default`),
			// and the fallback never routes them, so they must keep fuzzy matching.
			if (splitUpstreamRouting(modelId) && providerModels.some(supportsUpstreamRouting)) {
				return undefined;
			}
			const scored = providerModels
				.map(model => ({ model, match: fuzzyMatch(modelId, model.id) }))
				.filter(entry => entry.match.matches);
			if (scored.length === 0) {
				return undefined;
			}

			scored.sort((a, b) => {
				if (a.match.score !== b.match.score) return a.match.score - b.match.score;
				const aKey = formatModelString(a.model);
				const bKey = formatModelString(b.model);
				const aUsage = context.modelUsageRank.get(aKey) ?? Number.POSITIVE_INFINITY;
				const bUsage = context.modelUsageRank.get(bKey) ?? Number.POSITIVE_INFINITY;
				if (aUsage !== bUsage) return aUsage - bUsage;

				const aProviderUsage = context.providerUsageRank.get(a.model.provider) ?? Number.POSITIVE_INFINITY;
				const bProviderUsage = context.providerUsageRank.get(b.model.provider) ?? Number.POSITIVE_INFINITY;
				if (aProviderUsage !== bProviderUsage) return aProviderUsage - bProviderUsage;

				const aOrder = context.modelOrder.get(aKey) ?? 0;
				const bOrder = context.modelOrder.get(bKey) ?? 0;
				return aOrder - bOrder;
			});
			return scored[0]?.model;
		}
	}

	// No exact match - fall back to partial matching
	const matches = availableModels.filter(
		m => m.id.toLowerCase().includes(lowerPattern) || m.name?.toLowerCase().includes(lowerPattern),
	);

	if (matches.length === 0) {
		return undefined;
	}

	// Separate into aliases and dated versions
	const aliases = matches.filter(m => isAlias(m.id));
	const datedVersions = matches.filter(m => !isAlias(m.id));

	if (aliases.length > 0) {
		return pickPreferredModel(aliases, context);
	}
	if (datedVersions.length === 0) return undefined;

	if (datedVersions.length === 1) {
		return datedVersions[0];
	}

	const sortedById = datedVersions.slice().sort((a, b) => b.id.localeCompare(a.id));
	const topId = sortedById[0]?.id;
	if (!topId) return undefined;
	const topCandidates = sortedById.filter(model => model.id === topId);
	return pickPreferredModel(topCandidates, context);
}

export interface ParsedModelResult {
	model: Model<Api> | undefined;
	/** Thinking level if explicitly specified in pattern, undefined otherwise */
	thinkingLevel?: ConfiguredThinkingLevel;
	/** Upstream provider slug from an `@upstream` routing selector, if present. */
	upstream?: string;
	warning: string | undefined;
	explicitThinkingLevel: boolean;
}

/**
 * Parse a pattern to extract model and thinking level.
 * Handles models with colons in their IDs (e.g., OpenRouter's :exacto suffix).
 *
 * Algorithm:
 * 1. An exact match of the full pattern wins, so a literal id containing a colon keeps winning.
 * 2. A valid thinking suffix (`:high`) is split off and the prefix resolved.
 * 3. Any other suffix after the last colon is dropped with a warning and the prefix resolved.
 * 4. Only then is the full pattern matched loosely (fuzzy, substring).
 *
 * Loose matching runs last because it consumes the suffix as part of the id: `k3.1-pro:high`
 * is a fuzzy subsequence of `k3.1-pro-highspeed`, so trying it first resolved a pattern that
 * names `k3.1-pro` at effort `high` to a different model.
 */
function parseModelPatternWithContext(
	pattern: string,
	availableModels: readonly Model<Api>[],
	context: ModelPreferenceContext,
	options?: { allowInvalidThinkingSelectorFallback?: boolean },
): ParsedModelResult {
	const exactMatch = matchModelExactly(pattern, availableModels, context);
	if (exactMatch) {
		return { model: exactMatch, thinkingLevel: undefined, warning: undefined, explicitThinkingLevel: false };
	}

	// `max` is accepted only after the exact full pattern failed, so literal model IDs
	// ending in `:max` keep winning over the thinking suffix.
	const { base, level } = splitThinkingSuffix(pattern, -1, MAX_THINKING_SUFFIX_OPTIONS);
	if (level) {
		const result = parseModelPatternWithContext(base, availableModels, context, options);
		if (result.model) {
			// Only use this thinking level if no warning from inner recursion
			const explicitThinkingLevel = !result.warning;
			return {
				model: result.model,
				thinkingLevel: explicitThinkingLevel ? level : undefined,
				warning: result.warning,
				explicitThinkingLevel,
			};
		}
	} else {
		const lastColonIndex = pattern.lastIndexOf(":");
		if (lastColonIndex !== -1 && (options?.allowInvalidThinkingSelectorFallback ?? true)) {
			const suffix = pattern.substring(lastColonIndex + 1);
			const result = parseModelPatternWithContext(
				pattern.substring(0, lastColonIndex),
				availableModels,
				context,
				options,
			);
			if (result.model) {
				return {
					model: result.model,
					thinkingLevel: undefined,
					warning: `Invalid thinking level "${suffix}" in pattern "${pattern}". Using default instead.`,
					explicitThinkingLevel: false,
				};
			}
		}
	}

	const looseMatch = matchModelLoosely(pattern, availableModels, context);
	if (looseMatch) {
		return { model: looseMatch, thinkingLevel: undefined, warning: undefined, explicitThinkingLevel: false };
	}
	return { model: undefined, thinkingLevel: undefined, warning: undefined, explicitThinkingLevel: false };
}

/** Match a single pattern with a pre-built preference context (direct match plus
 *  the `@upstream` routing fallback), so chain resolution can reuse one context
 *  across every fallback pattern instead of rebuilding it per pattern. */
function matchPatternWithContext(
	pattern: string,
	availableModels: readonly Model<Api>[],
	context: ModelPreferenceContext,
	options?: { allowInvalidThinkingSelectorFallback?: boolean },
): ParsedModelResult {
	const direct = parseModelPatternWithContext(pattern, availableModels, context, options);
	if (direct.model) return direct;

	// No direct match: a trailing `@upstream` may be a provider-routing selector.
	// Only honor it when the base resolves to an aggregator model (OpenRouter /
	// Vercel Gateway); otherwise `@` stays part of the id and `direct` stands.
	const routing = splitUpstreamRouting(pattern);
	if (routing) {
		const routed = parseModelPatternWithContext(routing.base, availableModels, context, options);
		if (routed.model && supportsUpstreamRouting(routed.model)) {
			return { ...routed, model: applyUpstreamRouting(routed.model, routing.upstream), upstream: routing.upstream };
		}
	}
	return direct;
}

export function parseModelPattern(
	pattern: string,
	availableModels: readonly Model<Api>[],
	preferences?: ModelMatchPreferences,
	options?: { allowInvalidThinkingSelectorFallback?: boolean },
): ParsedModelResult {
	return matchPatternWithContext(
		pattern,
		availableModels,
		buildPreferenceContext(availableModels, preferences),
		options,
	);
}

/*
 * There is deliberately no agent-model resolver here.
 *
 * `resolveAgentModelPatterns` used to live at this spot and re-implemented the
 * whole agent precedence chain — settings override, then `agent.model`,
 * then the agent's frontmatter, then inherit — with a silent fall-through at
 * every step and a special case for the retired `@task` role. That made it a
 * second owner of "what model does this agent run", disagreeing with the
 * spawn path on unresolvable values, and it is why changing the agent model
 * appeared to do nothing. The one owner is now `resolveAgentModel` in
 * `task/agent-settings.ts`, which also reports WHICH layer decided and
 * refuses instead of falling through. Resolve agent models there.
 */

/**
 * Resolve the configured compaction model chain from settings
 * (`compaction.model`), in the order compaction should try them.
 *
 * Both encodings are the same chain and both are valid: the setting is
 * schema-typed `modelChain`, which admits a comma-separated string
 * (`"opus,sonnet"`) and a YAML list alike, and `normalizeModelPatternList` is
 * where they meet. Only the string form needs trimming, and `.trim()` on the
 * list form used to throw a TypeError from inside compaction rather than saying
 * anything useful.
 */
export function resolveCompactionModelPatterns(settings?: Settings): string[] {
	return normalizeModelPatternList(settings?.get("compaction.model"));
}

/** A configured model value resolved to a concrete model and thinking metadata. */
export interface ResolvedModelSelectorValue {
	model: Model<Api> | undefined;
	thinkingLevel?: ConfiguredThinkingLevel;
	explicitThinkingLevel: boolean;
	warning: string | undefined;
}

/**
 * Resolve a configured model value (one selector, a comma chain or a list) to
 * the first entry that matches an available model.
 */
export function resolveModelSelectorValue(
	value: string | string[] | undefined,
	// Readonly: this only reads the list, and callers legitimately hold a readonly
	// model list (the settings selector's picker does), which a mutable parameter
	// type rejected.
	availableModels: readonly Model<Api>[],
	options?: { settings?: Settings; matchPreferences?: ModelMatchPreferences },
): ResolvedModelSelectorValue {
	const effectivePatterns = normalizeModelPatternList(value);
	if (effectivePatterns.length === 0) {
		return { model: undefined, thinkingLevel: undefined, explicitThinkingLevel: false, warning: undefined };
	}

	let warning: string | undefined;
	const matchPreferences = mergeModelMatchPreferences(options?.settings, options?.matchPreferences);
	// Build the O(n) preference context (model-order map over all available
	// models) once and reuse it across every fallback pattern instead of
	// rebuilding it per pattern inside parseModelPattern.
	const preferenceContext = buildPreferenceContext(availableModels, matchPreferences);
	for (const effectivePattern of effectivePatterns) {
		const resolved = matchPatternWithContext(effectivePattern, availableModels, preferenceContext);
		if (resolved.model) {
			return {
				model: resolved.model,
				thinkingLevel: resolved.explicitThinkingLevel
					? resolved.thinkingLevel === AUTO_THINKING
						? AUTO_THINKING
						: (resolveThinkingLevelForModel(resolved.model, resolved.thinkingLevel) ?? resolved.thinkingLevel)
					: resolved.thinkingLevel,
				explicitThinkingLevel: resolved.explicitThinkingLevel,
				warning: resolved.warning,
			};
		}
		if (!warning && resolved.warning) {
			warning = resolved.warning;
		}
	}

	return { model: undefined, thinkingLevel: undefined, explicitThinkingLevel: false, warning };
}

interface ExplicitThinkingSelectorOptions {
	isLiteralModelId?: (provider: string, id: string) => boolean;
}

function isLiteralModelSelector(value: string, options?: ExplicitThinkingSelectorOptions): boolean {
	const parsed = parseModelString(value);
	return parsed !== undefined && options?.isLiteralModelId?.(parsed.provider, parsed.id) === true;
}

export function extractExplicitThinkingSelector(
	value: string | undefined,
	options?: ExplicitThinkingSelectorOptions,
): ConfiguredThinkingLevel | undefined {
	const normalized = value?.trim();
	if (!normalized) return undefined;
	const strictSelector = splitThinkingSuffix(normalized).level;
	if (strictSelector) return strictSelector;
	const maxSelector = splitThinkingSuffix(normalized, -1, MAX_THINKING_SUFFIX_OPTIONS).level;
	return maxSelector && !isLiteralModelSelector(normalized, options) ? maxSelector : undefined;
}

/**
 * Resolve a model identifier or pattern to a Model instance.
 */
export function resolveModelFromString(
	value: string,
	available: Model<Api>[],
	matchPreferences?: ModelMatchPreferences,
): Model<Api> | undefined {
	const exact = available.find(model => `${model.provider}/${model.id}` === value);
	if (exact) return exact;
	const parsed = parseModelString(value, {
		...MAX_THINKING_SUFFIX_OPTIONS,
		isLiteralModelId: (provider, id) => available.some(model => model.provider === provider && model.id === id),
	});
	if (parsed) {
		const parsedExact = available.find(model => model.provider === parsed.provider && model.id === parsed.id);
		if (parsedExact) return parsedExact;
	}
	return parseModelPattern(value, available, matchPreferences).model;
}

/** The model one override list resolves to, and the effort its matched pattern named. */
export interface ModelOverrideResolution {
	model?: Model<Api>;
	thinkingLevel?: ConfiguredThinkingLevel;
	explicitThinkingLevel: boolean;
	warning?: string;
}

/**
 * Resolve a list of override patterns to the first matching model.
 */
export function resolveModelOverride(
	modelPatterns: string[],
	modelRegistry: ModelLookupRegistry,
	settings?: Settings,
): ModelOverrideResolution {
	if (modelPatterns.length === 0) return { explicitThinkingLevel: false };
	const availableModels = modelRegistry.getAvailable();
	const matchPreferences = getModelMatchPreferences(settings);
	let warning: string | undefined;
	for (const pattern of modelPatterns) {
		const {
			model,
			thinkingLevel,
			explicitThinkingLevel,
			warning: patternWarning,
		} = resolveModelSelectorValue(pattern, availableModels, {
			settings,
			matchPreferences,
		});
		if (model) {
			return { model, thinkingLevel, explicitThinkingLevel, warning: patternWarning };
		}
		if (!warning && patternWarning) warning = patternWarning;
	}
	return { explicitThinkingLevel: false, warning };
}

/**
 * Resolve a list of override patterns to the first matching model whose provider
 * has working credentials, with an auth-aware fallback to the parent session's
 * active model.
 *
 * The patterns are the agent's own fallback chain, so a later pattern whose
 * provider authenticates outranks the parent's model. Only when no configured
 * pattern resolves to a usable model, and the parent's active model resolves with
 * working auth, does the agent run the parent's model. This prevents spawned agent
 * dispatch from silently routing to a provider the user can't actually call (e.g.
 * an agent model pointing at an unqualified id whose only available
 * provider variant has no configured credentials — see #985).
 *
 * `sessionId` is forwarded to `getApiKey` so that session-sticky OAuth
 * credentials resolve correctly during the pre-flight auth check. Without it,
 * providers with multiple OAuth accounts may return `undefined` even though
 * the credential is usable once the agent session starts — see #5325.
 *
 * Keyless-by-design providers (llama.cpp, ollama, lm-studio) advertise the
 * `kNoAuth` sentinel from `getApiKey` to signal that they do not require
 * credentials. Those are treated as authenticated, for the agent's patterns and
 * the parent's model alike, so an explicitly configured local model is never
 * silently rerouted to a remote provider (see #1008).
 *
 * If neither a configured pattern nor the parent has working auth, returns the
 * first configured resolution unchanged so the existing error path still surfaces
 * a meaningful failure downstream.
 */
export async function resolveModelOverrideWithAuthFallback(
	modelPatterns: string[],
	parentActiveModelPattern: string | undefined,
	modelRegistry: ModelLookupRegistry & Pick<ModelRegistry, "getApiKey">,
	settings?: Settings,
	sessionId?: string,
): Promise<ModelOverrideResolution & { authFallbackUsed: boolean }> {
	const patterns = normalizeModelPatternList(modelPatterns);
	// One pattern and no parent model leave nothing to fall back to, so no credential is looked up.
	if (patterns.length <= 1 && !parentActiveModelPattern) {
		return { ...resolveModelOverride(patterns, modelRegistry, settings), authFallbackUsed: false };
	}
	const canCall = async (model: Model<Api>): Promise<boolean> =>
		hasUsableCredential(await modelRegistry.getApiKey(model, sessionId));
	let primary: ModelOverrideResolution | undefined;
	let unmatchedWarning: string | undefined;
	for (const pattern of patterns) {
		const resolved = resolveModelOverride([pattern], modelRegistry, settings);
		if (!resolved.model) {
			unmatchedWarning ??= resolved.warning;
			continue;
		}
		primary ??= resolved;
		if (await canCall(resolved.model)) return { ...resolved, authFallbackUsed: false };
	}
	if (!primary?.model) return { explicitThinkingLevel: false, warning: unmatchedWarning, authFallbackUsed: false };
	if (!parentActiveModelPattern) return { ...primary, authFallbackUsed: false };

	const fallback = resolveModelOverride([parentActiveModelPattern], modelRegistry, settings);
	if (!fallback.model || modelsAreEqual(fallback.model, primary.model) || !(await canCall(fallback.model))) {
		return { ...primary, authFallbackUsed: false };
	}
	return { ...fallback, authFallbackUsed: true, warning: primary.warning ?? fallback.warning };
}

/**
 * Single owner of the "configured default model is unavailable" substitution:
 * when the persisted `defaultModel` points at a model whose provider has no
 * stored credentials (or that no longer exists), every surface (interactive
 * session, print mode, commit, …) substitutes the SAME model and surfaces the
 * SAME operator warning. Callers MUST print the returned warning — silently
 * swallowing it recreates the silent-fallback bug this exists to kill.
 * Returns undefined only when no model is available at all.
 */
export function fallbackForUnavailableDefault(
	configuredDefault: string | undefined,
	availableModels: readonly Model<Api>[],
): { model: Model<Api>; warning: string } | undefined {
	const model = availableModels[0];
	if (!model) return undefined;
	const subject = configuredDefault
		? `Configured default model "${configuredDefault}"`
		: "The configured default model";
	// The provider to sign into is the prefix of the configured selector when it
	// carries one; a bare model id (`opus`) does not name a provider, so the
	// clause stays generic rather than guessing one.
	const configuredProvider = configuredDefault?.includes("/") ? configuredDefault.split("/")[0] : undefined;
	// This warning reaches `veyyon commit`, `--print` startup and `bench` as well
	// as the interactive session (see the doc comment above), so the remedies are
	// shell commands. `veyyon auth` was named here and is not a command at all:
	// `cli-commands.ts` registers `auth-broker` and `auth-gateway`, and `/model`
	// only exists once a TUI is up.
	return {
		model,
		warning:
			`${subject} is unavailable: its provider has no stored credentials or the model no longer exists. ` +
			`Using ${model.provider}/${model.id} instead. Fix: run ` +
			`\`veyyon auth-broker login ${configuredProvider ?? "<provider>"}\` to sign in, or ` +
			"`veyyon models` to see what is available (`/model` picks a new default in an interactive veyyon session).",
	};
}

/**
 * Resolve model patterns to actual Model objects with optional thinking levels
 * Format: "pattern:level" where :level is optional
 * For each pattern, finds all matching models and picks the best version:
 * 1. Prefer alias (e.g., claude-sonnet-4-5) over dated versions (claude-sonnet-4-5-20250929)
 * 2. If no alias, pick the latest dated version
 *
 * Supports models with colons in their IDs (e.g., OpenRouter's model:exacto).
 * The algorithm tries to match the full pattern first, then progressively
 * strips colon-suffixes to find a match.
 */
export async function resolveModelScope(
	patterns: string[],
	modelRegistry: Pick<ModelRegistry, "getAvailable">,
	preferences?: ModelMatchPreferences,
): Promise<ScopedModel[]> {
	const availableModels = modelRegistry.getAvailable();
	const context = buildPreferenceContext(availableModels, preferences);
	const scopedModels: ScopedModel[] = [];
	const addScopedModel = (model: Model<Api>, thinkingLevel: ThinkingLevel | undefined, explicit: boolean) => {
		if (scopedModels.some(sm => modelsAreEqual(sm.model, model))) return;
		scopedModels.push({
			model,
			thinkingLevel: explicit
				? (resolveThinkingLevelForModel(model, thinkingLevel) ?? thinkingLevel)
				: thinkingLevel,
			explicitThinkingLevel: explicit,
		});
	};

	for (const pattern of patterns) {
		if (isGlobPattern(pattern)) {
			// Extract optional thinking level suffix (e.g., "provider/*:high") only
			// after literal `:max` globs had a chance to match real model IDs.
			const {
				models: matchingModels,
				thinkingLevel,
				explicitThinkingLevel,
			} = resolveGlobScopePattern(pattern, availableModels);

			if (matchingModels.length === 0) {
				logger.warn(`No models match pattern "${pattern}"`);
				continue;
			}

			for (const model of matchingModels) {
				addScopedModel(model, thinkingLevel, explicitThinkingLevel);
			}
			continue;
		}

		const { model, thinkingLevel, warning, explicitThinkingLevel } = parseModelPatternWithContext(
			pattern,
			availableModels,
			context,
		);

		if (warning) {
			logger.warn(warning);
		}

		if (!model) {
			logger.warn(`No models match pattern "${pattern}"`);
			continue;
		}

		// Scoped models (Ctrl+P cycling) carry concrete per-model overrides;
		// `auto` lives on the session, so drop the sentinel here.
		if (thinkingLevel === AUTO_THINKING) {
			addScopedModel(model, undefined, false);
		} else {
			addScopedModel(model, thinkingLevel, explicitThinkingLevel);
		}
	}

	return scopedModels;
}

/**
 * Resolve the set of models a session is allowed to use, given the active
 * settings. Starts from `modelRegistry.getAvailable()` (so disabled providers
 * and providers without credentials are already filtered out) and, when
 * `enabledModels` is configured for the current path scope, further restricts
 * the result to models matching those patterns.
 *
 * Returns the unfiltered available list when `enabledModels` is empty.
 * Returns an empty list when `enabledModels` is configured but no model matches
 * any pattern — callers MUST treat this as "no usable model" rather than
 * falling back to the global default (see issue #1022).
 */
export async function resolveAllowedModels(
	modelRegistry: Pick<ModelRegistry, "getAvailable">,
	settings: Settings | undefined,
	preferences?: ModelMatchPreferences,
): Promise<Model<Api>[]> {
	const available = modelRegistry.getAvailable();
	const patterns = settings?.get("enabledModels");
	if (!patterns || patterns.length === 0) {
		return available;
	}
	const scoped = await resolveModelScope(patterns, modelRegistry, preferences);
	if (scoped.length === 0) {
		return [];
	}
	return includeSyntheticAllowedModels(
		available,
		scoped.map(entry => entry.model),
	);
}

/**
 * Synchronous subset of {@link resolveAllowedModels} for contexts where async is unavailable
 * (e.g. `getAvailableModels()` which is called from the ACP model-list advertisement, RPC
 * `get_available_models`, and the `/model` slash command). Uses the same effective
 * `enabledModels` scope semantics as startup resolution:
 *
 * - Glob selectors match `provider/modelId` and bare model id
 * - Exact `provider/modelId`, bare ids, provider-scoped fuzzy, and substring selectors
 *   resolve through the shared model-pattern matcher
 * - Optional `:thinkingLevel` suffixes are stripped only when valid
 *
 * When no pattern resolves to any model (misconfiguration / typo) an empty list is returned,
 * consistent with the empty-list contract of {@link resolveAllowedModels}. Callers that render
 * a UI picker should treat an empty list as "hide the picker entry", matching how the SDK
 * surfaces the same misconfiguration during session initialization.
 */
export function filterAvailableModelsByEnabledPatterns(
	available: Model<Api>[],
	patterns: readonly string[],
): Model<Api>[] {
	if (patterns.length === 0) return available;

	const context = buildPreferenceContext(available, undefined);
	const allowedModels: Model<Api>[] = [];
	for (const pattern of patterns) {
		if (isGlobPattern(pattern)) {
			allowedModels.push(...resolveGlobScopePattern(pattern, available).models);
			continue;
		}
		const { model } = parseModelPatternWithContext(pattern, available, context);
		if (model) allowedModels.push(model);
	}

	return includeSyntheticAllowedModels(available, allowedModels);
}

export interface ResolveCliModelResult {
	model: Model<Api> | undefined;
	selector?: string;
	thinkingLevel?: ConfiguredThinkingLevel;
	warning: string | undefined;
	error: string | undefined;
}

/**
 * The exact `provider/id` reference a CLI selector names, looked up among that
 * provider's models alone.
 *
 * {@link resolveCliModel} answers such a reference before any rule that reads
 * another provider's models, and {@link resolveProviderModelReference} reads
 * only models whose provider equals the named one ignoring case, so a hit here
 * is the model the whole-catalog path returns. A miss returns undefined and the
 * caller runs that path unchanged, which owns every error and fuzzy match.
 * Undefined as well when the registry cannot list one provider.
 */
function resolveNamedProviderReference(
	cliProvider: string | undefined,
	cliModel: string,
	modelRegistry: CliModelRegistry,
): Model<Api> | undefined {
	if (!modelRegistry.getProviderModels) return undefined;
	const trimmedModel = cliModel.trim();
	if (cliProvider) {
		const models = modelRegistry.getProviderModels(cliProvider);
		// The whole-catalog path names the provider as its LAST model in catalog order spells it.
		const provider = models.at(-1)?.provider;
		if (provider === undefined) return undefined;
		const prefix = `${provider}/`;
		const pattern = cliModel.toLowerCase().startsWith(prefix.toLowerCase())
			? cliModel.substring(prefix.length)
			: trimmedModel;
		const idPart = splitThinkingSuffix(pattern, -1, MAX_THINKING_SUFFIX_OPTIONS).base;
		if (idPart === "" || idPart === PROVIDER_WILDCARD_ID) return undefined;
		return resolveProviderModelReference(provider, pattern, models);
	}
	const slashIndex = trimmedModel.indexOf("/");
	if (slashIndex === -1) return undefined;
	const provider = trimmedModel.substring(0, slashIndex).trim();
	const modelId = trimmedModel.substring(slashIndex + 1).trim();
	if (!provider || !modelId) return undefined;
	return resolveProviderModelReference(provider, modelId, modelRegistry.getProviderModels(provider));
}

/**
 * Resolve a single model from CLI flags.
 */
export function resolveCliModel(options: {
	cliProvider?: string;
	cliModel?: string;
	modelRegistry: CliModelRegistry;
	preferences?: ModelMatchPreferences;
}): ResolveCliModelResult {
	const { cliProvider, cliModel, modelRegistry, preferences: callerPreferences } = options;
	// Default the ambiguity tie-break to the registry's own credential check so
	// every CLI resolution path prefers providers the user can actually call.
	const preferences: ModelMatchPreferences = {
		...callerPreferences,
		hasConfiguredAuth:
			callerPreferences?.hasConfiguredAuth ??
			(modelRegistry.hasConfiguredAuth ? model => modelRegistry.hasConfiguredAuth!(model) : undefined),
	};

	if (!cliModel) {
		return { model: undefined, selector: undefined, warning: undefined, error: undefined };
	}

	const named = resolveNamedProviderReference(cliProvider, cliModel, modelRegistry);
	if (named) {
		return {
			model: named,
			selector: formatModelString(named),
			warning: undefined,
			thinkingLevel: undefined,
			error: undefined,
		};
	}

	const availableModels = modelRegistry.getAll();
	// Every "nothing matched" exit reads the classifier, never a hand-built
	// sentence: an empty registry or one without usable credentials is an auth
	// failure, and a `Model "x" not found` here blamed the id for it whenever the
	// selector carried a `:level` suffix or an explicit `--provider`.
	const failureView: ModelRegistryView = {
		getProviders: () => [...new Set(availableModels.map(model => model.provider))],
		getAll: () => availableModels,
		getAvailable: () =>
			modelRegistry.getAvailable?.() ??
			(modelRegistry.hasConfiguredAuth
				? availableModels.filter(model => modelRegistry.hasConfiguredAuth!(model))
				: availableModels),
		getError: () => modelRegistry.getError?.(),
	};
	if (availableModels.length === 0) {
		return {
			model: undefined,
			selector: undefined,
			warning: undefined,
			error: modelResolutionFailureMessage([cliProvider ? `${cliProvider}/${cliModel}` : cliModel], failureView),
		};
	}

	const providerMap = new Map<string, string>();
	for (const model of availableModels) {
		providerMap.set(model.provider.toLowerCase(), model.provider);
	}

	let provider = cliProvider ? providerMap.get(cliProvider.toLowerCase()) : undefined;
	if (cliProvider && !provider) {
		return {
			model: undefined,
			selector: undefined,
			warning: undefined,
			error: `Unknown provider "${cliProvider}". Run "veyyon models" to see available providers/models.`,
		};
	}

	const trimmedModel = cliModel.trim();
	if (!provider) {
		const lower = trimmedModel.toLowerCase();
		// When input has provider/id format (e.g. "zai/glm-5"), prefer decomposed
		// provider+id match over flat id match. Without this, a model with id
		// "zai/glm-5" on provider "vercel-ai-gateway" wins over provider "zai"
		// with id "glm-5", because Array.find returns the first catalog hit.
		let exact = findExactModelReferenceMatch(trimmedModel, availableModels);
		if (!exact) {
			// Flat exact id (or full selector), preferring providers with stored
			// credentials: several providers can expose the same bare id (e.g.
			// `xai/grok-4.3` and `xai-oauth/grok-4.3`), and picking the first
			// catalog hit used to select a credential-less provider and die on
			// "No API key found" while a signed-in provider held the same model.
			// Within each group (authenticated / not) catalog order still decides,
			// so resolution stays deterministic across runs.
			const exactIdMatches = availableModels.filter(
				model => model.id.toLowerCase() === lower || `${model.provider}/${model.id}`.toLowerCase() === lower,
			);
			exact =
				exactIdMatches.length > 1 && modelRegistry.hasConfiguredAuth
					? (exactIdMatches.find(model => modelRegistry.hasConfiguredAuth?.(model)) ?? exactIdMatches[0])
					: exactIdMatches[0];
		}
		if (exact) {
			return {
				model: exact,
				selector: formatModelString(exact),
				warning: undefined,
				thinkingLevel: undefined,
				error: undefined,
			};
		}
	}

	let pattern = trimmedModel;

	if (!provider) {
		const slashIndex = cliModel.indexOf("/");
		if (slashIndex !== -1) {
			const maybeProvider = cliModel.substring(0, slashIndex);
			const canonical = providerMap.get(maybeProvider.toLowerCase());
			if (canonical) {
				provider = canonical;
				pattern = cliModel.substring(slashIndex + 1);
			}
		}
	} else {
		const prefix = `${provider}/`;
		if (cliModel.toLowerCase().startsWith(prefix.toLowerCase())) {
			pattern = cliModel.substring(prefix.length);
		}
	}

	if (provider) {
		const idPart = splitThinkingSuffix(pattern, -1, MAX_THINKING_SUFFIX_OPTIONS).base;
		if (idPart === "" || idPart === PROVIDER_WILDCARD_ID) {
			// A provider and no model is a selector error, not a lookup miss: the
			// matcher rejects it (see `matchModelLoosely`), and the remedy is the provider's
			// own default rather than a near-match list an empty id cannot produce.
			const suggested = isKnownProvider(provider)
				? `${provider}/${DEFAULT_MODEL_PER_PROVIDER[provider]}`
				: undefined;
			return {
				model: undefined,
				selector: undefined,
				thinkingLevel: undefined,
				warning: undefined,
				error:
					`Selector "${cliModel}" names provider "${provider}" and no model. ` +
					(suggested ? `Its default is "${suggested}"; ` : "") +
					`run "veyyon models ${provider}" to list its models.`,
			};
		}
		const exactProviderMatch = resolveProviderModelReference(provider, pattern, availableModels);
		if (exactProviderMatch) {
			return {
				model: exactProviderMatch,
				selector: formatModelString(exactProviderMatch),
				warning: undefined,
				thinkingLevel: undefined,
				error: undefined,
			};
		}
	}

	const candidates = provider ? availableModels.filter(model => model.provider === provider) : availableModels;
	const { model, thinkingLevel, warning, upstream } = parseModelPattern(pattern, candidates, preferences, {
		allowInvalidThinkingSelectorFallback: false,
	});

	if (!model) {
		const display = provider ? `${provider}/${pattern}` : cliModel;
		return {
			model: undefined,
			selector: undefined,
			thinkingLevel: undefined,
			warning,
			error: modelResolutionFailureMessage([display], failureView),
		};
	}

	let selector = provider ? formatModelString(model) : undefined;
	if (selector !== undefined && upstream) {
		selector = `${selector}@${upstream}`;
	}

	return {
		model,
		selector,
		thinkingLevel,
		warning,
		error: undefined,
	};
}
