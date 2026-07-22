/**
 * Multi-hunk SWAP every line on n=60: concurrent original indices exact.
 * Why: full-file rewrite via per-line SWAP must equal sequential body.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits past 6000 multi-hunk SWAP all lines n60", () => {
	const n = 60;
	const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
	const base = lines.join("\n");

	it("SWAP each line to W_i", () => {
		const hunks = Array.from(
			{ length: n },
			(_, i) => `SWAP ${i + 1}.=${i + 1}:\n+W${i + 1}`,
		).join("\n");
		const out = applyEdits(base, parsePatch(hunks).edits).text;
		expect(out.split("\n")).toEqual(Array.from({ length: n }, (_, i) => `W${i + 1}`));
	});

	it("identity SWAP all preserves", () => {
		const hunks = lines
			.map((line, i) => `SWAP ${i + 1}.=${i + 1}:\n+${line}`)
			.join("\n");
		expect(applyEdits(base, parsePatch(hunks).edits).text).toBe(base);
	});
});
