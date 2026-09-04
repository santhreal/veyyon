/**
 * INS.HEAD with k body rows prepends exactly k lines in order.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits INS.HEAD k rows property", () => {
	for (const k of [1, 2, 3, 5, 8, 12]) {
		for (const base of ["", "body", "a\nb\nc"]) {
			it(`k=${k} base=${JSON.stringify(base)}`, () => {
				const rows = Array.from({ length: k }, (_, i) => `+H${i}`).join("\n");
				const { text } = applyEdits(base, parsePatch(`INS.HEAD:\n${rows}`).edits);
				const out = text.split("\n");
				const head = Array.from({ length: k }, (_, i) => `H${i}`);
				expect(out.slice(0, k)).toEqual(head);
				if (base === "") {
					expect(out.length).toBe(k);
				} else {
					expect(out.slice(k).join("\n")).toBe(base);
				}
			});
		}
	}
});
