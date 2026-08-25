/**
 * WHY THIS SUITE EXISTS AND WHICH CLASS IT CLOSES.
 *
 * Session evidence from live Cursor runs identified specific failure modes:
 *
 *  1. `NGHTTP2_INTERNAL_ERROR` resets after a long partial stream: a transient HTTP/2 transport fault.
 *     The transport and turn levels are retryable, but once a turn has already emitted tool calls
 *     (replayUnsafe), it must NEVER be retried at the turn level to prevent duplicate tool execution.
 *  2. HTTP 429 `Connect error resource_exhausted`: a usage/quota wall. It must classify with Flag.UsageLimit,
 *     triggering credential rotation (action: "rotate-credential") rather than hammering the same exhausted
 *     account in a provider retry loop.
 *  3. Quota 403: an HTTP 403 carrying quota exhaustion wording ("quota exceeded", "usage limit", "out of credits").
 *     Because the quota domain is ordered ahead of the auth domain, this rotates to a sibling account
 *     (action: "rotate-credential") rather than failing authentication or triggering re-login.
 *  4. `invalid_argument` (e.g. "Connect error invalid_argument: cannot encode field ..."): a client-side
 *     or protocol-invalid input error. It must be strictly terminal: never retried at provider or turn level,
 *     and never rotating accounts.
 *
 * What it does not catch:
 * Upstream Cursor server availability or external network connectivity.
 */
import { describe, expect, it } from "bun:test";
import * as AIError from "../src/error";
import { cursorStreamFailure } from "../src/providers/cursor";

describe("Cursor session error classification and recovery", () => {
	describe("NGHTTP2_INTERNAL_ERROR after stream reset", () => {
		const HTTP2_RESET_VARIANTS = [
			"Stream closed with error code NGHTTP2_INTERNAL_ERROR",
			"NGHTTP2_INTERNAL_ERROR",
			"HTTP/2 stream error: NGHTTP2_INTERNAL_ERROR",
			"upstream server error: Stream closed with error code NGHTTP2_INTERNAL_ERROR",
		];

		it.each(HTTP2_RESET_VARIANTS)("classifies %s as transient and enforces replay safety", message => {
			const error = new Error(message);
			const id = AIError.classify(error);

			// 1. Classification
			expect(AIError.is(id, AIError.Flag.Transient)).toBe(true);
			expect(AIError.is(id, AIError.Flag.UsageLimit)).toBe(false);
			expect(AIError.is(id, AIError.Flag.AuthFailed)).toBe(false);

			// 2. Transport & Provider Retry
			expect(AIError.recover(id, "transport")).toEqual({ action: "retry" });
			expect(AIError.isProviderRetryableError(error)).toBe(true);

			// 3. Credential stage (stays on current credential, does not rotate account)
			expect(AIError.recover(id, "credential")).toEqual({ action: "retry" });
			expect(AIError.isUsageLimit(error)).toBe(false);

			// 4. Turn stage: safe when no tool calls were emitted
			expect(AIError.recover(id, "turn")).toEqual({ action: "retry" });
			expect(AIError.retriable(id, { replayUnsafe: false })).toBe(true);

			// 5. Turn stage: TERMINAL when replayUnsafe=true (never duplicate tool effects)
			expect(AIError.retriable(id, { replayUnsafe: true })).toBe(false);
		});
	});

	describe("HTTP 429 Connect error resource_exhausted", () => {
		const RESOURCE_EXHAUSTED_CASES = [
			{
				name: "CursorApiError with status 429",
				error: new AIError.CursorApiError("Connect error resource_exhausted: (no detail)", 429),
			},
			{
				name: "cursorStreamFailure helper for resource_exhausted",
				error: cursorStreamFailure("resource_exhausted", "capacity exhausted", "Connect error"),
			},
			{
				name: "cursorStreamFailure helper for numeric gRPC status 8 (resource_exhausted)",
				error: cursorStreamFailure("8", "Quota exceeded: monthly quota reached", "gRPC error"),
			},
			{
				name: "cursorStreamFailure helper for numeric gRPC status 8 with resource_exhausted wording",
				error: cursorStreamFailure("8", "resource_exhausted: monthly account limit reached", "gRPC error"),
			},
			{
				name: "Plain Error with Connect error resource_exhausted message",
				error: new Error("Connect error resource_exhausted: backend capacity"),
			},
			{
				name: "Object with status 429 and resource_exhausted",
				error: Object.assign(new Error("Connect error resource_exhausted: (no detail)"), { status: 429 }),
			},
		];

		it.each(RESOURCE_EXHAUSTED_CASES)("routes $name to credential rotation and turn retry", ({ error }) => {
			const id = AIError.classify(error);

			// 1. Classification
			expect(AIError.is(id, AIError.Flag.UsageLimit)).toBe(true);

			// 2. Transport: surface immediately (do not hammer same credential)
			expect(AIError.recover(id, "transport")).toEqual({ action: "surface" });
			expect(AIError.isProviderRetryableError(error)).toBe(false);

			// 3. Credential: rotate to a sibling account
			expect(AIError.recover(id, "credential")).toEqual({ action: "rotate-credential" });
			expect(AIError.isUsageLimit(error)).toBe(true);

			// 4. Turn: retriable once new credential is in hand
			expect(AIError.recover(id, "turn")).toEqual({ action: "retry" });
			expect(AIError.retriable(id)).toBe(true);
		});
	});

	describe("Quota 403 vs Auth 403", () => {
		const QUOTA_403_CASES = [
			{
				name: "403 Forbidden with quota exceeded",
				error: new AIError.CursorApiError("403 Forbidden: quota exceeded", 403),
			},
			{
				name: "403 Forbidden with usage limit reached",
				error: new AIError.CursorApiError("403 Forbidden: usage limit reached", 403),
			},
			{
				name: "403 Forbidden with out of credits",
				error: new AIError.CursorApiError("403 You have run out of credits or need a subscription.", 403),
			},
			{
				name: "Connect error permission_denied with usage limit",
				error: new AIError.CursorApiError("Connect error permission_denied: You've reached your usage limit.", 403),
			},
		];

		it.each(QUOTA_403_CASES)("routes quota 403 ($name) to account rotation over auth failure", ({ error }) => {
			const id = AIError.classify(error);

			// 1. Classification carries UsageLimit
			expect(AIError.is(id, AIError.Flag.UsageLimit)).toBe(true);

			// 2. Credential recovery: quotaDomain precedes authDomain -> rotate-credential
			expect(AIError.recover(id, "credential")).toEqual({ action: "rotate-credential" });
			expect(AIError.isUsageLimit(error)).toBe(true);

			// 3. Provider retry is refused
			expect(AIError.isProviderRetryableError(error)).toBe(false);

			// 4. Turn is retriable after rotation
			expect(AIError.recover(id, "turn")).toEqual({ action: "retry" });
			expect(AIError.retriable(id)).toBe(true);
		});

		const AUTH_403_CASES = [
			{
				name: "403 Forbidden invalid api key",
				error: new AIError.CursorApiError("403 Forbidden: invalid api key", 403),
			},
			{
				name: "403 Forbidden access denied",
				error: new AIError.CursorApiError("403 Forbidden: access denied", 403),
			},
		];

		it.each(AUTH_403_CASES)("routes non-quota auth 403 ($name) to reauth without account rotation", ({ error }) => {
			const id = AIError.classify(error);

			// 1. Classification
			expect(AIError.is(id, AIError.Flag.AuthFailed)).toBe(true);
			expect(AIError.is(id, AIError.Flag.UsageLimit)).toBe(false);

			// 2. Credential recovery: reauth, not rotation
			expect(AIError.recover(id, "credential")).toEqual({ action: "reauth" });
			expect(AIError.isUsageLimit(error)).toBe(false);

			// 3. Provider and turn recovery surface
			expect(AIError.recover(id, "transport")).toEqual({ action: "surface" });
			expect(AIError.recover(id, "turn")).toEqual({ action: "surface" });
			expect(AIError.isProviderRetryableError(error)).toBe(false);
			expect(AIError.retriable(id)).toBe(false);
		});
	});

	describe("invalid_argument (protocol and request errors)", () => {
		const INVALID_ARGUMENT_CASES = [
			{
				name: "session-observed int32 binary encoding rejection",
				error: cursorStreamFailure(
					"invalid_argument",
					"cannot encode field agent.v1.GrepContentMatch.line_number to binary: invalid int32: 1753660800000",
					"Connect error",
				),
			},
			{
				name: "cursorStreamFailure helper for numeric gRPC status 3 (invalid_argument)",
				error: cursorStreamFailure("3", "cannot parse requested context", "gRPC error"),
			},
			{
				name: "generic invalid_argument trailer failure",
				error: cursorStreamFailure("invalid_argument", "bad prompt format", "Connect error"),
			},
			{
				name: "plain Error with Connect error invalid_argument",
				error: new Error("Connect error invalid_argument: tool schema is not acceptable"),
			},
			{
				name: "CursorApiError with status 400 invalid_argument",
				error: new AIError.CursorApiError("Connect error invalid_argument", 400),
			},
		];

		it.each(INVALID_ARGUMENT_CASES)(
			"treats $name as strictly terminal with no retries or account rotation",
			({ error }) => {
				const id = AIError.classify(error);

				// 1. Classification: not transient, not quota, not auth
				expect(AIError.is(id, AIError.Flag.Transient)).toBe(false);
				expect(AIError.is(id, AIError.Flag.UsageLimit)).toBe(false);
				expect(AIError.is(id, AIError.Flag.AuthFailed)).toBe(false);

				// 2. Transport: surface immediately (never retry in provider loop)
				expect(AIError.recover(id, "transport")).toEqual({ action: "surface" });
				expect(AIError.isProviderRetryableError(error)).toBe(false);

				// 3. Credential: surface immediately (never rotate accounts for invalid input)
				expect(AIError.recover(id, "credential")).toEqual({ action: "surface" });
				expect(AIError.isUsageLimit(error)).toBe(false);

				// 4. Turn: surface immediately (never retry at turn level)
				expect(AIError.recover(id, "turn")).toEqual({ action: "surface" });
				expect(AIError.retriable(id)).toBe(false);
			},
		);
	});
});
