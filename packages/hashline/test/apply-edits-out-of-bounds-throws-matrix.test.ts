/**
 * applyEdits throws when anchors exceed file line count.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits out of bounds throws matrix", () => {
	const base = "a\nb\nc"; // 3 lines

	for (const patch of ["DEL 4", "DEL 100", "SWAP 4.=4:\n+x", "INS.POST 4:\n+x", "INS.PRE 0:\n+x"]) {
		it(`throws for ${JSON.stringify(patch)}`, () => {
			expect(() => applyEdits(base, parsePatch(patch).edits)).toThrow(
				/does not exist|Line |>= 1|Invalid/i,
			);
		});
	}

	// INS.PRE 0 may fail at parse
	it("DEL 3 of 3 ok", () => {
		expect(applyEdits(base, parsePatch("DEL 3").edits).text).toBe("a\nb");
	});

	it("INS.POST 3 of 3 ok", () => {
		expect(applyEdits(base, parsePatch("INS.POST 3:\n+z").edits).text).toBe("a\nb\nc\nz");
	});
});
