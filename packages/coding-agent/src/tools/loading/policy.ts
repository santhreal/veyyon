import type { SettingValue } from "../../config/settings-schema";
import { type BuiltinToolName, normalizeToolName, normalizeToolNames, TOOL } from "../builtin-names";

/** THE tool-loading rules, as pure functions over explicit inputs. E — does this tool EXIST (should it be constructed / registered)? */

/** Registry size above which `tools.discoveryMode: "auto"` starts hiding MCP tools. */
export const TOOL_DISCOVERY_AUTO_THRESHOLD = 40;

export const TOOL_DISCOVERY_SEARCH_TOOL_NAME = "search_tool_bm25";

export type ToolDiscoveryModeSetting = SettingValue<"tools.discoveryMode">;
export type EffectiveToolDiscoveryMode = Exclude<ToolDiscoveryModeSetting, "auto">;

/** Size a tool set for the `auto` threshold. `search_tool_bm25` is excluded because it is the tool discovery ADDS; counting it would let a */
export function countToolsForAutoDiscovery(toolNames: Iterable<string>): number {
	let count = 0;
	for (const name of toolNames) {
		if (name !== TOOL_DISCOVERY_SEARCH_TOOL_NAME) count++;
	}
	return count;
}

export interface ToolDiscoveryModeInputs {
	/** `tools.discoveryMode`. */
	configuredMode: ToolDiscoveryModeSetting;
	/** `mcp.discoveryMode` — the legacy boolean, still honored as an alias for `mcp-only`. */
	legacyMcpDiscoveryMode: boolean;
	/** Result of {@link countToolsForAutoDiscovery} over whatever tool set the caller can see. */
	toolCount: number;
}

/** Resolve the effective discovery mode. THE SAME RULE IS ASKED AT FOUR DIFFERENT TIMES WITH FOUR DIFFERENT TOOL COUNTS, and they can */
export function resolveToolDiscoveryMode(inputs: ToolDiscoveryModeInputs): EffectiveToolDiscoveryMode {
	if (inputs.configuredMode === "all" || inputs.configuredMode === "mcp-only") return inputs.configuredMode;
	if (inputs.legacyMcpDiscoveryMode) return "mcp-only";
	if (inputs.configuredMode === "auto" && inputs.toolCount > TOOL_DISCOVERY_AUTO_THRESHOLD) return "mcp-only";
	return "off";
}

/** FUTURE LOAD POLICY (1/4). How a tool declares when it wants to be loaded. A new `always | dynamic | manual` vocabulary widens this union; every reader of it is either */
export type BuiltinToolLoadMode = "essential" | "discoverable";

/** Default essential tool names when `tools.essentialOverride` is empty. */
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
	/** Raw `tools.essentialOverride`. */
	override: readonly string[] | undefined;
	/** Whether a name is a known built-in; the override is filtered through it. */
	isBuiltinName: (name: string) => boolean;
}

/** FUTURE LOAD POLICY (3/4). Which built-ins survive `tools.discoveryMode: "all"` outright. The override wins when it is non-empty AFTER trim + normalize + filter-to-built-in. Note the */
export function resolveEssentialToolNames(inputs: EssentialToolNamesInputs): string[] {
	const override = inputs.override ?? [];
	const cleaned = normalizeToolNames(override.map(name => name.trim()).filter(Boolean));
	if (cleaned.length > 0) {
		return cleaned.filter(inputs.isBuiltinName);
	}
	return DEFAULT_ESSENTIAL_TOOL_NAMES.slice();
}

/** FUTURE LOAD POLICY (2/4). Filter the initial active tool set when `tools.discoveryMode === "all"`. Non-essential discoverable built-ins are hidden — the model rediscovers them via */
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
	/** `todo.eager`; anything other than `"default"` arms a named `todo` tool_choice. */
	todoEager: string;
	/** `todo.enabled`. */
	todoEnabled: boolean;
	/** Whether the completed registry holds a `todo` tool. */
	hasTodoTool: boolean;
	/** `subagent.delegation`. */
	delegationStrength: string;
	/** Whether the completed registry holds a `task` tool. */
	hasTaskTool: boolean;
}

/** FUTURE LOAD POLICY (4/4). Tools that must stay active under discovery-all whatever their declared load mode says. */
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
	/** Per-backend allowance from `eval.py` / `eval.js` / `eval.rb` / `eval.jl` plus env overrides. */
	pythonAllowed: boolean;
	jsAllowed: boolean;
	rubyAllowed: boolean;
	juliaAllowed: boolean;
	/** Preflight results. `true` when the probe passed OR was skipped (JS covers the session). */
	pythonAvailable: boolean;
	rubyAvailable: boolean;
	juliaAvailable: boolean;
}

/** Whether the `eval` tool exists at all. Exposed whenever ANY backend is reachable; an unreachable backend simply means `eval` */
export function resolveEvalToolAvailability(inputs: EvalToolAvailabilityInputs): boolean {
	const effectivePythonAllowed = inputs.pythonAllowed && inputs.pythonAvailable;
	const effectiveRubyAllowed = inputs.rubyAllowed && inputs.rubyAvailable;
	const effectiveJuliaAllowed = inputs.juliaAllowed && inputs.juliaAvailable;
	return effectivePythonAllowed || inputs.jsAllowed || effectiveRubyAllowed || effectiveJuliaAllowed;
}

/** Everything {@link isBuiltinToolAllowed} reads, gathered by the caller. Flat and eager on purpose. The predicate used to close over a `Settings` object and read it */
export interface BuiltinToolPermissionInputs {
	/** `goal.enabled`. */
	goalEnabled: boolean;
	/** Session-level LSP switch (`ToolSession.enableLsp`, defaulting to true). */
	enableLsp: boolean;
	/** `lsp.enabled`. */
	lspEnabled: boolean;
	/** `lsp.tool`. The agent-facing lsp tool; independent of injected diagnostics. */
	lspTool: boolean;
	/** `bash.enabled`. */
	bashEnabled: boolean;
	/** `launch.enabled`. */
	launchEnabled: boolean;
	/** Result of {@link resolveEvalToolAvailability}. */
	evalAllowed: boolean;
	/** `debug.enabled`. */
	debugEnabled: boolean;
	/** `ToolSession.requireYieldTool` — a session that must `yield` never gets `todo`. */
	requireYieldTool: boolean;
	/** `todo.enabled`. */
	todoEnabled: boolean;
	/** `glob.enabled`. */
	globEnabled: boolean;
	/** `grep.enabled`. */
	grepEnabled: boolean;
	/** `github.enabled`. */
	githubEnabled: boolean;
	/** `astGrep.enabled`. */
	astGrepEnabled: boolean;
	/** `astEdit.enabled`. */
	astEditEnabled: boolean;
	/** `inspect_image.enabled`. */
	inspectImageEnabled: boolean;
	/** `web_search.enabled`. */
	webSearchEnabled: boolean;
	/** Effective discovery mode is not `off`, at THIS stage's tool count. */
	discoveryActive: boolean;
	/** `ask.enabled`. */
	askEnabled: boolean;
	/** `browser.enabled`. */
	browserEnabled: boolean;
	/** `checkpoint.enabled` — governs both `checkpoint` and `rewind`. */
	checkpointEnabled: boolean;
	/** `isIrcEnabled(settings, taskDepth, maxNestedSpawnDepth)`. */
	ircEnabled: boolean;
	/** `memory.backend`, defaulted to `""`. */
	memoryBackend: string;
	/** `autolearn.enabled`. */
	autolearnEnabled: boolean;
	/** `(taskDepth ?? 0) === 0`. */
	isTopLevelSession: boolean;
	/** `delegationEnabled(settings)`. */
	delegationEnabled: boolean;
	/** `canSpawnAtDepth(resolveSessionMaxNestedSpawnDepth(...), taskDepth ?? 0)`. */
	canSpawnAtDepth: boolean;
}

/** Backends that expose `retain` / `recall` / `reflect`. */
const MEMORY_TOOL_BACKENDS: Record<string, true> = { hindsight: true, mnemopi: true };

/** Backends that expose `learn`; `local` joins the two above. */
const LEARN_TOOL_BACKENDS: Record<string, true> = { hindsight: true, mnemopi: true, local: true };

/** Whether `memory.backend` exposes `retain` / `recall` / `reflect`. */
export function memoryToolsBackendEnabled(memoryBackend: string): boolean {
	return MEMORY_TOOL_BACKENDS[memoryBackend] === true;
}

/** Whether `memory.backend` exposes `learn`. */
export function learnToolBackendEnabled(memoryBackend: string): boolean {
	return LEARN_TOOL_BACKENDS[memoryBackend] === true;
}

/** THE PERMISSION TABLE. One built-in name in, may-it-exist out. An unlisted name is PERMITTED (the final `return true`). That default is why adding a tool to */
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
	// search_tool_bm25 is allowed when either legacy mcp.discoveryMode or new tools.discoveryMode is active.
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
		// `subagent.enabled: false` takes subagents away entirely, so the tool itself is absent rather than present-but-discouraged: a prompt that says
		if (!inputs.delegationEnabled) return false;
		return inputs.canSpawnAtDepth;
	}
	return true;
}

export interface RequestedToolNamesInputs {
	/** `goal.enabled`; the model may create the initial goal or resume a paused one. */
	goalEnabled: boolean;
	/** `astGrep.enabled`. */
	astGrepEnabled: boolean;
	/** `astEdit.enabled`. */
	astEditEnabled: boolean;
	/** `memory.backend`, defaulted to `""`. */
	memoryBackend: string;
	/** `autolearn.enabled`. */
	autolearnEnabled: boolean;
	/** `(taskDepth ?? 0) === 0`. */
	isTopLevelSession: boolean;
}

/** Widen an EXPLICIT tool whitelist with the tools its entries imply. Only ever applied to a caller-supplied list. With no list, `createTools` enumerates every */
export function augmentRequestedToolNames(
	requestedToolNames: readonly string[],
	inputs: RequestedToolNamesInputs,
): string[] {
	const requested = requestedToolNames.slice();
	const push = (name: string): void => {
		if (!requested.includes(name)) requested.push(name);
	};
	if (inputs.goalEnabled) push(TOOL.goal);
	// Auto-include AST counterparts when their text-based sibling is present
	if (requested.includes(TOOL.grep) && inputs.astGrepEnabled) push(TOOL.ast_grep);
	if (requested.includes(TOOL.edit) && inputs.astEditEnabled) push(TOOL.ast_edit);
	if (memoryToolsBackendEnabled(inputs.memoryBackend)) {
		for (const name of [TOOL.recall, TOOL.retain, TOOL.reflect]) push(name);
	}
	// Auto-learn tools are gated by `autolearn.enabled` but, like the memory tools above, must also be force-included into an explicit requestedTools
	if (inputs.autolearnEnabled && inputs.isTopLevelSession) {
		push(TOOL.manage_skill);
		if (learnToolBackendEnabled(inputs.memoryBackend)) push(TOOL.learn);
	}
	return requested;
}

/** Append `yield` to an explicit whitelist when the session must terminate through it. CALLED AFTER THE DISCOVERY-MODE TOOL COUNT, and that ordering is the whole reason this is a */
export function withYieldToolAppended(requestedToolNames: readonly string[]): string[] {
	if (requestedToolNames.includes(TOOL.yield)) return requestedToolNames.slice();
	return requestedToolNames.concat([TOOL.yield]);
}

export interface BaseToolSelectionInputs {
	/** The augmented explicit whitelist, or undefined when the caller supplied none. */
	requestedToolNames: readonly string[] | undefined;
	/** Every constructible name — built-ins plus hidden tools. */
	isKnownToolName: (name: string) => boolean;
	/** {@link isBuiltinToolAllowed}, pre-bound to this session's inputs. */
	isAllowed: (name: string) => boolean;
	/** `BUILTIN_TOOLS` keys, in declaration order. That order is the default tool order. */
	builtinToolNames: readonly string[];
	/** `ToolSession.requireYieldTool`. */
	requireYieldTool: boolean;
	/** `goal.enabled`; the model may create the initial goal or resume a paused one. */
	goalEnabled: boolean;
}

/** The ordered names `createTools` will construct. Two shapes, and they are not symmetric: */
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
	/** `options.toolNames` normalized (with `yield`/auto-learn already forced in), or undefined. */
	explicitToolNames: readonly string[] | undefined;
	/** The requested names filtered to those the completed registry actually holds. */
	requestedToolNames: readonly string[];
	/** `goal.enabled`; appends the goal lifecycle tool when its registry entry exists. */
	goalEnabled: boolean;
	/** Extension tools whose definition sets `defaultInactive`. */
	defaultInactiveToolNames: ReadonlySet<string>;
	/** Membership test against the COMPLETED registry (built-ins + MCP + custom + extension). */
	hasRegistryTool: (name: string) => boolean;
	/** Whether any discovery mode is active. Back-compat name: it gates the MCP selection path. */
	mcpDiscoveryEnabled: boolean;
	/** MCP tool names belonging to a server named in `mcp.discoveryDefaultServers`. */
	discoveryDefaultServerToolNames: readonly string[];
	/** `selectedMCPToolNames` as persisted on this session branch, un-normalized. */
	persistedSelectedMCPToolNames: readonly string[];
	/** Whether the branch carries an explicit persisted selection entry. */
	hasPersistedMCPToolSelection: boolean;
	/** Custom + non-`defaultInactive` extension tool names, force-activated regardless of filters. */
	alwaysIncludeToolNames: readonly string[];
	/** Effective mode over the COMPLETED registry. */
	effectiveDiscoveryMode: EffectiveToolDiscoveryMode;
	/** Declared load mode of a registry entry, or undefined for MCP/custom/extension tools. */
	loadModeOf: (name: string) => BuiltinToolLoadMode | undefined;
	/** Result of {@link resolveEssentialToolNames}. */
	essentialToolNames: readonly string[];
	/** Result of {@link resolveDiscoveryAllForceActive}. */
	forceActiveToolNames: ReadonlySet<string>;
	/** `harness.profiles[<model>].tools`, when the active model has a profile that lists any. */
	harnessToolAllowlist: readonly string[] | undefined;
}

export interface InitialActiveToolNames {
	/** The ordered active set the session starts with. */
	initialToolNames: string[];
	/** MCP selection the session starts with (persisted or defaulted). */
	initialSelectedMCPToolNames: string[];
	/** The selection a session with no persisted entry would default to. */
	defaultSelectedMCPToolNames: string[];
	/** MCP tools named outright in `options.toolNames`. */
	explicitlyRequestedMCPToolNames: string[];
}

/** Apply a harness profile's per-model tool allowlist. An empty or absent list allows everything. */
export function applyHarnessToolAllowlist(
	toolNames: readonly string[],
	allowlist: readonly string[] | undefined,
): string[] {
	if (!allowlist || allowlist.length === 0) return toolNames.slice();
	const allowed = new Set(allowlist);
	return toolNames.filter(name => allowed.has(name));
}

/** Resolve the tool set a freshly-built session starts with. Six stages, applied in this order. The order is the behavior; each stage can only be read */
export function resolveInitialActiveToolNames(inputs: InitialActiveToolNamesInputs): InitialActiveToolNames {
	const hasExplicitToolNames = inputs.explicitToolNames !== undefined;

	// 1 + 2.
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

	// 3.
	let initialSelectedMCPToolNames: string[] = [];
	let defaultSelectedMCPToolNames: string[] = [];
	let initialToolNames = initialRequestedActiveToolNames.slice();
	if (inputs.mcpDiscoveryEnabled) {
		// Normalized, NOT filtered through the discoverable-MCP index: built-in activations are
		// persisted under this same key for back-compat (see stage 5's `restored` input), so a
		// built-in name here is legitimate and must survive.
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

	// 4.
	for (const name of inputs.alwaysIncludeToolNames) {
		if (inputs.mcpDiscoveryEnabled && isMCPToolNamePrefix(name)) continue;
		if (inputs.hasRegistryTool(name) && !initialToolNames.includes(name)) {
			initialToolNames.push(name);
		}
	}

	// 5.
	if (inputs.effectiveDiscoveryMode === "all") {
		initialToolNames = filterInitialToolsForDiscoveryAll(initialToolNames, {
			loadModeOf: inputs.loadModeOf,
			essentialNames: new Set(inputs.essentialToolNames),
			explicitlyRequested: new Set(inputs.explicitToolNames ?? []),
			// Back-compat: persisted activations live under selectedMCPToolNames today (built-in
			// activation persistence is a follow-up). MCP names won't collide with built-in names.
			restored: new Set(inputs.persistedSelectedMCPToolNames.map(normalizeToolName)),
			forceActive: inputs.forceActiveToolNames,
		});
	}

	// 6.
	initialToolNames = applyHarnessToolAllowlist(initialToolNames, inputs.harnessToolAllowlist);

	return {
		initialToolNames,
		initialSelectedMCPToolNames,
		defaultSelectedMCPToolNames,
		explicitlyRequestedMCPToolNames,
	};
}

/** Literal `mcp__` prefix test. Deliberately NOT `isMCPToolName` from `tool-discovery/tool-index`: identical today, but this */
function isMCPToolNamePrefix(name: string): boolean {
	return name.startsWith("mcp__");
}

/** Re-exported so callers can name a built-in without also importing `builtin-names`. */
export type { BuiltinToolName };
