/**
 * DEL 1.=k for k=1..n on fixed file: remaining is exact suffix.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits DEL contiguous block as range", () => {
	const n = 10;
	const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
	const base = lines.join("\n");

	for (let k = 1; k <= n; k++) {
		it(`DEL 1.=${k}`, () => {
			const patch = k === 1 ? "DEL 1" : `DEL 1.=${k}`;
			const { text } = applyEdits(base, parsePatch(patch).edits);
			expect(text).toBe(lines.slice(k).join("\n"));
		});
	}

	for (let k = 1; k <= n; k++) {
		it(`DEL ${k}.=${n}`, () => {
			const patch = k === n ? `DEL ${n}` : `DEL ${k}.=${n}`;
			const { text } = applyEdits(base, parsePatch(patch).edits);
			expect(text).toBe(lines.slice(0, k - 1).join("\n"));
		});
	}
});
