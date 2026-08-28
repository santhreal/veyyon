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


import {
	AUTH_FAILURE_RE,
	BENCHMARK_TOOL_NAMES,
	CLI_PATH,
	EDIT_FAILURE_CATEGORIES,
	EDIT_TOOL_NAMES,
	HL_SUBTYPES,
	PromptTimeoutError,
	PromptTurnLimitError,
	REPO_ROOT,
	RUNS_DIR,
	TMP,
	appendNoChangeMutationHint,
	buildGuidedHashlinePatch,
	buildMutationPreviewAgainstOriginal,
	buildProviderFailureRetryContext,
	buildTimeoutRetryContext,
	categorizeEditFailure,
	collectOriginalFileContents,
	copyConversationArtifacts,
	countEditFailureCategories,
	countHashlineEditSubtypes,
	detectProviderFailure,
	dumpArtifactsDir,
	emptyEditFailureCategoryCounts,
	evaluateMutationIntent,
	formatLogPath,
	getConversationDumpPath,
	getEditPathFromArgs,
	getEditPayloadFromArgs,
	getProviderFailureRetryDelayMs,
	isEditTool,
	isMutationTool,
	n,
	sanitizeDumpPathSegment,
	snapshotConversationDump,
	subtmp,
	writeConversationDump,
	type BenchmarkClient,
	type BenchmarkConfig,
	type ConversationDumpSessionState,
	type ConversationDumpSnapshot,
	type EditFailureCategory,
	type MutationIntentValidation,
	type PromptAttemptTelemetry,
	type PromptTurnLimitTelemetry,
	type ProviderFailure,
} from "./runner-helpers";

export {
	EDIT_FAILURE_CATEGORIES,
	writeConversationDump,
	type BenchmarkConfig,
	type EditFailureCategory,
	type MutationIntentValidation,
	type PromptAttemptTelemetry,
	type PromptTurnLimitTelemetry,
} from "./runner-helpers";

async function buildGuidedContext(
	task: EditTask,
	cwd: string,
	expectedDir: string,
	config: BenchmarkConfig,
): Promise<string | null> {
	if (!config.guided) return null;
	if (config.editVariant !== "hashline") return null;

	const file = task.metadata?.fileName ?? task.files[0];
	if (!file) return null;

	const actualPath = path.join(cwd, file);
	const expectedPath = path.join(expectedDir, file);
	const actual = await Bun.file(actualPath)
		.text()
		.catch(() => null);
	const expected = await Bun.file(expectedPath)
		.text()
		.catch(() => null);
	if (actual === null || expected === null) return null;

	const patch = buildGuidedHashlinePatch(file, actual, expected);
	if (patch === null) return null;
	const opCount = patch.split("\n").filter(l => /[↑↓→]/.test(l)).length;
	if (opCount === 0 || opCount > 25) return null;

	const args = { path: file, input: patch };
	const argsText = JSON.stringify(args, null, 2);
	if (argsText.length > 20_000) return null;
	const metaParts: string[] = [];
	if (typeof task.metadata?.lineNumber === "number") metaParts.push(`Line: ${task.metadata.lineNumber}`);
	if (typeof task.metadata?.mutationType === "string") metaParts.push(`Mutation: ${task.metadata.mutationType}`);

	return [
		`Target file: \`${file}\`${metaParts.length > 0 ? ` (${metaParts.join(", ")})` : ""}.`,
		"Apply this edit tool call (single call; copy/paste args exactly):",
		`\`\`\`diff\n${argsText}\n\`\`\``,
	].join("\n\n");
}

function buildInstructions(config: BenchmarkConfig): string {
	return config.noEditRequired
		? "Read the relevant files first, then apply the fix."
		: "Read the relevant files first, then use the edit or vim tool to apply the fix.";
}

type BenchmarkPromptDelivery = {
	kind: "prompt" | "followUp";
	message: string;
};

function buildBenchmarkSystemPrompt(params: { multiFile: boolean; config: BenchmarkConfig }): string {
	return prompt.render(EDIT_BENCHMARK_PROMPTS["benchmark-system"].text, {
		multiFile: params.multiFile,
		instructions: buildInstructions(params.config),
	});
}

function buildInitialBenchmarkPrompt(params: { taskPrompt: string; guidedContext?: string | null }): string {
	return prompt.render(EDIT_BENCHMARK_PROMPTS["benchmark-task"].text, {
		task_prompt: params.taskPrompt,
		guided_context: params.guidedContext ?? undefined,
	});
}

function buildRetryBenchmarkPrompt(params: { retryContext: string; guidedContext?: string | null }): string {
	return prompt.render(EDIT_BENCHMARK_PROMPTS["benchmark-retry"].text, {
		retry_context: params.retryContext,
		guided_context: params.guidedContext ?? undefined,
	});
}

function buildBenchmarkPromptDelivery(params: {
	taskPrompt: string;
	guidedContext?: string | null;
	retryContext?: string | null;
}): BenchmarkPromptDelivery {
	if (params.retryContext) {
		return {
			kind: "followUp",
			message: buildRetryBenchmarkPrompt({
				retryContext: params.retryContext,
				guidedContext: params.guidedContext,
			}),
		};
	}

	return {
		kind: "prompt",
		message: buildInitialBenchmarkPrompt({
			taskPrompt: params.taskPrompt,
			guidedContext: params.guidedContext,
		}),
	};
}

const BENCHMARK_PROVIDER_SESSION_VERSION = 1;

function buildBenchmarkProviderSessionId(params: {
	config: BenchmarkConfig;
	task: EditTask;
	multiFile: boolean;
	initialGuidedContext?: string | null;
}): string {
	const keyMaterial = [
		`version:${BENCHMARK_PROVIDER_SESSION_VERSION}`,
		`provider:${params.config.provider}`,
		`model:${params.config.model}`,
		`task:${params.task.id}`,
		`system:${buildBenchmarkSystemPrompt({ multiFile: params.multiFile, config: params.config })}`,
		`initial:${buildInitialBenchmarkPrompt({ taskPrompt: params.task.prompt, guidedContext: params.initialGuidedContext })}`,
	].join("\n");
	return `reb_${Bun.hash(keyMaterial).toString(36)}`;
}

async function prepareBenchmarkSessionSetup(params: {
	config: BenchmarkConfig;
	task: EditTask;
	cwd: string;
	expectedDir: string;
	multiFile: boolean;
}): Promise<{ initialGuidedContext: string | null; providerSessionId: string; rpcArgs: string[] }> {
	const initialGuidedContext = await buildGuidedContext(params.task, params.cwd, params.expectedDir, params.config);
	const providerSessionId = buildBenchmarkProviderSessionId({
		config: params.config,
		task: params.task,
		multiFile: params.multiFile,
		initialGuidedContext,
	});
	return {
		initialGuidedContext,
		providerSessionId,
		rpcArgs: buildBenchmarkRpcArgs(params.config, params.multiFile, providerSessionId),
	};
}

function buildBenchmarkRpcArgs(config: BenchmarkConfig, multiFile: boolean, providerSessionId: string): string[] {
	return [
		"--provider-session-id",
		providerSessionId,
		"--append-system-prompt",
		buildBenchmarkSystemPrompt({ multiFile, config }),
		"--tools",
		BENCHMARK_TOOL_NAMES.join(","),
		"--no-skills",
		"--no-title",
		"--no-rules",
		"--no-lsp",
	];
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

interface PendingEditCall {
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
	
	hashlineEditSubtypes?: Record<string, number>;
	mutationIntentMatched?: boolean;
	mutationIntentReason?: string;
	timeoutTelemetry?: PromptAttemptTelemetry;
	
	earlyStopped?: boolean;
	
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
	
	bestRunIndex: number;
	
	success: boolean;
	
	tokens: TokenStats;
	
	duration: number;
	
	indentScore: number;
	
	toolCalls: ToolCallStats;
	
	editSuccessRate: number;
	
	autocorrectFreeSuccess: boolean;
	
	flakeSuccessRate: number;
}

export interface BenchmarkSummary {
	totalTasks: number;
	
	totalRuns: number;
	
	successfulRuns: number;
	
	successfulTasks: number;
	
	taskSuccessRate: number;
	
	flakyTasks: number;
	
	consistentlyPassingTasks: number;
	
	successfulOneShotTasks: number;
	
	totalOneShotSuccessTokens: TokenStats;
	
	avgOneShotSuccessTokensPerTask: TokenStats;
	
	medianOneShotSuccessTokensPerTask: TokenStats;
	
	p1OneShotSuccessTokensPerTask: TokenStats;
	
	p99OneShotSuccessTokensPerTask: TokenStats;
	
	totalTokens: TokenStats;
	
	avgTokensPerTask: TokenStats;
	
	medianTokensPerTask: TokenStats;
	
	p1TokensPerTask: TokenStats;
	
	p99TokensPerTask: TokenStats;
	
	totalDuration: number;
	
	avgDurationPerTask: number;
	
	avgIndentScore: number;
	
	totalToolCalls: ToolCallStats;
	
	avgToolCallsPerTask: ToolCallStats;
	
	editSuccessRate: number;
	
	autocorrectFreeSuccessfulTasks: number;
	
	autocorrectFreeSuccessRate: number;
	
	autocorrectedBestRuns: number;
	
	editAutocorrectRate: number;
	
	timeoutRuns: number;
	
	totalTimeoutRetries: number;
	totalZeroToolRetries: number;
	totalProviderFailureRetries: number;
	
	ghostRuns: number;
	
	transportFailureRuns: number;
	mutationIntentMatchRate?: number;
	
	editFailureCategories: Record<EditFailureCategory, number>;
	
	hashlineEditSubtypes?: Record<string, number>;
}

export interface BenchmarkResult {
	config: BenchmarkConfig;
	tasks: TaskResult[];
	summary: BenchmarkSummary;
	startTime: string;
	endTime: string;
}

interface TaskRunItem {
	task: EditTask;
	runIndex: number;
}

async function copyFixtures(task: EditTask, destDir: string): Promise<void> {
	if (!task.inputDir) {
		throw new Error(`Task ${task.id} has no inputDir`);
	}
	const entries = await fs.promises.readdir(task.inputDir, { withFileTypes: true });
	await Promise.all(
		entries.map(entry =>
			fs.promises.cp(path.join(task.inputDir!, entry.name), path.join(destDir, entry.name), { recursive: true }),
		),
	);
}

interface EarlyStopOptions {
	check: () => Promise<boolean>;
	onMatch: () => void | Promise<void>;
}

function buildEarlyStop(params: {
	config: BenchmarkConfig;
	cwd: string;
	expectedDir: string;
	files: string[];
	logEvent: (event: unknown) => Promise<void>;
	attempt: number;
	onMatched: () => void;
}): EarlyStopOptions | undefined {
	if (params.config.earlyStopOnMatch === false) return undefined;
	if (params.files.length === 0) return undefined;
	return {
		check: async () => {
			const verification = await verifyExpectedFileSubset(params.expectedDir, params.cwd, params.files);
			return verification.success;
		},
		onMatch: async () => {
			params.onMatched();
			await params.logEvent({ type: "early_stop", attempt: params.attempt, reason: "formatted_match" });
		},
	};
}

async function runSingleTask(
	task: EditTask,
	runIndex: number,
	config: BenchmarkConfig,
	cwd: string,
	expectedDir: string,
	shared?: SharedInfra,
): Promise<TaskRunResult> {
	const startTime = Date.now();
	let error: string | undefined;
	let patchApplied = false;
	let verificationPassed = false;
	let indentScore: number | undefined;
	let formattedEquivalent: boolean | undefined;
	let diffStats: { linesChanged: number; charsChanged: number } | undefined;
	let tokens: TokenStats = { input: 0, output: 0, reasoning: 0, total: 0 };
	let agentResponse: string | undefined;
	let diff: string | undefined;
	const editFailures: EditFailure[] = [];
	const editWarnings: string[] = [];
	let editAutocorrectCount = 0;
	let timeoutTelemetry: PromptAttemptTelemetry | undefined;
	let mutationIntentValidation: MutationIntentValidation | null = null;
	let earlyStoppedByMatch = false;
	let conversationSnapshot: ConversationDumpSnapshot | undefined;
	const toolStats = {
		read: 0,
		edit: 0,
		write: 0,
		editSuccesses: 0,
		editFailures: 0,
		editWarnings: 0,
		editAutocorrects: 0,
		totalInputChars: 0,
	};
	const hashlineSubtypes: Record<string, number> = Object.fromEntries(HL_SUBTYPES.map(k => [k, 0]));

	const logFile = path.join(TMP, `run-${task.id}-${runIndex}.jsonl`);
	const logEvent = async (event: unknown) => {
		await fs.promises.appendFile(logFile, `${JSON.stringify(event)}\n`);
	};
	const originalFiles = await collectOriginalFileContents(cwd, task.files);
	let timeoutRetriesUsed = 0;
	let zeroToolRetries = 0;
	let providerFailureRetries = 0;

	const previousEnv = {
		VEYYON_EDIT_VARIANT: process.env.VEYYON_EDIT_VARIANT,
		VEYYON_EDIT_FUZZY: process.env.VEYYON_EDIT_FUZZY,
		VEYYON_EDIT_FUZZY_THRESHOLD: process.env.VEYYON_EDIT_FUZZY_THRESHOLD,
		VEYYON_STRICT_EDIT_MODE: process.env.VEYYON_STRICT_EDIT_MODE,
		VEYYON_NO_TITLE: process.env.VEYYON_NO_TITLE,
	};
	try {
		const sessionSetup = await prepareBenchmarkSessionSetup({
			config,
			task,
			cwd,
			expectedDir,
			multiFile: false,
		});
		await fs.promises.appendFile(
			logFile,
			`{"type":"meta","task":"${task.id}","run":${runIndex},"workDir":"${cwd}","providerSessionId":${JSON.stringify(sessionSetup.providerSessionId)}}\n`,
		);

		if (config.editVariant !== undefined) process.env.VEYYON_EDIT_VARIANT = config.editVariant;
		if (config.editFuzzy !== undefined)
			process.env.VEYYON_EDIT_FUZZY = config.editFuzzy === "auto" ? "auto" : config.editFuzzy ? "1" : "0";
		if (config.editFuzzyThreshold !== undefined)
			process.env.VEYYON_EDIT_FUZZY_THRESHOLD =
				config.editFuzzyThreshold === "auto" ? "auto" : String(config.editFuzzyThreshold);
		process.env.VEYYON_STRICT_EDIT_MODE = "1";
		process.env.VEYYON_NO_TITLE = "1";

		const useInProcess = config.inProcess !== false;
		const client: BenchmarkClient = useInProcess
			? new InProcessClient({
					cwd,
					model: config.model,
					appendSystemPrompt: buildBenchmarkSystemPrompt({ multiFile: false, config }),
					tools: [...BENCHMARK_TOOL_NAMES],
					editVariant: config.editVariant,
					editFuzzy: config.editFuzzy,
					editFuzzyThreshold: config.editFuzzyThreshold,
					shared,
				})
			: (() => {
					const rpc = new RpcClient({
						cliPath: CLI_PATH,
						cwd,
						provider: config.provider,
						model: config.model,
						args: sessionSetup.rpcArgs,
						env: { ...process.env } as Record<string, string>,
					});
					return Object.assign(rpc, {
						dispose: async () => rpc[Symbol.dispose](),
					}) as unknown as BenchmarkClient;
				})();

		try {
			await client.start();

			if (config.thinkingLevel) {
				await client.setThinkingLevel(config.thinkingLevel);
			}

			const initialState = await client.getState();
			const systemPromptTokens = estimateTokensFromText(initialState.systemPrompt?.join("\n\n") ?? "");

			const maxAttempts = Math.max(1, Math.floor(config.maxAttempts ?? 1));
			const maxTimeoutRetries = config.maxTimeoutRetries ?? 3;
			const noOpRetryLimit = config.noOpRetryLimit ?? 2;
			const maxProviderFailureRetries = config.maxProviderFailureRetries ?? 3;
			let retryContext: string | null = null;
			let allEvents: Array<{ type: string; [key: string]: unknown }> = [];

			for (let attempt = 0; attempt < maxAttempts; attempt++) {
				const guidedContext =
					attempt === 0
						? sessionSetup.initialGuidedContext
						: await buildGuidedContext(task, cwd, expectedDir, config);
				const delivery = buildBenchmarkPromptDelivery({
					taskPrompt: task.prompt,
					guidedContext,
					retryContext,
				});

				await fs.promises.appendFile(
					logFile,
					`{"type":"prompt","attempt":${attempt + 1},"delivery":${JSON.stringify(delivery.kind)},"message":${JSON.stringify(delivery.message)}}\n`,
				);

				const statsBefore = await client.getSessionStats();
				let events: Array<{ type: string; [key: string]: unknown }>;
				try {
					events = await collectPromptEvents(
						client,
						delivery,
						config,
						logEvent,
						buildEarlyStop({
							config,
							cwd,
							expectedDir,
							files: task.files,
							logEvent,
							attempt: attempt + 1,
							onMatched: () => {
								earlyStoppedByMatch = true;
							},
						}),
					);
				} catch (err) {
					if (err instanceof PromptTurnLimitError) {
						error = err.message;
						await logEvent({ type: "turn_limit_exceeded", attempt: attempt + 1, telemetry: err.telemetry });
						break;
					}
					if (err instanceof PromptTimeoutError) {
						timeoutTelemetry = err.telemetry;
						await logEvent({ type: "timeout", attempt: attempt + 1, telemetry: err.telemetry });
						timeoutRetriesUsed += 1;
						retryContext = buildTimeoutRetryContext(err.telemetry, timeoutRetriesUsed, maxTimeoutRetries);
						if (timeoutRetriesUsed >= maxTimeoutRetries) {
							error = `Timeout exhausted after ${maxTimeoutRetries} retries (last: ${err.telemetry.elapsedMs}ms, events=${err.telemetry.eventCount}, last_event=${err.telemetry.lastEventType ?? "none"})`;
							await logEvent({
								type: "timeout_exhausted",
								retriesUsed: timeoutRetriesUsed,
								telemetry: err.telemetry,
							});
							break;
						}
						attempt--; // Don't consume a regular attempt slot for timeout retries
						continue;
					}
					throw err;
				}
				const statsAfter = await client.getSessionStats();
				const attemptTokens = diffTokenStats(statsBefore, statsAfter, systemPromptTokens);
				tokens = {
					input: tokens.input + attemptTokens.input,
					output: tokens.output + attemptTokens.output,
					reasoning: tokens.reasoning + attemptTokens.reasoning,
					total: tokens.total + attemptTokens.total,
				};
				await logEvent({ type: "stats", before: statsBefore, after: statsAfter, attempt: attempt + 1 });
				allEvents = allEvents.concat(events);

				agentResponse = (await client.getLastAssistantText()) ?? undefined;
				await logEvent({ type: "response", text: agentResponse, attempt: attempt + 1 });

				const providerFailure = detectProviderFailure(events);
				const hasMutationToolCall = events.some(
					event =>
						event.type === "tool_execution_start" && isMutationTool((event as { toolName?: unknown }).toolName),
				);
				if (providerFailure && !hasMutationToolCall) {
					await logEvent({
						type: "provider_failure",
						attempt: attempt + 1,
						kind: providerFailure.kind,
						error: providerFailure.message,
					});
					if (providerFailureRetries < maxProviderFailureRetries) {
						providerFailureRetries += 1;
						const delayMs = getProviderFailureRetryDelayMs(providerFailureRetries);
						await logEvent({
							type: "provider_failure_retry",
							attempt: attempt + 1,
							retryNumber: providerFailureRetries,
							retryLimit: maxProviderFailureRetries,
							delayMs,
							kind: providerFailure.kind,
						});
						retryContext = buildProviderFailureRetryContext(
							providerFailure,
							providerFailureRetries,
							maxProviderFailureRetries,
							delayMs,
						);
						await Bun.sleep(delayMs);
						attempt--; // Don't consume a regular attempt slot for provider/auth retries
						continue;
					}
					error = `Provider ${providerFailure.kind} failure: ${providerFailure.message}`;
					await logEvent({
						type: "provider_failure_exhausted",
						attempt: attempt + 1,
						retriesUsed: providerFailureRetries,
						kind: providerFailure.kind,
						error: providerFailure.message,
					});
					break;
				}
				const pendingEdits = new Map<string, PendingEditCall>();
				const rawToolBlocks = new Map<string, string>();
				for (const event of events) {
					if (event.type === "message_end") {
						for (const raw of extractAssistantToolRawBlocks(event)) {
							rawToolBlocks.set(raw.id, raw.rawBlock);
							const pending = pendingEdits.get(raw.id);
							if (pending) pending.rawBlock = raw.rawBlock;
						}
					}
					if (event.type === "tool_execution_start") {
						const e = event as { toolName?: string; toolCallId?: string; args?: unknown };
						const toolName = e.toolName;
						if (toolName === "read") {
							toolStats.read++;
						} else if (isEditTool(toolName)) {
							toolStats.edit++;
							if (e.toolCallId)
								pendingEdits.set(e.toolCallId, { args: e.args, rawBlock: rawToolBlocks.get(e.toolCallId) });
						} else if (toolName === "write") {
							toolStats.write++;
						}

						
						if (e.args) {
							toolStats.totalInputChars += JSON.stringify(e.args).length;
						}
					} else if (event.type === "tool_execution_end") {
						const e = event as { toolName?: string; toolCallId?: string; isError?: boolean; result?: unknown };
						if (isEditTool(e.toolName) && e.toolCallId && pendingEdits.has(e.toolCallId)) {
							const pendingEdit = pendingEdits.get(e.toolCallId) ?? { args: null };
							const args = pendingEdit.args;
							pendingEdits.delete(e.toolCallId);
							if (config.editVariant === "hashline" && args) {
								const counts = countHashlineEditSubtypes(args);
								for (const key of HL_SUBTYPES) {
									hashlineSubtypes[key] += counts[key];
								}
							}
							if (e.isError) {
								toolStats.editFailures++;
								const error = await appendNoChangeMutationHint(
									extractToolErrorMessage(e.result),
									args,
									cwd,
									originalFiles,
								);
								editFailures.push({
									toolCallId: e.toolCallId,
									args,
									error,
									rawBlock: pendingEdit.rawBlock,
									category: categorizeEditFailure(error, args),
								});
							} else {
								toolStats.editSuccesses++;
								if (e.toolName === "edit") {
									const warningMessages = extractHashlineWarnings(e.result);
									if (warningMessages.length > 0) {
										for (let wi = 0; wi < warningMessages.length; wi++) editWarnings.push(warningMessages[wi]!);
										toolStats.editWarnings += warningMessages.length;
										if (hasHashlineAutocorrectWarning(warningMessages)) {
											editAutocorrectCount++;
											toolStats.editAutocorrects++;
										}
									}
								}
							}
						}
					}
				}

				
				const madeEditAttempt = toolStats.edit > 0 || toolStats.write > 0;
				if (!madeEditAttempt && zeroToolRetries < noOpRetryLimit) {
					zeroToolRetries++;
					await logEvent({ type: "zero_tool_retry", attempt: attempt + 1, retryNumber: zeroToolRetries });
					retryContext = `Previous attempt read files but made no edit attempt — you must use the edit or vim tool to apply the fix. Retry ${zeroToolRetries}/${noOpRetryLimit}.`;
					attempt--; // Don't consume a regular attempt slot
					continue;
				}

				patchApplied = toolStats.edit > 0;
				const verification = await verifyExpectedFiles(expectedDir, cwd);
				if (config.autoFormat) {
					await formatDirectory(cwd);
				}

				verificationPassed = verification.success;
				indentScore = verification.indentScore;
				formattedEquivalent = verification.formattedEquivalent;
				diffStats = verification.diffStats;
				diff = verification.diff;
				mutationIntentValidation = await evaluateMutationIntent(task, cwd, expectedDir);
				if (!verification.success && verification.error) {
					error = verification.error;
				}

				if (verification.success) {
					break;
				}

				const mutationIntentSuffix = mutationIntentValidation
					? `\n\nMutation intent: ${mutationIntentValidation.matched ? "matched" : "not matched"} (${mutationIntentValidation.reason})`
					: "";
				retryContext = error
					? `Verification failed: ${error}${diff ? `\n\nDiff (expected vs actual):\n\n\`\`\`diff\n${diff}\n\`\`\`` : ""}${mutationIntentSuffix}`
					: `Previous attempt failed.${mutationIntentSuffix}`;
			}
			if (config.conversationDumpDir) {
				conversationSnapshot = await snapshotConversationDump(client);
			}
		} finally {
			await client.dispose();
		}
	} catch (err) {
		error = err instanceof Error ? err.message : String(err);
		await logEvent({ type: "error", error });
	} finally {
		const restoreEnvKey = (key: keyof typeof previousEnv) => {
			const value = previousEnv[key];
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		};
		restoreEnvKey("VEYYON_EDIT_VARIANT");
		restoreEnvKey("VEYYON_EDIT_FUZZY");
		restoreEnvKey("VEYYON_EDIT_FUZZY_THRESHOLD");
		restoreEnvKey("VEYYON_STRICT_EDIT_MODE");
		restoreEnvKey("VEYYON_NO_TITLE");
	}

	const duration = Date.now() - startTime;
	const mustUseEditTool = Boolean(config.requireEditToolCall) && !config.noEditRequired;
	const mustUseReadTool = Boolean(config.requireReadToolCall) && !config.noEditRequired;
	const editSucceeded = toolStats.editSuccesses > 0;
	const success =
		verificationPassed && (!mustUseEditTool || editSucceeded) && (!mustUseReadTool || toolStats.read > 0);
	const metadata = task.metadata;

	await logEvent({
		type: "result",
		success,
		patchApplied,
		verificationPassed,
		error,
		duration,
		timeoutTelemetry,
		mutationIntentValidation,
	});
	console.log(`  Log: ${formatLogPath(logFile)}`);

	if (config.conversationDumpDir && conversationSnapshot) {
		await writeConversationDump({
			dumpDir: config.conversationDumpDir,
			taskId: task.id,
			runIndex,
			snapshot: conversationSnapshot,
		});
	}

	return {
		runIndex,
		success,
		patchApplied,
		verificationPassed,
		seed: metadata?.seed,
		mutationType: metadata?.mutationType,
		mutationCategory: metadata?.mutationCategory,
		difficultyScore: metadata?.difficultyScore,
		error,
		tokens,
		duration,
		indentScore,
		formattedEquivalent,
		diffStats,
		agentResponse,
		diff,
		toolCalls: toolStats,
		editFailures,
		editWarnings,
		editAutocorrectCount,
		hashlineEditSubtypes: config.editVariant === "hashline" ? hashlineSubtypes : undefined,
		mutationIntentMatched: mutationIntentValidation?.matched,
		mutationIntentReason: mutationIntentValidation?.reason,
		timeoutTelemetry,
		earlyStopped: earlyStoppedByMatch || undefined,
		retryStats: {
			timeoutRetries: timeoutRetriesUsed,
			zeroToolRetries,
			providerFailureRetries,
		},
	};
}

function extractToolText(result: unknown): string | null {
	if (typeof result === "string") return result;
	if (!result || typeof result !== "object") return null;
	const content = (result as { content?: unknown }).content;
	if (!Array.isArray(content)) return null;
	for (const entry of content) {
		if (!entry || typeof entry !== "object") continue;
		if (!("text" in entry)) continue;
		const text = (entry as { text?: unknown }).text;
		if (typeof text === "string") return text;
	}
	return null;
}

function extractHashlineWarnings(result: unknown): string[] {
	const text = extractToolText(result);
	if (!text) return [];
	const marker = "Warnings:\n";
	const markerIndex = text.indexOf(marker);
	if (markerIndex === -1) return [];
	return text
		.slice(markerIndex + marker.length)
		.split("\n")
		.map(line => line.trim())
		.filter(Boolean);
}

function hasHashlineAutocorrectWarning(warnings: string[]): boolean {
	return warnings.some(warning => warning.startsWith("Auto-corrected "));
}

function extractToolErrorMessage(result: unknown): string {
	const text = extractToolText(result);
	if (text) return text;
	try {
		return JSON.stringify(result);
	} catch {
		return "Unknown error";
	}
}

function extractAssistantToolRawBlocks(event: {
	type: string;
	[key: string]: unknown;
}): Array<{ id: string; rawBlock: string }> {
	const message = event.message;
	if (message === null || typeof message !== "object") return [];
	const role = (message as { role?: unknown }).role;
	if (role !== "assistant") return [];
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) return [];
	const rawBlocks: Array<{ id: string; rawBlock: string }> = [];
	for (const block of content) {
		if (block === null || typeof block !== "object") continue;
		const typedBlock = block as { type?: unknown; id?: unknown; rawBlock?: unknown };
		if (typedBlock.type !== "toolCall") continue;
		if (typeof typedBlock.id !== "string" || typeof typedBlock.rawBlock !== "string") continue;
		rawBlocks.push({ id: typedBlock.id, rawBlock: typedBlock.rawBlock });
	}
	return rawBlocks;
}

function shuffle<T>(items: T[]): T[] {
	const copy = items.slice();
	for (let i = copy.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[copy[i], copy[j]] = [copy[j]!, copy[i]!];
	}
	return copy;
}

async function collectPromptEvents(
	client: BenchmarkClient,
	delivery: BenchmarkPromptDelivery,
	config: BenchmarkConfig,
	logEvent: (event: unknown) => Promise<void>,
	earlyStop?: {
		check: () => Promise<boolean>;
		onMatch: () => void | Promise<void>;
	},
): Promise<Array<{ type: string; [key: string]: unknown }>> {
	const events: Array<{ type: string; [key: string]: unknown }> = [];
	let unsubscribe: (() => void) | undefined;
	const startedAt = Date.now();
	let pendingRetry = false;
	let toolExecutionStarts = 0;
	let toolExecutionEnds = 0;
	let messageEnds = 0;
	let lastEventType: string | undefined;
	const recentEventTypes: string[] = [];
	let observedTurns = 0;
	let timer: NodeJS.Timeout | undefined;
	let settled = false;
	let receivedFirstEvent = false;
	let earlyStopTriggered = false;
	let earlyStopChain: Promise<void> = Promise.resolve();

	const connectionTimeout = config.connectionTimeout ?? 30_000;

	const eventsPromise = new Promise<void>((resolve, reject) => {
		const resolveWait = () => {
			if (settled) {
				return;
			}
			settled = true;
			if (timer) {
				clearTimeout(timer);
			}
			unsubscribe?.();
			resolve();
		};

		const rejectWait = (err: Error) => {
			if (settled) {
				return;
			}
			settled = true;
			if (timer) {
				clearTimeout(timer);
			}
			unsubscribe?.();
			reject(err);
		};

		const fireTimeout = () => {
			client.abort?.();
			rejectWait(
				new PromptTimeoutError({
					elapsedMs: Date.now() - startedAt,
					eventCount: events.length,
					toolExecutionStarts,
					toolExecutionEnds,
					messageEnds,
					lastEventType,
					recentEventTypes: [...recentEventTypes],
					pendingRetry,
				}),
			);
		};

		const triggerEarlyStop = () => {
			if (!earlyStop || earlyStopTriggered || settled) return;
			earlyStopChain = earlyStopChain
				.then(async () => {
					if (earlyStopTriggered || settled) return;
					let matched = false;
					try {
						matched = await earlyStop.check();
					} catch {
						return;
					}
					if (!matched || earlyStopTriggered || settled) return;
					earlyStopTriggered = true;
					try {
						await earlyStop.onMatch();
					} catch {
						
					}
					client.abort?.();
					resolveWait();
				})
				.catch(() => {});
		};

		
		timer = setTimeout(fireTimeout, connectionTimeout);

		unsubscribe = client.onEvent(event => {
			if (!event || settled) {
				return;
			}
			const typedEvent = event as { type: string; [key: string]: unknown };

			
			if (!receivedFirstEvent) {
				receivedFirstEvent = true;
				if (timer) {
					clearTimeout(timer);
				}
				timer = setTimeout(fireTimeout, config.timeout);
			}

			events.push(typedEvent);
			lastEventType = typedEvent.type;
			recentEventTypes.push(typedEvent.type);
			if (recentEventTypes.length > 8) {
				recentEventTypes.shift();
			}
			if (typedEvent.type === "tool_execution_start") {
				toolExecutionStarts += 1;
			}
			if (typedEvent.type === "tool_execution_end") {
				toolExecutionEnds += 1;
			}
			if (
				typedEvent.type === "tool_execution_end" &&
				!(typedEvent as { isError?: boolean }).isError &&
				isMutationTool((typedEvent as { toolName?: unknown }).toolName)
			) {
				triggerEarlyStop();
			}
			if (typedEvent.type === "message_end") {
				messageEnds += 1;
			}

			if (
				typedEvent.type === "tool_execution_start" ||
				typedEvent.type === "tool_execution_end" ||
				typedEvent.type === "message_end"
			) {
				logEvent(typedEvent).catch(() => {});
			}
			if (typedEvent.type === "turn_start") {
				observedTurns += 1;
				if (typeof config.maxTurns === "number" && observedTurns > config.maxTurns) {
					client.abort?.();
					rejectWait(
						new PromptTurnLimitError({
							elapsedMs: Date.now() - startedAt,
							observedTurns,
							maxTurns: config.maxTurns,
							pendingRetry,
							lastEventType,
							recentEventTypes: [...recentEventTypes],
						}),
					);
					return;
				}
				if (pendingRetry) {
					pendingRetry = false;
				}
			} else if (typedEvent.type === "auto_retry_start") {
				pendingRetry = true;
			}
			if (typedEvent.type === "agent_end") {
				if (pendingRetry) {
					return;
				}
				resolveWait();
			}
		});
	});

	eventsPromise.catch(() => {});

	try {
		if (delivery.kind === "followUp") {
			await client.followUp(delivery.message);
		} else {
			await client.prompt(delivery.message);
		}
	} catch (err) {
		if (earlyStopTriggered) {
			if (timer) {
				clearTimeout(timer);
			}
			unsubscribe?.();
			return events;
		}
		if (timer) {
			clearTimeout(timer);
		}
		unsubscribe?.();
		throw err;
	}
	await eventsPromise;
	return events;
}

function diffTokenStats(before: SessionTokenStats, after: SessionTokenStats, systemPromptTokens: number): TokenStats {
	const calls = Math.max(0, after.assistantMessages - before.assistantMessages);
	const overhead = calls * systemPromptTokens;
	const beforePrompt = before.tokens.input + before.tokens.cacheRead + before.tokens.cacheWrite;
	const afterPrompt = after.tokens.input + after.tokens.cacheRead + after.tokens.cacheWrite;
	const input = Math.max(0, afterPrompt - beforePrompt - overhead);
	const output = Math.max(0, after.tokens.output - before.tokens.output);
	const reasoning = Math.max(0, after.tokens.reasoning - before.tokens.reasoning);
	const total = input + output;
	return { input, output, reasoning, total };
}

type SessionTokenStats = {
	tokens: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number };
	assistantMessages: number;
};

function isTransportFailure(r: TaskRunResult): boolean {
	if (r.success) return false;
	const err = r.error ?? "";
	return err.includes("Timeout exhausted");
}

function isGhostRun(r: TaskRunResult): boolean {
	if (r.success) return false;
	const noProgress =
		r.tokens.total === 0 && r.toolCalls.read === 0 && r.toolCalls.edit === 0 && r.toolCalls.write === 0;
	return noProgress || isTransportFailure(r);
}

const EMPTY_TOOL_CALL_STATS: ToolCallStats = {
	read: 0,
	edit: 0,
	write: 0,
	editSuccesses: 0,
	editFailures: 0,
	editWarnings: 0,
	editAutocorrects: 0,
	totalInputChars: 0,
};

function isBetterRun(a: TaskRunResult, b: TaskRunResult): boolean {
	if (a.success !== b.success) return a.success;
	const aGhost = isGhostRun(a);
	const bGhost = isGhostRun(b);
	if (aGhost !== bGhost) return !aGhost;
	if (a.tokens.total !== b.tokens.total) return a.tokens.total < b.tokens.total;
	return a.runIndex < b.runIndex;
}

function pickBestRunIndex(orderedRuns: TaskRunResult[]): number {
	if (orderedRuns.length === 0) return -1;
	let bestIdx = 0;
	for (let i = 1; i < orderedRuns.length; i++) {
		if (isBetterRun(orderedRuns[i]!, orderedRuns[bestIdx]!)) bestIdx = i;
	}
	return bestIdx;
}

function summarizeTaskRuns(task: EditTask, runs: TaskRunResult[]): TaskResult {
	const orderedRuns = runs.slice().sort((a, b) => a.runIndex - b.runIndex);
	const nonGhostRuns = orderedRuns.filter(r => !isGhostRun(r));
	const successfulNonGhost = nonGhostRuns.filter(r => r.success).length;
	const flakeSuccessRate = nonGhostRuns.length > 0 ? successfulNonGhost / nonGhostRuns.length : 0;
	const bestIdx = pickBestRunIndex(orderedRuns);
	const best = bestIdx === -1 ? undefined : orderedRuns[bestIdx]!;

	const tokens: TokenStats = best ? { ...best.tokens } : { input: 0, output: 0, reasoning: 0, total: 0 };
	const duration = best?.duration ?? 0;
	const indentScore = typeof best?.indentScore === "number" ? best.indentScore : 0;
	const toolCalls: ToolCallStats = best ? { ...best.toolCalls } : { ...EMPTY_TOOL_CALL_STATS };
	const editSuccessRate = toolCalls.edit > 0 ? toolCalls.editSuccesses / toolCalls.edit : 1;
	const autocorrectFreeSuccess = Boolean(best?.success) && (best?.editAutocorrectCount ?? 0) === 0;

	return {
		id: task.id,
		name: task.name,
		files: task.files,
		runs: orderedRuns,
		bestRunIndex: best?.runIndex ?? -1,
		success: Boolean(best?.success),
		tokens,
		duration,
		indentScore,
		toolCalls,
		editSuccessRate,
		autocorrectFreeSuccess,
		flakeSuccessRate,
	};
}

function buildFailureResult(item: TaskRunItem, error: string): TaskRunResult {
	return {
		runIndex: item.runIndex,
		success: false,
		patchApplied: false,
		verificationPassed: false,
		error,
		tokens: { input: 0, output: 0, reasoning: 0, total: 0 },
		duration: 0,
		toolCalls: {
			read: 0,
			edit: 0,
			write: 0,
			editSuccesses: 0,
			editFailures: 0,
			editWarnings: 0,
			editAutocorrects: 0,
			totalInputChars: 0,
		},
		editFailures: [],
		editWarnings: [],
		editAutocorrectCount: 0,
	};
}

async function runConcurrentBenchmarkRun(
	item: TaskRunItem,
	config: BenchmarkConfig,
	onProgress?: (event: ProgressEvent) => void,
	shared?: SharedInfra,
): Promise<{ task: EditTask; result: TaskRunResult }> {
	const workDir = subtmp(item.task.id);

	try {
		await copyFixtures(item.task, workDir);
		onProgress?.({ taskId: item.task.id, runIndex: item.runIndex, status: "started" });
		const result = await runSingleTask(item.task, item.runIndex, config, workDir, item.task.expectedDir, shared);
		onProgress?.({ taskId: item.task.id, runIndex: item.runIndex, status: "completed", result });
		return { task: item.task, result };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		const result = buildFailureResult(item, message);
		onProgress?.({ taskId: item.task.id, runIndex: item.runIndex, status: "completed", result });
		return { task: item.task, result };
	}
}

export function percentile(sortedAscending: readonly number[], p: number): number {
	const n = sortedAscending.length;
	if (n === 0) return 0;
	if (n === 1) return sortedAscending[0]!;
	const rank = (p / 100) * (n - 1);
	const lo = Math.floor(rank);
	const loVal = sortedAscending[lo]!;
	const hi = Math.ceil(rank);
	if (lo === hi) return loVal;
	return loVal + (sortedAscending[hi]! - loVal) * (rank - lo);
}

export interface TokenDistribution {
	median: TokenStats;
	p1: TokenStats;
	p99: TokenStats;
}

export function summarizeTokenDistribution(runs: readonly TaskRunResult[]): TokenDistribution {
	const input = runs.map(r => r.tokens.input).sort((a, b) => a - b);
	const output = runs.map(r => r.tokens.output).sort((a, b) => a - b);
	const reasoning = runs.map(r => r.tokens.reasoning).sort((a, b) => a - b);
	const total = runs.map(r => r.tokens.total).sort((a, b) => a - b);
	const at = (p: number): TokenStats => ({
		input: Math.round(percentile(input, p)),
		output: Math.round(percentile(output, p)),
		reasoning: Math.round(percentile(reasoning, p)),
		total: Math.round(percentile(total, p)),
	});
	return { median: at(50), p1: at(1), p99: at(99) };
}

export function buildBenchmarkResult(params: {
	tasks: EditTask[];
	config: BenchmarkConfig;
	resultsByTask: Map<string, TaskRunResult[]>;
	startTime: string;
	endTime?: string;
}): BenchmarkResult {
	const taskResults = params.tasks.map(task => summarizeTaskRuns(task, params.resultsByTask.get(task.id) ?? []));

	const endTime = params.endTime ?? new Date().toISOString();

	
	const allRuns = taskResults.flatMap(t => t.runs);
	const ghostRuns = allRuns.filter(r => isGhostRun(r)).length;
	const transportFailureRuns = allRuns.filter(r => isTransportFailure(r)).length;
	const nonGhostRuns = allRuns.filter(r => !isGhostRun(r));
	const totalRuns = nonGhostRuns.length;
	const successfulRuns = allRuns.filter(r => r.success).length;
	const timeoutRuns = nonGhostRuns.filter(
		r => r.error?.includes("Timeout") || r.error?.includes("Timeout exhausted"),
	).length;
	const totalTimeoutRetries = nonGhostRuns.reduce((sum, r) => sum + (r.retryStats?.timeoutRetries ?? 0), 0);
	const totalZeroToolRetries = nonGhostRuns.reduce((sum, r) => sum + (r.retryStats?.zeroToolRetries ?? 0), 0);
	const totalProviderFailureRetries = nonGhostRuns.reduce(
		(sum, r) => sum + (r.retryStats?.providerFailureRetries ?? 0),
		0,
	);
	const editFailureCategories = countEditFailureCategories(nonGhostRuns);
	const hashlineEditSubtypes: Record<string, number> | undefined =
		params.config.editVariant === "hashline"
			? Object.fromEntries(
					HL_SUBTYPES.map(key => [key, allRuns.reduce((sum, r) => sum + (r.hashlineEditSubtypes?.[key] ?? 0), 0)]),
				)
			: undefined;

	
	const bestRuns: TaskRunResult[] = [];
	for (const task of taskResults) {
		if (task.bestRunIndex < 0) continue;
		const best = task.runs.find(r => r.runIndex === task.bestRunIndex);
		if (best) bestRuns.push(best);
	}
	const tasksWithBestRun = bestRuns.length;
	const totalTasks = params.tasks.length;
	const denom = totalTasks || 1;

	const successfulTasks = taskResults.filter(t => t.success).length;
	const consistentlyPassingTasks = taskResults.filter(
		t => t.success && t.runs.filter(r => !isGhostRun(r)).every(r => r.success),
	).length;
	const flakyTasks = taskResults.filter(
		t => t.success && t.runs.filter(r => !isGhostRun(r)).some(r => !r.success),
	).length;

	const totalTokens: TokenStats = {
		input: bestRuns.reduce((sum, r) => sum + r.tokens.input, 0),
		output: bestRuns.reduce((sum, r) => sum + r.tokens.output, 0),
		reasoning: bestRuns.reduce((sum, r) => sum + r.tokens.reasoning, 0),
		total: bestRuns.reduce((sum, r) => sum + r.tokens.total, 0),
	};
	const tokenDistribution = summarizeTokenDistribution(bestRuns);
	const totalDuration = bestRuns.reduce((sum, r) => sum + r.duration, 0);
	const totalToolCalls: ToolCallStats = {
		read: bestRuns.reduce((sum, r) => sum + r.toolCalls.read, 0),
		edit: bestRuns.reduce((sum, r) => sum + r.toolCalls.edit, 0),
		write: bestRuns.reduce((sum, r) => sum + r.toolCalls.write, 0),
		editSuccesses: bestRuns.reduce((sum, r) => sum + r.toolCalls.editSuccesses, 0),
		editFailures: bestRuns.reduce((sum, r) => sum + r.toolCalls.editFailures, 0),
		editWarnings: bestRuns.reduce((sum, r) => sum + r.toolCalls.editWarnings, 0),
		editAutocorrects: bestRuns.reduce((sum, r) => sum + r.toolCalls.editAutocorrects, 0),
		totalInputChars: bestRuns.reduce((sum, r) => sum + r.toolCalls.totalInputChars, 0),
	};
	const bestIndentScores = bestRuns
		.map(r => r.indentScore)
		.filter((score): score is number => typeof score === "number");
	const avgIndentScore =
		bestIndentScores.length > 0 ? bestIndentScores.reduce((sum, s) => sum + s, 0) / bestIndentScores.length : 0;

	const editSuccessRate = totalToolCalls.edit > 0 ? totalToolCalls.editSuccesses / totalToolCalls.edit : 1;
	const autocorrectFreeSuccessfulTasks = bestRuns.filter(r => r.success && r.editAutocorrectCount === 0).length;
	const autocorrectedBestRuns = bestRuns.filter(r => r.editAutocorrectCount > 0).length;
	const editAutocorrectRate =
		totalToolCalls.editSuccesses > 0 ? totalToolCalls.editAutocorrects / totalToolCalls.editSuccesses : 0;
	const bestWithMutationIntent = bestRuns.filter(r => typeof r.mutationIntentMatched === "boolean");
	const mutationIntentMatchRate =
		bestWithMutationIntent.length > 0
			? bestWithMutationIntent.filter(r => r.mutationIntentMatched).length / bestWithMutationIntent.length
			: undefined;

	const oneShotSuccessRuns = taskResults
		.map(t => t.runs.find(r => r.runIndex === 0))
		.filter((r): r is TaskRunResult => Boolean(r?.success));
	const successfulOneShotTasks = oneShotSuccessRuns.length;
	const oneShotDenom = successfulOneShotTasks || 1;

	const totalOneShotSuccessTokens: TokenStats = {
		input: oneShotSuccessRuns.reduce((sum, r) => sum + r.tokens.input, 0),
		output: oneShotSuccessRuns.reduce((sum, r) => sum + r.tokens.output, 0),
		reasoning: oneShotSuccessRuns.reduce((sum, r) => sum + r.tokens.reasoning, 0),
		total: oneShotSuccessRuns.reduce((sum, r) => sum + r.tokens.total, 0),
	};
	const oneShotTokenDistribution = summarizeTokenDistribution(oneShotSuccessRuns);

	const taskDenom = tasksWithBestRun || 1;
	const summary: BenchmarkSummary = {
		successfulOneShotTasks,
		totalOneShotSuccessTokens,
		avgOneShotSuccessTokensPerTask: {
			input: Math.round(totalOneShotSuccessTokens.input / oneShotDenom),
			output: Math.round(totalOneShotSuccessTokens.output / oneShotDenom),
			reasoning: Math.round(totalOneShotSuccessTokens.reasoning / oneShotDenom),
			total: Math.round(totalOneShotSuccessTokens.total / oneShotDenom),
		},
		medianOneShotSuccessTokensPerTask: oneShotTokenDistribution.median,
		p1OneShotSuccessTokensPerTask: oneShotTokenDistribution.p1,
		p99OneShotSuccessTokensPerTask: oneShotTokenDistribution.p99,
		totalTasks,
		totalRuns,
		successfulRuns,
		successfulTasks,
		taskSuccessRate: successfulTasks / denom,
		flakyTasks,
		consistentlyPassingTasks,
		totalTokens,
		avgTokensPerTask: {
			input: Math.round(totalTokens.input / taskDenom),
			output: Math.round(totalTokens.output / taskDenom),
			reasoning: Math.round(totalTokens.reasoning / taskDenom),
			total: Math.round(totalTokens.total / taskDenom),
		},
		medianTokensPerTask: tokenDistribution.median,
		p1TokensPerTask: tokenDistribution.p1,
		p99TokensPerTask: tokenDistribution.p99,
		totalDuration,
		avgDurationPerTask: Math.round(totalDuration / taskDenom),
		avgIndentScore,
		totalToolCalls,
		avgToolCallsPerTask: {
			read: totalToolCalls.read / taskDenom,
			edit: totalToolCalls.edit / taskDenom,
			write: totalToolCalls.write / taskDenom,
			editSuccesses: totalToolCalls.editSuccesses / taskDenom,
			editFailures: totalToolCalls.editFailures / taskDenom,
			editWarnings: totalToolCalls.editWarnings / taskDenom,
			editAutocorrects: totalToolCalls.editAutocorrects / taskDenom,
			totalInputChars: totalToolCalls.totalInputChars / taskDenom,
		},
		editSuccessRate,
		autocorrectFreeSuccessfulTasks,
		autocorrectFreeSuccessRate: autocorrectFreeSuccessfulTasks / denom,
		autocorrectedBestRuns,
		editAutocorrectRate,
		timeoutRuns,
		totalTimeoutRetries,
		totalZeroToolRetries,
		totalProviderFailureRetries,
		ghostRuns,
		transportFailureRuns,
		mutationIntentMatchRate,
		editFailureCategories,
		hashlineEditSubtypes,
	};

	return {
		config: params.config,
		tasks: taskResults,
		summary,
		startTime: params.startTime,
		endTime,
	};
}

export async function runBenchmark(
	tasks: EditTask[],
	config: BenchmarkConfig,
	onProgress?: (event: ProgressEvent) => void,
	onResultSnapshot?: (result: BenchmarkResult) => void,
): Promise<BenchmarkResult> {
	const startTime = new Date().toISOString();

	
	const useInProcess = config.inProcess !== false;
	const shared = useInProcess
		? await discoverSharedInfra({
				editVariant: config.editVariant,
				editFuzzy: config.editFuzzy,
				editFuzzyThreshold: config.editFuzzyThreshold,
			})
		: undefined;

	try {
		const runsPerTask = Math.max(1, Math.floor(config.runsPerTask));
		const taskQueue = shuffle(tasks.slice());
		const resultsByTask = new Map<string, TaskRunResult[]>();
		const concurrency = Math.max(1, Math.floor(config.taskConcurrency));

		const recordResult = (task: EditTask, result: TaskRunResult) => {
			const list = resultsByTask.get(task.id) ?? [];
			list.push(result);
			resultsByTask.set(task.id, list);
			onResultSnapshot?.(buildBenchmarkResult({ tasks, config, resultsByTask, startTime }));
		};

		const runTaskAllRuns = async (task: EditTask): Promise<void> => {
			const items: TaskRunItem[] = Array.from({ length: runsPerTask }, (_, runIndex) => ({ task, runIndex }));
			await Promise.all(
				items.map(async item => {
					const { result } = await runConcurrentBenchmarkRun(item, config, onProgress, shared);
					recordResult(task, result);
				}),
			);
		};

		const worker = async (): Promise<void> => {
			while (true) {
				const task = taskQueue.shift();
				if (!task) return;
				await runTaskAllRuns(task);
			}
		};

		const slots = Math.min(concurrency, taskQueue.length);
		const running: Promise<void>[] = [];
		for (let i = 0; i < slots; i++) {
			running.push(worker());
		}

		await Promise.all(running);

		return buildBenchmarkResult({ tasks, config, resultsByTask, startTime });
	} finally {
		shared?.authStorage.close();
	}
}
