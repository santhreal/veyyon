import type { AgentEvent } from "@veyyon/agent-core";
import type { Api, Model } from "@veyyon/ai";
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
import { ModelRegistry } from "../config/model-registry";
import {
	formatModelSelectorValue,
	formatModelStringWithRouting,
	resolveModelOverride,
	resolveModelOverrideWithAuthFallback,
} from "../config/model-resolver";
import { Settings } from "../config/settings";
import type { AgentSessionEvent } from "../session/agent-session";
import type { ConfiguredThinkingLevel } from "../thinking";
import "../tools/yield";
import { ToolAbortError } from "../tools/tool-errors";
import {
	resolveSubagentAutoCloseBudget,
	resolveSubagentIdleTtlMs,
	resolveSubagentMaxNestedSpawnDepth,
	type SubagentAutoCloseBudget,
} from "./subagent-settings";
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

export type { YieldItem } from "./types";

export const MCP_CALL_TIMEOUT_MS = 60_000;

export const SOFT_REQUEST_BUDGET: Record<string, number> = {
	scout: 100,
	sonic: 100,
	default: 200,
};

export const BUDGET_STOP_GRACE_REQUESTS = 5;

export function buildBudgetNotice(requests: number, budget: number): string {
	return `[budget notice] You have used ${requests} requests in this run (soft budget: ${budget}). Wrap up now: finish the current step and yield your final report. At ${Math.ceil(budget * 1.5)} requests the run is force-stopped and you will be asked to yield whatever you have.`;
}

function formatSalvageSnippet(text: string, maxLength = 500): string {
	return truncate(collapseWhitespace(text), maxLength);
}

export function resolveEffectiveSubagentThinkingLevel(
	explicitThinkingLevel: boolean,
	resolvedThinkingLevel: ConfiguredThinkingLevel | undefined,
	configuredThinkingLevel: ConfiguredThinkingLevel | undefined,
): ConfiguredThinkingLevel | undefined {
	return explicitThinkingLevel ? resolvedThinkingLevel : (configuredThinkingLevel ?? resolvedThinkingLevel);
}

export const agentEventTypes = new Set<AgentEvent["type"]>([
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

export const isAgentEvent = (event: AgentSessionEvent): event is AgentEvent =>
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

export const SUBAGENT_RETRY_FALLBACK_ROLE_PREFIX = "subagent:";

export interface SubagentRetryFallbackCandidate {
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

export function withAbortTimeout<T>(
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

export function getReportFindingKey(value: unknown): string | null {
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

import * as fs from "node:fs/promises";
import path from "node:path";
import { type AgentIdentity, type AgentTelemetryConfig, recordHandoff, resolveTelemetry } from "@veyyon/agent-core";
import { ThinkingLevel } from "@veyyon/agent-core/thinking";
import { sessionFileName } from "@veyyon/utils/session-file";
import { runExtensionCompact, runExtensionSetModel } from "../extensibility/extensions/compact-handler";
import { getSessionSlashCommands } from "../extensibility/extensions/get-commands-handler";
import type { ExtensionUIContext } from "../extensibility/extensions/types";
import { buildSkillPromptMessage } from "../extensibility/skills";
import { subagentPrompts } from "../prompts/subagent/rows";
import { AgentLifecycleManager } from "../registry/agent-lifecycle";
import { AgentRegistry } from "../registry/agent-registry";
import type { CreateAgentSessionOptions, CreateAgentSessionResult } from "../sdk";
import type { AgentSession } from "../session/agent-session";
import { discoverAuthStorage } from "../session/auth-broker-config";
import { rootBudgetGroupOwnerId, withInheritedBudgetGroup } from "../session/cpu-limit";
import { SKILL_PROMPT_MESSAGE_TYPE, USER_INTERRUPT_LABEL } from "../session/messages";
import { SessionManager } from "../session/session-manager";
import { countNewlines, truncateTail } from "../session/streaming-output";
import type { ToolSession } from "../tools";
import { resolveEvalBackends } from "../tools/eval-backends";
import { isIrcEnabled } from "../tools/irc";
import { normalizeSchema } from "../tools/jtd-to-json-schema";
import { type ReportFindingDetails, toReviewFinding } from "../tools/review";
import type { EventBus } from "../utils/event-bus";
import { buildNamedToolChoice } from "../utils/tool-choice";
import {
	type AbortReason,
	createMCPProxyTools,
	createSubagentRunMonitor,
	createSubagentSettingsForCwd,
	currentYieldSchemaFailure,
	type ExecutorOptions,
	type FinalizeSubprocessOutputResult,
	finalizeSubprocessOutput,
	type SubagentRunMonitor,
} from "./executor";
import { settleAutoloadSkills } from "./inherited-collections";
import { YIELD_TOOL_NAME } from "./subprocess-tool-registry";

export interface DriveOutcome {
	failure?: string;
	turnCutShort: boolean;
	turnAborted: boolean;
	turnAbortReason?: string;
}

export const MAX_YIELD_RETRIES = 3;

export async function driveSessionToYield(
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
			if (!monitor.budgetStopRequested() || abortSignal.aborted) throw err;
		}

		const reminderToolChoice = buildNamedToolChoice(YIELD_TOOL_NAME, session.model);

		let retryCount = 0;
		while (!monitor.yieldCalled() && retryCount < MAX_YIELD_RETRIES && !abortSignal.aborted) {
			const budgetStop = monitor.budgetStopRequested();
			if (budgetStop) {
				retryCount = MAX_YIELD_RETRIES - 1;
				await monitor.waitForBudgetStop();
				if (monitor.yieldCalled() || abortSignal.aborted) break;
			}
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
		if (!abortSignal.aborted) {
			failure ??= err instanceof Error ? err.stack || err.message : String(err);
		}
	} finally {
		const lastAssistant = session.getLastAssistantMessage();
		if (lastAssistant?.stopReason === "error") {
			failure ??= lastAssistant.errorMessage || "Subagent failed";
		}
		const budgetStopWithoutYield = monitor.budgetStopRequested() && !monitor.yieldCalled();
		turnCutShort = abortSignal.aborted || lastAssistant?.stopReason === "aborted" || budgetStopWithoutYield;
		turnAborted = turnCutShort && monitor.isAbortedRun();
		if (turnAborted) {
			turnAbortReason = monitor.hasExplicitAbortReason()
				? monitor.resolveAbortReasonText()
				: lastAssistant?.errorMessage?.trim() || monitor.resolveAbortReasonText();
		}
	}

	return { failure, turnCutShort, turnAborted, turnAbortReason };
}

export interface FinalizeRunArgs {
	monitor: SubagentRunMonitor;
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

export interface RunVerdictInputs {
	readonly exitCodeAfterFinalize: number;
	readonly hasYield: boolean;
	readonly abortedViaYield: boolean;
	readonly yieldAbortReason?: string;
	readonly runtimeLimitExceeded: boolean;
	readonly turnCutShort: boolean;
	readonly turnAborted: boolean;
	readonly turnAbortReason?: string;
	readonly callerAborted: boolean;
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
	if (inputs.runtimeLimitExceeded && exitCode === 0) exitCode = 1;

	const aborted =
		inputs.runtimeLimitExceeded ||
		inputs.abortedViaYield ||
		(!inputs.hasYield && (inputs.turnAborted || inputs.callerAborted));

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

export async function finalizeRunResult(args: FinalizeRunArgs): Promise<SingleResult> {
	const { monitor, done, index, id, agent, task, assignment, signal, modelOverride } = args;
	const progress = monitor.progress;
	let exitCode = done.failure ? 1 : 0;
	let stderr = done.failure ?? "";

	let rawOutput = monitor.rawOutput();
	const yieldItems = progress.extractedToolData?.yield as YieldItem[] | undefined;
	const reportFindingDetails = progress.extractedToolData?.report_finding as ReportFindingDetails[] | undefined;
	const reportFindings: ReviewFinding[] | undefined = reportFindingDetails?.map(toReviewFinding);
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

	let outputMeta: { lineCount: number; charCount: number } | undefined;
	let outputPath: string | undefined;
	if (args.artifactsDir) {
		outputPath = path.join(args.artifactsDir, `${id}.md`);
		try {
			await Bun.write(outputPath, rawOutput);
			outputMeta = {
				lineCount: countNewlines(rawOutput) + 1,
				charCount: rawOutput.length,
			};
		} catch {}
	}

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

export const WAITING_ON_PEER =
	/(?:^[\s>*\-+\d.)\]]*|[.!?:;]\s+|\b(?:i am|i'm|am|is|are|still|currently|now)\s+)wait(?:ing|s)\s+(?:on|for)\b/im;

export function saysItIsWaitingOnAPeer(signOff: string | undefined): boolean {
	return signOff !== undefined && WAITING_ON_PEER.test(signOff);
}

function subagentSignOffText(monitor: SubagentRunMonitor): string | undefined {
	return monitor.lastAssistantSalvageText() ?? monitor.rawOutput();
}

export async function finalizeSubagentLifecycle(args: {
	id: string;
	session: AgentSession;
	aborted: boolean;
	abortKind?: AbortReason;
	keepAlive: boolean;
	isolated: boolean;
	agentIdleTtlMs: number;
	autoClose?: SubagentAutoCloseBudget;
	signOff?: string;
	reviveSession: (() => Promise<AgentSession>) | null;
}): Promise<void> {
	const registry = AgentRegistry.global();
	const disposeSession = async (): Promise<void> => {
		const { signal, cancel } = scopedTimeoutSignal(5000);
		try {
			await untilAborted(signal, () => args.session.dispose());
		} catch {
		} finally {
			cancel();
		}
	};

	const resumableAbort =
		args.abortKind === "budget" && args.keepAlive && !args.isolated && args.reviveSession !== null;
	if (args.aborted && !resumableAbort) {
		registry.setStatus(args.id, "aborted");
		await disposeSession();
		registry.detachSession(args.id);
		return;
	}

	if (!args.keepAlive) {
		await disposeSession();
		registry.unregister(args.id);
		return;
	}

	if (args.isolated) {
		registry.setWaitingOnPeer(args.id, saysItIsWaitingOnAPeer(args.signOff));
		registry.setStatus(args.id, "parked");
		await disposeSession();
		registry.detachSession(args.id);
		AgentLifecycleManager.global().adopt(args.id, {
			idleTtlMs: 0,
			closeParkedMs: args.autoClose?.parkedMs ?? 0,
			closeWaitingMs: args.autoClose?.waitingMs ?? 0,
		});
		return;
	}

	registry.setWaitingOnPeer(args.id, saysItIsWaitingOnAPeer(args.signOff));
	registry.setStatus(args.id, "idle");
	AgentLifecycleManager.global().adopt(args.id, {
		idleTtlMs: args.agentIdleTtlMs,
		closeParkedMs: args.autoClose?.parkedMs ?? 0,
		closeWaitingMs: args.autoClose?.waitingMs ?? 0,
		revive: args.reviveSession ?? undefined,
	});
}

export interface FollowUpTurnOptions {
	id: string;
	agent: AgentDefinition;
	message: string;
	index?: number;
	description?: string;
	signal?: AbortSignal;
	onProgress?: (progress: AgentProgress) => void;
	eventBus?: EventBus;
	parentToolCallId?: string;
	artifactsDir?: string;
	maxRuntimeMs?: number;
}

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
		} finally {
			cancel();
		}
		unsubscribe();
		const active = monitor.takeActiveSession();
		if (active) monitor.captureSalvage(active);
		monitor.finish();
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

export function resolveRootUIContext(childId: string): ExtensionUIContext | undefined {
	const registry = AgentRegistry.global();
	const child = registry.get(childId);
	if (!child) return undefined;
	const rootRunner = registry.listInScope(child.scope).find(ref => ref.kind === "main")?.session?.extensionRunner;
	return rootRunner?.hasUI() ? rootRunner.getUIContext() : undefined;
}

export function createSubagentSession(
	parentSessionId: string | undefined,
	sessionOptions: CreateAgentSessionOptions,
): Promise<CreateAgentSessionResult> {
	return withInheritedBudgetGroup(parentSessionId ?? rootBudgetGroupOwnerId(), async () => {
		const { createAgentSession } = await import("../sdk");
		return createAgentSession(sessionOptions);
	});
}

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
	let firstChatDispatchAt: number | undefined;

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

	let toolNames: string[] | undefined;
	if (agent.tools && agent.tools.length > 0) {
		toolNames = agent.tools;
		if (agent.spawns !== undefined && !toolNames.includes("task") && !atMaxDepth) {
			toolNames = toolNames.concat(["task"]);
		}
	}

	if (atMaxDepth && toolNames?.includes("task")) {
		toolNames = toolNames.filter(name => name !== "task");
	}
	if (toolNames && !toolNames.includes("irc")) {
		toolNames = toolNames.concat(["irc"]);
	}
	if (toolNames?.includes("exec")) {
		const backends = resolveEvalBackends({ settings } as ToolSession);
		const expanded = toolNames.filter(name => name !== "exec");
		if (backends.python || backends.js || backends.ruby || backends.julia) expanded.push("eval");
		expanded.push("bash");
		toolNames = Array.from(new Set(expanded));
	}

	const modelPatterns = normalizeModelPatterns(modelOverride);
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
		const perfStart = performance.now();
		let resolvedAt: number | undefined;
		let sessionOpenedAt: number | undefined;
		let sessionCreatedAt: number | undefined;
		let readyAt: number | undefined;

		try {
			checkAbort();
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
				const badgeLevel = effectiveThinkingLevel;
				progress.resolvedModel = badgeLevel
					? formatModelSelectorValue(formatModelStringWithRouting(model), badgeLevel)
					: formatModelStringWithRouting(model);
			}
			resolvedAt = performance.now();

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
				preloadedNamedExtensionPaths: options.preloadedNamedExtensionPaths,
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
						: defaultPrompt.slice(0, -1).concat([subagentPrompt, defaultPrompt[defaultPrompt.length - 1]!]);
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
				void sessionPromise.then(created => created.session.dispose()).catch(() => {});
				throw err;
			}
			sessionCreatedAt = performance.now();

			monitor.setActiveSession(session);
			installRegistryStatusSync(session);
			if (worktree === undefined) {
				reviveSession = async () => {
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
			if (abortSignal.aborted) {
				void monitor.abortActiveSession();
			}

			const pendingExtensionMessages: Array<Promise<unknown>> = [];
			const extensionRunner = session.extensionRunner;
			if (extensionRunner) {
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
			if (!abortSignal.aborted) {
				failure ??= err instanceof Error ? err.stack || err.message : String(err);
			} else {
				failure ??= undefined;
			}
		} finally {
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
			} finally {
				cancelCleanup();
			}
			if (unsubscribe) {
				try {
					unsubscribe();
				} catch {}
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
					signOff: subagentSignOffText(monitor),
					reviveSession,
				});
			}
		}

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
