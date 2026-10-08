import { describe, expect, it } from "bun:test";
import { createCodexProviderStreamError, isRetryableCodexFailureEvent } from "../openai-codex-responses";

describe("isRetryableCodexFailureEvent", () => {
	it("classifies retryable codes from nested error.code, error.type, then rawEvent.code", () => {
		expect(isRetryableCodexFailureEvent({ error: { code: "server_error" } })).toBe(true);
		expect(isRetryableCodexFailureEvent({ error: { type: "internal_error" } })).toBe(true);
		expect(isRetryableCodexFailureEvent({ code: "model_error" })).toBe(true);
	});

	it("prefers nested error.code over the top-level code (matching the factory)", () => {
		// The error.code chain wins, so a non-retryable nested code with no retryable message
		// is NOT retryable even though the top-level code is retryable.
		expect(isRetryableCodexFailureEvent({ code: "server_error", error: { code: "bad_request" } })).toBe(false);
	});

	it("detects retryable messages when the code is absent or unknown", () => {
		expect(isRetryableCodexFailureEvent({ message: "Please retry your request shortly" })).toBe(true);
		expect(isRetryableCodexFailureEvent({ code: "bad_request", message: "we are overloaded" })).toBe(true);
		expect(isRetryableCodexFailureEvent({ response: { message: "service unavailable" } })).toBe(true);
	});

	it("returns false for non-retryable code and message", () => {
		expect(isRetryableCodexFailureEvent({ code: "bad_request", message: "invalid input" })).toBe(false);
		expect(isRetryableCodexFailureEvent({})).toBe(false);
	});

	it("falls back to response.error when rawEvent.error is not an object", () => {
		expect(isRetryableCodexFailureEvent({ error: "boom", response: { error: { code: "server_error" } } })).toBe(true);
	});

	it("ignores mistyped fields instead of failing the whole parse", () => {
		// A numeric top-level `code` must not poison parsing; the retryable message is still honored.
		expect(isRetryableCodexFailureEvent({ code: 500, message: "internal error while processing" })).toBe(true);
		// Same tolerance nested: a non-string error.code is dropped while a valid error.message survives.
		expect(isRetryableCodexFailureEvent({ error: { code: 123, message: "server error happened" } })).toBe(true);
	});
});

describe("createCodexProviderStreamError", () => {
	it("prefers nested error.code over the top-level code (aligned with isRetryable)", () => {
		expect(createCodexProviderStreamError({ code: "outer_code", error: { code: "inner_code" } }).code).toBe(
			"inner_code",
		);
	});

	it("falls back to nested error.code then error.type", () => {
		expect(createCodexProviderStreamError({ error: { code: "inner_code" } }).code).toBe("inner_code");
		expect(createCodexProviderStreamError({ error: { type: "inner_type" } }).code).toBe("inner_type");
	});

	it("leaves code undefined when nothing supplies one", () => {
		expect(createCodexProviderStreamError({ message: "boom" }).code).toBeUndefined();
	});

	it("marks retryable error events and formats them as error events", () => {
		const err = createCodexProviderStreamError({ type: "error", code: "server_error", message: "kaboom" });
		expect(err.retryable).toBe(true);
		expect(err.code).toBe("server_error");
		expect(err.message).toContain("error event");
		expect(err.message).toContain("kaboom");
	});

	it("formats non-error failures via the response-failure path", () => {
		const err = createCodexProviderStreamError({
			type: "response.failed",
			response: { error: { message: "downstream blew up" } },
		});
		expect(err.retryable).toBe(false);
		expect(err.code).toBeUndefined();
		expect(err.message).toContain("response failed");
		expect(err.message).toContain("downstream blew up");
	});

	it("falls back to response.error when rawEvent.error is not an object", () => {
		const err = createCodexProviderStreamError({
			error: "boom",
			response: { error: { code: "server_error", message: "nested boom" } },
		});
		expect(err.code).toBe("server_error");
		expect(err.retryable).toBe(true);
		expect(err.message).toContain("nested boom");
	});
});

// Rate-limit and policy classifiers parse these messages (`parseRateLimitReason`, the provider error
// fixtures), so every formatting branch is pinned to its exact bytes under both labels.
describe("the Codex failure message", () => {
	const cases: Array<[string, Record<string, unknown>, string]> = [
		[
			"message with code and status",
			{ type: "response.failed", response: { status: "failed", error: { code: "server_error", message: "boom" } } },
			"Codex response failed: boom (code=server_error, status=failed)",
		],
		[
			"error event message with code",
			{ type: "error", code: "usage_limit_reached", message: "The usage limit has been reached" },
			"Codex error event: The usage limit has been reached (code=usage_limit_reached)",
		],
		["error event message alone", { type: "error", message: "boom" }, "Codex error event: boom"],
		[
			"error event message that itself says response failed",
			{ type: "error", message: "upstream response failed" },
			"Codex error event: upstream response failed",
		],
		[
			"nested message and status win over the top-level ones",
			{
				type: "error",
				message: "outer",
				status: "outer",
				error: { message: "inner" },
				response: { status: "inner" },
			},
			"Codex error event: inner (status=inner)",
		],
		[
			"status alone",
			{ type: "response.failed", response: { status: "incomplete" } },
			"Codex response failed (status=incomplete)",
		],
		[
			"error type alone",
			{ type: "error", error: { type: "invalid_request_error" } },
			"Codex error event (code=invalid_request_error)",
		],
		[
			"no fields: the raw event as JSON",
			{ type: "response.failed", response: { id: "resp_1" } },
			'Codex response failed: {"type":"response.failed","response":{"id":"resp_1"}}',
		],
		["error event with no fields", { type: "error" }, 'Codex error event: {"type":"error"}'],
	];

	it.each(cases)("%s", (_name, rawEvent, expected) => {
		expect(createCodexProviderStreamError(rawEvent).message).toBe(expected);
	});

	it("an event that cannot serialize falls back to the bare label", () => {
		for (const [type, expected] of [
			["error", "Codex error event"],
			["response.failed", "Codex response failed"],
		] as const) {
			const circular: Record<string, unknown> = { type };
			circular.self = circular;
			expect(createCodexProviderStreamError(circular).message).toBe(expected);
		}
	});

	it("the raw event is cut at 800 characters and states how many it dropped", () => {
		const padded = (n: number) => ({ type: "response.failed", padding: "p".repeat(n) });
		const fits = padded(800 - JSON.stringify(padded(0)).length);
		expect(createCodexProviderStreamError(fits).message).toBe(`Codex response failed: ${JSON.stringify(fits)}`);

		const over = padded(801 - JSON.stringify(padded(0)).length);
		const json = JSON.stringify(over);
		expect(createCodexProviderStreamError(over).message).toBe(
			`Codex response failed: ${json.slice(0, 800)}…[truncated 1]`,
		);
	});
});
