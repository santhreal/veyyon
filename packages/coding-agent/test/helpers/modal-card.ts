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
import { theme } from "@veyyon/coding-agent/modes/theme/theme";

/**
 * The card's content columns, ANSI stripped, one string per body row.
 *
 * Rules and dividers are dropped (they carry tees, not verticals); the search
 * line, padding rows and footer chips are kept, because a caller looking for a
 * row by its text does not care which band it came from.
 */
export function cardBodyLines(frame: readonly string[]): string[] {
	const box = theme.boxSharp;
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
		.map(line => line.slice(left + 2, right - 1).trimEnd());
}
