import { Container, fillSurface, Spacer, TERMINAL, visibleWidth, wrapTextWithAnsi } from "@veyyon/tui";
import { WidthAwareText } from "../../tui";
import type { ThemeColor } from "../theme/color";
import { getVisibleGround } from "../theme/ground-tints";
import { theme } from "../theme/theme";
import { COMPOSER_INSET_COLS } from "./composer-chrome";

/**
 * A note the session commits into the transcript: the todo reminder, an injected
 * rule. One owner, because there were two of them and they were the same mistake
 * twice.
 *
 * WHAT THEY WERE. `new Box(1, 1, t => theme.inverse(theme.fg("warning", t)))`,
 * which pads every row out to the terminal width and inverts it: a full-width slab
 * of saturated mustard carrying black text, in the middle of a grey transcript, for
 * a note. It was the loudest object on the screen and the only one starting at
 * column 0. Inverting also spent the foreground — `ttsr-notification.ts` carried
 * the comment "fg colors conflict with inverse, so styling inside the block is
 * limited to bold and italic" — so the block could not use colour to say anything.
 *
 * WHAT THEY ARE. The hue moves to a rail glyph down the left edge, where it names
 * the note's kind in one column instead of three hundred. The elevation comes from
 * the same ground-derived surface a card's plate is made of, so the note stands off
 * the page by a measured step rather than by inverting it, and a terminal that never
 * answered OSC 11 simply gets the rail and the colours. The note is as wide as its
 * text: a box stretched to the terminal edge reads as a wall rather than as a card
 * (see `Box.setHugContent`), and it sits on the transcript's one left rail, because
 * nothing in the transcript starts at column 0.
 */
export interface TranscriptNote {
	/** Theme colour for the rail and the headline (`warning`, `accent`, …). */
	tone: ThemeColor;
	/** First row. Styled by this module — pass plain text. */
	headline: string;
	/**
	 * Rows under the headline, already styled by the caller (a rule name in bold, a
	 * description in italic). A row may hold newlines and may be wider than the
	 * note: both are wrapped here, so every visual line keeps its rail.
	 */
	rows: readonly string[];
}

/**
 * How far a note stands off the page, as a fraction of the distance from the ground
 * to its contrast pole. A card's plate is 0.1 and its footer tray 0.04; a note in
 * the transcript is a raised thing rather than a card, so it sits between them.
 */
const NOTE_LIFT = 0.075;

/** The rail glyph, the space after it, and one column of air at the end. */
const NOTE_CHROME_COLS = 4;

/** Rows of one note, at the width its content is allowed to occupy. */
export function renderTranscriptNote(note: TranscriptNote, contentWidth: number): string[] {
	const rail = theme.fg(note.tone, theme.sep.block);
	// Two columns for the rail and its space; one for the air at the right edge.
	const textWidth = Math.max(8, contentWidth - NOTE_CHROME_COLS + 1);
	const headline = wrapTextWithAnsi(note.headline, textWidth);
	const rows: string[] = [];
	for (const row of note.rows) {
		if (row === "") {
			rows.push("");
			continue;
		}
		rows.push(...wrapTextWithAnsi(row, textWidth));
	}

	const lines = [
		...headline.map(line => `${rail} ${theme.bold(theme.fg(note.tone, line))}`),
		...(rows.length > 0 ? [rail] : []),
		...rows.map(row => (row === "" ? rail : `${rail} ${row}`)),
	];

	// A surface is only painted onto a ground that is actually on screen, and only
	// where 24-bit colour can express the step. Everything else keeps the rail and
	// the colours, which is a readable note on any terminal.
	const ground = TERMINAL.trueColor ? getVisibleGround() : undefined;
	if (ground === undefined) return lines;
	const widest = Math.max(...headline.map(visibleWidth), ...rows.map(visibleWidth));
	const noteWidth = Math.min(contentWidth, widest + NOTE_CHROME_COLS);
	return fillSurface(lines, noteWidth, { ground, lift: NOTE_LIFT });
}

/**
 * A note as a transcript block: blank line, note, blank line. The note is rebuilt at
 * render time, so a component that merges more content into itself while it is still
 * the live tail only has to call {@link setNote}.
 */
export class TranscriptNoteComponent extends Container {
	#note: TranscriptNote;
	readonly #text: WidthAwareText;

	constructor(note: TranscriptNote) {
		super();
		this.#note = note;
		this.addChild(new Spacer(1));
		this.#text = new WidthAwareText(
			contentWidth => renderTranscriptNote(this.#note, contentWidth).join("\n"),
			COMPOSER_INSET_COLS,
			0,
		);
		this.#text.setIgnoreTight(true);
		this.addChild(this.#text);
		this.addChild(new Spacer(1));
	}

	setNote(note: TranscriptNote): void {
		this.#note = note;
		this.#text.invalidate();
	}
}
