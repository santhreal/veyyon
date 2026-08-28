import * as fs from "node:fs";
import * as os from "node:os";
import type { Ghostty, GhosttyTerminal } from "ghostty-web";
import {
	EVENT_LOG_COMPACT_BUDGET,
	MAX_GHOSTTY_WRITE_CHUNK,
	OSC_SEQUENCE,
	SYNC_OUTPUT_BEGIN,
	SYNC_OUTPUT_END,
} from "./constants";
import {
	createGhosttyEngine,
	createGhosttyTerminal,
	reloadGhosttyModule,
	stripCombiningMarksForGhostty,
} from "./ghostty-engine";
import { cappedBaseY, historyRowText, syntheticGridRow } from "./grid-reader";

export type EventLogEntry = string | { columns: number; rows: number };

export interface VirtualTerminalEngineState {
	ghostty: Ghostty;
	term: GhosttyTerminal;
	columns: number;
	rows: number;
	scrollbackCap: number;
	viewportY: number;
	pendingEngineResize: boolean;
	engineRebuilds: number;
	eventLog: EventLogEntry[];
	eventLogBytes: number;
	logBaseColumns: number;
	logBaseRows: number;
	replayingLog: boolean;
	recoveringFromOom: boolean;
	historyTextCache: string[];
}

export function isAtBottom(state: VirtualTerminalEngineState): boolean {
	return state.viewportY >= cappedBaseY(state.term, state.scrollbackCap);
}

export function refollowBottom(state: VirtualTerminalEngineState, wasBottom: boolean): void {
	const base = cappedBaseY(state.term, state.scrollbackCap);
	state.viewportY = wasBottom ? base : Math.min(state.viewportY, base);
}

export function stripSynchronizedOutput(data: string): string {
	if (!data.includes(SYNC_OUTPUT_BEGIN) && !data.includes(SYNC_OUTPUT_END) && !data.includes("\x1b]")) return data;
	return data.replaceAll(SYNC_OUTPUT_BEGIN, "").replaceAll(SYNC_OUTPUT_END, "").replace(OSC_SEQUENCE, "");
}

/** Whether a viewport/history clear sequence sits immediately after a full-paint begin prefix. */
export function clearFollowsPaintBegin(data: string, clearIndex: number): boolean {
	const paintBegin = "\x1b[?25l\x1b[?2026h\x1b[?7l";
	const paintBeginNoSync = "\x1b[?25l\x1b[?7l";
	return (
		(clearIndex === paintBegin.length && data.startsWith(paintBegin)) ||
		(clearIndex === paintBeginNoSync.length && data.startsWith(paintBeginNoSync))
	);
}

/**
 * Replace the event log with a synthetic stream rebuilt from the healthy
 * engine's readable state: the wrapper-visible history window as plain
 * text, the grid repainted with background runs (the only style any oracle
 * reads), and the cursor restored. Replaying it reproduces every
 * observable the oracles consume.
 */
export function compactEventLog(state: VirtualTerminalEngineState): void {
	const historyLen = state.term.getScrollbackLength();
	const capped = cappedBaseY(state.term, state.scrollbackCap);
	let synthetic = "";
	for (let i = 0; i < capped; i++) {
		synthetic += `${historyRowText(state.term, state.historyTextCache, historyLen - capped + i)}\r\n`;
	}
	// Push exactly `capped` rows into scrollback, leaving a blank grid.
	synthetic += "\r\n".repeat(Math.max(0, state.rows - 1));
	for (let row = 0; row < state.rows; row++) {
		synthetic += `\x1b[${row + 1};1H\x1b[K${syntheticGridRow(state.term, row)}`;
	}
	const cursor = state.term.getCursor();
	synthetic += `\x1b[${cursor.y + 1};${cursor.x + 1}H`;
	state.eventLog = [synthetic];
	state.eventLogBytes = synthetic.length;
	state.logBaseColumns = state.columns;
	state.logBaseRows = state.rows;
}

/**
 * Rebuild a fresh engine and replay the event log to reproduce the exact
 * terminal state. Used for proactive rotation (with a compacted log) and
 * for OOM recovery, where the failed write is already in the log so the
 * replay completes it against a fresh allocator.
 */
export function rebuildEngineFromLog(state: VirtualTerminalEngineState): void {
	state.engineRebuilds++;
	const log = state.eventLog;
	// Give JSC a chance to collect previously abandoned instances before
	// allocating another one.
	Bun.gc(true);
	reloadGhosttyModule();
	state.ghostty = createGhosttyEngine();
	state.term = createGhosttyTerminal(state.ghostty, state.logBaseColumns, state.logBaseRows, state.scrollbackCap);
	state.historyTextCache.length = 0;
	state.replayingLog = true;
	try {
		for (const event of log) {
			if (typeof event === "string") {
				writeToGhostty(state, event);
			} else {
				state.term.resize(event.columns, event.rows);
			}
		}
	} finally {
		state.replayingLog = false;
	}
}

/**
 * Recover from a trapped engine write. The naive recovery — replay the raw
 * event log (which already ends with the failed write) into a fresh engine —
 * is NOT enough: ghostty-web 0.4 traps DETERMINISTICALLY on some byte
 * streams once the log carries a long multi-width resize history (stress
 * seed 0x90744a00: a clean process with a freshly compiled module traps at
 * the same replay offset every time), so the replay dies exactly like the
 * original write. Proven recovery shape: the log MINUS the failing write
 * replays cleanly, and the failing write lands cleanly on a compacted
 * synthetic state. So: pop the failed write, rebuild the pre-write state,
 * compact it to the bounded synthetic snapshot (rotating onto a fresh
 * engine), then re-apply the failed write through the normal path. A second
 * trap inside this recovery has no further fallback and fails the run
 * loudly (#replayingLog dump path) — never silently.
 */
export function recoverFromEngineOom(state: VirtualTerminalEngineState): void {
	if (state.recoveringFromOom) {
		// The re-applied write trapped even on the compacted state: there is
		// no weaker state to retry against. Fail loudly with the dump path
		// (never silently drop the bytes and continue with a wrong terminal).
		const dumpPath = `${os.tmpdir()}/ghostty-trap-log-${Date.now()}.json`;
		try {
			fs.writeFileSync(dumpPath, JSON.stringify(state.eventLog));
		} catch {}
		throw new Error(
			`ghostty write trapped again after OOM recovery onto a compacted state; event log dumped to ${dumpPath}`,
		);
	}
	const failed = state.eventLog.pop();
	if (typeof failed !== "string") {
		// The log must end with the write that trapped (writeToGhostty pushes
		// before writing). Anything else is bookkeeping corruption: restore
		// and fail via the raw replay so the dump captures the state.
		if (failed !== undefined) state.eventLog.push(failed);
		rebuildEngineFromLog(state);
		return;
	}
	state.eventLogBytes -= failed.length;
	state.recoveringFromOom = true;
	try {
		// Pre-write state replays cleanly (the trap needed the failed bytes).
		rebuildEngineFromLog(state);
		// Rotate onto the compact synthetic snapshot — the raw multi-width
		// history is what the failed write traps against.
		compactEventLog(state);
		rebuildEngineFromLog(state);
		// Re-apply the failed write on the compacted state; it lands back in
		// the (now compact) event log through the normal path. A second trap
		// re-enters this method and hits the guard above.
		writeToGhostty(state, failed);
	} finally {
		state.recoveringFromOom = false;
	}
}

export function writeToGhostty(state: VirtualTerminalEngineState, data: string): void {
	if (!state.replayingLog) {
		state.eventLog.push(data);
		state.eventLogBytes += data.length;
	}
	let offset = 0;
	while (offset < data.length) {
		let end = Math.min(offset + MAX_GHOSTTY_WRITE_CHUNK, data.length);
		const last = data.charCodeAt(end - 1);
		if (end < data.length && last >= 0xd800 && last <= 0xdbff) end--;
		if (end <= offset) end = Math.min(offset + 1, data.length);
		const chunk = data.slice(offset, end);
		try {
			state.term.write(chunk);
		} catch (error) {
			if (state.replayingLog) {
				const dumpPath = `${os.tmpdir()}/ghostty-trap-log-${Date.now()}.json`;
				try {
					fs.writeFileSync(dumpPath, JSON.stringify(state.eventLog));
				} catch {}
				throw new Error(
					`ghostty write failed during OOM-recovery replay (chunk ${chunk.length} chars at offset ${offset} of ${data.length}): ${String(error)}\n` +
						`event log dumped to ${dumpPath}\n` +
						`chunk head: ${JSON.stringify(chunk.slice(0, 200))}`,
					{ cause: error },
				);
			}
			recoverFromEngineOom(state);
			return;
		}
		offset = end;
	}
	// Healthy write completed: once the log grows past the budget, compact
	// it to a bounded synthetic state and rotate onto a fresh engine.
	// ghostty-web 0.4 instances cannot be freed safely and grow their WASM
	// memory monotonically with write volume; abandoned giants eventually
	// starve the process so badly that a fresh instance cannot even grow.
	// Rotating early keeps every instance small.
	if (!state.replayingLog && state.eventLogBytes > EVENT_LOG_COMPACT_BUDGET) {
		compactEventLog(state);
		rebuildEngineFromLog(state);
	}
}

export function recreateEngine(state: VirtualTerminalEngineState): void {
	// ghostty-web 0.4's terminal/free path is not safe under the rapid
	// resize/full-clear churn in the stress harness. Retire the old instance
	// and build a fresh one; tests are short-lived and this preserves the
	// observable full-clear/reset semantics without poisoning WASM state.
	state.ghostty = createGhosttyEngine();
	state.term = createGhosttyTerminal(state.ghostty, state.columns, state.rows, state.scrollbackCap);
	state.pendingEngineResize = false;
	state.viewportY = 0;
	state.historyTextCache.length = 0; // fresh engine: prior scrollback is gone
	state.eventLog.length = 0;
	state.eventLogBytes = 0;
	state.logBaseColumns = state.columns;
	state.logBaseRows = state.rows;
}

export function engineWrite(state: VirtualTerminalEngineState, data: string): void {
	const wasBottom = isAtBottom(state);
	const clearScrollbackAfterFullClear = "\x1b[2J\x1b[H\x1b[3J";
	// Destructive full paints emit home + ED3 without ED2 (TUI#emitFullPaint
	// rewrites every visible row with self-clearing lines).
	const destructiveClear = "\x1b[H\x1b[3J";
	const fullClearIndex = data.indexOf(clearScrollbackAfterFullClear);
	const destructiveIndex = data.indexOf(destructiveClear);
	if (fullClearIndex >= 0 && clearFollowsPaintBegin(data, fullClearIndex)) {
		// ghostty-web 0.4 can trap in WASM when libghostty-vt processes a
		// full-clear + ED3 repaint against an existing history buffer. The
		// sequence's observable effect here is a blank terminal with empty
		// history before repainting the transcript, so create exactly that
		// state directly in a fresh WASM instance and feed Ghostty the
		// unmodified text/SGR tail.
		recreateEngine(state);
		data = data.slice(0, fullClearIndex) + data.slice(fullClearIndex + clearScrollbackAfterFullClear.length);
	} else {
		if (state.pendingEngineResize) {
			state.term.resize(state.columns, state.rows);
			state.eventLog.push({ columns: state.columns, rows: state.rows });
			state.historyTextCache.length = 0; // engine rewraps scrollback on resize
			state.pendingEngineResize = false;
			// Rotate onto a compact synthetic state at every resize boundary.
			// ghostty-web 0.4 deterministically corrupts its own memory once an
			// instance accumulates history across several widths (stress seeds
			// 0x90744a00, 0x24d2d8c2): later writes AND scrollback reads both
			// trap out-of-bounds, and a scenario that never reads history
			// between ops (WSL traits) accumulates the poison invisibly until
			// recovery itself traps. Compacting here keeps each instance's raw
			// history effectively single-width, so the trap state never forms.
			// The read happens right after the healthy rewrap, exactly like the
			// byte-budget rotation below.
			//
			// Only when the trap state can actually form, which takes BOTH of
			// its ingredients. The width has to differ from the one this
			// instance's log was built at, because a resize that changes only
			// the row count rewraps nothing and cannot introduce a second
			// width. And there has to be history to be of two widths in the
			// first place: an instance with an empty scrollback is holding
			// nothing that a rewrap could poison. Rebuilding regardless cost a
			// `Bun.gc(true)`, a WASM module reload and a full log replay at
			// EVERY resize, which is what made a 240-resize storm take seconds.
			const widthChanged = state.columns !== state.logBaseColumns;
			if (widthChanged && state.term.getScrollbackLength() > 0) {
				compactEventLog(state);
				rebuildEngineFromLog(state);
			}
		}
		if (destructiveIndex >= 0 && clearFollowsPaintBegin(data, destructiveIndex)) {
			// ED3 renumbers scrollback offsets, so the offset-keyed history text
			// cache is stale. Let Ghostty process the bytes natively — recreating
			// to a blank grid here would mask self-clear regressions in the
			// no-ED2 repaint contract that the render tests exist to catch.
			state.historyTextCache.length = 0;
		}
	}
	data = stripSynchronizedOutput(data);
	data = stripCombiningMarksForGhostty(data);
	writeToGhostty(state, data);
	refollowBottom(state, wasBottom);
}
