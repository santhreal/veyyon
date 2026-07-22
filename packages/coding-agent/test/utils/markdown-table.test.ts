import { describe, expect, it } from "bun:test";
import { escapeMarkdownTableCell } from "@veyyon/coding-agent/utils/markdown-table";

/**
 * escapeMarkdownTableCell is the single owner of Markdown-table cell escaping,
 * created for FINDING-MD-TABLE-CELL-ESCAPER-DIVERGENT-DUPLICATES. Before it, four
 * call sites carried their own copies that disagreed: some escaped only `|` and
 * `\n`, missing a bare `\r` (which several Markdown renderers treat as a line
 * break) and a `\t`; the PPTX converter escaped nothing at all, so a `|` or
 * newline inside a slide-table cell silently split the row and corrupted every
 * column after it. These tests pin the unified contract: `|` becomes `\|`, and
 * any run of `\r`, `\n`, or `\t` collapses to one space, so a value can never
 * break out of its cell or its row.
 */
describe("escapeMarkdownTableCell", () => {
	it("escapes a pipe so the value stays a single cell", () => {
		expect(escapeMarkdownTableCell("a|b")).toBe("a\\|b");
	});

	it("escapes every pipe in the value, not just the first", () => {
		expect(escapeMarkdownTableCell("a|b|c")).toBe("a\\|b\\|c");
	});

	it("collapses a newline so the value cannot end the row early", () => {
		expect(escapeMarkdownTableCell("line1\nline2")).toBe("line1 line2");
	});

	it("collapses a bare carriage return, which the old \\r?\\n+ copies missed", () => {
		expect(escapeMarkdownTableCell("line1\rline2")).toBe("line1 line2");
	});

	it("collapses a tab, which the mnemopi and tools-markdown copies left raw", () => {
		expect(escapeMarkdownTableCell("a\tb")).toBe("a b");
	});

	it("collapses a mixed run of \\r\\n\\t to exactly one space", () => {
		expect(escapeMarkdownTableCell("a\r\n\t b")).toBe("a  b");
	});

	it("handles a value that both breaks the row and the cell", () => {
		expect(escapeMarkdownTableCell("x|y\nz")).toBe("x\\|y z");
	});

	it("leaves plain text and interior spaces untouched", () => {
		expect(escapeMarkdownTableCell("Alice Smith")).toBe("Alice Smith");
	});

	it("returns an empty string for an empty value", () => {
		expect(escapeMarkdownTableCell("")).toBe("");
	});
});
