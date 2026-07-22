/**
 * abortReasonText string reasons length 1..200 pass through exactly.
 * Why: operator interrupt messages must not be truncated or collapsed to sentinel.
 */
import { describe, expect, it } from "bun:test";
import { abortReasonText } from "@veyyon/agent-core/agent-loop";

describe("abortReasonText string length 1 to 200 matrix", () => {
	for (let n = 1; n <= 200; n++) {
		it(`len=${n}`, () => {
			const reason = "r".repeat(n);
			const c = new AbortController();
			c.abort(reason);
			expect(abortReasonText(c.signal)).toBe(reason);
		});
	}

	it("Error reason message passes", () => {
		const c = new AbortController();
		c.abort(new Error("tool timed out"));
		expect(abortReasonText(c.signal)).toBe("tool timed out");
	});

	it("AbortError name with empty message → sentinel", () => {
		const c = new AbortController();
		const e = new Error("");
		e.name = "AbortError";
		c.abort(e);
		const got = abortReasonText(c.signal);
		expect(typeof got).toBe("string");
		expect(got.length).toBeGreaterThan(0);
	});
});
