/**
 * MCP tool selection + generic tool discovery state: which MCP tools the
 * session has selected (persisted per session), the discoverable-tool caches
 * (registry-derived MCP map + BM25 search index), configured/session default
 * selections, and the discovery-mode gates. Applying a tool set to the agent
 * (system-prompt rebuild, ACP permission wrapping) stays on the session and is
 * reached through {@link McpToolSelectionDeps} closures.
 */
import path from "node:path";
import type { AgentTool } from "@veyyon/pi-agent-core";
import type { Settings } from "../config/settings";
import { countToolsForAutoDiscovery, resolveEffectiveToolDiscoveryMode } from "../tool-discovery/mode";
import {
	buildDiscoverableToolSearchIndex,
	collectDiscoverableTools,
	type DiscoverableTool,
	type DiscoverableToolSearchIndex,
	filterBySource,
	isMCPToolName,
	selectDiscoverableToolNamesByServer,
} from "../tool-discovery/tool-index";
import type { SessionContext } from "./session-context";
import type { SessionManager } from "./session-manager";

/** Initial selection state handed over from `AgentSessionConfig` at construction. */
export interface McpToolSelectionConfig {
	mcpDiscoveryEnabled?: boolean;
	initialSelectedMCPToolNames?: string[];
	defaultSelectedMCPServerNames?: string[];
	defaultSelectedMCPToolNames?: string[];
}

/** Session facilities the selection state drives; closures over AgentSession privates. */
export interface McpToolSelectionDeps {
	/** The live tool registry, shared by reference — the session mutates it. */
	toolRegistry: Map<string, AgentTool>;
	settings: Settings;
	sessionManager: SessionManager;
	getSessionFile(): string | undefined;
	getActiveToolNames(): string[];
	setActiveToolsByName(toolNames: string[]): Promise<void>;
	applyActiveToolsByName(
		toolNames: string[],
		options?: { persistMCPSelection?: boolean; previousSelectedMCPToolNames?: string[] },
	): Promise<void>;
}

/** Order-sensitive equality for persisted MCP tool-name lists. */
export function selectedMCPToolNamesMatch(left: string[], right: string[]): boolean {
	return left.length === right.length && left.every((name, index) => name === right[index]);
}

export class McpToolSelection {
	readonly #deps: McpToolSelectionDeps;
	#mcpDiscoveryEnabled: boolean;
	#discoverableMCPTools = new Map<string, DiscoverableTool>();
	#selectedMCPToolNames: Set<string>;
	/** Cached BM25 index over the discoverable tool list; null → rebuild on next read. */
	#discoverableToolSearchIndex: DiscoverableToolSearchIndex | null = null;
	/** Non-MCP tools activated through discovery; deselected when they go inactive. */
	#selectedDiscoveredToolNames = new Set<string>();
	#defaultSelectedMCPServerNames: Set<string>;
	#defaultSelectedMCPToolNames: Set<string>;
	/** Per-session-file snapshot of the configured default selection at last visit. */
	#sessionDefaultSelectedMCPToolNames = new Map<string, string[]>();

	constructor(config: McpToolSelectionConfig, deps: McpToolSelectionDeps) {
		this.#deps = deps;
		this.#mcpDiscoveryEnabled = config.mcpDiscoveryEnabled ?? false;
		this.#selectedMCPToolNames = new Set(config.initialSelectedMCPToolNames ?? []);
		this.#defaultSelectedMCPServerNames = new Set(config.defaultSelectedMCPServerNames ?? []);
		this.#defaultSelectedMCPToolNames = new Set(config.defaultSelectedMCPToolNames ?? []);
	}

	isMCPDiscoveryEnabled(): boolean {
		return this.#mcpDiscoveryEnabled;
	}

	/**
	 * Flip MCP discovery on after deferred discovery learns the real tool count.
	 * UI sessions resolve `tools.discoveryMode: "auto"` before MCP servers
	 * connect, so a large MCP toolset discovered later must be able to upgrade
	 * the session from the force-activate path to the discovery path. One-way:
	 * discovery is never downgraded mid-session.
	 */
	enableMCPDiscovery(): void {
		this.#mcpDiscoveryEnabled = true;
	}

	/** Rebuild the discoverable-MCP map from the current registry contents. */
	refreshDiscoverableFromRegistry(): void {
		const mcpTools = filterBySource(collectDiscoverableTools(this.#deps.toolRegistry.values()), "mcp");
		this.#discoverableMCPTools = new Map(mcpTools.map(tool => [tool.name, tool] as const));
		this.invalidateDiscoveryCaches();
	}

	/** Single point for invalidating cached discovery indices. Call after any change that can
	 *  affect which tools should be discoverable: registry mutations (refreshMCPTools,
	 *  refreshRpcHostTools) or active-tool mutations (#applyActiveToolsByName). */
	invalidateDiscoveryCaches(): void {
		this.#discoverableToolSearchIndex = null;
	}

	filterSelectableMCPToolNames(toolNames: Iterable<string>): string[] {
		return Array.from(toolNames).filter(
			name => this.#discoverableMCPTools.has(name) && this.#deps.toolRegistry.has(name),
		);
	}

	getConfiguredDefaultSelectedMCPToolNames(): string[] {
		return this.filterSelectableMCPToolNames([
			...this.#defaultSelectedMCPToolNames,
			...selectDiscoverableToolNamesByServer(
				this.#discoverableMCPTools.values(),
				this.#defaultSelectedMCPServerNames,
			),
		]);
	}

	/** The configured default MCP selection, unfiltered (session-boundary carryover). */
	defaultSelectedMCPToolNamesFiltered(): string[] {
		return this.filterSelectableMCPToolNames(this.#defaultSelectedMCPToolNames);
	}

	pruneSelectedMCPToolNames(): void {
		this.#selectedMCPToolNames = new Set(this.filterSelectableMCPToolNames(this.#selectedMCPToolNames));
	}

	/** Merge the configured defaults into the current selection (no persisted selection yet). */
	mergeConfiguredDefaultsIntoSelection(): void {
		this.#selectedMCPToolNames = new Set([
			...this.#selectedMCPToolNames,
			...this.getConfiguredDefaultSelectedMCPToolNames(),
		]);
	}

	rememberSessionDefaultSelectedMCPToolNames(
		sessionFile: string | null | undefined,
		toolNames: Iterable<string>,
	): void {
		if (!sessionFile) return;
		this.#sessionDefaultSelectedMCPToolNames.set(
			path.resolve(sessionFile),
			this.filterSelectableMCPToolNames(toolNames),
		);
	}

	getSessionDefaultSelectedMCPToolNames(sessionFile: string | null | undefined): string[] {
		if (!sessionFile) return [];
		return this.#sessionDefaultSelectedMCPToolNames.get(path.resolve(sessionFile)) ?? [];
	}

	persistSelectedMCPToolNamesIfChanged(previousSelectedMCPToolNames: string[]): void {
		if (!this.#mcpDiscoveryEnabled) return;
		const nextSelectedMCPToolNames = this.getSelectedMCPToolNames();
		if (selectedMCPToolNamesMatch(previousSelectedMCPToolNames, nextSelectedMCPToolNames)) {
			return;
		}
		this.#deps.sessionManager.appendMCPToolSelection(nextSelectedMCPToolNames);
	}

	getActiveNonMCPToolNames(): string[] {
		return this.#deps.getActiveToolNames().filter(name => !isMCPToolName(name) && this.#deps.toolRegistry.has(name));
	}

	getSelectedMCPToolNames(): string[] {
		if (!this.#mcpDiscoveryEnabled) {
			return this.#deps
				.getActiveToolNames()
				.filter(name => isMCPToolName(name) && this.#deps.toolRegistry.has(name));
		}
		return this.filterSelectableMCPToolNames(this.#selectedMCPToolNames);
	}

	/** Copy of the raw selection set (switch-session rollback snapshot). */
	snapshotSelectedMCPToolNames(): Set<string> {
		return new Set(this.#selectedMCPToolNames);
	}

	/** Restore a snapshot taken with {@link snapshotSelectedMCPToolNames}. */
	restoreSelectedMCPToolNames(snapshot: Set<string>): void {
		this.#selectedMCPToolNames = new Set(snapshot);
	}

	/**
	 * Reconcile selection state after a tool set was applied to the agent:
	 * the MCP selection tracks the applied set (when discovery is on), and
	 * discovered non-MCP selections that went inactive are dropped so BM25 can
	 * rediscover them. Also invalidates the discovery caches.
	 */
	reconcileAfterApply(validToolNames: string[]): void {
		if (this.#mcpDiscoveryEnabled) {
			this.#selectedMCPToolNames = new Set(
				validToolNames.filter(
					name => isMCPToolName(name) && this.#discoverableMCPTools.has(name) && this.#deps.toolRegistry.has(name),
				),
			);
		}
		const activeNameSet = new Set(validToolNames);
		for (const name of Array.from(this.#selectedDiscoveredToolNames)) {
			if (!activeNameSet.has(name) || isMCPToolName(name) || !this.#deps.toolRegistry.has(name)) {
				this.#selectedDiscoveredToolNames.delete(name);
			}
		}
		this.invalidateDiscoveryCaches();
	}

	/** Drop a tool from the discovered-selection set (registry removal paths). */
	deleteDiscoveredToolName(name: string): void {
		this.#selectedDiscoveredToolNames.delete(name);
	}

	async activateDiscoveredMCPTools(toolNames: string[]): Promise<string[]> {
		const nextSelectedMCPToolNames = new Set(this.#selectedMCPToolNames);
		const activated: string[] = [];
		for (const name of toolNames) {
			if (!isMCPToolName(name) || !this.#discoverableMCPTools.has(name) || !this.#deps.toolRegistry.has(name)) {
				continue;
			}
			nextSelectedMCPToolNames.add(name);
			activated.push(name);
		}
		if (activated.length === 0) {
			return [];
		}
		const nextActive = [
			...this.getActiveNonMCPToolNames(),
			...this.filterSelectableMCPToolNames(nextSelectedMCPToolNames),
		];
		await this.#deps.setActiveToolsByName(nextActive);
		return [...new Set(activated)];
	}

	// ── Generic tool discovery (covers built-in + MCP + extension) ────────────

	/** Resolve effective discovery mode from the current registry size. */
	#resolveEffectiveDiscoveryMode(): "off" | "mcp-only" | "all" {
		const mode = resolveEffectiveToolDiscoveryMode(
			this.#deps.settings,
			countToolsForAutoDiscovery(this.#deps.toolRegistry.keys()),
		);
		if (mode !== "off") return mode;
		return this.#mcpDiscoveryEnabled ? "mcp-only" : "off";
	}

	isToolDiscoveryEnabled(): boolean {
		return this.#resolveEffectiveDiscoveryMode() !== "off";
	}

	getDiscoverableTools(filter?: { source?: DiscoverableTool["source"] }): DiscoverableTool[] {
		// For "all" mode we combine built-in registry entries + MCP tools.
		// For "mcp-only" mode we only return MCP tools.
		const mode = this.#resolveEffectiveDiscoveryMode();
		const activeNames = new Set(this.#deps.getActiveToolNames());
		const mcpTools = Array.from(this.#discoverableMCPTools.values()).filter(t => !activeNames.has(t.name));
		const builtinTools: DiscoverableTool[] = mode === "all" ? this.#collectDiscoverableBuiltinTools() : [];
		const allTools = [...builtinTools, ...mcpTools];
		return filter?.source ? allTools.filter(t => t.source === filter.source) : allTools;
	}

	/** Collect built-in tools the model can discover via search_tool_bm25. Restricted to tool
	 *  definitions whose `loadMode === "discoverable"`. This keeps hidden/internal tools
	 *  (resolve, yield, report_finding, report_tool_issue) out of the index
	 *  and avoids mislabeling extension/custom default-inactive tools as built-ins. */
	#collectDiscoverableBuiltinTools(): DiscoverableTool[] {
		const activeNames = new Set(this.#deps.getActiveToolNames());
		const result: DiscoverableTool[] = [];
		for (const tool of this.#deps.toolRegistry.values()) {
			if (tool.loadMode !== "discoverable") continue;
			if (activeNames.has(tool.name)) continue;
			const collected = collectDiscoverableTools([tool], { source: "builtin" });
			result.push(...collected);
		}
		return result;
	}

	getDiscoverableToolSearchIndex(): DiscoverableToolSearchIndex {
		if (!this.#discoverableToolSearchIndex) {
			this.#discoverableToolSearchIndex = buildDiscoverableToolSearchIndex(this.getDiscoverableTools());
		}
		return this.#discoverableToolSearchIndex;
	}

	getSelectedDiscoveredToolNames(): string[] {
		// Union of MCP-selected and generic non-MCP selected. Non-MCP selections are only
		// selected while they are still active; otherwise BM25 must be able to rediscover them.
		const activeNames = new Set(this.#deps.getActiveToolNames());
		const mcpSelected = this.getSelectedMCPToolNames();
		const nonMcpSelected = Array.from(this.#selectedDiscoveredToolNames).filter(
			name => activeNames.has(name) && this.#deps.toolRegistry.has(name) && !isMCPToolName(name),
		);
		return [...new Set([...mcpSelected, ...nonMcpSelected])];
	}

	async activateDiscoveredTools(toolNames: string[]): Promise<string[]> {
		const mcpNames = toolNames.filter(isMCPToolName);
		const nonMcpNames = toolNames.filter(name => !isMCPToolName(name));
		const activated: string[] = [];

		// Activate MCP tools via existing path
		if (mcpNames.length > 0) {
			const activatedMcp = await this.activateDiscoveredMCPTools(mcpNames);
			activated.push(...activatedMcp);
		}

		// Activate non-MCP tools (built-ins that are in the registry but not currently active)
		if (nonMcpNames.length > 0) {
			const currentActiveNames = new Set(this.#deps.getActiveToolNames());
			const newlyAdded: string[] = [];
			for (const name of nonMcpNames) {
				if (this.#deps.toolRegistry.has(name) && !currentActiveNames.has(name)) {
					newlyAdded.push(name);
					this.#selectedDiscoveredToolNames.add(name);
					activated.push(name);
				}
			}
			if (newlyAdded.length > 0) {
				const nextActive = [...this.#deps.getActiveToolNames(), ...newlyAdded];
				await this.#deps.setActiveToolsByName(nextActive);
				this.invalidateDiscoveryCaches();
			}
		}

		return [...new Set(activated)];
	}

	async restoreMCPSelectionsForSessionContext(
		sessionContext: SessionContext,
		options?: { fallbackSelectedMCPToolNames?: Iterable<string> },
	): Promise<void> {
		if (!this.#mcpDiscoveryEnabled) return;
		const nextActiveNonMCPToolNames = this.getActiveNonMCPToolNames();
		const fallbackSelectedMCPToolNames =
			options?.fallbackSelectedMCPToolNames ?? this.getConfiguredDefaultSelectedMCPToolNames();
		const restoredMCPToolNames = sessionContext.hasPersistedMCPToolSelection
			? this.filterSelectableMCPToolNames(sessionContext.selectedMCPToolNames)
			: this.filterSelectableMCPToolNames(fallbackSelectedMCPToolNames);
		this.rememberSessionDefaultSelectedMCPToolNames(
			this.#deps.getSessionFile(),
			this.getConfiguredDefaultSelectedMCPToolNames(),
		);
		await this.#deps.applyActiveToolsByName([...nextActiveNonMCPToolNames, ...restoredMCPToolNames], {
			persistMCPSelection: false,
		});
	}
}
