import { Container, Markdown, Text } from "@veyyon/tui";
import type { CollabPromptCustomDisplay } from "@veyyon/wire/presentation";
import { getMarkdownTheme } from "../../../../theme/markdown-theme";
import { theme } from "../../../../theme/theme";

/**
 * Renders a collab guest prompt on every participant's transcript: a
 * user-message-styled bubble prefixed with the author's name.
 */

export class CollabPromptMessageComponent extends Container {
	constructor(message: CollabPromptCustomDisplay) {
		super();
		const from = message.from;
		const authorText = new Text(theme.fg("accent", `\x1b[1m«${from}»\x1b[22m ›`), 1, 0);
		authorText.setIgnoreTight(true);
		this.addChild(authorText);

		const md = new Markdown(message.text, 1, 1, getMarkdownTheme(), {
			color: (value: string) => theme.fg("userMessageText", value),
		});
		md.setIgnoreTight(true);
		this.addChild(md);
	}
}
