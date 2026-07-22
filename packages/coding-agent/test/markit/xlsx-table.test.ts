import { describe, expect, it } from "bun:test";
import { columnRefToIndex, positionRowValues } from "@veyyon/coding-agent/markit/converters/xlsx";
import { convertBufferWithMarkit } from "@veyyon/coding-agent/utils/markit";
import { zip } from "@veyyon/coding-agent/utils/zip";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

/**
 * These lock FINDING-XLSX-TABLE-COLUMN-MISALIGN-AND-UNESCAPED-CELLS. The XLSX
 * converter used to push each row's <c> cells in document order and ignore each
 * cell's `@_r` A1 reference entirely. Because XLSX omits empty cells, a row with
 * values only in columns A and C shipped two <c> elements and collapsed to
 * columns 0 and 1 — every sparse sheet was silently shifted left and misaligned
 * against its header. Separately, cell values containing `|` or newlines were
 * emitted raw and broke the Markdown table row. The fix positions values by
 * their real column and escapes cell content; these tests pin both.
 */
describe("columnRefToIndex", () => {
	it("maps single-letter A1 columns to 0-based indices", () => {
		expect(columnRefToIndex("A1")).toBe(0);
		expect(columnRefToIndex("B2")).toBe(1);
		expect(columnRefToIndex("Z100")).toBe(25);
	});

	it("maps multi-letter columns with bijective base-26 (no zero digit)", () => {
		expect(columnRefToIndex("AA1")).toBe(26);
		expect(columnRefToIndex("AB1")).toBe(27);
		expect(columnRefToIndex("AZ1")).toBe(51);
		expect(columnRefToIndex("BA1")).toBe(52);
		expect(columnRefToIndex("ZZ1")).toBe(701);
	});

	it("accepts lowercase references and ignores the row number", () => {
		expect(columnRefToIndex("c3")).toBe(2);
		expect(columnRefToIndex("aa99")).toBe(26);
	});

	it("returns undefined when the reference has no leading letters", () => {
		expect(columnRefToIndex("")).toBeUndefined();
		expect(columnRefToIndex("3")).toBeUndefined();
		expect(columnRefToIndex("$A")).toBeUndefined();
	});
});

describe("positionRowValues", () => {
	it("places a sparse row's values at their true columns, filling gaps", () => {
		// The core regression: A and C only. Old code produced ["x","y"]; the true
		// layout keeps column B empty between them.
		expect(
			positionRowValues([
				{ ref: "A1", value: "x" },
				{ ref: "C1", value: "y" },
			]),
		).toEqual(["x", "", "y"]);
	});

	it("orders values by column even when cells arrive out of document order", () => {
		expect(
			positionRowValues([
				{ ref: "B1", value: "b" },
				{ ref: "A1", value: "a" },
			]),
		).toEqual(["a", "b"]);
	});

	it("falls back to the next free column for a ref-less cell, dropping nothing", () => {
		// Preserves the pre-`@_r` behavior for files whose cells carry no reference.
		expect(
			positionRowValues([
				{ ref: undefined, value: "x" },
				{ ref: undefined, value: "y" },
			]),
		).toEqual(["x", "y"]);
	});

	it("mixes referenced and ref-less cells, advancing the fallback past the last column used", () => {
		expect(
			positionRowValues([
				{ ref: "A1", value: "a" },
				{ ref: undefined, value: "b" },
				{ ref: "D1", value: "d" },
			]),
		).toEqual(["a", "b", "", "d"]);
	});

	it("returns an empty row for no cells", () => {
		expect(positionRowValues([])).toEqual([]);
	});
});

describe("XlsxConverter end-to-end table alignment and escaping", () => {
	it("aligns a sparse row by cell reference and escapes a pipe in a value", () => {
		// Header spans A,B,C. The data row has values only in A and C (B omitted, as
		// real XLSX does) plus a pipe in the A value. Before the fix the "z" landed
		// under "B" and "a|b" broke the row.
		const xlsx = zip({
			"xl/workbook.xml": enc(
				`<?xml version="1.0"?><workbook xmlns:r="r"><sheets><sheet name="Grid" sheetId="1" r:id="rId1"/></sheets></workbook>`,
			),
			"xl/_rels/workbook.xml.rels": enc(
				`<?xml version="1.0"?><Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`,
			),
			"xl/worksheets/sheet1.xml": enc(
				`<?xml version="1.0"?><worksheet><sheetData>` +
					`<row r="1"><c r="A1" t="inlineStr"><is><t>H1</t></is></c><c r="B1" t="inlineStr"><is><t>H2</t></is></c><c r="C1" t="inlineStr"><is><t>H3</t></is></c></row>` +
					`<row r="2"><c r="A2" t="inlineStr"><is><t>a|b</t></is></c><c r="C2" t="inlineStr"><is><t>z</t></is></c></row>` +
					`</sheetData></worksheet>`,
			),
		});

		return convertBufferWithMarkit(xlsx, ".xlsx").then(result => {
			expect(result.ok).toBe(true);
			expect(result.content).toContain("| H1 | H2 | H3 |");
			// z stays under H3; B2 is an empty middle cell; the pipe is escaped.
			expect(result.content).toContain("| a\\|b |  | z |");
		});
	});
});
