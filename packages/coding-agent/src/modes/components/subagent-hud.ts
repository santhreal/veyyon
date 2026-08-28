/** The anchored Subagents block: a header and a tree of running agents. This is the block as it was before 1.2.0, restored. It was rebuilt as a table */

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

/** Text fit into one cell of one row. A newline is folded to a space before anything else happens. Descriptions are */
function cell(text: string, width: number): string {
	return truncateToWidth(replaceTabs(text).replace(/[\r\n]+/g, " "), width);
}

/** Build the anchored subagent HUD block: a bold accent "Subagents" header plus a bounded set of running-agent rows in the same `Id: description` shape the */
export function renderSubagentHudLines(sessions: readonly ObservableSession[], options: SubagentHudOptions): string[] {
	const running: ObservableSession[] = [];
	for (let si = 0; si < sessions.length; si++) {
		const session = sessions[si]!;
		if (session.kind === "subagent" && session.status === "active" && session.detached === true) {
			running.push(session);
		}
	}
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
	// `body` is what a row has left after the rail, its space, the mark and its space, and every budget below is charged against it. Budgeting against the
	const body = content - visibleWidth(dot) - 1;
	// A rail, a mark and no room for one letter of a name is chrome and not a block. The empty block is how this says so — the same path it takes when
	if (body < 1) return [];

	// One row per agent, with no tree connectors. Four branches drawn under a header to hold four flat siblings is scaffolding for a hierarchy this block
	const rows: string[] = new Array(visible.length);
	for (let si = 0; si < visible.length; si++) {
		const session = visible[si]!;
		const idText = cell(formatTaskId(session.id), body);
		let line = `${dot} ${theme.fg("accent", theme.bold(idText))}`;
		let left = body - visibleWidth(idText);
		const resolved = session.progress?.resolvedModel;
		let badge =
			options.showModelBadge && resolved ? truncateToWidth(modelBadgeFromSelector(resolved, theme), BADGE_MAX) : "";
		if (badge !== "" && session.progress?.fellBackFrom) badge = `${theme.fg("dim", "↓")}${badge}`;
		let badgeWidth = badge === "" ? 0 : visibleWidth(badge) + visibleWidth(theme.sep.dot);
		if (badge !== "" && left - badgeWidth < Math.min(TRUNCATE_LENGTHS.SHORT + DESCRIPTION_SEP, left)) {
			badge = "";
			badgeWidth = 0;
		}
		left -= badgeWidth;
		const description = session.description?.trim() || session.progress?.description?.trim();
		if (description) {
			const shown = cell(description, Math.max(0, left - DESCRIPTION_SEP));
			if (shown !== "") line += `${theme.fg("accent", ":")} ${theme.fg("accent", shown)}`;
		}
		if (badge !== "") line += `${theme.sep.dot}${badge}`;
		rows[si] = line;
	}
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
