import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

/**
 * Sequential pure apply chains: DEL then SWAP on the new text.
 */

function text(lines: string[]): string {
	return `${lines.join("\n")}\n`;
}

function apply(src: string, diff: string): string {
	return applyEdits(src, parsePatch(diff).edits).text;
}

describe("DEL then SWAP chain", () => {
	it("delete middle then swap first of remainder", () => {
		const mid = apply(text(["A", "B", "C", "D"]), "DEL 2.=3");
		expect(mid).toBe(text(["A", "D"]));
		const next = apply(mid, "SWAP 1.=1:\n+A2");
		expect(next).toBe(text(["A2", "D"]));
	});

	it("delete first then swap new first", () => {
		const mid = apply(text(["A", "B", "C"]), "DEL 1.=1");
		expect(mid).toBe(text(["B", "C"]));
		const next = apply(mid, "SWAP 1.=1:\n+B2");
		expect(next).toBe(text(["B2", "C"]));
	});

	it("delete last then swap last remaining", () => {
		const mid = apply(text(["A", "B", "C"]), "DEL 3.=3");
		expect(mid).toBe(text(["A", "B"]));
		const next = apply(mid, "SWAP 2.=2:\n+B2");
		expect(next).toBe(text(["A", "B2"]));
	});

	it("repeated single-line DEL shrinks the file to empty", () => {
		let cur = text(["A", "B", "C"]);
		for (let i = 0; i < 3; i++) {
			cur = apply(cur, "DEL 1.=1");
		}
		expect(cur === "" || cur === "\n").toBe(true);
	});
});
