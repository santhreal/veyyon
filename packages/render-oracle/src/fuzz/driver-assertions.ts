import {
	assertCleanBuffer,
	assertCleanBufferWhenAligned,
	assertHistoryPrefixStability,
	assertMultiplexerPaneHistoryGrowth,
	assertNativeScrollbackReplay,
	assertNoFrameNeutralScrollbackGrowth,
	assertScrolledDeferral,
	assertTapeScrollParity,
} from "./driver-scrollback-assertions";
import { bufferReflectsFrame, consumeAnsiChunk, getShadowWindowTop } from "./driver-shadow";
import type { AssertionsContext } from "./driver-state";
import {
	duplicateNonblankLines,
	expectedViewport,
	isExpectedOverlayVisible,
	NONSPACING_MARKS,
	sameLinesAllowingMarkDrift,
} from "./expected-frame";
import type { AppliedOperation } from "./operations";
import { cursorObject } from "./snapshot";
import type { Snapshot } from "./types";

export {
	assertCleanBuffer,
	assertCleanBufferWhenAligned,
	assertHistoryPrefixStability,
	assertMultiplexerPaneHistoryGrowth,
	assertNativeScrollbackReplay,
	assertNoFrameNeutralScrollbackGrowth,
	assertScrolledDeferral,
	assertTapeScrollParity,
};

export function assertOracles(
	context: AssertionsContext,
	op: AppliedOperation,
	before: Snapshot,
	after: Snapshot,
	index: number,
): void {
	assertSyncOutputDiscipline(context, op, before, after, index);
	assertTapeScrollParity(context, op, before, after, index);
	assertViewportFidelity(context, op, before, after, index);
	assertCleanBufferWhenAligned(context, op, before, after, index);
	assertNoFrameNeutralScrollbackGrowth(context, op, before, after, index);
	assertCursor(context, op, before, after, index);
	assertScrolledDeferral(context, op, before, after, index);
	assertMultiplexerPaneHistoryGrowth(context, op, before, after, index);
	assertHistoryPrefixStability(context, op, before, after, index);
	assertNativeScrollbackReplay(context, op, before, after, index);
	assertNoStaleOverlaySentinels(context, op, before, after, index);
	assertUniqueContentNoUnexpectedDuplicates(context, op, before, after, index);
	assertNoBackgroundBleed(context, op, before, after, index);
	// Native scrollback must reconcile to an exact bottom-anchored copy of the
	// transcript at checkpoints where the renderer actually performed a
	// destructive/native-history rebuild. Unknown ConPTY host scrollback and
	// ED3-risk terminals with no positive at-tail probe intentionally keep dirty
	// history deferred; asserting a clean buffer there would contradict the
	// anti-yank contract. tmux is excluded: its pane history is preserved, not
	// rebuilt, so the buffer snapshot is the view, not history.
	if (
		op.checkpoint &&
		!context.traits.preservesPaneHistory &&
		(context.traits.strictNativeScrollback || op.reconcilesNativeScrollback === true)
	) {
		assertCleanBuffer(context, op, before, after, index);
	}
}

// Synchronized-output (DEC 2026) + autowrap (DECAWM) bracket discipline.
// Every paint write opens with PAINT_BEGIN (`\x1b[?2026h\x1b[?7l`) and closes
// with PAINT_END (`\x1b[?7h\x1b[?2026l`); the standalone cursor write brackets
// its move in `\x1b[?2026h…\x1b[?2026l`. The contract: across the entire byte
// stream the brackets must strictly alternate open/close (depth stays in
// {0,1}) and return to 0 at every op boundary. A renderer path that opens a
// sync block and returns before closing it freezes the terminal until the
// next keystroke — the "output froze until I pressed a key" bug class — and
// an unbalanced `\x1b[?7l` leaves autowrap off, producing staircase trails on
// the next non-TUI write. There is no terminal-side timeout for an unclosed
// 2026 block (Contour synchronized-output spec), so the renderer alone owns
// the invariant. Audits incrementally from #writeLogScanned to stay O(bytes).
export function assertSyncOutputDiscipline(
	context: AssertionsContext,
	op: AppliedOperation,
	before: Snapshot,
	after: Snapshot,
	index: number,
): void {
	const shadow = context.shadow;
	for (; shadow.writeLogScanned < shadow.writeLog.length; shadow.writeLogScanned++) {
		consumeAnsiChunk(shadow, context.traits, shadow.writeLog[shadow.writeLogScanned]!, (msg, extra) =>
			context.fail(msg, op, before, after, index, extra),
		);
	}
	if (shadow.ansiCarry.length > 0) {
		context.fail("incomplete private CSI sequence at op boundary", op, before, after, index, {
			carry: shadow.ansiCarry,
		});
	}
	// At an op boundary every paint/cursor write the op emitted has completed,
	// so both brackets must be balanced. A nonzero depth means a paint path
	// left the terminal inside a sync block or with autowrap disabled.
	if (shadow.syncDepth !== 0) {
		context.fail("synchronized-output left open at op boundary", op, before, after, index, {
			syncDepth: shadow.syncDepth,
		});
	}
	if (shadow.autowrapOffDepth !== 0) {
		context.fail("autowrap left disabled at op boundary", op, before, after, index, {
			autowrapOffDepth: shadow.autowrapOffDepth,
		});
	}
}

// SGR/BCE bleed: background attributes must appear only on viewport cells
// whose logical content carries background SGR. Stress content includes
// deliberately unreset background sequences (backgroundStyledText); the
// renderer's per-line terminators (#applyLineResets / LINE_TERMINATOR) must
// confine the color to its own text cells. A leak means BCE (back-color-erase,
// which xterm.js and most real terminals implement) paints \x1b[K / \x1b[2K
// erased cells with the stale background — the user-visible "random colored
// blank cells" bug class. Text-only oracles cannot see this; this oracle reads
// cell attributes.
export function assertNoBackgroundBleed(
	context: AssertionsContext,
	op: AppliedOperation,
	before: Snapshot,
	after: Snapshot,
	index: number,
): void {
	if (context.hasVisibleOverlay()) return;
	if (!after.atBottom) return;
	const expectedView = expectedViewport(after.frame, after.height);
	const viewportTop = Math.max(0, after.frame.length - after.height);
	for (let row = 0; row < after.height; row++) {
		const backgroundColumns = after.viewBackgroundColumns[row] ?? [];
		if (backgroundColumns.length === 0) continue;
		// Judge only rows whose text matches the frame row they map to: a
		// deferred/stale row (text mismatch) has ambiguous provenance and is
		// re-checked once a repaint re-aligns it. backgroundStyledText labels are
		// never whitespace-only, so a stale background row cannot masquerade as a
		// legitimately blank row.
		if ((after.view[row] ?? "") !== (expectedView[row] ?? "")) continue;
		const frameRow = viewportTop + row;
		const expectedColumns = new Set(after.frameBackgroundColumns[frameRow] ?? []);
		const unexpectedColumns = backgroundColumns.filter(column => !expectedColumns.has(column));
		if (unexpectedColumns.length > 0) {
			context.fail("background SGR bleed", op, before, after, index, {
				row,
				frameRow,
				backgroundColumns,
				unexpectedColumns,
				expectedColumns: [...expectedColumns],
				rowText: after.view[row] ?? null,
				expected: "background-colored cells only on columns whose content carries background SGR",
			});
		}
	}
}

export function assertViewportFidelity(
	context: AssertionsContext,
	op: AppliedOperation,
	before: Snapshot,
	after: Snapshot,
	index: number,
): void {
	if (context.hasVisibleOverlay()) return;
	if (!after.atBottom) return;
	// The grid must show the shadow window slice: the frame tail anchored at
	// the ledger's window top (which floors at the committed boundary after
	// a shrink, leaving blank rows below the content instead of re-showing
	// committed rows). Multiplexer mode only checks geometry frames — tmux
	// reflows the pane grid on resize and the renderer must repaint the
	// whole visible window at the new geometry.
	if (context.traits.preservesPaneHistory && !op.geometryChanged) return;
	const expected: string[] = [];
	const windowTop = getShadowWindowTop(context.shadow);
	for (let r = 0; r < after.height; r++) {
		expected.push(after.frame[windowTop + r] ?? "");
	}
	if (!sameLinesAllowingMarkDrift(after.view, expected)) {
		context.fail(
			context.traits.foregroundStreaming ? "foreground-stream viewport fidelity" : "viewport fidelity",
			op,
			before,
			after,
			index,
			{ expected, shadowWindowTop: windowTop },
		);
	}
}

export function assertCursor(
	context: AssertionsContext,
	op: AppliedOperation,
	before: Snapshot,
	after: Snapshot,
	index: number,
): void {
	if (context.hasVisibleOverlay()) return;
	if (after.cursor.row < 0 || after.cursor.row >= after.height || after.cursor.col < 0) {
		context.fail("cursor bounds", op, before, after, index, { cursor: cursorObject(after) });
	}
	const expectedCursor = after.expectedCursor;
	if (expectedCursor === null || !after.atBottom) return;
	if (!bufferReflectsFrame(after.buffer, after.frame, after.height, context.scenario.scrollback)) return;
	if (after.cursor.row !== expectedCursor.row) {
		context.fail("focused cursor row", op, before, after, index, {
			expectedRow: expectedCursor.row,
			actualRow: after.cursor.row,
			actualCol: after.cursor.col,
		});
	}
	// Cursor column is a terminal cell offset, not a UTF-16 length. When the
	// marker is at or beyond the right margin, CHA clamping/pending-wrap details
	// are terminal-dependent, so only assert exact columns that fit in-view.
	if (expectedCursor.col < after.width && after.cursor.col !== expectedCursor.col) {
		context.fail("focused cursor column", op, before, after, index, {
			expectedCol: expectedCursor.col,
			actualCol: after.cursor.col,
			actualRow: after.cursor.row,
		});
	}
}

export function assertNoStaleOverlaySentinels(
	context: AssertionsContext,
	op: AppliedOperation,
	before: Snapshot,
	after: Snapshot,
	index: number,
): void {
	if (context.hiddenOverlaySentinels.size === 0) return;
	const visibleSentinels = new Set(
		context.overlays
			.filter(entry => isExpectedOverlayVisible(entry, context.term.columns, context.term.rows))
			.map(entry => entry.sentinel),
	);
	// Multiplexers preserve pane history and do not allow the renderer to scrub
	// scrollback safely. A hidden overlay must disappear from the live viewport,
	// but the viewport can itself be parked in pane history while scrolled.
	if (context.traits.preservesPaneHistory && !after.atBottom) return;
	const nativeText = context.traits.preservesPaneHistory
		? after.view.join("\n")
		: `${after.buffer.join("\n")}\n${after.view.join("\n")}`;
	for (const sentinel of context.hiddenOverlaySentinels) {
		if (visibleSentinels.has(sentinel)) continue;
		if (nativeText.includes(sentinel)) {
			context.fail("stale overlay sentinel", op, before, after, index, { sentinel });
		}
	}
}

export function assertUniqueContentNoUnexpectedDuplicates(
	context: AssertionsContext,
	op: AppliedOperation,
	before: Snapshot,
	after: Snapshot,
	index: number,
): void {
	if (!context.scenario.uniqueContent) return;
	// All comparisons run with non-spacing marks stripped: the virtual
	// terminal drops them on input (ghostty-web 0.4 margin-cluster crash
	// workaround), so buffer readback and frame/tape rows would otherwise
	// never collide on marked rows.
	const strip = (line: string): string => line.replace(NONSPACING_MARKS, "");
	// Accumulate even when the check below is skipped (scrolled/overlay): the
	// frame's legitimate duplicates commit to scrollback regardless of where
	// the viewport is parked. The shadow tape contributes too: a no-seam
	// offscreen insert re-indexes committed content, so the shifted rows
	// legitimately commit a second time (the exact tape-equality oracle has
	// already proven the buffer matches the ledger row for row).
	for (const line of duplicateNonblankLines(after.frame)) {
		context.everDuplicatedFrameLines.add(strip(line));
	}
	const tapeSeen = new Set<string>();
	for (const raw of context.shadow.shadowTape) {
		if (raw.length === 0) continue;
		const line = strip(raw);
		if (tapeSeen.has(line)) context.everDuplicatedFrameLines.add(line);
		tapeSeen.add(line);
	}
	// A committed row that still sits in the visible window (window floored
	// at the commit boundary) legitimately appears in both regions of the
	// whole-tape buffer snapshot.
	const windowTop = getShadowWindowTop(context.shadow);
	for (let r = 0; r < after.height; r++) {
		const raw = context.shadow.shadowFrame[windowTop + r] ?? "";
		if (raw.length === 0) continue;
		const line = strip(raw);
		if (tapeSeen.has(line)) context.everDuplicatedFrameLines.add(line);
	}
	if (context.hasVisibleOverlay() || !after.atBottom) return;
	const allowed = context.everDuplicatedFrameLines;
	const seen = new Set<string>();
	for (const raw of after.buffer) {
		if (raw.length === 0) continue;
		const line = strip(raw);
		if (seen.has(line) && !allowed.has(line)) {
			context.fail("unexpected duplicate native scrollback line", op, before, after, index, { line });
		}
		seen.add(line);
	}
}
