/**
 * The model switches the retry ladder makes: the `retry.fallbackChains` switch, the Fireworks Fast
 * degrade to its base model, and the restore of the primary once its cooldown expires.
 *
 * This is a session collaborator of {@link RetryRuntime}. It holds the active fallback, which records
 * the selector and thinking level a chain switch replaced, and reaches the session through
 * {@link RetryFallbackSession} and {@link RetryFallbackHost}.
 */
import type { Agent, ThinkingLevel } from "@veyyon/agent-core";
import type { AssistantMessage, Model } from "@veyyon/ai";
import * as AIError from "@veyyon/ai/error";
import { calculateRateLimitBackoffMs, parseRateLimitReason } from "@veyyon/ai/error/rate-limit";
import { isFireworksFastModelId, toFireworksBaseModelId } from "@veyyon/catalog/fireworks-model-id";
import { AgentStorage } from "@veyyon/kernel/session/agent-storage";
import { EPHEMERAL_MODEL_CHANGE_ROLE } from "@veyyon/kernel/session/session-entries";
import type { SessionManager } from "@veyyon/kernel/session/session-manager";
import type { ModelRegistry } from "../../config/model-registry";
import { formatModelStringWithRouting, resolveModelOverride } from "../../config/model-resolver";
import type { Settings } from "../../config/settings";
import type { ConfiguredThinkingLevel } from "../../thinking";
import {
	type ActiveRetryFallbackState,
	findRetryFallbackCandidates,
	formatRetryFallbackSelector,
	parseRetryFallbackSelector,
	type RetryFallbackChainSource,
	type RetryFallbackRevertPolicy,
	type RetryFallbackSelector,
	resolveRetryFallbackRole,
	retryFallbackChainsForRoles,
} from "../agent-session-retry-fallback";
import type { AgentSessionEvent } from "../agent-session-types";
import { hasReplayUnsafeToolOutput, isClassifierRefusal } from "../failed-turn";

/** What {@link RetryFallback} reads from the session's public surface. */
export interface RetryFallbackSession {
	readonly agent: Agent;
	readonly sessionManager: SessionManager;
	readonly settings: Settings;
	readonly modelRegistry: ModelRegistry;
	readonly model: Model | undefined;
	readonly thinkingLevel: ThinkingLevel | undefined;
	readonly sessionId: string;
	configuredThinkingLevel(): ConfiguredThinkingLevel | undefined;
	setThinkingLevel(
		level: ConfiguredThinkingLevel | undefined,
		persist?: boolean,
		source?: "session" | "resolved",
	): void;
}

/** What {@link RetryFallback} needs beyond the session's public surface. */
export interface RetryFallbackHost {
	emitSessionEvent(event: AgentSessionEvent): Promise<void>;
	/** Switch the active model and reset the provider sessions the switch invalidates. */
	setModelWithProviderSessionReset(model: Model): void;
	/** The retry ladder's classification of a failed turn against the active model. */
	classify(message: AssistantMessage): number;
}

export class RetryFallback {
	readonly #session: RetryFallbackSession;
	readonly #host: RetryFallbackHost;
	#activeFallback: ActiveRetryFallbackState | undefined = undefined;

	constructor(session: RetryFallbackSession, host: RetryFallbackHost) {
		this.#session = session;
		this.#host = host;
	}

	/** The chain key of the active fallback, or undefined when the primary model is active. */
	get activeRole(): string | undefined {
		return this.#activeFallback?.role;
	}

	/** Forget the active fallback: an explicit model change supersedes it. */
	clear(): void {
		this.#activeFallback = undefined;
	}

	/** What chain resolution reads, as of this call: the sanitized chains, role assignments and active model. */
	#source(): RetryFallbackChainSource {
		const settings = this.#session.settings;
		return {
			chains: retryFallbackChainsForRoles(
				settings.get("retry.fallbackChains"),
				Object.keys(settings.getModelRoles()),
			),
			modelRole: role => settings.getModelRole(role),
			models: this.#session.modelRegistry,
			activeModel: this.#session.model,
		};
	}

	#revertPolicy(): RetryFallbackRevertPolicy {
		return this.#session.settings.get("retry.fallbackRevertPolicy") === "never" ? "never" : "cooldown-expiry";
	}

	#isSuppressed(selector: RetryFallbackSelector): boolean {
		return this.#session.modelRegistry.isSelectorSuppressed(selector.raw);
	}

	noteCooldown(currentSelector: string, retryAfterMs: number | undefined, errorMessage: string): void {
		const cooldownMs =
			retryAfterMs && retryAfterMs > 0
				? retryAfterMs
				: calculateRateLimitBackoffMs(parseRateLimitReason(errorMessage), "selector-suppression");
		this.#session.modelRegistry.suppressSelector(currentSelector, Date.now() + cooldownMs);
	}

	/** Switch to a fallback model for the rest of the retry sequence, recording what to restore. */
	async #applyCandidate(
		role: string,
		selector: RetryFallbackSelector,
		candidate: Model,
		currentSelector: string,
		options?: { pinFallback?: boolean },
	): Promise<void> {
		// Capture the configured selector (auto-aware) so a fallback chain preserves
		// `auto` instead of collapsing it to the level it resolved to this turn.
		const currentThinkingLevel = this.#session.configuredThinkingLevel();
		const nextThinkingLevel = selector.thinkingLevel ?? currentThinkingLevel;
		this.#switchModel(candidate);
		this.#session.setThinkingLevel(nextThinkingLevel, false, "resolved");
		if (!this.#activeFallback) {
			this.#activeFallback = {
				role,
				originalSelector: currentSelector,
				originalThinkingLevel: currentThinkingLevel,
				lastAppliedFallbackThinkingLevel: nextThinkingLevel,
				pinned: options?.pinFallback === true,
			};
		} else {
			this.#activeFallback.lastAppliedFallbackThinkingLevel = nextThinkingLevel;
			this.#activeFallback.pinned = this.#activeFallback.pinned || options?.pinFallback === true;
		}
		await this.#host.emitSessionEvent({
			type: "retry_fallback_applied",
			from: currentSelector,
			to: selector.raw,
			role,
		});
	}

	/**
	 * Switch the active model for a retry: a provider-session reset, an ephemeral model-change entry,
	 * and a usage record. Every retry model switch (a chain fallback, the Fireworks Fast degrade, the
	 * restore of the primary) goes through here.
	 */
	#switchModel(model: Model): string {
		const selector = formatModelStringWithRouting(model);
		this.#host.setModelWithProviderSessionReset(model);
		this.#session.sessionManager.appendModelChange(selector, EPHEMERAL_MODEL_CHANGE_ROLE);
		AgentStorage.forAgentDir(this.#session.settings.getAgentDir())?.recordModelUsage(selector);
		return selector;
	}

	/** The registry model a fallback selector names, when it resolves and has a credential. */
	async #usableModel(selector: RetryFallbackSelector): Promise<Model | undefined> {
		const registry = this.#session.modelRegistry;
		const resolved = resolveModelOverride([selector.raw], registry, this.#session.settings);
		const model = resolved.model ?? registry.find(selector.provider, selector.id);
		if (!model) return undefined;
		return (await registry.getApiKey(model, this.#session.sessionId)) ? model : undefined;
	}

	async tryChain(currentSelector: string, options?: { pinFallback?: boolean }): Promise<boolean> {
		const source = this.#source();
		const role = this.#activeFallback?.role ?? resolveRetryFallbackRole(source, currentSelector);
		if (!role) return false;

		for (const selector of findRetryFallbackCandidates(source, role, currentSelector)) {
			if (this.#isSuppressed(selector)) continue;
			const candidate = await this.#usableModel(selector);
			if (!candidate) continue;
			await this.#applyCandidate(role, selector, candidate, currentSelector, options);
			return true;
		}

		return false;
	}

	/** The active model when it is a Fireworks Fast (`-fast`) variant, else undefined. */
	#activeFireworksFastModel(): Model | undefined {
		const model = this.#session.model;
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
	fireworksFastEligible(message: AssistantMessage): boolean {
		const model = this.#activeFireworksFastModel();
		if (!model) return false;
		if (message.stopReason !== "error") return false;
		if (message.content.some(block => block.type === "toolCall")) return false;
		// A content refusal/sensitivity stop is the model's decision, not a route
		// failure — switching to the base model would just re-trigger it.
		if (isClassifierRefusal(message)) return false;
		const id = this.#host.classify(message);
		if (AIError.isContextOverflow(message, model.contextWindow ?? 0)) return false;
		if (AIError.is(id, AIError.Flag.UsageLimit)) return false;
		if (AIError.is(id, AIError.Flag.AuthFailed)) return false;
		return this.#session.modelRegistry.find("fireworks", toFireworksBaseModelId(model.id)) !== undefined;
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
	hardErrorEligible(message: AssistantMessage): boolean {
		if (message.stopReason !== "error") return false;
		const model = this.#session.model;
		if (!model) return false;
		const retrySettings = this.#session.settings.getGroup("retry");
		if (!retrySettings.enabled || !retrySettings.modelFallback) return false;
		if (isClassifierRefusal(message)) return false;
		const id = this.#host.classify(message);
		if (AIError.is(id, AIError.Flag.Abort) || AIError.is(id, AIError.Flag.UserInterrupt)) return false;
		if (AIError.isContextOverflow(message, model.contextWindow ?? 0)) return false;
		if (hasReplayUnsafeToolOutput(message, this.#session.agent.state.messages)) return false;
		const currentSelector = formatRetryFallbackSelector(model, this.#session.thinkingLevel);
		const source = this.#source();
		const role = this.#activeFallback?.role ?? resolveRetryFallbackRole(source, currentSelector);
		if (!role) return false;
		return findRetryFallbackCandidates(source, role, currentSelector).length > 0;
	}

	/**
	 * Switch the active model from a Fireworks Fast (`-fast`) variant to its base
	 * (Standard) id and stick there for the rest of the session — the auto
	 * fallback that makes Fast a safe default. Returns false when the current
	 * model is not a fast variant, the base id is missing, or it has no key.
	 */
	async tryFireworksFast(currentSelector: string): Promise<boolean> {
		const model = this.#activeFireworksFastModel();
		if (!model) return false;
		const registry = this.#session.modelRegistry;
		const baseModel = registry.find("fireworks", toFireworksBaseModelId(model.id));
		if (!baseModel) return false;
		const apiKey = await registry.getApiKey(baseModel, this.#session.sessionId);
		if (!apiKey) return false;
		const baseSelector = this.#switchModel(baseModel);
		await this.#host.emitSessionEvent({
			type: "retry_fallback_applied",
			from: currentSelector,
			to: baseSelector,
			role: "fireworks-fast",
		});
		return true;
	}

	/** Restore the primary model a fallback replaced, once its cooldown has expired between retry sequences. */
	async maybeRestorePrimary(): Promise<void> {
		if (!this.#activeFallback) return;
		if (this.#activeFallback.pinned) return;
		if (this.#revertPolicy() !== "cooldown-expiry") return;

		const {
			originalSelector: originalSelectorRaw,
			originalThinkingLevel,
			lastAppliedFallbackThinkingLevel,
		} = this.#activeFallback;
		const originalSelector = parseRetryFallbackSelector(originalSelectorRaw, this.#session.modelRegistry);
		if (!originalSelector) {
			this.clear();
			return;
		}

		const currentModel = this.#session.model;
		if (!currentModel) return;
		const currentSelector = formatRetryFallbackSelector(currentModel, this.#session.thinkingLevel);
		if (currentSelector === originalSelector.raw) {
			if (!this.#isSuppressed(originalSelector)) {
				this.clear();
			}
			return;
		}
		if (this.#isSuppressed(originalSelector)) return;

		const primaryModel = await this.#usableModel(originalSelector);
		if (!primaryModel) return;

		const currentThinkingLevel = this.#session.configuredThinkingLevel();
		const thinkingToApply =
			currentThinkingLevel === lastAppliedFallbackThinkingLevel ? originalThinkingLevel : currentThinkingLevel;
		this.#switchModel(primaryModel);
		this.#session.setThinkingLevel(thinkingToApply, false, "resolved");
		this.clear();
	}
}
