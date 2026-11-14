/**
 * What every permission surface draws from: the palette, the call reduced to a verb and a
 * subject, the answers the policy offered, and one ticker for ambient motion.
 *
 * A surface reads the palette on every frame rather than once, so a theme switch while a
 * prompt is open repaints it in the new colours.
 */
import { blendHex } from "@veyyon/utils/motion";
import { replaceTabs } from "@veyyon/utils/tab-width";
import type { ApprovalCard, ApprovalCardReason, ExtensionUISelectItem } from "../../../../extensibility/extensions";
import { groundHairlineHex, groundRaisedHex } from "../../../../theme/ground-tints";
import { theme } from "../../../../theme/theme-binding";
import { pointerMotionEnabled } from "../chrome/modal-shell";

// ── palette ──────────────────────────────────────────────────────────────────────────────────

export interface Ink {
	/** The colour the rows visibly sit on. */
	ground: string;
	/** A whisper above the ground: tracks and card faces. */
	raised: string;
	/** Structural lines. */
	hairline: string;
	text: string;
	/** Text lifted toward white: titles and the selected answer. */
	bright: string;
	muted: string;
	dim: string;
	/** The brand accent. */
	ember: string;
	/** The accent pushed a third of the way into the ground. */
	emberDim: string;
	ok: string;
	warn: string;
	err: string;
}

export function ink(): Ink {
	const ground = theme.visibleGroundHex();
	const text = theme.getColorHex("text");
	const ember = theme.getColorHex("borderAccent");
	return {
		ground,
		raised: groundRaisedHex() ?? blendHex(ground, text, 0.05),
		hairline: groundHairlineHex() ?? blendHex(ground, text, 0.12),
		text,
		bright: blendHex(text, theme.isLight ? "#000000" : "#ffffff", 0.45),
		muted: theme.getColorHex("muted"),
		dim: theme.getColorHex("dim"),
		ember,
		emberDim: blendHex(ember, ground, 0.35),
		ok: theme.getColorHex("success"),
		warn: theme.getColorHex("warning"),
		err: theme.getColorHex("error"),
	};
}

/** `text` in the foreground `hex`, closed with a foreground reset. Plain text when colour is off. */
export function fg(hex: string, text: string): string {
	const open = theme.fgHexAnsi(hex);
	return open ? `${open}${text}\x1b[39m` : text;
}

/** `text` on the background `hex`, closed with a background reset. */
export function bg(hex: string, text: string): string {
	return theme.bgHex(hex, text);
}

// ── the call ─────────────────────────────────────────────────────────────────────────────────

export interface CallView {
	/** What the call does, in one word. */
	verb: "exec" | "write" | "edit" | "read" | "fetch" | "call";
	/** What it does it to: the command, the path, the URL, or the tool's first detail. */
	subject: string;
	/** Whether `subject` is a shell command and can be read as tokens. */
	shell: boolean;
	/** The tool's other `Label: value` details. */
	extra: { label: string; value: string }[];
}

function stringField(args: unknown, ...keys: string[]): string | undefined {
	if (typeof args !== "object" || args === null) return undefined;
	const record = args as Record<string, unknown>;
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) return value;
	}
	return undefined;
}

/** Display text: tabs to spaces, control characters dropped, newlines kept for `cellsOf` to mark. */
export function sanitize(text: string): string {
	return replaceTabs(text).replace(/[\x00-\x09\x0b-\x1f\x7f]/g, "");
}

/** A `Label: value` detail. The value may start on the next line, as a file's content does. */
function splitDetail(line: string): { label: string; value: string } {
	const head = /^([^:\n]{1,32}):\s+/.exec(line);
	return head ? { label: head[1]!, value: line.slice(head[0].length) } : { label: "", value: line };
}

export function callView(card: ApprovalCard): CallView {
	const details = card.details.map(line => splitDetail(sanitize(line)));
	const command = stringField(card.args, "command", "cmd", "script");
	if (command) {
		return {
			verb: "exec",
			subject: sanitize(command).trim(),
			shell: true,
			extra: details.filter(d => d.label !== "Command"),
		};
	}
	const path = stringField(card.args, "path", "file_path", "filePath", "file", "target");
	if (path) {
		const tool = card.toolName.toLowerCase();
		const verb = tool.includes("edit") ? "edit" : tool.includes("read") ? "read" : "write";
		return { verb, subject: sanitize(path), shell: false, extra: details.filter(d => d.value !== path) };
	}
	const url = stringField(card.args, "url", "uri", "href");
	if (url) return { verb: "fetch", subject: sanitize(url), shell: false, extra: details };
	const [first, ...rest] = details;
	return { verb: "call", subject: first?.value ?? card.toolName, shell: false, extra: rest };
}

export type TokenRole = "program" | "flag" | "path" | "string" | "operator" | "variable" | "word" | "space";

export interface Token {
	text: string;
	role: TokenRole;
}

/** Shell operators; `true` when the word after one is a program rather than a file. */
const OPERATORS: Record<string, boolean> = {
	"|": true,
	"||": true,
	"&&": true,
	";": true,
	"&": true,
	"|&": true,
	"2>&1": true,
	">": false,
	">>": false,
	"<": false,
	"2>": false,
};

/**
 * A shell command cut into display tokens. Not a parser: quoting is honoured so a quoted
 * argument stays one token, and the first word after the start or an operator is the program.
 */
export function shellTokens(command: string): Token[] {
	const tokens: Token[] = [];
	let expectProgram = true;
	let i = 0;
	while (i < command.length) {
		const ch = command[i]!;
		if (ch === " " || ch === "\n") {
			let j = i;
			while (j < command.length && (command[j] === " " || command[j] === "\n")) j++;
			tokens.push({ text: command.slice(i, j).replace(/\n/g, " "), role: "space" });
			i = j;
			continue;
		}
		let j = i;
		let quote: string | undefined;
		while (j < command.length) {
			const c = command[j]!;
			if (quote) {
				if (c === quote) quote = undefined;
			} else if (c === '"' || c === "'") quote = c;
			else if (c === " " || c === "\n") break;
			j++;
		}
		const text = command.slice(i, j);
		let role: TokenRole;
		if (Object.hasOwn(OPERATORS, text)) {
			role = "operator";
			expectProgram = OPERATORS[text]!;
		} else if (expectProgram && !/^\w+=/.test(text)) {
			role = "program";
			expectProgram = false;
		} else if (text.startsWith("-")) role = "flag";
		else if (text.startsWith('"') || text.startsWith("'")) role = "string";
		else if (text.startsWith("$")) role = "variable";
		else if (text.includes("/") || text.startsWith(".") || text.startsWith("~")) role = "path";
		else role = "word";
		tokens.push({ text, role });
		i = j;
	}
	return tokens;
}

// ── risk ─────────────────────────────────────────────────────────────────────────────────────

export type Risk = "routine" | "elevated" | "critical";

export function riskOf(card: ApprovalCard): Risk {
	if (card.reasons.some(r => r.kind === "critical")) return "critical";
	if (card.reasons.some(r => r.kind === "boundary" || r.kind === "secret")) return "elevated";
	return "routine";
}

/** The reasons worth a line: every non-policy reason, else the policy one. */
export function shownReasons(card: ApprovalCard): readonly ApprovalCardReason[] {
	const loud = card.reasons.filter(r => r.kind !== "policy");
	return loud.length > 0 ? loud : card.reasons;
}

// ── answers ──────────────────────────────────────────────────────────────────────────────────

export type ChoiceId = "once" | "pattern" | "session" | "deny" | "never";

export interface Choice {
	id: ChoiceId;
	/** The key that picks it outright. */
	key: string;
	/** The option label the policy reads back. */
	label: string;
	/** A one-word name for tight layouts. */
	name: string;
	/** What answering this does, in one sentence. */
	note: string;
	allow: boolean;
}

/** The answers the policy offered, in a fixed order, each mapped back to its option label. */
export function choicesFor(card: ApprovalCard, options: readonly ExtensionUISelectItem[]): Choice[] {
	const offered = new Set(options.map(o => (typeof o === "string" ? o : o.label)));
	const tool = sanitize(card.toolName);
	const pattern = card.pattern ? sanitize(card.pattern) : undefined;
	const all: (Choice | undefined)[] = [
		{
			id: "once",
			key: "y",
			label: card.choices.approveOnce,
			name: "once",
			note: "Run this call. Nothing is remembered.",
			allow: true,
		},
		card.choices.approvePattern
			? {
					id: "pattern",
					key: "p",
					label: card.choices.approvePattern,
					name: "pattern",
					note: `Run every ${pattern ? `\`${pattern}\`` : "matching"} call until you exit.`,
					allow: true,
				}
			: undefined,
		card.choices.approveSession
			? {
					id: "session",
					key: "a",
					label: card.choices.approveSession,
					name: "session",
					note: `Run every ${tool} call until you exit.`,
					allow: true,
				}
			: undefined,
		{
			id: "deny",
			key: "n",
			label: card.choices.denyOnce,
			name: "deny",
			note: "Skip this call. The agent is told it was refused.",
			allow: false,
		},
		{
			id: "never",
			key: "N",
			label: card.choices.denySession,
			name: "never",
			note: `Refuse every ${tool} call until you exit.`,
			allow: false,
		},
	];
	return all.filter((c): c is Choice => c !== undefined && offered.has(c.label));
}

/** Where the selection starts: on refusal for a destructive call, else on running it once. */
export function initialChoice(choices: readonly Choice[], risk: Risk): number {
	const want: ChoiceId = risk === "critical" ? "deny" : "once";
	return Math.max(
		0,
		choices.findIndex(c => c.id === want),
	);
}

// ── ambient motion ───────────────────────────────────────────────────────────────────────────

const FRAME_MS = 1000 / 30;
/** Ambient frames (breathing, a timer) are drawn at this interval when nothing is moving. */
const AMBIENT_MS = 1000 / 12;

/**
 * The clock a waiting prompt draws its own time from. It repaints at 30fps while
 * something is moving ({@link Ticker.hot}) and at 12fps otherwise, and at 1fps with
 * motion off, which is enough for a waiting timer.
 */
export class Ticker {
	readonly motion = pointerMotionEnabled();
	#start = performance.now();
	#hotUntil = 0;
	#lastPaint = 0;
	#timer: NodeJS.Timeout | undefined;
	#requestRender: () => void;

	constructor(requestRender: () => void) {
		this.#requestRender = requestRender;
	}

	start(): void {
		if (this.#timer) return;
		this.#start = performance.now();
		this.#timer = setInterval(() => this.#tick(), this.motion ? FRAME_MS : 1000);
		this.#timer.unref?.();
	}

	stop(): void {
		clearInterval(this.#timer);
		this.#timer = undefined;
	}

	/** Paint at full rate for the next `ms`. */
	hot(ms: number): void {
		this.#hotUntil = Math.max(this.#hotUntil, performance.now() + ms);
	}

	/** Milliseconds since `start`. */
	get elapsed(): number {
		return performance.now() - this.#start;
	}

	/**
	 * Progress through a scripted segment that begins `delay` ms after start and lasts `ms`,
	 * in [0, 1]. Always 1 with motion off, so every frame is the settled one.
	 */
	progress(delay: number, ms: number): number {
		if (!this.motion) return 1;
		return Math.min(1, Math.max(0, (this.elapsed - delay) / ms));
	}

	/** A slow sine in [0, 1] with period `ms`. 1 with motion off. */
	wave(ms: number, offset = 0): number {
		if (!this.motion) return 1;
		return 0.5 - 0.5 * Math.cos(((this.elapsed + offset) / ms) * Math.PI * 2);
	}

	#tick(): void {
		const now = performance.now();
		if (this.motion && now >= this.#hotUntil && now - this.#lastPaint < AMBIENT_MS) return;
		this.#lastPaint = now;
		this.#requestRender();
	}
}

/** `m:ss` of a duration. */
export function clockText(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** A deterministic noise glyph for cell `i` on frame `frame`, for text that decodes into place. */
export function noiseGlyph(i: number, frame: number): string {
	const NOISE = "·:-=+*#%/\\<>";
	const h = Math.imul(i * 374761393 + frame * 668265263, 1274126177) >>> 0;
	return NOISE[h % NOISE.length]!;
}

// ── cells ────────────────────────────────────────────────────────────────────────────────────

/**
 * One terminal cell. Surfaces that move things by the cell (a gliding thumb, a comet, text
 * decoding into place) compose a row as cells and paint it once, so each frame is a pure
 * function of time and the row is never re-parsed.
 */
export interface Cell {
	ch: string;
	fg?: string;
	bg?: string;
	bold?: boolean;
	underline?: boolean;
	strike?: boolean;
}

/**
 * `text` as cells in one style, sanitized: tabs become spaces, control bytes are dropped, and a
 * newline becomes a `↵` cell. A row holds one terminal line, and a line break inside it would split
 * the frame the renderer diffs against.
 */
export function cellsOf(text: string, style: Omit<Cell, "ch"> = {}): Cell[] {
	return Array.from(sanitize(text), ch => ({ ch: ch === "\n" ? "↵" : ch, ...style }));
}

export function blankCells(count: number): Cell[] {
	return Array.from({ length: Math.max(0, count) }, () => ({ ch: " " }));
}

function sameStyle(a: Cell, b: Cell): boolean {
	return a.fg === b.fg && a.bg === b.bg && a.bold === b.bold && a.underline === b.underline && a.strike === b.strike;
}

/** A row of cells as one string, one SGR run per stretch of identical style. */
export function paintCells(cells: readonly Cell[]): string {
	let out = "";
	let i = 0;
	while (i < cells.length) {
		const head = cells[i]!;
		let text = head.ch;
		let j = i + 1;
		while (j < cells.length && sameStyle(head, cells[j]!)) text += cells[j++]!.ch;
		if (head.bold) text = theme.bold(text);
		if (head.underline) text = theme.underline(text);
		if (head.strike) text = theme.strikethrough(text);
		if (head.fg) text = fg(head.fg, text);
		if (head.bg) text = bg(head.bg, text);
		out += text;
		i = j;
	}
	return out;
}

/** `cells` written into `row` from column `at`, clipped to the row. */
export function placeCells(row: Cell[], at: number, cells: readonly Cell[]): void {
	for (let k = 0; k < cells.length; k++) {
		const x = at + k;
		if (x >= 0 && x < row.length) row[x] = cells[k]!;
	}
}

/** The colour of a shell token: the program lifted, flags in the accent, operators quiet. */
export function tokenHex(role: TokenRole, k: Ink): string {
	switch (role) {
		case "program":
			return k.bright;
		case "flag":
			return k.ember;
		case "string":
			return blendHex(k.warn, k.text, 0.45);
		case "variable":
			return k.warn;
		case "operator":
			return k.dim;
		default:
			return k.text;
	}
}

/** The call's subject as cells: a command by token, a path with its file name lifted. */
export function subjectCells(view: CallView, k: Ink): Cell[] {
	if (view.shell) {
		return shellTokens(view.subject).flatMap(token =>
			cellsOf(token.text, { fg: tokenHex(token.role, k), bold: token.role === "program" }),
		);
	}
	if (view.verb === "call" || view.verb === "fetch") return cellsOf(view.subject, { fg: k.text });
	const slash = view.subject.lastIndexOf("/");
	return [
		...cellsOf(view.subject.slice(0, slash + 1), { fg: k.muted }),
		...cellsOf(view.subject.slice(slash + 1), { fg: k.bright }),
	];
}

/**
 * `cells` cut into rows of at most `room`, at most `rows` of them, the last ending in a count of
 * what was cut. A row breaks after a `↵` and otherwise at its last space, unless that would leave
 * it under half full; a word longer than that is cut where the row ends.
 */
export function wrapCells(cells: readonly Cell[], width: number, rows: number, k: Ink): Cell[][] {
	// At least one cell a row, so every pass of the loop consumes something.
	const room = Math.max(1, width);
	const lines: Cell[][] = [];
	let i = 0;
	while (i < cells.length && lines.length < rows) {
		let end = Math.min(cells.length, i + room);
		let next = end;
		const mark = cells.slice(i, end).findIndex(c => c.ch === "↵");
		if (mark >= 0) {
			end = next = i + mark + 1;
		} else if (end < cells.length) {
			for (let j = end; j > i + room / 2; j--) {
				if (cells[j]!.ch === " ") {
					end = j;
					next = j + 1;
					break;
				}
			}
		}
		lines.push(cells.slice(i, end));
		i = next;
	}
	if (i < cells.length) {
		const more = cellsOf(` … +${cells.length - i}`, { fg: k.dim });
		const last = lines[lines.length - 1]!;
		lines[lines.length - 1] = [...last.slice(0, room - more.length), ...more];
	}
	return lines;
}

/** The mark in front of a reason: the accent for a destructive call, a warning for a boundary. */
export function reasonGlyph(reason: ApprovalCardReason, k: Ink): Cell {
	switch (reason.kind) {
		case "critical":
			return { ch: "▲", fg: k.ember };
		case "boundary":
			return { ch: "↗", fg: k.warn };
		case "secret":
			return { ch: "◆", fg: k.warn };
		default:
			return { ch: "·", fg: k.dim };
	}
}

/** `text` truncated to `room` cells with an ellipsis. */
export function fitCells(cells: readonly Cell[], room: number, k: Ink): Cell[] {
	if (cells.length <= room) return [...cells];
	return room <= 0 ? [] : [...cells.slice(0, room - 1), { ch: "…", fg: k.dim }];
}
