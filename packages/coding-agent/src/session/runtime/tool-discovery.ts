/**
 * Tool discovery: which registered tools the model can find with `search_tool_bm25`, which of them
 * it has selected, and which MCP tools a session starts with.
 *
 * This is a session collaborator. It holds the discovery state (the MCP tools the registry offers,
 * the MCP and local selections, the built-in names, the configured and per-session default MCP
 * selections and the cached search index) and reaches the session only through
 * {@link ToolDiscoveryHost}. It reads the tool registry and never writes it: registering,
 * activating and persisting stay with the session, which asks this collaborator what to activate
 * and reports back what it activated.
 *
 * Two selections, kept apart:
 *
 * - **MCP selection**: with MCP discovery on, the MCP tools the model or the configuration selected,
 *   which persist in the session file. With it off, the active MCP tools are the selection.
 * - **Local selection**: the built-in and custom tools the model activated through discovery. A
 *   name leaves it once the tool is no longer active, so the search can find the tool again.
 */

import * as path from "node:path";
import type { AgentTool } from "@veyyon/agent-core";
import { countToolsForAutoDiscovery, type EffectiveToolDiscoveryMode } from "../../discovery/mode";
import {
	buildDiscoverableToolSearchIndex,
	collectDiscoverableTools,
	type DiscoverableTool,
	type DiscoverableToolSearchIndex,
	filterBySource,
	isMCPToolName,
	selectDiscoverableToolNamesByServer,
} from "../../discovery/tool-index";

/** What {@link ToolDiscovery} needs from the session that owns it. */
export interface ToolDiscoveryHost {
	/** The session's tool registry, read on every call, so a registry mutation is seen at once. */
	readonly registry: ReadonlyMap<string, AgentTool>;
	/** The names of the tools set on the agent, in order. */
	activeToolNames(): string[];
	/** `tools.discoveryMode` resolved for a registry of `toolCount` tools. */
	discoveryModeFor(toolCount: number): EffectiveToolDiscoveryMode;
}

/** The session configuration discovery starts from. */
export interface ToolDiscoveryConfig {
	/** Whether MCP tools are found through discovery rather than all activated. */
	mcpDiscoveryEnabled?: boolean;
	/** Registry entries that came from a built-in factory. */
	builtInToolNames?: Iterable<string>;
	/** The MCP selection the session resumes with. */
	initialSelectedMCPToolNames?: Iterable<string>;
	/** MCP servers whose every tool a fresh session selects. */
	defaultSelectedMCPServerNames?: Iterable<string>;
	/** MCP tools a fresh session selects. */
	defaultSelectedMCPToolNames?: Iterable<string>;
}

/** An MCP activation: the names it activated and the full active list that carries them. */
export interface MCPActivation {
	activated: string[];
	nextActive: string[];
}

/** Whether two tool-name lists hold the same names in the same order. */
export function sameToolNames(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((name, index) => name === right[index]);
}

export class ToolDiscovery {
	readonly #host: ToolDiscoveryHost;
	#mcpEnabled: boolean;
	#mcpTools = new Map<string, DiscoverableTool>();
	#selectedMCP: Set<string>;
	#selectedLocal = new Set<string>();
	readonly #builtIn: Set<string>;
	readonly #defaultMCPServers: ReadonlySet<string>;
	readonly #defaultMCPTools: ReadonlySet<string>;
	/** The configured default MCP selection each session file was opened with, by resolved path. */
	readonly #sessionDefaults = new Map<string, string[]>();
	#searchIndex: DiscoverableToolSearchIndex | null = null;

	constructor(host: ToolDiscoveryHost, config: ToolDiscoveryConfig) {
		this.#host = host;
		this.#mcpEnabled = config.mcpDiscoveryEnabled ?? false;
		this.#builtIn = new Set(config.builtInToolNames ?? []);
		this.#selectedMCP = new Set(config.initialSelectedMCPToolNames ?? []);
		this.#defaultMCPServers = new Set(config.defaultSelectedMCPServerNames ?? []);
		this.#defaultMCPTools = new Set(config.defaultSelectedMCPToolNames ?? []);
		this.reindexMCPTools();
		this.pruneSelectedMCP();
	}

	/** Whether MCP tools are found through discovery. */
	get mcpEnabled(): boolean {
		return this.#mcpEnabled;
	}

	/**
	 * Turn MCP discovery on once deferred discovery learns the real tool count. UI sessions resolve
	 * `tools.discoveryMode: "auto"` before MCP servers connect, so a large MCP toolset found later
	 * moves the session to the discovery path. One-way: discovery is never turned off mid-session.
	 */
	enableMCP(): void {
		this.#mcpEnabled = true;
	}

	/** Re-read the MCP tools the registry offers, after the registry's MCP entries changed. */
	reindexMCPTools(): void {
		const mcpTools = filterBySource(collectDiscoverableTools(this.#host.registry.values()), "mcp");
		this.#mcpTools = new Map(mcpTools.map(tool => [tool.name, tool] as const));
		this.invalidate();
	}

	/**
	 * Drop the cached search index. Called after any change to which tools are discoverable: a
	 * registry mutation or an active-tool change, since active tools are not discoverable.
	 */
	invalidate(): void {
		this.#searchIndex = null;
	}

	/** The names in `toolNames` that are discoverable MCP tools still in the registry. */
	selectableMCP(toolNames: Iterable<string>): string[] {
		const registry = this.#host.registry;
		return Array.from(toolNames).filter(name => this.#mcpTools.has(name) && registry.has(name));
	}

	/** The configured default MCP selection: the named tools and every tool of the named servers. */
	configuredDefaultMCP(): string[] {
		return this.selectableMCP([
			...this.#defaultMCPTools,
			...selectDiscoverableToolNamesByServer(this.#mcpTools.values(), this.#defaultMCPServers),
		]);
	}

	/** The configured default MCP tools alone, which a new session starts with. */
	defaultMCPTools(): string[] {
		return this.selectableMCP(this.#defaultMCPTools);
	}

	/** Drop selected MCP names that are no longer discoverable. */
	pruneSelectedMCP(): void {
		this.#selectedMCP = new Set(this.selectableMCP(this.#selectedMCP));
	}

	/** Add the configured default MCP selection to the current one. */
	addConfiguredDefaultMCP(): void {
		this.#selectedMCP = new Set([...this.#selectedMCP, ...this.configuredDefaultMCP()]);
	}

	/** A copy of the MCP selection, to restore with {@link restoreSelectedMCP} if a switch fails. */
	snapshotSelectedMCP(): Set<string> {
		return new Set(this.#selectedMCP);
	}

	restoreSelectedMCP(snapshot: ReadonlySet<string>): void {
		this.#selectedMCP = new Set(snapshot);
	}

	/** Record the configured default MCP selection as the one `sessionFile` falls back to. */
	rememberSessionDefaults(sessionFile: string | null | undefined): void {
		if (!sessionFile) return;
		this.#sessionDefaults.set(path.resolve(sessionFile), this.configuredDefaultMCP());
	}

	/** The default MCP selection recorded for `sessionFile`, empty when none was. */
	sessionDefaults(sessionFile: string | null | undefined): string[] {
		if (!sessionFile) return [];
		return this.#sessionDefaults.get(path.resolve(sessionFile)) ?? [];
	}

	/** The selected MCP tools: the discovery selection, or the active MCP tools with discovery off. */
	selectedMCP(): string[] {
		if (!this.#mcpEnabled) {
			const registry = this.#host.registry;
			return this.#host.activeToolNames().filter(name => isMCPToolName(name) && registry.has(name));
		}
		return this.selectableMCP(this.#selectedMCP);
	}

	/**
	 * The MCP selection to persist after an activation, or `undefined` when discovery is off or the
	 * selection equals `previous`.
	 */
	selectedMCPChangedFrom(previous: readonly string[]): string[] | undefined {
		if (!this.#mcpEnabled) return undefined;
		const next = this.selectedMCP();
		return sameToolNames(previous, next) ? undefined : next;
	}

	/** The active tools that are not MCP tools, in active order. */
	activeNonMCP(): string[] {
		const registry = this.#host.registry;
		return this.#host.activeToolNames().filter(name => !isMCPToolName(name) && registry.has(name));
	}

	/**
	 * What activating the discoverable MCP tools among `toolNames` activates, or `undefined` when it
	 * activates none. The selection itself follows the active list once the session applies it.
	 */
	planMCPActivation(toolNames: readonly string[]): MCPActivation | undefined {
		const registry = this.#host.registry;
		const nextSelected = new Set(this.#selectedMCP);
		const activated = new Set<string>();
		for (const name of toolNames) {
			if (!isMCPToolName(name) || !this.#mcpTools.has(name) || !registry.has(name)) continue;
			nextSelected.add(name);
			activated.add(name);
		}
		if (activated.size === 0) return undefined;
		return {
			activated: Array.from(activated),
			nextActive: this.activeNonMCP().concat(this.selectableMCP(nextSelected)),
		};
	}

	/**
	 * Select the registered, inactive local tools among `toolNames` and return them, in order. The
	 * session activates them.
	 */
	selectLocal(toolNames: readonly string[]): string[] {
		const registry = this.#host.registry;
		const active = new Set(this.#host.activeToolNames());
		const selected: string[] = [];
		for (const name of toolNames) {
			if (!registry.has(name) || active.has(name)) continue;
			selected.push(name);
			this.#selectedLocal.add(name);
		}
		return selected;
	}

	/** Remove `name` from the local selection, after its registry entry went away. */
	deselect(name: string): void {
		this.#selectedLocal.delete(name);
	}

	/**
	 * Follow an active-tool list the session is about to set: with MCP discovery on, the MCP
	 * selection becomes the active MCP tools.
	 */
	followActiveMCP(activeToolNames: readonly string[]): void {
		if (!this.#mcpEnabled) return;
		this.#selectedMCP = new Set(this.selectableMCP(activeToolNames.filter(isMCPToolName)));
	}

	/**
	 * Settle after the session set `activeToolNames` on the agent: a local selection that is no longer
	 * active leaves the selection, and the search index, which excludes active tools, is dropped.
	 */
	settleActive(activeToolNames: readonly string[]): void {
		const active = new Set(activeToolNames);
		const registry = this.#host.registry;
		for (const name of this.#selectedLocal) {
			if (!active.has(name) || isMCPToolName(name) || !registry.has(name)) this.#selectedLocal.delete(name);
		}
		this.invalidate();
	}

	/** The selected tools: the MCP selection and the local selection that is still active. */
	selectedDiscovered(): string[] {
		const active = new Set(this.#host.activeToolNames());
		const registry = this.#host.registry;
		const selected = new Set(this.selectedMCP());
		for (const name of this.#selectedLocal) {
			if (active.has(name) && registry.has(name) && !isMCPToolName(name)) selected.add(name);
		}
		return Array.from(selected);
	}

	/** Whether the registry entry for `name` came from a built-in factory. */
	isBuiltIn(name: string): boolean {
		return this.#builtIn.has(name);
	}

	addBuiltIn(name: string): void {
		this.#builtIn.add(name);
	}

	removeBuiltIn(name: string): void {
		this.#builtIn.delete(name);
	}

	/** `tools.discoveryMode` for the current registry, with MCP discovery lifting `off` to `mcp-only`. */
	effectiveMode(): EffectiveToolDiscoveryMode {
		const mode = this.#host.discoveryModeFor(countToolsForAutoDiscovery(this.#host.registry.keys()));
		if (mode !== "off") return mode;
		return this.#mcpEnabled ? "mcp-only" : "off";
	}

	/**
	 * The inactive tools the model can discover: the MCP tools, and in `all` mode the local tools whose
	 * `loadMode` is `discoverable`.
	 */
	discoverableTools(filter?: { source?: DiscoverableTool["source"] }): DiscoverableTool[] {
		const active = new Set(this.#host.activeToolNames());
		const tools = this.effectiveMode() === "all" ? this.#discoverableLocalTools(active) : [];
		for (const tool of this.#mcpTools.values()) {
			if (!active.has(tool.name)) tools.push(tool);
		}
		return filter?.source ? tools.filter(tool => tool.source === filter.source) : tools;
	}

	/** The search index over {@link discoverableTools}, built on first use after an invalidation. */
	searchIndex(): DiscoverableToolSearchIndex {
		this.#searchIndex ??= buildDiscoverableToolSearchIndex(this.discoverableTools());
		return this.#searchIndex;
	}

	/**
	 * Inactive local tools whose `loadMode` is `discoverable`; hidden and internal tools stay out of
	 * the index. A built-in name is sourced `builtin`, any other `custom`.
	 */
	#discoverableLocalTools(active: ReadonlySet<string>): DiscoverableTool[] {
		const tools: DiscoverableTool[] = [];
		for (const tool of this.#host.registry.values()) {
			if (tool.loadMode !== "discoverable" || active.has(tool.name)) continue;
			const source = this.#builtIn.has(tool.name) ? "builtin" : "custom";
			for (const discoverable of collectDiscoverableTools([tool], { source })) tools.push(discoverable);
		}
		return tools;
	}
}
