/**
 * WHY. Provider catch blocks across the codebase finalize failures through `finalize.ts`, which
 * bundles classification, HTTP status resolution, stop reason, logging level, rule tracing, and
 * remedy-preserving message formatting. If finalize misclassifies an unworded failure, collapses a
 * structured remedy into a generic sentence, or misattributes caller cancellations as errors,
 * the entire session layer misbehaves (e.g. infinite retries on unclassified 400s or noisy error
 * logs on deliberate user aborts).
 *
 * The class this closes: loss of remedy details during message formatting, misrouting of bare/unworded
 * errors, and incorrect stopReason/logLevel derivation on aborted requests.
 *
 * What it does not catch: stream decoding framing before the catch block.
 */
import { describe, expect, it } from "bun:test";
import { AnthropicApiError, type FinalizeResult, Flag, finalize, isClassified, ProviderHttpError } from "../src/error";
import { type AbortSourceTracker, createAbortSourceTracker } from "../src/utils/abort";

/** A tracker whose caller signal has already aborted, built the way a provider builds one. */
function callerAbortedTracker(): AbortSourceTracker {
	const caller = new AbortController();
	caller.abort(new Error("caller cancelled the turn"));
	return createAbortSourceTracker(caller.signal);
}

/** A tracker aborted by provider-local logic, carrying the local reason the watchdog raised. */
function locallyAbortedTracker(reason: Error): AbortSourceTracker {
	const tracker = createAbortSourceTracker();
	tracker.abortLocally(reason);
	return tracker;
}

describe("finalize error bundle end states", () => {
	describe("classified failure", () => {
		it("bundles Anthropic 401 auth failure with classified id, status, rules, and message", async () => {
			const headers = new Headers({ "request-id": "req_123" });
			const error = new AnthropicApiError(401, "401 Unauthorized: invalid x-api-key", headers);

			const result: FinalizeResult = await finalize(error, {
				api: "anthropic-messages",
				provider: "anthropic",
			});

			expect(result.status).toBe(401);
			expect(isClassified(result.id)).toBe(true);
			expect((result.id & Flag.AuthFailed) !== 0).toBe(true);
			expect(result.stopReason).toBe("error");
			expect(result.logLevel).toBe("error");
			expect(result.rules.length).toBeGreaterThan(0);
			expect(result.rules).toContain("auth-failure-prose");
			expect(result.message).toContain("401 Unauthorized: invalid x-api-key");
		});

		it("bundles prompt context overflow with ContextOverflow flag and compact remedy", async () => {
			const error = Object.assign(new Error("prompt is too long: 250000 tokens > 200000 maximum"), { status: 400 });

			const result = await finalize(error, { api: "anthropic-messages" });

			expect(result.status).toBe(400);
			expect(isClassified(result.id)).toBe(true);
			expect((result.id & Flag.ContextOverflow) !== 0).toBe(true);
			expect(result.stopReason).toBe("error");
			expect(result.logLevel).toBe("error");
			expect(result.rules).toContain("context-overflow-prose");
			expect(result.message).toContain("prompt is too long");
		});

		it("preserves stated retry-after window in the finalized message", async () => {
			const headers = new Headers({ "retry-after": "45" });
			const error = new ProviderHttpError("Rate limit exceeded", 429, { headers });

			const result = await finalize(error, { provider: "openai" });

			expect(result.status).toBe(429);
			expect((result.id & Flag.Transient) !== 0).toBe(true);
			expect(result.message).toContain("retry-after-ms=45000");
		});
	});

	describe("unclassified failure carrying only a status", () => {
		it("returns unclassified raw status id when error carries a non-standard HTTP status", async () => {
			const error = Object.assign(new Error("I'm a teapot"), { status: 418 });

			const result = await finalize(error);

			expect(result.status).toBe(418);
			expect(result.id).toBe(418);
			expect(isClassified(result.id)).toBe(false);
			expect(result.stopReason).toBe("error");
			expect(result.logLevel).toBe("error");
			expect(result.rules).toEqual([]);
			expect(result.message).toBe("I'm a teapot");
		});

		it("extracts status from capturedErrorResponse when error itself has no status", async () => {
			const error = new Error("Unknown proxy error");
			const capturedErrorResponse = {
				status: 502,
				statusText: "Bad Gateway",
				headers: new Headers(),
				bodyText: "Unknown proxy response",
			};

			const result = await finalize(error, { capturedErrorResponse });

			expect(result.status).toBe(502);
			expect(result.id).toBe(502);
			expect(isClassified(result.id)).toBe(false);
			expect(result.stopReason).toBe("error");
			expect(result.logLevel).toBe("error");
		});

		it("classifies bare 429 with no wording as UsageLimit wall rather than a transient throttle", async () => {
			const bare429 = { status: 429 };

			const result = await finalize(bare429);

			expect(result.status).toBe(429);
			expect(isClassified(result.id)).toBe(true);
			expect((result.id & Flag.UsageLimit) !== 0).toBe(true);
			expect(result.rules).toContain("opaque-or-exhausted-429");
		});
	});

	describe("failure with no wording at all", () => {
		it("handles undefined, null, empty object, and empty string without throwing", async () => {
			const undefinedResult = await finalize(undefined);
			expect(undefinedResult.id).toBe(0);
			expect(undefinedResult.status).toBeUndefined();
			expect(undefinedResult.stopReason).toBe("error");
			expect(undefinedResult.logLevel).toBe("error");
			expect(undefinedResult.rules).toEqual([]);
			expect(undefinedResult.message.length).toBeGreaterThan(0);

			const nullResult = await finalize(null);
			expect(nullResult.id).toBe(0);
			expect(nullResult.status).toBeUndefined();
			expect(nullResult.message.length).toBeGreaterThan(0);

			const emptyObjResult = await finalize({});
			expect(emptyObjResult.id).toBe(0);
			expect(emptyObjResult.status).toBeUndefined();
			expect(emptyObjResult.message.length).toBeGreaterThan(0);

			const emptyStrResult = await finalize("");
			expect(emptyStrResult.id).toBe(0);
			expect(emptyStrResult.message.length).toBeGreaterThan(0);
		});
	});

	describe("cancellation and abort tracking", () => {
		it("derives stopReason: aborted and logLevel: debug from AbortSignal.aborted", async () => {
			const controller = new AbortController();
			controller.abort();

			const error = new DOMException("The operation was aborted", "AbortError");
			const result = await finalize(error, { signal: controller.signal });

			expect(result.stopReason).toBe("aborted");
			expect(result.logLevel).toBe("debug");
			expect((result.id & Flag.Abort) !== 0).toBe(true);
		});

		it("derives stopReason: aborted and logLevel: debug from AbortSourceTracker caller abort", async () => {
			const abortTracker = callerAbortedTracker();

			const error = new Error("Connection aborted");
			const result = await finalize(error, { abortTracker });

			expect(result.stopReason).toBe("aborted");
			expect(result.logLevel).toBe("debug");
		});

		it("caller abort dominates over 500 error status in stopReason and logLevel", async () => {
			const abortTracker = callerAbortedTracker();

			const error = Object.assign(new Error("500 Internal Server Error"), { status: 500 });
			const result = await finalize(error, { abortTracker });

			expect(result.status).toBe(500);
			expect(result.stopReason).toBe("aborted");
			expect(result.logLevel).toBe("debug");
		});

		it("uses local abort reason message when abortTracker provides a local timeout", async () => {
			const localTimeoutReason = new Error("Stream first-event stall deadline elapsed (15000ms)");
			const abortTracker = locallyAbortedTracker(localTimeoutReason);

			const error = new Error("Generic fetch abort");
			const result = await finalize(error, { abortTracker });

			expect(result.stopReason).toBe("error");
			expect(result.logLevel).toBe("error");
			expect(result.message).toBe("Stream first-event stall deadline elapsed (15000ms)");
		});
	});

	describe("surfaced error remedies and provider-specific rewrites", () => {
		it("rewrites Ollama tool-call JSON parse error to explain llama.cpp rejection and state remedy", async () => {
			const error = Object.assign(
				new Error("500 Internal Server Error: failed to parse tool call arguments as json"),
				{ status: 500 },
			);

			const result = await finalize(error, { provider: "ollama" });

			expect(result.status).toBe(500);
			expect(result.message).toContain(
				"The local model emitted malformed tool-call JSON and llama.cpp rejected it (HTTP 500)",
			);
			expect(result.message).toContain("reload the model or reduce context, then retry");
			expect(result.rules).toContain("llama-cpp-tool-call-parse-clears-transient");
			expect((result.id & Flag.Transient) !== 0).toBe(false);
		});
	});
});
