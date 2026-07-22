/**
 * parsePatch lowers high-level hunks to insert/delete Edit objects: exact shapes.
 * Why: apply path depends on kind discriminants (bof/eof/before_anchor/after_anchor).
 */
import { describe, expect, it } from "bun:test";
import { parsePatch } from "@veyyon/hashline";

describe("applyEdits past 6000 parse edit shape exact", () => {
	it("DEL single → one delete with anchor.line", () => {
		const { edits } = parsePatch("DEL 3");
		expect(edits).toEqual([
			{ kind: "delete", anchor: { line: 3 }, lineNum: 1, index: 0 },
		]);
	});

	it("DEL range → one delete per line inclusive", () => {
		const { edits } = parsePatch("DEL 2.=5");
		expect(edits).toHaveLength(4);
		expect(edits.map((e) => (e as { anchor: { line: number } }).anchor.line)).toEqual([
			2, 3, 4, 5,
		]);
		for (const e of edits) expect(e.kind).toBe("delete");
	});

	it("SWAP lowers to replacement inserts then deletes", () => {
		const { edits } = parsePatch("SWAP 1.=2:\n+A\n+B");
		expect(edits).toHaveLength(4);
		expect(edits[0]).toMatchObject({
			kind: "insert",
			cursor: { kind: "before_anchor", anchor: { line: 1 } },
			text: "A",
			mode: "replacement",
		});
		expect(edits[1]).toMatchObject({
			kind: "insert",
			text: "B",
			mode: "replacement",
		});
		expect(edits[2]).toMatchObject({ kind: "delete", anchor: { line: 1 } });
		expect(edits[3]).toMatchObject({ kind: "delete", anchor: { line: 2 } });
	});

	it("INS.HEAD → bof insert", () => {
		const { edits } = parsePatch("INS.HEAD:\n+H");
		expect(edits).toEqual([
			{ kind: "insert", cursor: { kind: "bof" }, text: "H", lineNum: 1, index: 0 },
		]);
	});

	it("INS.TAIL → eof insert", () => {
		const { edits } = parsePatch("INS.TAIL:\n+T");
		expect(edits).toEqual([
			{ kind: "insert", cursor: { kind: "eof" }, text: "T", lineNum: 1, index: 0 },
		]);
	});

	it("INS.PRE → before_anchor", () => {
		const { edits } = parsePatch("INS.PRE 4:\n+R");
		expect(edits).toEqual([
			{
				kind: "insert",
				cursor: { kind: "before_anchor", anchor: { line: 4 } },
				text: "R",
				lineNum: 1,
				index: 0,
			},
		]);
	});

	it("INS.POST → after_anchor", () => {
		const { edits } = parsePatch("INS.POST 7:\n+P");
		expect(edits).toEqual([
			{
				kind: "insert",
				cursor: { kind: "after_anchor", anchor: { line: 7 } },
				text: "P",
				lineNum: 1,
				index: 0,
			},
		]);
	});

	it("multi-hunk preserves order and index", () => {
		const { edits } = parsePatch("DEL 1\nDEL 3\nINS.HEAD:\n+H");
		expect(edits).toHaveLength(3);
		expect(edits[0]).toMatchObject({ kind: "delete", anchor: { line: 1 }, index: 0 });
		expect(edits[1]).toMatchObject({ kind: "delete", anchor: { line: 3 }, index: 1 });
		expect(edits[2]).toMatchObject({ kind: "insert", cursor: { kind: "bof" }, text: "H", index: 2 });
	});

	it("INS.HEAD multi-row → one insert per body line", () => {
		const { edits } = parsePatch("INS.HEAD:\n+A\n+B\n+C");
		expect(edits).toHaveLength(3);
		expect(edits.map((e) => (e as { text: string }).text)).toEqual(["A", "B", "C"]);
		for (const e of edits) {
			expect(e.kind).toBe("insert");
			expect((e as { cursor: { kind: string } }).cursor.kind).toBe("bof");
		}
	});
});
