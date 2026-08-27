/**
 * Transport execution and attempt lifecycle for a single benchmark task run.
 *
 * Coordinates client interaction, event stream collection, timeout enforcement,
 * turn limits, verification checks, and per-child process environment isolation.
 *
 * Child process environment variables (VEYYON_STRICT_EDIT_MODE, VEYYON_NO_TITLE,
 * and variant settings) are passed explicitly to the spawned RPC client to isolate
 * execution without mutating parent process.env.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { RpcClient } from "@veyyon/coding-agent";
import { errorMessage, estimateTokensFromText, isRecord } from "@veyyon/utils";
import { InProcessClient, type SharedInfra } from "../../../../backends/in-process/client";
import { teardownWithin } from "../../../../core/trial-deadline";
import { repoRootDir, runsDir } from "../../../../paths";
import { formatDirectory } from "../../formatter";
import type { EditTask } from "../../tasks";
import { verifyExpectedFiles } from "../../verify";
import { buildEarlyStop } from "./early-stop";
import { collectPromptEvents } from "./events";
import {
	appendNoChangeMutationHint,
	buildGuidedContext,
	collectOriginalFileContents,
	evaluateMutationIntent,
} from "./guided";
import {
	buildBenchmarkPromptDelivery,
	buildBenchmarkSystemPrompt,
	prepareBenchmarkSessionSetup,
} from "./prompt-delivery";
import {
	buildProviderFailureRetryContext,
	buildTimeoutRetryContext,
	categorizeEditFailure,
	countHashlineEditSubtypes,
	detectProviderFailure,
	getProviderFailureRetryDelayMs,
} from "./retry";
import { diffTokenStats } from "./stats";
import {
	extractAssistantToolRawBlocks,
	extractHashlineWarnings,
	extractToolErrorMessage,
	formatLogPath,
	hasHashlineAutocorrectWarning,
	isEditTool,
	isMutationTool,
	PromptTimeoutError,
	PromptTurnLimitError,
	snapshotConversationDump,
	writeConversationDump,
} from "./telemetry";
import {
	BENCHMARK_TOOL_NAMES,
	type BenchmarkClient,
	type BenchmarkConfig,
	type ConversationDumpSnapshot,
	type EditFailure,
	HL_SUBTYPES,
	type MutationIntentValidation,
	type PendingEditCall,
	type PromptAttemptTelemetry,
	type TaskRunResult,
	type TokenStats,
} from "./types";

const CLI_PATH = Bun.fileURLToPath(import.meta.resolve("@veyyon/coding-agent/cli"));
const REPO_ROOT = repoRootDir();

export function createBenchmarkClient(params: {
	config: BenchmarkConfig;
	cwd: string;
	sessionSetup: { rpcArgs: string[] };
	shared?: SharedInfra;
}): BenchmarkClient {
	const useInProcess = params.config.inProcess !== false;
	if (useInProcess) {
		return new InProcessClient({
			cwd: params.cwd,
			model: params.config.model,
			appendSystemPrompt: buildBenchmarkSystemPrompt({ multiFile: false, config: params.config }),
			tools: [...BENCHMARK_TOOL_NAMES],
			editVariant: params.config.editVariant,
			editFuzzy: params.config.editFuzzy,
			editFuzzyThreshold: params.config.editFuzzyThreshold,
			shared: params.shared,
		});
	}

	const childEnv: Record<string, string> = {
		...(process.env as Record<string, string>),
		VEYYON_STRICT_EDIT_MODE: "1",
		VEYYON_NO_TITLE: "1",
	};
	if (params.config.editVariant !== undefined) {
		childEnv.VEYYON_EDIT_VARIANT = params.config.editVariant;
	}
	if (params.config.editFuzzy !== undefined) {
		childEnv.VEYYON_EDIT_FUZZY = params.config.editFuzzy === "auto" ? "auto" : params.config.editFuzzy ? "1" : "0";
	}
	if (params.config.editFuzzyThreshold !== undefined) {
		childEnv.VEYYON_EDIT_FUZZY_THRESHOLD =
			params.config.editFuzzyThreshold === "auto" ? "auto" : String(params.config.editFuzzyThreshold);
	}

	const rpc = new RpcClient({
		cliPath: CLI_PATH,
		cwd: params.cwd,
		provider: params.config.provider,
		model: params.config.model,
		args: params.sessionSetup.rpcArgs,
		env: childEnv,
	});
	return Object.assign(rpc, {
		dispose: async () => rpc[Symbol.dispose](),
	}) as unknown as BenchmarkClient;
}

export async function runSingleTask(
	task: EditTask,
	runIndex: number,
	config: BenchmarkConfig,
	cwd: string,
	expectedDir: string,
	shared?: SharedInfra,
	tempRoot?: string,
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

	const runsDirectory = tempRoot ?? path.join(runsDir(), `rb-${Math.random().toString(36).slice(2, 10)}`);
	await fs.mkdir(runsDirectory, { recursive: true });
	const logFile = path.join(runsDirectory, `run-${task.id}-${runIndex}.jsonl`);
	const logEvent = async (event: unknown) => {
		await fs.appendFile(logFile, `${JSON.stringify(event)}\n`);
	};
	const originalFiles = await collectOriginalFileContents(cwd, task.files);
	let timeoutRetriesUsed = 0;
	let zeroToolRetries = 0;
	let providerFailureRetries = 0;

	try {
		const sessionSetup = await prepareBenchmarkSessionSetup({
			config,
			task,
			cwd,
			expectedDir,
			multiFile: false,
		});
		await fs.appendFile(
			logFile,
			`{"type":"meta","task":"${task.id}","run":${runIndex},"workDir":"${cwd}","providerSessionId":${JSON.stringify(sessionSetup.providerSessionId)}}\n`,
		);

		const client = createBenchmarkClient({ config, cwd, sessionSetup, shared });

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

				await fs.appendFile(
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
						event.type === "tool_execution_start" && isMutationTool(isRecord(event) ? event.toolName : undefined),
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
						const toolName = typeof event.toolName === "string" ? event.toolName : undefined;
						const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
						if (toolName === "read") {
							toolStats.read++;
						} else if (isEditTool(toolName)) {
							toolStats.edit++;
							if (toolCallId) {
								pendingEdits.set(toolCallId, { args: event.args, rawBlock: rawToolBlocks.get(toolCallId) });
							}
						} else if (toolName === "write") {
							toolStats.write++;
						}

						if (event.args) {
							toolStats.totalInputChars += JSON.stringify(event.args).length;
						}
					} else if (event.type === "tool_execution_end") {
						const toolName = typeof event.toolName === "string" ? event.toolName : undefined;
						const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
						if (isEditTool(toolName) && toolCallId && pendingEdits.has(toolCallId)) {
							const pendingEdit = pendingEdits.get(toolCallId) ?? { args: null };
							const args = pendingEdit.args;
							pendingEdits.delete(toolCallId);
							if (config.editVariant === "hashline" && args) {
								const counts = countHashlineEditSubtypes(args);
								for (const key of HL_SUBTYPES) {
									hashlineSubtypes[key] += counts[key];
								}
							}
							if (event.isError) {
								toolStats.editFailures++;
								const toolError = await appendNoChangeMutationHint(
									extractToolErrorMessage(event.result),
									args,
									cwd,
									originalFiles,
								);
								editFailures.push({
									toolCallId,
									args,
									error: toolError,
									rawBlock: pendingEdit.rawBlock,
									category: categorizeEditFailure(toolError, args),
								});
							} else {
								toolStats.editSuccesses++;
								if (toolName === "edit") {
									const warningMessages = extractHashlineWarnings(event.result);
									if (warningMessages.length > 0) {
										editWarnings.push(...warningMessages);
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

				// Retry if the model didn't attempt any edit/write (read-only or no tool calls)
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
			// Bounded, and reported rather than thrown: a teardown that hangs would hold this
			// process past its trial's deadline, and one that throws would replace the
			// verification result this trial already earned.
			const teardownReason = await teardownWithin(() => client.dispose());
			if (teardownReason) {
				await logEvent({ type: "teardown_abandoned", reason: teardownReason });
			}
		}
	} catch (err) {
		error = errorMessage(err);
		await logEvent({ type: "error", error });
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
	console.log(`  Log: ${formatLogPath(logFile, REPO_ROOT)}`);

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
