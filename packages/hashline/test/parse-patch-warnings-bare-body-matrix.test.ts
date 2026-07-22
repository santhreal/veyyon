import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

/**
 * Bare body auto-prefix matrix: | and bare text under SWAP.
 */

function text(lines: string[]): string {
	return `${lines.join("\n")}\n`;
}

describe("parsePatch bare body auto-prefix matrix", () => {
	it("pipe-prefixed body becomes literal pipe content after auto-prefix", () => {
		const { edits, warnings } = parsePatch("SWAP 1.=1:\n|hello");
		expect(warnings.length).toBeGreaterThan(0);
		const out = applyEdits(text(["x"]), edits).text;
		expect(out).toContain("|hello");
	});

	it("multiple bare body lines each get auto-prefixed", () => {
		const { edits, warnings } = parsePatch("SWAP 1.=1:\n|a\n|b");
		expect(warnings.length).toBeGreaterThan(0);
		const out = applyEdits(text(["x"]), edits).text;
		expect(out).toContain("|a");
		expect(out).toContain("|b");
	});

	it("proper + body has no auto-prefix warning", () => {
		const { edits, warnings } = parsePatch("SWAP 1.=1:\n+ok");
		expect(warnings).toEqual([]);
		const out = applyEdits(text(["x"]), edits).text;
		expect(out).toBe(text(["ok"]));
	});
});
