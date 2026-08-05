/**
 * A description that does not fit its column must SAY it was cut.
 *
 * THE BUG THIS LOCKS OUT. `SelectList` cut an overlong description with
 * `Ellipsis.Omit`, so the row ended mid-word with nothing to mark the loss:
 * "Every tool call asks first, reads in" read as finished copy that happened to
 * end oddly, and the only way to notice was to already know the sentence. The
 * cost was not cosmetic. The setup wizard's authors could not see the column
 * boundary either, so they shortened row copy by hand across four scenes to stay
 * inside a width nothing reported, which is the same defect one step earlier.
 *
 * IF IT REGRESSES: every picker in the product silently truncates row copy
 * again, and the next person to write a description longer than the column ships
 * a fragment without knowing it.
 */
import { describe, expect, it } from "bun:test";
import { SelectList, type SelectListTheme } from "@veyyon/tui/components/select-list";
import type { BoxSymbols } from "@veyyon/tui/symbols";

const box: BoxSymbols = {
	topLeft: "┌",
	topRight: "┐",
	bottomLeft: "└",
	bottomRight: "┘",
	horizontal: "─",
	vertical: "│",
	teeDown: "┬",
	teeUp: "┴",
	teeLeft: "┤",
	teeRight: "├",
	cross: "┼",
};

/** Identity paints: assertions read the row text, not the styling around it. */
const theme: SelectListTheme = {
	selectedPrefix: (text: string) => text,
	selectedText: (text: string) => text,
	description: (text: string) => text,
	scrollInfo: (text: string) => text,
	noMatch: (text: string) => text,
	symbols: {
		cursor: "→",
		inputCursor: "|",
		boxRound: { topLeft: "╭", topRight: "╮", bottomLeft: "╰", bottomRight: "╯", horizontal: "─", vertical: "│" },
		boxSharp: box,
		table: box,
		quoteBorder: "│",
		hrChar: "─",
		spinnerFrames: ["|", "/", "-", "\\"],
	},
};

/**
 * At width 60 the description column is 24 cells wide (2 prefix + a 32-cell
 * primary column + 2 of safety margin), so a 60-character sentence cannot fit
 * and a 12-character one fits with room to spare.
 */
const WIDTH = 60;
const LONG = "Every tool call asks first, reads included, no exceptions.";
const SHORT = "Asks first";

describe("SelectList description truncation", () => {
	it("marks a description it had to cut with an ellipsis", () => {
		const list = new SelectList([{ value: "row", label: "row", description: LONG }], 5, theme);

		const rendered = list.render(WIDTH).join("\n");

		expect(rendered).toContain("…");
		// The tail is gone, which is the point: the ellipsis is the only thing
		// that says so.
		expect(rendered).not.toContain("no exceptions.");
		// And the surviving head is real text from the description, not a
		// placeholder: the row still says what it can.
		expect(rendered).toContain("Every tool call asks");
	});

	it("leaves a description that fits completely unmarked", () => {
		const list = new SelectList([{ value: "row", label: "row", description: SHORT }], 5, theme);

		const rendered = list.render(WIDTH).join("\n");

		expect(rendered).toContain(SHORT);
		expect(rendered).not.toContain("…");
	});

	/**
	 * The ellipsis must be paid for out of the description's own column, not
	 * added past it: a row one cell wider than the frame wraps in the host's
	 * terminal and costs a whole line.
	 */
	it("keeps the cut row inside the width it was given", () => {
		const list = new SelectList([{ value: "row", label: "row", description: LONG }], 5, theme);

		for (const line of list.render(WIDTH)) {
			expect(line.length).toBeLessThanOrEqual(WIDTH);
		}
	});
});
