/**
 * SWAP expand/contract matrix: line i of N becomes k lines of body (k>=1) — exact
 * splice. k=0 (a bodyless SWAP) is not "delete that line": it is rejected with
 * EMPTY_REPLACE (silent-delete footgun removed; DEL is the delete form).
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, EMPTY_REPLACE, formatReplaceHeader, parsePatch } from "@veyyon/hashline";

describe("applyEdits SWAP expand/contract matrix", () => {
	const n = 5;
	const base = Array.from({ length: n }, (_, i) => `L${i + 1}`);
	const text = base.join("\n");

	for (const pos of [1, 3, 5]) {
		it(`pos=${pos} k=0 (bodyless) is rejected`, () => {
			expect(() => parsePatch(formatReplaceHeader(pos, pos))).toThrow(EMPTY_REPLACE);
		});
		for (const k of [1, 2, 4]) {
			it(`pos=${pos} k=${k}`, () => {
				const body = Array.from({ length: k }, (_, i) => `+E${i}`).join("\n");
				const patch = `${formatReplaceHeader(pos, pos)}\n${body}`;
				const { text: out } = applyEdits(text, parsePatch(patch).edits);
				const want = [...base];
				want.splice(pos - 1, 1, ...Array.from({ length: k }, (_, i) => `E${i}`));
				expect(out).toBe(want.join("\n"));
			});
		}
	}
});
