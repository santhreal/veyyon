import { visibleWidth } from "@veyyon/tui";
import { formatTaskId } from "../../task/render";
import { replaceTabs, TRUNCATE_LENGTHS, truncateToWidth } from "../../tools/render-utils";
import type { ObservableSession } from "../session-observer-registry";
import { theme } from "../theme/theme";
import { modelBadgeFromSelector } from "./agent-model-badge";

export const SUBAGENT_HUD_VISIBLE_LIMIT = 8;
const BADGE_MAX = 30;
const DESCRIPTION_SEP = 2;

export interface SubagentHudOptions {
	columns: number;
	showModelBadge: boolean;
}

function cell(text: string, width: number): string {
	return truncateToWidth(replaceTabs(text).replace(/[\r\n]+/g, " "), width);
}

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
	const usable = Math.max(1, options.columns - 1);
	const content = Math.max(0, usable - visibleWidth(rail) - 1);
	const body = content - visibleWidth(dot) - 1;
	if (body < 1) return [];

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
		rows.push(theme.fg("dim", cell(`… ${hidden} more running — /agents for the full roster`, content)));
	}

	const railCell = theme.fg("dim", rail);
	const lines = [`${railCell} ${theme.bold(theme.fg("accent", cell("Subagents", content)))}`];
	for (let ri = 0; ri < rows.length; ri++) lines.push(`${railCell} ${rows[ri]!}`.trimEnd());
	return ["", ...lines];
}
