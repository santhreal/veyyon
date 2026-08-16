import { type Component, type Container, Spacer, Text } from "@veyyon/tui";
import { COMPOSER_INSET_COLS } from "./composer-chrome";

/**
 * Chrome for a transcript block that owns its own turn (`/btw`, `/omfg`).
 *
 * The transcript sits on ONE left rail at {@link COMPOSER_INSET_COLS}, and an
 * execution block already proves the shape: the accent lives on the header, the
 * body is indented to the rail, and there are no full-bleed rules (see
 * `buildExecutionFrame`). A pair of `───` rules around four short lines reads as
 * chrome shouting over content, and they were also drawn at column 0, which put
 * the loudest thing on screen two columns off the rail everything else follows.
 */
export interface TranscriptBlockParts {
	/** Header row: the command and its subject, already styled. */
	header: string;
	/** Optional second header row, e.g. a live status word. */
	subheader?: string;
	/** The block's content, mounted at the rail. */
	body: Component;
	/** Trailing hint or terminal state, already styled. */
	footer: string;
}

/**
 * Replace `block`'s children with the rail layout for `parts`.
 *
 * Callers rebuild on every streamed delta, so this clears rather than appends.
 */
export function mountTranscriptBlock(block: Container, parts: TranscriptBlockParts): void {
	block.clear();
	block.addChild(new Text(parts.header, COMPOSER_INSET_COLS, 0));
	if (parts.subheader !== undefined) {
		block.addChild(new Text(parts.subheader, COMPOSER_INSET_COLS, 0));
	}
	block.addChild(new Spacer(1));
	block.addChild(parts.body);
	block.addChild(new Spacer(1));
	block.addChild(new Text(parts.footer, COMPOSER_INSET_COLS, 0));
}
