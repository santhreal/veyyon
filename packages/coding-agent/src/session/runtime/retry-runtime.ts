/**
 * The retry ladder of a session: the backoff retry of a failed turn, credential rotation, and the
 * continuation of a tool batch that cannot be replayed. The model switches the ladder makes are
 * {@link RetryFallback}'s.
 *
 * This is a session collaborator. It holds the retry gate `prompt()` waits on, the attempt counter
 * and the errors a retry recovered, and reaches the session through {@link RetrySession} and
 * {@link RetryHost}.
 */
import { scheduler } from "node:timers/promises";
import type { AssistantMessage, AssistantRetryRecovery, AssistantRetryRecoveryKind, Model } from "@veyyon/ai";
import * as AIError from "@veyyon/ai/error";
import { calculateRateLimitBackoffMs, parseRateLimitReason } from "@veyyon/ai/error/rate-limit";
import type { OperatorNotices } from "@veyyon/kernel/session/operator-notices";
import {
	calculateRetryBackoffDelayMs,
	describeRetryPolicySource,
	type ResolvedRetryPolicy,
	resolveRetryPolicy,
	unreplayableContinueDelayMs,
} from "@veyyon/kernel/session/retry-policy";
import type { SessionEntry } from "@veyyon/kernel/session/session-entries";
import { errorMessage, extractRetryHint, logger } from "@veyyon/utils";
import type { RecoveredRetryError } from "../../extensibility/shared-events";
import { turnControlPrompts } from "../../prompts/turn-control/rows";
import { isEmptyAssistantStop, isSameAssistantMessage } from "../agent-session-message-shapes";
import { formatRetryFallbackSelector } from "../agent-session-retry-fallback";
import type {
	AgentSessionEvent,
	PendingRecoveredRetryError,
	ScheduledAgentContinueOptions,
} from "../agent-session-types";
import { hasReplayUnsafeToolOutput, isClassifierRefusal, toolBatchCanContinue } from "../failed-turn";
import { THINKING_LOOP_REDIRECT_TYPE } from "../nudges";
import { sameMessageContent, sessionMessagePersistenceKey } from "../turn-persistence";
import { RetryFallback, type RetryFallbackSession } from "./retry-fallback";

/**
 * Slack added past a sibling credential's block expiry before retrying, so
 * the next getApiKey lands after the block has actually lapsed.
 */
const SIBLING_UNBLOCK_BUFFER_MS = 1_000;

/** How a failed turn entered retry handling: which switches the recovery may make. */
interface RetryEntryOptions {
	allowModelFallback?: boolean;
	fireworksFastFallback?: boolean;
	hardErrorFallback?: boolean;
}

/** One retry attempt: the failure it answers, and the wait and switches decided for it. */
interface RetryAttempt {
	readonly message: AssistantMessage;
	readonly id: number;
	/** The failure's text, `Unknown error` when it carried none. */
	readonly errorMessage: string;
	/** The retry-after the provider's text asks for, if it states one. */
	readonly parsedRetryAfterMs: number | undefined;
	/** Every attempt on the current model is spent; only a model switch can retry. */
	readonly budgetExhausted: boolean;
	readonly classifierRefusal: boolean;
	readonly options: RetryEntryOptions | undefined;
	delayMs: number;
	switchedCredential: boolean;
	switchedModel: boolean;
	/** Set when a usage limit pinned the wait to credential availability; the retry-after bump then stays off. */
	usageLimitWaitMs: number | undefined;
}

/** What {@link RetryRuntime} reads from the session's public surface. */
export interface RetrySession extends RetryFallbackSession {
	readonly operatorNotices: OperatorNotices;
}

/** What {@link RetryRuntime} needs from the session beyond its public surface. */
export interface RetryHost {
	emitSessionEvent(event: AgentSessionEvent): Promise<void>;
	/** The prompt cycle now running; an abort advances it. */
	promptGeneration(): number;
	scheduleAgentContinue(options?: ScheduledAgentContinueOptions): void;
	/**
	 * Whether the turn was stopped on purpose: a user or lifecycle abort, a dispose, or the
	 * streaming-edit guard. Such a turn settles and is never retried or continued.
	 */
	abortIsDeliberate(): boolean;
	/** Switch the active model and reset the provider sessions the switch invalidates. */
	setModelWithProviderSessionReset(model: Model): void;
	resetCurrentResponsesProviderSession(reason: string): void;
	/** Spend a saved Codex reset on a live usage-limit failure; true when one was spent. */
	maybeAutoRedeemCodexReset(): Promise<boolean>;
	removeAssistantMessageFromActiveContext(message: AssistantMessage, reason: string): void;
	/** Persist an empty error turn the retry ladder is about to drop, once. */
	persistLifecycleErrorMessage(message: AssistantMessage): Promise<void>;
	resetSessionStopContinuationState(): void;
}

function isGenericAbortSentinel(message: AssistantMessage): boolean {
	return message.errorMessage === "Request was aborted" || message.errorMessage === "Request was aborted.";
}

function retryRecoveryKind(
	id: number,
	switchedCredential: boolean,
	switchedModel: boolean,
	delayMs: number,
): AssistantRetryRecoveryKind {
	if (switchedCredential) return "credential";
	if (switchedModel) return "model";
	if (AIError.is(id, AIError.Flag.UsageLimit) && delayMs > 0) return "wait";
	return "plain";
}

function retryRecoveryNote(recovery: AssistantRetryRecoveryKind, rateLimited: boolean): string {
	const parts: string[] = [];
	if (rateLimited) {
		parts.push("rate-limited");
	} else if (recovery === "plain") {
		parts.push("error");
	}
	if (recovery === "credential") {
		parts.push("switched account");
	} else if (recovery === "model") {
		parts.push("switched model");
	} else if (recovery === "wait") {
		parts.push("waited");
	}
	parts.push("retried");
	return parts.join("; ");
}

export class RetryRuntime {
	readonly #session: RetrySession;
	readonly #host: RetryHost;
	#abortController: AbortController | undefined = undefined;
	#attempt = 0;
	/** Continuations spent on transport deaths inside an unreplayable tool batch;
	 *  charged against the same budget as a retry, and restored both by a turn that
	 *  lands and by a new prompt, which is a new incident. */
	#batchContinues = 0;
	#gate: Promise<void> | undefined = undefined;
	#release: (() => void) | undefined = undefined;
	readonly #fallback: RetryFallback;
	#pendingRecoveredErrors: PendingRecoveredRetryError[] = [];

	constructor(session: RetrySession, host: RetryHost) {
		this.#session = session;
		this.#host = host;
		this.#fallback = new RetryFallback(session, {
			emitSessionEvent: event => host.emitSessionEvent(event),
			setModelWithProviderSessionReset: model => host.setModelWithProviderSessionReset(model),
			classify: message => this.#classify(message),
		});
	}

	/** Current retry attempt (0 if not retrying). */
	get attempt(): number {
		return this.#attempt;
	}

	/** Whether a retry or a continuation's announced wait holds the gate. */
	get isRetrying(): boolean {
		return this.#gate !== undefined;
	}

	/** The gate `prompt()` waits on while a retry is pending, if one is. */
	get gate(): Promise<void> | undefined {
		return this.#gate;
	}

	/** A new prompt is a new incident: restore the unreplayable-batch continuation allowance. */
	resetForPrompt(): void {
		// Every other turn-recovery allowance is restored with the prompt, and this one was reset
		// only by a turn that came back, so a session that spent it on a turn which never landed
		// could not continue again for the rest of its life: the next prompt died on the same
		// transport with no continuation and nothing said why. Continuations re-request through
		// the scheduled continue, which does not pass through here, so the cap still terminates a
		// provider that dies every attempt.
		this.#batchContinues = 0;
	}

	/**
	 * Classify retry decisions against the active session model. Test stream
	 * shims and provider adapters can emit generic assistant metadata, but retry
	 * policy belongs to the model that was actually requested for this turn.
	 */
	#classify(message: AssistantMessage): number {
		const activeModel = this.#session.model;
		const trace: string[] = [];
		const sameApi = !activeModel || message.api === activeModel.api;
		const id = sameApi
			? AIError.classifyMessage(message, trace)
			: AIError.classifyMessage(
					{
						api: activeModel.api,
						errorId: message.errorId,
						errorMessage: message.errorMessage,
						errorStatus: message.errorStatus,
					},
					trace,
				);
		// The rules that decided it, not only what it decided: a retry nobody expected, or a failure
		// that surfaced when a retry was due, is diagnosed from this line instead of by re-running the
		// classifier's conditions by hand against the provider's sentence.
		logger.debug("retry classification", { errorId: id, kind: AIError.stringify(id), rules: [...new Set(trace)] });
		message.errorId = id;
		return id;
	}

	/**
	 * Retry an empty, reason-less provider abort: a turn with no content that
	 * carries the generic sentinel (bare `abort()`), whether the provider
	 * finalized it as `stopReason: "aborted"` or leaked it as `stopReason:
	 * "error"` (a stalled/dropped stream reported as an error rather than an
	 * abort — issue #5375). Only fires while the session is neither aborting nor
	 * tearing down. A user/lifecycle abort, a dispose-driven abort, or a
	 * session-induced streaming-edit guard abort (auto-generated-file guard or
	 * failed-patch preview) is deliberate and MUST settle the turn instead:
	 * routing it through retry would orphan the retry gate on a continuation the
	 * guard skips (hanging the in-flight `prompt()`) or silently undo the guard's
	 * intended abort. Deliberate user interrupts (`UserInterrupt`) and silent
	 * aborts carry their own marker, not the generic sentinel, so they never
	 * match here.
	 */
	#isRetryableReasonlessAbort(message: AssistantMessage): boolean {
		if (
			(message.stopReason !== "aborted" && message.stopReason !== "error") ||
			message.content.length !== 0 ||
			this.#host.abortIsDeliberate()
		) {
			return false;
		}

		const id = this.#classify(message);
		if (message.stopReason === "aborted" && AIError.is(id, AIError.Flag.Abort)) return true;
		if (!isGenericAbortSentinel(message)) return false;

		message.errorId = AIError.create(AIError.Flag.Abort);
		return true;
	}

	/**
	 * Check if an error is retryable (transient errors or usage limits).
	 * Context overflow is NOT retryable (handled by compaction instead).
	 * Usage-limit errors are retryable because the retry handler performs credential switching.
	 */
	#isRetryableError(message: AssistantMessage): boolean {
		if (message.stopReason !== "error") return false;

		const id = this.#classify(message);
		// Context overflow is handled by compaction, not retry
		const contextWindow = this.#session.model?.contextWindow ?? 0;
		if (AIError.isContextOverflow(message, contextWindow)) return false;

		if (isClassifierRefusal(message)) return true;
		return AIError.retriable(id, {
			replayUnsafe: hasReplayUnsafeToolOutput(message, this.#session.agent.state.messages),
		});
	}

	/**
	 * A transport fault killed a tool batch that cannot be replayed, so continue
	 * the turn instead of ending the session's work.
	 *
	 * Retry and continuation answer different questions. Retry re-sends the turn,
	 * which {@link hasReplayUnsafeToolOutput} forbids once any call in the batch
	 * may have run: a Cursor exec-channel call dispatched inside the provider
	 * stream, or a call that already has a real result. Continuation sends the
	 * turn that is now in context, which is complete and valid: the failed
	 * assistant message kept its calls, every call the loop never dispatched was
	 * paired with a never-ran placeholder, and the batch ledger names exactly
	 * which ones need reissuing. Nothing is duplicated, because nothing is resent.
	 *
	 * Without this the operator's session stopped dead in the middle of a batch
	 * (a reported turn: 75 calls, 0 ran, 21 interrupted, 54 never ran) on a
	 * failure the classifier itself calls transient, and the only way forward was
	 * to notice and type something. The same happened when the stream died after
	 * the whole batch ran: Cursor's exec channel runs every call inside the
	 * stream, so a reset after the last result left a fully answered batch that
	 * was neither replayable nor continued. The bar is narrow: the failure would
	 * have been retried but for replay safety, the batch is continuable (see
	 * {@link toolBatchCanContinue}), and the attempts run on their own allowance, sized by the same
	 * `retry.maxRetries`, so a provider dying on every attempt cannot loop. Its
	 * own counter rather than the retry ladder's: the two answer different
	 * questions and one turn can legitimately reach both, so a turn that already
	 * retried must not arrive here with its recovery spent. The wait is the retry
	 * ladder's, though, down to the event it emits and the gate escape cancels.
	 */
	async #continueAfterUnreplayableBatch(message: AssistantMessage): Promise<boolean> {
		if (message.stopReason !== "error") return false;
		if (this.#host.abortIsDeliberate()) return false;
		const retrySettings = this.#session.settings.getGroup("retry");
		if (!retrySettings.enabled) return false;
		const id = this.#classify(message);
		// Blocked only by replay safety: transient on its own, refused with it.
		if (!AIError.retriable(id, { replayUnsafe: false })) return false;
		if (AIError.retriable(id, { replayUnsafe: true })) return false;
		const context = this.#session.agent.state.messages;
		if (!hasReplayUnsafeToolOutput(message, context)) return false;
		if (!toolBatchCanContinue(message, context)) return false;
		const policy = this.#resolvePolicy(retrySettings);
		if (this.#batchContinues >= policy.maxRetries) return false;
		this.#batchContinues += 1;
		this.#session.operatorNotices.warn(
			"unreplayable-batch",
			"The provider stream failed partway through a tool batch that cannot be replayed. Continuing the turn from the results already in context.",
		);
		// A continuation borrows the retry ladder's budget, so it borrows the same
		// backoff: the transport just died, and re-requesting the largest context
		// the session holds with no pause is what backoff exists to prevent. Keyed
		// on this counter rather than the attempt counter, so a session that also
		// retried does not inherit that ladder's position on its first continuation.
		// The formula and the ceiling rule live with the policy they read.
		const delayMs = unreplayableContinueDelayMs(policy, this.#batchContinues);
		// The wait joins the retry ladder's machinery instead of hiding inside the
		// scheduler's own delay, because a wait nobody can see or stop is worse than
		// no wait at all. #isRetryableError is false here by construction, which is
		// what sent us down this path, so #handleRetryableError never ran and the
		// retry gate does not exist yet: without creating it `isRetrying` stays
		// false, escape never reaches abortRetry(), and the countdown, an agent
		// HUD's retryState and every hook, extension, collab and SDK consumer see
		// nothing while the session sits silent for seconds.
		this.#ensureGate();
		await this.#host.emitSessionEvent({
			type: "auto_retry_start",
			attempt: this.#batchContinues,
			mode: "continue",
			maxAttempts: policy.maxRetries,
			policySource: describeRetryPolicySource(policy),
			delayMs,
			errorMessage: message.errorMessage || "Unknown error",
			errorId: message.errorId,
		});
		const waited = await this.#wait(delayMs);
		if (waited === "superseded") return false;
		if (waited === "cancelled") {
			await this.#host.emitSessionEvent({
				type: "auto_retry_end",
				success: false,
				attempt: this.#batchContinues,
				mode: "continue",
				finalError: "Continuation cancelled",
			});
			this.resolve();
			return false;
		}
		// The gate stays live across the wait so the turn reads as retrying, and the
		// continued turn's own agent_end resolves it. A continuation the scheduler
		// skips must resolve it here or an in-flight prompt() waits forever.
		this.#host.scheduleAgentContinue({
			generation: this.#host.promptGeneration(),
			onSkip: () => this.resolve(),
		});
		return true;
	}

	/** Forget the active fallback: an explicit model change supersedes it. */
	clearActiveFallback(): void {
		this.#fallback.clear();
	}

	/** Restore the primary model a fallback replaced, once its cooldown has expired between retry sequences. */
	async maybeRestoreFallbackPrimary(): Promise<void> {
		// Restoring the primary means "the fallback is no longer needed", which is
		// only ever true between retry sequences, never inside one. The cooldown
		// that guards this is shorter than a retry budget takes to burn
		// (SERVER_ERROR suppresses for 20s; ten retries capped at
		// RETRY_BACKOFF_MAX_DELAY_MS run ~55s), so without this check the primary
		// came back mid-sequence, the next failure hopped away again on a budget
		// freshly reset to 1, and the pair cycled for as long as the fault lasted.
		// Every lap re-sent the whole prompt at full input rate.
		if (this.#attempt > 0) return;
		await this.#fallback.maybeRestorePrimary();
	}

	/**
	 * Merge the global `retry.*` settings with any per-provider policy for the
	 * active model. With no model resolved there is nothing to key on, so the
	 * global settings stand unchanged.
	 */
	#resolvePolicy(retrySettings: { maxRetries: number; baseDelayMs: number; maxDelayMs: number }): ResolvedRetryPolicy {
		const global = {
			maxRetries: retrySettings.maxRetries,
			baseDelayMs: retrySettings.baseDelayMs,
			maxDelayMs: retrySettings.maxDelayMs,
		};
		const model = this.#session.model;
		if (!model) return { ...global, source: "global" };
		return resolveRetryPolicy(global, this.#session.settings.get("retry.perProvider"), model);
	}

	/**
	 * Retry, fall back, or settle a failed or aborted turn. True when the turn is handled and the
	 * stop-time passes must not run.
	 */
	async recoverFailedTurn(msg: AssistantMessage): Promise<boolean> {
		if (
			this.#isRetryableReasonlessAbort(msg) &&
			(await this.#handleRetryableError(msg, { allowModelFallback: false }))
		) {
			return true;
		}
		// A deliberate abort should settle the current turn, not trigger queued continuations.
		if (msg.stopReason === "aborted") {
			this.resolve();
			this.#host.resetSessionStopContinuationState();
			return true;
		}
		// Fireworks Fast variants degrade to their base model on a failed turn — including hard
		// router errors the generic retry classifier rejects — so this runs before the standard
		// retryability check.
		if (
			this.#fallback.fireworksFastEligible(msg) &&
			(await this.#handleRetryableError(msg, { fireworksFastFallback: true }))
		) {
			return true;
		}
		if (this.#isRetryableError(msg)) {
			if (await this.#handleRetryableError(msg)) return true;
		} else if (
			// A non-retryable hard error on a model covered by a configured fallback chain: retrying
			// the SAME model is pointless, but a DIFFERENT model is a fresh chance. #handleRetryableError
			// bails out (no backoff-retry of the failing model) when no switch happens.
			this.#fallback.hardErrorEligible(msg) &&
			(await this.#handleRetryableError(msg, { hardErrorFallback: true }))
		) {
			return true;
		}
		// Retry was refused because the batch cannot be resent, not because the failure was final.
		// The turn now in context IS sendable, so continue it rather than leaving the session parked
		// mid-batch.
		return this.#continueAfterUnreplayableBatch(msg);
	}

	/**
	 * Handle retryable errors with exponential backoff, credential rotation, and
	 * model-fallback chains. Also entered for NON-retryable errors when a switch
	 * is the recovery (`fireworksFastFallback`, `hardErrorFallback`): then a
	 * successful model switch retries immediately, and a failed switch surfaces
	 * the error without a same-model backoff retry.
	 * A step that throws (the auth store, a credential lookup, the session file) ends the retry
	 * sequence as failed and returns false, which hands the turn back to the settle path that
	 * closes the retry gate `prompt()` waits on. A throw escaping here skipped that path.
	 * @returns true if retry was initiated, false if max retries exceeded or disabled
	 */
	async #handleRetryableError(message: AssistantMessage, options?: RetryEntryOptions): Promise<boolean> {
		try {
			return await this.#attemptRetry(message, options);
		} catch (error) {
			const failure = errorMessage(error);
			logger.error("Retry recovery failed", { error: failure, originalError: message.errorMessage });
			const attempt = this.#attempt;
			this.#attempt = 0;
			this.#pendingRecoveredErrors = [];
			await this.#host.emitSessionEvent({
				type: "auto_retry_end",
				success: false,
				attempt,
				finalError: `Retry recovery failed: ${failure}. Original error: ${message.errorMessage || "Unknown error"}`,
			});
			return false;
		}
	}

	async #attemptRetry(message: AssistantMessage, options?: RetryEntryOptions): Promise<boolean> {
		const retrySettings = this.#session.settings.getGroup("retry");
		// A backend that runs its own agent loop remotely fails slowly and
		// expensively, so the global attempt count and backoff are resolved
		// against the active model before anything below reads them.
		const policy = this.#resolvePolicy(retrySettings);
		// The Fireworks Fast→base degrade is an intrinsic model-selection safety net,
		// not a retry loop, so it runs even when the user disabled retries: it switches
		// the model once and lets the base turn proceed.
		if (!retrySettings.enabled && !options?.fireworksFastFallback) return false;

		const generation = this.#host.promptGeneration();
		this.#attempt++;

		// Create the retry gate on the first attempt so waitForRetry() can await it.
		this.#ensureGate();

		const errorMessage = message.errorMessage || "Unknown error";
		const id = this.#classify(message);
		const staleReplay = AIError.is(id, AIError.Flag.StaleResponsesItem);
		const attempt: RetryAttempt = {
			message,
			id,
			errorMessage,
			parsedRetryAfterMs: extractRetryHint(undefined, errorMessage),
			// All attempts on the current model are spent. Don't fail yet: the
			// fallback chain gets one last consult. Credential rotation can
			// consume the entire budget without the fallback branch ever running
			// (every rotation sets switchedCredential and skips it), so without
			// this last resort a provider-wide usage cap never fails over to the
			// configured chain.
			budgetExhausted: this.#attempt > policy.maxRetries,
			classifierRefusal: isClassifierRefusal(message),
			options,
			delayMs: staleReplay ? 0 : calculateRetryBackoffDelayMs(policy.baseDelayMs, this.#attempt),
			switchedCredential: false,
			switchedModel: false,
			usageLimitWaitMs: undefined,
		};

		if (staleReplay) {
			this.#host.resetCurrentResponsesProviderSession("stale replay error");
		} else {
			const model = this.#session.model;
			if (!attempt.budgetExhausted && model && AIError.is(id, AIError.Flag.UsageLimit)) {
				await this.#parkUsageLimit(attempt, model);
			}
			if (!attempt.switchedCredential) await this.#switchModel(attempt, retrySettings.modelFallback);
		}
		if (await this.#closeUnrecoverable(attempt, policy.maxDelayMs)) return false;

		await this.#recordPendingRecoveredError(message, id, attempt);

		await this.#host.emitSessionEvent({
			type: "auto_retry_start",
			attempt: this.#attempt,
			maxAttempts: policy.maxRetries,
			policySource: describeRetryPolicySource(policy),
			delayMs: attempt.delayMs,
			errorMessage,
			errorId: message.errorId,
		});

		// Remove the failed assistant message from active context before retrying.
		this.#host.removeAssistantMessageFromActiveContext(message, "auto-retry");

		// A thinking/response loop retried into identical context loops again. Inject a
		// hidden redirect so the retried turn sees a directive to break the repeated
		// pattern instead of re-sampling the same stalled reasoning.
		this.#maybeInjectThinkingLoopRedirect(id);

		// Wait with exponential backoff (abortable).
		const waited = await this.#wait(attempt.delayMs);
		if (waited === "superseded") return false;
		if (waited === "cancelled") {
			// Aborted during sleep - emit end event so UI can clean up
			const cancelledAttempt = this.#attempt;
			this.#attempt = 0;
			await this.#host.emitSessionEvent({
				type: "auto_retry_end",
				success: false,
				attempt: cancelledAttempt,
				finalError: "Retry cancelled",
			});
			this.#pendingRecoveredErrors = [];
			this.resolve();
			return false;
		}

		// Retry via continue() outside the agent_end event callback chain.
		this.#host.scheduleAgentContinue({ delayMs: 1, generation });

		return true;
	}

	/**
	 * Park the credential a usage-limit failure exhausted and decide the wait: none when a sibling
	 * credential or a banked Codex reset takes over, else the sooner of the provider's retry-after
	 * window and the moment a temporarily blocked sibling frees up.
	 */
	async #parkUsageLimit(attempt: RetryAttempt, model: Model): Promise<void> {
		const retryAfterMs =
			attempt.parsedRetryAfterMs ??
			calculateRateLimitBackoffMs(parseRateLimitReason(attempt.errorMessage), "credential-park");
		const outcome = await this.#session.modelRegistry.authStorage.markUsageLimitReached(
			model.provider,
			this.#session.sessionId,
			{
				retryAfterMs,
				baseUrl: model.baseUrl,
				modelId: model.id,
			},
		);
		// A live usage-limit 429 on the active Codex account, with a banked reset and the opt-in
		// setting on, spends the reset and retries immediately instead of waiting out the window.
		// It runs after the free sibling switch and before model fallback.
		if (outcome.switched || (await this.#host.maybeAutoRedeemCodexReset())) {
			attempt.switchedCredential = true;
			attempt.delayMs = 0;
			return;
		}
		// No sibling credential is usable right now. Wait for whichever comes first: the provider's
		// retry-after window for the current account, or the earliest moment a temporarily blocked
		// sibling frees up (e.g. a 60s post-401 block or a 5-min usage-probe block); the next
		// attempt's getApiKey re-ranks and picks it up. Without this, one short-lived sibling block
		// escalates a recoverable situation into the provider's multi-hour wait and trips the
		// fail-fast cap.
		let waitMs = retryAfterMs;
		if (outcome.retryAtMs !== undefined) {
			const siblingWaitMs = Math.max(0, outcome.retryAtMs - Date.now()) + SIBLING_UNBLOCK_BUFFER_MS;
			if (siblingWaitMs < waitMs) waitMs = siblingWaitMs;
		}
		attempt.usageLimitWaitMs = waitMs;
		if (waitMs > attempt.delayMs) attempt.delayMs = waitMs;
	}

	/**
	 * Try the configured fallback chain, then the Fireworks Fast degrade, and settle the wait: none
	 * after a switch, else at least the provider's retry-after hint unless a usage limit already
	 * pinned it.
	 */
	async #switchModel(attempt: RetryAttempt, modelFallback: boolean): Promise<void> {
		const activeModel = this.#session.model;
		if (!activeModel) return;
		const currentSelector = formatRetryFallbackSelector(activeModel, this.#session.thinkingLevel);
		const allowModelFallback = attempt.options?.allowModelFallback !== false;
		// A refusal chain stops at the retry budget: the exhausted-attempt
		// last resort is for provider failures, not classifier decisions.
		if (allowModelFallback && modelFallback && !(attempt.budgetExhausted && attempt.classifierRefusal)) {
			if (!attempt.classifierRefusal) {
				this.#fallback.noteCooldown(currentSelector, attempt.parsedRetryAfterMs, attempt.errorMessage);
			}
			attempt.switchedModel = await this.#fallback.tryChain(currentSelector, {
				pinFallback: attempt.classifierRefusal,
			});
		}
		// Auto fallback from a Fireworks Fast variant to its base model. Independent
		// of the role-fallback setting: it's intrinsic to the Fast contract (speed
		// best-effort, degrade to Standard on failure) and triggers on hard router
		// errors the generic retry classifier would otherwise reject.
		if (!attempt.switchedModel && allowModelFallback && attempt.options?.fireworksFastFallback) {
			attempt.switchedModel = await this.#fallback.tryFireworksFast(currentSelector);
		}
		const retryAfterMs = attempt.parsedRetryAfterMs;
		if (attempt.switchedModel) {
			attempt.delayMs = 0;
		} else if (attempt.usageLimitWaitMs === undefined && retryAfterMs && retryAfterMs > attempt.delayMs) {
			attempt.delayMs = retryAfterMs;
		}
	}

	/**
	 * End the retry sequence when this attempt cannot retry: the budget is spent with no model to
	 * switch to, a refusal found no other model, a switch-only recovery could not switch, or the
	 * provider asks for a wait past `retry.maxDelayMs`. True when the sequence ended. A fallback
	 * model reached on the spent budget starts a fresh one.
	 */
	async #closeUnrecoverable(attempt: RetryAttempt, maxDelayMs: number): Promise<boolean> {
		const { message, switchedModel } = attempt;
		if (attempt.budgetExhausted) {
			if (!switchedModel) {
				await this.#host.persistLifecycleErrorMessage(message);
				// Max retries exceeded and no fallback model to switch to: emit
				// final failure and reset.
				await this.#host.emitSessionEvent({
					type: "auto_retry_end",
					success: false,
					attempt: this.#attempt - 1,
					finalError: message.errorMessage,
				});
				this.#pendingRecoveredErrors = [];
				this.#attempt = 0;
				this.resolve(); // Resolve so waitForRetry() completes
				return true;
			}
			// The fallback model gets a fresh retry budget — leaving the spent
			// counter in place would exhaust it again on its first error.
			this.#attempt = 1;
		}
		if (attempt.classifierRefusal && !switchedModel) {
			this.#attempt = 0;
			this.resolve();
			return true;
		}
		// A fallback switch was the whole reason we entered (Fast→base degrade or
		// a hard-error chain consult) but it could not happen (e.g. no candidate
		// has a credential). Don't fall through to backing-off and retrying the
		// failing model for an error the generic classifier wouldn't retry —
		// surface it instead.
		const switchOnly = attempt.options?.fireworksFastFallback || attempt.options?.hardErrorFallback;
		if (switchOnly && !switchedModel && !this.#isRetryableError(message)) {
			this.#attempt = 0;
			this.resolve();
			return true;
		}
		// Fail-fast cap: if the provider asks us to wait longer than
		// retry.maxDelayMs and we have no fallback credential or model to
		// switch to, surface the error instead of sleeping. Defends against
		// 3-hour Anthropic rate-limit windows that would otherwise leave a
		// agent (or interactive session) silently hung. The original
		// assistant error message is preserved in agent state so the caller
		// can act on it.
		const { delayMs } = attempt;
		if (maxDelayMs > 0 && delayMs > maxDelayMs && !attempt.switchedCredential && !switchedModel) {
			await this.#host.persistLifecycleErrorMessage(message);
			const ended = this.#attempt;
			this.#attempt = 0;
			await this.#host.emitSessionEvent({
				type: "auto_retry_end",
				success: false,
				attempt: ended,
				finalError: `Provider requested ${delayMs}ms wait, exceeds retry.maxDelayMs (${maxDelayMs}ms). Original error: ${attempt.errorMessage}`,
			});
			this.#pendingRecoveredErrors = [];
			this.resolve();
			return true;
		}
		return false;
	}

	/**
	 * Sleep out a recovery wait on its own abort controller. `superseded` when a newer wait replaced
	 * this one, `cancelled` when {@link abort} reached it; the caller reports either.
	 *
	 * The wait is announced with `auto_retry_start` before this runs, and the gate it holds is what
	 * routes escape to {@link abort} during that announcement. A cancel landing there finds no
	 * controller to abort and only releases the gate, so a released gate cancels the wait here.
	 */
	async #wait(delayMs: number): Promise<"elapsed" | "cancelled" | "superseded"> {
		const controller = new AbortController();
		this.#abortController?.abort();
		this.#abortController = controller;
		if (!this.#gate) controller.abort();
		try {
			await scheduler.wait(delayMs, { signal: controller.signal });
		} catch {
			if (this.#abortController !== controller) return "superseded";
			this.#abortController = undefined;
			return "cancelled";
		}
		if (this.#abortController === controller) this.#abortController = undefined;
		return "elapsed";
	}

	/**
	 * Inject a hidden redirect notice when a thinking/response loop is being retried, so
	 * the retried turn carries an instruction to break the repeated pattern instead of
	 * re-sampling the same stalled context. Injected on every {@link AIError.Flag.ThinkingLoop}
	 * retry (the failed assistant is dropped each attempt, so the notice does not accumulate
	 * unboundedly). No-op unless `id` carries the ThinkingLoop flag and the loop guard is
	 * enabled. The notice is generic on purpose — the detector's detail can quote raw model
	 * text, which must not be interpolated into a higher-priority developer message.
	 */
	#maybeInjectThinkingLoopRedirect(id: number): void {
		if (!AIError.is(id, AIError.Flag.ThinkingLoop)) return;
		if (this.#session.settings.get("model.loopGuard.enabled") !== true) return;
		const text = turnControlPrompts["turn-control/thinking-loop-redirect"].text;
		this.#session.agent.appendMessage({
			role: "custom",
			customType: THINKING_LOOP_REDIRECT_TYPE,
			content: text,
			display: false,
			attribution: "agent",
			timestamp: Date.now(),
		});
		this.#session.sessionManager.appendCustomMessageEntry(
			THINKING_LOOP_REDIRECT_TYPE,
			text,
			false,
			undefined,
			"agent",
		);
	}

	/** Cancel an in-progress retry wait and release the gate. */
	abort(): void {
		this.#abortController?.abort();
		// The attempt counter is reset where the cancelled wait is caught.
		this.resolve();
	}

	/**
	 * Drop the failed or aborted assistant turn at the end of context and re-attempt it with a fresh
	 * retry budget. False when the last message is not a failed or aborted assistant turn.
	 */
	retryLastFailedTurn(): boolean {
		const agent = this.#session.agent;
		const messages = agent.state.messages;
		const lastMsg = messages[messages.length - 1];
		if (lastMsg?.role !== "assistant") return false;

		const assistantMsg = lastMsg as AssistantMessage;
		if (assistantMsg.stopReason !== "error" && assistantMsg.stopReason !== "aborted") return false;

		// Remove the failed/aborted assistant message (same as auto-retry does before re-attempting)
		agent.replaceMessages(messages.slice(0, -1));

		// Reset retry budget for a fresh attempt
		this.#attempt = 0;

		// Re-attempt the turn
		this.#host.scheduleAgentContinue({ delayMs: 1 });

		return true;
	}

	/**
	 * Create the retry gate promise if one does not already exist.
	 *
	 * The gate is what `isRetrying` reports, so it is also what decides whether
	 * escape cancels the wait instead of the turn. Every recovery that makes the
	 * session sit and wait before re-requesting must hold it, not just the retry
	 * ladder, and only one of them may own the resolver: a second promise would
	 * orphan the first and hang the `prompt()` awaiting it.
	 */
	#ensureGate(): void {
		if (this.#gate) return;
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#gate = promise;
		this.#release = resolve;
	}

	/** Resolve the pending retry gate. */
	resolve(): void {
		if (this.#release) {
			this.#release();
			this.#release = undefined;
			this.#gate = undefined;
		}
	}

	/**
	 * Close the retry sequence a landed assistant turn recovered: report the fallback that carried
	 * it, mark the errors it superseded, and emit the successful `auto_retry_end`.
	 */
	async closeRecovered(message: AssistantMessage): Promise<void> {
		// Captured before the reset below: a landed turn is what closes the wait this ladder
		// announced, and by then the counter is back to zero.
		const batchContinues = this.#batchContinues;
		const landed = message.stopReason !== "error" && !isEmptyAssistantStop(message);
		if (landed) {
			// A turn that reached the provider and came back with something is the evidence the
			// transport recovered; the next transport death gets the full budget. An EMPTY turn is
			// not that evidence: clearing the counter on one would leave the end event below nothing
			// to fire on once the empty-stop ladder produced a real turn.
			this.#batchContinues = 0;
		}
		// An unreplayable-batch continuation announces its wait through the same event as the retry
		// ladder but counts on its own allowance, so it needs its own arm here or its start has no
		// end: the countdown, an agent HUD's retryState and the turn's retry trace would stay open.
		if (!landed || message.stopReason === "aborted" || !(this.#attempt > 0 || batchContinues > 0)) return;
		const model = this.#session.model;
		const fallbackRole = this.#fallback.activeRole;
		if (fallbackRole !== undefined && model) {
			await this.#host.emitSessionEvent({
				type: "retry_fallback_succeeded",
				model: formatRetryFallbackSelector(model, this.#session.thinkingLevel),
				role: fallbackRole,
			});
		}
		const recoveredErrors = await this.#markPendingRecoveredErrors(message);
		await this.#host.emitSessionEvent({
			type: "auto_retry_end",
			success: true,
			attempt: this.#attempt > 0 ? this.#attempt : batchContinues,
			mode: this.#attempt > 0 ? "retry" : "continue",
			recoveredErrors,
		});
		this.#pendingRecoveredErrors = [];
		this.#attempt = 0;
	}

	/**
	 * Close an unreplayable-batch continuation's announced wait when the prompt
	 * settles without a turn ever landing.
	 *
	 * The wait is announced with `auto_retry_start`, and every consumer of that
	 * event stays open until an end arrives: the countdown, `progress.retryState`
	 * on a parent HUD, the turn's retry trace, hooks, extensions, collab and the
	 * SDK. A landed turn closes it in {@link closeRecovered}.
	 * An EMPTY turn does not, and must not: an empty completion is not evidence
	 * the transport recovered, so the allowance stays spent and the empty-stop
	 * ladder gets its own chance to produce a real turn that closes the wait.
	 * What is left is the prompt that ACCEPTS an empty completion as terminal
	 * (`acceptTerminalEmptyStop`, which the autolearn nudge sets): the turn
	 * settles there with no further request, so without this the countdown ran on
	 * a session that was already idle, with nothing left to cancel it.
	 */
	async endAnnouncedContinuationWait(finalError: string): Promise<void> {
		const attempt = this.#batchContinues;
		if (attempt === 0) return;
		this.#batchContinues = 0;
		await this.#host.emitSessionEvent({
			type: "auto_retry_end",
			success: false,
			attempt,
			mode: "continue",
			finalError,
		});
		this.resolve();
	}

	/**
	 * End the retry cycle when the empty-stop ladder hits its cap: report the failure, reset every
	 * counter, and release the gate.
	 */
	async failAtEmptyStopCap(emptyStopAttempts: number, finalError: string): Promise<void> {
		await this.#host.emitSessionEvent({
			type: "auto_retry_end",
			success: false,
			attempt: this.#attempt > 0 ? this.#attempt : emptyStopAttempts,
			finalError,
		});
		this.#pendingRecoveredErrors = [];
		this.#attempt = 0;
		// The cap ends the cycle for a continuation's announced wait too: the end
		// above closed it, and leaving the counter set would let the next landed
		// turn emit a second end reporting a recovery that never happened.
		this.#batchContinues = 0;
		this.resolve();
	}

	async #recordPendingRecoveredError(
		message: AssistantMessage,
		id: number,
		options: { switchedCredential: boolean; switchedModel: boolean; delayMs: number },
	): Promise<void> {
		await this.#host.persistLifecycleErrorMessage(message);
		const persistenceKey = sessionMessagePersistenceKey(message);
		if (!persistenceKey) return;
		let branchEntry: SessionEntry | undefined;
		for (const entry of this.#session.sessionManager.getBranch().slice().reverse()) {
			if (entry.type !== "message" || entry.message.role !== "assistant") continue;
			if (sessionMessagePersistenceKey(entry.message) !== persistenceKey) continue;
			if (!sameMessageContent(entry.message, message) && !isSameAssistantMessage(entry.message, message)) {
				continue;
			}
			branchEntry = entry;
			break;
		}
		if (!branchEntry) return;
		if (this.#pendingRecoveredErrors.some(error => error.entryId === branchEntry.id)) return;
		const rateLimited = AIError.is(id, AIError.Flag.UsageLimit);
		const recovery = retryRecoveryKind(id, options.switchedCredential, options.switchedModel, options.delayMs);
		const note = retryRecoveryNote(recovery, rateLimited);
		this.#pendingRecoveredErrors.push({
			entryId: branchEntry.id,
			persistenceKey,
			recovery,
			attempt: this.#attempt,
			note,
		});
	}

	async #markPendingRecoveredErrors(supersedingMessage: AssistantMessage): Promise<RecoveredRetryError[]> {
		if (this.#pendingRecoveredErrors.length === 0) return [];
		const sessionManager = this.#session.sessionManager;
		const branch = sessionManager.getBranch();
		const branchById = new Map<string, SessionEntry>();
		for (const entry of branch) {
			branchById.set(entry.id, entry);
		}
		const recoveredAt = new Date().toISOString();
		const supersededBy: AssistantRetryRecovery["supersededBy"] = {
			timestamp: supersedingMessage.timestamp,
			provider: supersedingMessage.provider,
			model: supersedingMessage.model,
		};
		if (supersedingMessage.responseId) {
			supersededBy.responseId = supersedingMessage.responseId;
		}
		const recoveredErrors: RecoveredRetryError[] = [];
		const updated: SessionEntry[] = [];
		for (const pending of this.#pendingRecoveredErrors) {
			let entry = branchById.get(pending.entryId);
			if (entry?.type !== "message" || entry.message.role !== "assistant") {
				entry = branch
					.slice()
					.reverse()
					.find(
						candidate =>
							candidate.type === "message" &&
							candidate.message.role === "assistant" &&
							sessionMessagePersistenceKey(candidate.message) === pending.persistenceKey,
					);
			}
			if (entry?.type !== "message" || entry.message.role !== "assistant") continue;
			const retryRecovery: AssistantRetryRecovery = {
				kind: "auto-retry",
				status: "recovered",
				attempt: pending.attempt,
				recoveredAt,
				recovery: pending.recovery,
				note: pending.note,
				supersededBy,
			};
			entry.message.retryRecovery = retryRecovery;
			updated.push(entry);
			recoveredErrors.push({
				entryId: entry.id,
				persistenceKey: pending.persistenceKey,
				note: retryRecovery.note,
				retryRecovery,
			});
		}
		if (updated.length > 0) {
			await sessionManager.rewriteEntries(updated);
		}
		return recoveredErrors;
	}
}
