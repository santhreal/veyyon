/**
 * What a caller hands `createAgentSession` and what it gets back, plus the two
 * predicates that say which kind of session is being built.
 *
 * A caller that only builds an options record imports this module instead of the
 * factory, so naming a field does not pull in the composition root.
 */

import type { AgentTelemetryConfig } from "@veyyon/agent-core";
import type { Model } from "@veyyon/ai";
import type { ArgotSession } from "argot";
import type { EffortSource } from "../config/effort-resolver";
import type { ModelRegistry } from "../config/model-registry";
import type { PromptTemplate } from "../config/prompt-templates";
import type { Settings } from "../config/settings";
import type { Rule } from "../discovery/capability/rule";
import type { ToolPathWithSource } from "../extensibility/custom-tools";
import type { CustomTool } from "../extensibility/custom-tools/types";
import type {
	ExtensionFactory,
	ExtensionUIContext,
	LoadExtensionsResult,
	ToolDefinition,
} from "../extensibility/extensions";
import type { Skill } from "../extensibility/skills";
import type { FileSlashCommand } from "../extensibility/slash-commands";
import type { LocalProtocolOptions } from "../internal-urls";
import type { LspStartupServerInfo } from "../lsp";
import type { MCPManager } from "../mcp";
import type { HindsightSessionState } from "../memory/hindsight/state";
import type { MnemopiSessionState } from "../memory/mnemopi/state";
import type { AgentRegistry } from "../registry/agent-registry";
import type { ConfiguredThinkingLevel } from "../thinking";
import type { EventBus } from "../utils/event-bus";
import type { WorkspaceTree } from "../workspace-tree";
import type { AgentSession } from "./agent-session";
import type { PlanYolo, Prewalk } from "./agent-session-types";
import type { AuthStorage } from "./auth-storage";
import { discoverContextFiles } from "./factory-extensions";
import type { OperatorNotices } from "./operator-notices";
import type { SessionManager } from "./session-manager";

export interface CreateAgentSessionOptions {
	/** Working directory for project-local discovery. Default: getProjectDir() */
	cwd?: string;
	/** Agent config directory for this session. Default: `getAgentDir()`, i.e. `~/.veyyon/profiles/<active profile>/agent`. */
	agentDir?: string;
	/** Cross-profile vault/key root override for isolated SDK hosts. Default: getGlobalConfigRootDir() */
	globalConfigRoot?: string;
	/** Spawns to allow. Default: "*" */
	spawns?: string;

	/** Auth storage for credentials. Default: discoverAuthStorage(agentDir) */
	authStorage?: AuthStorage;
	/** Model registry. Default: discoverModels(authStorage, agentDir) */
	modelRegistry?: ModelRegistry;

	/** Model to use. Default: from settings, else first available */
	model?: Model;
	/** Raw model pattern(s) (e.g. from --model CLI flag) to resolve after extensions load.
	 * Used when model lookup is deferred because extension-provided models aren't registered yet. */
	modelPattern?: string | string[];
	/** Authenticated fallback selector for deferred subagent model patterns. */
	modelPatternAuthFallback?: string;
	/** Role name used to install retry fallbacks after deferred subagent patterns resolve. */
	modelPatternFallbackRole?: string;
	/** Thinking selector. Default: from settings, else unset */
	thinkingLevel?: ConfiguredThinkingLevel;
	/** Internal precedence source for the initial effort selection. */
	thinkingSource?: EffortSource;
	/** Models available for cycling (Ctrl+P in interactive mode). */
	scopedModels?: Array<{
		model: Model;
		thinkingLevel?: ConfiguredThinkingLevel;
		/** True only when this entry carried an explicit `:effort` suffix. */
		explicitThinkingLevel?: boolean;
	}>;
	/** Prewalk from the starting model to a fast/cheap target at the first edit/write once the todo list exists. */
	prewalk?: Prewalk;
	/** Force read-only plan mode at start, auto-approve on the model's first resolve call, then switch to execute. */
	planYolo?: PlanYolo;

	/** Provider-facing system prompt override. Replaces the fully rendered default blocks. */
	systemPrompt?: string | string[] | ((defaultPrompt: string[]) => string | string[]);
	/** Already-loaded custom prompt text rendered through the bundled custom system prompt template. */
	customSystemPrompt?: string;
	/** Already-loaded text appended through the bundled system prompt templates. */
	appendSystemPrompt?: string;
	/**
	 * Already-loaded title-generation system prompt override (typically
	 * {@link discoverTitleSystemPromptFile} → {@link resolvePromptInput}). When
	 * set, every automatic session-title generation path on this session — the
	 * first-input title and the replan-driven refresh — uses this prompt
	 * instead of the bundled default. Refresh on cwd change via
	 * {@link AgentSession.setTitleSystemPrompt}.
	 */
	titleSystemPrompt?: string;
	/** Optional provider-facing session identifier for prompt caches and sticky auth selection.
	 * Keeps persisted session files isolated while reusing provider-side caches. */
	providerSessionId?: string;
	/** Optional provider-facing prompt cache key, distinct from request lineage. */
	providerPromptCacheKey?: string;
	/** Whether `providerPromptCacheKey` is caller-pinned or inherited from a full fork. */
	providerPromptCacheKeySource?: "explicit" | "fork";
	/** Absolute wall-clock deadline in Unix epoch milliseconds. */
	deadline?: number;

	/** Custom tools to register (in addition to built-in tools). Accepts both CustomTool and ToolDefinition. */
	customTools?: (CustomTool | ToolDefinition)[];
	/** Inline extensions (merged with discovery). */
	extensions?: ExtensionFactory[];
	/** Additional extension paths to load (merged with discovery). */
	additionalExtensionPaths?: string[];
	/** Disable extension discovery (explicit paths still load). */
	disableExtensionDiscovery?: boolean;
	/**
	 * Pre-loaded extensions (skips file discovery and the per-session factory
	 * call). Used by the CLI when extensions are loaded early to parse custom
	 * flags — the same process owns the returned instances, so reusing them is
	 * safe.
	 *
	 * NEVER pass this across session boundaries (e.g. parent → subagent).
	 * `Extension` instances close over a parent-bound `ExtensionAPI` (cwd,
	 * eventBus, runtime), and reusing them would route tools/handlers/commands
	 * back through the parent. For subagents, forward
	 * {@link preloadedExtensionPaths} instead.
	 *
	 * @internal
	 */
	preloadedExtensions?: LoadExtensionsResult;
	/**
	 * Pre-discovered extension source paths. When provided, the filesystem-scan
	 * inside `discoverExtensionPaths()` is skipped — the session still calls
	 * `loadExtensions()` itself so each `Extension` is bound to THIS session's
	 * `ExtensionAPI` (cwd, eventBus, runtime).
	 *
	 * This is the safe pass-through for parent → subagent forwarding.
	 */
	preloadedExtensionPaths?: string[];
	/**
	 * The operator-named subset of {@link preloadedExtensionPaths}: the parent's `--extension`
	 * flags and `extensions:` entries.
	 *
	 * The project-trust gate exempts a path the operator named and withholds one the project scan
	 * found. A subagent inherits the parent's path list and cannot tell those apart, so without
	 * this it re-gated the operator's own file and started without it.
	 */
	preloadedNamedExtensionPaths?: string[];
	/**
	 * Pre-discovered custom-tool source paths from `.veyyon/tools/`, `.claude/tools/`,
	 * plugins, etc. When provided, the filesystem-scan inside
	 * `discoverCustomToolPaths()` is skipped — subagents inherit the parent's
	 * scan result and call `loadCustomTools()` themselves so each session binds
	 * tools to its OWN `CustomToolAPI` (cwd, exec, pushPendingAction, UI).
	 *
	 * Forwarding the loaded `LoadedCustomTool[]` instances directly would reuse
	 * the parent's session-bound API and route tool execution back through the
	 * parent — wrong for isolated tasks and for pending-action routing.
	 */
	preloadedCustomToolPaths?: ToolPathWithSource[];

	/** Shared event bus for tool/extension communication. Default: creates new bus. */
	eventBus?: EventBus;

	/**
	 * Where non-fatal problems the operator must see are delivered.
	 *
	 * Pass one built by the surface that can render it: a TUI constructs it with no sink and
	 * attaches its own once the screen exists, so warnings raised during session startup are
	 * buffered rather than lost. Default: a collector that writes to stderr as notices arrive,
	 * which is loud in the wrong place rather than silent (Law 10).
	 */
	operatorNotices?: OperatorNotices;

	/** Skills. Default: discovered from multiple locations */
	skills?: Skill[];
	/** Rules. Default: discovered from multiple locations */
	rules?: Rule[];
	/**
	 * Context files (AGENTS.md / CLAUDE.md content). Default: all three scopes via
	 * {@link discoverContextFiles}, not the project walk alone: global
	 * (`<config root>/AGENTS.md`), profile (`agentDir`'s own instruction file), and
	 * project (the walk up from `cwd`).
	 */
	contextFiles?: Array<{ path: string; content: string }>;
	/** Pre-built workspace tree (skips re-scanning; passed by parents to subagents). */
	workspaceTree?: WorkspaceTree;
	/** Prompt templates. Default: discovered from cwd/.veyyon/prompts/ + agentDir/prompts/ */
	promptTemplates?: PromptTemplate[];
	/** File-based slash commands. Default: discovered from commands/ directories */
	slashCommands?: FileSlashCommand[];

	/** Enable MCP server discovery from .mcp.json files. Default: true */
	enableMCP?: boolean;
	/** Existing MCP manager to reuse (skips discovery, propagates to toolSession). */
	mcpManager?: MCPManager;

	/** Enable LSP integration (tool, formatting, diagnostics, warmup). Default: true */
	enableLsp?: boolean;
	/** Skip subprocess-kernel availability checks and prelude warmup */
	skipPythonPreflight?: boolean;
	/** Tool names explicitly requested (enables disabled-by-default tools) */
	toolNames?: string[];

	/** Output schema for structured completion (subagents) */
	outputSchema?: unknown;
	/** Whether to include the yield tool by default */
	requireYieldTool?: boolean;
	/** Task recursion depth (for subagent sessions). Default: 0 */
	taskDepth?: number;
	/** Resolved absolute spawn-depth cap for this session's agent type. */
	maxNestedSpawnDepth?: number;
	/** Parent Hindsight state to alias for subagent memory tools. */
	parentHindsightSessionState?: HindsightSessionState;
	/**
	 * Parent session's Argot codec, forked into this subagent when
	 * `argot.subagents` is `inherit`. Absent for a top-level session or when the
	 * parent has Argot off; `createArgotSession` then arms fresh (never silently
	 * empty). Correctness never depends on this: it is a token optimization.
	 */
	parentArgot?: ArgotSession;
	/** Parent Mnemopi state to alias for subagent memory tools. */
	parentMnemopiSessionState?: MnemopiSessionState;
	/** Pre-allocated agent identity for IRC routing. Default: "Main" for top-level, parentTaskPrefix-derived for sub. */
	agentId?: string;
	/** Display name for the agent in IRC. Default: "main" or "sub". */
	agentDisplayName?: string;
	/** Optional shared agent registry for IRC routing. Default: AgentRegistry.global(). */
	agentRegistry?: AgentRegistry;
	/** Parent task ID prefix for nested artifact naming (e.g., "Extensions") */
	parentTaskPrefix?: string;
	/**
	 * Registry id of the spawning agent, recorded as this subagent's parent in
	 * the agent registry. Distinct from `parentTaskPrefix`, which is this agent's
	 * own artifact/output-id prefix (the executor passes the child's own id
	 * there, so it must never double as the parent link). Undefined for the
	 * top-level "Main" session, which has no parent.
	 */
	parentAgentId?: string;
	/** Inherited eval executor session id for subagents sharing parent eval state. */
	parentEvalSessionId?: string;

	/** Session manager. Default: session stored under the configured agentDir sessions root */
	sessionManager?: SessionManager;

	/** Override local:// protocol options for subagent local:// sharing. Default: uses the session's own artifacts dir and session ID. */
	localProtocolOptions?: LocalProtocolOptions;

	/** Settings instance. Default: Settings.init({ cwd, agentDir }) */
	settings?: Settings;
	/**
	 * Legacy alias for `settings`. Older Pi extensions pass SettingsManager.create(...)
	 * through this field; accept it so their SDK calls keep the configured settings.
	 */
	settingsManager?: Settings | Promise<Settings>;

	/** Whether UI is available (enables interactive tools like ask). Default: false */
	hasUI?: boolean;

	/**
	 * Opt-in OpenTelemetry instrumentation forwarded to the underlying Agent.
	 * Passing `{}` enables the loop's GenAI-semantic-convention spans. See
	 * {@link AgentTelemetryConfig} for the full surface (hooks, content capture,
	 * cost estimator, agent identity).
	 *
	 * Safe to enable without an OTEL SDK registered in the host: the
	 * `@opentelemetry/api` package returns a no-op tracer in that case.
	 */
	telemetry?: AgentTelemetryConfig;

	/**
	 * Fired once, when the agent loop hands its first request to the provider
	 * transport (i.e. the `streamFn` wrapper is first invoked). Used to measure
	 * subagent launch latency — the boundary between "session built" and "model
	 * call dispatched". This is the loop's dispatch point, slightly before the
	 * actual provider HTTP call (per-request prep, identical across all
	 * requests, follows it), which is the right granularity for launch timing.
	 */
	onFirstChatDispatch?: () => void;

	/** Whether to auto-approve all tool calls (--auto-approve CLI flag). Default: false */
	autoApprove?: boolean;

	/**
	 * Start with the full permission bypass on (the `--dangerously-skip-permissions`
	 * flag). Stronger than `autoApprove`: removes every prompt including per-tool
	 * `prompt` overrides. Explicit `deny` and plan mode still block. Default: false.
	 */
	bypassAllApprovals?: boolean;

	/**
	 * A subagent's live view of its parent's bypass. `bypassAllApprovals` above
	 * is a snapshot taken at spawn, so without this a parent that turns `/yolo`
	 * off leaves an already-running child bypassing approvals to the end of its
	 * run. Consulted on every check, and it can only narrow: a child whose own
	 * bypass is off is never granted one by its parent.
	 */
	parentApprovalBypassed?: () => boolean;
}

/**
 * Whether these options describe a SUBAGENT: a session another session spawned
 * inside this same process, rather than the top-level session the process was
 * started for.
 *
 * Both signals are needed. `taskDepth` counts task recursion and is what the task
 * executor sets; `parentTaskPrefix` names the spawning agent's artifact prefix and
 * is what the IRC and registry path sets. A session can arrive carrying one and
 * not the other, so asking about either alone misses a real subagent.
 *
 * ONE owner because the answer decides four separate things: which Argot policy
 * the session follows, whether it is displayed as "sub", whether it is given the
 * vibe tools, and whether re-rooting it may move the PROCESS working directory.
 * Those were four inline copies of this expression, which is three chances for
 * them to disagree about what a subagent is. The last of the four is the one with
 * teeth, because a subagent that re-roots the process moves the working directory
 * out from under its parent and every sibling sharing the process.
 */
export function isSubagentSession(options: Pick<CreateAgentSessionOptions, "taskDepth" | "parentTaskPrefix">): boolean {
	return (options.taskDepth ?? 0) > 0 || Boolean(options.parentTaskPrefix);
}

/**
 * Whether another session in THIS process spawned this one, and therefore already
 * owns the process-global singletons it should inherit rather than replace.
 *
 * Deliberately NOT `isSubagentSession`, and the difference is the point. That
 * predicate answers "is this a subagent", and takes `taskDepth` into account
 * because a session can be one without carrying a parent's prefix. This one
 * answers a narrower question about OWNERSHIP, and only a `parentTaskPrefix` can
 * answer it: the prefix is what names the spawning agent, so it is the only signal
 * that says a live parent exists in this process to inherit from. A `taskDepth`
 * greater than zero says the session sits at some recursion depth, which does not
 * imply anyone here owns anything.
 *
 * Swapping in `isSubagentSession` here would change behaviour for a session
 * carrying depth but no prefix. It would stop installing the skills, rules and
 * MCP singletons, and it would take `AsyncJobManager.instance()` as its scoped
 * manager, which is `undefined` when nothing installed one. That session would
 * then refuse async work with no parent to route to instead.
 *
 * No in-tree caller constructs that shape today: the task executor and
 * `persisted-revive` both set the two together, and the eval bridge reaches the
 * executor, which sets `parentTaskPrefix` at the spawn. `createAgentSession` is a
 * public SDK export, though, so an outside caller can pass depth alone, which is
 * exactly why the two questions get two named predicates rather than one shared
 * expression that happens to read the same today.
 */
export function isInProcessChildSession(options: Pick<CreateAgentSessionOptions, "parentTaskPrefix">): boolean {
	return Boolean(options.parentTaskPrefix);
}

/** Result from createAgentSession */
export interface CreateAgentSessionResult {
	/** The created session */
	session: AgentSession;
	/** Extensions result (loaded extensions + runtime) */
	extensionsResult: LoadExtensionsResult;
	/** Update tool UI context (interactive mode) */
	setToolUIContext: (uiContext: ExtensionUIContext, hasUI: boolean) => void;
	/** MCP manager for server lifecycle management (undefined if MCP disabled) */
	mcpManager?: MCPManager;
	/** Warning if session was restored with a different model than saved */
	modelFallbackMessage?: string;
	/** LSP servers detected for startup; warmup may continue in the background */
	lspServers?: LspStartupServerInfo[];
	/** Shared event bus for tool/extension communication */
	eventBus: EventBus;
}
