import { type Component, type Container, Spacer, Text } from "@veyyon/tui";
import { COMPOSER_INSET_COLS } from "./composer-chrome";

export interface TranscriptBlockParts {
	header?: string;
	subheader?: string;
	body: Component;
	footer?: string;
}

export function mountTranscriptBlock(block: Container, parts: TranscriptBlockParts): void {
	block.clear();
	if (parts.header !== undefined) {
		block.addChild(new Text(parts.header, COMPOSER_INSET_COLS, 0));
	}
	if (parts.subheader !== undefined) {
		block.addChild(new Text(parts.subheader, COMPOSER_INSET_COLS, 0));
	}
	if (parts.header !== undefined || parts.subheader !== undefined) {
		block.addChild(new Spacer(1));
	}
	block.addChild(parts.body);
	if (parts.footer !== undefined) {
		block.addChild(new Spacer(1));
		block.addChild(new Text(parts.footer, COMPOSER_INSET_COLS, 0));
	}
}

export function transcriptBlockText(text: string): Text {
	return new Text(text, COMPOSER_INSET_COLS, 0);
}
