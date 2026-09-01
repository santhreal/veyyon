import type { Component } from "@veyyon/tui";
import { Text } from "@veyyon/tui";
import { errorMessage, logger, prompt } from "@veyyon/utils";
import { type } from "arktype";
import type { Theme } from "../modes/theme/theme";
import { toolsPrompts } from "../prompts/tools/rows";
import {
	buildDiscoverableToolSearchIndex,
	type DiscoverableTool,
	type DiscoverableToolSearchIndex,
	filterBySource,
	formatDiscoverableToolServerSummary,
	summarizeDiscoverableTools,
} from "../tool-discovery/tool-index";
import { renderStatusLine, truncateToWidth } from "../tui";
import type { ToolSession } from ".";
import { formatExpandHint, formatMoreItems, replaceTabs, TRUNCATE_LENGTHS } from "./render-utils";

export const DEFAULT_LIMIT = 8;
export const TOOL_DISCOVERY_TITLE = "Tool Discovery";
export const COLLAPSED_MATCH_LIMIT = 5;
export const MATCH_LABEL_LEN = 72;
export const MATCH_DESCRIPTION_LEN = 96;

export const searchToolBm25Schema = type({
	query: type("string").describe("tool search query"),
	"limit?": type("number>0").describe("max matches"),
});

export type SearchToolBm25Params = typeof searchToolBm25Schema.infer;

export interface SearchToolBm25Match {
	name: string;
	label: string;
	description: string;
	server_name?: string;
	mcp_tool_name?: string;
	schema_keys: string[];
	score: number;
}

export interface SearchToolBm25Details {
	query: string;
	limit: number;
	total_tools: number;
	activated_tools: string[];
	active_selected_tools: string[];
	tools: SearchToolBm25Match[];
}

export function formatMatch(tool: DiscoverableTool, score: number): SearchToolBm25Match {
	return {
		name: tool.name,
		label: tool.label,
		description: tool.summary,
		server_name: tool.serverName,
		mcp_tool_name: tool.mcpToolName,
		schema_keys: tool.schemaKeys,
		score: Number(score.toFixed(6)),
	};
}

export function buildSearchToolBm25Content(details: SearchToolBm25Details): string {
	return JSON.stringify({
		query: details.query,
		activated_tools: details.activated_tools,
		match_count: details.tools.length,
		total_tools: details.total_tools,
	});
}

export function getDiscoverableToolsForDescription(session: ToolSession): DiscoverableTool[] {
	try {
		return session.getDiscoverableTools?.() ?? [];
	} catch (error) {
		logger.warn("Discoverable tool inventory could not be read; search_tool_bm25 is describing an empty inventory", {
			error: errorMessage(error),
		});
		return [];
	}
}

export function getDiscoverableToolSearchIndexForExecution(session: ToolSession): DiscoverableToolSearchIndex {
	try {
		const cached = session.getDiscoverableToolSearchIndex?.();
		if (cached) return cached;
	} catch (error) {
		logger.warn("Cached discoverable-tool search index threw; rebuilding it for this call", {
			error: errorMessage(error),
		});
	}
	return buildDiscoverableToolSearchIndex(getDiscoverableToolsForDescription(session));
}

export function getSelectedToolNames(session: ToolSession): string[] {
	if (session.getSelectedDiscoveredToolNames) {
		return session.getSelectedDiscoveredToolNames();
	}
	return session.getSelectedMCPToolNames?.() ?? [];
}

export async function activateTools(session: ToolSession, toolNames: string[]): Promise<string[]> {
	if (session.activateDiscoveredTools) {
		return session.activateDiscoveredTools(toolNames);
	}
	if (session.activateDiscoveredMCPTools) {
		return session.activateDiscoveredMCPTools(toolNames);
	}
	return [];
}

export type DiscoveryExecutionSession = ToolSession & {
	_supportsDiscoveryExecution: true;
};

export function supportsToolDiscoveryExecution(session: ToolSession): session is DiscoveryExecutionSession {
	if (
		typeof session.isToolDiscoveryEnabled === "function" &&
		typeof session.getSelectedDiscoveredToolNames === "function" &&
		typeof session.activateDiscoveredTools === "function"
	) {
		return true;
	}
	if (
		typeof session.isMCPDiscoveryEnabled === "function" &&
		typeof session.getSelectedMCPToolNames === "function" &&
		typeof session.activateDiscoveredMCPTools === "function"
	) {
		return true;
	}
	return false;
}

export function isDiscoveryEnabled(session: ToolSession): boolean {
	if (typeof session.isToolDiscoveryEnabled === "function") {
		return session.isToolDiscoveryEnabled();
	}
	return session.isMCPDiscoveryEnabled?.() ?? false;
}

export function renderSearchToolBm25Description(discoverableTools: DiscoverableTool[] = []): string {
	const summary = summarizeDiscoverableTools(discoverableTools);
	const builtinToolNames = filterBySource(discoverableTools, "builtin")
		.map(t => t.name)
		.sort();
	return prompt.render(toolsPrompts["tools/search-tool-bm25"].text, {
		discoverableToolCount: summary.toolCount,
		discoverableMCPServerSummaries: summary.servers.map(formatDiscoverableToolServerSummary),
		hasDiscoverableMCPServers: summary.servers.length > 0,
		discoverableBuiltinToolNames: builtinToolNames,
		hasDiscoverableBuiltinTools: builtinToolNames.length > 0,
	});
}

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

export function renderMatchBullets(tools: SearchToolBm25Match[], expanded: boolean, theme: Theme): string[] {
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

export function renderFallbackResult(text: string, theme: Theme): Component {
	const header = renderStatusLine({ icon: "warning", title: TOOL_DISCOVERY_TITLE }, theme);
	const bodyRaw = (text || "Tool discovery completed").split("\n");
	const bodyLines: string[] = new Array(bodyRaw.length);
	for (let li = 0; li < bodyRaw.length; li++) {
		bodyLines[li] = theme.fg("dim", truncateToWidth(replaceTabs(bodyRaw[li]!), TRUNCATE_LENGTHS.LINE));
	}
	return new Text([header, ...bodyLines].join("\n"), 0, 0);
}
