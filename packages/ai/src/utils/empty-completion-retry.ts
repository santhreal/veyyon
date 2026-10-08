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
import { exponentialBackoffDelay } from "@veyyon/utils/backoff";
import type { Api, AssistantMessage, AssistantMessageEvent, Context, Model, Usage } from "../types";
import { AssistantMessageEventStream } from "./event-stream";
import {
	type FirstEventBudget,
	isPreResponseStallMessage,
	openStallLadderBudget,
	PRE_RESPONSE_STALL_ATTEMPTS,
} from "./first-event-budget";

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

/** The event an attempt ends on. */
type TerminalEvent = Extract<AssistantMessageEvent, { type: "done" | "error" }>;

/** What an attempt left once its stream stopped without settling the caller's stream. */
interface AttemptRead {
	inner: AssistantMessageEventStream;
	/** Events before the first meaningful one, held back so an empty attempt can be discarded unseen. */
	held: AssistantMessageEvent[];
	/** True once the attempt forwarded content; replaying the request would duplicate it. */
	committed: boolean;
	/** The attempt's done or error event; absent when its stream ended without one. */
	terminal: TerminalEvent | undefined;
}

function release(outer: AssistantMessageEventStream, held: AssistantMessageEvent[]): void {
	for (const event of held) outer.push(event);
	held.length = 0;
}

/**
 * Forwards one attempt's events to `outer`, holding back every event before the first meaningful one so an
 * empty attempt can be discarded unseen. Returns undefined when the attempt settled `outer`: the caller's
 * stream closed, or the attempt's stream threw.
 */
async function forwardAttempt(
	inner: AssistantMessageEventStream,
	outer: AssistantMessageEventStream,
): Promise<AttemptRead | undefined> {
	const held: AssistantMessageEvent[] = [];
	let committed = false;
	try {
		for await (const event of inner) {
			if (event.type === "done" || event.type === "error") return { inner, held, committed, terminal: event };
			if (!committed) {
				if (!isMeaningfulCompletionEvent(event)) {
					held.push(event);
					continue;
				}
				committed = true;
				release(outer, held);
			}
			outer.push(event);
			if (outer.done) return undefined;
		}
	} catch (error) {
		release(outer, held);
		outer.fail(error);
		return undefined;
	}
	return { inner, held, committed, terminal: undefined };
}

/**
 * One turn's retries: the attempts it re-issues, the pause before each, and the spend each discarded
 * attempt billed. Empty completions and pre-response stalls draw on separate allowances, so a stall never
 * consumes the retries an empty completion gets, or the reverse.
 */
class TurnRetries<TApi extends Api> {
	#emptyRetries = 0;
	#stallRetries = 0;
	readonly #discardedUsages: Usage[] = [];
	readonly #outer: AssistantMessageEventStream;
	readonly #model: Model<TApi>;
	readonly #options: EmptyCompletionRetryOptions | undefined;
	readonly #nextAttempt: () => AssistantMessageEventStream;
	readonly #providerRetriesStalls: boolean;
	readonly #stallBudget: FirstEventBudget;

	constructor(
		outer: AssistantMessageEventStream,
		model: Model<TApi>,
		options: EmptyCompletionRetryOptions | undefined,
		nextAttempt: () => AssistantMessageEventStream,
		policy: TurnRetryPolicy | undefined,
	) {
		this.#outer = outer;
		this.#model = model;
		this.#options = options;
		this.#nextAttempt = nextAttempt;
		this.#providerRetriesStalls = policy?.providerRetriesStalls === true;
		// The declared first-event timeout is one attempt's deadline; the whole
		// pre-first-event phase is that deadline times the stall allowance, so a
		// retry can never push a turn past a multiple of the caller's own number.
		this.#stallBudget = openStallLadderBudget(options?.streamFirstEventTimeoutMs);
	}

	async run(): Promise<void> {
		while (true) {
			const read = await forwardAttempt(this.#nextAttempt(), this.#outer);
			if (read === undefined) return;
			const { terminal } = read;
			if (read.committed || terminal === undefined || !this.#retryable(terminal)) return this.#deliver(read);
			if (!(await this.#backOff(terminal, read.held))) return;
		}
	}

	/** Whether an uncommitted attempt that ended on `terminal` delivered nothing and has a retry left. */
	#retryable(terminal: TerminalEvent): boolean {
		if (terminal.type === "done") {
			// Retry only a genuinely degenerate completion: a normal stop that
			// produced no visible content and reported no generated content tokens.
			// Some providers count the terminal EOS as one output token, so a
			// one-token invisible stop is still the same empty-completion failure.
			const message = terminal.message;
			return (
				message.stopReason === "stop" &&
				!message.errorMessage &&
				(message.usage?.output ?? 0) <= 1 &&
				!hasVisibleAssistantContent(message) &&
				this.#emptyRetries < MAX_EMPTY_COMPLETION_RETRIES
			);
		}
		// A turn that never reached its first event is the other way a turn
		// delivers nothing, and the one a provider without its own ladder
		// used to surface unretried.
		const failure = terminal.error;
		return (
			!this.#providerRetriesStalls &&
			failure.stopReason !== "aborted" &&
			this.#options?.signal?.aborted !== true &&
			isPreResponseStallMessage(failure.errorMessage ?? "") &&
			this.#stallRetries < PRE_RESPONSE_STALL_ATTEMPTS - 1 &&
			!this.#stallBudget.spent()
		);
	}

	/**
	 * Waits out the pause before the next attempt and books the discarded one. False when the wait failed,
	 * which settles the turn.
	 */
	async #backOff(terminal: TerminalEvent, held: AssistantMessageEvent[]): Promise<boolean> {
		const stalled = terminal.type === "error";
		// A stalled attempt already spent the whole first-event deadline;
		// the backoff that paces an empty completion adds nothing to it.
		const delayMs = stalled
			? 0
			: exponentialBackoffDelay(this.#emptyRetries, { baseMs: EMPTY_COMPLETION_BASE_DELAY_MS, jitter: 0 });
		const signal = this.#options?.signal;
		try {
			signal?.throwIfAborted();
			const wait = this.#options?.providerRetryWait;
			if (wait) await wait(delayMs, signal);
			else await scheduler.wait(delayMs, { signal });
			signal?.throwIfAborted();
		} catch (waitError) {
			// Backoff is part of the operation: cancellation must reject it,
			// never turn the stale empty attempt into a successful result.
			release(this.#outer, held);
			this.#outer.fail(signal?.aborted ? signal.reason : waitError);
			return false;
		}
		// The held `start` from this discarded attempt is dropped, but the
		// prompt it billed is not: keep its usage for the delivered message.
		// A stall bills nothing, so it usually carries none.
		const discarded = stalled ? terminal.error : terminal.message;
		if (discarded.usage) this.#discardedUsages.push(discarded.usage);
		if (stalled) this.#stallRetries++;
		else this.#emptyRetries++;
		return true;
	}

	/** Hands the caller the attempt that ends the turn, carrying every discarded attempt's spend onto it. */
	async #deliver({ inner, held, terminal }: AttemptRead): Promise<void> {
		release(this.#outer, held);
		if (terminal) {
			this.#carrySpend(terminal.type === "done" ? terminal.message : terminal.error);
			this.#outer.push(terminal);
		} else if (!this.#outer.done) {
			this.#outer.end(this.#carrySpend(await inner.result()));
		}
	}

	#carrySpend(delivered: AssistantMessage): AssistantMessage {
		for (const spent of this.#discardedUsages) discardAttemptUsage(this.#model, spent, delivered.usage);
		return delivered;
	}
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
 *
 * Anything the retries throw, an `attempt` that throws before returning its
 * stream included, fails the returned stream instead of leaving it open.
 */
export function withEmptyCompletionRetry<TApi extends Api, O extends EmptyCompletionRetryOptions>(
	model: Model<TApi>,
	context: Context,
	options: O | undefined,
	attempt: (model: Model<TApi>, context: Context, options?: O) => AssistantMessageEventStream,
	policy?: TurnRetryPolicy,
): AssistantMessageEventStream {
	const outer = new AssistantMessageEventStream();
	const retries = new TurnRetries(outer, model, options, () => attempt(model, context, options), policy);
	void retries.run().catch(error => outer.fail(error));
	return outer;
}
