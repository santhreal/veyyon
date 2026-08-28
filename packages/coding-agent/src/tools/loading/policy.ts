import type { SettingValue } from "../../config/settings-schema";
import { type BuiltinToolName, normalizeToolName, normalizeToolNames, TOOL } from "../builtin-names";

export const TOOL_DISCOVERY_AUTO_THRESHOLD = 40;

export const TOOL_DISCOVERY_SEARCH_TOOL_NAME = "search_tool_bm25";

export type ToolDiscoveryModeSetting = SettingValue<"tools.discoveryMode">;
export type EffectiveToolDiscoveryMode = Exclude<ToolDiscoveryModeSetting, "auto">;

export function countToolsForAutoDiscovery(toolNames: Iterable<string>): number {
	let count = 0;
	for (const name of toolNames) {
		if (name !== TOOL_DISCOVERY_SEARCH_TOOL_NAME) count++;
	}
	return count;
}

export interface ToolDiscoveryModeInputs {
	configuredMode: ToolDiscoveryModeSetting;
	legacyMcpDiscoveryMode: boolean;
	toolCount: number;
}

export function resolveToolDiscoveryMode(inputs: ToolDiscoveryModeInputs): EffectiveToolDiscoveryMode {
	if (inputs.configuredMode === "all" || inputs.configuredMode === "mcp-only") return inputs.configuredMode;
	if (inputs.legacyMcpDiscoveryMode) return "mcp-only";
	if (inputs.configuredMode === "auto" && inputs.toolCount > TOOL_DISCOVERY_AUTO_THRESHOLD) return "mcp-only";
	return "off";
}

export type BuiltinToolLoadMode = "essential" | "discoverable";

export const DEFAULT_ESSENTIAL_TOOL_NAMES: readonly string[] = [
	TOOL.read,
	TOOL.bash,
	TOOL.launch,
	TOOL.edit,
	TOOL.write,
	TOOL.glob,
	TOOL.eval,
] as const;

export interface EssentialToolNamesInputs {
	override: readonly string[] | undefined;
	isBuiltinName: (name: string) => boolean;
}

export function resolveEssentialToolNames(inputs: EssentialToolNamesInputs): string[] {
	const override = inputs.override ?? [];
	const cleaned = normalizeToolNames(override.map(name => name.trim()).filter(Boolean));
	if (cleaned.length > 0) {
		return cleaned.filter(inputs.isBuiltinName);
	}
	return DEFAULT_ESSENTIAL_TOOL_NAMES.slice();
}

export function filterInitialToolsForDiscoveryAll(
	initialToolNames: string[],
	opts: {
		loadModeOf: (name: string) => BuiltinToolLoadMode | undefined;
		essentialNames: ReadonlySet<string>;
		explicitlyRequested: ReadonlySet<string>;
		restored: ReadonlySet<string>;
		forceActive: ReadonlySet<string>;
	},
): string[] {
	return initialToolNames.filter(name => {
		const loadMode = opts.loadModeOf(name);
		if (!loadMode) return true; // not a built-in — leave MCP/custom/extension to existing logic
		if (loadMode === "essential") return true;
		if (opts.essentialNames.has(name)) return true;
		if (opts.explicitlyRequested.has(name)) return true;
		if (opts.restored.has(name)) return true;
		if (opts.forceActive.has(name)) return true;
		return false;
	});
}

export interface DiscoveryAllForceActiveInputs {
	todoEager: string;
	todoEnabled: boolean;
	hasTodoTool: boolean;
	delegationStrength: string;
	hasTaskTool: boolean;
}

export function resolveDiscoveryAllForceActive(inputs: DiscoveryAllForceActiveInputs): Set<string> {
	const forceActive = new Set<string>();
	if (inputs.todoEager !== "default" && inputs.todoEnabled && inputs.hasTodoTool) {
		forceActive.add(TOOL.todo);
	}
	if ((inputs.delegationStrength === "preferred" || inputs.delegationStrength === "required") && inputs.hasTaskTool) {
		forceActive.add(TOOL.task);
	}
	return forceActive;
}

export interface EvalToolAvailabilityInputs {
	pythonAllowed: boolean;
	jsAllowed: boolean;
	rubyAllowed: boolean;
	juliaAllowed: boolean;
	pythonAvailable: boolean;
	rubyAvailable: boolean;
	juliaAvailable: boolean;
}

export function resolveEvalToolAvailability(inputs: EvalToolAvailabilityInputs): boolean {
	const effectivePythonAllowed = inputs.pythonAllowed && inputs.pythonAvailable;
	const effectiveRubyAllowed = inputs.rubyAllowed && inputs.rubyAvailable;
	const effectiveJuliaAllowed = inputs.juliaAllowed && inputs.juliaAvailable;
	return effectivePythonAllowed || inputs.jsAllowed || effectiveRubyAllowed || effectiveJuliaAllowed;
}

export interface BuiltinToolPermissionInputs {
	goalEnabled: boolean;
	enableLsp: boolean;
	lspEnabled: boolean;
	lspTool: boolean;
	bashEnabled: boolean;
	launchEnabled: boolean;
	evalAllowed: boolean;
	debugEnabled: boolean;
	requireYieldTool: boolean;
	todoEnabled: boolean;
	globEnabled: boolean;
	grepEnabled: boolean;
	githubEnabled: boolean;
	astGrepEnabled: boolean;
	astEditEnabled: boolean;
	inspectImageEnabled: boolean;
	webSearchEnabled: boolean;
	discoveryActive: boolean;
	askEnabled: boolean;
	browserEnabled: boolean;
	checkpointEnabled: boolean;
	ircEnabled: boolean;
	memoryBackend: string;
	autolearnEnabled: boolean;
	isTopLevelSession: boolean;
	delegationEnabled: boolean;
	canSpawnAtDepth: boolean;
}

const MEMORY_TOOL_BACKENDS: Record<string, true> = { hindsight: true, mnemopi: true };

const LEARN_TOOL_BACKENDS: Record<string, true> = { hindsight: true, mnemopi: true, local: true };

export function memoryToolsBackendEnabled(memoryBackend: string): boolean {
	return MEMORY_TOOL_BACKENDS[memoryBackend] === true;
}

export function learnToolBackendEnabled(memoryBackend: string): boolean {
	return LEARN_TOOL_BACKENDS[memoryBackend] === true;
}

export function isBuiltinToolAllowed(name: string, inputs: BuiltinToolPermissionInputs): boolean {
	if (name === TOOL.goal) return inputs.goalEnabled;
	if (name === TOOL.lsp) return inputs.enableLsp && inputs.lspEnabled && inputs.lspTool;
	if (name === TOOL.bash) return inputs.bashEnabled;
	if (name === TOOL.launch) return inputs.launchEnabled;
	if (name === TOOL.eval) return inputs.evalAllowed;
	if (name === TOOL.debug) return inputs.debugEnabled;
	if (name === TOOL.todo) return !inputs.requireYieldTool && inputs.todoEnabled;
	if (name === TOOL.glob) return inputs.globEnabled;
	if (name === TOOL.grep) return inputs.grepEnabled;
	if (name === TOOL.github) return inputs.githubEnabled;
	if (name === TOOL.ast_grep) return inputs.astGrepEnabled;
	if (name === TOOL.ast_edit) return inputs.astEditEnabled;
	if (name === TOOL.inspect_image) return inputs.inspectImageEnabled;
	if (name === TOOL.web_search) return inputs.webSearchEnabled;
	if (name === TOOL.search_tool_bm25) return inputs.discoveryActive;
	if (name === TOOL.ask) return inputs.askEnabled;
	if (name === TOOL.browser) return inputs.browserEnabled;
	if (name === TOOL.checkpoint || name === TOOL.rewind) return inputs.checkpointEnabled;
	if (name === TOOL.irc) return inputs.ircEnabled;
	if (name === TOOL.retain || name === TOOL.recall || name === TOOL.reflect) {
		return memoryToolsBackendEnabled(inputs.memoryBackend);
	}
	if (name === TOOL.manage_skill) return inputs.autolearnEnabled && inputs.isTopLevelSession;
	if (name === TOOL.learn) {
		return inputs.autolearnEnabled && inputs.isTopLevelSession && learnToolBackendEnabled(inputs.memoryBackend);
	}
	if (name === TOOL.task) {
		if (!inputs.delegationEnabled) return false;
		return inputs.canSpawnAtDepth;
	}
	return true;
}

export interface RequestedToolNamesInputs {
	goalEnabled: boolean;
	astGrepEnabled: boolean;
	astEditEnabled: boolean;
	memoryBackend: string;
	autolearnEnabled: boolean;
	isTopLevelSession: boolean;
}

export function augmentRequestedToolNames(
	requestedToolNames: readonly string[],
	inputs: RequestedToolNamesInputs,
): string[] {
	const requested = requestedToolNames.slice();
	const push = (name: string): void => {
		if (!requested.includes(name)) requested.push(name);
	};
	if (inputs.goalEnabled) push(TOOL.goal);
	if (requested.includes(TOOL.grep) && inputs.astGrepEnabled) push(TOOL.ast_grep);
	if (requested.includes(TOOL.edit) && inputs.astEditEnabled) push(TOOL.ast_edit);
	if (memoryToolsBackendEnabled(inputs.memoryBackend)) {
		for (const name of [TOOL.recall, TOOL.retain, TOOL.reflect]) push(name);
	}
	if (inputs.autolearnEnabled && inputs.isTopLevelSession) {
		push(TOOL.manage_skill);
		if (learnToolBackendEnabled(inputs.memoryBackend)) push(TOOL.learn);
	}
	return requested;
}

export function withYieldToolAppended(requestedToolNames: readonly string[]): string[] {
	if (requestedToolNames.includes(TOOL.yield)) return requestedToolNames.slice();
	return requestedToolNames.concat([TOOL.yield]);
}

export interface BaseToolSelectionInputs {
	requestedToolNames: readonly string[] | undefined;
	isKnownToolName: (name: string) => boolean;
	isAllowed: (name: string) => boolean;
	builtinToolNames: readonly string[];
	requireYieldTool: boolean;
	goalEnabled: boolean;
}

export function selectBaseToolNames(inputs: BaseToolSelectionInputs): string[] {
	if (inputs.requestedToolNames !== undefined) {
		return inputs.requestedToolNames.filter(
			name => inputs.isKnownToolName(name) && inputs.isAllowed(name) && name !== TOOL.resolve,
		);
	}
	const names = inputs.builtinToolNames.filter(inputs.isAllowed);
	if (inputs.requireYieldTool) names.push(TOOL.yield);
	if (inputs.goalEnabled) names.push(TOOL.goal);
	return names;
}

export interface InitialActiveToolNamesInputs {
	explicitToolNames: readonly string[] | undefined;
	requestedToolNames: readonly string[];
	goalEnabled: boolean;
	defaultInactiveToolNames: ReadonlySet<string>;
	hasRegistryTool: (name: string) => boolean;
	mcpDiscoveryEnabled: boolean;
	discoveryDefaultServerToolNames: readonly string[];
	persistedSelectedMCPToolNames: readonly string[];
	hasPersistedMCPToolSelection: boolean;
	alwaysIncludeToolNames: readonly string[];
	effectiveDiscoveryMode: EffectiveToolDiscoveryMode;
	loadModeOf: (name: string) => BuiltinToolLoadMode | undefined;
	essentialToolNames: readonly string[];
	forceActiveToolNames: ReadonlySet<string>;
	harnessToolAllowlist: readonly string[] | undefined;
}

export interface InitialActiveToolNames {
	initialToolNames: string[];
	initialSelectedMCPToolNames: string[];
	defaultSelectedMCPToolNames: string[];
	explicitlyRequestedMCPToolNames: string[];
}

export function applyHarnessToolAllowlist(
	toolNames: readonly string[],
	allowlist: readonly string[] | undefined,
): string[] {
	if (!allowlist || allowlist.length === 0) return toolNames.slice();
	const allowed = new Set(allowlist);
	return toolNames.filter(name => allowed.has(name));
}

export function resolveInitialActiveToolNames(inputs: InitialActiveToolNamesInputs): InitialActiveToolNames {
	const hasExplicitToolNames = inputs.explicitToolNames !== undefined;

	const requestedActiveToolNames = inputs.requestedToolNames.slice();
	if (inputs.goalEnabled && inputs.hasRegistryTool(TOOL.goal) && !requestedActiveToolNames.includes(TOOL.goal)) {
		requestedActiveToolNames.push(TOOL.goal);
	}
	const initialRequestedActiveToolNames = hasExplicitToolNames
		? requestedActiveToolNames
		: requestedActiveToolNames.filter(name => !inputs.defaultInactiveToolNames.has(name));
	const explicitlyRequestedMCPToolNames = hasExplicitToolNames
		? requestedActiveToolNames.filter(isMCPToolNamePrefix)
		: [];

	let initialSelectedMCPToolNames: string[] = [];
	let defaultSelectedMCPToolNames: string[] = [];
	let initialToolNames = initialRequestedActiveToolNames.slice();
	if (inputs.mcpDiscoveryEnabled) {
		const restoredSelectedMCPToolNames = inputs.persistedSelectedMCPToolNames
			.map(normalizeToolName)
			.filter(inputs.hasRegistryTool);
		defaultSelectedMCPToolNames = Array.from(
			new Set(inputs.discoveryDefaultServerToolNames.concat(explicitlyRequestedMCPToolNames)),
		);
		initialSelectedMCPToolNames = inputs.hasPersistedMCPToolSelection
			? restoredSelectedMCPToolNames
			: Array.from(new Set(restoredSelectedMCPToolNames.concat(defaultSelectedMCPToolNames)));
		initialToolNames = Array.from(
			new Set(
				initialRequestedActiveToolNames
					.filter(name => !isMCPToolNamePrefix(name))
					.concat(initialSelectedMCPToolNames),
			),
		);
	}

	for (const name of inputs.alwaysIncludeToolNames) {
		if (inputs.mcpDiscoveryEnabled && isMCPToolNamePrefix(name)) continue;
		if (inputs.hasRegistryTool(name) && !initialToolNames.includes(name)) {
			initialToolNames.push(name);
		}
	}

	if (inputs.effectiveDiscoveryMode === "all") {
		initialToolNames = filterInitialToolsForDiscoveryAll(initialToolNames, {
			loadModeOf: inputs.loadModeOf,
			essentialNames: new Set(inputs.essentialToolNames),
			explicitlyRequested: new Set(inputs.explicitToolNames ?? []),
			restored: new Set(inputs.persistedSelectedMCPToolNames.map(normalizeToolName)),
			forceActive: inputs.forceActiveToolNames,
		});
	}

	initialToolNames = applyHarnessToolAllowlist(initialToolNames, inputs.harnessToolAllowlist);

	return {
		initialToolNames,
		initialSelectedMCPToolNames,
		defaultSelectedMCPToolNames,
		explicitlyRequestedMCPToolNames,
	};
}

function isMCPToolNamePrefix(name: string): boolean {
	return name.startsWith("mcp__");
}

export type { BuiltinToolName };
