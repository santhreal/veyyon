import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

/**
 * Sequential INS.HEAD stacks in reverse order.
 */

function text(lines: string[]): string {
	return `${lines.join("\n")}\n`;
}

function apply(src: string, diff: string): string {
	return applyEdits(src, parsePatch(diff).edits).text;
}

describe("sequential INS.HEAD many", () => {
	it("prepending 1..10 stacks newest at top", () => {
		let cur = text(["0"]);
		for (let i = 1; i <= 10; i++) {
			cur = apply(cur, `INS.HEAD:\n+${i}`);
		}
		const lines = cur.split("\n").filter((l, i, a) => i < a.length - 1 || l);
		expect(lines[0]).toBe("10");
		expect(lines[lines.length - 1]).toBe("0");
		expect(lines).toHaveLength(11);
		expect(lines).toEqual(["10", "9", "8", "7", "6", "5", "4", "3", "2", "1", "0"]);
	});
});
