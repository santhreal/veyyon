import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@veyyon/agent-core";
import type { Component } from "@veyyon/tui";
import { Text } from "@veyyon/tui";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "../modes/theme/theme";
import { resolveEffectiveToolDiscoveryMode } from "../tool-discovery/mode";
import { type DiscoverableTool, searchDiscoverableTools } from "../tool-discovery/tool-index";
import { framedBlock, renderStatusLine, truncateToWidth } from "../tui";
import type { ToolSession } from ".";
import { formatCount, replaceTabs } from "./render-utils";
import type { SearchToolBm25Details, SearchToolBm25Params } from "./search-tool-bm25-helpers";

import {
	activateTools,
	buildSearchToolBm25Content,
	DEFAULT_LIMIT,
	formatMatch,
	getDiscoverableToolSearchIndexForExecution,
	getDiscoverableToolsForDescription,
	getSelectedToolNames,
	isDiscoveryEnabled,
	MATCH_LABEL_LEN,
	renderFallbackResult,
	renderMatchBullets,
	renderSearchToolBm25Description,
	searchToolBm25Schema,
	supportsToolDiscoveryExecution,
	TOOL_DISCOVERY_TITLE,
} from "./search-tool-bm25-helpers";
import { ToolError } from "./tool-errors";

export { renderSearchToolBm25Description };

export class SearchToolBm25Tool implements AgentTool<typeof searchToolBm25Schema, SearchToolBm25Details> {
	readonly name = "search_tool_bm25";
	readonly approval = "read" as const;
	readonly label = "SearchTools";
	readonly loadMode = "essential";
	get description(): string {
		return renderSearchToolBm25Description(getDiscoverableToolsForDescription(this.session));
	}
	readonly parameters = searchToolBm25Schema;
	readonly strict = true;

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): SearchToolBm25Tool | null {
		if (resolveEffectiveToolDiscoveryMode(session.settings, 0) === "off") return null;
		return supportsToolDiscoveryExecution(session) ? new SearchToolBm25Tool(session) : null;
	}

	async execute(
		_toolCallId: string,
		params: SearchToolBm25Params,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<SearchToolBm25Details>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<SearchToolBm25Details>> {
		if (!supportsToolDiscoveryExecution(this.session)) {
			throw new ToolError("Tool discovery is unavailable in this session.");
		}
		if (!isDiscoveryEnabled(this.session)) {
			throw new ToolError(
				"Tool discovery is disabled. Enable tools.discoveryMode or mcp.discoveryMode to use search_tool_bm25.",
			);
		}

		const query = params.query.trim();
		if (query.length === 0) {
			throw new ToolError("Query is required and must not be empty.");
		}
		const limit = params.limit ?? DEFAULT_LIMIT;
		if (!Number.isInteger(limit) || limit <= 0) {
			throw new ToolError("Limit must be a positive integer.");
		}

		const searchIndex = getDiscoverableToolSearchIndexForExecution(this.session);
		if (searchIndex.documents.length === 0) {
			throw new ToolError(
				"The discoverable-tool inventory is empty, which should not happen while tool discovery is enabled. " +
					"The session log carries the reason. Use the tools already active, or ask the operator to check it.",
			);
		}
		const selectedToolNames = new Set(getSelectedToolNames(this.session));
		let ranked: Array<{ tool: DiscoverableTool; score: number }> = [];
		try {
			ranked = searchDiscoverableTools(searchIndex, query, searchIndex.documents.length)
				.filter(result => !selectedToolNames.has(result.tool.name))
				.slice(0, limit);
		} catch (error) {
			if (error instanceof Error) {
				throw new ToolError(error.message);
			}
			throw error;
		}
		const activated =
			ranked.length > 0
				? await activateTools(
						this.session,
						ranked.map(result => result.tool.name),
					)
				: [];

		const details: SearchToolBm25Details = {
			query,
			limit,
			total_tools: searchIndex.documents.length,
			activated_tools: activated,
			active_selected_tools: getSelectedToolNames(this.session),
			tools: ranked.map(result => formatMatch(result.tool, result.score)),
		};

		return {
			content: [{ type: "text", text: buildSearchToolBm25Content(details) }],
			details,
		};
	}
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
			const parts: string[] = [];
			for (let ci = 0; ci < result.content.length; ci++) {
				const part = result.content[ci]!;
				if (part.type === "text" && typeof part.text === "string" && part.text.length > 0) {
					parts.push(part.text);
				}
			}
			const fallbackText = parts.join("\n");
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
