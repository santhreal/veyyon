/**
 * DEL prefix and suffix k=1..50000 on n=50000 (chunked its).
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits past 6000 DEL prefix suffix k 1 to 50000", () => {
	const n = 50000;
	const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
	const base = lines.join("\n");
	const chunk = 1000;

	for (let start = 1; start <= n; start += chunk) {
		const end = Math.min(start + chunk - 1, n);
		it(`DEL prefix k=${start}..${end}`, () => {
			for (let k = start; k <= end; k++) {
				const { text } = applyEdits(base, parsePatch(`DEL 1.=${k}`).edits);
				expect(text === "" ? [] : text.split("\n")).toHaveLength(n - k);
			}
		});
		it(`DEL suffix k=${start}..${end}`, () => {
			for (let k = start; k <= end; k++) {
				const s = n - k + 1;
				const { text } = applyEdits(base, parsePatch(`DEL ${s}.=${n}`).edits);
				expect(text === "" ? [] : text.split("\n")).toHaveLength(n - k);
			}
		});
	}
});
