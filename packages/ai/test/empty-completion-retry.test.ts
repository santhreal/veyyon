/**
 * Behavioral contracts for the canonical empty-completion retry policy:
 * successful retries discard stale attempts, exhaustion returns the final empty
 * completion, and cancellation during backoff rejects instead of resolving it.
 */
import { describe, expect, it } from "bun:test";
import type { AssistantMessage, AssistantMessageEvent, Context, Model, Usage } from "@veyyon/ai/types";
import { MAX_EMPTY_COMPLETION_RETRIES, withEmptyCompletionRetry } from "@veyyon/ai/utils/empty-completion-retry";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
import { buildModel } from "@veyyon/catalog/build";

const CTX = {} as Context;

/** Priced so a discarded attempt's spend is visible in dollars, not just tokens. */
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

function usage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function assistant(texts: string[] = []): AssistantMessage {
	return {
		role: "assistant",
		content: texts.map(text => ({ type: "text" as const, text })),
		api: "openai-completions",
		provider: "test",
		model: "test-model",
		timestamp: 1,
		stopReason: "stop",
		usage: usage(),
	};
}

function streamFromEvents(events: AssistantMessageEvent[]): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	for (const event of events) stream.push(event);
	return stream;
}

/** start + stop with no content/usage — the flaky-gateway empty completion. */
function emptyAttempt(): AssistantMessageEventStream {
	const message = assistant();
	return streamFromEvents([
		{ type: "start", partial: message },
		{ type: "done", reason: "stop", message },
	] as unknown as AssistantMessageEvent[]);
}

/** start + stop with no visible content and a single EOS output token. */
function eosOnlyAttempt(): AssistantMessageEventStream {
	const message = assistant();
	message.usage.output = 1;
	message.usage.totalTokens = 1;
	return streamFromEvents([
		{ type: "start", partial: message },
		{ type: "done", reason: "stop", message },
	] as unknown as AssistantMessageEvent[]);
}

function contentAttempt(): AssistantMessageEventStream {
	const message = assistant(["hello"]);
	return streamFromEvents([
		{ type: "start", partial: message },
		{ type: "text_start", contentIndex: 0, partial: message },
		{ type: "text_delta", contentIndex: 0, delta: "hello", partial: message },
		{ type: "text_end", contentIndex: 0, content: "hello", partial: message },
		{ type: "done", reason: "stop", message },
	] as unknown as AssistantMessageEvent[]);
}

async function drain(stream: AssistantMessageEventStream): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

/** Reads `stream` to its end or failure: the events it delivered, and what it failed with. */
async function readToFailure(
	stream: AssistantMessageEventStream,
): Promise<{ events: AssistantMessageEvent[]; error: unknown }> {
	const events: AssistantMessageEvent[] = [];
	try {
		for await (const event of stream) events.push(event);
	} catch (error) {
		return { events, error };
	}
	return { events, error: undefined };
}

/** An attempt whose only events are `start` and a `done` carrying `message`. */
function attemptEndingWith(message: AssistantMessage): AssistantMessageEventStream {
	return streamFromEvents([
		{ type: "start", partial: message },
		{ type: "done", reason: message.stopReason, message },
	] as unknown as AssistantMessageEvent[]);
}

/**
 * Stops that are not an empty completion, each differing from one in a single field. The wrapper
 * delivers each from the first attempt.
 */
const DELIVERED_STOPS: Array<{ name: string; message: () => AssistantMessage }> = [
	{
		name: "an invisible stop that generated two output tokens",
		message: () => {
			const message = assistant();
			message.usage.output = 2;
			return message;
		},
	},
	{ name: "a stop whose final message holds text it never streamed", message: () => assistant(["unstreamed"]) },
	{
		name: "a stop whose final message holds a tool call it never streamed",
		message: () => ({ ...assistant(), content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }] }),
	},
	{
		name: "a stop that reports an error message",
		message: () => ({ ...assistant(), errorMessage: "gateway hiccup" }),
	},
	{ name: "a length stop with no content", message: () => ({ ...assistant(), stopReason: "length" }) },
];

describe("withEmptyCompletionRetry", () => {
	/** Empty successes are retried until a later attempt produces visible content. */
	it("retries past empty attempts and delivers the first non-empty one", async () => {
		let attempts = 0;
		const waits: number[] = [];
		const stream = withEmptyCompletionRetry(
			MODEL,
			CTX,
			{ providerRetryWait: async ms => void waits.push(ms) },
			() => {
				attempts++;
				return attempts <= MAX_EMPTY_COMPLETION_RETRIES ? emptyAttempt() : contentAttempt();
			},
		);

		const events = await drain(stream);
		const result = await stream.result();

		expect(attempts).toBe(MAX_EMPTY_COMPLETION_RETRIES + 1);
		// Two retries is the budget a user waits through for an empty completion before the turn gives
		// up, and the pause doubles from the base before each.
		expect(waits).toEqual([500, 1_000]);
		// Discarded attempts' `start` events must not leak — exactly one survives.
		expect(events.filter(e => e.type === "start")).toHaveLength(1);
		expect(events.some(e => e.type === "text_delta")).toBe(true);
		expect(events.at(-1)?.type).toBe("done");
		expect(result.content).toEqual([{ type: "text", text: "hello" }]);
	});

	it("retries an EOS-only empty stop that reports one output token", async () => {
		let attempts = 0;
		const waits: number[] = [];
		const stream = withEmptyCompletionRetry(
			MODEL,
			CTX,
			{ providerRetryWait: async ms => void waits.push(ms) },
			() => {
				attempts++;
				return attempts === 1 ? eosOnlyAttempt() : contentAttempt();
			},
		);

		const events = await drain(stream);
		const result = await stream.result();

		expect(attempts).toBe(2);
		expect(waits).toEqual([500]);
		expect(events.filter(e => e.type === "start")).toHaveLength(1);
		expect(result.content).toEqual([{ type: "text", text: "hello" }]);
	});

	/** The bounded policy returns the final empty completion after exhausting retries. */
	it("delivers the empty result after exhausting the retry cap", async () => {
		let attempts = 0;
		const waits: number[] = [];
		const stream = withEmptyCompletionRetry(
			MODEL,
			CTX,
			{ providerRetryWait: async ms => void waits.push(ms) },
			() => {
				attempts++;
				return emptyAttempt();
			},
		);

		const events = await drain(stream);
		const result = await stream.result();

		expect(attempts).toBe(MAX_EMPTY_COMPLETION_RETRIES + 1);
		expect(waits).toHaveLength(2);
		expect(events.filter(e => e.type === "start")).toHaveLength(1);
		expect(events.at(-1)?.type).toBe("done");
		expect(result.content).toEqual([]);
	});

	it("does not retry when the first attempt streams content", async () => {
		let attempts = 0;
		let waited = false;
		const stream = withEmptyCompletionRetry(
			MODEL,
			CTX,
			{
				providerRetryWait: async () => {
					waited = true;
				},
			},
			() => {
				attempts++;
				return contentAttempt();
			},
		);

		await drain(stream);

		expect(attempts).toBe(1);
		expect(waited).toBe(false);
	});

	/** Provider error terminals pass through without retrying or entering backoff. */
	it("preserves non-retryable provider errors", async () => {
		let attempts = 0;
		let waited = false;
		const errorMessage = assistant();
		errorMessage.stopReason = "error";
		errorMessage.errorMessage = "provider rejected the request";
		const stream = withEmptyCompletionRetry(
			MODEL,
			CTX,
			{
				providerRetryWait: async () => {
					waited = true;
				},
			},
			() => {
				attempts++;
				return streamFromEvents([
					{ type: "start", partial: errorMessage },
					{ type: "error", reason: "error", error: errorMessage },
				] as unknown as AssistantMessageEvent[]);
			},
		);

		const result = await stream.result();

		expect(attempts).toBe(1);
		expect(waited).toBe(false);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("provider rejected the request");
	});

	it("commits on streamed thinking and does not retry a thinking-only stop", async () => {
		let attempts = 0;
		const stream = withEmptyCompletionRetry(MODEL, CTX, {}, () => {
			attempts++;
			const message = assistant(); // no visible content; only thinking streams
			return streamFromEvents([
				{ type: "start", partial: message },
				{ type: "thinking_delta", contentIndex: 0, delta: "pondering", partial: message },
				{ type: "done", reason: "stop", message },
			] as unknown as AssistantMessageEvent[]);
		});

		const events = await drain(stream);

		expect(attempts).toBe(1);
		expect(events.some(e => e.type === "thinking_delta")).toBe(true);
	});

	it("propagates a non-abort backoff failure after the events the discarded attempt held", async () => {
		const stream = withEmptyCompletionRetry(
			MODEL,
			CTX,
			{
				providerRetryWait: async () => {
					throw new Error("wait boom");
				},
			},
			() => emptyAttempt(),
		);

		const { events, error } = await readToFailure(stream);
		expect(events.map(event => event.type)).toEqual(["start"]);
		expect((error as Error | undefined)?.message).toBe("wait boom");
	});

	/** Cancellation while a retry is sleeping rejects with the caller's abort reason. */
	it("rejects instead of delivering the stale empty result when aborted during backoff", async () => {
		const controller = new AbortController();
		const backoffStarted = Promise.withResolvers<void>();
		let attempts = 0;
		const stream = withEmptyCompletionRetry(
			MODEL,
			CTX,
			{
				signal: controller.signal,
				providerRetryWait: async (_delayMs, signal) => {
					backoffStarted.resolve();
					await new Promise<void>((_resolve, reject) => {
						signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
					});
				},
			},
			() => {
				attempts++;
				return emptyAttempt();
			},
		);
		const result = stream.result();
		await backoffStarted.promise;
		const abortReason = new Error("cancelled during retry backoff");
		controller.abort(abortReason);

		await expect(result).rejects.toBe(abortReason);
		expect(attempts).toBe(1);
	});

	it("discards buffered pre-content markers from a retried empty attempt", async () => {
		let attempts = 0;
		const stream = withEmptyCompletionRetry(MODEL, CTX, { providerRetryWait: async () => {} }, () => {
			attempts++;
			if (attempts === 1) {
				const message = assistant();
				return streamFromEvents([
					{ type: "start", partial: message },
					{ type: "thinking_start", contentIndex: 0, partial: message },
					{ type: "done", reason: "stop", message },
				] as unknown as AssistantMessageEvent[]);
			}
			return contentAttempt();
		});

		const events = await drain(stream);

		expect(attempts).toBe(2);
		// The empty attempt's start + thinking_start were discarded; only the
		// successful attempt's events reach the consumer.
		expect(events.filter(e => e.type === "start")).toHaveLength(1);
		expect(events.some(e => e.type === "thinking_start")).toBe(false);
		expect(events.some(e => e.type === "text_delta")).toBe(true);
	});

	it("delivers the retry when the discarded attempt reports no usage", async () => {
		let attempts = 0;
		const stream = withEmptyCompletionRetry(MODEL, CTX, { providerRetryWait: async () => {} }, () => {
			attempts++;
			if (attempts > 1) return contentAttempt();
			const message: Partial<AssistantMessage> = assistant();
			delete message.usage;
			return streamFromEvents([
				{ type: "start", partial: message },
				{ type: "done", reason: "stop", message },
			] as unknown as AssistantMessageEvent[]);
		});

		const result = await stream.result();

		expect(attempts).toBe(2);
		expect(result.content).toEqual([{ type: "text", text: "hello" }]);
		expect(result.usage.discarded).toBeUndefined();
	});

	it("streams content as it arrives without waiting for the terminal event", async () => {
		let waited = false;
		const message = assistant(["streamed"]);
		const inner = new AssistantMessageEventStream();
		const stream = withEmptyCompletionRetry(
			MODEL,
			CTX,
			{
				providerRetryWait: async () => {
					waited = true;
				},
			},
			() => inner,
		);

		const iterator = stream[Symbol.asyncIterator]();
		// Push content with no terminal yet: the buffered start then the delta must
		// surface before any `done` exists, proving the wrapper does not buffer
		// meaningful content until completion.
		inner.push({ type: "start", partial: message } as unknown as AssistantMessageEvent);
		inner.push({
			type: "text_delta",
			contentIndex: 0,
			delta: "streamed",
			partial: message,
		} as unknown as AssistantMessageEvent);

		expect((await iterator.next()).value?.type).toBe("start");
		expect((await iterator.next()).value?.type).toBe("text_delta");

		inner.push({ type: "done", reason: "stop", message } as unknown as AssistantMessageEvent);
		expect((await iterator.next()).value?.type).toBe("done");
		expect(waited).toBe(false);
	});

	it("stops reading the attempt once the caller's stream is closed", async () => {
		const message = assistant(["streamed"]);
		const inner = new AssistantMessageEventStream();
		const released = Promise.withResolvers<void>();
		const read = inner[Symbol.asyncIterator].bind(inner);
		inner[Symbol.asyncIterator] = () => {
			const iterator = read();
			const leave = iterator.return!.bind(iterator);
			iterator.return = value => {
				released.resolve();
				return leave(value);
			};
			return iterator;
		};
		const stream = withEmptyCompletionRetry(MODEL, CTX, {}, () => inner);
		const iterator = stream[Symbol.asyncIterator]();
		const delta = (text: string) =>
			({ type: "text_delta", contentIndex: 0, delta: text, partial: message }) as unknown as AssistantMessageEvent;

		inner.push({ type: "start", partial: message } as unknown as AssistantMessageEvent);
		inner.push(delta("a"));
		expect((await iterator.next()).value?.type).toBe("start");
		expect((await iterator.next()).value?.type).toBe("text_delta");
		stream.fail(new Error("caller left"));
		inner.push(delta("b"));

		// The attempt's next event finds the caller gone and the wrapper lets go of the attempt; reading on
		// would leave this wait open until the attempt ends, and it never does here.
		await released.promise;
		inner.push(delta("c"));
		expect(inner.queue.map(event => (event.type === "text_delta" ? event.delta : event.type))).toEqual(["c"]);
	});

	for (const row of DELIVERED_STOPS) {
		it(`delivers ${row.name} without asking again`, async () => {
			let attempts = 0;
			const stream = withEmptyCompletionRetry(MODEL, CTX, { providerRetryWait: async () => {} }, () => {
				attempts++;
				return attemptEndingWith(row.message());
			});

			const result = await stream.result();

			expect(attempts).toBe(1);
			expect(result).toEqual(row.message());
		});
	}

	it("rejects with the abort reason without waiting when the turn was cancelled during the attempt", async () => {
		const controller = new AbortController();
		const reason = new Error("cancelled mid-attempt");
		let waited = false;
		let attempts = 0;
		const stream = withEmptyCompletionRetry(
			MODEL,
			CTX,
			{
				signal: controller.signal,
				providerRetryWait: async () => {
					waited = true;
				},
			},
			() => {
				attempts++;
				controller.abort(reason);
				return emptyAttempt();
			},
		);

		await expect(stream.result()).rejects.toBe(reason);
		expect(waited).toBe(false);
		expect(attempts).toBe(1);
	});

	it("does not ask again when the turn is cancelled during a wait that ignores the signal", async () => {
		const controller = new AbortController();
		const reason = new Error("cancelled during backoff");
		let attempts = 0;
		const stream = withEmptyCompletionRetry(
			MODEL,
			CTX,
			{
				signal: controller.signal,
				providerRetryWait: async () => {
					controller.abort(reason);
				},
			},
			() => {
				attempts++;
				return emptyAttempt();
			},
		);

		await expect(stream.result()).rejects.toBe(reason);
		expect(attempts).toBe(1);
	});

	it("reports the caller's abort reason rather than the error its cancelled wait threw", async () => {
		const controller = new AbortController();
		const reason = new Error("caller cancelled");
		const stream = withEmptyCompletionRetry(
			MODEL,
			CTX,
			{
				signal: controller.signal,
				providerRetryWait: async () => {
					controller.abort(reason);
					throw new DOMException("The operation was aborted", "AbortError");
				},
			},
			() => emptyAttempt(),
		);

		await expect(stream.result()).rejects.toBe(reason);
	});

	it("delivers the events an attempt held before its stream failed, then the failure", async () => {
		const failure = new Error("socket reset");
		const inner = streamFromEvents([{ type: "start", partial: assistant() }] as unknown as AssistantMessageEvent[]);
		inner.fail(failure);
		const stream = withEmptyCompletionRetry(MODEL, CTX, {}, () => inner);

		const { events, error } = await readToFailure(stream);

		expect(events.map(event => event.type)).toEqual(["start"]);
		expect(error).toBe(failure);
	});
});
