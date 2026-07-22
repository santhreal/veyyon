/**
 * parsePatch rejects overlapping / duplicate target lines with exact error class.
 */
import { describe, expect, it } from "bun:test";
import { parsePatch } from "@veyyon/hashline";

describe("parsePatch reject overlapping DEL matrix", () => {
	const cases = [
		"DEL 1\nDEL 1",
		"DEL 2\nDEL 2.=2",
		"DEL 1.=3\nDEL 2",
		"DEL 1.=2\nDEL 2.=3",
		"DEL 5\nDEL 5\nDEL 5",
	];
	for (const patch of cases) {
		it(`rejects ${JSON.stringify(patch)}`, () => {
			expect(() => parsePatch(patch)).toThrow(/already targeted|ONE hunk|overlap/i);
		});
	}

	it("non-overlapping DELs parse", () => {
		const { edits } = parsePatch("DEL 1\nDEL 3\nDEL 5");
		expect(edits.length).toBe(3);
	});

	it("adjacent non-overlapping ranges parse", () => {
		const { edits } = parsePatch("DEL 1.=2\nDEL 3.=4");
		expect(edits.length).toBeGreaterThanOrEqual(2);
	});
});
