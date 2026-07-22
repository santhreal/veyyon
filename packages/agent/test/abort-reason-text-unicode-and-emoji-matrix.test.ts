/**
 * abortReasonText string reasons with unicode and emoji pass through exact.
 */
import { describe, expect, it } from "bun:test";
import { abortReasonText } from "@veyyon/agent-core/agent-loop";

describe("abortReasonText unicode and emoji matrix", () => {
	const cases = [
		"日本語 abort",
		"café stop",
		"🚀 cancel",
		"stop\u0000null",
		"مرحبا",
		"Здравствуй",
		"a".repeat(1000),
	];

	for (const msg of cases) {
		it(`passes through ${JSON.stringify(msg).slice(0, 40)}`, () => {
			const c = new AbortController();
			c.abort(msg);
			expect(abortReasonText(c.signal)).toBe(msg);
		});
	}
});
