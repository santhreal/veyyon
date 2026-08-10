import { describe, expect, test } from "bun:test";
import * as AIError from "../src/error";
import { cursorStreamFailure, parseConnectEndStream } from "../src/providers/cursor";
import { devinTrailerFailure } from "../src/providers/devin";
import { AssistantMessageEventStream, EventStream } from "../src/utils/event-stream";
import { postOpenAIStream } from "../src/utils/openai-http";

/**
 * WHY THIS SUITE EXISTS, AND WHICH CLASS IT CLOSES.
 *
 * A provider stream failure has exactly one question to answer: is another attempt
 * worth making. Three separate places used to answer it, and they disagreed.
 *
 *   1. `ProviderResponseError` attaches `Flag.Transient` for the kinds that produced
 *      no content, so the turn loop retried them.
 *   2. `isProviderRetryableError`, which the in-provider retry loops (Anthropic,
 *      Devin) call, re-derived transience from message PROSE and never looked at
 *      that flag. A Devin empty body was therefore retried by one loop and refused
 *      by the other, and a truncated Cursor stream was retried only because its
 *      sentence happened to contain the word "truncated".
 *   3. Devin mapped Connect trailer codes onto HTTP statuses so the shared
 *      classifier could read them (after 564 of 2690 recorded turns died on
 *      retryable trailers). Cursor speaks the identical protocol, sends the
 *      identical trailer, and mapped nothing: an `unavailable` from Cursor
 *      classified as no kind at all and failed the turn outright.
 *
 * So the class is not "Cursor drops turns". It is "the retry verdict has more than
 * one owner". These rows pin the owner: the kind table decides for a structural
 * failure, `connectFailureStatus` decides for a trailer code, both deciders must
 * agree for every kind, and both providers must agree for every code and for both
 * wire spellings of a code.
 *
 * WHAT THIS DOES NOT CATCH: whether a retry is actually ATTEMPTED. That is the
 * replay-safety guard plus each provider's attempt budget (`devinRetryDelayMs`,
 * `PROVIDER_MAX_RETRIES`), covered elsewhere. A verdict of "retryable" here means
 * the classification permits a retry, not that one happened.
 */

/** A message with no transient wording, so only the structural verdict can decide. */
const NEUTRAL = "the provider said no more than this";

describe("a provider response kind has one retry verdict", () => {
	test("every kind agrees between the turn loop and the provider loop", () => {
		const kinds = Object.keys(AIError.PROVIDER_RESPONSE_RETRYABLE) as AIError.ProviderResponseErrorKind[];
		// Derived from the table, so a kind added to the union without a row here is
		// a type error, and a kind added to both without a verdict fails this row.
		expect(kinds.length).toBeGreaterThanOrEqual(6);
		const verdicts: Record<string, { turn: boolean; provider: boolean; expected: boolean }> = {};
		for (const kind of kinds) {
			const error = new AIError.ProviderResponseError(NEUTRAL, { provider: "devin", kind });
			verdicts[kind] = {
				turn: AIError.retriable(AIError.classify(error)),
				provider: AIError.isProviderRetryableError(error),
				expected: AIError.PROVIDER_RESPONSE_RETRYABLE[kind],
			};
		}
		expect(verdicts).toEqual({
			"incomplete-stream": { turn: true, provider: true, expected: true },
			"empty-body": { turn: true, provider: true, expected: true },
			envelope: { turn: false, provider: false, expected: false },
			output: { turn: false, provider: false, expected: false },
			"content-blocked": { turn: false, provider: false, expected: false },
			runtime: { turn: false, provider: false, expected: false },
		});
	});

	test("the verdict survives a message that says nothing retryable", () => {
		// The pre-fix provider loop needed prose. This message has none: no status,
		// no "truncated", no "timeout", no "unavailable".
		const dropped = new AIError.ProviderResponseError("Cursor stream ended before the turn was declared over", {
			provider: "cursor",
			kind: "incomplete-stream",
		});
		expect(AIError.isProviderRetryableError(dropped)).toBe(true);
		expect(AIError.retriable(AIError.classify(dropped))).toBe(true);
	});

	test("a content-blocked turn stays terminal in both deciders", () => {
		const blocked = new AIError.ProviderResponseError("Request blocked by Google (SAFETY)", {
			provider: "google",
			kind: "content-blocked",
		});
		expect(AIError.is(AIError.classify(blocked), AIError.Flag.ContentBlocked)).toBe(true);
		expect(AIError.retriable(AIError.classify(blocked))).toBe(false);
		expect(AIError.isProviderRetryableError(blocked)).toBe(false);
	});

	test("a replay-unsafe turn is refused even when the kind is retryable", () => {
		const dropped = new AIError.ProviderResponseError("stream ended", { kind: "incomplete-stream" });
		expect(AIError.retriable(AIError.classify(dropped), { replayUnsafe: true })).toBe(false);
	});
});

describe("connect trailer codes map to one status table", () => {
	const CODE_STATUS: readonly [string, number | undefined][] = [
		["unavailable", 503],
		["internal", 503],
		["deadline_exceeded", 503],
		["aborted", 503],
		["unknown", 503],
		["resource_exhausted", 429],
		["unauthenticated", 401],
		["invalid_argument", undefined],
		["not_found", undefined],
		["already_exists", undefined],
		["permission_denied", undefined],
		["failed_precondition", undefined],
		["out_of_range", undefined],
		["unimplemented", undefined],
		["data_loss", undefined],
		["canceled", undefined],
	];

	test("every transient code is placed, and every request fault is not", () => {
		const placed = Object.fromEntries(
			CODE_STATUS.map(([code]) => [code, AIError.connectFailureStatus({ code, message: NEUTRAL })]),
		);
		expect(placed).toEqual(Object.fromEntries(CODE_STATUS));
	});

	test("the transient set is exactly the codes that earn a retry", () => {
		// Derived from the exported set, so adding a code to it without deciding a
		// status here fails: every member must place, and only members may place as 5xx.
		for (const code of AIError.CONNECT_TRANSIENT_CODES) {
			expect(AIError.connectFailureStatus({ code, message: NEUTRAL })).toBeDefined();
		}
		const fiveHundreds = CODE_STATUS.filter(([, status]) => status !== undefined && status >= 500).map(
			([code]) => code,
		);
		expect(new Set(fiveHundreds)).toEqual(
			new Set([...AIError.CONNECT_TRANSIENT_CODES].filter(code => code !== "resource_exhausted")),
		);
	});

	test("the numeric gRPC spelling and the Connect name give the same verdict", () => {
		// The two wire formats spell one failure differently: an HTTP/2 `grpc-status`
		// trailer carries the number, a Connect end-stream trailer carries the name.
		// A verdict that depends on the spelling is the same defect in a new coat.
		const canonical: readonly [string, string][] = [
			["1", "canceled"],
			["2", "unknown"],
			["3", "invalid_argument"],
			["4", "deadline_exceeded"],
			["5", "not_found"],
			["6", "already_exists"],
			["7", "permission_denied"],
			["8", "resource_exhausted"],
			["9", "failed_precondition"],
			["10", "aborted"],
			["11", "out_of_range"],
			["12", "unimplemented"],
			["13", "internal"],
			["14", "unavailable"],
			["15", "data_loss"],
			["16", "unauthenticated"],
		];
		const mismatches: string[] = [];
		for (const [number, name] of canonical) {
			expect(AIError.normalizeConnectCode(number)).toBe(name);
			const byNumber = AIError.connectFailureStatus({ code: number, message: NEUTRAL });
			const byName = AIError.connectFailureStatus({ code: name, message: NEUTRAL });
			if (byNumber !== byName) mismatches.push(`${number}/${name}: ${byNumber} vs ${byName}`);
		}
		expect(mismatches).toEqual([]);
	});

	test("an unrecognized code is a request fault and is not retried", () => {
		expect(AIError.connectFailureStatus({ code: "wat", message: NEUTRAL })).toBeUndefined();
		expect(AIError.connectFailureStatus({ code: "", message: NEUTRAL })).toBeUndefined();
		expect(AIError.connectFailureStatus({ code: "42", message: NEUTRAL })).toBeUndefined();
	});

	test("the rate-limit sentence outranks the code, whichever code it is", () => {
		// Cascade's real trailer: a per-minute message cap reported as a permanent
		// authorization failure. 561 of 564 recorded Devin errors were this sentence.
		const message = "Reached overall message rate limit. Please try again later. Your limit will reset in 1 minute.";
		expect(AIError.connectFailureStatus({ code: "permission_denied", message })).toBe(429);
		expect(AIError.connectFailureStatus({ code: "invalid_argument", message: "too many requests" })).toBe(429);
		// The codes that place on their own are the ones that prove the ORDER: a
		// sentence about a rate limit has to win over a code that would otherwise
		// answer 503 or 401, because 429 is what carries retry-after handling and the
		// stated reset window, and because calling a rate limit a dead credential
		// disables a working account.
		expect(AIError.connectFailureStatus({ code: "unavailable", message: "rate limit exceeded, retry later" })).toBe(
			429,
		);
		expect(AIError.connectFailureStatus({ code: "unauthenticated", message: "too many requests" })).toBe(429);
		expect(AIError.connectFailureStatus({ code: "14", message: "rate limited" })).toBe(429);
	});

	test("case and padding in the code do not change the verdict", () => {
		expect(AIError.connectFailureStatus({ code: " UNAVAILABLE ", message: NEUTRAL })).toBe(503);
		expect(AIError.normalizeConnectCode(" 14 ")).toBe("unavailable");
	});
});

describe("devin and cursor read the same table", () => {
	const CODES = [
		"unavailable",
		"internal",
		"deadline_exceeded",
		"aborted",
		"unknown",
		"resource_exhausted",
		"unauthenticated",
		"invalid_argument",
		"not_found",
		"permission_denied",
		"unimplemented",
		"14",
		"13",
		"3",
	] as const;

	test("both providers agree on the retry verdict for every code", () => {
		const disagreements: string[] = [];
		for (const code of CODES) {
			const text = `stream error ${code}`;
			const devin = devinTrailerFailure({ code, message: NEUTRAL, text });
			const cursor = cursorStreamFailure(code, NEUTRAL, "Connect error");
			const devinRetry = AIError.isProviderRetryableError(devin);
			const cursorRetry = AIError.isProviderRetryableError(cursor);
			const devinTurn = AIError.retriable(AIError.classify(devin));
			const cursorTurn = AIError.retriable(AIError.classify(cursor));
			if (devinRetry !== cursorRetry || devinTurn !== cursorTurn) {
				disagreements.push(
					`${code}: devin provider=${devinRetry} turn=${devinTurn}, cursor provider=${cursorRetry} turn=${cursorTurn}`,
				);
			}
			if (AIError.status(devin) !== AIError.status(cursor)) {
				disagreements.push(`${code}: status ${AIError.status(devin)} vs ${AIError.status(cursor)}`);
			}
		}
		expect(disagreements).toEqual([]);
	});

	test("a transient code is retried on both providers", () => {
		const devin = devinTrailerFailure({
			code: "unavailable",
			message: NEUTRAL,
			text: "Devin stream error unavailable: gone",
		});
		const cursor = cursorStreamFailure("14", NEUTRAL, "gRPC error");
		expect(AIError.status(devin)).toBe(503);
		expect(AIError.status(cursor)).toBe(503);
		expect(AIError.isProviderRetryableError(devin)).toBe(true);
		expect(AIError.isProviderRetryableError(cursor)).toBe(true);
	});

	test("a request fault is terminal on both providers", () => {
		const devin = devinTrailerFailure({
			code: "invalid_argument",
			message: NEUTRAL,
			text: "Devin stream error invalid_argument: bad prompt",
		});
		const cursor = cursorStreamFailure("invalid_argument", NEUTRAL, "Connect error");
		expect(AIError.isProviderRetryableError(devin)).toBe(false);
		expect(AIError.isProviderRetryableError(cursor)).toBe(false);
		expect(cursor).toBeInstanceOf(AIError.ProviderResponseError);
		expect((cursor as AIError.ProviderResponseError).kind).toBe("envelope");
		expect((cursor as AIError.ProviderResponseError).provider).toBe("cursor");
	});
});

describe("cursor stream failures keep their operator-facing text", () => {
	test("a placed code becomes a CursorApiError without losing the message", () => {
		const failure = cursorStreamFailure("14", "backend unavailable", "gRPC error");
		expect(failure).toBeInstanceOf(AIError.CursorApiError);
		expect(failure.message).toBe("gRPC error 14: backend unavailable");
		expect(failure.name).toBe("CursorApiError");
	});

	test("an unauthenticated trailer is an auth failure, not a hiccup", () => {
		// Credential rotation owns this, and it must not be retried against the same
		// credential in a seconds-scale loop.
		const failure = cursorStreamFailure("unauthenticated", "token expired", "Connect error");
		expect(AIError.status(failure)).toBe(401);
		expect(AIError.is(AIError.classify(failure), AIError.Flag.AuthFailed)).toBe(true);
		expect(AIError.isProviderRetryableError(failure)).toBe(false);
	});

	test("an end-stream trailer carrying an error is classified from its code", () => {
		const frame = new TextEncoder().encode(
			JSON.stringify({ error: { code: "unavailable", message: "upstream gone" } }),
		);
		const failure = parseConnectEndStream(frame);
		expect(failure?.message).toBe("Connect error unavailable: upstream gone");
		expect(AIError.isProviderRetryableError(failure)).toBe(true);
	});

	test("a clean end-stream trailer is not an error", () => {
		expect(parseConnectEndStream(new TextEncoder().encode("{}"))).toBeNull();
		expect(parseConnectEndStream(new TextEncoder().encode(JSON.stringify({ metadata: {} })))).toBeNull();
	});

	test("an unreadable end-stream frame is an incomplete stream, so it retries", () => {
		const failure = parseConnectEndStream(new Uint8Array([0xff, 0x00, 0x7b, 0x22]));
		expect(failure).toBeInstanceOf(AIError.ProviderResponseError);
		expect((failure as AIError.ProviderResponseError).kind).toBe("incomplete-stream");
		expect(AIError.isProviderRetryableError(failure)).toBe(true);
	});
});

describe("a stream that produced nothing is retryable wherever it is reported", () => {
	test("a result-less stream rejects with a retryable incomplete stream", async () => {
		// Driven through the real `end()`, because a hand-built error proves only that
		// the constructor works. This branch used to label the fault `envelope`, which
		// classifies as nothing, so a stream that died before its final message failed
		// the turn outright.
		const plain = new EventStream<string, string>(
			event => event === "done",
			event => event,
		);
		plain.end();
		const plainError = await plain.result().then(
			() => undefined,
			(error: unknown) => error,
		);
		expect(plainError).toBeInstanceOf(AIError.ProviderResponseError);
		expect((plainError as AIError.ProviderResponseError).kind).toBe("incomplete-stream");
		expect(AIError.isProviderRetryableError(plainError)).toBe(true);

		const assistant = new AssistantMessageEventStream();
		assistant.end();
		const assistantError = await assistant.result().then(
			() => undefined,
			(error: unknown) => error,
		);
		expect(assistantError).toBeInstanceOf(AIError.ProviderResponseError);
		expect((assistantError as AIError.ProviderResponseError).kind).toBe("incomplete-stream");
		expect(AIError.isProviderRetryableError(assistantError)).toBe(true);
	});

	test("a 2xx with no body rejects with a retryable empty body", async () => {
		// The real transport, with a fetch that answers 200 and no body at all. The
		// caller cannot distinguish this from a dropped connection, and nothing was
		// produced, so it has to be retryable.
		const failure = await postOpenAIStream({
			url: "https://example.invalid/v1/chat/completions",
			headers: {},
			body: { model: "gpt-4o" },
			signal: new AbortController().signal,
			fetch: async () => new Response(null, { status: 200 }),
		}).then(
			() => undefined,
			(error: unknown) => error,
		);
		expect(failure).toBeInstanceOf(AIError.ProviderResponseError);
		expect((failure as AIError.ProviderResponseError).kind).toBe("empty-body");
		expect((failure as Error).message).toContain("no body (status 200)");
		expect(AIError.isProviderRetryableError(failure)).toBe(true);
		expect(AIError.retriable(AIError.classify(failure))).toBe(true);
	});

	test("a protocol violation is not a hiccup", () => {
		// A frame length past the cap is a malformed envelope: replaying it yields the
		// same bytes, so it stays terminal and the operator sees it.
		const oversized = new AIError.ProviderResponseError("Devin Connect frame length 99 exceeds 42-byte cap", {
			provider: "devin",
			kind: "envelope",
		});
		expect(AIError.isProviderRetryableError(oversized)).toBe(false);
		expect(AIError.retriable(AIError.classify(oversized))).toBe(false);
	});
});
