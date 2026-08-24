/**
 * Notebook editable text with CRLF still round-trips cells.
 *
 * WHY THIS SUITE EXISTS. `notebookToEditableText` joins on LF, but the edit
 * tool's write-back restores the file's original line endings. A Windows
 * `.ipynb` (or any applyEdits pass that left CR on unedited lines) feeds
 * `applyNotebookEditableText` markers of the form `# %% [code] cell:0\r`.
 * `CELL_MARKER_RE` is `$`-anchored and does not strip CR, so the first line is
 * not a marker and the apply throws "expected first line to be … cell:0".
 * The operator's notebook is unchanged and the edit is dropped.
 *
 * The contract: CRLF editable text parses the same cells as LF. This stays
 * red until markers are recognized with a trailing CR.
 */
import { describe, expect, it } from "bun:test";
import type { NotebookDocument } from "@veyyon/coding-agent/edit/notebook";
import { applyNotebookEditableText, notebookToEditableText } from "@veyyon/coding-agent/edit/notebook";

const nb = (cells: unknown[]): NotebookDocument =>
	({ cells, metadata: {}, nbformat: 4, nbformat_minor: 5 }) as unknown as NotebookDocument;

describe("applyNotebookEditableText CRLF markers", () => {
	it("parses a CRLF encoding of the editable form without throwing, and keeps source", () => {
		const source = nb([
			{ cell_type: "code", source: ["print(1)\n"], metadata: {}, execution_count: 4, outputs: [{ n: 1 }] },
			{ cell_type: "markdown", source: ["# Title"], metadata: { tags: ["t"] } },
		]);
		const lf = notebookToEditableText(source);
		const crlf = lf.replaceAll("\n", "\r\n");
		expect(crlf).toContain("\r\n");
		const back = applyNotebookEditableText(source, crlf, "n.ipynb");
		expect(back.cells).toHaveLength(2);
		expect(back.cells[0].source).toEqual(["print(1)\n"]);
		expect(back.cells[0].execution_count).toBe(4);
		expect(back.cells[0].outputs).toEqual([{ n: 1 }]);
		expect(back.cells[1].source).toEqual(["# Title"]);
		expect(back.cells[1].metadata).toEqual({ tags: ["t"] });
	});
});
