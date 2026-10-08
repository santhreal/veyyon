/**
 * WHY: `withEmptyCompletionRetry` runs its retries detached from the caller. A step that threw there, the
 * attempt factory before it returned a stream or a read of the attempt's final message, rejected a promise
 * nothing awaited, and the caller's stream stayed open: the turn hung with no error.
 *
 * Closes: every retry step that runs outside an attempt's own stream ends the caller's stream, its events
 * and its result both, with the error that step threw. Each row drives the real wrapper; a row that hangs
 * fails on the test timeout.
 *
 * Gap: the rows are the steps that exist today. A new step that catches its own error and then leaves the
 * caller's stream open is not caught here.
 */
import { describe, expect, it } from "bun:test";
import type { AssistantMessage, AssistantMessageEvent, Context, Model } from "@veyyon/ai/types";
import { withEmptyCompletionRetry } from "@veyyon/ai/utils/empty-completion-retry";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
import { buildModel } from "@veyyon/catalog/build";

const CTX = {} as Context;
const MODEL: Model<"openai-completions"> = buildModel({
	id: "test-model",
	name: "Test Model",
	api: "openai-completions",
	provider: "test",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	contextWindow: 200_000,
	maxTokens: 8_192,
});

function assistant(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-completions",
		provider: "test",
		model: "test-model",
		timestamp: 1,
		stopReason: "stop",
		usage: {
			input: 10,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 10,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

function attemptEndingWith(message: AssistantMessage): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	stream.push({ type: "start", partial: message } as AssistantMessageEvent);
	stream.push({ type: "done", reason: "stop", message });
	return stream;
}

/** An empty completion: the wrapper discards it and issues the request again. */
function emptyAttempt(): AssistantMessageEventStream {
	return attemptEndingWith(assistant());
}

interface Row {
	step: string;
	attempt: (failure: Error, attemptNumber: number) => AssistantMessageEventStream;
	providerRetryWait?: (failure: Error) => (delayMs: number) => Promise<void>;
	/** The stream rejects with this message instead of the row's own `failure`. */
	rejectsWith?: string;
}

const ROWS: Row[] = [
	{
		step: "the first attempt throws before returning its stream",
		attempt: failure => {
			throw failure;
		},
	},
	{
		step: "a retried attempt throws before returning its stream",
		attempt: (failure, attemptNumber) => {
			if (attemptNumber === 1) return emptyAttempt();
			throw failure;
		},
	},
	{
		step: "reading the attempt's final message throws",
		attempt: failure => {
			const message = assistant();
			Object.defineProperty(message, "usage", {
				get() {
					throw failure;
				},
			});
			return attemptEndingWith(message);
		},
	},
	{
		step: "the attempt's stream ends with no terminal event and no result",
		attempt: () => {
			const stream = new AssistantMessageEventStream();
			stream.push({ type: "start", partial: assistant() } as AssistantMessageEvent);
			stream.end();
			return stream;
		},
		rejectsWith: "Stream ended without a final result",
	},
	{
		step: "the wait before a retry throws without returning a promise",
		attempt: () => emptyAttempt(),
		providerRetryWait: failure => () => {
			throw failure;
		},
	},
];

describe("a retried turn ends with the error any retry step throws", () => {
	for (const row of ROWS) {
		it(`ends the caller's stream when ${row.step}`, async () => {
			const failure = new Error(row.step);
			let attempts = 0;
			const stream = withEmptyCompletionRetry(
				MODEL,
				CTX,
				{ providerRetryWait: row.providerRetryWait?.(failure) ?? (async () => {}) },
				() => row.attempt(failure, ++attempts),
			);

			const read = (async () => {
				for await (const _ of stream);
			})();
			for (const settling of [read, stream.result()]) {
				if (row.rejectsWith === undefined) await expect(settling).rejects.toBe(failure);
				else await expect(settling).rejects.toThrow(row.rejectsWith);
			}
		});
	}
});
