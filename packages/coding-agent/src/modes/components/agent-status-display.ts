/**
 * The single owner of the AgentStatus visual language: one color per status,
 * plus the glyph form (compact rosters) and word form (labels) derived from it.
 *
 * Both the Agent Hub roster and the transcript viewer read from here, so the two
 * can never again disagree on which color means `running` vs `idle` — they
 * previously did (hub: running→accent/idle→success; viewer: the reverse), a
 * same-name divergence where the identical status carried opposite colors in two
 * views. ONE-PLACE: the mapping lives here and nowhere else.
 */
import type { AgentStatus } from "../../registry/agent-registry";
import { type ThemeColor, theme } from "../theme/theme";

/** Canonical color per agent status. The one place this decision is made. */
const AGENT_STATUS_COLOR: Record<AgentStatus, ThemeColor> = {
	running: "accent", // actively working — attention (silver)
	idle: "success", // live and finished, awaiting work — ready (green)
	parked: "muted", // session disposed, revivable — dim
	aborted: "error", // hard-killed, terminal — error
};

/** Theme symbol key per agent status (the glyph shown in compact rosters). */
const AGENT_STATUS_SYMBOL = {
	running: "status.running",
	idle: "status.enabled",
	parked: "status.shadowed",
	aborted: "status.aborted",
} as const;

/** The color the given status is rendered in, everywhere. */
export function agentStatusColor(status: AgentStatus): ThemeColor {
	return AGENT_STATUS_COLOR[status];
}

/** Colored status glyph for compact rosters (e.g. the Agent Hub table). */
export function agentStatusGlyph(status: AgentStatus): string {
	return theme.styledSymbol(AGENT_STATUS_SYMBOL[status], AGENT_STATUS_COLOR[status]);
}

/** Colored status word (`running`/`idle`/`parked`/`aborted`) for labels. */
export function agentStatusWord(status: AgentStatus): string {
	return theme.fg(AGENT_STATUS_COLOR[status], status);
}
