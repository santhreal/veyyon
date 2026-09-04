/**
 * One patch: DEL first line and SWAP last line — disjoint ops exact.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits concurrent disjoint DEL and SWAP", () => {
	for (const n of [3, 5, 8, 12]) {
		it(`n=${n}`, () => {
			const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
			const base = lines.join("\n");
			const { text } = applyEdits(base, parsePatch(`DEL 1\nSWAP ${n}.=${n}:\n+Z`).edits);
			const out = text.split("\n");
			expect(out[0]).toBe("L2");
			expect(out[out.length - 1]).toBe("Z");
			expect(out).toHaveLength(n - 1);
		});
	}
});
