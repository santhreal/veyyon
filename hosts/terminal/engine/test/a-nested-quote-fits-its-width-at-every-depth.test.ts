/**
 * WHY: a blockquote reserves two cells for its `│ ` border and lays its content out in the rest. Once nesting used up
 * the width, the content width clamped to one cell while every deeper quote still prefixed its two-cell border, so
 * each enclosing quote re-wrapped those three-cell rows at one cell and split every row in two. The row count doubled
 * per nesting level: `>`×20 around fifteen characters rendered 425,984 rows at width 12 and took half a second per
 * frame, on model output the TUI renders on every streamed chunk.
 *
 * The class is any quote nesting, of any container content, whose rows outgrow the width they are given and so
 * multiply under the enclosing quotes. The sweep covers every width from 1 to 40 and every depth up to past both
 * nesting caps (the input marker cap and Markdown.MAX_RENDER_DEPTH), for unspaced and spaced `>` runs around a
 * paragraph, a list, a heading and an HTML `<blockquote>`. Each frame must fit its width, and hold no more rows than
 * the source has characters, since every row carries at least one source character.
 *
 * The same nesting once grew each row's bytes instead of its count: every level re-applied the quote style, which
 * re-opens the style after every close the inner levels wrote, so `>`×20 around "deep" was a 3,687-byte row and a
 * width sweep spent most of its time styling escapes. Each row must stay within a fixed number of bytes per level,
 * the cost of one border, plus a constant for the content's own styling.
 *
 * Not caught: a single quote level whose content row overflows by one wide grapheme at a one-cell width, which wraps
 * once and does not compound; content that is not ASCII is outside the width assertion for that reason.
 */
import { describe, expect, it } from "bun:test";
import { Markdown } from "@veyyon/tui/components/markdown";
import { visibleWidth } from "@veyyon/utils/width";
import { defaultMarkdownTheme } from "./test-themes.js";

const MAX_WIDTH = 40;
/** Bytes one quote level adds to a row: its styled `│ ` border. */
const ROW_BYTES_PER_LEVEL = 16;
/** Bytes a row's content and its styling may take regardless of depth. */
const ROW_BYTES_BASE = 96;
const MAX_DEPTH = Markdown.MAX_RENDER_DEPTH + 8;
const MARKERS = { unspaced: (depth: number) => ">".repeat(depth), spaced: (depth: number) => "> ".repeat(depth) };
const CONTENT = {
	paragraph: "deep words here",
	list: "- deep words here",
	heading: "## deep words here",
	html: "<blockquote>deep words here</blockquote>",
};

describe("a nested quote", () => {
	for (const [markerName, marker] of Object.entries(MARKERS)) {
		for (const [contentName, content] of Object.entries(CONTENT)) {
			it(`fits its width at every depth (${markerName} markers around a ${contentName})`, () => {
				for (let depth = 1; depth <= MAX_DEPTH; depth++) {
					const source = `${marker(depth)} ${content}`;
					for (let width = 1; width <= MAX_WIDTH; width++) {
						const rows = new Markdown(source, 0, 0, defaultMarkdownTheme).render(width);
						const label = `depth ${depth} width ${width}`;
						expect({ label, rows: rows.length <= source.length }).toEqual({ label, rows: true });
						const wide = rows.filter(row => visibleWidth(row) > width);
						expect({ label, wide }).toEqual({ label, wide: [] });
						const bloated = rows.filter(row => row.length > ROW_BYTES_BASE + ROW_BYTES_PER_LEVEL * depth);
						expect({ label, bloated }).toEqual({ label, bloated: [] });
					}
				}
			});
		}
	}
});
