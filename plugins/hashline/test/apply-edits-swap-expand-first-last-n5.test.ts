/**
 * Expand first and last of 5-line file to k=2..4.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits expand first/last n=5", () => {
	const base = ["a", "b", "c", "d", "e"];
	const text = base.join("\n");
	for (const k of [2, 3, 4]) {
		it(`first k=${k}`, () => {
			const body = Array.from({ length: k }, (_, i) => `+F${i}`).join("\n");
			const { text: out } = applyEdits(text, parsePatch(`SWAP 1.=1:\n${body}`).edits);
			const mid = Array.from({ length: k }, (_, i) => `F${i}`);
			expect(out).toBe([...mid, "b", "c", "d", "e"].join("\n"));
		});
		it(`last k=${k}`, () => {
			const body = Array.from({ length: k }, (_, i) => `+L${i}`).join("\n");
			const { text: out } = applyEdits(text, parsePatch(`SWAP 5.=5:\n${body}`).edits);
			const mid = Array.from({ length: k }, (_, i) => `L${i}`);
			expect(out).toBe(["a", "b", "c", "d", ...mid].join("\n"));
		});
	}
});
