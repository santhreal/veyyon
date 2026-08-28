import type { ThinkingLevel } from "@veyyon/agent-core/thinking";
import type { Api, Model } from "@veyyon/ai";
import { modelsAreEqual } from "@veyyon/catalog/models";
import { logger } from "@veyyon/utils";
import MODEL_PRIO from "../priority.json" with { type: "json" };
import { AUTO_THINKING, type ConfiguredThinkingLevel, resolveThinkingLevelForModel } from "../thinking";
import { isAuthenticated, kNoAuth } from "./auth-state";
import type { ModelRegistry } from "./model-registry";
import {
	applyUpstreamRouting,
	buildPreferenceContext,
	type CliModelRegistry,
	findExactModelReferenceMatch,
	formatModelString,
	getModelMatchPreferences,
	includeSyntheticAllowedModels,
	MAX_THINKING_SUFFIX_OPTIONS,
	type ModelLookupRegistry,
	type ModelMatchPreferences,
	type ModelPreferenceContext,
	matchModel,
	mergeModelMatchPreferences,
	parseModelString,
	resolveGlobScopePattern,
	resolveProviderModelReference,
	type ScopedModel,
	splitThinkingSuffix,
	splitUpstreamRouting,
	supportsUpstreamRouting,
} from "./model-resolver-helpers";
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

export {
	formatModelSelectorValue,
	formatModelString,
	formatModelStringWithRouting,
	getModelMatchPreferences,
	type ModelLookupRegistry,
	type ModelMatchPreferences,
	parseModelString,
	pickDefaultAvailableModel,
	resolveProviderModelReference,
	type ScopedModel,
	splitUpstreamRouting,
} from "./model-resolver-helpers";

export interface ParsedModelResult {
	model: Model<Api> | undefined;
	thinkingLevel?: ConfiguredThinkingLevel;
	upstream?: string;
	warning: string | undefined;
	explicitThinkingLevel: boolean;
}

function parseModelPatternWithContext(
	pattern: string,
	availableModels: readonly Model<Api>[],
	context: ModelPreferenceContext,
	options?: { allowInvalidThinkingSelectorFallback?: boolean },
): ParsedModelResult {
	const exactMatch = matchModel(pattern, availableModels, context);
	if (exactMatch) {
		return { model: exactMatch, thinkingLevel: undefined, warning: undefined, explicitThinkingLevel: false };
	}

	const { base, level } = splitThinkingSuffix(pattern, -1, MAX_THINKING_SUFFIX_OPTIONS);
	if (level) {
		const result = parseModelPatternWithContext(base, availableModels, context, options);
		if (result.model) {
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
		return { model: undefined, thinkingLevel: undefined, warning: undefined, explicitThinkingLevel: false };
	}
	const prefix = pattern.substring(0, lastColonIndex);
	const suffix = pattern.substring(lastColonIndex + 1);

	const allowFallback = options?.allowInvalidThinkingSelectorFallback ?? true;
	if (!allowFallback) {
		return { model: undefined, thinkingLevel: undefined, warning: undefined, explicitThinkingLevel: false };
	}

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

function matchPatternWithContext(
	pattern: string,
	availableModels: readonly Model<Api>[],
	context: ModelPreferenceContext,
	options?: { allowInvalidThinkingSelectorFallback?: boolean },
): ParsedModelResult {
	const direct = parseModelPatternWithContext(pattern, availableModels, context, options);
	if (direct.model) return direct;

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

export function normalizeModelPatternList(value: string | string[] | undefined): string[] {
	if (!value) return [];
	const patterns = Array.isArray(value) ? value.flatMap(pattern => pattern.split(",")) : value.split(",");
	return patterns.map(pattern => pattern.trim()).filter(Boolean);
}

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
		const existing = splitThinkingSuffix(pattern, -1, MAX_THINKING_SUFFIX_OPTIONS);
		return `${existing.base}:${thinkingLevel}`;
	});
}

export function expandRoleAlias(value: string, settings?: Settings): string {
	const normalized = value.trim();
	if (normalized === DEFAULT_MODEL_ROLE || normalized === DEFAULT_MODEL_ROLE_ALIAS) {
		return normalized;
	}
	if (
		normalized === formatModelRoleAlias(DEFAULT_MODEL_ROLE) &&
		settings?.getModelRole(DEFAULT_MODEL_ROLE) === undefined
	) {
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

export function resolveCompactionModelPatterns(settings?: Settings): string[] {
	const configured = settings?.get("compaction.model");
	const value = typeof configured === "string" ? configured.trim() : configured;
	if (!value || value.length === 0) return [];
	return resolveConfiguredModelPatterns(value, settings);
}

export interface ResolvedModelRoleValue {
	model: Model<Api> | undefined;
	thinkingLevel?: ConfiguredThinkingLevel;
	explicitThinkingLevel: boolean;
	warning: string | undefined;
}

export function resolveModelRoleValue(
	roleValue: string | undefined,
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

export function resolveModelFromSettings(options: {
	settings: Settings;
	availableModels: Model<Api>[];
	matchPreferences?: ModelMatchPreferences;
	roleOrder?: readonly ModelRole[];
}): Model<Api> | undefined {
	const { settings, availableModels, matchPreferences, roleOrder } = options;
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

interface RoleChainWalk {
	selection?: { model: Model<Api>; thinkingLevel?: ConfiguredThinkingLevel };
	misconfiguredRoles: string[];
}

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

export function resolveRoleSelection(
	roles: readonly string[],
	settings: Settings,
	availableModels: readonly Model<Api>[],
): { model: Model<Api>; thinkingLevel?: ConfiguredThinkingLevel } | undefined {
	return walkRoleChain(roles, settings, availableModels).selection;
}

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

export function fallbackForUnavailableDefault(
	configuredDefault: string | undefined,
	availableModels: readonly Model<Api>[],
): { model: Model<Api>; warning: string } | undefined {
	const model = availableModels[0];
	if (!model) return undefined;
	const subject = configuredDefault
		? `Configured default model "${configuredDefault}"`
		: "The configured default model";
	const configuredProvider = configuredDefault?.includes("/") ? configuredDefault.split("/")[0] : undefined;
	return {
		model,
		warning:
			`${subject} is unavailable: its provider has no stored credentials or the model no longer exists. ` +
			`Using ${model.provider}/${model.id} instead. Fix: run ` +
			`\`veyyon auth-broker login ${configuredProvider ?? "<provider>"}\` to sign in, or ` +
			"`veyyon models` to see what is available (`/model` picks a new default in an interactive veyyon session).",
	};
}

export function resolveAdvisorRoleSelection(
	settings: Settings,
	availableModels: readonly Model<Api>[],
	liveModel?: Model<Api>,
): { model: Model<Api>; thinkingLevel?: ConfiguredThinkingLevel } | undefined {
	return resolveRoleSelectionWithInherit(["advisor"], settings, availableModels, liveModel);
}

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
		if (pattern.includes("*") || pattern.includes("?") || pattern.includes("[")) {
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

		if (thinkingLevel === AUTO_THINKING) {
			addScopedModel(model, undefined, false);
		} else {
			addScopedModel(model, thinkingLevel, explicitThinkingLevel);
		}
	}

	return scopedModels;
}

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

export function resolveCliModel(options: {
	cliProvider?: string;
	cliModel?: string;
	modelRegistry: CliModelRegistry;
	settings?: Settings;
	preferences?: ModelMatchPreferences;
}): ResolveCliModelResult {
	const { cliProvider, cliModel, modelRegistry, settings, preferences: callerPreferences } = options;
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
		let exact = findExactModelReferenceMatch(trimmedModel, availableModels);
		if (!exact) {
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

export async function findSmolModel(
	modelRegistry: ModelLookupRegistry,
	savedModel?: string,
): Promise<Model<Api> | undefined> {
	const availableModels = modelRegistry.getAvailable();
	if (availableModels.length === 0) return undefined;

	if (savedModel) {
		const match = resolveModelFromString(savedModel, availableModels, undefined);
		if (match) return match;
	}

	for (const pattern of MODEL_PRIO.smol) {
		const providerMatch = availableModels.find(m => `${m.provider}/${m.id}`.toLowerCase() === pattern);
		if (providerMatch) return providerMatch;

		const exactMatch = parseModelPattern(pattern, availableModels, undefined).model;
		if (exactMatch) return exactMatch;

		const fuzzyMatch = availableModels.find(m => m.id.toLowerCase().includes(pattern));
		if (fuzzyMatch) return fuzzyMatch;
	}

	return availableModels[0];
}

export async function findSlowModel(
	modelRegistry: ModelLookupRegistry,
	savedModel?: string,
): Promise<Model<Api> | undefined> {
	const availableModels = modelRegistry.getAvailable();
	if (availableModels.length === 0) return undefined;

	if (savedModel) {
		const match = resolveModelFromString(savedModel, availableModels, undefined);
		if (match) return match;
	}

	for (const pattern of MODEL_PRIO.slow) {
		const exactMatch = parseModelPattern(pattern, availableModels, undefined).model;
		if (exactMatch) return exactMatch;

		const fuzzyMatch = availableModels.find(m => m.id.toLowerCase().includes(pattern.toLowerCase()));
		if (fuzzyMatch) return fuzzyMatch;
	}

	return availableModels[0];
}
