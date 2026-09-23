/**
 * One window of the room, painted at any size and any depth.
 *
 * A window is a conversation seen from farther back: its frame carries the
 * ordinal, the title and the state; its body is the prompt being worked on and
 * the tail of what followed, rewrapped to the window's width; its bottom edge is
 * the model and the directory. The painter takes a size and an ink strength and
 * returns exactly `height` rows of exactly `width` cells, so the stage can place
 * and clip it without measuring anything.
 *
 * Depth is ink, not a filter: every colour is mixed toward the terminal ground
 * by the window's strength before it is written, so a receding window reads as
 * farther away on any ground, including in 256 colours, where the mixed colour
 * is quantized rather than skipped. Text the theme leaves in the terminal's own
 * foreground is given an explicit colour at the same strength, because a window
 * that faded everything except its prose would look like prose floating in
 * front of a ghost.
 *
 * Near full size a window can show the conversation's real screen instead of
 * its card, cropped to the window: that is what makes opening the room read as
 * the screen pulling back into a window rather than being replaced by one.
 */

import { TERMINAL } from "@veyyon/tui";
import { sgrSequence } from "@veyyon/utils/ansi";
import { formatClock } from "@veyyon/utils/format";
import { clamp01 } from "@veyyon/utils/math";
import { blendHex, fadeLineTowards } from "@veyyon/utils/motion";
import { sliceByColumn, truncateToWidth, visibleWidth } from "@veyyon/utils/width";
import { wrapTextWithAnsi } from "@veyyon/utils/wrap";
import { groundFrameHex } from "../../../../theme/ground-tints";
import { lavaAnsi } from "../../../../theme/shimmer";
import { type ThemeColor, theme } from "../../../../theme/theme";
import { sharedSpinnerFrame } from "../transcript/tool-execution";
import type { RoomFeedBlock, RoomWindowSnapshot } from "./room-view-model";

/** Below this width a window is a frame, its ordinal and its state glyph. */
const TINY_WIDTH = 12;
/** Below this width the frame carries the ordinal and the state glyph but no words. */
const COMPACT_WIDTH = 28;
/** The prompt at the head of a window never takes more rows than this. */
const PROMPT_HEAD_ROWS = 2;

/** How a window is drawn on one frame. */
export interface RoomWindowPaint {
	readonly width: number;
	readonly height: number;
	readonly snapshot: RoomWindowSnapshot;
	/** 1-based position in the room: the number `/room <n>` and the digit keys take. */
	readonly ordinal: number;
	/** Ink strength in [0, 1]. */
	readonly strength: number;
	readonly selected: boolean;
	/** False while the window covers the whole terminal, which is the one size it draws without a frame. */
	readonly framed: boolean;
	/** Dialogs held until this conversation is on screen. */
	readonly waitingDialogs: number;
	/**
	 * The conversation's real screen and how much of it to show instead of the
	 * card: 1 shows only the crop, 0 only the card, and the band between them
	 * dissolves one into the other.
	 */
	readonly screen?: { readonly rows: readonly string[]; readonly mix: number };
	/** Wall time the frame is drawn for; drives the spinner and the clock. */
	readonly now: number;
}

/** The new-conversation slot at the end of the row. */
export interface RoomNewSlotPaint {
	readonly width: number;
	readonly height: number;
	readonly strength: number;
	readonly selected: boolean;
	/** A conversation is being created for this slot. */
	readonly starting: boolean;
	readonly now: number;
}

/**
 * Colours at one strength. At full strength a token paints exactly as the rest
 * of the product paints it, terminal default foreground included; below it,
 * every token is an explicit mix toward the ground.
 */
export class RoomInk {
	readonly strength: number;
	readonly #ground: string;
	readonly #cache = new Map<string, string>();

	constructor(strength: number, ground: string) {
		this.strength = clamp01(strength);
		this.#ground = ground;
	}

	get full(): boolean {
		return this.strength >= 0.999;
	}

	token(token: ThemeColor, text: string): string {
		if (text === "") return "";
		if (this.full) return theme.fg(token, text);
		return this.hex(theme.getColorHex(token), text);
	}

	hex(hex: string, text: string): string {
		if (text === "") return "";
		let open = this.#cache.get(hex);
		if (open === undefined) {
			open = theme.fgHexAnsi(this.full ? hex : blendHex(this.#ground, hex, this.strength));
			this.#cache.set(hex, open);
		}
		return open === "" ? text : `${open}${text}\x1b[39m`;
	}

	bold(text: string): string {
		return theme.bold(text);
	}
}

/** Pad or cut one styled row to exactly `width` cells, closing every style it opened. */
function fitRow(row: string, width: number): string {
	if (width <= 0) return "";
	const w = visibleWidth(row);
	if (w === width) return `${row}\x1b[0m`;
	if (w < width) return `${row}\x1b[0m${" ".repeat(width - w)}`;
	const cut = sliceByColumn(row, 0, width, true);
	return `${cut}\x1b[0m${" ".repeat(Math.max(0, width - visibleWidth(cut)))}`;
}

/** Strip the markdown markers a card has no room to render, keeping their text. */
function plainProse(text: string): string {
	return text
		.replace(/^```.*$/gm, "")
		.replace(/^#{1,6}\s+/gm, "")
		.replace(/\*\*(.+?)\*\*/g, "$1")
		.replace(/__(.+?)__/g, "$1")
		.replace(/`([^`\n]+)`/g, "$1")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/** Wrap plain text to `width` cells; an empty text is no rows. */
function wrapPlain(text: string, width: number): string[] {
	if (text === "" || width <= 0) return [];
	return wrapTextWithAnsi(text, width);
}

/** The state chip on a window's top edge: glyph, word, and the running clock. */
function stateChip(
	snapshot: RoomWindowSnapshot,
	waitingDialogs: number,
	ink: RoomInk,
	now: number,
	words: boolean,
): { text: string; width: number } {
	const parts: string[] = [];
	let width = 0;
	const push = (styled: string, plain: string): void => {
		parts.push(styled);
		width += visibleWidth(plain);
	};
	if (waitingDialogs > 0) {
		push(ink.token("borderAccent", theme.status.warning), theme.status.warning);
		if (words) push(ink.token("borderAccent", " needs you"), " needs you");
		return { text: parts.join(""), width };
	}
	const state = snapshot.state;
	switch (state.kind) {
		case "working": {
			const frames = theme.getSpinnerFrames("status");
			const glyph = frames[sharedSpinnerFrame(frames.length, now)] ?? "";
			const lava = ink.full ? lavaAnsi(theme, TERMINAL.trueColor, now) : undefined;
			push(lava ? `${lava}${glyph}\x1b[39m` : ink.token("borderAccent", glyph), glyph);
			if (words) {
				const word = ` ${state.activity === "starting" ? "starting" : "working"}`;
				push(ink.token("accent", word), word);
				const clock = ` ${formatClock(now - state.since)}`;
				push(ink.token("dim", clock), clock);
			}
			break;
		}
		case "done":
			push(ink.token("success", theme.status.success), theme.status.success);
			if (words) push(ink.token("muted", " done"), " done");
			break;
		case "failed":
			push(ink.token("error", theme.status.error), theme.status.error);
			if (words) push(ink.token("error", " failed"), " failed");
			break;
		case "stopped":
			push(ink.token("muted", theme.status.aborted), theme.status.aborted);
			if (words) push(ink.token("muted", " stopped"), " stopped");
			break;
		case "new":
			if (words) push(ink.token("dim", "new"), "new");
			break;
	}
	return { text: parts.join(""), width };
}

/** The window's title: its name, else its first prompt, else what it is. */
function windowTitle(snapshot: RoomWindowSnapshot): string {
	return snapshot.title ?? snapshot.lead ?? "New conversation";
}

interface FrameColours {
	readonly edge: (text: string) => string;
}

function frameColours(ink: RoomInk, selected: boolean): FrameColours {
	if (selected) return { edge: text => ink.token("borderAccent", text) };
	const derived = groundFrameHex();
	if (derived !== undefined && TERMINAL.trueColor) return { edge: text => ink.hex(derived, text) };
	return { edge: text => ink.token("borderMuted", text) };
}

interface EdgePiece {
	readonly text: string;
	readonly width: number;
}

/** A title narrower than this is cut to the state glyph before it is cut further. */
const MIN_EDGE_TITLE = 12;

/**
 * `╭─ label ──── chip ─╮` at exactly `width` cells. The state is what a
 * glance at a window is for, so the title gives way first: it is shortened,
 * then the chip loses its words and keeps its glyph, and only then does the
 * title shorten past its floor.
 */
function topEdge(width: number, label: EdgePiece, chip: EdgePiece, chipGlyph: EdgePiece, frame: FrameColours): string {
	const box = theme.boxRound;
	const inner = width - 2;
	if (inner <= 0) return frame.edge(`${box.topLeft}${box.topRight}`.slice(0, Math.max(0, width)));
	// `─ ` + label + ` ` … ` ` + chip + ` ─`.
	const cost = (piece: EdgePiece): number => (piece.width > 0 ? piece.width + 3 : 1);
	const cut = (piece: EdgePiece, room: number): EdgePiece => {
		if (piece.width <= room) return piece;
		if (room <= 1) return { text: "", width: 0 };
		const text = truncateToWidth(piece.text, room);
		return { text, width: visibleWidth(text) };
	};
	let title = label;
	let state = chip;
	if (cost(title) + cost(state) > inner) title = cut(title, Math.max(MIN_EDGE_TITLE, inner - cost(state) - 3));
	if (cost(title) + cost(state) > inner) state = chipGlyph;
	if (cost(title) + cost(state) > inner) title = cut(title, inner - cost(state) - 3);
	if (cost(title) + cost(state) > inner) state = { text: "", width: 0 };
	const head =
		title.width > 0
			? `${frame.edge(`${box.horizontal} `)}${title.text}${frame.edge(" ")}`
			: frame.edge(box.horizontal);
	const tail =
		state.width > 0
			? `${frame.edge(" ")}${state.text}${frame.edge(` ${box.horizontal}`)}`
			: frame.edge(box.horizontal);
	const fill = frame.edge(box.horizontal.repeat(Math.max(0, inner - cost(title) - cost(state))));
	return `${frame.edge(box.topLeft)}${head}${fill}${tail}${frame.edge(box.topRight)}`;
}

/** `╰─ meta ─────╯` at exactly `width` cells. */
function bottomEdge(width: number, meta: string, ink: RoomInk, frame: FrameColours): string {
	const box = theme.boxRound;
	const inner = width - 2;
	if (inner <= 0) return frame.edge(`${box.bottomLeft}${box.bottomRight}`.slice(0, Math.max(0, width)));
	const room = inner - 4;
	const text = room >= 6 && meta !== "" ? truncateToWidth(meta, room) : "";
	const textWidth = visibleWidth(text);
	if (textWidth === 0) return frame.edge(`${box.bottomLeft}${box.horizontal.repeat(inner)}${box.bottomRight}`);
	const fill = box.horizontal.repeat(Math.max(0, inner - textWidth - 3));
	return `${frame.edge(`${box.bottomLeft}${box.horizontal} `)}${ink.token("dim", text)}${frame.edge(` ${fill}${box.bottomRight}`)}`;
}

/** Surround body rows with the side edges; rows are fitted to the inner width first. */
function framedBody(
	rows: readonly string[],
	width: number,
	height: number,
	frame: FrameColours,
	pad: number,
): string[] {
	const box = theme.boxRound;
	const inner = Math.max(0, width - 2 - pad * 2);
	const side = " ".repeat(pad);
	const out: string[] = [];
	for (let i = 0; i < height; i++) {
		out.push(`${frame.edge(box.vertical)}${side}${fitRow(rows[i] ?? "", inner)}${side}${frame.edge(box.vertical)}`);
	}
	return out;
}

/** One feed block as styled rows at `width`. */
function blockRows(block: RoomFeedBlock, width: number, ink: RoomInk, working: boolean): string[] {
	switch (block.kind) {
		case "prompt": {
			const gutter = ink.token(working ? "borderAccent" : "dim", theme.nav.cursor);
			return wrapPlain(block.text, Math.max(1, width - 2)).map(
				(line, i) => `${i === 0 ? gutter : " "} ${ink.token("userMessageText", line)}`,
			);
		}
		case "tool": {
			const railToken: ThemeColor =
				block.state === "error" ? "error" : block.state === "running" ? "borderAccent" : "dim";
			const rail = ink.token(railToken, theme.symbol("block.rail"));
			const label = ink.bold(ink.token("toolTitle", block.label));
			const detail = block.detail === "" ? "" : `  ${ink.token("muted", block.detail)}`;
			const mark = block.state === "error" ? ` ${ink.token("error", theme.status.error)}` : "";
			return [truncateToWidth(`${rail} ${label}${detail}${mark}`, width)];
		}
		case "text":
			return wrapPlain(plainProse(block.text), width).map(line => ink.token("text", line));
		case "thinking":
			return [theme.italic(ink.token("thinkingText", "Thinking…"))];
		case "note":
			return wrapPlain(block.text, width).map(line => ink.token(block.tone === "error" ? "error" : "muted", line));
	}
}

/**
 * The body of a card: the prompt at the head (at most two rows), then as much
 * of the tail of what followed as fits. When the middle is cut, a `⋯` row says
 * so, so a card never implies the prompt was answered by its last three lines.
 */
function cardBody(snapshot: RoomWindowSnapshot, width: number, height: number, ink: RoomInk): string[] {
	if (height <= 0 || width <= 0) return [];
	const working = snapshot.state.kind === "working";
	const blocks = snapshot.blocks;
	if (blocks.length === 0) {
		const lines = snapshot.state.kind === "new" ? ["Nothing asked yet"] : ["No messages"];
		const top = Math.max(0, Math.floor((height - lines.length) / 2));
		const rows: string[] = new Array(top).fill("");
		for (const line of lines) {
			const w = visibleWidth(line);
			rows.push(
				" ".repeat(Math.max(0, Math.floor((width - w) / 2))) + ink.token("dim", truncateToWidth(line, width)),
			);
		}
		return rows;
	}
	const head: string[] = [];
	let bodyStart = 0;
	if (blocks[0]?.kind === "prompt") {
		const promptRows = blockRows(blocks[0], width, ink, working);
		if (promptRows.length > PROMPT_HEAD_ROWS) {
			head.push(...promptRows.slice(0, PROMPT_HEAD_ROWS - 1));
			const last = promptRows[PROMPT_HEAD_ROWS - 1] ?? "";
			head.push(truncateToWidth(`${last}…`, width));
		} else {
			head.push(...promptRows);
		}
		bodyStart = 1;
	}
	const body: string[] = [];
	let previous: RoomFeedBlock["kind"] | undefined;
	for (let i = bodyStart; i < blocks.length; i++) {
		const block = blocks[i]!;
		// A paragraph of prose is set off from the tool rows around it, the way
		// the transcript sets them off; tool rows stack tight.
		if (previous !== undefined && (block.kind === "text" || previous === "text") && block.kind !== previous) {
			body.push("");
		}
		body.push(...blockRows(block, width, ink, working));
		previous = block.kind;
	}
	if (head.length === 0) return body.slice(-height);
	const spacer = body.length > 0 ? 1 : 0;
	if (head.length + spacer + body.length <= height) return [...head, ...(spacer ? [""] : []), ...body];
	if (height <= head.length + 1) return body.slice(-height);
	const tailRows = height - head.length - 1;
	return [...head, `  ${ink.token("dim", theme.status.pending)}`, ...body.slice(-tailRows)];
}

/** `2  refactor auth`, with the selection cursor ahead of it when selected. */
function titleLabel(paint: RoomWindowPaint, ink: RoomInk, withTitle: boolean): { text: string; width: number } {
	const ordinal = String(paint.ordinal);
	const cursor = paint.selected ? `${theme.nav.cursor} ` : "";
	const title = withTitle ? windowTitle(paint.snapshot) : "";
	const plain = `${cursor}${ordinal}${title ? `  ${title}` : ""}`;
	const styledCursor = cursor ? ink.token("borderAccent", cursor) : "";
	const styledOrdinal = paint.selected ? ink.bold(ink.token("borderAccent", ordinal)) : ink.token("muted", ordinal);
	const styledTitle = title
		? `  ${paint.selected ? ink.bold(ink.token("text", title)) : ink.token("text", title)}`
		: "";
	return { text: `${styledCursor}${styledOrdinal}${styledTitle}`, width: visibleWidth(plain) };
}

/** Every SGR sequence in a line; `pinDefaultForeground` walks it to the end, which resets it. */
const SGR_ANYWHERE = sgrSequence("g");

/**
 * Insert an explicit foreground wherever `line` falls back to the terminal's
 * default one — at its start and after every reset — so a fade has a colour to
 * mix. `38`/`48` arguments are skipped rather than read as codes, which is the
 * difference between `38;2;0;0;0` (black) and a `0` (reset).
 */
function pinDefaultForeground(line: string, open: string): string {
	let out = open;
	let last = 0;
	SGR_ANYWHERE.lastIndex = 0;
	for (let match = SGR_ANYWHERE.exec(line); match !== null; match = SGR_ANYWHERE.exec(line)) {
		out += line.slice(last, match.index + match[0].length);
		last = match.index + match[0].length;
		const codes = (match[1] ?? "").split(/[;:]/);
		let resets = codes.length === 1 && codes[0] === "";
		for (let i = 0; i < codes.length && !resets; i++) {
			const code = codes[i];
			if (code === "38" || code === "48" || code === "58") {
				i += codes[i + 1] === "5" ? 2 : 4;
				continue;
			}
			if (code === "0" || code === "39") resets = true;
		}
		if (resets) out += open;
	}
	return out + line.slice(last);
}

/**
 * The conversation's real screen cropped to `width`×`height`: its bottom rows,
 * from the left edge, since a conversation reads from the composer upward and
 * its text is set flush left.
 */
function screenCrop(rows: readonly string[], width: number, height: number, ink: RoomInk, ground: string): string[] {
	const top = Math.max(0, rows.length - height);
	const out: string[] = [];
	const textHex = theme.getColorHex("text");
	const open = theme.fgHexAnsi(textHex);
	for (let i = 0; i < height; i++) {
		let row = rows[top + i] ?? "";
		row = sliceByColumn(row, 0, width, true);
		if (!ink.full && TERMINAL.trueColor && open !== "") {
			row = fadeLineTowards(pinDefaultForeground(row, open), ground, ink.strength);
		}
		out.push(fitRow(row, width));
	}
	return out;
}

/** Paint one conversation window: exactly `height` rows of exactly `width` cells. */
export function paintRoomWindow(paint: RoomWindowPaint): string[] {
	const { width, height } = paint;
	if (width <= 0 || height <= 0) return [];
	const ground = theme.visibleGroundHex();
	const ink = new RoomInk(paint.strength, ground);
	const screen = paint.screen;

	// The whole terminal with a screen to show: the window IS the screen, with no frame.
	if (screen !== undefined && !paint.framed && screen.mix >= 0.999) {
		return screenCrop(screen.rows, width, height, ink, ground);
	}
	if (height < 3 || width < 4) {
		return new Array(height).fill(" ".repeat(width));
	}

	const frame = frameColours(ink, paint.selected);
	const innerHeight = height - 2;

	if (width < TINY_WIDTH) {
		const chip = stateChip(paint.snapshot, paint.waitingDialogs, ink, paint.now, false);
		const label = paint.selected
			? ink.bold(ink.token("borderAccent", String(paint.ordinal)))
			: ink.token("muted", String(paint.ordinal));
		const innerWidth = width - 2;
		const centre = (text: string, w: number): string =>
			`${" ".repeat(Math.max(0, Math.floor((innerWidth - w) / 2)))}${text}`;
		const rows = [centre(label, String(paint.ordinal).length), centre(chip.text, chip.width)];
		const top = Math.max(0, Math.floor((innerHeight - rows.length) / 3));
		const body: string[] = [...new Array(top).fill(""), ...rows];
		return [
			frame.edge(
				`${theme.boxRound.topLeft}${theme.boxRound.horizontal.repeat(width - 2)}${theme.boxRound.topRight}`,
			),
			...framedBody(body, width, innerHeight, frame, 0),
			frame.edge(
				`${theme.boxRound.bottomLeft}${theme.boxRound.horizontal.repeat(width - 2)}${theme.boxRound.bottomRight}`,
			),
		];
	}

	const compact = width < COMPACT_WIDTH;
	const label = titleLabel(paint, ink, !compact);
	const chip = stateChip(paint.snapshot, paint.waitingDialogs, ink, paint.now, !compact);
	const chipGlyph = stateChip(paint.snapshot, paint.waitingDialogs, ink, paint.now, false);
	const top = topEdge(width, label, chip, chipGlyph, frame);
	const meta = [paint.snapshot.model, paint.snapshot.cwd].filter(Boolean).join(theme.sep.dot);
	const bottom = bottomEdge(width, compact ? "" : meta, ink, frame);

	const pad = 1;
	const innerWidth = width - 2 - pad * 2;
	let body: string[];
	if (screen !== undefined && screen.mix > 0.5) {
		const cropInk = new RoomInk(ink.strength * clamp01((screen.mix - 0.5) * 2), ground);
		body = screenCrop(screen.rows, width - 2, innerHeight, cropInk, ground);
		return [top, ...framedBody(body, width, innerHeight, frame, 0), bottom];
	}
	const cardStrength = screen !== undefined ? ink.strength * clamp01((0.5 - screen.mix) * 2) : ink.strength;
	const cardInk = cardStrength === ink.strength ? ink : new RoomInk(cardStrength, ground);
	const rows: string[] = [];
	// A narrow window leads with its name, since its top edge has no room for one.
	// A conversation with no name goes by its prompt, which the body already
	// leads with, so it gets no second copy of it.
	if (compact && paint.snapshot.title !== undefined) {
		const title = truncateToWidth(paint.snapshot.title, innerWidth);
		rows.push(paint.selected ? cardInk.bold(cardInk.token("text", title)) : cardInk.token("text", title));
		rows.push("");
	}
	// A conversation holding a question says so at the foot of its window, where
	// the eye lands after reading what it did, not only in the edge chip.
	const waitingRow =
		paint.waitingDialogs > 0 && innerHeight - rows.length >= 4
			? cardInk.token(
					"borderAccent",
					`${theme.status.warning} ${innerWidth >= 26 ? "waiting for your answer" : "needs you"}`,
				)
			: undefined;
	rows.push(...cardBody(paint.snapshot, innerWidth, innerHeight - rows.length - (waitingRow ? 2 : 0), cardInk));
	if (waitingRow) {
		while (rows.length < innerHeight - 1) rows.push("");
		rows.push(waitingRow);
	}
	return [top, ...framedBody(rows, width, innerHeight, frame, pad), bottom];
}

/** Paint the new-conversation slot. */
export function paintRoomNewSlot(paint: RoomNewSlotPaint): string[] {
	const { width, height } = paint;
	if (width <= 0 || height <= 0) return [];
	if (height < 3 || width < 4) return new Array(height).fill(" ".repeat(width));
	const ink = new RoomInk(paint.strength, theme.visibleGroundHex());
	const frame = frameColours(ink, paint.selected);
	const box = theme.boxRound;
	const innerWidth = width - 2;
	const innerHeight = height - 2;
	const lines: { text: string; width: number }[] = [];
	if (paint.starting) {
		const frames = theme.getSpinnerFrames("status");
		const glyph = frames[sharedSpinnerFrame(frames.length, paint.now)] ?? "";
		const word = width >= TINY_WIDTH ? " Starting…" : "";
		lines.push({
			text: `${ink.token("borderAccent", glyph)}${ink.token("muted", word)}`,
			width: visibleWidth(glyph + word),
		});
	} else {
		lines.push({ text: ink.bold(ink.token(paint.selected ? "borderAccent" : "accent", "+")), width: 1 });
		const label = width >= COMPACT_WIDTH ? "New conversation" : width >= TINY_WIDTH ? "new" : "";
		if (label) {
			lines.push({ text: "", width: 0 });
			lines.push({ text: ink.token("muted", label), width: label.length });
		}
	}
	const top = Math.max(0, Math.floor((innerHeight - lines.length) / 2));
	const body: string[] = new Array(top).fill("");
	for (const line of lines) {
		body.push(`${" ".repeat(Math.max(0, Math.floor((innerWidth - line.width) / 2)))}${line.text}`);
	}
	return [
		frame.edge(`${box.topLeft}${box.horizontal.repeat(innerWidth)}${box.topRight}`),
		...framedBody(body, width, innerHeight, frame, 0),
		frame.edge(`${box.bottomLeft}${box.horizontal.repeat(innerWidth)}${box.bottomRight}`),
	];
}
