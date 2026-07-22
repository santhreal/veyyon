/**
 * Three sequential INS.TAIL applyEdits steps.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits triple sequential INS.TAIL", () => {
	it("builds a\nb\nc", () => {
		let text = "";
		for (const line of ["a", "b", "c"]) {
			text = applyEdits(text, parsePatch(`INS.TAIL:\n+${line}`).edits).text;
		}
		expect(text).toBe("a\nb\nc");
	});

	it("builds with initial seed", () => {
		let text = "seed";
		for (const line of ["1", "2", "3", "4"]) {
			text = applyEdits(text, parsePatch(`INS.TAIL:\n+${line}`).edits).text;
		}
		expect(text).toBe("seed\n1\n2\n3\n4");
	});
});
