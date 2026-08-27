import { Container, Markdown, Text } from "@veyyon/tui";
import type { CollabPromptDetails } from "../../collab/protocol";
import type { CustomMessage } from "../../session/messages";
import { getMarkdownTheme } from "../theme/markdown-theme";
import { theme } from "../theme/theme";

/**
 * Renders a collab guest prompt on every participant's transcript: a
 * user-message-styled bubble prefixed with the author's name.
 */
export class CollabPromptMessageComponent extends Container {
	constructor(message: CustomMessage<CollabPromptDetails>) {
		super();
		const from = message.details?.from?.trim() || "guest";
		const authorText = new Text(theme.fg("accent", `\x1b[1m«${from}»\x1b[22m ›`), 1, 0);
		authorText.setIgnoreTight(true);
		this.addChild(authorText);
		let text: string;
		if (typeof message.content === "string") {
			text = message.content;
		} else {
			text = "";
			for (let ci = 0; ci < message.content.length; ci++) {
				const content = message.content[ci]!;
				if (content.type === "text") text += content.text;
			}
		}
		const md = new Markdown(text, 1, 1, getMarkdownTheme(), {
			color: (value: string) => theme.fg("userMessageText", value),
		});
		md.setIgnoreTight(true);
		this.addChild(md);
	}
}
