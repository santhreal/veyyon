/**
 * An incremental paint agrees with a cold mount of the same state.
 *
 * WHY THIS SUITE EXISTS:
 * Every other renderer suite here judges the screen against an expectation somebody wrote down, so
 * it can only find a defect that was imagined first. composer-defect-sweep.test.ts mounts four
 * thousand static states and asks eleven authored questions of each;
 * a-repaint-never-leaves-a-second-composer-behind.test.ts counts hairlines and prompts across a
 * transition. Both are blind to a wrong frame nobody thought to ask about.
 *
 * This suite needs no authored expectation. A cold mount at a given width, height, transcript
 * length and composer height is ground truth for that state: it is one full paint with nothing
 * carried over. Reaching the same state incrementally -- appending transcript rows, resizing, or
 * changing the composer's own height -- must therefore land on the same viewport, row for row, and
 * on the same composedFrameRows. Any difference is the incremental path disagreeing with a full
 * paint, which is a renderer defect by definition and needs no judgement call to recognise.
 *
 * Two ways of reaching the state are driven, because they are different code paths. Settling after
 * every step exercises the per-frame differential emitters one transition at a time. Applying a
 * whole batch with no settle between steps lets the ~33ms throttle coalesce them into a single
 * frame that is both taller and longer, or shorter and reflowed, which is where an emitter that
 * positions rows against a viewport top the reflow already invalidated goes wrong.
 *
 * Both run with scroll isolation off and on. On is the production default, and it swaps in the
 * virtual scroll tape and pinned-footer accounting, so an agreement proven with it off says nothing
 * about the configuration users actually run.
 *
 * THE CLASS THIS CLOSES:
 * A frame is owed and the engine reports itself idle. TUI.renderPending is the single signal
 * settle-frames.ts settles on ("a pending frame is never mistaken for quiescence"), and it counts
 * timer fields by hand. It omitted two of the engine's six hold-then-paint timers -- the
 * non-multiplexer resize viewport settle and the Ghostty initial-image delay -- so for the 120ms
 * after a resize it reported idle while the authoritative full paint was still queued. A test that
 * settled in that window read a stale frame: content appended after a resize was simply absent, and
 * the deficit was exactly that append's row count.
 *
 * The differential fails by default on a new member of that class. Add a seventh deferral timer and
 * leave it out of renderPending, and any sequence whose last step arms it settles early, lands on a
 * stale frame and diverges from the cold mount. Nothing has to be taught the new timer's name.
 *
 * WHAT THIS SUITE DOES NOT CATCH:
 * - Scrollback. Only the viewport is compared, because a cold mount has no history to hold and a
 *   warm one legitimately does, so the two can never agree there.
 * - A scrolled-back view. Every case sits at the bottom of the transcript; the runner derives
 *   scrollOffset rather than taking one, so a frozen mid-transcript view is out of reach here.
 * - A real tool result's own component. The transcript is a double returning plain rows, so
 *   wrapping, ANSI and inline images inside a streamed result are not exercised.
 * - The Ghostty initial-image delay, one of the two timers this closed. Removing it from
 *   renderPending leaves every case here green, because arming it needs an inline image drawn on a
 *   terminal reporting itself as Ghostty. The fail-by-default property above holds only for a
 *   deferral a driven sequence can actually arm.
 * - Mouse routing, overlays and focus changes, none of which are driven here.
 * - Which of the two paints is wrong. A divergence proves they disagree, not that the cold mount is
 *   the correct one.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { initTheme } from "../src/modes/theme/theme";
import { runComposerOracleScenario } from "./helpers/composer-oracle-runner";

/** One driven step. */
type Op =
	| { kind: "append"; count: number }
	| { kind: "resize"; width: number; height: number }
	| { kind: "editor"; text: string };

/** Everything a cold mount needs to reproduce a state reached incrementally. */
interface State {
	width: number;
	height: number;
	lines: number;
	editor: string;
}

/** What a settled scenario is judged on. */
interface Painted {
	grid: readonly string[];
	composed: number;
	end: State;
}

/** Whether each step gets its own frame, or the batch coalesces into one. */
type Timing = "per-step" | "coalesced";

/**
 * The runner generates `transcript-output-line-NNNN` from zero for a numeric
 * `transcriptLines`, so an appended row must use the same spelling or warm and
 * cold content would differ on content alone.
 */
function transcriptLine(index: number): string {
	return `transcript-output-line-${String(index).padStart(4, "0")}`;
}

/** One line of composer text. */
const EDITOR_ONE = "run the build";
/** Two lines, so the composer is one row taller than the single-line case. */
const EDITOR_TWO = "run the build\nthen ship it";
/** Five lines, enough for the composer to reshape the frame under a short terminal. */
const EDITOR_FIVE = "one\ntwo\nthree\nfour\nfive";

/**
 * Drive `ops` against a live scenario started at `start`.
 *
 * `per-step` settles after each op. `coalesced` applies every op first and settles once, so the
 * throttle merges them into a single frame.
 */
async function paintIncrementally(
	start: State,
	ops: readonly Op[],
	timing: Timing,
	scrollIsolation: boolean,
): Promise<Painted> {
	const scenario = await runComposerOracleScenario({
		width: start.width,
		height: start.height,
		transcriptLines: start.lines,
		editorText: start.editor,
		scrollIsolation,
		focused: true,
	});
	const state: State = { ...start };
	try {
		for (const op of ops) {
			if (op.kind === "append") {
				for (let i = 0; i < op.count; i += 1) {
					scenario.transcript.lines.push(transcriptLine(state.lines + i));
				}
				state.lines += op.count;
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
async function paintCold(state: State, scrollIsolation: boolean): Promise<Painted> {
	const scenario = await runComposerOracleScenario({
		width: state.width,
		height: state.height,
		transcriptLines: state.lines,
		editorText: state.editor,
		scrollIsolation,
		focused: true,
	});
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

/**
 * Starting states. Short and tall terminals both matter: the composer is pinned to the bottom, so
 * a height that barely fits it exercises a different windowing branch than one with room to spare.
 */
const STARTS: readonly State[] = [
	{ width: 80, height: 16, lines: 4, editor: EDITOR_ONE },
	{ width: 80, height: 24, lines: 0, editor: EDITOR_ONE },
	{ width: 80, height: 8, lines: 2, editor: EDITOR_ONE },
	{ width: 40, height: 12, lines: 30, editor: EDITOR_ONE },
	{ width: 120, height: 6, lines: 1, editor: EDITOR_ONE },
	{ width: 10, height: 4, lines: 0, editor: EDITOR_ONE },
	{ width: 20, height: 30, lines: 60, editor: EDITOR_ONE },
	{ width: 60, height: 5, lines: 3, editor: EDITOR_FIVE },
];

/**
 * Operation sequences, each run from every start, at both timings and both isolation settings.
 *
 * The three op kinds are the three ways the frame changes size under a pinned footer: the
 * transcript grows above it, the terminal changes around it, and the composer itself changes
 * height. The mixed sequences matter more than the single ones, because a deferral that swallows a
 * step only shows up when a later step lands while the earlier one is still owed, and a coalescing
 * defect only shows up when two kinds land in one frame.
 */
const SEQUENCES: readonly (readonly Op[])[] = [
	[{ kind: "append", count: 1 }],
	[{ kind: "append", count: 40 }],
	[{ kind: "resize", width: 80, height: 20 }],
	[{ kind: "resize", width: 30, height: 5 }],
	[
		{ kind: "resize", width: 80, height: 20 },
		{ kind: "append", count: 3 },
	],
	[
		{ kind: "append", count: 3 },
		{ kind: "resize", width: 80, height: 6 },
	],
	[
		{ kind: "append", count: 20 },
		{ kind: "resize", width: 40, height: 30 },
	],
	[
		{ kind: "append", count: 12 },
		{ kind: "resize", width: 60, height: 10 },
		{ kind: "append", count: 4 },
	],
	[
		{ kind: "append", count: 2 },
		{ kind: "resize", width: 100, height: 30 },
		{ kind: "append", count: 2 },
		{ kind: "resize", width: 100, height: 5 },
	],
	[
		{ kind: "append", count: 5 },
		{ kind: "resize", width: 15, height: 4 },
		{ kind: "append", count: 5 },
		{ kind: "resize", width: 120, height: 24 },
	],
	[{ kind: "editor", text: EDITOR_TWO }],
	[{ kind: "editor", text: EDITOR_FIVE }],
	[
		{ kind: "editor", text: EDITOR_FIVE },
		{ kind: "editor", text: EDITOR_ONE },
	],
	[
		{ kind: "editor", text: EDITOR_FIVE },
		{ kind: "append", count: 4 },
	],
	[
		{ kind: "append", count: 4 },
		{ kind: "editor", text: EDITOR_FIVE },
	],
	[
		{ kind: "editor", text: EDITOR_FIVE },
		{ kind: "resize", width: 60, height: 10 },
	],
	[
		{ kind: "resize", width: 60, height: 10 },
		{ kind: "editor", text: EDITOR_FIVE },
	],
	[
		{ kind: "resize", width: 90, height: 25 },
		{ kind: "resize", width: 45, height: 9 },
		{ kind: "append", count: 6 },
	],
	[
		{ kind: "editor", text: EDITOR_FIVE },
		{ kind: "resize", width: 40, height: 6 },
		{ kind: "append", count: 3 },
		{ kind: "editor", text: EDITOR_ONE },
	],
	[
		{ kind: "append", count: 3 },
		{ kind: "editor", text: EDITOR_TWO },
		{ kind: "resize", width: 100, height: 12 },
		{ kind: "editor", text: EDITOR_FIVE },
	],
];

/** Wall-clock ceiling for one start's sweep: every sequence mounts twice and settles. */
const SWEEP_BUDGET_MS = 120_000;

/** Name a sequence by its steps, so a failure says which one diverged. */
function describeOps(ops: readonly Op[]): string {
	const parts = ops.map(op => {
		if (op.kind === "append") return `+${op.count}`;
		if (op.kind === "resize") return `${op.width}x${op.height}`;
		return `editor:${op.text.split("\n").length}`;
	});
	return parts.join(" ");
}

/** Row-by-row report of every way the two paints disagree. */
function disagreements(label: string, warm: Painted, cold: Painted): string[] {
	if (warm.composed !== cold.composed) {
		return [`${label}: composedFrameRows incremental=${warm.composed} cold=${cold.composed}`];
	}
	const found: string[] = [];
	const rows = Math.max(warm.grid.length, cold.grid.length);
	for (let row = 0; row < rows; row += 1) {
		const incremental = warm.grid[row] ?? "<missing row>";
		const fresh = cold.grid[row] ?? "<missing row>";
		if (incremental !== fresh) {
			found.push(`${label}: row ${row} incremental=${JSON.stringify(incremental)} cold=${JSON.stringify(fresh)}`);
		}
	}
	return found;
}

const TIMINGS: readonly Timing[] = ["per-step", "coalesced"];
/** False and true, because true is the production default and swaps in the virtual scroll tape. */
const ISOLATION: readonly boolean[] = [false, true];

describe("an incremental paint agrees with a cold mount", () => {
	beforeAll(async () => {
		await initTheme(false);
	});

	for (const timing of TIMINGS) {
		for (const scrollIsolation of ISOLATION) {
			const mode = `${timing}, isolation ${scrollIsolation ? "on" : "off"}`;

			for (const start of STARTS) {
				const startLabel = `${start.width}x${start.height} transcript=${start.lines} composer=${start.editor.split("\n").length}`;

				it(
					`holds from ${startLabel} (${mode})`,
					async () => {
						const divergences: string[] = [];
						for (const ops of SEQUENCES) {
							const label = `${startLabel} ${mode} [${describeOps(ops)}]`;
							const warm = await paintIncrementally(start, ops, timing, scrollIsolation);
							const cold = await paintCold(warm.end, scrollIsolation);
							divergences.push(...disagreements(label, warm, cold));
						}
						expect(divergences).toEqual([]);
					},
					SWEEP_BUDGET_MS,
				);
			}
		}
	}
});
