/**
 * The model and thinking level a session starts on.
 *
 * Selection runs in two passes because extension providers register between them. The first
 * pass restores the session's last model or the settings default, so model-dependent setup
 * (thinking-level resolution, the host preconnect) starts on it. The second runs once every
 * provider is visible: it retries the session's model candidates, resolves deferred `--model`
 * patterns, falls back to the first authenticated model, and refreshes the chosen model's
 * metadata.
 */

import type { ThinkingLevel } from "@veyyon/agent-core";
import type { Model } from "@veyyon/ai";
import { getRestorableSessionModels, type SessionContext } from "@veyyon/kernel/session/session-context";
import type { SessionManager } from "@veyyon/kernel/session/session-manager";
import { logger } from "@veyyon/utils";
import { isAuthenticated, kNoAuth } from "../config/auth-state";
import { type EffortSource, resolveEffort, withLegacyDefaultEffort } from "../config/effort-resolver";
import type { ModelRegistry } from "../config/model-registry";
import { modelResolutionFailureMessage } from "../config/model-resolution-failure";
import {
	formatModelSelectorValue,
	formatModelStringWithRouting,
	getModelMatchPreferences,
	type ModelMatchPreferences,
	type ParsedModelResult,
	parseModelPattern,
	parseModelString,
	pickDefaultAvailableModel,
	type ResolvedModelRoleValue,
	resolveAllowedModels,
	resolveConfiguredModelPatterns,
	resolveModelRoleValue,
} from "../config/model-resolver";
import { DEFAULT_MODEL_SLOT } from "../config/model-roles";
import type { Settings } from "../config/settings";
import {
	AUTO_THINKING,
	type ConfiguredThinkingLevel,
	concreteThinkingLevel,
	parseConfiguredThinkingLevel,
	parseThinkingLevel,
	resolveProvisionalAutoLevel,
	resolveThinkingLevelForModel,
} from "../thinking";
import type { CreateAgentSessionOptions } from "./factory-options";

/** What selection reads. Every field is read, never written, except the settings overrides a fallback role installs. */
export interface StartupModelInputs {
	options: Pick<
		CreateAgentSessionOptions,
		| "model"
		| "modelPattern"
		| "modelPatternAuthFallback"
		| "modelPatternFallbackRole"
		| "thinkingLevel"
		| "thinkingSource"
	>;
	settings: Settings;
	modelRegistry: ModelRegistry;
	sessionManager: SessionManager;
	/** The context the session resumes. */
	existingSession: SessionContext;
	hasExistingSession: boolean;
	/** Whether the resumed branch records a thinking-level change. */
	hasThinkingEntry: boolean;
}

/** A pattern match that found a model. */
type MatchedModel = ParsedModelResult & { model: Model };

function isMatched(result: ParsedModelResult): result is MatchedModel {
	return result.model !== undefined;
}

/** The deferred `--model` patterns, trimmed, with empty ones dropped. */
function deferredModelPatterns(modelPattern: string | string[] | undefined): string[] {
	if (Array.isArray(modelPattern)) return modelPattern.map(pattern => pattern.trim()).filter(Boolean);
	const trimmed = modelPattern?.trim();
	return trimmed ? [trimmed] : [];
}

/**
 * Best-effort preconnect to the model's API host. Bun's `fetch.preconnect` primes DNS + TCP +
 * TLS + H2 so the first real request reuses the warm connection. Errors are swallowed:
 * preconnect is an optimization, never a hard dependency.
 */
function preconnectModelHost(baseUrl: string | undefined): void {
	if (!baseUrl) return;
	const preconnect = (globalThis.fetch as typeof fetch & { preconnect?: (url: string) => void }).preconnect;
	if (typeof preconnect !== "function") return;
	try {
		preconnect(baseUrl);
	} catch {
		// Best effort.
	}
}

/**
 * Make `primary` the `role` model and the later distinct matches its retry fallback chain.
 *
 * Only settings overrides are written, so the chain lives for this process and never reaches
 * the config file.
 */
function installPatternFallbackChain(
	settings: Settings,
	role: string,
	primary: MatchedModel,
	laterPatterns: readonly string[],
	availableModels: readonly Model[],
	matchPreferences: ModelMatchPreferences,
): void {
	const primarySelector = formatModelSelectorValue(formatModelStringWithRouting(primary.model), primary.thinkingLevel);
	const seenSelectors = new Set<string>([primarySelector]);
	const fallbackSelectors: string[] = [];
	for (const fallbackPattern of laterPatterns) {
		const fallback = parseModelPattern(fallbackPattern, availableModels, matchPreferences);
		if (!fallback.model) continue;
		const fallbackSelector = formatModelSelectorValue(
			formatModelStringWithRouting(fallback.model),
			fallback.thinkingLevel,
		);
		if (seenSelectors.has(fallbackSelector)) continue;
		seenSelectors.add(fallbackSelector);
		fallbackSelectors.push(fallbackSelector);
	}
	if (fallbackSelectors.length === 0) return;

	const modelRoles: Record<string, string> = {};
	const existingRoles = settings.getModelRoles();
	for (const existingRole in existingRoles) {
		const selector = existingRoles[existingRole];
		if (selector) modelRoles[existingRole] = selector;
	}
	modelRoles[role] = primarySelector;
	settings.override("modelRoles", modelRoles);

	const fallbackChains: Record<string, string[]> = { [role]: fallbackSelectors };
	const existingFallbackChains = settings.get("retry.fallbackChains");
	for (const chainRole in existingFallbackChains) {
		if (chainRole !== role) fallbackChains[chainRole] = existingFallbackChains[chainRole];
	}
	settings.override("retry.fallbackChains", fallbackChains);
}

export class StartupModelSelection {
	/** Whether the caller named a model, directly or through `--model` patterns. */
	readonly hasExplicitModel: boolean;
	readonly #inputs: StartupModelInputs;
	readonly #deferredPatterns: string[];
	readonly #matchPreferences: ModelMatchPreferences;
	/** The session's model strings, in the order a resume tries them. */
	readonly #sessionModelStrings: string[];
	#defaultRoleSpec: ResolvedModelRoleValue;
	#model: Model | undefined;
	#fallbackMessage: string | undefined;
	#restoredIndex = -1;
	#restoredThinkingLevel: ConfiguredThinkingLevel | undefined;
	#autoThinking = false;
	#effectiveThinkingLevel: ThinkingLevel | undefined;
	#thinkingSource: EffortSource = "model-default";

	/** Run the first pass: the session's last model, else the settings default. */
	static async begin(inputs: StartupModelInputs): Promise<StartupModelSelection> {
		const { settings, modelRegistry } = inputs;
		const matchPreferences = getModelMatchPreferences(settings);
		const allowedModels = await logger.time("resolveAllowedModels", () =>
			resolveAllowedModels(modelRegistry, settings, matchPreferences),
		);
		const defaultRoleSpec = logger.time("resolveDefaultModelRole", () =>
			resolveModelRoleValue(settings.getModelRole(DEFAULT_MODEL_SLOT), allowedModels, {
				settings,
				matchPreferences,
			}),
		);
		const selection = new StartupModelSelection(inputs, matchPreferences, defaultRoleSpec);
		selection.#restoreSessionModel();
		selection.#useSettingsDefault();
		const model = selection.#model;
		selection.#settleThinking(model);
		// Fire-and-forget TLS+H2 handshake to the model's host so it overlaps with the rest of
		// session setup (extension/skill load, tool registry, system prompt build). Without this,
		// the first `fetch(...)` pays the full handshake serially — 100–300 ms transcontinental
		// for api.anthropic.com from a residential IP. Every mode benefits (interactive, print,
		// rpc, acp).
		if (model) preconnectModelHost(model.baseUrl);
		return selection;
	}

	private constructor(
		inputs: StartupModelInputs,
		matchPreferences: ModelMatchPreferences,
		defaultRoleSpec: ResolvedModelRoleValue,
	) {
		const { options, sessionManager, existingSession, hasExistingSession } = inputs;
		this.#inputs = inputs;
		this.#deferredPatterns = deferredModelPatterns(options.modelPattern);
		this.hasExplicitModel = options.model !== undefined || this.#deferredPatterns.length > 0;
		this.#matchPreferences = matchPreferences;
		this.#defaultRoleSpec = defaultRoleSpec;
		this.#model = options.model;
		this.#sessionModelStrings =
			!this.hasExplicitModel && hasExistingSession
				? getRestorableSessionModels(existingSession.models, sessionManager.getLastModelChangeRole())
				: [];
	}

	/** The selected model, or undefined when nothing resolved. */
	get model(): Model | undefined {
		return this.#model;
	}

	/** Why the selection is not what was asked for, or undefined when it is. */
	get fallbackMessage(): string | undefined {
		return this.#fallbackMessage;
	}

	/** Whether the session starts on the `auto` thinking selector. */
	get autoThinking(): boolean {
		return this.#autoThinking;
	}

	/**
	 * The concrete level the agent and session start with. With `auto` this is the provisional
	 * level shown until the first per-turn classification resolves; `auto` itself stays a
	 * session-only concept handled by AgentSession.
	 */
	get effectiveThinkingLevel(): ThinkingLevel | undefined {
		return this.#effectiveThinkingLevel;
	}

	/** Where the thinking level came from, so a model switch can keep a session override. */
	get thinkingSource(): EffortSource {
		return this.#thinkingSource;
	}

	/** Run the second pass, after extension providers registered. */
	async completeAfterExtensions(): Promise<void> {
		this.#reclaimSessionModel();
		if (!this.#model && this.#deferredPatterns.length > 0) await this.#resolveDeferredPatterns();
		if (!this.#model && this.#deferredPatterns.length === 0) await this.#resolveFallbackModel();
		await this.#refreshSelectedMetadata();
	}

	/**
	 * Startup model *selection* only needs to know whether auth is configured for a candidate's
	 * provider — never the resolved key bytes. The synchronous, side-effect-free probe refreshes
	 * no OAuth tokens, executes no `!command` keys, and issues no auth-broker requests. Resolving
	 * the real key here (`getApiKey`) blocks resume on those network paths — a slow or
	 * unreachable OAuth/broker endpoint stalls startup for the full ~10s refresh timeout per
	 * candidate (observed as a hang in `restoreSessionModel`). The real key is resolved lazily
	 * per request via ModelRegistry.resolver.
	 */
	#hasAuth(candidate: Model): boolean {
		return this.#inputs.modelRegistry.hasConfiguredAuth(candidate);
	}

	/** The authenticated model session candidate `index` names, or undefined when it names none. */
	#sessionCandidate(index: number): { model: Model; thinkingLevel: ConfiguredThinkingLevel | undefined } | undefined {
		const { modelRegistry } = this.#inputs;
		const parsedModel = parseModelString(this.#sessionModelStrings[index], {
			allowMaxSuffix: true,
			allowAutoAlias: true,
			isLiteralModelId: (provider, id) => modelRegistry.find(provider, id) !== undefined,
		});
		if (!parsedModel) return undefined;
		const restoredModel = modelRegistry.find(parsedModel.provider, parsedModel.id);
		if (!restoredModel || !this.#hasAuth(restoredModel)) return undefined;
		return { model: restoredModel, thinkingLevel: parsedModel.thinkingLevel };
	}

	/**
	 * Restore the session's model strings in fallback order. Extension-registered providers are
	 * not visible yet, so `#reclaimSessionModel` retries the preferred candidates once they are.
	 */
	#restoreSessionModel(): void {
		if (this.hasExplicitModel || this.#model || this.#sessionModelStrings.length === 0) return;
		logger.time("restoreSessionModel", () => {
			let failedSessionModel: string | undefined;
			for (let i = 0; i < this.#sessionModelStrings.length; i++) {
				const candidate = this.#sessionCandidate(i);
				if (candidate) {
					this.#model = candidate.model;
					this.#restoredIndex = i;
					this.#restoredThinkingLevel = candidate.thinkingLevel;
					break;
				}
				failedSessionModel ??= this.#sessionModelStrings[i];
			}
			if (failedSessionModel) {
				this.#fallbackMessage = `Could not restore model ${failedSessionModel}`;
			}
		});
	}

	/** With no model yet and none requested, take the settings default. */
	#useSettingsDefault(): void {
		const settingsDefaultModel = this.#defaultRoleSpec.model;
		if (this.hasExplicitModel || this.#model || !settingsDefaultModel) return;
		logger.time("resolveSettingsDefaultModel", () => {
			// defaultRoleSpec.model already comes from modelRegistry.getAvailable(), so
			// re-validating auth here just repeats the expensive lookup path.
			this.#model = settingsDefaultModel;
		});
	}

	/** Resolve one effort axis and remember its source. */
	#pickInitialThinkingLevel(selectedModel: Model | undefined): ConfiguredThinkingLevel | undefined {
		const { options, settings, existingSession, hasExistingSession, hasThinkingEntry } = this.#inputs;
		if (options.thinkingLevel !== undefined) {
			this.#thinkingSource = options.thinkingSource ?? "session";
			return options.thinkingLevel;
		}
		if (hasExistingSession && hasThinkingEntry) {
			this.#thinkingSource = "session";
			return (
				parseConfiguredThinkingLevel(existingSession.configuredThinkingLevel) ??
				parseThinkingLevel(existingSession.thinkingLevel)
			);
		}
		if (!hasThinkingEntry && this.#restoredThinkingLevel !== undefined) {
			this.#thinkingSource = "session";
			return this.#restoredThinkingLevel;
		}
		if (!this.hasExplicitModel && !hasThinkingEntry && this.#defaultRoleSpec.explicitThinkingLevel) {
			this.#thinkingSource = "selector";
			return this.#defaultRoleSpec.thinkingLevel;
		}
		const saved = resolveEffort({
			modelSelector: selectedModel ? `${selectedModel.provider}/${selectedModel.id}` : undefined,
			defaultEffort: withLegacyDefaultEffort(
				settings.isConfigured("defaultEffort") ? settings.get("defaultEffort") : undefined,
				settings.get("defaultThinkingLevel"),
			),
		});
		this.#thinkingSource = saved.source;
		return saved.level ?? selectedModel?.thinking?.defaultLevel;
	}

	/**
	 * Recompute the thinking level from scratch against `selectedModel`, so a value derived from
	 * an earlier candidate's `thinking.defaultLevel` never becomes sticky.
	 */
	#settleThinking(selectedModel: Model | undefined): void {
		const thinkingLevel = this.#pickInitialThinkingLevel(selectedModel);
		const autoThinking = thinkingLevel === AUTO_THINKING;
		const concreteLevel = concreteThinkingLevel(thinkingLevel);
		this.#autoThinking = autoThinking;
		this.#effectiveThinkingLevel =
			selectedModel === undefined
				? concreteLevel
				: logger.time("resolveThinkingLevelForModel", () =>
						autoThinking
							? resolveProvisionalAutoLevel(selectedModel)
							: resolveThinkingLevelForModel(selectedModel, concreteLevel),
					);
	}

	/** Start on `selectedModel`: clear the fallback message, settle thinking, warm the host. */
	#adopt(selectedModel: Model): void {
		this.#model = selectedModel;
		this.#fallbackMessage = undefined;
		this.#settleThinking(selectedModel);
		preconnectModelHost(selectedModel.baseUrl);
	}

	/**
	 * Retry the session's model candidates now that extension providers are registered. The
	 * first pass ran before extensions loaded, so a role model an extension supplies either fell
	 * back to the saved default (`#restoredIndex > 0`) or failed entirely (`#restoredIndex ===
	 * -1`, with the settings default or a later fallback filling the model). Reclaiming it here
	 * makes resume honor the last active role in either case.
	 */
	#reclaimSessionModel(): void {
		const retryLimit = this.#restoredIndex >= 0 ? this.#restoredIndex : this.#sessionModelStrings.length;
		if (this.hasExplicitModel) return;
		for (let i = 0; i < retryLimit; i++) {
			const candidate = this.#sessionCandidate(i);
			if (!candidate) continue;
			this.#restoredIndex = i;
			this.#restoredThinkingLevel = candidate.thinkingLevel;
			this.#adopt(candidate.model);
			return;
		}
	}

	/**
	 * Resolve deferred `--model`/agent patterns now that extension models are registered. Role
	 * aliases (`@smol`) and comma chains expand to concrete selectors first, so the deferred path
	 * accepts everything the immediate path (resolveModelOverride → resolveModelRoleValue)
	 * accepts.
	 */
	async #resolveDeferredPatterns(): Promise<void> {
		const { options, settings, modelRegistry } = this.#inputs;
		const expandedModelPatterns = resolveConfiguredModelPatterns(this.#deferredPatterns, settings);
		let availableModels = modelRegistry.getAll();
		const matchPreferences = getModelMatchPreferences(settings);
		// The background refresh (refreshInBackground at startup) may not have completed yet.
		// When an explicit --model points at a dynamically-discovered model that isn't in the
		// static catalog (e.g. a provider's /v1/models list or models.dev overlay), the patterns
		// won't resolve against the static-only registry. Do a synchronous cache-aware discovery
		// pass and retry before reporting failure. This mirrors the non-explicit fallback in
		// `#resolveFallbackModel`.
		if (!expandedModelPatterns.some(pattern => parseModelPattern(pattern, availableModels, matchPreferences).model)) {
			await logger.time("resolveExplicitModelDiscovery", () => modelRegistry.refresh("online-if-uncached"));
			availableModels = modelRegistry.getAll();
		}
		for (let patternIndex = 0; patternIndex < expandedModelPatterns.length; patternIndex += 1) {
			const primary = parseModelPattern(expandedModelPatterns[patternIndex], availableModels, matchPreferences);
			if (!isMatched(primary)) continue;
			const authFallback = await this.#authFallback(primary, availableModels, matchPreferences);
			const selected = authFallback ?? primary;
			if (authFallback === undefined && options.modelPatternFallbackRole) {
				installPatternFallbackChain(
					settings,
					options.modelPatternFallbackRole,
					primary,
					expandedModelPatterns.slice(patternIndex + 1),
					availableModels,
					matchPreferences,
				);
			}
			if (selected.explicitThinkingLevel) {
				this.#restoredThinkingLevel = selected.thinkingLevel;
			}
			this.#adopt(selected.model);
			return;
		}
		// Never assume the id is at fault. An empty registry, or one whose credentials can no
		// longer serve a token, is an AUTH failure, and reporting it as an unknown model id is
		// what sent a real investigation into model allowlists for a day (BACKLOG
		// AUTH-FAILURE-BLAMES-MODEL-ID). The classification is `modelResolutionFailureMessage`,
		// under test.
		this.#fallbackMessage = modelResolutionFailureMessage(this.#deferredPatterns, modelRegistry);
	}

	/**
	 * The `modelPatternAuthFallback` match, when `primary` has no usable credential and the
	 * fallback does. Undefined keeps `primary`.
	 */
	async #authFallback(
		primary: MatchedModel,
		availableModels: readonly Model[],
		matchPreferences: ModelMatchPreferences,
	): Promise<MatchedModel | undefined> {
		const { options, modelRegistry } = this.#inputs;
		if (!options.modelPatternAuthFallback) return undefined;
		const primaryKey = await modelRegistry.getApiKey(primary.model);
		if (primaryKey === kNoAuth || isAuthenticated(primaryKey)) return undefined;
		const fallback = parseModelPattern(options.modelPatternAuthFallback, availableModels, matchPreferences);
		if (!isMatched(fallback)) return undefined;
		const fallbackKey = await modelRegistry.getApiKey(fallback.model);
		return isAuthenticated(fallbackKey) ? fallback : undefined;
	}

	/**
	 * Fall back to the first available model with a valid API key, honoring the path-scoped
	 * `enabledModels` allow-list when configured. Skipped when `--model` named a model that was
	 * not found.
	 */
	async #resolveFallbackModel(): Promise<void> {
		const { settings, modelRegistry } = this.#inputs;
		await this.#tryResolveDefaultRole();

		if (!this.#model) {
			const fallbackCandidates = await resolveAllowedModels(modelRegistry, settings, this.#matchPreferences);
			let pick = pickDefaultAvailableModel(fallbackCandidates.filter(candidate => this.#hasAuth(candidate)));

			// Cold-cache discovery race (issues #6114, #6162): a discovery provider (models.yml
			// `openai-models-list`, LM Studio/Ollama/llama.cpp, or an openai-compat proxy) ships no
			// static models, so the static+cached catalog resolved nothing above. Background
			// discovery in main.ts fires only AFTER createAgentSession returns, so on a cache-cold
			// boot the configured default stays unresolved and `pick` silently degrades to an
			// unrelated authed provider's default (#6162) or "No models available" (#6114) — even
			// though `veyyon models` (which awaits discovery) lists the model. Await one cache-aware
			// discovery pass and retry when a default role is configured (must win over `pick`) or
			// nothing resolved at all. The common path — role already resolved, or a `pick` with no
			// configured default — never pays for it.
			const defaultRoleConfigured = Boolean(settings.getModelRole(DEFAULT_MODEL_SLOT));
			if (
				!this.hasExplicitModel &&
				(defaultRoleConfigured || !pick) &&
				modelRegistry.getDiscoverableProviders().length > 0
			) {
				await logger.time("resolveModelDiscoveryFallback", () => modelRegistry.refresh("online-if-uncached"));
				if (!(await this.#tryResolveDefaultRole()) && !this.#model) {
					const refreshedCandidates = await resolveAllowedModels(modelRegistry, settings, this.#matchPreferences);
					pick = pickDefaultAvailableModel(refreshedCandidates.filter(candidate => this.#hasAuth(candidate)));
				}
			}

			if (!this.#model && pick) {
				this.#model = pick;
			}
		}

		const model = this.#model;
		if (model) {
			if (this.#fallbackMessage) {
				this.#fallbackMessage += `. Using ${model.provider}/${model.id}`;
			}
			return;
		}
		const patterns = settings.get("enabledModels");
		// The `enabledModels` case already names its real cause. The general case must not: "set
		// an API key" is right only when there is no credential, and it hid a broken registry
		// behind advice about keys.
		this.#fallbackMessage =
			patterns && patterns.length > 0
				? `No model available matching enabledModels (${patterns.join(", ")}) with usable credentials. Configure auth for an allowed provider or adjust enabledModels.`
				: modelResolutionFailureMessage([], modelRegistry);
	}

	/**
	 * Retry the default-role lookup against the post-extension allowed set, adopting the model
	 * when it resolves. Extension factories register providers AFTER the first pass resolved
	 * `#defaultRoleSpec`, and configured discovery providers may still be mid-discovery, so a
	 * role pointing at such a model (an openai-compat plugin's `posthog/claude-opus-4-8`, a
	 * models.yml `openai-models-list` endpoint) returned `undefined` there. Without this retry
	 * the `pickDefaultAvailableModel` fallback replaces the configured default with a bundled
	 * provider's default whenever a stray `OPENAI_API_KEY`/`ANTHROPIC_API_KEY` is in the
	 * environment. (issues #3569, #6162)
	 */
	async #tryResolveDefaultRole(): Promise<boolean> {
		if (this.hasExplicitModel) return false;
		const { settings, modelRegistry } = this.#inputs;
		// Re-resolve the allowed set: extension factories and discovery refreshes may have
		// registered models not visible earlier.
		const fallbackCandidates = await resolveAllowedModels(modelRegistry, settings, this.#matchPreferences);
		const reResolvedRoleSpec = resolveModelRoleValue(settings.getModelRole(DEFAULT_MODEL_SLOT), fallbackCandidates, {
			settings,
			matchPreferences: this.#matchPreferences,
		});
		const resolvedDefaultModel = reResolvedRoleSpec.model;
		if (!resolvedDefaultModel) return false;
		// Set before adopting: the thinking pick reads the role's explicit selector (e.g. `:max`).
		this.#defaultRoleSpec = reResolvedRoleSpec;
		this.#adopt(resolvedDefaultModel);
		return true;
	}

	/** Swap in the selected model's refreshed metadata, re-settling thinking when it changed. */
	async #refreshSelectedMetadata(): Promise<void> {
		const selectedModel = this.#model;
		if (!selectedModel) return;
		const refreshedModel = await logger.time("refreshInitialModelMetadata", () =>
			this.#inputs.modelRegistry.refreshSelectedModelMetadata(selectedModel),
		);
		if (refreshedModel === selectedModel) return;
		this.#model = refreshedModel;
		this.#settleThinking(refreshedModel);
	}
}
