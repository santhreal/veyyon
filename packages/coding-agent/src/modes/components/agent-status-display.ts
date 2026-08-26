/**
 * Canonical owner of AgentStatus visual language (colors, glyphs, labels).
 * Control Center and transcript viewer read here so status colors cannot diverge
 * (previously hub had running→accent/idle→success, viewer had the reverse).
 */
import type { AgentStatus } from "../../registry/agent-registry";
import { type ThemeColor, theme } from "../theme/theme";

/**
 * The state a surface NAMES, which is finer than {@link AgentStatus}.
 *
 * `AgentStatus` says whether an agent is running or stopped and nothing about
 * WHY, and the two states that most need attention are exactly the two it
 * cannot express:
 *
 * - `blocked` is `running`. The agent is mid-turn, stopped at an approval
 *   prompt, and a roster that draws it as `running` shows a spawn waiting on a
 *   person as one grinding through a build. `AgentRef.pendingApproval` is the
 *   discriminator and the only one: there is no status to read.
 * - `waiting` is `idle` or `parked`. The agent stopped to let a peer answer,
 *   which is also what an abandoned agent looks like, and it read exactly like
 *   one that had simply finished. `AgentRef.waitingOnPeer` carries it, written
 *   from the sign-off by `task/executor.ts`; the lifecycle manager already
 *   spends it on a longer close budget, so the state was trusted everywhere
 *   except on screen.
 */
export type AgentDisplayState = AgentStatus | "blocked" | "waiting";

/** Canonical color per display state. The one place this decision is made. */
const AGENT_STATUS_COLOR: Record<AgentDisplayState, ThemeColor> = {
	running: "accent", // actively working — attention (silver)
	blocked: "warning", // stopped at an approval prompt — needs YOU
	idle: "success", // live and finished, awaiting work — ready (green)
	waiting: "link", // stopped on a peer that may never answer
	parked: "muted", // session disposed, revivable — dim
	aborted: "error", // hard-killed, terminal — error
};

/** Theme symbol key per display state (the glyph shown in compact rosters). */
const AGENT_STATUS_SYMBOL = {
	running: "status.running",
	blocked: "status.warning",
	idle: "status.enabled",
	waiting: "status.pending",
	parked: "status.shadowed",
	aborted: "status.aborted",
} as const;

/** All canonical agent display states derived from the visual language owner. */
export const AGENT_DISPLAY_STATES = Object.keys(AGENT_STATUS_COLOR) as readonly AgentDisplayState[];

// AGENT_STATUS_ORDER was here: a canonical sort rank per status, shared so the
// Agent Hub roster and the Subagent Inbox sidebar could not disagree about which
// agents floated to the top. Both views are gone, and the Agent Control Center
// that replaced them sorts by SPAWN order instead, deliberately: call signs are
// assigned from the roster order, so a status-based sort renames agents as they
// change state, and a name that moves is worse than no name. The constant had no
// remaining consumer, and an exported ordering nothing orders by is a rule a
// reader will assume is in force.

/**
 * Derives display state for an agent across surfaces.
 * Only a RUNNING agent can be `blocked` (`pendingApproval` during turn; terminal state takes precedence once stopped).
 * Only a STOPPED agent can be `waiting` (`waitingOnPeer` written at end of turn).
 */
export function agentDisplayState(agent: {
	status: AgentStatus;
	waitingOnPeer?: boolean;
	blockedOnApproval?: boolean;
}): AgentDisplayState {
	if (agent.status === "running" && agent.blockedOnApproval === true) return "blocked";
	if (agent.waitingOnPeer !== true) return agent.status;
	return agent.status === "idle" || agent.status === "parked" ? "waiting" : agent.status;
}

/** The color the given display state is rendered in, everywhere. */
export function agentStatusColor(status: AgentDisplayState): ThemeColor {
	return AGENT_STATUS_COLOR[status];
}

/** Colored status glyph for compact rosters (the Control Center's Live view). */
export function agentStatusGlyph(status: AgentDisplayState): string {
	return theme.styledSymbol(AGENT_STATUS_SYMBOL[status], AGENT_STATUS_COLOR[status]);
}

/** Colored status word (`running`/`idle`/`waiting`/`parked`/`aborted`) for labels. */
export function agentStatusWord(status: AgentDisplayState): string {
	return theme.fg(AGENT_STATUS_COLOR[status], status);
}
