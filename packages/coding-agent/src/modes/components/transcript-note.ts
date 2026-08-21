import { Container, Spacer, wrapTextWithAnsi } from "@veyyon/tui";
import { WidthAwareText } from "../../tui";
import type { ThemeColor } from "../theme/color";
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
 * the note's kind in one column instead of three hundred, and the text keeps its
 * own colours. Nothing behind the text is painted, so the note sits on whatever the
 * terminal's page already is, and it sits on the transcript's one left rail because
 * nothing in the transcript starts at column 0.
 *
 * NO BACKGROUND. The step between the slab and this was a raised surface: a fill a
 * few percent off the detected ground, hugging the text. It is gone, and the reason
 * it is gone is that it was the LAST painted background in the inline TUI. Every
 * other block gives up its fill (`statusLine.transparent`, the unpainted composer,
 * the message cards), so a note carrying one was the single lighter rectangle on the
 * page, which is precisely the "sticks out" the fill was supposed to avoid at a
 * gentler amplitude. Elevation only reads as elevation among surfaces; alone on a
 * flat page it reads as a highlight. A note is emphasised by its rail and its hue,
 * and by nothing else.
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

	// No background, on any terminal, whatever it answered for its ground: the rail
	// and the foregrounds are the whole treatment, and they are the same bytes on a
	// truecolor terminal and on one that cannot take a 24-bit fill.
	return [
		...headline.map(line => `${rail} ${theme.bold(theme.fg(note.tone, line))}`),
		...(rows.length > 0 ? [rail] : []),
		...rows.map(row => (row === "" ? rail : `${rail} ${row}`)),
	];
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

	/**
	 * The note this block is carrying. Read by the off arm of the note's proof, which
	 * renders this exact content through the chrome the notes used to have: a
	 * differential is only evidence if it varies the chrome and nothing else.
	 */
	get note(): TranscriptNote {
		return this.#note;
	}

	setNote(note: TranscriptNote): void {
		this.#note = note;
		this.#text.invalidate();
	}
}
