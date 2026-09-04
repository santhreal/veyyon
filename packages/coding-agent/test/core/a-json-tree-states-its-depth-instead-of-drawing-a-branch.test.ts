/**
 * WHY THIS SUITE EXISTS. `tools/core/json-tree-view.ts` is the one place a JSON value becomes the
 * lines a card shows for it, for every host. Its terminal twin `json-tree-render.ts` draws the same
 * walk with `├─` glyphs baked into the string, so the view form states nesting as depth instead: two
 * columns per level plus a kind mark. Every field it emits is a string or a number that still
 * compiles when it is wrong, so a type check sees none of this.
 *
 * THE CLASS THIS CLOSES. "A structure reaches a reader as something other than the value the tool
 * held." Five mechanisms carry that and each is asserted at its own boundary: the depth encoding
 * (columns and kind marks, and no branch glyph a non-terminal host would have to strip), the two
 * bounds (depth and lines) with the `truncated` flag that a card turns into an ellipsis row, the
 * scalar cut, the multi-line string that spans rows, and the hidden plumbing keys a reader never
 * asked for.
 *
 * WHAT IT DOES NOT CATCH. How a host DRAWS a line: `icon.folder` resolving to a terminal glyph is
 * `draw-tool-view`'s claim, pinned in the converted-tool differential suites. The bounds are checked
 * against the string walk, and the words each row states with them, but not the columns each walk
 * indents by: one states depth and the other draws a branch, so their whitespace differs by design.
 */

import { describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { initTheme, theme } from "@veyyon/coding-agent/theme/theme";
import { renderJsonTreeLines } from "@veyyon/coding-agent/tools/core/json-tree-render";
import { type JsonTreeBounds, jsonTreeViewLines } from "@veyyon/coding-agent/tools/core/json-tree-view";
import type { ViewLine } from "@veyyon/view";

const BOUNDS: JsonTreeBounds = { maxDepth: 6, maxLines: 200, maxScalarLen: 80 };

/** The visible words of a line, symbol keys included, which is what a reader ends up with. */
function words(line: ViewLine): string {
	return line.map(span => span.symbol ?? span.text).join("");
}

function lines(value: unknown, overrides: Partial<JsonTreeBounds> = {}): string[] {
	return jsonTreeViewLines(value, { ...BOUNDS, ...overrides }).lines.map(words);
}

/** A line's words with its kind mark dropped, which is the part both walks state the same way. */
function labels(line: ViewLine): string {
	return line
		.map(span => span.text)
		.join("")
		.replace(/\s+/g, " ")
		.trim();
}

/** The same words out of a drawn row: the branch, the glyphs and the colours are all non-ASCII. */
function plainLabels(row: string): string {
	return stripVTControlCharacters(row)
		.replace(/[^\x20-\x7E…]/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

describe("a json tree states its depth instead of drawing a branch", () => {
	it("spends two columns per level and marks each node's kind", () => {
		const walked = jsonTreeViewLines({ outer: { items: [1], leaf: "x" } }, BOUNDS);

		expect(walked.truncated).toBe(false);
		expect(walked.lines.map(words)).toEqual([
			"icon.folder outer",
			"  icon.package items",
			"    icon.file [0]: 1",
			'  icon.file leaf: "x"',
		]);
		const indents = walked.lines.map(line => (line[0]?.symbol === undefined ? (line[0]?.text ?? "") : ""));
		expect(indents).toEqual(["", "  ", "    ", "  "]);
	});

	it("draws no branch glyph a host would have to strip", () => {
		const drawn = lines({ tree: { deep: { deeper: [{ leaf: true }] } } }).join("\n");

		expect(drawn).not.toContain("├");
		expect(drawn).not.toContain("└");
		expect(drawn).not.toContain("│");
		expect(drawn).not.toContain("─");
	});

	it("labels a top-level scalar and keys array members by index", () => {
		expect(lines(42)).toEqual(["icon.file value: 42"]);
		expect(lines(["a", "b"])).toEqual(['icon.file [0]: "a"', 'icon.file [1]: "b"']);
	});

	it("closes an empty container with its own brackets and calls nothing truncated", () => {
		const empties = jsonTreeViewLines({ list: [], map: {} }, BOUNDS);

		expect(empties.truncated).toBe(false);
		expect(empties.lines.map(words)).toEqual(["icon.package list", "  []", "icon.folder map", "  {}"]);
	});

	it("stops at the depth bound with an ellipsis row, and leaves the flag to the line budget", () => {
		// A root child is level 1, which is the level `maxDepth` counts, so a bound of 1 states the root
		// keys and closes each container under them. The terminal walk this replaces bounded the same
		// level, and a card that allowed one more would deepen every walk in the product by a level.
		const cut = jsonTreeViewLines({ a: { b: { c: 1 } } }, { ...BOUNDS, maxDepth: 1 });

		expect(cut.lines.map(words)).toEqual(["icon.folder a", "  …"]);
		// The cut is already in the rows, so a card reading the flag adds no second ellipsis for it.
		expect(cut.truncated).toBe(false);

		const deeper = jsonTreeViewLines({ a: { b: { c: 1 } } }, { ...BOUNDS, maxDepth: 2 });
		expect(deeper.lines.map(words)).toEqual(["icon.folder a", "  icon.folder b", "    …"]);
		expect(deeper.truncated).toBe(false);
	});

	it("never spends more lines than the bound allows, and says it was cut", () => {
		const many = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`k${index}`, index]));
		const bounded = jsonTreeViewLines(many, { ...BOUNDS, maxLines: 4 });

		expect(bounded.lines).toHaveLength(4);
		expect(bounded.lines.map(words)).toEqual([
			"icon.file k0: 0",
			"icon.file k1: 1",
			"icon.file k2: 2",
			"icon.file k3: 3",
		]);
		expect(bounded.truncated).toBe(true);
	});

	it("cuts a long scalar at the scalar bound", () => {
		const [row] = lines({ note: "z".repeat(40) }, { maxScalarLen: 8 });

		expect(row).toBe('icon.file note: "zzzzzzz…"');
	});

	it("hangs a multi-line string under its key and closes the quote on the last row", () => {
		const spanned = jsonTreeViewLines({ body: "first\nsecond\nthird" }, BOUNDS);

		expect(spanned.truncated).toBe(false);
		expect(spanned.lines.map(words)).toEqual(['icon.file body: "first', "  second", '  third"']);
	});

	it("states how many rows of a multi-line string it held back", () => {
		const held = jsonTreeViewLines({ body: "one\ntwo\nthree\nfour" }, { ...BOUNDS, maxLines: 3 });

		expect(held.lines.map(words)).toEqual(['icon.file body: "one', "  two", '  …(2 more lines)"']);
		expect(held.truncated).toBe(true);
	});

	/**
	 * A bare string is the one value no container loop follows, so the string walk is the only thing
	 * that can report the cut. A card that shows an ellipsis row off `truncated` shows nothing here
	 * unless the walk itself says so.
	 */
	it("reports a top-level multi-line string as cut with no container to notice", () => {
		const held = jsonTreeViewLines("one\ntwo\nthree\nfour", { ...BOUNDS, maxLines: 3 });

		expect(held.lines.map(words)).toEqual(['icon.file value: "one', "  two", '  …(2 more lines)"']);
		expect(held.truncated).toBe(true);
	});

	it("drops the plumbing keys a tool wrote into its own arguments", () => {
		expect(lines({ i: "an intent", __partialJson: '{"pat', pat: "x" })).toEqual(['icon.file pat: "x"']);
	});

	/**
	 * The bounds are the reader's, and a card passes the same numbers to whichever walk its host uses.
	 * A level counted differently here than in the string walk deepens or shortens every structure in
	 * the product by a level while both stay green on their own, which is the defect this closes: the
	 * view walk numbered a root child 0 where the string walk numbered it 1, so a collapsed card
	 * showed one level more than the terminal ever had.
	 */
	it("cuts at the same level and the same row as the string walk it replaces", async () => {
		await initTheme();
		const fixture = { a: { b: { c: [1, { d: "x" }] } }, top: 3 };

		for (const maxDepth of [1, 2, 3, 4, 5]) {
			for (const maxLines of [3, 200]) {
				const walked = jsonTreeViewLines(fixture, { maxDepth, maxLines, maxScalarLen: 80 });
				const drawn = renderJsonTreeLines(fixture, theme, maxDepth, maxLines, 80);

				expect({ maxDepth, maxLines, rows: walked.lines.map(labels), cut: walked.truncated }).toEqual({
					maxDepth,
					maxLines,
					rows: drawn.lines.map(plainLabels),
					cut: drawn.truncated,
				});
			}
		}
	});
});
