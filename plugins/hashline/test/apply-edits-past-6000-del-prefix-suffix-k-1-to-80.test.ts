/**
 * DEL prefix 1..=k and suffix (n-k+1).=n for k=1..80 on n=80.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits past 6000 DEL prefix and suffix k 1 to 80", () => {
	const n = 80;
	const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
	const base = lines.join("\n");

	for (let k = 1; k <= n; k++) {
		it(`DEL prefix 1..=${k}`, () => {
			const { text } = applyEdits(base, parsePatch(`DEL 1.=${k}`).edits);
			const out = text === "" ? [] : text.split("\n");
			expect(out).toEqual(lines.slice(k));
		});

		it(`DEL suffix ${n - k + 1}..=${n}`, () => {
			const start = n - k + 1;
			const { text } = applyEdits(base, parsePatch(`DEL ${start}.=${n}`).edits);
			const out = text === "" ? [] : text.split("\n");
			expect(out).toEqual(lines.slice(0, n - k));
		});
	}
});
