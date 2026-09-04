import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

/**
 * Build a list by repeatedly INS.POST on the last line.
 */

function text(lines: string[]): string {
	return `${lines.join("\n")}\n`;
}

function apply(src: string, diff: string): string {
	return applyEdits(src, parsePatch(diff).edits).text;
}

function count(s: string): number {
	if (s === "" || s === "\n") return 0;
	return s.replace(/\n$/, "").split("\n").length;
}

describe("INS.POST chain build list", () => {
	it("appending after last line 10 times grows by 10", () => {
		let cur = text(["start"]);
		for (let i = 1; i <= 10; i++) {
			const last = count(cur);
			cur = apply(cur, `INS.POST ${last}:\n+item${i}`);
		}
		const lines = cur.split("\n").filter((l, i, a) => i < a.length - 1 || l);
		expect(lines[0]).toBe("start");
		expect(lines).toHaveLength(11);
		expect(lines[10]).toBe("item10");
	});
});
