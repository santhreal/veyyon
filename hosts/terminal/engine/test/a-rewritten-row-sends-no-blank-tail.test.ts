/**
 * A rewritten row draws the cells the whole row draws, without sending the blank tail it was padded with.
 *
 * WHY. Components pad every row to the terminal width, and every row rewrite erases the rest of the row,
 * so the padding crossed the multiplexer and the terminal for nothing: the working line's spinner frame
 * was 344 bytes, 166 of them spaces. `lineRewriteSequence` drops the spaces after a row's last drawn cell
 * unless an attribute that draws on a blank is open over them.
 *
 * THE INVARIANT, swept over every SGR code from 0 to 107, the extended and colon color forms, the colon
 * underline styles, a malformed color and attributes opened then closed, each opened before a padded
 * tail, over ASCII and non-ASCII rows (the two branches of the rewrite), a tail split by an escape and a
 * row behind a hyperlink, at two widths, written over a row that already holds styled text: the
 * rewritten row shows what the row written whole after an erase shows. The tail is still sent only where
 * the trim cannot read what it draws, and that set is pinned by exact equality.
 *
 * WHAT IT DOES NOT CATCH. The oracle reads background, underline, strike-through and inverse. Overline,
 * frames and ideogram lines draw nothing this terminal can read back, so a trim that dropped spaces
 * under them would pass the cell check; the pinned set is what fails then. Hyperlinks are not read back,
 * so dropping an OSC 8 escape from among the trimmed spaces would pass too.
 */
import { describe, expect, it } from "bun:test";
import { lineRewriteSequence } from "@veyyon/tui/core/renderer";
import { VirtualTerminal } from "./virtual-terminal";

const ROW = 1;

/** SGR parameter lists opened before the tail, labelled by their parameters. */
const OPENERS: string[] = [
	...Array.from({ length: 108 }, (_, code) => `${code}`),
	"",
	"38;5;196",
	"48;5;21",
	"38;2;10;200;30",
	"48;2;10;200;30",
	"58;5;3",
	"38:2::10:20:30",
	"48:2::10:20:30",
	"4:0",
	"4:1",
	"4:3",
	"48;5",
	"41;49",
	"7;27",
	"4;24",
	"9;29",
	"41;0",
];

/** Openers whose tail the trim keeps although this terminal shows those cells as erased ones. */
const KEPT_UNREADABLE = [
	"38",
	"48",
	"48;5",
	"51",
	"52",
	"53",
	"56",
	"57",
	"58",
	"60",
	"61",
	"62",
	"63",
	"64",
	"66",
	"67",
	"68",
	"69",
	"70",
	"71",
	"72",
	"76",
	"77",
	"78",
	"79",
	"80",
	"81",
	"82",
	"83",
	"84",
	"85",
	"86",
	"87",
	"88",
	"89",
	"98",
	"99",
];

const CONTENTS: Array<{ text: string; width: number }> = [
	{ text: "ok", width: 2 },
	{ text: "\x1b[38;2;241;139;48m▒\x1b[39m Working…", width: 10 },
	{ text: "語x", width: 3 },
];

const WIDTHS = [12, 40];

type Shape = "padded" | "split" | "linked";
const SHAPES: Shape[] = ["padded", "split", "linked"];

function rowOf(shape: Shape, content: string, opener: string, pad: number): string {
	const open = `\x1b[${opener}m`;
	if (shape === "split") return `${content}${open}  \x1b[39m${" ".repeat(pad - 2)}`;
	if (shape === "linked") return `\x1b]8;;https://example.com\x07${content}\x1b]8;;\x07${open}${" ".repeat(pad)}`;
	return `${content}${open}${" ".repeat(pad)}`;
}

/** The row as the terminal shows it after `write` lands on a row that held styled text. */
function shownAfter(term: VirtualTerminal, width: number, write: string): string[] {
	term.write(`\x1b[0m\x1b[${ROW + 1};1H\x1b[41;4;7;9m${"Z".repeat(width)}\x1b[0m\x1b[${ROW + 1};1H${write}\x1b[0m`);
	return term.getViewportRowPresentation(ROW);
}

describe("a rewritten row", () => {
	it("shows what the whole row shows, and sends its blank tail only where the trim cannot read it", () => {
		const keptUnreadable = new Set<string>();
		const mismatches: string[] = [];
		for (const width of WIDTHS) {
			const term = new VirtualTerminal(width, 3);
			const erased = shownAfter(term, width, "\x1b[2K")[0];
			for (const opener of OPENERS) {
				for (const content of CONTENTS) {
					const pad = width - content.width;
					for (const shape of SHAPES) {
						const row = rowOf(shape, content.text, opener, pad);
						const whole = shownAfter(term, width, `\x1b[2K${row}`);
						const rewritten = shownAfter(term, width, lineRewriteSequence(row, width));
						if (JSON.stringify(rewritten) !== JSON.stringify(whole)) {
							mismatches.push(`${shape} ${JSON.stringify(content.text)} after ${opener} at ${width}`);
						}
						const tailErased = whole.slice(content.width).every(cell => cell === erased);
						if (tailErased && lineRewriteSequence(row, width).includes("  ")) keptUnreadable.add(opener);
					}
				}
			}
		}
		expect(mismatches).toEqual([]);
		expect([...keptUnreadable].sort()).toEqual([...KEPT_UNREADABLE].sort());
	});

	it("sends the working line's frame without the padding after its message", () => {
		const message = "\x1b[38;2;241;139;48m▒\x1b[39m \x1b[38;2;139;147;164mWorking… · 0:15 ⟦esc⟧\x1b[39m";
		const sequence = lineRewriteSequence(` ${message}${" ".repeat(166)}`, 190);
		expect(sequence).toBe(lineRewriteSequence(` ${message}`, 190));
	});
});
