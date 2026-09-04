/**
 * Multi-hunk SWAP every line of n=120 in one patch.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits past 6000 SWAP all lines one patch n120", () => {
	const n = 120;
	const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
	const base = lines.join("\n");

	it("SWAP every line to R{i}", () => {
		const hunks = Array.from({ length: n }, (_, i) => `SWAP ${i + 1}.=${i + 1}:\n+R${i + 1}`).join("\n");
		expect(applyEdits(base, parsePatch(hunks).edits).text.split("\n")).toEqual(
			Array.from({ length: n }, (_, i) => `R${i + 1}`),
		);
	});

	it("identity", () => {
		const hunks = Array.from({ length: n }, (_, i) => `SWAP ${i + 1}.=${i + 1}:\n+L${i + 1}`).join("\n");
		expect(applyEdits(base, parsePatch(hunks).edits).text).toBe(base);
	});
});
