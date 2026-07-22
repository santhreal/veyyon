import { describe, expect, it } from "bun:test";
import { parsePipeRow } from "@veyyon/coding-agent/markit/converters/pdf/render";

/**
 * Locks FINDING-PDF-PARSEPIPEROW-SPLITS-ESCAPED-PIPE. parsePipeRow re-parses a
 * table row that escapePipes already rendered, so a literal pipe in a cell
 * arrives as `\|`. The parser must treat `\|` as cell content, not a delimiter;
 * splitting on it inflated the column count and made
 * normalizeDetachedFirstColumnTables silently skip any pipe-bearing table. The
 * escape is preserved (not unescaped) so a parsed cell re-joins into a row
 * without a re-escape. These assert the exact cell arrays.
 */
describe("parsePipeRow escaped-pipe handling", () => {
	it("splits a plain row on its delimiters", () => {
		expect(parsePipeRow("| a | b | c |")).toEqual(["a", "b", "c"]);
	});

	it("keeps an escaped pipe inside its cell instead of splitting on it", () => {
		// Before the fix this produced ["a \\", "b", "c"] — three cells from two.
		expect(parsePipeRow("| a \\| b | c |")).toEqual(["a \\| b", "c"]);
	});

	it("keeps multiple escaped pipes in one cell as a single cell", () => {
		expect(parsePipeRow("| a \\| b \\| c |")).toEqual(["a \\| b \\| c"]);
	});

	it("still splits real delimiters that surround an escaped-pipe cell", () => {
		expect(parsePipeRow("| x | a \\| b | y |")).toEqual(["x", "a \\| b", "y"]);
	});

	it("trims surrounding whitespace from each cell", () => {
		expect(parsePipeRow("|   left   |  right  |")).toEqual(["left", "right"]);
	});

	it("returns no cells for a line that is not a pipe row", () => {
		expect(parsePipeRow("just some text")).toEqual([]);
		expect(parsePipeRow("| missing end")).toEqual([]);
	});
});
