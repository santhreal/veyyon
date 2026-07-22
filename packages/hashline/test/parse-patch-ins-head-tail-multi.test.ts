/**
 * INS.HEAD/TAIL multi-row: exact order of inserts.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("parsePatch+applyEdits INS.HEAD/TAIL multi-row", () => {
	it("HEAD multi rows prepend in order", () => {
		const { text } = applyEdits("body", parsePatch("INS.HEAD:\n+1\n+2\n+3").edits);
		expect(text).toBe("1\n2\n3\nbody");
	});

	it("TAIL multi rows append in order", () => {
		const { text } = applyEdits("body", parsePatch("INS.TAIL:\n+1\n+2\n+3").edits);
		expect(text).toBe("body\n1\n2\n3");
	});

	it("HEAD and TAIL together", () => {
		const { text } = applyEdits("m", parsePatch("INS.HEAD:\n+H\nINS.TAIL:\n+T").edits);
		expect(text).toBe("H\nm\nT");
	});

	it("empty source HEAD creates content", () => {
		const { text } = applyEdits("", parsePatch("INS.HEAD:\n+only").edits);
		expect(text).toBe("only");
	});

	it("empty source TAIL creates content", () => {
		const { text } = applyEdits("", parsePatch("INS.TAIL:\n+only").edits);
		expect(text).toBe("only");
	});

	it("unicode multi HEAD", () => {
		const { text } = applyEdits("x", parsePatch("INS.HEAD:\n+日本語\n+☃").edits);
		expect(text).toBe("日本語\n☃\nx");
	});
});
