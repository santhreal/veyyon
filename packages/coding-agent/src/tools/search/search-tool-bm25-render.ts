/**
 * Terminal drawing for the search_tool_bm25 tool. The tool half in `search-tool-bm25.ts` decides what
 * happened; this half decides how a terminal shows it, and is the only one of the two
 * that reaches the TUI.
 */

import type { Component } from "@veyyon/tui";
import { Text } from "@veyyon/tui";
import type { RenderResultOptions } from "../../extensibility/custom-tools/types";
import type { Theme } from "../../theme/theme";
import { framedBlock, renderStatusLine, truncateToWidth } from "../../tui";
import { formatCount, formatExpandHint, formatMoreItems, replaceTabs, TRUNCATE_LENGTHS } from "../core/render-utils";
import {
	COLLAPSED_MATCH_LIMIT,
	type SearchToolBm25Details,
	type SearchToolBm25Match,
	type SearchToolBm25Params,
} from "./search-tool-bm25";

const TOOL_DISCOVERY_TITLE = "Tool Discovery";
const MATCH_LABEL_LEN = 72;
const MATCH_DESCRIPTION_LEN = 96;
function renderMatchLines(match: SearchToolBm25Match, theme: Theme): string[] {
	const safeServerName = match.server_name ? replaceTabs(match.server_name) : undefined;
	const safeLabel = replaceTabs(match.label);
	const safeDescription = replaceTabs(match.description.trim());
	const metaParts: string[] = [];
	if (safeServerName) metaParts.push(theme.fg("muted", safeServerName));
	metaParts.push(theme.fg("dim", `score ${match.score.toFixed(3)}`));
	const metaSep = theme.fg("dim", theme.sep.dot);
	const metaSuffix = metaParts.length > 0 ? ` ${metaParts.join(metaSep)}` : "";
	const lines = [`${theme.fg("accent", truncateToWidth(safeLabel, MATCH_LABEL_LEN))}${metaSuffix}`];
	if (safeDescription) {
		lines.push(theme.fg("muted", truncateToWidth(safeDescription, MATCH_DESCRIPTION_LEN)));
	}
	return lines;
}

function renderMatchBullets(tools: SearchToolBm25Match[], expanded: boolean, theme: Theme): string[] {
	const shown = expanded ? tools.length : Math.min(tools.length, COLLAPSED_MATCH_LIMIT);
	const bullet = theme.fg("dim", theme.format.bullet);
	const lines: string[] = [];
	for (let i = 0; i < shown; i++) {
		const itemLines = renderMatchLines(tools[i]!, theme);
		lines.push(`${bullet} ${itemLines[0]}`);
		for (let j = 1; j < itemLines.length; j++) {
			lines.push(`  ${itemLines[j]}`);
		}
	}
	const remaining = tools.length - shown;
	if (remaining > 0) {
		const hint = formatExpandHint(theme, expanded, true);
		lines.push(`${theme.fg("muted", formatMoreItems(remaining, "tool"))}${hint ? ` ${hint}` : ""}`);
	}
	return lines;
}

function renderFallbackResult(text: string, theme: Theme): Component {
	const header = renderStatusLine({ icon: "warning", title: TOOL_DISCOVERY_TITLE }, theme);
	const bodyLines = (text || "Tool discovery completed")
		.split("\n")
		.map(line => theme.fg("dim", truncateToWidth(replaceTabs(line), TRUNCATE_LENGTHS.LINE)));
	return new Text([header, ...bodyLines].join("\n"), 0, 0);
}

export const searchToolBm25Renderer = {
	renderCall(args: SearchToolBm25Params, _options: RenderResultOptions, uiTheme: Theme): Component {
		const query = typeof args.query === "string" ? replaceTabs(args.query.trim()) : "";
		const meta = args.limit ? [`limit:${args.limit}`] : [];
		const header = renderStatusLine(
			{ icon: "pending", title: TOOL_DISCOVERY_TITLE, description: query || "(empty query)", meta },
			uiTheme,
		);
		return new Text(header, 0, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: SearchToolBm25Details; isError?: boolean },
		options: RenderResultOptions,
		uiTheme: Theme,
	): Component {
		if (!result.details) {
			const fallbackText = result.content
				.filter(part => part.type === "text")
				.map(part => part.text)
				.filter((text): text is string => typeof text === "string" && text.length > 0)
				.join("\n");
			return renderFallbackResult(fallbackText, uiTheme);
		}

		const { details } = result;
		const meta = [
			formatCount("match", details.tools.length),
			`${details.active_selected_tools.length} active`,
			`${details.total_tools} total`,
			`limit:${details.limit}`,
		];
		const safeQuery = replaceTabs(details.query);
		const header = renderStatusLine(
			{
				...(details.tools.length > 0
					? { iconOverride: uiTheme.fg("accent", uiTheme.symbol("icon.search")) }
					: { icon: "warning" as const }),
				title: TOOL_DISCOVERY_TITLE,
				description: truncateToWidth(safeQuery, MATCH_LABEL_LEN),
				meta,
			},
			uiTheme,
		);
		if (details.tools.length === 0) {
			const emptyMessage =
				details.total_tools === 0 ? "No discoverable tools are currently loaded." : "No matching tools found.";
			return new Text(`${header}\n${uiTheme.fg("muted", emptyMessage)}`, 0, 0);
		}

		return framedBlock(uiTheme, width => ({
			header,
			sections: [{ lines: renderMatchBullets(details.tools, options.expanded ?? false, uiTheme) }],
			state: "success",
			borderColor: "borderMuted",
			applyBg: false,
			width,
		}));
	},

	mergeCallAndResult: true,
	inline: true,
};
