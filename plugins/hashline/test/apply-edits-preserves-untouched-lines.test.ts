import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

/**
 * Untouched lines keep exact original content after edits elsewhere.
 */

function text(lines: string[]): string {
	return `${lines.join("\n")}\n`;
}

function apply(src: string, diff: string): string {
	return applyEdits(src, parsePatch(diff).edits).text;
}

describe("applyEdits preserves untouched lines", () => {
	it("SWAP first leaves all other lines identical", () => {
		const lines = Array.from({ length: 10 }, (_, i) => `exact-${i}-content`);
		const src = text(lines);
		const out = apply(src, "SWAP 1.=1:\n+CHANGED");
		const result = out.split("\n").filter((l, i, a) => i < a.length - 1 || l);
		expect(result[0]).toBe("CHANGED");
		for (let i = 1; i < 10; i++) {
			expect(result[i]).toBe(lines[i]!);
		}
	});

	it("DEL last leaves prefix identical", () => {
		const lines = ["A", "B", "C", "D"];
		const src = text(lines);
		const out = apply(src, "DEL 4.=4");
		expect(out).toBe(text(["A", "B", "C"]));
	});

	it("INS.TAIL leaves prefix identical", () => {
		const lines = ["A", "B"];
		const src = text(lines);
		const out = apply(src, "INS.TAIL:\n+C");
		expect(out).toBe(text(["A", "B", "C"]));
	});
});
