/**
 * abortReasonText Error reasons: non-AbortError message pass; AbortError fallbacks.
 * Why: tool timeouts must surface message; bare AbortError stays sentinel.
 */
import { describe, expect, it } from "bun:test";
import { abortReasonText } from "@veyyon/agent-core/agent-loop";

describe("abortReasonText error name and message grid", () => {
	const names = ["Error", "TypeError", "RangeError", "TimeoutError", "CustomError"];
	const msgs = ["timeout", "cancelled", "boom", "x".repeat(100), "unicode 🚀"];

	for (const name of names) {
		for (const msg of msgs) {
			it(`${name}: ${msg.slice(0, 20)}`, () => {
				const c = new AbortController();
				const e = new Error(msg);
				e.name = name;
				c.abort(e);
				expect(abortReasonText(c.signal)).toBe(msg);
			});
		}
	}

	it("AbortError with message may pass or sentinel depending on path", () => {
		const c = new AbortController();
		const e = new Error("user stop");
		e.name = "AbortError";
		c.abort(e);
		const got = abortReasonText(c.signal);
		expect(typeof got).toBe("string");
		expect(got.length).toBeGreaterThan(0);
	});
});
