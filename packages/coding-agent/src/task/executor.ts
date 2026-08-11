/**
 * In-process execution for subagents.
 *
 * Runs each subagent on the main thread and forwards AgentEvents for progress tracking.
 */

import * as fs from "node:fs/promises";
import path from "node:path";
import type { AgentEvent, AgentIdentity, AgentTelemetryConfig } from "@veyyon/agent-core";
import { recordHandoff, resolveTelemetry } from "@veyyon/agent-core";
import { ThinkingLevel } from "@veyyon/agent-core/thinking";
import type { Api, Model, ServiceTierByFamily, Usage } from "@veyyon/ai";
import { emptyUsage } from "@veyyon/catalog/models";
import {
	collapseWhitespace,
	errorMessage,
	getSessionsDir,
	isRecord,
	logger,
	popLoopPhase,
	prompt,
	pushLoopPhase,
	scopedTimeoutSignal,
	truncate,
	untilAborted,
} from "@veyyon/utils";
import { sessionFileName } from "@veyyon/utils/session-file";
import type { ArgotSession, StreamDecoder } from "argot";
import { createSubagentStreamDecoder, expandSubagentReturn } from "../argot-wire";
import type { Rule } from "../capability/rule";
import { ModelRegistry } from "../config/model-registry";
import {
	formatModelSelectorValue,
	formatModelStringWithRouting,
	resolveModelOverride,
	resolveModelOverrideWithAuthFallback,
} from "../config/model-resolver";
import type { PromptTemplate } from "../config/prompt-templates";
import { buildServiceTierByFamily, resolveSubagentServiceTier } from "../config/service-tier";
import { Settings } from "../config/settings";
import type { SettingPath } from "../config/settings-schema";
import type { ToolPathWithSource } from "../extensibility/custom-tools";
import type { CustomTool } from "../extensibility/custom-tools/types";
import { runExtensionCompact, runExtensionSetModel } from "../extensibility/extensions/compact-handler";
import { getSessionSlashCommands } from "../extensibility/extensions/get-commands-handler";
import type { ExtensionUIContext } from "../extensibility/extensions/types";
import { buildSkillPromptMessage, type Skill } from "../extensibility/skills";
import type { HindsightSessionState } from "../hindsight/state";
import type { LocalProtocolOptions } from "../internal-urls";
import type { MCPManager } from "../mcp/manager";
import type { MnemopiSessionState } from "../mnemopi/state";
import { subagentPrompts } from "../prompts/subagent/rows";
import { AgentLifecycleManager } from "../registry/agent-lifecycle";
import { AgentRegistry } from "../registry/agent-registry";
// `createAgentSession` is loaded on demand, further down, where a subagent is
// actually spawned. `../sdk` is the composition root and imports the whole
// application, so naming it statically put this module in a 54-module import
// cycle (task/executor -> sdk -> task/index -> task/executor) that also swept in
// `main.ts`, the interactive UI, eval and the browser tool. A cycle is
// instantiated as one unit, so importing `session/agent-session` cost 91 MB per
// file. Deferring changes nothing at runtime: by the time anything spawns a
// subagent the real program has loaded `sdk` anyway, and a test that never spawns
// one no longer pays for it. The TYPE stays a static import because types are
// erased.
import type { CreateAgentSessionOptions, CreateAgentSessionResult } from "../sdk";
import type { AgentSession, AgentSessionEvent } from "../session/agent-session";
import type { ArtifactManager } from "../session/artifacts";
import { discoverAuthStorage } from "../session/auth-broker-config";
import type { AuthStorage } from "../session/auth-storage";
import { rootBudgetGroupOwnerId, withInheritedBudgetGroup } from "../session/cpu-limit";
import { SKILL_PROMPT_MESSAGE_TYPE, USER_INTERRUPT_LABEL } from "../session/messages";
import { SessionManager } from "../session/session-manager";
import { truncateTail } from "../session/streaming-output";
import type { ConfiguredThinkingLevel } from "../thinking";
import type { ContextFileEntry, ToolSession } from "../tools";
import { resolveEvalBackends } from "../tools/eval-backends";
import { isIrcEnabled } from "../tools/irc";
import { normalizeSchema } from "../tools/jtd-to-json-schema";
import {
	buildOutputValidator,
	type OutputValidator,
	summarizeValidationFailure,
} from "../tools/output-schema-validator";
import { type ReportFindingDetails, toReviewFinding } from "../tools/review";
// SIDE-EFFECT IMPORT, and it is load-bearing.
//
// `tools/yield.ts` registers the `yield` handler on `subprocessToolRegistry` at module load, and
// this file's entire completion path reads it: no handler means `recordExtractedToolData` is never
// called, so `yieldCalled` stays false, the subagent is prompted again for a result it already
// returned, and the run finally reports a missing yield with exit code 1. Nothing in the extracted
// output survives either.
//
// Until now that registration arrived by luck of import order: a child session builds its own
// `yield` tool, which loads the module, and in-process children happen to do that before they can
// emit a yield event. The dependency was real, unstated and unenforced, and it broke the moment the
// child session was a stub rather than a real one. Stating it here is what makes the parent's
// interpretation of a yield independent of who built the child.
import "../tools/yield";
import type { SideCompleteImpl } from "../session/side-complete";
import { ToolAbortError } from "../tools/tool-errors";
import type { EventBus } from "../utils/event-bus";
import { buildNamedToolChoice } from "../utils/tool-choice";
import type { WorkspaceTree } from "../workspace-tree";
import { type AutoloadSkillPlan, settleAutoloadSkills } from "./inherited-collections";
import { generateTaskLabel } from "./label";
import {
	resolveSubagentAutoCloseBudget,
	resolveSubagentIdleTtlMs,
	resolveSubagentMaxNestedSpawnDepth,
	type SubagentAutoCloseBudget,
} from "./subagent-settings";
import { subprocessToolRegistry, YIELD_TOOL_NAME } from "./subprocess-tool-registry";
import {
	type AgentDefinition,
	type AgentProgress,
	canSpawnAtDepth,
	MAX_OUTPUT_BYTES,
	MAX_OUTPUT_LINES,
	type ReviewFinding,
	type SingleResult,
	TASK_SUBAGENT_EVENT_CHANNEL,
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
	type TaskToolDetails,
	type YieldItem,
} from "./types";
import { arrayValuedLabels, assembleYieldResult } from "./yield-assembly";

export type { YieldItem } from "./types";

const MCP_CALL_TIMEOUT_MS = 60_000;

/**
 * Soft per-agent request budgets (assistant requests per run). Crossing the
 * budget injects a wrap-up steering notice (`task.softRequestBudgetNotice`,
 * on by default). At 1.5x the budget the free-running turn is stopped and the
 * agent is driven to one forced final `yield` so partial findings come back
 * as a real report; only if it still refuses to yield within
 * {@link BUDGET_STOP_GRACE_REQUESTS} more requests is the run hard-aborted.
 * The `default` key applies to agents without an explicit entry and can be
 * overridden via the `task.softRequestBudget` setting (0 disables the guard).
 */
export const SOFT_REQUEST_BUDGET: Record<string, number> = {
	scout: 100,
	sonic: 100,
	default: 200,
};

/** Extra requests allowed after a budget stop for the forced yield to land before the run is hard-aborted. */
export const BUDGET_STOP_GRACE_REQUESTS = 5;

/** Steering notice injected when a subagent crosses its soft request budget. */
export function buildBudgetNotice(requests: number, budget: number): string {
	return `[budget notice] You have used ${requests} requests in this run (soft budget: ${budget}). Wrap up now: finish the current step and yield your final report. At ${Math.ceil(budget * 1.5)} requests the run is force-stopped and you will be asked to yield whatever you have.`;
}

/** Flatten whitespace and clip salvage text for the cancelled-child summary line. */
function formatSalvageSnippet(text: string, maxLength = 500): string {
	return truncate(collapseWhitespace(text), maxLength);
}

/**
 * The thinking effort a dispatched subagent runs at, by precedence:
 *
 * 1. an explicit `:level` suffix on the resolved model pattern (e.g.
 *    `subagent.model = "anthropic/claude-sonnet-4-5:high"`) always wins;
 * 2. otherwise `configuredThinkingLevel`, the level the CALLER already resolved;
 * 3. otherwise the level derived from the pattern match itself.
 *
 * `explicitThinkingLevel` is set by the model resolver when it stripped a
 * concrete `:level` suffix off the pattern; in that case `resolvedThinkingLevel`
 * carries that level and it is authoritative, so the caller's level is ignored.
 *
 * `configuredThinkingLevel` is NOT the agent definition's frontmatter, though it
 * was named and documented as if it were. Every caller passes the output of
 * `resolveSubagentThinkingLevel` (row, then blanket, then frontmatter), and this
 * function must not re-apply any of those layers — resolving frontmatter a second
 * time behind the caller is how the same axis came to have two answers.
 */
export function resolveEffectiveSubagentThinkingLevel(
	explicitThinkingLevel: boolean,
	resolvedThinkingLevel: ConfiguredThinkingLevel | undefined,
	configuredThinkingLevel: ConfiguredThinkingLevel | undefined,
): ConfiguredThinkingLevel | undefined {
	return explicitThinkingLevel ? resolvedThinkingLevel : (configuredThinkingLevel ?? resolvedThinkingLevel);
}

/** Agent event types to forward for progress tracking. */
const agentEventTypes = new Set<AgentEvent["type"]>([
	"agent_start",
	"agent_end",
	"turn_start",
	"turn_end",
	"message_start",
	"message_update",
	"message_end",
	"tool_execution_start",
	"tool_execution_update",
	"tool_execution_end",
]);

const isAgentEvent = (event: AgentSessionEvent): event is AgentEvent =>
	agentEventTypes.has(event.type as AgentEvent["type"]);

function normalizeModelPatterns(value: string | string[] | undefined): string[] {
	if (!value) return [];
	if (Array.isArray(value)) {
		return value.map(entry => entry.trim()).filter(Boolean);
	}
	return value
		.split(",")
		.map(entry => entry.trim())
		.filter(Boolean);
}

const SUBAGENT_RETRY_FALLBACK_ROLE_PREFIX = "subagent:";

interface SubagentRetryFallbackCandidate {
	model: Model<Api>;
	selector: string;
}

function resolveSubagentRetryFallbackCandidates(
	modelPatterns: string[],
	modelRegistry: ModelRegistry,
	settings: Settings,
): SubagentRetryFallbackCandidate[] {
	const candidates: SubagentRetryFallbackCandidate[] = [];
	const seen = new Set<string>();
	for (const pattern of modelPatterns) {
		const resolved = resolveModelOverride([pattern], modelRegistry, settings);
		if (!resolved.model) continue;
		const selector = resolved.explicitThinkingLevel
			? formatModelSelectorValue(formatModelStringWithRouting(resolved.model), resolved.thinkingLevel)
			: formatModelStringWithRouting(resolved.model);
		if (seen.has(selector)) continue;
		seen.add(selector);
		candidates.push({ model: resolved.model, selector });
	}
	return candidates;
}

function installSubagentRetryFallbackChain(args: {
	settings: Settings;
	id: string;
	candidates: SubagentRetryFallbackCandidate[];
	model: Model<Api> | undefined;
	authFallbackUsed: boolean;
}): string | undefined {
	const { settings, id, candidates, model, authFallbackUsed } = args;
	if (!model || authFallbackUsed || candidates.length <= 1) return undefined;

	const selectedIndex = candidates.findIndex(
		candidate => candidate.model.provider === model.provider && candidate.model.id === model.id,
	);
	if (selectedIndex < 0) return undefined;
	const fallbackSelectors = candidates.slice(selectedIndex + 1).map(candidate => candidate.selector);
	if (fallbackSelectors.length === 0) return undefined;

	const role = `${SUBAGENT_RETRY_FALLBACK_ROLE_PREFIX}${id}`;
	const modelRoles: Record<string, string> = {};
	const existingRoles = settings.getModelRoles();
	for (const existingRole in existingRoles) {
		const selector = existingRoles[existingRole];
		if (selector) {
			modelRoles[existingRole] = selector;
		}
	}
	modelRoles[role] = candidates[selectedIndex].selector;
	settings.override("modelRoles", modelRoles);
	const fallbackChains: Record<string, string[]> = {
		[role]: fallbackSelectors,
	};
	const existingFallbackChains = settings.get("retry.fallbackChains");
	for (const existingRole in existingFallbackChains) {
		if (existingRole !== role) {
			fallbackChains[existingRole] = existingFallbackChains[existingRole];
		}
	}
	settings.override("retry.fallbackChains", fallbackChains);
	return role;
}

function withAbortTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
	signal?: AbortSignal,
	timeoutController?: AbortController,
): Promise<T> {
	if (signal?.aborted) {
		return Promise.reject(new ToolAbortError());
	}

	const { promise: wrappedPromise, resolve, reject } = Promise.withResolvers<T>();
	let settled = false;
	const timeoutId = setTimeout(() => {
		if (settled) return;
		settled = true;
		timeoutController?.abort(new DOMException(`MCP tool call timed out after ${timeoutMs}ms`, "TimeoutError"));
		reject(new Error(`MCP tool call timed out after ${timeoutMs}ms`));
	}, timeoutMs);

	const onAbort = () => {
		if (settled) return;
		settled = true;
		clearTimeout(timeoutId);
		timeoutController?.abort();
		reject(new ToolAbortError());
	};

	if (signal) {
		signal.addEventListener("abort", onAbort, { once: true });
	}

	promise.then(resolve, reject).finally(() => {
		if (signal) signal.removeEventListener("abort", onAbort);
		clearTimeout(timeoutId);
	});

	return wrappedPromise;
}

function getReportFindingKey(value: unknown): string | null {
	if (!isRecord(value)) return null;
	const title = typeof value.title === "string" ? value.title : null;
	const filePath = typeof value.file_path === "string" ? value.file_path : null;
	const lineStart = typeof value.line_start === "number" ? value.line_start : null;
	const lineEnd = typeof value.line_end === "number" ? value.line_end : null;
	const priority = typeof value.priority === "string" ? value.priority : null;
	if (!title || !filePath || lineStart === null || lineEnd === null) {
		return null;
	}
	return `${filePath}:${lineStart}:${lineEnd}:${priority ?? ""}:${title}`;
}

/** Options for subagent execution */
export interface ExecutorOptions {
	cwd: string;
	worktree?: string;
	agent: AgentDefinition;
	task: string;
	assignment?: string;
	/** Shared background from the task call (`task.batch`), rendered into the subagent's system prompt. */
	context?: string;
	/**
	 * The session's active overall plan, handed off so subagents spawned during
	 * plan execution share the same plan context as the main agent. Omitted when
	 * the session did not start with a plan (or while plan mode is still active).
	 */
	planReference?: { path: string; content: string };
	/** Pre-set UI label (e.g. eval bridge label). When absent, a tiny-model label is generated from the assignment. */
	description?: string;
	/** Final outbound confidentiality boundary for generated label input. */
	obfuscateProviderText?: (text: string) => string;
	/**
	 * The parent session's side transport for the generated label request. When
	 * absent the label runs on a bare `completeSimple`: no stream watchdog and
	 * outside the in-flight cap, so a wide spawn fan-out issues one unbracketed
	 * request per subagent.
	 */
	completeImpl?: SideCompleteImpl;
	index: number;
	id: string;
	parentToolCallId?: string;
	/**
	 * Spawn runs as a detached background job (parent turn not blocked on it).
	 * Rides the subagent lifecycle/progress payloads so HUD-style surfaces can
	 * skip spawns the transcript already renders inline. See
	 * {@link SubagentLifecyclePayload.detached}.
	 */
	detached?: boolean;
	modelOverride?: string | string[];
	/**
	 * Active model selector of the parent session, used as an auth-aware fallback
	 * if the resolved subagent model has no working credentials. See #985.
	 */
	parentActiveModelPattern?: string;
	/** Configured effort of the parent session, used when this subagent has no explicit effort. */
	parentThinkingLevel?: ConfiguredThinkingLevel;
	thinkingLevel?: ConfiguredThinkingLevel;
	outputSchema?: unknown;
	/**
	 * Caller supplied a schema that supersedes the agent's native output prompt.
	 * Eval `agent(..., schema=...)` sets this so built-in agents ignore stale yield labels.
	 */
	outputSchemaOverridesAgent?: boolean;
	/** Parent task recursion depth (0 = top-level, 1 = first child, etc.) */
	taskDepth?: number;
	/**
	 * Override the `task.maxRuntimeMs` wall-clock cap for this run. When provided
	 * it wins over the settings value; `0` disables the per-subagent wall-clock
	 * limit entirely. Used by the eval `agent()` bridge, whose parent cell
	 * watchdog is already suspended for the call's duration.
	 */
	maxRuntimeMs?: number;
	enableLsp?: boolean;
	signal?: AbortSignal;
	onProgress?: (progress: AgentProgress) => void;
	/**
	 * Epochs (ms, `Date.now()`) bracketing the concurrency-semaphore wait:
	 * `invokedAt` is stamped at the spawn boundary before `acquire()`,
	 * `acquiredAt` immediately after. {@link runSubprocess} reports true queue
	 * wait (`acquiredAt - invokedAt`) and pre-run setup (`startTime - acquiredAt`)
	 * separately in the launch-timing debug log. Undefined for callers that
	 * bypass the semaphore path.
	 */
	invokedAt?: number;
	acquiredAt?: number;
	sessionFile?: string | null;
	persistArtifacts?: boolean;
	artifactsDir?: string;
	eventBus?: EventBus;
	contextFiles?: ContextFileEntry[];
	skills?: Skill[];
	promptTemplates?: PromptTemplate[];
	workspaceTree?: WorkspaceTree;
	/** Parent-discovered rules, forwarded to skip rule discovery in the subagent. */
	rules?: Rule[];
	/**
	 * Parent's discovered extension source paths. Forwarded to skip the
	 * extension FS scan in the subagent; the subagent then re-binds each
	 * extension against its own `ExtensionAPI` (cwd, eventBus, runtime).
	 */
	preloadedExtensionPaths?: string[];
	/**
	 * Parent's discovered custom-tool source paths. Forwarded to skip the
	 * `.veyyon/tools/` FS scan in the subagent; the subagent then re-binds each
	 * tool against its own `CustomToolAPI` (cwd, exec, pushPendingAction, UI).
	 */
	preloadedCustomToolPaths?: ToolPathWithSource[];
	mcpManager?: MCPManager;
	authStorage?: AuthStorage;
	modelRegistry?: ModelRegistry;
	settings?: Settings;
	/**
	 * Parent session's live `/yolo` full-bypass state. The bypass is session
	 * scoped and never written to settings, so the settings fork that carries
	 * every other inherited rung cannot see it: without this the child resolved
	 * `tools.approvalMode` from settings alone, got the `auto` default, and
	 * prompted while the parent was running unasked. A spawn carries the
	 * parent's rung, and the bypass is part of that rung.
	 */
	bypassAllApprovals?: boolean;
	/**
	 * The parent's bypass, read live rather than copied. `bypassAllApprovals`
	 * above is a snapshot: without this, `/yolo off` in the parent leaves an
	 * already-running subagent bypassing approvals until it finishes.
	 */
	parentApprovalBypassed?: () => boolean;
	/**
	 * Parent session's live per-family service tiers, the source of truth for a
	 * subagent whose `tier.subagent` is `"inherit"`. `null` = the parent
	 * explicitly has no tier (e.g. `/fast off`); omitted = no live session, so
	 * inherit falls back to the subagent's configured `tier.*` settings.
	 */
	parentServiceTier?: ServiceTierByFamily | null;
	/** Override local:// protocol options so subagent shares parent's local:// root */
	localProtocolOptions?: LocalProtocolOptions;
	/**
	 * Parent session's ArtifactManager. Subagent adopts it so artifact IDs are
	 * unique across the whole agent tree and all artifacts land in the parent's
	 * artifacts directory (no per-subagent subdir).
	 */
	parentArtifactManager?: ArtifactManager;
	parentHindsightSessionState?: HindsightSessionState;
	parentMnemopiSessionState?: MnemopiSessionState;
	/** Parent session's Argot codec, forked into this subagent under `argot.subagents: inherit`. */
	parentArgot?: ArgotSession;
	/** Parent agent's eval executor session id. Subagents reuse it so eval state is shared. */
	parentEvalSessionId?: string;
	/**
	 * Parent agent's OpenTelemetry configuration. When defined, the subagent's
	 * loop is started with the same tracer/hooks but its own agent identity
	 * stamped, so its `invoke_agent` / `chat` / `execute_tool` spans appear as
	 * a sub-tree under the parent's active `execute_tool task` span. A
	 * `handoff` span is emitted on dispatch to mark the parent → subagent
	 * transition explicitly.
	 */
	parentTelemetry?: AgentTelemetryConfig;
	/**
	 * The spawner's plan for the agent definition's `autoloadSkills` names, autoloaded via
	 * `sendCustomMessage` before the first prompt. A `deferred` plan carries the names unmatched so
	 * they resolve against the child's own skills; see `settleAutoloadSkills`.
	 */
	autoloadSkills?: AutoloadSkillPlan<Skill>;
	/**
	 * Registry id of the spawning agent, recorded as this subagent's parent.
	 * Forwarded verbatim to the SDK; the executor never derives it (the spawner
	 * passes its own `getAgentId()`).
	 */
	parentAgentId?: string;
	/**
	 * The SPAWNING session's id, so this subagent's own session registers as an
	 * alias of the spawner's budget group instead of creating a second one. See
	 * `withInheritedBudgetGroup`: a subagent that opens its own group multiplies
	 * every resource limit the operator set by the number of live subagents.
	 *
	 * An id that is itself an alias resolves to the same root owner, which is
	 * what makes the inheritance work at unbounded depth. Omitted falls back to
	 * the process's root session, because a subagent always belongs to some
	 * tree and no tree is a better guess than the first one.
	 */
	parentSessionId?: string;
	/**
	 * Keep the finished subagent addressable in the registry for IRC/revival.
	 * Defaults to true. Eval bridge agents are programmatic one-shot helpers and
	 * set this false so disposal unregisters them instead of leaving idle peers.
	 */
	keepAlive?: boolean;
}

function parseStringifiedJson(value: unknown): unknown {
	if (typeof value !== "string") return value;
	const trimmed = value.trim();
	if (!trimmed) return value;
	if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return value;
	try {
		return JSON.parse(trimmed);
	} catch {
		return value;
	}
}

function previewOffendingData(value: unknown, maxLength = 500): string {
	let serialized: string;
	try {
		serialized = JSON.stringify(value) ?? "null";
	} catch {
		serialized = String(value);
	}
	return serialized.length > maxLength ? `${serialized.slice(0, maxLength)}…` : serialized;
}

/**
 * A task's output as JSON, or undefined when it is not JSON.
 *
 * Undefined is a real answer rather than a swallowed failure: a task's output is whatever its command
 * printed, and prose is the common case. The caller keeps the raw text either way and only uses the
 * parsed form when there is one, so nothing is dropped for failing to parse.
 */
function tryParseJsonOutput(text: string): unknown | undefined {
	const trimmed = text.trim();
	if (!trimmed) return undefined;
	try {
		return JSON.parse(trimmed);
	} catch {
		return undefined;
	}
}

function extractCompletionData(parsed: unknown): unknown {
	if (!parsed || typeof parsed !== "object") return parsed;
	const record = parsed as Record<string, unknown>;
	if ("data" in record) {
		return record.data;
	}
	return parsed;
}

/**
 * Resolve the final yielded payload, optionally splicing collected
 * `report_finding` entries into a top-level `findings` array.
 *
 * Injection is suppressed when an active validator would reject the augmented
 * payload (e.g. a caller-supplied schema with `additionalProperties: false`
 * that does not declare `findings`). That keeps the in-tool yield validator
 * (which only sees the raw, pre-injection data) in lockstep with this
 * post-mortem validator — honoring the "accepted in-tool ⇒ accepted
 * post-mortem" guarantee documented in `output-schema-validator.ts`. The
 * dropped findings are still preserved verbatim in the agent's progress
 * stream and JSONL artifact, so no information is lost when injection is
 * suppressed.
 */
function normalizeCompleteData(
	data: unknown,
	reportFindings: ReviewFinding[] | undefined,
	validator: OutputValidator | undefined,
): unknown {
	const normalized = parseStringifiedJson(data ?? null);
	if (
		!Array.isArray(reportFindings) ||
		reportFindings.length === 0 ||
		!normalized ||
		typeof normalized !== "object" ||
		Array.isArray(normalized)
	) {
		return normalized;
	}
	const record = normalized as Record<string, unknown>;
	if ("findings" in record) return normalized;
	const injected = { ...record, findings: reportFindings };
	if (validator && !validator.validate(injected).success) return normalized;
	return injected;
}

function resolveFallbackCompletion(rawOutput: string, outputSchema: unknown): { data: unknown } | null {
	const parsed = tryParseJsonOutput(rawOutput);
	if (parsed === undefined) return null;
	const candidate = parseStringifiedJson(extractCompletionData(parsed));
	if (candidate === undefined) return null;
	const { validator, error } = buildOutputValidator(outputSchema);
	if (error) return null;
	if (validator && !validator.validate(candidate).success) return null;
	return { data: candidate };
}

interface FinalizeSubprocessOutputArgs {
	rawOutput: string;
	/** Whether the TURN failed. Not the run's verdict: `resolveRunVerdict` owns that. */
	exitCode: number;
	stderr: string;
	/**
	 * The turn did not end on its own (`DriveOutcome.turnCutShort`).
	 *
	 * Used to refuse the fallback paths: text a cancelled child happened to leave behind is not a
	 * delivered result, so it must not be parsed into one or blessed as output.
	 */
	doneAborted: boolean;
	signalAborted: boolean;
	yieldItems?: YieldItem[];
	reportFindings?: ReviewFinding[];
	outputSchema: unknown;
	lastAssistantText?: string;
}

interface FinalizeSubprocessOutputResult {
	rawOutput: string;
	exitCode: number;
	stderr: string;
	abortedViaYield: boolean;
	hasYield: boolean;
}
export const SUBAGENT_WARNING_NULL_YIELD = "SYSTEM WARNING: Subagent called yield with null data.";
export const SUBAGENT_WARNING_MISSING_YIELD =
	"SYSTEM WARNING: Subagent exited without calling yield tool after 3 reminders.";

/** Build a schema_violation outcome — surfaced as a non-zero exit so callers treat it as a failure. */
function buildSchemaViolationOutcome(
	failure: { message: string; missingRequired: string[] },
	data: unknown,
): { rawOutput: string; stderr: string; exitCode: number } {
	const missing = failure.missingRequired;
	const headline =
		missing.length > 0
			? `schema_violation: missing required fields: ${missing.join(", ")}`
			: `schema_violation: ${failure.message}`;
	const payload = {
		error: "schema_violation",
		message: failure.message,
		missingRequired: missing,
		data: previewOffendingData(data),
	};
	let rawOutput: string;
	try {
		rawOutput = JSON.stringify(payload, null, 2);
	} catch {
		rawOutput = `{"error":"schema_violation","message":${JSON.stringify(headline)}}`;
	}
	return { rawOutput, stderr: headline, exitCode: 1 };
}

/** Return the whole-result schema failure for accepted yields, or undefined when complete. */
function currentYieldSchemaFailure(progress: AgentProgress, outputSchema: unknown): string | undefined {
	const extracted = progress.extractedToolData?.yield;
	if (!Array.isArray(extracted) || extracted.length === 0) return undefined;
	const yieldItems = extracted.filter(item => item !== null && typeof item === "object") as YieldItem[];
	const lastYield = yieldItems[yieldItems.length - 1];
	if (lastYield?.status === "aborted") return undefined;
	const assembled = assembleYieldResult(yieldItems, undefined, arrayValuedLabels(outputSchema));
	if (!assembled || assembled.missingData) return "The accepted yield data is incomplete.";
	const { validator, error: schemaError } = buildOutputValidator(outputSchema);
	if (schemaError || !validator) return undefined;
	const extractedFindings = progress.extractedToolData?.report_finding;
	const reportFindings = Array.isArray(extractedFindings) ? (extractedFindings as ReviewFinding[]) : undefined;
	const completeData = assembled.rawText
		? assembled.data
		: normalizeCompleteData(assembled.data, reportFindings, validator);
	const result = validator.validate(completeData);
	if (result.success) return undefined;
	const summary = summarizeValidationFailure(result, completeData, validator.requiredFields);
	return summary.missingRequired.length > 0
		? `${summary.message}. Missing required fields: ${summary.missingRequired.join(", ")}`
		: summary.message;
}

export function finalizeSubprocessOutput(args: FinalizeSubprocessOutputArgs): FinalizeSubprocessOutputResult {
	let { rawOutput, exitCode, stderr } = args;
	const { yieldItems, reportFindings, doneAborted, signalAborted, outputSchema, lastAssistantText } = args;
	let abortedViaYield = false;
	const hasYield = Array.isArray(yieldItems) && yieldItems.length > 0;
	const hadFailureBeforeYield = exitCode !== 0 && stderr.trim().length > 0;

	if (hasYield) {
		const lastYield = yieldItems[yieldItems.length - 1];
		if (lastYield?.status === "aborted") {
			abortedViaYield = true;
			exitCode = 0;
			stderr = lastYield.error || "Subagent aborted task";
			try {
				rawOutput = JSON.stringify({ aborted: true, error: lastYield.error }, null, 2);
			} catch {
				rawOutput = `{"aborted":true,"error":"${lastYield.error || "Unknown error"}"}`;
			}
		} else {
			const assembled = assembleYieldResult(yieldItems, lastAssistantText, arrayValuedLabels(outputSchema));
			if (!assembled || assembled.missingData) {
				rawOutput = rawOutput ? `${SUBAGENT_WARNING_NULL_YIELD}\n\n${rawOutput}` : SUBAGENT_WARNING_NULL_YIELD;
			} else {
				const { validator, error: schemaError } = buildOutputValidator(outputSchema);
				const completeData = assembled.rawText
					? assembled.data
					: normalizeCompleteData(assembled.data, reportFindings, validator);
				const result = schemaError
					? { success: true as const }
					: (validator?.validate(completeData) ?? { success: true as const });
				if (!result.success) {
					const summary = summarizeValidationFailure(result, completeData, validator?.requiredFields ?? []);
					const outcome = buildSchemaViolationOutcome(summary, completeData);
					rawOutput = outcome.rawOutput;
					stderr = outcome.stderr;
					exitCode = outcome.exitCode;
				} else {
					try {
						rawOutput =
							assembled.rawText && typeof completeData === "string"
								? completeData
								: (JSON.stringify(completeData, null, 2) ?? "null");
					} catch (err) {
						const errorText = errorMessage(err);
						rawOutput = `{"error":"Failed to serialize yield data: ${errorText}"}`;
					}
					if (!hadFailureBeforeYield) {
						exitCode = 0;
						stderr = schemaError ? `invalid output schema: ${schemaError}` : "";
					} else if (!stderr) {
						stderr = "Subagent failed after yielding a result.";
					}
				}
			}
		}
	} else {
		const allowFallback = exitCode === 0 && !doneAborted && !signalAborted;
		const { normalized: normalizedSchema, error: schemaError } = normalizeSchema(outputSchema);
		const hasOutputSchema = normalizedSchema !== undefined && !schemaError;
		const fallback = allowFallback ? resolveFallbackCompletion(rawOutput, outputSchema) : null;
		if (fallback) {
			const { validator } = buildOutputValidator(outputSchema);
			const completeData = normalizeCompleteData(fallback.data, reportFindings, validator);
			const result = validator?.validate(completeData) ?? { success: true as const };
			if (!result.success) {
				const summary = summarizeValidationFailure(result, completeData, validator?.requiredFields ?? []);
				const outcome = buildSchemaViolationOutcome(summary, completeData);
				rawOutput = outcome.rawOutput;
				stderr = outcome.stderr;
				exitCode = outcome.exitCode;
			} else {
				try {
					rawOutput = JSON.stringify(completeData, null, 2) ?? "null";
				} catch (err) {
					const errorText = errorMessage(err);
					rawOutput = `{"error":"Failed to serialize fallback completion: ${errorText}"}`;
				}
				exitCode = 0;
				stderr = "";
			}
		} else if (!hasOutputSchema && allowFallback && rawOutput.trim().length > 0) {
			exitCode = 0;
			stderr = "";
		} else if (allowFallback) {
			// `allowFallback` rather than `exitCode === 0`: a cut-short turn gets no missing-yield
			// warning, because it was cancelled rather than disobedient, and the exit code that says so
			// comes from `resolveRunVerdict`. Before the verdict moved there, an aborted turn arrived
			// here with a non-zero exit code and this branch was skipped for that reason instead.
			const hasRawOutput = rawOutput.trim().length > 0;
			rawOutput = rawOutput ? `${SUBAGENT_WARNING_MISSING_YIELD}\n\n${rawOutput}` : SUBAGENT_WARNING_MISSING_YIELD;
			if (hasOutputSchema || !hasRawOutput) {
				exitCode = 1;
				stderr = SUBAGENT_WARNING_MISSING_YIELD;
			}
		}
	}

	return { rawOutput, exitCode, stderr, abortedViaYield, hasYield };
}

/**
 * Extract a short preview from tool args for display.
 */
function extractToolArgsPreview(args: Record<string, unknown>): string {
	// Priority order for preview
	const previewKeys = ["command", "file_path", "path", "pattern", "query", "url", "task", "prompt"];

	for (const key of previewKeys) {
		if (args[key] && typeof args[key] === "string") {
			const value = args[key] as string;
			return truncate(value, 60);
		}
	}

	return "";
}

function getNumberField(record: Record<string, unknown>, key: string): number | undefined {
	if (!Object.hasOwn(record, key)) return undefined;
	const value = record[key];
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function firstNumberField(record: Record<string, unknown>, keys: string[]): number | undefined {
	for (const key of keys) {
		const value = getNumberField(record, key);
		if (value !== undefined) return value;
	}
	return undefined;
}

/**
 * Tokens for progress display: input + output + cacheWrite per turn.
 *
 * Deliberately excludes cacheRead. With prompt caching, cacheRead in each turn
 * equals the full cached context (potentially hundreds of KB), so summing it
 * across all turns produces a cumulative total that is N×context_size — far
 * larger than the context window and misleading as a "work done" metric.
 * cacheWrite is kept because each byte is written once, not repeated per turn.
 * The cost segment handles billing; dedicated cache_read/cache_write segments
 * handle cache-specific monitoring.
 */
function getUsageTokens(usage: unknown): number {
	if (!usage || typeof usage !== "object") return 0;
	const record = usage as Record<string, unknown>;

	const input = firstNumberField(record, ["input", "input_tokens", "inputTokens"]) ?? 0;
	const output = firstNumberField(record, ["output", "output_tokens", "outputTokens"]) ?? 0;
	const cacheWrite = firstNumberField(record, ["cacheWrite", "cache_write", "cacheWriteTokens"]) ?? 0;
	const computed = input + output + cacheWrite;
	if (computed > 0) return computed;
	// Fallback for providers that only surface a pre-summed total without individual
	// field breakdown. This total includes cacheRead, but returning it is still better
	// than silently showing 0 for those providers.
	return firstNumberField(record, ["totalTokens", "total_tokens"]) ?? 0;
}

/**
 * Create proxy tools that reuse the parent's MCP connections.
 *
 * Each proxy delegates to the current source `MCPTool`/`DeferredMCPTool` rather
 * than rebuilding a raw `tools/call` request, so the Task/subagent path shares
 * the source tool's authoritative outbound boundary: harness-intent (`i`)
 * stripping, optional-placeholder pruning, local-URL resolution, reconnect
 * retry, abort handling, and result/provider metadata. The source tool is
 * re-resolved on every call by raw MCP server/tool metadata (not the normalized
 * display name), so a reconnect that swaps the instance in `getTools()` is
 * always honored. The proxy adds only the Task-specific 60s call timeout,
 * combining its abort signal with the caller's around source execution.
 */
export function createMCPProxyTools(mcpManager: MCPManager): CustomTool[] {
	return mcpManager.getTools().map(tool => {
		const serverName = tool.mcpServerName ?? "";
		const mcpToolName = tool.mcpToolName ?? "";
		return {
			name: tool.name,
			label: tool.label ?? tool.name,
			description: tool.description ?? "",
			parameters: tool.parameters,
			strict: tool.strict,
			mcpServerName: serverName,
			mcpToolName,
			execute: async (toolCallId, params, onUpdate, ctx, signal) => {
				if (signal?.aborted) {
					throw new ToolAbortError();
				}
				// Re-resolve by raw MCP metadata so a reconnect that replaced the
				// source instance is picked up; the display name alone is not enough.
				const source = mcpManager
					.getTools()
					.find(t => t.mcpServerName === serverName && t.mcpToolName === mcpToolName);
				if (!source?.execute) {
					return {
						content: [{ type: "text" as const, text: `MCP error: tool ${mcpToolName} no longer available` }],
						details: { serverName, mcpToolName, isError: true },
					};
				}
				try {
					const timeoutController = new AbortController();
					const timeoutSignal = timeoutController.signal;
					const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
					return await withAbortTimeout(
						Promise.resolve(source.execute(toolCallId, params, onUpdate, ctx, combinedSignal)),
						MCP_CALL_TIMEOUT_MS,
						signal,
						timeoutController,
					);
				} catch (error) {
					if (error instanceof ToolAbortError) {
						throw error;
					}
					return {
						content: [
							{
								type: "text" as const,
								text: `MCP error: ${errorMessage(error)}`,
							},
						],
						details: { serverName, mcpToolName, isError: true },
					};
				}
			},
		};
	});
}

export function createSubagentSettings(
	baseSettings: Settings,
	overrides?: Partial<Record<SettingPath, unknown>>,
	inheritedServiceTier?: ServiceTierByFamily | null,
): Settings {
	// Resolve the subagent's per-family tiers from `tier.subagent` ("inherit" =
	// match the parent's live tiers when a live session supplied them, else the
	// subagent's own configured tier.* settings). These and the headless safety
	// policies are genuine runtime overrides; global/project/config-file layers
	// stay separate so a later cwd clone can replace only its project policy.
	const inheritedTiers =
		inheritedServiceTier === undefined
			? buildServiceTierByFamily(
					baseSettings.get("tier.openai"),
					baseSettings.get("tier.anthropic"),
					baseSettings.get("tier.google"),
				)
			: (inheritedServiceTier ?? {});
	const subagentTiers = resolveSubagentServiceTier(baseSettings.get("tier.subagent"), inheritedTiers);
	return baseSettings.forkWithRuntimeOverrides({
		"tier.openai": subagentTiers.openai ?? "none",
		"tier.anthropic": subagentTiers.anthropic ?? "none",
		"tier.google": subagentTiers.google ?? "none",
		"async.enabled": false,
		"bash.autoBackground.enabled": false,

		// `tools.approvalMode` is DELIBERATELY ABSENT. A spawned agent INHERITS the
		// spawning session's rung through the fork's own settings layers; writing any
		// literal here would override the operator's choice with a value they never
		// configured. This used to be a hardcoded `"yolo"`, which meant a `read` of
		// /etc/passwd and a `bash` that spends a stored credential were UNGATED for
		// every subagent on a default install: the wrapper opts out of the
		// working-directory boundary and the secret-use boundary on exactly the
		// condition `approvalMode === "yolo"`. It also silently LOWERED a rung the
		// operator had raised, so delegating work one level down was a way around a
		// boundary the main session enforced. A spawn carries the parent's rung; it
		// never widens it and never arbitrarily narrows it.
		//
		// Per-tool `tools.approval` policies were already inherited the same way.
		...overrides,
	});
}

/**
 * Bind a subagent's settings to the directory it will run in.
 *
 * The destination contributes the cwd and nothing else. `cloneForCwd` copies
 * every configured layer verbatim and re-resolves only path-scoped values, so a
 * checked-in `.veyyon/settings.json` in a repo the operator merely cloned
 * decides nothing about the agent spawned into it.
 *
 * That is the fix for a real hole, not an incidental property. `tools.approvalMode`
 * was once an ordinary project-scoped setting: parent pinned to `ask`,
 * destination containing `{"tools.approvalMode":"yolo"}`, child resolved `yolo`,
 * which short-circuits the working-directory boundary and the secret-use
 * boundary in the tool wrapper. A clamp pinning the child back to the parent's
 * rung was built and then discarded on the ruling that a repository may
 * contribute nothing but `AGENTS.md` / `CLAUDE.md` context: narrowing the door
 * was the wrong fix, so the door went. Project scope is gone from every layer
 * (settings, rules, hooks, MCP, slash commands, custom tools, extension
 * modules, SSH hosts).
 *
 * `test/task/subagent-settings-cwd-provenance.test.ts` writes a hostile
 * `settings.json` into each destination and asserts it changes nothing.
 */
export async function createSubagentSettingsForCwd(
	baseSettings: Settings,
	cwd: string,
	overrides?: Partial<Record<SettingPath, unknown>>,
	inheritedServiceTier?: ServiceTierByFamily | null,
): Promise<Settings> {
	const runtimeFork = baseSettings.forkWithRuntimeOverrides();
	const destinationSettings = await runtimeFork.cloneForCwd(cwd);
	return createSubagentSettings(destinationSettings, overrides, inheritedServiceTier);
}

export type AbortReason = "signal" | "terminate" | "timeout" | "budget";

/** Inputs for the run monitor driving one subagent assignment. */
interface RunMonitorArgs {
	index: number;
	id: string;
	agent: AgentDefinition;
	task: string;
	assignment?: string;
	description?: string;
	/** Parent model registry for tiny-model label generation; absent → skip labeling. */
	modelRegistry?: ModelRegistry;
	/** Parent settings for tiny-model label generation. */
	settings?: Settings;
	obfuscateProviderText?: (text: string) => string;
	completeImpl?: SideCompleteImpl;
	modelOverride?: string | string[];
	signal?: AbortSignal;
	onProgress?: (progress: AgentProgress) => void;
	eventBus?: EventBus;
	parentToolCallId?: string;
	detached?: boolean;
	sessionFile?: string;
	/** Soft assistant-request budget; 0 disables the guard. */
	softRequestBudget: number;
	/** Whether crossing the soft budget injects a wrap-up steering notice. */
	softRequestBudgetNotice: boolean;
	/** Wall-clock cap in ms; 0 disables the timer. */
	maxRuntimeMs: number;
}

/**
 * The run-monitoring core of {@link runSubprocess}: progress tracking, event
 * processing, abort/budget machinery, usage accumulation, and output capture
 * for one assignment run.
 */
interface SubagentRunMonitor {
	readonly progress: AgentProgress;
	/** Fires when the run was asked to stop (caller signal, timeout, budget, terminate). */
	readonly abortSignal: AbortSignal;
	readonly accumulatedUsage: Usage;
	hasUsage(): boolean;
	yieldCalled(): boolean;
	runtimeLimitExceeded(): boolean;
	/** True once the soft-budget stop fired: the free-running turn was aborted and the run is being driven to a forced final yield. */
	budgetStopRequested(): boolean;
	/** Resolves when the budget-stop session abort has settled (immediately when no stop fired). */
	waitForBudgetStop(): Promise<void>;
	/** The abort kind for this run, when an abort was requested. */
	abortKind(): AbortReason | undefined;
	/** True when the abort carries a precise external reason (signal / wall-clock / budget). */
	hasExplicitAbortReason(): boolean;
	/** Whether the (attempted) abort counts as a cancelled run rather than an internal failure. */
	isAbortedRun(): boolean;
	requestAbort(reason: AbortReason): void;
	abortActiveSession(): Promise<void>;
	waitForActiveSessionAbort(): Promise<void>;
	resolveSignalAbortReason(): string;
	resolveAbortReasonText(): string;
	setActiveSession(session: AgentSession | null): void;
	/** Return and clear the active session reference. */
	takeActiveSession(): AgentSession | null;
	/** Subscribe the monitor to a session's events. Returns the unsubscribe function. */
	attach(session: AgentSession): () => void;
	/** Best-effort capture of the last assistant text for cancelled-run salvage. */
	captureSalvage(session: AgentSession): void;
	lastAssistantSalvageText(): string | undefined;
	/** Final raw output: end-of-run assistant text when available, else accumulated chunks. */
	rawOutput(): string;
	scheduleProgress(flush?: boolean): void;
	/** Stop processing events and clear listeners/timers. Call once the run settled. */
	finish(): void;
}

function createSubagentRunMonitor(args: RunMonitorArgs): SubagentRunMonitor {
	const {
		index,
		id,
		agent,
		task,
		assignment,
		signal,
		onProgress,
		softRequestBudget,
		softRequestBudgetNotice,
		maxRuntimeMs,
	} = args;
	const startTime = Date.now();

	const progress: AgentProgress = {
		index,
		id,
		agent: agent.name,
		agentSource: agent.source,
		status: "running",
		task,
		assignment,
		description: args.description,
		lastIntent: undefined,
		recentTools: [],
		recentOutput: [],
		toolCount: 0,
		requests: 0,
		tokens: 0,
		cost: 0,
		durationMs: 0,
		modelOverride: args.modelOverride,
	};

	const outputChunks: string[] = [];
	const finalOutputChunks: string[] = [];
	const RECENT_OUTPUT_TAIL_BYTES = 8 * 1024;
	// `recentOutputTail` holds the child's live output ALREADY DECODED for display,
	// never raw handles. Streamed deltas pass through `streamDecoder` (seam 3 in the
	// argot integration manual), which buffers a handle split across deltas so the
	// operator never sees a raw `§handle` in the live preview; `undefined` for an
	// `off`/unarmed child, which streams straight through.
	let recentOutputTail = "";
	let tailLastLineRepresentable = false;
	let streamDecoder: StreamDecoder | undefined;
	let streamDecoderReady = false;
	let resolved = false;
	let abortSent = false;
	let abortReason: AbortReason | undefined;
	let runtimeLimitExceeded = false;
	const listenerController = new AbortController();
	const listenerSignal = listenerController.signal;
	const abortController = new AbortController();
	const abortSignal = abortController.signal;
	let activeSession: AgentSession | null = null;
	let yieldCalled = false;
	let yieldCallPending = false;

	// Accumulate usage incrementally from message_end events (no memory for streaming events)
	const accumulatedUsage: Usage = { ...emptyUsage(), reasoningTokens: 0 };
	let hasUsage = false;
	let budgetSteerSent = false;
	let budgetLimitExceeded = false;
	let budgetStopRequested = false;
	let budgetStopAbortPromise: Promise<void> | undefined;
	let lastAssistantSalvageText: string | undefined;
	let activeSessionAbortPromise: Promise<void> | undefined;

	// Expand the child's own shorthand at the RETURN boundary before its raw
	// assistant text becomes the parent's tool result. See `expandSubagentReturn`
	// (argot-wire.ts) for why this seam exists; the only wrinkle here is that the
	// child codec lives on the currently-attached session.
	const expandChildOutput = (text: string): string => {
		try {
			return expandSubagentReturn(activeSession?.getArgotSession?.(), text);
		} catch (error) {
			logger.warn("Subagent return-boundary argot expansion failed", {
				error: errorMessage(error),
			});
			return text;
		}
	};

	const abortActiveSession = (): Promise<void> => {
		const session = activeSession;
		if (!session) return Promise.resolve();
		activeSessionAbortPromise ??= session.abort().catch(error => {
			logger.debug("Subagent session abort cleanup failed", {
				error: errorMessage(error),
			});
		});
		return activeSessionAbortPromise;
	};

	const waitForActiveSessionAbort = async (): Promise<void> => {
		if (activeSessionAbortPromise) await activeSessionAbortPromise;
	};

	const requestAbort = (reason: AbortReason) => {
		if (reason === "timeout") {
			runtimeLimitExceeded = true;
		}
		if (reason === "budget") {
			budgetLimitExceeded = true;
		}
		if (abortSent) {
			if (reason === "signal" && abortReason !== "signal" && abortReason !== "timeout") {
				abortReason = "signal";
			}
			return;
		}
		if (resolved) return;
		abortSent = true;
		abortReason = reason;
		abortController.abort();
		void abortActiveSession();
	};

	// Soft-budget stop: cancel the free-running turn WITHOUT aborting the
	// monitor, so driveSessionToYield can still drive one forced final yield.
	// Deliberately not routed through abortActiveSession(): that memoizes its
	// promise, and a later hard abort (grace exhausted) must be able to abort
	// the session again.
	const requestBudgetStop = () => {
		if (budgetStopRequested || abortSent || resolved) return;
		budgetStopRequested = true;
		const session = activeSession;
		budgetStopAbortPromise = session
			? session.abort().catch(error => {
					logger.debug("Subagent budget-stop abort failed", {
						error: errorMessage(error),
					});
				})
			: Promise.resolve();
	};

	// Handle abort signal
	if (signal) {
		signal.addEventListener(
			"abort",
			() => {
				if (!resolved) requestAbort("signal");
			},
			{ once: true, signal: listenerSignal },
		);
	}

	// Wall-clock hard limit. Defense-in-depth for the case where a provider stream
	// hang escapes the inference-layer watchdog (see openai-completions
	// `isOpenAICompletionsProgressChunk`). Disabled by default; set
	// `task.maxRuntimeMs > 0` to cap each subagent's lifetime.
	//
	// The budget bounds the AGENT's work, so it must not charge time the operator
	// spent deciding on an approval card. Aborting a child whose prompt is still
	// on screen is abandonment with extra steps: the operator answers for an agent
	// that is already dead, and the run is lost with no report. So the timer does
	// not abort on its first fire; it recomputes worked time with the approval
	// waits subtracted and re-arms for whatever remains.
	//
	// Subtraction rather than a pause/resume pair on purpose. A stop-and-rearm
	// clock has a failure direction this does not: a resume missed on any throw
	// path leaves the child with no cap at all, turning a bounded abandonment into
	// an unbounded one. Here a missed clear only ever makes the cap fire late, and
	// the registry stays the single source of truth for the interval.
	let runtimeTimeoutId: NodeJS.Timeout | undefined;
	if (maxRuntimeMs > 0) {
		const registry = AgentRegistry.global();
		const armRuntimeLimit = (delayMs: number) => {
			runtimeTimeoutId = setTimeout(
				() => {
					if (resolved) return;
					const now = Date.now();
					const openSince = registry.pendingApprovalSince(id);
					// Closed waits plus the one still open, if the child is blocked right
					// now. Reading only the open interval would under-credit a child that
					// has already answered several prompts and gone back to work.
					const waitedMs = registry.approvalWaitedMs(id) + (openSince === undefined ? 0 : now - openSince);
					const remainingMs = maxRuntimeMs - (now - startTime - waitedMs);
					if (remainingMs > 0) {
						armRuntimeLimit(remainingMs);
						return;
					}
					logger.warn("Subagent runtime limit exceeded; aborting", {
						id,
						agent: agent.name,
						maxRuntimeMs,
						approvalWaitedMs: waitedMs,
					});
					requestAbort("timeout");
				},
				Math.max(0, delayMs),
			);
		};
		armRuntimeLimit(maxRuntimeMs);
	}

	const resolveSignalAbortReason = (): string => {
		const reason = signal?.reason;
		if (reason instanceof Error) {
			const message = reason.message.trim();
			if (message.length > 0) return message;
		} else if (typeof reason === "string") {
			const message = reason.trim();
			if (message.length > 0) return message;
		}
		return "Cancelled by caller";
	};
	const resolveAbortReasonText = (): string => {
		if (runtimeLimitExceeded) {
			return `Subagent runtime limit exceeded (task.maxRuntimeMs=${maxRuntimeMs})`;
		}
		if (budgetLimitExceeded) {
			return `Soft request budget exceeded (${progress.requests} requests; budget ${softRequestBudget}) — agent did not yield when force-stopped`;
		}
		if (budgetStopRequested) {
			return `Soft request budget exceeded (${progress.requests} requests; budget ${softRequestBudget})`;
		}
		return resolveSignalAbortReason();
	};
	const PROGRESS_COALESCE_MS = 150;
	let lastProgressEmitMs = 0;
	let progressTimeoutId: NodeJS.Timeout | null = null;

	const emitProgressNow = () => {
		progress.durationMs = Date.now() - startTime;
		onProgress?.({ ...progress });
		const activityGist =
			progress.lastIntent ?? (progress.currentTool ? `running ${progress.currentTool}` : undefined);
		if (activityGist) AgentRegistry.global().setActivity(id, activityGist);
		if (args.eventBus) {
			args.eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, {
				index,
				agent: agent.name,
				agentSource: agent.source,
				task,
				parentToolCallId: args.parentToolCallId,
				detached: args.detached,
				assignment,
				progress: { ...progress },
				sessionFile: args.sessionFile,
			});
		}
		lastProgressEmitMs = Date.now();
	};

	const scheduleProgress = (flush = false) => {
		if (flush) {
			if (progressTimeoutId) {
				clearTimeout(progressTimeoutId);
				progressTimeoutId = null;
			}
			emitProgressNow();
			return;
		}
		const now = Date.now();
		const elapsed = now - lastProgressEmitMs;
		if (lastProgressEmitMs === 0 || elapsed >= PROGRESS_COALESCE_MS) {
			if (progressTimeoutId) {
				clearTimeout(progressTimeoutId);
				progressTimeoutId = null;
			}
			emitProgressNow();
			return;
		}
		if (progressTimeoutId) return;
		progressTimeoutId = setTimeout(() => {
			progressTimeoutId = null;
			emitProgressNow();
		}, PROGRESS_COALESCE_MS - elapsed);
	};

	// The task wire schema carries no description: when the caller didn't pre-set
	// a UI label (e.g. the eval bridge's `label`), compress the assignment into a
	// tiny-model one-sentence label off the spawn's critical path. Best-effort —
	// a late label still lands via the finalize-time reads of `progress.description`;
	// failures just leave the label unset.
	const labelSource = assignment?.trim();
	if (!args.description && args.modelRegistry && args.settings && labelSource) {
		generateTaskLabel(
			labelSource,
			args.modelRegistry,
			args.settings,
			id,
			args.obfuscateProviderText,
			args.completeImpl,
		)
			.then(label => {
				if (!label || abortSignal.aborted || progress.description) return;
				progress.description = label;
				if (!resolved) scheduleProgress();
			})
			.catch(err => {
				logger.debug("Subagent label generation failed", {
					id,
					error: errorMessage(err),
				});
			});
	}

	const getMessageContent = (message: unknown): unknown => {
		if (!isRecord(message) || !("content" in message)) {
			return undefined;
		}
		return message.content;
	};

	const getMessageUsage = (message: unknown): unknown => {
		if (!isRecord(message) || !("usage" in message)) {
			return undefined;
		}
		return message.usage;
	};

	// Lazily build the per-message stream decoder from the child's own codec, so a
	// codec armed just before prompting is picked up. `push`/`flush`/`reset` are the
	// only argot calls here; all handle logic lives in argot's StreamDecoder.
	const ensureStreamDecoder = (): StreamDecoder | undefined => {
		if (!streamDecoderReady) {
			streamDecoder = createSubagentStreamDecoder(activeSession?.getArgotSession?.());
			streamDecoderReady = true;
		}
		return streamDecoder;
	};

	// Decode one streamed delta for display. Identity when there is no codec.
	const decodeStreamDelta = (delta: string): string => {
		const decoder = ensureStreamDecoder();
		if (!decoder) return delta;
		try {
			return decoder.push(delta);
		} catch (error) {
			logger.warn("Subagent stream-display argot decode failed", { error: errorMessage(error) });
			return delta;
		}
	};

	// Release any handle fragment the decoder is holding at end of a message.
	const flushStreamDecoder = (): string => {
		const decoder = streamDecoder;
		if (!decoder) return "";
		try {
			return decoder.flush();
		} catch (error) {
			logger.warn("Subagent stream-display argot flush failed", { error: errorMessage(error) });
			return "";
		}
	};

	const updateRecentOutputLines = () => {
		const lines = recentOutputTail.split("\n");
		const filtered = lines.filter(line => line.trim());
		progress.recentOutput = filtered.slice(-8).reverse();
		// The tail's last raw segment (after its final newline) is "represented"
		// in recentOutput only when it trims non-empty — an empty/whitespace-only
		// trailing segment is filtered out, so recentOutput[0] is then the line
		// before it, not the tail's true last line.
		tailLastLineRepresentable = lines[lines.length - 1].trim().length > 0;
	};

	const appendRecentOutputTail = (text: string) => {
		if (!text) return;
		recentOutputTail += text;
		const truncated = recentOutputTail.length > RECENT_OUTPUT_TAIL_BYTES;
		if (truncated) {
			recentOutputTail = recentOutputTail.slice(-RECENT_OUTPUT_TAIL_BYTES);
		}
		// Fast path: a token without a newline only extends the current last line.
		// This runs on every text_delta token (hundreds/thousands per second while
		// streaming), so skip re-splitting the whole (up to 8KB) tail unless the line
		// structure actually changed. Requires no truncation AND the tail's last line
		// already represented (trims non-empty) — otherwise boundaries shift and a
		// full recompute is required. Appending to a non-empty line keeps it non-empty,
		// so the flag stays valid across consecutive fast-path tokens.
		if (truncated || text.includes("\n") || !tailLastLineRepresentable || progress.recentOutput.length === 0) {
			updateRecentOutputLines();
		} else {
			progress.recentOutput = [progress.recentOutput[0] + text, ...progress.recentOutput.slice(1)];
		}
	};

	const replaceRecentOutputFromContent = (content: unknown[]) => {
		// A full-content snapshot supersedes whatever the streaming decoder was
		// holding, and each text block is complete, so expand it whole (seam 2/4
		// call) rather than through the delta decoder. Drop the decoder's stale tail.
		streamDecoder?.reset();
		streamDecoderReady = false;
		recentOutputTail = "";
		for (const block of content) {
			if (!block || typeof block !== "object") continue;
			const record = block as { type?: unknown; text?: unknown };
			if (record.type !== "text" || typeof record.text !== "string") continue;
			if (!record.text) continue;
			recentOutputTail += expandChildOutput(record.text);
			if (recentOutputTail.length > RECENT_OUTPUT_TAIL_BYTES) {
				recentOutputTail = recentOutputTail.slice(-RECENT_OUTPUT_TAIL_BYTES);
			}
		}
		updateRecentOutputLines();
	};

	const resetRecentOutput = () => {
		streamDecoder?.reset();
		streamDecoder = undefined;
		streamDecoderReady = false;
		recentOutputTail = "";
		tailLastLineRepresentable = false;
		progress.recentOutput = [];
	};

	const emitSubagentEvent = (event: AgentSessionEvent) => {
		if (!args.eventBus) return;
		args.eventBus.emit(TASK_SUBAGENT_EVENT_CHANNEL, {
			id,
			event,
		});
	};

	const recordExtractedToolData = (toolName: string, data: unknown): void => {
		progress.extractedToolData = progress.extractedToolData || {};
		const existing = progress.extractedToolData[toolName] || [];
		const findingKey = toolName === "report_finding" ? getReportFindingKey(data) : null;
		if (findingKey) {
			const existingIndex = existing.findIndex(item => getReportFindingKey(item) === findingKey);
			if (existingIndex >= 0) {
				existing[existingIndex] = data;
			} else {
				existing.push(data);
			}
		} else {
			existing.push(data);
		}
		progress.extractedToolData[toolName] = existing;
		if (toolName === YIELD_TOOL_NAME) {
			yieldCalled = true;
			yieldCallPending = false;
		}
	};

	const processEvent = (event: AgentEvent) => {
		if (resolved) return;
		const now = Date.now();
		let flushProgress = false;

		switch (event.type) {
			case "message_start":
				if (event.message?.role === "assistant") {
					resetRecentOutput();
				}
				break;

			case "tool_execution_start": {
				progress.toolCount++;
				progress.currentTool = event.toolName;
				let startArgs: Record<string, unknown> = {};
				if ("toolArgs" in event && isRecord(event.toolArgs)) {
					startArgs = event.toolArgs;
				} else if (isRecord(event.args)) {
					startArgs = event.args;
				}
				progress.currentToolArgs = extractToolArgsPreview(startArgs);
				progress.currentToolStartMs = now;
				const intent = event.intent?.trim();
				if (intent) {
					progress.lastIntent = intent;
				}
				if (event.toolName === YIELD_TOOL_NAME && !yieldCalled) {
					yieldCallPending = true;
				}
				// Reset any prior in-flight task snapshot so we don't show stale
				// nested progress when the agent enters a fresh `task` call.
				if (event.toolName === "task") {
					progress.inflightTaskDetails = undefined;
				}
				break;
			}

			case "tool_execution_end": {
				if (progress.currentTool) {
					progress.recentTools.unshift({
						tool: progress.currentTool,
						args: progress.currentToolArgs || "",
						endMs: now,
					});
					// Keep only last 5
					if (progress.recentTools.length > 5) {
						progress.recentTools.pop();
					}
				}
				progress.currentTool = undefined;
				progress.currentToolArgs = undefined;
				progress.currentToolStartMs = undefined;
				// The finalized TaskToolDetails will be captured below into
				// `extractedToolData.task`; drop the in-flight snapshot so the
				// renderer doesn't double-count it against the final entry.
				if (event.toolName === "task") {
					progress.inflightTaskDetails = undefined;
				}

				// Check for registered subagent tool handler
				const handler = subprocessToolRegistry.getHandler(event.toolName);
				if (handler === undefined && event.toolName === YIELD_TOOL_NAME) {
					// FAIL LOUD, never silently. A yield with no handler is a broken build (see the
					// side-effect import at the top of this file), and the quiet version of this is what
					// hid it: the result is dropped, the subagent is asked again, and the run ends as a
					// missing-yield failure that names the subagent rather than the wiring.
					logger.error(
						`Subagent ${id} returned a ${YIELD_TOOL_NAME} result and no ${YIELD_TOOL_NAME} handler is registered on subprocessToolRegistry. ` +
							`The result cannot be read, so this run will report a missing yield. This is a build wiring fault, not a subagent fault: ` +
							`task/executor.ts must import tools/yield.ts for its registration side effect.`,
					);
				}
				const eventRecord: unknown = event;
				const eventArgs = isRecord(eventRecord) && isRecord(eventRecord.args) ? eventRecord.args : {};
				if (handler) {
					// Extract data using handler
					if (handler.extractData) {
						const data = handler.extractData({
							toolName: event.toolName,
							toolCallId: event.toolCallId,
							args: eventArgs,
							result: event.result,
							isError: event.isError,
						});
						if (data !== undefined) {
							recordExtractedToolData(event.toolName, data);
						}
					}

					if (event.toolName === YIELD_TOOL_NAME) {
						yieldCallPending = false;
					}

					// Check if handler wants to terminate the session
					if (
						handler.shouldTerminate?.({
							toolName: event.toolName,
							toolCallId: event.toolCallId,
							args: eventArgs,
							result: event.result,
							isError: event.isError,
						})
					) {
						requestAbort("terminate");
					}
				}
				flushProgress = true;
				break;
			}

			case "tool_execution_update": {
				// Surface nested-subagent progress mid-flight. The child task
				// tool emits incremental `onUpdate` calls carrying its current
				// `TaskToolDetails` (results + progress); we stash the latest
				// snapshot so the parent UI can render the in-flight subtree
				// without waiting for the call to finish.
				if (event.toolName === "task") {
					const partial = (event as { partialResult?: { details?: unknown } }).partialResult;
					const details = partial && typeof partial === "object" ? partial.details : undefined;
					if (details && typeof details === "object" && "results" in (details as TaskToolDetails)) {
						progress.inflightTaskDetails = details as TaskToolDetails;
						flushProgress = true;
					}
				}
				break;
			}

			case "message_update": {
				if (event.message?.role !== "assistant") break;
				const assistantEvent = (
					event as AgentEvent & {
						assistantMessageEvent?: { type?: string; delta?: string };
					}
				).assistantMessageEvent;
				if (assistantEvent?.type === "text_delta" && typeof assistantEvent.delta === "string") {
					appendRecentOutputTail(decodeStreamDelta(assistantEvent.delta));
					break;
				}
				if (assistantEvent && assistantEvent.type !== "text_delta") {
					break;
				}
				const updateContent =
					getMessageContent(event.message) || (event as AgentEvent & { content?: unknown }).content;
				if (updateContent && Array.isArray(updateContent)) {
					replaceRecentOutputFromContent(updateContent);
				}
				break;
			}

			case "message_end": {
				// Extract text from assistant and toolResult messages (not user prompts)
				const role = event.message?.role;
				if (role === "assistant") {
					progress.requests += 1;
					const eventContent = isRecord(event) && "content" in event ? event.content : undefined;
					const messageContent = getMessageContent(event.message) || eventContent;
					if (messageContent && Array.isArray(messageContent)) {
						for (const block of messageContent) {
							if (!isRecord(block)) continue;
							if (block.type === "text" && typeof block.text === "string") {
								outputChunks.push(expandChildOutput(block.text));
								continue;
							}
							if (block.type !== "toolCall" || typeof block.name !== "string") continue;
							if (block.name === YIELD_TOOL_NAME && !yieldCalled) {
								yieldCallPending = true;
								flushProgress = true;
							}
						}
						// The finalized content is authoritative and complete, so refresh
						// the live preview from it (fully decoded); this also resolves any
						// handle fragment the streaming decoder was still holding. If a
						// runtime streamed only deltas with no final snapshot, flush the
						// decoder's held tail into the preview instead.
						if (messageContent && Array.isArray(messageContent)) {
							replaceRecentOutputFromContent(messageContent);
						} else {
							appendRecentOutputTail(flushStreamDecoder());
						}
					}
					if (softRequestBudget > 0 && !abortSent && !yieldCallPending) {
						const stopThreshold = softRequestBudget * 1.5;
						if (budgetStopRequested) {
							// Grace window after the stop: the forced yield needs a
							// request or two; a child that keeps burning requests
							// instead of yielding is hard-aborted.
							if (progress.requests >= stopThreshold + BUDGET_STOP_GRACE_REQUESTS) {
								requestAbort("budget");
							}
						} else if (progress.requests >= stopThreshold) {
							requestBudgetStop();
						} else if (softRequestBudgetNotice && !budgetSteerSent && progress.requests >= softRequestBudget) {
							budgetSteerSent = true;
							const steerSession = activeSession;
							if (steerSession) {
								// Build the notice now (the count at crossing time), but send
								// behind an async boundary: a synchronously-throwing send must
								// never take down event processing (which escalates to terminate).
								const notice = buildBudgetNotice(progress.requests, softRequestBudget);
								void Promise.resolve()
									.then(() => steerSession.sendUserMessage(notice, { deliverAs: "steer" }))
									.catch(err => {
										logger.warn("Subagent budget steer failed", {
											error: errorMessage(err),
										});
									});
							}
						}
					}
				}
				// Extract and accumulate usage (prefer message.usage, fallback to event.usage)
				const eventUsage = isRecord(event) && "usage" in event ? event.usage : undefined;
				const messageUsage = getMessageUsage(event.message) || eventUsage;
				if (isRecord(messageUsage)) {
					// Only count assistant messages (not tool results, etc.)
					if (role === "assistant") {
						const costRecord = isRecord(messageUsage.cost) ? messageUsage.cost : undefined;
						hasUsage = true;
						accumulatedUsage.input += getNumberField(messageUsage, "input") ?? 0;
						accumulatedUsage.output += getNumberField(messageUsage, "output") ?? 0;
						accumulatedUsage.cacheRead += getNumberField(messageUsage, "cacheRead") ?? 0;
						accumulatedUsage.cacheWrite += getNumberField(messageUsage, "cacheWrite") ?? 0;
						accumulatedUsage.totalTokens += getNumberField(messageUsage, "totalTokens") ?? 0;
						accumulatedUsage.reasoningTokens =
							(accumulatedUsage.reasoningTokens ?? 0) + (getNumberField(messageUsage, "reasoningTokens") ?? 0);
						if (costRecord) {
							accumulatedUsage.cost.input += getNumberField(costRecord, "input") ?? 0;
							accumulatedUsage.cost.output += getNumberField(costRecord, "output") ?? 0;
							accumulatedUsage.cost.cacheRead += getNumberField(costRecord, "cacheRead") ?? 0;
							accumulatedUsage.cost.cacheWrite += getNumberField(costRecord, "cacheWrite") ?? 0;
							accumulatedUsage.cost.total += getNumberField(costRecord, "total") ?? 0;
							progress.cost = accumulatedUsage.cost.total;
						}
					}
					// Accumulate tokens for progress display
					progress.tokens += getUsageTokens(messageUsage);
					// Track latest per-turn context size so the UI can show
					// "current context", not just cumulative billing volume.
					if (role === "assistant") {
						const perTurnTotal = getNumberField(messageUsage, "totalTokens");
						if (perTurnTotal !== undefined && perTurnTotal > 0) {
							progress.contextTokens = perTurnTotal;
						}
					}
				}
				break;
			}

			case "agent_end":
				// Extract final content from assistant messages only (not user prompts)
				if (event.messages && Array.isArray(event.messages)) {
					for (const msg of event.messages) {
						if ((msg as { role?: string })?.role !== "assistant") continue;
						const messageContent = getMessageContent(msg);
						if (messageContent && Array.isArray(messageContent)) {
							for (const block of messageContent) {
								if (block.type === "text" && block.text) {
									finalOutputChunks.push(expandChildOutput(block.text));
								}
							}
						}
					}
				}
				flushProgress = true;
				break;
		}

		scheduleProgress(flushProgress);
	};

	const attach = (session: AgentSession): (() => void) =>
		session.subscribe(event => {
			emitSubagentEvent(event);
			if (event.type === "auto_retry_start") {
				progress.retryState = {
					attempt: event.attempt,
					maxAttempts: event.maxAttempts,
					delayMs: event.delayMs,
					errorMessage: event.errorMessage,
					startedAtMs: Date.now(),
					mode: event.mode,
				};
				progress.retryFailure = undefined;
				scheduleProgress(true);
				return;
			}
			if (event.type === "auto_retry_end") {
				const attempt = progress.retryState?.attempt ?? event.attempt;
				progress.retryState = undefined;
				if (!event.success) {
					progress.retryFailure = {
						attempt,
						errorMessage: event.finalError ?? "Auto-retry failed",
						mode: event.mode,
					};
				}
				scheduleProgress(true);
				return;
			}
			if (isAgentEvent(event)) {
				// Breadcrumb the synchronous subagent event handling so the loop
				// watchdog can attribute any block to this in-process subagent.
				pushLoopPhase(`subagent:${id}`);
				try {
					processEvent(event);
				} catch (err) {
					logger.error("Subagent event processing failed", {
						error: errorMessage(err),
					});
					requestAbort("terminate");
				} finally {
					popLoopPhase();
				}
			}
			if (event.type === "retry_fallback_applied") {
				// Remember the first model only. A chain that walks three deep still
				// fell back FROM the model the user picked, not from the second one.
				progress.fellBackFrom ??= progress.resolvedModel ?? event.from;
				progress.resolvedModel = event.to;
				scheduleProgress(true);
				return;
			}
			if (event.type === "retry_fallback_succeeded") {
				progress.resolvedModel = event.model;
				scheduleProgress(true);
				return;
			}
		});

	const captureSalvage = (session: AgentSession): void => {
		// Best-effort salvage: capture the last assistant text so
		// cancelled/aborted children can surface "last activity" instead of
		// "(no output)".
		try {
			const lastContent = session.getLastAssistantMessage()?.content;
			if (Array.isArray(lastContent)) {
				const text = lastContent
					.map(block => (block.type === "text" && typeof block.text === "string" ? block.text : ""))
					.filter(Boolean)
					.join("\n");
				if (text.trim()) {
					// Same return-boundary rule as the streamed chunks: the salvaged
					// last-turn text is handle-form and must expand through the child's
					// own codec before it can become the parent's tool result.
					lastAssistantSalvageText = expandSubagentReturn(session.getArgotSession?.(), text);
				}
			}
		} catch {
			// Salvage is best-effort; partial sessions may not implement it
		}
	};

	return {
		progress,
		abortSignal,
		accumulatedUsage,
		hasUsage: () => hasUsage,
		yieldCalled: () => yieldCalled,
		runtimeLimitExceeded: () => runtimeLimitExceeded,
		hasExplicitAbortReason: () =>
			abortReason === "signal" || runtimeLimitExceeded || budgetLimitExceeded || budgetStopRequested,
		budgetStopRequested: () => budgetStopRequested,
		waitForBudgetStop: () => budgetStopAbortPromise ?? Promise.resolve(),
		// A soft stop that never escalated still identifies as a budget abort so
		// the lifecycle can park the agent as resumable instead of killing it.
		abortKind: () => abortReason ?? (budgetStopRequested ? "budget" : undefined),
		isAbortedRun: () =>
			abortReason === "signal" || runtimeLimitExceeded || budgetLimitExceeded || abortReason === undefined,
		requestAbort,
		abortActiveSession,
		waitForActiveSessionAbort,
		resolveSignalAbortReason,
		resolveAbortReasonText,
		setActiveSession: session => {
			activeSession = session;
		},
		takeActiveSession: () => {
			const session = activeSession;
			activeSession = null;
			return session;
		},
		attach,
		captureSalvage,
		lastAssistantSalvageText: () => lastAssistantSalvageText,
		rawOutput: () => (finalOutputChunks.length > 0 ? finalOutputChunks.join("") : outputChunks.join("")),
		scheduleProgress,
		finish: () => {
			resolved = true;
			listenerController.abort();
			if (runtimeTimeoutId !== undefined) {
				clearTimeout(runtimeTimeoutId);
				runtimeTimeoutId = undefined;
			}
			if (progressTimeoutId) {
				clearTimeout(progressTimeoutId);
				progressTimeoutId = null;
			}
		},
	};
}

/**
 * What ONE turn of a subagent DID, as facts rather than as a verdict.
 *
 * The run's outcome is not decided here. It is decided once, by {@link resolveRunVerdict}, from
 * these facts plus what `finalizeSubprocessOutput` extracted from the child's yields. The split
 * matters because the two halves know different things: this function watched the turn, and only the
 * finalizer knows whether a result was actually delivered.
 *
 * Before this shape existed, four sites inside `driveSessionToYield` and a fifth inside
 * `runSubprocess` each classified the run themselves, and `finalizeRunResult` then re-derived the
 * same conclusion and silently overrode them. The copies did not agree, and the disagreement was
 * invisible because the last one to run won: mutating the flag they keyed on so it could never be
 * true left the whole lane green.
 */
interface DriveOutcome {
	/**
	 * A genuine failure: the turn threw for a reason that was not an abort, or the model reported an
	 * `error` stop. An abort is NOT a failure and never lands here.
	 */
	failure?: string;
	/**
	 * The turn did not end on its own: a signal fired, the model reported the turn aborted, or a soft
	 * budget stop cut it short without a yield.
	 *
	 * Kept separate from {@link DriveOutcome.turnAborted} because they answer different questions. A
	 * turn cut short cannot be reported as a clean success, even when the cut is an internal teardown
	 * the operator should see as a failure rather than as a cancellation.
	 */
	turnCutShort: boolean;
	/** The cut was a real cancellation of this run (caller signal, wall clock, or budget stop). */
	turnAborted: boolean;
	/** The most precise reason available for {@link DriveOutcome.turnAborted}. */
	turnAbortReason?: string;
}

const MAX_YIELD_RETRIES = 3;

/**
 * Drive one assignment through a live session: send the prompt, wait for idle,
 * remind the agent to `yield` (up to {@link MAX_YIELD_RETRIES} times), then
 * classify the terminal assistant state. A soft-budget stop short-circuits the
 * reminder ladder into a single forced final yield so partial findings still
 * come back as a real report.
 */
async function driveSessionToYield(
	session: AgentSession,
	monitor: SubagentRunMonitor,
	task: string,
	outputSchema: unknown,
): Promise<DriveOutcome> {
	const abortSignal = monitor.abortSignal;
	let failure: string | undefined;
	let turnCutShort = false;
	let turnAborted = false;
	let turnAbortReason: string | undefined;
	// Bookkeeping is deliberately absent here: an abort's MEANING is resolved once, in the `finally`
	// below, from the state the turn actually ended in. Recording it at every throw site is what let
	// four copies of the rule drift apart.
	const checkAbort = () => {
		if (abortSignal.aborted) throw new ToolAbortError();
	};
	const awaitAbortable = async <T>(promise: Promise<T>): Promise<T> => {
		checkAbort();
		const { promise: abortPromise, reject } = Promise.withResolvers<never>();
		const onAbort = () => {
			try {
				checkAbort();
			} catch (err) {
				reject(err);
			}
		};
		abortSignal.addEventListener("abort", onAbort, { once: true });
		try {
			return await Promise.race([promise, abortPromise]);
		} finally {
			abortSignal.removeEventListener("abort", onAbort);
		}
	};

	try {
		try {
			await awaitAbortable(session.prompt(task, { attribution: "agent" }));
			await awaitAbortable(session.waitForIdle());
		} catch (err) {
			// A budget stop cancels the free-running turn by aborting the
			// session, which can surface here as a rejected prompt. Swallow it
			// and drive the forced final yield below; real caller/timeout
			// aborts (monitor signal) and genuine failures keep the old path.
			if (!monitor.budgetStopRequested() || abortSignal.aborted) throw err;
		}

		const reminderToolChoice = buildNamedToolChoice(YIELD_TOOL_NAME, session.model);

		let retryCount = 0;
		while (!monitor.yieldCalled() && retryCount < MAX_YIELD_RETRIES && !abortSignal.aborted) {
			// A budget stop collapses the reminder ladder to a single forced
			// final yield: wait for the stop's session abort to settle, then
			// prompt once with the wrap-up reminder + named tool choice.
			const budgetStop = monitor.budgetStopRequested();
			if (budgetStop) {
				retryCount = MAX_YIELD_RETRIES - 1;
				await monitor.waitForBudgetStop();
				if (monitor.yieldCalled() || abortSignal.aborted) break;
			}
			// Skip reminders when the model returned a terminal error (e.g.
			// rate-limit cap hit, auth failure). Re-prompting would just
			// hit the same wall, multiplying the failure noise without
			// any chance of producing a yield.
			const lastBeforeReminder = session.getLastAssistantMessage();
			if (lastBeforeReminder?.stopReason === "error") break;
			try {
				retryCount++;
				const reminder = prompt.render(subagentPrompts["subagent/yield-reminder"].text, {
					retryCount,
					maxRetries: MAX_YIELD_RETRIES,
					budgetStop,
				});

				const isFinalRetry = retryCount >= MAX_YIELD_RETRIES;
				await awaitAbortable(
					session.prompt(reminder, {
						attribution: "agent",
						synthetic: true,
						...(isFinalRetry && reminderToolChoice ? { toolChoice: reminderToolChoice } : {}),
					}),
				);
				await awaitAbortable(session.waitForIdle());
			} catch (err) {
				if (abortSignal.aborted || err instanceof ToolAbortError) {
					// Benign control-flow exit — user cancel (^C) or compaction aborting
					// pending operations both surface here as ToolAbortError. The outer
					// catch and finally already mark the run aborted; logging at ERROR
					// would spam operator dashboards with non-failures.
					logger.debug("Subagent prompt aborted");
				} else {
					logger.error("Subagent prompt failed", {
						error: errorMessage(err),
					});
				}
			}
		}

		const schemaFailure = abortSignal.aborted ? undefined : currentYieldSchemaFailure(monitor.progress, outputSchema);
		if (schemaFailure) {
			try {
				await awaitAbortable(
					session.prompt(
						prompt.render(subagentPrompts["subagent/yield-schema-repair"].text, { failure: schemaFailure }),
						{
							attribution: "agent",
							synthetic: true,
							...(reminderToolChoice ? { toolChoice: reminderToolChoice } : {}),
						},
					),
				);
				await awaitAbortable(session.waitForIdle());
			} catch (err) {
				if (abortSignal.aborted || err instanceof ToolAbortError) {
					logger.debug("Subagent schema repair prompt aborted");
				} else {
					logger.error("Subagent schema repair prompt failed", { error: errorMessage(err) });
				}
			}
		}

		if (monitor.yieldCalled()) {
			await session.waitForIdle();
		} else {
			await awaitAbortable(session.waitForIdle());
		}
	} catch (err) {
		// An abort is not a failure: it is reported as one of the two abort facts below, and whether it
		// costs the run its result depends on whether a yield landed, which this function cannot see.
		if (!abortSignal.aborted) {
			failure ??= err instanceof Error ? err.stack || err.message : String(err);
		}
	} finally {
		const lastAssistant = session.getLastAssistantMessage();
		if (lastAssistant?.stopReason === "error") {
			failure ??= lastAssistant.errorMessage || "Subagent failed";
		}
		// A budget stop that produced no yield cut the turn short even though no signal named it: the
		// stop cancels the free-running turn, the forced wrap-up reminder is the child's last chance,
		// and silence there means the budget ended the run.
		const budgetStopWithoutYield = monitor.budgetStopRequested() && !monitor.yieldCalled();
		turnCutShort = abortSignal.aborted || lastAssistant?.stopReason === "aborted" || budgetStopWithoutYield;
		// A cut turn is a CANCELLATION only when the abort belongs to this run. An internal teardown
		// (a tool event handler failing, which aborts the session to stop the run) sets an abort reason
		// of its own and `isAbortedRun` is false for it, so it stays a failure rather than being
		// reported to the operator as though someone cancelled. A soft budget stop needs no term of its
		// own here: it reaches this line through `turnCutShort` and leaves no explicit abort reason, so
		// `isAbortedRun` is true for it. Adding one was redundant and no test could tell the difference.
		turnAborted = turnCutShort && monitor.isAbortedRun();
		if (turnAborted) {
			// A caller signal or the wall-clock timer carries a precise reason (signal.reason,
			// "runtime limit exceeded"). An internal turn abort does NOT, so the assistant message's
			// own errorMessage ("Request was aborted", or a specific stream error) beats the
			// misleading "Cancelled by caller".
			turnAbortReason = monitor.hasExplicitAbortReason()
				? monitor.resolveAbortReasonText()
				: lastAssistant?.errorMessage?.trim() || monitor.resolveAbortReasonText();
		}
	}

	return { failure, turnCutShort, turnAborted, turnAbortReason };
}

interface FinalizeRunArgs {
	monitor: SubagentRunMonitor;
	/** The turn's facts (see {@link DriveOutcome}) plus how long the run took. */
	done: DriveOutcome & { durationMs: number };
	index: number;
	id: string;
	agent: AgentDefinition;
	task: string;
	assignment?: string;
	modelOverride?: string | string[];
	outputSchema?: unknown;
	signal?: AbortSignal;
	artifactsDir?: string;
	eventBus?: EventBus;
	parentToolCallId?: string;
	detached?: boolean;
	sessionFile?: string;
	startTime: number;
}

/**
 * The text that goes in a settled run's `error` field, or `undefined` when the
 * run did not fail.
 *
 * This is the one channel a parent reads to learn what went wrong, and it used
 * to be left EMPTY for the worst case. A crashed subagent settles with a
 * non-zero exit code, no stderr, and no output: an out-of-memory kill and a
 * native crash both look exactly like that. The old condition
 * (`exitCode !== 0 && stderr`) produced no error text for it, so a child that
 * died was indistinguishable from a child that simply had nothing to report,
 * precisely when the difference mattered most.
 *
 * The synthesized message is not a diagnosis. It states that no diagnosis was
 * available and what that usually means, which is the useful fact: it tells the
 * parent to stop waiting for a reason and to suspect resources rather than to
 * retry the same prompt.
 *
 * An ABORTED run is excluded on purpose. Its explanation lives on `abortReason`
 * (a cancellation, a budget stop, a runtime limit), and `error` is deliberately
 * left empty there so callers read the reason rather than a second, vaguer copy
 * of it. Guessing "it most likely crashed or ran out of memory" for a run the
 * parent itself cancelled would be actively wrong.
 */
export function resolveSubagentErrorText(
	exitCode: number,
	stderr: string,
	rawOutput: string,
	aborted: boolean,
): string | undefined {
	if (exitCode === 0) return undefined;
	const reported = stderr.trim();
	if (reported) return reported;
	if (aborted) return undefined;
	const produced = rawOutput.trim().length > 0 ? "" : " and produced no output";
	return `Subagent exited with code ${exitCode}${produced} and reported no error. It most likely crashed or was killed (out of memory, or terminated by the operating system).`;
}

/**
 * THE run verdict: exit code, aborted, and why, decided in ONE place.
 *
 * Everything upstream reports facts. `driveSessionToYield` says what the turn did
 * ({@link DriveOutcome}); `finalizeSubprocessOutput` says what was delivered (whether any yield
 * landed, whether the child yielded an abort, and the exit code that follows from the payload). This
 * function is the only thing that turns those into an outcome, so there is exactly one place to read
 * and one place to change.
 *
 * THE RULES, stated once:
 *
 * - A delivered yield means the subagent's work exists and belongs to the caller, so an abort around
 *   it does not fail the run. This is why `hasYield` gates the abort terms rather than being weighed
 *   against them.
 * - A blown wall clock overrides everything, including a yield that landed while the session was
 *   being torn down: a run that exceeded its runtime is not one whose result you want to trust.
 * - A yielded abort is the child reporting its own cancellation. It keeps exit code 0, because the
 *   child answered, and it still reports as aborted, because the answer was "I stopped".
 * - A turn cut short with nothing delivered cannot report success, even when the cut was an internal
 *   teardown rather than a cancellation. That case fails without being called aborted.
 *
 * Both halves of the first two rules are pinned by `test/task/executor-yield-versus-caller-abort.test.ts`,
 * `test/task/executor-wall-clock.test.ts`, and the verdict matrix in `test/task/run-verdict.test.ts`.
 */
export interface RunVerdictInputs {
	/** The exit code `finalizeSubprocessOutput` arrived at from the payload. */
	readonly exitCodeAfterFinalize: number;
	readonly hasYield: boolean;
	readonly abortedViaYield: boolean;
	/** The reason carried by a child's own aborted yield. */
	readonly yieldAbortReason?: string;
	readonly runtimeLimitExceeded: boolean;
	readonly turnCutShort: boolean;
	readonly turnAborted: boolean;
	readonly turnAbortReason?: string;
	/** The CALLER's signal, which aborts the run even when the turn never noticed. */
	readonly callerAborted: boolean;
	/** Reason resolvers, consulted only for the case each one owns. */
	readonly resolveAbortReason: () => string | undefined;
	readonly resolveSignalAbortReason: () => string | undefined;
}

export interface RunVerdict {
	readonly exitCode: number;
	readonly aborted: boolean;
	readonly abortReason?: string;
}

export function resolveRunVerdict(inputs: RunVerdictInputs): RunVerdict {
	let exitCode = inputs.exitCodeAfterFinalize;
	// The wall clock first, and independent of everything else: a late yield must not buy back a
	// timed-out run's success.
	if (inputs.runtimeLimitExceeded && exitCode === 0) exitCode = 1;

	const aborted =
		inputs.runtimeLimitExceeded ||
		inputs.abortedViaYield ||
		(!inputs.hasYield && (inputs.turnAborted || inputs.callerAborted));

	// A cut turn that delivered nothing cannot pass. `abortedViaYield` is excluded because the child
	// DID answer, and its answer is worth zero exit code plus an aborted status.
	if (!inputs.hasYield && inputs.turnCutShort && !inputs.abortedViaYield && exitCode === 0) exitCode = 1;

	if (!aborted) return { exitCode, aborted: false };

	const abortReason = inputs.runtimeLimitExceeded
		? inputs.resolveAbortReason()
		: inputs.abortedViaYield
			? inputs.yieldAbortReason
			: (inputs.turnAbortReason ??
				(inputs.callerAborted ? inputs.resolveSignalAbortReason() : inputs.resolveAbortReason()));
	return { exitCode, aborted: true, abortReason };
}

/**
 * Turn a settled run into a {@link SingleResult}: resolve the yield payload via
 * {@link finalizeSubprocessOutput}, salvage cancelled-run output, write the
 * `<id>.md` output artifact, flush final progress, and emit the lifecycle end
 * event.
 */
async function finalizeRunResult(args: FinalizeRunArgs): Promise<SingleResult> {
	const { monitor, done, index, id, agent, task, assignment, signal, modelOverride } = args;
	const progress = monitor.progress;
	// The turn's own failure is the only exit code the finalizer starts from. Whether an abort costs
	// the run its success is `resolveRunVerdict`'s call, made below once the payload is known.
	let exitCode = done.failure ? 1 : 0;
	let stderr = done.failure ?? "";

	// Use final output if available, otherwise accumulated output
	let rawOutput = monitor.rawOutput();
	const yieldItems = progress.extractedToolData?.yield as YieldItem[] | undefined;
	const reportFindingDetails = progress.extractedToolData?.report_finding as ReportFindingDetails[] | undefined;
	const reportFindings: ReviewFinding[] | undefined = reportFindingDetails?.map(toReviewFinding);
	// Breadcrumb the synchronous yield-payload shaping (O(rawOutput)) so a block
	// here is attributed to this subagent rather than logged as "unknown".
	pushLoopPhase(`subagent:${id}`);
	let finalized: FinalizeSubprocessOutputResult;
	try {
		finalized = finalizeSubprocessOutput({
			rawOutput,
			exitCode,
			stderr,
			doneAborted: done.turnCutShort,
			signalAborted: Boolean(signal?.aborted),
			yieldItems,
			reportFindings,
			outputSchema: args.outputSchema,
			lastAssistantText: monitor.lastAssistantSalvageText(),
		});
	} finally {
		popLoopPhase();
	}
	rawOutput = finalized.rawOutput;
	exitCode = finalized.exitCode;
	stderr = finalized.stderr;
	// Salvage for cancelled/aborted children that produced no completed output:
	// surface the last assistant text + stats instead of "(no output)" so the
	// parent doesn't redo work the child already finished.
	const salvageText = monitor.lastAssistantSalvageText();
	if (
		(done.turnCutShort || signal?.aborted || monitor.runtimeLimitExceeded()) &&
		!rawOutput.trim() &&
		salvageText !== undefined
	) {
		rawOutput = `[cancelled after ${progress.requests} req, ${progress.tokens} tok — last activity: "${formatSalvageSnippet(salvageText)}"]`;
	}
	const lastYield = yieldItems?.[yieldItems.length - 1];
	const yieldAbortReason = lastYield?.status === "aborted" ? lastYield.error || "Subagent aborted task" : undefined;
	const { abortedViaYield, hasYield } = finalized;
	const { content: truncatedOutput, truncated } = truncateTail(rawOutput, {
		maxBytes: MAX_OUTPUT_BYTES,
		maxLines: MAX_OUTPUT_LINES,
	});

	// Write output artifact (input and jsonl already written in real-time)
	// Compute output metadata for agent:// URL integration
	let outputMeta: { lineCount: number; charCount: number } | undefined;
	let outputPath: string | undefined;
	if (args.artifactsDir) {
		outputPath = path.join(args.artifactsDir, `${id}.md`);
		try {
			await Bun.write(outputPath, rawOutput);
			outputMeta = {
				lineCount: rawOutput.split("\n").length,
				charCount: rawOutput.length,
			};
		} catch {
			// Non-fatal
		}
	}

	// The one place the run's outcome is decided. The yield payload is settled by now, which is why
	// the call happens here and not in the turn loop: `hasYield` is the fact every abort rule turns on.
	const verdict = resolveRunVerdict({
		exitCodeAfterFinalize: exitCode,
		hasYield,
		abortedViaYield,
		yieldAbortReason,
		runtimeLimitExceeded: monitor.runtimeLimitExceeded(),
		turnCutShort: done.turnCutShort,
		turnAborted: done.turnAborted,
		turnAbortReason: done.turnAbortReason,
		callerAborted: Boolean(signal?.aborted),
		resolveAbortReason: () => monitor.resolveAbortReasonText(),
		resolveSignalAbortReason: () => monitor.resolveSignalAbortReason(),
	});
	exitCode = verdict.exitCode;
	const wasAborted = verdict.aborted;
	const finalAbortReason = verdict.abortReason;
	progress.status = wasAborted ? "aborted" : exitCode === 0 ? "completed" : "failed";
	monitor.scheduleProgress(true);

	// Emit lifecycle end event after finalization so yield status is reflected
	if (args.eventBus) {
		args.eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id,
			agent: agent.name,
			parentToolCallId: args.parentToolCallId,
			detached: args.detached,
			agentSource: agent.source,
			description: progress.description,
			status: progress.status as "completed" | "failed" | "aborted",
			sessionFile: args.sessionFile,
			index,
		});
	}

	return {
		index,
		id,
		agent: agent.name,
		agentSource: agent.source,
		task,
		assignment,
		description: progress.description,
		lastIntent: progress.lastIntent,
		exitCode,
		output: truncatedOutput,
		stderr,
		truncated: Boolean(truncated),
		durationMs: Date.now() - args.startTime,
		tokens: progress.tokens,
		requests: progress.requests,
		contextTokens: progress.contextTokens,
		contextWindow: progress.contextWindow,
		modelOverride,
		resolvedModel: progress.resolvedModel,
		error: resolveSubagentErrorText(exitCode, stderr, rawOutput, wasAborted),
		aborted: wasAborted,
		abortReason: finalAbortReason,
		usage: monitor.hasUsage() ? monitor.accumulatedUsage : undefined,
		outputPath,
		extractedToolData: progress.extractedToolData,
		retryFailure: progress.retryFailure,
		outputMeta,
	};
}

/**
 * Whether an agent's sign-off says it stopped to wait on another agent, which earns
 * it the longer close budget.
 *
 * WHAT IT IS GIVEN. Callers pass {@link subagentSignOffText}, which is the agent's
 * LAST assistant message when that message carried text, and the run's accumulated
 * assistant text only when it did not. This comment used to say "last message" while
 * every caller handed it `monitor.rawOutput()`, which is every assistant message of
 * the run concatenated. That was a false description of what the matcher reads, and
 * it made the position rules below read as if they applied to a sign-off when they
 * were being applied to a whole transcript.
 *
 * The scan is cheap either way and never reaches a model, so it costs no tokens:
 * measured at roughly 11 microseconds per KiB, 4.6 ms on 424 KiB, and 2.4 ms on a
 * 203 KiB string built entirely from "The fix was worth waiting for", which is the
 * adversarial shape for this pattern and shows no backtracking blowup. Cost is not
 * the reason to prefer the sign-off; accuracy is.
 *
 * The phrase alone is not enough. "waiting for" carries two unrelated meanings and
 * the surface form is identical: "waiting for the audit to finish" is a self-report,
 * "worth waiting for the rebuild to prove" is a comment about something else. So the
 * match requires the report POSITION as well as the words. The clause has to open a
 * sentence ("Waiting on SourceLfsGates"), follow a label ("Blocked: waits for X"), or
 * follow a subject that makes the agent the one waiting ("I am waiting on the
 * reviewer", "still waiting for review").
 *
 * A line's leading list or quote marker counts as the start of the clause, because a
 * bulleted status line ("- Waiting on ReviewBot") is the single most common way an
 * agent writes this and is exactly the self-report shape. The marker class only ever
 * lets the clause begin a line: anything else between the marker and the verb, as in
 * "- The fix was worth waiting for", still fails to match.
 *
 * A false positive only lengthens the grace and a false negative only shortens it to
 * the ordinary one, so the failure direction is a ref that lingers rather than one
 * that vanishes while still needed. That asymmetry is why a phrase match is
 * acceptable here at all; nothing about correctness depends on it.
 */
const WAITING_ON_PEER =
	/(?:^[\s>*\-+\d.)\]]*|[.!?:;]\s+|\b(?:i am|i'm|am|is|are|still|currently|now)\s+)wait(?:ing|s)\s+(?:on|for)\b/im;

export function saysItIsWaitingOnAPeer(signOff: string | undefined): boolean {
	return signOff !== undefined && WAITING_ON_PEER.test(signOff);
}

/**
 * The text a finished agent signed off with, for {@link saysItIsWaitingOnAPeer}.
 *
 * `monitor.rawOutput()` is not that. It is `finalOutputChunks` joined, filled from
 * the `agent_end` event's `messages`, which the agent loop supplies as every message
 * the run produced: on a long run it is the whole transcript's assistant prose, so a
 * "waiting on X" line written forty turns earlier and long since resolved reads as
 * the agent's current state. `captureSalvage` has already recorded the LAST assistant
 * message's text by the time either caller runs, and that is the sign-off.
 *
 * The fallback matters and is deliberately the broad one. An agent whose final
 * message was a bare `yield` tool call left no salvage text, and reading nothing
 * there would deny the longer grace to exactly the agents that stopped to wait,
 * which is the harmful direction: a peer the operator is about to message gets
 * dropped. Over-matching only makes a ref linger.
 */
function subagentSignOffText(monitor: SubagentRunMonitor): string | undefined {
	return monitor.lastAssistantSalvageText() ?? monitor.rawOutput();
}

/**
 * Settle a subagent's registry lifecycle after a run: terminal teardown for
 * hard aborts, unregister for one-shot helpers, park for isolated runs, and
 * idle + lifecycle adoption for kept-alive agents. A soft-budget abort on a
 * kept-alive, revivable agent is treated as a self-inflicted stop rather than
 * a kill — the agent stays interrogable and resumable (irc wake / revival).
 */
export async function finalizeSubagentLifecycle(args: {
	id: string;
	session: AgentSession;
	aborted: boolean;
	/** Which watchdog (if any) requested the abort; decides revivability. */
	abortKind?: AbortReason;
	keepAlive: boolean;
	isolated: boolean;
	agentIdleTtlMs: number;
	/** Close budgets for the parked ref; absent keeps it listed until exit. */
	autoClose?: SubagentAutoCloseBudget;
	/**
	 * The agent's sign-off (see the resolver beside {@link saysItIsWaitingOnAPeer}),
	 * read only to decide whether it stopped to wait on a peer.
	 */
	signOff?: string;
	reviveSession: (() => Promise<AgentSession>) | null;
}): Promise<void> {
	const registry = AgentRegistry.global();
	const disposeSession = async (): Promise<void> => {
		// scopedTimeoutSignal clears the 5s cleanup deadline the moment dispose()
		// settles, so a bare AbortSignal.timeout timer never outlives disposal and
		// piles up under a burst of subagent teardowns.
		const { signal, cancel } = scopedTimeoutSignal(5000);
		try {
			await untilAborted(signal, () => args.session.dispose());
		} catch {
			// Ignore cleanup errors
		} finally {
			cancel();
		}
	};

	// A budget abort leaves a consistent session with its transcript on disk;
	// caller signals, wall-clock timeouts (possible stream hang), and internal
	// terminations are genuine kills and stay terminal.
	const resumableAbort =
		args.abortKind === "budget" && args.keepAlive && !args.isolated && args.reviveSession !== null;
	if (args.aborted && !resumableAbort) {
		registry.setStatus(args.id, "aborted");
		await disposeSession();
		// `AgentRef.session` is null exactly when parked or aborted, and until this
		// call it was not: the flip to "aborted" left the disposing session hanging off
		// the ref, and `ensureLive` returns `ref.session` whenever it is set, so a wake
		// arriving inside the dispose window was handed a session being torn down. The
		// sdk's dispose wrapper unregisters any ref that is not parked, so this ref is
		// usually gone a moment later and needs no close budget of its own, but "usually
		// gone" is not the invariant the field documents.
		registry.detachSession(args.id);
		return;
	}

	if (!args.keepAlive) {
		// One-shot helper: dispose and unregister. No IRC, no revival.
		await disposeSession();
		registry.unregister(args.id);
		return;
	}

	if (args.isolated) {
		// Isolated run: the worktree is merged + cleaned after the run, so
		// the session is not resumable. Park the ref WITHOUT a reviver: the
		// transcript stays reachable (history://), but ensureLive will throw.
		// Status must flip to "parked" before dispose so the sdk dispose
		// wrapper skips unregister.
		registry.setWaitingOnPeer(args.id, saysItIsWaitingOnAPeer(args.signOff));
		registry.setStatus(args.id, "parked");
		await disposeSession();
		registry.detachSession(args.id);
		// Adopted only to arm the close, with no idle stage (it is already parked) and
		// no reviver (there is nothing to revive into). These are the refs it matters
		// most for: an isolated agent can never be woken, so leaving it listed offers
		// the operator a peer that cannot answer. Adopting after the status flip is
		// what lets the close deadline read `parked` and arm immediately.
		AgentLifecycleManager.global().adopt(args.id, {
			idleTtlMs: 0,
			closeParkedMs: args.autoClose?.parkedMs ?? 0,
			closeWaitingMs: args.autoClose?.waitingMs ?? 0,
		});
		return;
	}

	// Keep-alive: finished and failed subagents both stay interrogable.
	// The lifecycle manager owns idle-TTL parking + revival from here on, and the
	// close budgets decide how long the parked ref survives after that.
	registry.setWaitingOnPeer(args.id, saysItIsWaitingOnAPeer(args.signOff));
	registry.setStatus(args.id, "idle");
	AgentLifecycleManager.global().adopt(args.id, {
		idleTtlMs: args.agentIdleTtlMs,
		closeParkedMs: args.autoClose?.parkedMs ?? 0,
		closeWaitingMs: args.autoClose?.waitingMs ?? 0,
		revive: args.reviveSession ?? undefined,
	});
}

/** Options for {@link runSubagentFollowUpTurn}. */
export interface FollowUpTurnOptions {
	/** Registry id of the (live or parked) subagent to continue. */
	id: string;
	/** Agent definition the session was originally spawned with (drives progress labels + finalize). */
	agent: AgentDefinition;
	/** The follow-up message; sent as the turn's user prompt. */
	message: string;
	index?: number;
	description?: string;
	signal?: AbortSignal;
	onProgress?: (progress: AgentProgress) => void;
	eventBus?: EventBus;
	parentToolCallId?: string;
	/** When set, the turn's raw output is (re)written to `<artifactsDir>/<id>.md` so `agent://<id>` tracks the latest turn. */
	artifactsDir?: string;
	/** Wall-clock cap in ms for this turn; 0 disables. */
	maxRuntimeMs?: number;
}

/**
 * Continue a previously spawned (keep-alive) subagent with one more monitored
 * turn: revive it if parked, send `message` as a real prompt, drive it to
 * `yield`, and finalize a {@link SingleResult} exactly like a first run.
 *
 * The session's full conversation history is retained (live session, or JSONL
 * replay through the lifecycle reviver), so the turn sees all prior context.
 * Unlike {@link runSubprocess}, the session is NOT torn down afterwards — it
 * stays adopted by the {@link AgentLifecycleManager} (idle → TTL park →
 * revive), and an aborted turn only aborts the in-flight turn.
 */
export async function runSubagentFollowUpTurn(options: FollowUpTurnOptions): Promise<SingleResult> {
	const { id, agent, message, signal } = options;
	const index = options.index ?? 0;
	const startTime = Date.now();
	const session = await AgentLifecycleManager.global().ensureLive(id);
	const ref = AgentRegistry.global().get(id);
	const sessionFile = ref?.sessionFile ?? undefined;

	const monitor = createSubagentRunMonitor({
		index,
		id,
		agent,
		task: message,
		description: options.description,
		signal,
		onProgress: options.onProgress,
		eventBus: options.eventBus,
		parentToolCallId: options.parentToolCallId,
		detached: true,
		sessionFile,
		softRequestBudget: 0,
		softRequestBudgetNotice: false,
		maxRuntimeMs: options.maxRuntimeMs ?? 0,
	});

	if (options.eventBus) {
		options.eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id,
			agent: agent.name,
			parentToolCallId: options.parentToolCallId,
			detached: true,
			agentSource: agent.source,
			description: options.description,
			status: "started",
			sessionFile,
			index,
		});
	}

	monitor.setActiveSession(session);
	const unsubscribe = monitor.attach(session);
	let outcome: DriveOutcome;
	try {
		outcome = await driveSessionToYield(session, monitor, message, agent.output);
	} finally {
		const { signal, cancel } = scopedTimeoutSignal(5000);
		try {
			await untilAborted(signal, () => monitor.waitForActiveSessionAbort());
		} catch {
			// Ignore abort cleanup timeouts; the session stays adopted either way.
		} finally {
			cancel();
		}
		unsubscribe();
		const active = monitor.takeActiveSession();
		if (active) monitor.captureSalvage(active);
		monitor.finish();
		// The waiting flag describes the agent's LATEST word, not its first. A follow-up
		// turn does not go through `finalizeSubagentLifecycle`, so without this an agent
		// that once signed off "waiting on X" and has since reported done keeps the
		// longer close grace for the rest of the session, and the operator's ordinary
		// budget is never applied to it again.
		//
		// Inside the `finally`, and after `captureSalvage`, on purpose. It used to sit
		// after the whole try/finally, which relied on `driveSessionToYield` never
		// throwing. That happens to hold today (it catches every path into a
		// `DriveOutcome`), so this placement fixes no reachable bug, and that is exactly
		// why it belongs here: "the flag always tracks the latest word" was true only
		// because of an invariant of a different 160-line function, stated nowhere, and
		// one added `throw` there would have made it quietly false.
		AgentRegistry.global().setWaitingOnPeer(id, saysItIsWaitingOnAPeer(subagentSignOffText(monitor)));
	}

	return finalizeRunResult({
		monitor,
		done: { ...outcome, durationMs: Date.now() - startTime },
		index,
		id,
		agent,
		task: message,
		signal,
		artifactsDir: options.artifactsDir,
		eventBus: options.eventBus,
		parentToolCallId: options.parentToolCallId,
		detached: true,
		sessionFile,
		startTime,
	});
}

/**
 * The interactive surface a spawned agent's approval prompts are presented on:
 * the one belonging to the ROOT session of its conversation.
 *
 * Without this a subagent has no surface at all. `initialize` takes a
 * `uiContext` as its fourth parameter and the spawner never passed one, so the
 * runner kept its no-op default, `hasUI()` was false for every child, and any
 * call that needed permission threw "requires approval but no interactive UI
 * available" instead of asking anyone. That was survivable only while every
 * subagent was forced to `yolo` and therefore never asked; once children inherit
 * the operator's rung, the same path is a hard failure on an ordinary call.
 *
 * Resolution is by {@link AgentRef.scope}, not by walking `parentId`. Scope is
 * inherited transitively at registration, so a child at ANY depth already
 * carries the root's identity and the request goes straight there. A
 * parent-to-parent chain is the thing this avoids: every intermediate is an
 * agent that can be parked, aborted or simply busy, and each one is another
 * place the request can be dropped, which is the abandonment being fixed.
 *
 * Returns undefined when the root itself has no UI (ACP, `-p` with no terminal)
 * or when no root is resolvable. That is deliberate and is NOT a fallback to
 * silence: the runner then reports `hasUI()` false and the wrapper refuses the
 * call with an explanation, which is the correct answer for a run where nobody
 * can be asked. Auto-approving instead would make a non-interactive root the
 * most permissive configuration in the product.
 */
export function resolveRootUIContext(childId: string): ExtensionUIContext | undefined {
	const registry = AgentRegistry.global();
	const child = registry.get(childId);
	if (!child) return undefined;
	const rootRunner = registry.listInScope(child.scope).find(ref => ref.kind === "main")?.session?.extensionRunner;
	// `hasUI()` distinguishes a root wired to a terminal from one holding the
	// no-op context. Passing the no-op down would make the child's `hasUI()` true
	// and turn every prompt into a silent `undefined` choice, i.e. a denial the
	// operator was never shown.
	return rootRunner?.hasUI() ? rootRunner.getUIContext() : undefined;
}

/**
 * The ONE way a subagent's session is created, and therefore the one place the
 * tree's budget group is pinned.
 *
 * A subagent opens its own `SessionManager`, so `AgentSession`'s constructor
 * registers a budget group of its own unless it is told to borrow the tree's.
 * That is not cosmetic: an operator who caps a session at four cores otherwise
 * gets four cores PER LIVE SUBAGENT, and the write budget, the process cap and
 * the memory cap all multiply the same way.
 *
 * The pin is an AsyncLocalStorage scope rather than a parameter because the
 * constructor calls `initSessionCpuLimit` synchronously, several layers below
 * this module, and `agent-session.ts` cannot take an argument for it.
 *
 * Creation and pinning live in ONE function on purpose. They were two wrappers
 * around two call sites, and the suite covering the registry helpers stayed
 * green when both wrappers were deleted, which is precisely how the
 * multiplication would come back unnoticed. Now the only way to build a
 * subagent session is the way that joins the tree.
 */
export function createSubagentSession(
	parentSessionId: string | undefined,
	sessionOptions: CreateAgentSessionOptions,
): Promise<CreateAgentSessionResult> {
	return withInheritedBudgetGroup(parentSessionId ?? rootBudgetGroupOwnerId(), async () => {
		// Loaded on demand for the reason given at the top of this file: naming
		// `../sdk` statically puts this module in a 54-module import cycle.
		const { createAgentSession } = await import("../sdk");
		return createAgentSession(sessionOptions);
	});
}

/**
 * Run a single agent in-process.
 */
export async function runSubprocess(options: ExecutorOptions): Promise<SingleResult> {
	const {
		cwd,
		agent,
		task,
		assignment,
		index,
		id,
		worktree,
		modelOverride,
		thinkingLevel,
		outputSchema,
		enableLsp,
		signal,
		onProgress,
	} = options;
	const startTime = Date.now();
	// Set by the session's onFirstChatDispatch hook the first time the agent
	// loop dispatches a chat request to the provider — the launch-complete boundary.
	let firstChatDispatchAt: number | undefined;

	// Check if already aborted
	if (signal?.aborted) {
		return {
			index,
			id,
			agent: agent.name,
			agentSource: agent.source,
			task,
			assignment,
			description: options.description,
			exitCode: 1,
			output: "",
			stderr: "Cancelled before start",
			truncated: false,
			durationMs: 0,
			tokens: 0,
			requests: 0,
			modelOverride,
			error: "Cancelled before start",
			aborted: true,
			abortReason: "Cancelled before start",
		};
	}

	// Set up artifact paths and write input file upfront if artifacts dir provided.
	// A subagent ALWAYS gets a durable session file — never an in-memory session that
	// would silently lose its transcript (Law 10, no silent fallback). When the caller
	// provides no artifacts dir, route the transcript to the durable sessions dir so the
	// run stays studyable and revivable via history://<id> (GRAN-1).
	const subtaskSessionFile: string = options.artifactsDir
		? path.join(options.artifactsDir, sessionFileName(id))
		: path.join(getSessionsDir(), sessionFileName(`orphan-task-${id}`));

	const sourceSettings = options.settings ?? Settings.isolated();
	const effectiveCwd = worktree ?? cwd;
	const subagentSettings = await createSubagentSettingsForCwd(
		sourceSettings,
		effectiveCwd,
		agent.readSummarize === false ? { "read.summarize.enabled": false } : undefined,
		options.parentServiceTier,
	);
	// Every executor decision below is part of the child's runtime contract, so
	// it reads the destination-scoped view rather than the parent's project.
	const settings = subagentSettings;
	const maxNestedSpawnDepth = resolveSubagentMaxNestedSpawnDepth(settings, agent.name);
	const maxRuntimeMs = Math.max(
		0,
		Math.trunc(Number(options.maxRuntimeMs ?? settings.get("subagent.maxRuntimeMs") ?? 0) || 0),
	);
	const agentIdleTtlMs = resolveSubagentIdleTtlMs(settings);
	const autoCloseBudget = resolveSubagentAutoCloseBudget(settings);
	const configuredDefaultBudget = Math.max(
		0,
		Math.trunc(Number(settings.get("subagent.softRequestBudget") ?? SOFT_REQUEST_BUDGET.default) || 0),
	);
	const softRequestBudget =
		configuredDefaultBudget === 0 ? 0 : (SOFT_REQUEST_BUDGET[agent.name] ?? configuredDefaultBudget);
	const softRequestBudgetNotice = settings.get("subagent.softRequestBudgetNotice") ?? false;
	const parentDepth = options.taskDepth ?? 0;
	const childDepth = parentDepth + 1;
	const atMaxDepth = !canSpawnAtDepth(maxNestedSpawnDepth, childDepth);

	// Add tools if specified
	let toolNames: string[] | undefined;
	if (agent.tools && agent.tools.length > 0) {
		toolNames = agent.tools;
		// Auto-include task tool if spawns defined but task not in tools
		if (agent.spawns !== undefined && !toolNames.includes("task") && !atMaxDepth) {
			toolNames = [...toolNames, "task"];
		}
	}

	if (atMaxDepth && toolNames?.includes("task")) {
		toolNames = toolNames.filter(name => name !== "task");
	}
	// IRC is always available; the COOP prompt section advertises it, so a restricted
	// whitelist must still carry `irc` for the subagent to actually use it.
	if (toolNames && !toolNames.includes("irc")) {
		toolNames = [...toolNames, "irc"];
	}
	if (toolNames?.includes("exec")) {
		const backends = resolveEvalBackends({ settings } as ToolSession);
		const expanded = toolNames.filter(name => name !== "exec");
		if (backends.python || backends.js || backends.ruby || backends.julia) expanded.push("eval");
		expanded.push("bash");
		toolNames = Array.from(new Set(expanded));
	}

	// The caller resolved this through `resolveSubagentModel`, the one owner of
	// "what model does this subagent run", and handed the patterns down. Falling
	// back to `agent.model` here would re-create the defect this replaced: the
	// definition's frontmatter deciding behind the operator's back on any path that
	// forgot to resolve, which is how bundled role aliases outranked the subagent
	// model setting.
	const modelPatterns = normalizeModelPatterns(modelOverride);
	// Always a durable file — subagents never run in-memory (see subtaskSessionFile above).
	const sessionFile: string = subtaskSessionFile;
	const spawnsEnv = atMaxDepth
		? ""
		: agent.spawns === undefined
			? ""
			: agent.spawns === "*"
				? "*"
				: agent.spawns.join(",");

	const lspEnabled = enableLsp ?? true;
	const ircEnabled = isIrcEnabled(subagentSettings, childDepth, maxNestedSpawnDepth);
	const skipPythonPreflight = Array.isArray(toolNames) && !toolNames.includes("eval");

	const monitor = createSubagentRunMonitor({
		index,
		id,
		agent,
		task,
		assignment,
		description: options.description,
		modelRegistry: options.modelRegistry,
		settings,
		obfuscateProviderText: options.obfuscateProviderText,
		completeImpl: options.completeImpl,
		modelOverride,
		signal,
		onProgress,
		eventBus: options.eventBus,
		parentToolCallId: options.parentToolCallId,
		detached: options.detached,
		sessionFile: subtaskSessionFile,
		softRequestBudget,
		softRequestBudgetNotice,
		maxRuntimeMs,
	});
	const progress = monitor.progress;
	let unsubscribe: (() => void) | null = null;
	let reviveSession: (() => Promise<AgentSession>) | null = null;
	// Adopted (kept-alive) subagents flip registry status from session events on
	// later turns: revive/wake → running, turn drained → idle. The subscription
	// intentionally survives this run; a disposed session emits nothing, so it
	// needs no teardown.
	const installRegistryStatusSync = (target: AgentSession): void => {
		target.subscribe(event => {
			if (event.type === "agent_start") {
				AgentRegistry.global().setStatus(id, "running");
			} else if (event.type === "agent_end") {
				AgentRegistry.global().setStatus(id, "idle");
			}
		});
	};

	const runSubagent = async (): Promise<DriveOutcome & { durationMs: number }> => {
		const sessionAbortController = new AbortController();
		const abortSignal = monitor.abortSignal;
		// The same facts `driveSessionToYield` reports, because setup can fail or be cancelled before
		// the turn ever starts. No verdict is formed here either: see `resolveRunVerdict`.
		let failure: string | undefined;
		let turnCutShort = false;
		let turnAborted = false;
		let turnAbortReason: string | undefined;
		const checkAbort = () => {
			if (abortSignal.aborted) {
				throw new ToolAbortError();
			}
		};
		const awaitAbortable = async <T>(promise: Promise<T>): Promise<T> => {
			checkAbort();
			const { promise: abortPromise, reject } = Promise.withResolvers<never>();
			const onAbort = () => {
				try {
					checkAbort();
				} catch (err) {
					reject(err);
				}
			};
			abortSignal.addEventListener("abort", onAbort, { once: true });
			try {
				return await Promise.race([promise, abortPromise]);
			} finally {
				abortSignal.removeEventListener("abort", onAbort);
			}
		};
		// Launch-latency phase marks (performance.now()); read by the debug log
		// emitted before this closure returns. Left undefined when setup throws
		// before reaching the phase, which itself localizes the cost.
		const perfStart = performance.now();
		let resolvedAt: number | undefined;
		let sessionOpenedAt: number | undefined;
		let sessionCreatedAt: number | undefined;
		let readyAt: number | undefined;

		try {
			checkAbort();
			// Pin authStorage to modelRegistry.authStorage — mirrors the createAgentSession invariant.
			const registryFromParent = options.modelRegistry !== undefined;
			const modelRegistry =
				options.modelRegistry ??
				new ModelRegistry(options.authStorage ?? (await awaitAbortable(discoverAuthStorage())));
			const authStorage = modelRegistry.authStorage;
			if (options.authStorage && options.authStorage !== authStorage) {
				throw new Error(
					"options.authStorage and options.modelRegistry.authStorage must be the same instance when both are provided",
				);
			}
			checkAbort();
			if (!registryFromParent) {
				await awaitAbortable(modelRegistry.refresh());
			} else {
				logger.debug("runSubagent: reusing parent modelRegistry; skipping refresh");
			}
			checkAbort();

			const {
				model,
				thinkingLevel: resolvedThinkingLevel,
				explicitThinkingLevel,
				authFallbackUsed,
				warning: modelResolutionWarning,
			} = await awaitAbortable(
				resolveModelOverrideWithAuthFallback(
					modelPatterns,
					options.parentActiveModelPattern,
					modelRegistry,
					settings,
					id,
				),
			);
			if (modelResolutionWarning) {
				logger.warn("Subagent model resolution warning", {
					warning: modelResolutionWarning,
					requested: modelPatterns,
				});
			}
			if (authFallbackUsed && model) {
				logger.warn("Subagent model has no working credentials; falling back to parent session model", {
					requested: modelPatterns,
					parentModel: options.parentActiveModelPattern,
					resolvedProvider: model.provider,
					resolvedModel: model.id,
				});
			}
			const retryFallbackRole = installSubagentRetryFallbackChain({
				settings: subagentSettings,
				id,
				candidates: resolveSubagentRetryFallbackCandidates(modelPatterns, modelRegistry, settings),
				model,
				authFallbackUsed,
			});
			if (retryFallbackRole) {
				logger.debug("Configured subagent runtime model fallback chain", {
					role: retryFallbackRole,
					requested: modelPatterns,
				});
			}
			if (model?.contextWindow && model.contextWindow > 0) {
				progress.contextWindow = model.contextWindow;
			}
			const selectedThinkingLevel = resolveEffectiveSubagentThinkingLevel(
				explicitThinkingLevel,
				resolvedThinkingLevel,
				thinkingLevel,
			);
			const effectiveThinkingLevel =
				selectedThinkingLevel === undefined || selectedThinkingLevel === ThinkingLevel.Inherit
					? (options.parentThinkingLevel ?? ThinkingLevel.Inherit)
					: selectedThinkingLevel;
			if (model) {
				// The badge carries the effort this agent ACTUALLY runs at, not only an effort somebody
				// typed as a `:level` suffix. Effort inherits on its own axis (this agent's row, then the
				// blanket subagent effort, then frontmatter, then the session), so the ordinary case is an
				// agent running at a perfectly definite effort that no suffix names. The badge printed the
				// bare model for exactly those, which reads as "this one has no effort level" next to a
				// sibling that shows one, when both have one and they may well differ.
				const badgeLevel = effectiveThinkingLevel;
				progress.resolvedModel = badgeLevel
					? formatModelSelectorValue(formatModelStringWithRouting(model), badgeLevel)
					: formatModelStringWithRouting(model);
			}
			resolvedAt = performance.now();

			// sessionFile is always durable — a subagent never runs in-memory (GRAN-1).
			const sessionManager = await awaitAbortable(
				SessionManager.open(sessionFile, undefined, undefined, {
					initialCwd: effectiveCwd,
					suppressBreadcrumb: true,
				}),
			);
			if (options.parentArtifactManager) {
				sessionManager.adoptArtifactManager(options.parentArtifactManager);
			}
			sessionOpenedAt = performance.now();

			const mcpProxyTools = options.mcpManager ? createMCPProxyTools(options.mcpManager) : [];
			const enableMCP = !options.mcpManager;

			// Derive subagent-scoped telemetry from the parent's config so the
			// child loop's spans nest under the parent's active execute_tool span
			// (OTEL context propagation handles parent linkage automatically),
			// carry the subagent's own agent identity, and use the subagent's
			// own session id for `gen_ai.conversation.id`.
			const subagentAgentIdentity: AgentIdentity | undefined = options.parentTelemetry
				? {
						id,
						name: agent.name,
						description: agent.description,
					}
				: undefined;
			const subagentTelemetry: AgentTelemetryConfig | undefined =
				options.parentTelemetry && subagentAgentIdentity
					? {
							...options.parentTelemetry,
							agent: subagentAgentIdentity,
							// Clear parent's conversationId; the child loop falls back to
							// its own AgentLoopConfig.sessionId.
							conversationId: undefined,
						}
					: undefined;

			if (options.parentTelemetry && subagentAgentIdentity) {
				const parentTelemetryHandle = resolveTelemetry(
					options.parentTelemetry,
					options.parentTelemetry.conversationId,
				);
				recordHandoff(parentTelemetryHandle, {
					fromAgent: options.parentTelemetry.agent,
					toAgent: subagentAgentIdentity,
				});
			}

			const { normalized: normalizedOutputSchema } = normalizeSchema(outputSchema);

			// Captured by the lifecycle reviver: rebuilding an equivalent session from
			// the same JSONL file re-invokes createAgentSession with the exact options
			// of the original run (same agent id, tools, model, system prompt,
			// artifacts dir) — only the SessionManager differs.
			const buildSubagentSessionOptions = (
				sessionManagerForRun: SessionManager,
				runtimeSettings: Settings,
			): CreateAgentSessionOptions => ({
				cwd: sessionManagerForRun.getCwd(),
				authStorage,
				modelRegistry,
				settings: runtimeSettings,
				bypassAllApprovals: options.bypassAllApprovals,
				parentApprovalBypassed: options.parentApprovalBypassed,
				model,
				modelPattern: model || modelOverride === undefined ? undefined : modelPatterns,
				modelPatternAuthFallback:
					model || modelOverride === undefined ? undefined : options.parentActiveModelPattern,
				modelPatternFallbackRole:
					model || modelOverride === undefined ? undefined : `${SUBAGENT_RETRY_FALLBACK_ROLE_PREFIX}${id}`,
				thinkingLevel: effectiveThinkingLevel,
				toolNames,
				requireYieldTool: true,
				contextFiles: options.contextFiles,
				skills: options.skills,
				promptTemplates: options.promptTemplates,
				workspaceTree: options.workspaceTree,
				rules: options.rules,
				preloadedExtensionPaths: options.preloadedExtensionPaths,
				preloadedCustomToolPaths: options.preloadedCustomToolPaths,
				systemPrompt: defaultPrompt => {
					const subagentPrompt = prompt.render(subagentPrompts["subagent/system-prompt"].text, {
						agent: agent.systemPrompt,
						context: options.context?.trim() ?? "",
						planReference: options.planReference?.content ?? "",
						planReferencePath: options.planReference?.path ?? "",
						worktree: worktree ?? "",
						outputSchema: normalizedOutputSchema,
						outputSchemaOverridesAgent: options.outputSchemaOverridesAgent === true,
						ircEnabled,
					});
					return defaultPrompt.length === 0
						? [subagentPrompt]
						: [...defaultPrompt.slice(0, -1), subagentPrompt, defaultPrompt[defaultPrompt.length - 1]];
				},
				sessionManager: sessionManagerForRun,
				hasUI: false,
				spawns: spawnsEnv,
				taskDepth: childDepth,
				maxNestedSpawnDepth,
				parentHindsightSessionState: options.parentHindsightSessionState,
				parentMnemopiSessionState: options.parentMnemopiSessionState,
				parentArgot: options.parentArgot,
				parentTaskPrefix: id,
				parentAgentId: options.parentAgentId,
				agentId: id,
				agentDisplayName: agent.name,
				enableLsp: lspEnabled,
				skipPythonPreflight,
				enableMCP,
				mcpManager: options.mcpManager,
				customTools: mcpProxyTools.length > 0 ? mcpProxyTools : undefined,
				localProtocolOptions: options.localProtocolOptions,
				telemetry: subagentTelemetry,
				parentEvalSessionId: options.parentEvalSessionId,
				onFirstChatDispatch: () => {
					firstChatDispatchAt ??= performance.now();
				},
			});

			const sessionPromise = createSubagentSession(
				options.parentSessionId,
				buildSubagentSessionOptions(sessionManager, subagentSettings),
			);
			let session: AgentSession;
			try {
				({ session } = await awaitAbortable(sessionPromise));
			} catch (err) {
				// Abort raced session startup. The session may still resolve later
				// holding live LSP/MCP child processes — dispose it when it does so
				// a cancelled subagent cannot leak them.
				void sessionPromise.then(created => created.session.dispose()).catch(() => {});
				throw err;
			}
			sessionCreatedAt = performance.now();

			monitor.setActiveSession(session);
			installRegistryStatusSync(session);
			if (worktree === undefined) {
				// Lifecycle reviver: park closed the JSONL writer, so reopening takes
				// the single-writer lock cleanly and restores the full message history
				// (createAgentSession → agent.replaceMessages). Isolated runs are not
				// resumable (worktree is merged + cleaned) and never get a reviver.
				reviveSession = async () => {
					// Re-peek as well as re-open on every use: /move can rewrite
					// the header after this closure was created, and a deleted
					// recorded cwd must fail closed rather than use open()'s
					// general interactive fallback.
					const current = await SessionManager.peekSessionInit(sessionFile);
					if (!current?.init) {
						throw new Error(`Cannot revive ${id}: persisted session contract is missing`);
					}
					try {
						await fs.stat(current.cwd);
					} catch {
						throw new Error(`Cannot revive ${id}: persisted working directory is unavailable`);
					}
					const reopened = await SessionManager.open(sessionFile, undefined, undefined, {
						initialCwd: current.cwd,
						suppressBreadcrumb: true,
					});
					if (options.parentArtifactManager) {
						reopened.adoptArtifactManager(options.parentArtifactManager);
					}
					const revivedSettings = await subagentSettings.cloneForCwd(reopened.getCwd());
					const { session: revived } = await createSubagentSession(
						options.parentSessionId,
						buildSubagentSessionOptions(reopened, revivedSettings),
					);
					installRegistryStatusSync(revived);
					return revived;
				};
			}

			// Emit lifecycle start event
			if (options.eventBus) {
				options.eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
					id,
					agent: agent.name,
					parentToolCallId: options.parentToolCallId,
					detached: options.detached,
					agentSource: agent.source,
					description: options.description,
					status: "started",
					sessionFile: subtaskSessionFile,
					index,
				});
			}

			const subagentToolNames = session.getActiveToolNames();
			const parentOwnedToolNames = new Set(["todo"]);
			const filteredSubagentTools = subagentToolNames.filter(name => !parentOwnedToolNames.has(name));
			if (filteredSubagentTools.length !== subagentToolNames.length) {
				await awaitAbortable(session.setActiveToolsByName(filteredSubagentTools));
			}

			session.sessionManager.appendSessionInit({
				systemPrompt: session.agent.state.systemPrompt.join("\n\n"),
				task,
				tools: session.getActiveToolNames(),
				spawns: spawnsEnv,
				readSummarize: agent.readSummarize,
				maxNestedSpawnDepth,
				outputSchema,
			});

			abortSignal.addEventListener(
				"abort",
				() => {
					void monitor.abortActiveSession();
				},
				{ once: true, signal: sessionAbortController.signal },
			);
			// Defensive: if the wall-clock timer (or external signal) fired during
			// the awaited setup above, the listener registration races the dispatch
			// and may not observe the already-fired abort event. Mirror it manually.
			if (abortSignal.aborted) {
				void monitor.abortActiveSession();
			}

			const pendingExtensionMessages: Array<Promise<unknown>> = [];
			const extensionRunner = session.extensionRunner;
			if (extensionRunner) {
				// Name the child on its own runner before initialize, so an approval
				// card raised from it carries a byline. See `ExtensionRunner.agentId`.
				extensionRunner.setAgentId(id);
				extensionRunner.initialize(
					{
						sendMessage: (message, options) => {
							const sendPromise = session.sendCustomMessage(message, options).catch(e => {
								logger.error("Extension sendMessage failed", {
									error: errorMessage(e),
								});
							});
							pendingExtensionMessages.push(sendPromise);
						},
						sendUserMessage: (content, options) => {
							const sendPromise = session.sendUserMessage(content, options).catch(e => {
								logger.error("Extension sendUserMessage failed", {
									error: errorMessage(e),
								});
							});
							pendingExtensionMessages.push(sendPromise);
						},
						appendEntry: (customType, data) => {
							session.sessionManager.appendCustomEntry(customType, data);
						},
						setLabel: (targetId, label) => {
							session.sessionManager.appendLabelChange(targetId, label);
						},
						getActiveTools: () => session.getActiveToolNames(),
						getAllTools: () => session.getAllToolNames(),
						setActiveTools: (toolNames: string[]) =>
							session.setActiveToolsByName(toolNames.filter(name => !parentOwnedToolNames.has(name))),
						getCommands: () => getSessionSlashCommands(session),
						setModel: model => runExtensionSetModel(session, model),
						getThinkingLevel: () => session.thinkingLevel,
						setThinkingLevel: (level, persist) => session.setThinkingLevel(level, persist),
						getSessionName: () => session.sessionManager.getSessionName(),
						setSessionName: async name => {
							await session.sessionManager.setSessionName(name, "user");
						},
					},
					{
						getModel: () => session.model,
						isIdle: () => !session.isStreaming,
						obfuscateProviderText: text => session.obfuscateProviderText(text),
						abort: () => session.abort({ reason: USER_INTERRUPT_LABEL }),
						hasPendingMessages: () => session.queuedMessageCount > 0,
						shutdown: () => {},
						getContextUsage: () => session.getContextUsage(),
						getSystemPrompt: () => session.systemPrompt,
						compact: instructionsOrOptions => runExtensionCompact(session, instructionsOrOptions),
					},
					undefined,
					resolveRootUIContext(id),
				);
				extensionRunner.onError(err => {
					logger.error("Extension error", { path: err.extensionPath, error: err.error });
				});
				await awaitAbortable(extensionRunner.emit({ type: "session_start" }));
				while (pendingExtensionMessages.length > 0) {
					await awaitAbortable(Promise.all(pendingExtensionMessages.splice(0)));
				}
			}

			unsubscribe = monitor.attach(session);

			checkAbort();
			// Autoload skills via sendCustomMessage (same mechanic as /skill:<name>).
			//
			// Settled HERE, against `session.skills`, because this is the first point where the
			// child's own skill set exists. A spawn whose `cwd` differs from the parent's inherits
			// no skills and rediscovers its own, so the spawner cannot match the declared names: it
			// forwards them as a `deferred` plan and they are judged present or missing against the
			// tree the child was actually pointed at.
			const autoloadSkills = settleAutoloadSkills(options.autoloadSkills, session.skills, agent.name);
			for (const skill of autoloadSkills) {
				const { message } = await buildSkillPromptMessage(skill, "", "autoload");
				await session.sendCustomMessage(
					{
						customType: SKILL_PROMPT_MESSAGE_TYPE,
						content: message,
						display: false,
						details: { name: skill.name, path: skill.filePath },
					},
					{ triggerTurn: false },
				);
			}

			readyAt = performance.now();
			const outcome = await driveSessionToYield(session, monitor, task, outputSchema);
			failure = outcome.failure;
			turnCutShort = outcome.turnCutShort;
			turnAborted = outcome.turnAborted;
			turnAbortReason = outcome.turnAbortReason;
		} catch (err) {
			// Setup threw: a real failure unless the run was cancelled, in which case the abort facts
			// below describe it.
			if (!abortSignal.aborted) {
				failure ??= err instanceof Error ? err.stack || err.message : String(err);
			} else {
				failure ??= undefined;
			}
		} finally {
			// Setup can be cancelled before `driveSessionToYield` ever runs, so the facts are completed
			// here rather than assumed. This used to be a second copy of the demotion rule that
			// disagreed with the turn loop's.
			if (abortSignal.aborted) {
				turnCutShort = true;
				if (monitor.isAbortedRun()) {
					turnAborted = true;
					turnAbortReason ??= monitor.resolveAbortReasonText();
				}
			}
			sessionAbortController.abort();
			const { signal: cleanupSignal, cancel: cancelCleanup } = scopedTimeoutSignal(5000);
			try {
				await untilAborted(cleanupSignal, () => monitor.waitForActiveSessionAbort());
			} catch {
				// Ignore abort cleanup timeouts/errors; terminal disposal below is still best-effort.
			} finally {
				cancelCleanup();
			}
			if (unsubscribe) {
				try {
					unsubscribe();
				} catch {
					// Ignore unsubscribe errors
				}
				unsubscribe = null;
			}
			const session = monitor.takeActiveSession();
			if (session) {
				monitor.captureSalvage(session);
				await finalizeSubagentLifecycle({
					id,
					session,
					aborted: turnAborted,
					abortKind: monitor.abortKind(),
					keepAlive: options.keepAlive !== false,
					isolated: worktree !== undefined,
					agentIdleTtlMs,
					autoClose: autoCloseBudget,
					// `captureSalvage` ran on the line above, so the sign-off is this run's
					// LAST assistant text rather than every assistant message it produced.
					signOff: subagentSignOffText(monitor),
					reviveSession,
				});
			}
		}

		// Launch-latency breakdown (subagent invocation → first chat dispatch).
		// Phase deltas are performance.now() spans; the task-tool concurrency
		// brackets use the Date.now epochs captured by the spawn site
		// (invokedAt before acquire, acquiredAt after) so queue wait and
		// pre-run setup are reported apart.
		const span = (from: number | undefined, to: number | undefined): number | undefined =>
			from !== undefined && to !== undefined ? Math.round(to - from) : undefined;
		const queueMs =
			options.invokedAt !== undefined && options.acquiredAt !== undefined
				? Math.round(options.acquiredAt - options.invokedAt)
				: undefined;
		const preRunMs = options.acquiredAt !== undefined ? Math.round(startTime - options.acquiredAt) : undefined;
		const setupToFirstChatMs = span(perfStart, firstChatDispatchAt);
		const invokeToFirstChatMs =
			options.invokedAt !== undefined && setupToFirstChatMs !== undefined
				? Math.round(startTime - options.invokedAt) + setupToFirstChatMs
				: undefined;
		logger.debug("subagent launch timing", {
			id,
			agent: agent.name,
			queueMs,
			preRunMs,
			resolveMs: span(perfStart, resolvedAt),
			sessionOpenMs: span(resolvedAt, sessionOpenedAt),
			createSessionMs: span(sessionOpenedAt, sessionCreatedAt),
			readyMs: span(sessionCreatedAt, readyAt),
			promptToFirstChatMs: span(readyAt, firstChatDispatchAt),
			setupToFirstChatMs,
			invokeToFirstChatMs,
		});
		return {
			failure,
			turnCutShort,
			turnAborted,
			turnAbortReason,
			durationMs: Date.now() - startTime,
		};
	};

	const done = await runSubagent();
	monitor.finish();

	return finalizeRunResult({
		monitor,
		done,
		index,
		id,
		agent,
		task,
		assignment,
		modelOverride,
		outputSchema,
		signal,
		artifactsDir: options.artifactsDir,
		eventBus: options.eventBus,
		parentToolCallId: options.parentToolCallId,
		detached: options.detached,
		sessionFile: subtaskSessionFile,
		startTime,
	});
}
