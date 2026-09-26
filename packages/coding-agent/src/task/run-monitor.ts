/**
 * The run monitor for one agent assignment: progress tracking, event processing, the abort and
 * soft-budget machinery, usage accumulation and output capture. `runSubprocess` in `executor.ts`
 * drives the child session; this module watches it.
 */

import type { AgentEvent } from "@veyyon/agent-core";
import type { Usage } from "@veyyon/ai";
import { emptyUsage } from "@veyyon/catalog/models";
import type { SideCompleteImpl } from "@veyyon/kernel/session/side-complete";
import { errorMessage, isRecord, logger, popLoopPhase, pushLoopPhase, truncate } from "@veyyon/utils";
import type { StreamDecoder } from "argot";
import { createAgentStreamDecoder, expandAgentReturn } from "../argot-wire";
import type { ModelRegistry } from "../config/model-registry";
import { resolveModelOverride } from "../config/model-resolver";
import type { Settings } from "../config/settings";
import { AgentRegistry } from "../registry/agent-registry";
import type { AgentSession } from "../session/agent-session";
import type { AgentSessionEvent } from "../session/agent-session-types";
// SIDE-EFFECT IMPORT, and it is load-bearing.
//
// `tools/agent/yield.ts` registers the `yield` handler on `subprocessToolRegistry` at module load, and
// this module's completion tracking reads it: no handler means `recordExtractedToolData` is never
// called, so `yieldCalled` stays false, the agent is prompted again for a result it already
// returned, and the run finally reports a missing yield with exit code 1. Nothing in the extracted
// output survives either.
//
// Until now that registration arrived by luck of import order: a child session builds its own
// `yield` tool, which loads the module, and in-process children happen to do that before they can
// emit a yield event. The dependency was real, unstated and unenforced, and it broke the moment the
// child session was a stub rather than a real one. Stating it here is what makes the parent's
// interpretation of a yield independent of who built the child.
import "../tools/agent/yield";
import type { EventBus } from "../utils/event-bus";
import { generateTaskLabel } from "./label";
// SIDE-EFFECT IMPORT, for the same reason as `../tools/agent/yield` above.
//
// `nested-task-details.ts` registers the `task` handler, and this module's `recordExtractedToolData`
// is what reads it: no handler means a child's own spawns never reach `extractedToolData.task`, so a
// two-level delegation reports one level and everything under it stays invisible. The registration
// used to ride in on `task/render.ts`, which drew the tree that consumed it; the drawing is a view
// now and imports nothing terminal, so the protocol half states its own dependency here.
import "./nested-task-details";
import { type SubprocessToolEvent, subprocessToolRegistry, YIELD_TOOL_NAME } from "./subprocess-tool-registry";
import {
	type AgentDefinition,
	type AgentProgress,
	TASK_SUBAGENT_EVENT_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
	type TaskToolDetails,
} from "./types";

export type AbortReason = "signal" | "terminate" | "timeout" | "budget";

/** Extra requests allowed after a budget stop for the forced yield to land before the run is hard-aborted. */
export const BUDGET_STOP_GRACE_REQUESTS = 5;

/** Steering notice injected when an agent crosses its soft request budget. */
export function buildBudgetNotice(requests: number, budget: number): string {
	return `[budget notice] You have used ${requests} requests in this run (soft budget: ${budget}). Wrap up now: finish the current step and yield your final report. At ${Math.ceil(budget * 1.5)} requests the run is force-stopped and you will be asked to yield whatever you have.`;
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

/** Tool argument keys whose value previews a call, in priority order. */
const PREVIEW_ARG_KEYS = ["command", "file_path", "path", "pattern", "query", "url", "task", "prompt"];

/** A short preview of a tool call's arguments for display. */
function extractToolArgsPreview(args: Record<string, unknown> | undefined): string {
	if (!args) return "";
	for (const key of PREVIEW_ARG_KEYS) {
		const value = args[key];
		if (typeof value === "string" && value) return truncate(value, 60);
	}
	return "";
}

/** The arguments a `tool_execution_start` carries: the traced `toolArgs` when present, else `args`. */
function toolStartArgs(
	event: Extract<AgentEvent, { type: "tool_execution_start" }>,
): Record<string, unknown> | undefined {
	if ("toolArgs" in event && isRecord(event.toolArgs)) return event.toolArgs;
	return isRecord(event.args) ? event.args : undefined;
}

/** The handler-facing view of a finished tool call. */
function toSubprocessToolEvent(event: Extract<AgentEvent, { type: "tool_execution_end" }>): SubprocessToolEvent {
	const eventRecord: unknown = event;
	return {
		toolName: event.toolName,
		toolCallId: event.toolCallId,
		args: isRecord(eventRecord) && isRecord(eventRecord.args) ? eventRecord.args : {},
		result: event.result,
		isError: event.isError,
	};
}

/** The `TaskToolDetails` snapshot a nested `task` call streams in its partial result, if any. */
function inflightTaskDetails(partialResult: unknown): TaskToolDetails | undefined {
	const details = isRecord(partialResult) ? partialResult.details : undefined;
	return isRecord(details) && "results" in details ? (details as unknown as TaskToolDetails) : undefined;
}

/** The text of a `text` content block, or undefined for any other block. */
function textBlockText(block: unknown): string | undefined {
	return isRecord(block) && block.type === "text" && typeof block.text === "string" ? block.text : undefined;
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

/** Adds one assistant message's reported usage, tokens and cost, to the run total. */
function addUsage(total: Usage, usage: Record<string, unknown>): void {
	total.input += getNumberField(usage, "input") ?? 0;
	total.output += getNumberField(usage, "output") ?? 0;
	total.cacheRead += getNumberField(usage, "cacheRead") ?? 0;
	total.cacheWrite += getNumberField(usage, "cacheWrite") ?? 0;
	total.totalTokens += getNumberField(usage, "totalTokens") ?? 0;
	total.reasoningTokens = (total.reasoningTokens ?? 0) + (getNumberField(usage, "reasoningTokens") ?? 0);
	const cost = usage.cost;
	if (!isRecord(cost)) return;
	total.cost.input += getNumberField(cost, "input") ?? 0;
	total.cost.output += getNumberField(cost, "output") ?? 0;
	total.cost.cacheRead += getNumberField(cost, "cacheRead") ?? 0;
	total.cost.cacheWrite += getNumberField(cost, "cacheWrite") ?? 0;
	total.cost.total += getNumberField(cost, "total") ?? 0;
}

/** Inputs for the run monitor driving one agent assignment. */
export interface RunMonitorArgs {
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
	/**
	 * The parent session's live model selector. Label generation inherits it when
	 * the tiny/commit/smol roles are unset, the way a session title inherits the
	 * live model: a spawn is not a headless context, and resolving the label
	 * through the persisted default role instead ran it on whatever the config
	 * file last named, which is not necessarily a model that answers.
	 */
	parentActiveModelPattern?: string;
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
 * The run-monitoring core of `runSubprocess`: progress tracking, event
 * processing, abort/budget machinery, usage accumulation, and output capture
 * for one assignment run.
 */
export interface AgentRunMonitor {
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

export function createAgentRunMonitor(args: RunMonitorArgs): AgentRunMonitor {
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
	// assistant text becomes the parent's tool result. See `expandAgentReturn`
	// (argot-wire.ts) for why this seam exists; the only wrinkle here is that the
	// child codec lives on the currently-attached session.
	const expandChildOutput = (text: string): string => {
		try {
			return expandAgentReturn(activeSession?.getArgotSession?.(), text);
		} catch (error) {
			logger.warn("Agent return-boundary argot expansion failed", {
				error: errorMessage(error),
			});
			return text;
		}
	};

	const abortActiveSession = (): Promise<void> => {
		const session = activeSession;
		if (!session) return Promise.resolve();
		activeSessionAbortPromise ??= session.abort().catch(error => {
			logger.debug("Agent session abort cleanup failed", {
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
					logger.debug("Agent budget-stop abort failed", {
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
	// `task.maxRuntimeMs > 0` to cap each agent's lifetime.
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
					logger.warn("Agent runtime limit exceeded; aborting", {
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
			return `Agent runtime limit exceeded (task.maxRuntimeMs=${maxRuntimeMs})`;
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
		// The model the label inherits when no title role is configured. A pattern
		// that no longer resolves (a retired id, a signed-out provider) leaves the
		// title generator on its headless path, the persisted default role.
		const liveModel = args.parentActiveModelPattern
			? resolveModelOverride([args.parentActiveModelPattern], args.modelRegistry, args.settings).model
			: undefined;
		generateTaskLabel(
			labelSource,
			args.modelRegistry,
			args.settings,
			id,
			args.obfuscateProviderText,
			args.completeImpl,
			liveModel,
		)
			.then(label => {
				if (!label || abortSignal.aborted || progress.description) return;
				progress.description = label;
				if (!resolved) scheduleProgress();
			})
			.catch(err => {
				logger.debug("Agent label generation failed", {
					id,
					error: errorMessage(err),
				});
			});
	}

	/** `content` or `usage` of an event or message when it is an object; undefined otherwise. */
	const messageField = (message: unknown, key: "content" | "usage"): unknown =>
		isRecord(message) ? message[key] : undefined;

	// Lazily build the per-message stream decoder from the child's own codec, so a
	// codec armed just before prompting is picked up. `push`/`flush`/`reset` are the
	// only argot calls here; all handle logic lives in argot's StreamDecoder.
	const ensureStreamDecoder = (): StreamDecoder | undefined => {
		if (!streamDecoderReady) {
			streamDecoder = createAgentStreamDecoder(activeSession?.getArgotSession?.());
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
			logger.warn("Agent stream-display argot decode failed", { error: errorMessage(error) });
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
			logger.warn("Agent stream-display argot flush failed", { error: errorMessage(error) });
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
			const text = textBlockText(block);
			if (!text) continue;
			recentOutputTail += expandChildOutput(text);
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

	const emitAgentEvent = (event: AgentSessionEvent) => {
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

	const onToolExecutionStart = (event: Extract<AgentEvent, { type: "tool_execution_start" }>): void => {
		progress.toolCount++;
		progress.currentTool = event.toolName;
		progress.currentToolArgs = extractToolArgsPreview(toolStartArgs(event));
		progress.currentToolStartMs = Date.now();
		const intent = event.intent?.trim();
		if (intent) progress.lastIntent = intent;
		if (event.toolName === YIELD_TOOL_NAME && !yieldCalled) yieldCallPending = true;
		// Reset any prior in-flight task snapshot so we don't show stale
		// nested progress when the agent enters a fresh `task` call.
		if (event.toolName === "task") progress.inflightTaskDetails = undefined;
	};

	/** Move the running tool onto the recent-tools list (newest first, five kept). */
	const archiveCurrentTool = (): void => {
		if (progress.currentTool) {
			progress.recentTools.unshift({
				tool: progress.currentTool,
				args: progress.currentToolArgs || "",
				endMs: Date.now(),
			});
			if (progress.recentTools.length > 5) progress.recentTools.pop();
		}
		progress.currentTool = undefined;
		progress.currentToolArgs = undefined;
		progress.currentToolStartMs = undefined;
	};

	const onToolExecutionEnd = (event: Extract<AgentEvent, { type: "tool_execution_end" }>): void => {
		archiveCurrentTool();
		// The finalized TaskToolDetails will be captured below into
		// `extractedToolData.task`; drop the in-flight snapshot so the
		// renderer doesn't double-count it against the final entry.
		if (event.toolName === "task") progress.inflightTaskDetails = undefined;

		const handler = subprocessToolRegistry.getHandler(event.toolName);
		if (!handler) {
			if (event.toolName === YIELD_TOOL_NAME) reportMissingYieldHandler();
			return;
		}
		const toolEvent = toSubprocessToolEvent(event);
		const data = handler.extractData?.(toolEvent);
		if (data !== undefined) recordExtractedToolData(event.toolName, data);
		if (event.toolName === YIELD_TOOL_NAME) yieldCallPending = false;
		if (handler.shouldTerminate?.(toolEvent)) requestAbort("terminate");
	};

	/**
	 * FAIL LOUD, never silently. A yield with no handler is a broken build (see the
	 * side-effect import at the top of this file), and the quiet version of this is what
	 * hid it: the result is dropped, the agent is asked again, and the run ends as a
	 * missing-yield failure that names the agent rather than the wiring.
	 */
	const reportMissingYieldHandler = (): void => {
		logger.error(
			`Agent ${id} returned a ${YIELD_TOOL_NAME} result and no ${YIELD_TOOL_NAME} handler is registered on subprocessToolRegistry. ` +
				`The result cannot be read, so this run will report a missing yield. This is a build wiring fault, not an agent fault: ` +
				`task/run-monitor.ts must import tools/agent/yield.ts for its registration side effect.`,
		);
	};

	/**
	 * Surface nested-agent progress mid-flight. The child task tool emits
	 * incremental `onUpdate` calls carrying its current `TaskToolDetails`
	 * (results + progress); stash the latest snapshot so the parent UI can render
	 * the in-flight subtree without waiting for the call to finish. True when a
	 * snapshot was taken.
	 */
	const onToolExecutionUpdate = (event: Extract<AgentEvent, { type: "tool_execution_update" }>): boolean => {
		if (event.toolName !== "task") return false;
		const details = inflightTaskDetails(event.partialResult);
		if (!details) return false;
		progress.inflightTaskDetails = details;
		return true;
	};

	const onMessageUpdate = (event: Extract<AgentEvent, { type: "message_update" }>): void => {
		if (event.message?.role !== "assistant") return;
		const assistantEvent: { type?: string; delta?: unknown } | undefined = event.assistantMessageEvent;
		if (assistantEvent?.type === "text_delta" && typeof assistantEvent.delta === "string") {
			appendRecentOutputTail(decodeStreamDelta(assistantEvent.delta));
			return;
		}
		if (assistantEvent && assistantEvent.type !== "text_delta") return;
		const updateContent = messageField(event.message, "content") || messageField(event, "content");
		if (Array.isArray(updateContent)) replaceRecentOutputFromContent(updateContent);
	};

	/** Capture a finished assistant message's text; true when it carries a yield call not yet recorded. */
	const collectAssistantOutput = (content: unknown[]): boolean => {
		let yieldPending = false;
		for (const block of content) {
			const text = textBlockText(block);
			if (text !== undefined) {
				outputChunks.push(expandChildOutput(text));
			} else if (isRecord(block) && block.type === "toolCall" && block.name === YIELD_TOOL_NAME && !yieldCalled) {
				yieldCallPending = true;
				yieldPending = true;
			}
		}
		// The finalized content is authoritative and complete, so refresh the live
		// preview from it (fully decoded); this also resolves any handle fragment
		// the streaming decoder was still holding.
		replaceRecentOutputFromContent(content);
		return yieldPending;
	};

	/** Build the budget notice at crossing time and steer it into the live session. */
	const sendBudgetSteer = (): void => {
		budgetSteerSent = true;
		const steerSession = activeSession;
		if (!steerSession) return;
		// Send behind an async boundary: a synchronously-throwing send must never
		// take down event processing (which escalates to terminate).
		const notice = buildBudgetNotice(progress.requests, softRequestBudget);
		void Promise.resolve()
			.then(() => steerSession.sendUserMessage(notice, { deliverAs: "steer" }))
			.catch(err => {
				logger.warn("Agent budget steer failed", {
					error: errorMessage(err),
				});
			});
	};

	/** Steer at the soft budget, stop at 1.5x, hard-abort once the post-stop grace runs out. */
	const enforceSoftRequestBudget = (): void => {
		if (softRequestBudget <= 0 || abortSent || yieldCallPending) return;
		const stopThreshold = softRequestBudget * 1.5;
		if (budgetStopRequested) {
			// Grace window after the stop: the forced yield needs a request or two;
			// a child that keeps burning requests instead of yielding is hard-aborted.
			if (progress.requests >= stopThreshold + BUDGET_STOP_GRACE_REQUESTS) requestAbort("budget");
		} else if (progress.requests >= stopThreshold) {
			requestBudgetStop();
		} else if (softRequestBudgetNotice && !budgetSteerSent && progress.requests >= softRequestBudget) {
			sendBudgetSteer();
		}
	};

	/** Accumulate a message's usage; only assistant messages count toward billing and context size. */
	const recordMessageUsage = (usage: Record<string, unknown>, fromAssistant: boolean): void => {
		// Accumulate tokens for progress display
		progress.tokens += getUsageTokens(usage);
		if (!fromAssistant) return;
		hasUsage = true;
		addUsage(accumulatedUsage, usage);
		progress.cost = accumulatedUsage.cost.total;
		// Track latest per-turn context size so the UI can show
		// "current context", not just cumulative billing volume.
		const perTurnTotal = getNumberField(usage, "totalTokens");
		if (perTurnTotal !== undefined && perTurnTotal > 0) progress.contextTokens = perTurnTotal;
	};

	/** Record a finished message. True when the progress card must flush now. */
	const onMessageEnd = (event: Extract<AgentEvent, { type: "message_end" }>): boolean => {
		const fromAssistant = event.message?.role === "assistant";
		let flush = false;
		if (fromAssistant) {
			progress.requests += 1;
			// Extract text from assistant messages, not user prompts or tool results.
			const content = messageField(event.message, "content") || messageField(event, "content");
			if (Array.isArray(content)) {
				flush = collectAssistantOutput(content);
			} else {
				// A runtime that streamed only deltas with no final snapshot: flush the
				// decoder's held tail into the preview instead.
				appendRecentOutputTail(flushStreamDecoder());
			}
			enforceSoftRequestBudget();
		}
		// Prefer message.usage, fall back to event.usage.
		const usage = messageField(event.message, "usage") || messageField(event, "usage");
		if (isRecord(usage)) recordMessageUsage(usage, fromAssistant);
		return flush;
	};

	/** Capture the run's final assistant text from the end-of-run transcript. */
	const onAgentEnd = (messages: unknown): void => {
		if (!Array.isArray(messages)) return;
		for (const msg of messages) {
			if (isRecord(msg) && msg.role === "assistant") pushExpandedText(msg.content, finalOutputChunks);
		}
	};

	/** Append each text block of `content`, expanded at the return boundary, to `chunks`. */
	const pushExpandedText = (content: unknown, chunks: string[]): void => {
		if (!Array.isArray(content)) return;
		for (const block of content) {
			const text = textBlockText(block);
			if (text) chunks.push(expandChildOutput(text));
		}
	};

	/** Apply one agent event to the progress state. True when the progress card must flush now. */
	const applyAgentEvent = (event: AgentEvent): boolean => {
		switch (event.type) {
			case "message_start":
				if (event.message?.role === "assistant") resetRecentOutput();
				return false;
			case "tool_execution_start":
				onToolExecutionStart(event);
				return false;
			case "tool_execution_end":
				onToolExecutionEnd(event);
				return true;
			case "tool_execution_update":
				return onToolExecutionUpdate(event);
			case "message_update":
				onMessageUpdate(event);
				return false;
			case "message_end":
				return onMessageEnd(event);
			case "agent_end":
				onAgentEnd(event.messages);
				return true;
			default:
				return false;
		}
	};

	const processEvent = (event: AgentEvent) => {
		if (resolved) return;
		scheduleProgress(applyAgentEvent(event));
	};

	/** Apply a session-level retry event to the progress state. True when the event was one. */
	const applyRetryEvent = (event: AgentSessionEvent): boolean => {
		switch (event.type) {
			case "auto_retry_start":
				progress.retryState = {
					attempt: event.attempt,
					maxAttempts: event.maxAttempts,
					delayMs: event.delayMs,
					errorMessage: event.errorMessage,
					startedAtMs: Date.now(),
					mode: event.mode,
				};
				progress.retryFailure = undefined;
				return true;
			case "auto_retry_end": {
				const attempt = progress.retryState?.attempt ?? event.attempt;
				progress.retryState = undefined;
				if (!event.success) {
					progress.retryFailure = {
						attempt,
						errorMessage: event.finalError ?? "Auto-retry failed",
						mode: event.mode,
					};
				}
				return true;
			}
			case "retry_fallback_applied":
				// Remember the first model only. A chain that walks three deep still
				// fell back FROM the model the user picked, not from the second one.
				progress.fellBackFrom ??= progress.resolvedModel ?? event.from;
				progress.resolvedModel = event.to;
				return true;
			case "retry_fallback_succeeded":
				progress.resolvedModel = event.model;
				return true;
			default:
				return false;
		}
	};

	const attach = (session: AgentSession): (() => void) =>
		session.subscribe(event => {
			emitAgentEvent(event);
			if (applyRetryEvent(event)) {
				scheduleProgress(true);
				return;
			}
			if (!isAgentEvent(event)) return;
			// Breadcrumb the synchronous agent event handling so the loop
			// watchdog can attribute any block to this in-process agent.
			pushLoopPhase(`agent:${id}`);
			try {
				processEvent(event);
			} catch (err) {
				logger.error("Agent event processing failed", {
					error: errorMessage(err),
				});
				requestAbort("terminate");
			} finally {
				popLoopPhase();
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
					lastAssistantSalvageText = expandAgentReturn(session.getArgotSession?.(), text);
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
