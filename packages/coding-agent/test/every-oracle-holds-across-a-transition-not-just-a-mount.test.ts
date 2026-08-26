/**
 * Composer zone defect oracles hold across incremental state transitions (appends, shrinks, resizes, editor mutations, scroll freezing, overlays) rather than only on cold initial mounts.
 *
 * WHY THIS SUITE EXISTS:
 * Cold mounts settle exactly one frame from scratch and evaluate it in isolation.
 * Real terminal interactions, however, are stateful sequences: streaming tokens append
 * beneath a pinned footer, the editor grows and shrinks with multiline input, terminal
 * windows resize under multiplexers, mouse wheel events freeze the viewport into virtual
 * scrollback, and overlays composite on top of active content. Rendering defects
 * (such as misaligned footers, output bleeding past the hairline, broken scroll isolation,
 * or lost mouse routing) frequently manifest only in the transition between frames.
 * This suite drives dynamic Op sequences, evaluating all 12 composer oracles after every
 * single step under both per-step and coalesced timings.
 *
 * WHAT THIS SUITE DOES NOT CATCH:
 * - Color theme palette accuracy or 24-bit truecolor contrast fidelity.
 * - External terminal emulator escape parsing quirks outside Ghostty VirtualTerminal.
 * - Sixel / Kitty inline graphics protocol placement.
 *
 * MUTATION GATE:
 * 1. packages/tui/src/tui.ts:4141 — windowTop = Math.max(this.#committedRows, frameLength - height + 1, 0)
 *    Observed: 5 failing tests, 1728 red transition step failures.
 *    Failure text: "CardPadRow at screen row 6 has non-blank content or background styling: '  › run the build'."
 * 2. packages/tui/src/tui.ts:4224 — frame[frameLength - footerRows + 1 + (r - regionRows)] (virtual scroll footer slice offset)
 *    Observed: 3 failing tests, 219 red transition step failures.
 *    Failure text: "Virtual scroll footer row 0 ('') differs from live footer ('────────────────────────────────────────────────────────────────────────────────')."
 * 3. packages/tui/src/tui.ts:4232 — frame[windowTop + r + 1] (non-virtual scroll window slice offset)
 *    Observed: 7 failing tests, 1772 red transition step failures.
 *    Failure text: "CardPadRow at screen row 6 has non-blank content or background styling: '  › run the build'."
 */

import { beforeAll, describe, expect, it } from "bun:test";
import {
	COMPOSER_ORACLE_GUARANTEES,
	type ComposerOracleGuarantee,
	type OracleFailure,
} from "../src/modes/components/composer-defect-oracle";
import { initTheme } from "../src/modes/theme/theme";
import { runComposerOracleScenario } from "./helpers/composer-oracle-runner";
import {
	contentLine,
	contentLines,
	describeOps,
	describeState,
	EDITOR_FIVE,
	EDITOR_ONE,
	EDITOR_TWO,
	EDITOR_WIDE,
	EDITOR_WRAPPING,
	FLAVOR_MARK,
	FLAVORS,
	ISOLATION,
	MAX_RETURN_NOTCHES,
	MODE_STATES,
	type Op,
	OverlayMock,
	type State,
	TIMINGS,
	type Timing,
	WHEEL_DOWN,
	WHEEL_UP,
} from "./helpers/renderer-differential";

interface StepFailure {
	label: string;
	failures: OracleFailure[];
}

interface TransitionRunResult {
	evaluatedStatesCount: number;
	failures: StepFailure[];
}

/**
 * Drive an Op sequence, evaluating all defect oracles after every transition step.
 */
async function driveTransitionSequence(
	start: State,
	ops: readonly Op[],
	timing: Timing,
	scrollIsolation: boolean,
	oracleCounts: Map<ComposerOracleGuarantee, number>,
	evaluatedOpKinds?: Set<Op["kind"]>,
): Promise<TransitionRunResult & { overlayOpenSkippedCount: number }> {
	const scenario = await runComposerOracleScenario({
		width: start.width,
		height: start.height,
		transcriptLines: contentLines(start.flavor, start.lines),
		transcriptLineMarkers: [FLAVOR_MARK[start.flavor]],
		editorText: start.editor,
		modeState: start.modeState,
		statusMessage: start.statusMessage,
		scrollIsolation,
		focused: true,
	});

	const state: State = { ...start };
	const mountProbes = scenario.captureContext.probes;
	const overlays: Array<{ hide: () => void }> = [];
	const failures: StepFailure[] = [];
	let evaluatedStatesCount = 0;
	let overlayOpenSkippedCount = 0;

	const evaluateCurrentFrame = (opIndex: number, stepLabel: string, opKind?: Op["kind"]) => {
		// An open overlay composites over the composer zone; oracles judge the composer's
		// own painted rows, so skip while modal covers the screen and evaluate upon close.
		if (scenario.tui.hasOverlay()) {
			overlayOpenSkippedCount += 1;
			return;
		}
		evaluatedStatesCount += 1;
		if (opKind) {
			evaluatedOpKinds?.add(opKind);
		}
		const { evaluation } = scenario.recapture();
		for (const guarantee of evaluation.inspected) {
			oracleCounts.set(guarantee, (oracleCounts.get(guarantee) ?? 0) + 1);
		}
		if (!evaluation.passed) {
			failures.push({
				label: `${describeState(start)} -> ${describeOps(ops)} (step ${opIndex}: ${stepLabel}, timing=${timing}, iso=${scrollIsolation})`,
				failures: evaluation.failures,
			});
		}
	};
	try {
		for (let opIndex = 0; opIndex < ops.length; opIndex += 1) {
			const op = ops[opIndex]!;
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
			} else if (op.kind === "resize") {
				state.width = op.width;
				state.height = op.height;
				scenario.terminal.resize(state.width, state.height);
				// The capture reads geometry from its context, so a resize that does not reach it leaves
				// every following frame judged against the terminal's old size.
				scenario.captureContext.width = op.width;
				scenario.captureContext.height = op.height;
			} else if (op.kind === "overlay-open") {
				overlays.push(
					scenario.tui.showOverlay(new OverlayMock(op.rows), {
						fullscreen: op.fullscreen ?? false,
					}),
				);
			} else if (op.kind === "overlay-close") {
				overlays.pop()?.hide();
				scenario.tui.requestRender();
			} else if (op.kind === "scroll") {
				// Clicking a footer row while the view is frozen resumes the live tail, so the capture
				// stops probing until the view is back on the tail. The routing oracle is exercised on
				// every live-tail frame instead.
				scenario.captureContext.probes = null;
				for (let i = 0; i < op.notches; i += 1) {
					scenario.terminal.sendInput(WHEEL_UP);
					await scenario.advance();
				}
				scenario.captureContext.scrolledNotches += op.notches;
			} else if (op.kind === "return") {
				for (let i = 0; i < MAX_RETURN_NOTCHES && scenario.tui.virtualScrollActive; i += 1) {
					scenario.terminal.sendInput(WHEEL_DOWN);
					await scenario.advance();
				}
				scenario.captureContext.scrolledNotches = 0;
				scenario.captureContext.probes = mountProbes;
			}

			if (timing === "per-step") {
				if (op.kind !== "scroll" && op.kind !== "return") {
					await scenario.advance();
				}
				evaluateCurrentFrame(opIndex, op.kind, op.kind);
			}
		}

		if (timing === "coalesced") {
			await scenario.advance();
			evaluateCurrentFrame(ops.length - 1, "coalesced-end", ops[ops.length - 1]?.kind);
		}
		return {
			evaluatedStatesCount,
			overlayOpenSkippedCount,
			failures,
		};
	} finally {
		scenario.cleanUp();
	}
}

describe("composer defect oracle transition sweep", () => {
	beforeAll(async () => {
		await initTheme(false);
	});

	const oracleExecutionCounts = new Map<ComposerOracleGuarantee, number>();
	for (const id of COMPOSER_ORACLE_GUARANTEES) {
		oracleExecutionCounts.set(id, 0);
	}

	const SWEEP_GEOMETRIES = [
		{ width: 20, height: 6 },
		{ width: 80, height: 12 },
		{ width: 120, height: 24 },
	] as const;

	const SWEEP_SEQUENCE: readonly Op[] = [
		{ kind: "append", count: 6 },
		{ kind: "editor", text: EDITOR_TWO },
		{ kind: "scroll", notches: 2 },
		{ kind: "resize", width: 40, height: 8 },
		{ kind: "return" },
		{ kind: "shrink", count: 3 },
		{ kind: "overlay-open", rows: 3 },
		{ kind: "overlay-close" },
	];

	it("growing the transcript under a pinned footer maintains all defect oracles", async () => {
		const start: State = {
			width: 80,
			height: 12,
			lines: 2,
			flavor: "plain",
			editor: EDITOR_ONE,
		};
		const ops: Op[] = [
			{ kind: "append", count: 5 },
			{ kind: "append", count: 10 },
			{ kind: "append", count: 20 },
		];
		const result = await driveTransitionSequence(start, ops, "per-step", true, oracleExecutionCounts);
		expect(result.failures).toEqual([]);
		expect(result.evaluatedStatesCount).toBe(ops.length);
	}, 15000);

	it("shrinking the transcript under a pinned footer maintains all defect oracles", async () => {
		const start: State = {
			width: 80,
			height: 12,
			lines: 35,
			flavor: "ansi",
			editor: EDITOR_ONE,
		};
		const ops: Op[] = [
			{ kind: "shrink", count: 10 },
			{ kind: "shrink", count: 20 },
			{ kind: "shrink", count: 10 },
		];
		const result = await driveTransitionSequence(start, ops, "per-step", true, oracleExecutionCounts);
		expect(result.failures).toEqual([]);
		expect(result.evaluatedStatesCount).toBe(ops.length);
	}, 15000);

	it("resizing the terminal window maintains all defect oracles", async () => {
		const start: State = {
			width: 80,
			height: 12,
			lines: 10,
			flavor: "wide",
			editor: EDITOR_TWO,
		};
		const ops: Op[] = [
			{ kind: "scroll", notches: 2 },
			{ kind: "resize", width: 40, height: 8 },
			{ kind: "resize", width: 20, height: 6 },
			{ kind: "resize", width: 120, height: 24 },
			{ kind: "resize", width: 80, height: 12 },
		];
		const result = await driveTransitionSequence(start, ops, "per-step", true, oracleExecutionCounts);
		expect(result.failures).toEqual([]);
		expect(result.evaluatedStatesCount).toBe(ops.length);
	}, 15000);

	it("changing editor text and composer height maintains all defect oracles", async () => {
		const start: State = {
			width: 80,
			height: 12,
			lines: 8,
			flavor: "combining",
			editor: EDITOR_ONE,
		};
		const ops: Op[] = [
			{ kind: "editor", text: EDITOR_TWO },
			{ kind: "editor", text: EDITOR_FIVE },
			{ kind: "editor", text: EDITOR_WRAPPING },
			{ kind: "editor", text: EDITOR_WIDE },
			{ kind: "editor", text: "" },
		];
		const result = await driveTransitionSequence(start, ops, "per-step", true, oracleExecutionCounts);
		expect(result.failures).toEqual([]);
		expect(result.evaluatedStatesCount).toBe(ops.length);
	}, 15000);

	it("scroll freezing and returning to live tail maintains all defect oracles", async () => {
		const start: State = {
			width: 80,
			height: 12,
			lines: 40,
			flavor: "astral",
			editor: EDITOR_ONE,
		};
		const ops: Op[] = [{ kind: "scroll", notches: 2 }, { kind: "scroll", notches: 4 }, { kind: "return" }];
		const result = await driveTransitionSequence(start, ops, "per-step", true, oracleExecutionCounts);
		expect(result.failures).toEqual([]);
		expect(result.evaluatedStatesCount).toBe(ops.length);
	}, 15000);

	it("opening and closing overlays maintains all defect oracles", async () => {
		const start: State = {
			width: 80,
			height: 12,
			lines: 15,
			flavor: "wrapping",
			editor: EDITOR_ONE,
		};
		const ops: Op[] = [
			{ kind: "overlay-open", rows: 4 },
			{ kind: "overlay-close" },
			{ kind: "overlay-open", rows: 6, fullscreen: true },
			{ kind: "overlay-close" },
		];
		const result = await driveTransitionSequence(start, ops, "per-step", true, oracleExecutionCounts);
		expect(result.failures).toEqual([]);
		expect(result.evaluatedStatesCount).toBe(2);
		expect(result.overlayOpenSkippedCount).toBe(2);
	}, 15000);

	it("full cross-product transition sweep maintains all defect oracles across every step", async () => {
		const allFailures: StepFailure[] = [];
		let totalStatesJudged = 0;
		let totalOverlayOpenSkipped = 0;
		const evaluatedOpKinds = new Set<Op["kind"]>();

		const expectedTuples =
			SWEEP_GEOMETRIES.length * FLAVORS.length * TIMINGS.length * ISOLATION.length * MODE_STATES.length;
		let executedTuples = 0;

		for (const geom of SWEEP_GEOMETRIES) {
			for (const flavor of FLAVORS) {
				for (const timing of TIMINGS) {
					for (const isolation of ISOLATION) {
						for (const modeState of MODE_STATES) {
							executedTuples += 1;
							const start: State = {
								width: geom.width,
								height: geom.height,
								lines: 4,
								flavor,
								editor: EDITOR_ONE,
								modeState,
							};

							const result = await driveTransitionSequence(
								start,
								SWEEP_SEQUENCE,
								timing,
								isolation,
								oracleExecutionCounts,
								evaluatedOpKinds,
							);

							totalStatesJudged += result.evaluatedStatesCount;
							totalOverlayOpenSkipped += result.overlayOpenSkippedCount;
							if (result.failures.length > 0) {
								allFailures.push(...result.failures);
							}
						}
					}
				}
			}
		}

		// Assert sweep is not vacuous: every dimension in the cross product ran
		expect(executedTuples).toBe(expectedTuples);

		// Per-step runs evaluate 7 non-overlay steps (1 overlay-open is skipped while modal covers screen).
		// Coalesced runs evaluate 1 frame at sequence end (after overlay-close).
		// Total per (geom, flavor, iso, mode) tuple = 7 + 1 = 8 judged states.
		const tuplesPerTimingArm = SWEEP_GEOMETRIES.length * FLAVORS.length * ISOLATION.length * MODE_STATES.length;
		const expectedTotalJudgedStates = tuplesPerTimingArm * (SWEEP_SEQUENCE.length - 1 + 1);
		expect(totalStatesJudged).toBe(expectedTotalJudgedStates);

		// Pin the overlay-open skipped count across the per-step runs
		expect(totalOverlayOpenSkipped).toBe(tuplesPerTimingArm);

		// Every op kind the sequence contains, except the one that opens an overlay: a frame with a
		// modal over the composer is out of the oracles' scope. Pinned as a set rather than a count, so
		// an op kind that silently stops being driven names itself.
		expect([...evaluatedOpKinds].sort()).toEqual([
			"append",
			"editor",
			"overlay-close",
			"resize",
			"return",
			"scroll",
			"shrink",
		]);

		// Single assertion reporting all failures across the entire sweep
		expect(allFailures).toEqual([]);
	}, 600000);

	// Reads the counts every test above accumulated, so it has to be declared last in this file.
	it("every guarantee in COMPOSER_ORACLE_GUARANTEES was exercised across transitions", () => {
		const unexercisedOracles = COMPOSER_ORACLE_GUARANTEES.filter(id => (oracleExecutionCounts.get(id) ?? 0) === 0);

		// Pinned exact equality: every single one of the 12 oracles must be exercised.
		// None are unexercised because the transition sweep includes scroll freezing (testing
		// virtualScrollPreservesFooterStability), mouse routing probes, hairline/pad checks,
		// and multiline editor height mutations.
		expect(unexercisedOracles).toEqual([]);
	});
});
