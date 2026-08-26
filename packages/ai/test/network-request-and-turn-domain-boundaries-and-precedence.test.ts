/**
 * WHY. Classification rules in network.ts, request.ts, and turn.ts must precisely discriminate
 * failure modes without false positives (e.g. model names with digits triggering status codes,
 * or unrelated 400 errors triggering grammar degradation). Furthermore, when multiple rules or
 * failure flags co-occur on a single error, recovery precedence must deterministically resolve
 * according to the domain hierarchy.
 *
 * The class this closes: regex regressions on boundary conditions, near-miss false matches across
 * network/request/turn failure kinds, and precedence ambiguities when multiple flags co-occur.
 *
 * What it does not catch: provider-specific transport framing quirks tested in integration suites.
 */
import { describe, expect, it } from "bun:test";
import { STREAM_FRAME_LIMIT_ERROR_NAME } from "@veyyon/utils/stream-frame-limit";
import {
	AnthropicConnectionError,
	AnthropicConnectionTimeoutError,
	CodexProviderStreamError,
	CodexWebSocketTransportError,
	classify,
	create,
	explain,
	Flag,
	KIND_MASK,
	ProviderHttpError,
	recover,
	retriable,
	vetoesRetry,
} from "../src/error";

describe("network domain boundary conditions", () => {
	describe("timeoutDomain", () => {
		it("anthropic-connection-timeout: positive and negative matches", () => {
			const positive = new AnthropicConnectionTimeoutError();
			const positiveExplanation = explain(positive);
			expect(positiveExplanation.rules).toContain("anthropic-connection-timeout");
			expect((positiveExplanation.id & Flag.Timeout) !== 0).toBe(true);
			expect((positiveExplanation.id & Flag.Transient) !== 0).toBe(true);

			const negative = new AnthropicConnectionError(new Error("socket hang up"));
			const negativeExplanation = explain(negative);
			expect(negativeExplanation.rules).not.toContain("anthropic-connection-timeout");
			expect(negativeExplanation.rules).toContain("anthropic-connection-error");
			expect((negativeExplanation.id & Flag.Timeout) !== 0).toBe(false);
		});

		it("timeout-with-http2-verdict: positive and negative matches", () => {
			const positive = new Error("Stream closed with error code NGHTTP2_INTERNAL_ERROR: request timed out");
			const positiveExplanation = explain(positive);
			expect(positiveExplanation.rules).toContain("timeout-with-http2-verdict");
			expect((positiveExplanation.id & Flag.Timeout) !== 0).toBe(true);

			const negative = new Error("Stream closed with error code NGHTTP2_INTERNAL_ERROR: internal failure");
			const negativeExplanation = explain(negative);
			expect(negativeExplanation.rules).not.toContain("timeout-with-http2-verdict");
			expect((negativeExplanation.id & Flag.Timeout) !== 0).toBe(false);
		});

		it("timeout-without-http2-verdict: positive and negative matches", () => {
			const positive = new Error("operation timed out after 30000ms");
			const positiveExplanation = explain(positive);
			expect(positiveExplanation.rules).toContain("timeout-without-http2-verdict");
			expect((positiveExplanation.id & Flag.Timeout) !== 0).toBe(true);
			expect((positiveExplanation.id & Flag.Transient) !== 0).toBe(true);

			const positiveStall = new Error("stream stall waiting for response");
			const stallExplanation = explain(positiveStall);
			expect(stallExplanation.rules).toContain("timeout-without-http2-verdict");

			const negative = new Error("timely response processed successfully");
			const negativeExplanation = explain(negative);
			expect(negativeExplanation.rules).not.toContain("timeout-without-http2-verdict");
			expect((negativeExplanation.id & Flag.Timeout) !== 0).toBe(false);
		});
	});

	describe("transportDomain", () => {
		it("codex websocket and retryable stream: positive and negative matches", () => {
			const wsPositive = new CodexWebSocketTransportError("socket reset");
			expect(explain(wsPositive).rules).toContain("codex-websocket-transport");

			const wsNegative = new Error("Codex websocket transport error: plain error");
			expect(explain(wsNegative).rules).not.toContain("codex-websocket-transport");

			const streamPositive = new CodexProviderStreamError("stream dropped", { retryable: true });
			expect(explain(streamPositive).rules).toContain("codex-retryable-stream");

			const streamNegative = new CodexProviderStreamError("stream dropped", { retryable: false });
			expect(explain(streamNegative).rules).not.toContain("codex-retryable-stream");
		});

		it("named-http2-retryable-code: positive and negative matches", () => {
			const positive = new Error("Stream closed with error code NGHTTP2_REFUSED_STREAM");
			expect(explain(positive).rules).toContain("named-http2-retryable-code");
			expect(classify(positive) & Flag.Transient).toBe(Flag.Transient);

			const negative = new Error("Stream closed with error code NGHTTP2_CANCEL");
			expect(explain(negative).rules).not.toContain("named-http2-retryable-code");
			expect(explain(negative).rules).toContain("named-http2-refused-code");
		});

		it("transport-vocabulary: word boundaries for statuses and errnos", () => {
			const positiveEconn = new Error("read ECONNRESET");
			expect(explain(positiveEconn).rules).toContain("transport-vocabulary");

			const positive502 = new Error("502 Bad Gateway");
			expect(explain(positive502).rules).toContain("transport-vocabulary");

			// Digits in model name should NOT match transport status numbers
			const negativeModelDigits = new Error("model claude-3-5-sonnet-20240502 failed to generate");
			expect(explain(negativeModelDigits).rules).not.toContain("transport-vocabulary");

			// Non-socket errno substring should not match
			const negativeEpipeline = new Error("EPIPELINE not a socket errno");
			expect(explain(negativeEpipeline).rules).not.toContain("transport-vocabulary");

			// Timeouts are handled by timeoutDomain, not transport-vocabulary
			const timeoutMsg = new Error("request timed out");
			expect(explain(timeoutMsg).rules).not.toContain("transport-vocabulary");
			expect(explain(timeoutMsg).rules).toContain("timeout-without-http2-verdict");
		});

		it("stream-corruption: positive and negative matches", () => {
			const positiveJson = new Error("unexpected end of json input");
			expect(explain(positiveJson).rules).toContain("stream-corruption");

			const positiveOrder = new Error("stream event order violated");
			expect(explain(positiveOrder).rules).toContain("stream-corruption");

			const positiveCode1302 = new Error("upstream error 1302 occurred");
			expect(explain(positiveCode1302).rules).toContain("stream-corruption");

			const negativeCode13020 = new Error("request id 13020 completed");
			expect(explain(negativeCode13020).rules).not.toContain("stream-corruption");
		});

		it("copilot-model-not-supported-flap: status 400 requirement and code detection", () => {
			const positiveText = Object.assign(new Error("400 Bad Request: model_not_supported for gpt-4o"), {
				status: 400,
			});
			expect(explain(positiveText).rules).toContain("copilot-model-not-supported-flap");

			const positiveCode = Object.assign(new Error("400 error"), { status: 400, code: "model_not_supported" });
			expect(explain(positiveCode).rules).toContain("copilot-model-not-supported-flap");

			const negativeStatus500 = Object.assign(new Error("500 Internal Error: model_not_supported"), { status: 500 });
			expect(explain(negativeStatus500).rules).not.toContain("copilot-model-not-supported-flap");

			const negativeDifferentCode = Object.assign(new Error("400 Bad Request: model_not_found"), { status: 400 });
			expect(explain(negativeDifferentCode).rules).not.toContain("copilot-model-not-supported-flap");
		});
	});

	describe("refusalDomain", () => {
		it("stream-frame-limit-breach: sets TransportRefused and clears Transient", () => {
			const framingBreach = Object.assign(new Error("line with no line feed"), {
				name: STREAM_FRAME_LIMIT_ERROR_NAME,
			});
			const wrapped = new Error("connection error, please retry", { cause: framingBreach });
			const explanation = explain(wrapped);

			expect(explanation.rules).toContain("stream-frame-limit-breach");
			expect(explanation.rules).toContain("framing-violation-clears-transient");
			expect((explanation.id & Flag.TransportRefused) !== 0).toBe(true);
			expect((explanation.id & Flag.Transient) !== 0).toBe(false);

			const nonFraming = new Error("line with no line feed");
			expect(explain(nonFraming).rules).not.toContain("stream-frame-limit-breach");
		});

		it("named-http2-refused-code: positive and negative matches", () => {
			const positiveCancel = new Error("Stream closed with error code NGHTTP2_CANCEL");
			expect(explain(positiveCancel).rules).toContain("named-http2-refused-code");
			expect(classify(positiveCancel) & Flag.TransportRefused).toBe(Flag.TransportRefused);

			const positiveFlow = new Error("Stream closed with error code NGHTTP2_FLOW_CONTROL_ERROR");
			expect(explain(positiveFlow).rules).toContain("named-http2-refused-code");

			const negativeInternal = new Error("Stream closed with error code NGHTTP2_INTERNAL_ERROR");
			expect(explain(negativeInternal).rules).not.toContain("named-http2-refused-code");
			expect(explain(negativeInternal).rules).toContain("named-http2-retryable-code");
		});
	});
});

describe("request domain boundary conditions", () => {
	describe("overflowDomain", () => {
		it("context-overflow-prose: positive and negative matches", () => {
			const positiveTokens = new Error("prompt is too long: 250000 tokens > 200000 maximum");
			expect(explain(positiveTokens).rules).toContain("context-overflow-prose");

			const positiveNoBody = new Error("400 status code (no body)");
			expect(explain(positiveNoBody).rules).toContain("context-overflow-prose");

			const positive413 = new Error("413 Payload Too Large");
			expect(explain(positive413).rules).toContain("context-overflow-prose");

			const negative = new Error("400 Bad Request: missing required header");
			expect(explain(negative).rules).not.toContain("context-overflow-prose");
		});
	});

	describe("grammarDomain", () => {
		it("strict-tools-rejection: status 400/422 and pattern boundaries", () => {
			const positive400 = Object.assign(
				new Error("400 invalid_request_error: compiled grammar is too large to fit in limit"),
				{ status: 400 },
			);
			expect(explain(positive400).rules).toContain("strict-tools-rejection");

			const positive422 = Object.assign(
				new Error("422 Unprocessable Entity: structured_outputs not supported by backend"),
				{ status: 422 },
			);
			expect(explain(positive422).rules).toContain("strict-tools-rejection");

			const positiveMixed = Object.assign(new Error("400 wrong_api_format: mixed values for 'strict'"), {
				status: 400,
			});
			expect(explain(positiveMixed).rules).toContain("strict-tools-rejection");

			const negativeStatus200 = Object.assign(new Error("200 OK: compiled grammar is too large"), { status: 200 });
			expect(explain(negativeStatus200).rules).not.toContain("strict-tools-rejection");

			const negativeUnrelated400 = Object.assign(new Error("400 invalid_request_error: invalid temperature value"), {
				status: 400,
			});
			expect(explain(negativeUnrelated400).rules).not.toContain("strict-tools-rejection");
		});
	});

	describe("fastModeDomain", () => {
		it("fast-mode-parameter-rejected: 400 and speed parameter boundaries", () => {
			const positive = Object.assign(
				new Error("400 invalid_request_error: speed parameter is not supported for this model"),
				{ status: 400 },
			);
			expect(explain(positive).rules).toContain("fast-mode-parameter-rejected");

			const negativeParam = Object.assign(
				new Error("400 invalid_request_error: temperature parameter is not supported"),
				{ status: 400 },
			);
			expect(explain(negativeParam).rules).not.toContain("fast-mode-parameter-rejected");

			const negativeStatus = Object.assign(new Error("500 internal_error: speed not supported"), { status: 500 });
			expect(explain(negativeStatus).rules).not.toContain("fast-mode-parameter-rejected");
		});

		it("fast-mode-entitlement-wall: 429 and fast mode entitlement boundaries", () => {
			const positive = Object.assign(
				new Error("429 rate_limit_error: fast mode requires additional account entitlements"),
				{ status: 429 },
			);
			expect(explain(positive).rules).toContain("fast-mode-entitlement-wall");

			const negativePlainRateLimit = Object.assign(new Error("429 rate_limit_error: token limit reached"), {
				status: 429,
			});
			expect(explain(negativePlainRateLimit).rules).not.toContain("fast-mode-entitlement-wall");

			const negativeStatus = Object.assign(new Error("400 rate_limit_error: fast mode error"), { status: 400 });
			expect(explain(negativeStatus).rules).not.toContain("fast-mode-entitlement-wall");
		});
	});

	describe("providerHttpDomain", () => {
		it("provider-http-error: maps status and machine codes to flags", () => {
			const usageLimit = new ProviderHttpError("Quota exhausted", 429, { code: "usage_limit_reached" });
			expect(classify(usageLimit) & Flag.UsageLimit).toBe(Flag.UsageLimit);

			const overloaded = new ProviderHttpError("Overloaded", 503, { code: "overloaded_error" });
			expect(classify(overloaded) & Flag.Transient).toBe(Flag.Transient);

			const auth401 = new ProviderHttpError("Unauthorized", 401);
			expect(classify(auth401) & Flag.AuthFailed).toBe(Flag.AuthFailed);

			const bare429 = new ProviderHttpError("Too Many Requests", 429);
			expect(classify(bare429) & Flag.Transient).toBe(Flag.Transient);

			const server500 = new ProviderHttpError("Internal Error", 500);
			expect(classify(server500) & Flag.Transient).toBe(Flag.Transient);

			const unrelated400 = new ProviderHttpError("Bad Request", 400, { code: "invalid_body" });
			expect(classify(unrelated400) & KIND_MASK).toBe(0);
		});
	});
});

describe("turn domain boundary conditions", () => {
	describe("toolCallDomain", () => {
		it("malformed-function-call: positive and negative matches", () => {
			const positive = new Error("MALFORMED_FUNCTION_CALL: model generated unparseable tool call");
			expect(explain(positive).rules).toContain("malformed-function-call");
			expect(classify(positive) & Flag.MalformedFunctionCall).toBe(Flag.MalformedFunctionCall);

			const negative = new Error("FUNCTION_CALL_EXECUTED: tool call completed successfully");
			expect(explain(negative).rules).not.toContain("malformed-function-call");
		});
	});

	describe("streamDomain", () => {
		it("provider-finish-error: positive and negative matches", () => {
			const positiveReturned = new Error("Provider returned error finish_reason from upstream");
			expect(explain(positiveReturned).rules).toContain("provider-finish-error");

			const positiveFinishReason = new Error("Provider finish_reason: error from upstream");
			expect(explain(positiveFinishReason).rules).toContain("provider-finish-error");

			const negativeStop = new Error("Stream completed with finish_reason: stop");
			expect(explain(negativeStop).rules).not.toContain("provider-finish-error");
		});

		it("stale-responses-item: api matching and text boundaries", () => {
			const positiveOpenAI = new Error("Item with id 'resp_abc123' not found.");
			expect(explain(positiveOpenAI, "openai-responses").rules).toContain("stale-responses-item");

			const positiveCodex = new Error("previous_response expired in cache");
			expect(explain(positiveCodex, "openai-codex-responses").rules).toContain("stale-responses-item");

			// Same text with mismatched API must NOT match
			const negativeAnthropic = new Error("Item with id 'resp_abc123' not found.");
			expect(explain(negativeAnthropic, "anthropic-messages").rules).not.toContain("stale-responses-item");

			const negativeFound = new Error("Item with id 'resp_abc123' was found and processed");
			expect(explain(negativeFound, "openai-responses").rules).not.toContain("stale-responses-item");
		});
	});

	describe("contentDomain", () => {
		it("content-filter: positive and negative matches", () => {
			const positive = new Error("incomplete: content_filter triggered by policy");
			expect(explain(positive).rules).toContain("content-filter");
			expect(classify(positive) & Flag.ContentBlocked).toBe(Flag.ContentBlocked);

			const negative = new Error("content_type: application/json was accepted");
			expect(explain(negative).rules).not.toContain("content-filter");
		});
	});

	describe("interruptDomain", () => {
		it("abort-by-error-name: recognizes AbortError and ToolAbortError names", () => {
			const domAbort = new DOMException("The operation was aborted", "AbortError");
			expect(explain(domAbort).rules).toContain("abort-by-error-name");

			const toolAbort = Object.assign(new Error("request cancelled"), { name: "ToolAbortError" });
			expect(explain(toolAbort).rules).toContain("abort-by-error-name");

			const plainError = new Error("The operation was aborted");
			expect(explain(plainError).rules).not.toContain("abort-by-error-name");
		});
	});
});

describe("precedence resolution when multiple rules or flags co-occur", () => {
	it("refusalDomain vetoes retry and surfaces even when wrapped in transient wording", () => {
		const refusedWithTransient = new Error(
			"Stream closed with error code NGHTTP2_CANCEL: connection error, please retry your request",
		);
		const classifiedId = classify(refusedWithTransient);

		expect((classifiedId & Flag.TransportRefused) !== 0).toBe(true);
		expect(vetoesRetry(classifiedId)).toBe(true);
		expect(retriable(classifiedId)).toBe(false);
		expect(recover(classifiedId, "turn")).toEqual({ action: "surface" });
	});

	it("contentDomain vetoes retry and surfaces even when accompanied by 503 status wording", () => {
		const contentWith503 = new Error("503 Service Unavailable: incomplete: content_filter");
		const classifiedId = classify(contentWith503);

		expect((classifiedId & Flag.ContentBlocked) !== 0).toBe(true);
		expect((classifiedId & Flag.Transient) !== 0).toBe(true);
		expect(vetoesRetry(classifiedId)).toBe(true);
		expect(retriable(classifiedId)).toBe(false);
		expect(recover(classifiedId, "turn")).toEqual({ action: "surface" });
	});

	it("interruptDomain dominates turn recovery with abort over any secondary status", () => {
		const abortWith503 = Object.assign(new Error("503 Service Unavailable: aborted"), {
			name: "AbortError",
			status: 503,
		});
		const classifiedId = classify(abortWith503);

		expect((classifiedId & Flag.Abort) !== 0).toBe(true);
		expect(recover(classifiedId, "turn")).toEqual({ action: "abort" });
		expect(recover(classifiedId, "transport")).toEqual({ action: "abort" });
		expect(retriable(classifiedId)).toBe(false);
	});

	it("overflowDomain compacts on turn recovery ahead of transport retry on 413", () => {
		const overflow413 = Object.assign(new Error("413 Payload Too Large: prompt is too long: 250k tokens"), {
			status: 413,
		});
		const classifiedId = classify(overflow413);

		expect((classifiedId & Flag.ContextOverflow) !== 0).toBe(true);
		expect(recover(classifiedId, "turn")).toEqual({ action: "compact" });
	});

	it("grammarDomain degrades strict-tools capability ahead of transport retry on 400", () => {
		const grammar400 = Object.assign(new Error("400 invalid_request_error: compiled grammar is too large"), {
			status: 400,
		});
		const classifiedId = classify(grammar400);

		expect((classifiedId & Flag.Grammar) !== 0).toBe(true);
		expect(recover(classifiedId, "turn")).toEqual({ action: "degrade", capability: "strict-tools" });
	});

	it("fastModeDomain degrades fast-mode capability ahead of transport retry on 400", () => {
		const fastMode400 = Object.assign(
			new Error("400 invalid_request_error: speed parameter is not supported for this model"),
			{ status: 400 },
		);
		const classifiedId = classify(fastMode400);

		expect((classifiedId & Flag.FastModeUnsupported) !== 0).toBe(true);
		expect(recover(classifiedId, "turn")).toEqual({ action: "degrade", capability: "fast-mode" });
	});

	it("toolCallDomain allows replay-unsafe retry while plain transient refuses it", () => {
		const malformedId = create(Flag.MalformedFunctionCall, Flag.Transient);
		const transientId = create(Flag.Transient);

		expect(retriable(malformedId, { replayUnsafe: true })).toBe(true);
		expect(retriable(transientId, { replayUnsafe: true })).toBe(false);
	});

	it("resolves timeout recovery: transient timeout retries while bare timeout switches model", () => {
		const transientTimeoutId = create(Flag.Timeout, Flag.Transient);
		const bareTimeoutId = create(Flag.Timeout);

		expect(recover(transientTimeoutId, "turn")).toEqual({ action: "retry" });
		expect(recover(bareTimeoutId, "turn")).toEqual({ action: "switch-model" });
	});
});
