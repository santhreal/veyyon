/**
 * Property: INS.HEAD/TAIL/POST with k body rows increases length by k.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits property INS length delta", () => {
	const base = "a\nb\nc\nd\ne";
	const n = 5;

	for (const k of [1, 2, 3, 5, 10]) {
		const rows = Array.from({ length: k }, (_, i) => `+R${i}`).join("\n");

		it(`HEAD k=${k}`, () => {
			const { text } = applyEdits(base, parsePatch(`INS.HEAD:\n${rows}`).edits);
			expect(text.split("\n").length).toBe(n + k);
		});

		it(`TAIL k=${k}`, () => {
			const { text } = applyEdits(base, parsePatch(`INS.TAIL:\n${rows}`).edits);
			expect(text.split("\n").length).toBe(n + k);
		});

		it(`POST 3 k=${k}`, () => {
			const { text } = applyEdits(base, parsePatch(`INS.POST 3:\n${rows}`).edits);
			expect(text.split("\n").length).toBe(n + k);
		});

		it(`PRE 2 k=${k}`, () => {
			const { text } = applyEdits(base, parsePatch(`INS.PRE 2:\n${rows}`).edits);
			expect(text.split("\n").length).toBe(n + k);
		});
	}
});
