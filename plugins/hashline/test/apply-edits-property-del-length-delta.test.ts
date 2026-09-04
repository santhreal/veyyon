/**
 * Property: after DEL start..=end, length = old - (end-start+1).
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, formatDeleteHeader, parsePatch } from "@veyyon/hashline";

describe("applyEdits property DEL length delta", () => {
	const n = 15;
	const base = Array.from({ length: n }, (_, i) => `L${i + 1}`).join("\n");

	for (let start = 1; start <= n; start++) {
		for (let end = start; end <= Math.min(start + 5, n); end++) {
			it(`DEL ${start}.=${end}`, () => {
				const span = end - start + 1;
				const { text } = applyEdits(base, parsePatch(formatDeleteHeader(start, end)).edits);
				const len = text === "" ? 0 : text.split("\n").length;
				expect(len).toBe(n - span);
			});
		}
	}
});
