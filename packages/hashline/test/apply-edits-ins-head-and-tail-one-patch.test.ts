import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

/**
 * INS.HEAD and INS.TAIL in a single patch.
 */

function text(lines: string[]): string {
	return `${lines.join("\n")}\n`;
}

function apply(src: string, diff: string): string {
	return applyEdits(src, parsePatch(diff).edits).text;
}

describe("INS.HEAD and INS.TAIL one patch", () => {
	it("adds head and tail around body", () => {
		const out = apply(text(["mid"]), "INS.HEAD:\n+H\nINS.TAIL:\n+T");
		expect(out).toContain("H");
		expect(out).toContain("mid");
		expect(out).toContain("T");
		const lines = out.split("\n").filter((l, i, a) => i < a.length - 1 || l);
		expect(lines).toContain("H");
		expect(lines).toContain("mid");
		expect(lines).toContain("T");
		expect(lines).toHaveLength(3);
	});
});
