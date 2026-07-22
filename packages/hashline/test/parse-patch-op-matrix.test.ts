/**
 * parsePatch operator matrix: SWAP/DEL/INS/REM/MV exact edit shapes and rejects.
 */
import { describe, expect, it } from "bun:test";
import { parsePatch, parsePatchStreaming } from "../src/parser";
import {
	DELETE_TAKES_NO_BODY,
	EMPTY_INSERT,
	EMPTY_REPLACE,
	MINUS_ROW_REJECTED,
	REM_TAKES_NO_BODY,
} from "../src/messages";

describe("parsePatch SWAP matrix", () => {
	it("single-line SWAP becomes delete+insert at that line", () => {
		const { edits, warnings } = parsePatch("SWAP 2.=2:\n+NEW");
		expect(warnings).toEqual([]);
		const kinds = edits.map(e => e.kind);
		expect(kinds).toContain("delete");
		expect(kinds).toContain("insert");
		const del = edits.find(e => e.kind === "delete");
		if (del?.kind !== "delete") throw new Error("missing delete");
		expect(del.anchor.line).toBe(2);
		const ins = edits.filter(e => e.kind === "insert");
		expect(ins).toHaveLength(1);
		if (ins[0]?.kind === "insert") {
			expect(ins[0].text).toBe("NEW");
		}
	});

	it("multi-line SWAP range deletes each line in range", () => {
		const { edits } = parsePatch("SWAP 1.=3:\n+A\n+B");
		const dels = edits.filter(e => e.kind === "delete");
		expect(dels.map(e => (e.kind === "delete" ? e.anchor.line : -1)).sort((a, b) => a - b)).toEqual([
			1, 2, 3,
		]);
		const ins = edits.filter(e => e.kind === "insert");
		expect(ins.map(e => (e.kind === "insert" ? e.text : ""))).toEqual(["A", "B"]);
	});

	it("empty SWAP body is treated as pure delete of the range (no EMPTY_REPLACE throw)", () => {
		// Bodyless SWAP N.=M: lowers to the same deletes as DEL N.=M rather than
		// throwing EMPTY_REPLACE (EMPTY_REPLACE is reserved for other empty paths).
		const { edits, warnings } = parsePatch("SWAP 1.=1:");
		expect(warnings).toEqual([]);
		expect(edits).toHaveLength(1);
		expect(edits[0]?.kind).toBe("delete");
		if (edits[0]?.kind === "delete") expect(edits[0].anchor.line).toBe(1);

		const multi = parsePatch("SWAP 2.=4:");
		expect(
			multi.edits
				.filter(e => e.kind === "delete")
				.map(e => (e.kind === "delete" ? e.anchor.line : 0)),
		).toEqual([2, 3, 4]);
		// EMPTY_REPLACE still exists as the operator-facing string for empty replace
		// diagnostics elsewhere (block / messaging contract).
		expect(EMPTY_REPLACE).toContain("SWAP");
	});

	it("minus body row is rejected", () => {
		expect(() => parsePatch("SWAP 1.=1:\n-old\n+new")).toThrow(MINUS_ROW_REJECTED.slice(0, 15));
	});
});

describe("parsePatch DEL matrix", () => {
	it("DEL N deletes single line", () => {
		const { edits } = parsePatch("DEL 4");
		expect(edits).toHaveLength(1);
		expect(edits[0]?.kind).toBe("delete");
		if (edits[0]?.kind === "delete") expect(edits[0].anchor.line).toBe(4);
	});

	it("DEL N.=M deletes inclusive range", () => {
		const { edits } = parsePatch("DEL 2.=5");
		const lines = edits
			.filter(e => e.kind === "delete")
			.map(e => (e.kind === "delete" ? e.anchor.line : 0));
		expect(lines).toEqual([2, 3, 4, 5]);
	});

	it("DEL with body rejects", () => {
		expect(() => parsePatch("DEL 1\n+oops")).toThrow(DELETE_TAKES_NO_BODY.slice(0, 10));
	});
});

describe("parsePatch INS matrix", () => {
	it("INS.POST N inserts after anchor", () => {
		const { edits } = parsePatch("INS.POST 3:\n+x\n+y");
		expect(edits).toHaveLength(2);
		for (const e of edits) {
			expect(e.kind).toBe("insert");
			if (e.kind === "insert") {
				expect(e.cursor.kind).toBe("after_anchor");
				if (e.cursor.kind === "after_anchor") expect(e.cursor.anchor.line).toBe(3);
			}
		}
		expect(edits.map(e => (e.kind === "insert" ? e.text : ""))).toEqual(["x", "y"]);
	});

	it("INS.PRE N inserts before anchor", () => {
		const { edits } = parsePatch("INS.PRE 1:\n+head");
		expect(edits).toHaveLength(1);
		const e = edits[0];
		if (e?.kind !== "insert") throw new Error("expected insert");
		expect(e.cursor.kind).toBe("before_anchor");
		if (e.cursor.kind === "before_anchor") expect(e.cursor.anchor.line).toBe(1);
		expect(e.text).toBe("head");
	});

	it("INS.HEAD and INS.TAIL use bof/eof cursors", () => {
		const head = parsePatch("INS.HEAD:\n+H");
		expect(head.edits[0]?.kind).toBe("insert");
		if (head.edits[0]?.kind === "insert") expect(head.edits[0].cursor.kind).toBe("bof");

		const tail = parsePatch("INS.TAIL:\n+T");
		expect(tail.edits[0]?.kind).toBe("insert");
		if (tail.edits[0]?.kind === "insert") expect(tail.edits[0].cursor.kind).toBe("eof");
	});

	it("empty INS rejects", () => {
		expect(() => parsePatch("INS.POST 1:")).toThrow(EMPTY_INSERT.slice(0, 10));
	});
});

describe("parsePatch REM and MV", () => {
	it("REM alone yields fileOp rem", () => {
		const { edits, fileOp } = parsePatch("REM");
		expect(edits).toEqual([]);
		expect(fileOp).toEqual({ kind: "rem" });
	});

	it("REM with a following body row rejects (fail-closed)", () => {
		// Current tokenizer/executor path surfaces a body-takes-no-rows style error
		// (message may name REM or another file-op form depending on drain order).
		expect(() => parsePatch("REM\n+x")).toThrow(/does not take body rows/);
		expect(REM_TAKES_NO_BODY).toContain("REM");
	});

	it("MV dest yields move fileOp", () => {
		const { fileOp, edits } = parsePatch("MV other/path.ts");
		expect(edits).toEqual([]);
		expect(fileOp).toEqual({ kind: "move", dest: "other/path.ts" });
	});
});

describe("parsePatch multi-hunk and streaming", () => {
	it("multiple hunks produce ordered anchors", () => {
		const { edits } = parsePatch("DEL 1\nSWAP 3.=3:\n+Z\nINS.TAIL:\n+end");
		const dels = edits.filter(e => e.kind === "delete");
		expect(dels.some(e => e.kind === "delete" && e.anchor.line === 1)).toBe(true);
		expect(dels.some(e => e.kind === "delete" && e.anchor.line === 3)).toBe(true);
		expect(edits.some(e => e.kind === "insert" && e.text === "Z")).toBe(true);
		expect(edits.some(e => e.kind === "insert" && e.text === "end")).toBe(true);
	});

	it("parsePatchStreaming ends streaming path without hanging on complete input", () => {
		const a = parsePatch("SWAP 1.=1:\n+X");
		const b = parsePatchStreaming("SWAP 1.=1:\n+X");
		expect(b.edits.length).toBe(a.edits.length);
		expect(b.edits.map(e => e.kind)).toEqual(a.edits.map(e => e.kind));
	});

	it("literal + body with leading spaces is preserved", () => {
		const { edits } = parsePatch("SWAP 1.=1:\n+  indented\n+\t tabbed");
		const texts = edits.filter(e => e.kind === "insert").map(e => (e.kind === "insert" ? e.text : ""));
		expect(texts).toEqual(["  indented", "\t tabbed"]);
	});

	it("unicode body round-trips through parse", () => {
		const body = "café ☃ 日本語";
		const { edits } = parsePatch(`SWAP 1.=1:\n+${body}`);
		const ins = edits.find(e => e.kind === "insert");
		if (ins?.kind !== "insert") throw new Error("missing insert");
		expect(ins.text).toBe(body);
	});
});
