/**
 * Types and interfaces for the TypeScript edit benchmark runner.
 *
 * Declares trial configuration, result shapes, tool telemetry, failure
 * categories, and client abstractions.
 */

import type { AgentMessage, ResolvedThinkingLevel, ThinkingLevel } from "@veyyon/agent-core";
import type { Model } from "@veyyon/ai";
import type { DumpedTool } from "../../../../backends/in-process/client";
import type { EditTask } from "../../tasks";

export const EDIT_FAILURE_CATEGORIES = [
	"range-continuation",
	"unified-diff",
	"no-change",
	"hash-mismatch",
	"other",
] as const;

export type EditFailureCategory = (typeof EDIT_FAILURE_CATEGORIES)[number];

export const HL_SUBTYPES = ["set", "set_range", "insert"] as const;
export const BENCHMARK_TOOL_NAMES = ["read", "edit", "write", "apply_patch"] as const;
export const EDIT_TOOL_NAMES = ["edit", "apply_patch"] as const;

export interface BenchmarkConfig {
	provider: string;
	model: string;
	thinkingLevel?: ResolvedThinkingLevel;
	runsPerTask: number;
	timeout: number;
	/** Timeout for the first event to arrive. If no events are observed within this window, abort early. Default: 30000 */
	connectionTimeout?: number;
	maxTurns?: number;
	taskConcurrency: number;
	requireEditToolCall?: boolean;
	requireReadToolCall?: boolean;
	noEditRequired?: boolean;
	autoFormat?: boolean;
	/** If true, abort the agent loop as soon as the formatted file content matches the expected fixture. Default: true. */
	earlyStopOnMatch?: boolean;
	editVariant?: string;
	editFuzzy?: boolean | "auto";
	editFuzzyThreshold?: number | "auto";
	guided?: boolean;
	maxAttempts?: number;
	noOpRetryLimit?: number;
	maxTimeoutRetries?: number;
	maxProviderFailureRetries?: number;
	mutationScopeWindow?: number;
	conversationDumpDir?: string;
	/** Use in-process agent sessions instead of spawning CLI subprocesses. Default: true */
	inProcess?: boolean;
}

/** Subset of session state used for markdown conversation dumps (parity with /dump). */
export type ConversationDumpSessionState = {
	sessionFile?: string;
	systemPrompt?: string[];
	model?: Model;
	thinkingLevel?: ThinkingLevel | undefined;
	dumpTools?: readonly DumpedTool[];
};

export type ConversationDumpSnapshot = {
	messages: AgentMessage[];
	sourceSessionFile?: string;
	systemPrompt?: string[];
	model?: Model;
	thinkingLevel?: ThinkingLevel | undefined;
	dumpTools?: readonly DumpedTool[];
};

/** Common interface for both RPC and in-process clients */
export interface BenchmarkClient {
	start(): Promise<void>;
	setThinkingLevel(level: ResolvedThinkingLevel): Promise<void>;
	onEvent(listener: (event: { type: string; [key: string]: unknown }) => void): () => void;
	prompt(text: string): Promise<void>;
	followUp(text: string): Promise<void>;
	getSessionStats(): Promise<{
		tokens: {
			input: number;
			output: number;
			reasoning: number;
			cacheRead: number;
			cacheWrite: number;
			total: number;
		};
		assistantMessages: number;
	}>;
	getLastAssistantText(): Promise<string | null>;
	getMessages(): Promise<AgentMessage[]>;
	getState(): Promise<ConversationDumpSessionState>;
	abort?(): void;
	dispose(): Promise<void>;
}

export interface PromptAttemptTelemetry {
	elapsedMs: number;
	eventCount: number;
	toolExecutionStarts: number;
	toolExecutionEnds: number;
	messageEnds: number;
	lastEventType?: string;
	recentEventTypes: string[];
	pendingRetry: boolean;
}

export interface PromptTurnLimitTelemetry {
	elapsedMs: number;
	observedTurns: number;
	maxTurns: number;
	pendingRetry: boolean;
	lastEventType?: string;
	recentEventTypes: string[];
}

export interface MutationIntentValidation {
	matched: boolean;
	reason: string;
	mutationType?: string;
	file?: string;
	lineNumber?: number;
}

export interface ProviderFailure {
	kind: "auth" | "provider";
	message: string;
}

export interface TokenStats {
	input: number;
	output: number;
	reasoning: number;
	total: number;
}

export interface ToolCallStats {
	read: number;
	edit: number;
	write: number;
	editSuccesses: number;
	editFailures: number;
	editWarnings: number;
	editAutocorrects: number;
	totalInputChars: number;
}

export interface PendingEditCall {
	args: unknown;
	rawBlock?: string;
}

export interface EditFailure {
	toolCallId: string;
	args: unknown;
	error: string;
	rawBlock?: string;
	category?: EditFailureCategory;
}

export interface TaskRunResult {
	runIndex: number;
	success: boolean;
	patchApplied: boolean;
	verificationPassed: boolean;
	seed?: number;
	mutationType?: string;
	mutationCategory?: string;
	difficultyScore?: number;
	error?: string;
	tokens: TokenStats;
	duration: number;
	indentScore?: number;
	formattedEquivalent?: boolean;
	diffStats?: { linesChanged: number; charsChanged: number };
	agentResponse?: string;
	diff?: string;
	toolCalls: ToolCallStats;
	editFailures: EditFailure[];
	editWarnings: string[];
	editAutocorrectCount: number;
	/** Hashline edit subtype counts (replaceLine, replaceLines, etc.) — only when editVariant is hashline */
	hashlineEditSubtypes?: Record<string, number>;
	mutationIntentMatched?: boolean;
	mutationIntentReason?: string;
	timeoutTelemetry?: PromptAttemptTelemetry;
	/** True when the run terminated early because the formatted file content matched the expected fixture. */
	earlyStopped?: boolean;
	/** Retry telemetry: how many retries of each type were used */
	retryStats?: {
		timeoutRetries: number;
		zeroToolRetries: number;
		providerFailureRetries: number;
	};
}

export interface ProgressEvent {
	taskId: string;
	runIndex: number;
	status: "started" | "completed";
	result?: TaskRunResult;
}

export interface TaskResult {
	id: string;
	name: string;
	files: string[];
	runs: TaskRunResult[];
	/** Index into `runs` (ordered by runIndex) of the selected best run; -1 if no runs completed. */
	bestRunIndex: number;
	/** True when the selected best run succeeded. */
	success: boolean;
	/** Token usage of the best run. */
	tokens: TokenStats;
	/** Duration (ms) of the best run. */
	duration: number;
	/** Indent score of the best run, or 0 if unscored. */
	indentScore: number;
	/** Tool call stats of the best run. */
	toolCalls: ToolCallStats;
	/** Edit-tool success rate of the best run (defaults to 1 when no edit attempts). */
	editSuccessRate: number;
	/** True if the best run succeeded with zero autocorrects. */
	autocorrectFreeSuccess: boolean;
	/** Fraction of completed (non-ghost) runs that succeeded — flakiness indicator. */
	flakeSuccessRate: number;
}

export interface BenchmarkSummary {
	totalTasks: number;
	/** Total completed runs across all tasks (excludes ghost runs). */
	totalRuns: number;
	/** Successful runs across every executed run (any of N). Diagnostic. */
	successfulRuns: number;
	/** Tasks whose best run succeeded (best-of-N). Primary headline metric. */
	successfulTasks: number;
	/** successfulTasks / totalTasks. */
	taskSuccessRate: number;
	/** Tasks where best succeeded but at least one of N failed (flakiness). */
	flakyTasks: number;
	/** Tasks where every executed non-ghost run succeeded. */
	consistentlyPassingTasks: number;
	/** Tasks whose first run succeeded. */
	successfulOneShotTasks: number;
	/** Tokens summed over the first run of each successfully one-shot task. */
	totalOneShotSuccessTokens: TokenStats;
	/** Average tokens per successfully one-shot task. */
	avgOneShotSuccessTokensPerTask: TokenStats;
	/** Median tokens across successfully one-shot tasks. */
	medianOneShotSuccessTokensPerTask: TokenStats;
	/** 1st-percentile tokens across successfully one-shot tasks. */
	p1OneShotSuccessTokensPerTask: TokenStats;
	/** 99th-percentile tokens across successfully one-shot tasks. */
	p99OneShotSuccessTokensPerTask: TokenStats;
	/** Tokens summed over the best run of each task. */
	totalTokens: TokenStats;
	/** Average tokens per task (sum of best runs / number of tasks). */
	avgTokensPerTask: TokenStats;
	/** Median tokens across best runs (per-task distribution). */
	medianTokensPerTask: TokenStats;
	/** 1st-percentile tokens across best runs (per-task distribution). */
	p1TokensPerTask: TokenStats;
	/** 99th-percentile tokens across best runs (per-task distribution). */
	p99TokensPerTask: TokenStats;
	/** Duration summed over best runs. */
	totalDuration: number;
	/** Average duration of the best run per task. */
	avgDurationPerTask: number;
	/** Average indent score over best runs (only counts runs with a score). */
	avgIndentScore: number;
	/** Tool calls summed over best runs. */
	totalToolCalls: ToolCallStats;
	/** Average tool calls per task (sum of best runs / number of tasks). */
	avgToolCallsPerTask: ToolCallStats;
	/** Edit-tool success rate aggregated across best runs. */
	editSuccessRate: number;
	/** Tasks where the best run succeeded without any autocorrects. */
	autocorrectFreeSuccessfulTasks: number;
	/** autocorrectFreeSuccessfulTasks / totalTasks. */
	autocorrectFreeSuccessRate: number;
	/** Best runs with any autocorrects. */
	autocorrectedBestRuns: number;
	/** Autocorrect rate across best-run edit successes. */
	editAutocorrectRate: number;
	/** Diagnostic: runs (across all N) that timed out. */
	timeoutRuns: number;
	/** Diagnostic: total retry counts across all runs. */
	totalTimeoutRetries: number;
	totalZeroToolRetries: number;
	totalProviderFailureRetries: number;
	/** Diagnostic: ghost runs (0 tokens, 0 tool calls) across all N. */
	ghostRuns: number;
	/** Diagnostic: runs excluded because provider/transport stalls exhausted retries. */
	transportFailureRuns: number;
	mutationIntentMatchRate?: number;
	/** Edit failure categories across all runs. */
	editFailureCategories: Record<EditFailureCategory, number>;
	/** Hashline edit subtype totals across all runs — only when editVariant is hashline. */
	hashlineEditSubtypes?: Record<string, number>;
}

export interface BenchmarkResult {
	config: BenchmarkConfig;
	tasks: TaskResult[];
	summary: BenchmarkSummary;
	startTime: string;
	endTime: string;
}

export interface TaskRunItem {
	task: EditTask;
	runIndex: number;
}

/** Median / 1st / 99th percentile token stats over a set of runs (one sample per run). */
export interface TokenDistribution {
	median: TokenStats;
	p1: TokenStats;
	p99: TokenStats;
}

export type SessionTokenStats = {
	tokens: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number };
	assistantMessages: number;
};
