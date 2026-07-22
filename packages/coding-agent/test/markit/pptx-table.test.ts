import { describe, expect, it } from "bun:test";
import { convertBufferWithMarkit } from "@veyyon/coding-agent/utils/markit";
import { zip } from "@veyyon/coding-agent/utils/zip";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

/**
 * Locks the PPTX half of FINDING-MD-TABLE-CELL-ESCAPER-DIVERGENT-DUPLICATES. The
 * PPTX converter built each table row by joining raw cell text with " | " and no
 * escaping. A slide-table cell that contained a `|` therefore introduced an extra
 * column separator, shifting every following cell one column left and corrupting
 * the whole row against its header. Routing the cells through the shared
 * escapeMarkdownTableCell keeps `a|b` a single cell.
 */
describe("PptxConverter table cell escaping", () => {
	it("escapes a pipe inside a slide-table cell so the row keeps its columns", async () => {
		const cell = (text: string): string =>
			`<a:tc><a:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></a:txBody></a:tc>`;
		const row = (...cells: string[]): string => `<a:tr>${cells.join("")}</a:tr>`;
		const pptx = zip({
			"ppt/presentation.xml": enc(
				`<?xml version="1.0"?><p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>`,
			),
			"ppt/_rels/presentation.xml.rels": enc(
				`<?xml version="1.0"?><Relationships><Relationship Id="rId1" Target="slides/slide1.xml"/></Relationships>`,
			),
			"ppt/slides/slide1.xml": enc(
				`<?xml version="1.0"?><p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree>` +
					`<p:graphicFrame><a:graphic><a:graphicData><a:tbl>` +
					row(cell("Name"), cell("Note")) +
					row(cell("Alice"), cell("a|b")) +
					`</a:tbl></a:graphicData></a:graphic></p:graphicFrame>` +
					`</p:spTree></p:cSld></p:sld>`,
			),
		});

		const result = await convertBufferWithMarkit(pptx, ".pptx");
		expect(result.ok).toBe(true);
		expect(result.content).toContain("| Name | Note |");
		// The pipe is escaped, so "a|b" stays in the second column instead of
		// spawning a phantom third column.
		expect(result.content).toContain("| Alice | a\\|b |");
	});
});
