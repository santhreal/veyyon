/**
 * The transcript card for live IRC traffic: `irc:incoming` DMs delivered to this session,
 * `irc:autoreply` side-channel replies sent on this session's behalf, and `irc:relay` observations
 * of agent-to-agent traffic.
 *
 * A terminal component rather than tool code: nothing here is a tool call, so no result reaches the
 * tool renderer and no host but this one draws it. It keeps the glyph and the indent the `irc` card
 * uses, so a delivered message and a message the model sent read the same way in the transcript.
 */
import type { Component } from "@veyyon/tui";
import { formatAge } from "@veyyon/utils";
import type { Theme } from "../../../../theme/theme";
import { createCachedComponent, getPreviewLines, replaceTabs } from "../../../../tools/core/render-utils";
import { Ellipsis, renderStatusLine, truncateToWidth } from "../../../../tui";

/** Rows of the message a collapsed card shows, and the rows it shows once expanded. */
const BODY_LINES_COLLAPSED = 3;
const BODY_LINES_EXPANDED = 12;
/** The columns a body line is cut to before the card is fitted to the terminal. */
const BODY_LINE_WIDTH = 100;

/** What the card is, drawn where an outcome icon would go: this row reports no outcome. */
function ircGlyph(theme: Theme): string {
	return theme.styledSymbol("tool.irc", "accent");
}

function messageAge(ts: number | undefined): string {
	if (!ts) return "";
	return formatAge(Math.max(1, Math.round((Date.now() - ts) / 1000)));
}

/**
 * The message body as indented rows, with a dim counter for the rows the card kept back.
 *
 * No quote glyph: the card already hangs from the transcript's own edge, and a second `▏` two cells
 * inside it drew a second left edge for the same rows.
 */
function bodyLines(body: string, expanded: boolean, theme: Theme): string[] {
	const max = expanded ? BODY_LINES_EXPANDED : BODY_LINES_COLLAPSED;
	const total = body.split("\n").filter(line => line.trim()).length;
	const lines = getPreviewLines(body, max, BODY_LINE_WIDTH, Ellipsis.Unicode).map(
		line => `  ${theme.fg("toolOutput", replaceTabs(line))}`,
	);
	const hidden = total - Math.min(total, max);
	if (hidden > 0) {
		lines.push(`  ${theme.fg("dim", `… +${hidden} more ${hidden === 1 ? "line" : "lines"}`)}`);
	}
	return lines;
}

export interface IrcMessageCard {
	kind: "incoming" | "autoreply" | "relay";
	from?: string;
	to?: string;
	body?: string;
	replyTo?: string;
	timestamp?: number;
}

export function createIrcMessageCard(card: IrcMessageCard, getExpanded: () => boolean, uiTheme: Theme): Component {
	const from = card.from?.trim() || "?";
	const title =
		card.kind === "incoming"
			? `IRC ${uiTheme.nav.back} ${from}`
			: card.kind === "autoreply"
				? `IRC ${uiTheme.nav.selected} ${card.to?.trim() || "?"}`
				: `IRC ${from} ${uiTheme.nav.selected} ${card.to?.trim() || "?"}`;
	const body = card.body ?? "";
	const meta: string[] = [];
	if (card.kind === "autoreply") meta.push("auto");
	if (card.replyTo) meta.push("reply");
	const age = messageAge(card.timestamp);
	if (age) meta.push(age);
	return createCachedComponent(
		getExpanded,
		(width, expanded) => {
			const lines = [renderStatusLine({ iconOverride: ircGlyph(uiTheme), title, meta }, uiTheme)];
			if (body.trim()) lines.push(...bodyLines(body, expanded, uiTheme));
			return lines.map(line => truncateToWidth(line, width, Ellipsis.Unicode));
		},
		{ paddingX: 1 },
	);
}
