import type { TextContent } from "@veyyon/ai";
import type { Box, Component } from "@veyyon/tui";
import { Markdown, Spacer, TERMINAL, Text } from "@veyyon/tui";
import { getMarkdownTheme } from "../../modes/theme/markdown-theme";
import { type Theme, theme } from "../../modes/theme/theme";
import { groundHairlineHex, groundTintFgAnsi } from "../theme/ground-tints";
import { reportRendererFailure } from "./renderer-failure";

export function cardOutlineColor(): (text: string) => string {
	const derived = groundTintFgAnsi(groundHairlineHex(), TERMINAL.trueColor);
	if (derived !== undefined) return text => `${derived}${text}\x1b[39m`;
	return text => theme.fg("borderMuted", text);
}

export interface FramedMessage {
	customType: string;
	content: string | (TextContent | { type: string })[];
}

export type FramedRenderer<M extends FramedMessage> = (
	message: M,
	options: { expanded: boolean },
	theme: Theme,
) => Component | undefined;

export interface RebuildFrameOptions<M extends FramedMessage> {
	message: M;
	box: Box;
	expanded: boolean;
	icon?: string;
	collapseAfterLines?: number;
	customRenderer?: FramedRenderer<M>;
}

export function framedRendererSubject(customType: string): string {
	return `custom message "${customType}"`;
}

export function renderFramedMessage<M extends FramedMessage>(opts: RebuildFrameOptions<M>): Component | undefined {
	let failureRow: Text | undefined;
	if (opts.customRenderer) {
		try {
			const component = opts.customRenderer(opts.message, { expanded: opts.expanded }, theme);
			if (component) return component;
		} catch (err) {
			failureRow = reportRendererFailure(
				framedRendererSubject(opts.message.customType),
				err,
				"showing the default card",
			);
		}
	}

	opts.box.clear();
	opts.box.setBorder({ chars: theme.boxSharp, color: cardOutlineColor() });
	opts.box.setHugContent(true);

	const tag = opts.icon ? `${opts.icon} ${opts.message.customType}` : opts.message.customType;
	opts.box.addChild(new Text(theme.fg("customMessageLabel", theme.bold(tag)), 0, 0));
	if (failureRow) opts.box.addChild(failureRow);
	opts.box.addChild(new Spacer(1));

	let text: string;
	if (typeof opts.message.content === "string") {
		text = opts.message.content;
	} else {
		const parts: string[] = [];
		for (let ci = 0; ci < opts.message.content.length; ci++) {
			const c = opts.message.content[ci]!;
			if (c.type === "text") parts.push((c as TextContent).text);
		}
		text = parts.join("\n");
	}

	if (!opts.expanded && opts.collapseAfterLines !== undefined) {
		const limit = opts.collapseAfterLines;
		if (limit === 0) {
			text = "\n…";
		} else {
			let newlineCount = 0;
			let cutPos = -1;
			for (let i = 0; i < text.length; i++) {
				if (text.charCodeAt(i) === 10) {
					newlineCount++;
					if (newlineCount === limit) {
						cutPos = i;
						break;
					}
				}
			}
			if (cutPos >= 0) text = `${text.slice(0, cutPos)}\n…`;
		}
	}

	opts.box.addChild(
		new Markdown(text, 0, 0, getMarkdownTheme(), {
			color: (value: string) => theme.fg("customMessageText", value),
		}),
	);

	return undefined;
}
