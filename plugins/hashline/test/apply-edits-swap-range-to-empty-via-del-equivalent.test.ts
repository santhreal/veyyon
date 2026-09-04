/**
 * DEL range and multi-line delete are equivalent to removing that span.
 * Property over all ranges on n=6.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, formatDeleteHeader, parsePatch } from "@veyyon/hashline";

describe("applyEdits DEL range equivalent to slice remove", () => {
	const n = 6;
	const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
	const base = lines.join("\n");

	for (let s = 1; s <= n; s++) {
		for (let e = s; e <= n; e++) {
			it(`DEL ${s}.=${e}`, () => {
				const header = formatDeleteHeader(s, e);
				const { text } = applyEdits(base, parsePatch(header).edits);
				const want = [...lines.slice(0, s - 1), ...lines.slice(e)].join("\n");
				expect(text).toBe(want);
			});
		}
	}
});
