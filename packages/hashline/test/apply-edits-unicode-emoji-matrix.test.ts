/**
 * applyEdits with emoji and multi-byte unicode at every position.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

const glyphs = ["☃", "日本語", "café", "🚀", "Ω", "مرحبا"];

describe("applyEdits unicode/emoji matrix", () => {
	for (const g of glyphs) {
		it(`SWAP to ${g}`, () => {
			const { text } = applyEdits("x\ny", parsePatch(`SWAP 1.=1:\n+${g}`).edits);
			expect(text).toBe(`${g}\ny`);
		});
		it(`INS.HEAD ${g}`, () => {
			const { text } = applyEdits("body", parsePatch(`INS.HEAD:\n+${g}`).edits);
			expect(text).toBe(`${g}\nbody`);
		});
		it(`INS.TAIL ${g}`, () => {
			const { text } = applyEdits("body", parsePatch(`INS.TAIL:\n+${g}`).edits);
			expect(text).toBe(`body\n${g}`);
		});
	}
});
