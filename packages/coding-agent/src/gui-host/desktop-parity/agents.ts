/**
 * The agents dashboard operations the terminal offers, and the carrier that
 * reaches each from the desktop.
 *
 * A member is `key:<keybinding id>` for each keybinding that opens the card
 * (`app.agents.*` and `app.session.observe`), or `card:<method>` for each public
 * operation of `AgentDashboard`. The card's in-card navigation (selection, the
 * Live/Comms switch, folding and filtering the comms stream) redraws the roster
 * and the stream the two sections below already hold, and is not a member.
 */
import type { DesktopCarrier } from "./carrier";

/** Keybinding ids that open the agents dashboard: every `app.agents.*` id and `app.session.observe`. */
export function isAgentsDashboardKey(id: string): boolean {
	return id.startsWith("app.agents.") || id === "app.session.observe";
}

export const AGENTS_DASHBOARD_CARRIERS: Readonly<Record<string, DesktopCarrier>> = {
	/** The roster: one row per live, parked and persisted agent. */
	"key:app.agents.hub": { section: "Agents" },
	/** The same card; the window reads the traffic stream beside the roster. */
	"key:app.session.observe": { section: "AgentComms" },
	/**
	 * Opens an agent's conversation, reviving it when parked. The window sends
	 * `ReviveAgent`, then opens `AgentView.session`.
	 */
	"card:openSelectedAgent": { action: "ReviveAgent" },
	/** Reads an advisor's or a collab guest's agent transcript without switching the live session. */
	"card:openTranscript": { action: "PreviewSessionTranscript" },
	/** Aborts a running agent and releases it; releases a parked one. */
	"card:killSelectedAgent": { action: "CancelTask" },
};
