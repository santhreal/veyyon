/**
 * A frozen view maps every segment to the row it paints on.
 *
 * WHY THIS SUITE EXISTS:
 * The oracles judge the terminal grid, so each one has to turn a frame row into a screen row. That
 * conversion was `segment.startIndex - windowTopRow`, which is the live-tail mapping for a segment
 * that scrolls. The pinned footer does not scroll: it is painted at the bottom of the screen
 * whatever the transcript is doing, and while the view is scrolled back the rows above it come from
 * a frozen slice whose top is `virtualScrollTop`, not `windowTopRow`. Applying the content mapping
 * to a footer segment while the view was frozen was wrong in two directions at once, and the
 * transcript depth decided which:
 *
 * - A frame overflowing the viewport by a few rows mapped a CardPadRow onto a footer row. The
 *   padding oracle then read the capability line, found text where it wanted blank air, and failed
 *   a state the renderer had painted correctly. `docs/internal/renderer-defect-oracle.md` recorded
 *   this as a known false positive and the sweep steered around it by deriving `scrollOffset` as
 *   `transcriptCount > height ? 2 : 0`.
 * - A frame overflowing by more than a screen mapped the pad past the end of the viewport, where
 *   the bounds check dropped it. That half was never recorded, because it fails nothing: every
 *   deep scrolled-back state simply had no padding coverage at all. A silent hole outranks a false
 *   positive, since a false positive is eventually investigated.
 *
 * `screenRowForSegment` now locates a footer segment from the footer's own top row and a content
 * segment from whichever window is on screen. It is a strict generalisation: for a live-tail state
 * it returns exactly what the old subtraction returned, which claim 4 pins.
 *
 * WHY THE SNAPSHOT AND NOT THE ENGINE:
 * Whether the view is frozen is asserted from `frameState.virtualScrollTop`, captured when the grid
 * was read, and never from `tui.virtualScrollActive` afterwards. The runner probes mouse routing
 * after it reads the grid, and those clicks can resume the live tail, so the engine's own getter
 * reports a different answer by then. A suite that asked the engine would sometimes conclude the
 * state it just judged was never frozen.
 *
 * WHAT THIS SUITE DOES NOT CATCH:
 * - Content segments while frozen. The transcript is one segment in this mount, so the content
 *   branch of the mapping is exercised but never with several stacked content segments.
 * - A footer whose children change height between the compose pass and the read. The ledger is
 *   rebuilt by re-rendering, so both sides see the same heights by construction.
 * - Whether the row the oracle inspects is the row the ENGINE painted that segment on. This suite
 *   proves the mapping is consistent and in range, and the padding oracle's own assertion proves
 *   the row is blank, but nothing here reads the engine's internal placement.
 *
 * MUTATION GATE:
 * Restoring the old mapping (`screenRowForSegment` returning `segment.startIndex - windowTopRow`
 * for every segment) turns claims 1 and 2 red together: claim 1 reports
 * `composerCardPadsAreUnpaintedAir` on the shallow-overflow states, and claim 2 reports the deep
 * states mapping a pad to a row past the viewport. Recorded results are in the commit that added
 * this file.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { type ComposerOracleFrameState, screenRowForSegment } from "../src/modes/components/composer-defect-oracle";
import { initTheme } from "../src/modes/theme/theme";
import { runComposerOracleScenario } from "./helpers/composer-oracle-runner";
import { contentLines, FLAVORS, ISOLATION } from "./helpers/renderer-differential";

/** Terminal heights, from one that barely holds the composer to a roomy one. */
const HEIGHTS: readonly number[] = [10, 16, 24];

/**
 * Transcript depths, chosen relative to the heights above so that every relationship between the
 * frame and the viewport is represented: shorter than the screen, overflowing by a few rows, and
 * overflowing by more than a screen. The shallow band is where the false positive lived and the
 * deep band is where the silent hole lived, so a sweep that misses either proves nothing.
 */
const DEPTHS: readonly number[] = [0, 2, 6, 12, 20, 40];

/** Wheel notches to walk back before the grid is read. Zero stays on the live tail. */
const OFFSETS: readonly number[] = [0, 1, 2, 3];

/** Screen rows a segment's first row could occupy, for every CardPadRow in the ledger. */
function padRows(state: ComposerOracleFrameState): (number | null)[] {
	const rows: (number | null)[] = [];
	for (let i = 0; i < state.segments.length; i += 1) {
		const segment = state.segments[i]!;
		if (segment.componentName === "CardPadRow" && segment.rowCount > 0) {
			rows.push(screenRowForSegment(state, i));
		}
	}
	return rows;
}

describe("a frozen view maps every segment to the row it paints on", () => {
	// The sweep is driven once and judged by three tests. Asserting both categories inside one test
	// aborts at the first failure, which leaves the second claim ungated: a mutation that breaks
	// both would only ever be observed breaking one.
	const oracleFailures: string[] = [];
	const skippedPads: string[] = [];
	let frozenStates = 0;
	let inspectedPads = 0;
	let casesDriven = 0;

	beforeAll(async () => {
		await initTheme(false);
		for (const isolation of ISOLATION) {
			for (const height of HEIGHTS) {
				for (const depth of DEPTHS) {
					for (const offset of OFFSETS) {
						const scenario = await runComposerOracleScenario({
							width: 80,
							height,
							transcriptLines: depth,
							editorText: "run the build",
							scrollIsolation: isolation,
							scrollOffset: offset,
						});
						try {
							const state = scenario.frameState;
							const label = `iso=${isolation} h${height} lines${depth} off${offset} total=${state.totalFrameRows} vst=${String(state.virtualScrollTop)}`;
							casesDriven += 1;
							if (state.virtualScrollTop !== null) frozenStates += 1;

							for (const failure of scenario.evaluation.failures ?? []) {
								oracleFailures.push(`${label}: ${failure.oracle}: ${failure.message}`);
							}

							// Every pad the ledger carries must land on a row this viewport
							// actually has, or the oracle silently inspects nothing.
							for (const row of padRows(state)) {
								if (row === null || row >= state.rawViewportLines.length) {
									skippedPads.push(
										`${label}: pad mapped to ${String(row)}, viewport has ${state.rawViewportLines.length} rows`,
									);
								} else {
									inspectedPads += 1;
								}
							}
						} finally {
							scenario.cleanUp();
						}
					}
				}
			}
		}
	}, 900_000);

	it("reaches the frozen path, so the claims below are not vacuous", () => {
		expect(casesDriven).toBe(ISOLATION.length * HEIGHTS.length * DEPTHS.length * OFFSETS.length);
		expect(frozenStates).toBeGreaterThan(0);
	});

	it("judges every scrolled-back state without a false failure", () => {
		expect(oracleFailures).toEqual([]);
	});

	it("inspects every pad the ledger carries rather than mapping it off screen", () => {
		expect(skippedPads).toEqual([]);
		// Two pads per state, so this also pins that the ledger was read at all.
		expect(inspectedPads).toBe(ISOLATION.length * HEIGHTS.length * DEPTHS.length * OFFSETS.length * 2);
	});

	it("maps a footer segment the same way whether or not the content flavour changes", async () => {
		// The mapping is arithmetic over the ledger, so content that changes row WIDTH must not
		// change which ROW a footer segment lands on. A flavour-dependent answer would mean the
		// mapping is reading painted content rather than the ledger.
		const answers = new Map<string, string>();
		for (const flavor of FLAVORS) {
			const scenario = await runComposerOracleScenario({
				width: 80,
				height: 16,
				transcriptLines: contentLines(flavor, 20),
				editorText: "run the build",
				scrollIsolation: true,
				scrollOffset: 2,
			});
			try {
				const state = scenario.frameState;
				const footerFirst = state.segments.length - state.pinnedFooterChildCount;
				const mapped = state.segments
					.slice(footerFirst)
					.map((_seg, i) => String(screenRowForSegment(state, footerFirst + i)))
					.join(",");
				answers.set(flavor, mapped);
			} finally {
				scenario.cleanUp();
			}
		}
		const distinct = new Set(answers.values());
		expect([...distinct].length, `flavour-dependent footer mapping: ${JSON.stringify([...answers])}`).toBe(1);
	}, 600_000);

	it("returns the live-tail answer unchanged for a state that is not scrolled back", async () => {
		// Claim 4. The fix generalises the mapping; it must not move a row in the state the old
		// subtraction already got right, which is every live-tail state.
		const drifted: string[] = [];
		for (const height of HEIGHTS) {
			for (const depth of DEPTHS) {
				const scenario = await runComposerOracleScenario({
					width: 80,
					height,
					transcriptLines: depth,
					editorText: "run the build",
					scrollIsolation: true,
				});
				try {
					const state = scenario.frameState;
					expect(state.virtualScrollTop).toBeNull();
					for (let i = 0; i < state.segments.length; i += 1) {
						const legacy = state.segments[i]!.startIndex - state.windowTopRow;
						const mapped = screenRowForSegment(state, i);
						if (mapped !== null && mapped !== legacy) {
							drifted.push(
								`h${height} lines${depth} segment ${i} (${state.segments[i]!.componentName}): mapped=${mapped} legacy=${legacy}`,
							);
						}
					}
				} finally {
					scenario.cleanUp();
				}
			}
		}
		expect(drifted).toEqual([]);
	}, 600_000);
});
