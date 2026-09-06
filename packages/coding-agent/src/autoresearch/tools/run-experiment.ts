import * as fs from "node:fs";
import * as path from "node:path";
import { errorMessage, formatBytes } from "@veyyon/utils";
import { replaceTabs } from "@veyyon/utils/wrap";
import type { ViewSpan } from "@veyyon/view";
import { type } from "arktype";
import { executeBash } from "../../exec/bash-executor";
import type { ToolDefinition } from "../../extensibility/extensions";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, TailBuffer, truncateTail } from "../../session/streaming-output";
// `shortenPath` is defined here and nowhere else: it collapses the real home directory, which the
// browser-side owner in `@veyyon/tool-render` cannot do. The module binds no runtime value from
// `@veyyon/tui`, so taking a string helper from it leaves this tool host-agnostic.
import { shortenPath } from "../../tools/core/render-utils";
import * as git from "../../utils/git";
import { parseWorkDirDirtyPaths } from "../git";
import {
	EXPERIMENT_MAX_BYTES,
	EXPERIMENT_MAX_LINES,
	formatElapsed,
	formatNum,
	gitStatusPorcelain,
	gitWorkDirPrefix,
	parseAsiLines,
	parseMetricLines,
} from "../helpers";
import { buildExperimentState } from "../state";
import { openAutoresearchStorageIfExists } from "../storage";
import type {
	AutoresearchToolFactoryOptions,
	RunDetails,
	RunExperimentProgressDetails,
	RunningExperiment,
} from "../types";
import { DEFAULT_HARNESS_COMMAND } from "./init-experiment";

const runExperimentSchema = type({
	"timeout_seconds?": type("number").describe("timeout in seconds (default 600)"),
	"arm?": type("string").describe("candidate arm this measurement belongs to, when breadth > 1"),
});

interface ProcessExecutionResult {
	exitCode: number | null;
	killed: boolean;
	logPath: string;
	output: string;
}

interface ProgressSnapshot {
	elapsed: string;
	runDirectory: string;
	fullOutputPath: string;
	tailOutput: string;
	truncation?: RunExperimentProgressDetails["truncation"];
}

export function createRunExperimentTool(
	options: AutoresearchToolFactoryOptions,
): ToolDefinition<typeof runExperimentSchema, RunDetails | RunExperimentProgressDetails> {
	return {
		name: "run_experiment",
		label: "Run Experiment",
		description:
			"Run any benchmark command. Output is captured automatically; `METRIC name=value` and `ASI key=value` lines printed by the command are parsed.",
		parameters: runExperimentSchema,
		defaultInactive: true,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const storage = await openAutoresearchStorageIfExists(ctx.cwd);
			const currentBranch = (await git.branch.current(ctx.cwd)) ?? null;
			const session = storage?.getActiveSessionForBranch(currentBranch) ?? null;
			if (!storage || !session) {
				return {
					content: [
						{
							type: "text",
							text: "Error: no active autoresearch session for the current branch. Call init_experiment first.",
						},
					],
				};
			}

			const runtime = options.getRuntime(ctx);

			const abandonedPriorRun = (() => {
				const pending = storage.getPendingRun(session.id);
				if (!pending) return null;
				storage.abandonIncompleteRuns(session.id);
				return pending.id;
			})();

			const resolvedCommand = DEFAULT_HARNESS_COMMAND;
			// The pre-run dirty set is what tells the difference between the user's own uncommitted work and
			// what this experiment changes, and it is recorded on the run for the log and the revert to use
			// later. An unreadable status used to become an EMPTY set, which claims the tree was clean: every
			// pre-existing dirty file would then be attributed to the experiment and reverted with it.
			let preRunDirtyPaths: string[];
			try {
				const preRunStatus = await gitStatusPorcelain(ctx.cwd);
				const workDirPrefix = await gitWorkDirPrefix(ctx.cwd);
				preRunDirtyPaths = parseWorkDirDirtyPaths(preRunStatus, workDirPrefix);
			} catch (err) {
				return {
					content: [
						{
							type: "text",
							text: `Error: git status failed, so no run was started: ${errorMessage(err)}`,
						},
					],
				};
			}

			const startedAt = Date.now();
			// What actually built and measured this arm. `start_arm` has already put
			// the session on the arm's model by now, so the model in force here is
			// the one that wrote the diff being measured. It is recorded on the row
			// rather than at log time, when a certified round has moved on to the
			// last arm's model.
			const currentModel = ctx.models?.current();
			const measuredArm = params.arm?.trim() || undefined;
			const insertedRun = storage.insertRun({
				sessionId: session.id,
				segment: session.currentSegment,
				command: resolvedCommand,
				logPath: "", // patched after we know the run id
				preRunDirtyPaths,
				startedAt,
				arm: measuredArm,
				model: currentModel ? `${currentModel.provider}/${currentModel.id}` : null,
			});

			const runDirectory = path.join(storage.projectDir, "runs", String(insertedRun.id).padStart(4, "0"));
			const benchmarkLogPath = path.join(runDirectory, "benchmark.log");
			fs.mkdirSync(runDirectory, { recursive: true });
			storage.updateRunLogPath(insertedRun.id, benchmarkLogPath);

			runtime.lastRunDuration = null;
			runtime.lastRunAsi = null;
			runtime.lastRunArtifactDir = runDirectory;
			runtime.lastRunNumber = insertedRun.id;
			runtime.lastRunSummary = null;
			const running: RunningExperiment = {
				startedAt,
				command: resolvedCommand,
				runDirectory,
				runNumber: insertedRun.id,
				tail: "",
			};
			runtime.runningExperiment = running;
			options.dashboard.update(ctx, runtime);
			options.dashboard.requestRender();

			const timeoutMs = Math.max(0, Math.floor((params.timeout_seconds ?? 600) * 1000));
			let execution: ProcessExecutionResult;
			try {
				execution = await executeProcess({
					command: resolvedCommand,
					cwd: ctx.cwd,
					logPath: benchmarkLogPath,
					timeoutMs,
					cpuSessionId: ctx.sessionManager.getSessionId(),
					signal,
					onProgress: details => {
						// The screen's clock repaints the pane once a second; this is
						// what it repaints from.
						running.tail = details.tailOutput;
						onUpdate?.({
							content: [{ type: "text", text: details.tailOutput }],
							details: {
								phase: "running",
								elapsed: details.elapsed,
								truncation: details.truncation,
								fullOutputPath: details.fullOutputPath,
								runDirectory: details.runDirectory,
							},
						});
					},
				});
			} finally {
				runtime.runningExperiment = null;
				options.dashboard.update(ctx, runtime);
				options.dashboard.requestRender();
			}

			const completedAt = Date.now();
			const durationMs = completedAt - startedAt;
			const durationSeconds = durationMs / 1000;
			runtime.lastRunDuration = durationSeconds;

			const llmTruncation = truncateTail(execution.output, {
				maxBytes: EXPERIMENT_MAX_BYTES,
				maxLines: EXPERIMENT_MAX_LINES,
			});
			const displayTruncation = truncateTail(execution.output, {
				maxBytes: DEFAULT_MAX_BYTES,
				maxLines: DEFAULT_MAX_LINES,
			});

			const parsedMetricsMap = parseMetricLines(execution.output);
			const parsedMetrics = parsedMetricsMap.size > 0 ? Object.fromEntries(parsedMetricsMap.entries()) : null;
			const parsedPrimary = parsedMetricsMap.get(session.primaryMetric) ?? null;
			const parsedAsi = parseAsiLines(execution.output);
			runtime.lastRunAsi = parsedAsi;

			storage.markRunCompleted({
				runId: insertedRun.id,
				completedAt,
				durationMs,
				exitCode: execution.exitCode,
				timedOut: execution.killed,
				parsedPrimary,
				parsedMetrics,
				parsedAsi,
			});

			const passed = execution.exitCode === 0 && !execution.killed;
			const resultDetails: RunDetails = {
				runNumber: insertedRun.id,
				runDirectory,
				benchmarkLogPath,
				command: resolvedCommand,
				exitCode: execution.exitCode,
				durationSeconds,
				passed,
				crashed: execution.exitCode !== 0 || execution.killed,
				timedOut: execution.killed,
				tailOutput: displayTruncation.content,
				parsedMetrics,
				parsedPrimary,
				parsedAsi,
				metricName: session.primaryMetric,
				metricUnit: session.metricUnit,
				preRunDirtyPaths,
				abandonedPriorRun,
				truncation: llmTruncation.truncated ? llmTruncation : undefined,
				fullOutputPath: execution.logPath,
			};

			runtime.lastRunSummary = {
				runNumber: insertedRun.id,
				runDirectory,
				command: resolvedCommand,
				durationSeconds,
				passed,
				exitCode: execution.exitCode,
				timedOut: execution.killed,
				parsedPrimary,
				parsedMetrics,
				parsedAsi,
				preRunDirtyPaths,
			};

			// Refresh state to reflect any prior abandonment changes (logged set unchanged).
			const refreshedSession = storage.getSessionById(session.id);
			if (refreshedSession) {
				runtime.state = buildExperimentState(refreshedSession, storage.listLoggedRuns(session.id));
			}
			options.dashboard.update(ctx, runtime);
			options.dashboard.requestRender();

			const headerLines: string[] = [];
			if (abandonedPriorRun !== null) {
				headerLines.push(`Note: abandoned prior pending run #${abandonedPriorRun} before starting this run.`);
			}
			// A per-arm model only takes effect through `start_arm`. Measuring an arm
			// that was never started, or measuring one arm while another is in
			// flight, means the diff was written by the wrong model, and the row
			// records which one. Silence here would leave the comparison looking
			// like a contest between models it never ran on.
			if (measuredArm !== undefined && session.armModels.some(spec => spec.length > 0)) {
				const inFlight = runtime.activeArm?.arm;
				const builtOn = currentModel ? `${currentModel.provider}/${currentModel.id}` : "the session model";
				if (inFlight === undefined) {
					headerLines.push(
						`Warning: measured as ${measuredArm} with no arm in flight, so it was built on ${builtOn} rather than the model configured for ${measuredArm}. Call start_arm before the first edit of an arm.`,
					);
				} else if (inFlight !== measuredArm) {
					headerLines.push(
						`Warning: measured as ${measuredArm} while ${inFlight} was in flight, so it was built on ${builtOn}, which is ${inFlight}'s model.`,
					);
				}
			}
			const warningPrefix = headerLines.length > 0 ? `${headerLines.join("\n")}\n\n` : "";

			return {
				content: [
					{
						type: "text",
						text: warningPrefix + buildRunText(resultDetails, llmTruncation.content, runtime.state.bestMetric),
					},
				],
				details: resultDetails,
			};
		},
		view: {
			renderCall: () => ({
				kind: "textBlock",
				spans: [
					{ text: "run_experiment", tone: "title", bold: true },
					{ text: " " },
					{ text: DEFAULT_HARNESS_COMMAND, tone: "muted" },
				],
			}),
			renderResult: (result, context) => {
				const details = result.details;
				if (isProgressDetails(details)) {
					const header = `Running ${details.elapsed}...`;
					const preview = replaceTabs(result.content.find(part => part.type === "text")?.text ?? "");
					const spans: ViewSpan[] = [{ text: header, tone: "warning" }];
					if (preview) {
						spans.push({ text: "\n" }, { text: preview, tone: "dim" });
					}
					return { kind: "textBlock", spans };
				}
				if (!isRunDetails(details)) {
					const text = replaceTabs(result.content.find(part => part.type === "text")?.text ?? "");
					return { kind: "textBlock", spans: [{ text }] };
				}
				const statusText = renderStatusText(details);
				if (!context.expanded && details.tailOutput.trim().length === 0) {
					return { kind: "textBlock", spans: [{ text: statusText, tone: statusTone(details) }] };
				}
				const preview = replaceTabs(
					context.expanded ? details.tailOutput : details.tailOutput.split("\n").slice(-5).join("\n"),
				);
				const spans: ViewSpan[] = [{ text: statusText, tone: statusTone(details) }];
				if (preview) {
					spans.push({ text: "\n" }, { text: preview, tone: "dim" });
				}
				if (preview && context.expanded && details.truncation && details.fullOutputPath) {
					spans.push(
						{ text: "\n" },
						{ text: `Full output: ${shortenPath(details.fullOutputPath)}`, tone: "warning" },
					);
				}
				return { kind: "textBlock", spans };
			},
		},
	};
}

async function executeProcess(opts: {
	command: string;
	cwd: string;
	logPath: string;
	timeoutMs: number;
	/** The owning veyyon session, so experiment compute joins that session's CPU budget. */
	cpuSessionId: string;
	signal?: AbortSignal;
	onProgress?(details: ProgressSnapshot): void;
}): Promise<ProcessExecutionResult> {
	const tailBuffer = new TailBuffer(DEFAULT_MAX_BYTES * 2);

	const startedAt = Date.now();
	const snapshot = (): ProgressSnapshot => {
		const tail = truncateTail(tailBuffer.text(), {
			maxBytes: DEFAULT_MAX_BYTES,
			maxLines: DEFAULT_MAX_LINES,
		});
		return {
			elapsed: formatElapsed(Date.now() - startedAt),
			runDirectory: path.dirname(opts.logPath),
			fullOutputPath: opts.logPath,
			tailOutput: tail.content,
			truncation: tail.truncated ? tail : undefined,
		};
	};

	const progressTimer = opts.onProgress
		? setInterval(() => {
				opts.onProgress?.(snapshot());
			}, 1000)
		: undefined;

	const logSink = Bun.file(opts.logPath).writer();
	let logSinkClosed = false;
	const closeLogSink = async (): Promise<void> => {
		if (logSinkClosed) return;
		logSinkClosed = true;
		await logSink.end();
	};
	try {
		const result = await executeBash(opts.command, {
			cwd: opts.cwd,
			sessionKey: `autoresearch:${opts.cwd}`,
			cpuSessionId: opts.cpuSessionId,
			timeout: opts.timeoutMs > 0 ? opts.timeoutMs : 2_147_000_000,
			signal: opts.signal,
			chunkThrottleMs: 0,
			onChunk: chunk => {
				tailBuffer.append(chunk);
				logSink.write(chunk);
			},
		});
		await closeLogSink();
		if (opts.signal?.aborted) {
			throw new Error("aborted");
		}

		const output = await fs.promises.readFile(opts.logPath, "utf8");

		return {
			exitCode: result.exitCode ?? null,
			killed: result.cancelled,
			logPath: opts.logPath,
			output,
		};
	} finally {
		clearInterval(progressTimer);
		if (!logSinkClosed) {
			try {
				await closeLogSink();
			} catch {
				// Preserve the command failure when cleanup is best-effort.
			}
		}
	}
}
function buildRunText(details: RunDetails, outputPreview: string, bestMetric: number | null): string {
	const lines: string[] = [];
	lines.push(`Run #${details.runNumber} directory: ${details.runDirectory}`);
	if (details.timedOut) {
		lines.push(`TIMEOUT after ${details.durationSeconds.toFixed(1)}s`);
	} else if (details.exitCode !== 0) {
		lines.push(`FAILED with exit code ${details.exitCode} in ${details.durationSeconds.toFixed(1)}s`);
	} else {
		lines.push(`PASSED in ${details.durationSeconds.toFixed(1)}s`);
	}
	if (bestMetric !== null) {
		lines.push(`Current baseline ${details.metricName}: ${formatNum(bestMetric, details.metricUnit)}`);
	}
	if (details.parsedPrimary !== null) {
		lines.push(`Parsed ${details.metricName}: ${details.parsedPrimary}`);
		lines.push(`Next log_experiment metric: ${details.parsedPrimary}`);
	}
	if (details.parsedMetrics) {
		const secondaryEntries = Object.entries(details.parsedMetrics)
			.filter(([name]) => name !== details.metricName)
			.map(([name, value]) => [name, value] as const);
		const secondary = secondaryEntries.map(([name, value]) => `${name}=${value}`);
		if (secondary.length > 0) {
			lines.push(`Parsed metrics: ${secondary.join(", ")}`);
			lines.push(`Next log_experiment metrics: ${JSON.stringify(Object.fromEntries(secondaryEntries))}`);
		}
	}
	if (details.parsedAsi) {
		lines.push(`Parsed ASI keys: ${Object.keys(details.parsedAsi).join(", ")}`);
	}
	lines.push("");
	lines.push(outputPreview);
	if (details.truncation && details.fullOutputPath) {
		lines.push("");
		lines.push(
			`Output truncated (${formatBytes(EXPERIMENT_MAX_BYTES)} limit). Full output: ${details.fullOutputPath}`,
		);
	}
	return lines.join("\n").trimEnd();
}

function renderStatusText(details: RunDetails): string {
	if (details.timedOut) {
		return `TIMEOUT ${details.durationSeconds.toFixed(1)}s`;
	}
	if (details.exitCode !== 0) {
		return `FAIL exit=${details.exitCode} ${details.durationSeconds.toFixed(1)}s`;
	}
	const metric =
		details.parsedPrimary !== null
			? ` ${details.metricName}=${formatNum(details.parsedPrimary, details.metricUnit)}`
			: "";
	return `PASS ${details.durationSeconds.toFixed(1)}s${metric}`;
}

function statusTone(details: RunDetails): ViewSpan["tone"] {
	if (details.timedOut || details.exitCode !== 0) {
		return "error";
	}
	return "success";
}

function isRunDetails(value: unknown): value is RunDetails {
	if (typeof value !== "object" || value === null) return false;
	return "command" in value && "durationSeconds" in value;
}

function isProgressDetails(value: unknown): value is RunExperimentProgressDetails {
	if (typeof value !== "object" || value === null) return false;
	return "phase" in value && value.phase === "running";
}
