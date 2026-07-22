import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

/**
 * DEL ranges that leave exactly one line.
 */

function text(lines: string[]): string {
	return `${lines.join("\n")}\n`;
}

function apply(src: string, diff: string): string {
	return applyEdits(src, parsePatch(diff).edits).text;
}

describe("DEL leave one line", () => {
	it("DEL 2.=N leaves first line", () => {
		const src = text(["A", "B", "C", "D"]);
		const out = apply(src, "DEL 2.=4");
		expect(out).toBe(text(["A"]));
	});

	it("DEL 1.=N-1 leaves last line", () => {
		const src = text(["A", "B", "C", "D"]);
		const out = apply(src, "DEL 1.=3");
		expect(out).toBe(text(["D"]));
	});
});
