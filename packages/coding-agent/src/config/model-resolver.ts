/** Model resolution, scoping, and initial selection. Layering: */

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
import { fuzzyMatch } from "@veyyon/tui";
import { logger } from "@veyyon/utils";
import MODEL_PRIO from "../priority.json" with { type: "json" };
import {
	AUTO_THINKING,
	type ConfiguredThinkingLevel,
	concreteThinkingLevel,
	parseThinkingLevel,
	resolveThinkingLevelForModel,
} from "../thinking";
import { isAuthenticated, kNoAuth } from "./auth-state";
import type { ModelRegistry } from "./model-registry";
import {
	DEFAULT_MODEL_ROLE_ALIAS,
	DEFAULT_MODEL_SLOT,
	formatModelRoleAlias,
	LEGACY_MODEL_ROLE_ALIAS_PREFIX,
	MODEL_ROLE_ALIAS_PREFIX,
	MODEL_ROLE_IDS,
	type ModelRole,
} from "./model-roles";
import type { Settings } from "./settings";

function isKnownProvider(provider: string): provider is KnownProvider {
	return provider in DEFAULT_MODEL_PER_PROVIDER;
}

/** Pick the first provider-default model in availability order. If multiple providers expose that same default id, rank only that shared-id */
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
// Suffix recognition for the model-pattern parser: `:max` is a real thinking level and `:auto` maps to the auto sentinel. Both are gated behind flags
const MAX_THINKING_SUFFIX_OPTIONS: ThinkingSuffixOptions = { allowMaxSuffix: true, allowAutoAlias: true };

function parseThinkingSuffix(value: string, options?: ThinkingSuffixOptions): ConfiguredThinkingLevel | undefined {
	const level = parseThinkingLevel(value);
	if (level === ThinkingLevel.Max) return options?.allowMaxSuffix === true ? level : undefined;
	if (level !== undefined) return level;
	if (options?.allowAutoAlias === true && value === AUTO_THINKING) return AUTO_THINKING;
	return undefined;
}

/** Split a trailing `:<level>` thinking selector off a model pattern. `level` is set when the suffix parses as a concrete thinking level (or, when */
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
	// Glob scopes describe which models are enabled, not per-role thinking. Coerce the `auto` sentinel to a concrete-only view so scope callers stay
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

/** Parse a model string in "provider/modelId" format. Returns undefined if the format is invalid. */
export function parseModelString(
	modelStr: string,
	options?: ModelStringParseOptions,
): { provider: string; id: string; thinkingLevel?: ConfiguredThinkingLevel } | undefined {
	const slashIdx = modelStr.indexOf("/");
	if (slashIdx <= 0) return undefined;
	const id = modelStr.slice(slashIdx + 1);
	const provider = modelStr.slice(0, slashIdx);
	// Strip strict thinking level suffixes first (e.g. "claude-sonnet-4-6:high" -> id "claude-sonnet-4-6", thinkingLevel "high").
	const strict = splitThinkingSuffix(id);
	if (strict.level) return { provider, id: strict.base, thinkingLevel: strict.level };
	// `max` is a real thinking level, but real model IDs can also end in
	// `:max`. Context-aware callers pass a literal lookup so those models win.
	const maxAlias = splitThinkingSuffix(id, -1, options);
	if (maxAlias.level) {
		return options?.isLiteralModelId?.(provider, id) === true
			? { provider, id }
			: { provider, id: maxAlias.base, thinkingLevel: maxAlias.level };
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

/** Split a trailing `@<upstream>` provider-routing selector off a model pattern. This is a purely SYNTACTIC split: `openrouter/z-ai/glm-4.7@cerebras` -> base */
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
	/** Credential check used to break ambiguous matches toward providers the user can actually call. A credential-less provider is never the right */
	hasConfiguredAuth?: (model: Model<Api>) => boolean;
}

export type ModelLookupRegistry = Pick<ModelRegistry, "getAvailable">;
type CliModelRegistry = Pick<ModelRegistry, "getAll"> & Partial<Pick<ModelRegistry, "hasConfiguredAuth">>;

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
	settings?: Partial<Pick<Settings, "get" | "getStorage">>,
): ModelMatchPreferences {
	return {
		usageOrder: settings?.getStorage?.()?.getModelUsageOrder(),
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

/** Helper to check if a model ID looks like an alias (no date suffix) Dates are typically in format: -20241022 or -20250929 */
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
/** The single model-matching engine. Tries, in order: 1. exact `provider/id` reference (variant-alias and OpenRouter routed/date */
function matchModel(
	modelPattern: string,
	availableModels: readonly Model<Api>[],
	context: ModelPreferenceContext,
): Model<Api> | undefined {
	const exactRefMatch = findExactModelReferenceMatch(modelPattern, availableModels);
	if (exactRefMatch) {
		return exactRefMatch;
	}

	// Exact ID match (case-insensitive) — this must happen before provider-scoped fuzzy matching so raw IDs that contain slashes (for example OpenRouter model
	const lowerPattern = modelPattern.toLowerCase();
	const exactMatches = availableModels.filter(m => m.id.toLowerCase() === lowerPattern);
	if (exactMatches.length > 0) {
		return pickPreferredModel(exactMatches, context);
	}

	const bedrockInferenceProfile = resolveBedrockInferenceProfileModelId(modelPattern, availableModels);
	if (bedrockInferenceProfile) {
		return bedrockInferenceProfile;
	}

	// Retired effort-tier variant ids (bare, no provider prefix) resolve to their collapsed logical model; models from the providers whose table
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
		} else {
			// Let the routing fallback apply `@upstream` before fuzzy matching can consume the slug — but only for aggregator providers (OpenRouter / Vercel Gateway). Other
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

/** Parse a pattern to extract model and thinking level. Handles models with colons in their IDs (e.g., OpenRouter's :exacto suffix). */
function parseModelPatternWithContext(
	pattern: string,
	availableModels: readonly Model<Api>[],
	context: ModelPreferenceContext,
	options?: { allowInvalidThinkingSelectorFallback?: boolean },
): ParsedModelResult {
	// Try exact match first
	const exactMatch = matchModel(pattern, availableModels, context);
	if (exactMatch) {
		return { model: exactMatch, thinkingLevel: undefined, warning: undefined, explicitThinkingLevel: false };
	}

	// No match - try stripping a valid thinking suffix and recursing.
	// `max` is accepted only after the full pattern failed, so literal model IDs
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
		return result;
	}

	const lastColonIndex = pattern.lastIndexOf(":");
	if (lastColonIndex === -1) {
		// No colons, pattern simply doesn't match any model
		return { model: undefined, thinkingLevel: undefined, warning: undefined, explicitThinkingLevel: false };
	}
	const prefix = pattern.substring(0, lastColonIndex);
	const suffix = pattern.substring(lastColonIndex + 1);

	const allowFallback = options?.allowInvalidThinkingSelectorFallback ?? true;
	if (!allowFallback) {
		return { model: undefined, thinkingLevel: undefined, warning: undefined, explicitThinkingLevel: false };
	}

	// Invalid suffix - recurse on prefix and warn
	const result = parseModelPatternWithContext(prefix, availableModels, context, options);
	if (result.model) {
		return {
			model: result.model,
			thinkingLevel: undefined,
			warning: `Invalid thinking level "${suffix}" in pattern "${pattern}". Using default instead.`,
			explicitThinkingLevel: false,
		};
	}
	return result;
}

/** Match a single pattern with a pre-built preference context (direct match plus
 *  the `@upstream` routing fallback), so role resolution can reuse one context
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

const DEFAULT_MODEL_ROLE = "default";
const MODEL_ROLE_ALIAS_PREFIXES = [MODEL_ROLE_ALIAS_PREFIX, LEGACY_MODEL_ROLE_ALIAS_PREFIX];

function isModelRole(role: string): role is ModelRole {
	return (MODEL_ROLE_IDS as string[]).includes(role);
}

/** Minimum colon index for splitting a `:<level>` suffix off a role alias, or `undefined` when `value` is not role-alias shaped. Doubles as the slice */
function modelRoleAliasPrefixLength(value: string): number | undefined {
	if (value === DEFAULT_MODEL_ROLE_ALIAS || value.startsWith(`${DEFAULT_MODEL_ROLE_ALIAS}:`)) return 0;
	return MODEL_ROLE_ALIAS_PREFIXES.find(prefix => value.startsWith(prefix))?.length;
}

function getModelRoleAlias(value: string, settings?: Settings): string | undefined {
	const normalized = value.trim();
	const prefixLength = modelRoleAliasPrefixLength(normalized);
	if (prefixLength === undefined) return undefined;

	const candidate = normalized === DEFAULT_MODEL_ROLE_ALIAS ? DEFAULT_MODEL_ROLE : normalized.slice(prefixLength);
	if (isModelRole(candidate) || settings?.getModelRole(candidate) !== undefined) return candidate;
	return undefined;
}

/** Split a configured model value into its ordered chain of patterns. `"opus,sonnet"` and `["opus", "sonnet"]` are the same chain. This is the ONE */
export function normalizeModelPatternList(value: string | string[] | undefined): string[] {
	if (!value) return [];
	const patterns = Array.isArray(value) ? value.flatMap(pattern => pattern.split(",")) : value.split(",");
	return patterns.map(pattern => pattern.trim()).filter(Boolean);
}

/** Expand one configured pattern, resolving a `@role` alias to the model the role is configured with. */
function resolveConfiguredRolePattern(
	value: string,
	settings?: Settings,
	visited: Set<string> = new Set(),
): string[] | undefined {
	const normalized = value.trim();
	if (!normalized) return undefined;

	const { base: aliasCandidate, level: thinkingLevel } = splitThinkingSuffix(
		normalized,
		modelRoleAliasPrefixLength(normalized) ?? LEGACY_MODEL_ROLE_ALIAS_PREFIX.length,
		MAX_THINKING_SUFFIX_OPTIONS,
	);
	const role = getModelRoleAlias(aliasCandidate, settings);
	if (!role) {
		// A `@name` that matches no role is not a model pattern either — no provider or model id starts with `@` — so resolving it to the literal string only
		if (normalized.startsWith(MODEL_ROLE_ALIAS_PREFIX)) return undefined;
		return [normalized];
	}
	if (visited.has(role)) return undefined;
	visited.add(role);

	const configured = settings?.getModelRole(role)?.trim();
	const resolved = configured ? normalizeModelPatternList(configured) : [];
	if (resolved.length === 0) {
		return undefined;
	}

	if (!thinkingLevel) return resolved;
	return resolved.map(pattern => {
		// The alias suffix is the selector nearest the caller and therefore
		// replaces a valid suffix stored on the aliased role. Appending produced
		// `model:high:low`, leaving two contradictory selectors in one value.
		const existing = splitThinkingSuffix(pattern, -1, MAX_THINKING_SUFFIX_OPTIONS);
		return `${existing.base}:${thinkingLevel}`;
	});
}

/**
 * Expand a role alias like "@smol" to the configured model string.
 */
export function expandRoleAlias(value: string, settings?: Settings): string {
	const normalized = value.trim();
	if (normalized === DEFAULT_MODEL_ROLE || normalized === DEFAULT_MODEL_ROLE_ALIAS) {
		// Bare "default" / "*" are inherit/wildcard sentinels, never expanded.
		return normalized;
	}
	if (
		normalized === formatModelRoleAlias(DEFAULT_MODEL_ROLE) &&
		settings?.getModelRole(DEFAULT_MODEL_ROLE) === undefined
	) {
		// "@default" with no stored legacy default role stays literal; when the
		// role IS configured it expands like any other alias (#980 fail-closed).
		return normalized;
	}

	const resolved = resolveConfiguredRolePattern(value, settings)?.[0];
	return resolved ?? value;
}

export function resolveConfiguredModelPatterns(value: string | string[] | undefined, settings?: Settings): string[] {
	const patterns = normalizeModelPatternList(value);
	return patterns.flatMap(pattern => {
		const resolved = resolveConfiguredRolePattern(pattern, settings);
		return resolved ?? [];
	});
}
/* There is deliberately no agent-model resolver here. `resolveAgentModelPatterns` used to live at this spot and re-implemented the */

/** Resolve the configured compaction model chain from settings (`compaction.model`), in the order compaction should try them. */
export function resolveCompactionModelPatterns(settings?: Settings): string[] {
	const configured = settings?.get("compaction.model");
	const value = typeof configured === "string" ? configured.trim() : configured;
	if (!value || value.length === 0) return [];
	return resolveConfiguredModelPatterns(value, settings);
}

/**
 * Resolve a model role value into a concrete model and thinking metadata.
 */
export interface ResolvedModelRoleValue {
	model: Model<Api> | undefined;
	thinkingLevel?: ConfiguredThinkingLevel;
	explicitThinkingLevel: boolean;
	warning: string | undefined;
}

export function resolveModelRoleValue(
	roleValue: string | undefined,
	// Readonly: this only reads the list, and callers legitimately hold a readonly
	// model list (the settings selector's picker does), which a mutable parameter
	// type rejected.
	availableModels: readonly Model<Api>[],
	options?: { settings?: Settings; matchPreferences?: ModelMatchPreferences },
): ResolvedModelRoleValue {
	if (!roleValue) {
		return { model: undefined, thinkingLevel: undefined, explicitThinkingLevel: false, warning: undefined };
	}

	const normalized = roleValue.trim();
	if (!normalized || normalized === DEFAULT_MODEL_ROLE) {
		return { model: undefined, thinkingLevel: undefined, explicitThinkingLevel: false, warning: undefined };
	}

	const effectivePatterns = resolveConfiguredModelPatterns(normalized, options?.settings);
	if (!effectivePatterns || effectivePatterns.length === 0) {
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
	settings?: Settings,
	options?: ExplicitThinkingSelectorOptions,
): ConfiguredThinkingLevel | undefined {
	if (!value) return undefined;
	const normalized = value.trim();
	if (!normalized || normalized === DEFAULT_MODEL_ROLE) return undefined;

	const visited = new Set<string>();
	let current = normalized;
	while (!visited.has(current)) {
		visited.add(current);
		const rolePrefixLength = modelRoleAliasPrefixLength(current) ?? LEGACY_MODEL_ROLE_ALIAS_PREFIX.length;
		const strictSelector = splitThinkingSuffix(current, rolePrefixLength).level;
		if (strictSelector) {
			return strictSelector;
		}
		const maxSelector = splitThinkingSuffix(current, rolePrefixLength, MAX_THINKING_SUFFIX_OPTIONS).level;
		if (
			maxSelector &&
			(modelRoleAliasPrefixLength(current) !== undefined || !isLiteralModelSelector(current, options))
		) {
			return maxSelector;
		}
		const expanded = expandRoleAlias(current, settings).trim();
		if (!expanded || expanded === current) break;
		if (expanded === DEFAULT_MODEL_ROLE) return undefined;
		current = expanded;
	}

	return undefined;
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

/**
 * Resolve a model from configured roles, honoring order and overrides.
 */
export function resolveModelFromSettings(options: {
	settings: Settings;
	availableModels: Model<Api>[];
	matchPreferences?: ModelMatchPreferences;
	roleOrder?: readonly ModelRole[];
}): Model<Api> | undefined {
	const { settings, availableModels, matchPreferences, roleOrder } = options;
	// The legacy "default" role is hidden from pickers (not in MODEL_ROLE_IDS) but remains a valid stored assignment and must be honored first — a
	const roles = roleOrder ?? [DEFAULT_MODEL_SLOT, ...MODEL_ROLE_IDS];
	let sawConfiguredProviderQualifiedRole = false;
	for (const role of roles) {
		const configured = settings.getModelRole(role);
		if (!configured) continue;
		const expanded = expandRoleAlias(configured, settings).trim();
		if (expanded.includes("/")) {
			sawConfiguredProviderQualifiedRole = true;
		}
		const resolved = resolveModelFromString(expanded, availableModels, matchPreferences);
		if (resolved) return resolved;
	}
	return sawConfiguredProviderQualifiedRole ? undefined : availableModels[0];
}

/**
 * Resolve a list of override patterns to the first matching model.
 */
export function resolveModelOverride(
	modelPatterns: string[],
	modelRegistry: ModelLookupRegistry,
	settings?: Settings,
): { model?: Model<Api>; thinkingLevel?: ConfiguredThinkingLevel; explicitThinkingLevel: boolean; warning?: string } {
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
		} = resolveModelRoleValue(pattern, availableModels, {
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

/** Resolve a list of override patterns to the first matching model, with an auth-aware fallback to the parent session's active model. */
export async function resolveModelOverrideWithAuthFallback(
	modelPatterns: string[],
	parentActiveModelPattern: string | undefined,
	modelRegistry: ModelLookupRegistry & Pick<ModelRegistry, "getApiKey">,
	settings?: Settings,
	sessionId?: string,
): Promise<{
	model?: Model<Api>;
	thinkingLevel?: ConfiguredThinkingLevel;
	explicitThinkingLevel: boolean;
	authFallbackUsed: boolean;
	warning?: string;
}> {
	const primary = resolveModelOverride(modelPatterns, modelRegistry, settings);
	if (!primary.model || !parentActiveModelPattern) {
		return { ...primary, authFallbackUsed: false };
	}

	const primaryKey = await modelRegistry.getApiKey(primary.model, sessionId);
	if (primaryKey === kNoAuth || isAuthenticated(primaryKey)) {
		return { ...primary, authFallbackUsed: false };
	}

	const fallback = resolveModelOverride([parentActiveModelPattern], modelRegistry, settings);
	if (!fallback.model) {
		return { ...primary, authFallbackUsed: false };
	}
	if (modelsAreEqual(fallback.model, primary.model)) {
		return { ...primary, authFallbackUsed: false };
	}
	const fallbackKey = await modelRegistry.getApiKey(fallback.model, sessionId);
	if (!isAuthenticated(fallbackKey)) {
		return { ...primary, authFallbackUsed: false };
	}

	return { ...fallback, authFallbackUsed: true, warning: primary.warning ?? fallback.warning };
}

/** A role chain walk: the winning selection, plus the roles that were set but could not resolve. */
interface RoleChainWalk {
	selection?: { model: Model<Api>; thinkingLevel?: ConfiguredThinkingLevel };
	/** Roles carrying a configured value that matched no available model. */
	misconfiguredRoles: string[];
}

/** Walk a role chain in order, returning the first role that resolves plus every role that was CONFIGURED yet matched no available model. */
function walkRoleChain(
	roles: readonly string[],
	settings: Settings,
	availableModels: readonly Model<Api>[],
): RoleChainWalk {
	const matchPreferences = getModelMatchPreferences(settings);
	const misconfiguredRoles: string[] = [];
	for (const role of roles) {
		const configured = settings.getModelRole(role)?.trim();
		const resolved = resolveModelRoleValue(configured, availableModels, { settings, matchPreferences });
		if (resolved.model) {
			return { selection: { model: resolved.model, thinkingLevel: resolved.thinkingLevel }, misconfiguredRoles };
		}
		if (configured) misconfiguredRoles.push(role);
	}
	return { misconfiguredRoles };
}

/**
 * Resolve a list of role patterns to the first matching model.
 */
export function resolveRoleSelection(
	roles: readonly string[],
	settings: Settings,
	availableModels: readonly Model<Api>[],
): { model: Model<Api>; thinkingLevel?: ConfiguredThinkingLevel } | undefined {
	return walkRoleChain(roles, settings, availableModels).selection;
}

/** Role resolution with the inherit default: configured roles win; when every role in the chain is UNSET the live main model is inherited. Headless contexts */
export function resolveRoleSelectionWithInherit(
	roles: readonly string[],
	settings: Settings,
	availableModels: readonly Model<Api>[],
	liveModel?: Model<Api>,
): { model: Model<Api>; thinkingLevel?: ConfiguredThinkingLevel } | undefined {
	const { selection, misconfiguredRoles } = walkRoleChain(roles, settings, availableModels);
	if (selection) return selection;
	if (misconfiguredRoles.length > 0) return undefined;
	if (liveModel) return { model: liveModel, thinkingLevel: undefined };
	const persisted = resolveModelRoleValue(settings.getModelRole(DEFAULT_MODEL_SLOT), availableModels, {
		settings,
		matchPreferences: getModelMatchPreferences(settings),
	});
	return persisted.model ? { model: persisted.model, thinkingLevel: persisted.thinkingLevel } : undefined;
}

/** Single owner of the "configured default model is unavailable" substitution: when the persisted `default` role points at a model whose provider has no */
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
	// This warning reaches `veyyon commit`, `--print` startup and `bench` as well as the interactive session (see the doc comment above), so the remedies are
	return {
		model,
		warning:
			`${subject} is unavailable: its provider has no stored credentials or the model no longer exists. ` +
			`Using ${model.provider}/${model.id} instead. Fix: run ` +
			`\`veyyon auth-broker login ${configuredProvider ?? "<provider>"}\` to sign in, or ` +
			"`veyyon models` to see what is available (`/model` picks a new default in an interactive veyyon session).",
	};
}

/** Resolve the model for the `advisor` role. A configured `modelRoles.advisor` wins outright (a bad override surfaces as no model rather than silently */
export function resolveAdvisorRoleSelection(
	settings: Settings,
	availableModels: readonly Model<Api>[],
	liveModel?: Model<Api>,
): { model: Model<Api>; thinkingLevel?: ConfiguredThinkingLevel } | undefined {
	return resolveRoleSelectionWithInherit(["advisor"], settings, availableModels, liveModel);
}

/** Resolve model patterns to actual Model objects with optional thinking levels Format: "pattern:level" where :level is optional */
export async function resolveModelScope(
	patterns: string[],
	modelRegistry: Pick<ModelRegistry, "getAvailable">,
	preferences?: ModelMatchPreferences,
	settings?: Settings,
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
		// Check if pattern contains glob characters
		if (pattern.includes("*") || pattern.includes("?") || pattern.includes("[")) {
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

		// Role aliases (`@smol`, `pi/slow`) resolve to the role's single concrete model — not its whole fallback chain — so a role contributes one scope
		if (settings && modelRoleAliasPrefixLength(pattern) !== undefined) {
			const resolved = resolveModelRoleValue(pattern, availableModels, { settings, matchPreferences: preferences });
			if (resolved.warning) logger.warn(resolved.warning);
			if (!resolved.model) {
				logger.warn(`No models match pattern "${pattern}"`);
				continue;
			}
			if (resolved.thinkingLevel === AUTO_THINKING) {
				addScopedModel(resolved.model, undefined, false);
			} else {
				addScopedModel(resolved.model, resolved.thinkingLevel, resolved.explicitThinkingLevel);
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

/** Resolve the set of models a session is allowed to use, given the active settings. Starts from `modelRegistry.getAvailable()` (so disabled providers */
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
	const scoped = await resolveModelScope(patterns, modelRegistry, preferences, settings);
	if (scoped.length === 0) {
		return [];
	}
	return includeSyntheticAllowedModels(
		available,
		scoped.map(entry => entry.model),
	);
}

/** Synchronous subset of {@link resolveAllowedModels} for contexts where async is unavailable (e.g. `getAvailableModels()` which is called from the ACP model-list advertisement, RPC */
export function filterAvailableModelsByEnabledPatterns(
	available: Model<Api>[],
	patterns: readonly string[],
	settings?: Settings,
): Model<Api>[] {
	if (patterns.length === 0) return available;

	const context = buildPreferenceContext(available, undefined);
	const allowedModels: Model<Api>[] = [];
	const addAllowed = (model: Model<Api>) => {
		allowedModels.push(model);
	};

	for (const pattern of patterns) {
		if (pattern.includes("*") || pattern.includes("?") || pattern.includes("[")) {
			for (const model of resolveGlobScopePattern(pattern, available).models) {
				addAllowed(model);
			}
			continue;
		}

		// Mirror resolveModelScope: role aliases resolve to the role's model.
		if (settings && modelRoleAliasPrefixLength(pattern) !== undefined) {
			const { model } = resolveModelRoleValue(pattern, available, { settings });
			if (model) addAllowed(model);
			continue;
		}

		const { model } = parseModelPatternWithContext(pattern, available, context);
		if (model) {
			addAllowed(model);
		}
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
 * Resolve a single model from CLI flags.
 */
export function resolveCliModel(options: {
	cliProvider?: string;
	cliModel?: string;
	modelRegistry: CliModelRegistry;
	settings?: Settings;
	preferences?: ModelMatchPreferences;
}): ResolveCliModelResult {
	const { cliProvider, cliModel, modelRegistry, settings, preferences: callerPreferences } = options;
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

	const availableModels = modelRegistry.getAll();
	if (availableModels.length === 0) {
		return {
			model: undefined,
			selector: undefined,
			warning: undefined,
			error: "No models available. Check your installation or add models to models.json.",
		};
	}

	if (!cliProvider && modelRoleAliasPrefixLength(cliModel) !== undefined) {
		const resolved = resolveModelRoleValue(cliModel, availableModels, { settings, matchPreferences: preferences });
		if (resolved.model) {
			return {
				model: resolved.model,
				selector: formatModelString(resolved.model),
				thinkingLevel: resolved.thinkingLevel,
				warning: resolved.warning,
				error: undefined,
			};
		}
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
		// When input has provider/id format (e.g. "zai/glm-5"), prefer decomposed provider+id match over flat id match. Without this, a model with id
		let exact = findExactModelReferenceMatch(trimmedModel, availableModels);
		if (!exact) {
			// Flat exact id (or full selector), preferring providers with stored credentials: several providers can expose the same bare id (e.g.
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
			error: `Model "${display}" not found. Run "veyyon models" to see available models.`,
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

/** Find a smol/fast model using the priority chain. Tries exact matches first, then fuzzy matches. */
export async function findSmolModel(
	modelRegistry: ModelLookupRegistry,
	savedModel?: string,
): Promise<Model<Api> | undefined> {
	const availableModels = modelRegistry.getAvailable();
	if (availableModels.length === 0) return undefined;

	// 1. Try saved model from settings
	if (savedModel) {
		const match = resolveModelFromString(savedModel, availableModels, undefined);
		if (match) return match;
	}

	// 2. Try priority chain
	for (const pattern of MODEL_PRIO.smol) {
		// Try exact match with provider prefix
		const providerMatch = availableModels.find(m => `${m.provider}/${m.id}`.toLowerCase() === pattern);
		if (providerMatch) return providerMatch;

		// Try exact match first
		const exactMatch = parseModelPattern(pattern, availableModels, undefined).model;
		if (exactMatch) return exactMatch;

		// Try fuzzy match (substring)
		const fuzzyMatch = availableModels.find(m => m.id.toLowerCase().includes(pattern));
		if (fuzzyMatch) return fuzzyMatch;
	}

	// 3. Fallback to first available (same as default)
	return availableModels[0];
}

/** Find a slow/comprehensive model using the priority chain. Prioritizes reasoning and codex models for thorough analysis. */
export async function findSlowModel(
	modelRegistry: ModelLookupRegistry,
	savedModel?: string,
): Promise<Model<Api> | undefined> {
	const availableModels = modelRegistry.getAvailable();
	if (availableModels.length === 0) return undefined;

	// 1. Try saved model from settings
	if (savedModel) {
		const match = resolveModelFromString(savedModel, availableModels, undefined);
		if (match) return match;
	}

	// 2. Try priority chain
	for (const pattern of MODEL_PRIO.slow) {
		// Try exact match first
		const exactMatch = parseModelPattern(pattern, availableModels, undefined).model;
		if (exactMatch) return exactMatch;

		// Try fuzzy match (substring)
		const fuzzyMatch = availableModels.find(m => m.id.toLowerCase().includes(pattern.toLowerCase()));
		if (fuzzyMatch) return fuzzyMatch;
	}

	// 3. Fallback to first available (same as default)
	return availableModels[0];
}
