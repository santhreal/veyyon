import type { Usage } from "@veyyon/ai";
import { $envpos } from "@veyyon/utils/env";
import { type BaseType, type } from "arktype";
import type { RetryRecoveryMode } from "../modes/retry-display";
import type { AgentSessionEvent } from "../session/agent-session";
import type { ConfiguredThinkingLevel } from "../thinking";
import { DEFAULT_SPAWN_AGENT } from "./spawn-policy";
import type { NestedRepoPatch } from "./worktree";

export type AgentSource = "bundled" | "user" | "project";

export const MAX_OUTPUT_BYTES = $envpos("VEYYON_TASK_MAX_OUTPUT_BYTES", 500_000);

export const MAX_OUTPUT_LINES = $envpos("VEYYON_TASK_MAX_OUTPUT_LINES", 5000);

export const TASK_SUBAGENT_EVENT_CHANNEL = "task:subagent:event";

export const TASK_SUBAGENT_PROGRESS_CHANNEL = "task:subagent:progress";

export const TASK_SUBAGENT_LIFECYCLE_CHANNEL = "task:subagent:lifecycle";

export interface SubagentProgressPayload {
	index: number;
	agent: string;
	agentSource: AgentSource;
	task: string;
	parentToolCallId?: string;
	assignment?: string;
	progress: AgentProgress;
	sessionFile?: string;
	detached?: boolean;
}

export interface SubagentEventPayload {
	id: string;
	event: AgentSessionEvent;
}

export interface SubagentLifecyclePayload {
	id: string;
	agent: string;
	agentSource: AgentSource;
	description?: string;
	status: "started" | "completed" | "failed" | "aborted";
	sessionFile?: string;
	parentToolCallId?: string;
	index: number;
	detached?: boolean;
}

export const LABEL_MAX = 80;

export const taskItemSchema = type({
	"name?": "string",
	agent: "string = 'deep'",
	task: "string",
	"cwd?": "string",
	"+": "delete",
});
const taskItemSchemaIsolated = type({
	"name?": "string",
	agent: "string = 'deep'",
	task: "string",
	"isolated?": "boolean",
	"cwd?": "string",
	"+": "delete",
});

export interface TaskItem {
	name?: string;
	agent?: string;
	task?: string;
	isolated?: boolean;
	cwd?: string;
}

export const taskSchema = type({
	"name?": "string",
	agent: "string = 'deep'",
	task: "string",
	"isolated?": "boolean",
	"cwd?": "string",
	"+": "delete",
});
const taskSchemaNoIsolation = type({
	"name?": "string",
	agent: "string = 'deep'",
	task: "string",
	"cwd?": "string",
	"+": "delete",
});
const taskSchemaBatch = type({
	context: "string",
	tasks: taskItemSchemaIsolated.array(),
	"+": "delete",
});
const taskSchemaBatchNoIsolation = type({
	context: "string",
	tasks: taskItemSchema.array(),
	"+": "delete",
});
const ALL_TASK_SCHEMAS = [taskSchema, taskSchemaNoIsolation, taskSchemaBatch, taskSchemaBatchNoIsolation] as const;

type DynamicTaskSchema = (typeof ALL_TASK_SCHEMAS)[number];
export type TaskToolSchemaInstance = DynamicTaskSchema | BaseType;

const taskSchemaCache = new Map<string, BaseType>();

function taskAgentSchemaRule(defaultAgent: string | undefined, enabledAgentNames?: readonly string[]) {
	const trimmedDefault = defaultAgent?.trim();
	if (enabledAgentNames === undefined) {
		return trimmedDefault ? type("string").default(trimmedDefault) : "string";
	}
	const names = Array.from(new Set(enabledAgentNames.map(name => name.trim()).filter(Boolean)));
	const enabled = type.enumerated(...names);
	return trimmedDefault ? enabled.default(trimmedDefault) : enabled;
}

function createTaskSchema(options: {
	isolationEnabled: boolean;
	batchEnabled: boolean;
	defaultAgent: string | undefined;
	enabledAgentNames?: readonly string[];
}): BaseType {
	const agent = taskAgentSchemaRule(options.defaultAgent, options.enabledAgentNames);
	if (options.batchEnabled) {
		if (options.isolationEnabled) {
			const item = type.raw({
				"name?": "string",
				agent,
				task: "string",
				"isolated?": "boolean",
				"cwd?": "string",
				"+": "delete",
			});
			return type.raw({
				context: "string",
				tasks: item.array(),
				"+": "delete",
			});
		}
		const item = type.raw({
			"name?": "string",
			agent,
			task: "string",
			"cwd?": "string",
			"+": "delete",
		});
		return type.raw({
			context: "string",
			tasks: item.array(),
			"+": "delete",
		});
	}
	if (options.isolationEnabled) {
		return type.raw({
			"name?": "string",
			agent,
			task: "string",
			"isolated?": "boolean",
			"cwd?": "string",
			"+": "delete",
		});
	}
	return type.raw({
		"name?": "string",
		agent,
		task: "string",
		"cwd?": "string",
		"+": "delete",
	});
}

export function getTaskSchema(options: { isolationEnabled: boolean; batchEnabled: boolean }): DynamicTaskSchema;
export function getTaskSchema(options: {
	isolationEnabled: boolean;
	batchEnabled: boolean;
	defaultAgent: string | undefined;
	enabledAgentNames?: readonly string[];
}): TaskToolSchemaInstance;
export function getTaskSchema(options: {
	isolationEnabled: boolean;
	batchEnabled: boolean;
	defaultAgent?: string;
	enabledAgentNames?: readonly string[];
}): TaskToolSchemaInstance {
	const hasDefaultAgent = Object.hasOwn(options, "defaultAgent");
	const defaultAgent = hasDefaultAgent ? options.defaultAgent : DEFAULT_SPAWN_AGENT;
	const enabledAgentNames = options.enabledAgentNames;
	if (enabledAgentNames === undefined && defaultAgent === DEFAULT_SPAWN_AGENT) {
		if (options.batchEnabled) return options.isolationEnabled ? taskSchemaBatch : taskSchemaBatchNoIsolation;
		return options.isolationEnabled ? taskSchema : taskSchemaNoIsolation;
	}
	const encodedNames =
		enabledAgentNames === undefined
			? "unconstrained"
			: enabledAgentNames.map(name => `${name.length}:${name}`).join(",");
	const key = `${options.isolationEnabled ? "iso" : "flat"}:${options.batchEnabled ? "batch" : "single"}:${defaultAgent === undefined ? "unset" : `set:${defaultAgent.length}:${defaultAgent}`}:agents:${encodedNames}`;
	const cached = taskSchemaCache.get(key);
	if (cached) return cached;
	const schema = createTaskSchema({ ...options, defaultAgent, enabledAgentNames });
	taskSchemaCache.set(key, schema);
	return schema;
}

export interface TaskParams {
	name?: string;
	agent?: string;
	task?: string;
	tasks?: TaskItem[];
	context?: string;
	isolated?: boolean;
	cwd?: string;
}

export function oneLineLabel(text: string, max = LABEL_MAX): string {
	const oneLine = text.replace(/[\p{Cc}\p{Cf}\s]+/gu, " ").trim();
	const cap = Math.max(1, max);
	const chars = [...oneLine];
	return chars.length > cap ? `${chars.slice(0, cap - 1).join("")}…` : oneLine;
}

export function canSpawnAtDepth(maxNestedSpawnDepth: number, taskDepth: number): boolean {
	return maxNestedSpawnDepth < 0 || taskDepth <= maxNestedSpawnDepth;
}

export interface ReviewFinding {
	title: string;
	body: string;
	priority: number;
	confidence: number;
	file_path: string;
	line_start: number;
	line_end: number;
}

export interface AgentDefinition {
	name: string;
	description: string;
	systemPrompt: string;
	tools?: string[];
	spawns?: string[] | "*";
	model?: string[];
	thinkingLevel?: ConfiguredThinkingLevel;
	output?: unknown;
	blocking?: boolean;
	autoloadSkills?: string[];
	readSummarize?: boolean;
	source: AgentSource;
	filePath?: string;
}

export interface YieldItem {
	data?: unknown;
	status?: "success" | "aborted";
	error?: string;
	type?: string | string[];
	useLastTurn?: boolean;
	schemaOverridden?: boolean;
}

export interface AgentProgress {
	index: number;
	id: string;
	agent: string;
	agentSource: AgentSource;
	status: "pending" | "running" | "completed" | "failed" | "aborted";
	task: string;
	assignment?: string;
	description?: string;
	lastIntent?: string;
	currentTool?: string;
	currentToolArgs?: string;
	currentToolStartMs?: number;
	recentTools: Array<{ tool: string; args: string; endMs: number }>;
	recentOutput: string[];
	toolCount: number;
	requests: number;
	tokens: number;
	contextTokens?: number;
	contextWindow?: number;
	cost: number;
	durationMs: number;
	modelOverride?: string | string[];
	resolvedModel?: string;
	fellBackFrom?: string;
	extractedToolData?: Record<string, unknown[]>;
	retryState?: {
		attempt: number;
		maxAttempts: number;
		delayMs: number;
		errorMessage: string;
		startedAtMs: number;
		mode?: RetryRecoveryMode;
	};
	retryFailure?: {
		attempt: number;
		errorMessage: string;
		mode?: RetryRecoveryMode;
	};
	inflightTaskDetails?: TaskToolDetails;
}

export interface SingleResult {
	index: number;
	id: string;
	agent: string;
	agentSource: AgentSource;
	task: string;
	assignment?: string;
	description?: string;
	lastIntent?: string;
	exitCode: number;
	output: string;
	stderr: string;
	truncated: boolean;
	durationMs: number;
	tokens: number;
	requests: number;
	contextTokens?: number;
	contextWindow?: number;
	modelOverride?: string | string[];
	resolvedModel?: string;
	error?: string;
	aborted?: boolean;
	abortReason?: string;
	usage?: Usage;
	outputPath?: string;
	patchPath?: string;
	branchName?: string;
	branchBaseSha?: string;
	nestedPatches?: NestedRepoPatch[];
	extractedToolData?: Record<string, unknown[]>;
	retryFailure?: {
		attempt: number;
		errorMessage: string;
		mode?: RetryRecoveryMode;
	};
	outputMeta?: { lineCount: number; charCount: number };
}

export interface TaskToolDetails {
	projectAgentsDir: string | null;
	results: SingleResult[];
	totalDurationMs: number;
	usage?: Usage;
	outputPaths?: string[];
	progress?: AgentProgress[];
	warning?: {
		kind: "homogeneous-triage";
		message: string;
	};
	async?: {
		state: "running" | "completed" | "failed";
		jobId: string;
		type: "task";
	};
}
