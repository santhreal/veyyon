/**
 * The grid is where a render proof can start lying quietly.
 *
 * Everything downstream draws exactly what this decoder says each cell is, so a
 * mishandled SGR code does not produce an error: it produces a picture that looks
 * plausible and shows the wrong colour. That is the worst possible failure for a
 * tool whose entire job is to be believed about colour, so each code veyyon emits is
 * pinned against the value a terminal would resolve, not against itself.
 *
 * The load-bearing claim is the last one: a row is padded out with the DEFAULT
 * background, never with the style left in force at the end of the line. A component
 * that means to fill its full width has to say so, and one that stops early must
 * show the ground. Padding with the trailing style would paint every short line
 * edge-to-edge and make the exact bug class this tool exists for invisible.
 */
import { describe, expect, it } from "bun:test";
import { ansiToGrid, applySgr, cellWidth, palette256 } from "./ansi-grid";

const RESET = {
	fg: undefined,
	bg: undefined,
	bold: false,
	dim: false,
	italic: false,
	underline: false,
	reverse: false,
} as const;

/** The single cell a one-character line decodes to. */
function cell(line: string, index = 0, width = 8) {
	return ansiToGrid([line], width).rows[0][index];
}

describe("colour codes", () => {
	it("resolves a truecolour foreground and background", () => {
		expect(cell("\x1b[38;2;10;20;30mX").fg).toEqual([10, 20, 30]);
		expect(cell("\x1b[48;2;40;44;52mX").bg).toEqual([40, 44, 52]);
	});

	it("resolves the 16 base colours, bright variants included", () => {
		expect(cell("\x1b[31mX").fg).toEqual([205, 0, 0]);
		expect(cell("\x1b[91mX").fg).toEqual([255, 0, 0]);
		expect(cell("\x1b[44mX").bg).toEqual([0, 0, 238]);
		expect(cell("\x1b[104mX").bg).toEqual([92, 92, 255]);
	});

	/** The 256-colour cube and its grey ramp, at the boundaries where an off-by-one
	 * in the arithmetic shows: the first cube entry, a mid entry, the last cube
	 * entry, and both ends of the greys. */
	it("resolves the 256-colour palette the way xterm does", () => {
		expect(palette256(0)).toEqual([0, 0, 0]);
		expect(palette256(15)).toEqual([255, 255, 255]);
		expect(palette256(16)).toEqual([0, 0, 0]);
		expect(palette256(21)).toEqual([0, 0, 255]);
		expect(palette256(231)).toEqual([255, 255, 255]);
		expect(palette256(232)).toEqual([8, 8, 8]);
		expect(palette256(255)).toEqual([238, 238, 238]);
	});

	it("resolves an indexed colour written as 38;5;n", () => {
		expect(cell("\x1b[38;5;21mX").fg).toEqual([0, 0, 255]);
		expect(cell("\x1b[48;5;232mX").bg).toEqual([8, 8, 8]);
	});

	it("returns to the default on 39 and 49, not to black", () => {
		expect(cell("\x1b[31m\x1b[39mX").fg).toBeUndefined();
		expect(cell("\x1b[41m\x1b[49mX").bg).toBeUndefined();
	});
});

describe("attributes", () => {
	it("records each attribute veyyon emits", () => {
		expect(cell("\x1b[1mX").bold).toBe(true);
		expect(cell("\x1b[2mX").dim).toBe(true);
		expect(cell("\x1b[3mX").italic).toBe(true);
		expect(cell("\x1b[4mX").underline).toBe(true);
		expect(cell("\x1b[7mX").reverse).toBe(true);
	});

	it("clears bold and dim together on 22, as a terminal does", () => {
		const cleared = applySgr({ ...RESET, bold: true, dim: true }, [22]);

		expect(cleared.bold).toBe(false);
		expect(cleared.dim).toBe(false);
	});

	it("clears everything on 0, including colours", () => {
		const cleared = applySgr({ ...RESET, bold: true, fg: [1, 2, 3], bg: [4, 5, 6] }, [0]);

		expect(cleared).toEqual({ ...RESET });
	});

	it("applies several parameters from one sequence", () => {
		const styled = cell("\x1b[1;4;38;2;9;9;9mX");

		expect(styled.bold).toBe(true);
		expect(styled.underline).toBe(true);
		expect(styled.fg).toEqual([9, 9, 9]);
	});
});

describe("sequences that are not styling", () => {
	/** A hyperlink wraps visible text in OSC 8. Left undecoded, its URL would be
	 * drawn as text and every proof of a link would be unreadable. */
	it("drops an OSC 8 hyperlink and keeps its label", () => {
		const row = ansiToGrid(["\x1b]8;;https://example.com\x07link\x1b]8;;\x07"], 8).rows[0];

		expect(
			row
				.map(c => c.char)
				.join("")
				.trimEnd(),
		).toBe("link");
	});

	it("drops a cursor-movement sequence without drawing it", () => {
		const row = ansiToGrid(["a\x1b[2Cb"], 8).rows[0];

		expect(
			row
				.map(c => c.char)
				.join("")
				.trimEnd(),
		).toBe("ab");
	});

	/** A truncated escape at end of line must not consume the rest of the row or
	 * throw: a component's output can be sliced mid-sequence by a width clamp. */
	it("survives a truncated escape sequence", () => {
		expect(() => ansiToGrid(["ab\x1b["], 8)).not.toThrow();
		expect(() => ansiToGrid(["ab\x1b"], 8)).not.toThrow();
	});
});

describe("cell geometry", () => {
	it("gives a double-width grapheme two cells, the second a continuation", () => {
		const row = ansiToGrid(["漢x"], 8).rows[0];

		expect(row[0].char).toBe("漢");
		expect(row[0].continuation).toBe(false);
		expect(row[1].continuation).toBe(true);
		expect(row[2].char).toBe("x");
	});

	it("attaches a combining mark to the cell it modifies", () => {
		// Written decomposed on purpose: "e" plus U+0301, which is two code points in
		// ONE cell. A decoder that gave the mark its own cell would shift every
		// following column and make an alignment proof wrong by a character.
		const row = ansiToGrid(["e\u0301x"], 8).rows[0];

		expect(row[0].char).toBe("e\u0301");
		expect(row[1].char).toBe("x");
	});

	it("measures widths for the ranges that matter", () => {
		expect(cellWidth("a")).toBe(1);
		expect(cellWidth("漢")).toBe(2);
		expect(cellWidth("\u0301")).toBe(0);
	});

	it("pads every row to the requested width and truncates beyond it", () => {
		const grid = ansiToGrid(["ab", "abcdefghij"], 5);

		expect(grid.rows[0]).toHaveLength(5);
		expect(grid.rows[1]).toHaveLength(5);
		expect(grid.width).toBe(5);
		expect(grid.height).toBe(2);
	});

	/**
	 * The claim this whole tool rests on. A line that sets a background and ends
	 * must show GROUND in the columns it did not write, because that is what the
	 * terminal shows and it is how you see that a fill stops short.
	 */
	it("pads with the default background, not the trailing style", () => {
		const row = ansiToGrid(["\x1b[48;2;40;44;52mfill"], 10).rows[0];

		expect(row[0].bg).toEqual([40, 44, 52]);
		expect(row[3].bg).toEqual([40, 44, 52]);
		expect(row[4].bg).toBeUndefined();
		expect(row[9].bg).toBeUndefined();
	});

	/** Style does not leak between lines either: each row starts unstyled, so an
	 * unterminated colour on one line cannot tint the next one in the proof. */
	it("starts each row unstyled", () => {
		const grid = ansiToGrid(["\x1b[41mred", "plain"], 6);

		expect(grid.rows[0][0].bg).toEqual([205, 0, 0]);
		expect(grid.rows[1][0].bg).toBeUndefined();
	});
});
