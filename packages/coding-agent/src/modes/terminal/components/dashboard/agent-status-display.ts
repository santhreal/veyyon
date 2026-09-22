/**
 * The single owner of the AgentStatus visual language: one color per status,
 * plus the glyph form (compact rosters) and word form (labels) derived from it.
 *
 * Both the Control Center roster and the transcript viewer read from here, so the two
 * can never again disagree on which color means `running` vs `idle` — they
 * previously did (hub: running→accent/idle→success; viewer: the reverse), a
 * same-name divergence where the identical status carried opposite colors in two
 * views. ONE-PLACE: the mapping lives here and nowhere else.
 */
import type { AgentDisplayState } from "../../../../registry/live-roster";
import { type ThemeColor, theme } from "../../../../theme/theme";

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
// Agent Hub roster and the Agent Inbox sidebar could not disagree about which
// agents floated to the top. Both views are gone, and the agent dashboard
// that replaced them sorts by SPAWN order instead, deliberately: call signs are
// assigned from the roster order, so a status-based sort renames agents as they
// change state, and a name that moves is worse than no name. The constant had no
// remaining consumer, and an exported ordering nothing orders by is a rule a
// reader will assume is in force.

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
