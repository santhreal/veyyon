import * as os from "node:os";
import type { InteractiveModeContext } from "../modes/terminal/types";

/**
 * The name shown to collab peers. Reads one setting, so it asks for one member
 * rather than the whole 200-member interactive context: a caller that has been
 * narrowed (the host and the guest link both have) can still call it.
 */
export function collabDisplayName(ctx: Pick<InteractiveModeContext, "settings">): string {
	const configured = (ctx.settings.get("collab.displayName") ?? "").trim();
	if (configured) return configured;
	return accountName() || machineName() || "anonymous";
}

/**
 * The account this process runs as, empty when it cannot be resolved.
 *
 * A uid with no passwd entry — every container that runs as a bare numeric user
 * — reports the literal `unknown` rather than raising, so a roster drew a row
 * reading "unknown" beside the host badge. That word names no account and is
 * read here as no answer.
 */
function accountName(): string {
	try {
		const named = os.userInfo().username.trim();
		return named === "unknown" ? "" : named;
	} catch {
		return "";
	}
}

/** The machine's own name, empty when it has none. */
function machineName(): string {
	try {
		return os.hostname().trim();
	} catch {
		return "";
	}
}
