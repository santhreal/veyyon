/**
 * What every permission surface draws from: the palette, the call reduced to a verb and a
 * subject, the answers the policy offered, and one ticker for ambient motion.
 *
 * A surface reads the palette on every frame rather than once, so a theme switch while a
 * prompt is open repaints it in the new colours.
 */
import type { Component } from "@veyyon/tui";
import { matchesKey } from "@veyyon/utils/keys";
import { type Animation, blendHex, MOTION, motionClock } from "@veyyon/utils/motion";
import { replaceTabs } from "@veyyon/utils/tab-width";
import { truncateToWidth } from "@veyyon/utils/width";
import type { ApprovalCard, ApprovalCardReason, ExtensionUISelectItem } from "../../../../extensibility/extensions";
import { groundHairlineHex, groundRaisedHex } from "../../../../theme/ground-tints";
import { theme } from "../../../../theme/theme-binding";
import type { ApprovalCategory, ApprovalChoiceId } from "../../../../tools/core/approval-gate";
import { matchesSelectCancel } from "../../utils/keybinding-matchers";
import { pointerMotionEnabled } from "../chrome/modal-shell";
import type { PermissionSurfaceContext } from "./surface";

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

/** How loud each category draws: a destructive call is critical, an argument boundary elevated. */
const CATEGORY_RISK: Record<ApprovalCategory, Risk> = {
	destructive: "critical",
	secret: "elevated",
	outside: "elevated",
	command: "routine",
	edit: "routine",
	read: "routine",
};

export function riskOf(card: ApprovalCard): Risk {
	return CATEGORY_RISK[card.category];
}

/** The reasons worth a line: every elevated or critical reason, else the tier one. */
export function shownReasons(card: ApprovalCard): readonly ApprovalCardReason[] {
	const loud = card.reasons.filter(r => CATEGORY_RISK[r.category] !== "routine");
	return loud.length > 0 ? loud : card.reasons;
}

// ── answers ──────────────────────────────────────────────────────────────────────────────────

export type ChoiceId = ApprovalChoiceId;

export interface Choice {
	id: ChoiceId;
	/** The key that picks it outright. */
	key: string;
	/** The option label the policy reads back. */
	label: string;
	/** What a session answer covers, sanitized: the tool, the pattern or the secret names. */
	scope: string;
	/** What answering this does, in one sentence. */
	note: string;
	allow: boolean;
}

/** Each answer's key and note; `scope` is what a session answer covers. */
const CHOICE_FACE: Record<ChoiceId, { key: string; note: (scope: string, secret: boolean) => string }> = {
	once: { key: "y", note: () => "Run this call. Nothing is remembered." },
	pattern: { key: "p", note: scope => `Run every \`${scope}\` call until you exit.` },
	session: {
		key: "a",
		note: (scope, secret) =>
			secret ? `Let any call spend ${scope} until you exit.` : `Run every ${scope} call until you exit.`,
	},
	deny: { key: "n", note: () => "Skip this call. The agent is told it was refused." },
	never: {
		key: "N",
		note: (scope, secret) =>
			secret
				? `Refuse every call that spends ${scope} until you exit.`
				: `Refuse every ${scope} call until you exit.`,
	},
};

/** The answers the policy offered, in its order, each mapped back to its option label. */
export function choicesFor(card: ApprovalCard, options: readonly ExtensionUISelectItem[]): Choice[] {
	const offered = new Set(options.map(o => (typeof o === "string" ? o : o.label)));
	const secret = card.category === "secret";
	return card.choices
		.filter(choice => offered.has(choice.label))
		.map(choice => {
			const face = CHOICE_FACE[choice.id];
			const scope = sanitize(choice.scope ?? card.toolName);
			return {
				id: choice.id,
				key: face.key,
				label: choice.label,
				scope,
				note: face.note(scope, secret),
				allow: choice.allow,
			};
		});
}

/** Where the selection starts: on refusal for a destructive call, else on running it once. */
export function initialChoice(choices: readonly Choice[], risk: Risk): number {
	const want: ChoiceId = risk === "critical" ? "deny" : "once";
	return Math.max(
		0,
		choices.findIndex(c => c.id === want),
	);
}

const VERB_PHRASE: Record<CallView["verb"], string> = {
	exec: "wants to run",
	write: "wants to write",
	edit: "wants to edit",
	read: "wants to read",
	fetch: "wants to open",
	call: "wants to call",
};

/** `bash  wants to run`, or `designer · bash  wants to run` for a spawned agent's call. */
export function leadCells(card: ApprovalCard, view: CallView, k: Ink): Cell[] {
	return [
		...(card.requester ? cellsOf(`${card.requester} · `, { fg: k.muted }) : []),
		...cellsOf(card.toolName, { fg: k.bright, bold: true }),
		...cellsOf(`  ${VERB_PHRASE[view.verb]}`, { fg: k.muted }),
	];
}

/** A number that springs toward each target it is given, on `MOTION.move`; it jumps with motion off. */
export class Glide {
	#animation: Animation | undefined;
	readonly #motion: boolean;

	constructor(motion: boolean) {
		this.#motion = motion;
	}

	/** Aim at `target` and return where the value is now. */
	toward(target: number): number {
		if (!this.#animation) {
			this.#animation = motionClock.animate(MOTION.move, { from: target, to: target, enabled: this.#motion });
		} else if (target !== this.#animation.target) {
			this.#animation.retarget(target);
			if (this.#motion) motionClock.resume(this.#animation);
			else this.#animation.finish();
		}
		return this.#animation.value;
	}
}

// ── the prompt ───────────────────────────────────────────────────────────────────────────────

/** How the prompt was answered: the choice (none for a cancel, which denies) and when, on the ticker. */
export interface Answer {
	choice: Choice | undefined;
	allow: boolean;
	at: number;
}

export interface PromptTiming {
	/** Repaint rate while nothing is scripted to move; 30 keeps a flowing field smooth. */
	ambientFps: number;
	/** How long the entrance runs at full rate. */
	enterMs: number;
	/** How long the exit plays before the composer comes back. */
	exitMs: number;
}

/**
 * A waiting permission prompt: the call, its answers, the selection, and the keys that move and
 * settle it. A direction draws {@link PermissionPrompt.frame} from these and from the ticker's
 * time; it never handles a key or settles the prompt itself.
 *
 * Keys: left, up, shift+tab, `h` and `k` select the previous answer; right, down, tab, `l` and
 * `j` the next; enter answers with the selection; an answer's own key selects and answers; escape
 * cancels, which the policy reads as a refusal.
 */
export abstract class PermissionPrompt implements Component {
	readonly card: ApprovalCard;
	readonly view: CallView;
	readonly risk: Risk;
	readonly choices: Choice[];
	readonly ticker: Ticker;
	readonly #ctx: PermissionSurfaceContext;
	readonly #exitMs: number;
	#index: number;
	#selectedAt = 0;
	#answer: Answer | undefined;
	#exiting = false;

	constructor(card: ApprovalCard, ctx: PermissionSurfaceContext, timing: PromptTiming) {
		this.card = card;
		this.#ctx = ctx;
		this.view = callView(card);
		this.risk = riskOf(card);
		this.choices = choicesFor(card, ctx.options);
		this.#index = initialChoice(this.choices, this.risk);
		this.#exitMs = timing.exitMs;
		this.ticker = new Ticker(ctx.requestRender, timing.ambientFps);
		this.ticker.start();
		this.ticker.hot(timing.enterMs);
	}

	get index(): number {
		return this.#index;
	}

	get selected(): Choice {
		return this.choices[this.#index]!;
	}

	/** Ticker time the selection last moved; 0 until it does. */
	get selectedAt(): number {
		return this.#selectedAt;
	}

	get answer(): Answer | undefined {
		return this.#answer;
	}

	/** Whether the exit is playing. */
	get exiting(): boolean {
		return this.#exiting;
	}

	/** Progress through the exit in [0, 1]; 0 until it starts. */
	get leaving(): number {
		if (!this.#exiting || !this.#answer) return 0;
		return Math.min(1, Math.max(0, (this.ticker.elapsed - this.#answer.at) / this.#exitMs));
	}

	/** Seconds of ambient time, for fields that drift. Fixed at 0 with motion off, so the still is stable. */
	get flow(): number {
		return this.ticker.motion ? this.ticker.elapsed / 1000 : 0;
	}

	/** Rows of the terminal the prompt is drawn on, for a prompt that fills the screen. */
	get screenRows(): number {
		return this.#ctx.tui.terminal.rows;
	}

	dispose(): void {
		this.ticker.stop();
	}

	invalidate(): void {}

	beginOverlayExit(requestRender: () => void, done: () => void): boolean {
		if (!this.ticker.motion) return false;
		this.#answer ??= { choice: undefined, allow: false, at: this.ticker.elapsed };
		this.#exiting = true;
		const end = this.#answer.at + this.#exitMs;
		const timer = setInterval(() => {
			requestRender();
			if (this.ticker.elapsed >= end) {
				clearInterval(timer);
				done();
			}
		}, 1000 / 60);
		timer.unref?.();
		return true;
	}

	handleInput(data: string): void {
		if (this.#answer) return;
		if (matchesSelectCancel(data)) {
			this.#settle(undefined);
		} else if (
			matchesKey(data, "left") ||
			matchesKey(data, "up") ||
			matchesKey(data, "shift+tab") ||
			data === "h" ||
			data === "k"
		) {
			this.#select(this.#index - 1);
		} else if (
			matchesKey(data, "right") ||
			matchesKey(data, "down") ||
			matchesKey(data, "tab") ||
			data === "l" ||
			data === "j"
		) {
			this.#select(this.#index + 1);
		} else if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") {
			this.#settle(this.selected);
		} else {
			const keyed = this.choices.findIndex(c => c.key === data);
			if (keyed < 0) return;
			this.#select(keyed);
			this.#settle(this.choices[keyed]);
		}
	}

	render(width: number): readonly string[] {
		return this.frame(width, ink()).map(line => truncateToWidth(line, width));
	}

	/** The prompt's rows at `width`, drawn from the selection, the answer and the ticker's time. */
	abstract frame(width: number, k: Ink): string[];

	/** Called after the selection moves, before the repaint. */
	onSelect(_previous: number, _next: number): void {}

	#select(index: number): void {
		const next = Math.max(0, Math.min(this.choices.length - 1, index));
		if (next === this.#index) return;
		const previous = this.#index;
		this.#index = next;
		this.#selectedAt = this.ticker.elapsed;
		this.ticker.hot(900);
		this.onSelect(previous, next);
		this.#ctx.requestRender();
	}

	#settle(choice: Choice | undefined): void {
		this.#answer = { choice, allow: choice?.allow ?? false, at: this.ticker.elapsed };
		this.ticker.hot(this.#exitMs + 200);
		this.#ctx.settle(choice?.label);
	}
}

// ── ambient motion ───────────────────────────────────────────────────────────────────────────

const FRAME_MS = 1000 / 30;

/**
 * The clock a waiting prompt draws its own time from. It repaints at 30fps while
 * something is moving ({@link Ticker.hot}), at `ambientFps` otherwise, and at 1fps with
 * motion off, which is enough for a waiting timer.
 */
export class Ticker {
	readonly motion = pointerMotionEnabled();
	#start = performance.now();
	#hotUntil = 0;
	#lastPaint = 0;
	#timer: NodeJS.Timeout | undefined;
	#requestRender: () => void;
	readonly #ambientMs: number;

	constructor(requestRender: () => void, ambientFps = 12) {
		this.#requestRender = requestRender;
		this.#ambientMs = 1000 / ambientFps;
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
		if (this.motion && now >= this.#hotUntil && now - this.#lastPaint < this.#ambientMs) return;
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
const REASON_MARK: Record<ApprovalCategory, (k: Ink) => Cell> = {
	destructive: k => ({ ch: "▲", fg: k.ember }),
	secret: k => ({ ch: "◆", fg: k.warn }),
	outside: k => ({ ch: "↗", fg: k.warn }),
	command: k => ({ ch: "·", fg: k.dim }),
	edit: k => ({ ch: "·", fg: k.dim }),
	read: k => ({ ch: "·", fg: k.dim }),
};

/** `text` truncated to `room` cells with an ellipsis. */
export function fitCells(cells: readonly Cell[], room: number, k: Ink): Cell[] {
	if (cells.length <= room) return [...cells];
	return room <= 0 ? [] : [...cells.slice(0, room - 1), { ch: "…", fg: k.dim }];
}

/** The call's other details as `label  value` rows, at most two, each fitted to `room`. */
export function detailRows(view: CallView, room: number, k: Ink): Cell[][] {
	return view.extra.slice(0, 2).map(detail => {
		const label = detail.label ? `${detail.label.toLowerCase()}  ` : "";
		return fitCells([...cellsOf(label, { fg: k.dim }), ...cellsOf(detail.value, { fg: k.muted })], room, k);
	});
}

/** Why the call is asked about, a mark then the reason, at most two rows; the approval mode when no reason is given. */
export function reasonRows(card: ApprovalCard, room: number, k: Ink): Cell[][] {
	const reasons = shownReasons(card);
	if (reasons.length === 0) {
		return [
			fitCells([...cellsOf("approval mode  ", { fg: k.dim }), ...cellsOf(card.mode, { fg: k.muted })], room, k),
		];
	}
	return reasons
		.slice(0, 2)
		.map(reason =>
			fitCells(
				[
					REASON_MARK[reason.category](k),
					{ ch: " " },
					...cellsOf(reason.text, { fg: CATEGORY_RISK[reason.category] === "routine" ? k.dim : k.muted }),
				],
				room,
				k,
			),
		);
}
