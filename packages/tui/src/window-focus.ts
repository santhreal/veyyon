// Terminal window focus tracking via DECSET 1004 (CSI I / CSI O).

/**
 * What the terminal last said about its own window focus.
 *
 * `unknown` is the startup value and the value after a teardown: no focus event
 * has been seen, so nothing may be inferred from it.
 */
export type WindowFocusState = "unknown" | "focused" | "unfocused";

/** DECSET 1004: ask the terminal to report focus in/out. */
export const FOCUS_REPORTING_ENABLE = "\x1b[?1004h";

/** DECRST 1004: stop focus reporting, so the operator's shell does not inherit it. */
export const FOCUS_REPORTING_DISABLE = "\x1b[?1004l";

/** Focus in, the only sequence a focused terminal sends under mode 1004. */
const FOCUS_IN = "\x1b[I";

/** Focus out, its exact counterpart. */
const FOCUS_OUT = "\x1b[O";

let state: WindowFocusState = "unknown";

/** The last focus state the terminal reported, or `unknown` when it has reported none. */
export function windowFocusState(): WindowFocusState {
	return state;
}

/**
 * Whether the terminal window is KNOWN to hold focus. False while the state is
 * `unknown`, which is what keeps a terminal with no focus reporting behaving as
 * it always did.
 */
export function isWindowFocused(): boolean {
	return state === "focused";
}

/** Set the state directly. The terminal owns this at runtime; tests use it to stage a state. */
export function setWindowFocusState(next: WindowFocusState): void {
	state = next;
}

/** Consume input sequence if it is a focus report (CSI I / CSI O). */
export function consumeWindowFocusEvent(sequence: string): boolean {
	if (sequence === FOCUS_IN) {
		state = "focused";
		return true;
	}
	if (sequence === FOCUS_OUT) {
		state = "unfocused";
		return true;
	}
	return false;
}
