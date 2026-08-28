/// <reference types="./bun-imports.d.ts" />

import * as fs from "node:fs";
import * as path from "node:path";
import { formatHashlineHeader, InMemorySnapshotStore } from "@veyyon/hashline";
import type { AgentMessage, ResolvedThinkingLevel, ThinkingLevel } from "@veyyon/agent-core";
import type { Model, ToolExample } from "@veyyon/ai";
import { formatSessionDumpText, RpcClient } from "@veyyon/coding-agent";
import { estimateTokensFromText, prompt, splitTextLines } from "@veyyon/utils";
import { diffLines } from "diff";
import { formatDirectory } from "@veyyon/typescript-edit-benchmark/formatter";
import {
	discoverSharedInfra,
	InProcessClient,
	type SharedInfra,
} from "@veyyon/typescript-edit-benchmark/in-process-client";
import { EDIT_BENCHMARK_PROMPTS } from "./prompts/registry";
import type { EditTask } from "@veyyon/typescript-edit-benchmark/tasks";
import {
	verifyExpectedFileSubset,
	verifyExpectedFiles,
} from "@veyyon/typescript-edit-benchmark/verify";


import type { TaskRunResult } from "./runner";

export const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..", "..");
export const RUNS_DIR = path.join(REPO_ROOT, "runs");
export const TMP = path.join(RUNS_DIR, `rb-${Math.random().toString(36).slice(2, 10)}`);
export const CLI_PATH = Bun.fileURLToPath(import.meta.resolve("@veyyon/coding-agent/cli"));

export function formatLogPath(logFile: string): string {
	const relativePath = path.relative(REPO_ROOT, logFile);
	return relativePath === "" ? "." : relativePath;
}

export type ConversationDumpSessionState = {
	sessionFile?: string;
	systemPrompt?: string[];
	model?: Model;
	thinkingLevel?: ThinkingLevel | undefined;
	dumpTools?: Array<{ name: string; description: string; parameters: unknown; examples?: readonly ToolExample[] }>;
};

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

fs.mkdirSync(TMP, { recursive: true });

export let n = 0;
export function subtmp(pre: string): string {
	const dir = path.join(TMP, `${pre}-${n++}`);
	fs.mkdirSync(dir);
	return dir;
}

export interface BenchmarkConfig {
	provider: string;
	model: string;
	thinkingLevel?: ResolvedThinkingLevel;
	runsPerTask: number;
	timeout: number;
	
	connectionTimeout?: number;
	maxTurns?: number;
	taskConcurrency: number;
	requireEditToolCall?: boolean;
	requireReadToolCall?: boolean;
	noEditRequired?: boolean;
	autoFormat?: boolean;
	
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
	
	inProcess?: boolean;
}

export type ConversationDumpSnapshot = {
	messages: AgentMessage[];
	sourceSessionFile?: string;
	systemPrompt?: string[];
	model?: Model;
	thinkingLevel?: ThinkingLevel | undefined;
	dumpTools?: Array<{ name: string; description: string; parameters: unknown; examples?: readonly ToolExample[] }>;
};

export function sanitizeDumpPathSegment(value: string): string {
	return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export function getConversationDumpPath(dumpDir: string, taskId: string, runIndex: number): string {
	return path.join(dumpDir, sanitizeDumpPathSegment(taskId), `run-${runIndex + 1}.md`);
}

export function dumpArtifactsDir(dumpFilePath: string): string {
	if (dumpFilePath.endsWith(".md")) {
		return dumpFilePath.slice(0, -3);
	}
	if (dumpFilePath.endsWith(".jsonl")) {
		return dumpFilePath.slice(0, -6);
	}
	const ext = path.extname(dumpFilePath);
	return path.join(path.dirname(dumpFilePath), path.basename(dumpFilePath, ext));
}

export async function copyConversationArtifacts(sourceSessionFile: string, targetDumpFile: string): Promise<void> {
	const sourceArtifactsDir = dumpArtifactsDir(sourceSessionFile);
	const targetArtifactsDir = dumpArtifactsDir(targetDumpFile);
	try {
		const stat = await fs.promises.stat(sourceArtifactsDir);
		if (!stat.isDirectory()) return;
		await fs.promises.cp(sourceArtifactsDir, targetArtifactsDir, { recursive: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
}

export async function writeConversationDump(params: {
	dumpDir: string;
	taskId: string;
	runIndex: number;
	snapshot: ConversationDumpSnapshot;
}): Promise<string> {
	const dumpPath = getConversationDumpPath(params.dumpDir, params.taskId, params.runIndex);
	await fs.promises.mkdir(path.dirname(dumpPath), { recursive: true });
	const body = formatSessionDumpText({
		messages: params.snapshot.messages,
		systemPrompt: params.snapshot.systemPrompt,
		model: params.snapshot.model,
		thinkingLevel: params.snapshot.thinkingLevel,
		tools: params.snapshot.dumpTools,
	});
	await Bun.write(dumpPath, `${body}\n`);
	if (params.snapshot.sourceSessionFile) {
		await copyConversationArtifacts(params.snapshot.sourceSessionFile, dumpPath);
	}
	return dumpPath;
}

export async function snapshotConversationDump(client: BenchmarkClient): Promise<ConversationDumpSnapshot> {
	const [messages, state] = await Promise.all([client.getMessages(), client.getState()]);
	return {
		messages,
		sourceSessionFile: state.sessionFile,
		systemPrompt: state.systemPrompt,
		model: state.model,
		thinkingLevel: state.thinkingLevel,
		dumpTools: state.dumpTools,
	};
}

export function getEditPathFromArgs(args: unknown): string | null {
	if (!args || typeof args !== "object") return null;
	const pathValue = (args as { path?: unknown }).path;
	return typeof pathValue === "string" && pathValue.length > 0 ? pathValue : null;
}

export function getEditPayloadFromArgs(args: unknown): string {
	if (!args || typeof args !== "object") return "";
	const input = (args as { input?: unknown }).input;
	if (typeof input === "string") return input;
	const diff = (args as { diff?: unknown }).diff;
	if (typeof diff === "string") return diff;
	try {
		return JSON.stringify(args);
	} catch {
		return "";
	}
}

export const EDIT_FAILURE_CATEGORIES = [
	"range-continuation",
	"unified-diff",
	"no-change",
	"hash-mismatch",
	"other",
] as const;

export type EditFailureCategory = (typeof EDIT_FAILURE_CATEGORIES)[number];

export function categorizeEditFailure(error: string, args: unknown): EditFailureCategory {
	const payload = getEditPayloadFromArgs(args);
	const hasRangeReplacePayload = /^[1-9]\d*[a-z]{2}\.\.[1-9]\d*[a-z]{2}[ \t]*=/m.test(payload);
	if (
		/\\TEXT.* (?:continuation|has been removed)|range[- ]replacement continuation|LidA\.\.LidB=FIRST_LINE/i.test(
			error,
		)
	) {
		return "range-continuation";
	}
	if (/unified-diff syntax|\+Lid[=|]|\+[1-9]\d*[a-z]{2}[=|]/i.test(error)) {
		return "unified-diff";
	}
	if (/No changes made|no changes being made|replacement is identical/i.test(error)) {
		return "no-change";
	}
	if (/hash mismatch|expected hash|stale/i.test(error)) {
		return "hash-mismatch";
	}
	if (hasRangeReplacePayload && /unrecognized op|cannot parse|Lines must start/i.test(error)) {
		return "range-continuation";
	}
	return "other";
}

export function emptyEditFailureCategoryCounts(): Record<EditFailureCategory, number> {
	return Object.fromEntries(EDIT_FAILURE_CATEGORIES.map(category => [category, 0])) as Record<
		EditFailureCategory,
		number
	>;
}

export function countEditFailureCategories(runs: TaskRunResult[]): Record<EditFailureCategory, number> {
	const counts = emptyEditFailureCategoryCounts();
	for (const run of runs) {
		for (const failure of run.editFailures) {
			counts[failure.category ?? "other"] += 1;
		}
	}
	return counts;
}

export const HL_SUBTYPES = ["set", "set_range", "insert"] as const;
export const BENCHMARK_TOOL_NAMES = ["read", "edit", "write", "apply_patch"] as const;
export const EDIT_TOOL_NAMES = ["edit", "apply_patch"] as const;

export function isEditTool(toolName: unknown): toolName is (typeof EDIT_TOOL_NAMES)[number] {
	return toolName === "edit" || toolName === "vim" || toolName === "apply_patch";
}

export function isMutationTool(toolName: unknown): boolean {
	return isEditTool(toolName) || toolName === "write";
}

export function countHashlineEditSubtypes(args: unknown): Record<string, number> {
	const counts: Record<string, number> = Object.fromEntries(HL_SUBTYPES.map(k => [k, 0]));
	if (!args || typeof args !== "object") return counts;
	const edits = (args as { edits?: unknown[] }).edits;
	if (!Array.isArray(edits)) return counts;
	for (const edit of edits) {
		if (!edit || typeof edit !== "object") continue;
		for (const key of HL_SUBTYPES) {
			if (key in edit) {
				counts[key]++;
				break;
			}
		}
	}
	return counts;
}

export async function collectOriginalFileContents(cwd: string, files: string[]): Promise<Map<string, string>> {
	const originals = new Map<string, string>();
	for (const file of files) {
		const fullPath = path.join(cwd, file);
		try {
			originals.set(fullPath, await Bun.file(fullPath).text());
		} catch {
		}
	}
	return originals;
}

export function buildMutationPreviewAgainstOriginal(original: string, current: string): string | null {
	if (original === current) return null;

	const changes = diffLines(original, current);
	const preview: string[] = [];
	let origLineNum = 1;
	let newLineNum = 1;

	for (const change of changes) {
		const lines = splitTextLines(change.value);
		if (!change.added && !change.removed) {
			origLineNum += lines.length;
			newLineNum += lines.length;
			continue;
		}

		if (change.removed) {
			for (const line of lines) {
				preview.push(`-${origLineNum}:${line}`);
				origLineNum += 1;
			}
			continue;
		}

		for (const line of lines) {
			preview.push(`+${newLineNum}:${line}`);
			newLineNum += 1;
		}
	}

	return preview.length > 0 ? preview.join("\n") : null;
}

export async function appendNoChangeMutationHint(
	error: string,
	args: unknown,
	cwd: string,
	originalFiles: Map<string, string>,
): Promise<string> {
	if (!error.includes("No changes made")) return error;
	const editPath = getEditPathFromArgs(args);
	if (!editPath) return error;

	const fullPath = editPath.startsWith("/") ? editPath : path.join(cwd, editPath);
	const original = originalFiles.get(fullPath);
	if (original === undefined) return error;

	let current: string;
	try {
		current = await Bun.file(fullPath).text();
	} catch {
		return error;
	}

	const preview = buildMutationPreviewAgainstOriginal(original, current);
	if (!preview) return error;

	return `${error}\nThe file differs from the original fixture at these lines:\n${preview}`;
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

export class PromptTimeoutError extends Error {
	telemetry: PromptAttemptTelemetry;

	constructor(telemetry: PromptAttemptTelemetry) {
		super("Timeout waiting for agent_end");
		this.name = "PromptTimeoutError";
		this.telemetry = telemetry;
	}
}

export interface PromptTurnLimitTelemetry {
	elapsedMs: number;
	observedTurns: number;
	maxTurns: number;
	pendingRetry: boolean;
	lastEventType?: string;
	recentEventTypes: string[];
}

export class PromptTurnLimitError extends Error {
	telemetry: PromptTurnLimitTelemetry;

	constructor(telemetry: PromptTurnLimitTelemetry) {
		super(
			`Max turn limit exceeded: observed ${telemetry.observedTurns} turn_start events (limit ${telemetry.maxTurns}).`,
		);
		this.name = "PromptTurnLimitError";
		this.telemetry = telemetry;
	}
}

export interface MutationIntentValidation {
	matched: boolean;
	reason: string;
	mutationType?: string;
	file?: string;
	lineNumber?: number;
}

export function buildTimeoutRetryContext(telemetry: PromptAttemptTelemetry, retryNumber: number, retryLimit: number): string {
	return [
		`Previous attempt timed out waiting for agent_end after ${telemetry.elapsedMs}ms.`,
		`Observed events=${telemetry.eventCount}, tool_starts=${telemetry.toolExecutionStarts}, tool_ends=${telemetry.toolExecutionEnds}, message_ends=${telemetry.messageEnds}.`,
		telemetry.lastEventType
			? `Last event type: ${telemetry.lastEventType}.`
			: "No events were observed before timeout.",
		`Timeout retry ${retryNumber}/${retryLimit}: emit one minimal, concrete edit attempt quickly and stop.`,
	].join("\n");
}

export const AUTH_FAILURE_RE =
	/\b(401|unauthorized|forbidden|invalid api key|invalid key|user not found|authentication|not authenticated|permission denied|access denied)\b/i;

export interface ProviderFailure {
	kind: "auth" | "provider";
	message: string;
}

export function detectProviderFailure(events: Array<{ type: string; [key: string]: unknown }>): ProviderFailure | null {
	for (const event of events) {
		if (event.type !== "message_end") continue;
		const message = (event as { message?: unknown }).message;
		if (!message || typeof message !== "object") continue;
		const role = (message as { role?: unknown }).role;
		if (role !== "assistant") continue;
		const errorMessage = (message as { errorMessage?: unknown }).errorMessage;
		if (typeof errorMessage !== "string") continue;
		const normalized = errorMessage.trim();
		if (normalized.length === 0) continue;
		return {
			kind: AUTH_FAILURE_RE.test(normalized) ? "auth" : "provider",
			message: normalized,
		};
	}
	return null;
}

export function getProviderFailureRetryDelayMs(retryNumber: number): number {
	const safeRetryNumber = Math.max(1, retryNumber);
	return Math.min(10_000, 1_000 * 2 ** (safeRetryNumber - 1));
}

export function buildProviderFailureRetryContext(
	failure: ProviderFailure,
	retryNumber: number,
	retryLimit: number,
	delayMs: number,
): string {
	const category = failure.kind === "auth" ? "provider/auth" : "provider";
	return [
		`Previous attempt failed due to a ${category} error.`,
		`Provider error: ${failure.message}`,
		`Retry ${retryNumber}/${retryLimit} after ${delayMs}ms backoff. Resume the requested edit flow once the provider responds successfully.`,
	].join("\n");
}

export async function evaluateMutationIntent(
	task: EditTask,
	cwd: string,
	expectedDir: string,
): Promise<MutationIntentValidation | null> {
	const metadata = task.metadata;
	const file = metadata?.fileName ?? task.files[0];
	const lineNumber = metadata?.lineNumber;
	if (!file || typeof lineNumber !== "number" || lineNumber < 1) {
		return null;
	}

	const currentPath = file.startsWith("/") ? file : path.join(cwd, file);
	const expectedPath = file.startsWith("/") ? file : path.join(expectedDir, file);

	let currentText: string;
	let expectedText: string;
	try {
		currentText = await Bun.file(currentPath).text();
		expectedText = await Bun.file(expectedPath).text();
	} catch {
		return {
			matched: false,
			reason: "Unable to read current/expected target file for mutation-intent check.",
			mutationType: metadata?.mutationType,
			file,
			lineNumber,
		};
	}

	const currentLine = currentText.split("\n")[lineNumber - 1] ?? "";
	const expectedLine = expectedText.split("\n")[lineNumber - 1] ?? "";
	const originalSnippet = metadata?.originalSnippet;
	const mutatedSnippet = metadata?.mutatedSnippet;

	if (currentLine === expectedLine && expectedLine.length > 0) {
		return {
			matched: true,
			reason: "Target line exactly matches expected fixture.",
			mutationType: metadata?.mutationType,
			file,
			lineNumber,
		};
	}

	if (typeof originalSnippet === "string" && originalSnippet.length > 0) {
		const hasOriginal = currentLine.includes(originalSnippet);
		const stillHasMutated =
			typeof mutatedSnippet === "string" && mutatedSnippet.length > 0 ? currentLine.includes(mutatedSnippet) : false;
		if (hasOriginal && !stillHasMutated) {
			return {
				matched: true,
				reason: "Target line contains original snippet and no longer contains mutated snippet.",
				mutationType: metadata?.mutationType,
				file,
				lineNumber,
			};
		}
	}

	return {
		matched: false,
		reason: `Target line mismatch at ${file}:${lineNumber}.`,
		mutationType: metadata?.mutationType,
		file,
		lineNumber,
	};
}

export function buildGuidedHashlinePatch(file: string, actual: string, expected: string): string | null {
	const changes = diffLines(actual, expected);
	const actualLines = actual.split("\n");
	const fileLineCount =
		actualLines.length > 0 && actualLines[actualLines.length - 1] === ""
			? actualLines.length - 1
			: actualLines.length;

	const ops: string[] = [];
	let line = 1;
	let pendingStart = 1;
	let pendingRemoved = 0;
	let pendingAdded: string[] = [];

	const formatPayload = (body: string[]): string => (body.length === 0 ? "" : `\n${body.join("\n")}`);

	const flush = () => {
		if (pendingRemoved === 0 && pendingAdded.length === 0) return;

		if (pendingRemoved === 0) {
			if (pendingAdded.length === 0) return;
			if (pendingStart <= 1) {
				ops.push(`BOF↓${formatPayload(pendingAdded)}`);
			} else if (pendingStart > fileLineCount) {
				ops.push(`EOF↓${formatPayload(pendingAdded)}`);
			} else {
				ops.push(`${pendingStart}↑${formatPayload(pendingAdded)}`);
			}
		} else {
			const startLine = pendingStart;
			const endLine = pendingStart + pendingRemoved - 1;
			const anchor = startLine === endLine ? `${startLine}` : `${startLine}-${endLine}`;
			if (pendingAdded.length === 0) {
				ops.push(`${anchor}!`);
			} else {
				ops.push(`${anchor}:${formatPayload(pendingAdded)}`);
			}
		}

		pendingRemoved = 0;
		pendingAdded = [];
	};

	for (const change of changes) {
		const lines = splitTextLines(change.value);
		if (!change.added && !change.removed) {
			flush();
			line += lines.length;
			pendingStart = line;
			continue;
		}
		if (pendingRemoved === 0 && pendingAdded.length === 0) {
			pendingStart = line;
		}
		if (change.removed) {
			pendingRemoved += lines.length;
			line += lines.length;
		}
		if (change.added) {
			for (let li = 0; li < lines.length; li++) pendingAdded.push(lines[li]!);
		}
	}
	flush();

	if (ops.length === 0) return null;
	const normalizedActual = actual.replace(/\r\n?/g, "\n");
	const snapshots = new InMemorySnapshotStore();
	const tag = snapshots.record(file, normalizedActual);
	const header = formatHashlineHeader(file, tag);
	return `${header}\n${ops.join("\n")}`;
}

