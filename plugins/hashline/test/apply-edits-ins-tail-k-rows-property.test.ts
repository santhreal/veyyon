/**
 * INS.TAIL with k body rows appends exactly k lines in order.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits INS.TAIL k rows property", () => {
	for (const k of [1, 2, 3, 5, 8, 12]) {
		for (const base of ["", "body", "a\nb\nc"]) {
			it(`k=${k} base=${JSON.stringify(base)}`, () => {
				const rows = Array.from({ length: k }, (_, i) => `+T${i}`).join("\n");
				const { text } = applyEdits(base, parsePatch(`INS.TAIL:\n${rows}`).edits);
				const out = text.split("\n");
				const tail = Array.from({ length: k }, (_, i) => `T${i}`);
				if (base === "") {
					expect(out).toEqual(tail);
				} else {
					expect(out.slice(0, out.length - k).join("\n")).toBe(base);
					expect(out.slice(out.length - k)).toEqual(tail);
				}
			});
		}
	}
});
