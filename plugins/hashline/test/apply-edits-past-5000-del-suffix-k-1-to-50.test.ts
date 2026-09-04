/**
 * DEL last k for k=1..50 on n=60 file.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits past 5000 DEL suffix k 1 to 50", () => {
	const n = 60;
	const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
	const base = lines.join("\n");

	for (let k = 1; k <= 50; k++) {
		it(`k=${k}`, () => {
			const start = n - k + 1;
			const patch = k === 1 ? `DEL ${n}` : `DEL ${start}.=${n}`;
			const { text } = applyEdits(base, parsePatch(patch).edits);
			expect(text.split("\n")).toEqual(lines.slice(0, n - k));
		});
	}
});
