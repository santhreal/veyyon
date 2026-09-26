/**
 * In-process execution for agents.
 *
 * Runs each agent on the main thread and forwards AgentEvents for progress tracking.
 */

import * as fs from "node:fs/promises";
import path from "node:path";
import { type AgentIdentity, type AgentTelemetryConfig, recordHandoff, resolveTelemetry } from "@veyyon/agent-core";
import { ThinkingLevel } from "@veyyon/agent-core/thinking";
import type { Api, Model, ServiceTierByFamily, ToolChoice } from "@veyyon/ai";
import type { AuthStorage } from "@veyyon/ai/auth-storage";
import type { ArtifactManager } from "@veyyon/kernel/session/artifacts";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import type { SideCompleteImpl } from "@veyyon/kernel/session/side-complete";
import {
	collapseWhitespace,
	errorMessage,
	getSessionsDir,
	logger,
	popLoopPhase,
	prompt,
	pushLoopPhase,
	scopedTimeoutSignal,
	truncate,
	untilAborted,
} from "@veyyon/utils";
import { sessionFileName } from "@veyyon/utils/session-file";
import type { ArgotSession } from "argot";
import { ModelRegistry } from "../config/model-registry";
import {
	formatModelSelectorValue,
	formatModelStringWithRouting,
	resolveModelOverride,
	resolveModelOverrideWithAuthFallback,
} from "../config/model-resolver";
import type { PromptTemplate } from "../config/prompt-templates";
import { buildServiceTierByFamily, resolveAgentServiceTier } from "../config/service-tier";
import { type SettingPath, Settings } from "../config/settings";
import type { Rule } from "../discovery/capability/rule";
import type { ToolPathWithSource } from "../extensibility/custom-tools";
import type { CustomTool } from "../extensibility/custom-tools/types";
import { runExtensionCompact, runExtensionSetModel } from "../extensibility/extensions/compact-handler";
import { getSessionSlashCommands } from "../extensibility/extensions/get-commands-handler";
import type { ExtensionUIContext } from "../extensibility/extensions/types";
import { buildSkillPromptMessage, type Skill } from "../extensibility/skills";
import type { LocalProtocolOptions } from "../internal-urls";
import type { MCPManager } from "../mcp/manager";
import type { HindsightSessionState } from "../memory/hindsight/state";
import type { MnemopiSessionState } from "../memory/mnemopi/state";
import { agentPrompts } from "../prompts/agent/rows";
import { AgentLifecycleManager, syncStatusWithTurns } from "../registry/agent-lifecycle";
import { AgentRegistry } from "../registry/agent-registry";
import { createAgentSession } from "../sdk";
import type { AgentSession } from "../session/agent-session";
import { discoverAuthStorage } from "../session/auth-broker-config";
import { rootBudgetGroupOwnerId, withInheritedBudgetGroup } from "../session/cpu-limit";
import type { CreateAgentSessionOptions, CreateAgentSessionResult } from "../session/factory-options";
import { SKILL_PROMPT_MESSAGE_TYPE, USER_INTERRUPT_LABEL } from "../session/messages";
import { truncateTail } from "../session/streaming-output";
import type { ConfiguredThinkingLevel } from "../thinking";
import type { ContextFileEntry, ToolSession } from "../tools";
import { isIrcEnabled } from "../tools/agent/irc";
import { type ReportFindingDetails, toReviewFinding } from "../tools/agent/review";
import { normalizeSchema } from "../tools/core/jtd-to-json-schema";
import {
	buildOutputValidator,
	type OutputValidator,
	summarizeValidationFailure,
} from "../tools/core/output-schema-validator";
import { ToolAbortError } from "../tools/core/tool-errors";
import { resolveEvalBackends } from "../tools/shell/eval-backends";
import type { EventBus } from "../utils/event-bus";
import { buildNamedToolChoice } from "../utils/tool-choice";
import type { WorkspaceTree } from "../workspace-tree";
import {
	type AgentPruneBudget,
	resolveAgentIdleTtlMs,
	resolveAgentMaxNestedSpawnDepth,
	resolveAgentPruneBudget,
} from "./agent-settings";
import { type AutoloadSkillPlan, settleAutoloadSkills } from "./inherited-collections";
import { type AbortReason, type AgentRunMonitor, createAgentRunMonitor } from "./run-monitor";
import { YIELD_TOOL_NAME } from "./subprocess-tool-registry";
import {
	type AgentDefinition,
	type AgentProgress,
	canSpawnAtDepth,
	MAX_OUTPUT_BYTES,
	MAX_OUTPUT_LINES,
	type ReviewFinding,
	type SingleResult,
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
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
 * `BUDGET_STOP_GRACE_REQUESTS` (`run-monitor.ts`) more requests is the run hard-aborted.
 * The `default` key applies to agents without an explicit entry and can be
 * overridden via the `task.softRequestBudget` setting (0 disables the guard).
 */
export const SOFT_REQUEST_BUDGET: Record<string, number> = {
	scout: 100,
	sonic: 100,
	default: 200,
};

/** Flatten whitespace and clip salvage text for the cancelled-child summary line. */
function formatSalvageSnippet(text: string, maxLength = 500): string {
	return truncate(collapseWhitespace(text), maxLength);
}

/**
 * The thinking effort a dispatched agent runs at, by precedence:
 *
 * 1. an explicit `:level` suffix on the resolved model pattern (e.g.
 *    `agent.model = "anthropic/claude-sonnet-4-5:high"`) always wins;
 * 2. otherwise `configuredThinkingLevel`, the level the CALLER already resolved;
 * 3. otherwise the level derived from the pattern match itself.
 *
 * `explicitThinkingLevel` is set by the model resolver when it stripped a
 * concrete `:level` suffix off the pattern; in that case `resolvedThinkingLevel`
 * carries that level and it is authoritative, so the caller's level is ignored.
 *
 * `configuredThinkingLevel` is NOT the agent definition's frontmatter, though it
 * was named and documented as if it were. Every caller passes the output of
 * `resolveAgentThinkingLevel` (row, then blanket, then frontmatter), and this
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

const AGENT_RETRY_FALLBACK_ROLE_PREFIX = "agent:";

interface AgentRetryFallbackCandidate {
	model: Model<Api>;
	selector: string;
}

function resolveAgentRetryFallbackCandidates(
	modelPatterns: string[],
	modelRegistry: ModelRegistry,
	settings: Settings,
): AgentRetryFallbackCandidate[] {
	const candidates: AgentRetryFallbackCandidate[] = [];
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

function installAgentRetryFallbackChain(args: {
	settings: Settings;
	id: string;
	candidates: AgentRetryFallbackCandidate[];
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

	const role = `${AGENT_RETRY_FALLBACK_ROLE_PREFIX}${id}`;
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

type AbortableAwaiter = <T>(promise: Promise<T>) => Promise<T>;

/**
 * Awaits a promise that does not itself observe `abortSignal`, rejecting with `ToolAbortError` as
 * soon as the signal fires. The listener is removed on every settle, so a signal that outlives many
 * awaited steps does not accumulate one listener per step.
 */
function createAbortableAwaiter(abortSignal: AbortSignal): AbortableAwaiter {
	return async <T>(promise: Promise<T>): Promise<T> => {
		if (abortSignal.aborted) throw new ToolAbortError();
		const { promise: abortPromise, reject } = Promise.withResolvers<never>();
		const onAbort = () => {
			if (abortSignal.aborted) reject(new ToolAbortError());
		};
		abortSignal.addEventListener("abort", onAbort, { once: true });
		try {
			return await Promise.race([promise, abortPromise]);
		} finally {
			abortSignal.removeEventListener("abort", onAbort);
		}
	};
}

/** Options for agent execution */
export interface ExecutorOptions {
	cwd: string;
	worktree?: string;
	agent: AgentDefinition;
	task: string;
	assignment?: string;
	/** Shared background from the task call (`task.batch`), rendered into the agent's system prompt. */
	context?: string;
	/**
	 * The session's active overall plan, handed off so agents spawned during
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
	 * request per agent.
	 */
	completeImpl?: SideCompleteImpl;
	index: number;
	id: string;
	parentToolCallId?: string;
	/**
	 * Spawn runs as a detached background job (parent turn not blocked on it).
	 * Rides the agent lifecycle/progress payloads so HUD-style surfaces can
	 * skip spawns the transcript already renders inline. See
	 * {@link AgentLifecyclePayload.detached}.
	 */
	detached?: boolean;
	modelOverride?: string | string[];
	/**
	 * Active model selector of the parent session, used as an auth-aware fallback
	 * if the resolved agent model has no working credentials. See #985.
	 */
	parentActiveModelPattern?: string;
	/** Configured effort of the parent session, used when this agent has no explicit effort. */
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
	 * it wins over the settings value; `0` disables the per-agent wall-clock
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
	/** Parent-discovered rules, forwarded to skip rule discovery in the agent. */
	rules?: Rule[];
	/**
	 * Parent's discovered extension source paths. Forwarded to skip the
	 * extension FS scan in the agent; the agent then re-binds each
	 * extension against its own `ExtensionAPI` (cwd, eventBus, runtime).
	 */
	preloadedExtensionPaths?: string[];
	/** The operator-named subset of {@link preloadedExtensionPaths}; see the SDK option of the same name. */
	preloadedNamedExtensionPaths?: string[];
	/**
	 * Parent's discovered custom-tool source paths. Forwarded to skip the
	 * `.veyyon/tools/` FS scan in the agent; the agent then re-binds each
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
	 * already-running agent bypassing approvals until it finishes.
	 */
	parentApprovalBypassed?: () => boolean;
	/**
	 * Parent session's live per-family service tiers, the source of truth for a
	 * agent whose `tier.agent` is `"inherit"`. `null` = the parent
	 * explicitly has no tier (e.g. `/fast off`); omitted = no live session, so
	 * inherit falls back to the agent's configured `tier.*` settings.
	 */
	parentServiceTier?: ServiceTierByFamily | null;
	/** Override local:// protocol options so agent shares parent's local:// root */
	localProtocolOptions?: LocalProtocolOptions;
	/**
	 * Parent session's ArtifactManager. Agent adopts it so artifact IDs are
	 * unique across the whole agent tree and all artifacts land in the parent's
	 * artifacts directory (no per-agent subdir).
	 */
	parentArtifactManager?: ArtifactManager;
	parentHindsightSessionState?: HindsightSessionState;
	parentMnemopiSessionState?: MnemopiSessionState;
	/** Parent session's Argot codec, forked into this agent under `argot.agents: inherit`. */
	parentArgot?: ArgotSession;
	/** Parent agent's eval executor session id. Agents reuse it so eval state is shared. */
	parentEvalSessionId?: string;
	/**
	 * Parent agent's OpenTelemetry configuration. When defined, the agent's
	 * loop is started with the same tracer/hooks but its own agent identity
	 * stamped, so its `invoke_agent` / `chat` / `execute_tool` spans appear as
	 * a sub-tree under the parent's active `execute_tool task` span. A
	 * `handoff` span is emitted on dispatch to mark the parent → agent
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
	 * Registry id of the spawning agent, recorded as this agent's parent.
	 * Forwarded verbatim to the SDK; the executor never derives it (the spawner
	 * passes its own `getAgentId()`).
	 */
	parentAgentId?: string;
	/**
	 * The SPAWNING session's id, so this agent's own session registers as an
	 * alias of the spawner's budget group instead of creating a second one. See
	 * `withInheritedBudgetGroup`: an agent that opens its own group multiplies
	 * every resource limit the operator set by the number of live agents.
	 *
	 * An id that is itself an alias resolves to the same root owner, which is
	 * what makes the inheritance work at unbounded depth. Omitted falls back to
	 * the process's root session, because an agent always belongs to some
	 * tree and no tree is a better guess than the first one.
	 */
	parentSessionId?: string;
	/**
	 * Keep the finished agent addressable in the registry for IRC/revival.
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

/** Parse a structured completion out of what a child left behind without calling yield. */
function resolveFallbackCompletion(
	rawOutput: string,
	outputSchema: unknown,
): { data: unknown; validator: OutputValidator | undefined } | null {
	const parsed = tryParseJsonOutput(rawOutput);
	if (parsed === undefined) return null;
	const candidate = parseStringifiedJson(extractCompletionData(parsed));
	if (candidate === undefined) return null;
	const { validator, error } = buildOutputValidator(outputSchema);
	if (error) return null;
	if (validator && !validator.validate(candidate).success) return null;
	return { data: candidate, validator };
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

/** What the parent receives from a finished subprocess: its output, exit code and failure text. */
interface SubprocessOutcome {
	rawOutput: string;
	exitCode: number;
	stderr: string;
}

interface FinalizeSubprocessOutputResult extends SubprocessOutcome {
	abortedViaYield: boolean;
	hasYield: boolean;
}
export const SUBAGENT_WARNING_NULL_YIELD = "SYSTEM WARNING: Agent called yield with null data.";
export const SUBAGENT_WARNING_MISSING_YIELD =
	"SYSTEM WARNING: Agent exited without calling yield tool after 3 reminders.";

/** Build a schema_violation outcome — surfaced as a non-zero exit so callers treat it as a failure. */
function buildSchemaViolationOutcome(
	failure: { message: string; missingRequired: string[] },
	data: unknown,
): SubprocessOutcome {
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

/** The schema failure `data` hits, or undefined when it conforms or no validator constrains it. */
function schemaFailure(
	validator: OutputValidator | undefined,
	data: unknown,
): { message: string; missingRequired: string[] } | undefined {
	if (!validator) return undefined;
	const result = validator.validate(data);
	return result.success ? undefined : summarizeValidationFailure(result, data, validator.requiredFields);
}

/** The payload an assembled yield delivers: raw assistant text verbatim, structured data normalized. */
function deliveredYieldData(
	assembled: { data: unknown; rawText: boolean },
	reportFindings: ReviewFinding[] | undefined,
	validator: OutputValidator | undefined,
): unknown {
	return assembled.rawText ? assembled.data : normalizeCompleteData(assembled.data, reportFindings, validator);
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
	const { validator } = buildOutputValidator(outputSchema);
	if (!validator) return undefined;
	const extractedFindings = progress.extractedToolData?.report_finding;
	const reportFindings = Array.isArray(extractedFindings) ? (extractedFindings as ReviewFinding[]) : undefined;
	const failure = schemaFailure(validator, deliveredYieldData(assembled, reportFindings, validator));
	if (!failure) return undefined;
	return failure.missingRequired.length > 0
		? `${failure.message}. Missing required fields: ${failure.missingRequired.join(", ")}`
		: failure.message;
}

/** Whether the caller demanded structured output: a usable schema, including an unconstrained one. */
function demandsStructuredOutput(outputSchema: unknown): boolean {
	const { normalized, error } = normalizeSchema(outputSchema);
	return normalized !== undefined && !error;
}

function prependWarning(rawOutput: string, warning: string): string {
	return rawOutput ? `${warning}\n\n${rawOutput}` : warning;
}

interface SerializedPayload {
	rawOutput: string;
	/** Set when the payload could not be serialized; `rawOutput` then holds the error envelope. */
	error?: string;
}

/**
 * Serialize a delivered payload. The error envelope is built through `JSON.stringify`, never
 * interpolation: a circular-structure message carries quotes and newlines that would make the
 * envelope unparseable.
 */
function serializeDelivered(data: unknown, what: string): SerializedPayload {
	try {
		return { rawOutput: JSON.stringify(data, null, 2) ?? "null" };
	} catch (err) {
		const error = `Failed to serialize ${what}: ${errorMessage(err)}`;
		return { rawOutput: JSON.stringify({ error }), error };
	}
}

function abortedYieldOutcome(error: string | undefined): SubprocessOutcome {
	let rawOutput: string;
	try {
		rawOutput = JSON.stringify({ aborted: true, error }, null, 2);
	} catch {
		rawOutput = `{"aborted":true,"error":"${error || "Unknown error"}"}`;
	}
	return { rawOutput, exitCode: 0, stderr: error || "Agent aborted task" };
}

/**
 * A yield that carried no usable data. It is tolerable only when no structured output was demanded
 * and the turn left usable prose behind. Otherwise it mirrors the missing-yield policy: yielding
 * unusable data is a harder failure than never yielding, so it must not exit 0 and hand the warning
 * back as the result.
 */
function nullYieldOutcome({
	rawOutput,
	exitCode,
	stderr,
	outputSchema,
}: FinalizeSubprocessOutputArgs): SubprocessOutcome {
	const warned = prependWarning(rawOutput, SUBAGENT_WARNING_NULL_YIELD);
	if (!demandsStructuredOutput(outputSchema) && rawOutput.trim()) return { rawOutput: warned, exitCode, stderr };
	return { rawOutput: warned, exitCode: 1, stderr: stderr.trim() ? stderr : SUBAGENT_WARNING_NULL_YIELD };
}

/** Deliver the data an accepted yield carries, validated against the output schema. */
function finalizeYieldData(args: FinalizeSubprocessOutputArgs, yieldItems: YieldItem[]): SubprocessOutcome {
	const { exitCode, stderr, outputSchema } = args;
	const assembled = assembleYieldResult(yieldItems, args.lastAssistantText, arrayValuedLabels(outputSchema));
	if (!assembled || assembled.missingData) return nullYieldOutcome(args);
	const { validator, error: schemaError } = buildOutputValidator(outputSchema);
	const data = deliveredYieldData(assembled, args.reportFindings, validator);
	const failure = schemaFailure(validator, data);
	if (failure) return buildSchemaViolationOutcome(failure, data);
	const serialized: SerializedPayload =
		assembled.rawText && typeof data === "string" ? { rawOutput: data } : serializeDelivered(data, "yield data");
	// A payload that could not be serialized was never delivered, whatever the turn did.
	if (serialized.error !== undefined) {
		return { rawOutput: serialized.rawOutput, exitCode: 1, stderr: stderr.trim() ? stderr : serialized.error };
	}
	// A turn that failed with a stated reason before it yielded keeps that failure.
	if (exitCode !== 0 && stderr.trim()) return { rawOutput: serialized.rawOutput, exitCode, stderr };
	return {
		rawOutput: serialized.rawOutput,
		exitCode: 0,
		stderr: schemaError ? `invalid output schema: ${schemaError}` : "",
	};
}

function finalizeFallbackCompletion(
	fallback: { data: unknown; validator: OutputValidator | undefined },
	reportFindings: ReviewFinding[] | undefined,
): SubprocessOutcome {
	const data = normalizeCompleteData(fallback.data, reportFindings, fallback.validator);
	const failure = schemaFailure(fallback.validator, data);
	if (failure) return buildSchemaViolationOutcome(failure, data);
	const serialized = serializeDelivered(data, "fallback completion");
	return { rawOutput: serialized.rawOutput, exitCode: serialized.error ? 1 : 0, stderr: serialized.error ?? "" };
}

/** Resolve a turn that ended without calling yield: parse a fallback completion, accept prose, or warn. */
function finalizeWithoutYield(args: FinalizeSubprocessOutputArgs): SubprocessOutcome {
	const { rawOutput, exitCode, stderr, outputSchema } = args;
	// A cut-short turn gets no fallback and no missing-yield warning: it was cancelled rather than
	// disobedient, and the exit code that says so comes from `resolveRunVerdict`.
	if (exitCode !== 0 || args.doneAborted || args.signalAborted) return { rawOutput, exitCode, stderr };
	const fallback = resolveFallbackCompletion(rawOutput, outputSchema);
	if (fallback) return finalizeFallbackCompletion(fallback, args.reportFindings);
	if (!demandsStructuredOutput(outputSchema) && rawOutput.trim()) return { rawOutput, exitCode: 0, stderr: "" };
	return {
		rawOutput: prependWarning(rawOutput, SUBAGENT_WARNING_MISSING_YIELD),
		exitCode: 1,
		stderr: SUBAGENT_WARNING_MISSING_YIELD,
	};
}

export function finalizeSubprocessOutput(args: FinalizeSubprocessOutputArgs): FinalizeSubprocessOutputResult {
	const { yieldItems } = args;
	if (!Array.isArray(yieldItems) || yieldItems.length === 0) {
		return { ...finalizeWithoutYield(args), abortedViaYield: false, hasYield: false };
	}
	const lastYield = yieldItems[yieldItems.length - 1];
	if (lastYield?.status === "aborted") {
		return { ...abortedYieldOutcome(lastYield.error), abortedViaYield: true, hasYield: true };
	}
	return { ...finalizeYieldData(args, yieldItems), abortedViaYield: false, hasYield: true };
}

/**
 * The proxy's `execute`. The source tool is re-resolved on every call by raw MCP server/tool
 * metadata, so a reconnect that replaced the source instance is picked up; the display name alone
 * is not enough.
 */
function proxyMcpExecute(mcpManager: MCPManager, serverName: string, mcpToolName: string): CustomTool["execute"] {
	const failed = (text: string) => ({
		content: [{ type: "text" as const, text }],
		details: { serverName, mcpToolName, isError: true },
	});
	return async (toolCallId, params, onUpdate, ctx, signal) => {
		if (signal?.aborted) throw new ToolAbortError();
		const source = mcpManager.getTools().find(t => t.mcpServerName === serverName && t.mcpToolName === mcpToolName);
		if (!source?.execute) return failed(`MCP error: tool ${mcpToolName} no longer available`);
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
			if (error instanceof ToolAbortError) throw error;
			return failed(`MCP error: ${errorMessage(error)}`);
		}
	};
}

/**
 * Create proxy tools that reuse the parent's MCP connections.
 *
 * Each proxy delegates to the current source `MCPTool`/`DeferredMCPTool` rather
 * than rebuilding a raw `tools/call` request, so the Task/agent path shares
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
			execute: proxyMcpExecute(mcpManager, serverName, mcpToolName),
		};
	});
}

export function createSubagentSettings(
	baseSettings: Settings,
	overrides?: Partial<Record<SettingPath, unknown>>,
	inheritedServiceTier?: ServiceTierByFamily | null,
): Settings {
	// Resolve the agent's per-family tiers from `tier.agent` ("inherit" =
	// match the parent's live tiers when a live session supplied them, else the
	// agent's own configured tier.* settings). These and the headless safety
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
	const agentTiers = resolveAgentServiceTier(baseSettings.get("tier.agent"), inheritedTiers);
	return baseSettings.forkWithRuntimeOverrides({
		"tier.openai": agentTiers.openai ?? "none",
		"tier.anthropic": agentTiers.anthropic ?? "none",
		"tier.google": agentTiers.google ?? "none",
		"async.enabled": false,
		"bash.autoBackground.enabled": false,

		// `tools.approvalMode` is DELIBERATELY ABSENT. A spawned agent INHERITS the
		// spawning session's rung through the fork's own settings layers; writing any
		// literal here would override the operator's choice with a value they never
		// configured. This used to be a hardcoded `"yolo"`, which meant a `read` of
		// /etc/passwd and a `bash` that spends a stored credential were UNGATED for
		// every agent on a default install: the wrapper opts out of the
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
 * Bind an agent's settings to the directory it will run in.
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
 * `test/task/agent-settings-cwd-provenance.test.ts` writes a hostile
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

/**
 * The selector an agent's model badge prints: `provider/id[@route][:effort]`,
 * the same string the inline task widget, the anchored HUD and the `/agents`
 * roster format through `modelBadgeFromSelector`. The effort is the level the
 * agent ACTUALLY runs at, not only one somebody typed as a `:level` suffix.
 */
function resolvedModelBadge(model: Model<Api>, thinkingLevel: ConfiguredThinkingLevel | undefined): string {
	return formatModelSelectorValue(formatModelStringWithRouting(model), thinkingLevel);
}

/**
 * What ONE turn of an agent DID, as facts rather than as a verdict.
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

/** One driven run: the session, its monitor, and the awaiter bound to the monitor's abort signal. */
interface YieldDrive {
	session: AgentSession;
	monitor: AgentRunMonitor;
	awaitAbortable: AbortableAwaiter;
	/** Names the yield tool on providers that accept a named tool choice; undefined elsewhere. */
	yieldToolChoice: ToolChoice | undefined;
}

/**
 * Send a synthetic follow-up and wait for the turn it starts. A failure ends the follow-up, not the
 * run: the caller reads what the turn left behind either way.
 */
async function sendSyntheticPrompt(
	drive: YieldDrive,
	text: string,
	toolChoice: ToolChoice | undefined,
	label: string,
): Promise<void> {
	try {
		await drive.awaitAbortable(
			drive.session.prompt(text, { attribution: "agent", synthetic: true, ...(toolChoice ? { toolChoice } : {}) }),
		);
		await drive.awaitAbortable(drive.session.waitForIdle());
	} catch (err) {
		if (drive.monitor.abortSignal.aborted || err instanceof ToolAbortError) {
			// Benign control-flow exit — user cancel (^C) or compaction aborting pending operations both
			// surface here as ToolAbortError. The run's abort is resolved from the state the turn ended
			// in; logging at ERROR would spam operator dashboards with non-failures.
			logger.debug(`${label} aborted`);
		} else {
			logger.error(`${label} failed`, { error: errorMessage(err) });
		}
	}
}

/**
 * Remind the agent to `yield`, up to {@link MAX_YIELD_RETRIES} times, forcing the tool on the last
 * reminder. A budget stop collapses the ladder to that one forced final reminder.
 */
async function remindToYield(drive: YieldDrive): Promise<void> {
	const { session, monitor } = drive;
	const abortSignal = monitor.abortSignal;
	let retryCount = 0;
	while (!monitor.yieldCalled() && retryCount < MAX_YIELD_RETRIES && !abortSignal.aborted) {
		// Wait for the budget stop's session abort to settle, then prompt once with the wrap-up
		// reminder and the named tool choice.
		const budgetStop = monitor.budgetStopRequested();
		if (budgetStop) {
			retryCount = MAX_YIELD_RETRIES - 1;
			await monitor.waitForBudgetStop();
			if (monitor.yieldCalled() || abortSignal.aborted) return;
		}
		// Skip reminders when the model returned a terminal error (a rate-limit cap, an auth failure).
		// Re-prompting would hit the same wall, multiplying the failure noise without any chance of
		// producing a yield.
		if (session.getLastAssistantMessage()?.stopReason === "error") return;
		retryCount++;
		const reminder = prompt.render(agentPrompts["agent/yield-reminder"].text, {
			retryCount,
			maxRetries: MAX_YIELD_RETRIES,
			budgetStop,
		});
		const toolChoice = retryCount >= MAX_YIELD_RETRIES ? drive.yieldToolChoice : undefined;
		await sendSyntheticPrompt(drive, reminder, toolChoice, "Agent prompt");
	}
}

/** Give an agent whose accepted yields fail the output schema one forced chance to repair them. */
async function repairYieldSchema(drive: YieldDrive, outputSchema: unknown): Promise<void> {
	if (drive.monitor.abortSignal.aborted) return;
	const failure = currentYieldSchemaFailure(drive.monitor.progress, outputSchema);
	if (!failure) return;
	const repair = prompt.render(agentPrompts["agent/yield-schema-repair"].text, { failure });
	await sendSyntheticPrompt(drive, repair, drive.yieldToolChoice, "Agent schema repair prompt");
}

/** Classify the state the turn ended in. `failure` is what the drive itself threw, if anything. */
function resolveTurnEnd(session: AgentSession, monitor: AgentRunMonitor, failure: string | undefined): DriveOutcome {
	const lastAssistant = session.getLastAssistantMessage();
	if (lastAssistant?.stopReason === "error") {
		failure ??= lastAssistant.errorMessage || "Agent failed";
	}
	// A budget stop that produced no yield cut the turn short even though no signal named it: the
	// stop cancels the free-running turn, the forced wrap-up reminder is the child's last chance,
	// and silence there means the budget ended the run.
	const budgetStopWithoutYield = monitor.budgetStopRequested() && !monitor.yieldCalled();
	const turnCutShort =
		monitor.abortSignal.aborted || lastAssistant?.stopReason === "aborted" || budgetStopWithoutYield;
	// A cut turn is a CANCELLATION only when the abort belongs to this run. An internal teardown
	// (a tool event handler failing, which aborts the session to stop the run) sets an abort reason
	// of its own and `isAbortedRun` is false for it, so it stays a failure rather than being
	// reported to the operator as though someone cancelled. A soft budget stop reaches this line
	// through `turnCutShort` and leaves no explicit abort reason, so `isAbortedRun` is true for it.
	const turnAborted = turnCutShort && monitor.isAbortedRun();
	if (!turnAborted) return { failure, turnCutShort, turnAborted };
	// A caller signal or the wall-clock timer carries a precise reason (signal.reason, "runtime
	// limit exceeded"). An internal turn abort does NOT, so the assistant message's own errorMessage
	// ("Request was aborted", or a specific stream error) beats the misleading "Cancelled by caller".
	const turnAbortReason = monitor.hasExplicitAbortReason()
		? monitor.resolveAbortReasonText()
		: lastAssistant?.errorMessage?.trim() || monitor.resolveAbortReasonText();
	return { failure, turnCutShort, turnAborted, turnAbortReason };
}

/**
 * Drive one assignment through a live session: send the prompt, wait for idle,
 * remind the agent to `yield` (up to {@link MAX_YIELD_RETRIES} times), then
 * classify the terminal assistant state. A soft-budget stop short-circuits the
 * reminder ladder into a single forced final yield so partial findings still
 * come back as a real report.
 */
async function driveSessionToYield(
	session: AgentSession,
	monitor: AgentRunMonitor,
	task: string,
	outputSchema: unknown,
): Promise<DriveOutcome> {
	const abortSignal = monitor.abortSignal;
	const awaitAbortable = createAbortableAwaiter(abortSignal);
	let failure: string | undefined;
	try {
		try {
			await awaitAbortable(session.prompt(task, { attribution: "agent" }));
			await awaitAbortable(session.waitForIdle());
		} catch (err) {
			// A budget stop cancels the free-running turn by aborting the session, which can surface
			// here as a rejected prompt. Swallow it and drive the forced final yield below; real
			// caller/timeout aborts (monitor signal) and genuine failures keep the old path.
			if (!monitor.budgetStopRequested() || abortSignal.aborted) throw err;
		}
		const yieldToolChoice = buildNamedToolChoice(YIELD_TOOL_NAME, session.model);
		const drive: YieldDrive = { session, monitor, awaitAbortable, yieldToolChoice };
		await remindToYield(drive);
		await repairYieldSchema(drive, outputSchema);
		if (monitor.yieldCalled()) {
			await session.waitForIdle();
		} else {
			await awaitAbortable(session.waitForIdle());
		}
	} catch (err) {
		// An abort is not a failure: it is reported as one of the two abort facts, and whether it
		// costs the run its result depends on whether a yield landed, which this function cannot see.
		if (!abortSignal.aborted) failure = err instanceof Error ? err.stack || err.message : String(err);
	}
	// An abort's MEANING is resolved once, from the state the turn ended in. Recording it at every
	// throw site is what let four copies of the rule drift apart.
	return resolveTurnEnd(session, monitor, failure);
}

interface FinalizeRunArgs {
	monitor: AgentRunMonitor;
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
 * to be left EMPTY for the worst case. A crashed agent settles with a
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
	return `Agent exited with code ${exitCode}${produced} and reported no error. It most likely crashed or was killed (out of memory, or terminated by the operating system).`;
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
 * - A delivered yield means the agent's work exists and belongs to the caller, so an abort around
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
 * Salvage for cancelled/aborted children that produced no completed output: surface the last
 * assistant text and stats instead of "(no output)" so the parent does not redo work the child
 * already finished.
 */
function salvageCancelledOutput(rawOutput: string, monitor: AgentRunMonitor, cutShort: boolean): string {
	if (!cutShort || rawOutput.trim()) return rawOutput;
	const salvageText = monitor.lastAssistantSalvageText();
	if (salvageText === undefined) return rawOutput;
	const { requests, tokens } = monitor.progress;
	return `[cancelled after ${requests} req, ${tokens} tok — last activity: "${formatSalvageSnippet(salvageText)}"]`;
}

/**
 * Write the run's `<id>.md` output artifact (the input and JSONL are written live) and measure it for
 * agent:// URL integration. A failed write is non-fatal: the path stays set and the measurement is
 * absent.
 */
async function writeOutputArtifact(
	artifactsDir: string | undefined,
	id: string,
	rawOutput: string,
	lineCount: number,
): Promise<Pick<SingleResult, "outputPath" | "outputMeta">> {
	if (!artifactsDir) return {};
	const outputPath = path.join(artifactsDir, `${id}.md`);
	try {
		await Bun.write(outputPath, rawOutput);
	} catch {
		return { outputPath };
	}
	return { outputPath, outputMeta: { lineCount, charCount: rawOutput.length } };
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
	const yieldItems = progress.extractedToolData?.yield as YieldItem[] | undefined;
	const reportFindingDetails = progress.extractedToolData?.report_finding as ReportFindingDetails[] | undefined;
	const reportFindings: ReviewFinding[] | undefined = reportFindingDetails?.map(toReviewFinding);
	// Breadcrumb the synchronous yield-payload shaping (O(rawOutput)) so a block
	// here is attributed to this agent rather than logged as "unknown".
	pushLoopPhase(`agent:${id}`);
	let finalized: FinalizeSubprocessOutputResult;
	try {
		finalized = finalizeSubprocessOutput({
			rawOutput: monitor.rawOutput(),
			// The turn's own failure is the only exit code the finalizer starts from. Whether an abort
			// costs the run its success is `resolveRunVerdict`'s call, made below once the payload is known.
			exitCode: done.failure ? 1 : 0,
			stderr: done.failure ?? "",
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
	const { stderr, abortedViaYield, hasYield } = finalized;
	const rawOutput = salvageCancelledOutput(
		finalized.rawOutput,
		monitor,
		done.turnCutShort || Boolean(signal?.aborted) || monitor.runtimeLimitExceeded(),
	);
	const lastYield = yieldItems?.[yieldItems.length - 1];
	const yieldAbortReason = lastYield?.status === "aborted" ? lastYield.error || "Agent aborted task" : undefined;
	const {
		content: truncatedOutput,
		truncated,
		totalLines,
	} = truncateTail(rawOutput, {
		maxBytes: MAX_OUTPUT_BYTES,
		maxLines: MAX_OUTPUT_LINES,
	});
	const { outputPath, outputMeta } = await writeOutputArtifact(args.artifactsDir, id, rawOutput, totalLines);

	// The one place the run's outcome is decided. The yield payload is settled by now, which is why
	// the call happens here and not in the turn loop: `hasYield` is the fact every abort rule turns on.
	const {
		exitCode,
		aborted: wasAborted,
		abortReason: finalAbortReason,
	} = resolveRunVerdict({
		exitCodeAfterFinalize: finalized.exitCode,
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
 * WHAT IT IS GIVEN. Callers pass {@link agentSignOffText}, which is the agent's
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
function agentSignOffText(monitor: AgentRunMonitor): string | undefined {
	return monitor.lastAssistantSalvageText() ?? monitor.rawOutput();
}

/**
 * Settle an agent's registry lifecycle after a run: terminal teardown for
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
	prune?: AgentPruneBudget;
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
		// piles up under a burst of agent teardowns.
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
			pruneAfterMs: args.prune?.afterMs ?? 0,
			pruneWaitingAfterMs: args.prune?.waitingAfterMs ?? 0,
		});
		return;
	}

	// Keep-alive: finished and failed agents both stay interrogable.
	// The lifecycle manager owns idle-TTL parking + revival from here on, and the
	// close budgets decide how long the parked ref survives after that.
	registry.setWaitingOnPeer(args.id, saysItIsWaitingOnAPeer(args.signOff));
	registry.setStatus(args.id, "idle");
	AgentLifecycleManager.global().adopt(args.id, {
		idleTtlMs: args.agentIdleTtlMs,
		pruneAfterMs: args.prune?.afterMs ?? 0,
		pruneWaitingAfterMs: args.prune?.waitingAfterMs ?? 0,
		revive: args.reviveSession ?? undefined,
	});
}

/** Options for {@link runSubagentFollowUpTurn}. */
export interface FollowUpTurnOptions {
	/** Registry id of the (live or parked) agent to continue. */
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
 * Continue a previously spawned (keep-alive) agent with one more monitored
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

	const monitor = createAgentRunMonitor({
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
	// A follow-up turn's progress snapshot replaces the spawn's in every observer,
	// so it carries the same badge or the row loses it the moment the agent is
	// woken. The live session is the one authority on what it runs.
	if (session.model) {
		monitor.progress.resolvedModel = resolvedModelBadge(session.model, session.thinkingLevel);
	}

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
		await settleActiveSessionAbort(monitor);
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
		AgentRegistry.global().setWaitingOnPeer(id, saysItIsWaitingOnAPeer(agentSignOffText(monitor)));
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
 * Without this an agent has no surface at all. `initialize` takes a
 * `uiContext` as its fourth parameter and the spawner never passed one, so the
 * runner kept its no-op default, `hasUI()` was false for every child, and any
 * call that needed permission threw "requires approval but no interactive UI
 * available" instead of asking anyone. That was survivable only while every
 * agent was forced to `yolo` and therefore never asked; once children inherit
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
 * The ONE way an agent's session is created, and therefore the one place the
 * tree's budget group is pinned.
 *
 * An agent opens its own `SessionManager`, so `AgentSession`'s constructor
 * registers a budget group of its own unless it is told to borrow the tree's.
 * That is not cosmetic: an operator who caps a session at four cores otherwise
 * gets four cores PER LIVE AGENT, and the write budget, the process cap and
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
 * agent session is the way that joins the tree.
 */
export function createSubagentSession(
	parentSessionId: string | undefined,
	sessionOptions: CreateAgentSessionOptions,
): Promise<CreateAgentSessionResult> {
	return withInheritedBudgetGroup(parentSessionId ?? rootBudgetGroupOwnerId(), () => {
		return createAgentSession(sessionOptions);
	});
}

const CANCELLED_BEFORE_START = "Cancelled before start";

function cancelledBeforeStart(options: ExecutorOptions): SingleResult {
	return {
		index: options.index,
		id: options.id,
		agent: options.agent.name,
		agentSource: options.agent.source,
		task: options.task,
		assignment: options.assignment,
		description: options.description,
		exitCode: 1,
		output: "",
		stderr: CANCELLED_BEFORE_START,
		truncated: false,
		durationMs: 0,
		tokens: 0,
		requests: 0,
		modelOverride: options.modelOverride,
		error: CANCELLED_BEFORE_START,
		aborted: true,
		abortReason: CANCELLED_BEFORE_START,
	};
}

/** Tools the parent session owns; a child never runs its own copy. */
const PARENT_OWNED_TOOL_NAMES: ReadonlySet<string> = new Set(["todo"]);

/**
 * The tool whitelist the child runs with, or undefined for the agent's full default set. A child that
 * may spawn gains `task` and one at the spawn-depth limit loses it; `irc` is always carried because the
 * COOP prompt section advertises it; `exec` expands to `bash`, plus `eval` when an eval backend exists.
 */
function resolveChildToolNames(agent: AgentDefinition, atMaxDepth: boolean, settings: Settings): string[] | undefined {
	if (!agent.tools || agent.tools.length === 0) return undefined;
	let toolNames = agent.tools;
	if (agent.spawns !== undefined && !atMaxDepth && !toolNames.includes("task")) toolNames = toolNames.concat(["task"]);
	if (atMaxDepth && toolNames.includes("task")) toolNames = toolNames.filter(name => name !== "task");
	if (!toolNames.includes("irc")) toolNames = toolNames.concat(["irc"]);
	if (!toolNames.includes("exec")) return toolNames;
	const backends = resolveEvalBackends({ settings } as ToolSession);
	const expanded = toolNames.filter(name => name !== "exec");
	if (backends.python || backends.js || backends.ruby || backends.julia) expanded.push("eval");
	expanded.push("bash");
	return Array.from(new Set(expanded));
}

/** The `spawns` value the child session receives: empty at the depth limit or when undeclared. */
function childSpawnsEnv(agent: AgentDefinition, atMaxDepth: boolean): string {
	if (atMaxDepth || agent.spawns === undefined) return "";
	return agent.spawns === "*" ? "*" : agent.spawns.join(",");
}

/** A non-negative integer from a setting value; anything unparseable reads as 0. */
function nonNegativeInt(value: unknown): number {
	return Math.max(0, Math.trunc(Number(value) || 0));
}

function resolveSoftRequestBudget(settings: Settings, agentName: string): number {
	const configuredDefault = nonNegativeInt(settings.get("agent.softRequestBudget") ?? SOFT_REQUEST_BUDGET.default);
	return configuredDefault === 0 ? 0 : (SOFT_REQUEST_BUDGET[agentName] ?? configuredDefault);
}

function throwIfRunAborted(abortSignal: AbortSignal): void {
	if (abortSignal.aborted) throw new ToolAbortError();
}

/**
 * `performance.now()` marks of a run's launch. A mark stays undefined when setup threw before
 * reaching it, which itself localizes the cost.
 */
interface LaunchMarks {
	perfStart: number;
	resolvedAt?: number;
	sessionOpenedAt?: number;
	sessionCreatedAt?: number;
	readyAt?: number;
	/** The first time the agent loop dispatched a chat request to the provider: the launch-complete boundary. */
	firstChatDispatchAt?: number;
}

/** Everything a run's session setup reads, resolved once by {@link runSubprocess}. */
interface ChildSessionContext {
	options: ExecutorOptions;
	monitor: AgentRunMonitor;
	/**
	 * The child's destination-scoped settings. Every executor decision is part of the child's runtime
	 * contract, so it reads this view rather than the parent's project.
	 */
	settings: Settings;
	/** Always a durable file: an agent never runs in-memory (GRAN-1). */
	sessionFile: string;
	effectiveCwd: string;
	modelPatterns: string[];
	toolNames: string[] | undefined;
	spawnsEnv: string;
	childDepth: number;
	maxNestedSpawnDepth: number;
	ircEnabled: boolean;
	awaitAbortable: AbortableAwaiter;
	marks: LaunchMarks;
}

/** The model a child runs on and the effort it runs at. */
interface RunModel {
	modelRegistry: ModelRegistry;
	model: Model<Api> | undefined;
	thinkingLevel: ConfiguredThinkingLevel;
}

type ChildSessionOptionsBuilder = (sessionManager: SessionManager, settings: Settings) => CreateAgentSessionOptions;

/** The registry the child resolves models through: the parent's when handed down, else a fresh, refreshed one. */
async function openModelRegistry(
	options: ExecutorOptions,
	abortSignal: AbortSignal,
	awaitAbortable: AbortableAwaiter,
): Promise<ModelRegistry> {
	// Pin authStorage to modelRegistry.authStorage — mirrors the createAgentSession invariant.
	const modelRegistry =
		options.modelRegistry ?? new ModelRegistry(options.authStorage ?? (await awaitAbortable(discoverAuthStorage())));
	if (options.authStorage && options.authStorage !== modelRegistry.authStorage) {
		throw new Error(
			"options.authStorage and options.modelRegistry.authStorage must be the same instance when both are provided",
		);
	}
	throwIfRunAborted(abortSignal);
	if (options.modelRegistry === undefined) {
		await awaitAbortable(modelRegistry.refresh());
	} else {
		logger.debug("Agent run reusing parent modelRegistry; skipping refresh");
	}
	throwIfRunAborted(abortSignal);
	return modelRegistry;
}

/** Resolve the model and effort the child runs at, and record both on its progress row. */
async function resolveRunModel(ctx: ChildSessionContext): Promise<RunModel> {
	const { options, settings, modelPatterns, monitor } = ctx;
	throwIfRunAborted(monitor.abortSignal);
	const modelRegistry = await openModelRegistry(options, monitor.abortSignal, ctx.awaitAbortable);
	const resolution = await ctx.awaitAbortable(
		resolveModelOverrideWithAuthFallback(
			modelPatterns,
			options.parentActiveModelPattern,
			modelRegistry,
			settings,
			options.id,
		),
	);
	const { model, authFallbackUsed } = resolution;
	if (resolution.warning) {
		logger.warn("Agent model resolution warning", { warning: resolution.warning, requested: modelPatterns });
	}
	if (authFallbackUsed && model) {
		logger.warn("Agent model has no working credentials; falling back to parent session model", {
			requested: modelPatterns,
			parentModel: options.parentActiveModelPattern,
			resolvedProvider: model.provider,
			resolvedModel: model.id,
		});
	}
	const retryFallbackRole = installAgentRetryFallbackChain({
		settings,
		id: options.id,
		candidates: resolveAgentRetryFallbackCandidates(modelPatterns, modelRegistry, settings),
		model,
		authFallbackUsed,
	});
	if (retryFallbackRole) {
		logger.debug("Configured agent runtime model fallback chain", {
			role: retryFallbackRole,
			requested: modelPatterns,
		});
	}
	const selected = resolveEffectiveSubagentThinkingLevel(
		resolution.explicitThinkingLevel,
		resolution.thinkingLevel,
		options.thinkingLevel,
	);
	const thinkingLevel =
		selected === undefined || selected === ThinkingLevel.Inherit
			? (options.parentThinkingLevel ?? ThinkingLevel.Inherit)
			: selected;
	if (model) {
		if (model.contextWindow && model.contextWindow > 0) monitor.progress.contextWindow = model.contextWindow;
		// The badge carries the effort this agent ACTUALLY runs at, not only an effort somebody typed as
		// a `:level` suffix. Effort inherits on its own axis (this agent's row, then the blanket agent
		// effort, then frontmatter, then the session), so the ordinary case is an agent running at a
		// definite effort that no suffix names; a bare model there reads as "no effort level" next to a
		// sibling that shows one.
		monitor.progress.resolvedModel = resolvedModelBadge(model, thinkingLevel);
	}
	return { modelRegistry, model, thinkingLevel };
}

/**
 * Derive agent-scoped telemetry from the parent's config so the child loop's spans nest under the
 * parent's active execute_tool span (OTEL context propagation handles parent linkage), carry the
 * agent's own identity, and use the agent's own session id for `gen_ai.conversation.id`. Records the
 * parent → agent handoff span.
 */
function deriveAgentTelemetry(options: ExecutorOptions): AgentTelemetryConfig | undefined {
	const parentTelemetry = options.parentTelemetry;
	if (!parentTelemetry) return undefined;
	const agentIdentity: AgentIdentity = {
		id: options.id,
		name: options.agent.name,
		description: options.agent.description,
	};
	recordHandoff(resolveTelemetry(parentTelemetry, parentTelemetry.conversationId), {
		fromAgent: parentTelemetry.agent,
		toAgent: agentIdentity,
	});
	// Clear the parent's conversationId; the child loop falls back to its own AgentLoopConfig.sessionId.
	return { ...parentTelemetry, agent: agentIdentity, conversationId: undefined };
}

/** The agent's own system prompt section; it depends only on the run's fixed inputs. */
function renderAgentSystemPrompt(options: ExecutorOptions, ircEnabled: boolean): string {
	const { normalized: normalizedOutputSchema } = normalizeSchema(options.outputSchema);
	return prompt.render(agentPrompts["agent/system-prompt"].text, {
		agent: options.agent.systemPrompt,
		context: options.context?.trim() ?? "",
		planReference: options.planReference?.content ?? "",
		planReferencePath: options.planReference?.path ?? "",
		worktree: options.worktree ?? "",
		outputSchema: normalizedOutputSchema,
		outputSchemaOverridesAgent: options.outputSchemaOverridesAgent === true,
		ircEnabled,
	});
}

/** Place the agent's section before the last section of the default prompt. */
function spliceAgentSystemPrompt(defaultPrompt: string[], agentPrompt: string): string[] {
	return defaultPrompt.length === 0
		? [agentPrompt]
		: defaultPrompt.slice(0, -1).concat([agentPrompt, defaultPrompt[defaultPrompt.length - 1]!]);
}

/**
 * Build the options every session of this run is created with. The lifecycle reviver rebuilds an
 * equivalent session from the same JSONL file through the same builder, so it gets the exact options
 * of the original run (same agent id, tools, model, system prompt, artifacts dir); only the
 * SessionManager differs.
 */
function childSessionOptionsBuilder(ctx: ChildSessionContext, runModel: RunModel): ChildSessionOptionsBuilder {
	const { options, marks } = ctx;
	const { modelRegistry, model, thinkingLevel } = runModel;
	const id = options.id;
	// A requested pattern that resolved to no model is handed to the session to resolve itself, with
	// the parent's model as its auth fallback and the run's retry chain as its fallback role.
	const deferredPattern = !model && options.modelOverride !== undefined;
	const mcpProxyTools = options.mcpManager ? createMCPProxyTools(options.mcpManager) : [];
	const telemetry = deriveAgentTelemetry(options);
	let agentPrompt: string | undefined;
	return (sessionManager, settings) => ({
		cwd: sessionManager.getCwd(),
		authStorage: modelRegistry.authStorage,
		modelRegistry,
		settings,
		bypassAllApprovals: options.bypassAllApprovals,
		parentApprovalBypassed: options.parentApprovalBypassed,
		model,
		modelPattern: deferredPattern ? ctx.modelPatterns : undefined,
		modelPatternAuthFallback: deferredPattern ? options.parentActiveModelPattern : undefined,
		modelPatternFallbackRole: deferredPattern ? `${AGENT_RETRY_FALLBACK_ROLE_PREFIX}${id}` : undefined,
		thinkingLevel,
		toolNames: ctx.toolNames,
		requireYieldTool: true,
		contextFiles: options.contextFiles,
		skills: options.skills,
		promptTemplates: options.promptTemplates,
		workspaceTree: options.workspaceTree,
		rules: options.rules,
		preloadedExtensionPaths: options.preloadedExtensionPaths,
		preloadedNamedExtensionPaths: options.preloadedNamedExtensionPaths,
		preloadedCustomToolPaths: options.preloadedCustomToolPaths,
		systemPrompt: defaultPrompt => {
			agentPrompt ??= renderAgentSystemPrompt(options, ctx.ircEnabled);
			return spliceAgentSystemPrompt(defaultPrompt, agentPrompt);
		},
		sessionManager,
		hasUI: false,
		spawns: ctx.spawnsEnv,
		taskDepth: ctx.childDepth,
		maxNestedSpawnDepth: ctx.maxNestedSpawnDepth,
		parentHindsightSessionState: options.parentHindsightSessionState,
		parentMnemopiSessionState: options.parentMnemopiSessionState,
		parentArgot: options.parentArgot,
		parentTaskPrefix: id,
		parentAgentId: options.parentAgentId,
		agentId: id,
		agentDisplayName: options.agent.name,
		enableLsp: options.enableLsp ?? true,
		skipPythonPreflight: Array.isArray(ctx.toolNames) && !ctx.toolNames.includes("eval"),
		enableMCP: !options.mcpManager,
		mcpManager: options.mcpManager,
		customTools: mcpProxyTools.length > 0 ? mcpProxyTools : undefined,
		localProtocolOptions: options.localProtocolOptions,
		telemetry,
		parentEvalSessionId: options.parentEvalSessionId,
		onFirstChatDispatch: () => {
			marks.firstChatDispatchAt ??= performance.now();
		},
	});
}

/**
 * Create the child's session. When an abort races startup the session may still resolve later
 * holding live LSP/MCP child processes, so it is disposed when it does and a cancelled agent cannot
 * leak them.
 */
async function createChildSession(
	parentSessionId: string | undefined,
	sessionOptions: CreateAgentSessionOptions,
	awaitAbortable: AbortableAwaiter,
): Promise<AgentSession> {
	const sessionPromise = createSubagentSession(parentSessionId, sessionOptions);
	try {
		return (await awaitAbortable(sessionPromise)).session;
	} catch (err) {
		void sessionPromise.then(created => created.session.dispose()).catch(() => {});
		throw err;
	}
}

/**
 * Lifecycle reviver: park closed the JSONL writer, so reopening takes the single-writer lock cleanly
 * and restores the full message history (createAgentSession → agent.replaceMessages).
 */
function createSessionReviver(
	ctx: ChildSessionContext,
	buildSessionOptions: ChildSessionOptionsBuilder,
): () => Promise<AgentSession> {
	const { options, sessionFile } = ctx;
	const id = options.id;
	return async () => {
		// Re-peek as well as re-open on every use: /move can rewrite the header after this closure was
		// created, and a deleted recorded cwd must fail closed rather than use open()'s general
		// interactive fallback.
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
		const revivedSettings = await ctx.settings.cloneForCwd(reopened.getCwd());
		const { session: revived } = await createSubagentSession(
			options.parentSessionId,
			buildSessionOptions(reopened, revivedSettings),
		);
		syncStatusWithTurns(AgentRegistry.global(), id, revived);
		return revived;
	};
}

interface OpenedChildSession {
	session: AgentSession;
	/** Null for isolated runs: the worktree is merged and cleaned after the run, so it cannot resume. */
	reviveSession: (() => Promise<AgentSession>) | null;
}

/** Open the child's durable session on its resolved model and register it with the monitor and the agent registry. */
async function openChildSession(ctx: ChildSessionContext): Promise<OpenedChildSession> {
	const { options, monitor, marks } = ctx;
	const runModel = await resolveRunModel(ctx);
	marks.resolvedAt = performance.now();
	const sessionManager = await ctx.awaitAbortable(
		SessionManager.open(ctx.sessionFile, undefined, undefined, {
			initialCwd: ctx.effectiveCwd,
			suppressBreadcrumb: true,
		}),
	);
	if (options.parentArtifactManager) {
		sessionManager.adoptArtifactManager(options.parentArtifactManager);
	}
	marks.sessionOpenedAt = performance.now();
	const buildSessionOptions = childSessionOptionsBuilder(ctx, runModel);
	const session = await createChildSession(
		options.parentSessionId,
		buildSessionOptions(sessionManager, ctx.settings),
		ctx.awaitAbortable,
	);
	marks.sessionCreatedAt = performance.now();
	monitor.setActiveSession(session);
	// Adopted (kept-alive) agents report later turns to the registry through the session's own
	// events; the subscription survives this run.
	syncStatusWithTurns(AgentRegistry.global(), options.id, session);
	// No override resolved, so the session picked its model itself: the parent's, or the persisted
	// default. The badge names what runs either way, at the effort the session settled on — `auto`
	// resolved, an unsupported level clamped — the same authority the follow-up turn reads.
	const progress = monitor.progress;
	if (!progress.resolvedModel && session.model) {
		progress.resolvedModel = resolvedModelBadge(session.model, session.thinkingLevel);
		progress.contextWindow ??= session.model.contextWindow || undefined;
	}
	const reviveSession = options.worktree === undefined ? createSessionReviver(ctx, buildSessionOptions) : null;
	return { session, reviveSession };
}

/**
 * Bring up the child's extension runner against its session and deliver `session_start`, draining the
 * messages extensions sent while starting before the first prompt.
 */
async function initializeChildExtensions(
	session: AgentSession,
	id: string,
	awaitAbortable: AbortableAwaiter,
): Promise<void> {
	const extensionRunner = session.extensionRunner;
	if (!extensionRunner) return;
	const pendingExtensionMessages: Array<Promise<unknown>> = [];
	const trackExtensionSend = (action: "sendMessage" | "sendUserMessage", send: Promise<unknown>): void => {
		pendingExtensionMessages.push(
			send.catch(e => {
				logger.error(`Extension ${action} failed`, { error: errorMessage(e) });
			}),
		);
	};
	// Name the child on its own runner before initialize, so an approval card raised from it carries
	// a byline. See `ExtensionRunner.agentId`.
	extensionRunner.setAgentId(id);
	extensionRunner.initialize(
		{
			sendMessage: (message, options) =>
				trackExtensionSend("sendMessage", session.sendCustomMessage(message, options)),
			sendUserMessage: (content, options) =>
				trackExtensionSend("sendUserMessage", session.sendUserMessage(content, options)),
			appendEntry: (customType, data) => {
				session.sessionManager.appendCustomEntry(customType, data);
			},
			setLabel: (targetId, label) => {
				session.sessionManager.appendLabelChange(targetId, label);
			},
			getActiveTools: () => session.getActiveToolNames(),
			getAllTools: () => session.getAllToolNames(),
			setActiveTools: (toolNames: string[]) =>
				session.setActiveToolsByName(toolNames.filter(name => !PARENT_OWNED_TOOL_NAMES.has(name))),
			getCommands: () => getSessionSlashCommands(session),
			setModel: (model, options) => runExtensionSetModel(session, model, options),
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

/**
 * Announce the child's start, drop parent-owned tools, record its session init, bridge the run's
 * abort signal into the session, and bring up its extensions.
 */
async function startChildSession(
	ctx: ChildSessionContext,
	session: AgentSession,
	sessionAbortSignal: AbortSignal,
): Promise<void> {
	const { options, monitor } = ctx;
	options.eventBus?.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
		id: options.id,
		agent: options.agent.name,
		parentToolCallId: options.parentToolCallId,
		detached: options.detached,
		agentSource: options.agent.source,
		description: options.description,
		status: "started",
		sessionFile: ctx.sessionFile,
		index: options.index,
	});
	const agentToolNames = session.getActiveToolNames();
	const childToolNames = agentToolNames.filter(name => !PARENT_OWNED_TOOL_NAMES.has(name));
	if (childToolNames.length !== agentToolNames.length) {
		await ctx.awaitAbortable(session.setActiveToolsByName(childToolNames));
	}
	session.sessionManager.appendSessionInit({
		systemPrompt: session.agent.state.systemPrompt.join("\n\n"),
		task: options.task,
		tools: session.getActiveToolNames(),
		spawns: ctx.spawnsEnv,
		readSummarize: options.agent.readSummarize,
		maxNestedSpawnDepth: ctx.maxNestedSpawnDepth,
		outputSchema: options.outputSchema,
	});
	const abortSignal = monitor.abortSignal;
	abortSignal.addEventListener(
		"abort",
		() => {
			void monitor.abortActiveSession();
		},
		{ once: true, signal: sessionAbortSignal },
	);
	// Defensive: if the wall-clock timer (or external signal) fired during the awaited setup above,
	// the listener registration races the dispatch and may not observe the already-fired abort event.
	// Mirror it manually.
	if (abortSignal.aborted) {
		void monitor.abortActiveSession();
	}
	await initializeChildExtensions(session, options.id, ctx.awaitAbortable);
}

/**
 * Autoload skills via sendCustomMessage (same mechanic as /skill:<name>).
 *
 * Settled against `session.skills`, because this is the first point where the child's own skill set
 * exists. A spawn whose `cwd` differs from the parent's inherits no skills and rediscovers its own, so
 * the spawner cannot match the declared names: it forwards them as a `deferred` plan and they are
 * judged present or missing against the tree the child was pointed at.
 */
async function autoloadChildSkills(session: AgentSession, options: ExecutorOptions): Promise<void> {
	for (const skill of settleAutoloadSkills(options.autoloadSkills, session.skills, options.agent.name)) {
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
}

/**
 * Complete the turn facts for a run whose setup may have been cancelled before `driveSessionToYield`
 * ever ran: they are completed here rather than assumed. No verdict is formed; see `resolveRunVerdict`.
 */
function withSetupAbort(outcome: DriveOutcome, monitor: AgentRunMonitor): DriveOutcome {
	if (!monitor.abortSignal.aborted) return outcome;
	if (!monitor.isAbortedRun()) return { ...outcome, turnCutShort: true };
	return {
		...outcome,
		turnCutShort: true,
		turnAborted: true,
		turnAbortReason: outcome.turnAbortReason ?? monitor.resolveAbortReasonText(),
	};
}

interface RunRelease {
	options: ExecutorOptions;
	monitor: AgentRunMonitor;
	unsubscribe: (() => void) | undefined;
	turnAborted: boolean;
	agentIdleTtlMs: number;
	prune: AgentPruneBudget;
	reviveSession: (() => Promise<AgentSession>) | null;
}

/**
 * Wait, at most 5s, for an in-flight session abort to settle. A timeout or error leaves the teardown
 * that follows to proceed best-effort.
 */
async function settleActiveSessionAbort(monitor: AgentRunMonitor): Promise<void> {
	const { signal, cancel } = scopedTimeoutSignal(5000);
	try {
		await untilAborted(signal, () => monitor.waitForActiveSessionAbort());
	} catch {
		// Timeouts and abort errors are expected here; teardown continues either way.
	} finally {
		cancel();
	}
}

/**
 * Tear down a finished run: wait (bounded) for the session abort to settle, detach the monitor, and
 * settle the session's registry lifecycle.
 */
async function releaseRunSession(release: RunRelease): Promise<void> {
	const { options, monitor } = release;
	await settleActiveSessionAbort(monitor);
	try {
		release.unsubscribe?.();
	} catch {
		// Ignore unsubscribe errors
	}
	const session = monitor.takeActiveSession();
	if (!session) return;
	monitor.captureSalvage(session);
	await finalizeSubagentLifecycle({
		id: options.id,
		session,
		aborted: release.turnAborted,
		abortKind: monitor.abortKind(),
		keepAlive: options.keepAlive !== false,
		isolated: options.worktree !== undefined,
		agentIdleTtlMs: release.agentIdleTtlMs,
		prune: release.prune,
		// `captureSalvage` ran on the line above, so the sign-off is this run's LAST assistant text
		// rather than every assistant message it produced.
		signOff: agentSignOffText(monitor),
		reviveSession: release.reviveSession,
	});
}

function elapsedMs(from: number | undefined, to: number | undefined): number | undefined {
	return from !== undefined && to !== undefined ? Math.round(to - from) : undefined;
}

/**
 * Log the launch-latency breakdown (agent invocation → first chat dispatch). Phase deltas are
 * `performance.now()` spans; the task-tool concurrency brackets use the `Date.now()` epochs captured
 * by the spawn site (invokedAt before acquire, acquiredAt after) so queue wait and pre-run setup are
 * reported apart.
 */
function logLaunchTiming(options: ExecutorOptions, startTime: number, marks: LaunchMarks): void {
	const { invokedAt, acquiredAt } = options;
	const setupToFirstChatMs = elapsedMs(marks.perfStart, marks.firstChatDispatchAt);
	logger.debug("agent launch timing", {
		id: options.id,
		agent: options.agent.name,
		queueMs: elapsedMs(invokedAt, acquiredAt),
		preRunMs: elapsedMs(acquiredAt, startTime),
		resolveMs: elapsedMs(marks.perfStart, marks.resolvedAt),
		sessionOpenMs: elapsedMs(marks.resolvedAt, marks.sessionOpenedAt),
		createSessionMs: elapsedMs(marks.sessionOpenedAt, marks.sessionCreatedAt),
		readyMs: elapsedMs(marks.sessionCreatedAt, marks.readyAt),
		promptToFirstChatMs: elapsedMs(marks.readyAt, marks.firstChatDispatchAt),
		setupToFirstChatMs,
		invokeToFirstChatMs:
			invokedAt !== undefined && setupToFirstChatMs !== undefined
				? Math.round(startTime - invokedAt) + setupToFirstChatMs
				: undefined,
	});
}

/**
 * Set up the child's session, drive it to a yield, and release it. Setup can fail or be cancelled
 * before the turn ever starts, so the reported facts cover setup as well as the turn.
 */
async function driveChildRun(
	ctx: ChildSessionContext,
	startTime: number,
	lifecycle: Pick<RunRelease, "agentIdleTtlMs" | "prune">,
): Promise<DriveOutcome & { durationMs: number }> {
	const { options, monitor } = ctx;
	const abortSignal = monitor.abortSignal;
	const sessionAbortController = new AbortController();
	let outcome: DriveOutcome = { turnCutShort: false, turnAborted: false };
	let unsubscribe: (() => void) | undefined;
	let reviveSession: (() => Promise<AgentSession>) | null = null;
	try {
		const opened = await openChildSession(ctx);
		reviveSession = opened.reviveSession;
		await startChildSession(ctx, opened.session, sessionAbortController.signal);
		unsubscribe = monitor.attach(opened.session);
		throwIfRunAborted(abortSignal);
		await autoloadChildSkills(opened.session, options);
		ctx.marks.readyAt = performance.now();
		outcome = await driveSessionToYield(opened.session, monitor, options.task, options.outputSchema);
	} catch (err) {
		// Setup threw: a real failure unless the run was cancelled, in which case the abort facts
		// describe it.
		if (!abortSignal.aborted) {
			outcome = { ...outcome, failure: err instanceof Error ? err.stack || err.message : String(err) };
		}
	} finally {
		outcome = withSetupAbort(outcome, monitor);
		sessionAbortController.abort();
		await releaseRunSession({
			options,
			monitor,
			unsubscribe,
			turnAborted: outcome.turnAborted,
			...lifecycle,
			reviveSession,
		});
	}
	logLaunchTiming(options, startTime, ctx.marks);
	return { ...outcome, durationMs: Date.now() - startTime };
}

/**
 * Run a single agent in-process.
 */
export async function runSubprocess(options: ExecutorOptions): Promise<SingleResult> {
	const { agent, id, worktree, modelOverride, signal } = options;
	const startTime = Date.now();
	if (signal?.aborted) return cancelledBeforeStart(options);

	// An agent ALWAYS gets a durable session file — never an in-memory session that would silently lose
	// its transcript (Law 10, no silent fallback). When the caller provides no artifacts dir, route the
	// transcript to the durable sessions dir so the run stays studyable and revivable via
	// history://<id> (GRAN-1).
	const sessionFile = options.artifactsDir
		? path.join(options.artifactsDir, sessionFileName(id))
		: path.join(getSessionsDir(), sessionFileName(`orphan-task-${id}`));
	const effectiveCwd = worktree ?? options.cwd;
	const settings = await createSubagentSettingsForCwd(
		options.settings ?? Settings.isolated(),
		effectiveCwd,
		agent.readSummarize === false ? { "read.summarize.enabled": false } : undefined,
		options.parentServiceTier,
	);
	const maxNestedSpawnDepth = resolveAgentMaxNestedSpawnDepth(settings, agent.name);
	const childDepth = (options.taskDepth ?? 0) + 1;
	const atMaxDepth = !canSpawnAtDepth(maxNestedSpawnDepth, childDepth);

	const monitor = createAgentRunMonitor({
		index: options.index,
		id,
		agent,
		task: options.task,
		assignment: options.assignment,
		description: options.description,
		modelRegistry: options.modelRegistry,
		settings,
		parentActiveModelPattern: options.parentActiveModelPattern,
		obfuscateProviderText: options.obfuscateProviderText,
		completeImpl: options.completeImpl,
		modelOverride,
		signal,
		onProgress: options.onProgress,
		eventBus: options.eventBus,
		parentToolCallId: options.parentToolCallId,
		detached: options.detached,
		sessionFile,
		softRequestBudget: resolveSoftRequestBudget(settings, agent.name),
		softRequestBudgetNotice: settings.get("agent.softRequestBudgetNotice") ?? false,
		maxRuntimeMs: nonNegativeInt(options.maxRuntimeMs ?? settings.get("agent.maxRuntimeMs")),
	});

	const done = await driveChildRun(
		{
			options,
			monitor,
			settings,
			sessionFile,
			effectiveCwd,
			// The caller resolved this through `resolveAgentModel`, the one owner of "what model does
			// this agent run", and handed the patterns down. Falling back to `agent.model` here would let
			// the definition's frontmatter decide on any path that forgot to resolve.
			modelPatterns: normalizeModelPatterns(modelOverride),
			toolNames: resolveChildToolNames(agent, atMaxDepth, settings),
			spawnsEnv: childSpawnsEnv(agent, atMaxDepth),
			childDepth,
			maxNestedSpawnDepth,
			ircEnabled: isIrcEnabled(settings, childDepth, maxNestedSpawnDepth),
			awaitAbortable: createAbortableAwaiter(monitor.abortSignal),
			marks: { perfStart: performance.now() },
		},
		startTime,
		{ agentIdleTtlMs: resolveAgentIdleTtlMs(settings), prune: resolveAgentPruneBudget(settings) },
	);
	monitor.finish();

	return finalizeRunResult({
		monitor,
		done,
		index: options.index,
		id,
		agent,
		task: options.task,
		assignment: options.assignment,
		modelOverride,
		outputSchema: options.outputSchema,
		signal,
		artifactsDir: options.artifactsDir,
		eventBus: options.eventBus,
		parentToolCallId: options.parentToolCallId,
		detached: options.detached,
		sessionFile,
		startTime,
	});
}
