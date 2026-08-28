import type { AgentStatus } from "../../registry/agent-registry";
import { type ThemeColor, theme } from "../theme/theme";

export type AgentDisplayState = AgentStatus | "blocked" | "waiting";

const AGENT_STATUS_COLOR: Record<AgentDisplayState, ThemeColor> = {
	running: "accent", // actively working — attention (silver)
	blocked: "warning", // stopped at an approval prompt — needs YOU
	idle: "success", // live and finished, awaiting work — ready (green)
	waiting: "link", // stopped on a peer that may never answer
	parked: "muted", // session disposed, revivable — dim
	aborted: "error", // hard-killed, terminal — error
};

const AGENT_STATUS_SYMBOL = {
	running: "status.running",
	blocked: "status.warning",
	idle: "status.enabled",
	waiting: "status.pending",
	parked: "status.shadowed",
	aborted: "status.aborted",
} as const;

export const AGENT_DISPLAY_STATES = Object.keys(AGENT_STATUS_COLOR) as readonly AgentDisplayState[];

export function agentDisplayState(agent: {
	status: AgentStatus;
	waitingOnPeer?: boolean;
	blockedOnApproval?: boolean;
}): AgentDisplayState {
	if (agent.status === "running" && agent.blockedOnApproval === true) return "blocked";
	if (agent.waitingOnPeer !== true) return agent.status;
	return agent.status === "idle" || agent.status === "parked" ? "waiting" : agent.status;
}

export function agentStatusColor(status: AgentDisplayState): ThemeColor {
	return AGENT_STATUS_COLOR[status];
}

export function agentStatusGlyph(status: AgentDisplayState): string {
	return theme.styledSymbol(AGENT_STATUS_SYMBOL[status], AGENT_STATUS_COLOR[status]);
}

export function agentStatusWord(status: AgentDisplayState): string {
	return theme.fg(AGENT_STATUS_COLOR[status], status);
}
