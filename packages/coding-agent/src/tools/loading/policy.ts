import type { SettingValue } from "../../config/settings-schema";
import { type BuiltinToolName, normalizeToolName, normalizeToolNames, TOOL } from "../builtin-names";

/**
 * THE tool-loading rules, as pure functions over explicit inputs.
 *
 * WHAT LIVES HERE. Every decision that answers one of three questions:
 *
 *   E — does this tool EXIST (should it be constructed / registered)?
 *   P — is this tool PERMITTED (allowed to exist given settings and session shape)?
 *   A — is this tool ACTIVE (in the list sent to the provider on the next turn)?
 *
 * WHAT DOES NOT. Nothing here reads a `Settings` object, touches a session, or looks at a
 * registry. Callers gather inputs and apply the returned decision. That is the property that
 * makes these rules readable in one sitting and testable without booting an agent — and it is
 * why the adapters that DO read settings (`computeEssentialBuiltinNames` in `tools/index.ts`,
 * `resolveEffectiveToolDiscoveryMode` in `tool-discovery/mode.ts`,
 * `filterToolsByHarnessProfile` in `harness/model-profile.ts`) are one-line wrappers that
 * gather and delegate rather than deciding anything themselves.
 *
 * WHAT DELIBERATELY STAYED OUTSIDE. Per-tool `createIf` factories keep their own last-line
 * refusals, several of which duplicate a branch of {@link isBuiltinToolAllowed}. That
 * duplication is intentional: `BUILTIN_TOOLS.debug(session)` is public API, so the factory has
 * to refuse on its own or a caller that bypasses `createTools` gets a tool the policy forbids.
 * Registry mutation (`AgentSession.#applyActiveToolsByName`, `refreshMCPTools`,
 * `refreshSshTool`, vibe/RPC tools, plan-mode swaps) stays with the session for the obvious
 * reason: it mutates private session state, which no pure function can own. The full decision
 * map, including every overlap and every site that resisted, is in `local://tool-load-map.md`.
 *
 * FUTURE LOAD POLICY. A future `always | dynamic | manual` policy has exactly four seams, each
 * marked `FUTURE LOAD POLICY` below: the {@link BuiltinToolLoadMode} union, the
 * {@link filterInitialToolsForDiscoveryAll} filter that reads it, {@link resolveEssentialToolNames}
 * where a per-tool `always` would replace the override list, and
 * {@link resolveDiscoveryAllForceActive} where `manual` would opt out of force-activation.
 * Nothing else in the codebase reads `loadMode` except two `=== "discoverable"` checks that
 * build the discoverable index.
 *
 * CHANGING ANYTHING HERE. `test/tools/tool-loading-differential.test.ts` boots the real
 * `createAgentSession` and freezes the ordered active tool list plus discoverable index for 17
 * settings combinations. It is the guard that made this consolidation provably behavior-
 * preserving, and it is mutation-tested: 16 deliberate rule breaks were injected here and all
 * 16 were caught. A rule added below without a matrix cell is an unprotected rule.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Discovery mode (E, P)
// ─────────────────────────────────────────────────────────────────────────────

/** Registry size above which `tools.discoveryMode: "auto"` starts hiding MCP tools. */
export const TOOL_DISCOVERY_AUTO_THRESHOLD = 40;

export const TOOL_DISCOVERY_SEARCH_TOOL_NAME = "search_tool_bm25";

export type ToolDiscoveryModeSetting = SettingValue<"tools.discoveryMode">;
export type EffectiveToolDiscoveryMode = Exclude<ToolDiscoveryModeSetting, "auto">;

/**
 * Size a tool set for the `auto` threshold.
 *
 * `search_tool_bm25` is excluded because it is the tool discovery ADDS; counting it would let a
 * session that just crossed the threshold count its own remedy and stay across it.
 */
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

/**
 * Resolve the effective discovery mode.
 *
 * THE SAME RULE IS ASKED AT FOUR DIFFERENT TIMES WITH FOUR DIFFERENT TOOL COUNTS, and they can
 * legitimately disagree: `createTools` sees built-ins only, `SearchToolBm25Tool.createIf`
 * passes literal `0`, the SDK sees the completed local registry, and `AgentSession` re-asks
 * against the live registry after deferred MCP discovery lands. A default `auto` session with
 * 45 MCP tools is therefore `off` in the first two and `mcp-only` in the last two — by design,
 * because the SDK registers the tool the earlier stages refused. One rule, four answers.
 */
export function resolveToolDiscoveryMode(inputs: ToolDiscoveryModeInputs): EffectiveToolDiscoveryMode {
	if (inputs.configuredMode === "all" || inputs.configuredMode === "mcp-only") return inputs.configuredMode;
	if (inputs.legacyMcpDiscoveryMode) return "mcp-only";
	if (inputs.configuredMode === "auto" && inputs.toolCount > TOOL_DISCOVERY_AUTO_THRESHOLD) return "mcp-only";
	return "off";
}

// ─────────────────────────────────────────────────────────────────────────────
// Essential tools (A, under discovery-all only)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * FUTURE LOAD POLICY (1/4). How a tool declares when it wants to be loaded.
 *
 * A new `always | dynamic | manual` vocabulary widens this union; every reader of it is either
 * {@link filterInitialToolsForDiscoveryAll} below or a `=== "discoverable"` index check.
 */
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

/**
 * FUTURE LOAD POLICY (3/4). Which built-ins survive `tools.discoveryMode: "all"` outright.
 *
 * The override wins when it is non-empty AFTER trim + normalize + filter-to-built-in. Note the
 * documented edge: an override naming only unknown tools returns `[]`, NOT the defaults — the
 * user said "these and nothing else", and silently restoring seven tools they did not name
 * would be the opposite of what they asked for. `test/tool-discovery/initial-tools.test.ts`
 * pins that behavior; do not "fix" it here.
 */
export function resolveEssentialToolNames(inputs: EssentialToolNamesInputs): string[] {
	const override = inputs.override ?? [];
	const cleaned = normalizeToolNames(override.map(name => name.trim()).filter(Boolean));
	if (cleaned.length > 0) {
		return cleaned.filter(inputs.isBuiltinName);
	}
	return [...DEFAULT_ESSENTIAL_TOOL_NAMES];
}

/**
 * FUTURE LOAD POLICY (2/4). Filter the initial active tool set when `tools.discoveryMode === "all"`.
 *
 * Non-essential discoverable built-ins are hidden — the model rediscovers them via
 * `search_tool_bm25` and activates them on demand. A tool survives hiding when it is essential,
 * explicitly requested, restored from a prior selection, or required by a forced tool_choice
 * feature (`forceActive`). The last case is load-bearing: a named tool_choice (e.g. the eager
 * `todo` prelude) must reference a tool present in the request, or the provider rejects it
 * with 400.
 */
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

/**
 * FUTURE LOAD POLICY (4/4). Tools that must stay active under discovery-all whatever their
 * declared load mode says.
 *
 * `todo`: an eager todo prelude forces a NAMED tool_choice on the first turn, and a named
 * choice that references a tool absent from the request is a provider 400.
 *
 * `task`: STRENGTH ALONE, deliberately. This runs before the task tool has discovered anything,
 * so the enabled-agent set is not knowable yet. Keeping `task` active costs one tool slot and
 * is what lets the prompt decide honestly later, once `resolveDelegation` can see both inputs.
 * Nothing forces a `task` tool_choice; the point is that eager delegation stays possible and
 * the Eager Tasks prompt section renders.
 */
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

// ─────────────────────────────────────────────────────────────────────────────
// Built-in permission (P) and the request list `createTools` builds from it
// ─────────────────────────────────────────────────────────────────────────────

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

/**
 * Whether the `eval` tool exists at all.
 *
 * Exposed whenever ANY backend is reachable; an unreachable backend simply means `eval`
 * dispatches exclusively to the others, checked again at first invocation.
 */
export function resolveEvalToolAvailability(inputs: EvalToolAvailabilityInputs): boolean {
	const effectivePythonAllowed = inputs.pythonAllowed && inputs.pythonAvailable;
	const effectiveRubyAllowed = inputs.rubyAllowed && inputs.rubyAvailable;
	const effectiveJuliaAllowed = inputs.juliaAllowed && inputs.juliaAvailable;
	return effectivePythonAllowed || inputs.jsAllowed || effectiveRubyAllowed || effectiveJuliaAllowed;
}

/**
 * Everything {@link isBuiltinToolAllowed} reads, gathered by the caller.
 *
 * Flat and eager on purpose. The predicate used to close over a `Settings` object and read it
 * lazily per name, which meant the permission table and the settings it depends on could only
 * be seen by reading the function body. Every field below is a pure read (a settings lookup or
 * a derived predicate over one), so hoisting them changes no observable behavior and buys a
 * declaration site that lists, in one place, exactly which settings decide which tools exist.
 */
export interface BuiltinToolPermissionInputs {
	/** `goal.enabled`. */
	goalEnabled: boolean;
	/** `goal.enabled` AND live goal-mode state is enabled. */
	goalModeActive: boolean;
	/** Session-level LSP switch (`ToolSession.enableLsp`, defaulting to true). */
	enableLsp: boolean;
	/** `lsp.enabled`. */
	lspEnabled: boolean;
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

/**
 * THE PERMISSION TABLE. One built-in name in, may-it-exist out.
 *
 * An unlisted name is PERMITTED (the final `return true`). That default is why adding a tool to
 * `BUILTIN_TOOLS` without touching this function ships it on by default, and why a tool that
 * needs a switch has to say so here.
 */
export function isBuiltinToolAllowed(name: string, inputs: BuiltinToolPermissionInputs): boolean {
	if (name === TOOL.goal) return inputs.goalEnabled && inputs.goalModeActive;
	if (name === TOOL.lsp) return inputs.enableLsp && inputs.lspEnabled;
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
		// `subagent.delegation: off` means this session does not delegate at all,
		// so the tool itself is absent rather than present-but-discouraged. A
		// prompt that says "do not spawn subagents" while still shipping the tool
		// description spends tokens describing something the operator turned off.
		if (!inputs.delegationEnabled) return false;
		return inputs.canSpawnAtDepth;
	}
	return true;
}

export interface RequestedToolNamesInputs {
	/** `goal.enabled` AND live goal-mode state is enabled. */
	goalModeActive: boolean;
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

/**
 * Widen an EXPLICIT tool whitelist with the tools its entries imply.
 *
 * Only ever applied to a caller-supplied list. With no list, `createTools` enumerates every
 * built-in and filters by {@link isBuiltinToolAllowed} instead, so there is nothing to widen.
 *
 * The `goal` entry used to be pushed separately, before the eval-backend preflight. It is
 * folded in here because the preflight reads only `includes("eval")` and no push below adds or
 * removes `eval` — the two orderings are indistinguishable. `yield` is NOT folded in; see
 * {@link withYieldToolAppended} for why its position is load-bearing.
 *
 * Append order is part of the contract: it becomes tool order, which becomes prompt order.
 *
 * @returns A NEW array; the input is not mutated.
 */
export function augmentRequestedToolNames(
	requestedToolNames: readonly string[],
	inputs: RequestedToolNamesInputs,
): string[] {
	const requested = [...requestedToolNames];
	const push = (name: string): void => {
		if (!requested.includes(name)) requested.push(name);
	};
	if (inputs.goalModeActive) push(TOOL.goal);
	// Auto-include AST counterparts when their text-based sibling is present
	if (requested.includes(TOOL.grep) && inputs.astGrepEnabled) push(TOOL.ast_grep);
	if (requested.includes(TOOL.edit) && inputs.astEditEnabled) push(TOOL.ast_edit);
	if (memoryToolsBackendEnabled(inputs.memoryBackend)) {
		for (const name of [TOOL.recall, TOOL.retain, TOOL.reflect]) push(name);
	}
	// Auto-learn tools are gated by `autolearn.enabled` but, like the memory
	// tools above, must also be force-included into an explicit requestedTools
	// list so a restricted top-level session whose controller/guidance is
	// active still exposes the tools the nudge points at. Gated to top-level
	// (taskDepth 0): the controller only runs there, so a subagent's explicit
	// tool whitelist must never be silently widened with write-capable tools.
	if (inputs.autolearnEnabled && inputs.isTopLevelSession) {
		push(TOOL.manage_skill);
		if (learnToolBackendEnabled(inputs.memoryBackend)) push(TOOL.learn);
	}
	return requested;
}

/**
 * Append `yield` to an explicit whitelist when the session must terminate through it.
 *
 * CALLED AFTER THE DISCOVERY-MODE TOOL COUNT, and that ordering is the whole reason this is a
 * separate function from {@link augmentRequestedToolNames}. Counting `yield` would let a
 * whitelist sitting exactly on `TOOL_DISCOVERY_AUTO_THRESHOLD` tip over it and silently switch
 * the session into discovery mode. Do not fold this into the augmentation above.
 *
 * @returns A NEW array; the input is not mutated.
 */
export function withYieldToolAppended(requestedToolNames: readonly string[]): string[] {
	if (requestedToolNames.includes(TOOL.yield)) return [...requestedToolNames];
	return [...requestedToolNames, TOOL.yield];
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
	/** `goal.enabled` AND live goal-mode state is enabled. */
	goalModeActive: boolean;
}

/**
 * The ordered names `createTools` will construct.
 *
 * Two shapes, and they are not symmetric:
 *
 * - EXPLICIT whitelist: exactly the requested names that are known and permitted, in the
 *   caller's order, minus `resolve`. `resolve` is dropped here and re-added unconditionally
 *   after construction, because it must be present whenever anything can invoke it (a
 *   deferrable tool staging a preview, or plan mode's standing handler) — which an explicit
 *   whitelist cannot know.
 * - NO whitelist: every permitted built-in in declaration order, then `yield`, then `goal`.
 *   Hidden tools other than those two are never enumerated.
 */
export function selectBaseToolNames(inputs: BaseToolSelectionInputs): string[] {
	if (inputs.requestedToolNames !== undefined) {
		return inputs.requestedToolNames.filter(
			name => inputs.isKnownToolName(name) && inputs.isAllowed(name) && name !== TOOL.resolve,
		);
	}
	const names = inputs.builtinToolNames.filter(inputs.isAllowed);
	if (inputs.requireYieldTool) names.push(TOOL.yield);
	if (inputs.goalModeActive) names.push(TOOL.goal);
	return names;
}

// ─────────────────────────────────────────────────────────────────────────────
// Initial active set (A) — the SDK's session-bootstrap pipeline
// ─────────────────────────────────────────────────────────────────────────────

export interface InitialActiveToolNamesInputs {
	/** `options.toolNames` normalized (with `yield`/auto-learn already forced in), or undefined. */
	explicitToolNames: readonly string[] | undefined;
	/** The requested names filtered to those the completed registry actually holds. */
	requestedToolNames: readonly string[];
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
	if (!allowlist || allowlist.length === 0) return [...toolNames];
	const allowed = new Set(allowlist);
	return toolNames.filter(name => allowed.has(name));
}

/**
 * Resolve the tool set a freshly-built session starts with.
 *
 * Six stages, applied in this order. The order is the behavior; each stage can only be read
 * against the set the previous one produced.
 *
 *   1. DROP `goal`. It is hidden and mode-owned: goal mode activates it, a tool list never does.
 *   2. DROP `defaultInactive` extension tools — unless the caller passed an explicit whitelist,
 *      in which case naming one IS the opt-in.
 *   3. MERGE the MCP selection (only when discovery is on): non-MCP requests keep their order,
 *      then the persisted selection, or persisted ∪ defaults for a branch that never recorded one.
 *   4. APPEND `alwaysInclude` — custom and extension tools that bypass the whitelist entirely.
 *      MCP names are skipped here when discovery is on, because stage 3 owns them.
 *   5. HIDE non-essential discoverable tools under `all`. See
 *      {@link filterInitialToolsForDiscoveryAll}.
 *   6. RESTRICT to the harness profile's allowlist, if the active model has one.
 */
export function resolveInitialActiveToolNames(inputs: InitialActiveToolNamesInputs): InitialActiveToolNames {
	const hasExplicitToolNames = inputs.explicitToolNames !== undefined;

	// 1 + 2.
	const requestedActiveToolNames = inputs.requestedToolNames.filter(name => name !== TOOL.goal);
	const initialRequestedActiveToolNames = hasExplicitToolNames
		? requestedActiveToolNames
		: requestedActiveToolNames.filter(name => !inputs.defaultInactiveToolNames.has(name));
	const explicitlyRequestedMCPToolNames = hasExplicitToolNames
		? requestedActiveToolNames.filter(isMCPToolNamePrefix)
		: [];

	// 3.
	let initialSelectedMCPToolNames: string[] = [];
	let defaultSelectedMCPToolNames: string[] = [];
	let initialToolNames = [...initialRequestedActiveToolNames];
	if (inputs.mcpDiscoveryEnabled) {
		// Normalized, NOT filtered through the discoverable-MCP index: built-in activations are
		// persisted under this same key for back-compat (see stage 5's `restored` input), so a
		// built-in name here is legitimate and must survive.
		const restoredSelectedMCPToolNames = inputs.persistedSelectedMCPToolNames
			.map(normalizeToolName)
			.filter(inputs.hasRegistryTool);
		defaultSelectedMCPToolNames = [
			...new Set([...inputs.discoveryDefaultServerToolNames, ...explicitlyRequestedMCPToolNames]),
		];
		initialSelectedMCPToolNames = inputs.hasPersistedMCPToolSelection
			? restoredSelectedMCPToolNames
			: [...new Set([...restoredSelectedMCPToolNames, ...defaultSelectedMCPToolNames])];
		initialToolNames = [
			...new Set([
				...initialRequestedActiveToolNames.filter(name => !isMCPToolNamePrefix(name)),
				...initialSelectedMCPToolNames,
			]),
		];
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

/**
 * Literal `mcp__` prefix test.
 *
 * Deliberately NOT `isMCPToolName` from `tool-discovery/tool-index`: identical today, but this
 * module is the pure-policy layer and importing the discovery index for one `startsWith` would
 * pull a BM25 implementation into it. The sites this replaced all spelled the prefix inline.
 */
function isMCPToolNamePrefix(name: string): boolean {
	return name.startsWith("mcp__");
}

/** Re-exported so callers can name a built-in without also importing `builtin-names`. */
export type { BuiltinToolName };
