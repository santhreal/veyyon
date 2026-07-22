/**
 * Oscillating SWAP between A and B on one line: ends at expected phase.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

function apply(text: string, patch: string): string {
	return applyEdits(text, parsePatch(patch).edits).text;
}

describe("applyEdits oscillating SWAP A/B", () => {
	it("even count ends at A", () => {
		let t = "x\nA\nz";
		for (let i = 0; i < 10; i++) {
			const next = i % 2 === 0 ? "B" : "A";
			t = apply(t, `SWAP 2.=2:\n+${next}`);
		}
		expect(t).toBe("x\nA\nz");
	});

	it("odd count ends at B", () => {
		let t = "x\nA\nz";
		for (let i = 0; i < 11; i++) {
			const next = i % 2 === 0 ? "B" : "A";
			t = apply(t, `SWAP 2.=2:\n+${next}`);
		}
		expect(t).toBe("x\nB\nz");
	});
});
