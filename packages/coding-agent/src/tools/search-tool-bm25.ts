import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@veyyon/agent-core";
import { errorMessage, logger, prompt } from "@veyyon/utils";
import { type } from "arktype";
import { resolveEffectiveToolDiscoveryMode } from "../discovery/mode";
import {
	buildDiscoverableToolSearchIndex,
	type DiscoverableTool,
	type DiscoverableToolSearchIndex,
	filterBySource,
	formatDiscoverableToolServerSummary,
	searchDiscoverableTools,
	summarizeDiscoverableTools,
} from "../discovery/tool-index";
import { toolsPrompts } from "../prompts/tools/rows";
import type { ToolSession } from ".";
import { ToolError } from "./tool-errors";

const DEFAULT_LIMIT = 8;
export const COLLAPSED_MATCH_LIMIT = 5;
/**
 * How close to the best match a tool must score to be activated by the same
 * call. BM25 rank order is not a decision: a natural-language query matches the
 * tail of the inventory weakly, and activating that tail bills its schema on
 * every later request of the session, silently. Measured on the default hidden
 * set, "keep track of what is left to do" activated `todo` plus `set_cwd`,
 * `task` and `web_search`, costing 2,239 tokens a request where `todo` alone
 * costs 1,048. A near-tie is still activated, because a fuzzy query whose best
 * answer is rank two is what this tool exists to serve.
 */
const ACTIVATION_SCORE_FLOOR = 0.5;

const searchToolBm25Schema = type({
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
	/** Ranked matches the score floor kept out of the activation, names only. */
	also_matched: string[];
	active_selected_tools: string[];
	tools: SearchToolBm25Match[];
}

function formatMatch(tool: DiscoverableTool, score: number): SearchToolBm25Match {
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

function buildSearchToolBm25Content(details: SearchToolBm25Details): string {
	return JSON.stringify({
		query: details.query,
		activated_tools: details.activated_tools,
		...(details.also_matched.length > 0 ? { also_matched: details.also_matched } : {}),
		match_count: details.tools.length,
		total_tools: details.total_tools,
	});
}

/**
 * The discoverable-tool inventory, for rendering this tool's description.
 *
 * A throw here is reported and the description falls back to the empty inventory, because a
 * broken inventory must not prevent the session from starting — but it is NOT silent. The
 * description is built at prompt-build time, and rendering "no tools are currently
 * discoverable" for a session that has fifteen of them tells the model the capability does
 * not exist, which is a recall loss with no symptom (Law 10). The warning is how an operator
 * finds out.
 */
function getDiscoverableToolsForDescription(session: ToolSession): DiscoverableTool[] {
	try {
		return session.getDiscoverableTools?.() ?? [];
	} catch (error) {
		logger.warn("Discoverable tool inventory could not be read; search_tool_bm25 is describing an empty inventory", {
			error: errorMessage(error),
		});
		return [];
	}
}

/**
 * The search index, for an actual `search_tool_bm25` call.
 *
 * Rebuilding when the session has no cached index is the ordinary path, not a fallback: the
 * cache is a cache. A cache getter that THROWS is a different matter — that is a defect
 * somewhere else, and swallowing it hid the one signal that would have led to it, so it is
 * reported before the rebuild.
 *
 * The rebuild reads the same inventory as the description path, so a broken inventory
 * surfaces there as a warning and here as an empty index. An empty index is why `execute`
 * refuses rather than answering "no matches": see the check at its call site.
 */
function getDiscoverableToolSearchIndexForExecution(session: ToolSession): DiscoverableToolSearchIndex {
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

/** Resolve the effective selected tool names (generic or legacy MCP). */
function getSelectedToolNames(session: ToolSession): string[] {
	if (session.getSelectedDiscoveredToolNames) {
		return session.getSelectedDiscoveredToolNames();
	}
	return session.getSelectedMCPToolNames?.() ?? [];
}

/** Activate tools (generic or legacy MCP fallback). */
async function activateTools(session: ToolSession, toolNames: string[]): Promise<string[]> {
	if (session.activateDiscoveredTools) {
		return session.activateDiscoveredTools(toolNames);
	}
	if (session.activateDiscoveredMCPTools) {
		return session.activateDiscoveredMCPTools(toolNames);
	}
	return [];
}

type DiscoveryExecutionSession = ToolSession & {
	_supportsDiscoveryExecution: true;
};

function supportsToolDiscoveryExecution(session: ToolSession): session is DiscoveryExecutionSession {
	// Supports generic discovery
	if (
		typeof session.isToolDiscoveryEnabled === "function" &&
		typeof session.getSelectedDiscoveredToolNames === "function" &&
		typeof session.activateDiscoveredTools === "function"
	) {
		return true;
	}
	// Supports legacy MCP discovery
	if (
		typeof session.isMCPDiscoveryEnabled === "function" &&
		typeof session.getSelectedMCPToolNames === "function" &&
		typeof session.activateDiscoveredMCPTools === "function"
	) {
		return true;
	}
	return false;
}

function isDiscoveryEnabled(session: ToolSession): boolean {
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

/**
 * SearchToolsTool — wire name `search_tool_bm25` (preserved for persisted session back-compat).
 *
 * When tools.discoveryMode === "all", this covers both MCP tools and built-in discoverable tools.
 * When tools.discoveryMode === "mcp-only" or mcp.discoveryMode === true, only MCP tools are searched.
 */
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
		// Direct createTools() calls do not know the final MCP/extension catalog yet, so
		// auto mode is activated later by createAgentSession after the full registry exists.
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
		// Discovery is enabled (checked above) and yet there is nothing to search, which means
		// the inventory could not be read rather than that this session has no discoverable
		// tools. Answering "0 matches" would teach the model the capability does not exist and
		// it would stop asking — the invisible recall loss Law 10 is about. Refuse instead, so
		// the failure reaches the transcript and the model can try another route.
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
		// An activation is billed on every later request of the session, so it
		// follows the score band and not the rank order: a weak tail match is
		// reported instead, and a second query by name activates it for 20 tokens.
		const bestScore = ranked[0]?.score ?? 0;
		const activating = ranked.filter(result => result.score >= bestScore * ACTIVATION_SCORE_FLOOR);
		const activated =
			activating.length > 0
				? await activateTools(
						this.session,
						activating.map(result => result.tool.name),
					)
				: [];
		const alsoMatched = ranked.filter(result => !activating.includes(result)).map(result => result.tool.name);

		const details: SearchToolBm25Details = {
			query,
			limit,
			total_tools: searchIndex.documents.length,
			activated_tools: activated,
			also_matched: alsoMatched,
			active_selected_tools: getSelectedToolNames(this.session),
			tools: ranked.map(result => formatMatch(result.tool, result.score)),
		};

		return {
			content: [{ type: "text", text: buildSearchToolBm25Content(details) }],
			details,
		};
	}
}
