import { LARGE_SCROLL } from "./constants";
import { bufferReflectsFrame, expectedDriverScrollbackBuffer, historySaturated } from "./driver-shadow";
import type { AssertionsContext } from "./driver-state";
import {
	firstMismatchIndex,
	fixedViewportSlice,
	normalizeLines,
	sameLines,
	sameLinesAllowingMarkDrift,
	scrollbackProbePositions,
	windowAround,
} from "./expected-frame";
import type { AppliedOperation } from "./operations";
import type { Snapshot } from "./types";

// The shadow tape and the physical buffer must scroll in lockstep: outside
// gesture replays (checkpoints, geometry) the only thing that ever pushes
// rows into native scrollback is a commit, and every commit appends to the
// tape in the same write. Any disagreement means the ledgers diverged —
// catch it at the op where it happens instead of N ops later when the
// content mismatch surfaces.
export function assertTapeScrollParity(
	context: AssertionsContext,
	op: AppliedOperation,
	before: Snapshot,
	after: Snapshot,
	index: number,
): void {
	if (!context.traits.strictNativeScrollback) return;
	if (op.checkpoint || op.geometryChanged) return;
	if (historySaturated(before, context.scenario.scrollback) || historySaturated(after, context.scenario.scrollback))
		return;
	const physicalDelta = after.position.baseY - before.position.baseY;
	const tapeDelta = after.shadowTapeLength - before.shadowTapeLength;
	if (physicalDelta !== tapeDelta) {
		context.fail("tape/physical scroll parity", op, before, after, index, {
			physicalDelta,
			tapeDelta,
		});
	}
}

export function assertCleanBufferWhenAligned(
	context: AssertionsContext,
	op: AppliedOperation,
	before: Snapshot,
	after: Snapshot,
	index: number,
): void {
	if (!context.traits.strictNativeScrollback || !after.atBottom || op.geometryChanged) return;
	if (context.hasVisibleOverlay()) return;
	if (!bufferReflectsFrame(before.buffer, before.frame, before.height, context.scenario.scrollback)) return;
	const expected = expectedDriverScrollbackBuffer(context.shadow, after.height, context.scenario.scrollback);
	if (after.buffer.length !== expected.length) return;
	if (!sameLinesAllowingMarkDrift(after.buffer, expected)) {
		const mismatch = firstMismatchIndex(after.buffer, expected);
		context.fail("aligned buffer fidelity", op, before, after, index, {
			expectedLength: expected.length,
			actualLength: after.buffer.length,
			firstMismatch: mismatch,
			expectedWindow: windowAround(expected, mismatch),
			actualWindow: windowAround(after.buffer, mismatch),
		});
	}
}

export function assertNoFrameNeutralScrollbackGrowth(
	context: AssertionsContext,
	op: AppliedOperation,
	before: Snapshot,
	after: Snapshot,
	index: number,
): void {
	if (context.hasVisibleOverlay()) return;
	if (!context.traits.strictNativeScrollback || op.checkpoint || op.geometryChanged) return;
	if (!before.atBottom || !after.atBottom) return;
	if (!sameLines(before.frame, after.frame)) return;
	if (after.buffer.length > before.buffer.length) {
		if (bufferReflectsFrame(after.buffer, after.frame, after.height, context.scenario.scrollback)) return;
		// A frame-neutral OP is not a frame-neutral SEQUENCE: a transient
		// tall block inside the op (highWaterPreviewCollapse streams a
		// preview past the viewport, then collapses back to the original
		// frame) legitimately commits its overflow rows into history, and
		// with scrollback rebuild disabled the engine may not erase them
		// ("duplication, never loss"). Every legitimate growth row is a
		// commit, and every commit appends to the tape in the same write —
		// so growth beyond the op's tape growth is a leak (rows entering
		// history that the engine never accounted as committed).
		const tapeDelta = Math.max(0, after.shadowTapeLength - before.shadowTapeLength);
		const growth = after.buffer.length - before.buffer.length;
		if (growth <= tapeDelta) return;
		context.fail("frame-neutral scrollback growth", op, before, after, index, {
			beforeLength: before.buffer.length,
			afterLength: after.buffer.length,
			tapeDelta,
		});
	}
}

export function assertScrolledDeferral(
	context: AssertionsContext,
	op: AppliedOperation,
	before: Snapshot,
	after: Snapshot,
	index: number,
): void {
	if (!op.mutatesContent || before.atBottom) return;
	if (op.mutatesViewport || op.geometryChanged || op.checkpoint) return;
	if (
		context.traits.viewportProbe !== "known" &&
		!context.traits.conptyHostScrollbackUnobservable &&
		!context.traits.ed3ScrollbackEraseRisk
	)
		return;

	// The engine's one documented history rewrite: a committed-prefix
	// divergence (a scrolled-off row whose source produced different bytes)
	// erases native scrollback with a single ED3 and replays the frame, so the
	// block lands exactly once instead of being recommitted below its stale
	// copy. `divergenceRebuild` in `TUI.#doRender` takes that path without
	// consulting the reader's position — there is no viewport probe, and
	// exactly-once history is the recorded product decision, so neither the
	// reader's offset nor the rows above it survive the replay by contract.
	// Hold the rebuild to the fidelity the at-bottom path demands instead of
	// skipping it: the history it wrote is exactly what the engine recorded as
	// committed. Only history is judged — an overlay borrows the grid and
	// paints live rows the committed record never holds — and only where the
	// engine owns native scrollback: a multiplexer pane keeps its own history
	// (the engine never ED3s there), which `assertMultiplexerPaneHistoryGrowth`
	// bounds instead.
	if (after.redraws !== before.redraws) {
		if (!context.traits.strictNativeScrollback) return;
		const rebuilt = expectedDriverScrollbackBuffer(context.shadow, after.height, context.scenario.scrollback);
		const historyRows = Math.min(after.position.baseY, after.buffer.length, rebuilt.length);
		const actualHistory = after.buffer.slice(0, historyRows);
		const expectedHistory = rebuilt.slice(0, historyRows);
		if (!sameLinesAllowingMarkDrift(actualHistory, expectedHistory)) {
			const mismatch = firstMismatchIndex(actualHistory, expectedHistory);
			context.fail("rebuilt history diverged from the committed record", op, before, after, index, {
				historyRows,
				expectedLength: rebuilt.length,
				actualLength: after.buffer.length,
				firstMismatch: mismatch,
				expectedWindow: windowAround(expectedHistory, mismatch),
				actualWindow: windowAround(actualHistory, mismatch),
			});
		}
		return;
	}
	if (after.position.viewportY !== before.position.viewportY) {
		context.fail("scrolled viewport moved during content mutation", op, before, after, index, {
			expectedViewportY: before.position.viewportY,
			actualViewportY: after.position.viewportY,
		});
	}

	// The anti-yank contract while scrolled into history: the viewport must not
	// move (asserted above) and the visible rows that come from committed
	// scrollback (history) must not be rewritten by a deferred content mutation.
	// Rows below the history boundary belong to the live region and may legitimately
	// repaint — e.g. a deferred shrink pads and repaints the live viewport, and a
	// partial scroll (by < height) keeps the top live row on screen.
	//
	// Saturated history is the one legitimate exception (seed 0x40593834):
	// once baseY sits at the line cap, every commit EVICTS the oldest history
	// row, and under an offset-pinned viewport the visible content slides up
	// beneath the scrolled reader — a full-scrollback artifact, not a stray
	// write. Skip row stability only when a commit actually happened this op
	// (tape grew); a history row changing with zero commits is still a bug.
	const scrolledTapeDelta = Math.max(0, after.shadowTapeLength - before.shadowTapeLength);
	if (
		(historySaturated(before, context.scenario.scrollback) || historySaturated(after, context.scenario.scrollback)) &&
		scrolledTapeDelta > 0
	)
		return;
	const historyVisible = Math.max(0, Math.min(before.position.baseY - before.position.viewportY, before.height));
	for (let i = 0; i < historyVisible; i++) {
		if (after.view[i] !== before.view[i]) {
			context.fail("scrolled history row rewritten during deferred content mutation", op, before, after, index, {
				row: i,
				historyVisible,
				beforeRow: before.view[i] ?? null,
				afterRow: after.view[i] ?? null,
				beforeBaseY: before.position.baseY,
				afterBaseY: after.position.baseY,
				beforeViewportY: before.position.viewportY,
				afterViewportY: after.position.viewportY,
			});
		}
	}
}

// Multiplexer panes never receive a destructive scrollback clear (the
// renderer forces clearScrollback off inside tmux/screen/zellij because pane
// history is intentionally preserved), so any full-frame replay during live
// rendering appends a complete duplicate copy of the transcript to pane
// history. Users see every transcript row twice (or more) when scrolling
// back, and the per-frame write cost becomes O(frame). Pane history may grow
// exactly by the rows the shadow ledger committed during the op (appends,
// plus backfill of a chunk frozen during an overlay or geometry frame);
// anything beyond that is a replay leaking into preserved history. Geometry
// frames are exempt except pure height resizes, where xterm/tmux reflow is
// bounded: a height shrink moves at most (oldHeight - newHeight) rows into
// pane history — width changes rewrap pane history with unbounded row
// deltas and cannot be bounded from here.
export function assertMultiplexerPaneHistoryGrowth(
	context: AssertionsContext,
	op: AppliedOperation,
	before: Snapshot,
	after: Snapshot,
	index: number,
): void {
	if (!context.traits.preservesPaneHistory) return;
	if (op.checkpoint) return;
	const heightOnlyResize = op.kind === "resizeHeight";
	if (op.geometryChanged && !heightOnlyResize) return;
	const reflowAllowance = heightOnlyResize ? Math.max(0, before.height - after.height) : 0;
	const deltaBaseY = after.position.baseY - before.position.baseY;
	if (deltaBaseY <= 0) return;
	const committedDelta = Math.max(0, after.shadowTapeLength - before.shadowTapeLength);
	const allowedGrowth = committedDelta + reflowAllowance;
	if (deltaBaseY > allowedGrowth) {
		context.fail("multiplexer pane history grew faster than committed rows", op, before, after, index, {
			deltaBaseY,
			allowedGrowth,
			committedDelta,
			expected: "live frames must not replay the transcript into preserved pane history",
		});
	}
}

export function assertHistoryPrefixStability(
	context: AssertionsContext,
	op: AppliedOperation,
	before: Snapshot,
	after: Snapshot,
	index: number,
): void {
	if (!context.traits.strictNativeScrollback) return;
	if (historySaturated(before, context.scenario.scrollback) || historySaturated(after, context.scenario.scrollback))
		return;
	if (!op.mutatesContent || before.redraws !== after.redraws) return;
	const prefixLength = Math.max(0, Math.min(before.position.viewportY, before.buffer.length));
	const beforePrefix = before.buffer.slice(0, prefixLength);
	const afterPrefix = after.buffer.slice(0, prefixLength);
	if (!sameLines(beforePrefix, afterPrefix)) {
		context.fail("scrollback prefix changed without redraw", op, before, after, index, {
			prefixLength,
			beforePrefix,
			afterPrefix,
		});
	}
}

export function assertNativeScrollbackReplay(
	context: AssertionsContext,
	op: AppliedOperation,
	before: Snapshot,
	after: Snapshot,
	index: number,
): void {
	if (!context.traits.strictNativeScrollback) return;
	if (context.hasVisibleOverlay()) return;
	if (!after.atBottom) return;
	if (!op.mutatesContent && !op.forcedRender && !op.checkpoint && !op.geometryChanged) return;
	const expected = expectedDriverScrollbackBuffer(context.shadow, after.height, context.scenario.scrollback);
	if (!sameLinesAllowingMarkDrift(after.buffer, expected)) {
		const mismatch = firstMismatchIndex(after.buffer, expected);
		context.fail("native scrollback buffer fidelity", op, before, after, index, {
			expectedLength: expected.length,
			actualLength: after.buffer.length,
			firstMismatch: mismatch,
			expectedWindow: windowAround(expected, mismatch),
			actualWindow: windowAround(after.buffer, mismatch),
		});
	}

	const probes = scrollbackProbePositions(after.position.baseY, expected.length, after.height);
	try {
		for (const viewportY of probes) {
			const current = context.term.getBufferPosition().viewportY;
			context.term.scrollLines(viewportY - current);
			const actual = normalizeLines(context.term.getViewport());
			const expectedView = fixedViewportSlice(expected, viewportY, after.height);
			if (!sameLinesAllowingMarkDrift(actual, expectedView)) {
				context.fail("native scrollback viewport fidelity", op, before, after, index, {
					viewportY,
					expected: expectedView,
					actual,
				});
			}
		}
	} finally {
		context.term.scrollLines(LARGE_SCROLL);
	}
}

export function assertCleanBuffer(
	context: AssertionsContext,
	op: AppliedOperation,
	before: Snapshot,
	after: Snapshot,
	index: number,
): void {
	if (context.hasVisibleOverlay()) return;
	const expected = expectedDriverScrollbackBuffer(context.shadow, after.height, context.scenario.scrollback);
	if (!sameLinesAllowingMarkDrift(after.buffer, expected)) {
		context.fail("clean checkpoint reconstruction", op, before, after, index, {
			expectedLength: expected.length,
			actualLength: after.buffer.length,
		});
	}
}
