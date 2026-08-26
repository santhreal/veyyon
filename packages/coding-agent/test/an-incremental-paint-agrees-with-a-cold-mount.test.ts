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
 * carried over. Reaching the same state incrementally must therefore land on the same viewport,
 * row for row, and on the same composedFrameRows. Any difference is the incremental path
 * disagreeing with a full paint, which is a renderer defect by definition.
 *
 * FOUR AXES, EACH FOR A DIFFERENT REASON:
 *  - Geometry and transcript depth, swept as starting states, because the composer is pinned to
 *    the bottom and a height that barely fits it takes a different windowing branch.
 *  - Timing. Settling after every step exercises the per-frame emitters one transition at a time;
 *    applying a batch and settling once lets the throttle merge them into a single frame that is
 *    both reflowed and longer, which is where an emitter positioning rows against a viewport top
 *    the reflow already invalidated goes wrong.
 *  - Content shape. Column accounting is where renderers break: a wide glyph takes two cells, a
 *    combining mark none, an astral pair is one glyph in two code units, SGR bytes take no width,
 *    and a long row wraps. Plain marker rows exercise none of that.
 *  - Composer accents and a status row, because they change the chrome's height and colours, and
 *    the pinned footer's row count is what the transcript window is computed against.
 *
 * Every sweep runs with scroll isolation off and on. On is the production default and swaps in the
 * virtual scroll tape, so an agreement proven with it off says nothing about what users run.
 *
 * THE CLASS THIS CLOSES:
 * A frame is owed and the engine reports itself idle. TUI.renderPending is the single signal
 * settle-frames.ts settles on ("a pending frame is never mistaken for quiescence"), and it counts
 * timer fields by hand. It omitted two of the engine's six hold-then-paint timers -- the
 * non-multiplexer resize viewport settle and the Ghostty initial-image delay -- so for the 120ms
 * after a resize it reported idle while the authoritative full paint was still queued. A test that
 * settled in that window read a stale frame: content changed after a resize was simply absent, and
 * the deficit was exactly that step's row count.
 *
 * The differential fails by default on a new member of that class. Add a seventh deferral timer and
 * leave it out of renderPending, and any sequence whose last step arms it settles early, lands on a
 * stale frame and diverges from the cold mount. Nothing has to be taught the new timer's name.
 *
 * WHAT THIS SUITE DOES NOT CATCH:
 * - A defect a cold mount shares. The comparison is warm against cold, so a state that is painted
 *   wrong the same way both times agrees with itself. Absolute invariants live in
 *   the-painted-grid-fits-the-terminal-and-holds-one-composer.test.ts.
 * - Scrollback. Only the viewport is compared, because a cold mount has no history to hold.
 * - A scrolled-back view. Those live in the two scroll suites, which use a round trip and a
 *   re-freeze because a cold mount is never scrolled.
 * - A real tool result's own component. The transcript is a double returning prepared rows, so a
 *   streamed result's own wrapping and image protocols are not exercised.
 * - The Ghostty initial-image delay, one of the two timers this closed. Removing it from
 *   renderPending leaves every case here green, because arming it needs an inline image drawn on a
 *   terminal reporting itself as Ghostty. The fail-by-default property holds only for a deferral a
 *   driven sequence can actually arm.
 * - Overlays and focus changes, neither of which is driven here.
 * - Which of the two paints is wrong. A divergence proves they disagree, not that cold is right.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { initTheme } from "../src/modes/theme/theme";
import {
	describeOps,
	describeState,
	disagreements,
	EDITOR_FIVE,
	EDITOR_ONE,
	EDITOR_TWO,
	EDITOR_WIDE,
	EDITOR_WRAPPING,
	FLAVORS,
	ISOLATION,
	MODE_STATES,
	type Op,
	paintCold,
	paintIncrementally,
	type State,
	TIMINGS,
} from "./helpers/renderer-differential";

/** Ceiling for one sweep: each comparison mounts twice and settles at least once. */
const SWEEP_BUDGET_MS = 180_000;

/** Starting states for the geometry backbone. */
const STARTS: readonly State[] = [
	{ width: 80, height: 16, lines: 4, editor: EDITOR_ONE, flavor: "plain" },
	{ width: 80, height: 24, lines: 0, editor: EDITOR_ONE, flavor: "plain" },
	{ width: 80, height: 8, lines: 2, editor: EDITOR_ONE, flavor: "plain" },
	{ width: 40, height: 12, lines: 30, editor: EDITOR_ONE, flavor: "plain" },
	{ width: 120, height: 6, lines: 1, editor: EDITOR_ONE, flavor: "plain" },
	{ width: 10, height: 4, lines: 0, editor: EDITOR_ONE, flavor: "plain" },
	{ width: 20, height: 30, lines: 60, editor: EDITOR_ONE, flavor: "plain" },
	{ width: 60, height: 5, lines: 3, editor: EDITOR_FIVE, flavor: "plain" },
];

/** The full sequence set, run against the geometry backbone. */
const SEQUENCES: readonly (readonly Op[])[] = [
	[{ kind: "append", count: 1 }],
	[{ kind: "append", count: 40 }],
	[{ kind: "shrink", count: 2 }],
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
		{ kind: "append", count: 6 },
		{ kind: "shrink", count: 4 },
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
	[{ kind: "editor", text: EDITOR_WRAPPING }],
	[{ kind: "editor", text: EDITOR_WIDE }],
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

/** A smaller sequence set for the axes that multiply against every member. */
const CROSS_SEQUENCES: readonly (readonly Op[])[] = [
	[{ kind: "append", count: 3 }],
	[{ kind: "shrink", count: 3 }],
	[
		{ kind: "append", count: 6 },
		{ kind: "shrink", count: 4 },
	],
	[
		{ kind: "resize", width: 60, height: 12 },
		{ kind: "append", count: 4 },
	],
	[
		{ kind: "shrink", count: 5 },
		{ kind: "resize", width: 100, height: 20 },
	],
	[{ kind: "editor", text: EDITOR_WRAPPING }],
	[{ kind: "editor", text: EDITOR_WIDE }],
	[
		{ kind: "editor", text: EDITOR_FIVE },
		{ kind: "resize", width: 30, height: 6 },
	],
	[
		{ kind: "append", count: 4 },
		{ kind: "editor", text: EDITOR_WRAPPING },
		{ kind: "resize", width: 50, height: 10 },
	],
];

/** Geometries the content and accent axes are crossed against. */
const CROSS_GEOMETRIES: ReadonlyArray<{ width: number; height: number }> = [
	{ width: 80, height: 16 },
	{ width: 40, height: 8 },
	{ width: 120, height: 6 },
	{ width: 20, height: 24 },
];

/** Run every sequence from `start` at one timing and isolation, collecting divergences. */
async function sweep(
	start: State,
	sequences: readonly (readonly Op[])[],
	timing: (typeof TIMINGS)[number],
	scrollIsolation: boolean,
	into: string[],
): Promise<void> {
	for (const ops of sequences) {
		const label = `${describeState(start)} ${timing} iso=${scrollIsolation ? "on" : "off"} [${describeOps(ops)}]`;
		const warm = await paintIncrementally(start, ops, timing, scrollIsolation);
		const cold = await paintCold(warm.end, scrollIsolation);
		into.push(...disagreements(label, warm, cold));
	}
}

describe("an incremental paint agrees with a cold mount", () => {
	beforeAll(async () => {
		await initTheme(false);
	});

	describe("across geometry, timing and scroll isolation", () => {
		for (const timing of TIMINGS) {
			for (const scrollIsolation of ISOLATION) {
				for (const start of STARTS) {
					it(
						`holds from ${describeState(start)} (${timing}, isolation ${scrollIsolation ? "on" : "off"})`,
						async () => {
							const divergences: string[] = [];
							await sweep(start, SEQUENCES, timing, scrollIsolation, divergences);
							expect(divergences).toEqual([]);
						},
						SWEEP_BUDGET_MS,
					);
				}
			}
		}
	});

	describe("across content shape", () => {
		for (const flavor of FLAVORS) {
			it(
				`holds for ${flavor} transcript rows`,
				async () => {
					const divergences: string[] = [];
					for (const geometry of CROSS_GEOMETRIES) {
						const start: State = { ...geometry, lines: 14, editor: EDITOR_ONE, flavor };
						for (const timing of TIMINGS) {
							await sweep(start, CROSS_SEQUENCES, timing, true, divergences);
						}
					}
					expect(divergences).toEqual([]);
				},
				SWEEP_BUDGET_MS,
			);
		}
	});

	describe("across composer accents", () => {
		for (const modeState of MODE_STATES) {
			const name = modeState ? Object.keys(modeState).join("+") : "default accents";
			it(
				`holds with ${name}`,
				async () => {
					const divergences: string[] = [];
					for (const statusMessage of [undefined, "working on it"]) {
						const start: State = {
							width: 80,
							height: 16,
							lines: 14,
							editor: EDITOR_ONE,
							flavor: "plain",
							modeState,
							statusMessage,
						};
						for (const scrollIsolation of ISOLATION) {
							await sweep(start, CROSS_SEQUENCES, "per-step", scrollIsolation, divergences);
						}
					}
					expect(divergences).toEqual([]);
				},
				SWEEP_BUDGET_MS,
			);
		}
	});
});
