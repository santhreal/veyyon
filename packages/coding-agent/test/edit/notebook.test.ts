import { describe, expect, it } from "bun:test";
import type { NotebookDocument } from "@veyyon/coding-agent/edit/notebook";
import {
	applyNotebookEditableText,
	isNotebookPath,
	notebookToEditableText,
	splitNotebookSource,
} from "@veyyon/coding-agent/edit/notebook";

/**
 * notebook.ts converts a .ipynb between its JSON form and a flat editable text the
 * edit tool can patch (each cell prefixed with `# %% [type] cell:N`), then folds an
 * edited text back onto the original cells. It had ZERO tests despite two subtle
 * contracts a regression would silently break:
 *
 *  - The round trip must preserve per-cell metadata, execution_count, and outputs
 *    by matching each parsed cell back to its original by index, and must add/drop
 *    execution_count+outputs when a cell's type flips to/from code.
 *  - A source line that itself looks like a cell marker (`# %% [markdown] cell:3`)
 *    must be escaped (extra `%`) on render and unescaped on parse, so a notebook
 *    that CONTAINS marker-like text is not split into phantom cells.
 *
 * These assert the exact editable text, the exact restored cell fields, and the
 * escape round trip.
 */

const nb = (cells: unknown[], metadata: Record<string, unknown> = {}): NotebookDocument =>
	({ cells, metadata, nbformat: 4, nbformat_minor: 5 }) as unknown as NotebookDocument;

describe("isNotebookPath", () => {
	it("matches the .ipynb extension case-insensitively", () => {
		expect(isNotebookPath("/a/b.ipynb")).toBe(true);
		expect(isNotebookPath("/a/b.IPYNB")).toBe(true);
		expect(isNotebookPath("/a/b.py")).toBe(false);
	});
});

describe("splitNotebookSource", () => {
	it("splits into Jupyter-style lines that keep their trailing newline", () => {
		expect(splitNotebookSource("")).toEqual([]);
		expect(splitNotebookSource("a")).toEqual(["a"]);
		expect(splitNotebookSource("a\n")).toEqual(["a\n"]);
		expect(splitNotebookSource("a\nb")).toEqual(["a\n", "b"]);
		expect(splitNotebookSource("a\n\n")).toEqual(["a\n", "\n"]);
	});
});

describe("notebookToEditableText", () => {
	it("prefixes each cell with a typed marker and omits the body for empty cells", () => {
		const text = notebookToEditableText(
			nb([
				{ cell_type: "code", source: ["print(1)\n"], metadata: {} },
				{ cell_type: "markdown", source: ["# Title\n", "body"], metadata: {} },
				{ cell_type: "code", source: [], metadata: {} },
			]),
		);
		expect(text).toBe("# %% [code] cell:0\nprint(1)\n\n# %% [markdown] cell:1\n# Title\nbody\n# %% [code] cell:2");
	});
});

describe("applyNotebookEditableText round trip", () => {
	const source = nb(
		[
			{ cell_type: "code", source: ["print(1)\n"], metadata: {}, execution_count: 5, outputs: [{ x: 1 }] },
			{ cell_type: "markdown", source: ["# Title\n", "body"], metadata: { tags: ["t"] } },
			{ cell_type: "code", source: [], metadata: {} },
		],
		{ kernelspec: { name: "python3" } },
	);

	it("preserves source, execution_count, outputs, cell metadata, and doc metadata on an identity edit", () => {
		const back = applyNotebookEditableText(source, notebookToEditableText(source), "n.ipynb");
		expect(back.cells[0].source).toEqual(["print(1)\n"]);
		expect(back.cells[0].execution_count).toBe(5);
		expect(back.cells[0].outputs).toEqual([{ x: 1 }]);
		expect(back.cells[1].source).toEqual(["# Title\n", "body"]);
		expect(back.cells[1].metadata).toEqual({ tags: ["t"] });
		expect(back.cells[2].source).toEqual([]);
		expect(back.metadata).toEqual({ kernelspec: { name: "python3" } });
	});
});

describe("applyNotebookEditableText cell-type transitions and matching", () => {
	const source = nb([
		{ cell_type: "code", source: ["x=1"], metadata: { a: 1 }, execution_count: 9, outputs: [{ o: 1 }] },
		{ cell_type: "markdown", source: ["md"], metadata: {} },
	]);

	it("drops execution_count and outputs when a code cell becomes markdown, keeping metadata", () => {
		const result = applyNotebookEditableText(source, "# %% [markdown] cell:0\nx=1", "n.ipynb");
		expect(result.cells[0].cell_type).toBe("markdown");
		expect("execution_count" in result.cells[0]).toBe(false);
		expect("outputs" in result.cells[0]).toBe(false);
		expect(result.cells[0].metadata).toEqual({ a: 1 });
	});

	it("adds a null execution_count and empty outputs when a markdown cell becomes code", () => {
		const result = applyNotebookEditableText(source, "# %% [code] cell:1\nmd", "n.ipynb");
		expect(result.cells[0].execution_count).toBeNull();
		expect(result.cells[0].outputs).toEqual([]);
	});

	it("matches cells by their index marker so reordering carries fields along", () => {
		const result = applyNotebookEditableText(
			source,
			"# %% [markdown] cell:1\nmd\n# %% [code] cell:0\nx=1",
			"n.ipynb",
		);
		expect(result.cells).toHaveLength(2);
		expect(result.cells[0].source).toEqual(["md"]);
		expect(result.cells[1].execution_count).toBe(9);
		expect(result.cells[1].outputs).toEqual([{ o: 1 }]);
	});

	it("creates a fresh cell for a brand-new, duplicate, or out-of-range index", () => {
		const fresh = applyNotebookEditableText(source, "# %% [code]\nnew", "n.ipynb");
		expect(fresh.cells[0].outputs).toEqual([]);
		expect(fresh.cells[0].source).toEqual(["new"]);

		const dup = applyNotebookEditableText(source, "# %% [code] cell:0\nx=1\n# %% [code] cell:0\ny=2", "n.ipynb");
		expect(dup.cells[0].outputs).toEqual([{ o: 1 }]);
		expect(dup.cells[1].outputs).toEqual([]);

		const oob = applyNotebookEditableText(source, "# %% [code] cell:99\nz=3", "n.ipynb");
		expect(oob.cells[0].source).toEqual(["z=3"]);
	});

	it("throws when the editable text does not start with a cell marker", () => {
		expect(() => applyNotebookEditableText(source, "not a marker", "n.ipynb")).toThrow(
			"Invalid notebook editable representation for n.ipynb",
		);
	});
});

describe("applyNotebookEditableText marker escaping", () => {
	it("round-trips a source line that itself looks like a cell marker without splitting", () => {
		const source = nb([{ cell_type: "markdown", source: ["# %% [markdown] cell:3\n", "real"], metadata: {} }]);
		const text = notebookToEditableText(source);
		// the marker-like source line gains a % so it is not seen as a new cell.
		expect(text).toBe("# %% [markdown] cell:0\n# %%% [markdown] cell:3\nreal");
		const back = applyNotebookEditableText(source, text, "n.ipynb");
		expect(back.cells).toHaveLength(1);
		expect(back.cells[0].source).toEqual(["# %% [markdown] cell:3\n", "real"]);
	});
});
