/**
 * DEL single line i for i=1..3000000 on n=3000000 (chunked; setDefaultTimeout 120s).
 */
import { describe, expect, it, setDefaultTimeout } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

setDefaultTimeout(120_000);

describe("applyEdits past 6000 DEL line 1 to 3000000", () => {
	const n = 3000000;
	const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
	const base = lines.join("\n");
	const chunk = 1000;

	for (let start = 1; start <= n; start += chunk) {
		const end = Math.min(start + chunk - 1, n);
		it(`DEL lines ${start}..${end}`, () => {
			for (let i = start; i <= end; i++) {
				const { firstChangedLine } = applyEdits(base, parsePatch(`DEL ${i}`).edits);
				expect(firstChangedLine).toBe(i);
			}
		});
	}
});
