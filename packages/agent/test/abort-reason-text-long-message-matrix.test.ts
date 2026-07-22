/**
 * abortReasonText long and multi-line string reasons pass through unchanged.
 * Why: truncation of abort reason would hide operator interrupt detail.
 */
import { describe, expect, it } from "bun:test";
import { abortReasonText } from "@veyyon/agent-core/agent-loop";

describe("abortReasonText long message matrix", () => {
	const GENERIC = "Request was aborted";

	for (const len of [1, 10, 100, 500, 2000]) {
		it(`string length ${len} passes through`, () => {
			const msg = "x".repeat(len);
			const c = new AbortController();
			c.abort(msg);
			expect(abortReasonText(c.signal)).toBe(msg);
		});
	}

	it("multi-line reason preserved", () => {
		const msg = "line1\nline2\nline3";
		const c = new AbortController();
		c.abort(msg);
		expect(abortReasonText(c.signal)).toBe(msg);
	});

	it("Error with long message", () => {
		const msg = "e".repeat(300);
		const c = new AbortController();
		const err = new Error(msg);
		err.name = "CustomError";
		c.abort(err);
		expect(abortReasonText(c.signal)).toBe(msg);
	});

	it("Error message with only newlines falls back", () => {
		const c = new AbortController();
		const err = new Error("\n\n");
		err.name = "CustomError";
		c.abort(err);
		expect(abortReasonText(c.signal)).toBe(GENERIC);
	});
});
