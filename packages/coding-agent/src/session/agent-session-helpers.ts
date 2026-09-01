/**
 * AgentSession - Core abstraction for agent lifecycle and session management.
 *
 * This class is shared between all run modes (interactive, print, rpc).
 * It encapsulates:
 * - Agent state access
 * - Event subscription with automatic session persistence
 * - Model and thinking level management
 * - Compaction (manual and auto)
 * - Bash execution
 * - Session switching and branching
 *
 * Modes use this class and add their own I/O layer on top.
 */

import type { Agent, AgentEvent, AgentMessage, AgentTool, StreamFn, ThinkingLevel } from "@veyyon/agent-core";
import { type CompactionResult, type SessionMessageEntry, stripLegacyArchive } from "@veyyon/agent-core/compaction";
import type {
	AssistantMessage,
	AssistantRetryRecoveryKind,
	CodexCompactionContext,
	Context,
	ImageContent,
	Message,
	MessageAttribution,
	Model,
	ServiceTierByFamily,
	SimpleStreamOptions,
	TextContent,
	ToolChoice,
} from "@veyyon/ai";
import type { SessionTelemetryDetail } from "@veyyon/ai/instrumentation";
import { deriveClaudeDeviceId } from "@veyyon/ai/providers/anthropic";
import type { Effort } from "@veyyon/catalog/effort";
import { Patch } from "@veyyon/hashline";
import { getInstallId, getStringProperty, isRecord, type postmortem } from "@veyyon/utils";
import type { ArgotSession } from "argot";
import type {
	AdviseTool,
	AdvisorConfig,
	AdvisorEmissionGuard,
	AdvisorRuntime,
	AdvisorTranscriptRecorder,
} from "../advisor";
import type { AsyncJob, AsyncJobDeliveryState, AsyncJobManager } from "../async";
import type { Rule } from "../capability/rule";
import type { CompactionEngineAction } from "../config/compaction-strategy";
import type { EffortSource } from "../config/effort-resolver";
import type { ModelRegistry } from "../config/model-registry";
import { formatModelSelectorValue, formatModelStringWithRouting, parseModelString } from "../config/model-resolver";
import type { PromptTemplate } from "../config/prompt-templates";
import type { Settings, SkillsSettings } from "../config/settings";
import type { RawSseDebugBuffer } from "../debug/raw-sse-buffer";
import { expandApplyPatchToEntries } from "../edit/modes/apply-patch";
import type { TtsrManager } from "../export/ttsr";
import type { LoadedCustomCommand } from "../extensibility/custom-commands";
import type { ExtensionRunner, ExtensionUIContext } from "../extensibility/extensions";
import type { ContextUsage } from "../extensibility/extensions/types";
import type { RecoveredRetryError } from "../extensibility/shared-events";
import type { Skill } from "../extensibility/skills";
import type { FileSlashCommand } from "../extensibility/slash-commands";
import type { Goal, GoalModeState } from "../goals/state";
import type { RetryRecoveryMode } from "../modes/retry-display";
import { theme } from "../modes/theme/theme-binding";
import { transformProviderPayload } from "../provider-boundary";
import type { SecretObfuscator } from "../secrets/obfuscator";
import { isLivePromptGate } from "../system-prompt-builder/gate-registry";
import { type ConfiguredThinkingLevel, concreteThinkingLevel } from "../thinking";
import type { TitleConversationTurn } from "../tiny/message-preproc";
import { TOOL } from "../tools/builtin-names";
import type { CompletedRewindState } from "../tools/checkpoint";
import { resolveToCwd } from "../tools/path-utils";
import type { TodoItem } from "../tools/todo";
import { AgentSession } from "./agent-session";
import type { AuthStorage } from "./auth-storage";
import type { ClientBridgePermissionOption } from "./client-bridge";
import { type ContentBlockLike, contentText } from "./content-text";
import { type CustomMessage, readQueueChipText } from "./messages";
import type { OperatorNotices } from "./operator-notices";
import type { SessionEntry, SessionTitleSource } from "./session-entries";
import type { SessionManager } from "./session-manager";
import type { ShakeMode, ShakeResult } from "./shake-types";

export const SESSION_STOP_CONTINUATION_CAP = 8;
export const PLAN_MODE_REMINDER_MAX = 3;
export const PLAN_DECISION_TOOLS = new Set<string>([TOOL.ask, TOOL.resolve]);

/**
 * Mutating tool results (`bash`/`eval`/`edit`/`write`/`ast_edit`) without the
 * agent touching the `todo` tool that trip the mid-run reconciliation nudge.
 * Read-only exploration (grep/read/glob/lsp) never ticks this: an agent
 * researching for a long stretch has nothing to flip. Picked so a normal
 * fix-verify loop (~3-6 mutations) never sees the nudge, but a sustained run
 * of landed work without flipping any todos does. Without this nudge, long
 * runs drive the live todo HUD to `0/N` until the final stop, then batch-flip
 * to `N/N` (issue #3651).
 */
export const MID_RUN_TODO_NUDGE_MUTATION_THRESHOLD = 12;
/** Mid-run nudges per prompt cycle. Deliberately tighter than
 *  `todo.reminders.max` (the stop-time budget): this is a gentle hidden hint,
 *  not an escalation ladder. */
export const MID_RUN_TODO_NUDGE_MAX_PER_CYCLE = 2;
/** Tool results that count as landed work for the mid-run todo nudge. */
export const MID_RUN_TODO_NUDGE_MUTATING_TOOLS: Record<string, true> = {
	bash: true,
	eval: true,
	edit: true,
	write: true,
	ast_edit: true,
};

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

/** `customType` for the hidden mid-run todo nudge; `display: false`, so it reaches
 *  the model but never renders in the TUI or transcript. */
export const MID_RUN_TODO_NUDGE_MESSAGE_TYPE = "mid-run-todo-nudge";
/**
 * Custom-message type carrying the memory backend's volatile context (recalled
 * memories, mental models) at the TAIL of the conversation.
 *
 * It used to ride in the system prompt, which is the provider's cache prefix, so
 * every recall and every mental-model reload made the next request re-read the
 * whole conversation as uncached input. Same information, same place in the
 * model's reading order, no prefix invalidation.
 */
export const MEMORY_CONTEXT_MESSAGE_TYPE = "memory-context";
/**
 * Custom-message type carrying the two facts that describe NOW rather than the
 * project: the calendar date and the working directory.
 *
 * They used to be one sentence inside the project block of the system prompt,
 * which is the provider's cache prefix, and the working directory is the one
 * thing in that prefix a session routinely changes. Measured on this repository,
 * a re-root from the root to `packages/utils` altered exactly one line of a
 * 92,921-character prompt — that sentence — and threw away the cached prefix for
 * the entire conversation behind it. Across 19 local log files, 210 of 232
 * recorded prefix invalidations were a `cwd-change`, averaging about 85,000
 * characters re-read each time for a path that had moved a directory down.
 *
 * The rebuild on re-root stays: the rules, skills and workspace tree really are
 * cwd-derived and a cross-project move must change them. What changes is that a
 * move which alters nothing but the path now rebuilds to BYTE-IDENTICAL bytes, so
 * there is no invalidation to record.
 */
export const SESSION_STATE_MESSAGE_TYPE = "session-state";
/** Hidden plan nudge injected by prewalk; scrubbed from the LLM context
 *  when the switch happens. */
export const PREWALK_PLAN_MESSAGE_TYPE = "prewalk-plan";
/** Hidden safety-net nudge forcing one more turn after a text-only reply to
 *  the plan nudge, which would otherwise end the run with no code written. */
export const PREWALK_CONTINUE_MESSAGE_TYPE = "prewalk-continue";
/** Hidden "verify before finishing" checklist steered into the run at the
 *  switch, aimed at the fast model's specific failure patterns: partial
 *  multi-site fixes, unnecessarily broad rewrites, and reported-test-only
 *  verification. */
export const PREWALK_CHECKLIST_MESSAGE_TYPE = "prewalk-checklist";
/** Tools whose first successful call triggers the switch — once the todo
 *  gate is open (see {@link AgentSession.#prewalkTodoSeen}). Bash is
 *  deliberately excluded: it doubles as exploration (ls/cat) and fired
 *  turn-1 switches in practice. `todo` is deliberately NOT a trigger: firing
 *  at the todo init handed the fast model 100% of the implementation with
 *  zero started work and measurably regressed pass rates. */
export const PREWALK_ACTION_TOOLS: Record<string, true> = {
	edit: true,
	write: true,
};
/** `customType` for the hidden hand-off message steered to the target model
 *  once PlanYolo auto-approves the plan. Unlike prewalk's plan nudge this
 *  is never scrubbed — it IS the instruction the target model acts on. */
export const PLAN_YOLO_HANDOFF_MESSAGE_TYPE = "plan-yolo-handoff";
/** Abort reason for the Gemini reasoning-header runaway interrupt. Surfaced on the
 *  discarded assistant turn only; never reaches the model. */
export const GEMINI_HEADER_INTERRUPT_REASON = "Interrupted: emit a tool call instead of more planning";
/** `customType` for the hidden tool-call reminder injected after the interrupt. */
export const GEMINI_TOOL_REMINDER_TYPE = "gemini-tool-call-reminder";
/** `customType` for the hidden redirect notice injected into a turn retried after a
 *  thinking/response loop. Steers the model off the repeated content; never displayed. */
export const THINKING_LOOP_REDIRECT_TYPE = "thinking-loop-redirect";
export const TOOL_CALL_LOOP_REDIRECT_TYPE = "tool-call-loop-redirect";

function customMessageContentText(content: string | (TextContent | ImageContent)[]): string {
	if (typeof content === "string") return content;
	const parts: string[] = [];
	for (const part of content) {
		if (part.type === "text") parts.push(part.text);
	}
	return parts.join("\n");
}

function stringProperty(value: object, key: string): string | undefined {
	const field = Object.getOwnPropertyDescriptor(value, key)?.value;
	return typeof field === "string" ? field : undefined;
}

function reportFromRewindReportContent(content: string): string {
	const marker = "\nReport:\n";
	const index = content.lastIndexOf(marker);
	const report = index >= 0 ? content.slice(index + marker.length) : content;
	return report.trim();
}

export function completedRewindFromEntry(entry: SessionEntry): CompletedRewindState | undefined {
	if (entry.type !== "custom_message" || entry.customType !== "rewind-report") return undefined;
	const details = entry.details;
	if (!details || typeof details !== "object") return undefined;
	const startedAt = stringProperty(details, "startedAt");
	const rewoundAt = stringProperty(details, "rewoundAt");
	if (!startedAt || !rewoundAt) return undefined;
	const report =
		stringProperty(details, "report")?.trim() ||
		reportFromRewindReportContent(customMessageContentText(entry.content));
	return report.length > 0 ? { report, startedAt, rewoundAt } : undefined;
}

export function isSuccessfulCheckpointEntry(entry: SessionEntry): entry is SessionMessageEntry & {
	message: { role: "toolResult"; toolName: "checkpoint"; isError?: false };
} {
	return (
		entry.type === "message" &&
		entry.message.role === "toolResult" &&
		entry.message.toolName === TOOL.checkpoint &&
		entry.message.isError !== true
	);
}

export function checkpointStartedAtFromEntry(entry: SessionEntry): string | undefined {
	if (!isSuccessfulCheckpointEntry(entry)) return undefined;
	const details = entry.message.details;
	if (details && typeof details === "object") {
		const startedAt = stringProperty(details, "startedAt");
		if (startedAt) return startedAt;
	}
	return entry.timestamp;
}

// A side-channel assistant response is signed for the hidden prompt/history that
// produced it. If we persist that response under a different user turn, native
// replay anchors become invalid; keep only visible, non-cryptographic content.
export function sanitizeAssistantForReparentedHistory(message: AssistantMessage): AssistantMessage {
	const content: AssistantMessage["content"] = [];
	for (const block of message.content) {
		if (block.type === "redactedThinking") continue;
		if (block.type === "thinking") {
			content.push({ type: "thinking", thinking: block.thinking });
			continue;
		}
		content.push(block);
	}
	return { ...message, content, providerPayload: undefined };
}

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

export const UNEXPECTED_STOP_MAX_RETRIES = 3;
export const UNEXPECTED_STOP_TIMEOUT_MS = 4000;
export const EMPTY_STOP_MAX_RETRIES = 3;
/**
 * Budget for callers on the user-visible `/quit` / `/exit` shutdown path that
 * want to cap how long they wait for `MnemopiSessionState.dispose()` to finish
 * its consolidate pass. Consolidate fires fresh LLM fact extractions, each a
 * 1–3 s round-trip, so interactive shutdown passes this budget to keep the
 * UI responsive. Callers that keep the process/session host alive must omit it
 * so dispose still awaits the full consolidate-then-close pipeline.
 */
export const SHUTDOWN_CONSOLIDATE_BUDGET_MS = 1_500;

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

export type CompactionCheckResult = Readonly<{
	continuationScheduled: boolean;
	automaticContinuationBlocked?: boolean;
	historyRewritten?: boolean;
}>;

export const COMPACTION_CHECK_NONE: CompactionCheckResult = {
	continuationScheduled: false,
};
export const COMPACTION_CHECK_CONTINUATION: CompactionCheckResult = {
	continuationScheduled: true,
};
export const COMPACTION_CHECK_BLOCK_AUTOMATIC_CONTINUATION: CompactionCheckResult = {
	continuationScheduled: false,
	automaticContinuationBlocked: true,
};

/**
 * User-facing notice for a compaction dead end: maintenance freed too little
 * to retry safely. `remedies` names the recovery actions left on the emitting
 * path — by the time the post-pass dead end fires, the tiered rescue has
 * already attempted both elide and image-drop automatically.
 */
export function compactionDeadEndWarning(remedies: string): string {
	return (
		"Compaction freed too little context to make progress — pausing automatic maintenance to avoid a compaction loop. " +
		`The most recent turn alone is too large to reduce further; ${remedies} or switch to a larger-context model.`
	);
}

/**
 * Context window compaction may price itself against, or undefined when the
 * model declares none.
 *
 * `Model.contextWindow` is nullable, and null there is a statement: this model
 * never told us how much it holds. Compaction caps its recent-history budget
 * against that window so it cannot ask to keep more conversation than the
 * prompt is allowed to carry, and there is nothing to cap against here.
 * Substituting a default would clamp against a number nobody stated, so the
 * cap is skipped and the configured budget stands, which is the behaviour
 * every session had before the cap existed.
 */
export function declaredContextWindow(model: Model | undefined): number | undefined {
	const contextWindow = model?.contextWindow;
	return typeof contextWindow === "number" && contextWindow > 0 ? contextWindow : undefined;
}

export function createCodexCompactionContext(options: {
	trigger: CodexCompactionContext["trigger"];
	reason: CodexCompactionContext["reason"];
	phase: CodexCompactionContext["phase"];
}): CodexCompactionContext {
	return {
		operationId: crypto.randomUUID(),
		trigger: options.trigger,
		reason: options.reason,
		phase: options.phase,
		strategy: "memento",
	};
}

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

/** Whether writing `path` must rebuild the prompt the model is holding. */
export function rebuildsThePrompt(path: string): boolean {
	return isLivePromptGate(path) || TOOL_SHAPE_SETTING_PATHS[path] === true;
}

/**
 * Per-turn prune cache window. A tool result whose all-message suffix exceeds
 * this is in the warm, already-sent prompt-cache prefix: re-writing it costs the
 * cacheWrite premium on the whole suffix. Per-turn passes only reclaim inside
 * this tail (matches the supersede pass's default `suffixTokenLimit`); deeper
 * stale/age victims are left to compaction/shake, which rebuild the cache anyway.
 */
export const PRUNE_CACHE_WARM_SUFFIX_TOKENS = 8_000;

/**
 * Idle gap after which the supersede pass may flush the whole sent region (the
 * provider cache is cold, so re-writing it is free). MUST exceed the maximum
 * Anthropic prompt-cache TTL: "long" retention (the OAuth default) is 1h, or a
 * still-warm prefix is busted by the flush. 90 min leaves margin over the 1h TTL.
 */
export const PRUNE_IDLE_FLUSH_MS = 90 * 60_000;
/**
 * How long a headless `shutdown()` waits for `dispose()` to flush before it
 * exits anyway. Long enough for a session-log write, short enough that a wedged
 * teardown cannot strand the caller.
 */
export const SHUTDOWN_DISPOSE_TIMEOUT_MS = 5_000;
export type CommandMetadataChangedListener = () => void | Promise<void>;
export type AsyncJobSnapshotItem = Pick<AsyncJob, "id" | "type" | "status" | "label" | "startTime">;

/**
 * Hysteresis band for the post-maintenance "did we actually create headroom?"
 * check shared by the shake tail and the context-full tail. A
 * pass counts as having resolved threshold pressure only when residual context
 * lands at or below `COMPACTION_RECOVERY_BAND × threshold`. Re-checking against
 * the raw threshold lets a pass keep reclaiming a trickle of the previous
 * turn's output and land just under the line every turn, sustaining the
 * auto-continue dead loop reported in #2275; the same band stops the
 * context-full tail from re-firing on a history whose single
 * most-recent kept turn already exceeds the threshold (the compaction thrash).
 */
export const COMPACTION_RECOVERY_BAND = 0.8;

/**
 * Slack added past a sibling credential's block expiry before retrying, so
 * the next getApiKey lands after the block has actually lapsed.
 */
export const SIBLING_UNBLOCK_BUFFER_MS = 1_000;
export const NON_WHITESPACE_RE = /\S/;

export function hasNonWhitespace(value: string): boolean {
	return NON_WHITESPACE_RE.test(value);
}

export interface AsyncJobSnapshot {
	running: AsyncJobSnapshotItem[];
	recent: AsyncJobSnapshotItem[];
	delivery: AsyncJobDeliveryState;
}

/** One finished background job queued for the async-result follow-up. */
export interface AsyncResultEntry {
	jobId: string;
	result: string;
	job: AsyncJob | undefined;
	durationMs: number | undefined;
}

export type { ShakeMode, ShakeResult };
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

// ============================================================================
// Types
// ============================================================================

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

export interface ProjectAdvisorScope {
	advisorWatchdogPrompt?: string;
	advisorContextPrompt?: string;
	advisorSharedInstructions?: string;
	advisorConfigs?: AdvisorConfig[];
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
	 * agent; its config `tools` selects a subset (default read/grep/glob). Undefined
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

export interface FreshSessionResult {
	previousSessionId: string;
	sessionId: string;
	closedProviderSessions: number;
}

/** Internal marker for hook messages queued through the agent loop */
// ============================================================================
// Constants
// ============================================================================

/** Standard thinking levels */

/** `retry.fallbackChains` config: chain key (role name or model selector) → ordered fallback selectors. */
export type RetryFallbackChains = Record<string, string[]>;

export type RetryFallbackRevertPolicy = "never" | "cooldown-expiry";

export interface RetryFallbackSelector {
	raw: string;
	provider: string;
	id: string;
	thinkingLevel: ThinkingLevel | undefined;
}

export interface ActiveRetryFallbackState {
	/** Chain key that produced this fallback: a model-role name or a model-selector key. */
	role: string;
	originalSelector: string;
	originalThinkingLevel: ConfiguredThinkingLevel | undefined;
	lastAppliedFallbackThinkingLevel: ConfiguredThinkingLevel | undefined;
	pinned: boolean;
}

export function parseRetryFallbackSelector(
	selector: string,
	modelLookup?: { find(provider: string, id: string): Model | undefined },
): RetryFallbackSelector | undefined {
	const trimmed = selector.trim();
	if (!trimmed) return undefined;
	const parsed = parseModelString(trimmed, {
		allowMaxSuffix: true,
		allowAutoAlias: true,
		isLiteralModelId: (provider, id) => modelLookup?.find(provider, id) !== undefined,
	});
	if (!parsed) return undefined;
	return {
		raw: trimmed,
		provider: parsed.provider,
		id: parsed.id,
		thinkingLevel: concreteThinkingLevel(parsed.thinkingLevel),
	};
}

/**
 * `retry.fallbackChains` keys are either model-role names (`smol`, `default`)
 * or model selectors (`provider/model-id[:thinking]`). Role names never
 * contain a slash, so its presence marks a model-keyed chain whose primary is
 * the key itself — the chain follows the model across role reassignments.
 */
export function isRetryFallbackModelKey(key: string): boolean {
	return key.includes("/");
}

/**
 * A `provider/*` fallback-chain key: matches any active model of that provider,
 * so one entry covers every current and future model behind the provider.
 */
export function isRetryFallbackWildcardKey(key: string): boolean {
	return key.endsWith("/*");
}

export function formatRetryFallbackSelector(model: Model, thinkingLevel: ThinkingLevel | undefined): string {
	return formatModelSelectorValue(formatModelStringWithRouting(model), thinkingLevel);
}

export function formatRetryFallbackBaseSelector(selector: RetryFallbackSelector): string {
	return `${selector.provider}/${selector.id}`;
}

export const EPHEMERAL_REPLY_MAX_BYTES = 4096;

/**
 * Collapse degenerate ephemeral replies (/btw, /omfg side-channel turns).
 * Models occasionally loop on a single line (~16 reports of N-times-repeated
 * replies); compress runs longer than 3 down to one instance + `[…N×]`, then
 * cap at 4 KiB so a runaway reply can't flood the channel.
 */
export function dedupeEphemeralReply(text: string): string {
	if (!text) return text;
	const lines = text.split("\n");
	const out: string[] = [];
	let i = 0;
	while (i < lines.length) {
		let j = i + 1;
		while (j < lines.length && lines[j] === lines[i]) j++;
		const runLen = j - i;
		if (runLen > 3) {
			out.push(lines[i], `[…${runLen}×]`);
		} else {
			for (let k = 0; k < runLen; k++) out.push(lines[i]);
		}
		i = j;
	}
	let result = out.join("\n");
	if (Buffer.byteLength(result, "utf8") > EPHEMERAL_REPLY_MAX_BYTES) {
		// Trim by characters until we're under the byte budget — handles multi-byte
		// glyphs at the boundary without splitting them.
		const suffix = "\n[…truncated]";
		const budget = EPHEMERAL_REPLY_MAX_BYTES - Buffer.byteLength(suffix, "utf8");
		while (Buffer.byteLength(result, "utf8") > budget) {
			result = result.slice(0, -1);
		}
		result += suffix;
	}
	return result;
}

/**
 * Build the per-request `metadata` payload for the Anthropic provider, shaped
 * like real Claude Code's `getAPIMetadata` output (`{ session_id, account_uuid,
 * device_id }`) so the backend buckets requests under one session and attributes
 * them to the authenticated OAuth account when available. Resolved at request
 * time so token refreshes and login/logout transitions don't strand a stale
 * account UUID in memory. `account_uuid` and `device_id` are omitted for
 * non-Anthropic providers to avoid leaking the user's Claude identity to
 * third-party APIs (including Anthropic-format-compatible proxies such as
 * cloudflare-ai-gateway or gitlab-duo).
 *
 * `provider` is the target provider string (e.g. `"anthropic"`) and gates the
 * `account_uuid` and `device_id` lookups — only `"anthropic"` requests carry them.
 *
 * `sessionId` is forwarded to the auth-storage session-sticky lookup so that
 * multi-credential setups attribute to the same OAuth account used for the
 * actual API request rather than always picking the first credential.
 *
 * `authStorage` is treated as optional so test fixtures that stub `modelRegistry`
 * without a real storage layer still work; the resolver simply skips the lookup
 * and emits `{ session_id }` alone, matching the no-OAuth-credential path.
 */
/**
 * Whether `next` is the same tool set as `current` in a different order.
 *
 * Order-only differences are the case worth catching: they cost a full prefix
 * re-encode and buy nothing, because the model selects a tool by name. A genuine
 * set change (a tool added, removed, or swapped) is NOT a permutation and must
 * reach the provider in the order the caller asked for.
 */
export function isToolOrderPermutation(current: readonly string[], next: readonly string[]): boolean {
	if (current.length !== next.length || current.length === 0) return false;
	let sameOrder = true;
	for (let index = 0; index < current.length; index++) {
		if (current[index] !== next[index]) {
			sameOrder = false;
			break;
		}
	}
	if (sameOrder) return false;
	const currentSet = new Set(current);
	if (currentSet.size !== current.length) return false;
	for (const name of next) {
		if (!currentSet.delete(name)) return false;
	}
	return currentSet.size === 0;
}

export function buildSessionMetadata(
	sessionId: string,
	provider: string,
	authStorage: AuthStorage | undefined,
): Record<string, unknown> {
	const userId: Record<string, string> = { session_id: sessionId };
	// Only look up account_uuid when the request is going to Anthropic. Injecting
	// a Claude OAuth account_uuid into requests bound for other providers (including
	// Anthropic-format-compatible proxies like cloudflare-ai-gateway or gitlab-duo)
	// would leak the user's Anthropic identity to unrelated third-party APIs.
	if (provider === "anthropic") {
		const accountUuid = authStorage?.getOAuthAccountId("anthropic", sessionId);
		if (typeof accountUuid === "string" && accountUuid.length > 0) {
			userId.account_uuid = accountUuid;
			// Claude Code's `device_id` is a stable 64-hex account-scoped install
			// identifier. Include both veyyon's persistent install id and the Claude
			// account UUID so two accounts on the same install do not share a device.
			userId.device_id = deriveClaudeDeviceId(getInstallId(), accountUuid);
		}
	}
	return { user_id: JSON.stringify(userId) };
}

export const noOpUIContext: ExtensionUIContext = {
	select: async (_title, _options, _dialogOptions) => undefined,
	confirm: async (_title, _message, _dialogOptions) => false,
	input: async (_title, _placeholder, _dialogOptions) => undefined,
	notify: () => {},
	onTerminalInput: () => () => {},
	setStatus: () => {},
	setWorkingMessage: () => {},
	setWidget: () => {},
	setTitle: () => {},
	custom: async () => undefined as never,
	setEditorText: () => {},
	pasteToEditor: () => {},
	getEditorText: () => "",
	editor: async () => undefined,
	addAutocompleteProvider: () => {},
	get theme() {
		return theme;
	},
	getAllThemes: () => Promise.resolve([]),
	getTheme: () => Promise.resolve(undefined),
	setTheme: _theme => Promise.resolve({ success: false, error: "UI not available" }),
	setFooter: () => {},
	setHeader: () => {},
	setEditorComponent: () => {},
	getToolsExpanded: () => false,
	setToolsExpanded: () => {},
};

export function createHandoffContext(document: string): string {
	return `<handoff-context>\n${document}\n</handoff-context>\n\nThe above is a handoff document from a previous session. Use this context to continue the work seamlessly.`;
}

export function createHandoffFileName(date = new Date()): string {
	const fileTimestamp = date.toISOString().replace(/[:.]/g, "-");
	return `handoff-${fileTimestamp}.md`;
}

// ============================================================================
// ACP Permission Gate
// ============================================================================

/** Tools that require user permission before execution when an ACP client is connected. */
export const PERMISSION_REQUIRED_TOOLS = new Set([TOOL.bash, TOOL.edit, "delete", "move"]);

/** Permission options presented to the client on each gated tool call. */
export const PERMISSION_OPTIONS: ClientBridgePermissionOption[] = [
	{ optionId: "allow_once", name: "Allow once", kind: "allow_once" },
	{ optionId: "allow_always", name: "Always allow", kind: "allow_always" },
	{ optionId: "reject_once", name: "Reject", kind: "reject_once" },
	{ optionId: "reject_always", name: "Always reject", kind: "reject_always" },
];

export const PERMISSION_OPTIONS_BY_ID = new Map(PERMISSION_OPTIONS.map(option => [option.optionId, option]));

export { getStringProperty } from "@veyyon/utils";

function collectStringPaths(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function getEditDestructiveIntent(args: unknown): { kind: "delete" | "move"; paths: string[] } | undefined {
	if (!isRecord(args)) return undefined;
	const a = args as Record<string, unknown>;

	const edits = Array.isArray(a.edits) ? a.edits : undefined;
	if (edits) {
		const path = getStringProperty(a, "path");
		if (path) {
			for (const edit of edits) {
				if (!isRecord(edit)) continue;
				const op = getStringProperty(edit as Record<string, unknown>, "op");
				if (op === "delete") return { kind: "delete", paths: [path] };
			}
		}
		for (const edit of edits) {
			if (!isRecord(edit)) continue;
			const entry = edit as Record<string, unknown>;
			const op = getStringProperty(entry, "op");
			const rename = getStringProperty(entry, "rename");
			if (op !== "create" && rename) return { kind: "move", paths: path ? [path, rename] : [rename] };
		}
	}

	const input = getStringProperty(a, "input");
	if (input) {
		try {
			const patch = Patch.parse(input);
			for (const section of patch.sections) {
				if (section.fileOp?.kind === "rem") return { kind: "delete", paths: [section.path] };
				if (section.fileOp?.kind === "move") return { kind: "move", paths: [section.path, section.fileOp.dest] };
			}
		} catch {
			// Not a hashline patch — fall through to apply_patch parsing.
		}
		try {
			const entries = expandApplyPatchToEntries({ input });
			const deleteEntry = entries.find(entry => entry.op === "delete");
			if (deleteEntry) return { kind: "delete", paths: [deleteEntry.path] };
			const moveEntry = entries.find(entry => entry.rename);
			if (moveEntry?.rename) return { kind: "move", paths: [moveEntry.path, moveEntry.rename] };
		} catch {
			// If the edit input is not an apply_patch envelope, it is not a delete/move operation.
		}
	}

	return undefined;
}

export function getPermissionIntent(
	toolName: string,
	args: unknown,
): { toolName: string; title: string; paths?: string[]; cacheKey: string } | undefined {
	const a = isRecord(args) ? (args as Record<string, unknown>) : {};
	if (toolName === TOOL.bash) {
		const cmd = getStringProperty(a, "command")?.slice(0, 80);
		return { toolName, title: cmd || toolName, cacheKey: toolName };
	}
	if (toolName === "delete") {
		const p = getStringProperty(a, "path");
		return { toolName, title: p ? `Delete ${p}` : toolName, paths: p ? [p] : undefined, cacheKey: toolName };
	}
	if (toolName === "move") {
		const from = getStringProperty(a, "oldPath") ?? getStringProperty(a, "path") ?? getStringProperty(a, "from");
		const to = getStringProperty(a, "newPath") ?? getStringProperty(a, "to") ?? getStringProperty(a, "destination");
		if (from && to) return { toolName, title: `Move ${from} to ${to}`, paths: [from, to], cacheKey: toolName };
		return {
			toolName,
			title: from ? `Move ${from}` : toolName,
			paths: from ? [from] : undefined,
			cacheKey: toolName,
		};
	}
	if (toolName === TOOL.edit) {
		const intent = getEditDestructiveIntent(args);
		if (!intent) return undefined;
		if (intent.kind === "delete") {
			return {
				toolName,
				title: `Delete ${intent.paths[0] ?? "edit target"}`,
				paths: intent.paths,
				cacheKey: "edit:delete",
			};
		}
		const from = intent.paths[0];
		const to = intent.paths[1];
		return {
			toolName,
			title: from && to ? `Move ${from} to ${to}` : `Move ${from ?? to ?? "edit target"}`,
			paths: intent.paths,
			cacheKey: "edit:move",
		};
	}
	return undefined;
}

export function extractPermissionLocations(
	args: unknown,
	cwd: string,
	explicitPaths?: string[],
): { path: string; line?: number }[] {
	if (!args || typeof args !== "object") return [];
	const a = args as Record<string, unknown>;
	const out: { path: string; line?: number }[] = [];
	const pushPath = (value: unknown) => {
		if (typeof value !== "string" || value.length === 0) return;
		// ACP locations carry file paths that the editor host will open or focus;
		// they must be absolute or the client cannot resolve them. Resolve raw
		// tool args (often cwd-relative) against the session cwd before sending.
		let resolved: string;
		try {
			resolved = resolveToCwd(value, cwd);
		} catch {
			return;
		}
		if (out.some(location => location.path === resolved)) return;
		out.push({ path: resolved });
	};
	if (explicitPaths) {
		for (const p of explicitPaths) {
			pushPath(p);
		}
		return out;
	}
	pushPath(a.path);
	pushPath(a.file);
	for (const p of collectStringPaths(a.paths)) {
		pushPath(p);
	}
	pushPath(a.oldPath);
	pushPath(a.newPath);
	pushPath(a.from);
	pushPath(a.to);
	pushPath(a.source);
	pushPath(a.destination);
	return out;
}

// ============================================================================
// AgentSession Class
// ============================================================================

/** Entry returned by {@link AgentSession.clearQueue} / {@link AgentSession.popLastQueuedMessage}. */
export type RestoredQueuedMessage = { text: string; images?: ImageContent[] };

function queuedTextContent(message: AgentMessage): string | undefined {
	if (!("content" in message)) return undefined;
	const content = message.content;
	if (typeof content === "string") return content;
	return content.find((part): part is TextContent => part.type === "text")?.text;
}

function queuedImageContent(message: AgentMessage): ImageContent[] | undefined {
	if (!("content" in message) || typeof message.content === "string") return undefined;
	const images = message.content.filter(
		(part): part is ImageContent =>
			part.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string",
	);
	return images.length > 0 ? images : undefined;
}

export function isDisplayableQueuedMessage(message: AgentMessage): boolean {
	return !(message.role === "custom" && message.display === false);
}

export function isAdvisorCard(message: AgentMessage): message is CustomMessage {
	return message.role === "custom" && message.customType === "advisor";
}

export function isTerminalTextAssistantAnswer(message: AgentMessage | undefined): message is AssistantMessage {
	if (message?.role !== "assistant" || message.stopReason !== "stop") return false;
	let hasText = false;
	for (const part of message.content) {
		if (part.type === "toolCall") return false;
		if (part.type === "text") {
			if (part.text.trim().length > 0) hasText = true;
			continue;
		}
		if (part.type === "thinking" || part.type === "redactedThinking" || part.type === "fallback") continue;
		return false;
	}
	return hasText;
}

/**
 * A queued message the user can restore to the editor / pull back as a draft.
 * Only genuinely user-authored messages qualify: plain user turns, or custom
 * messages explicitly attributed to the user (e.g. `/skill` invocations).
 * Agent-authored queued cards — advisor concern/blocker notes, IRC asides,
 * extension notices, hidden goal/plan/budget steers — ride the same
 * steer/follow-up queues but must never be dumped into the editor on Esc/Alt+Up.
 */
export function isUserQueuedMessage(message: AgentMessage): boolean {
	if (message.role === "user") return true;
	return message.role === "custom" && message.attribution === "user" && message.display !== false;
}

/** Custom-message types of the hidden magic-keyword notices that `#createMagicKeywordNotices`
 *  enqueues alongside a user prompt. Keep in sync with that method. */
export const MAGIC_KEYWORD_NOTICE_TYPES: ReadonlySet<string> = new Set([
	"ultrathink-notice",
	"orchestrate-notice",
	"workflow-notice",
]);

/** Custom-message type of the hidden companion carrying vision descriptions of image
 *  attachments sent to a text-only model (see `#buildImageDescriptionNotice`). */
export const IMAGE_ATTACHMENT_DESCRIPTION_TYPE = "image-attachment-description";

/**
 * A hidden, user-attributed companion of a queued user prompt: the magic-keyword
 * notices (`ultrathink`/`orchestrate`/`workflow`) enqueued alongside the user
 * message. They are `attribution: "user"` but `display: false`, so they are not
 * editor-restorable; when the user pulls their prompt back out of the queue these
 * must leave with it rather than linger as stale, companion-less steering. Scoped to
 * the known notice types so an unrelated hidden user custom is never silently dropped.
 */
export function isHiddenUserCompanion(message: AgentMessage): boolean {
	return (
		message.role === "custom" &&
		message.attribution === "user" &&
		message.display === false &&
		(MAGIC_KEYWORD_NOTICE_TYPES.has(message.customType) || message.customType === IMAGE_ATTACHMENT_DESCRIPTION_TYPE)
	);
}

export function queueChipText(message: AgentMessage): string {
	if (message.role === "custom") {
		return readQueueChipText(message.details) ?? queuedTextContent(message) ?? "";
	}
	const text = queuedTextContent(message) ?? "";
	if (text) return text;
	return queuedImageContent(message) ? "[Image]" : "";
}

export function toRestoredQueuedMessage(message: AgentMessage): RestoredQueuedMessage {
	return { text: queueChipText(message), images: queuedImageContent(message) };
}

export function mergeLlmCompactionPreserveData(
	hookPreserveData: Record<string, unknown> | undefined,
	resultPreserveData: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
	const preserveData = { ...(hookPreserveData ?? {}), ...(resultPreserveData ?? {}) };
	return stripLegacyArchive(Object.keys(preserveData).length > 0 ? preserveData : undefined);
}

/**
 * Redact every string in a provider payload, object keys included, after
 * mutable request hooks. The bounded shared walker rejects transformed-key
 * collisions and unsupported/cyclic payloads; the boundary converts every
 * walker failure into a fail-closed confidentiality error.
 */
export function obfuscateProviderPayload(value: unknown, obfuscator: SecretObfuscator | undefined): unknown {
	if (!obfuscator?.hasSecrets()) return value;
	return transformProviderPayload(value, text => obfuscator.obfuscate(text), "AgentSession provider payload", {
		safeFailureDetails: true,
	});
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

export const REPLAN_TITLE_CONTEXT_TURN_LIMIT = 6;

export type SessionNameTrigger = "replan";
export type SetSessionNameWithTrigger = (
	name: string,
	source?: SessionTitleSource,
	trigger?: SessionNameTrigger,
) => Promise<boolean>;

// A thin adapter over the `contentText` owner for the `unknown` agent-message
// boundary: content here may be a plain string, an array of blocks (a wider
// union that also carries thinking and tool-call blocks), or malformed. The
// string/non-array guards live here; the block flattening (skip non-text, trim,
// join with a blank line) is the owner's job. `contentText` skips non-record and
// non-string-text blocks the same way the old hand-rolled loop did.
export function textFromContent(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return contentText(content as readonly ContentBlockLike[], { separator: "\n\n", trimBlocks: true });
}

function thinkingFromContent(content: unknown): string {
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (!isRecord(block) || block.type !== "thinking" || typeof block.thinking !== "string") continue;
		const thinking = block.thinking.trim();
		if (thinking) parts.push(thinking);
	}
	return parts.join("\n\n");
}

export function toolCallOpFromMessage(message: AgentMessage, toolCallId: string): string | undefined {
	if (message.role !== "assistant" || !Array.isArray(message.content)) return undefined;
	for (const block of message.content) {
		if (!isRecord(block) || block.type !== "toolCall" || block.id !== toolCallId) continue;
		return isRecord(block.arguments) ? getStringProperty(block.arguments, "op") : undefined;
	}
	return undefined;
}

export function titleConversationTurnFromMessage(message: AgentMessage): TitleConversationTurn | undefined {
	if (message.role !== "user" && message.role !== "assistant") return undefined;
	const text = textFromContent(message.content);
	const thinking = message.role === "assistant" ? thinkingFromContent(message.content) : undefined;
	if (!text && !thinking) return undefined;
	return { role: message.role, ...(text ? { text } : {}), ...(thinking ? { thinking } : {}) };
}
