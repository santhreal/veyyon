/** The single owner of the AgentStatus visual language: one color per status, plus the glyph form (compact rosters) and word form (labels) derived from it. */
import type { AgentStatus } from "../../registry/agent-registry";
import { type ThemeColor, theme } from "../theme/theme";

/** The state a surface NAMES, which is finer than {@link AgentStatus}. `AgentStatus` says whether an agent is running or stopped and nothing about */
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

// AGENT_STATUS_ORDER was here: a canonical sort rank per status, shared so the Agent Hub roster and the Subagent Inbox sidebar could not disagree about which

/** The state to render for one agent. Every surface derives it here, so no two can disagree about when an agent counts as blocked or waiting. */
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
