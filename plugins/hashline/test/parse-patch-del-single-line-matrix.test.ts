/**
 * parsePatch DEL N for N=1..20 exact anchor.
 */
import { describe, expect, it } from "bun:test";
import { parsePatch } from "../src/parser";

describe("parsePatch DEL single line 1..20", () => {
	for (let n = 1; n <= 20; n++) {
		it(`DEL ${n}`, () => {
			const { edits } = parsePatch(`DEL ${n}`);
			expect(edits).toHaveLength(1);
			if (edits[0]?.kind === "delete") expect(edits[0].anchor.line).toBe(n);
		});
	}
});
