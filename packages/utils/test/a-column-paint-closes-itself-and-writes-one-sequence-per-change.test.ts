/**
 * WHY. `paintLineBackground` and `paintBlockBackground` are exported from the tui barrel and back
 * every surface treatment that moves across a row, yet no test named them. Two of their properties
 * are the difference between a lit card and a corrupted screen, and both are invisible to a test
 * that only checks the text came back.
 *
 * The first is closure. A background this pass opens must be closed by this pass, or it survives
 * past the last column it owns and runs off the card's right edge across the rest of the page. The
 * subtle half is that a component's own `\x1b[39m` closes a FOREGROUND and leaves the background
 * untouched: a pass that read every component sequence as "my paint was closed" would stop emitting
 * the `49m` that actually closes it. That is the bleed this suite pins.
 *
 * The second is cost. These run per row per frame, and a truecolor background is nineteen bytes a
 * cell, so a sequence is written only where the answer CHANGES. A refactor that emits one per cell
 * stays visually identical and is a large regression; only a byte assertion can see it.
 *
 * The class this closes: paint that outlives its window, paint that stops early because a component
 * sequence was misread, a per-cell rewrite, and column accounting that a wide grapheme or a
 * combining sequence throws off.
 *
 * What it does not catch: whether a chosen colour is the right colour, and how the surface module
 * above this one derives its gradient, which is that module's own contract. Its filename is spelled
 * out nowhere here on purpose, because the coverage floor counts a raw substring as naming a module
 * and a mention in a comment would credit it with a test it does not have.
 */
import { describe, expect, it } from "bun:test";
import { paintBlockBackground, paintLineBackground } from "@veyyon/utils/paint-columns";

const CSI = "\x1b[";
const RESET_BG = `${CSI}49m`;
const bg = (r: number, g: number, b: number): string => `${CSI}48;2;${r};${g};${b}m`;

/** Count of background sequences a result writes, which is what the per-change contract bounds. */
function backgroundSequenceCount(text: string): number {
	return text.split(`${CSI}48;2;`).length - 1;
}

describe("paintLineBackground", () => {
	it("leaves the line untouched when the painter claims no column", () => {
		const line = `${CSI}31mred${CSI}39m`;

		expect(paintLineBackground(line, 3, () => undefined)).toBe(line);
	});

	it("writes one background sequence for a run of columns that want the same colour", () => {
		const painted = paintLineBackground("abcdefgh", 8, () => "#102030");

		expect(backgroundSequenceCount(painted)).toBe(1);
		expect(painted).toBe(`${bg(16, 32, 48)}abcdefgh${RESET_BG}`);
	});

	it("writes a sequence only where the answer changes, not once per cell", () => {
		// Two halves, so the whole eight-column row costs two sequences and one close.
		const painted = paintLineBackground("abcdefgh", 8, ({ col }) => (col < 4 ? "#010203" : "#040506"));

		expect(backgroundSequenceCount(painted)).toBe(2);
		expect(painted).toBe(`${bg(1, 2, 3)}abcd${bg(4, 5, 6)}efgh${RESET_BG}`);
	});

	it("closes the background it opened so the paint cannot outlive the line", () => {
		const painted = paintLineBackground("ab", 2, () => "#ffffff");

		expect(painted.endsWith(RESET_BG)).toBe(true);
	});

	it("keeps painting across a foreground close, and still closes its own paint", () => {
		// The bleed: `39m` ends a colour the component opened and says nothing about the
		// background, so the pass must neither stop painting nor forget to close.
		const line = `${CSI}31mab${CSI}39mcd`;

		const painted = paintLineBackground(line, 4, () => "#0a0b0c");

		// The component's own sequence stays where it was written: the paint opens on the first
		// CELL, which is after it.
		expect(painted).toBe(`${CSI}31m${bg(10, 11, 12)}ab${CSI}39mcd${RESET_BG}`);
		expect(backgroundSequenceCount(painted)).toBe(1);
	});

	it("re-asserts its paint after a component sequence that does clear the background", () => {
		// `49m` genuinely returns the terminal to the default ground, so the next cell has to
		// re-open the paint rather than assume it survived.
		const line = `ab${CSI}49mcd`;

		const painted = paintLineBackground(line, 4, () => "#0a0b0c");

		expect(painted).toBe(`${bg(10, 11, 12)}ab${CSI}49m${bg(10, 11, 12)}cd${RESET_BG}`);
	});

	it("reports the component's truecolor background to the painter", () => {
		const seen: Array<string | undefined> = [];
		const line = `${CSI}48;2;1;2;3mxy`;

		paintLineBackground(line, 2, ({ background }) => {
			seen.push(background);
			return undefined;
		});

		expect(seen).toEqual(["#010203", "#010203"]);
	});

	it("reads the colon form of a truecolor background as well as the semicolon form", () => {
		const seen: Array<string | undefined> = [];

		paintLineBackground(`${CSI}48:2::4:5:6mz`, 1, ({ background }) => {
			seen.push(background);
			return undefined;
		});

		expect(seen).toEqual(["#040506"]);
	});

	it("reports an indexed background as unknown rather than guessing a palette entry", () => {
		const seen: Array<string | undefined> = [];

		paintLineBackground(`${CSI}48;5;204mq`, 1, ({ background }) => {
			seen.push(background);
			return undefined;
		});

		expect(seen).toEqual([undefined]);
	});

	it("restores the component's own background when a painted span ends", () => {
		const line = `${CSI}48;2;9;9;9mabcd`;

		const painted = paintLineBackground(line, 4, ({ col }) => (col < 2 ? "#111111" : undefined));

		// Columns 2-3 fall back to what the component asked for, not to the default ground. The
		// close still lands: this pass re-emitted that background, so this pass ends it.
		expect(painted).toBe(`${CSI}48;2;9;9;9m${bg(17, 17, 17)}ab${bg(9, 9, 9)}cd${RESET_BG}`);
	});

	it("pads a short line to the width and marks the padded columns as past the content", () => {
		const past: number[] = [];

		const painted = paintLineBackground("ab", 5, ({ col, past: beyond }) => {
			if (beyond) past.push(col);
			return "#020202";
		});

		expect(past).toEqual([2, 3, 4]);
		expect(painted).toBe(`${bg(2, 2, 2)}ab   ${RESET_BG}`);
	});

	it("bounds both the paint and the padding to the window it was given", () => {
		const columns: number[] = [];

		const painted = paintLineBackground(
			"ab",
			10,
			({ col }) => {
				columns.push(col);
				return "#030303";
			},
			{ start: 1, end: 4 },
		);

		expect(columns).toEqual([1, 2, 3]);
		// Padding stops at the window end: nothing is written across the columns it does not own.
		expect(painted).toBe(`a${bg(3, 3, 3)}b  ${RESET_BG}`);
	});

	it("counts a double-width grapheme as one column report and two columns of advance", () => {
		const columns: number[] = [];

		paintLineBackground("あb", 4, ({ col }) => {
			columns.push(col);
			return undefined;
		});

		expect(columns).toEqual([0, 2, 3]);
	});

	it("treats a combining sequence as one cell instead of splitting it", () => {
		const cells: number[] = [];
		// A ZWJ emoji family is one grapheme; splitting it would paint half of it.
		const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}";

		paintLineBackground(family, 2, ({ col }) => {
			cells.push(col);
			return undefined;
		});

		expect(cells).toEqual([0]);
	});
});

describe("paintBlockBackground", () => {
	it("leaves a row exactly as it was when the painter declines it", () => {
		const lines = ["one", "two"];

		const painted = paintBlockBackground(lines, 3, row => (row === 0 ? () => "#050505" : null));

		expect(painted[0]).toBe(`${bg(5, 5, 5)}one${RESET_BG}`);
		expect(painted[1]).toBe("two");
	});

	it("numbers rows from zero so a treatment can vary down the block", () => {
		const rows: number[] = [];

		paintBlockBackground(["a", "b", "c"], 1, row => {
			rows.push(row);
			return null;
		});

		expect(rows).toEqual([0, 1, 2]);
	});
});
