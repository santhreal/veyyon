/**
 * The public shape of a session: the event union every subscriber matches on, the
 * configuration a session is constructed from, and the option and result records
 * its callers pass and read.
 *
 * These are types and constants, so a caller that only needs to name a session
 * event or build a config imports this module instead of the session runtime.
 */

import type { Agent, AgentEvent, AgentMessage, AgentTool, StreamFn, ThinkingLevel } from "@veyyon/agent-core";
import type { CompactionResult } from "@veyyon/agent-core/compaction";
import type {
	AssistantRetryRecoveryKind,
	Context,
	ImageContent,
	Message,
	MessageAttribution,
	Model,
	ServiceTierByFamily,
	SimpleStreamOptions,
	ToolChoice,
} from "@veyyon/ai";
import type { SessionTelemetryDetail } from "@veyyon/ai/instrumentation";
import type { Effort } from "@veyyon/catalog/effort";
import type { OperatorNotices } from "@veyyon/kernel/session/operator-notices";
import type { SessionTitleSource } from "@veyyon/kernel/session/session-entries";
import type { postmortem } from "@veyyon/utils";
import type { ArgotSession } from "argot";
import type {
	AdviseTool,
	AdvisorConfig,
	AdvisorEmissionGuard,
	AdvisorRuntime,
	AdvisorTranscriptRecorder,
} from "../advisor";
import type { AsyncJob, AsyncJobDeliveryState, AsyncJobManager } from "../async";
import type { CompactionEngineAction } from "../config/compaction-strategy";
import type { EffortSource } from "../config/effort-resolver";
import type { ModelRegistry } from "../config/model-registry";
import type { PromptTemplate } from "../config/prompt-templates";
import type { Settings, SkillsSettings } from "../config/settings";
import type { RawSseDebugBuffer } from "../debug/raw-sse-buffer";
import type { Rule } from "../discovery/capability/rule";
import type { TtsrManager } from "../export/ttsr";
import type { LoadedCustomCommand } from "../extensibility/custom-commands";
import type { ExtensionRunner } from "../extensibility/extensions";
import type { ContextUsage } from "../extensibility/extensions/types";
import type { RecoveredRetryError } from "../extensibility/shared-events";
import type { Skill } from "../extensibility/skills";
import type { FileSlashCommand } from "../extensibility/slash-commands";
import type { Goal, GoalModeState } from "../goals/state";
import type { RetryRecoveryMode } from "../modes/retry-display";
import type { SecretObfuscator } from "../secrets/obfuscator";
import type { ConfiguredThinkingLevel } from "../thinking";
import type { TodoItem } from "../tools/agent/todo";
import type { CustomMessage } from "./messages";
import type { SessionManager } from "./session-manager";

/** Session-specific events that extend the core AgentEvent */
export type AgentSessionEvent =
	| AgentEvent
	| {
			type: "auto_compaction_start";
			reason: "threshold" | "overflow" | "idle" | "incomplete";
			action: CompactionEngineAction;
	  }
	| {
			type: "auto_compaction_end";
			action: CompactionEngineAction;
			result: CompactionResult | undefined;
			aborted: boolean;
			willRetry: boolean;
			errorMessage?: string;
			/** True when compaction was skipped for a benign reason (no model, no candidates, nothing to compact). */
			skipped?: boolean;
	  }
	| {
			type: "auto_retry_start";
			attempt: number;
			maxAttempts: number;
			delayMs: number;
			errorMessage: string;
			errorId?: number;
			/**
			 * Why this attempt budget applies, when it is not simply the global
			 * setting (e.g. `cursor provider default`). Shown to the user so a
			 * limit they never configured is explainable rather than mysterious.
			 */
			policySource?: string;
			/**
			 * Which recovery is waiting. Absent means a retry, which is what the
			 * retry ladder emits; `continue` is an unreplayable tool batch being
			 * carried forward instead of resent. Only the wording differs, but a
			 * countdown claiming a retry sits on the same screen as a notice saying
			 * the batch is being continued.
			 */
			mode?: RetryRecoveryMode;
	  }
	| {
			type: "auto_retry_end";
			success: boolean;
			attempt: number;
			finalError?: string;
			mode?: RetryRecoveryMode;
			recoveredErrors?: RecoveredRetryError[];
	  }
	| { type: "retry_fallback_applied"; from: string; to: string; role: string }
	| { type: "retry_fallback_succeeded"; model: string; role: string }
	| { type: "ttsr_triggered"; rules: Rule[] }
	| { type: "todo_reminder"; todos: TodoItem[]; attempt: number; maxAttempts: number }
	| { type: "todo_auto_clear" }
	| { type: "irc_message"; message: CustomMessage }
	| { type: "notice"; level: "info" | "warning" | "error"; message: string; source?: string }
	| {
			type: "thinking_level_changed";
			thinkingLevel: ThinkingLevel | undefined;
			/** The user-configured selector when it differs from the effective level (e.g. `auto`). */
			configured?: ConfiguredThinkingLevel;
			/** The level `auto` resolved to this turn, once classified. */
			resolved?: Effort;
	  }
	| { type: "goal_updated"; goal: Goal | null; state?: GoalModeState }
	| { type: "cwd_changed"; previous: string; cwd: string };

/** Listener function for agent session events */
export type AgentSessionEventListener = (event: AgentSessionEvent) => void;

export interface AgentSessionDisposeOptions {
	mnemopiConsolidateTimeoutMs?: number;
	/**
	 * Postmortem reason that triggered this dispose (signal/fatal teardown
	 * paths). When set, the persisted `session_exit` diagnostic records it
	 * instead of the generic `"dispose"` used for normal programmatic disposal
	 * (`/quit`, test teardown, subagent completion).
	 */
	reason?: postmortem.Reason;
}

export interface AgentSessionConfig {
	agent: Agent;
	sessionManager: SessionManager;
	settings: Settings;
	/** Whether the caller explicitly requested yolo/auto-approve behavior for this session. */
	autoApprove?: boolean;
	/**
	 * Start the session with the full permission bypass on (the
	 * `--dangerously-skip-permissions` launch flag). Stronger than `autoApprove`:
	 * removes every prompt including per-tool `prompt` overrides, but explicit
	 * `deny` and plan mode still block. Toggle at runtime with `/yolo`.
	 */
	bypassAllApprovals?: boolean;
	/**
	 * A subagent's live view of its parent's bypass. The child's own
	 * `bypassAllApprovals` is a snapshot taken at spawn, so without this a parent
	 * that revokes `/yolo` leaves an already-running child bypassing approvals to
	 * the end of its run. Consulted on every check and can only narrow.
	 */
	parentApprovalBypassed?: () => boolean;
	/** Models to cycle through with Ctrl+P (from --models flags). */
	scopedModels?: Array<{
		model: Model;
		thinkingLevel?: ConfiguredThinkingLevel;
		/** True only when this entry carried an explicit `:effort` suffix. */
		explicitThinkingLevel?: boolean;
	}>;
	/** Initial session thinking selector. */
	thinkingLevel?: ConfiguredThinkingLevel;
	/** Origin of the initial selector, used to distinguish a session override from a saved default. */
	thinkingSource?: EffortSource;
	/** Prewalk from the starting model to a fast/cheap target at the first edit/write once the todo list exists. */
	prewalk?: Prewalk;
	/** Force read-only plan mode at start, auto-approve on the model's first
	 *  `resolve` call, then switch to the target to implement. */
	planYolo?: PlanYolo;

	/** Initial per-family service tiers (OpenAI / Anthropic / Google) for the live session. */
	serviceTierByFamily?: ServiceTierByFamily;
	/** Prompt templates for expansion */
	promptTemplates?: PromptTemplate[];
	/** File-based slash commands for expansion */
	slashCommands?: FileSlashCommand[];
	/** Extension runner (created in main.ts with wrapped tools) */
	extensionRunner?: ExtensionRunner;
	/** Loaded skills (already discovered by SDK) */
	skills?: Skill[];
	/**
	 * Channel for non-fatal problems the operator must see.
	 *
	 * Replaces the old `skillWarnings` array, which was collected, threaded through here, and
	 * exposed as a getter that no production code read: skill-loading problems were discarded in
	 * silence while the field made it look as though somebody was showing them. Skill warnings now
	 * arrive here as notices with `source: "skills"`, alongside everything else that needs saying.
	 */
	operatorNotices?: OperatorNotices;
	/** Custom commands (TypeScript slash commands) */
	customCommands?: LoadedCustomCommand[];
	skillsSettings?: SkillsSettings;
	/** Model registry for API key resolution and model discovery */
	modelRegistry: ModelRegistry;
	/** Tool registry for LSP and settings */
	toolRegistry?: Map<string, AgentTool>;
	/** Creates the tools registered only while `/vibe` mode is active. */
	createVibeTools?: () => AgentTool[];
	/** Tool names whose current registry entry is still the built-in implementation. */
	builtInToolNames?: Iterable<string>;
	/** Update tool-session predicates that render guidance from the live active tool set. */
	setActiveToolNames?: (names: Iterable<string>) => void;
	/** Current session pre-LLM message transform pipeline */
	transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => AgentMessage[] | Promise<AgentMessage[]>;
	/**
	 * Per-request transform applied after `convertToLlm` and before the
	 * provider call. Used for secret obfuscation and image
	 * clamping. When supplied via {@link createAgentSession}, the advisor agent
	 * inherits this so its requests undergo the same shaping as the main turn.
	 */
	transformProviderContext?: (
		context: Context,
		model: Model,
		runtime?: SecretRuntimeLease,
	) => Context | Promise<Context>;
	/**
	 * Stream wrapper passed to side-channel requests (`/btw`, `/omfg`, IRC
	 * auto-replies, and handoff generation) so they apply the same provider
	 * shaping and host-level request wrappers as normal agent turns. Defaults
	 * to plain `streamSimple` when omitted.
	 */
	sideStreamFn?: StreamFn;
	/**
	 * Stream wrapper passed to the advisor agent so its requests apply the
	 * session's `providers.openrouterVariant`, `providers.antigravityEndpoint`,
	 * `providers.maxInFlightRequests`, and `model.loopGuard.*` settings —
	 * keeping OpenRouter sticky-routing / response caching consistent with the
	 * main agent. Defaults to plain `streamSimple` when omitted.
	 */
	advisorStreamFn?: StreamFn;
	/** Hint that OpenAI Codex requests should prefer websocket transport when supported. */
	preferWebsockets?: boolean;
	/** Provider payload hook used by the active session request path */
	onPayload?: SimpleStreamOptions["onPayload"];
	/** Provider response hook used by the active session request path */
	onResponse?: SimpleStreamOptions["onResponse"];
	/** Raw SSE hook used by the active session request path */
	onSseEvent?: SimpleStreamOptions["onSseEvent"];
	/** Per-session raw SSE diagnostic buffer */
	rawSseDebugBuffer?: RawSseDebugBuffer;
	/** Current session message-to-LLM conversion pipeline */
	convertToLlm?: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
	/** System prompt builder that can consider tool availability. Returns ordered provider-facing blocks. */
	rebuildSystemPrompt?: (toolNames: string[], tools: Map<string, AgentTool>) => Promise<{ systemPrompt: string[] }>;
	/** Local calendar date provider used by prompt-cache invalidation. Defaults to the host local date. */
	getLocalCalendarDate?: () => string;
	/** Rebuild the SSH tool from current capability discovery results. */
	reloadSshTool?: () => Promise<AgentTool | null>;
	requestedToolNames?: ReadonlySet<string>;
	/**
	 * Optional accessor for live MCP server instructions. Read by the session's
	 * `rebuildSystemPrompt`-skip optimization to detect server-side instruction
	 * changes (e.g. an MCP server upgrade) that would otherwise pass the tool-set
	 * signature comparison and silently keep a stale prompt cached.
	 */
	getMcpServerInstructions?: () => Map<string, string> | undefined;
	/** Enable hidden-by-default MCP tool discovery for this session. */
	mcpDiscoveryEnabled?: boolean;
	/** MCP tool names to activate for the current session when discovery mode is enabled. */
	initialSelectedMCPToolNames?: string[];
	/** Whether constructor-provided MCP defaults should be persisted immediately. */
	persistInitialMCPToolSelection?: boolean;
	/** MCP server names whose tools should seed discovery-mode sessions whenever those servers are connected. */
	defaultSelectedMCPServerNames?: string[];
	/** MCP tool names that should seed brand-new sessions created from this AgentSession. */
	defaultSelectedMCPToolNames?: string[];
	/** TTSR manager for time-traveling stream rules */
	ttsrManager?: TtsrManager;
	/** Secret obfuscator for deobfuscating streaming edit content */
	obfuscator?: SecretObfuscator;
	/** Initial immutable SDK runtime snapshot. Supersedes `obfuscator` when present. */
	secretRuntime?: SecretRuntimeLease;
	/** Await the latest winning runtime before admitting one provider request. */
	leaseSecretRuntime?: () => Promise<SecretRuntimeLease>;
	/** Recover the lease attached by the SDK to a provider context. */
	resolveSecretRuntimeLeaseForContext?: (context: Context) => SecretRuntimeLease | undefined;
	/**
	 * Reload and atomically replace the complete secret runtime for a cwd.
	 * The SDK owns config/env/vault loading; the session owns when lifecycle changes require it.
	 */
	refreshSecretRuntime?: (cwd: string) => Promise<SecretRuntimeLease | SecretObfuscator | undefined>;
	/** Argot shorthand codec (experimental); expands handles before display/tools. */
	argot?: ArgotSession;
	/** Inherited eval executor session id from a parent agent. */
	parentEvalSessionId?: string;
	/** Logical owner for retained eval kernels created by this session. */
	evalKernelOwnerId?: string;
	/**
	 * AsyncJobManager that this session installed as the process-global instance.
	 * Only set for top-level sessions; subagents inherit the parent's manager and
	 * **MUST NOT** dispose it on their own teardown.
	 */
	ownedAsyncJobManager?: AsyncJobManager;
	/**
	 * Whether this session was spawned by another session in the SAME process.
	 *
	 * Set from `isSubagentSession` in `sdk.ts`, which is the one owner of that
	 * question. It governs re-rooting: a subagent shares the process with its
	 * parent and its siblings, so moving its working directory must not move
	 * theirs. See {@link AgentSession.rescopeToCwd}. Default false, which is the
	 * safe reading for an embedder that builds a session directly: a session with
	 * nobody above it owns the process.
	 */
	isSubagent?: boolean;
	/**
	 * AsyncJobManager reachable by this session for scoped job actions.
	 *
	 * Top-level owners receive their own manager, subagents receive the inherited
	 * parent manager, and secondary in-process top-level sessions receive
	 * `undefined` so job snapshots and ACP drains cannot observe the primary's
	 * state.
	 */
	asyncJobManager?: AsyncJobManager;
	/** Agent identity (registry id like "Main" or "Alice") used for IRC routing. */
	agentId?: string;
	/** Whether this session is the top-level agent or a subagent. Drives eager-task
	 *  prelude gating so a top-level session created with a custom `agentId` still
	 *  receives the always-mode reminder. Defaults to "main". */
	agentKind?: "main" | "sub";
	/**
	 * Override the provider-facing session ID for all API requests from this session.
	 * When absent, `sessionManager.getSessionId()` is used. Needed when benchmark or
	 * SDK callers issue probes / prewarming with an explicit `--provider-session-id`
	 * so that credential sticky selection is consistent with the session's streaming calls.
	 */
	providerSessionId?: string;
	/** Marks `agent.promptCacheKey` as fork-inherited so incompatible route changes can clear it. */
	providerPromptCacheKeySource?: "explicit" | "fork";
	/**
	 * Full advisor toolset, pre-built in `createAgentSession` against a distinct,
	 * advisor-scoped `ToolSession` (its own `-advisor` session/agent id) so the
	 * advisor's tool state stays isolated from the primary. The advisor is a full
	 * agent; its config `tools` selects a subset (default read/search). Undefined
	 * when the advisor is disabled.
	 */
	advisorTools?: AgentTool[];
	/** Preloaded watchdog prompt content for the advisor. */
	advisorWatchdogPrompt?: string;
	/** Preloaded YAML top-level `instructions` shared baseline, kept separate from
	 *  `advisorWatchdogPrompt` so `/advisor configure` can swap it live. */
	advisorSharedInstructions?: string;
	/**
	 * Preloaded project context files (AGENTS.md, etc.) rendered as a system-prompt
	 * block for the advisor — the same standing instructions the primary agent
	 * receives, so the reviewer holds the agent to them.
	 */
	advisorContextPrompt?: string;
	/**
	 * Advisors discovered from `WATCHDOG.yml`. Empty/undefined runs a single
	 * legacy advisor on the `advisor` role (byte-for-byte the pre-config path).
	 */
	advisorConfigs?: AdvisorConfig[];
	/**
	 * Strip tool descriptions from provider-bound tool specs on side requests
	 * (handoff). A resolver follows the active model so session dumps and side
	 * requests use the same descriptor placement as the rebuilt system prompt.
	 */
	pruneToolDescriptions?: boolean | ((model: Model) => boolean);
	/**
	 * Disconnect this session's OWNED MCP manager on dispose. Provided only when
	 * the session created the manager (top-level sessions); subagents reuse a
	 * parent's manager via `options.mcpManager` and omit this so a child's
	 * teardown never tears down the shared servers.
	 */
	disconnectOwnedMcpManager?: () => Promise<void>;
	/**
	 * Override the bundled system prompt used by automatic session-title
	 * generation paths (initial title + replan refresh). Source-of-truth is
	 * `TITLE_SYSTEM.md` discovered via {@link discoverTitleSystemPromptFile} and
	 * resolved through {@link resolvePromptInput}; refresh after a `/move`-style
	 * cwd change via {@link AgentSession.setTitleSystemPrompt}.
	 */
	titleSystemPrompt?: string;
}

/** Options for AgentSession.prompt() */
export interface PromptOptions {
	/** Whether to expand file-based prompt templates (default: true) */
	expandPromptTemplates?: boolean;
	/** Image attachments */
	images?: ImageContent[];
	/** When streaming, how to queue the message: "steer" (interrupt) or "followUp" (wait). */
	streamingBehavior?: "steer" | "followUp";
	/** Optional tool choice override for the next LLM call. */
	toolChoice?: ToolChoice;
	/** Send as developer/system message instead of user. Providers that support it use the developer role; others fall back to user. */
	synthetic?: boolean;
	/** Marks this prompt as a deliberate user action (typed message, `.`/`c`
	 *  continue). Clears advisor auto-resume suppression that a user interrupt set.
	 *  Defaults to `!synthetic`; manual-continue is synthetic yet user-initiated, so
	 *  it sets this explicitly. Agent-initiated synthetic prompts (auto-continue,
	 *  plan re-prime, reminders) leave it unset and keep suppression latched. */
	userInitiated?: boolean;
	/** Explicit billing/initiator attribution for the prompt. Defaults to user prompts as `user` and synthetic prompts as `agent`. */
	attribution?: MessageAttribution;
	/** Skip pre-send compaction checks for this prompt (internal use for maintenance flows). */
	skipCompactionCheck?: boolean;
}

/** Options for AgentSession.followUp() */
export interface FollowUpOptions {
	/** Enqueue as a hidden developer message (agent-attributed by default) instead of a user follow-up. */
	synthetic?: boolean;
	/** Whether to expand file-based prompt templates (default: true). */
	expandPromptTemplates?: boolean;
	/** Explicit billing/initiator attribution. Defaults to `agent` for synthetic follow-ups. */
	attribution?: MessageAttribution;
}

/** Result from a handoff operation. */
export interface HandoffResult {
	document: string;
	savedPath?: string;
}

export interface SessionHandoffOptions {
	autoTriggered?: boolean;
	signal?: AbortSignal;
	onSwitchCancelled?: () => void;
}

/** Result from cycleModel() */
export interface ModelCycleResult {
	model: Model;
	thinkingLevel: ThinkingLevel | undefined;
	/** Whether cycling through scoped models (--models flag) or all available */
	isScoped: boolean;
}

/** Result from cycleRoleModels() */
export interface RoleModelCycleResult {
	model: Model;
	thinkingLevel: ThinkingLevel | undefined;
	role: string;
}

/** A configured role resolved to a concrete model, used by role cycling and
 *  the plan-approval model slider. */
export interface ResolvedRoleModel {
	role: string;
	model: Model;
	thinkingLevel?: ConfiguredThinkingLevel;
	explicitThinkingLevel: boolean;
}

/** The set of resolvable role models plus the index of the currently active
 *  one within {@link ResolvedRoleModel.role} order. */
export interface RoleModelCycle {
	models: ResolvedRoleModel[];
	currentIndex: number;
}

export interface ContextUsageBreakdown {
	contextWindow: number;
	anchored: boolean;
	usedTokens: number;
	systemPromptTokens: number;
	systemToolsTokens: number;
	systemContextTokens: number;
	skillsTokens: number;
	messagesTokens: number;
	pendingMessagesTokens: number;
}

/** Session statistics for /session command */
export interface SessionStats {
	sessionFile: string | undefined;
	sessionId: string;
	userMessages: number;
	assistantMessages: number;
	toolCalls: number;
	toolResults: number;
	totalMessages: number;
	tokens: {
		input: number;
		output: number;
		reasoning: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
	premiumRequests: number;
	cost: number;
	contextUsage?: ContextUsage;
}

/** Advisor statistics for /advisor status command. */
export interface AdvisorStats {
	configured: boolean;
	active: boolean;
	model?: Model;
	contextWindow: number;
	contextTokens: number;
	tokens: {
		input: number;
		output: number;
		reasoning: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
	cost: number;
	messages: {
		user: number;
		assistant: number;
		total: number;
	};
	/** Per-advisor breakdown; one entry per active advisor (single-advisor sessions have one). */
	advisors: PerAdvisorStat[];
}

/** One advisor's slice of {@link AdvisorStats}, surfaced for the multi-advisor status panel. */
export interface PerAdvisorStat {
	name: string;
	model: Model;
	contextWindow: number;
	contextTokens: number;
	tokens: AdvisorStats["tokens"];
	cost: number;
	messages: AdvisorStats["messages"];
}

/**
 * One live advisor instance: its own agent/runtime/tools/recorder plus a
 * per-advisor emission guard and identity. The session holds an array of these;
 * primary-scoped state (turn counters, interrupt latches, the shared yield
 * channel) stays on the session.
 */
export interface ActiveAdvisor {
	/** Display name from config ("default" for the legacy no-YAML advisor). */
	name: string;
	/** Slug for the transcript filename/session id; "" → `__advisor.jsonl`. */
	slug: string;
	agent: Agent;
	runtime: AdvisorRuntime;
	adviseTool: AdviseTool;
	emissionGuard: AdvisorEmissionGuard;
	recorder: AdvisorTranscriptRecorder;
	/** Latest recorder close, awaited by dispose() so the final turn lands on disk. */
	recorderClosed: Promise<void>;
	/** Unsubscribe for the advisor agent's event stream feeding the recorder. */
	agentUnsubscribe?: () => void;
	model: Model;
	thinkingLevel: ThinkingLevel;
	/** Stable key for the resolved runtime inputs that require a rebuild to change. */
	signature: string;
}

/** Resolved advisor config ready to instantiate as an {@link ActiveAdvisor}. */
export interface AdvisorRuntimeDescriptor {
	config: AdvisorConfig;
	name: string;
	slug: string;
	model: Model;
	thinkingLevel: ThinkingLevel;
	signature: string;
}

export interface ProjectAdvisorScope {
	advisorWatchdogPrompt?: string;
	advisorContextPrompt?: string;
	advisorSharedInstructions?: string;
	advisorConfigs?: AdvisorConfig[];
}

export interface FreshSessionResult {
	previousSessionId: string;
	sessionId: string;
	closedProviderSessions: number;
}

export interface AsyncJobSnapshot {
	running: AsyncJobSnapshotItem[];
	recent: AsyncJobSnapshotItem[];
	delivery: AsyncJobDeliveryState;
}

export type AsyncJobSnapshotItem = Pick<AsyncJob, "id" | "type" | "status" | "label" | "startTime">;

/** One finished background job queued for the async-result follow-up. */
export interface AsyncResultEntry {
	jobId: string;
	result: string;
	job: AsyncJob | undefined;
	durationMs: number | undefined;
}

/**
 * Prewalk: switches an active session one-way from its starting model to
 * a fast/cheap `target` at the first completed turn that runs an edit/write
 * tool once the todo list exists. A hidden plan nudge asks the starting
 * model to write a plan, initialize its todo list from it, and start; the
 * todo call opens the trigger gate (it never fires the switch itself), so
 * the starting model always begins the implementation. A hidden
 * checklist nudge asks the target model to verify its work before
 * finishing. Both are always on — this is the one mechanism that won out
 * over turn-count and ungated variants in testing.
 */
export interface Prewalk {
	target: Model;
	thinkingLevel?: ConfiguredThinkingLevel;
}

/**
 * PlanYolo: forces the session into read-only plan mode at start, then
 * auto-approves the plan the instant the model calls `resolve({ action:
 * "apply" })` for it — no interactive review — and switches to a fast/cheap
 * `target` model to implement it. The headless counterpart to interactive
 * plan mode's "Approve and execute", for print/non-interactive runs where
 * there is no one to click Approve.
 */
export interface PlanYolo {
	target: Model;
	thinkingLevel?: ConfiguredThinkingLevel;
}

/**
 * Immutable authority admitted for one provider request.
 *
 * Expansion and redaction intentionally travel together in one snapshot: a
 * later disable/re-scope may replace the session's live runtime, but it cannot
 * change what an already-admitted request uses after an async hook resumes.
 */
export interface SecretRuntimeLease {
	readonly revision: number;
	readonly cwd: string;
	/** Live expansion authority. Undefined when expansion is disabled. */
	readonly expansionObfuscator: SecretObfuscator | undefined;
	/**
	 * Redaction-only authority, which outlives expansion.
	 *
	 * This is a different object from `expansionObfuscator` and outlives it on
	 * purpose: a disable or a cwd move off the vault ends expansion while the
	 * redaction tombstones stay, so a value the model has already seen as a
	 * placeholder can never travel back to a provider as plaintext. Prefer the
	 * `obfuscate*` closures below; this object is exposed for the few consumers
	 * that hold a redactor themselves rather than calling through the lease.
	 */
	readonly redactionObfuscator: SecretObfuscator | undefined;
	/** True when the redaction-only authority still holds live values or tombstones. */
	readonly hasRedactions: boolean;
	obfuscateText(text: string): string;
	obfuscateMessages(messages: Message[]): Message[];
	obfuscateContext(context: Context): Context;
	obfuscatePayload(payload: unknown): unknown;
	/**
	 * Whether expansion may proceed against the captured vault revision, without
	 * side effects. True when nothing needs expanding, or when the captured
	 * revision is still current. Pass the payload for the payload-aware answer:
	 * text with no live placeholder is always fresh, because expanding it could
	 * not change a byte. NEVER throws and NEVER schedules work, so a render path
	 * can consult it and degrade.
	 */
	isFreshForExpansion(text?: string): boolean;
	/**
	 * Refresh a stale runtime and resolve once expansion may proceed.
	 *
	 * A stale captured revision is a cache miss, not a security event: the
	 * recovery is to re-read the vault, which is what this awaits. Resolves
	 * immediately when `text` carries no live placeholder or the revision is
	 * current. Rejects ONLY when a refresh was attempted, genuinely failed, and
	 * `text` carries a live placeholder.
	 */
	ensureFreshForExpansion(text?: string): Promise<void>;
	/**
	 * Synchronously assert that named expansion is still backed by the captured
	 * vault revision, for a SPEND: text about to be expanded and handed to a
	 * tool, a command, or the provider. Silent for any payload without a live
	 * placeholder. Prefer {@link SecretRuntimeLease.ensureFreshForExpansion}
	 * wherever an await is possible, and NEVER call this from a display or render
	 * path: an exception there unwinds the renderer instead of failing one
	 * operation.
	 */
	assertFreshForExpansion(text?: string): void;
}

export type CommandMetadataChangedListener = () => void | Promise<void>;

export interface PendingContextSnapshot {
	promptTokens: number;
	nonMessageTokens: number;
	/**
	 * How many messages existed BEFORE this turn: the index in `messages` where the turn begins.
	 *
	 * Not "how many messages this prompt accounts for". A turn submits messages that never join the
	 * conversation -- the session-state line carrying the date and directory, recalled memories --
	 * so a count of what was submitted overshoots the boundary by however many of those there were,
	 * and the anchor test below then rejects every provider count the turn produces.
	 */
	cutoffCount: number;
	/** The submitted messages, by identity: each is already inside `promptTokens`. */
	submitted: ReadonlySet<AgentMessage>;
	detail: SessionTelemetryDetail;
	storedMessagesTokens?: number;
	tailTokens?: number;
	compactionEntryId?: string;
}

export type MessageEndPersistenceSlot = {
	readonly promise: Promise<void>;
	persist: (persistMessage: () => void) => Promise<void>;
	release: () => void;
};

export type PendingRecoveredRetryError = {
	entryId: string;
	persistenceKey: string;
	recovery: AssistantRetryRecoveryKind;
	attempt: number;
	note: string;
};

export type PostPromptSkipReason = "aborted" | "stale-generation";

export type AgentContinueSkipReason =
	| PostPromptSkipReason
	| "session-unavailable"
	| "should-continue-false"
	| "post-restore-unavailable";

export type ScheduledAgentContinueOptions = {
	delayMs?: number;
	generation?: number;
	shouldContinue?: () => boolean;
	onSkip?: (reason: AgentContinueSkipReason) => void;
	onError?: () => void;
};

export type SessionNameTrigger = "replan";

export type SetSessionNameWithTrigger = (
	name: string,
	source?: SessionTitleSource,
	trigger?: SessionNameTrigger,
) => Promise<boolean>;

/**
 * Budget for callers on the user-visible `/quit` / `/exit` shutdown path that
 * want to cap how long they wait for `MnemopiSessionState.dispose()` to finish
 * its consolidate pass. Consolidate fires fresh LLM fact extractions, each a
 * 1–3 s round-trip, so interactive shutdown passes this budget to keep the
 * UI responsive. Callers that keep the process/session host alive must omit it
 * so dispose still awaits the full consolidate-then-close pipeline.
 */
export const SHUTDOWN_CONSOLIDATE_BUDGET_MS = 1_500;

/**
 * How long a headless `shutdown()` waits for `dispose()` to flush before it
 * exits anyway. Long enough for a session-log write, short enough that a wedged
 * teardown cannot strand the caller.
 */
export const SHUTDOWN_DISPOSE_TIMEOUT_MS = 5_000;

/**
 * Settings that change the SHAPE OF THE TOOLS the model is handed, rather than
 * any text in the system prompt.
 *
 * WHY THIS IS NOT A LIST OF PROMPT GATES. Which settings rewrite the prompt is
 * answered in one place, `system-prompt-builder/gate-registry.ts`, and the
 * listener below reads it through {@link isLivePromptGate}. This table used to
 * restate five of those rows and omit the other five, which is the same
 * two-lists-that-must-agree failure the registry exists to end: writing
 * `personality`, `tools.format`, `inlineToolDescriptors`, `includeModelInPrompt`,
 * `tui.renderMermaid` or `tools.intentTracing` from anything other than the
 * settings selector (a slash command, an SDK or ACP host, a plugin) changed the
 * configuration and left the prompt describing the previous one.
 *
 * These three are genuinely not prompt gates: they gate no template variable and
 * no runtime section, they decide the `task` tool's own description and schema
 * (`tools/task/index.ts` reads all three per rebuild), and nothing else notices
 * when one is written. A rebuild is how the model is told.
 */
export const TOOL_SHAPE_SETTING_PATHS: Readonly<Record<string, true>> = {
	"async.enabled": true,
	"subagent.isolation.mode": true,
	"subagent.maxNestedSpawnDepth": true,
};
