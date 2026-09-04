/**
 * Each op type on a fixed 3-line file with exact result.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

const base = "a\nb\nc";

describe("applyEdits all ops on three-line file", () => {
	it("DEL 1", () => {
		expect(applyEdits(base, parsePatch("DEL 1").edits).text).toBe("b\nc");
	});
	it("DEL 2", () => {
		expect(applyEdits(base, parsePatch("DEL 2").edits).text).toBe("a\nc");
	});
	it("DEL 3", () => {
		expect(applyEdits(base, parsePatch("DEL 3").edits).text).toBe("a\nb");
	});
	it("DEL 1.=3", () => {
		expect(applyEdits(base, parsePatch("DEL 1.=3").edits).text).toBe("");
	});
	it("SWAP 2", () => {
		expect(applyEdits(base, parsePatch("SWAP 2.=2:\n+B").edits).text).toBe("a\nB\nc");
	});
	it("INS.HEAD", () => {
		expect(applyEdits(base, parsePatch("INS.HEAD:\n+H").edits).text).toBe("H\na\nb\nc");
	});
	it("INS.TAIL", () => {
		expect(applyEdits(base, parsePatch("INS.TAIL:\n+T").edits).text).toBe("a\nb\nc\nT");
	});
	it("INS.PRE 1", () => {
		expect(applyEdits(base, parsePatch("INS.PRE 1:\n+P").edits).text).toBe("P\na\nb\nc");
	});
	it("INS.POST 3", () => {
		expect(applyEdits(base, parsePatch("INS.POST 3:\n+Q").edits).text).toBe("a\nb\nc\nQ");
	});
	it("INS.POST 1", () => {
		expect(applyEdits(base, parsePatch("INS.POST 1:\n+M").edits).text).toBe("a\nM\nb\nc");
	});
});
