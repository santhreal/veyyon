/**
 * A resize while the view is frozen abandons the frozen view and lands on the live tail at the new geometry.
 *
 * WHY THIS SUITE EXISTS:
 * Resizing while the view is scrolled back into history is the highest-risk combination in the TUI engine.
 * A resize invalidates geometry, reflows terminal text, and sets geometryChanged in the frame transition ledger.
 * The virtual scroll slice path at tui.ts:4178 must abandon the frozen slice and resume the live tail,
 * because the scroll snapshot was captured once against the old geometry and committed scrollback rows were wrapped
 * at the old width. If the engine fails to resume the live tail on resize, it either serves stale rows wrapped for the
 * wrong width or corrupts the window slice positioning.
 *
 * This suite drives five invariants across geometry shifts, content flavours, wheel depths, timings, and isolation modes:
 *
 * 1. COLD PARITY AFTER RESIZE: Scrolling back, resizing (narrower, wider, shorter, taller, both), and returning
 *    to the live tail matches byte-for-byte a cold mount of the final state.
 * 2. IMMEDIATE RESUME: A resize while frozen immediately clears virtualScrollActive and resumes following the live tail.
 * 3. BOUNDED WIDTH: After a resize while frozen, every row on the viewport fits within the new terminal width.
 * 4. RESIZE STORM IDEMPOTENCE: Multiple successive resizes while frozen, including rapid alternating width storms,
 *    do not accumulate drift or duplicate chrome, and agree with a cold mount on return.
 * 5. SINGULAR CHROME: Hairlines and prompt rows never duplicate at any point during freeze, resize, or return.
 * 6. FRESH RE-FREEZE SNAPSHOT: Freezing again after a resize rebuilds a fresh snapshot at the new geometry rather
 *    than reusing stale snapshot data from before the resize.
 *
 * WHAT THIS SUITE DOES NOT CATCH:
 * - Multiplexer pane resize history rewriting. Multiplexer sessions keep native history and bypass rebuilds.
 * - Hardware terminal cursor jitter during in-flight SIGWINCH before frame settle.
 * - Terminal emulator viewport clipping when host terminal dimensions change before the process receives SIGWINCH.
 * - Dropping `geometryChanged` alone from line 4178 in non-multiplexer environments where `resizeRepaintsInPlace()`
 *   is false, because `geometryRebuild` sets `fullPaint = true`, which independently satisfies the resume condition.
 *
 * MUTATION GATE:
 * 1. Mutation (a): Drop `this.#virtualScrollTop = null;` from `#resumeLiveTail()` at tui.ts:1906.
 *    Result: RED. 4 tests failed:
 *    - "scroll back, resize, return to tail: the frame equals a cold mount at the new geometry" failed with 70 row discrepancies.
 *    - "the resize itself resumes the live tail immediately" failed with 40 cases reporting "virtualScrollActive remained true after resize".
 *    - "repeated resizes while frozen do not accumulate and agree with cold mount upon return" failed with 164 row discrepancies.
 *    - "freezing again after a resize and append rebuilds a fresh snapshot at the new geometry" failed: expected false, received true.
 * 2. Mutation (b): Drop `this.#scrollSnapshot = null;` from `#resumeLiveTail()` at tui.ts:1907.
 *    Result: RED. 1 test failed:
 *    - "freezing again after a resize and append rebuilds a fresh snapshot at the new geometry" failed: viewport in second freeze did not contain newly appended lines.
 * 3. Mutation (c): Change `windowTop = Math.max(this.#committedRows, frameLength - height, 0)` at tui.ts:4141 to use `frameLength - height - 1`.
 *    Result: RED. 1 test failed:
 *    - "scroll back, resize, return to tail: the frame equals a cold mount at the new geometry" failed with 26 row discrepancies (row 0 incremental="  › one" cold="  ┆ two").
 * 4. Mutation (d): Change `windowTop = Math.max(0, frameLength - height)` at tui.ts:4107 to `frameLength - height - 1`.
 *    Result: RED. 2 tests failed:
 *    - "scroll back, resize, return to tail: the frame equals a cold mount at the new geometry" failed with row discrepancies.
 *    - "repeated resizes while frozen do not accumulate and agree with cold mount upon return" failed with row discrepancies.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { stripAnsi } from "@veyyon/utils/strip-ansi";
import { initTheme } from "../src/modes/theme/theme";
import { runComposerOracleScenario } from "./helpers/composer-oracle-runner";
import {
	balanced,
	contentLine,
	contentLines,
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
	paintCold,
	paintIncrementally,
	type State,
	TIMINGS,
	WHEEL_UP,
} from "./helpers/renderer-differential";

interface ResizeTarget {
	name: string;
	width: (w: number) => number;
	height: (h: number) => number;
}

const RESIZE_TARGETS: readonly ResizeTarget[] = [
	{ name: "narrower", width: w => Math.max(20, w - 20), height: h => h },
	{ name: "wider", width: w => w + 20, height: h => h },
	{ name: "shorter", width: w => w, height: h => Math.max(6, h - 4) },
	{ name: "taller", width: w => w, height: h => h + 6 },
	{ name: "narrower+shorter", width: w => Math.max(20, w - 20), height: h => Math.max(6, h - 4) },
	{ name: "wider+taller", width: w => w + 20, height: h => h + 6 },
	{ name: "narrower+taller", width: w => Math.max(20, w - 20), height: h => h + 6 },
	{ name: "wider+shorter", width: w => w + 20, height: h => Math.max(6, h - 4) },
];

interface StartFixture {
	width: number;
	height: number;
	lines: number;
	editor: string;
}

const START_FIXTURES: readonly StartFixture[] = [
	{ width: 80, height: 16, lines: 50, editor: EDITOR_ONE },
	{ width: 80, height: 10, lines: 60, editor: EDITOR_TWO },
	{ width: 60, height: 12, lines: 40, editor: EDITOR_FIVE },
	{ width: 100, height: 8, lines: 45, editor: EDITOR_WRAPPING },
	{ width: 70, height: 14, lines: 35, editor: EDITOR_WIDE },
];

const NOTCH_VARIANTS: readonly number[] = [2, 6];

describe("a resize while the view is frozen lands on the right rows", () => {
	beforeAll(async () => {
		await initTheme(false);
	});

	it("scroll back, resize, return to tail: the frame equals a cold mount at the new geometry", async () => {
		const discrepancies: string[] = [];

		// Variant sweep derived dynamically from exported tables.
		for (const isolation of ISOLATION) {
			for (const timing of TIMINGS) {
				for (let i = 0; i < FLAVORS.length; i += 1) {
					const flavor = FLAVORS[i]!;
					const fixture = START_FIXTURES[i % START_FIXTURES.length]!;
					const notches = NOTCH_VARIANTS[i % NOTCH_VARIANTS.length]!;
					const target = RESIZE_TARGETS[i % RESIZE_TARGETS.length]!;

					const newWidth = target.width(fixture.width);
					const newHeight = target.height(fixture.height);

					const startState: State = {
						width: fixture.width,
						height: fixture.height,
						lines: fixture.lines,
						editor: fixture.editor,
						flavor,
					};

					const ops: Op[] = [
						{ kind: "scroll", notches },
						{ kind: "resize", width: newWidth, height: newHeight },
						{ kind: "return" },
					];

					expect(balanced(ops)).toBe(true);

					const label = `${describeState(startState)} -> ${describeOps(ops)} target=${target.name} timing=${timing} iso=${isolation ? "1" : "0"}`;
					const warm = await paintIncrementally(startState, ops, timing, isolation);
					const cold = await paintCold(warm.end, isolation);

					const diffs = disagreements(label, warm, cold);
					if (diffs.length > 0) {
						discrepancies.push(...diffs);
					}
				}
			}
		}

		expect(discrepancies).toEqual([]);
	}, 180000);

	it("the resize itself resumes the live tail immediately", async () => {
		const neverFroze: string[] = [];
		const failedToResume: string[] = [];
		const chromeFaults: string[] = [];

		for (const fixture of START_FIXTURES) {
			for (const notches of NOTCH_VARIANTS) {
				for (const target of RESIZE_TARGETS.slice(0, 4)) {
					const newWidth = target.width(fixture.width);
					const newHeight = target.height(fixture.height);
					const label = `${fixture.width}x${fixture.height}/${fixture.lines} notches=${notches} -> ${newWidth}x${newHeight} (${target.name})`;

					const scenario = await runComposerOracleScenario({
						width: fixture.width,
						height: fixture.height,
						transcriptLines: contentLines("plain", fixture.lines),
						editorText: fixture.editor,
						scrollIsolation: true,
						focused: true,
					});

					try {
						// 1. Scroll back to freeze the view.
						for (let n = 0; n < notches; n += 1) {
							scenario.terminal.sendInput(WHEEL_UP);
							await scenario.advance();
						}

						if (!scenario.tui.virtualScrollActive) {
							neverFroze.push(label);
						}

						// 2. Resize while frozen.
						scenario.terminal.resize(newWidth, newHeight);
						await scenario.advance();

						// 3. Engine must resume the live tail on resize.
						if (scenario.tui.virtualScrollActive) {
							failedToResume.push(`${label}: virtualScrollActive remained true after resize`);
						}

						// 4. Chrome must remain singular on the resumed view.
						const viewport = scenario.terminal.getViewport().slice();
						const chrome = countChrome(viewport);
						if (chrome.hairlines > 1 || chrome.prompts > 1) {
							chromeFaults.push(`${label}: hairlines=${chrome.hairlines} prompts=${chrome.prompts}`);
						}
					} finally {
						scenario.cleanUp();
					}
				}
			}
		}

		expect(neverFroze).toEqual([]);
		expect(failedToResume).toEqual([]);
		expect(chromeFaults).toEqual([]);
	}, 120000);

	it("no row exceeds the new terminal width after a resize while frozen", async () => {
		const widthViolations: string[] = [];

		for (const flavor of FLAVORS) {
			for (const fixture of START_FIXTURES.slice(0, 3)) {
				for (const target of [RESIZE_TARGETS[0]!, RESIZE_TARGETS[4]!]) {
					const newWidth = target.width(fixture.width);
					const newHeight = target.height(fixture.height);
					const label = `${flavor} ${fixture.width}x${fixture.height} -> ${newWidth}x${newHeight} (${target.name})`;

					const scenario = await runComposerOracleScenario({
						width: fixture.width,
						height: fixture.height,
						transcriptLines: contentLines(flavor, fixture.lines),
						editorText: fixture.editor,
						scrollIsolation: true,
						focused: true,
					});

					try {
						// Scroll back to freeze.
						scenario.terminal.sendInput(WHEEL_UP);
						await scenario.advance();
						scenario.terminal.sendInput(WHEEL_UP);
						await scenario.advance();

						// Resize while frozen.
						scenario.terminal.resize(newWidth, newHeight);
						await scenario.advance();

						// Check all viewport lines.
						const viewport = scenario.terminal.getViewport();
						for (let r = 0; r < viewport.length; r += 1) {
							const row = viewport[r]!;
							const stripped = stripAnsi(row);
							const w = Bun.stringWidth(stripped);
							if (w > newWidth) {
								widthViolations.push(`${label} row ${r}: width ${w} > ${newWidth}: ${JSON.stringify(row)}`);
							}
						}
					} finally {
						scenario.cleanUp();
					}
				}
			}
		}

		expect(widthViolations).toEqual([]);
	}, 120000);

	it("repeated resizes while frozen do not accumulate and agree with cold mount upon return", async () => {
		const discrepancies: string[] = [];

		// Alternating resize storms and multi-step resizing.
		const STORM_SEQUENCES: Array<{ name: string; ops: Op[] }> = [
			{
				name: "alternating-width-storm",
				ops: [
					{ kind: "scroll", notches: 4 },
					{ kind: "resize", width: 60, height: 16 },
					{ kind: "resize", width: 90, height: 16 },
					{ kind: "resize", width: 60, height: 16 },
					{ kind: "resize", width: 90, height: 16 },
					{ kind: "resize", width: 75, height: 16 },
					{ kind: "return" },
				],
			},
			{
				name: "progressive-dimension-churn",
				ops: [
					{ kind: "scroll", notches: 3 },
					{ kind: "resize", width: 70, height: 14 },
					{ kind: "resize", width: 60, height: 10 },
					{ kind: "resize", width: 85, height: 18 },
					{ kind: "resize", width: 80, height: 16 },
					{ kind: "return" },
				],
			},
			{
				name: "alternating-height-storm",
				ops: [
					{ kind: "scroll", notches: 5 },
					{ kind: "resize", width: 80, height: 10 },
					{ kind: "resize", width: 80, height: 20 },
					{ kind: "resize", width: 80, height: 8 },
					{ kind: "resize", width: 80, height: 16 },
					{ kind: "return" },
				],
			},
		];

		for (const storm of STORM_SEQUENCES) {
			expect(balanced(storm.ops)).toBe(true);

			for (const isolation of ISOLATION) {
				for (const timing of TIMINGS) {
					for (const flavor of ["plain", "wide", "wrapping"] as const) {
						const startState: State = {
							width: 80,
							height: 16,
							lines: 60,
							editor: EDITOR_ONE,
							flavor,
						};

						const label = `${storm.name} ${flavor} timing=${timing} iso=${isolation ? "1" : "0"}`;
						const warm = await paintIncrementally(startState, storm.ops, timing, isolation);
						const cold = await paintCold(warm.end, isolation);

						const diffs = disagreements(label, warm, cold);
						if (diffs.length > 0) {
							discrepancies.push(...diffs);
						}
					}
				}
			}
		}

		expect(discrepancies).toEqual([]);
	}, 180000);

	it("chrome stays singular throughout freeze, resize, and return", async () => {
		const chromeFaults: string[] = [];

		for (const modeState of MODE_STATES) {
			const scenario = await runComposerOracleScenario({
				width: 80,
				height: 16,
				transcriptLines: contentLines("plain", 45),
				editorText: EDITOR_TWO,
				modeState,
				scrollIsolation: true,
				focused: true,
			});

			try {
				const modeLabel = modeState ? Object.keys(modeState).join("+") : "default-mode";

				// Phase 1: Live initial state
				let chrome = countChrome(scenario.terminal.getViewport());
				if (chrome.hairlines > 1 || chrome.prompts > 1) {
					chromeFaults.push(`${modeLabel} initial: hairlines=${chrome.hairlines} prompts=${chrome.prompts}`);
				}

				// Phase 2: Frozen state
				scenario.terminal.sendInput(WHEEL_UP);
				await scenario.advance();
				scenario.terminal.sendInput(WHEEL_UP);
				await scenario.advance();

				chrome = countChrome(scenario.terminal.getViewport());
				if (chrome.hairlines > 1 || chrome.prompts > 1) {
					chromeFaults.push(`${modeLabel} frozen: hairlines=${chrome.hairlines} prompts=${chrome.prompts}`);
				}

				// Phase 3: Immediate post-resize state
				scenario.terminal.resize(65, 12);
				await scenario.advance();

				chrome = countChrome(scenario.terminal.getViewport());
				if (chrome.hairlines > 1 || chrome.prompts > 1) {
					chromeFaults.push(`${modeLabel} resized: hairlines=${chrome.hairlines} prompts=${chrome.prompts}`);
				}

				// Phase 4: Second resize before return
				scenario.terminal.resize(85, 18);
				await scenario.advance();

				chrome = countChrome(scenario.terminal.getViewport());
				if (chrome.hairlines > 1 || chrome.prompts > 1) {
					chromeFaults.push(`${modeLabel} second-resize: hairlines=${chrome.hairlines} prompts=${chrome.prompts}`);
				}
			} finally {
				scenario.cleanUp();
			}
		}

		expect(chromeFaults).toEqual([]);
	}, 120000);

	it("freezing again after a resize and append rebuilds a fresh snapshot at the new geometry", async () => {
		const staleSnapshotErrors: string[] = [];

		const scenario = await runComposerOracleScenario({
			width: 80,
			height: 16,
			transcriptLines: contentLines("plain", 40),
			editorText: EDITOR_ONE,
			scrollIsolation: true,
			focused: true,
		});

		try {
			// 1. Initial freeze at 80x16. Snapshot is captured for 40 lines at width 80.
			scenario.terminal.sendInput(WHEEL_UP);
			await scenario.advance();
			scenario.terminal.sendInput(WHEEL_UP);
			await scenario.advance();
			expect(scenario.tui.virtualScrollActive).toBe(true);

			// 2. Resize to 60x12 (resumes live tail, must clear #scrollSnapshot).
			scenario.terminal.resize(60, 12);
			await scenario.advance();
			expect(scenario.tui.virtualScrollActive).toBe(false);

			// 3. Append 20 more lines while at live tail (total 60 lines).
			for (let i = 0; i < 20; i += 1) {
				scenario.transcript.lines.push(contentLine("plain", 40 + i));
			}
			scenario.transcript.invalidate();
			await scenario.advance();

			// 4. Freeze again at 60x12.
			scenario.terminal.sendInput(WHEEL_UP);
			await scenario.advance();
			expect(scenario.tui.virtualScrollActive).toBe(true);

			// 5. The viewport must show the newly appended lines near the tail (e.g. line 0050+),
			// not a stale snapshot capped at line 0039 or formatted for width 80.
			const viewport = scenario.terminal.getViewport();
			const viewportText = viewport.join("\n");
			const hasNewLines = viewportText.includes("transcript-output-line-005");
			if (!hasNewLines) {
				staleSnapshotErrors.push(
					`viewport in second freeze did not contain newly appended lines: ${JSON.stringify(viewport)}`,
				);
			}

			for (let r = 0; r < viewport.length; r += 1) {
				const row = viewport[r]!;
				const stripped = stripAnsi(row);
				const w = Bun.stringWidth(stripped);
				if (w > 60) {
					staleSnapshotErrors.push(`re-frozen row ${r}: width ${w} > 60: ${JSON.stringify(row)}`);
				}
			}
		} finally {
			scenario.cleanUp();
		}

		expect(staleSnapshotErrors).toEqual([]);
	}, 120000);
});
