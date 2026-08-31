/**
 * Multi-hunk SWAP every line of n=25 in one patch: full-file renumber bodies.
 * Why: concurrent identity-index SWAPs must not see each other's renumber.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits past 6000 SWAP all lines one patch n25", () => {
	const n = 25;
	const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
	const base = lines.join("\n");

	it("SWAP every line to R{i}", () => {
		const hunks = Array.from({ length: n }, (_, i) => `SWAP ${i + 1}.=${i + 1}:\n+R${i + 1}`).join("\n");
		const { text } = applyEdits(base, parsePatch(hunks).edits);
		expect(text.split("\n")).toEqual(Array.from({ length: n }, (_, i) => `R${i + 1}`));
	});

	it("identity SWAP every line leaves file unchanged", () => {
		const hunks = Array.from({ length: n }, (_, i) => `SWAP ${i + 1}.=${i + 1}:\n+L${i + 1}`).join("\n");
		const { text } = applyEdits(base, parsePatch(hunks).edits);
		expect(text).toBe(base);
	});
});
