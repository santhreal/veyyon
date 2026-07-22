import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

/**
 * SWAP that replaces a line with itself still produces a result equal to source.
 */

function text(lines: string[]): string {
	return `${lines.join("\n")}\n`;
}

describe("applyEdits noop SWAP", () => {
	it("SWAP line to same content leaves text equal", () => {
		const src = text(["same", "other"]);
		const out = applyEdits(src, parsePatch("SWAP 1.=1:\n+same").edits).text;
		expect(out).toBe(src);
	});

	it("SWAP each line to itself preserves whole file", () => {
		const lines = ["a", "b", "c", "d"];
		const src = text(lines);
		const hunks = lines.map((l, i) => `SWAP ${i + 1}.=${i + 1}:\n+${l}`).join("\n");
		const out = applyEdits(src, parsePatch(hunks).edits).text;
		expect(out).toBe(src);
	});
});
