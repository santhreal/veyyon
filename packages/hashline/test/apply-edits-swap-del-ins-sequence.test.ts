import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

/**
 * Longer sequential pure edit chains.
 */

function text(lines: string[]): string {
	return `${lines.join("\n")}\n`;
}

function apply(src: string, diff: string): string {
	return applyEdits(src, parsePatch(diff).edits).text;
}

describe("SWAP DEL INS long sequence", () => {
	it("build file through a sequence of pure ops", () => {
		let cur = text(["seed"]);
		cur = apply(cur, "INS.TAIL:\n+a");
		cur = apply(cur, "INS.TAIL:\n+b");
		cur = apply(cur, "SWAP 1.=1:\n+SEED");
		cur = apply(cur, "DEL 2.=2");
		cur = apply(cur, "INS.HEAD:\n+H");
		expect(cur).toBe(text(["H", "SEED", "b"]));
	});
});
