/**
 * Bounded retries for an empty assistant completion.
 *
 * Some providers — and especially flaky OpenAI-/Anthropic-compatible gateways —
 * intermittently return a benign terminal stop carrying no content and no usage
 * (e.g. a single OpenAI `delta: {}` + `finish_reason: "stop"` chunk). Delivered
 * as-is the agent loop has nothing to act on and silently halts mid-task, so the
 * request must be retried instead of surfaced.
 *
 * This wraps a single-attempt provider stream and re-invokes it (a fresh request
 * with its own message state) when an attempt produces no meaningful content.
 * Only a stream that streamed nothing meaningful is retried: the moment any
 * text/thinking/tool delta is forwarded the attempt is committed, so live
 * streaming (including thinking) is never delayed, retried, or duplicated.
 *
 * Mirrors the Gemini empty-response policy in `google-shared` (which keeps its
 * own integrated loop) and is shared by the OpenAI-completions and
 * Anthropic-messages providers.
 *
 * A PRE-RESPONSE STALL is the second member of the same class: the turn
 * delivered nothing, not because the provider answered emptily but because it
 * never answered at all. A first connect that produces no first event is
 * common, and retrying it once is what keeps a turn alive; a second
 * consecutive stall is a dead endpoint. Providers that already run their own
 * bounded stall ladder (Anthropic, Codex) declare `providerRetriesStalls` so
 * the two ladders never multiply.
 */
import { scheduler } from "node:timers/promises";
import { discardAttemptUsage } from "@veyyon/catalog/models";
import type { Api, AssistantMessage, AssistantMessageEvent, Context, Model } from "../types";
import { AssistantMessageEventStream } from "./event-stream";
import { isPreResponseStallMessage, openStallLadderBudget, PRE_RESPONSE_STALL_ATTEMPTS } from "./first-event-budget";

export const MAX_EMPTY_COMPLETION_RETRIES = 2;
export const EMPTY_COMPLETION_BASE_DELAY_MS = 500;

/**
 * Surfaced when a turn hit the length cap having delivered nothing per
 * {@link hasVisibleAssistantContent}: the prompt itself consumed the window, so
 * there is no partial answer to keep and the operator has to make room. Ollama
 * is the only backend that reaches this (`emptyLengthFinishIsContextError` in
 * the catalog's OpenAI compat is `provider === "ollama"`), but it reaches it
 * down both the native `ollama-chat` stream and the OpenAI-compatible one, so
 * the wording lives here rather than in either provider.
 */
export const EMPTY_OLLAMA_LENGTH_COMPLETION_MESSAGE =
	"Model returned no content: prompt filled the context window; raise Ollama num_ctx or shorten the prompt.";

const NON_WHITESPACE_RE = /\S/;

/**
 * Whether a completed assistant message carries content worth delivering: a tool
 * call or any non-whitespace text. An empty/whitespace-only message — or one
 * that only ever produced thinking — is the "empty response" failure.
 */
export function hasVisibleAssistantContent(message: AssistantMessage): boolean {
	for (const block of message.content) {
		if (block.type === "toolCall") return true;
		if (block.type === "text" && NON_WHITESPACE_RE.test(block.text)) return true;
	}
	return false;
}

/** A streamed event that delivers content worth committing the attempt for. */
function isMeaningfulCompletionEvent(event: AssistantMessageEvent): boolean {
	switch (event.type) {
		case "text_delta":
		case "thinking_delta":
		case "toolcall_delta":
			return event.delta.length > 0;
		case "text_end":
		case "thinking_end":
			return event.content.length > 0;
		case "toolcall_start":
		case "toolcall_end":
			return true;
		default:
			return false;
	}
}

interface EmptyCompletionRetryOptions {
	signal?: AbortSignal;
	providerRetryWait?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
	/** The caller's declared per-attempt first-event deadline, when it set one. */
	streamFirstEventTimeoutMs?: number;
}

/** How a provider divides stall-retry responsibility with this wrapper. */
export interface TurnRetryPolicy {
	/**
	 * True when the provider runs its own bounded pre-response stall ladder, so
	 * this wrapper must not add a second one on top of it.
	 */
	providerRetriesStalls?: boolean;
}

/**
 * Wrap a single-attempt provider stream with bounded retries for a turn that
 * delivered nothing: an empty completion, or a pre-response stall.
 * `attempt` MUST create a fresh request (and its own output message) on each
 * call so a retry never inherits stale metadata from a discarded attempt.
 *
 * A discarded attempt's spend is not stale metadata: the provider billed the
 * whole prompt (cache write included) for the empty answer it returned, so each
 * abandoned attempt's usage is carried onto the message finally delivered.
 */
export function withEmptyCompletionRetry<TApi extends Api, O extends EmptyCompletionRetryOptions>(
	model: Model<TApi>,
	context: Context,
	options: O | undefined,
	attempt: (model: Model<TApi>, context: Context, options?: O) => AssistantMessageEventStream,
	policy?: TurnRetryPolicy,
): AssistantMessageEventStream {
	const outer = new AssistantMessageEventStream();
	const signal = options?.signal;
	const discardedUsages: AssistantMessage["usage"][] = [];
	const carrySpend = (delivered: AssistantMessage): AssistantMessage => {
		for (const spent of discardedUsages) discardAttemptUsage(model, spent, delivered.usage);
		discardedUsages.length = 0;
		return delivered;
	};
	// The declared first-event timeout is one attempt's deadline; the whole
	// pre-first-event phase is that deadline times the stall allowance, so a
	// retry can never push a turn past a multiple of the caller's own number.
	const stallBudget = openStallLadderBudget(options?.streamFirstEventTimeoutMs);
	let stallAttempt = 0;
	let emptyAttempt = 0;
	void (async () => {
		while (true) {
			const inner = attempt(model, context, options);
			const buffered: AssistantMessageEvent[] = [];
			let committed = false;
			let terminal: AssistantMessageEvent | undefined;
			const flush = (): void => {
				for (const event of buffered) outer.push(event);
				buffered.length = 0;
			};
			try {
				for await (const event of inner) {
					if (event.type === "done" || event.type === "error") {
						terminal = event;
						break;
					}
					// Buffer pre-content events (start/*_start) so an empty attempt can
					// be discarded; commit the moment real content streams.
					if (!committed && !isMeaningfulCompletionEvent(event)) {
						buffered.push(event);
						continue;
					}
					committed = true;
					flush();
					outer.push(event);
					if (outer.done) return;
				}
			} catch (error) {
				flush();
				outer.fail(error);
				return;
			}

			// Retry only a genuinely degenerate completion: a normal stop that
			// produced no visible content and reported no generated content tokens.
			// Some providers count the terminal EOS as one output token, so a
			// one-token invisible stop is still the same empty-completion failure.
			const message = terminal?.type === "done" ? terminal.message : undefined;
			const isRetryableEmpty =
				!committed &&
				message !== undefined &&
				message.stopReason === "stop" &&
				!message.errorMessage &&
				(message.usage?.output ?? 0) <= 1 &&
				!hasVisibleAssistantContent(message) &&
				emptyAttempt < MAX_EMPTY_COMPLETION_RETRIES;

			// A turn that never reached its first event is the other way a turn
			// delivers nothing, and the one a provider without its own ladder
			// used to surface unretried. Only an uncommitted attempt qualifies:
			// once a delta is out, replaying the request would duplicate it.
			const failure = terminal?.type === "error" ? terminal.error : undefined;
			const isRetryableStall =
				!committed &&
				policy?.providerRetriesStalls !== true &&
				failure !== undefined &&
				failure.stopReason !== "aborted" &&
				signal?.aborted !== true &&
				isPreResponseStallMessage(failure.errorMessage ?? "") &&
				stallAttempt < PRE_RESPONSE_STALL_ATTEMPTS - 1 &&
				!stallBudget.spent();

			if (isRetryableEmpty || isRetryableStall) {
				// A stalled attempt already spent the whole first-event deadline;
				// the backoff that paces an empty completion adds nothing to it.
				const delayMs = isRetryableStall ? 0 : EMPTY_COMPLETION_BASE_DELAY_MS * 2 ** emptyAttempt;
				try {
					signal?.throwIfAborted();
					if (options?.providerRetryWait) await options.providerRetryWait(delayMs, signal);
					else await scheduler.wait(delayMs, { signal });
					signal?.throwIfAborted();
				} catch (waitError) {
					// Backoff is part of the operation: cancellation must reject it,
					// never turn the stale empty attempt into a successful result.
					flush();
					outer.fail(signal?.aborted ? signal.reason : waitError);
					return;
				}
				// The buffered `start` from this discarded attempt is dropped, but
				// the prompt it billed is not: keep its usage for the delivered
				// message. A stall bills nothing, so it usually carries none.
				const discardedUsage = isRetryableStall ? failure?.usage : message?.usage;
				if (discardedUsage) discardedUsages.push(discardedUsage);
				// The two ladders are separate budgets: a stall must not consume
				// the allowance an empty completion gets, or vice versa.
				if (isRetryableStall) stallAttempt++;
				else emptyAttempt++;
				continue;
			}

			flush();
			if (terminal) {
				// A failed turn has no message to carry spend onto (the caller sees a
				// thrown error), so only a terminal event takes it.
				if (terminal.type === "done") carrySpend(terminal.message);
				else if (terminal.type === "error") carrySpend(terminal.error);
				outer.push(terminal);
			} else if (!outer.done) {
				try {
					outer.end(carrySpend(await inner.result()));
				} catch (error) {
					outer.fail(error);
				}
			}
			return;
		}
	})();
	return outer;
}
