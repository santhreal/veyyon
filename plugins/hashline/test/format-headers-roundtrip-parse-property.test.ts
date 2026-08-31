/**
 * formatReplace/Delete/InsertHeader strings parse back through parsePatch
 * and apply with exact prefix/suffix preservation.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, formatDeleteHeader, formatInsertHeader, formatReplaceHeader, parsePatch } from "@veyyon/hashline";

describe("format headers roundtrip parse property", () => {
	const n = 15;
	const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
	const text = lines.join("\n");

	for (let start = 1; start <= 10; start++) {
		for (const end of [start, Math.min(start + 1, n), Math.min(start + 4, n)]) {
			it(`SWAP ${start}.=${end}`, () => {
				const header = formatReplaceHeader(start, end);
				expect(header).toBe(`SWAP ${start}.=${end}:`);
				const { edits } = parsePatch(`${header}\n+body`);
				const out = applyEdits(text, edits).text.split("\n");
				expect(out.slice(0, start - 1)).toEqual(lines.slice(0, start - 1));
				expect(out[start - 1]).toBe("body");
				expect(out.slice(start)).toEqual(lines.slice(end));
			});

			it(`DEL ${start}.=${end}`, () => {
				const header = formatDeleteHeader(start, end);
				if (start === end) expect(header).toBe(`DEL ${start}`);
				else expect(header).toBe(`DEL ${start}.=${end}`);
				const { edits } = parsePatch(header);
				const out = applyEdits(text, edits).text.split("\n");
				const want = lines.filter((_, i) => i + 1 < start || i + 1 > end);
				expect(out).toEqual(want);
			});
		}
	}

	it("formatInsertHeader all cursor kinds", () => {
		expect(formatInsertHeader({ kind: "bof" })).toBe("INS.HEAD:");
		expect(formatInsertHeader({ kind: "eof" })).toBe("INS.TAIL:");
		expect(formatInsertHeader({ kind: "before_anchor", anchor: { line: 4 } })).toBe("INS.PRE 4:");
		expect(formatInsertHeader({ kind: "after_anchor", anchor: { line: 7 } })).toBe("INS.POST 7:");
	});

	it("insert headers apply", () => {
		expect(applyEdits("a\nb", parsePatch(`${formatInsertHeader({ kind: "bof" })}\n+H`).edits).text).toBe("H\na\nb");
		expect(applyEdits("a\nb", parsePatch(`${formatInsertHeader({ kind: "eof" })}\n+T`).edits).text).toBe("a\nb\nT");
		expect(
			applyEdits(
				"a\nb\nc",
				parsePatch(`${formatInsertHeader({ kind: "after_anchor", anchor: { line: 2 } })}\n+X`).edits,
			).text,
		).toBe("a\nb\nX\nc");
	});
});
