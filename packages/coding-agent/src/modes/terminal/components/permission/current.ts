/**
 * Current: the permission prompt as a lit card floating in fog.
 *
 * The call takes the whole screen. A field of braille fog drifts across it, thin in the middle
 * and gathering toward the edges, and it glows where it meets the card, so the card reads as the
 * one lit thing in the room. The card's border catches the light along its top edge, brightest
 * at the centre, and a sheen crosses that edge every few seconds. Its colour there is the risk:
 * silver for a routine call, amber for an elevated one, ember for a destructive one.
 *
 * Inside, the call sits above a hairline and the answers below it. The command is laid out the
 * way it runs, one stage of a pipeline or one command of a chain a line, on a dotted rail that a
 * pulse of light runs down. The answers are a tight list with their keys at the right edge. The
 * selected one sits on a band of half-tone light, dense at its left edge and thinning to the
 * right, that glides between answers a quarter of a row at a time and turns red over a refusal.
 * What the selected answer does is written under the list.
 *
 * Allowing flares the band before the card and the fog fade; refusing fades them at once.
 *
 * Every frame is a function of the ticker's time, the selection and the answer, so fixing those
 * reproduces it.
 */
import { clamp01 } from "@veyyon/utils/math";
import { blendHex, easeInOutCubic, easeOutCubic } from "@veyyon/utils/motion";
import type { ApprovalCard } from "../../../../extensibility/extensions";
import { DotCanvas, fbm3, hash2, scale, smoothstep, stepOf } from "./ascii";
import {
	blankCells,
	type Cell,
	type ChoiceId,
	cellsOf,
	clockText,
	detailRows,
	fitCells,
	Glide,
	type Ink,
	leadCells,
	PermissionPrompt,
	paintCells,
	reasonRows,
	shellTokens,
	shownReasons,
	subjectCells,
	type TokenRole,
	wrapCells,
} from "./kit";
import type { PermissionSurfaceContext } from "./surface";

/** Widest the card grows, in cells. */
const CARD = 76;
/** Most rows the command takes before the rest is counted. */
const COMMAND_ROWS = 8;
/** How the prompt arrives, in ms from open. */
const ENTER = {
	fog: 900,
	borderAt: 80,
	border: 620,
	rowsAt: 220,
	perRow: 22,
	rowFade: 260,
	bandAt: 520,
	band: 320,
} as const;
const EXIT_MS = 560;
/** The sheen's period, and how long of it the sheen spends crossing the top edge. */
const SHEEN = { period: 5200, cross: 1500 } as const;
/** The rail pulse's period, and how long of it the pulse spends running down the command. */
const PULSE = { period: 2600, run: 1300 } as const;
/** Operators that start a new line of the command. */
const BREAKS: Record<string, true> = { "|": true, "||": true, "&&": true, ";": true, "|&": true };

/** Each answer's name; `scope` is what a session answer covers, `secret` whether it is a secret prompt. */
const ANSWER_NAME: Record<ChoiceId, (scope: string, secret: boolean) => string> = {
	once: () => "Allow once",
	pattern: () => "Allow this pattern",
	session: (scope, secret) => (secret ? `Allow ${scope} this session` : `Allow all ${scope}`),
	deny: () => "Deny",
	never: (scope, secret) => (secret ? `Deny ${scope} this session` : `Deny all ${scope}`),
};

/** Command syntax in the card's cool register: the accent is kept for risk. */
const SYNTAX: Record<TokenRole, (k: Ink) => string> = {
	program: k => k.bright,
	flag: k => blendHex(k.muted, k.text, 0.35),
	path: k => k.text,
	string: k => blendHex(k.ok, k.text, 0.45),
	variable: k => blendHex(k.warn, k.text, 0.4),
	operator: k => k.dim,
	word: k => k.text,
	space: k => k.text,
};

type RowKind = "plain" | "command" | "divider" | "answer";

interface Row {
	cells: Cell[];
	/** Column of the first cell, relative to the card's content column. */
	x: number;
	kind: RowKind;
}

interface Layout {
	rows: Row[];
	/** Row of each answer. */
	answers: number[];
	/** Column after each answer's name, relative to the content column. */
	nameEnds: number[];
	/** Row of the selected answer's note. */
	note: number;
}

/** A rectangle of cells, right and bottom exclusive. */
interface Rect {
	left: number;
	top: number;
	right: number;
	bottom: number;
}

export class CurrentPrompt extends PermissionPrompt {
	readonly #heat: Glide;
	readonly #band: Glide;

	constructor(card: ApprovalCard, ctx: PermissionSurfaceContext) {
		super(card, ctx, { ambientFps: 20, enterMs: 1400, exitMs: EXIT_MS });
		this.#heat = new Glide(this.ticker.motion);
		this.#band = new Glide(this.ticker.motion);
	}

	frame(width: number, k: Ink): string[] {
		const height = Math.max(1, this.screenRows);
		const t = this.ticker;
		const cardWidth = Math.max(8, Math.min(CARD, width - (width < 60 ? 2 : 8)));
		const pad = cardWidth < 50 ? 2 : 3;
		const inner = Math.max(1, cardWidth - 2 - pad * 2);
		const layout = this.#layout(inner, height, k);
		// The card is its rows plus a blank row inside each border; the hints sit a row under it.
		const cardHeight = layout.rows.length + 4;
		const cardTop = Math.max(0, Math.floor((height - cardHeight - 2) * 0.45));
		const cardLeft = Math.floor((width - cardWidth) / 2);
		const contentLeft = cardLeft + 1 + pad;
		const contentTop = cardTop + 2;

		const leaving = this.leaving;
		const allowed = this.answer?.allow ?? false;
		const gone = leaving === 0 ? 0 : allowed ? smoothstep(0.25, 1, leaving) : smoothstep(0, 0.65, leaving);
		const screen = Array.from({ length: height }, () => blankCells(width));

		// Text first: the selection and the fog fill only the cells it leaves blank.
		for (const [i, row] of layout.rows.entries()) {
			const y = contentTop + i;
			if (y >= height || row.cells.length === 0 || row.kind === "divider") continue;
			const shown = easeOutCubic(t.progress(ENTER.rowsAt + i * ENTER.perRow, ENTER.rowFade));
			// On an allow the chosen answer is the last thing to go.
			const fade = allowed && i === layout.answers[this.index] ? smoothstep(0.5, 1, leaving) : gone;
			place(screen[y]!, contentLeft + row.x, row.cells, shown * (1 - fade), k);
		}
		const since = this.selectedAt > 0 ? clamp01((t.elapsed - this.selectedAt) / 240) : 1;
		const noteY = contentTop + layout.note;
		if (noteY < height) {
			const note = fitCells(cellsOf(this.selected.note, { fg: k.muted }), inner - 2, k);
			const noteShown = easeOutCubic(since) * easeOutCubic(t.progress(ENTER.bandAt, ENTER.band)) * (1 - gone);
			place(screen[noteY]!, contentLeft + 2, note, noteShown, k);
		}

		const rail = layout.rows.flatMap((row, i) => (row.kind === "command" ? [contentTop + i] : []));
		this.#rail(screen, contentLeft, rail, gone, k);
		const answerY = contentTop + layout.answers[this.index]!;
		this.#selection(
			screen,
			contentLeft,
			contentLeft + layout.nameEnds[this.index]!,
			contentLeft + inner - 1,
			answerY,
			leaving,
			allowed,
			gone,
			k,
		);
		const divider = layout.rows.findIndex(row => row.kind === "divider");
		this.#border(screen, cardLeft, cardTop, cardWidth, cardHeight, contentTop + divider, gone, k);

		const hintY = cardTop + cardHeight + 1;
		const hints = hintCells(k);
		const hintX = Math.floor((width - hints.length) / 2);
		if (hintY < height && width >= hints.length) {
			const shown = easeOutCubic(t.progress(ENTER.bandAt + 120, 400)) * (1 - gone);
			place(screen[hintY]!, hintX, hints, shown, k);
		}

		const card = { left: cardLeft, top: cardTop, right: cardLeft + cardWidth, bottom: cardTop + cardHeight };
		const hint = { left: hintX, top: hintY, right: hintX + hints.length, bottom: hintY + 1 };
		this.#fog(screen, card, hint, leaving, k);
		return screen.map(paintCells);
	}

	/**
	 * The fog: braille stipple over every blank cell outside the card. Its density is a drifting
	 * noise, gathered into clumps toward the screen's edges and thinned toward its middle, cleared
	 * a couple of cells around the card and the hints, and drawn into a glow right against the
	 * card. The field is sampled at cell corners and blended across each cell's eight dots, and
	 * each dot has its own fixed threshold, so the fog reads as grain rather than a grid.
	 */
	#fog(screen: Cell[][], card: Rect, hint: Rect, leaving: number, k: Ink): void {
		const height = screen.length;
		const width = screen[0]?.length ?? 0;
		const appear = easeInOutCubic(this.ticker.progress(0, ENTER.fog)) * (1 - smoothstep(0, 0.85, leaving));
		if (appear <= 0 || width === 0) return;
		const flow = this.flow;
		const stride = width + 1;
		const cover = new Float32Array(stride * (height + 1));
		const light = new Float32Array(stride * (height + 1));
		const glows = new Float32Array(stride * (height + 1));
		const away = (rect: Rect, x: number, y: number): number =>
			Math.hypot(Math.max(rect.left - x, 0, x - rect.right), Math.max(rect.top - y, 0, y - rect.bottom) * 2.1);
		for (let y = 0; y <= height; y++) {
			for (let x = 0; x <= width; x++) {
				const fromCard = away(card, x, y);
				const d = Math.min(fromCard, away(hint, x, y));
				const n = fbm3(x * 0.05 + flow * 0.06, y * 0.12, flow * 0.05) * 0.5 + 0.5;
				const r = Math.hypot((x - width / 2) / (width / 2), (y - height / 2) / (height / 2));
				const edge = smoothstep(0.35, 1.15, r);
				const clump = smoothstep(0.42, 0.8, n);
				const glow = Math.exp(-fromCard / 3);
				const at = y * stride + x;
				cover[at] =
					appear * smoothstep(0.6, 2.2, d) * Math.min(0.5, 0.5 * edge * clump + 0.3 * glow * (0.4 + 0.6 * n));
				light[at] = clamp01(0.1 + 0.7 * glow + 0.25 * clump * edge);
				glows[at] = glow;
			}
		}
		const canvas = new DotCanvas(width, height);
		for (let y = 0; y < height; y++) {
			const row = screen[y]!;
			for (let x = 0; x < width; x++) {
				if (row[x]!.ch !== " " || row[x - 1]?.ch.trim() || row[x + 1]?.ch.trim()) continue;
				const a = y * stride + x;
				const c = a + stride;
				for (let j = 0; j < 4; j++) {
					const fy = (j + 0.5) / 4;
					for (let i = 0; i < 2; i++) {
						const fx = (i + 0.5) / 2;
						const v =
							(cover[a]! * (1 - fx) + cover[a + 1]! * fx) * (1 - fy) +
							(cover[c]! * (1 - fx) + cover[c + 1]! * fx) * fy;
						const px = x * 2 + i;
						const py = y * 4 + j;
						if (v <= hash2(px, py)) continue;
						canvas.plot(px, py, (light[a]! + light[a + 1]! + light[c]! + light[c + 1]!) / 4);
					}
				}
			}
		}
		const tint = this.risk === "critical" ? k.ember : this.risk === "elevated" ? k.warn : undefined;
		const shades = scale(blendHex(k.ground, k.dim, 0.45), blendHex(k.muted, k.text, 0.35), 6);
		for (let y = 0; y < height; y++) {
			const row = screen[y]!;
			for (let x = 0; x < width; x++) {
				const ch = canvas.glyph(x, y);
				if (ch === " ") continue;
				let hex = stepOf(shades, canvas.level(x, y));
				// A risky call warms the glow nearest the card, in steps so the row paints as runs.
				if (tint) hex = blendHex(hex, tint, Math.round(glows[y * stride + x]! * 3) * 0.14);
				row[x] = { ch, fg: hex };
			}
		}
	}

	/**
	 * The card's border, rounded, with a divider across it at `dividerY`. It draws itself out
	 * from the top centre both ways on open. Light falls on the top edge, brightest at its centre
	 * and tinted by the risk, and a sheen crosses it every few seconds; the sides dim downward.
	 */
	#border(
		screen: Cell[][],
		left: number,
		top: number,
		width: number,
		height: number,
		dividerY: number,
		gone: number,
		k: Ink,
	): void {
		const t = this.ticker;
		const draw = easeInOutCubic(t.progress(ENTER.borderAt, ENTER.border));
		if (draw <= 0 || gone >= 1) return;
		const right = left + width - 1;
		const bottom = top + height - 1;
		const centre = left + (width - 1) / 2;
		const half = Math.max(1, (width - 1) / 2);
		// Path length from the top centre around either side to the bottom centre.
		const reach = half + (height - 1) + half;
		const phase = t.motion ? t.elapsed % SHEEN.period : SHEEN.period;
		const sheenX = left - 8 + (phase / SHEEN.cross) * (width + 16);
		const accent = this.risk === "critical" ? k.ember : this.risk === "elevated" ? k.warn : k.bright;
		const shades = scale(blendHex(k.hairline, k.dim, 0.3), k.bright, 8);

		const put = (x: number, y: number, ch: string, along: number, light: number): void => {
			if (y < 0 || y >= screen.length || x < 0 || x >= screen[0]!.length || along / reach > draw) return;
			const level = clamp01(light) * (1 - gone);
			const lit = smoothstep(0.55, 1, light);
			screen[y]![x] = { ch, fg: blendHex(stepOf(shades, level), accent, Math.round(lit * 3) * 0.2 * (1 - gone)) };
		};

		for (let x = left; x <= right; x++) {
			const u = Math.abs(x - centre) / half;
			const sheen = phase < SHEEN.cross ? 0.55 * Math.exp(-(((x - sheenX) / 5) ** 2)) : 0;
			const ch = x === left ? "╭" : x === right ? "╮" : "─";
			put(x, top, ch, Math.abs(x - centre), 0.28 + 0.62 * (1 - u) ** 2 + sheen);
			put(
				x,
				bottom,
				x === left ? "╰" : x === right ? "╯" : "─",
				half + height - 1 + (half - Math.abs(x - centre)),
				0.16,
			);
		}
		for (let y = top + 1; y < bottom; y++) {
			const v = (y - top) / Math.max(1, height - 1);
			const light = 0.16 + 0.3 * (1 - v) ** 2;
			const along = half + (y - top);
			const divide = y === dividerY;
			put(left, y, divide ? "├" : "│", along, light);
			put(right, y, divide ? "┤" : "│", along, light);
			if (divide) for (let x = left + 1; x < right; x++) put(x, y, "─", along, 0.1);
		}
	}

	/**
	 * The rail beside the command: a dotted line down its rows, and a pulse of light that runs
	 * down it every few seconds, as the data runs through the pipeline.
	 */
	#rail(screen: Cell[][], x: number, rows: readonly number[], gone: number, k: Ink): void {
		if (rows.length === 0 || gone >= 1) return;
		const t = this.ticker;
		const shown = easeOutCubic(t.progress(ENTER.rowsAt, ENTER.rowFade + 200)) * (1 - gone);
		const phase = t.motion ? t.elapsed % PULSE.period : PULSE.period;
		const at = phase < PULSE.run ? (phase / PULSE.run) * (rows.length + 1) - 0.5 : Number.NEGATIVE_INFINITY;
		const shades = scale(k.ground, k.bright, 6);
		for (const [i, y] of rows.entries()) {
			if (y >= screen.length || x < 0 || x >= screen[0]!.length) continue;
			const pulse = Math.exp(-(((i - at) / 0.8) ** 2));
			const level = (0.3 + 0.7 * pulse) * shown;
			screen[y]![x] = { ch: "⡇", fg: stepOf(shades, level) };
		}
	}

	/**
	 * The selection: a bar of dots at the content's left edge that glides between answers a
	 * quarter of a row at a time, and a dotted leader from the selected answer's name to its key
	 * that draws itself out on each move, brightest by the name, with a bead of light running
	 * along it toward the key. Both turn red over a refusal and flare on an allow.
	 */
	#selection(
		screen: Cell[][],
		left: number,
		nameEnd: number,
		keyX: number,
		row: number,
		leaving: number,
		allowed: boolean,
		gone: number,
		k: Ink,
	): void {
		const t = this.ticker;
		const appear = easeOutCubic(t.progress(ENTER.bandAt, ENTER.band));
		if (appear <= 0 || gone >= 1) return;
		const height = screen.length;
		const width = screen[0]?.length ?? 0;
		const heat = this.#heat.toward(this.selected.allow ? 0 : 1);
		const flare = allowed && leaving > 0 ? Math.sin(Math.PI * Math.min(1, leaving / 0.45)) : 0;
		const lit = blendHex(k.bright, blendHex(k.err, k.text, 0.2), heat);
		const shades = scale(k.ground, lit, 6);
		const fade = appear * (1 - gone);

		const top = Math.round(this.#band.toward(row * 4));
		const bar = new DotCanvas(width, height);
		for (let y = top; y < top + 4; y++) bar.plot(left * 2 + 1, y, 1);
		for (let y = Math.max(0, top >> 2); y <= Math.min(height - 1, (top + 3) >> 2); y++) {
			const ch = bar.glyph(left, y);
			if (ch !== " " && left >= 0 && left < width) screen[y]![left] = { ch, fg: stepOf(shades, fade) };
		}

		const start = nameEnd + 1;
		const length = keyX - 1 - start;
		if (row >= height || length < 2) return;
		const grow = this.selectedAt > 0 ? easeOutCubic(clamp01((t.elapsed - this.selectedAt) / 320)) : 1;
		const drawn = Math.round(length * grow * appear);
		const bead = ((this.flow * 0.55) % 1.5) * length;
		const cells = screen[row]!;
		for (let i = 0; i < drawn; i++) {
			const x = start + i;
			if (x < 0 || x >= width || cells[x]!.ch !== " ") continue;
			const u = i / (length - 1);
			const light = 0.14 + 0.5 * (1 - u) ** 1.4 + 0.45 * Math.exp(-(((i - bead) / 2.5) ** 2)) + 0.6 * flare;
			cells[x] = { ch: "⠒", fg: stepOf(shades, clamp01(light) * fade) };
		}
	}

	/** The command, one stage of a pipeline or one command of a chain a line, each after its operator. */
	#command(room: number, budget: number, k: Ink): Cell[][] {
		const view = this.view;
		if (!view.shell) return wrapCells(subjectCells(view, k), room, budget, k);
		const segments: { op: string | undefined; cells: Cell[] }[] = [{ op: undefined, cells: [] }];
		for (const token of shellTokens(view.subject)) {
			if (token.role === "operator" && Object.hasOwn(BREAKS, token.text)) {
				segments.push({ op: token.text, cells: [] });
				continue;
			}
			const segment = segments[segments.length - 1]!;
			if (token.role === "space" && segment.cells.length === 0) continue;
			segment.cells.push(...cellsOf(token.text, { fg: SYNTAX[token.role](k), bold: token.role === "program" }));
		}
		const lines: Cell[][] = [];
		for (const { op, cells } of segments) {
			while (cells.length > 0 && cells[cells.length - 1]!.ch === " ") cells.pop();
			if (cells.length === 0 && op === undefined) continue;
			const prefix = cellsOf(op === undefined ? "   " : `${op.padStart(2)} `, { fg: k.dim });
			for (const [i, line] of wrapCells(cells, room - 3, budget, k).entries()) {
				lines.push([...(i === 0 ? prefix : blankCells(3)), ...line]);
			}
		}
		if (lines.length > budget) {
			const cut = lines.length - budget + 1;
			lines.length = Math.max(0, budget - 1);
			lines.push(cellsOf(`   … ${cut} more line${cut === 1 ? "" : "s"}`, { fg: k.dim }));
		}
		return lines;
	}

	#layout(inner: number, height: number, k: Ink): Layout {
		const rows: Row[] = [];
		const push = (cells: Cell[], x = 0, kind: RowKind = "plain"): void => {
			rows.push({ cells: fitCells(cells, inner - x, k), x, kind });
		};

		const quiet = [
			...detailRows(this.view, inner - 2, k),
			...(shownReasons(this.card).length > 0 ? reasonRows(this.card, inner - 2, k) : []),
		];
		const groups = this.choices.findIndex(c => !c.allow) > 0 ? 1 : 0;
		// Header, blank, blank, divider, blank, the list, blank, note; the card's border and inner
		// blank rows, the hints and a margin.
		const fixed = 8 + this.choices.length + groups + (quiet.length > 0 ? quiet.length + 1 : 0) + 4 + 4;
		const budget = Math.max(1, Math.min(COMMAND_ROWS, height - fixed));

		const clock = cellsOf(clockText(this.ticker.elapsed), { fg: k.dim });
		const label =
			this.risk === "critical"
				? cellsOf("destructive  ", { fg: k.ember })
				: this.risk === "elevated"
					? cellsOf("elevated  ", { fg: k.warn })
					: [];
		const tail = [...label, ...clock];
		const lead = fitCells(leadCells(this.card, this.view, k), Math.max(0, inner - tail.length - 2), k);
		push([...lead, ...blankCells(inner - lead.length - tail.length), ...tail]);
		push([]);

		for (const line of this.#command(inner - 2, budget, k)) push(line, 2, "command");
		if (quiet.length > 0) {
			push([]);
			for (const line of quiet) push(line, 5);
		}
		push([]);
		push([], 0, "divider");
		push([]);

		const answers: number[] = [];
		const nameEnds: number[] = [];
		for (const [i, choice] of this.choices.entries()) {
			if (i > 0 && this.choices[i - 1]!.allow && !choice.allow) push([]);
			answers.push(rows.length);
			const selected = i === this.index;
			const name = cellsOf(ANSWER_NAME[choice.id](choice.scope, this.card.category === "secret"), {
				fg: selected ? k.bright : k.muted,
				bold: selected,
			});
			const key = { ch: choice.key, fg: selected ? k.text : k.dim, bold: selected };
			const room = inner - 2;
			const fitted = fitCells(name, Math.max(0, room - 3), k);
			nameEnds.push(2 + fitted.length);
			push([...fitted, ...blankCells(room - fitted.length - 1), key], 2, "answer");
		}
		push([]);
		const note = rows.length;
		push([]);

		return { rows, answers, nameEnds, note };
	}
}

/** `↑↓ choose   ⏎ answer   esc deny`, keys lifted over their actions. */
function hintCells(k: Ink): Cell[] {
	return [
		...cellsOf("↑↓", { fg: k.muted }),
		...cellsOf(" choose   ", { fg: k.dim }),
		...cellsOf("⏎", { fg: k.muted }),
		...cellsOf(" answer   ", { fg: k.dim }),
		...cellsOf("esc", { fg: k.muted }),
		...cellsOf(" deny", { fg: k.dim }),
	];
}

/** `cells` written into `row` from `at`, faded from the ground by `alpha`. */
function place(row: Cell[], at: number, cells: readonly Cell[], alpha: number, k: Ink): void {
	if (alpha <= 0) return;
	for (let j = 0; j < cells.length; j++) {
		const cell = cells[j]!;
		const x = at + j;
		if (cell.ch === " " || x < 0 || x >= row.length) continue;
		const hex = cell.fg ?? k.text;
		row[x] = { ...cell, fg: alpha < 1 ? blendHex(k.ground, hex, alpha) : hex };
	}
}
