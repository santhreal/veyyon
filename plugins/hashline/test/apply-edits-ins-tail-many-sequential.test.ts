import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

/**
 * Sequential INS.TAIL builds a list in order.
 */

function text(lines: string[]): string {
	return `${lines.join("\n")}\n`;
}

function apply(src: string, diff: string): string {
	return applyEdits(src, parsePatch(diff).edits).text;
}

describe("sequential INS.TAIL many", () => {
	it("appending 1..20 builds ascending list", () => {
		let cur = text(["0"]);
		for (let i = 1; i <= 20; i++) {
			cur = apply(cur, `INS.TAIL:\n+${i}`);
		}
		const lines = cur.split("\n").filter((l, i, a) => i < a.length - 1 || l);
		expect(lines).toEqual(Array.from({ length: 21 }, (_, i) => String(i)));
	});
});
