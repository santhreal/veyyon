import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

/**
 * SWAP with unicode bodies across multiple line positions.
 */

function text(lines: string[]): string {
	return `${lines.join("\n")}\n`;
}

function apply(src: string, diff: string): string {
	return applyEdits(src, parsePatch(diff).edits).text;
}

describe("SWAP unicode matrix", () => {
	const glyphs = ["日", "本", "語", "🙂", "é", "Ω", "中"];

	it("replaces each line with a unicode glyph", () => {
		const src = text(glyphs.map((_, i) => `L${i}`));
		for (let i = 0; i < glyphs.length; i++) {
			const out = apply(src, `SWAP ${i + 1}.=${i + 1}:\n+${glyphs[i]}`);
			const lines = out.split("\n").filter((l, idx, a) => idx < a.length - 1 || l);
			expect(lines[i]).toBe(glyphs[i]!);
		}
	});

	it("replaces entire file of unicode with one line", () => {
		const src = text(["一", "二", "三"]);
		const out = apply(src, "SWAP 1.=3:\n+合");
		expect(out).toBe(text(["合"]));
	});

	it("emoji multi-line body swap", () => {
		const src = text(["x"]);
		const out = apply(src, "SWAP 1.=1:\n+🙂\n+🎉");
		expect(out).toBe(text(["🙂", "🎉"]));
	});
});
