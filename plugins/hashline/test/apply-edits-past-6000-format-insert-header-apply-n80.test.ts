/**
 * formatInsertHeader for PRE/POST/HEAD/TAIL -> parse -> apply exact on n=80.
 * Why: insert formatter must agree with parser for every cursor shape.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, formatInsertHeader, parsePatch } from "@veyyon/hashline";

describe("applyEdits past 6000 format insert header apply n80", () => {
	const n = 80;
	const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
	const base = lines.join("\n");

	it("HEAD", () => {
		const h = formatInsertHeader({ kind: "bof" });
		const out = applyEdits(base, parsePatch(`${h}\n+X`).edits).text.split("\n");
		expect(out[0]).toBe("X");
		expect(out.slice(1)).toEqual(lines);
	});

	it("TAIL", () => {
		const h = formatInsertHeader({ kind: "eof" });
		const out = applyEdits(base, parsePatch(`${h}\n+Y`).edits).text.split("\n");
		expect(out[out.length - 1]).toBe("Y");
		expect(out.slice(0, n)).toEqual(lines);
	});

	for (let a = 1; a <= n; a++) {
		it(`PRE ${a}`, () => {
			const h = formatInsertHeader({ kind: "before_anchor", anchor: { line: a } });
			const out = applyEdits(base, parsePatch(`${h}\n+P`).edits).text.split("\n");
			expect(out).toEqual([...lines.slice(0, a - 1), "P", ...lines.slice(a - 1)]);
		});
		it(`POST ${a}`, () => {
			const h = formatInsertHeader({ kind: "after_anchor", anchor: { line: a } });
			const out = applyEdits(base, parsePatch(`${h}\n+Q`).edits).text.split("\n");
			expect(out).toEqual([...lines.slice(0, a), "Q", ...lines.slice(a)]);
		});
	}
});
