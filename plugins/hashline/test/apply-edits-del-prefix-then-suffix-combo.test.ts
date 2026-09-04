/**
 * Multi-hunk DEL first k and last m lines in one patch: remaining middle exact.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits DEL prefix then suffix combo", () => {
	for (const n of [5, 8, 12]) {
		for (const k of [1, 2]) {
			for (const m of [1, 2]) {
				if (k + m >= n) continue;
				it(`n=${n} del first ${k} last ${m}`, () => {
					const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
					const base = lines.join("\n");
					const dels: string[] = [];
					for (let i = 1; i <= k; i++) dels.push(`DEL ${i}`);
					for (let i = n - m + 1; i <= n; i++) dels.push(`DEL ${i}`);
					const { text } = applyEdits(base, parsePatch(dels.join("\n")).edits);
					const want = lines.slice(k, n - m).join("\n");
					expect(text).toBe(want);
				});
			}
		}
	}
});
