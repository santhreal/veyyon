import { Container, Spacer } from "@veyyon/tui";
import { WidthAwareText } from "../../tui";
import { COMPOSER_INSET_COLS } from "./composer-chrome";
import type { TranscriptNote } from "./transcript-note-helpers";
import { renderTranscriptNote } from "./transcript-note-helpers";

export type { TranscriptNote };
export { renderTranscriptNote };

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

	get note(): TranscriptNote {
		return this.#note;
	}

	setNote(note: TranscriptNote): void {
		this.#note = note;
		this.#text.invalidate();
	}
}
