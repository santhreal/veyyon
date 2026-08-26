/**
 * Output that streams in while scrolled back leaves the view alone.
 *
 * WHY THIS SUITE EXISTS:
 * This is the scenario #920 described: a bash result streaming into the transcript while a second
 * composer appeared partway up the screen, overlapping tool output. The reported defect was never
 * reproduced, and the suites written for it drive growth from the live tail, where the view follows
 * the newest row. Reading back through a long result is when a user is most likely to be scrolled
 * up, and a frozen view is a different render path: the transcript region reads a snapshot built
 * when the view froze, while the pinned footer stays live at the bottom of the screen.
 *
 * Four invariants, none of which needs an authored expectation:
 *
 *  1. NO DRIFT. While the view is frozen, appending rows must not move it. That is the whole point
 *     of freezing, and it is the one the reader would notice first.
 *  2. ONE COMPOSER. Never more than one hairline and one prompt row on screen, counted rather than
 *     detected, because `some(...)` is true whether a row was repainted in place or drawn again
 *     below itself. This is the shape #920 reported.
 *  3. RETURNING IS EXACT. Walking back to the tail must land on the same frame as a cold mount at
 *     the grown transcript length, so the growth that happened out of sight is not lost.
 *  4. RE-FREEZING IS NOT STALE. Freezing a second time must agree with a cold mount frozen the same
 *     way. The frozen slice is built once with `??=`, so a resume that leaves the previous snapshot
 *     behind serves pre-growth rows to the next reader who scrolls up.
 *
 * WHY THE FROZEN COUNT IS ASSERTED:
 * Every invariant above is vacuous if the wheel never froze anything, and that is the easy way for
 * this suite to pass while testing nothing. The count of cases that actually froze is asserted
 * against the case table, so a wheel event that stops reaching the scroll tape turns this red
 * instead of quietly making it meaningless.
 *
 * WHAT THIS SUITE DOES NOT CATCH:
 * - A resize while scrolled back. That changes what returning should mean and is not driven here.
 * - Native scrollback. Only the viewport is compared.
 * - A real tool result's own component. The transcript is a double returning plain rows, so
 *   wrapping, ANSI and inline images inside a streamed result are not exercised, and #920's report
 *   involved a real bash result.
 * - Whether the frozen slice shows the correct rows on the first freeze. Invariant 4 compares a
 *   re-freeze against a cold mount, so a first freeze that is wrong in the same way on both sides
 *   agrees with itself.
 * - Partial returns. Cases walk all the way back to the tail.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { initTheme } from "../src/modes/theme/theme";
import { runComposerOracleScenario } from "./helpers/composer-oracle-runner";
import {
	compareGrids,
	contentLine,
	countChrome,
	MAX_RETURN_NOTCHES,
	WHEEL_DOWN,
	WHEEL_UP,
} from "./helpers/renderer-differential";

/** One streaming-while-scrolled-back scenario. */
interface Case {
	width: number;
	height: number;
	lines: number;
	/** Wheel notches back before the streaming starts. */
	upNotches: number;
	/** Append rounds, each one settled, standing in for a streaming result. */
	appendBatches: number;
	/** Rows appended per round. */
	perBatch: number;
}

/**
 * Every case has a transcript deeper than its viewport, so the wheel has somewhere to go and the
 * view genuinely freezes. Depths and notch counts vary so the frozen anchor sits at different
 * distances from both ends of the scroll space.
 */
const CASES: readonly Case[] = [
	{ width: 80, height: 16, lines: 60, upNotches: 2, appendBatches: 6, perBatch: 3 },
	{ width: 80, height: 16, lines: 60, upNotches: 5, appendBatches: 12, perBatch: 5 },
	{ width: 80, height: 10, lines: 200, upNotches: 3, appendBatches: 8, perBatch: 4 },
	{ width: 80, height: 24, lines: 30, upNotches: 1, appendBatches: 4, perBatch: 2 },
	{ width: 40, height: 8, lines: 80, upNotches: 4, appendBatches: 10, perBatch: 3 },
	{ width: 120, height: 6, lines: 40, upNotches: 2, appendBatches: 6, perBatch: 6 },
	{ width: 20, height: 30, lines: 90, upNotches: 3, appendBatches: 5, perBatch: 4 },
	{ width: 80, height: 16, lines: 12, upNotches: 1, appendBatches: 5, perBatch: 3 },
];

/** Ceiling for the whole sweep: each case mounts twice and settles once per notch and per batch. */
const SWEEP_BUDGET_MS = 120_000;

describe("output that streams in while scrolled back leaves the view alone", () => {
	beforeAll(async () => {
		await initTheme(false);
	});

	it(
		"holds the frozen view, keeps one composer, and returns to the grown tail",
		async () => {
			const drift: string[] = [];
			const chromeFaults: string[] = [];
			const tailMismatch: string[] = [];
			const staleSnapshot: string[] = [];
			const neverFroze: string[] = [];

			for (const testCase of CASES) {
				const label = `${testCase.width}x${testCase.height}/${testCase.lines} up=${testCase.upNotches} +${testCase.appendBatches}x${testCase.perBatch}`;
				const scenario = await runComposerOracleScenario({
					width: testCase.width,
					height: testCase.height,
					transcriptLines: testCase.lines,
					editorText: "run the build",
					scrollIsolation: true,
					focused: true,
				});
				let total = testCase.lines;
				try {
					for (let i = 0; i < testCase.upNotches; i += 1) {
						scenario.terminal.sendInput(WHEEL_UP);
						await scenario.advance();
					}
					const frozen = scenario.terminal.getViewport().slice();
					if (!scenario.tui.virtualScrollActive) neverFroze.push(label);

					for (let batch = 0; batch < testCase.appendBatches; batch += 1) {
						for (let i = 0; i < testCase.perBatch; i += 1) {
							scenario.transcript.lines.push(contentLine("plain", total + i));
						}
						total += testCase.perBatch;
						scenario.transcript.invalidate();
						await scenario.advance();

						const now = scenario.terminal.getViewport().slice();
						const chrome = countChrome(now);
						if (chrome.hairlines > 1 || chrome.prompts > 1) {
							chromeFaults.push(
								`${label} batch=${batch}: hairlines=${chrome.hairlines} prompts=${chrome.prompts}`,
							);
						}
						compareGrids(drift, `${label} batch=${batch}`, "frozen", frozen, "now", now);
					}

					for (let i = 0; i < MAX_RETURN_NOTCHES; i += 1) {
						if (!scenario.tui.virtualScrollActive) break;
						scenario.terminal.sendInput(WHEEL_DOWN);
						await scenario.advance();
					}
					const returned = scenario.terminal.getViewport().slice();

					for (let i = 0; i < testCase.upNotches; i += 1) {
						scenario.terminal.sendInput(WHEEL_UP);
						await scenario.advance();
					}
					const refrozen = scenario.terminal.getViewport().slice();

					const cold = await runComposerOracleScenario({
						width: testCase.width,
						height: testCase.height,
						transcriptLines: total,
						editorText: "run the build",
						scrollIsolation: true,
						focused: true,
					});
					try {
						compareGrids(tailMismatch, label, "returned", returned, "cold", cold.terminal.getViewport().slice());
						for (let i = 0; i < testCase.upNotches; i += 1) {
							cold.terminal.sendInput(WHEEL_UP);
							await cold.advance();
						}
						compareGrids(staleSnapshot, label, "refrozen", refrozen, "cold", cold.terminal.getViewport().slice());
					} finally {
						cold.cleanUp();
					}
				} finally {
					scenario.cleanUp();
				}
			}

			// Assert first: every invariant below is vacuous on a view that never froze.
			expect(neverFroze).toEqual([]);
			expect(drift).toEqual([]);
			expect(chromeFaults).toEqual([]);
			expect(tailMismatch).toEqual([]);
			expect(staleSnapshot).toEqual([]);
		},
		SWEEP_BUDGET_MS,
	);
});
