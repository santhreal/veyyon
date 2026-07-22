/**
 * SWAP every line 1..400000 on n=400000 (chunked its; raised per-test timeout).
 */
import { describe, expect, it, setDefaultTimeout } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

setDefaultTimeout(120_000);

describe("applyEdits past 6000 SWAP line 1 to 400000", () => {
	const n = 400000;
	const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
	const base = lines.join("\n");
	const chunk = 1000;

	for (let start = 1; start <= n; start += chunk) {
		const end = Math.min(start + chunk - 1, n);
		it(`SWAP lines ${start}..${end}`, () => {
			for (let i = start; i <= end; i++) {
				const { text, firstChangedLine } = applyEdits(
					base,
					parsePatch(`SWAP ${i}.=${i}:\n+X${i}`).edits,
				);
				expect(text.split("\n")[i - 1]).toBe(`X${i}`);
				expect(firstChangedLine).toBe(i);
			}
		});
	}
});
