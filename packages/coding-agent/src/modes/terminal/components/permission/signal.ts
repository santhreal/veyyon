/**
 * Signal: the permission prompt as a console docked above the composer.
 *
 * A hairline draws itself in from the left behind an ember comet, the call decodes into place
 * cell by cell, and the answers sit on one segmented control whose thumb glides between them on
 * a spring, with half-cell precision at its edges. While the prompt waits, the dot beside the
 * title breathes and a faint glint runs the hairline now and then. Answering presses the thumb
 * and folds the console down into the composer.
 *
 * Every frame is a pure function of the ticker's time and the selection, so a frame can be
 * reproduced by fixing both.
 */
import type { Component } from "@veyyon/tui";
import { matchesKey } from "@veyyon/utils/keys";
import { clamp01 } from "@veyyon/utils/math";
import {
	type Animation,
	blendHex,
	easeInOutCubic,
	easeOutCubic,
	easeOutQuint,
	fadeLineTowards,
	MOTION,
	motionClock,
	revealedRows,
} from "@veyyon/utils/motion";
import { truncateToWidth } from "@veyyon/utils/width";
import type { ApprovalCard } from "../../../../extensibility/extensions";
import { matchesSelectCancel } from "../../utils/keybinding-matchers";
import {
	blankCells,
	type CallView,
	type Cell,
	type Choice,
	callView,
	cellsOf,
	choicesFor,
	clockText,
	type Ink,
	initialChoice,
	ink,
	noiseGlyph,
	paintCells,
	placeCells,
	type Risk,
	reasonGlyph,
	riskOf,
	shownReasons,
	subjectCells,
	Ticker,
	wrapCells,
} from "./kit";
import type { PermissionSurfaceContext } from "./surface";

/** Columns between the screen edge and the console's content. */
const MARGIN = 3;
/** Rows of the call itself shown before eliding the rest. */
const SUBJECT_ROWS = 3;

/** When each part of the console arrives, in ms from open. */
const ENTER = {
	header: { at: 120, ms: 320 },
	subject: { at: 240, perCell: 5, settle: 170 },
	reasons: { at: 420, ms: 300 },
	track: { at: 470, ms: 460 },
	thumb: { at: 760, ms: 260 },
	note: { at: 680, ms: 320 },
} as const;

/** How the console folds away once answered. */
const EXIT = { press: 140, fold: 220 } as const;

interface Segment {
	choice: Choice;
	/** Column of the segment's left edge, relative to the control's left edge. */
	x: number;
	width: number;
	/** Column of the label within the segment. */
	labelAt: number;
	showKey: boolean;
}

interface ControlLayout {
	segments: Segment[];
	tracks: { x: number; width: number }[];
	/** Column where the refusal track begins; the thumb turns ember as it crosses into it. */
	denyAt: number;
	width: number;
}

const LAYOUTS = [
	{ keys: true, pad: 3, gap: 2 },
	{ keys: true, pad: 2, gap: 2 },
	{ keys: false, pad: 2, gap: 2 },
	{ keys: false, pad: 1, gap: 1 },
] as const;

function layoutControl(choices: readonly Choice[], room: number): ControlLayout | undefined {
	for (const spec of LAYOUTS) {
		const segments: Segment[] = [];
		const tracks: { x: number; width: number }[] = [];
		let x = 0;
		let trackStart = 0;
		let denyAt = 0;
		for (let i = 0; i < choices.length; i++) {
			const choice = choices[i]!;
			const previous = choices[i - 1];
			if (previous?.allow && !choice.allow) {
				tracks.push({ x: trackStart, width: x - trackStart });
				x += spec.gap;
				trackStart = x;
				denyAt = x;
			}
			const label = spec.keys ? choice.key.length + 2 + choice.name.length : choice.name.length;
			const width = label + spec.pad * 2;
			segments.push({ choice, x, width, labelAt: spec.pad, showKey: spec.keys });
			x += width;
		}
		tracks.push({ x: trackStart, width: x - trackStart });
		if (x <= room) return { segments, tracks, denyAt: denyAt || x, width: x };
	}
	return undefined;
}

export class SignalPrompt implements Component {
	readonly #card: ApprovalCard;
	readonly #ctx: PermissionSurfaceContext;
	readonly #view: CallView;
	readonly #risk: Risk;
	readonly #choices: Choice[];
	readonly #ticker: Ticker;
	#index: number;
	#thumbX: Animation | undefined;
	#thumbW: Animation | undefined;
	#layoutKey = "";
	/** Ticker time the selection last changed, for the note's fade. */
	#selectedAt = 0;
	#answeredAt: number | undefined;
	#exit: { at: number; timer: NodeJS.Timeout } | undefined;

	constructor(card: ApprovalCard, ctx: PermissionSurfaceContext) {
		this.#card = card;
		this.#ctx = ctx;
		this.#view = callView(card);
		this.#risk = riskOf(card);
		this.#choices = choicesFor(card, ctx.options);
		this.#index = initialChoice(this.#choices, this.#risk);
		this.#ticker = new Ticker(ctx.requestRender);
		this.#ticker.start();
		const decode = ENTER.subject.at + Math.min(this.#view.subject.length, 120) * ENTER.subject.perCell;
		this.#ticker.hot(Math.max(1200, decode + ENTER.subject.settle + 100));
	}

	dispose(): void {
		if (!this.#exit) this.#ticker.stop();
	}

	invalidate(): void {}

	beginOverlayExit(requestRender: () => void, done: () => void): boolean {
		if (!this.#ticker.motion) {
			this.#ticker.stop();
			return false;
		}
		this.#answeredAt ??= this.#ticker.elapsed;
		const at = this.#ticker.elapsed;
		const timer = setInterval(() => {
			requestRender();
			if (this.#ticker.elapsed - at >= EXIT.press + EXIT.fold) {
				clearInterval(timer);
				this.#ticker.stop();
				done();
			}
		}, 1000 / 60);
		timer.unref?.();
		this.#exit = { at, timer };
		return true;
	}

	handleInput(data: string): void {
		if (this.#answeredAt !== undefined) return;
		if (matchesSelectCancel(data)) {
			this.#answer(undefined);
			return;
		}
		if (matchesKey(data, "left") || matchesKey(data, "shift+tab") || data === "h") {
			this.#select(this.#index - 1);
			return;
		}
		if (matchesKey(data, "right") || matchesKey(data, "tab") || data === "l") {
			this.#select(this.#index + 1);
			return;
		}
		if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") {
			this.#answer(this.#choices[this.#index]);
			return;
		}
		const keyed = this.#choices.findIndex(c => c.key === data);
		if (keyed >= 0) {
			this.#select(keyed);
			this.#answer(this.#choices[keyed]);
		}
	}

	#select(index: number): void {
		const next = Math.max(0, Math.min(this.#choices.length - 1, index));
		if (next === this.#index) return;
		this.#index = next;
		this.#selectedAt = this.#ticker.elapsed;
		this.#ticker.hot(700);
		this.#ctx.requestRender();
	}

	#answer(choice: Choice | undefined): void {
		this.#answeredAt = this.#ticker.elapsed;
		this.#ticker.hot(EXIT.press + EXIT.fold + 100);
		this.#ctx.settle(choice?.label);
	}

	// ── frame ────────────────────────────────────────────────────────────────────────────────

	render(width: number): readonly string[] {
		const w = Math.max(24, width);
		const k = ink();
		const rows: string[] = [];
		const fadeIn = (line: string, part: { at: number; ms: number }): string => {
			const strength = easeOutCubic(this.#ticker.progress(part.at, part.ms));
			return strength >= 1 ? line : fadeLineTowards(line, k.ground, strength);
		};

		rows.push(fadeIn(paintCells(this.#header(w, k)), ENTER.header));
		rows.push("");
		for (const line of this.#subject(w, k)) rows.push(paintCells(line));
		for (const line of this.#extra(w, k)) rows.push(fadeIn(paintCells(line), ENTER.reasons));
		for (const line of this.#reasons(w, k)) rows.push(fadeIn(paintCells(line), ENTER.reasons));
		rows.push("");
		for (const line of this.#control(w, k)) rows.push(paintCells(line));
		rows.push(fadeIn(paintCells(this.#footer(w, k)), ENTER.note));
		rows.push("");

		const fitted = rows.map(line => truncateToWidth(line, w));
		return this.#exit ? this.#fold(fitted, k) : fitted;
	}

	/** The fold after an answer: the console shrinks into the composer while fading out. */
	#fold(rows: string[], k: Ink): string[] {
		const since = this.#ticker.elapsed - this.#exit!.at;
		const fold = clamp01((since - EXIT.press) / EXIT.fold);
		if (fold <= 0) return rows;
		const keep = revealedRows(rows.length, 1 - easeInOutCubic(fold));
		return rows.slice(rows.length - keep).map(line => fadeLineTowards(line, k.ground, 1 - fold));
	}

	#header(w: number, k: Ink): Cell[] {
		const t = this.#ticker;
		const critical = this.#risk === "critical";
		const row = blankCells(w);
		const breath = t.wave(critical ? 1100 : 2600);
		// A light passes through the title once as it arrives, ember at its core.
		const title = "p e r m i s s i o n";
		const sweep = t.progress(ENTER.header.at + 80, 820);
		const core = easeInOutCubic(sweep) * (title.length + 10) - 5;
		const lit = Array.from(title, (ch, i) => {
			const heat = sweep >= 1 ? 0 : Math.max(0, 1 - Math.abs(i - core) / 4) ** 2;
			return { ch, fg: blendHex(k.bright, k.ember, heat) };
		});
		const left: Cell[] = [
			{ ch: "●", fg: blendHex(k.emberDim, k.ember, breath) },
			...blankCells(2),
			...lit,
			...blankCells(4),
			...cellsOf(this.#card.toolName, { fg: k.text, bold: true }),
			...cellsOf("  ·  ", { fg: k.dim }),
			...cellsOf(this.#view.verb, { fg: k.muted }),
		];
		if (critical) left.push(...blankCells(4), ...cellsOf("▲ destructive", { fg: k.ember }));
		placeCells(row, MARGIN, left);
		const right: Cell[] = [];
		if (this.#card.requester)
			right.push(...cellsOf(`for ${this.#card.requester}`, { fg: k.muted }), ...blankCells(3));
		right.push(...cellsOf("waiting ", { fg: k.dim }), ...cellsOf(clockText(t.elapsed), { fg: k.muted }));
		const rightAt = w - MARGIN - right.length;
		if (rightAt > MARGIN + left.length + 2) placeCells(row, rightAt, right);
		return row;
	}

	/** The call itself, decoding out of noise a cell at a time. */
	#subject(w: number, k: Ink): Cell[][] {
		const t = this.#ticker;
		const view = this.#view;
		const cells = subjectCells(view, k);
		const frame = Math.floor(t.elapsed / 45);
		const { at, perCell, settle } = ENTER.subject;
		for (let i = 0; i < cells.length; i++) {
			const cell = cells[i]!;
			if (cell.ch === " ") continue;
			const start = at + Math.min(i, 120) * perCell;
			const p = t.progress(start, settle);
			if (p >= 1) continue;
			cells[i] = p <= 0 ? { ch: " " } : { ch: noiseGlyph(i, frame), fg: blendHex(k.dim, k.ember, 0.4 * (1 - p)) };
		}
		const lines = wrapCells(cells, Math.max(8, w - MARGIN * 2 - 2), SUBJECT_ROWS, k);
		const prefix = view.shell ? "$" : "›";
		const prompt = easeOutCubic(t.progress(at - 60, 200));
		return lines.map((line, i) => {
			const row = blankCells(w);
			if (i === 0) placeCells(row, MARGIN, [{ ch: prefix, fg: blendHex(k.ground, k.ember, prompt) }]);
			placeCells(row, MARGIN + 2, line);
			return row;
		});
	}

	#extra(w: number, k: Ink): Cell[][] {
		return this.#view.extra.slice(0, 2).map(detail => {
			const row = blankCells(w);
			const label = detail.label ? `${detail.label.toLowerCase()}  ` : "";
			const text = [...cellsOf(label, { fg: k.dim }), ...cellsOf(detail.value, { fg: k.muted })];
			placeCells(row, MARGIN + 2, text.slice(0, w - MARGIN * 2 - 2));
			return row;
		});
	}

	#reasons(w: number, k: Ink): Cell[][] {
		const reasons = shownReasons(this.#card);
		const lines: Cell[][] = [];
		if (reasons.length === 0) {
			const row = blankCells(w);
			placeCells(row, MARGIN + 2, [
				...cellsOf("approval mode  ", { fg: k.dim }),
				...cellsOf(this.#card.mode, { fg: k.muted }),
			]);
			return [row];
		}
		for (const reason of reasons.slice(0, 2)) {
			const row = blankCells(w);
			const text = [
				reasonGlyph(reason, k),
				{ ch: " " },
				...cellsOf(reason.text, { fg: reason.kind === "policy" ? k.dim : k.muted }),
			];
			const room = w - MARGIN * 2 - 2;
			placeCells(row, MARGIN + 2, text.length > room ? [...text.slice(0, room - 1), { ch: "…", fg: k.dim }] : text);
			lines.push(row);
		}
		return lines;
	}

	/** The segmented control: a raised track, labels, and a thumb that glides between them. */
	#control(w: number, k: Ink): Cell[][] {
		const t = this.#ticker;
		const layout = layoutControl(this.#choices, w - MARGIN * 2);
		if (!layout) return this.#stack(w, k);
		const top = blankCells(w);
		const mid = blankCells(w);
		const bottom = blankCells(w);
		const trackHex = blendHex(k.ground, k.text, 0.1);
		const reveal = MARGIN + easeOutQuint(t.progress(ENTER.track.at, ENTER.track.ms)) * layout.width;
		for (const track of layout.tracks) {
			for (let x = track.x; x < track.x + track.width; x++) {
				const at = MARGIN + x;
				if (at >= reveal) continue;
				top[at] = { ch: "▄", fg: trackHex };
				mid[at] = { ch: " ", bg: trackHex };
				bottom[at] = { ch: "▀", fg: trackHex };
			}
		}
		for (const seg of layout.segments) {
			const label: Cell[] = seg.showKey
				? [{ ch: seg.choice.key, fg: k.emberDim }, ...blankCells(2), ...cellsOf(seg.choice.name, { fg: k.muted })]
				: cellsOf(seg.choice.name, { fg: k.muted });
			for (let i = 0; i < label.length; i++) {
				const at = MARGIN + seg.x + seg.labelAt + i;
				if (at >= reveal) continue;
				mid[at] = { ...label[i]!, bg: trackHex };
			}
		}

		const seg = layout.segments[this.#index]!;
		const key = `${w}:${layout.width}`;
		if (!this.#thumbX || !this.#thumbW || key !== this.#layoutKey) {
			this.#thumbX = motionClock.animate(MOTION.move, { from: seg.x, to: seg.x, enabled: t.motion });
			this.#thumbW = motionClock.animate(MOTION.move, { from: seg.width, to: seg.width, enabled: t.motion });
			this.#layoutKey = key;
		} else {
			for (const [anim, to] of [
				[this.#thumbX, seg.x],
				[this.#thumbW, seg.width],
			] as const) {
				anim.retarget(to);
				if (t.motion) motionClock.resume(anim);
				else anim.finish();
			}
		}

		const tx = this.#thumbX.value;
		const tw = this.#thumbW.value;
		const centre = tx + tw / 2;
		const denyMix = clamp01((centre - (layout.denyAt - 6)) / 10);
		let thumbHex = blendHex(k.bright, k.ember, denyMix);
		if (this.#answeredAt !== undefined) {
			const press = clamp01((t.elapsed - this.#answeredAt) / EXIT.press);
			thumbHex = blendHex(thumbHex, denyMix > 0.5 ? k.bright : k.ember, Math.sin(press * Math.PI) * 0.8);
		}
		thumbHex = blendHex(trackHex, thumbHex, easeOutCubic(t.progress(ENTER.thumb.at, ENTER.thumb.ms)));
		const onThumb = k.ground;
		const keyOnThumb = blendHex(k.emberDim, k.ground, Math.max(denyMix, 0.15));

		for (let x = Math.floor(tx); x < Math.ceil(tx + tw); x++) {
			const cover = Math.min(x + 1, tx + tw) - Math.max(x, tx);
			if (cover <= 0.04) continue;
			const at = MARGIN + x;
			if (at < 0 || at >= w) continue;
			const under = mid[at]!;
			const full = cover >= 0.96 || (under.ch !== " " && cover >= 0.5);
			if (full) {
				const isKey = seg.showKey && under.fg === k.emberDim;
				mid[at] = {
					ch: under.ch,
					fg: isKey ? keyOnThumb : onThumb,
					bg: thumbHex,
					bold: under.ch !== " " && !isKey,
				};
				top[at] = { ch: "▄", fg: thumbHex };
				bottom[at] = { ch: "▀", fg: thumbHex };
			} else if (under.ch === " ") {
				mid[at] = { ch: x < tx ? "▐" : "▌", fg: thumbHex, bg: under.bg };
				if (cover >= 0.5) {
					top[at] = { ch: "▄", fg: thumbHex };
					bottom[at] = { ch: "▀", fg: thumbHex };
				}
			}
		}
		return [top, mid, bottom];
	}

	/** The answers as a column, for a terminal too narrow for the control. */
	#stack(w: number, k: Ink): Cell[][] {
		return this.#choices.map((choice, i) => {
			const row = blankCells(w);
			const selected = i === this.#index;
			const label = [{ ch: choice.key, fg: k.emberDim }, ...blankCells(2), ...cellsOf(choice.name, { fg: k.text })];
			if (selected) {
				const fill = choice.allow ? k.bright : k.ember;
				const band = blankCells(w - MARGIN * 2).map(c => ({ ...c, bg: fill }));
				placeCells(row, MARGIN, band);
				placeCells(
					row,
					MARGIN + 1,
					label.map(c => ({ ...c, fg: k.ground, bg: fill, bold: c.ch !== " " })),
				);
			} else placeCells(row, MARGIN + 1, label);
			return row;
		});
	}

	/** The selected answer's consequence, and the keys. */
	#footer(w: number, k: Ink): Cell[] {
		const t = this.#ticker;
		const row = blankCells(w);
		const hints: Cell[] = [
			...cellsOf("←→", { fg: k.text }),
			...cellsOf(" move   ", { fg: k.dim }),
			...cellsOf("⏎", { fg: k.text }),
			...cellsOf(" answer   ", { fg: k.dim }),
			...cellsOf("esc", { fg: k.text }),
			...cellsOf(" deny", { fg: k.dim }),
		];
		const hintsAt = w - MARGIN - hints.length;
		const choice = this.#choices[this.#index];
		const settled = this.#answeredAt !== undefined;
		const noteText = settled ? (choice?.allow ? "approved" : "refused") : (choice?.note ?? "");
		const fade = settled ? 1 : easeOutCubic(clamp01((t.elapsed - this.#selectedAt) / 260));
		const noteHex = settled ? (choice?.allow ? k.bright : k.ember) : blendHex(k.ground, k.muted, fade);
		const room = Math.max(0, hintsAt - MARGIN - 3);
		const note = cellsOf(noteText, { fg: noteHex });
		placeCells(
			row,
			MARGIN,
			note.length > room ? [...note.slice(0, Math.max(0, room - 1)), { ch: "…", fg: k.dim }] : note,
		);
		if (hintsAt > MARGIN + 12) placeCells(row, hintsAt, hints);
		return row;
	}
}
