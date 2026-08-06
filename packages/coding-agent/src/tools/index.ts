import type {
	AgentTelemetryConfig,
	AgentTool,
	AgentToolContext,
	ThinkingLevel,
	ToolCallContext,
} from "@veyyon/agent-core";
import type { FetchImpl, ImageContent, Model, ServiceTierByFamily, ToolChoice } from "@veyyon/ai";
import type { InMemorySnapshotStore } from "@veyyon/hashline";
import { logger } from "@veyyon/utils";
import { ARGOT_LOAD_TOOL, ARGOT_UNLOAD_TOOL, type ArgotSession } from "argot";
import type { AsyncJobManager } from "../async/job-manager";
import type { ContextFile } from "../capability/context-file";
import type { Rule } from "../capability/rule";
import type { PromptTemplate } from "../config/prompt-templates";
import type { Settings } from "../config/settings";
import type { ToolPathWithSource } from "../extensibility/custom-tools";
import type { Skill } from "../extensibility/skills";
import type { GoalModeState, GoalRuntime } from "../goals";
import type { HindsightSessionState } from "../hindsight/state";
import type { LocalProtocolOptions } from "../internal-urls";
import type { MCPManager } from "../mcp";
import type { MnemopiSessionState } from "../mnemopi/state";
import type { PlanModeState } from "../plan-mode/state";
import type { AgentRegistry } from "../registry/agent-registry";
import type { ArtifactManager } from "../session/artifacts";
import type { ClientBridge } from "../session/client-bridge";
import type { CustomMessage } from "../session/messages";
import type { SubagentSpawnRecord, UsageStatistics } from "../session/session-entries";
import type { ToolChoiceQueue } from "../session/tool-choice-queue";
import type { AgentOutputManager } from "../task/output-manager";
import { delegationEnabled, resolveSessionMaxNestedSpawnDepth } from "../task/subagent-settings";
import { canSpawnAtDepth } from "../task/types";
import type { ConfiguredThinkingLevel } from "../thinking";
import { resolveEffectiveToolDiscoveryMode } from "../tool-discovery/mode";
import type { DiscoverableTool, DiscoverableToolSearchIndex } from "../tool-discovery/tool-index";
import type { EventBus } from "../utils/event-bus";
import type { WorkspaceTree } from "../workspace-tree";
import { type BuiltinToolName, type HiddenToolName, normalizeToolNames, TOOL } from "./builtin-names";
import type { CheckpointState, CompletedRewindState } from "./checkpoint";
import { resolveEvalBackends } from "./eval-backends";
import { isIrcEnabled } from "./irc-enabled";
import {
	augmentRequestedToolNames,
	type BuiltinToolPermissionInputs,
	countToolsForAutoDiscovery,
	isBuiltinToolAllowed,
	resolveEssentialToolNames,
	resolveEvalToolAvailability,
	selectBaseToolNames,
	withYieldToolAppended,
} from "./loading";
import { wrapToolWithMetaNotice } from "./output-meta";
import { RerootDetector, wrapToolWithRerootHint } from "./reroot-hint";
import type { TodoPhase } from "./todo";

// NOTE: tool implementation modules are intentionally NOT imported eagerly
// here. Each factory in BUILTIN_TOOLS / HIDDEN_TOOLS dynamic-imports its
// module on first construction, so the CLI boot path never parses tool
// implementations it does not activate. The public re-exports of every tool
// module live in `src/index.ts` (the library entry), not in this barrel.
// Type-only re-exports below are erased at runtime and cost nothing.
export type { LspStartupServerInfo } from "../lsp";
export type { BashToolDetails, BashToolInput } from "./bash";
export type { GlobToolDetails, GlobToolInput } from "./glob";
export type { GrepToolDetails, GrepToolInput } from "./grep";
// Tool-loading rules now live in `./loading`. Re-exported here because `@veyyon/coding-agent/tools`
// is the documented import path for them and the SDK plus several suites use it.
export {
	type BuiltinToolLoadMode,
	DEFAULT_ESSENTIAL_TOOL_NAMES,
	filterInitialToolsForDiscoveryAll,
} from "./loading";
export type { ReadToolDetails, ReadToolInput } from "./read";
export type { WriteToolInput } from "./write";

/** Tool type (AgentTool from pi-ai) */
export type Tool = AgentTool<any, any, any>;

export type ContextFileEntry = {
	path: string;
	content: string;
	depth?: number;
	/**
	 * Which scope the file came from, preserved from context-file discovery
	 * (`ContextFile.level` in `capability/context-file.ts` owns the meaning).
	 * Absent when a caller synthesized the entry by hand: provenance unknown,
	 * which delivery channels restricted to operator-owned scopes (Cursor rules)
	 * treat as not the operator's own and leave out.
	 */
	level?: ContextFile["level"];
};

/** Image attachment handle exposed to tools for user-facing labels such as `Image #1`. */
export type ImageAttachmentEntry = {
	label: string;
	uri: string;
	image: ImageContent;
};

export type {
	DiscoverableTool,
	DiscoverableToolSearchIndex,
	DiscoverableToolSearchResult,
	DiscoverableToolSource,
} from "../tool-discovery/tool-index";

/**
 * A late LSP diagnostics result that arrived after the edit/write tool already
 * returned. Surfaced to the model and the transcript via
 * {@link ToolSession.queueDeferredDiagnostics}, batched through the session
 * yield queue like background-job results.
 */
export interface DeferredDiagnosticsEntry {
	/** Absolute path the diagnostics belong to (the renderer shortens it). */
	path: string;
	/** One-line severity summary, e.g. "2 errors". */
	summary: string;
	/** Formatted, ready-to-display diagnostic lines. */
	messages: string[];
	/** True when any message is error severity. */
	errored: boolean;
	/**
	 * Evaluated at injection time (in the dispatcher's stale check): drop the entry
	 * when a newer mutation to the same file has superseded it, so the model never
	 * sees diagnostics for stale content.
	 */
	isStale(): boolean;
}

/** Session context for tool factories */
export interface ToolSession {
	/** Current working directory */
	cwd: string;
	/**
	 * Re-root the live session cwd for this session only.
	 * Never writes profile `session.workdir` or other persisted config.
	 * Returns the resolved absolute path.
	 */
	setCwd?(resolvedPath: string, options?: { validate?: boolean }): Promise<string>;
	/**
	 * Redact one provider-bound string at the final tool-owned outbound seam.
	 * The callback is live: callers must invoke it immediately before dispatch.
	 */
	obfuscateProviderText?: (text: string) => string;
	/** Whether UI is available */
	hasUI: boolean;
	/** Effective concrete effort currently applied to the parent session. */
	readonly thinkingLevel?: ThinkingLevel;
	/**
	 * Suppress the spawn specialization/coordination advisory appended to `task`
	 * results. Set by internal/programmatic callers (e.g. the commit agent's
	 * file-analysis fan-out) whose results are consumed by code — not by a model
	 * orchestrating further spawns — so the nudge would only be noise.
	 */
	suppressSpawnAdvisory?: boolean;
	/** Optional fetch implementation injected into the URL read pipeline (tests, proxies). Defaults to global fetch. */
	fetch?: FetchImpl;
	/** Skip subprocess-kernel availability checks and warmup */
	skipPythonPreflight?: boolean;
	/** Pre-loaded context files (AGENTS.md, etc) */
	contextFiles?: ContextFileEntry[];
	/** Pre-loaded workspace tree (forwarded to subagents to skip re-scanning) */
	workspaceTree?: WorkspaceTree;
	/** Pre-loaded skills */
	skills?: Skill[];
	/** Pre-loaded prompt templates */
	promptTemplates?: PromptTemplate[];
	/** Pre-loaded rules (forwarded to subagents to skip re-discovery). */
	rules?: Rule[];
	/**
	 * Pre-discovered extension source paths. Forwarded to subagents so they
	 * skip the FS scan but still re-bind extensions to their own session-scoped
	 * `ExtensionAPI` (cwd, eventBus, runtime). Inline extension factories
	 * (`<inline-N>`) are NOT included — those are session-local.
	 */
	extensionPaths?: string[];
	/**
	 * Pre-discovered custom-tool source paths from `.veyyon/tools/`, `.claude/tools/`,
	 * plugins, etc. Forwarded to subagents so they skip the FS scan but still
	 * re-bind tools to their own session-scoped `CustomToolAPI`.
	 */
	customToolPaths?: ToolPathWithSource[];
	/** Whether LSP integrations are enabled */
	enableLsp?: boolean;
	/** Whether an edit-capable tool is available in this session (controls hashline output) */
	hasEditTool?: boolean;
	/** Event bus for tool/extension communication */
	eventBus?: EventBus;
	/** Output schema for structured completion (subagents) */
	outputSchema?: unknown;
	/** Whether to include the yield tool by default */
	requireYieldTool?: boolean;
	/** Task recursion depth (0 = top-level, 1 = first child, etc.) */
	taskDepth?: number;
	/** Resolved absolute spawn-depth cap for this session's agent type. */
	maxNestedSpawnDepth?: number;
	/** Get shared eval executor session ID. Subagents inherit this to share JS/Python/Ruby/Julia state. */
	getEvalSessionId?: () => string | null;
	/** Get session file */
	getSessionFile: () => string | null;
	/** Get eval kernel owner ID for session-scoped retained-kernel cleanup. */
	getEvalKernelOwnerId?: () => string | null;
	/** Reject new eval work once session disposal has started. */
	assertEvalExecutionAllowed?: () => void;
	/** Track tool-owned eval work so session disposal can await/abort it like direct session eval runs. */
	trackEvalExecution?<T>(execution: Promise<T>, abortController: AbortController): Promise<T>;
	/** Get session ID */
	getSessionId?: () => string | null;
	/**
	 * Whether a `/` command has granted this agent type for the turn in flight.
	 *
	 * `subagent.agents.<name>.enabled` governs THE MODEL: enabled means the model
	 * may pick that agent on its own initiative, disabled means it may not. It does
	 * not govern the person typing. `/review` names `reviewer` outright, and a user
	 * running `/review` is asking for a review, not asking the model to decide
	 * whether reviewing is a good idea — so the command declares the agents its
	 * prompt will name and the spawn is honored even with that agent disabled.
	 *
	 * Turn-scoped and command-declared, deliberately. A grant that outlived its
	 * turn, or one that any caller could set, would be the old "disabled but still
	 * runs" state again with extra steps: the whole reason that state was removed
	 * is that a switch has to mean what it says for every path the MODEL controls.
	 *
	 * Absent (no implementation) means no grant, so a session that never runs
	 * commands behaves exactly as the setting reads.
	 */
	agentGrantedThisTurn?: (agentName: string) => boolean;
	/**
	 * How many assistant turns have already happened in this session.
	 *
	 * Used to price how long a tool result will sit in context. A result is
	 * billed once as fresh input and then re-read as a cache token on every later
	 * turn, so an early result costs far more than the same bytes late in a
	 * session. See `inlineCapForTurn` in session/streaming-output.
	 */
	getTurnIndex?: () => number;
	/** Get Hindsight runtime state for this agent session. */
	getHindsightSessionState?: () => HindsightSessionState | undefined;
	/** Get this session's Argot codec, forked into subagents under `argot.subagents: inherit`. */
	getArgotSession?: () => ArgotSession | undefined;
	/**
	 * Rebuild the base system prompt after prompt-visible session state changed
	 * (e.g. the argot teach set), so the next turn teaches the new state.
	 * Optional: lighter tool sessions (tests, subagents) may omit it.
	 *
	 * `reason` is REQUIRED, mirroring `AgentSession.refreshBaseSystemPrompt`. A
	 * rebuild here lands MID-TURN, with the whole conversation already behind the
	 * prefix, so it is the most expensive shape this call has: the next request
	 * re-reads every token. This signature took no argument, which let a tool
	 * spend that re-prefill and record `reason: undefined` — exactly the
	 * unattributed entry the required parameter on the session method exists to
	 * prevent. Optionality is about whether the hook is wired, never about
	 * whether the cost gets a name.
	 */
	refreshBaseSystemPrompt?(reason: string): Promise<void>;
	/** Get Mnemopi runtime state for this agent session. */
	getMnemopiSessionState?: () => MnemopiSessionState | undefined;
	/** Agent identity used for IRC routing. Returns the registry id (e.g. "Main", "AuthLoader"). */
	getAgentId?: () => string | null;
	/**
	 * Whether the `/yolo` full bypass is on for this session. Session scoped and
	 * never written to settings, so a spawning tool has to read it here to pass
	 * the parent's rung to a child.
	 */
	isApprovalBypassed?: () => boolean;
	/**
	 * Resolve the live {@link AgentToolContext} for a tool call this session
	 * makes outside the agent loop (the eval and browser bridges). The approval
	 * wrapper reads its whole policy from that context: an absent one silently
	 * downgrades an explicit `tools.approval.<tool>: deny`, plan mode, the cwd
	 * and secret boundaries, and a standing session denial into a plain
	 * unchecked call. Every caller that reaches a registered tool directly must
	 * pass what this returns.
	 */
	getToolContext?: (toolCall?: ToolCallContext) => AgentToolContext | undefined;
	/** Look up a registered tool by name (used by the eval js backend's tool bridge). */
	getToolByName?: (name: string) => AgentTool | undefined;
	/** Return whether a built-in tool is active in this turn's tool set. */
	isToolActive?: (name: string) => boolean;
	/** Update the active built-in tool predicate when a session changes tools mid-run. */
	setActiveToolNames?: (names: Iterable<string>) => void;
	/** Agent registry for IRC routing across live sessions. */
	agentRegistry?: AgentRegistry;
	/** Get artifacts directory for artifact:// URLs */
	getArtifactsDir?: () => string | null;
	/**
	 * Record a structured parent->child index entry for one subagent this session
	 * spawned (the task tool calls this once per settled subagent). Absent on
	 * sessions that do not persist; a no-op there.
	 */
	recordSubagentSpawn?: (record: SubagentSpawnRecord) => void;
	/** Get the ArtifactManager backing this session (shared across parent + subagents). */
	getArtifactManager?: () => ArtifactManager | null;
	/** Allocate a new artifact path and ID for session-scoped truncated output. */
	allocateOutputArtifact?: (toolType: string) => Promise<{ id?: string; path?: string }>;
	/** Get session spawns */
	getSessionSpawns: () => string | null;
	/** Get resolved model string if explicitly set for this session */
	getModelString?: () => string | undefined;
	/** Get the current session model string, regardless of how it was chosen */
	getActiveModelString?: () => string | undefined;
	/** Get the current session's configured effort (`auto` remains `auto`) for subagent inheritance. */
	getActiveThinkingLevel?: () => ConfiguredThinkingLevel | undefined;
	/** Get the current session model object (provider/api capabilities), regardless of how it was chosen. */
	getActiveModel?: () => Model | undefined;
	/** Get the session's live per-family service tiers (undefined = none). Source of truth for subagent `tier.subagent: inherit`. */
	getServiceTierByFamily?: () => ServiceTierByFamily | undefined;
	/** Auth storage for passing to subagents (avoids re-discovery) */
	authStorage?: import("../session/auth-storage").AuthStorage;
	/** Model registry for passing to subagents (avoids re-discovery) */
	modelRegistry?: import("../config/model-registry").ModelRegistry;
	/** Agent output manager for unique agent:// IDs across task invocations */
	agentOutputManager?: AgentOutputManager;
	/**
	 * Async job manager scoped to this session.
	 *
	 * - Top-level session that constructed one: its own manager.
	 * - Subagent (`parentTaskPrefix` set): the parent's manager, so background
	 *   bash/task work and `onJobComplete` deliveries flow into the conversation
	 *   that spawned it.
	 * - Secondary in-process top-level session that found a singleton already
	 *   installed (issue #1923): `undefined`. Tools refuse async work rather
	 *   than silently route completions into the owning session's `yieldQueue`.
	 *
	 * Tools MUST use this instead of `AsyncJobManager.instance()` so a secondary
	 * session never borrows the owning session's manager by accident.
	 */
	asyncJobManager?: AsyncJobManager;
	/** MCP manager visible to subagents without relying on the process-global singleton. */
	mcpManager?: MCPManager;
	/** Local protocol root to propagate to nested subagents and eval-created agents. */
	localProtocolOptions?: LocalProtocolOptions;
	/** Settings instance for passing to subagents */
	settings: Settings;
	/** Plan mode state (if active) */
	getPlanModeState?: () => PlanModeState | undefined;
	/** Path of the session's active plan reference (e.g. `local://<title>.md`); defaults to `local://PLAN.md`. */
	getPlanReferencePath?: () => string;
	/** Goal mode state (if active or paused) */
	getGoalModeState?: () => GoalModeState | undefined;
	/** Goal runtime for the active agent session. */
	getGoalRuntime?: () => GoalRuntime | undefined;
	/** Get cumulative session usage statistics (input/output tokens, cost). */
	getUsageStatistics?: () => UsageStatistics;
	/** Current per-turn token budget {total, spent, hard} for the eval `budget` helper. */
	getTurnBudget?: () => { total: number | null; spent: number; hard: boolean };
	/** Record output tokens consumed by an eval-spawned subagent toward the current turn budget. */
	recordEvalSubagentUsage?: (output: number) => void;
	/** Bridge to the connected client (e.g. ACP editor host). Tools should route fs/terminal/permission requests through this when available. */
	getClientBridge?: () => ClientBridge | undefined;
	/** Get cached todo phases for this session. */
	getTodoPhases?: () => TodoPhase[];
	/** Replace cached todo phases for this session. */
	setTodoPhases?: (phases: TodoPhase[]) => void;
	/** Whether MCP tool discovery is active for this session. */
	isMCPDiscoveryEnabled?: () => boolean;
	/** Get MCP tools activated by prior search_tool_bm25 calls. */
	getSelectedMCPToolNames?: () => string[];
	/** Merge MCP tool selections into the active session tool set. */
	activateDiscoveredMCPTools?: (toolNames: string[]) => Promise<string[]>;
	// ── Generic tool discovery (unified — covers built-in + MCP + extension) ──
	/** Whether any form of tool discovery is active (tools.discoveryMode !== "off" or mcp.discoveryMode). */
	isToolDiscoveryEnabled?: () => boolean;
	/** Get all hidden-but-discoverable tools for search_tool_bm25 prompts. */
	getDiscoverableTools?: (filter?: {
		source?: import("../tool-discovery/tool-index").DiscoverableToolSource;
	}) => DiscoverableTool[];
	/** Get the cached generic discoverable search index. */
	getDiscoverableToolSearchIndex?: () => DiscoverableToolSearchIndex;
	/** Get tool names activated by prior search_tool_bm25 calls (all sources). */
	getSelectedDiscoveredToolNames?: () => string[];
	/** Merge tool selections into the active session tool set. */
	activateDiscoveredTools?: (toolNames: string[]) => Promise<string[]>;
	/** The tool-choice queue used to force forthcoming tool invocations and carry invocation handlers. */
	getToolChoiceQueue?(): ToolChoiceQueue;
	/** Build a model-provider-specific ToolChoice that targets the named tool, or undefined if unsupported. */
	buildToolChoice?(toolName: string): ToolChoice | undefined;
	/** Steer a hidden custom message into the conversation (e.g. a preview reminder). */
	steer?(message: { customType: string; content: string; details?: unknown }): void;
	/** Peek the currently in-flight tool-choice queue directive's invocation handler. Used by the `resolve` tool to dispatch to the pending action. */
	peekQueueInvoker?(): ((input: unknown) => Promise<unknown> | unknown) | undefined;
	/** Peek the most-recently registered non-forcing pending preview invoker. The `resolve`
	 *  tool dispatches to it so a staged preview resolves WITHOUT forcing tool_choice — the
	 *  agent-loop's SoftToolRequirement lifecycle owns reminder injection and escalation. */
	peekPendingInvoker?(): ((input: unknown) => Promise<unknown> | unknown) | undefined;
	/** Clear stale pending preview markers when `resolve` cannot dispatch them. */
	clearPendingInvokers?(): void;
	/** Peek the long-lived "standing" resolve handler registered by a mode (e.g. plan mode).
	 *  Consulted by the `resolve` tool as a fallback when no queue invoker is in flight,
	 *  letting modes accept `resolve` invocations without forcing the tool choice every turn. */
	peekStandingResolveHandler?(): ((input: unknown) => Promise<unknown> | unknown) | undefined;
	/** Register or clear the standing resolve handler. Passing `null` clears it. */
	setStandingResolveHandler?(handler: ((input: unknown) => Promise<unknown> | unknown) | null): void;
	/** Get active checkpoint state if any. */
	getCheckpointState?: () => CheckpointState | undefined;
	/** Set or clear active checkpoint state. */
	setCheckpointState?: (state: CheckpointState | null) => void;
	/** Get the most recent completed rewind, if this session just rewound a checkpoint. */
	getLastCompletedRewind?: () => CompletedRewindState | undefined;

	/** Per-session snapshot store of file contents as last shown to the model
	 *  by `read`/`search`. Used by hashline anchor-stale recovery to
	 *  reconstruct the version the model authored anchors against when the
	 *  file changed out-of-band. Lazily initialized by `getFileSnapshotStore`. */
	fileSnapshotStore?: InMemorySnapshotStore;

	/** Per-session log of unresolved git merge conflict regions surfaced by
	 *  `read`. Each entry gets a stable id N referenced by `write conflict://N`
	 *  to splice the recorded region with replacement content. Lazily initialized
	 *  by `getConflictHistory`. */
	conflictHistory?: import("./conflict-detect").ConflictHistory;

	/** Per-session ledger of post-edit LSP diagnostics already surfaced to the
	 *  model for each file. Lazily initialized by `getDiagnosticsLedger`. */
	diagnosticsLedger?: import("../lsp/diagnostics-ledger").DiagnosticsLedger;

	/** Per-session ledger of consecutive byte-identical no-op edits, keyed by
	 *  canonical file path. The hashline executor escalates a soft no-op hint
	 *  to a thrown error once the same payload no-ops `NOOP_HARD_LIMIT` times,
	 *  breaking subagent loops that ignore the textual hint (issue #2081).
	 *  Lazily initialized by `getNoopLoopGuard`. */
	noopLoopGuard?: import("../edit/hashline/noop-loop-guard").NoopLoopGuard;

	/** Queue a hidden message to be injected at the next agent turn. */
	queueDeferredMessage?(message: CustomMessage): void;
	/** Queue late LSP diagnostics (arrived after an edit/write returned) to be shown
	 *  in the transcript and delivered to the model at the next yield, like background
	 *  job results. */
	queueDeferredDiagnostics?(entry: DeferredDiagnosticsEntry): void;
	/** Bump and return the session-global mutation counter for `path`. Edit/write
	 *  tools call this on every file mutation so stale late-diagnostics can be dropped. */
	bumpFileMutationVersion?(path: string): number;
	/** Read the current session-global mutation counter for `path` (0 if never mutated). */
	getFileMutationVersion?(path: string): number;
	/** Get the active OpenTelemetry config so subagent dispatch can forward
	 *  the parent's tracer/hooks with the subagent's own identity stamped. */
	getTelemetry?: () => AgentTelemetryConfig | undefined;
	/** Return image attachments visible to tools for resolving labels such as `Image #1`. */
	getImageAttachments?: () => ImageAttachmentEntry[];
}

export type ToolFactory = (session: ToolSession) => Tool | null | Promise<Tool | null>;

/**
 * Resolve the active essential built-in tool names from settings.
 *
 * Settings adapter for {@link resolveEssentialToolNames}; the rule lives in `./loading/policy`
 * with the rest of the tool-loading decisions. Kept at this name and signature because the SDK
 * and `test/tool-discovery/initial-tools.test.ts` both call it.
 */
export function computeEssentialBuiltinNames(settings: Settings): string[] {
	return resolveEssentialToolNames({
		override: settings.get("tools.essentialOverride"),
		isBuiltinName: name => name in BUILTIN_TOOLS,
	});
}

/**
 * Public callable factory map. External callers may invoke `BUILTIN_TOOLS.read(session)` or
 * `BUILTIN_TOOLS[name](session)` to construct a tool directly.
 */
export const BUILTIN_TOOLS: Record<BuiltinToolName, ToolFactory> = {
	read: async s => new (await import("./read")).ReadTool(s),
	bash: async s => new (await import("./bash")).BashTool(s),
	launch: async s => new (await import("./launch")).LaunchTool(s),
	edit: async s => new (await import("../edit")).EditTool(s),
	ast_grep: async s => new (await import("./ast-grep")).AstGrepTool(s),
	ast_edit: async s => new (await import("./ast-edit")).AstEditTool(s),
	ask: async s => (await import("./ask")).AskTool.createIf(s),
	debug: async s => (await import("./debug")).DebugTool.createIf(s),
	eval: async s => (await import("./eval")).EvalTool.create(s),
	ssh: async s => (await import("./ssh")).loadSshTool(s),
	github: async s => (await import("./gh")).GithubTool.createIf(s),
	glob: async s => new (await import("./glob")).GlobTool(s, { rootPathAlias: true }),
	grep: async s => new (await import("./grep")).GrepTool(s),
	lsp: async s => (await import("../lsp")).LspTool.createIf(s),
	inspect_image: async s => new (await import("./inspect-image")).InspectImageTool(s),
	browser: async s => new (await import("./browser")).BrowserTool(s),
	checkpoint: async s => (await import("./checkpoint")).CheckpointTool.createIf(s),
	rewind: async s => (await import("./checkpoint")).RewindTool.createIf(s),
	task: async s => (await import("../task")).TaskTool.create(s),
	job: async s => new (await import("./job")).JobTool(s),
	irc: async s => (await import("./irc")).IrcTool.createIf(s),
	todo: async s => new (await import("./todo")).TodoTool(s),
	web_search: async s => new (await import("../web/search")).WebSearchTool(s),
	search_tool_bm25: async s => (await import("./search-tool-bm25")).SearchToolBm25Tool.createIf(s),
	set_cwd: async s => new (await import("./set-cwd")).SetCwdTool(s),
	write: async s => new (await import("./write")).WriteTool(s),
	memory_edit: async s => (await import("./memory-edit")).MemoryEditTool.createIf(s),
	retain: async s => (await import("./memory-retain")).MemoryRetainTool.createIf(s),
	recall: async s => (await import("./memory-recall")).MemoryRecallTool.createIf(s),
	reflect: async s => (await import("./memory-reflect")).MemoryReflectTool.createIf(s),
	learn: async s => (await import("./learn")).LearnTool.createIf(s),
	manage_skill: async s => (await import("./manage-skill")).ManageSkillTool.createIf(s),
	// The two Argot folder tools exist only when the session holds a codec; with
	// the feature off, or for a subagent under `argot.subagents: off`, there is no
	// session to load into, so the factory returns null and the tool is absent.
	[ARGOT_LOAD_TOOL]: async s =>
		s.settings.get("argot.enabled") && s.getArgotSession?.() !== undefined
			? new (await import("./argot")).ArgotLoadTool(s)
			: null,
	[ARGOT_UNLOAD_TOOL]: async s =>
		s.settings.get("argot.enabled") && s.getArgotSession?.() !== undefined
			? new (await import("./argot")).ArgotUnloadTool(s)
			: null,
};

// Keyed by `HiddenToolName` rather than `string` for the same reason `BUILTIN_TOOLS` is keyed by
// `BuiltinToolName`: the registry is a declaration site, so the key set is what the compiler checks
// a rename against. Typed as `string` it accepted any key, and a hidden tool renamed in one place
// stayed registered under the old name with nothing to say so.
export const HIDDEN_TOOLS: Record<HiddenToolName, ToolFactory> = {
	yield: async s => new (await import("./yield")).YieldTool(s),
	report_finding: async () => (await import("./review")).reportFindingTool,
	report_tool_issue: async s => (await import("./report-tool-issue")).createReportToolIssueTool(s),
	resolve: async s => new (await import("./resolve")).ResolveTool(s),
	goal: async s => new (await import("../goals/tools/goal-tool")).GoalTool(s),
};

export type ToolName = BuiltinToolName;

/**
 * Create tools from BUILTIN_TOOLS registry.
 */
export async function createTools(session: ToolSession, toolNames?: string[]): Promise<Tool[]> {
	const includeYield = session.requireYieldTool === true;
	const enableLsp = session.enableLsp ?? true;
	const taskDepth = session.taskDepth ?? 0;
	const memoryBackend = session.settings.get("memory.backend") ?? "";
	const goalEnabled = session.settings.get("goal.enabled");
	const goalModeActive = goalEnabled && session.getGoalModeState?.()?.enabled === true;
	// An EXPLICIT whitelist gets widened with the tools its entries imply (see
	// `./loading/policy`). With no whitelist there is nothing to widen: the default path below
	// enumerates every built-in and filters it by permission instead.
	let requestedTools =
		toolNames && toolNames.length > 0
			? augmentRequestedToolNames(normalizeToolNames(toolNames), {
					goalModeActive,
					astGrepEnabled: session.settings.get("astGrep.enabled"),
					astEditEnabled: session.settings.get("astEdit.enabled"),
					memoryBackend,
					autolearnEnabled: session.settings.get("autolearn.enabled"),
					isTopLevelSession: taskDepth === 0,
				})
			: undefined;
	const backends = resolveEvalBackends(session);
	const allowPython = backends.python;
	const allowJs = backends.js;
	const allowRuby = backends.ruby;
	const allowJulia = backends.julia;
	const skipEvalPreflight = session.skipPythonPreflight === true;
	// Eval tool is enabled if ANY backend is reachable. JS needs no preflight, so
	// we only probe Python/Ruby/Julia when JS is disabled — otherwise allowEval is
	// already true and per-backend availability is checked at first invocation.
	let pythonAvailable = true;
	let rubyAvailable = true;
	let juliaAvailable = true;
	const evalRequested = requestedTools === undefined || requestedTools.includes(TOOL.eval);
	if (!skipEvalPreflight && !allowJs && evalRequested) {
		if (allowPython) {
			const { checkPythonKernelAvailability } = await import("../eval/py/kernel");
			const availability = await logger.time(
				"createTools:pythonCheck",
				checkPythonKernelAvailability,
				session.cwd,
				session.settings.get("python.interpreter")?.trim() || undefined,
			);
			pythonAvailable = availability.ok;
			if (!availability.ok) {
				logger.warn("Python kernel unavailable and JS backend disabled", { reason: availability.reason });
			}
		}
		if (allowRuby) {
			const { checkRubyKernelAvailability } = await import("../eval/rb/kernel");
			const availability = await checkRubyKernelAvailability(
				session.cwd,
				session.settings.get("ruby.interpreter")?.trim() || undefined,
			);
			rubyAvailable = availability.ok;
			if (!availability.ok) {
				logger.warn("Ruby kernel unavailable and JS backend disabled", { reason: availability.reason });
			}
		}
		if (allowJulia) {
			const { checkJuliaKernelAvailability } = await import("../eval/jl/kernel");
			const availability = await checkJuliaKernelAvailability(
				session.cwd,
				session.settings.get("julia.interpreter")?.trim() || undefined,
			);
			juliaAvailable = availability.ok;
			if (!availability.ok) {
				logger.warn("Julia kernel unavailable and JS backend disabled", { reason: availability.reason });
			}
		}
	}

	const allowEval = resolveEvalToolAvailability({
		pythonAllowed: allowPython,
		jsAllowed: allowJs,
		rubyAllowed: allowRuby,
		juliaAllowed: allowJulia,
		pythonAvailable,
		rubyAvailable,
		juliaAvailable,
	});
	// Resolve effective tool discovery mode.
	// tools.discoveryMode controls the new modes; mcp.discoveryMode remains a back-compat alias for "mcp-only".
	const effectiveDiscoveryMode = resolveEffectiveToolDiscoveryMode(
		session.settings,
		countToolsForAutoDiscovery(requestedTools ?? Object.keys(BUILTIN_TOOLS)),
	);
	const discoveryActive = effectiveDiscoveryMode !== "off";

	const allTools: Record<string, ToolFactory> = { ...BUILTIN_TOOLS, ...HIDDEN_TOOLS };
	// Every input the permission table reads, gathered once. The table itself is
	// `isBuiltinToolAllowed` in `./loading/policy` — this is the only place that turns
	// settings and session shape into its arguments.
	const permissionInputs: BuiltinToolPermissionInputs = {
		goalEnabled,
		goalModeActive,
		enableLsp,
		lspEnabled: session.settings.get("lsp.enabled"),
		bashEnabled: session.settings.get("bash.enabled"),
		launchEnabled: session.settings.get("launch.enabled"),
		evalAllowed: allowEval,
		debugEnabled: session.settings.get("debug.enabled"),
		requireYieldTool: includeYield,
		todoEnabled: session.settings.get("todo.enabled"),
		globEnabled: session.settings.get("glob.enabled"),
		grepEnabled: session.settings.get("grep.enabled"),
		githubEnabled: session.settings.get("github.enabled"),
		astGrepEnabled: session.settings.get("astGrep.enabled"),
		astEditEnabled: session.settings.get("astEdit.enabled"),
		inspectImageEnabled: session.settings.get("inspect_image.enabled"),
		webSearchEnabled: session.settings.get("web_search.enabled"),
		discoveryActive,
		askEnabled: session.settings.get("ask.enabled"),
		browserEnabled: session.settings.get("browser.enabled"),
		checkpointEnabled: session.settings.get("checkpoint.enabled"),
		ircEnabled: isIrcEnabled(session.settings, taskDepth, session.maxNestedSpawnDepth),
		memoryBackend,
		autolearnEnabled: session.settings.get("autolearn.enabled"),
		isTopLevelSession: taskDepth === 0,
		delegationEnabled: delegationEnabled(session.settings),
		canSpawnAtDepth: canSpawnAtDepth(
			resolveSessionMaxNestedSpawnDepth(session.settings, session.maxNestedSpawnDepth),
			taskDepth,
		),
	};
	const isToolAllowed = (name: string): boolean => isBuiltinToolAllowed(name, permissionInputs);
	// AFTER the discovery-mode count above, deliberately — see `withYieldToolAppended`.
	if (includeYield && requestedTools) {
		requestedTools = withYieldToolAppended(requestedTools);
	}

	const baseEntries = selectBaseToolNames({
		requestedToolNames: requestedTools,
		isKnownToolName: name => name in allTools,
		isAllowed: isToolAllowed,
		builtinToolNames: Object.keys(BUILTIN_TOOLS),
		requireYieldTool: includeYield,
		goalModeActive,
	}).map(name => [name, allTools[name]] as const);

	const activeToolNames = new Set(baseEntries.map(([name]) => name));
	if (session.setActiveToolNames) {
		session.setActiveToolNames(activeToolNames);
	} else {
		session.isToolActive = name => activeToolNames.has(name);
	}

	// One detector per session, so out-of-cwd activity is counted across the whole
	// session rather than per tool, and a subagent starts from zero.
	const rerootDetector = new RerootDetector();
	const wrap = (tool: Tool): Tool => wrapToolWithRerootHint(wrapToolWithMetaNotice(tool), rerootDetector, session);

	const baseResults = await Promise.all(
		baseEntries.map(async ([name, factory]) => {
			const tool = await logger.time(`createTools:${name}`, factory as ToolFactory, session);
			return tool ? wrap(tool) : null;
		}),
	);
	const tools = baseResults.filter((r): r is Tool => r !== null);
	if (!tools.some(tool => tool.name === TOOL.resolve)) {
		const resolveTool = await logger.time("createTools:resolve", HIDDEN_TOOLS.resolve, session);
		if (resolveTool) {
			tools.push(wrap(resolveTool));
		}
	}

	// Auto-inject report_tool_issue when autoqa is enabled (env or setting).
	// Injected unconditionally into every agent, regardless of requested tool list.
	const { createReportToolIssueTool, isAutoQaEnabled } = await import("./report-tool-issue");
	const autoQA = isAutoQaEnabled(session.settings);
	if (autoQA && !tools.some(t => t.name === TOOL.report_tool_issue)) {
		// Build the enum from tools we just constructed via BUILTIN_TOOLS / HIDDEN_TOOLS.
		// Extension overrides (e.g. a user's custom `bash`) get added later by
		// other code paths, so they're absent here — exactly what we want; MCP /
		// extension tools never end up in the report enum.
		const activeBuiltinNames = tools
			.map(t => t.name)
			.filter(name => (name in BUILTIN_TOOLS || name in HIDDEN_TOOLS) && name !== TOOL.report_tool_issue);
		const qaTool = createReportToolIssueTool(session, activeBuiltinNames);
		if (qaTool) {
			tools.push(wrap(qaTool));
		}
	}

	return tools;
}
