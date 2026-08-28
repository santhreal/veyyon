import { Container, fillSurface, Spacer, TERMINAL, visibleWidth, wrapTextWithAnsi } from "@veyyon/tui";
import { WidthAwareText } from "../../tui";
import type { ThemeColor } from "../theme/color";
import { getVisibleGround } from "../theme/ground-tints";
import { theme } from "../theme/theme";
import { COMPOSER_INSET_COLS } from "./composer-chrome";

/** A note the session commits into the transcript: the todo reminder, an injected rule. One owner, because there were two of them and they were the same mistake */
export interface TranscriptNote {
	/** Theme colour for the rail and the headline (`warning`, `accent`, …). */
	tone: ThemeColor;
	/** First row. Styled by this module — pass plain text. */
	headline: string;
	/** Rows under the headline, already styled by the caller (a rule name in bold, a description in italic). A row may hold newlines and may be wider than the */
	rows: readonly string[];
}

/** How far a note stands off the page, as a fraction of the distance from the ground to its contrast pole. A card's plate is 0.1 and its footer tray 0.04; a note in */
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
	for (let ri = 0; ri < note.rows.length; ri++) {
		const row = note.rows[ri]!;
		if (row === "") {
			rows.push("");
			continue;
		}
		const wtLines = wrapTextWithAnsi(row, textWidth);
		for (let li = 0; li < wtLines.length; li++) rows.push(wtLines[li]!);
	}

	const lines: string[] = new Array(headline.length + (rows.length > 0 ? 1 : 0) + rows.length);
	let li = 0;
	for (let hi = 0; hi < headline.length; hi++) {
		lines[li++] = `${rail} ${theme.bold(theme.fg(note.tone, headline[hi]!))}`;
	}
	if (rows.length > 0) lines[li++] = rail;
	for (let ri = 0; ri < rows.length; ri++) {
		lines[li++] = rows[ri] === "" ? rail : `${rail} ${rows[ri]!}`;
	}

	// A surface is only painted onto a ground that is actually on screen, and only
	// where 24-bit colour can express the step. Everything else keeps the rail and
	// the colours, which is a readable note on any terminal.
	const ground = TERMINAL.trueColor ? getVisibleGround() : undefined;
	if (ground === undefined) return lines;
	let widest = 0;
	for (let hi = 0; hi < headline.length; hi++) {
		const w = visibleWidth(headline[hi]!);
		if (w > widest) widest = w;
	}
	for (let ri = 0; ri < rows.length; ri++) {
		const w = visibleWidth(rows[ri]!);
		if (w > widest) widest = w;
	}
	const noteWidth = Math.min(contentWidth, widest + NOTE_CHROME_COLS);
	return fillSurface(lines, noteWidth, { ground, lift: NOTE_LIFT });
}

/** A note as a transcript block: blank line, note, blank line. The note is rebuilt at render time, so a component that merges more content into itself while it is still */
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

	/** The note this block is carrying. Read by the off arm of the note's proof, which renders this exact content through the chrome the notes used to have: a */
	get note(): TranscriptNote {
		return this.#note;
	}

	setNote(note: TranscriptNote): void {
		this.#note = note;
		this.#text.invalidate();
	}
}
