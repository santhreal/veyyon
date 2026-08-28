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

function countNewlines(text: string): number {
	let count = 0;
	for (let i = 0; i < text.length; i++) {
		if (text.charCodeAt(i) === 0x0a) count++;
	}
	return count;
}

const MCP_CALL_TIMEOUT_MS = 60_000;

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
				// never yielding, so it must not exit 0 and hand the warning back as the result.
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

interface SubagentRunMonitor {
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
							// Grace window after the stop: the forced yield needs a
							if (progress.requests >= stopThreshold + BUDGET_STOP_GRACE_REQUESTS) {
								requestAbort("budget");
							}
						} else if (progress.requests >= stopThreshold) {
							requestBudgetStop();
						} else if (softRequestBudgetNotice && !budgetSteerSent && progress.requests >= softRequestBudget) {
							budgetSteerSent = true;
							const steerSession = activeSession;
							if (steerSession) {
								// behind an async boundary: a synchronously-throwing send must
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
					// last-turn text is handle-form and must expand through the child's
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

interface DriveOutcome {
	failure?: string;
	turnCutShort: boolean;
	turnAborted: boolean;
	turnAbortReason?: string;
}

const MAX_YIELD_RETRIES = 3;

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

interface FinalizeRunArgs {
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
	// The wall clock first, and independent of everything else: a late yield must not buy back a
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

async function finalizeRunResult(args: FinalizeRunArgs): Promise<SingleResult> {
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

	// The one place the run's outcome is decided. The yield payload is settled by now, which is why
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

const WAITING_ON_PEER =
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
	// whitelist must still carry `irc` for the subagent to actually use it.
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
				// Abort raced session startup. The session may still resolve later
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
			// the awaited setup above, the listener registration races the dispatch
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
