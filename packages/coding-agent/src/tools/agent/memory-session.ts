import type { MnemopiSessionState } from "../../memory/mnemopi/state";
import type { ToolSession } from "../index";

/**
 * Obtain the initialized Mnemopi session state or fail closed with a clear error.
 */
export function requireMnemopiSessionState(session: ToolSession): MnemopiSessionState {
	const state = session.getMnemopiSessionState?.();
	if (!state) {
		throw new Error("Mnemopi backend is not initialised for this session.");
	}
	return state;
}
