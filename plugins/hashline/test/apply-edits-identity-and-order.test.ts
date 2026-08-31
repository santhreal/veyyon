import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

/**
 * applyEdits identity, order, and multi-edit non-interference on disjoint lines.
 */

function text(lines: string[]): string {
	return `${lines.join("\n")}\n`;
}

describe("applyEdits identity and order", () => {
	it("empty edits is identity for many bodies", () => {
		for (let n = 0; n <= 20; n++) {
			const src = text(Array.from({ length: n }, (_, i) => `L${i}`));
			expect(applyEdits(src, []).text).toBe(src);
		}
	});

	it("disjoint SWAPs commute in result content multiset", () => {
		const src = text(["A", "B", "C", "D"]);
		const ab = applyEdits(src, parsePatch("SWAP 1.=1:\n+A2\nSWAP 3.=3:\n+C2").edits).text;
		const ba = applyEdits(src, parsePatch("SWAP 3.=3:\n+C2\nSWAP 1.=1:\n+A2").edits).text;
		// Same final multiset of lines.
		expect(ab.split("\n").sort()).toEqual(ba.split("\n").sort());
		expect(ab).toContain("A2");
		expect(ab).toContain("C2");
	});

	it("double SWAP of the same anchor line is rejected as overlapping hunks", () => {
		// Parser validates no two hunks target the same anchor line.
		expect(() => parsePatch("SWAP 1.=1:\n+FIRST\nSWAP 1.=1:\n+SECOND")).toThrow(
			/already targeted|ONE hunk per range|overlap/i,
		);
	});

	it("unicode identity holds", () => {
		const src = text(["日本語", "🙂", "é"]);
		expect(applyEdits(src, []).text).toBe(src);
	});
});
