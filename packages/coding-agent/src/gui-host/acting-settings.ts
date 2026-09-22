import { isSettingsInitialized, Settings } from "../config/settings";
import type { ActionContext } from "./actions/types";

/**
 * The settings a desktop action reads, writes and reports.
 *
 * This client's own session first, then the settings this process is already
 * running on, and only then a fresh load. The middle one is not an
 * optimization. A window with no session open writing to an isolated instance
 * flushes the value to disk and leaves every live session in the process
 * reading what it loaded at startup, so the setting is stored and ignored
 * until a restart; reading from an isolated instance has the mirror fault,
 * reporting a value off disk that nothing in the process is acting on.
 *
 * The process store is taken whenever the slot is filled, without comparing
 * directories, because that is what a session on this connection will get:
 * `createAgentSession` reaches `Settings.init`, and a second init joins the
 * settled one rather than loading the directories it was passed. Answering out
 * of anything else would state a value the next session will not act on.
 *
 * Every surface that answers out of settings resolves them here. A surface
 * with its own order reports one value while the action acts on another, which
 * is how a configured relay reads as absent on a window whose session has not
 * started yet.
 */
export function actingSettings(ctx: ActionContext): Promise<Settings> | Settings {
	const session = ctx.clientState.agentSession?.settings;
	if (session) return session;
	if (isSettingsInitialized()) return Settings.instance;
	return Settings.loadIsolated({ cwd: ctx.cwd, agentDir: ctx.agentDir });
}
