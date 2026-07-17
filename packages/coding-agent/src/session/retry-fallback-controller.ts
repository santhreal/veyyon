/**
 * Retry fallback-chain controller: resolves the chain key that owns a failing
 * model selector, walks the configured `retry.fallbackChains` candidates,
 * applies model switches (including the Fireworks Fast → base degrade), tracks
 * the active-fallback state, and restores the primary model once its cooldown
 * expires. Pure selector parsing/formatting lives in ./retry-fallback.
 */
import type { ThinkingLevel } from "@veyyon/pi-agent-core";
import { type AssistantMessage, calculateRateLimitBackoffMs, type Model, parseRateLimitReason } from "@veyyon/pi-ai";
import * as AIError from "@veyyon/pi-ai/error";
import { isFireworksFastModelId, toFireworksBaseModelId } from "@veyyon/pi-catalog/fireworks-model-id";
import { logger } from "@veyyon/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import {
	formatModelSelectorValue,
	formatModelString,
	formatModelStringWithRouting,
	resolveModelOverride,
} from "../config/model-resolver";
import type { Settings } from "../config/settings";
import type { ConfiguredThinkingLevel } from "../thinking";
import type { AgentSessionEvent } from "./agent-session";
import {
	type ActiveRetryFallbackState,
	formatRetryFallbackBaseSelector,
	formatRetryFallbackSelector,
	isRetryFallbackModelKey,
	isRetryFallbackWildcardKey,
	parseRetryFallbackSelector,
	type RetryFallbackChains,
	type RetryFallbackRevertPolicy,
	type RetryFallbackSelector,
} from "./retry-fallback";
import { EPHEMERAL_MODEL_CHANGE_ROLE } from "./session-entries";
import type { SessionManager } from "./session-manager";

/** Session facilities the controller drives; closures over AgentSession privates. */
export interface RetryFallbackControllerDeps {
	settings: Settings;
	modelRegistry: ModelRegistry;
	sessionManager: SessionManager;
	getSessionId(): string;
	getModel(): Model | undefined;
	getThinkingLevel(): ThinkingLevel | undefined;
	configuredThinkingLevel(): ConfiguredThinkingLevel | undefined;
	setThinkingLevel(level: ConfiguredThinkingLevel | undefined): void;
	setModelWithProviderSessionReset(model: Model): void;
	emitSessionEvent(event: AgentSessionEvent): Promise<void>;
	pushConfigWarning(message: string): void;
	classifyRetryMessage(message: AssistantMessage): number;
	isClassifierRefusal(message: AssistantMessage): boolean;
	hasReplayUnsafeToolOutput(message: AssistantMessage): boolean;
}

export class RetryFallbackController {
	readonly #deps: RetryFallbackControllerDeps;
	#active: ActiveRetryFallbackState | undefined = undefined;

	constructor(deps: RetryFallbackControllerDeps) {
		this.#deps = deps;
	}

	/** The in-effect fallback state, when a chain switch is active. */
	get active(): ActiveRetryFallbackState | undefined {
		return this.#active;
	}

	clearActive(): void {
		this.#active = undefined;
	}

	#chains(): RetryFallbackChains {
		const configuredChains = this.#deps.settings.get("retry.fallbackChains");
		if (!configuredChains || typeof configuredChains !== "object") return {};
		const chains: RetryFallbackChains = { ...(configuredChains as RetryFallbackChains) };
		const defaultChain = chains.default;
		if (Array.isArray(defaultChain)) {
			for (const role of Object.keys(this.#deps.settings.getModelRoles())) {
				if (role !== "default" && chains[role] === undefined) {
					chains[role] = defaultChain;
				}
			}
		}
		return chains;
	}

	validateChains(): void {
		const configuredChains = this.#deps.settings.get("retry.fallbackChains");
		if (configuredChains === undefined) return;
		if (!configuredChains || typeof configuredChains !== "object" || Array.isArray(configuredChains)) {
			const msg = "retry.fallbackChains must be a mapping of role names or model selectors to selector arrays.";
			logger.warn(msg);
			this.#deps.pushConfigWarning(msg);
			return;
		}

		for (const key in configuredChains) {
			const chain = (configuredChains as RetryFallbackChains)[key];
			const keyKind = isRetryFallbackModelKey(key) ? "model" : "role";
			if (keyKind === "model") {
				if (isRetryFallbackWildcardKey(key)) {
					const provider = key.slice(0, -2);
					if (!this.#deps.modelRegistry.getAll().some(model => model.provider === provider)) {
						const msg = `retry.fallbackChains wildcard key references unknown provider: ${key}`;
						logger.warn(msg);
						this.#deps.pushConfigWarning(msg);
					}
				} else {
					const parsedKey = parseRetryFallbackSelector(key, this.#deps.modelRegistry);
					if (!parsedKey) {
						const msg = `Invalid model selector key in retry.fallbackChains: ${key}`;
						logger.warn(msg);
						this.#deps.pushConfigWarning(msg);
					} else if (!this.#deps.modelRegistry.find(parsedKey.provider, parsedKey.id)) {
						const msg = `retry.fallbackChains key references unknown model: ${key}`;
						logger.warn(msg);
						this.#deps.pushConfigWarning(msg);
					}
				}
			}
			if (!Array.isArray(chain)) {
				const msg = `Fallback chain for ${keyKind} '${key}' must be an array of selector strings.`;
				logger.warn(msg);
				this.#deps.pushConfigWarning(msg);
				continue;
			}
			for (const selectorStr of chain) {
				if (typeof selectorStr !== "string") {
					const msg = `Fallback chain for ${keyKind} '${key}' contains a non-string selector.`;
					logger.warn(msg);
					this.#deps.pushConfigWarning(msg);
					continue;
				}
				if (isRetryFallbackWildcardKey(selectorStr)) {
					const provider = selectorStr.slice(0, -2);
					if (!this.#deps.modelRegistry.getAll().some(model => model.provider === provider)) {
						const msg = `Fallback chain for ${keyKind} '${key}' references unknown provider: ${selectorStr}`;
						logger.warn(msg);
						this.#deps.pushConfigWarning(msg);
					}
					continue;
				}
				const parsed = parseRetryFallbackSelector(selectorStr, this.#deps.modelRegistry);
				if (!parsed) {
					const msg = `Invalid fallback selector format in ${keyKind} '${key}': ${selectorStr}`;
					logger.warn(msg);
					this.#deps.pushConfigWarning(msg);
					continue;
				}
				const exists = this.#deps.modelRegistry.find(parsed.provider, parsed.id);
				if (!exists) {
					const msg = `Fallback chain for ${keyKind} '${key}' references unknown model: ${selectorStr}`;
					logger.warn(msg);
					this.#deps.pushConfigWarning(msg);
				}
			}
		}
	}

	#revertPolicy(): RetryFallbackRevertPolicy {
		return this.#deps.settings.get("retry.fallbackRevertPolicy") === "never" ? "never" : "cooldown-expiry";
	}

	#primarySelector(role: string): RetryFallbackSelector | undefined {
		if (isRetryFallbackWildcardKey(role)) return undefined;
		if (isRetryFallbackModelKey(role)) return parseRetryFallbackSelector(role, this.#deps.modelRegistry);
		const configuredSelector = this.#deps.settings.getModelRole(role);
		return configuredSelector ? parseRetryFallbackSelector(configuredSelector, this.#deps.modelRegistry) : undefined;
	}

	#isSuppressed(selector: RetryFallbackSelector): boolean {
		return this.#deps.modelRegistry.isSelectorSuppressed(selector.raw);
	}

	noteCooldown(currentSelector: string, retryAfterMs: number | undefined, errorMessage: string): void {
		let cooldownMs = retryAfterMs;
		if (!cooldownMs || cooldownMs <= 0) {
			const reason = parseRateLimitReason(errorMessage);
			cooldownMs = reason === "UNKNOWN" ? 5 * 60 * 1000 : calculateRateLimitBackoffMs(reason);
		}
		this.#deps.modelRegistry.suppressSelector(currentSelector, Date.now() + cooldownMs);
	}

	/**
	 * Map the failing model selector to the chain key that owns it, by
	 * specificity: an exact model-selector key, then a `provider/*` wildcard,
	 * then a model role whose current assignment matches, then `default`.
	 * Model-oriented keys win over roles so a chain follows the model across
	 * role reassignments.
	 */
	#resolveRole(currentSelector: string): string | undefined {
		const parsedCurrent = parseRetryFallbackSelector(currentSelector, this.#deps.modelRegistry);
		if (!parsedCurrent) return undefined;
		const chains = this.#chains();
		const currentBaseSelector = formatRetryFallbackBaseSelector(parsedCurrent);
		const model = this.#deps.getModel();
		const currentPlainSelector = model
			? formatModelSelectorValue(formatModelString(model), parsedCurrent.thinkingLevel)
			: undefined;
		const currentPlainBaseSelector =
			currentPlainSelector && currentPlainSelector !== currentSelector
				? formatRetryFallbackBaseSelector(parseRetryFallbackSelector(currentPlainSelector) ?? parsedCurrent)
				: undefined;

		const exactModelKeys: string[] = [];
		const roleKeys: string[] = [];
		for (const key in chains) {
			if (!isRetryFallbackModelKey(key)) roleKeys.push(key);
			else if (!isRetryFallbackWildcardKey(key)) exactModelKeys.push(key);
		}
		const matchesCurrent = (primary: RetryFallbackSelector | undefined): boolean => {
			if (!primary) return false;
			if (primary.raw === currentSelector || (currentPlainSelector && primary.raw === currentPlainSelector)) {
				return true;
			}
			const base = formatRetryFallbackBaseSelector(primary);
			return base === currentBaseSelector || (!!currentPlainBaseSelector && base === currentPlainBaseSelector);
		};

		// 1. Exact model-selector keys — most specific.
		for (const key of exactModelKeys) {
			if (matchesCurrent(this.#primarySelector(key))) return key;
		}
		// 2. Provider wildcard (`provider/*`) — any active model of this provider.
		const wildcardKey = `${parsedCurrent.provider}/*`;
		if (Array.isArray(chains[wildcardKey])) return wildcardKey;
		// 3. Role keys — matched by the role's currently-assigned model.
		for (const key of roleKeys) {
			if (matchesCurrent(this.#primarySelector(key))) return key;
		}
		// 4. The default chain, when default has no explicit role primary.
		const defaultChain = chains.default;
		if (Array.isArray(defaultChain) && defaultChain.length > 0 && this.#primarySelector("default") === undefined) {
			return "default";
		}
		return undefined;
	}

	/**
	 * Parse one configured chain entry. A `provider/*` entry keeps the failing
	 * model's id and swaps the provider (google-antigravity/x → google/x);
	 * ids the target provider lacks are skipped by the candidate loop's
	 * registry lookup.
	 */
	#parseChainEntry(entry: string, current: RetryFallbackSelector | undefined): RetryFallbackSelector | undefined {
		if (isRetryFallbackWildcardKey(entry)) {
			if (!current) return undefined;
			const provider = entry.slice(0, -2);
			return { raw: `${provider}/${current.id}`, provider, id: current.id, thinkingLevel: undefined };
		}
		return parseRetryFallbackSelector(entry, this.#deps.modelRegistry);
	}

	#effectiveChain(role: string, currentSelector?: string): RetryFallbackSelector[] {
		const parsedCurrent = currentSelector
			? parseRetryFallbackSelector(currentSelector, this.#deps.modelRegistry)
			: undefined;
		const seen = new Set<string>();
		const chain: RetryFallbackSelector[] = [];
		if (isRetryFallbackWildcardKey(role)) {
			// A wildcard key has no fixed primary: the active model is the
			// primary, followed by the configured provider-level fallbacks.
			if (parsedCurrent) {
				chain.push(parsedCurrent);
				seen.add(parsedCurrent.raw);
			}
		} else {
			const primarySelector = this.#primarySelector(role);
			if (!primarySelector) return [];
			chain.push(primarySelector);
			seen.add(primarySelector.raw);
		}
		for (const selector of this.#chains()[role] ?? []) {
			const parsed = this.#parseChainEntry(selector, parsedCurrent);
			if (!parsed || seen.has(parsed.raw)) continue;
			seen.add(parsed.raw);
			chain.push(parsed);
		}
		return chain;
	}

	#findCandidates(role: string, currentSelector: string): RetryFallbackSelector[] {
		let chain = this.#effectiveChain(role, currentSelector);
		const parsedCurrent = parseRetryFallbackSelector(currentSelector, this.#deps.modelRegistry);
		if (chain.length === 0 && role === "default" && parsedCurrent) {
			const chains = this.#chains();
			const defaultChain = chains.default;
			if (Array.isArray(defaultChain) && defaultChain.length > 0 && this.#primarySelector("default") === undefined) {
				const seen = new Set<string>([parsedCurrent.raw]);
				chain = [parsedCurrent];
				for (const selector of defaultChain) {
					const parsed = this.#parseChainEntry(selector, parsedCurrent);
					if (!parsed || seen.has(parsed.raw)) continue;
					seen.add(parsed.raw);
					chain.push(parsed);
				}
			}
		}
		if (chain.length <= 1) return [];
		const currentBaseSelector = parsedCurrent ? formatRetryFallbackBaseSelector(parsedCurrent) : undefined;
		const model = this.#deps.getModel();
		const currentPlainSelector =
			model && parsedCurrent
				? formatModelSelectorValue(formatModelString(model), parsedCurrent.thinkingLevel)
				: undefined;
		const currentPlainBaseSelector =
			parsedCurrent && currentPlainSelector && currentPlainSelector !== currentSelector
				? formatRetryFallbackBaseSelector(parseRetryFallbackSelector(currentPlainSelector) ?? parsedCurrent)
				: undefined;
		const exactIndex = chain.findIndex(
			selector => selector.raw === currentSelector || selector.raw === currentPlainSelector,
		);
		if (exactIndex >= 0) return chain.slice(exactIndex + 1);
		const baseIndex = currentBaseSelector
			? chain.findIndex(selector => {
					const selectorBase = formatRetryFallbackBaseSelector(selector);
					return selectorBase === currentBaseSelector || selectorBase === currentPlainBaseSelector;
				})
			: -1;
		if (baseIndex >= 0) return chain.slice(baseIndex + 1);
		return chain.slice(1);
	}

	async #applyCandidate(
		role: string,
		selector: RetryFallbackSelector,
		currentSelector: string,
		options?: { pinFallback?: boolean },
	): Promise<void> {
		const resolved = resolveModelOverride([selector.raw], this.#deps.modelRegistry, this.#deps.settings);
		const candidate = resolved.model ?? this.#deps.modelRegistry.find(selector.provider, selector.id);
		if (!candidate) {
			throw new Error(`Retry fallback model not found: ${selector.raw}`);
		}
		const apiKey = await this.#deps.modelRegistry.getApiKey(candidate, this.#deps.getSessionId());
		if (!apiKey) {
			throw new Error(`No API key for retry fallback ${selector.raw}`);
		}

		// Capture the configured selector (auto-aware) so a fallback chain preserves
		// `auto` instead of collapsing it to the level it resolved to this turn.
		const currentThinkingLevel = this.#deps.configuredThinkingLevel();
		const nextThinkingLevel = selector.thinkingLevel ?? currentThinkingLevel;
		const candidateSelector = formatModelStringWithRouting(candidate);
		this.#deps.setModelWithProviderSessionReset(candidate);
		this.#deps.sessionManager.appendModelChange(candidateSelector, EPHEMERAL_MODEL_CHANGE_ROLE);
		this.#deps.settings.getStorage()?.recordModelUsage(candidateSelector);
		this.#deps.setThinkingLevel(nextThinkingLevel);
		if (!this.#active) {
			this.#active = {
				role,
				originalSelector: currentSelector,
				originalThinkingLevel: currentThinkingLevel,
				lastAppliedFallbackThinkingLevel: nextThinkingLevel,
				pinned: options?.pinFallback === true,
			};
		} else {
			this.#active.lastAppliedFallbackThinkingLevel = nextThinkingLevel;
			this.#active.pinned = this.#active.pinned || options?.pinFallback === true;
		}
		await this.#deps.emitSessionEvent({
			type: "retry_fallback_applied",
			from: currentSelector,
			to: selector.raw,
			role,
		});
	}

	async tryModelFallback(currentSelector: string, options?: { pinFallback?: boolean }): Promise<boolean> {
		const role = this.#active?.role ?? this.#resolveRole(currentSelector);
		if (!role) return false;

		for (const selector of this.#findCandidates(role, currentSelector)) {
			if (this.#isSuppressed(selector)) continue;
			const resolved = resolveModelOverride([selector.raw], this.#deps.modelRegistry, this.#deps.settings);
			const candidate = resolved.model ?? this.#deps.modelRegistry.find(selector.provider, selector.id);
			if (!candidate) continue;
			const apiKey = await this.#deps.modelRegistry.getApiKey(candidate, this.#deps.getSessionId());
			if (!apiKey) continue;
			await this.#applyCandidate(role, selector, currentSelector, options);
			return true;
		}

		return false;
	}

	/** The active model when it is a Fireworks Fast (`-fast`) variant, else undefined. */
	#activeFireworksFastModel(): Model | undefined {
		const model = this.#deps.getModel();
		return model?.provider === "fireworks" && isFireworksFastModelId(model.id) ? model : undefined;
	}

	/**
	 * True when the current turn failed on a Fireworks Fast (`-fast`) model in a
	 * way that should degrade to the reliable base (Standard) model. Fast is a
	 * speed-optimized router with no SLA, so any *pre-content* failure — a
	 * transient overload/5xx or a hard "router/model not found / unsupported" —
	 * is worth retrying on the base id. Skips failures the base model shares:
	 * context overflow (compaction's job), usage limits and auth errors (same
	 * account/key), and turns that already emitted a tool call (replaying would
	 * duplicate work). Requires the base model to exist in the registry.
	 */
	isFireworksFastFallbackEligible(message: AssistantMessage): boolean {
		const model = this.#activeFireworksFastModel();
		if (!model) return false;
		if (message.stopReason !== "error") return false;
		if (message.content.some(block => block.type === "toolCall")) return false;
		// A content refusal/sensitivity stop is the model's decision, not a route
		// failure — switching to the base model would just re-trigger it.
		if (this.#deps.isClassifierRefusal(message)) return false;
		const id = this.#deps.classifyRetryMessage(message);
		if (AIError.isContextOverflow(message, model.contextWindow ?? 0)) return false;
		if (AIError.is(id, AIError.Flag.UsageLimit)) return false;
		if (AIError.is(id, AIError.Flag.AuthFailed)) return false;
		return this.#deps.modelRegistry.find("fireworks", toFireworksBaseModelId(model.id)) !== undefined;
	}

	/**
	 * True when a turn failed with a hard (non-retryable) provider error but a
	 * configured `retry.fallbackChains` entry covers the active model: the same
	 * model is not worth retrying, yet a DIFFERENT model is a fresh chance, so
	 * the chain is consulted before the error becomes final. Skips failures a
	 * model switch cannot fix or must not replay: cancellations (abort-flavored
	 * errors are not model faults), context overflow (compaction's job),
	 * classifier refusals (chain consult is handled on the retryable path with
	 * `pinFallback`), and turns that already emitted a tool call (replaying
	 * could duplicate work).
	 */
	isHardErrorFallbackEligible(message: AssistantMessage): boolean {
		if (message.stopReason !== "error") return false;
		const model = this.#deps.getModel();
		if (!model) return false;
		const retrySettings = this.#deps.settings.getGroup("retry");
		if (!retrySettings.enabled || !retrySettings.modelFallback) return false;
		if (this.#deps.isClassifierRefusal(message)) return false;
		const id = this.#deps.classifyRetryMessage(message);
		if (AIError.is(id, AIError.Flag.Abort) || AIError.is(id, AIError.Flag.UserInterrupt)) return false;
		if (AIError.isContextOverflow(message, model.contextWindow ?? 0)) return false;
		if (this.#deps.hasReplayUnsafeToolOutput(message)) return false;
		const currentSelector = formatRetryFallbackSelector(model, this.#deps.getThinkingLevel());
		const role = this.#active?.role ?? this.#resolveRole(currentSelector);
		if (!role) return false;
		return this.#findCandidates(role, currentSelector).length > 0;
	}

	/**
	 * Switch the active model from a Fireworks Fast (`-fast`) variant to its base
	 * (Standard) id and stick there for the rest of the session — the auto
	 * fallback that makes Fast a safe default. Returns false when the current
	 * model is not a fast variant, the base id is missing, or it has no key.
	 */
	async tryFireworksFastFallback(currentSelector: string): Promise<boolean> {
		const model = this.#activeFireworksFastModel();
		if (!model) return false;
		const baseModel = this.#deps.modelRegistry.find("fireworks", toFireworksBaseModelId(model.id));
		if (!baseModel) return false;
		const apiKey = await this.#deps.modelRegistry.getApiKey(baseModel, this.#deps.getSessionId());
		if (!apiKey) return false;
		const baseSelector = formatModelStringWithRouting(baseModel);
		this.#deps.setModelWithProviderSessionReset(baseModel);
		this.#deps.sessionManager.appendModelChange(baseSelector, EPHEMERAL_MODEL_CHANGE_ROLE);
		this.#deps.settings.getStorage()?.recordModelUsage(baseSelector);
		await this.#deps.emitSessionEvent({
			type: "retry_fallback_applied",
			from: currentSelector,
			to: baseSelector,
			role: "fireworks-fast",
		});
		return true;
	}

	async maybeRestorePrimary(): Promise<void> {
		if (!this.#active) return;
		if (this.#active.pinned) return;
		if (this.#revertPolicy() !== "cooldown-expiry") return;

		const {
			originalSelector: originalSelectorRaw,
			originalThinkingLevel,
			lastAppliedFallbackThinkingLevel,
		} = this.#active;
		const originalSelector = parseRetryFallbackSelector(originalSelectorRaw, this.#deps.modelRegistry);
		if (!originalSelector) {
			this.clearActive();
			return;
		}

		const currentModel = this.#deps.getModel();
		if (!currentModel) return;
		const currentSelector = formatRetryFallbackSelector(currentModel, this.#deps.getThinkingLevel());
		if (currentSelector === originalSelector.raw) {
			if (!this.#isSuppressed(originalSelector)) {
				this.clearActive();
			}
			return;
		}
		if (this.#isSuppressed(originalSelector)) return;

		const resolvedPrimary = resolveModelOverride(
			[originalSelector.raw],
			this.#deps.modelRegistry,
			this.#deps.settings,
		);
		const primaryModel =
			resolvedPrimary.model ?? this.#deps.modelRegistry.find(originalSelector.provider, originalSelector.id);
		if (!primaryModel) return;
		const apiKey = await this.#deps.modelRegistry.getApiKey(primaryModel, this.#deps.getSessionId());
		if (!apiKey) return;

		const currentThinkingLevel = this.#deps.configuredThinkingLevel();
		const thinkingToApply =
			currentThinkingLevel === lastAppliedFallbackThinkingLevel ? originalThinkingLevel : currentThinkingLevel;
		const primarySelector = formatModelStringWithRouting(primaryModel);
		this.#deps.setModelWithProviderSessionReset(primaryModel);
		this.#deps.sessionManager.appendModelChange(primarySelector, EPHEMERAL_MODEL_CHANGE_ROLE);
		this.#deps.settings.getStorage()?.recordModelUsage(primarySelector);
		this.#deps.setThinkingLevel(thinkingToApply);
		this.clearActive();
	}
}
