// Terminal window focus, as reported by the terminal itself (DECSET 1004).
//
// WHY THIS EXISTS. A desktop notification is an interruption, and an
// interruption is only worth anything when the operator is somewhere else.
// Veyyon fired every notification unconditionally: the turn-completion toast
// and the `ask` toast arrived while the operator sat watching the very terminal
// that produced them. Under an autonomous run (`--yolo`, no approval prompts)
// that is a toast per turn on a screen the operator is already looking at, which
// is how "veyyon keeps notifying me for everything" became a real complaint
// rather than a preference.
//
// Focus reporting is the only signal a terminal application gets about whether
// its window is the one receiving keystrokes. With DECSET 1004 enabled, the
// terminal writes `CSI I` when the window takes focus and `CSI O` when it loses
// it. Nothing else is reported: there is no query, no initial state, and a
// terminal that does not implement the mode simply never sends either sequence.
//
// So the state is three-valued and the notification gate FAILS OPEN. `unknown`
// means no terminal has told us anything, and it must behave exactly as the
// pre-focus code did (deliver), or every terminal without 1004 support would
// lose notifications entirely for the sake of a feature it cannot participate
// in.

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

/**
 * Consume an input sequence when it is a focus report, and return whether it
 * was one.
 *
 * The caller uses the return value to STOP forwarding the sequence as user
 * input. `CSI I` and `CSI O` are not keystrokes, and a terminal that still had
 * mode 1004 enabled by a previous application was already delivering them into
 * the editor as stray escape sequences.
 */
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
