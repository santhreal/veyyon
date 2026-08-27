/**
 * The anchored Subagents block: a header and a tree of running agents.
 *
 * This is the block as it was before 1.2.0, restored. It was rebuilt as a table
 * of lanes — an id column, a model column and a live activity column resolving
 * recovery over tool over description — and the table said less than the tree
 * it replaced: three columns of padded cells read as one grid to scan rather
 * than as a short list of names, and the activity column drew whatever text a
 * tool call happened to carry.
 *
 * One thing is added, which is the RAIL. `block.rail` is the first non-space
 * cell of every row, the one arrangement {@link paintRailMotion} and
 * `findRailCell` can find, so light travels down the left edge of the block the
 * way it travels down a tool block's. Every row is drawn in the same settled
 * colour and the sweep is what lights them: gating it per row lit only the rows
 * whose agent was inside a tool, and a roster where one agent kept starting and
 * finishing calls flashed a chunk of the rail on and off while the rest of it
 * stood still.
 */

import { visibleWidth } from "@veyyon/tui";
import { formatTaskId } from "../../task/render";
import { replaceTabs, TRUNCATE_LENGTHS, truncateToWidth } from "../../tools/render-utils";
import type { ObservableSession } from "../session-observer-registry";
import { theme } from "../theme/theme";
import { modelBadgeFromSelector } from "./agent-model-badge";

/** Rows drawn before the block stops and counts the rest. */
export const SUBAGENT_HUD_VISIBLE_LIMIT = 8;
/** Cap on the model badge, matching the inline task widget's own cap. */
const BADGE_MAX = 30;
/** Width of the `: ` that introduces a description. */
const DESCRIPTION_SEP = 2;

export interface SubagentHudOptions {
	columns: number;
	/** `subagent.showResolvedModelBadge`, read by the caller so this stays pure. */
	showModelBadge: boolean;
}

/**
 * Text fit into one cell of one row.
 *
 * A newline is folded to a space before anything else happens. Descriptions are
 * free text, and one carrying a real newline put its tail on a line of its own
 * at column zero, outside the block's rail: an anchored region does not scroll,
 * so the leak stayed on screen and the region grew by a row on every rebuild.
 * `truncateToWidth` bounds a string's WIDTH and states nothing about how many
 * lines it occupies.
 */
function cell(text: string, width: number): string {
	return truncateToWidth(replaceTabs(text).replace(/[\r\n]+/g, " "), width);
}

/**
 * Build the anchored subagent HUD block: a bold accent "Subagents" header plus a
 * bounded set of running-agent rows in the same `Id: description` shape the
 * inline task rows use.
 *
 * Only detached spawns are listed. A synchronous `task` call blocks the parent
 * turn and its inline tool block already renders progress live, and eval
 * `agent()` spawns are rendered by their own eval cell tree. Returns no lines
 * when nothing is running, so the container clears itself.
 *
 * Each row ends with the model the agent is actually running on, the same badge
 * the inline task widget and the `/agents` roster print, via the one
 * {@link modelBadgeFromSelector} formatter. A badge that would leave the
 * description less than {@link TRUNCATE_LENGTHS.SHORT} columns is dropped
 * instead of wrapping the row: the roster drops it on a narrow card for the same
 * reason.
 */
export function renderSubagentHudLines(sessions: readonly ObservableSession[], options: SubagentHudOptions): string[] {
	const running = sessions.filter(
		session => session.kind === "subagent" && session.status === "active" && session.detached === true,
	);
	if (running.length === 0) return [];

	const dot = theme.styledSymbol("status.done", "accent");
	const rail = theme.symbol("block.rail");
	const visible = running.slice(0, SUBAGENT_HUD_VISIBLE_LIMIT);
	const hidden = running.length - visible.length;
	// The last column is left clear: a row that fills it arms the terminal's
	// pending wrap, and a wrapped row in an anchored region does not scroll away,
	// it makes the region taller on every rebuild.
	const usable = Math.max(1, options.columns - 1);
	const content = Math.max(0, usable - visibleWidth(rail) - 1);
	// `body` is what a row has left after the rail, its space, the mark and its
	// space, and every budget below is charged against it. Budgeting against the
	// block's whole content width instead drew a row past the bound, and an
	// anchored row that overflows does not scroll away: `Text` soft-wraps it and
	// the region grows a line on every rebuild.
	const body = content - visibleWidth(dot) - 1;
	// A rail, a mark and no room for one letter of a name is chrome and not a
	// block. The empty block is how this says so — the same path it takes when
	// nothing is running, so the container clears rather than drawing a row wider
	// than the terminal.
	if (body < 1) return [];

	// One row per agent, with no tree connectors. Four branches drawn under a
	// header to hold four flat siblings is scaffolding for a hierarchy this block
	// does not have, and it put a second vertical edge two cells inside the rail,
	// which is the block's own left edge.
	const rows = visible.map(session => {
		const idText = cell(formatTaskId(session.id), body);
		let line = `${dot} ${theme.fg("accent", theme.bold(idText))}`;
		let left = body - visibleWidth(idText);
		const resolved = session.progress?.resolvedModel;
		let badge =
			options.showModelBadge && resolved ? truncateToWidth(modelBadgeFromSelector(resolved, theme), BADGE_MAX) : "";
		// A dim arrow when this is not the model the agent started on. The badge
		// alone says what it runs on and cannot say that it is not what you picked,
		// which is the question behind "why is this one slower than the others".
		if (badge !== "" && session.progress?.fellBackFrom) badge = `${theme.fg("dim", "↓")}${badge}`;
		let badgeWidth = badge === "" ? 0 : visibleWidth(badge) + visibleWidth(theme.sep.dot);
		// The badge is fixed cost, so it comes out of the row budget before the
		// description does. It goes when it does not fit at all, and it goes when
		// what is left could not hold a readable description: it is a name that does
		// not change for the agent's whole run, and the description says what the
		// agent is for.
		if (badge !== "" && left - badgeWidth < Math.min(TRUNCATE_LENGTHS.SHORT + DESCRIPTION_SEP, left)) {
			badge = "";
			badgeWidth = 0;
		}
		left -= badgeWidth;
		// The spawn description and never the prompt: a task's prompt is
		// paragraphs, and the block is a list of what is running.
		const description = session.description?.trim() || session.progress?.description?.trim();
		if (description) {
			const shown = cell(description, Math.max(0, left - DESCRIPTION_SEP));
			if (shown !== "") line += `${theme.fg("accent", ":")} ${theme.fg("accent", shown)}`;
		}
		if (badge !== "") line += `${theme.sep.dot}${badge}`;
		return line;
	});
	if (hidden > 0) {
		// The count lives here and nowhere else: it is news only when the block
		// stopped drawing agents, and this row exists only then.
		rows.push(theme.fg("dim", cell(`… ${hidden} more running — /agents for the full roster`, content)));
	}

	// The rail is one edge from the header to the last row, drawn in one colour:
	// the sweep is the motion, and a gap in the edge reads as a broken block.
	const railCell = theme.fg("dim", rail);
	const lines = [`${railCell} ${theme.bold(theme.fg("accent", cell("Subagents", content)))}`];
	for (let ri = 0; ri < rows.length; ri++) lines.push(`${railCell} ${rows[ri]!}`.trimEnd());
	return ["", ...lines];
}
