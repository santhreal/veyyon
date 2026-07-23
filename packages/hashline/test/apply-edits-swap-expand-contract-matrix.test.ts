/**
 * SWAP expand/contract matrix: line i of N becomes k lines for various k.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, formatReplaceHeader, parsePatch } from "@veyyon/hashline";

describe("applyEdits SWAP expand/contract matrix", () => {
	const n = 5;
	const base = Array.from({ length: n }, (_, i) => `L${i + 1}`);
	const text = base.join("\n");

	for (const pos of [1, 3, 5]) {
		for (const k of [0, 1, 2, 4]) {
			// k=0 means bodyless SWAP = pure delete of that line
			it(`pos=${pos} k=${k}`, () => {
				const h = formatReplaceHeader(pos, pos);
				const body = k === 0 ? "" : Array.from({ length: k }, (_, i) => `+E${i}`).join("\n");
				const patch = body ? `${h}\n${body}` : `${h}`;
				const { text: out } = applyEdits(text, parsePatch(patch).edits);
				const want = [...base];
				const insert = k === 0 ? [] : Array.from({ length: k }, (_, i) => `E${i}`);
				want.splice(pos - 1, 1, ...insert);
				expect(out).toBe(want.join("\n"));
			});
		}
	}
});
