import { ALT_SCREEN_ENTER, ALT_SCREEN_EXIT } from "./constants";
import {
	expectedScrollbackBuffer as expectedScrollbackBufferHelper,
	findPrivateCsiTerminator,
	parseCsiParameters,
	sameLines,
	trailingPrivateCsiPrefixStart,
} from "./expected-frame";
import type { JsonObject, Snapshot, TerminalStressTraits } from "./types";

export interface DriverShadowState {
	shadowTape: string[];
	shadowCommitted: number;
	shadowFrame: string[];
	shadowFrameHeight: number;
	shadowFrameWidth: number;
	shadowFrameOverlay: boolean;
	shadowFrameGeometryChanged: boolean;
	shadowResizePending: boolean;
	shadowAltActive: boolean;
	writeLog: string[];
	writeLogScanned: number;
	ansiCarry: string;
	syncDepth: number;
	autowrapOffDepth: number;
}

export function createDriverShadowState(): DriverShadowState {
	return {
		shadowTape: [],
		shadowCommitted: 0,
		shadowFrame: [],
		shadowFrameHeight: 0,
		shadowFrameWidth: 0,
		shadowFrameOverlay: false,
		shadowFrameGeometryChanged: false,
		shadowResizePending: false,
		shadowAltActive: false,
		writeLog: [],
		writeLogScanned: 0,
		ansiCarry: "",
		syncDepth: 0,
		autowrapOffDepth: 0,
	};
}

/**
 * The frame row mapped to grid row 0: the frame tail anchored at the
 * viewport, floored at the committed boundary (rows already in native
 * history are never re-shown on the grid). Derived, never stored — every
 * stored copy of this value drifted from the engine on some seed.
 */
export function getShadowWindowTop(shadow: DriverShadowState): number {
	return Math.max(shadow.shadowCommitted, shadow.shadowFrame.length - Math.max(1, shadow.shadowFrameHeight), 0);
}

/**
 * Reconcile the shadow ledger with the engine's committed counter. A raise
 * means the emit scrolled rows into native history: materialize them onto
 * the tape from the frame that was on screen. A drop is a render-time
 * re-anchor or audit resync (cursor-tail pull-down, divergence trim): the
 * engine rebases its counter WITHOUT erasing history — the stale committed
 * copy stays in the terminal ("duplication, never loss") — so the tape
 * keeps its rows and only the counter rebases; the re-committed rows land
 * on the tape again when the counter re-advances, exactly as they re-enter
 * the terminal physically.
 */
export function syncShadowCommitted(shadow: DriverShadowState, committedRows: number): void {
	if (committedRows > shadow.shadowCommitted) {
		for (let i = shadow.shadowCommitted; i < committedRows; i++) {
			shadow.shadowTape.push(shadow.shadowFrame[i] ?? "");
		}
	}
	shadow.shadowCommitted = committedRows;
}

/**
 * Advance the shadow commit ledger for one observed write. Destructive and
 * non-destructive replays are byte-driven (ED3/ED2 change what history
 * CONTAINS, which the committed counter alone cannot express); ordinary
 * updates flow through syncShadowCommitted, which also runs here first so
 * pre-emit counter drops (classification re-anchors) are observed before
 * this write's own commits raise the counter again.
 */
export function applyShadowWrite(shadow: DriverShadowState, committedRows: number, data: string): void {
	syncShadowCommitted(shadow, committedRows);
	data = normalScreenShadowWrite(shadow, data);
	if (data.length === 0) return;
	const frame = shadow.shadowFrame;
	const height = Math.max(1, shadow.shadowFrameHeight);
	const length = frame.length;
	if (data.includes("\x1b[3J")) {
		shadow.shadowCommitted = Math.max(0, length - height);
		shadow.shadowTape = frame.slice(0, shadow.shadowCommitted);
		return;
	}
	if (data.includes("\x1b[2J")) {
		// Grid cleared in place, committed prefix scrolls above it; prior
		// history rows stay (and are erased only by the ED3 branch above).
		const chunkTo = Math.max(0, length - height);
		for (let i = 0; i < chunkTo; i++) shadow.shadowTape.push(frame[i] ?? "");
		shadow.shadowCommitted = chunkTo;
		return;
	}
}

// Resize fast-path frames write to the alternate screen, then the settled
// replay often leaves alt and emits ED3 in the same write. Ignore bytes while
// alt is active, but keep the normal-screen suffix after `?1049l` so the
// shadow ledger observes the authoritative replay.
export function normalScreenShadowWrite(shadow: DriverShadowState, data: string): string {
	if (shadow.shadowAltActive) {
		const exitIndex = data.lastIndexOf(ALT_SCREEN_EXIT);
		if (exitIndex === -1) return "";
		shadow.shadowAltActive = false;
		return data.slice(exitIndex + ALT_SCREEN_EXIT.length);
	}
	const enterIndex = data.indexOf(ALT_SCREEN_ENTER);
	if (enterIndex === -1) return data;
	const exitIndex = data.indexOf(ALT_SCREEN_EXIT, enterIndex + ALT_SCREEN_ENTER.length);
	if (exitIndex === -1) {
		shadow.shadowAltActive = true;
		return data.slice(0, enterIndex);
	}
	return data.slice(0, enterIndex) + data.slice(exitIndex + ALT_SCREEN_EXIT.length);
}

export function consumeAnsiChunk(
	shadow: DriverShadowState,
	traits: TerminalStressTraits,
	data: string,
	onFail: (msg: string, extra: JsonObject) => never,
): void {
	const input = shadow.ansiCarry + data;
	shadow.ansiCarry = "";
	let cursor = 0;
	while (cursor < input.length) {
		const esc = input.indexOf("\x1b[?", cursor);
		if (esc === -1) break;
		const terminator = findPrivateCsiTerminator(input, esc + 3);
		if (terminator === -1) {
			shadow.ansiCarry = input.slice(esc);
			return;
		}
		const final = input[terminator] ?? "";
		if (final === "h" || final === "l") {
			const params = parseCsiParameters(input.slice(esc + 3, terminator));
			consumePrivateModeSequence(shadow, traits, params, final, onFail);
		}
		cursor = terminator + 1;
	}
	const carryStart = trailingPrivateCsiPrefixStart(input);
	if (carryStart >= 0) {
		shadow.ansiCarry = input.slice(carryStart);
	}
}

export function consumePrivateModeSequence(
	shadow: DriverShadowState,
	traits: TerminalStressTraits,
	params: readonly number[],
	final: "h" | "l",
	onFail: (msg: string, extra: JsonObject) => never,
): void {
	if (params.includes(2026)) {
		if (traits.syncOutputDisabled) {
			onFail(
				final === "h"
					? "synchronized-output begin emitted while VEYYON_NO_SYNC_OUTPUT is set"
					: "synchronized-output end emitted while VEYYON_NO_SYNC_OUTPUT is set",
				{ sequence: final === "h" ? "BSU" : "ESU" },
			);
		}
		shadow.syncDepth += final === "h" ? 1 : -1;
		if (shadow.syncDepth > 1) {
			onFail("nested synchronized-output begin (BSU within BSU)", {
				syncDepth: shadow.syncDepth,
			});
		}
		if (shadow.syncDepth < 0) {
			onFail("synchronized-output end (ESU) without matching begin", {
				syncDepth: shadow.syncDepth,
			});
		}
	}
	if (params.includes(7)) {
		shadow.autowrapOffDepth += final === "l" ? 1 : -1;
		if (shadow.autowrapOffDepth < 0) {
			onFail("autowrap enabled without matching disable", {
				autowrapOffDepth: shadow.autowrapOffDepth,
			});
		}
	}
}

export function expectedDriverScrollbackBuffer(
	shadow: DriverShadowState,
	snapshotHeight: number,
	scrollback: number,
): string[] {
	const height = snapshotHeight;
	const expected = [...shadow.shadowTape];
	const windowTop = getShadowWindowTop(shadow);
	for (let r = 0; r < height; r++) {
		expected.push(shadow.shadowFrame[windowTop + r] ?? "");
	}
	const cap = height + scrollback;
	return expected.length > cap ? expected.slice(expected.length - cap) : expected;
}

/**
 * Whether the terminal's scrollback history is full. Once baseY sits at the
 * scenario's line cap, every further physical scroll EVICTS the oldest
 * history row and baseY stays pinned — physical deltas stop tracking
 * commits, and the history prefix legitimately shifts without a redraw. The
 * old guard here re-derived saturation from the CURRENT frame's length,
 * which wrongly re-armed after a frame collapse (seed 0xe19c9184 op 87:
 * frame shrank to 2 rows, but the terminal history stays saturated forever
 * — history never shrinks short of an ED3 erase, and after ED3 baseY drops
 * below the cap so this predicate re-arms the checks correctly).
 */
export function historySaturated(snapshot: Snapshot, scrollback: number): boolean {
	return snapshot.position.baseY >= scrollback;
}

export function bufferReflectsFrame(
	buffer: readonly string[],
	frame: readonly string[],
	height: number,
	scrollback: number,
): boolean {
	return sameLines(buffer, expectedScrollbackBufferHelper(frame, height, scrollback));
}

export function isCleanBuffer(
	buffer: readonly string[],
	frame: readonly string[],
	height: number,
	scrollback: number,
): boolean {
	return bufferReflectsFrame(buffer, frame, height, scrollback);
}
