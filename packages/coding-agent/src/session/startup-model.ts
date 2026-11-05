/**
 * The model, thinking level and service tier a session starts on.
 *
 * Selection runs in two passes because extension providers register between them. The first
 * pass restores the session's last model or the settings default, so model-dependent setup
 * (thinking-level resolution, the host preconnect) starts on it. The second runs once every
 * provider is visible: it retries the session's model candidates, resolves deferred `--model`
 * patterns, falls back to the first authenticated model, and refreshes the chosen model's
 * metadata.
 */

import type { ThinkingLevel } from "@veyyon/agent-core";
import type { Model, ServiceTierByFamily } from "@veyyon/ai";
import { getRestorableSessionModels, type SessionContext } from "@veyyon/kernel/session/session-context";
import type { SessionManager } from "@veyyon/kernel/session/session-manager";
import { logger } from "@veyyon/utils";
import { hasUsableCredential } from "../config/auth-state";
import { type EffortSource, resolveEffort, withLegacyDefaultEffort } from "../config/effort-resolver";
import { normalizeModelPatternList } from "../config/model-pattern-list";
import type { ModelRegistry } from "../config/model-registry";
import { modelResolutionFailureMessage } from "../config/model-resolution-failure";
import {
	formatModelSelectorValue,
	formatModelStringWithRouting,
	getModelMatchPreferences,
	type ModelMatchPreferences,
	type ParsedModelResult,
	type ParsedModelString,
	parseModelPattern,
	parseModelString,
	pickDefaultAvailableModel,
	type ResolvedModelSelectorValue,
	resolveAllowedModels,
	resolveModelSelectorValue,
} from "../config/model-resolver";
import { buildServiceTierByFamily } from "../config/service-tier";
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

/** What selection reads. Every field is read, never written, except the settings override a fallback chain installs. */
export interface StartupModelInputs {
	options: Pick<
		CreateAgentSessionOptions,
		| "model"
		| "modelPattern"
		| "modelPatternAuthFallback"
		| "modelPatternFallbackChain"
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
 * Make the later distinct matches the retry fallback chain of `primary`, keyed by its selector.
 *
 * Only a settings override is written, so the chain lives for this process and never reaches
 * the config file.
 */
function installPatternFallbackChain(
	settings: Settings,
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

	const fallbackChains: Record<string, string[]> = { [primarySelector]: fallbackSelectors };
	const existingFallbackChains = settings.get("retry.fallbackChains");
	for (const key in existingFallbackChains) {
		if (key !== primarySelector) fallbackChains[key] = existingFallbackChains[key];
	}
	settings.override("retry.fallbackChains", fallbackChains);
}

/** The service tier a session starts on: the tiers a resumed branch recorded, else the settings tiers. */
export function startingServiceTierByFamily(
	hasServiceTierEntry: boolean,
	restoredContext: SessionContext,
	settings: Settings,
): ServiceTierByFamily {
	if (hasServiceTierEntry) return restoredContext.serviceTier ?? {};
	return buildServiceTierByFamily(
		settings.get("tier.openai"),
		settings.get("tier.anthropic"),
		settings.get("tier.google"),
	);
}

export class StartupModelSelection {
	/** Whether the caller named a model, directly or through `--model` patterns. */
	readonly hasExplicitModel: boolean;
	readonly #inputs: StartupModelInputs;
	readonly #deferredPatterns: string[];
	readonly #matchPreferences: ModelMatchPreferences;
	/** The session's model strings, in the order a resume tries them. */
	readonly #sessionModelStrings: string[];
	#defaultModelSpec: ResolvedModelSelectorValue;
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
		const defaultModelSpec = logger.time("resolveDefaultModel", () =>
			resolveModelSelectorValue(settings.get("defaultModel"), allowedModels, {
				settings,
				matchPreferences,
			}),
		);
		const selection = new StartupModelSelection(inputs, matchPreferences, defaultModelSpec);
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
		defaultModelSpec: ResolvedModelSelectorValue,
	) {
		const { options, sessionManager, existingSession, hasExistingSession } = inputs;
		this.#inputs = inputs;
		this.#deferredPatterns = normalizeModelPatternList(options.modelPattern);
		this.hasExplicitModel = options.model !== undefined || this.#deferredPatterns.length > 0;
		this.#matchPreferences = matchPreferences;
		this.#defaultModelSpec = defaultModelSpec;
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

	/** The thinking selector the session starts with: `auto`, else the concrete level. */
	get sessionThinkingLevel(): ConfiguredThinkingLevel | undefined {
		return this.#autoThinking ? AUTO_THINKING : this.#effectiveThinkingLevel;
	}

	/** Run the second pass, after extension providers registered. */
	async completeAfterExtensions(): Promise<void> {
		this.#reclaimSessionModel();
		await this.#discoverSessionModel();
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

	/** Session model string `index`, parsed against the registry. */
	#parseSessionModel(index: number): ParsedModelString | undefined {
		const { modelRegistry } = this.#inputs;
		return parseModelString(this.#sessionModelStrings[index], {
			allowMaxSuffix: true,
			allowAutoAlias: true,
			isLiteralModelId: (provider, id) => modelRegistry.find(provider, id) !== undefined,
		});
	}

	/** The authenticated model session candidate `index` names, or undefined when it names none. */
	#sessionCandidate(index: number): { model: Model; thinkingLevel: ConfiguredThinkingLevel | undefined } | undefined {
		const parsedModel = this.#parseSessionModel(index);
		if (!parsedModel) return undefined;
		const restoredModel = this.#inputs.modelRegistry.find(parsedModel.provider, parsedModel.id);
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
		const settingsDefaultModel = this.#defaultModelSpec.model;
		if (this.hasExplicitModel || this.#model || !settingsDefaultModel) return;
		logger.time("resolveSettingsDefaultModel", () => {
			// defaultModelSpec.model already comes from modelRegistry.getAvailable(), so
			// re-validating auth here repeats the expensive lookup path.
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
		if (!this.hasExplicitModel && !hasThinkingEntry && this.#defaultModelSpec.explicitThinkingLevel) {
			this.#thinkingSource = "selector";
			return this.#defaultModelSpec.thinkingLevel;
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
	 * first pass ran before extensions loaded, so a model an extension supplies either fell
	 * back to the saved default (`#restoredIndex > 0`) or failed entirely (`#restoredIndex ===
	 * -1`, with the settings default or a later fallback filling the model). Reclaiming it here
	 * makes resume honor the last active model in either case.
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
	 * Discover the providers of the session's preferred models the registry does not list, then
	 * reclaim. A model that exists only in a provider's discovery listing is known at startup only
	 * through the discovery cache, and a cold or rejected cache (a deleted `models.db`, the first
	 * launch after the cache schema version changes) leaves it unknown until the background
	 * refresh, which runs after selection. Discovery skips a provider with no credential, so a
	 * resume that restored its model, or one whose provider cannot be authenticated, sends no
	 * request.
	 */
	async #discoverSessionModel(): Promise<void> {
		const { modelRegistry } = this.#inputs;
		const preferred = this.#restoredIndex >= 0 ? this.#restoredIndex : this.#sessionModelStrings.length;
		const providers = new Set<string>();
		for (let i = 0; i < preferred; i++) {
			const parsed = this.#parseSessionModel(i);
			if (parsed) providers.add(parsed.provider);
		}
		if (providers.size === 0) return;
		await logger.time("discoverSessionModel", () =>
			Promise.all(Array.from(providers, provider => modelRegistry.refreshProvider(provider, "online-if-uncached"))),
		);
		this.#reclaimSessionModel();
	}

	/**
	 * Resolve deferred `--model`/agent patterns now that extension models are registered. Comma
	 * chains split into their entries first, so the deferred path accepts everything the
	 * immediate path (resolveModelOverrideWithAuthFallback) accepts, in the same order: the first
	 * pattern whose provider can serve a request, then `modelPatternAuthFallback`, then the first
	 * pattern that matched at all so the request names the credential it lacks.
	 */
	async #resolveDeferredPatterns(): Promise<void> {
		const { options, settings, modelRegistry } = this.#inputs;
		const patterns = this.#deferredPatterns;
		let availableModels = modelRegistry.getAll();
		const matchPreferences = getModelMatchPreferences(settings);
		// The background refresh (refreshInBackground at startup) may not have completed yet.
		// When an explicit --model points at a dynamically-discovered model that isn't in the
		// static catalog (e.g. a provider's /v1/models list or models.dev overlay), the patterns
		// won't resolve against the static-only registry. Do a synchronous cache-aware discovery
		// pass and retry before reporting failure. This mirrors the non-explicit fallback in
		// `#resolveFallbackModel`.
		if (!patterns.some(pattern => parseModelPattern(pattern, availableModels, matchPreferences).model)) {
			await logger.time("resolveExplicitModelDiscovery", () => modelRegistry.refresh("online-if-uncached"));
			availableModels = modelRegistry.getAll();
		}
		// One pattern and no auth fallback leave nothing to fall back to, so no credential is looked up.
		const hasAlternative = patterns.length > 1 || options.modelPatternAuthFallback !== undefined;
		const usable = async (model: Model): Promise<boolean> =>
			hasUsableCredential(await modelRegistry.getApiKey(model));
		let first: { match: MatchedModel; index: number } | undefined;
		for (const [index, pattern] of patterns.entries()) {
			const match = parseModelPattern(pattern, availableModels, matchPreferences);
			if (!isMatched(match)) continue;
			first ??= { match, index };
			if (!hasAlternative || (await usable(match.model))) {
				this.#adoptPatternMatch(match, patterns.slice(index + 1), availableModels, matchPreferences);
				return;
			}
		}
		if (first) {
			const fallback = options.modelPatternAuthFallback
				? parseModelPattern(options.modelPatternAuthFallback, availableModels, matchPreferences)
				: undefined;
			if (fallback && isMatched(fallback) && (await usable(fallback.model))) {
				this.#adoptPatternMatch(fallback, [], availableModels, matchPreferences);
			} else {
				this.#adoptPatternMatch(first.match, patterns.slice(first.index + 1), availableModels, matchPreferences);
			}
			return;
		}
		// Never assume the id is at fault. An empty registry, or one whose credentials can no
		// longer serve a token, is an AUTH failure, and reporting it as an unknown model id is
		// what sent a real investigation into model allowlists for a day (BACKLOG
		// AUTH-FAILURE-BLAMES-MODEL-ID). The classification is `modelResolutionFailureMessage`,
		// under test.
		this.#fallbackMessage = modelResolutionFailureMessage(patterns, modelRegistry);
	}

	/** Run `match`, with the patterns after it as its retry chain when the caller asked for one. */
	#adoptPatternMatch(
		match: MatchedModel,
		laterPatterns: readonly string[],
		availableModels: readonly Model[],
		matchPreferences: ModelMatchPreferences,
	): void {
		if (this.#inputs.options.modelPatternFallbackChain) {
			installPatternFallbackChain(this.#inputs.settings, match, laterPatterns, availableModels, matchPreferences);
		}
		if (match.explicitThinkingLevel) this.#restoredThinkingLevel = match.thinkingLevel;
		this.#adopt(match.model);
	}

	/**
	 * Fall back to the first available model with a valid API key, honoring the path-scoped
	 * `enabledModels` allow-list when configured. Skipped when `--model` named a model that was
	 * not found.
	 */
	async #resolveFallbackModel(): Promise<void> {
		const { settings, modelRegistry } = this.#inputs;
		await this.#tryResolveDefaultModel();

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
			// discovery pass and retry when a default model is configured (must win over `pick`) or
			// nothing resolved at all. The common path — default model already resolved, or a `pick`
			// with no configured default — never pays for it.
			const defaultModelConfigured = normalizeModelPatternList(settings.get("defaultModel")).length > 0;
			if (
				!this.hasExplicitModel &&
				(defaultModelConfigured || !pick) &&
				modelRegistry.getDiscoverableProviders().length > 0
			) {
				await logger.time("resolveModelDiscoveryFallback", () => modelRegistry.refresh("online-if-uncached"));
				if (!(await this.#tryResolveDefaultModel()) && !this.#model) {
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
	 * Retry the `defaultModel` lookup against the post-extension allowed set, adopting the model
	 * when it resolves. Extension factories register providers AFTER the first pass resolved
	 * `#defaultModelSpec`, and configured discovery providers may still be mid-discovery, so a
	 * value pointing at such a model (an openai-compat plugin's `posthog/claude-opus-4-8`, a
	 * models.yml `openai-models-list` endpoint) returned `undefined` there. Without this retry
	 * the `pickDefaultAvailableModel` fallback replaces the configured default with a bundled
	 * provider's default whenever a stray `OPENAI_API_KEY`/`ANTHROPIC_API_KEY` is in the
	 * environment. (issues #3569, #6162)
	 */
	async #tryResolveDefaultModel(): Promise<boolean> {
		if (this.hasExplicitModel) return false;
		const { settings, modelRegistry } = this.#inputs;
		// Re-resolve the allowed set: extension factories and discovery refreshes may have
		// registered models not visible earlier.
		const fallbackCandidates = await resolveAllowedModels(modelRegistry, settings, this.#matchPreferences);
		const reResolvedSpec = resolveModelSelectorValue(settings.get("defaultModel"), fallbackCandidates, {
			settings,
			matchPreferences: this.#matchPreferences,
		});
		const resolvedDefaultModel = reResolvedSpec.model;
		if (!resolvedDefaultModel) return false;
		// Set before adopting: the thinking pick reads the value's explicit selector (e.g. `:max`).
		this.#defaultModelSpec = reResolvedSpec;
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
