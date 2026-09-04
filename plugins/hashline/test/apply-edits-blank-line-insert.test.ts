/**
 * Insert blank lines via + empty body rows.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits blank line inserts", () => {
	it("SWAP to blank line", () => {
		const { text } = applyEdits("a\nb", parsePatch("SWAP 1.=1:\n+").edits);
		expect(text).toBe("\nb");
	});

	it("INS.POST blank", () => {
		const { text } = applyEdits("a\nb", parsePatch("INS.POST 1:\n+").edits);
		expect(text).toBe("a\n\nb");
	});

	it("INS.HEAD blank", () => {
		const { text } = applyEdits("a", parsePatch("INS.HEAD:\n+").edits);
		expect(text).toBe("\na");
	});

	it("INS.TAIL blank", () => {
		const { text } = applyEdits("a", parsePatch("INS.TAIL:\n+").edits);
		expect(text).toBe("a\n");
	});

	it("two blanks HEAD", () => {
		const { text } = applyEdits("x", parsePatch("INS.HEAD:\n+\n+").edits);
		expect(text).toBe("\n\nx");
	});
});
