import { truncateToWidth } from "@veyyon/tui/utils";

/** Cells a palette row gives a command's description before it is cut. */
const DESCRIPTION_CELLS = 60;

/**
 * The description a command shows when its frontmatter states none: the body's
 * first line with something on it, cut to the width a palette row gives it.
 *
 * Three loaders built this by hand — the extension slash-command parser, the
 * legacy prompt-template shim and the built-in template loader — and all three
 * kept 60 UTF-16 code units and then appended three ASCII periods, which is 63
 * columns of a 60-column budget, marked in a spelling no other row in the
 * product uses. The cut is in cells and the mark is one `…`, because the result
 * is a row.
 *
 * An empty body gives an empty description, which every caller already handles
 * by falling back to its source label.
 */
export function descriptionFromBody(body: string): string {
	const firstLine = body.split("\n").find(line => line.trim());
	return firstLine ? truncateToWidth(firstLine, DESCRIPTION_CELLS) : "";
}
