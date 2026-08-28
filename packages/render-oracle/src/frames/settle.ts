/**
 * ONE owner for "wait until the TUI has finished painting" in tests.
 *
 * Every integration suite that drives the real render scheduler needs this, and
 * they each grew their own version. Two shapes were in use and both are wrong
 * under load:
 *
 *  - a fixed sleep (`await Bun.sleep(40)`), which is a bet that the throttled
 *    frame lands inside 40 ms. In a 378,000-test sweep it does not, and
 *    `overlay-scroll` read `"status-before"` one frame after setting the text to
 *    `"status-after"`.
 *  - sampling diagnostic counters until two samples match, which cannot tell an
 *    idle engine from one that has not started: nothing changed because nothing
 *    happened yet. The pinned-composer suite snapshotted a view under that rule
 *    and three still-queued wheel events then moved it.
 *
 * {@link settleFrames} asks the engine instead of guessing, through
 * `TUI.renderPending` — the read-only "a frame is owed" signal — and only then
 * requires the observable state to hold still. Both failures above are
 * impossible under it: a pending frame is never mistaken for quiescence.
 *
 * Use this in any suite driving a real `TUI` against a `VirtualTerminal`. Suites
 * with a fake scheduler they step by hand do not need it and must not use it.
 */
import type { TUI } from "@veyyon/tui";

/**
 * The only thing this helper needs from a terminal.
 *
 * Structural rather than `VirtualTerminal`, because several suites drive a
 * narrower capture terminal of their own and must not be forced to widen it (or,
 * worse, keep a fixed sleep because the type did not fit).
 */
export interface FlushableTerminal {
	/**
	 * Optional: a terminal that writes straight into a buffer (a capture terminal
	 * in a repro suite) has nothing to drain, and requiring the method would push
	 * those suites back onto a fixed sleep.
	 */
	flush?(): Promise<void>;
}

/** How long to keep pumping before declaring the engine stuck. */
const DEFAULT_TIMEOUT_MS = 5_000;
/** One pump: short enough that a 30 Hz frame is not over-waited, long enough
 *  that a loaded machine still makes progress between samples. */
const PUMP_MS = 4;
/** Consecutive identical samples required after the engine reports no owed
 *  frame. Two, because the frame that just painted can queue a follow-up. */
const STABLE_SAMPLES = 2;

/** Everything a settled frame is allowed to be judged on, as one string. */
function snapshot(tui: TUI): string {
	return [
		tui.renderPending ? "pending" : "idle",
		tui.composedFrameRows,
		tui.committedRows,
		tui.scrollTapeRows,
		tui.virtualScrollNewRows,
		tui.virtualScrollActive ? "frozen" : "following",
		tui.fullRedraws,
	].join("/");
}

export interface SettleFramesOptions {
	/** Overall bound before throwing. Raise it only for a suite that genuinely
	 *  waits out a long quiet window (a resize settle, a ConPTY full paint). */
	timeoutMs?: number;
}

/**
 * Pump timers and the terminal until the engine owes no frame and its observable
 * state has stopped moving.
 *
 * Throws rather than returning on timeout, with the last snapshot: an engine
 * that never settles is a defect in the engine or the test, and returning
 * quietly would turn it into a mystery assertion failure later.
 */
export async function settleFrames<T extends object>(
	// `T & FlushableTerminal` rather than plain `FlushableTerminal`: every property
	// of `FlushableTerminal` is optional, which makes it a WEAK type, and passing a
	// terminal with no `flush` at all is then TS2559 ("no properties in common").
	// `issue-2045-repro`'s CaptureTerminal is exactly that, and the plain signature
	// broke the tui type check. Inferring `T` from the argument keeps the call
	// site's own type and still allows the optional `flush`.
	term: T & FlushableTerminal,
	tui: TUI,
	options?: SettleFramesOptions,
): Promise<void> {
	const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const deadline = Bun.nanoseconds() + timeoutMs * 1_000_000;
	let previous = "";
	let stable = 0;
	let last = "";
	while (Bun.nanoseconds() < deadline) {
		// nextTick before the sleep so a render queued from a microtask is armed
		// as a timer before this pump's sleep gives timers a chance to run.
		await new Promise<void>(resolve => process.nextTick(resolve));
		await Bun.sleep(PUMP_MS);
		await term.flush?.();
		last = snapshot(tui);
		if (tui.renderPending) {
			stable = 0;
			previous = last;
			continue;
		}
		stable = last === previous ? stable + 1 : 0;
		previous = last;
		if (stable >= STABLE_SAMPLES) return;
	}
	throw new Error(
		`settleFrames: the TUI never settled within ${timeoutMs}ms (last state ${last || "unsampled"}). ` +
			`Either a render loop keeps re-requesting frames, or a quiet window is longer than the bound ` +
			`(pass timeoutMs).`,
	);
}
