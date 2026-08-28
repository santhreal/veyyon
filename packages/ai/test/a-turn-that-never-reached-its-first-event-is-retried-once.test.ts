/**
 * WHY. A turn whose provider accepted the connection and then said nothing used
 * to end the turn outright on every provider that does not run its own retry
 * loop. Anthropic and Codex were given a bounded stall ladder when the opposite
 * defect was fixed there (a stall re-spending the declared budget on all ten
 * provider retries); the providers that never retried a stall at all were not
 * given one, so a single silent connect surfaced
 * "OpenAI completions stream timed out while waiting for the first event" and
 * burned the turn. Goal mode then counted those as failed turns and stopped
 * driving after a handful of them.
 *
 * THE CLASS THIS CLOSES. Not "openai-completions must retry a stall", but "no
 * provider surfaces a first-event stall to its caller on the first occurrence,
 * and none retries one without bound". The invariant is asserted at the shared
 * choke point every wrapped provider passes through
 * (`withEmptyCompletionRetry`), and once end to end through the real
 * openai-completions transport.
 *
 * WHAT THIS DOES NOT CATCH. Providers that do not route through the shared
 * wrapper at all — bedrock-converse-stream, google-gemini-cli and
 * pi-native-client — are enumerated below and asserted to be a closed set, so
 * adding a provider to that set is a decision someone has to record here, but
 * their stall behavior is not exercised. Anthropic and Codex own their ladders
 * internally and are covered by their own suites; this suite only pins that
 * they declare that ownership, so the two ladders cannot multiply.
 */
import { describe, expect, it } from "bun:test";
import * as ai from "@veyyon/ai";
import { streamOpenAICompletions } from "@veyyon/ai/providers/openai-completions";
import type { AssistantMessage, AssistantMessageEvent, Context, FetchImpl, Model, Usage } from "@veyyon/ai/types";
import { withEmptyCompletionRetry } from "@veyyon/ai/utils/empty-completion-retry";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
import { PRE_RESPONSE_STALL_ATTEMPTS } from "@veyyon/ai/utils/first-event-budget";
import { buildModel } from "@veyyon/catalog/build";

/**
 * The ladder's budget is this deadline times the attempt allowance, and the
 * first attempt spends its own deadline plus whatever the transport costs to
 * abort and report. At 60ms a loaded runner spent the whole multiple on
 * attempt one and the retry this suite exists to prove was correctly refused,
 * so the case measured the host rather than the ladder. A second is far above
 * that overhead and still an order of magnitude under the case timeout; the
 * opposite branch — an attempt that outlives the multiple — is pinned
 * deterministically at the bottom of this file with a 5ms deadline.
 */
const STALL_DEADLINE_MS = 1_000;

const MODEL: Model<"openai-completions"> = buildModel({
	id: "test-model",
	name: "Test Model",
	api: "openai-completions",
	provider: "test",
	baseUrl: "https://example.invalid/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	contextWindow: 200_000,
	maxTokens: 8_192,
});

const CONTEXT = { messages: [{ role: "user", content: "hi" }] } as unknown as Context;

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

function assistant(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-completions",
		provider: "test",
		model: "test-model",
		timestamp: 1,
		stopReason: "stop",
		usage: usage(),
		...overrides,
	} as AssistantMessage;
}

function streamFromEvents(events: AssistantMessageEvent[]): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	for (const event of events) stream.push(event);
	return stream;
}

/** An attempt that reached no first event and reported the watchdog's message. */
function stalledAttempt(message = "stream timed out while waiting for the first event"): AssistantMessageEventStream {
	const failure = assistant({ stopReason: "error", errorMessage: message });
	return streamFromEvents([
		{ type: "start", partial: failure },
		{ type: "error", reason: "error", error: failure },
	] as unknown as AssistantMessageEvent[]);
}

/** A stall that takes `delayMs` to fail, so it consumes real budget. */
function stalledAfter(delayMs: number): AssistantMessageEventStream {
	const failure = assistant({
		stopReason: "error",
		errorMessage: "stream timed out while waiting for the first event",
	});
	const stream = new AssistantMessageEventStream();
	stream.push({ type: "start", partial: failure } as unknown as AssistantMessageEvent);
	void (async () => {
		await new Promise(resolve => setTimeout(resolve, delayMs));
		stream.push({ type: "error", reason: "error", error: failure } as unknown as AssistantMessageEvent);
	})();
	return stream;
}

/** An attempt that streamed real text before failing — replaying it would duplicate. */
function committedThenStalled(): AssistantMessageEventStream {
	const partial = assistant({ content: [{ type: "text", text: "hello" }] });
	const failure = assistant({
		stopReason: "error",
		errorMessage: "stream timed out while waiting for the first event",
		content: [{ type: "text", text: "hello" }],
	});
	return streamFromEvents([
		{ type: "start", partial },
		{ type: "text_start", contentIndex: 0, partial },
		{ type: "text_delta", contentIndex: 0, delta: "hello", partial },
		{ type: "error", reason: "error", error: failure },
	] as unknown as AssistantMessageEvent[]);
}

function contentAttempt(): AssistantMessageEventStream {
	const message = assistant({ content: [{ type: "text", text: "recovered" }] });
	return streamFromEvents([
		{ type: "start", partial: message },
		{ type: "text_start", contentIndex: 0, partial: message },
		{ type: "text_delta", contentIndex: 0, delta: "recovered", partial: message },
		{ type: "text_end", contentIndex: 0, content: "recovered", partial: message },
		{ type: "done", reason: "stop", message },
	] as unknown as AssistantMessageEvent[]);
}

async function drain(stream: AssistantMessageEventStream): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

/** A transport that accepts the call and never answers until it is aborted. */
function neverAnswering(calls: { count: number }): FetchImpl {
	return ((_url: unknown, init?: { signal?: AbortSignal }) => {
		calls.count++;
		const { promise, reject } = Promise.withResolvers<Response>();
		const signal = init?.signal;
		if (signal?.aborted) reject(signal.reason);
		else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
		return promise;
	}) as unknown as FetchImpl;
}

describe("a turn that never reached its first event", () => {
	it("re-issues the request once through the real openai-completions transport", async () => {
		const calls = { count: 0 };
		const result = await streamOpenAICompletions(MODEL, CONTEXT, {
			apiKey: "test-key",
			fetch: neverAnswering(calls),
			streamFirstEventTimeoutMs: STALL_DEADLINE_MS,
		}).result();

		// One stall is retried; the second ends the phase. Without the ladder the
		// first stall was the whole turn, which is the reported defect.
		expect(calls.count).toBe(PRE_RESPONSE_STALL_ATTEMPTS);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage ?? "").toMatch(/timed out/i);
	}, 15_000);

	it("delivers a later attempt that answers, so one silent connect does not end the turn", async () => {
		let attempts = 0;
		const events = await drain(
			withEmptyCompletionRetry(MODEL, CONTEXT, { providerRetryWait: async () => {} }, () => {
				attempts++;
				return attempts === 1 ? stalledAttempt() : contentAttempt();
			}),
		);

		expect(attempts).toBe(2);
		expect(events.at(-1)?.type).toBe("done");
		// The discarded attempt's `start` must not leak a second envelope.
		expect(events.filter(e => e.type === "start")).toHaveLength(1);
	});

	it("stops at the stall allowance instead of retrying a dead endpoint forever", async () => {
		let attempts = 0;
		const events = await drain(
			withEmptyCompletionRetry(MODEL, CONTEXT, { providerRetryWait: async () => {} }, () => {
				attempts++;
				return stalledAttempt();
			}),
		);

		expect(attempts).toBe(PRE_RESPONSE_STALL_ATTEMPTS);
		expect(events.at(-1)?.type).toBe("error");
	});

	it("never replays an attempt that already streamed content", async () => {
		let attempts = 0;
		const events = await drain(
			withEmptyCompletionRetry(MODEL, CONTEXT, { providerRetryWait: async () => {} }, () => {
				attempts++;
				return committedThenStalled();
			}),
		);

		expect(attempts).toBe(1);
		expect(events.filter(e => e.type === "text_delta")).toHaveLength(1);
		expect(events.at(-1)?.type).toBe("error");
	});

	it("adds no second ladder for a provider that runs its own", async () => {
		let attempts = 0;
		await drain(
			withEmptyCompletionRetry(
				MODEL,
				CONTEXT,
				{ providerRetryWait: async () => {} },
				() => {
					attempts++;
					return stalledAttempt();
				},
				{ providerRetriesStalls: true },
			),
		);

		expect(attempts).toBe(1);
	});

	it("does not retry a stall the caller cancelled", async () => {
		const controller = new AbortController();
		controller.abort();
		let attempts = 0;
		await drain(
			withEmptyCompletionRetry(MODEL, CONTEXT, { signal: controller.signal }, () => {
				attempts++;
				return stalledAttempt();
			}),
		);

		expect(attempts).toBe(1);
	});

	it("bounds the whole pre-first-event phase by the declared deadline", async () => {
		let attempts = 0;
		// The declared number is one attempt's deadline; the phase is a bounded
		// multiple of it. An attempt that outlives the whole multiple leaves no
		// room for another, so the phase ends rather than paying for a third.
		await drain(
			withEmptyCompletionRetry(
				MODEL,
				CONTEXT,
				{ streamFirstEventTimeoutMs: 5, providerRetryWait: async () => {} },
				() => {
					attempts++;
					return stalledAfter(40);
				},
			),
		);

		expect(attempts).toBe(1);
	});
});

describe("every streaming provider is classified for stall retry", () => {
	/**
	 * Derived from the package's own exports at run time, not from a hardcoded
	 * list: a new `stream*` provider export lands in `discovered` and turns this
	 * red until someone records which side of the ladder it is on.
	 */
	const OWNS_ITS_OWN_LADDER = ["streamAnthropic", "streamOpenAICodexResponses"] as const;
	const LADDERED_BY_THE_SHARED_WRAPPER = [
		"streamAzureOpenAIResponses",
		"streamOllama",
		"streamOpenAICompletions",
		"streamOpenAIResponses",
	] as const;
	/** Not wrapped at all — their stall behavior is a known, recorded gap. */
	const NOT_WRAPPED = [
		"streamGitLabDuo",
		"streamGitLabDuoWorkflow",
		"streamKimi",
		"streamMock",
		"streamSynthetic",
	] as const;
	/** Dispatchers and helpers, not a provider transport of their own. */
	const NOT_A_PROVIDER_TRANSPORT = ["stream", "streamSimple"] as const;
	it("leaves no exported provider stream unclassified", () => {
		const discovered = Object.keys(ai)
			.filter(name => name.startsWith("stream") && typeof (ai as Record<string, unknown>)[name] === "function")
			.sort();
		const classified = [
			...OWNS_ITS_OWN_LADDER,
			...LADDERED_BY_THE_SHARED_WRAPPER,
			...NOT_WRAPPED,
			...NOT_A_PROVIDER_TRANSPORT,
		].sort();

		expect(discovered).toEqual(classified);
	});
});
