/**
 * A session's tool discovery mode: resolved once its tool registry is complete, raised when deferred
 * MCP tools push `auto` past its threshold, and the `search_tool_bm25` registration that follows it.
 */

import type { Settings } from "../config/settings";
import {
	countToolsForAutoDiscovery,
	type EffectiveToolDiscoveryMode,
	resolveEffectiveToolDiscoveryMode,
} from "../discovery/mode";
import {
	collectDiscoverableTools,
	filterBySource,
	isMCPToolName,
	selectDiscoverableToolNamesByServer,
} from "../discovery/tool-index";
import type { CustomTool } from "../extensibility/custom-tools/types";
import { type ExtensionRunner, ExtensionToolWrapper } from "../extensibility/extensions";
import type { Tool, ToolSession } from "../tools";
import { TOOL } from "../tools/core/builtin-names";
import { wrapToolWithMetaNotice } from "../tools/core/output-meta";
import { SearchToolBm25Tool } from "../tools/search/search-tool-bm25";
import type { AgentSession } from "./agent-session";

/** What {@link SessionToolDiscovery} reads. */
export interface SessionToolDiscoveryInput {
	/** The complete registry: built-in, extension, SDK-custom and startup MCP tools. */
	tools: Map<string, Tool>;
	/** Built-ins by provenance; `search_tool_bm25` joins them when discovery starts on. */
	builtInNames: Set<string>;
	settings: Settings;
	toolSession: ToolSession;
	extensionRunner: ExtensionRunner;
}

/**
 * A session's tool discovery mode. Resolved once the registry is complete, so `auto` counts MCP and
 * extension tools, and raised from `off` when deferred MCP tools push `auto` past its threshold.
 * While discovery is on, the registry holds `search_tool_bm25`.
 */
export class SessionToolDiscovery {
	#mode: EffectiveToolDiscoveryMode;
	readonly #input: SessionToolDiscoveryInput;

	constructor(input: SessionToolDiscoveryInput) {
		this.#input = input;
		this.#mode = resolveEffectiveToolDiscoveryMode(input.settings, countToolsForAutoDiscovery(input.tools.keys()));
		if (this.enabled && this.#addSearchTool()) input.builtInNames.add(TOOL.search_tool_bm25);
	}

	get mode(): EffectiveToolDiscoveryMode {
		return this.#mode;
	}

	/** Whether any discovery mode is active. */
	get enabled(): boolean {
		return this.#mode !== "off";
	}

	/**
	 * Turn discovery on for `liveSession` when `mcpTools` joining the registry push `auto` past its
	 * threshold, activating `search_tool_bm25`. Resolves whether discovery is on afterwards.
	 */
	async enableForMCPTools(liveSession: AgentSession, mcpTools: CustomTool[]): Promise<boolean> {
		if (this.enabled) return true;
		const nonMCPToolNames = Array.from(this.#input.tools.keys()).filter(name => !isMCPToolName(name));
		const projectedMode = resolveEffectiveToolDiscoveryMode(
			this.#input.settings,
			countToolsForAutoDiscovery(nonMCPToolNames.concat(mcpTools.map(tool => tool.name))),
		);
		if (projectedMode === "off") return false;

		this.#mode = projectedMode;
		liveSession.enableMCPDiscovery();
		this.#addSearchTool();
		const activeToolNames = liveSession.getActiveToolNames();
		if (!activeToolNames.includes(TOOL.search_tool_bm25)) {
			await liveSession.setActiveToolsByName(activeToolNames.concat([TOOL.search_tool_bm25]));
		}
		return true;
	}

	/**
	 * Replace `liveSession`'s MCP tools with `mcpTools`. A deferred discovery that leaves discovery off
	 * activates every one of them, since none is reachable through search.
	 */
	async refreshMCPTools(liveSession: AgentSession, mcpTools: CustomTool[], deferred: boolean): Promise<void> {
		const activateAll = deferred && !this.enabled && !(await this.enableForMCPTools(liveSession, mcpTools));
		await liveSession.refreshMCPTools(mcpTools, activateAll ? { activateAll: true } : undefined);
	}

	/** The MCP tools of `servers` a session selects by default. Empty while discovery is off. */
	defaultServerToolNames(servers: ReadonlySet<string>): string[] {
		if (!this.enabled) return [];
		return selectDiscoverableToolNamesByServer(
			filterBySource(collectDiscoverableTools(this.#input.tools.values()), "mcp"),
			servers,
		);
	}

	/** Register `search_tool_bm25` unless the registry holds it. Returns whether it was added. */
	#addSearchTool(): boolean {
		const { tools, toolSession, extensionRunner } = this.#input;
		if (tools.has(TOOL.search_tool_bm25)) return false;
		const searchTool: Tool = new SearchToolBm25Tool(toolSession);
		tools.set(searchTool.name, new ExtensionToolWrapper(wrapToolWithMetaNotice(searchTool), extensionRunner) as Tool);
		return true;
	}
}
