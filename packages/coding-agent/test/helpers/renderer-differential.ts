/**
 * ONE owner for differential renderer checks.
 *
 * A differential check needs no authored expectation: a cold mount at a given state is one full
 * paint with nothing carried over, so it is ground truth for that state, and reaching the same
 * state incrementally must land on the same screen. Three suites use that idea, and before this
 * module they each carried their own copy of the wheel escape sequences, the transcript row
 * spelling, the grid comparison and the composer-chrome count. Four copies of a row spelling is
 * four chances for warm and cold to differ on content rather than on rendering, which reads as a
 * renderer defect and is not one.
 *
 * Everything here is shared by
 * `an-incremental-paint-agrees-with-a-cold-mount`,
 * `scrolling-back-and-returning-leaves-the-frame-unchanged` and
 * `output-that-streams-in-while-scrolled-back-leaves-the-view-alone`.
 */

import { ThinkingLevel } from "@veyyon/agent-core";
import type { Component, OverlayHandle } from "@veyyon/tui";
import { stripAnsi } from "@veyyon/utils/strip-ansi";
import { WHEEL_DOWN, WHEEL_UP } from "../../../tui/test/helpers/sgr-mouse";
import type { ComposerAccentState } from "../../src/modes/components/composer-chrome";
import { isComposerPromptLine, isHairlineLine } from "../../src/modes/components/composer-defect-oracle";
import { runComposerOracleScenario } from "./composer-oracle-runner";

// The wheel reports themselves are a TUI-level fact, owned by the tui package's test helpers and
// re-exported here so a differential suite has one import rather than two.
export { WHEEL_DOWN, WHEEL_UP } from "../../../tui/test/helpers/sgr-mouse";

/**
 * Upper bound on notches needed to walk back to the tail. Far more than any case needs; a loop
 * stops as soon as the view resumes following, and the bound only keeps a defect from hanging
 * instead of failing.
 */
export const MAX_RETURN_NOTCHES = 200;

/**
 * What transcript rows are made of.
 *
 * Content is a pure function of the row index so a cold mount can reproduce byte-for-byte what an
 * incremental run appended. The non-plain flavours exist because column accounting is where a
 * renderer breaks: a wide glyph occupies two cells, a combining mark occupies none, an astral pair
 * is one glyph in two code units, an SGR run carries bytes that take no width at all, and a long
 * row has to wrap.
 */
export type Flavor = "plain" | "wide" | "combining" | "astral" | "ansi" | "wrapping";

/** Every flavour, for a sweep that enumerates rather than samples. */
export const FLAVORS: readonly Flavor[] = ["plain", "wide", "combining", "astral", "ansi", "wrapping"];

/** One transcript row of the given flavour. Deterministic in `index`. */
export function contentLine(flavor: Flavor, index: number): string {
	const n = String(index).padStart(4, "0");
	switch (flavor) {
		case "plain":
			return `transcript-output-line-${n}`;
		case "wide":
			// Two cells per glyph, so a width budget that counts code points overruns the row.
			return `行${n}　全角文字の行が続く`;
		case "combining":
			// Marks add no width; counting code points over-measures instead.
			return `line-${n} e\u0301a\u0300o\u0308u\u030a combining`;
		case "astral":
			// One glyph, two UTF-16 code units, two cells wide.
			return `line-${n} \u{1F389}\u{1F680}\u{1F9EA} astral`;
		case "ansi":
			// Colour bytes take no columns. A width computed on the raw string is far too large.
			return `\x1b[31mline-${n}\x1b[0m \x1b[1;34mcoloured\x1b[0m tail`;
		case "wrapping":
			// Longer than any width swept here, so the row must wrap.
			return `line-${n} ${"wrap".repeat(40)}`;
	}
}

/** `count` transcript rows of one flavour, starting at row 0. */
export function contentLines(flavor: Flavor, count: number): string[] {
	return Array.from({ length: count }, (_v, i) => contentLine(flavor, i));
}

/**
 * One driven step.
 *
 * `overlay-open`/`overlay-close` and `scroll`/`return` are TRANSIENT: a sequence that closes every
 * overlay it opened and walks back to the live tail ends in a state a cold mount can reproduce, so
 * it stays comparable. A sequence that leaves an overlay up, or leaves the view frozen, has no cold
 * equivalent and must be judged by an absolute invariant instead. `balanced` says which it is.
 */
export type Op =
	| { kind: "append"; count: number }
	| { kind: "shrink"; count: number }
	| { kind: "resize"; width: number; height: number }
	| { kind: "editor"; text: string }
	| { kind: "overlay-open"; rows: number; fullscreen?: boolean }
	| { kind: "overlay-close" }
	| { kind: "scroll"; notches: number }
	| { kind: "return" };

/**
 * True when `ops` ends where a cold mount can meet it: every overlay closed, and the view back on
 * the live tail. A suite comparing against `paintCold` must only drive balanced sequences.
 */
export function balanced(ops: readonly Op[]): boolean {
	let open = 0;
	let frozen = false;
	for (const op of ops) {
		if (op.kind === "overlay-open") open += 1;
		else if (op.kind === "overlay-close") open = Math.max(0, open - 1);
		else if (op.kind === "scroll") frozen = true;
		else if (op.kind === "return") frozen = false;
	}
	return open === 0 && !frozen;
}

/**
 * An overlay with a fixed row count and recognisable content.
 *
 * The engine treats a visible overlay as a reason to abandon a frozen scroll view and resume the
 * live tail, and a `fullscreen` overlay borrows the alternate screen, where the engine paints only
 * the modal and emits no scrollback bytes. Neither path had a driver before this component existed.
 */
export class OverlayMock implements Component {
	constructor(readonly rows: number) {}

	invalidate(): void {}

	render(width: number): string[] {
		return Array.from({ length: this.rows }, (_v, i) => `[overlay-row-${i}]`.slice(0, Math.max(1, width)));
	}
}

/** A row of overlay content, for a suite asserting an overlay is or is not on screen. */
export const OVERLAY_MARK = "[overlay-row-";

/** Everything a cold mount needs to reproduce a state reached incrementally. */
export interface State {
	width: number;
	height: number;
	lines: number;
	editor: string;
	flavor: Flavor;
	/** Composer accent state, which changes the chrome's colours and gutter. */
	modeState?: Partial<ComposerAccentState>;
	/** A status row above the composer, when the scenario carries one. */
	statusMessage?: string;
}

/** What a settled scenario is judged on. */
export interface Painted {
	grid: readonly string[];
	composed: number;
	end: State;
}

/** Whether each step gets its own frame, or a batch coalesces into one. */
export type Timing = "per-step" | "coalesced";

/** Both timings, for a sweep that drives each. */
export const TIMINGS: readonly Timing[] = ["per-step", "coalesced"];

/**
 * Scroll isolation off and on. On is the production default and hands the wheel to the virtual
 * scroll tape; off leaves scrolling to the terminal's own scrollback.
 */
export const ISOLATION: readonly boolean[] = [false, true];

/** One line of composer text. */
export const EDITOR_ONE = "run the build";
/** Two lines, so the composer is one row taller. */
export const EDITOR_TWO = "run the build\nthen ship it";
/** Five lines, enough to reshape the frame under a short terminal. */
export const EDITOR_FIVE = "one\ntwo\nthree\nfour\nfive";
/** One logical line far wider than any swept terminal, so the composer wraps it. */
export const EDITOR_WRAPPING = `explain ${"this-identifier-is-long ".repeat(12)}please`;
/** Wide and combining glyphs in the composer, where the caret column is also at stake. */
export const EDITOR_WIDE = "実行して　ください é\u0301 \u{1F680}";

/** Mount a scenario at `state`. */
async function mount(state: State, scrollIsolation: boolean) {
	return await runComposerOracleScenario({
		width: state.width,
		height: state.height,
		transcriptLines: contentLines(state.flavor, state.lines),
		editorText: state.editor,
		modeState: state.modeState,
		statusMessage: state.statusMessage,
		scrollIsolation,
		focused: true,
	});
}

/**
 * Drive `ops` from `start`.
 *
 * `per-step` settles after each op, exercising the per-frame differential emitters one transition
 * at a time. `coalesced` applies every op and settles once, letting the throttle merge them into a
 * single frame that is both reflowed and longer.
 */
export async function paintIncrementally(
	start: State,
	ops: readonly Op[],
	timing: Timing,
	scrollIsolation: boolean,
): Promise<Painted> {
	const scenario = await mount(start, scrollIsolation);
	const state: State = { ...start };
	const overlays: OverlayHandle[] = [];
	try {
		for (const op of ops) {
			if (op.kind === "append") {
				for (let i = 0; i < op.count; i += 1) {
					scenario.transcript.lines.push(contentLine(state.flavor, state.lines + i));
				}
				state.lines += op.count;
				scenario.transcript.invalidate();
			} else if (op.kind === "shrink") {
				const removed = Math.min(op.count, state.lines);
				scenario.transcript.lines.length = state.lines - removed;
				state.lines -= removed;
				scenario.transcript.invalidate();
			} else if (op.kind === "editor") {
				state.editor = op.text;
				scenario.editor.setText(op.text);
			} else if (op.kind === "resize") {
				state.width = op.width;
				state.height = op.height;
				scenario.terminal.resize(state.width, state.height);
			} else if (op.kind === "overlay-open") {
				overlays.push(
					scenario.tui.showOverlay(new OverlayMock(op.rows), {
						fullscreen: op.fullscreen ?? false,
					}),
				);
			} else if (op.kind === "overlay-close") {
				overlays.pop()?.hide();
				scenario.tui.requestRender();
			} else if (op.kind === "scroll") {
				// A wheel notch is only honoured once the frame it acts on has landed, so each
				// notch settles even under `coalesced`: coalescing INPUT would test the terminal's
				// input buffer, not the renderer.
				for (let i = 0; i < op.notches; i += 1) {
					scenario.terminal.sendInput(WHEEL_UP);
					await scenario.advance();
				}
			} else {
				for (let i = 0; i < MAX_RETURN_NOTCHES && scenario.tui.virtualScrollActive; i += 1) {
					scenario.terminal.sendInput(WHEEL_DOWN);
					await scenario.advance();
				}
			}
			if (timing === "per-step") await scenario.advance();
		}
		if (timing === "coalesced") await scenario.advance();
		return {
			grid: scenario.terminal.getViewport().slice(),
			composed: scenario.tui.composedFrameRows,
			end: state,
		};
	} finally {
		scenario.cleanUp();
	}
}

/** Mount `state` cold: one full paint, nothing carried over. */
export async function paintCold(state: State, scrollIsolation: boolean): Promise<Painted> {
	const scenario = await mount(state, scrollIsolation);
	try {
		return {
			grid: scenario.terminal.getViewport().slice(),
			composed: scenario.tui.composedFrameRows,
			end: state,
		};
	} finally {
		scenario.cleanUp();
	}
}

/** Name a sequence by its steps, so a failure says which one diverged. */
export function describeOps(ops: readonly Op[]): string {
	return ops
		.map(op => {
			if (op.kind === "append") return `+${op.count}`;
			if (op.kind === "shrink") return `-${op.count}`;
			if (op.kind === "resize") return `${op.width}x${op.height}`;
			if (op.kind === "overlay-open") return `overlay${op.rows}${op.fullscreen ? "-full" : ""}`;
			if (op.kind === "overlay-close") return "overlay-close";
			if (op.kind === "scroll") return `up${op.notches}`;
			if (op.kind === "return") return "tail";
			return `editor:${op.text.split("\n").length}`;
		})
		.join(" ");
}

/** Name a state, so a failure says which one diverged. */
export function describeState(state: State): string {
	const mode = state.modeState ? Object.keys(state.modeState).join("+") : "plain-mode";
	return `${state.width}x${state.height}/${state.lines}/${state.flavor}/ed${state.editor.split("\n").length}/${mode}`;
}

/** Append to `into` a line per row on which two grids disagree. */
export function compareGrids(
	into: string[],
	label: string,
	leftName: string,
	left: readonly string[],
	rightName: string,
	right: readonly string[],
): void {
	for (let row = 0; row < Math.max(left.length, right.length); row += 1) {
		const a = left[row] ?? "<missing row>";
		const b = right[row] ?? "<missing row>";
		if (a !== b) {
			into.push(`${label}: row ${row} ${leftName}=${JSON.stringify(a)} ${rightName}=${JSON.stringify(b)}`);
		}
	}
}

/** Compare two paints, reporting composed-row disagreement before row content. */
export function disagreements(label: string, warm: Painted, cold: Painted): string[] {
	if (warm.composed !== cold.composed) {
		return [`${label}: composedFrameRows incremental=${warm.composed} cold=${cold.composed}`];
	}
	const found: string[] = [];
	compareGrids(found, label, "incremental", warm.grid, "cold", cold.grid);
	return found;
}

/**
 * Count composer chrome on screen.
 *
 * Counts, never presence: a duplicate is two of a row that must appear once, and `some(...)` is
 * true whether a row was repainted in place or drawn again below itself.
 */
export function countChrome(rows: readonly string[]): { hairlines: number; prompts: number } {
	let hairlines = 0;
	let prompts = 0;
	for (const row of rows) {
		const bare = stripAnsi(row);
		if (isHairlineLine(bare)) hairlines += 1;
		if (isComposerPromptLine(bare)) prompts += 1;
	}
	return { hairlines, prompts };
}

/** Composer accent states worth sweeping, each changing the chrome's colours or gutter. */
export const MODE_STATES: readonly (Partial<ComposerAccentState> | undefined)[] = [
	undefined,
	{ bashMode: true },
	{ planMode: true },
	{ bypass: true },
	{ focusedSubagent: true },
	{ thinkingLevel: ThinkingLevel.High },
];
