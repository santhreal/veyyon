/**
 * DEL prefix and suffix k=1..300 on n=300.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits past 6000 DEL prefix suffix k 1 to 300", () => {
	const n = 300;
	const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
	const base = lines.join("\n");

	for (let k = 1; k <= n; k++) {
		it(`prefix ${k}`, () => {
			const { text } = applyEdits(base, parsePatch(`DEL 1.=${k}`).edits);
			expect(text === "" ? [] : text.split("\n")).toHaveLength(n - k);
		});

		it(`suffix ${k}`, () => {
			const start = n - k + 1;
			const { text } = applyEdits(base, parsePatch(`DEL ${start}.=${n}`).edits);
			expect(text === "" ? [] : text.split("\n")).toHaveLength(n - k);
		});
	}
});
