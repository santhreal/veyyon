export type WindowFocusState = "unknown" | "focused" | "unfocused";

export const FOCUS_REPORTING_ENABLE = "\x1b[?1004h";

export const FOCUS_REPORTING_DISABLE = "\x1b[?1004l";

const FOCUS_IN = "\x1b[I";

const FOCUS_OUT = "\x1b[O";

let state: WindowFocusState = "unknown";

export function windowFocusState(): WindowFocusState {
	return state;
}

export function isWindowFocused(): boolean {
	return state === "focused";
}

export function setWindowFocusState(next: WindowFocusState): void {
	state = next;
}

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
