/**
 * formatDeleteHeader / formatReplaceHeader → parse → apply grid for small n.
 */
import { describe, expect, it } from "bun:test";
import {
	applyEdits,
	formatDeleteHeader,
	formatReplaceHeader,
	parsePatch,
} from "@veyyon/hashline";

describe("format header parse apply grid", () => {
	const n = 8;
	const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
	const base = lines.join("\n");

	for (let s = 1; s <= 4; s++) {
		for (let e = s; e <= s + 2 && e <= n; e++) {
			it(`DEL format ${s}.=${e}`, () => {
				const h = formatDeleteHeader(s, e);
				const { text } = applyEdits(base, parsePatch(h).edits);
				expect(text).toBe([...lines.slice(0, s - 1), ...lines.slice(e)].join("\n"));
			});

			it(`SWAP format ${s}.=${e} → one row`, () => {
				const h = formatReplaceHeader(s, e);
				const { text } = applyEdits(base, parsePatch(`${h}\n+X`).edits);
				const out = text.split("\n");
				expect(out.slice(0, s - 1)).toEqual(lines.slice(0, s - 1));
				expect(out[s - 1]).toBe("X");
				expect(out.slice(s)).toEqual(lines.slice(e));
			});
		}
	}
});
