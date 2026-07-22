/**
 * Symmetric DEL first k and last k leaves middle n-2k lines.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits mirror DEL left right", () => {
	for (const n of [6, 10, 14]) {
		for (const k of [1, 2, 3]) {
			if (2 * k >= n) continue;
			it(`n=${n} k=${k}`, () => {
				const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
				const base = lines.join("\n");
				const dels: string[] = [];
				for (let i = 1; i <= k; i++) dels.push(`DEL ${i}`);
				for (let i = n - k + 1; i <= n; i++) dels.push(`DEL ${i}`);
				const { text } = applyEdits(base, parsePatch(dels.join("\n")).edits);
				expect(text.split("\n")).toEqual(lines.slice(k, n - k));
			});
		}
	}
});
