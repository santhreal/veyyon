/**
 * How the terminal breaks one row of a change across several rows of a narrow window.
 *
 * A diff row is a gutter and a body: `-315│const x = 1`. Wrapping it the way prose wraps puts the
 * tail of a long line back in the gutter column, where it reads as one more changed line rather than
 * as the rest of the one above it. So the gutter is measured, the body is wrapped to what is left,
 * and every row after the first opens with a blank gutter of the same width.
 *
 * The terminal owns this because the width is the terminal's: a tool states the change and never how
 * many columns a reader has.
 */

import { SGR_FG_RESET } from "@veyyon/utils/ansi";
import { visibleWidth } from "@veyyon/utils/width";
import { wrapTextWithAnsi } from "@veyyon/utils/wrap";

/**
 * Split a diff row into the prefix it keeps on its first row and the prefix its wrapped rows carry
 * instead. `undefined` means the row is not a diff row and wraps as prose.
 *
 * Gutter shapes the diff renderer produces: `-315│`, ` 313│`, `+322│`, plus the deduplicated forms
 * `   +│` and `    │` whose repeated line number it blanked -- all `│`-separated. An ASCII `|`
 * gutter appears only in a canonical row passed through uncoloured (`-42|old`, ` 42|ctx`), which
 * always carries a marker column and a number. So the number is optional for `│`, while `|` requires
 * the full canonical shape; anything else -- a body line that merely starts with `|`, error text
 * like `123|…` -- is not a diff row.
 *
 * A row from a change computed before the edit landed has no number to draw, so its gutter is the
 * marker alone: `+return raw.split(...)`. It wraps as often as a numbered row does, and a wrapped
 * row that started back in the marker column would read as one more added line.
 */
function splitDiffRow(body: string): { prefix: string; continuation: string; content: string } | undefined {
	const gutter = /^(\s*[+-]?\s*\d*)([|│])(.*)$/s.exec(body);
	if (gutter && gutter[1].length > 0 && (gutter[2] === "│" || /^[+\-\s]\s*\d+$/.test(gutter[1]))) {
		const prefix = `${gutter[1]}${gutter[2]}`;
		return {
			prefix,
			continuation: `${" ".repeat(Math.max(0, visibleWidth(prefix) - 1))}${gutter[2]}`,
			content: gutter[3] ?? "",
		};
	}
	const marker = /^([+-])(.*)$/s.exec(body);
	if (marker) return { prefix: marker[1] ?? "", continuation: " ", content: marker[2] ?? "" };
	return undefined;
}

/** One drawn diff row as the rows it occupies at this width, each opening in its own gutter. */
export function wrapDiffRow(line: string, width: number): string[] {
	if (width <= 0) return [line];
	if (line.length === 0) return [""];

	const startAnsi = line.match(/^((?:\x1b\[[0-9;]*m)*)/)?.[1] ?? "";
	const bodyWithReset = line.slice(startAnsi.length);
	const body = bodyWithReset.endsWith(SGR_FG_RESET) ? bodyWithReset.slice(0, -SGR_FG_RESET.length) : bodyWithReset;
	const split = splitDiffRow(body);
	if (!split) return wrapTextWithAnsi(line, width);

	const contentWidth = Math.max(1, width - visibleWidth(split.prefix));
	const wrappedContent = wrapTextWithAnsi(split.content, contentWidth);

	// Each row is a standalone terminal line: the wrap re-opens active SGR state at the next row's
	// start, so a row that breaks inside an intra-line highlight still ends with inverse video
	// active. Close it alongside the foreground reset -- otherwise the padding the frame appends
	// after the row is painted as an inverse block.
	return wrappedContent.map(
		(segment, index) => `${startAnsi}${index === 0 ? split.prefix : split.continuation}${segment}\x1b[27m\x1b[39m`,
	);
}
