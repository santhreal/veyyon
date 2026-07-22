/**
 * Multi-hunk SWAP only odd lines on n=60; evens unchanged.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits past 6000 multi-hunk SWAP odds n60", () => {
	const n = 60;
	const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
	const base = lines.join("\n");

	it("odds become O_i", () => {
		const hunks = Array.from({ length: n }, (_, i) => i + 1)
			.filter((x) => x % 2 === 1)
			.map((x) => `SWAP ${x}.=${x}:\n+O${x}`)
			.join("\n");
		const out = applyEdits(base, parsePatch(hunks).edits).text.split("\n");
		for (let i = 1; i <= n; i++) {
			if (i % 2 === 1) expect(out[i - 1]).toBe(`O${i}`);
			else expect(out[i - 1]).toBe(`L${i}`);
		}
	});
});
