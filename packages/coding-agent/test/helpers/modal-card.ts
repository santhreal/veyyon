/**
 * Read the body of a rendered ModalShell card out of a full-screen frame.
 *
 * A card paints a whole terminal frame: empty pads around a centered box whose
 * body rows are `│ <content> │`. A suite that asserts on what a list DRAWS —
 * a gutter column, a cursor glyph at the start of a row — is asserting on the
 * content columns, and the border plus the left pad shift every one of them.
 * Slicing them off here keeps those assertions about the list instead of about
 * where the card happens to sit on screen.
 */
import { cardBox } from "@veyyon/coding-agent/modes/components/overlay-box";
import { theme } from "@veyyon/coding-agent/modes/theme/theme";

/**
 * The card's content columns, ANSI stripped, one string per body row.
 *
 * Rules and dividers are dropped; the search line, padding rows and footer
 * chips are kept, because a caller looking for a row by its text does not care
 * which band it came from. A section rule is inset now (`│ ──── │` rather than
 * a welded `├────┤`), so it reaches the body filter as an ordinary row and is
 * dropped by its content instead of by its left column.
 */
export function cardBodyLines(frame: readonly string[]): string[] {
	const box = cardBox(theme);
	const plain = frame.map(line => Bun.stripANSI(line));
	const top = plain.findIndex(line => line.includes(box.topLeft));
	if (top === -1) throw new Error("cardBodyLines: the frame carries no ModalShell card");
	const topLine = plain[top] as string;
	const left = topLine.indexOf(box.topLeft);
	const right = topLine.lastIndexOf(box.topRight);
	// Anchored at the card's own left column, not at the first `└` in the frame:
	// a tree row draws that glyph too, and matching it closed the card three
	// rows into its body and dropped every entry below the branch.
	const bottom = plain.findIndex((line, row) => row > top && line[left] === box.bottomLeft);
	if (bottom === -1) throw new Error("cardBodyLines: the card has no bottom border");
	return plain
		.slice(top + 1, bottom)
		.filter(line => line[left] === box.vertical)
		.map(line => line.slice(left + 2, right - 1).trimEnd())
		.filter(content => content !== box.horizontal.repeat(content.length) || content.length === 0);
}

/**
 * The frame row holding the card's first section rule, or -1.
 *
 * A rule was identifiable by the `├` welded into the left border. It is inset
 * now (`│ ──── │`), so what identifies it is its CONTENT: a card row drawn from
 * nothing but rule glyphs. The split rule keeps the tee that closes the sidebar
 * column, so that glyph counts as rule too.
 */
export function cardRuleRowIndex(frame: readonly string[]): number {
	const box = cardBox(theme);
	return frame.findIndex(line => {
		const content = Bun.stripANSI(line).trim();
		if (!content.startsWith(box.vertical) || !content.endsWith(box.vertical)) return false;
		const inner = content.slice(box.vertical.length, -box.vertical.length).trim();
		return inner.length > 0 && [...inner].every(glyph => glyph === box.horizontal || glyph === box.teeUp);
	});
}
