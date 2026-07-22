/**
 * Ops on empty source: HEAD/TAIL build; DEL no-ops; SWAP writes body as sole content.
 * Why: empty-file path is a common recovery edge after full DEL.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits past 6000 empty body ops matrix", () => {
	it("INS.HEAD builds from empty", () => {
		const { text } = applyEdits("", parsePatch("INS.HEAD:\n+A\n+B").edits);
		expect(text).toBe("A\nB");
	});

	it("INS.TAIL builds from empty same as HEAD for first content", () => {
		const { text } = applyEdits("", parsePatch("INS.TAIL:\n+A\n+B").edits);
		expect(text).toBe("A\nB");
	});

	it("HEAD then TAIL from empty", () => {
		let t = applyEdits("", parsePatch("INS.HEAD:\n+H").edits).text;
		t = applyEdits(t, parsePatch("INS.TAIL:\n+T").edits).text;
		expect(t).toBe("H\nT");
	});

	it("DEL on empty is no-op with firstChangedLine 1", () => {
		const r = applyEdits("", parsePatch("DEL 1").edits);
		expect(r.text).toBe("");
		expect(r.firstChangedLine).toBe(1);
	});

	it("SWAP on empty writes body as sole content", () => {
		const r = applyEdits("", parsePatch("SWAP 1.=1:\n+X").edits);
		expect(r.text).toBe("X");
		expect(r.firstChangedLine).toBe(1);
	});

	for (let k = 1; k <= 15; k++) {
		it(`empty HEAD k=${k} then full DEL`, () => {
			const rows = Array.from({ length: k }, (_, i) => `+L${i + 1}`).join("\n");
			const built = applyEdits("", parsePatch(`INS.HEAD:\n${rows}`).edits).text;
			expect(built.split("\n")).toHaveLength(k);
			const cleared = applyEdits(built, parsePatch(`DEL 1.=${k}`).edits).text;
			expect(cleared).toBe("");
		});
	}
});
