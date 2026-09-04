/**
 * INS.HEAD/TAIL parse to bof/eof cursors.
 */
import { describe, expect, it } from "bun:test";
import { parsePatch } from "../src/parser";

describe("parsePatch HEAD/TAIL cursors", () => {
	it("HEAD is bof", () => {
		const e = parsePatch("INS.HEAD:\n+x").edits[0];
		expect(e?.kind).toBe("insert");
		if (e?.kind === "insert") expect(e.cursor.kind).toBe("bof");
	});

	it("TAIL is eof", () => {
		const e = parsePatch("INS.TAIL:\n+x").edits[0];
		expect(e?.kind).toBe("insert");
		if (e?.kind === "insert") expect(e.cursor.kind).toBe("eof");
	});

	it("multi HEAD rows all bof", () => {
		const edits = parsePatch("INS.HEAD:\n+a\n+b").edits;
		expect(edits).toHaveLength(2);
		for (const e of edits) {
			if (e.kind === "insert") expect(e.cursor.kind).toBe("bof");
		}
	});

	it("multi TAIL rows all eof", () => {
		const edits = parsePatch("INS.TAIL:\n+a\n+b").edits;
		expect(edits).toHaveLength(2);
		for (const e of edits) {
			if (e.kind === "insert") expect(e.cursor.kind).toBe("eof");
		}
	});
});
