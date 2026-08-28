import type { AgentEvent, AgentTelemetryConfig } from "@veyyon/agent-core";
import type { ServiceTierByFamily, Usage } from "@veyyon/ai";
import { emptyUsage } from "@veyyon/catalog/models";
import { errorMessage, isRecord, logger, popLoopPhase, pushLoopPhase, truncate } from "@veyyon/utils";
import type { ArgotSession, StreamDecoder } from "argot";
import { createSubagentStreamDecoder, expandSubagentReturn } from "../argot-wire";
import type { Rule } from "../capability/rule";
import type { ModelRegistry } from "../config/model-registry";
import type { PromptTemplate } from "../config/prompt-templates";
import { buildServiceTierByFamily, resolveSubagentServiceTier } from "../config/service-tier";
import type { Settings } from "../config/settings";
import type { SettingPath } from "../config/settings-schema";
import type { ToolPathWithSource } from "../extensibility/custom-tools";
import type { CustomTool } from "../extensibility/custom-tools/types";
import type { Skill } from "../extensibility/skills";
import type { HindsightSessionState } from "../hindsight/state";
import type { LocalProtocolOptions } from "../internal-urls";
import type { MCPManager } from "../mcp/manager";
import type { MnemopiSessionState } from "../mnemopi/state";
import { AgentRegistry } from "../registry/agent-registry";
import type { AgentSession, AgentSessionEvent } from "../session/agent-session";
import type { ArtifactManager } from "../session/artifacts";
import type { AuthStorage } from "../session/auth-storage";
import type { ConfiguredThinkingLevel } from "../thinking";
import type { ContextFileEntry } from "../tools";
import { normalizeSchema } from "../tools/jtd-to-json-schema";
import {
	buildOutputValidator,
	type OutputValidator,
	summarizeValidationFailure,
} from "../tools/output-schema-validator";
import "../tools/yield";
import type { SideCompleteImpl } from "../session/side-complete";
import { ToolAbortError } from "../tools/tool-errors";
import type { EventBus } from "../utils/event-bus";
import type { WorkspaceTree } from "../workspace-tree";
import {
	BUDGET_STOP_GRACE_REQUESTS,
	buildBudgetNotice,
	getReportFindingKey,
	isAgentEvent,
	MCP_CALL_TIMEOUT_MS,
	withAbortTimeout,
} from "./executor-helpers";
import type { AutoloadSkillPlan } from "./inherited-collections";
import { generateTaskLabel } from "./label";
import { subprocessToolRegistry, YIELD_TOOL_NAME } from "./subprocess-tool-registry";
import {
	type AgentDefinition,
	type AgentProgress,
	type ReviewFinding,
	TASK_SUBAGENT_EVENT_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
	type TaskToolDetails,
	type YieldItem,
} from "./types";
import { arrayValuedLabels, assembleYieldResult } from "./yield-assembly";

export {
	BUDGET_STOP_GRACE_REQUESTS,
	buildBudgetNotice,
	createSubagentSession,
	type FollowUpTurnOptions,
	finalizeSubagentLifecycle,
	type RunVerdict,
	type RunVerdictInputs,
	resolveEffectiveSubagentThinkingLevel,
	resolveRootUIContext,
	resolveRunVerdict,
	resolveSubagentErrorText,
	runSubagentFollowUpTurn,
	runSubprocess,
	SOFT_REQUEST_BUDGET,
	saysItIsWaitingOnAPeer,
} from "./executor-helpers";

export interface ExecutorOptions {
	cwd: string;
	worktree?: string;
	agent: AgentDefinition;
	task: string;
	assignment?: string;
	context?: string;
	planReference?: { path: string; content: string };
	description?: string;
	obfuscateProviderText?: (text: string) => string;
	completeImpl?: SideCompleteImpl;
	index: number;
	id: string;
	parentToolCallId?: string;
	detached?: boolean;
	modelOverride?: string | string[];
	parentActiveModelPattern?: string;
	parentThinkingLevel?: ConfiguredThinkingLevel;
	thinkingLevel?: ConfiguredThinkingLevel;
	outputSchema?: unknown;
	outputSchemaOverridesAgent?: boolean;
	taskDepth?: number;
	maxRuntimeMs?: number;
	enableLsp?: boolean;
	signal?: AbortSignal;
	onProgress?: (progress: AgentProgress) => void;
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
	rules?: Rule[];
	preloadedExtensionPaths?: string[];
	preloadedNamedExtensionPaths?: string[];
	preloadedCustomToolPaths?: ToolPathWithSource[];
	mcpManager?: MCPManager;
	authStorage?: AuthStorage;
	modelRegistry?: ModelRegistry;
	settings?: Settings;
	bypassAllApprovals?: boolean;
	parentApprovalBypassed?: () => boolean;
	parentServiceTier?: ServiceTierByFamily | null;
	localProtocolOptions?: LocalProtocolOptions;
	parentArtifactManager?: ArtifactManager;
	parentHindsightSessionState?: HindsightSessionState;
	parentMnemopiSessionState?: MnemopiSessionState;
	parentArgot?: ArgotSession;
	parentEvalSessionId?: string;
	parentTelemetry?: AgentTelemetryConfig;
	autoloadSkills?: AutoloadSkillPlan<Skill>;
	parentAgentId?: string;
	parentSessionId?: string;
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
	exitCode: number;
	stderr: string;
	doneAborted: boolean;
	signalAborted: boolean;
	yieldItems?: YieldItem[];
	reportFindings?: ReviewFinding[];
	outputSchema: unknown;
	lastAssistantText?: string;
}

export interface FinalizeSubprocessOutputResult {
	rawOutput: string;
	exitCode: number;
	stderr: string;
	abortedViaYield: boolean;
	hasYield: boolean;
}
export const SUBAGENT_WARNING_NULL_YIELD = "SYSTEM WARNING: Subagent called yield with null data.";
export const SUBAGENT_WARNING_MISSING_YIELD =
	"SYSTEM WARNING: Subagent exited without calling yield tool after 3 reminders.";

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

export function currentYieldSchemaFailure(progress: AgentProgress, outputSchema: unknown): string | undefined {
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
	const { normalized: normalizedSchema, error: normalizedSchemaError } = normalizeSchema(outputSchema);
	const hasOutputSchema = normalizedSchema !== undefined && !normalizedSchemaError;

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
				const hasRawOutput = rawOutput.trim().length > 0;
				rawOutput = rawOutput ? `${SUBAGENT_WARNING_NULL_YIELD}\n\n${rawOutput}` : SUBAGENT_WARNING_NULL_YIELD;
				if (hasOutputSchema || !hasRawOutput) {
					exitCode = 1;
					if (!stderr.trim()) stderr = SUBAGENT_WARNING_NULL_YIELD;
				}
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
					let serializationError: string | undefined;
					try {
						rawOutput =
							assembled.rawText && typeof completeData === "string"
								? completeData
								: (JSON.stringify(completeData, null, 2) ?? "null");
					} catch (err) {
						serializationError = `Failed to serialize yield data: ${errorMessage(err)}`;
						rawOutput = JSON.stringify({ error: serializationError });
					}
					if (serializationError !== undefined) {
						exitCode = 1;
						if (!stderr.trim()) stderr = serializationError;
					} else if (!hadFailureBeforeYield) {
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
					exitCode = 0;
					stderr = "";
				} catch (err) {
					const failure = `Failed to serialize fallback completion: ${errorMessage(err)}`;
					rawOutput = JSON.stringify({ error: failure });
					exitCode = 1;
					stderr = failure;
				}
			}
		} else if (!hasOutputSchema && allowFallback && rawOutput.trim().length > 0) {
			exitCode = 0;
			stderr = "";
		} else if (allowFallback) {
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

function extractToolArgsPreview(args: Record<string, unknown>): string {
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

function getUsageTokens(usage: unknown): number {
	if (!usage || typeof usage !== "object") return 0;
	const record = usage as Record<string, unknown>;

	const input = firstNumberField(record, ["input", "input_tokens", "inputTokens"]) ?? 0;
	const output = firstNumberField(record, ["output", "output_tokens", "outputTokens"]) ?? 0;
	const cacheWrite = firstNumberField(record, ["cacheWrite", "cache_write", "cacheWriteTokens"]) ?? 0;
	const computed = input + output + cacheWrite;
	if (computed > 0) return computed;
	return firstNumberField(record, ["totalTokens", "total_tokens"]) ?? 0;
}

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

		...overrides,
	});
}

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

interface RunMonitorArgs {
	index: number;
	id: string;
	agent: AgentDefinition;
	task: string;
	assignment?: string;
	description?: string;
	modelRegistry?: ModelRegistry;
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
	softRequestBudget: number;
	softRequestBudgetNotice: boolean;
	maxRuntimeMs: number;
}

export interface SubagentRunMonitor {
	readonly progress: AgentProgress;
	readonly abortSignal: AbortSignal;
	readonly accumulatedUsage: Usage;
	hasUsage(): boolean;
	yieldCalled(): boolean;
	runtimeLimitExceeded(): boolean;
	budgetStopRequested(): boolean;
	waitForBudgetStop(): Promise<void>;
	abortKind(): AbortReason | undefined;
	hasExplicitAbortReason(): boolean;
	isAbortedRun(): boolean;
	requestAbort(reason: AbortReason): void;
	abortActiveSession(): Promise<void>;
	waitForActiveSessionAbort(): Promise<void>;
	resolveSignalAbortReason(): string;
	resolveAbortReasonText(): string;
	setActiveSession(session: AgentSession | null): void;
	takeActiveSession(): AgentSession | null;
	attach(session: AgentSession): () => void;
	captureSalvage(session: AgentSession): void;
	lastAssistantSalvageText(): string | undefined;
	rawOutput(): string;
	scheduleProgress(flush?: boolean): void;
	finish(): void;
}

export function createSubagentRunMonitor(args: RunMonitorArgs): SubagentRunMonitor {
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

	const accumulatedUsage: Usage = { ...emptyUsage(), reasoningTokens: 0 };
	let hasUsage = false;
	let budgetSteerSent = false;
	let budgetLimitExceeded = false;
	let budgetStopRequested = false;
	let budgetStopAbortPromise: Promise<void> | undefined;
	let lastAssistantSalvageText: string | undefined;
	let activeSessionAbortPromise: Promise<void> | undefined;

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

	if (signal) {
		signal.addEventListener(
			"abort",
			() => {
				if (!resolved) requestAbort("signal");
			},
			{ once: true, signal: listenerSignal },
		);
	}

	let runtimeTimeoutId: NodeJS.Timeout | undefined;
	if (maxRuntimeMs > 0) {
		const registry = AgentRegistry.global();
		const armRuntimeLimit = (delayMs: number) => {
			runtimeTimeoutId = setTimeout(
				() => {
					if (resolved) return;
					const now = Date.now();
					const openSince = registry.pendingApprovalSince(id);
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

	const ensureStreamDecoder = (): StreamDecoder | undefined => {
		if (!streamDecoderReady) {
			streamDecoder = createSubagentStreamDecoder(activeSession?.getArgotSession?.());
			streamDecoderReady = true;
		}
		return streamDecoder;
	};

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
		tailLastLineRepresentable = lines[lines.length - 1]!.trim().length > 0;
		const recent: string[] = [];
		for (let li = lines.length - 1; li >= 0 && recent.length < 8; li--) {
			const line = lines[li]!;
			if (line.trim()) recent.push(line);
		}
		progress.recentOutput = recent;
	};

	const appendRecentOutputTail = (text: string) => {
		if (!text) return;
		recentOutputTail += text;
		const truncated = recentOutputTail.length > RECENT_OUTPUT_TAIL_BYTES;
		if (truncated) {
			recentOutputTail = recentOutputTail.slice(-RECENT_OUTPUT_TAIL_BYTES);
		}
		if (truncated || text.includes("\n") || !tailLastLineRepresentable || progress.recentOutput.length === 0) {
			updateRecentOutputLines();
		} else {
			progress.recentOutput[0] = progress.recentOutput[0] + text;
		}
	};

	const replaceRecentOutputFromContent = (content: unknown[]) => {
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
					if (progress.recentTools.length > 5) {
						progress.recentTools.pop();
					}
				}
				progress.currentTool = undefined;
				progress.currentToolArgs = undefined;
				progress.currentToolStartMs = undefined;
				if (event.toolName === "task") {
					progress.inflightTaskDetails = undefined;
				}

				const handler = subprocessToolRegistry.getHandler(event.toolName);
				if (handler === undefined && event.toolName === YIELD_TOOL_NAME) {
					logger.error(
						`Subagent ${id} returned a ${YIELD_TOOL_NAME} result and no ${YIELD_TOOL_NAME} handler is registered on subprocessToolRegistry. ` +
							`The result cannot be read, so this run will report a missing yield. This is a build wiring fault, not a subagent fault: ` +
							`task/executor.ts must import tools/yield.ts for its registration side effect.`,
					);
				}
				const eventRecord: unknown = event;
				const eventArgs = isRecord(eventRecord) && isRecord(eventRecord.args) ? eventRecord.args : {};
				if (handler) {
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
						if (messageContent && Array.isArray(messageContent)) {
							replaceRecentOutputFromContent(messageContent);
						} else {
							appendRecentOutputTail(flushStreamDecoder());
						}
					}
					if (softRequestBudget > 0 && !abortSent && !yieldCallPending) {
						const stopThreshold = softRequestBudget * 1.5;
						if (budgetStopRequested) {
							if (progress.requests >= stopThreshold + BUDGET_STOP_GRACE_REQUESTS) {
								requestAbort("budget");
							}
						} else if (progress.requests >= stopThreshold) {
							requestBudgetStop();
						} else if (softRequestBudgetNotice && !budgetSteerSent && progress.requests >= softRequestBudget) {
							budgetSteerSent = true;
							const steerSession = activeSession;
							if (steerSession) {
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
				const eventUsage = isRecord(event) && "usage" in event ? event.usage : undefined;
				const messageUsage = getMessageUsage(event.message) || eventUsage;
				if (isRecord(messageUsage)) {
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
					progress.tokens += getUsageTokens(messageUsage);
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
		try {
			const lastContent = session.getLastAssistantMessage()?.content;
			if (Array.isArray(lastContent)) {
				const text = lastContent
					.map(block => (block.type === "text" && typeof block.text === "string" ? block.text : ""))
					.filter(Boolean)
					.join("\n");
				if (text.trim()) {
					lastAssistantSalvageText = expandSubagentReturn(session.getArgotSession?.(), text);
				}
			}
		} catch {}
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
