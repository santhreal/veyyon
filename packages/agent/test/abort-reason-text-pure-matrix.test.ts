/**
 * abortReasonText surfaces AbortController.abort(reason) on assistant
 * errorMessage. Bare abort / default AbortError → generic sentinel.
 * String and non-AbortError Error reasons pass through.
 */
import { describe, expect, it } from "bun:test";
import { abortReasonText } from "@veyyon/agent-core/agent-loop";

describe("abortReasonText pure matrix", () => {
	it("undefined signal → generic sentinel", () => {
		expect(abortReasonText(undefined)).toBe("Request was aborted");
	});

	it("live non-aborted signal → generic sentinel", () => {
		const c = new AbortController();
		expect(abortReasonText(c.signal)).toBe("Request was aborted");
	});

	it("bare abort() → generic sentinel", () => {
		const c = new AbortController();
		c.abort();
		expect(abortReasonText(c.signal)).toBe("Request was aborted");
	});

	it("string reason passes through", () => {
		const c = new AbortController();
		c.abort("Interrupted by user");
		expect(abortReasonText(c.signal)).toBe("Interrupted by user");
	});

	it("whitespace-only string falls back to generic", () => {
		const c = new AbortController();
		c.abort("   ");
		expect(abortReasonText(c.signal)).toBe("Request was aborted");
	});

	it("empty string falls back to generic", () => {
		const c = new AbortController();
		c.abort("");
		expect(abortReasonText(c.signal)).toBe("Request was aborted");
	});

	it("Error reason with non-AbortError name passes message", () => {
		const c = new AbortController();
		c.abort(new Error("tool boom"));
		expect(abortReasonText(c.signal)).toBe("tool boom");
	});

	it("Error with empty message falls back", () => {
		const c = new AbortController();
		const err = new Error("   ");
		err.name = "CustomError";
		c.abort(err);
		expect(abortReasonText(c.signal)).toBe("Request was aborted");
	});

	it("AbortError DOMException-like falls back (name AbortError)", () => {
		const c = new AbortController();
		const err = new Error("The operation was aborted.");
		err.name = "AbortError";
		c.abort(err);
		expect(abortReasonText(c.signal)).toBe("Request was aborted");
	});

	it("numeric reason is not a string → generic", () => {
		const c = new AbortController();
		c.abort(42 as unknown as string);
		expect(abortReasonText(c.signal)).toBe("Request was aborted");
	});
});
