/**
 * Scrolling back and returning leaves the frame unchanged.
 *
 * WHY THIS SUITE EXISTS:
 * The scrolled-back view is the one state the differential in
 * an-incremental-paint-agrees-with-a-cold-mount.test.ts cannot judge: a cold mount is never
 * scrolled, so there is no ground truth to compare a frozen mid-transcript view against. That left
 * the path with no expectation-free check at all, and it is a path that has carried real defects --
 * the composer duplicating inside scrolled-back history is a fix already in this package's
 * changelog.
 *
 * A round trip needs no ground truth. Wheel up N notches, wheel back down N, and the viewport must
 * be byte-identical to what it was before the first notch. Any difference is state the scroll path
 * failed to restore, and a composer left behind in the returned frame is exactly what that looks
 * like.
 *
 * WHY EACH CASE DECLARES WHETHER IT SCROLLS:
 * A round trip over a view that never moved is green for the wrong reason, and it is the likely
 * outcome: without scroll isolation the TUI does not own the wheel at all, and a transcript
 * shorter than the viewport has nothing above it to reveal. Left unchecked, this suite would pass
 * with every wheel event going nowhere. So each case states whether it expects to move and that is
 * asserted per case, which makes the suite fail if wheel events stop reaching the scroll tape --
 * a silent regression a round-trip check alone cannot see.
 *
 * WHAT THIS SUITE DOES NOT CATCH:
 * - Whether the scrolled view itself is correct. It judges only that returning restores the frame,
 *   so a wrong-but-reversible scrolled frame passes. The oracles in composer-defect-sweep judge
 *   the scrolled frame's content.
 * - Native scrollback. Only the viewport is compared; rows the terminal has committed to history
 *   are outside it.
 * - Partial returns. Every case scrolls back by exactly the notches it scrolled up, so a clamp that
 *   loses a notch at either end is out of reach.
 * - A resize while scrolled back, and a transcript that grows while scrolled back. Both change what
 *   "returning" should mean and neither is driven here.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { initTheme } from "../src/modes/theme/theme";
import { runComposerOracleScenario } from "./helpers/composer-oracle-runner";

/** SGR wheel-up report at row 5, col 5. */
const WHEEL_UP = "\x1b[<64;5;5M";
/** SGR wheel-down report at row 5, col 5. */
const WHEEL_DOWN = "\x1b[<65;5;5M";

/** A terminal size and transcript depth, and whether that depth can scroll at all. */
interface Geometry {
	width: number;
	height: number;
	lines: number;
	/**
	 * Whether the composed frame is taller than the viewport, so there is something above the
	 * window to reveal. False for a transcript that fits with the composer inside one screen.
	 */
	deeperThanViewport: boolean;
}

const GEOMETRIES: readonly Geometry[] = [
	{ width: 80, height: 16, lines: 60, deeperThanViewport: true },
	{ width: 80, height: 10, lines: 200, deeperThanViewport: true },
	{ width: 80, height: 24, lines: 30, deeperThanViewport: true },
	{ width: 40, height: 8, lines: 80, deeperThanViewport: true },
	{ width: 120, height: 6, lines: 40, deeperThanViewport: true },
	{ width: 20, height: 30, lines: 90, deeperThanViewport: true },
	{ width: 80, height: 16, lines: 12, deeperThanViewport: true },
	// Six rows of transcript plus the composer still fit inside twenty-four, so the wheel has
	// nothing to reveal. The oracle docs call this shallow case out as unswept.
	{ width: 80, height: 24, lines: 6, deeperThanViewport: false },
];

/** Notch counts: one wheel event, a short drag, and a long one. */
const STEP_COUNTS: readonly number[] = [1, 3, 8];

/**
 * Scroll isolation off and on.
 *
 * On is the production default and is what hands the wheel to the TUI's virtual scroll tape. Off
 * leaves scrolling to the terminal's own scrollback, which never moves the composed viewport, so
 * those cases pin that gating rather than the round trip.
 */
const ISOLATION: readonly boolean[] = [false, true];

/** Ceiling for the whole sweep: every case mounts once and settles per notch, twice over. */
const SWEEP_BUDGET_MS = 120_000;

describe("scrolling back and returning leaves the frame unchanged", () => {
	beforeAll(async () => {
		await initTheme(false);
	});

	it(
		"restores the frame byte for byte, and only moves where the wheel is owned",
		async () => {
			const unrestored: string[] = [];
			const wrongMovement: string[] = [];

			for (const isolation of ISOLATION) {
				for (const geometry of GEOMETRIES) {
					for (const steps of STEP_COUNTS) {
						const label = `${geometry.width}x${geometry.height}/${geometry.lines} steps=${steps} isolation=${isolation ? "on" : "off"}`;
						const scenario = await runComposerOracleScenario({
							width: geometry.width,
							height: geometry.height,
							transcriptLines: geometry.lines,
							editorText: "run the build",
							scrollIsolation: isolation,
							focused: true,
						});
						try {
							const before = scenario.terminal.getViewport().slice();
							for (let i = 0; i < steps; i += 1) {
								scenario.terminal.sendInput(WHEEL_UP);
								await scenario.advance();
							}
							const scrolled = scenario.terminal.getViewport().slice();
							for (let i = 0; i < steps; i += 1) {
								scenario.terminal.sendInput(WHEEL_DOWN);
								await scenario.advance();
							}
							const after = scenario.terminal.getViewport().slice();

							// The wheel only reaches the tape when the TUI owns scrolling and there is
							// something above the window to reveal.
							const shouldMove = isolation && geometry.deeperThanViewport;
							const moved = scrolled.join("\n") !== before.join("\n");
							if (moved !== shouldMove) {
								wrongMovement.push(`${label}: moved=${moved} expected=${shouldMove}`);
							}

							for (let row = 0; row < Math.max(before.length, after.length); row += 1) {
								const start = before[row] ?? "<missing row>";
								const end = after[row] ?? "<missing row>";
								if (start !== end) {
									unrestored.push(
										`${label}: row ${row} before=${JSON.stringify(start)} after=${JSON.stringify(end)}`,
									);
								}
							}
						} finally {
							scenario.cleanUp();
						}
					}
				}
			}

			expect(wrongMovement).toEqual([]);
			expect(unrestored).toEqual([]);
		},
		SWEEP_BUDGET_MS,
	);
});
