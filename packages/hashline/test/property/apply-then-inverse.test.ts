/**
 * Apply-then-inverse restores the original bytes.
 *
 * WHY THIS SUITE EXISTS. Hashline already walks thousands of seeded DEL/INS/SWAP
 * sequences and checks line *counts*. A count-preserving applier can still drop
 * a combining mark, swallow a CR, or rewrite a line the inverse cannot put back.
 * The product contract the edit tool advertises is stronger: a well-formed hunk
 * that applied is undoable by another well-formed hunk, and the file is the
 * file that was read.
 *
 * WHAT THIS DOES NOT COVER. Boundary-repair and block ops change the authored
 * span. Patcher write-back of CRLF lives in `patcher-crlf-unicode-bom-matrix`.
 * Direct `applyEdits` on a CRLF body is a different boundary: it must not mix
 * endings. The CRLF inverse case below is expected red until that is true.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

function apply(text: string, patch: string): { text: string; warnings: string[] } {
	const parsed = parsePatch(patch);
	expect(parsed.warnings).toEqual([]);
	const result = applyEdits(text, parsed.edits);
	return { text: result.text, warnings: result.warnings ?? [] };
}

function restore(original: string, patch: string, inverse: string): void {
	const forward = apply(original, patch);
	expect(forward.warnings).toEqual([]);
	expect(forward.text).not.toBe(original);
	const back = apply(forward.text, inverse);
	expect(back.warnings).toEqual([]);
	expect(back.text).toBe(original);
}

describe("apply then inverse restores the original bytes", () => {
	it("DEL of the first, middle, and last line each invert to an insert of those exact bytes", () => {
		const original = ["alpha", "beta", "gamma"].join("\n");
		restore(original, "DEL 1", "INS.HEAD:\n+alpha");
		restore(original, "DEL 2", "INS.PRE 2:\n+beta");
		restore(original, "DEL 3", "INS.TAIL:\n+gamma");
	});

	it("a SWAP of a unicode line inverts by swapping the original line back", () => {
		const original = ["café", "日本語", "🚀"].join("\n");
		restore(original, "SWAP 2.=2:\n+ascii", "SWAP 2.=2:\n+日本語");
	});

	it("INS.HEAD / INS.TAIL / INS.PRE / INS.POST invert by deleting the inserted row", () => {
		const original = ["a", "b", "c"].join("\n");
		restore(original, "INS.HEAD:\n+H", "DEL 1");
		restore(original, "INS.TAIL:\n+T", "DEL 4");
		restore(original, "INS.PRE 2:\n+P", "DEL 2");
		restore(original, "INS.POST 2:\n+Q", "DEL 3");
	});

	it("a combining-mark line is not stripped by SWAP then inverse", () => {
		const marked = "e\u0301";
		const original = ["x", marked, "z"].join("\n");
		restore(original, "SWAP 2.=2:\n+e", `SWAP 2.=2:\n+${marked}`);
	});

	it("SWAP then inverse on a CRLF file restores those original bytes", () => {
		// applyEdits splits on LF only, so a SWAP today rewrites the edited line
		// as LF and leaves CR on its neighbors. The advertised inverse contract
		// is the file that was read, not a mixed-ending cousin. This stays red
		// until the applier refuses CRLF or preserves it on every line.
		const original = "one\r\ntwo\r\nthree";
		const forward = apply(original, "SWAP 2.=2:\n+TWO");
		expect(forward.warnings).toEqual([]);
		expect(JSON.stringify(forward.text)).toBe(JSON.stringify("one\r\nTWO\r\nthree"));
		const back = apply(forward.text, "SWAP 2.=2:\n+two");
		expect(back.warnings).toEqual([]);
		expect(JSON.stringify(back.text)).toBe(JSON.stringify(original));
	});

	it("a range DEL inverts by inserting the deleted span at the same position", () => {
		const original = ["a", "b", "c", "d"].join("\n");
		restore(original, "DEL 2.=3", "INS.PRE 2:\n+b\n+c");
	});

	it("a range SWAP inverts by swapping the original span back, payload width included", () => {
		const original = ["a", "b", "c", "d"].join("\n");
		restore(original, "SWAP 2.=3:\n+X\n+Y\n+Z", "SWAP 2.=4:\n+b\n+c");
	});
});
