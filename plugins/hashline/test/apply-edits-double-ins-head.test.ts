import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

/**
 * Sequential double INS.HEAD / INS.TAIL.
 */

function text(lines: string[]): string {
	return `${lines.join("\n")}\n`;
}

function apply(src: string, diff: string): string {
	return applyEdits(src, parsePatch(diff).edits).text;
}

describe("double INS.HEAD / INS.TAIL sequential", () => {
	it("two HEAD inserts stack in reverse chronological order at top", () => {
		let cur = text(["body"]);
		cur = apply(cur, "INS.HEAD:\n+H1");
		cur = apply(cur, "INS.HEAD:\n+H2");
		expect(cur).toBe(text(["H2", "H1", "body"]));
	});

	it("two TAIL inserts stack in order at bottom", () => {
		let cur = text(["body"]);
		cur = apply(cur, "INS.TAIL:\n+T1");
		cur = apply(cur, "INS.TAIL:\n+T2");
		expect(cur).toBe(text(["body", "T1", "T2"]));
	});
});
