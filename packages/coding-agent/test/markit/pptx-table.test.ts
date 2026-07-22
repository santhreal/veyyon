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

/**
 * Locks FINDING-PPTX-TABLE-CELL-RUN-JOIN-SPACES. A DrawingML `<a:r>` run boundary
 * marks a formatting change (bold, color, language), not a word break, so a word
 * split across a boundary — "Hello" stored as run "Hel" + run "lo" — must render
 * as "Hello". extractTable used to join a cell's runs with a space, producing the
 * corrupt "Hel lo" in a table cell while the identical text rendered as "Hello" in
 * slide body. Both paths now route through the single textFromBody owner, which
 * joins runs with the empty string, so a cell and a body shape agree.
 */
describe("PptxConverter run joining", () => {
	const twoRunCell = (a: string, b: string): string =>
		`<a:tc><a:txBody><a:p><a:r><a:t>${a}</a:t></a:r><a:r><a:t>${b}</a:t></a:r></a:p></a:txBody></a:tc>`;

	const buildPptx = (slideBody: string): Uint8Array =>
		zip({
			"ppt/presentation.xml": enc(
				`<?xml version="1.0"?><p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>`,
			),
			"ppt/_rels/presentation.xml.rels": enc(
				`<?xml version="1.0"?><Relationships><Relationship Id="rId1" Target="slides/slide1.xml"/></Relationships>`,
			),
			"ppt/slides/slide1.xml": enc(
				`<?xml version="1.0"?><p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree>${slideBody}</p:spTree></p:cSld></p:sld>`,
			),
		});

	it("joins a table cell's runs with no inserted space", async () => {
		const table =
			`<p:graphicFrame><a:graphic><a:graphicData><a:tbl>` +
			`<a:tr>${twoRunCell("Head", "er")}</a:tr>` +
			`<a:tr>${twoRunCell("Hel", "lo")}</a:tr>` +
			`</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
		const result = await convertBufferWithMarkit(buildPptx(table), ".pptx");
		expect(result.ok).toBe(true);
		expect(result.content).toContain("| Header |");
		expect(result.content).toContain("| Hello |");
		expect(result.content).not.toContain("Hel lo");
	});

	it("renders identical two-run text the same in a body shape and a table cell", async () => {
		const bodyShape = `<p:sp><p:txBody><a:p><a:r><a:t>Hel</a:t></a:r><a:r><a:t>lo</a:t></a:r></a:p></p:txBody></p:sp>`;
		const table =
			`<p:graphicFrame><a:graphic><a:graphicData><a:tbl>` +
			`<a:tr>${twoRunCell("Col", "umn")}</a:tr>` +
			`<a:tr>${twoRunCell("Hel", "lo")}</a:tr>` +
			`</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
		const result = await convertBufferWithMarkit(buildPptx(bodyShape + table), ".pptx");
		expect(result.ok).toBe(true);
		// Body shape: first text shape becomes the slide title heading.
		expect(result.content).toContain("# Hello");
		// Table cell: same two runs, same joined text, in a cell.
		expect(result.content).toContain("| Hello |");
		expect(result.content).not.toContain("Hel lo");
	});
});
