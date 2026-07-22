import * as os from "node:os";
import type { InteractiveModeContext } from "../modes/types";

/** Display name for this process's user in collab sessions. */
/**
 * The name shown to collab peers. Reads one setting, so it asks for one member
 * rather than the whole 200-member interactive context: a caller that has been
 * narrowed (the host and the guest link both have) can still call it.
 */
export function collabDisplayName(ctx: Pick<InteractiveModeContext, "settings">): string {
	const configured = (ctx.settings.get("collab.displayName") ?? "").trim();
	if (configured) return configured;
	try {
		return os.userInfo().username;
	} catch {
		return "anonymous";
	}
}
