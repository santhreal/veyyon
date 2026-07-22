/**
 * Blank and whitespace-only line bodies through SWAP/DEL/INS.
 * Why: empty and space-only lines are valid content and must roundtrip.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits past 6000 blank whitespace swap del grid", () => {
	const bodies = ["", " ", "  ", "\t", " \t ", "\t\t", "   "];

	it("file of blanks identity SWAP", () => {
		const base = bodies.join("\n");
		const hunks = bodies.map((b, i) => `SWAP ${i + 1}.=${i + 1}:\n+${b}`).join("\n");
		expect(applyEdits(base, parsePatch(hunks).edits).text).toBe(base);
	});

	for (let i = 0; i < bodies.length; i++) {
		it(`DEL blank idx ${i}`, () => {
			const base = bodies.join("\n");
			const out = applyEdits(base, parsePatch(`DEL ${i + 1}`).edits).text;
			expect(out === "" ? [] : out.split("\n")).toEqual(bodies.filter((_, j) => j !== i));
		});
	}

	for (const b of bodies) {
		it(`SWAP first to ${JSON.stringify(b)}`, () => {
			const out = applyEdits("old\nkeep", parsePatch(`SWAP 1.=1:\n+${b}`).edits).text;
			expect(out).toBe(`${b}\nkeep`);
		});
	}

	it("INS.HEAD empty line then content", () => {
		const out = applyEdits("x", parsePatch("INS.HEAD:\n+\n+y").edits).text.split("\n");
		expect(out).toEqual(["", "y", "x"]);
	});
});
