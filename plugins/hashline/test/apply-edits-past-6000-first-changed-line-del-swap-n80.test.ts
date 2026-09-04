/**
 * firstChangedLine for single-line DEL and SWAP on n=80.
 * Why: line-local ops must report the exact target as firstChangedLine.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits past 6000 firstChangedLine DEL SWAP n80", () => {
	const n = 80;
	const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
	const base = lines.join("\n");

	for (let line = 1; line <= n; line++) {
		it(`DEL ${line} firstChangedLine=${line}`, () => {
			const r = applyEdits(base, parsePatch(`DEL ${line}`).edits);
			expect(r.firstChangedLine).toBe(line);
			expect(r.text === "" ? [] : r.text.split("\n")).toEqual([...lines.slice(0, line - 1), ...lines.slice(line)]);
		});

		it(`SWAP ${line} firstChangedLine=${line}`, () => {
			const r = applyEdits(base, parsePatch(`SWAP ${line}.=${line}:\n+W${line}`).edits);
			expect(r.firstChangedLine).toBe(line);
			const out = r.text.split("\n");
			expect(out[line - 1]).toBe(`W${line}`);
			expect(out).toHaveLength(n);
		});
	}
});
