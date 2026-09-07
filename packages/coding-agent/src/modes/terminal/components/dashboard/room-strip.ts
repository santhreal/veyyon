/**
 * The room strip: one anchored row listing the driving agents that sit side by
 * side in this terminal, with the one on screen marked and one selected.
 *
 * The sideways axis. The agent dashboard is the downward one: it lists what
 * the displayed conversation spawned, and Enter goes into a spawn. This strip
 * never lists a spawn. A row is a peer conversation, Enter attaches the screen
 * to it, and the conversation that was on screen keeps running behind it.
 *
 * Pure: the caller reads the registry and the settings and hands the rows in,
 * so a test renders the strip from a fixture and the controller owns nothing
 * about how a row is drawn.
 */

import { visibleWidth } from "@veyyon/utils/width";
import type { AgentRef } from "../../../../registry/agent-registry";
import { theme } from "../../../../theme/theme";
import { replaceTabs, truncateToWidth } from "../../../../tools/core/render-utils";
import { agentDisplayState, agentStatusGlyph } from "./agent-status-display";

/** One row of the strip: what the caller resolved about a peer. */
export interface RoomStripMember {
	ref: AgentRef;
	/** Session title when the conversation has one, else undefined. */
	title: string | undefined;
}

export interface RoomStripOptions {
	columns: number;
	/** Id of the driving agent the screen is attached to. */
	currentId: string;
	/** Id under the cursor; the row Enter would attach to. */
	selectedId: string;
}

/** Gap between two member cells. */
const CELL_GAP = "   ";
/** Longest a member label is drawn before it is cut. */
const LABEL_MAX = 28;

/**
 * The name a peer is drawn under: its session title, else its position in the
 * room. Every driving agent registers with the display name `main`, so the ref's
 * own name cannot tell two apart, and the raw id (`main:<session id>`) is an
 * identifier for the model, not a label for a person.
 */
export function roomMemberLabel(member: RoomStripMember, index: number): string {
	const title = member.title?.trim();
	if (title) return replaceTabs(title).replace(/[\r\n]+/g, " ");
	return `session ${index + 1}`;
}

/**
 * The strip as one line, or no line when the room holds fewer than two
 * members. A room of one is not a room, and a strip that says so would be a
 * row of chrome above every composer in every session that never opened a peer.
 */
export function renderRoomStripLine(
	members: readonly RoomStripMember[],
	options: RoomStripOptions,
): string | undefined {
	if (members.length < 2) return undefined;
	const cells = members.map((member, index) => {
		const ref = member.ref;
		const state = agentDisplayState({
			status: ref.status,
			waitingOnPeer: ref.waitingOnPeer,
			blockedOnApproval: ref.pendingApproval !== undefined,
		});
		const label = truncateToWidth(roomMemberLabel(member, index), LABEL_MAX);
		const isCurrent = ref.id === options.currentId;
		const isSelected = ref.id === options.selectedId;
		const marker = isSelected ? theme.fg("accent", theme.symbol("nav.cursor")) : " ";
		const name = isCurrent ? theme.bold(label) : isSelected ? theme.fg("accent", label) : theme.fg("muted", label);
		const activity = ref.status === "running" && ref.activity ? theme.fg("dim", ` · ${ref.activity}`) : "";
		return `${marker}${agentStatusGlyph(state)} ${name}${activity}`;
	});
	const header = theme.fg("accent", theme.bold("Room"));
	const hint = theme.fg("dim", "  ←/→ select · Enter switch · Esc close");
	const body = cells.join(CELL_GAP);
	const line = `${header}  ${body}`;
	// The hint is chrome; it is the first thing to go when the row is short.
	const withHint = `${line}${hint}`;
	if (visibleWidth(withHint) <= options.columns) return withHint;
	return truncateToWidth(line, options.columns);
}
