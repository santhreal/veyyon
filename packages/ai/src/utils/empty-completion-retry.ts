import { scheduler } from "node:timers/promises";
import { discardAttemptUsage } from "@veyyon/catalog/models";
import type { Api, AssistantMessage, AssistantMessageEvent, Context, Model } from "../types";
import { AssistantMessageEventStream } from "./event-stream";
import { isPreResponseStallMessage, openStallLadderBudget, PRE_RESPONSE_STALL_ATTEMPTS } from "./first-event-budget";

export const MAX_EMPTY_COMPLETION_RETRIES = 2;
export const EMPTY_COMPLETION_BASE_DELAY_MS = 500;

export const EMPTY_OLLAMA_LENGTH_COMPLETION_MESSAGE =
	"Model returned no content: prompt filled the context window; raise Ollama num_ctx or shorten the prompt.";

const NON_WHITESPACE_RE = /\S/;

export function hasVisibleAssistantContent(message: AssistantMessage): boolean {
	for (const block of message.content) {
		if (block.type === "toolCall") return true;
		if (block.type === "text" && NON_WHITESPACE_RE.test(block.text)) return true;
	}
	return false;
}

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
	streamFirstEventTimeoutMs?: number;
}

export interface TurnRetryPolicy {
	providerRetriesStalls?: boolean;
}

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

			const message = terminal?.type === "done" ? terminal.message : undefined;
			const isRetryableEmpty =
				!committed &&
				message !== undefined &&
				message.stopReason === "stop" &&
				!message.errorMessage &&
				(message.usage?.output ?? 0) <= 1 &&
				!hasVisibleAssistantContent(message) &&
				emptyAttempt < MAX_EMPTY_COMPLETION_RETRIES;

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
				const delayMs = isRetryableStall ? 0 : EMPTY_COMPLETION_BASE_DELAY_MS * 2 ** emptyAttempt;
				try {
					signal?.throwIfAborted();
					if (options?.providerRetryWait) await options.providerRetryWait(delayMs, signal);
					else await scheduler.wait(delayMs, { signal });
					signal?.throwIfAborted();
				} catch (waitError) {
					flush();
					outer.fail(signal?.aborted ? signal.reason : waitError);
					return;
				}
				const discardedUsage = isRetryableStall ? failure?.usage : message?.usage;
				if (discardedUsage) discardedUsages.push(discardedUsage);
				if (isRetryableStall) stallAttempt++;
				else emptyAttempt++;
				continue;
			}

			flush();
			if (terminal) {
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
