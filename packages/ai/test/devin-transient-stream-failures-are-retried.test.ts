/**
 * A Devin turn that fails before it says anything is retried instead of lost.
 *
 * THE BUG THIS SUITE LOCKS OUT, measured rather than imagined. Cascade reports stream-level failures
 * in the Connect end-stream trailer as a structured `{code, message}`. `readConnectTrailerError`
 * flattened that into one string and the caller wrapped it in `AIError.ValidationError` — the one
 * error class that must never be retried, because it means the request itself was wrong. So every
 * server-side failure, transient or not, ended the turn immediately. Across the recorded sessions on
 * this machine that was 564 of 2690 Devin turns (21%) failed, and 561 of them carried one message:
 *
 *   permission_denied: Reached overall message rate limit. Please try again later.
 *   Your limit will reset in 1 minute.
 *
 * Three things make that the worst possible case to treat as permanent. The server states how long
 * to wait. The code it chose (`permission_denied`) describes an authorization failure it is not. And
 * 563 of the 564 had emitted no token at all, so re-running was safe for nearly every one.
 *
 * WHAT IS ASSERTED. That the classification now depends on the failure (rate limit and server fault
 * retried, `invalid_argument` still permanent), that the wait comes from the server's own sentence
 * rather than a guess, that the retry is abandoned in every case where it would do harm (a token
 * already emitted, an abort, an exhausted budget, a window longer than the cap), and that a retried
 * turn is indistinguishable from a clean one to the consumer — one `start`, one `done`.
 *
 * NO TEST HERE SLEEPS. `providerRetryWait` is the injection seam the provider calls instead of a
 * timer, so every delay is asserted as a number instead of waited out.
 */
import { describe, expect, it } from "bun:test";
import { create, toBinary } from "@bufbuild/protobuf";
import { parseDevinRateLimitResetMs, streamDevin } from "@veyyon/ai/providers/devin";
import type { AssistantMessage, AssistantMessageEvent, Context, Model } from "@veyyon/ai/types";
import { buildModel } from "@veyyon/catalog/build";
import { GetChatMessageResponseSchema } from "@veyyon/catalog/discovery/devin-gen/exa/api_server_pb/api_server_pb";
import { GetUserJwtResponseSchema } from "@veyyon/catalog/discovery/devin-gen/exa/auth_pb/auth_pb";
import { StopReason } from "@veyyon/catalog/discovery/devin-gen/exa/codeium_common_pb/codeium_common_pb";

const devinModel: Model<"devin-agent"> = buildModel({
	id: "devin-test",
	name: "Devin Test",
	api: "devin-agent",
	provider: "devin",
	baseUrl: "https://server.codeium.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1,
	maxTokens: 1,
});

const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };

const CONNECT_END_STREAM_FLAG = 0x02;

/** Frame a Connect message, matching what the server writes for a data frame. */
function dataFrame(payload: Uint8Array): Uint8Array {
	const out = new Uint8Array(5 + payload.length);
	const view = new DataView(out.buffer);
	view.setUint8(0, 0);
	view.setUint32(1, payload.length, false);
	out.set(payload, 5);
	return out;
}

/** A text delta, so a test can put a token on the wire before a failure. */
function textFrame(text: string, stopReason = StopReason.UNSPECIFIED): Uint8Array {
	const msg = create(GetChatMessageResponseSchema, { messageId: "msg-1", stopReason, deltaText: text });
	return dataFrame(toBinary(GetChatMessageResponseSchema, msg));
}

/** The end-stream trailer, which is where Cascade reports a stream-level failure. */
function trailerFrame(body: unknown): Uint8Array {
	const json = new TextEncoder().encode(JSON.stringify(body));
	const out = new Uint8Array(5 + json.length);
	const view = new DataView(out.buffer);
	view.setUint8(0, CONNECT_END_STREAM_FLAG);
	view.setUint32(1, json.length, false);
	out.set(json, 5);
	return out;
}

function errorTrailer(code: string, message: string): Uint8Array {
	return trailerFrame({ error: { code, message } });
}

const RATE_LIMIT_MESSAGE =
	"Reached overall message rate limit. Please try again later. Your limit will reset in 1 minute. (trace ID: abc123)";

/**
 * A fetch whose Cascade responses are scripted per attempt.
 *
 * Each entry is one attempt's frames, so a test states "fail, then succeed" as data. `attempts`
 * counts the chat requests only, which is the number the retry budget is about.
 */
function scriptedFetch(perAttempt: readonly (readonly Uint8Array[])[]): {
	fetchImpl: typeof fetch;
	attempts: () => number;
} {
	const authPayload = toBinary(GetUserJwtResponseSchema, create(GetUserJwtResponseSchema, { userJwt: "jwt" }));
	let attempt = 0;
	const fetchImpl = (async (input: string | URL | Request) => {
		if (String(input).includes("GetUserJwt")) return new Response(authPayload);
		const frames = perAttempt[Math.min(attempt, perAttempt.length - 1)] ?? [];
		attempt += 1;
		let index = 0;
		return new Response(
			new ReadableStream<Uint8Array>({
				pull(controller) {
					const frame = frames[index++];
					if (frame) controller.enqueue(frame);
					else controller.close();
				},
			}),
			{ status: 200 },
		);
	}) as typeof fetch;
	return { fetchImpl, attempts: () => attempt };
}

/** Run a stream to completion, collecting the events a consumer would see. */
async function collect(
	fetchImpl: typeof fetch,
	options: { signal?: AbortSignal } = {},
): Promise<{ events: AssistantMessageEvent[]; waits: number[]; result: AssistantMessage }> {
	const waits: number[] = [];
	const stream = streamDevin(devinModel, context, {
		apiKey: "token",
		fetch: fetchImpl,
		signal: options.signal,
		providerRetryWait: async (delayMs: number) => {
			waits.push(delayMs);
		},
	});
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return { events, waits, result: await stream.result() };
}

describe("parseDevinRateLimitResetMs", () => {
	/**
	 * The server's sentence is the only machine-usable retry hint on a Connect trailer.
	 *
	 * There is no `retry-after` header to read, so this parse is what decides both how long to wait
	 * and, for a long window, whether to wait at all. Each unit is covered because a scale error here
	 * turns a one-minute pause into an hour or a retry that fires immediately and fails again.
	 */
	it("reads the stated window in every unit the server uses", () => {
		expect(parseDevinRateLimitResetMs("Your limit will reset in 1 minute.")).toBe(60_000);
		expect(parseDevinRateLimitResetMs("Your limit will reset in 40 minutes.")).toBe(2_400_000);
		expect(parseDevinRateLimitResetMs("Your limit will reset in 30 seconds.")).toBe(30_000);
		expect(parseDevinRateLimitResetMs("Your limit will reset in 2 hours.")).toBe(7_200_000);
	});

	/** The real message, whole, because that is the string the parse has to survive. */
	it("reads the window out of the message Cascade actually sends", () => {
		expect(parseDevinRateLimitResetMs(RATE_LIMIT_MESSAGE)).toBe(60_000);
	});

	/** Wording variants that mean the same thing, so a server rephrasing does not silently stop retries. */
	it("accepts the phrasings that carry the same claim", () => {
		expect(parseDevinRateLimitResetMs("limit resets in 15 seconds")).toBe(15_000);
		expect(parseDevinRateLimitResetMs("will reset after 5 minutes")).toBe(300_000);
		expect(parseDevinRateLimitResetMs("will reset in about 2 minutes")).toBe(120_000);
	});

	/**
	 * No window stated means no window invented.
	 *
	 * The caller distinguishes `undefined` from a number: `undefined` falls back to exponential
	 * backoff, so a parse that guessed would override real backoff with a fabricated wait.
	 */
	it("returns undefined when the message states no window", () => {
		expect(parseDevinRateLimitResetMs("Reached overall message rate limit.")).toBeUndefined();
		expect(parseDevinRateLimitResetMs("")).toBeUndefined();
		expect(parseDevinRateLimitResetMs("reset in a moment")).toBeUndefined();
	});
});

describe("streamDevin retries a turn that failed before saying anything", () => {
	/**
	 * THE CENTRAL CASE: the rate limit that was losing 561 turns now costs a wait and succeeds.
	 *
	 * Asserted on the delivered text, not merely on the attempt count, because a retry that fires and
	 * drops the second attempt's output would satisfy a counter and still lose the turn.
	 */
	it("waits the window the server stated and delivers the second attempt", async () => {
		const { fetchImpl, attempts } = scriptedFetch([
			[errorTrailer("permission_denied", RATE_LIMIT_MESSAGE)],
			[textFrame("recovered answer", StopReason.STOP_PATTERN)],
		]);

		const { events, waits, result } = await collect(fetchImpl);

		expect(attempts()).toBe(2);
		// 60s stated, plus the one second of slack that keeps the retry from racing the server clock.
		expect(waits).toEqual([61_000]);
		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "recovered answer" }]);
		expect(events.filter(event => event.type === "error")).toEqual([]);
	});

	/**
	 * A retried turn looks like an ordinary one: exactly one `start` and one `done`.
	 *
	 * The delegation the retry is built on re-enters `streamDevin`, so the second attempt would
	 * naturally announce itself again. A consumer that sees two `start` events for one turn is
	 * watching a protocol violation, and a TUI that renders per `start` would double the message.
	 */
	it("does not announce the stream twice", async () => {
		const { fetchImpl } = scriptedFetch([
			[errorTrailer("unavailable", "backend unavailable")],
			[textFrame("second try", StopReason.STOP_PATTERN)],
		]);

		const { events } = await collect(fetchImpl);

		expect(events.filter(event => event.type === "start")).toHaveLength(1);
		expect(events.filter(event => event.type === "done")).toHaveLength(1);
		expect(events[0]?.type).toBe("start");
	});

	/**
	 * A server fault with no stated window falls back to backoff rather than to nothing.
	 *
	 * `unavailable` is transient by Connect's own semantics and carries no timing, which is the case
	 * the exponential path exists for. Pinning the first delay keeps "retryable" from silently
	 * meaning "retry instantly", which against a struggling backend is a small denial of service.
	 */
	it("backs off exponentially when the failure states no window", async () => {
		const { fetchImpl, attempts } = scriptedFetch([
			[errorTrailer("unavailable", "backend unavailable")],
			[errorTrailer("internal", "internal error")],
			[textFrame("third time", StopReason.STOP_PATTERN)],
		]);

		const { waits, result } = await collect(fetchImpl);

		expect(attempts()).toBe(3);
		expect(waits).toEqual([1_000, 2_000]);
		expect(result.content).toEqual([{ type: "text", text: "third time" }]);
	});
});

describe("streamDevin refuses to retry when a retry would do harm", () => {
	/**
	 * REPLAY SAFETY, and the reason this fix cannot help a drop mid-answer.
	 *
	 * Once a delta has escaped there is no way to un-say it, so a second attempt would duplicate or
	 * contradict text already on the consumer's screen. The failure is surfaced with the partial
	 * content intact instead, which is the honest outcome: the operator sees what arrived and that it
	 * ended in an error.
	 */
	it("surfaces the failure when a token was already emitted", async () => {
		const { fetchImpl, attempts } = scriptedFetch([
			[textFrame("partial thought"), errorTrailer("permission_denied", RATE_LIMIT_MESSAGE)],
			[textFrame("never reached", StopReason.STOP_PATTERN)],
		]);

		const { waits, result } = await collect(fetchImpl);

		expect(attempts()).toBe(1);
		expect(waits).toEqual([]);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Reached overall message rate limit");
		expect(result.content).toEqual([{ type: "text", text: "partial thought" }]);
	});

	/**
	 * A genuinely bad request stays permanent, which is what the old code got right by accident.
	 *
	 * `invalid_argument` means the request was wrong, so every retry is the same request failing the
	 * same way. Without this the fix would trade 561 lost turns for a retry storm on malformed
	 * requests, and the `ValidationError` class the whole path used to return exists for exactly this
	 * case.
	 */
	it("does not retry a request the server rejected as invalid", async () => {
		const { fetchImpl, attempts } = scriptedFetch([
			[errorTrailer("invalid_argument", "tool schema is not acceptable")],
			[textFrame("never reached", StopReason.STOP_PATTERN)],
		]);

		const { waits, result } = await collect(fetchImpl);

		expect(attempts()).toBe(1);
		expect(waits).toEqual([]);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("tool schema is not acceptable");
	});

	/**
	 * A window longer than the cap fails now instead of sleeping through it.
	 *
	 * The forty-minute reset is a real observed value. Waiting it out would leave the operator
	 * staring at a frozen turn with no way to know why, so the failure is theirs to see and act on.
	 */
	it("gives up rather than waiting out a window beyond the cap", async () => {
		const { fetchImpl, attempts } = scriptedFetch([
			[
				errorTrailer(
					"permission_denied",
					"Reached overall message rate limit. Your limit will reset in 40 minutes.",
				),
			],
			[textFrame("never reached", StopReason.STOP_PATTERN)],
		]);

		const { waits, result } = await collect(fetchImpl);

		expect(attempts()).toBe(1);
		expect(waits).toEqual([]);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("40 minutes");
	});

	/**
	 * The budget is bounded, so a persistently failing endpoint fails in seconds.
	 *
	 * Without a cap the delegation would recurse for as long as the server keeps failing. Four
	 * attempts total: the original plus three retries.
	 */
	it("stops after the retry budget is spent", async () => {
		const { fetchImpl, attempts } = scriptedFetch([[errorTrailer("unavailable", "still unavailable")]]);

		const { waits, result } = await collect(fetchImpl);

		expect(attempts()).toBe(4);
		expect(waits).toEqual([1_000, 2_000, 4_000]);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("still unavailable");
	});

	/**
	 * An aborted request does not fire another one on its way out.
	 *
	 * The caller has said to stop, and a retry launched during teardown is a request nobody is
	 * waiting for that still spends rate-limit budget.
	 */
	it("does not retry once the caller has aborted", async () => {
		const controller = new AbortController();
		const { fetchImpl, attempts } = scriptedFetch([[errorTrailer("unavailable", "backend unavailable")]]);
		controller.abort();

		const { waits } = await collect(fetchImpl, { signal: controller.signal });

		expect(attempts()).toBeLessThanOrEqual(1);
		expect(waits).toEqual([]);
	});
});
