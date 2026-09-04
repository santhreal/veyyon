/**
 * Multi-hunk SWAP of lines 1..=20 to unique bodies in one patch (diagonal renumber).
 * Why: full concurrent single-line SWAP must not see mid-patch content shifts.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits past 6000 SWAP diagonal n20", () => {
	const n = 20;
	const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
	const base = lines.join("\n");

	it("SWAP all to D{i} in one patch", () => {
		const hunks = Array.from({ length: n }, (_, i) => `SWAP ${i + 1}.=${i + 1}:\n+D${i + 1}`).join("\n");
		const { text } = applyEdits(base, parsePatch(hunks).edits);
		expect(text.split("\n")).toEqual(Array.from({ length: n }, (_, i) => `D${i + 1}`));
	});

	it("SWAP reverse content mapping", () => {
		const hunks = Array.from({ length: n }, (_, i) => `SWAP ${i + 1}.=${i + 1}:\n+L${n - i}`).join("\n");
		const { text } = applyEdits(base, parsePatch(hunks).edits);
		expect(text.split("\n")).toEqual(Array.from({ length: n }, (_, i) => `L${n - i}`));
	});

	it("SWAP only odd lines", () => {
		const hunks = Array.from({ length: n }, (_, i) => {
			const line = i + 1;
			if (line % 2 === 0) return null;
			return `SWAP ${line}.=${line}:\n+O${line}`;
		})
			.filter(Boolean)
			.join("\n");
		const { text } = applyEdits(base, parsePatch(hunks).edits);
		const out = text.split("\n");
		for (let i = 0; i < n; i++) {
			if ((i + 1) % 2 === 1) expect(out[i]).toBe(`O${i + 1}`);
			else expect(out[i]).toBe(`L${i + 1}`);
		}
	});
});
