/**
 * DEL last k lines for k=1..25 on n=30 file: exact prefix.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits continue depth property DEL suffix k 1 to 25", () => {
	const n = 30;
	const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
	const base = lines.join("\n");

	for (let k = 1; k <= 25; k++) {
		it(`k=${k}`, () => {
			const start = n - k + 1;
			const patch = k === 1 ? `DEL ${n}` : `DEL ${start}.=${n}`;
			const { text } = applyEdits(base, parsePatch(patch).edits);
			expect(text.split("\n")).toEqual(lines.slice(0, n - k));
		});
	}
});
