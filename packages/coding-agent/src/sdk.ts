import type { AgentMessage, AgentTelemetryConfig, AgentTool } from "@veyyon/agent-core";
import type { Model } from "@veyyon/ai";
import type { Component } from "@veyyon/tui";
import { $env, getAgentDir, getProjectDir, logger, postmortem, prompt } from "@veyyon/utils";
import type { AsyncJobType } from "./async";
import { type CapabilityResult, loadCapability } from "./capability";
import { type Rule, ruleCapability } from "./capability/rule";
import type { EffortSource } from "./config/effort-resolver";
import type { ModelRegistry } from "./config/model-registry";
import { loadPromptTemplates as loadPromptTemplatesInternal, type PromptTemplate } from "./config/prompt-templates";
import type { Settings, SkillsSettings } from "./config/settings";
import "./discovery";
import type { ArgotSession } from "argot/session";
import { disposeAllJuliaKernelSessions } from "./eval/jl/executor";
import { disposeAllVmContexts } from "./eval/js/context-manager";
import { disposeAllKernelSessions } from "./eval/py/executor";
import { disposeAllRubyKernelSessions } from "./eval/rb/executor";
import type { LoadedCustomCommand } from "./extensibility/custom-commands";
import type { ToolPathWithSource } from "./extensibility/custom-tools";
import type { CustomTool, CustomToolContext, CustomToolSessionEvent } from "./extensibility/custom-tools/types";
import {
	discoverExtensionPaths,
	type ExtensionContext,
	type ExtensionFactory,
	type ExtensionUIContext,
	type LoadExtensionsResult,
	loadExtensions,
	type ToolDefinition,
} from "./extensibility/extensions";
import { loadSkills as loadSkillsInternal, type Skill, type SkillWarning } from "./extensibility/skills";
import { type FileSlashCommand, loadSlashCommands as loadSlashCommandsInternal } from "./extensibility/slash-commands";
import type { HindsightSessionState } from "./hindsight/state";
import type { LocalProtocolOptions } from "./internal-urls";
import type { LspStartupServerInfo } from "./lsp";
import { type MCPLoadResult, type MCPManager, parseMCPToolName } from "./mcp";
import type { MnemopiSessionState } from "./mnemopi/state";
import { toolsPrompts } from "./prompts/tools/rows";
import type { AgentRegistry } from "./registry/agent-registry";
import { vaultKeyPath } from "./secrets/vault-crypto";
import type { AgentSession, AsyncResultEntry, PlanYolo, Prewalk } from "./session/agent-session";
import { discoverAuthStorage } from "./session/auth-broker-config";
import type { AuthStorage } from "./session/auth-storage";
import { type CustomMessage, LSP_LATE_DIAGNOSTIC_MESSAGE_TYPE } from "./session/messages";
import type { OperatorNotices } from "./session/operator-notices";
import type { SessionManager } from "./session/session-manager";
import { closeAllConnections } from "./ssh/connection-manager";
import { unmountAll } from "./ssh/sshfs-mount";
import {
	type BuildSystemPromptResult,
	buildSystemPrompt as buildSystemPromptInternal,
	buildSystemPromptToolMetadata,
	loadProjectContextFiles as loadContextFilesInternal,
} from "./system-prompt";
import type { ConfiguredThinkingLevel } from "./thinking";
import { isMCPToolName } from "./tool-discovery/tool-index";
import {
	BUILTIN_TOOLS,
	type ContextFileEntry,
	createTools,
	type DeferredDiagnosticsEntry,
	HIDDEN_TOOLS,
	type Tool,
	type ToolSession,
} from "./tools";
import { imageGenTool } from "./tools/image-gen";
import { EventBus } from "./utils/event-bus";
import type { WorkspaceTree } from "./workspace-tree";

export { createAgentSession } from "./sdk-helpers";

type AsyncResultJobDetails = {
	jobId: string;
	type?: AsyncJobType;
	label?: string;
	durationMs?: number;
};

type AsyncResultDetails = {
	jobs: AsyncResultJobDetails[];
};

export type McpNotificationEntry = {
	serverName: string;
	uri: string;
};

/**
 * The operator-facing text for a session that cannot initialize secret protection.
 *
 * Starting anyway was considered and rejected. Degrading to a no-secrets session
 * reads like the kind option, but it is fail-OPEN on a security control: without a
 * placeholder key there is no obfuscator, and the obfuscator is what REDACTS. Stored
 * secrets would merely be unavailable, which is survivable, but env-derived values
 * that this session would have redacted reach the model, the transcript and the
 * session file in the clear. The operator turned protection on deliberately; quietly
 * running without it is worse than not starting, because nothing on screen would say
 * the guarantee had lapsed.
 *
 * So the failure stays fatal and becomes a decision instead of a stack trace: it names
 * the key path, the causes worth checking, and the one command that starts veyyon
 * without protection if that is genuinely what the operator wants.
 */
export function secretProtectionUnavailableMessage(globalConfigRoot: string): string {
	return [
		`Secret protection is enabled but its key at ${vaultKeyPath(globalConfigRoot)} could not be initialized, so this session cannot redact or expand secrets.`,
		`Check that ${globalConfigRoot} is a real directory you own and can write to, that it is not a symlink and not on a read-only or exotic filesystem, then retry.`,
		"To start without secret protection instead, run: veyyon config set secrets.enabled false",
	].join("\n");
}

export function buildAsyncResultBatchMessage(entries: AsyncResultEntry[]): CustomMessage<AsyncResultDetails> | null {
	if (entries.length === 0) return null;
	const jobs = entries.map(entry => ({
		jobId: entry.jobId,
		result: entry.result,
		type: entry.job?.type,
		label: entry.job?.label,
		durationMs: entry.durationMs,
	}));
	const details: AsyncResultDetails = {
		jobs: jobs.map(job => ({
			jobId: job.jobId,
			type: job.type,
			label: job.label,
			durationMs: job.durationMs,
		})),
	};
	return {
		role: "custom",
		customType: "async-result",
		content: prompt.render(toolsPrompts["tools/async-result"].text, {
			multiple: jobs.length > 1,
			jobs,
		}),
		display: true,
		attribution: "agent",
		details,
		timestamp: Date.now(),
	};
}

type LateDiagnosticsDetails = {
	files: Array<{ path: string; summary: string; errored: boolean; messages: string[] }>;
};

export function buildLateDiagnosticsBatchMessage(
	entries: DeferredDiagnosticsEntry[],
): CustomMessage<LateDiagnosticsDetails> | null {
	if (entries.length === 0) return null;
	const files = entries.map(entry => ({
		path: entry.path,
		summary: entry.summary,
		messages: entry.messages,
		errored: entry.errored,
	}));
	const details: LateDiagnosticsDetails = {
		files: files.map(file => ({
			path: file.path,
			summary: file.summary,
			errored: file.errored,
			messages: file.messages,
		})),
	};
	return {
		role: "custom",
		customType: LSP_LATE_DIAGNOSTIC_MESSAGE_TYPE,
		content: prompt.render(toolsPrompts["tools/lsp-late-diagnostic"].text, {
			multiple: files.length > 1,
			files,
		}),
		display: true,
		attribution: "agent",
		details,
		timestamp: Date.now(),
	};
}

export function buildMcpNotificationBatchMessage(entries: McpNotificationEntry[]): AgentMessage | null {
	const resources: McpNotificationEntry[] = [];
	const seen = new Set<string>();
	for (const entry of entries) {
		const key = `${entry.serverName}\0${entry.uri}`;
		if (seen.has(key)) continue;
		seen.add(key);
		resources.push(entry);
	}
	if (resources.length === 0) return null;
	const lines = [`[MCP notification] ${resources.length} resource(s) updated:`];
	for (const resource of resources) {
		lines.push(`- server="${resource.serverName}" uri=${resource.uri}`);
	}
	lines.push('Use read(path="mcp://<uri>") to inspect if relevant.');
	return {
		role: "user",
		content: [{ type: "text", text: lines.join("\n") }],
		attribution: "agent",
		timestamp: Date.now(),
	};
}

export type DeferredMCPActivation = {
	mcpDiscoveryEnabled: boolean;
	explicitlyRequestedMCPToolNames: string[];
	activateAllMCPTools: boolean;
};

export function createPendingMCPTool(name: string): Tool {
	const parsed = parseMCPToolName(name);
	const serverName = parsed?.serverName;
	const mcpToolName = parsed?.toolName ?? name;
	const label = serverName ? `${serverName}/${mcpToolName}` : name;
	const message = serverName
		? `MCP server "${serverName}" is still connecting; tool "${name}" is not yet available. Retry after the MCP connection completes.`
		: `MCP discovery is still in progress; tool "${name}" is not yet available. Retry after MCP connection completes.`;
	const tool: Tool & { mcpServerName?: string; mcpToolName?: string } = {
		name,
		label,
		description: `Pending MCP tool. ${message}`,
		parameters: {
			type: "object",
			properties: {},
			additionalProperties: true,
		},
		approval: "write", // not-a-tool-name: approval tier
		intent: "omit",
		mcpServerName: serverName,
		mcpToolName,
		async execute() {
			return {
				content: [{ type: "text", text: message }],
				details: { serverName, mcpToolName, isError: true },
				isError: true,
			};
		},
	};
	return tool;
}

export function collectPendingMCPToolNames(
	explicitToolNames: readonly string[] | undefined,
	restoredSelectedToolNames: readonly string[],
): string[] {
	const names = new Set<string>();
	for (const name of explicitToolNames ?? []) {
		const normalized = name.toLowerCase();
		if (isMCPToolName(normalized)) names.add(normalized);
	}
	for (const name of restoredSelectedToolNames) {
		const normalized = name.toLowerCase();
		if (isMCPToolName(normalized)) names.add(normalized);
	}
	return [...names];
}

export function logMCPLoadErrors(errors: MCPLoadResult["errors"]): void {
	for (const [serverName, error] of errors) {
		logger.error("MCP tool load failed", { path: `mcp:${serverName}`, error });
	}
}

export function applyMCPEnvironment(result: { exaApiKeys: string[] }): void {
	if (result.exaApiKeys.length > 0 && !$env.EXA_API_KEY) {
		Bun.env.EXA_API_KEY = result.exaApiKeys[0];
	}
}

// Types
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

// `DialectFormat` and `resolveDialect` moved to `config/dialect-format.ts` so
// `system-prompt-builder/gate-inputs.ts` can ask the same question without importing this
// module, which imports it. Re-exported here because both are published from this entry point.
export { type DialectFormat, resolveDialect } from "./config/dialect-format";

// Re-exports

export type { PromptTemplate } from "./config/prompt-templates";
export { Settings, type SkillsSettings } from "./config/settings";
export type { CustomCommand, CustomCommandFactory } from "./extensibility/custom-commands/types";
export type { CustomTool, CustomToolFactory } from "./extensibility/custom-tools/types";
export type * from "./extensibility/extensions";
export type { Skill } from "./extensibility/skills";
export type { FileSlashCommand } from "./extensibility/slash-commands";
export type { MCPManager, MCPServerConfig, MCPServerConnection, MCPToolsLoadResult } from "./mcp";
export type { Tool } from "./tools";
export { buildDirectoryTree, buildWorkspaceTree, type DirectoryTree, type WorkspaceTree } from "./workspace-tree";

// Individual tool classes (BashTool, EditTool, ...) are re-exported from the
// library entry `src/index.ts` via their implementation modules — importing
// them here would eagerly parse every tool implementation on the CLI boot path.
export {
	// Tool factories and registry
	BUILTIN_TOOLS,
	createTools,
	HIDDEN_TOOLS,
	type ToolSession,
};

// Helper Functions

// Discovery Functions

/**
 * Create an AuthStorage instance.
 *
 * Default: local SQLite store at `<agentDir>/agent.db`.
 *
 * Broker mode: when `VEYYON_AUTH_BROKER_URL` is set, credentials are pulled from
 * a remote auth-broker over the wire. Refresh tokens never leave the broker;
 * the client receives access tokens with `refresh = "__remote__"` and calls
 * back into the broker through the {@link AuthStorageOptions.refreshOAuthCredential}
 * override to re-mint access tokens when needed.
 *
 * RE-EXPORTED, NOT REDEFINED. This was a wrapper that called the function below
 * and added nothing: `session/auth-broker-config` already defaults `agentDir` to
 * `getAgentDir()`, so the two were the same function under one name in two
 * places. Callers that only wanted credential discovery had to import this
 * module, which is the whole application, and one of them (`web/search`) sat in a
 * 49-module import cycle because of it. Anything inside the package should import
 * it from `./session/auth-broker-config`; this export exists because it is part
 * of the published SDK surface.
 */
export { discoverAuthStorage };

/**
 * Discover extensions from cwd.
 */
/**
 * Path-only counterpart of {@link loadSessionExtensions}: the FS-heavy scan
 * without the per-session module load. Subagents reuse the parent's path list
 * (cached on {@link ToolSession.extensionPaths}) and rebuild Extension
 * instances themselves so each session's `ExtensionAPI` (cwd, eventBus,
 * runtime) is its own.
 *
 * `agentDir` names the profile whose hooks and extension modules load. Omitting
 * it resolves the process-booted profile, which is only correct when the caller
 * genuinely has no session profile to speak of.
 */
export async function discoverSessionExtensionPaths(
	options: Pick<CreateAgentSessionOptions, "disableExtensionDiscovery" | "additionalExtensionPaths">,
	cwd: string,
	settings: Settings,
	agentDir?: string,
): Promise<string[]> {
	if (options.disableExtensionDiscovery) {
		return options.additionalExtensionPaths ?? [];
	}
	const configuredPaths = [...(options.additionalExtensionPaths ?? []), ...(settings.get("extensions") ?? [])];
	const disabledExtensionIds = settings.get("disabledExtensions") ?? [];
	return discoverExtensionPaths(configuredPaths, cwd, disabledExtensionIds, agentDir);
}

/**
 * Load the discovered/configured extensions for a session — everything {@link
 * createAgentSession} would load except the inline factory extensions it appends
 * itself. Extracted so the CLI can resolve extension-registered flags (and thus
 * classify `@file` arguments extension-aware) *before* a session — and its
 * terminal breadcrumb — is created, then hand the result back through
 * {@link CreateAgentSessionOptions.preloadedExtensions} so the work is not
 * repeated. Keep this the single source of the discovery branch logic.
 */
export async function loadSessionExtensions(
	options: Pick<CreateAgentSessionOptions, "disableExtensionDiscovery" | "additionalExtensionPaths">,
	cwd: string,
	settings: Settings,
	eventBus: EventBus,
	agentDir?: string,
	adoptSpawnedPid?: (pid: number) => void,
	gateSpawn?: (what: string) => Promise<void>,
): Promise<LoadExtensionsResult> {
	const paths = await discoverSessionExtensionPaths(options, cwd, settings, agentDir);
	const result = await logger.time(
		"loadExtensions",
		loadExtensions,
		paths,
		cwd,
		eventBus,
		adoptSpawnedPid,
		{
			agentDir,
			configuredPaths: [...(options.additionalExtensionPaths ?? []), ...(settings.get("extensions") ?? [])],
		},
		gateSpawn,
	);
	reportExtensionLoadFailures(result);
	return result;
}

/**
 * Say out loud that an extension the user asked for is not running.
 *
 * `logger.error` alone was the whole report, and the default transport set is
 * `{ file: true }` with no console transport — see the header of
 * `session/operator-notices.ts`, which names this exact channel as the one that
 * reaches nobody. So an extension with a syntax error, a bad import, or a
 * throwing factory was dropped, the session started clean, and the operator's
 * only symptom was that its tools, commands and flags were absent with no
 * explanation. Skill-loading failures three hundred lines below already go to
 * the operator channel; this is the same failure of the same kind and now
 * reports the same way.
 *
 * The file log keeps the record either way: raising a notice adds reach and
 * never removes it.
 */
export function reportExtensionLoadFailures(result: LoadExtensionsResult, operatorNotices?: OperatorNotices): void {
	for (const { path, error } of result.errors) {
		logger.error("Failed to load extension", { path, error });
		operatorNotices?.error("extensions", `${path}: ${error}`);
	}
	// Withheld is not a failure and must not read as one, but it MUST be seen: project code the
	// operator has not approved is silently absent otherwise, and "my repo's extension does
	// nothing" would be indistinguishable from a broken extension. A warning names the file and
	// what would make it run.
	for (const { path, reason } of result.withheld) {
		logger.warn("Withheld project extension", { path, reason });
		operatorNotices?.warn("extensions", reason);
	}
}

/**
 * Load discovered/configured extensions and register their providers into
 * `modelRegistry`, then discover the dynamic provider catalogs. One-shot CLIs
 * (`veyyon bench`, dry-balance) build a bare {@link ModelRegistry} that only knows
 * built-in catalog providers; without this, providers contributed by an
 * extension (e.g. a custom OpenAI-compatible provider under
 * `~/.veyyon/profiles/<name>/agent/extensions/`) never reach model resolution. Mirrors the
 * session / `veyyon models` path: drain the queued provider registrations, then
 * `refreshRuntimeProviders` so dynamically-discovered models exist before
 * selectors are resolved.
 */
export async function loadCliExtensionProviders(
	modelRegistry: ModelRegistry,
	settings: Settings,
	cwd: string,
	options: Pick<CreateAgentSessionOptions, "disableExtensionDiscovery" | "additionalExtensionPaths"> = {},
): Promise<void> {
	const eventBus = new EventBus();
	// No agent dir: a one-shot CLI has no session profile, so the process-booted
	// one is the right and only answer here. Stated because the same omission at
	// the session call site was the defect.
	const extensionsResult = await loadSessionExtensions(options, cwd, settings, eventBus);
	const activeSources = extensionsResult.extensions.map(extension => extension.path);
	modelRegistry.syncExtensionSources(activeSources);
	for (const sourceId of new Set(activeSources)) {
		modelRegistry.clearSourceRegistrations(sourceId);
	}
	for (const { name, config, sourceId } of extensionsResult.runtime.pendingProviderRegistrations) {
		modelRegistry.registerProvider(name, config, sourceId);
	}
	extensionsResult.runtime.pendingProviderRegistrations = [];
	await modelRegistry.refreshRuntimeProviders();
}

/**
 * Discover the skills for a session: the authored `<agentDir>/skills`, the
 * auto-learn `<agentDir>/managed-skills`, and any skills shipped by plugin packages
 * configured for the session.
 *
 * `agentDir` defaults to {@link getAgentDir} exactly the way
 * {@link discoverPromptTemplates} does, and it is FORWARDED. It used to be accepted
 * and dropped, which pinned the skill set to whichever profile the process booted
 * with: an agent rooted in another agent dir silently got a stranger's skills, or
 * none. Do not reintroduce that by widening the signature without threading the
 * value. {@link loadSkillsInternal} forwards it as `LoadOptions.agentDir`, which lands
 * on the `LoadContext` all three profile-rooted skill providers read.
 */
export async function discoverSkills(
	cwd?: string,
	agentDir?: string,
	settings?: SkillsSettings,
): Promise<{ skills: Skill[]; warnings: SkillWarning[] }> {
	return await loadSkillsInternal({
		...settings,
		cwd: cwd ?? getProjectDir(),
		agentDir: agentDir ?? getAgentDir(),
	});
}

/**
 * Discover the rules for a session: the profile's `<agentDir>/RULES.md` and
 * `<agentDir>/rules/`, the bundled defaults, and every foreign-config and plugin
 * rule source. All of them are user-scope: a repository's own `.veyyon/rules/`
 * was dropped as a source, because a cloned repo cannot be a standing
 * instruction on every request.
 *
 * `agentDir` defaults to {@link getAgentDir} and is FORWARDED, exactly like
 * {@link discoverSkills} and {@link discoverContextFiles}. Rules were the one
 * discovered layer with no wrapper: both session call sites reached
 * `loadCapability` directly with `{ cwd }` and no agent dir, so a session rooted
 * in another profile got that profile's instructions and skills alongside the
 * BOOTED profile's rules. This wrapper exists so the default lives in one place
 * and cannot be forgotten at a call site again.
 */
export async function discoverRules(cwd?: string, agentDir?: string): Promise<CapabilityResult<Rule>> {
	return await loadCapability<Rule>(ruleCapability.id, {
		cwd: cwd ?? getProjectDir(),
		agentDir: agentDir ?? getAgentDir(),
	});
}

/**
 * Discover the context files (AGENTS.md / CLAUDE.md) for a session.
 *
 * Resolves all three scopes, in resolution order global (`<config root>/AGENTS.md`)
 * → profile (`agentDir`'s own instruction file) → project (the walk up from `cwd`).
 * The array is returned in AUTHORITY order, least authoritative first so the
 * strongest file holds the last and highest-recency slot: project (farther from
 * cwd first) → profile → global, which is last and therefore wins. See
 * {@link loadProjectContextFilesWithWarnings} for why those two axes differ.
 *
 * `agentDir` defaults to {@link getAgentDir} exactly the way
 * {@link discoverPromptTemplates} does, and it is FORWARDED. It used to be
 * accepted and dropped, which silently pinned the profile scope to whichever
 * profile the process booted with: an agent rooted in another agent dir got
 * someone else's profile file, or none. Do not reintroduce that by widening the
 * signature without threading the value.
 */
export async function discoverContextFiles(cwd?: string, agentDir?: string): Promise<ContextFileEntry[]> {
	return await loadContextFilesInternal({
		cwd: cwd ?? getProjectDir(),
		agentDir: agentDir ?? getAgentDir(),
	});
}

/**
 * Discover prompt templates from cwd and agentDir.
 */
export async function discoverPromptTemplates(cwd?: string, agentDir?: string): Promise<PromptTemplate[]> {
	return await loadPromptTemplatesInternal({
		cwd: cwd ?? getProjectDir(),
		agentDir: agentDir ?? getAgentDir(),
	});
}

/**
 * Discover file-based slash commands from commands/ directories.
 *
 * `agentDir` defaults to {@link getAgentDir} exactly the way
 * {@link discoverPromptTemplates} does, and it is FORWARDED. Without it the
 * user scope came from whichever profile the process booted with, so a session
 * rooted in another agent dir got that profile's AGENTS.md, skills and prompt
 * templates but the booted profile's slash commands.
 */
export async function discoverSlashCommands(cwd?: string, agentDir?: string): Promise<FileSlashCommand[]> {
	return loadSlashCommandsInternal({ cwd: cwd ?? getProjectDir(), agentDir: agentDir ?? getAgentDir() });
}

/**
 * Discover custom commands (TypeScript slash commands) from cwd and agentDir.
 */
/**
 * Discover MCP servers from .mcp.json files.
 * Returns the manager and loaded tools.
 */
// API Key Helpers

// System Prompt

export interface BuildSystemPromptOptions {
	tools?: Tool[];
	skills?: Skill[];
	contextFiles?: Array<{ path: string; content: string }>;
	cwd?: string;
	agentDir?: string;
	customPrompt?: string;
	appendPrompt?: string;
	inlineToolDescriptors?: boolean;
	includeWorkspaceTree?: boolean;
}

/**
 * Build the default provider-facing system prompt blocks.
 *
 * The returned `systemPrompt` preserves the stable harness prompt and dynamic project context
 * as separate entries so providers can cache prompt prefixes without concatenating blocks.
 */
export async function buildSystemPrompt(options: BuildSystemPromptOptions = {}): Promise<BuildSystemPromptResult> {
	const toolMap = options.tools ? new Map(options.tools.map(tool => [tool.name, tool])) : undefined;
	return await buildSystemPromptInternal({
		cwd: options.cwd,
		agentDir: options.agentDir,
		customPrompt: options.customPrompt,
		skills: options.skills,
		contextFiles: options.contextFiles,
		appendSystemPrompt: options.appendPrompt,
		inlineToolDescriptors: options.inlineToolDescriptors,
		includeWorkspaceTree: options.includeWorkspaceTree,
		toolNames: options.tools?.map(tool => tool.name),
		tools: toolMap ? buildSystemPromptToolMetadata(toolMap) : undefined,
	});
}

// Internal Helpers

function createCustomToolContext(
	ctx: ExtensionContext,
	obfuscateProviderText?: (text: string) => string,
): CustomToolContext {
	return {
		sessionManager: ctx.sessionManager,
		modelRegistry: ctx.modelRegistry,
		model: ctx.model,
		isIdle: ctx.isIdle,
		hasQueuedMessages: ctx.hasPendingMessages,
		abort: ctx.abort,
		obfuscateProviderText: obfuscateProviderText ?? ctx.obfuscateProviderText,
		localProtocolOptions: ctx.localProtocolOptions,
	};
}

// The sdk's own marker is a symbol, so it cannot collide with a property a user put on their tool. The
// legacy shim's string twin is its own module's, since the shim STAMPS it and this only reads it.
import { LEGACY_TOOL_DEFINITION_MARKER } from "./extensibility/legacy-tool-marker";

const TOOL_DEFINITION_MARKER = Symbol("__isToolDefinition");

export function isCustomTool(tool: CustomTool | ToolDefinition): tool is CustomTool {
	// Converted tools carry a hidden marker: the sdk's symbol
	// (customToolToDefinition) or the legacy shim's string prop. Anything
	// unmarked is a CustomTool that still needs conversion — checking only one
	// marker would double-convert the other kind, scrambling execute()'s
	// argument order.
	const marked = tool as { [TOOL_DEFINITION_MARKER]?: true; [LEGACY_TOOL_DEFINITION_MARKER]?: true };
	return marked[TOOL_DEFINITION_MARKER] !== true && marked[LEGACY_TOOL_DEFINITION_MARKER] !== true;
}

export function isLegacyBuiltinToolDefinition(tool: CustomTool | ToolDefinition): boolean {
	return !isCustomTool(tool) && "__veyyonLegacyBuiltinTool" in tool && tool.__veyyonLegacyBuiltinTool === true;
}

/** Matches the truncation applied to per-server instructions inside `rebuildSystemPrompt`. */
export const MAX_MCP_INSTRUCTIONS_LENGTH = 4000;

let sshCleanupRegistered = false;

async function cleanupSshResources(): Promise<void> {
	const results = await Promise.allSettled([closeAllConnections(), unmountAll()]);
	for (const result of results) {
		if (result.status === "rejected") {
			logger.warn("SSH cleanup failed", { error: String(result.reason) });
		}
	}
}

export function registerSshCleanup(): void {
	if (sshCleanupRegistered) return;
	sshCleanupRegistered = true;
	postmortem.register("ssh-cleanup", cleanupSshResources);
}

let evalCleanupRegistered = false;

export function registerEvalCleanup(): void {
	if (evalCleanupRegistered) return;
	evalCleanupRegistered = true;
	postmortem.register("python-cleanup", disposeAllKernelSessions);
	postmortem.register("ruby-cleanup", disposeAllRubyKernelSessions);
	postmortem.register("julia-cleanup", disposeAllJuliaKernelSessions);
	// JS eval worker/subprocess: reap on hard process exit too, the same as the
	// kernels above, so it cannot outlive the process (GRAN-11).
	postmortem.register("js-eval-cleanup", disposeAllVmContexts);
}

export function customToolToDefinition(
	tool: CustomTool,
	obfuscateProviderText?: (text: string) => string,
): ToolDefinition {
	const definition: ToolDefinition & { [TOOL_DEFINITION_MARKER]: true } = {
		name: tool.name,
		label: tool.label,
		description: tool.description,
		parameters: tool.parameters,
		hidden: tool.hidden,
		deferrable: tool.deferrable,
		approval: typeof tool.approval === "function" ? tool.approval.bind(tool) : tool.approval,
		mcpServerName: tool.mcpServerName,
		mcpToolName: tool.mcpToolName,
		execute: (toolCallId, params, signal, onUpdate, ctx) =>
			tool.execute(toolCallId, params, onUpdate, createCustomToolContext(ctx, obfuscateProviderText), signal),
		onSession: tool.onSession
			? (event, ctx) => tool.onSession?.(event, createCustomToolContext(ctx, obfuscateProviderText))
			: undefined,
		renderCall: tool.renderCall,
		renderResult: tool.renderResult
			? (result, options, theme): Component => {
					const component = tool.renderResult?.(
						result,
						{ expanded: options.expanded, isPartial: options.isPartial, spinnerFrame: options.spinnerFrame },
						theme,
					);
					// Return empty component if undefined to match Component type requirement
					return component ?? ({ render: () => [] } as unknown as Component);
				}
			: undefined,
		[TOOL_DEFINITION_MARKER]: true,
	};
	if (tool === imageGenTool) {
		(definition as typeof definition & Pick<AgentTool, "loadMode">).loadMode = imageGenTool.loadMode;
	}
	return definition;
}

export function createCustomToolsExtension(
	tools: CustomTool[],
	obfuscateProviderText: (text: string) => string,
): ExtensionFactory {
	return api => {
		for (const tool of tools) {
			api.registerTool(customToolToDefinition(tool, obfuscateProviderText));
		}

		const runOnSession = async (event: CustomToolSessionEvent, ctx: ExtensionContext) => {
			for (const tool of tools) {
				if (!tool.onSession) continue;
				try {
					await tool.onSession(event, createCustomToolContext(ctx, obfuscateProviderText));
				} catch (err) {
					logger.warn("Custom tool onSession error", { tool: tool.name, error: String(err) });
				}
			}
		};

		api.on("session_start", async (_event, ctx) =>
			runOnSession({ reason: "start", previousSessionFile: undefined }, ctx),
		);
		api.on("session_switch", async (event, ctx) =>
			runOnSession({ reason: "switch", previousSessionFile: event.previousSessionFile }, ctx),
		);
		api.on("session_branch", async (event, ctx) =>
			runOnSession({ reason: "branch", previousSessionFile: event.previousSessionFile }, ctx),
		);
		api.on("session_tree", async (_event, ctx) =>
			runOnSession({ reason: "tree", previousSessionFile: undefined }, ctx),
		);
		api.on("session_shutdown", async (_event, ctx) =>
			runOnSession({ reason: "shutdown", previousSessionFile: undefined }, ctx),
		);
		api.on("auto_compaction_start", async (event, ctx) =>
			runOnSession({ reason: "auto_compaction_start", trigger: event.reason, action: event.action }, ctx),
		);
		api.on("auto_compaction_end", async (event, ctx) =>
			runOnSession(
				{
					reason: "auto_compaction_end",
					action: event.action,
					result: event.result,
					aborted: event.aborted,
					willRetry: event.willRetry,
					errorMessage: event.errorMessage,
				},
				ctx,
			),
		);
		api.on("auto_retry_start", async (event, ctx) =>
			runOnSession(
				{
					reason: "auto_retry_start",
					attempt: event.attempt,
					maxAttempts: event.maxAttempts,
					delayMs: event.delayMs,
					errorMessage: event.errorMessage,
					errorId: event.errorId,
					mode: event.mode,
				},
				ctx,
			),
		);
		api.on("auto_retry_end", async (event, ctx) =>
			runOnSession(
				{
					reason: "auto_retry_end",
					success: event.success,
					attempt: event.attempt,
					finalError: event.finalError,
					mode: event.mode,
					recoveredErrors: event.recoveredErrors,
				},
				ctx,
			),
		);
		api.on("ttsr_triggered", async (event, ctx) =>
			runOnSession({ reason: "ttsr_triggered", rules: event.rules }, ctx),
		);
		api.on("todo_reminder", async (event, ctx) =>
			runOnSession(
				{
					reason: "todo_reminder",
					todos: event.todos,
					attempt: event.attempt,
					maxAttempts: event.maxAttempts,
				},
				ctx,
			),
		);
	};
}

// Factory

/**
 * Build LoadedCustomCommand entries for all MCP prompts across connected servers.
 * These are re-created whenever prompts change (setOnPromptsChanged callback).
 */
export function buildMCPPromptCommands(manager: MCPManager): LoadedCustomCommand[] {
	const commands: LoadedCustomCommand[] = [];
	for (const serverName of manager.getConnectedServers()) {
		const prompts = manager.getServerPrompts(serverName);
		if (!prompts?.length) continue;
		for (const prompt of prompts) {
			const commandName = `${serverName}:${prompt.name}`;
			commands.push({
				path: `mcp:${commandName}`,
				resolvedPath: `mcp:${commandName}`,
				source: "bundled",
				command: {
					name: commandName,
					description: prompt.description ?? `MCP prompt from ${serverName}`,
					async execute(args: string[]) {
						const promptArgs: Record<string, string> = {};
						for (const arg of args) {
							const eqIdx = arg.indexOf("=");
							if (eqIdx > 0) {
								promptArgs[arg.slice(0, eqIdx)] = arg.slice(eqIdx + 1);
							}
						}
						const result = await manager.executePrompt(serverName, prompt.name, promptArgs);
						if (!result) return "";
						const parts: string[] = [];
						for (const msg of result.messages) {
							const contentItems = Array.isArray(msg.content) ? msg.content : [msg.content];
							for (const item of contentItems) {
								if (item.type === "text") {
									parts.push(item.text);
								} else if (item.type === "resource") {
									const resource = item.resource;
									if (resource.text) parts.push(resource.text);
								}
							}
						}
						return parts.join("\n\n");
					},
				},
			});
		}
	}
	return commands;
}
/**
 * Create an AgentSession with the specified options.
 *
 * @example
 * ```typescript
 * // Minimal - uses defaults
 * const { session } = await createAgentSession();
 *
 * // With explicit model
 * import { getBundledModel } from '@veyyon/catalog';
 * const { session } = await createAgentSession({
 *   model: getBundledModel('anthropic', 'claude-opus-4-5'),
 *   thinkingLevel: 'high',
 * });
 *
 * // Continue previous session
 * const { session, modelFallbackMessage } = await createAgentSession({
 *   continueSession: true,
 * });
 *
 * // Full control
 * const { session } = await createAgentSession({
 *   model: myModel,
 *   getApiKey: async () => Bun.env.MY_KEY,
 *   systemPrompt: ['You are helpful.'],
 *   tools: codingTools({ cwd: getProjectDir() }),
 *   skills: [],
 *   sessionManager: SessionManager.inMemory(),
 * });
 * ```
 */
