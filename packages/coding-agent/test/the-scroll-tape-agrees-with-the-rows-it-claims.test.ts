/**
 * The scroll tape counters and committed row accounting agree with physical scrollback.
 *
 * WHY THIS SUITE EXISTS:
 * The TUI engine maintains three internal counters to track row commits and virtual scrolling:
 * `committedRows` (rows declared permanently scrolled off above the live viewport),
 * `scrollTapeRows` (rows retained on the virtual scroll tape), and `virtualScrollNewRows`
 * (rows appended while the view is frozen in virtual scroll). The engine derives `windowTop`
 * directly from `committedRows` (at tui.ts:2762 and 4141), so any drift between these counters
 * and the physical scrollback buffer mis-slices every subsequent frame. Prior tests checked
 * visual grid output without verifying that the engine's internal counters agreed with
 * `VirtualTerminal.getScrollBuffer()`.
 *
 * WHAT THIS SUITE DOES NOT CATCH:
 * - Direct native terminal scrollback clearing via platform escape sequences.
 * - Alternate screen buffer switching where native scrollback is bypassed.
 * - Hardware terminal emulation differences in scrollback line eviction limits.
 *
 * MUTATION GATE:
 * 1. Dropping `this.#virtualScrollTop = null` in `#resumeLiveTail()` (packages/tui/src/tui.ts:1906):
 *    Turns 24 cases red in the virtualScrollNewRows suite with:
 *    "80x16/plain: failed to return to live tail after wheel down",
 *    "80x16/plain: virtualScrollNewRows did not reset to 0 upon return to tail: got 11".
 * 2. Off-by-one in `committedRows` update in `#emitUpdate` (`this.#committedRows = chunkTo + 1` at packages/tui/src/tui.ts:5334):
 *    Turns 96 cases red in the physical scrollback agreement suite with:
 *    "80x16/plain/iso=false/per-step: physicalScrollback=39 !== committedRows=42 (composed=57)".
 * 3. Dropping rows from scroll tape in `#appendScrollTape` (`for (let i = from + 1; ...)` at packages/tui/src/tui.ts:1740):
 *    Turns 96 cases red in the physical scrollback agreement suite with:
 *    "80x16/plain/iso=false/per-step: scrollTapeRows=35 !== committedRows=39 (physicalScrollback=39)".
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { initTheme } from "../src/modes/theme/theme";
import { runComposerOracleScenario } from "./helpers/composer-oracle-runner";
import {
	contentLine,
	contentLines,
	FLAVORS,
	ISOLATION,
	TIMINGS,
	WHEEL_DOWN,
	WHEEL_UP,
} from "./helpers/renderer-differential";

interface Geometry {
	width: number;
	height: number;
	initialLines: number;
}

const BOUNDS_GEOMETRIES: readonly Geometry[] = [
	// Underfills viewport
	{ width: 80, height: 24, initialLines: 2 },
	{ width: 60, height: 20, initialLines: 4 },
	// Near viewport boundary
	{ width: 80, height: 16, initialLines: 9 },
	// Overfills viewport
	{ width: 80, height: 12, initialLines: 20 },
	{ width: 40, height: 8, initialLines: 15 },
	{ width: 100, height: 10, initialLines: 30 },
];

const SCROLLBACK_GEOMETRIES: readonly Geometry[] = [
	{ width: 80, height: 16, initialLines: 5 },
	{ width: 40, height: 10, initialLines: 5 },
	{ width: 120, height: 24, initialLines: 5 },
	{ width: 60, height: 8, initialLines: 5 },
];

const FROZEN_GEOMETRIES: readonly Geometry[] = [
	{ width: 80, height: 16, initialLines: 40 },
	{ width: 60, height: 12, initialLines: 30 },
	{ width: 100, height: 20, initialLines: 50 },
	{ width: 40, height: 10, initialLines: 25 },
];

const SWEEP_TIMEOUT_MS = 120_000;

describe("the scroll tape agrees with the rows it claims", () => {
	beforeAll(async () => {
		await initTheme(false);
	});

	it(
		"committedRows never exceeds composedFrameRows and is monotonic under appends",
		async () => {
			const boundsFaults: string[] = [];
			const monotonicityFaults: string[] = [];

			for (const geom of BOUNDS_GEOMETRIES) {
				for (const flavor of FLAVORS) {
					for (const isolation of ISOLATION) {
						for (const timing of TIMINGS) {
							const label = `${geom.width}x${geom.height}/init=${geom.initialLines}/${flavor}/iso=${isolation}/${timing}`;
							const scenario = await runComposerOracleScenario({
								width: geom.width,
								height: geom.height,
								transcriptLines: contentLines(flavor, geom.initialLines),
								editorText: "run the build",
								scrollIsolation: isolation,
								focused: true,
							});
							try {
								let prevCommitted = scenario.tui.committedRows;
								let composed = scenario.tui.composedFrameRows;

								if (prevCommitted < 0 || prevCommitted > composed) {
									boundsFaults.push(
										`${label} initial: committedRows=${prevCommitted} out of bounds [0, ${composed}]`,
									);
								}

								const appendBatches = [1, 3, 7, 15, 25];
								let currentLines = geom.initialLines;

								for (const batch of appendBatches) {
									for (let i = 0; i < batch; i += 1) {
										scenario.transcript.lines.push(contentLine(flavor, currentLines + i));
									}
									currentLines += batch;
									scenario.transcript.invalidate();

									if (timing === "per-step") {
										await scenario.advance();
										const currCommitted = scenario.tui.committedRows;
										composed = scenario.tui.composedFrameRows;

										if (currCommitted < 0 || currCommitted > composed) {
											boundsFaults.push(
												`${label} batch +${batch}: committedRows=${currCommitted} out of bounds [0, ${composed}]`,
											);
										}
										if (currCommitted < prevCommitted) {
											monotonicityFaults.push(
												`${label} batch +${batch}: committedRows decreased from ${prevCommitted} to ${currCommitted}`,
											);
										}
										prevCommitted = currCommitted;
									}
								}

								if (timing === "coalesced") {
									await scenario.advance();
									const currCommitted = scenario.tui.committedRows;
									composed = scenario.tui.composedFrameRows;

									if (currCommitted < 0 || currCommitted > composed) {
										boundsFaults.push(
											`${label} coalesced: committedRows=${currCommitted} out of bounds [0, ${composed}]`,
										);
									}
									if (currCommitted < prevCommitted) {
										monotonicityFaults.push(
											`${label} coalesced: committedRows decreased from ${prevCommitted} to ${currCommitted}`,
										);
									}
								}
							} finally {
								scenario.cleanUp();
							}
						}
					}
				}
			}

			expect(boundsFaults).toEqual([]);
			expect(monotonicityFaults).toEqual([]);
		},
		SWEEP_TIMEOUT_MS,
	);

	it(
		"counters agree with physical scrollback across geometries and content flavors",
		async () => {
			const scrollbackFaults: string[] = [];

			for (const geom of SCROLLBACK_GEOMETRIES) {
				for (const flavor of FLAVORS) {
					for (const isolation of ISOLATION) {
						for (const timing of TIMINGS) {
							const label = `${geom.width}x${geom.height}/${flavor}/iso=${isolation}/${timing}`;
							const scenario = await runComposerOracleScenario({
								width: geom.width,
								height: geom.height,
								transcriptLines: contentLines(flavor, geom.initialLines),
								editorText: "inspect scrollback",
								scrollIsolation: isolation,
								focused: true,
							});
							try {
								const appendBatches = [10, 20, 15];
								let currentLines = geom.initialLines;

								for (const batch of appendBatches) {
									for (let i = 0; i < batch; i += 1) {
										scenario.transcript.lines.push(contentLine(flavor, currentLines + i));
									}
									currentLines += batch;
									scenario.transcript.invalidate();

									if (timing === "per-step") {
										await scenario.advance();
									}
								}

								if (timing === "coalesced") {
									await scenario.advance();
								}

								const scrollBuf = scenario.terminal.getScrollBuffer();
								const physicalScrollback = scrollBuf.length - geom.height;
								const committed = scenario.tui.committedRows;
								const tape = scenario.tui.scrollTapeRows;
								const composed = scenario.tui.composedFrameRows;

								if (physicalScrollback !== committed) {
									scrollbackFaults.push(
										`${label}: physicalScrollback=${physicalScrollback} !== committedRows=${committed} (composed=${composed})`,
									);
								}
								if (tape !== committed) {
									scrollbackFaults.push(
										`${label}: scrollTapeRows=${tape} !== committedRows=${committed} (physicalScrollback=${physicalScrollback})`,
									);
								}
							} finally {
								scenario.cleanUp();
							}
						}
					}
				}
			}

			expect(scrollbackFaults).toEqual([]);
		},
		SWEEP_TIMEOUT_MS,
	);

	it(
		"virtualScrollNewRows tracks appended rows while frozen and resets upon returning to tail",
		async () => {
			const neverFroze: string[] = [];
			const counterFaults: string[] = [];

			for (const geom of FROZEN_GEOMETRIES) {
				for (const flavor of FLAVORS) {
					const label = `${geom.width}x${geom.height}/${flavor}`;
					const scenario = await runComposerOracleScenario({
						width: geom.width,
						height: geom.height,
						transcriptLines: contentLines(flavor, geom.initialLines),
						editorText: "track new rows",
						scrollIsolation: true,
						focused: true,
					});
					try {
						const scrollNotches = 3;
						for (let i = 0; i < scrollNotches; i += 1) {
							scenario.terminal.sendInput(WHEEL_UP);
							await scenario.advance();
						}

						if (!scenario.tui.virtualScrollActive) {
							neverFroze.push(label);
							continue;
						}

						const baselineNewRows = scenario.tui.virtualScrollNewRows;
						const committedAtFreeze = scenario.tui.committedRows;
						let totalAppended = 0;
						const appendBatches = [4, 7, 12];
						let currentLineCount = geom.initialLines;

						for (const batch of appendBatches) {
							for (let i = 0; i < batch; i += 1) {
								scenario.transcript.lines.push(contentLine(flavor, currentLineCount + i));
							}
							currentLineCount += batch;
							totalAppended += batch;
							scenario.transcript.invalidate();
							await scenario.advance();

							// virtualScrollNewRows increases by exactly the number of appended rows
							const delta = scenario.tui.virtualScrollNewRows - baselineNewRows;
							if (delta !== totalAppended) {
								counterFaults.push(
									`${label}: virtualScrollNewRows delta=${delta} !== totalAppended=${totalAppended} (current=${scenario.tui.virtualScrollNewRows}, baseline=${baselineNewRows})`,
								);
							}

							// commits must remain frozen while in virtual scroll
							if (scenario.tui.committedRows !== committedAtFreeze) {
								counterFaults.push(
									`${label}: committedRows changed while frozen from ${committedAtFreeze} to ${scenario.tui.committedRows}`,
								);
							}
						}

						for (let i = 0; i < 100 && scenario.tui.virtualScrollActive; i += 1) {
							scenario.terminal.sendInput(WHEEL_DOWN);
							await scenario.advance();
						}

						if (scenario.tui.virtualScrollActive) {
							counterFaults.push(`${label}: failed to return to live tail after wheel down`);
						}
						if (scenario.tui.virtualScrollNewRows !== 0) {
							counterFaults.push(
								`${label}: virtualScrollNewRows did not reset to 0 upon return to tail: got ${scenario.tui.virtualScrollNewRows}`,
							);
						}
					} finally {
						scenario.cleanUp();
					}
				}
			}

			expect(neverFroze).toEqual([]);
			expect(counterFaults).toEqual([]);
		},
		SWEEP_TIMEOUT_MS,
	);

	it(
		"scrollTapeRows does not shrink while the view is frozen",
		async () => {
			const tapeShrinkFaults: string[] = [];

			for (const geom of FROZEN_GEOMETRIES) {
				for (const flavor of FLAVORS) {
					const label = `${geom.width}x${geom.height}/${flavor}`;
					const scenario = await runComposerOracleScenario({
						width: geom.width,
						height: geom.height,
						transcriptLines: contentLines(flavor, geom.initialLines),
						editorText: "tape stability",
						scrollIsolation: true,
						focused: true,
					});
					try {
						const scrollNotches = 3;
						for (let i = 0; i < scrollNotches; i += 1) {
							scenario.terminal.sendInput(WHEEL_UP);
							await scenario.advance();
						}

						const tapeRowsAtFreeze = scenario.tui.scrollTapeRows;
						const appendBatches = [3, 6, 9];
						let currentLineCount = geom.initialLines;

						for (const batch of appendBatches) {
							for (let i = 0; i < batch; i += 1) {
								scenario.transcript.lines.push(contentLine(flavor, currentLineCount + i));
							}
							currentLineCount += batch;
							scenario.transcript.invalidate();
							await scenario.advance();

							if (scenario.tui.scrollTapeRows < tapeRowsAtFreeze) {
								tapeShrinkFaults.push(
									`${label}: scrollTapeRows shrank from ${tapeRowsAtFreeze} to ${scenario.tui.scrollTapeRows} during batch +${batch}`,
								);
							}
						}
					} finally {
						scenario.cleanUp();
					}
				}
			}

			expect(tapeShrinkFaults).toEqual([]);
		},
		SWEEP_TIMEOUT_MS,
	);
});
