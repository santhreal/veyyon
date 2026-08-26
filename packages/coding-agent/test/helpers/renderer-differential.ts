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
import { stripAnsi } from "@veyyon/utils/strip-ansi";
import type { ComposerAccentState } from "../../src/modes/components/composer-chrome";
import { isComposerPromptLine, isHairlineLine } from "../../src/modes/components/composer-defect-oracle";
import { runComposerOracleScenario } from "./composer-oracle-runner";

/** SGR wheel-up report at row 5, col 5. Scrolls back into history. */
export const WHEEL_UP = "\x1b[<64;5;5M";
/** SGR wheel-down report at row 5, col 5. Walks forward toward the live tail. */
export const WHEEL_DOWN = "\x1b[<65;5;5M";

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

/** One driven step. */
export type Op =
	| { kind: "append"; count: number }
	| { kind: "shrink"; count: number }
	| { kind: "resize"; width: number; height: number }
	| { kind: "editor"; text: string };

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
			} else {
				state.width = op.width;
				state.height = op.height;
				scenario.terminal.resize(state.width, state.height);
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
