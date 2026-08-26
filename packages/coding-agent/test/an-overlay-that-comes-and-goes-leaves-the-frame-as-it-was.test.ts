/**
 * An overlay that comes and goes leaves the frame as it was.
 *
 * WHY THIS SUITE EXISTS:
 * The overlay path was entirely undriven by the differential renderer oracle. showOverlay hides
 * the hardware cursor, pushes an entry onto overlayStack, shifts component focus, and draws the
 * overlay component on top of the composed frame window. Crucially, the presence of a visible
 * overlay forces the engine to abandon a frozen scroll view and resume following the live tail
 * (~tui.ts:4178). Closing an overlay via hide() triggers exit handling, drops the stack entry, and
 * requests a re-render.
 *
 * This suite provides expectation-free and invariant checks across five distinct claims:
 *  1. Balanced overlay sequences (where every opened overlay is closed) leave the frame identical
 *     to a cold mount of the end state byte for byte.
 *  2. An overlay is demonstrably visible on screen while open, and completely absent after close,
 *     verifying that differential checks do not pass vacuously.
 *  3. Opening an overlay while scrolled back forces the virtual scroll view to resume following the
 *     live tail immediately, and resets the scroll snapshot so subsequent scrollbacks are not stale.
 *  4. Composer chrome (hairlines and prompts) remains strictly singular at every step across overlay
 *     open, mutation, nesting, and close transitions.
 *  5. Fullscreen overlays on the alternate screen do not duplicate chrome or corrupt normal buffer
 *     rendering upon dismissal.
 *
 * WHAT THIS SUITE DOES NOT CATCH:
 * - Animated overlay exit frames during intermediate ticks. The tests settle frames after hide()
 *   completes its exit callback.
 * - Mouse event hit testing on overlay boundaries. Mouse routing is verified in component-specific
 *   unit tests.
 * - Hardware terminal alt-screen escape sequences emitted to the physical PTY. VirtualTerminal
 *   verifies buffer contents rather than raw escape stream bytes.
 *
 * MUTATION GATE:
 * 1. packages/tui/src/tui.ts:4178: Deleted `hasVisibleOverlay ||` from the frozen view resume condition.
 *    Result: 1 test failed (16 failed cases). Observed: failedResumes expected [], received:
 *    "80x16/60 up=3: virtualScrollActive expected false after overlay open".
 * 2. packages/tui/src/tui.ts:1907: Dropped `this.#scrollSnapshot = null;` from `#resumeLiveTail()`.
 *    Result: 1 test failed (1 failed case). Observed: refreezeDiffs expected [], received:
 *    "re-freeze: row 4 warm-refreeze=\"transcript-output-line-0007 █\" cold-refreeze=\"transcript-output-line-0007 │\"".
 * 3. packages/tui/src/tui.ts:2201: Changed `hasOverlay()` to return `false` unconditionally.
 *    Result: 2 tests failed. Observed: "expect(received).toBe(expected) Expected: true Received: false"
 *    at `expect(scenario.tui.hasOverlay()).toBe(true)`.
 * 4. packages/tui/src/tui.ts:3544: Replaced `component.render(width)` with empty array in `#compositeOverlaysIntoWindow`.
 *    Result: 2 tests failed. Observed: "expect(received).toBeGreaterThan(expected) Expected: > 0 Received: 0"
 *    at `expect(openOverlayRows.length).toBeGreaterThan(0)`.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { initTheme } from "../src/modes/theme/theme";
import { runComposerOracleScenario } from "./helpers/defect-oracles";
import {
	balanced,
	compareGrids,
	contentLine,
	countChrome,
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
	OVERLAY_MARK,
	OverlayMock,
	paintCold,
	paintIncrementally,
	type State,
	TIMINGS,
	WHEEL_DOWN,
	WHEEL_UP,
} from "./helpers/renderer-differential";

/** Timeout ceiling for the entire differential sweep. */
const SUITE_TIMEOUT_MS = 180_000;

/** Geometry matrix covering short, standard, tall, narrow, and wide viewports. */
const GEOMETRY_STARTS: readonly State[] = [
	{ width: 80, height: 16, lines: 10, editor: EDITOR_ONE, flavor: "plain" },
	{ width: 80, height: 24, lines: 35, editor: EDITOR_ONE, flavor: "plain" },
	{ width: 80, height: 8, lines: 6, editor: EDITOR_ONE, flavor: "plain" },
	{ width: 40, height: 12, lines: 25, editor: EDITOR_ONE, flavor: "plain" },
	{ width: 120, height: 6, lines: 15, editor: EDITOR_ONE, flavor: "plain" },
	{ width: 20, height: 30, lines: 50, editor: EDITOR_ONE, flavor: "plain" },
];

/**
 * Balanced operation sequences exercising:
 * - Shorter overlay (3 rows)
 * - Filling overlay (10 rows)
 * - Clipping overlay (30 rows, exceeds terminal height)
 * - Work done while overlay is open (append, shrink, editor text change, terminal resize)
 * - Nested overlays (open, open, close, close)
 * - Re-opened overlay (open, close, open, close)
 */
const BALANCED_SEQUENCES: readonly (readonly Op[])[] = [
	// Simple open and close: short, filling, and clipping heights
	[{ kind: "overlay-open", rows: 3 }, { kind: "overlay-close" }],
	[{ kind: "overlay-open", rows: 10 }, { kind: "overlay-close" }],
	[{ kind: "overlay-open", rows: 30 }, { kind: "overlay-close" }],
	// Append transcript rows while overlay is open
	[{ kind: "overlay-open", rows: 4 }, { kind: "append", count: 5 }, { kind: "overlay-close" }],
	// Shrink transcript rows while overlay is open
	[{ kind: "overlay-open", rows: 5 }, { kind: "shrink", count: 3 }, { kind: "overlay-close" }],
	// Editor changes while overlay is open
	[{ kind: "overlay-open", rows: 4 }, { kind: "editor", text: EDITOR_TWO }, { kind: "overlay-close" }],
	[{ kind: "overlay-open", rows: 6 }, { kind: "editor", text: EDITOR_FIVE }, { kind: "overlay-close" }],
	// Terminal resize while overlay is open
	[{ kind: "overlay-open", rows: 4 }, { kind: "resize", width: 60, height: 14 }, { kind: "overlay-close" }],
	// Combined work while overlay is open
	[
		{ kind: "overlay-open", rows: 8 },
		{ kind: "append", count: 4 },
		{ kind: "editor", text: EDITOR_TWO },
		{ kind: "resize", width: 70, height: 12 },
		{ kind: "overlay-close" },
	],
	// Nested overlays: open first, open second, close second, close first
	[
		{ kind: "overlay-open", rows: 3 },
		{ kind: "overlay-open", rows: 8 },
		{ kind: "overlay-close" },
		{ kind: "overlay-close" },
	],
	// Nested overlays with mutations at each level
	[
		{ kind: "overlay-open", rows: 3 },
		{ kind: "append", count: 2 },
		{ kind: "overlay-open", rows: 6 },
		{ kind: "editor", text: EDITOR_TWO },
		{ kind: "overlay-close" },
		{ kind: "shrink", count: 1 },
		{ kind: "overlay-close" },
	],
	// Overlay opened and closed twice in succession
	[
		{ kind: "overlay-open", rows: 4 },
		{ kind: "overlay-close" },
		{ kind: "overlay-open", rows: 7 },
		{ kind: "overlay-close" },
	],
];

/** Geometries for scrollback resume testing. */
interface ScrollResumeCase {
	width: number;
	height: number;
	lines: number;
	upNotches: number;
}

const SCROLL_RESUME_CASES: readonly ScrollResumeCase[] = [
	{ width: 80, height: 16, lines: 60, upNotches: 3 },
	{ width: 80, height: 10, lines: 100, upNotches: 5 },
	{ width: 80, height: 24, lines: 40, upNotches: 2 },
	{ width: 40, height: 8, lines: 50, upNotches: 4 },
	{ width: 120, height: 6, lines: 30, upNotches: 2 },
	{ width: 20, height: 30, lines: 70, upNotches: 6 },
	{ width: 80, height: 16, lines: 12, upNotches: 1 },
];

describe("an overlay that comes and goes leaves the frame as it was", () => {
	beforeAll(async () => {
		await initTheme(false);
	});

	it(
		"restores the frame byte for byte across geometries, timings, and isolations",
		async () => {
			const divergences: string[] = [];

			for (const isolation of ISOLATION) {
				for (const timing of TIMINGS) {
					for (const start of GEOMETRY_STARTS) {
						for (const seq of BALANCED_SEQUENCES) {
							expect(balanced(seq)).toBe(true);
							const label = `${describeState(start)} timing=${timing} iso=${isolation} ops=(${describeOps(seq)})`;
							const warm = await paintIncrementally(start, seq, timing, isolation);
							const cold = await paintCold(warm.end, isolation);
							const diffs = disagreements(label, warm, cold);
							if (diffs.length > 0) {
								divergences.push(...diffs);
							}
						}
					}
				}
			}

			expect(divergences).toEqual([]);
		},
		SUITE_TIMEOUT_MS,
	);

	it(
		"restores the frame byte for byte across content flavors and editor shapes",
		async () => {
			const divergences: string[] = [];
			const baseState: State = {
				width: 80,
				height: 16,
				lines: 10,
				editor: EDITOR_ONE,
				flavor: "plain",
			};

			const editors = [EDITOR_ONE, EDITOR_TWO, EDITOR_FIVE, EDITOR_WRAPPING, EDITOR_WIDE];
			const representativeSeq: readonly Op[] = [
				{ kind: "overlay-open", rows: 5 },
				{ kind: "append", count: 3 },
				{ kind: "overlay-close" },
			];
			expect(balanced(representativeSeq)).toBe(true);

			for (const isolation of ISOLATION) {
				for (const flavor of FLAVORS) {
					for (const editor of editors) {
						const start: State = { ...baseState, flavor, editor };
						const label = `${describeState(start)} iso=${isolation}`;
						const warm = await paintIncrementally(start, representativeSeq, "per-step", isolation);
						const cold = await paintCold(warm.end, isolation);
						const diffs = disagreements(label, warm, cold);
						if (diffs.length > 0) {
							divergences.push(...diffs);
						}
					}
				}
			}

			expect(divergences).toEqual([]);
		},
		SUITE_TIMEOUT_MS,
	);

	it(
		"restores the frame byte for byte across composer mode states",
		async () => {
			const divergences: string[] = [];
			const baseState: State = {
				width: 80,
				height: 16,
				lines: 8,
				editor: EDITOR_ONE,
				flavor: "plain",
			};

			const representativeSeq: readonly Op[] = [
				{ kind: "overlay-open", rows: 4 },
				{ kind: "editor", text: EDITOR_TWO },
				{ kind: "overlay-close" },
			];
			expect(balanced(representativeSeq)).toBe(true);

			for (const isolation of ISOLATION) {
				for (const modeState of MODE_STATES) {
					const start: State = { ...baseState, modeState };
					const label = `${describeState(start)} iso=${isolation}`;
					const warm = await paintIncrementally(start, representativeSeq, "per-step", isolation);
					const cold = await paintCold(warm.end, isolation);
					const diffs = disagreements(label, warm, cold);
					if (diffs.length > 0) {
						divergences.push(...diffs);
					}
				}
			}

			expect(divergences).toEqual([]);
		},
		SUITE_TIMEOUT_MS,
	);

	it(
		"renders overlay content while open and completely removes it upon closing",
		async () => {
			const overlayRowCounts = [3, 10, 25];
			const testGeometries = [
				{ width: 80, height: 16, lines: 10 },
				{ width: 40, height: 12, lines: 20 },
				{ width: 120, height: 8, lines: 15 },
			];

			for (const geo of testGeometries) {
				for (const rows of overlayRowCounts) {
					const label = `${geo.width}x${geo.height}/${geo.lines} rows=${rows}`;
					const scenario = await runComposerOracleScenario({
						width: geo.width,
						height: geo.height,
						transcriptLines: geo.lines,
						editorText: EDITOR_ONE,
						scrollIsolation: true,
						focused: true,
					});

					try {
						// Before overlay: no overlay marks and hasOverlay is false
						expect(scenario.tui.hasOverlay()).toBe(false);
						const initialGrid = scenario.terminal.getViewport().slice();
						const initialOverlayRows = initialGrid.filter(r => r.includes(OVERLAY_MARK));
						expect(initialOverlayRows.length).toBe(0);

						// Show overlay
						const handle = scenario.tui.showOverlay(new OverlayMock(rows));
						await scenario.advance();

						// While overlay is open: hasOverlay is true and overlay rows are visible
						expect(scenario.tui.hasOverlay()).toBe(true);
						const openGrid = scenario.terminal.getViewport().slice();
						const openOverlayRows = openGrid.filter(r => r.includes(OVERLAY_MARK));
						expect(openOverlayRows.length).toBeGreaterThan(0);
						// Expected rendered overlay row count is capped at viewport height
						const expectedVisibleRows = Math.min(rows, geo.height);
						expect(openOverlayRows.length).toBe(expectedVisibleRows);

						// Close overlay directly via handle.hide()
						handle.hide();
						await scenario.advance();

						// After overlay close: hasOverlay is false and 0 overlay rows remain
						expect(scenario.tui.hasOverlay()).toBe(false);
						const closedGrid = scenario.terminal.getViewport().slice();
						const closedOverlayRows = closedGrid.filter(r => r.includes(OVERLAY_MARK));
						expect(closedOverlayRows.length).toBe(0);

						// Closed viewport equals the initial cold viewport
						const diffs: string[] = [];
						compareGrids(diffs, label, "closed", closedGrid, "initial", initialGrid);
						expect(diffs).toEqual([]);
					} finally {
						scenario.cleanUp();
					}
				}
			}
		},
		SUITE_TIMEOUT_MS,
	);

	it(
		"forces a frozen scroll view back to the live tail and resets the scroll snapshot",
		async () => {
			const neverFroze: string[] = [];
			const failedResumes: string[] = [];
			const gridMismatches: string[] = [];

			for (const testCase of SCROLL_RESUME_CASES) {
				const label = `${testCase.width}x${testCase.height}/${testCase.lines} up=${testCase.upNotches}`;
				const scenario = await runComposerOracleScenario({
					width: testCase.width,
					height: testCase.height,
					transcriptLines: testCase.lines,
					editorText: EDITOR_ONE,
					scrollIsolation: true,
					focused: true,
				});

				try {
					// 1. Scroll back into history
					for (let i = 0; i < testCase.upNotches; i += 1) {
						scenario.terminal.sendInput(WHEEL_UP);
						await scenario.advance();
					}

					// Verify that the view genuinely froze
					if (!scenario.tui.virtualScrollActive) {
						neverFroze.push(label);
					}

					// 2. Open an overlay while frozen
					const handle = scenario.tui.showOverlay(new OverlayMock(4));
					await scenario.advance();

					// Opening an overlay must force the engine to resume following the live tail
					if (scenario.tui.virtualScrollActive) {
						failedResumes.push(`${label}: virtualScrollActive expected false after overlay open`);
					}

					// 3. Close the overlay
					handle.hide();
					await scenario.advance();

					// Virtual scroll remains inactive (at live tail)
					if (scenario.tui.virtualScrollActive) {
						failedResumes.push(`${label}: virtualScrollActive expected false after overlay close`);
					}

					// Grid must equal a cold mount at the live tail
					const cold = await paintCold(
						{
							width: testCase.width,
							height: testCase.height,
							lines: testCase.lines,
							editor: EDITOR_ONE,
							flavor: "plain",
						},
						true,
					);
					const currentGrid = scenario.terminal.getViewport().slice();
					const diffs: string[] = [];
					compareGrids(diffs, label, "warm-resumed", currentGrid, "cold-tail", cold.grid);
					if (diffs.length > 0) {
						gridMismatches.push(...diffs);
					}
				} finally {
					scenario.cleanUp();
				}
			}

			expect(neverFroze).toEqual([]);
			expect(failedResumes).toEqual([]);
			expect(gridMismatches).toEqual([]);

			// 4. Test re-freeze snapshot invalidation:
			// Ensure that #resumeLiveTail clears #scrollSnapshot so a later freeze gets fresh rows.
			const refreezeScenario = await runComposerOracleScenario({
				width: 80,
				height: 16,
				transcriptLines: 20,
				editorText: EDITOR_ONE,
				scrollIsolation: true,
				focused: true,
			});

			try {
				// Scroll back
				for (let i = 0; i < 3; i += 1) {
					refreezeScenario.terminal.sendInput(WHEEL_UP);
					await refreezeScenario.advance();
				}
				expect(refreezeScenario.tui.virtualScrollActive).toBe(true);

				// Append 10 rows to transcript while scrolled back
				for (let i = 0; i < 10; i += 1) {
					refreezeScenario.transcript.lines.push(contentLine("plain", 20 + i));
				}
				refreezeScenario.transcript.invalidate();

				// Open overlay -> forces resumeLiveTail
				const handle = refreezeScenario.tui.showOverlay(new OverlayMock(3));
				await refreezeScenario.advance();
				expect(refreezeScenario.tui.virtualScrollActive).toBe(false);

				// Close overlay
				handle.hide();
				await refreezeScenario.advance();

				// Reset wheel direction streak so subsequent scroll-up starts at baseline
				refreezeScenario.terminal.sendInput(WHEEL_DOWN);
				await refreezeScenario.advance();

				// Scroll back again -> freezes a new snapshot
				for (let i = 0; i < 3; i += 1) {
					refreezeScenario.terminal.sendInput(WHEEL_UP);
					await refreezeScenario.advance();
				}
				expect(refreezeScenario.tui.virtualScrollActive).toBe(true);

				// Build cold reference for a scenario mounted with 30 lines and scrolled back 3 notches
				const coldRefreezeScenario = await runComposerOracleScenario({
					width: 80,
					height: 16,
					transcriptLines: 30,
					editorText: EDITOR_ONE,
					scrollIsolation: true,
					focused: true,
				});
				try {
					for (let i = 0; i < 3; i += 1) {
						coldRefreezeScenario.terminal.sendInput(WHEEL_UP);
						await coldRefreezeScenario.advance();
					}
					const warmViewport = refreezeScenario.terminal.getViewport().slice();
					const coldViewport = coldRefreezeScenario.terminal.getViewport().slice();
					const refreezeDiffs: string[] = [];
					compareGrids(refreezeDiffs, "re-freeze", "warm-refreeze", warmViewport, "cold-refreeze", coldViewport);
					expect(refreezeDiffs).toEqual([]);
				} finally {
					coldRefreezeScenario.cleanUp();
				}
			} finally {
				refreezeScenario.cleanUp();
			}
		},
		SUITE_TIMEOUT_MS,
	);

	it(
		"maintains singular composer chrome across every overlay transition",
		async () => {
			const chromeViolations: string[] = [];

			for (const isolation of ISOLATION) {
				for (const start of GEOMETRY_STARTS) {
					const scenario = await runComposerOracleScenario({
						width: start.width,
						height: start.height,
						transcriptLines: start.lines,
						editorText: start.editor,
						scrollIsolation: isolation,
						focused: true,
					});

					try {
						const checkChrome = (step: string) => {
							const { hairlines, prompts } = countChrome(scenario.terminal.getViewport());
							if (hairlines > 1 || prompts > 1) {
								chromeViolations.push(
									`${describeState(start)} iso=${isolation} step=${step}: hairlines=${hairlines} prompts=${prompts}`,
								);
							}
						};

						// Step 1: Initial mount
						checkChrome("mount");

						// Step 2: Open first overlay
						const h1 = scenario.tui.showOverlay(new OverlayMock(4));
						await scenario.advance();
						checkChrome("overlay1-open");

						// Step 3: Append transcript rows
						scenario.transcript.lines.push(contentLine("plain", start.lines + 1));
						scenario.transcript.invalidate();
						await scenario.advance();
						checkChrome("append-while-overlay");

						// Step 4: Open nested overlay
						const h2 = scenario.tui.showOverlay(new OverlayMock(6));
						await scenario.advance();
						checkChrome("overlay2-open-nested");

						// Step 5: Close second overlay
						h2.hide();
						await scenario.advance();
						checkChrome("overlay2-close");

						// Step 6: Change editor text
						scenario.editor.setText(EDITOR_TWO);
						await scenario.advance();
						checkChrome("editor-change");

						// Step 7: Close first overlay
						h1.hide();
						await scenario.advance();
						checkChrome("overlay1-close");
					} finally {
						scenario.cleanUp();
					}
				}
			}

			expect(chromeViolations).toEqual([]);
		},
		SUITE_TIMEOUT_MS,
	);

	it(
		"does not corrupt the normal screen or duplicate chrome with a fullscreen overlay",
		async () => {
			const fullscreenDivergences: string[] = [];

			for (const isolation of ISOLATION) {
				for (const start of GEOMETRY_STARTS) {
					const label = `${describeState(start)} iso=${isolation} fullscreen`;
					const scenario = await runComposerOracleScenario({
						width: start.width,
						height: start.height,
						transcriptLines: start.lines,
						editorText: start.editor,
						scrollIsolation: isolation,
						focused: true,
					});

					try {
						// Open fullscreen overlay
						const handle = scenario.tui.showOverlay(new OverlayMock(8), { fullscreen: true });
						await scenario.advance();

						expect(scenario.tui.hasOverlay()).toBe(true);

						// Chrome while fullscreen overlay is active must not be duplicated
						const { hairlines, prompts } = countChrome(scenario.terminal.getViewport());
						expect(hairlines).toBeLessThanOrEqual(1);
						expect(prompts).toBeLessThanOrEqual(1);

						// Overlay rows must be rendered
						const fsGrid = scenario.terminal.getViewport().slice();
						const fsOverlayRows = fsGrid.filter(r => r.includes(OVERLAY_MARK));
						expect(fsOverlayRows.length).toBeGreaterThan(0);

						// Mutate transcript while fullscreen
						scenario.transcript.lines.push(contentLine(start.flavor, start.lines));
						scenario.transcript.lines.push(contentLine(start.flavor, start.lines + 1));
						scenario.transcript.invalidate();
						await scenario.advance();

						// Close fullscreen overlay
						handle.hide();
						await scenario.advance();

						expect(scenario.tui.hasOverlay()).toBe(false);

						// Final frame must match a cold mount with the appended lines
						const endState: State = {
							...start,
							lines: start.lines + 2,
						};
						const cold = await paintCold(endState, isolation);
						const afterGrid = scenario.terminal.getViewport().slice();
						compareGrids(fullscreenDivergences, label, "after-fullscreen", afterGrid, "cold", cold.grid);
					} finally {
						scenario.cleanUp();
					}
				}
			}

			expect(fullscreenDivergences).toEqual([]);
		},
		SUITE_TIMEOUT_MS,
	);
});
