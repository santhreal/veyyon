/**
 * Pure numeric body lines are content, not re-parsed as line refs.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits numeric-only body lines", () => {
	for (const body of ["0", "1", "42", "100", "9999", "007"]) {
		it(body, () => {
			const { text } = applyEdits("x", parsePatch(`SWAP 1.=1:\n+${body}`).edits);
			expect(text).toBe(body);
		});
	}

	it("multi-line numbers", () => {
		const { text } = applyEdits("x", parsePatch("SWAP 1.=1:\n+1\n+2\n+3").edits);
		expect(text).toBe("1\n2\n3");
	});
});
