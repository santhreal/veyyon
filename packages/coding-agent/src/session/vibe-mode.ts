/**
 * Entering and leaving vibe mode, for every host that offers it.
 *
 * The transition is four moves on the session -- swap the tool set, record the
 * state, tell a running turn, append the mode entry -- and a fifth on the
 * worker registry when it ends. A host adds its own status text around these
 * calls; it does not repeat them, so the terminal and the desktop cannot drift
 * on which tools a vibe session holds or whether its workers outlive it.
 */
import { MAIN_AGENT_ID } from "../registry/agent-registry";
import type { AgentSession } from "./agent-session";
import { VibeSessionRegistry } from "./vibe-runtime";

/** The tool the director keeps: it reads, the workers write. */
const VIBE_BASE_TOOLS = ["read"];

/**
 * Installs the vibe tools, strips the active set down to {@link
 * VIBE_BASE_TOOLS} plus those, and records the mode on the session.
 *
 * The tool names the session held are recorded in the mode state rather than
 * in the caller, so whichever host leaves the mode restores the set the
 * session actually had.
 */
export async function enterVibeMode(session: AgentSession): Promise<void> {
	// Entering a mode the session is already in would capture the vibe tools
	// as the set to restore, so leaving would hand them back for good.
	if (session.getVibeModeState()?.enabled) return;
	const previousTools = session.getActiveToolNames();
	await session.activateVibeTools(VIBE_BASE_TOOLS);
	session.setVibeModeState({ enabled: true, previousTools });
	if (session.isStreaming) {
		await session.sendVibeModeContext({ deliverAs: "steer" });
	}
	session.sessionManager.appendModeChange("vibe");
}

/** What leaving the mode did, for the host that reports it. */
export interface VibeModeExit {
	/** Whether the session was in vibe mode at all. */
	left: boolean;
	/** Worker sessions killed, which outlive neither the mode nor the exit. */
	killed: number;
}

/**
 * Restores the tool set, drops the mode, and kills every worker the director
 * spawned.
 *
 * `record` is false for the teardown a resume runs before it reads the mode
 * the session file states: that is not a mode the operator left, and appending
 * one would overwrite the entry being restored.
 */
export async function exitVibeMode(session: AgentSession, options?: { record?: boolean }): Promise<VibeModeExit> {
	const state = session.getVibeModeState();
	if (!state?.enabled) return { left: false, killed: 0 };
	await session.deactivateVibeTools(state.previousTools ?? []);
	session.setVibeModeState(undefined);
	const killed = await VibeSessionRegistry.global().killAll(
		session.getAgentId() ?? MAIN_AGENT_ID,
		session.asyncJobManager,
	);
	if (options?.record !== false) session.sessionManager.appendModeChange("none");
	return { left: true, killed };
}
