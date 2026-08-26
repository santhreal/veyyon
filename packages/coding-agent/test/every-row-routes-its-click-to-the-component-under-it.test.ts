/**
 * Every row routes its click to the component under it.
 *
 * WHY THIS SUITE EXISTS:
 * Mouse routing in the terminal UI is pure coordinate arithmetic between the screen row,
 * the pinned footer's top row, and each child component's rendered line offset. When the
 * mouse is captured by the engine, a click anywhere on the screen must be dispatched to the
 * exact component occupying that screen row, with the local line reflecting the offset
 * within the target component. An off-by-one in this arithmetic can cause footer clicks to
 * misroute to the transcript, target the wrong child component, or deliver invalid local line
 * offsets to interactive controls like quiet zone chips or shortcut buttons.
 *
 * WHAT THIS SUITE DOES NOT CATCH:
 * - Drag-select text gestures outside the pinned footer. Text selection is handled by the host
 *   onSelectionAttempt callback rather than component-level routeMouse dispatch.
 * - SGR mouse tracking mode negotiation with real physical terminals. The runner operates on
 *   Ghostty VirtualTerminal with synthetic SGR sequences.
 * - Horizontal hit-testing within inline text segments of a single line. That is owned by
 *   individual component click handlers such as QuietZoneLine.onClick.
 *
 * MUTATION GATE:
 * 1. Shifting footerRowOffset by +1 in mouse dispatch (packages/tui/src/tui.ts line 3310:
 *    `this.#routeFooterMouse(event, event.row - footerRowOffset + 1)`) turns 1982 cases red with:
 *    "error: expect(received).toBe(expected) - Expected: \"footer:capabilityLine\", Received: \"footer:shortcuts\"".
 * 2. Shifting local line calculation in routeFooterMouse (packages/tui/src/tui.ts line 3163:
 *    `component.routeMouse(event, localRow + 1, event.col)`) turns 1982 cases red with:
 *    "error: expect(received).toBe(expected) - Expected: 0, Received: 1".
 * 3. Shifting column forwarding in routeFooterMouse (packages/tui/src/tui.ts line 3163:
 *    `component.routeMouse(event, localRow, event.col + 1)`) turns 1982 cases red with:
 *    "error: expect(received).toBe(expected) - Expected: 5, Received: 6".
 * 4. Off-by-one in segment frameRow bounds check (packages/tui/src/tui.ts line 3159:
 *    `if (frameRow <= segment.start || frameRow >= segment.start + segment.rowCount) continue;`)
 *    turns 1982 cases red with:
 *    "error: expect(received).toBe(expected) - Expected: \"footer:capabilityLine\", Received: null".
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { ThinkingLevel } from "@veyyon/agent-core";
import { initTheme } from "../src/modes/theme/theme";
import { type RunnerOptions, type RunnerResult, runComposerOracleScenario } from "./helpers/composer-oracle-runner";
import {
	contentLines,
	EDITOR_FIVE,
	EDITOR_ONE,
	EDITOR_TWO,
	EDITOR_WIDE,
	EDITOR_WRAPPING,
	FLAVORS,
	type Flavor,
	ISOLATION,
	MODE_STATES,
	TIMINGS,
	type Timing,
} from "./helpers/renderer-differential";

interface DerivedFooterBounds {
	capScreenTop: number | null;
	capScreenBottom: number | null;
	shortScreenTop: number | null;
	shortScreenBottom: number | null;
}

/**
 * Derive the screen row boundaries of routable footer children from the frame segments ledger.
 * This computes child boundaries dynamically without hardcoding row indices or component order.
 */
function deriveRoutableFooterBounds(result: RunnerResult): DerivedFooterBounds {
	const { frameState } = result;
	const { screenBounds, segments, pinnedFooterChildCount, pinnedFooterRows, totalFrameRows } = frameState;
	const footerStartFrameRow = totalFrameRows - pinnedFooterRows;

	const footerSegments = segments.slice(-pinnedFooterChildCount);
	const capSeg = footerSegments.find(s => s.componentName === "QuietZoneLine");
	const capScreenTop =
		capSeg && capSeg.rowCount > 0 ? screenBounds.footerRowOffset + (capSeg.startIndex - footerStartFrameRow) : null;
	const capScreenBottom = capScreenTop !== null && capSeg ? capScreenTop + capSeg.rowCount - 1 : null;
	const shortSeg = footerSegments.find(s => s.componentName === "ComposerShortcuts");

	const shortScreenTop =
		shortSeg && shortSeg.rowCount > 0
			? screenBounds.footerRowOffset + (shortSeg.startIndex - footerStartFrameRow)
			: null;
	const shortScreenBottom = shortScreenTop !== null && shortSeg ? shortScreenTop + shortSeg.rowCount - 1 : null;

	return {
		capScreenTop,
		capScreenBottom,
		shortScreenTop,
		shortScreenBottom,
	};
}

/**
 * Verify all mouse routing claims for a rendered frame scenario.
 */
function assertMouseRoutingClaims(result: RunnerResult, scrollIsolation: boolean): void {
	const { frameState } = result;
	const { screenBounds, mouseRouting, height } = frameState;
	// The runner probes every footer row and records where the click landed. A frame carrying no
	// routing record at all would satisfy every claim below without testing one, so the record's
	// presence is asserted rather than assumed.
	expect(mouseRouting, "the runner recorded no mouse routing for this frame").toBeDefined();
	if (!mouseRouting) return;
	const bounds = deriveRoutableFooterBounds(result);

	// Claim 1: A click on a footer row reaches a footer child, never the transcript.
	for (let r = screenBounds.footerTop; r <= screenBounds.footerBottom; r++) {
		if (r < 0 || r >= height) continue;
		const routing = mouseRouting.get(r);
		if (!routing) continue;

		expect(routing.routedTo).not.toBe("transcript");

		if (scrollIsolation) {
			if (bounds.capScreenTop !== null && bounds.capScreenBottom !== null) {
				if (r >= bounds.capScreenTop && r <= bounds.capScreenBottom) {
					expect(routing.routedTo).toBe("footer:capabilityLine");
				}
			}
			if (bounds.shortScreenTop !== null && bounds.shortScreenBottom !== null) {
				if (r >= bounds.shortScreenTop && r <= bounds.shortScreenBottom) {
					expect(routing.routedTo).toBe("footer:shortcuts");
				}
			}
		}
	}

	// Claim 2: A click above the footer never reaches a footer child.
	for (let r = 0; r < screenBounds.footerTop; r++) {
		if (r < 0 || r >= height) continue;
		const routing = mouseRouting.get(r);
		if (!routing) continue;

		const isFooterTarget = routing.routedTo?.startsWith("footer:") ?? false;
		expect(isFooterTarget).toBe(false);

		if (r <= screenBounds.contentBottom) {
			expect(routing.routedTo).toBe("transcript");
		}
	}

	// Claim 3: The local line is the row offset inside its child.
	// Claim 4: The column survives the round trip (column 5 remains column 5).
	for (const [r, routing] of mouseRouting.entries()) {
		if (routing.routedTo === "footer:capabilityLine") {
			expect(bounds.capScreenTop).not.toBeNull();
			const expectedLocalLine = r - bounds.capScreenTop!;
			expect(routing.localLine).toBe(expectedLocalLine);
			expect(routing.col).toBe(5);
		} else if (routing.routedTo === "footer:shortcuts") {
			expect(bounds.shortScreenTop).not.toBeNull();
			const expectedLocalLine = r - bounds.shortScreenTop!;
			expect(routing.localLine).toBe(expectedLocalLine);
			expect(routing.col).toBe(5);
		}
	}
}

describe("every row routes its click to the component under it", () => {
	beforeAll(async () => {
		await initTheme(false);
	});

	// Derive variant spaces from source at run time with fail-by-default checks
	it("derives all exported flavors without unrecorded opt-outs", () => {
		const knownFlavors: readonly Flavor[] = ["plain", "wide", "combining", "astral", "ansi", "wrapping"];
		expect(FLAVORS.slice().sort()).toEqual(knownFlavors.slice().sort());
	});

	it("derives all exported timings without unrecorded opt-outs", () => {
		const knownTimings: readonly Timing[] = ["per-step", "coalesced"];
		expect(TIMINGS.slice().sort()).toEqual(knownTimings.slice().sort());
	});

	it("derives all exported isolation states without unrecorded opt-outs", () => {
		const knownIsolation: readonly boolean[] = [false, true];
		expect(ISOLATION.slice().sort()).toEqual(knownIsolation.slice().sort());
	});

	it("derives all exported mode states without unrecorded opt-outs", () => {
		expect(MODE_STATES.length).toBe(6);
		const hasThinking = MODE_STATES.some(m => m?.thinkingLevel === ThinkingLevel.High);
		const hasBash = MODE_STATES.some(m => m?.bashMode === true);
		const hasPlan = MODE_STATES.some(m => m?.planMode === true);
		const hasBypass = MODE_STATES.some(m => m?.bypass === true);
		const hasSubagent = MODE_STATES.some(m => m?.focusedSubagent === true);
		const hasDefault = MODE_STATES.some(m => m === undefined);
		expect(hasThinking && hasBash && hasPlan && hasBypass && hasSubagent && hasDefault).toBe(true);
	});

	describe("sweeping geometries, flavors, isolation, mode states, and focus", () => {
		const widths = [30, 80, 120];
		const heights = [8, 12, 24];
		const transcriptDepths = [0, 3, 20];

		for (const width of widths) {
			for (const height of heights) {
				for (const lines of transcriptDepths) {
					for (const flavor of FLAVORS) {
						for (const isolation of ISOLATION) {
							for (const modeState of MODE_STATES) {
								for (const focused of [true, false]) {
									const modeName = modeState ? Object.keys(modeState).join("+") : "default";
									const label = `w${width} h${height} lines${lines} ${flavor} iso=${isolation} mode=${modeName} focus=${focused}`;

									it(label, async () => {
										const options: RunnerOptions = {
											width,
											height,
											transcriptLines: contentLines(flavor, lines),
											editorText: EDITOR_ONE,
											scrollIsolation: isolation,
											scrollOffset: 0,
											modeState,
											focused,
										};

										const res = await runComposerOracleScenario(options);
										try {
											assertMouseRoutingClaims(res, isolation);
										} finally {
											res.cleanUp();
										}
									});
								}
							}
						}
					}
				}
			}
		}
	});

	describe("sweeping multi-line editor heights and wrapping text", () => {
		const editorVariants = [
			{ name: "empty", text: "" },
			{ name: "two-lines", text: EDITOR_TWO },
			{ name: "five-lines", text: EDITOR_FIVE },
			{ name: "wrapping", text: EDITOR_WRAPPING },
			{ name: "wide", text: EDITOR_WIDE },
		];

		for (const { name, text } of editorVariants) {
			for (const height of [10, 24]) {
				for (const lines of [0, 15]) {
					const label = `editor=${name} h${height} lines=${lines}`;
					it(label, async () => {
						const options: RunnerOptions = {
							width: 80,
							height,
							transcriptLines: contentLines("plain", lines),
							editorText: text,
							scrollIsolation: true,
							scrollOffset: 0,
							focused: true,
						};

						const res = await runComposerOracleScenario(options);
						try {
							assertMouseRoutingClaims(res, true);
						} finally {
							res.cleanUp();
						}
					});
				}
			}
		}
	});

	describe("routing stability under frozen scrollback view (claim 5)", () => {
		const frozenGeometries = [
			{ width: 40, height: 10 },
			{ width: 80, height: 12 },
			{ width: 120, height: 20 },
		];
		const scrollOffsets = [1, 2, 4];
		const editors = [
			{ name: "one-line", text: EDITOR_ONE },
			{ name: "five-lines", text: EDITOR_FIVE },
		];

		for (const geo of frozenGeometries) {
			for (const scrollOffset of scrollOffsets) {
				for (const editor of editors) {
					const label = `w${geo.width} h${geo.height} scrollOffset=${scrollOffset} editor=${editor.name}`;
					it(label, async () => {
						const options: RunnerOptions = {
							width: geo.width,
							height: geo.height,
							transcriptLines: contentLines("plain", 35),
							editorText: editor.text,
							scrollIsolation: true,
							scrollOffset,
							focused: true,
						};

						const res = await runComposerOracleScenario(options);
						try {
							expect(res.frameState.virtualScrollTop).toBe(scrollOffset);
							assertMouseRoutingClaims(res, true);
						} finally {
							res.cleanUp();
						}
					});
				}
			}
		}
	});
});
