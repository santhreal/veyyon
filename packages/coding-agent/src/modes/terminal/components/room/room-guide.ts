/**
 * What the room is and how to use it, in one place: the guide card the room
 * view shows the first time it opens (and on `?`), and the panel `/room help`
 * prints, read the same rows. The keys the terminal lets a user rebind come in
 * from the keybindings; the keys inside the room view are the stage's own.
 */

import { truncateToWidth, visibleWidth } from "@veyyon/utils/width";
import { wrapTextWithAnsi } from "@veyyon/utils/wrap";
import { type ThemeColor, theme } from "../../../../theme/theme";
import type { RoomInk } from "./room-window";

/** The card is never wider than this, however wide the terminal: a guide reads in a column. */
const MAX_CARD_WIDTH = 78;
/** Below this width the card has no room for a key and its meaning on one line, and is not drawn. */
const MIN_CARD_WIDTH = 30;
/** The key column never takes more than this share of the card, so the meanings keep room to read. */
const KEY_COLUMN_SHARE = 0.42;

/** The room's rebindable keys, as the status line names them; undefined when unbound. */
export interface RoomGuideKeys {
	/** `app.room.view`. */
	readonly view: string | undefined;
	/** `app.room.next`. */
	readonly next: string | undefined;
	/** `app.room.previous`. */
	readonly previous: string | undefined;
}

/** One line of the guide: what to press, or what a mark looks like, and what it means. */
export interface RoomGuideRow {
	readonly keys: string;
	readonly text: string;
}

export interface RoomGuideSection {
	readonly title: string;
	readonly rows: readonly RoomGuideRow[];
}

export interface RoomGuide {
	/** One sentence on what a room is. */
	readonly lead: string;
	readonly sections: readonly RoomGuideSection[];
}

/** The room guide, with the bound keys spelled the way the rest of the terminal spells them. */
export function roomGuide(keys: RoomGuideKeys): RoomGuide {
	const open = keys.view ? `${keys.view} · →→` : "→→";
	const cycle = [keys.next, keys.previous].filter((key): key is string => key !== undefined).join(" ");
	const getAround: RoomGuideRow[] = [
		{ keys: open, text: "open the room: every conversation as a window" },
		{ keys: "/room new · n", text: "start a conversation beside this one" },
		{ keys: "enter · 1–9 · click", text: "go into a window" },
		{ keys: "←→ · tab", text: "move between windows · lay them all out" },
		{ keys: "x", text: "close a conversation" },
		{ keys: "esc", text: "back to the conversation you came from" },
	];
	if (cycle) getAround.push({ keys: cycle, text: "next or previous conversation, without the room" });
	return {
		lead: "A room is every conversation in this terminal. Each keeps working while you are in another.",
		sections: [
			{ title: "Getting around", rows: getAround },
			{
				title: "Reading a window",
				rows: [
					{ keys: `${theme.status.warning} needs you`, text: "a question is waiting for your answer" },
					{ keys: "working 0:41", text: "its turn so far" },
					{
						keys: `${theme.status.success} ${theme.status.error}`,
						text: "unread: finished or failed while you were away",
					},
					{ keys: "✎ draft", text: "what you typed there and did not send" },
				],
			},
		],
	};
}

/** The guide as Markdown, for `/room help`. */
export function roomGuideMarkdown(guide: RoomGuide): string {
	const lines = [guide.lead, ""];
	for (const section of guide.sections) {
		lines.push(`**${section.title}**`, "", "| | |", "|---|---|");
		for (const row of section.rows) lines.push(`| \`${row.keys}\` | ${row.text} |`);
		lines.push("");
	}
	lines.push("In the room view, `?` shows this again.");
	return lines.join("\n");
}

/** One line of the card's body, styled, and the cells it takes. */
interface CardLine {
	readonly text: string;
	readonly width: number;
}

/**
 * The guide as a card at most `maxWidth` by `maxHeight` cells: a rounded frame
 * titled `The room`, the lead, each section that fits whole, and the line that
 * says how to close it. Sections that do not fit are left out from the last;
 * too small a space for the lead and that line draws nothing. Every row is
 * exactly the card's width.
 */
export function paintRoomGuide(guide: RoomGuide, maxWidth: number, maxHeight: number, ink: RoomInk): string[] {
	const width = Math.min(MAX_CARD_WIDTH, maxWidth);
	if (width < MIN_CARD_WIDTH) return [];
	const inner = width - 4;
	const styled = (plain: string, token: ThemeColor, bold = false): CardLine => {
		const cut = truncateToWidth(plain, inner);
		const text = ink.token(token, cut);
		return { text: bold ? ink.bold(text) : text, width: visibleWidth(cut) };
	};
	const blank: CardLine = { text: "", width: 0 };

	const lead = wrapTextWithAnsi(guide.lead, inner).map(line => styled(line, "text"));
	const footer = styled("any key closes this · ? shows it again", "dim");
	const keyWidth = Math.min(
		Math.floor(inner * KEY_COLUMN_SHARE),
		Math.max(0, ...guide.sections.flatMap(section => section.rows.map(row => visibleWidth(row.keys)))),
	);
	const sections = guide.sections.map(section => [
		blank,
		styled(section.title, "text", true),
		...section.rows.map(row => {
			const keys = truncateToWidth(row.keys, keyWidth);
			const meaning = truncateToWidth(row.text, Math.max(0, inner - keyWidth - 2));
			const pad = " ".repeat(Math.max(0, keyWidth - visibleWidth(keys)));
			return {
				text: `${ink.token("accent", keys)}${pad}  ${ink.token("muted", meaning)}`,
				width: keyWidth + 2 + visibleWidth(meaning),
			};
		}),
	]);

	const budget = maxHeight - 2;
	const body: CardLine[] = [...lead];
	if (body.length + 2 > budget) return [];
	for (const section of sections) {
		if (body.length + section.length + 2 > budget) break;
		body.push(...section);
	}
	body.push(blank, footer);

	const box = theme.boxRound;
	const edge = (text: string): string => ink.token("borderAccent", text);
	const title = " The room ";
	const top = `${edge(`${box.topLeft}${box.horizontal}`)}${ink.bold(ink.token("text", title))}${edge(
		`${box.horizontal.repeat(Math.max(0, width - 3 - visibleWidth(title)))}${box.topRight}`,
	)}`;
	const rows = body.map(
		line => `${edge(box.vertical)} ${line.text}${" ".repeat(Math.max(0, inner - line.width))} ${edge(box.vertical)}`,
	);
	const bottom = edge(`${box.bottomLeft}${box.horizontal.repeat(width - 2)}${box.bottomRight}`);
	return [top, ...rows, bottom];
}
