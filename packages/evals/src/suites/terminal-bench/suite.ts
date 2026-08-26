import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { $which, errorMessage } from "@veyyon/utils";
import { sumOfMeasured } from "../../core/scoring";
import type {
	BackendId,
	EvalSuite,
	PreflightVerdict,
	SuiteContext,
	SuiteProvenance,
	TaskDescriptor,
	TrialArtifacts,
	TrialCell,
	TrialScore,
	TrialUsage,
} from "../../core/types";
import {
	defaultGitExecutor,
	discoverTerminalBenchTasks,
	getDefaultTerminalBenchCacheDir,
	getTerminalBenchTaskConfigPath,
	getTerminalBenchTaskDir,
	getTerminalBenchTaskInstructionPath,
	TERMINAL_BENCH_COMMIT_SHA,
	TERMINAL_BENCH_GIT_REMOTE,
	TERMINAL_BENCH_TAG,
} from "./dataset";
import { TERMINAL_BENCH_SUITE_NAME } from "./paths";
import { computeTerminalBenchProvenance } from "./provenance";
import { loadTaskConfig, type MultiStepRewardStrategy } from "./task-config";
import { loadTaskList } from "./task-list";

const execFileAsync = promisify(execFile);

export type CommandExecutor = (file: string, args: readonly string[]) => Promise<{ stdout: string; stderr: string }>;
export type WhichLookup = (bin: string) => string | null;
export type GpuChecker = () => Promise<boolean>;

export async function defaultCommandExecutor(
	file: string,
	args: readonly string[],
): Promise<{ stdout: string; stderr: string }> {
	return execFileAsync(file, args as string[], {
		encoding: "utf-8",
		maxBuffer: 16 * 1024 * 1024,
	});
}

export async function defaultGpuChecker(
	whichFn: WhichLookup = $which,
	cmdExec: CommandExecutor = defaultCommandExecutor,
): Promise<boolean> {
	const nvidiaSmi = whichFn("nvidia-smi");
	if (!nvidiaSmi) return false;
	try {
		const { stdout } = await cmdExec(nvidiaSmi, ["-L"]);
		return stdout.trim().length > 0;
	} catch {
		return false;
	}
}

export interface TerminalBenchSuiteOptions {
	readonly defaultDatasetDir?: string;
	readonly git?: typeof defaultGitExecutor;
	readonly which?: WhichLookup;
	readonly exec?: CommandExecutor;
	readonly gpuCheck?: GpuChecker;
}

export class TerminalBenchSuite implements EvalSuite {
	readonly name = TERMINAL_BENCH_SUITE_NAME;
	readonly version = TERMINAL_BENCH_TAG;
	readonly displayName = "Terminal-Bench 3.0";
	readonly description = "Terminal-Bench 3.0 benchmark suite for terminal and tool-use evaluation";
	readonly backend: BackendId = "harbor";

	readonly #defaultDatasetDir: string | undefined;
	readonly #git: typeof defaultGitExecutor;
	readonly #which: WhichLookup;
	readonly #exec: CommandExecutor;
	readonly #gpuCheck: GpuChecker;

	constructor(options: TerminalBenchSuiteOptions = {}) {
		this.#defaultDatasetDir = options.defaultDatasetDir;
		this.#git = options.git ?? defaultGitExecutor;
		this.#which = options.which ?? $which;
		this.#exec = options.exec ?? defaultCommandExecutor;
		this.#gpuCheck = options.gpuCheck ?? (() => defaultGpuChecker(this.#which, this.#exec));
	}

	#resolveDatasetDir(context: SuiteContext): string {
		return context.datasetDir ?? this.#defaultDatasetDir ?? getDefaultTerminalBenchCacheDir();
	}

	async discoverTasks(context: SuiteContext): Promise<readonly string[]> {
		const options = context.options;
		if (options?.taskList && typeof options.taskList === "string") {
			const loaded = await loadTaskList(options.taskList);
			return loaded.tasks;
		}

		if (Array.isArray(options?.tasks) && options.tasks.length > 0) {
			return options.tasks.filter((t): t is string => typeof t === "string");
		}

		if (Array.isArray(options?.taskIds) && options.taskIds.length > 0) {
			return options.taskIds.filter((t): t is string => typeof t === "string");
		}

		const datasetDir = this.#resolveDatasetDir(context);
		return discoverTerminalBenchTasks(datasetDir);
	}

	async describeTask(taskId: string, context: SuiteContext): Promise<TaskDescriptor> {
		const datasetDir = this.#resolveDatasetDir(context);
		const taskDir = getTerminalBenchTaskDir(datasetDir, taskId);
		const config = await loadTaskConfig(taskDir);
		const instructionPath = getTerminalBenchTaskInstructionPath(datasetDir, taskId);
		const timeBudgetSec = config.agent.timeout_sec ?? 18000;

		const metadata: Record<string, unknown> = {
			...config,
			schema_version: config.schema_version,
			task: config.task ?? null,
			metadata: config.metadata,
			verifier: config.verifier,
			verifier_environment_mode: config.verifier.environment_mode ?? "separate",
			verifier_timeout_sec: config.verifier.timeout_sec,
			agent: config.agent,
			agent_timeout_sec: timeBudgetSec,
			environment: config.environment,
			cpus: config.environment.cpus ?? null,
			memory_mb: config.environment.memory_mb ?? null,
			storage_mb: config.environment.storage_mb ?? null,
			gpus: config.environment.gpus ?? 0,
			gpu_types: config.environment.gpu_types ?? null,
			network_mode: config.environment.network_mode,
			os: config.environment.os,
			workdir: config.environment.workdir ?? null,
			artifacts: config.artifacts,
			solution: config.solution,
			source: config.source ?? null,
			multi_step_reward_strategy: config.multi_step_reward_strategy ?? null,
			steps: config.steps ?? null,
			rawConfig: config,
		};

		return {
			id: taskId,
			path: taskDir,
			timeBudgetSec,
			instructionPath,
			metadata,
		};
	}

	async provenance(context: SuiteContext): Promise<SuiteProvenance> {
		const datasetDir = this.#resolveDatasetDir(context);
		const tasks = await this.discoverTasks(context);
		const prov = await computeTerminalBenchProvenance({
			datasetRoot: datasetDir,
			selectedTasks: tasks,
		});

		return {
			suite: this.name,
			version: this.version,
			sha: prov.resolvedCommitSha || TERMINAL_BENCH_COMMIT_SHA,
			sourceUrl: TERMINAL_BENCH_GIT_REMOTE,
			metadata: {
				gitRemote: prov.gitRemote,
				resolvedCommitSha: prov.resolvedCommitSha,
				taskCount: prov.taskCount,
				selectedTasks: prov.selectedTasks,
				contentHash: prov.contentHash,
				timestamp: prov.timestamp,
			},
		};
	}

	async preflight(context: SuiteContext): Promise<PreflightVerdict> {
		const datasetDir = this.#resolveDatasetDir(context);

		// 1. Corpus acquired check
		try {
			const s = await stat(datasetDir);
			if (!s.isDirectory()) {
				return {
					ok: false,
					reason: `Terminal-Bench corpus is not acquired: path is not a directory at ${datasetDir}. Run acquireTerminalBenchDataset() to clone the pinned dataset.`,
					missingRequirements: ["corpus"],
				};
			}
		} catch (error) {
			const err = errorMessage(error);
			return {
				ok: false,
				reason: `Terminal-Bench corpus is not acquired at ${datasetDir} (${err}). Run acquireTerminalBenchDataset() to clone and pin the dataset.`,
				missingRequirements: ["corpus"],
			};
		}

		try {
			const tasksDir = join(datasetDir, "tasks");
			const tasksStat = await stat(tasksDir);
			if (!tasksStat.isDirectory()) {
				return {
					ok: false,
					reason: `Terminal-Bench corpus is incomplete: missing tasks/ directory at ${datasetDir}. Run acquireTerminalBenchDataset() to re-clone the dataset.`,
					missingRequirements: ["corpus"],
				};
			}
		} catch (error) {
			const err = errorMessage(error);
			return {
				ok: false,
				reason: `Terminal-Bench corpus is incomplete: missing tasks/ directory at ${datasetDir} (${err}). Run acquireTerminalBenchDataset() to re-clone the dataset.`,
				missingRequirements: ["corpus"],
			};
		}

		// 2. Resolved commit SHA check
		try {
			const resolvedSha = await this.#git(["rev-parse", "HEAD"], datasetDir);
			if (resolvedSha && resolvedSha !== TERMINAL_BENCH_COMMIT_SHA) {
				return {
					ok: false,
					reason: `Terminal-Bench corpus commit SHA mismatch at ${datasetDir}: expected ${TERMINAL_BENCH_COMMIT_SHA}, found ${resolvedSha}. Re-acquire with acquireTerminalBenchDataset({ force: true }).`,
					missingRequirements: ["pinned-commit-sha"],
				};
			}
		} catch (error) {
			// If .git is absent or git fails, fail closed if SHA verification is required
			const err = errorMessage(error);
			return {
				ok: false,
				reason: `Failed to verify Terminal-Bench corpus commit SHA at ${datasetDir}: ${err}. Ensure dataset repository is intact.`,
				missingRequirements: ["pinned-commit-sha"],
			};
		}

		// 3. harbor on PATH check
		const harborBin = this.#which("harbor");
		if (!harborBin) {
			return {
				ok: false,
				reason:
					"harbor executable is not on PATH. Install harbor via 'uv tool install harbor' or ensure PATH includes harbor.",
				missingRequirements: ["harbor"],
			};
		}

		// 4. docker usable check
		const dockerBin = this.#which("docker");
		if (!dockerBin) {
			return {
				ok: false,
				reason: "docker executable is not on PATH. Install Docker and ensure PATH includes docker.",
				missingRequirements: ["docker"],
			};
		}

		try {
			await this.#exec(dockerBin, ["info"]);
		} catch (error) {
			const err = errorMessage(error);
			return {
				ok: false,
				reason: `Docker daemon is not accessible: ${err}. Ensure Docker daemon is running and current user has permissions.`,
				missingRequirements: ["docker-daemon"],
			};
		}

		// 5. GPU requirements check
		try {
			const tasksToRun = await this.discoverTasks(context);
			const tasksNeedingGpu: Array<{ taskId: string; gpus: number; gpuTypes?: readonly string[] | null }> = [];

			for (const taskId of tasksToRun) {
				const configPath = getTerminalBenchTaskConfigPath(datasetDir, taskId);
				try {
					const config = await loadTaskConfig(configPath);
					const reqGpus = config.environment.gpus ?? 0;
					if (reqGpus > 0) {
						tasksNeedingGpu.push({
							taskId,
							gpus: reqGpus,
							gpuTypes: config.environment.gpu_types,
						});
					}
				} catch {
					// If a specific task config cannot be read, discovery / task config error will surface on run
				}
			}

			if (tasksNeedingGpu.length > 0) {
				const hasGpu = await this.#gpuCheck();
				if (!hasGpu) {
					const first = tasksNeedingGpu[0]!;
					const typeNote = first.gpuTypes && first.gpuTypes.length > 0 ? ` (${first.gpuTypes.join(", ")})` : "";
					return {
						ok: false,
						reason: `Task '${first.taskId}' requires ${first.gpus} GPU(s)${typeNote}, but host does not have usable GPU acceleration.`,
						missingRequirements: ["gpu"],
					};
				}
			}
		} catch {
			// If task discovery fails, report ok: true or let task discovery error on run
		}

		return { ok: true };
	}

	async scoreTrial(cell: TrialCell, artifacts: TrialArtifacts): Promise<TrialScore> {
		if (typeof artifacts.extra?.error === "string" && artifacts.extra.error) {
			return {
				reward: null,
				partial: null,
				error: `Trial execution failed: ${artifacts.extra.error}`,
				usage: null,
				extra: {
					...artifacts.extra,
					cell,
				},
			};
		}

		const trialDir = artifacts.trialDir;
		const filePaths = artifacts.filePaths ?? {};

		// Check for multi-step trial layout
		const stepDirs = await this.#findStepDirs(trialDir, filePaths);
		if (stepDirs.length > 0) {
			return this.#scoreMultiStepTrial(cell, artifacts, stepDirs);
		}

		return this.#scoreSingleStepTrial(cell, artifacts);
	}

	async #findStepDirs(
		trialDir: string | null | undefined,
		filePaths: Readonly<Record<string, string>>,
	): Promise<readonly string[]> {
		if (trialDir) {
			try {
				const entries = await readdir(trialDir, { withFileTypes: true });
				const stepNames = entries
					.filter(e => e.isDirectory() && /^step_\d+$/i.test(e.name))
					.map(e => e.name)
					.sort((a, b) => {
						const numA = Number.parseInt(a.replace(/\D/g, ""), 10) || 0;
						const numB = Number.parseInt(b.replace(/\D/g, ""), 10) || 0;
						return numA - numB;
					});
				if (stepNames.length > 0) return stepNames;
			} catch {
				// Ignore disk errors
			}
		}

		// Check filePaths map for step patterns
		const stepSet = new Set<string>();
		for (const key of Object.keys(filePaths)) {
			const match = key.match(/^(step_\d+)[/\\]/i);
			if (match?.[1]) {
				stepSet.add(match[1]);
			}
		}
		if (stepSet.size > 0) {
			return [...stepSet].sort((a, b) => {
				const numA = Number.parseInt(a.replace(/\D/g, ""), 10) || 0;
				const numB = Number.parseInt(b.replace(/\D/g, ""), 10) || 0;
				return numA - numB;
			});
		}

		return [];
	}

	async #readArtifactText(
		trialDir: string | null | undefined,
		filePaths: Readonly<Record<string, string>>,
		relativeCandidates: readonly string[],
	): Promise<string | null> {
		for (const rel of relativeCandidates) {
			if (rel in filePaths) {
				const fullPath = filePaths[rel];
				if (typeof fullPath === "string") {
					try {
						const text = await readFile(fullPath, "utf-8");
						return text;
					} catch {
						// Failed to read path
					}
				}
			}

			if (trialDir) {
				const full = join(trialDir, rel);
				try {
					const text = await readFile(full, "utf-8");
					return text;
				} catch {
					// Try next candidate
				}
			}
		}
		return null;
	}

	async #extractSingleReward(
		trialDir: string | null | undefined,
		filePaths: Readonly<Record<string, string>>,
		subPathPrefix = "",
	): Promise<{ reward: number | null; partial: number | null; error: string | null }> {
		const jsonCandidates = [
			`${subPathPrefix}verifier/reward.json`,
			`${subPathPrefix}logs/verifier/reward.json`,
			`${subPathPrefix}reward.json`,
		].map(p => p.replace(/^\/+/, ""));

		const txtCandidates = [
			`${subPathPrefix}verifier/reward.txt`,
			`${subPathPrefix}logs/verifier/reward.txt`,
			`${subPathPrefix}reward.txt`,
		].map(p => p.replace(/^\/+/, ""));

		const rawJson = await this.#readArtifactText(trialDir, filePaths, jsonCandidates);
		if (rawJson !== null) {
			const trimmed = rawJson.trim();
			if (trimmed.length === 0) {
				// Empty reward.json: try reward.txt before failing
				const rawTxt = await this.#readArtifactText(trialDir, filePaths, txtCandidates);
				if (rawTxt !== null) {
					return this.#parseRewardText(rawTxt);
				}
				return { reward: null, partial: null, error: "Reward file 'reward.json' is empty" };
			}

			try {
				const parsed = JSON.parse(trimmed);
				if (typeof parsed === "number" && Number.isFinite(parsed)) {
					return { reward: parsed, partial: parsed, error: null };
				}
				if (parsed && typeof parsed === "object") {
					if (typeof parsed.reward === "number" && Number.isFinite(parsed.reward)) {
						const partial =
							typeof parsed.partial === "number" && Number.isFinite(parsed.partial)
								? parsed.partial
								: parsed.reward;
						return { reward: parsed.reward, partial, error: null };
					}
					if (parsed.rewards && typeof parsed.rewards === "object") {
						const firstKey = Object.keys(parsed.rewards)[0];
						const rVal = firstKey ? parsed.rewards[firstKey] : undefined;
						if (typeof rVal === "number" && Number.isFinite(rVal)) {
							return { reward: rVal, partial: rVal, error: null };
						}
					}
				}
				// JSON parse succeeded but no reward found: try reward.txt before reporting unparseable JSON
				const rawTxt = await this.#readArtifactText(trialDir, filePaths, txtCandidates);
				if (rawTxt !== null) {
					return this.#parseRewardText(rawTxt);
				}
				return { reward: null, partial: null, error: "Unparseable reward.json: missing numeric 'reward' field" };
			} catch (err) {
				// JSON syntax error: try reward.txt before reporting error
				const rawTxt = await this.#readArtifactText(trialDir, filePaths, txtCandidates);
				if (rawTxt !== null) {
					return this.#parseRewardText(rawTxt);
				}
				const msg = errorMessage(err);
				return { reward: null, partial: null, error: `Unparseable reward.json: ${msg}` };
			}
		}

		// Try reward.txt
		const rawTxt = await this.#readArtifactText(trialDir, filePaths, txtCandidates);
		if (rawTxt !== null) {
			return this.#parseRewardText(rawTxt);
		}

		// Try result.json if present
		const resultJson = await this.#readArtifactText(trialDir, filePaths, [
			`${subPathPrefix}result.json`.replace(/^\/+/, ""),
		]);
		if (resultJson !== null) {
			try {
				const r = JSON.parse(resultJson.trim());
				if (r && typeof r === "object") {
					if (r.verifier_result && typeof r.verifier_result === "object") {
						const vr = r.verifier_result;
						if (typeof vr.reward === "number" && Number.isFinite(vr.reward)) {
							return { reward: vr.reward, partial: vr.reward, error: null };
						}
						if (vr.rewards && typeof vr.rewards === "object") {
							const k = Object.keys(vr.rewards)[0];
							const val = k ? vr.rewards[k] : undefined;
							if (typeof val === "number" && Number.isFinite(val)) {
								return { reward: val, partial: val, error: null };
							}
						}
					}
					if (r.exception_info && typeof r.exception_info === "object") {
						const excType =
							typeof r.exception_info.exception_type === "string"
								? r.exception_info.exception_type
								: "TrialException";
						return { reward: null, partial: null, error: `Trial failed with exception: ${excType}` };
					}
				}
			} catch {
				// Ignore
			}
		}

		return {
			reward: null,
			partial: null,
			error: "Missing reward file: neither reward.json nor reward.txt found in trial artifacts",
		};
	}

	#parseRewardText(rawTxt: string): { reward: number | null; partial: number | null; error: string | null } {
		const trimmed = rawTxt.trim();
		if (trimmed.length === 0) {
			return { reward: null, partial: null, error: "Reward file 'reward.txt' is empty" };
		}
		const num = Number.parseFloat(trimmed);
		if (!Number.isNaN(num) && Number.isFinite(num)) {
			return { reward: num, partial: num, error: null };
		}
		return { reward: null, partial: null, error: `Unparseable reward.txt: '${trimmed}' is not a valid number` };
	}

	async #extractUsage(
		trialDir: string | null | undefined,
		filePaths: Readonly<Record<string, string>>,
	): Promise<{
		usage: TrialUsage | null;
		parseError?: { file: string; message: string } | null;
	}> {
		const rawResult = await this.#readArtifactText(trialDir, filePaths, ["result.json"]);
		if (rawResult !== null) {
			const targetFile = filePaths["result.json"] ?? (trialDir ? join(trialDir, "result.json") : "result.json");
			try {
				const r = JSON.parse(rawResult.trim());
				if (r && typeof r === "object") {
					const inputTokensList: (number | null | undefined)[] = [];
					const outputTokensList: (number | null | undefined)[] = [];
					const cacheTokensList: (number | null | undefined)[] = [];
					const costUsdList: (number | null | undefined)[] = [];

					const addCtx = (ctx: unknown) => {
						if (ctx && typeof ctx === "object") {
							const c = ctx as Record<string, unknown>;
							if (typeof c.n_input_tokens === "number") {
								inputTokensList.push(c.n_input_tokens);
							}
							if (typeof c.n_output_tokens === "number") {
								outputTokensList.push(c.n_output_tokens);
							}
							if (typeof c.n_cache_tokens === "number") {
								cacheTokensList.push(c.n_cache_tokens);
							}
							if (typeof c.cost_usd === "number") {
								costUsdList.push(c.cost_usd);
							}
						}
					};

					addCtx(r.agent_result);
					if (Array.isArray(r.step_results)) {
						for (const step of r.step_results) {
							if (step && typeof step === "object") {
								addCtx((step as Record<string, unknown>).agent_result);
							}
						}
					}

					let durationSec: number | null = null;
					if (typeof r.started_at === "string" && typeof r.finished_at === "string") {
						const start = Date.parse(r.started_at);
						const finish = Date.parse(r.finished_at);
						if (!Number.isNaN(start) && !Number.isNaN(finish) && finish >= start) {
							durationSec = (finish - start) / 1000;
						}
					}

					const inputTokens = sumOfMeasured(inputTokensList);
					const outputTokens = sumOfMeasured(outputTokensList);
					const cacheTokens = sumOfMeasured(cacheTokensList);
					const costUsd = sumOfMeasured(costUsdList);

					const hasUsage =
						inputTokens !== null ||
						outputTokens !== null ||
						cacheTokens !== null ||
						costUsd !== null ||
						durationSec !== null;

					if (hasUsage) {
						return {
							usage: {
								inputTokens,
								outputTokens,
								cacheTokens,
								costUsd,
								durationSec,
							},
							parseError: null,
						};
					}
				}
			} catch (err) {
				return {
					usage: null,
					parseError: {
						file: targetFile,
						message: `Failed to parse result.json from '${targetFile}': ${errorMessage(err)}`,
					},
				};
			}
		}

		return { usage: null, parseError: null };
	}

	async #scoreSingleStepTrial(cell: TrialCell, artifacts: TrialArtifacts): Promise<TrialScore> {
		const trialDir = artifacts.trialDir;
		const filePaths = artifacts.filePaths ?? {};
		const { reward, partial, error } = await this.#extractSingleReward(trialDir, filePaths);
		const { usage, parseError } = await this.#extractUsage(trialDir, filePaths);

		const finalError = error ?? parseError?.message ?? null;

		return {
			reward: finalError ? null : reward,
			partial: finalError ? null : partial,
			error: finalError,
			usage,
			extra: {
				...artifacts.extra,
				cell,
				...(parseError ? { result_json_parse_error: parseError.message, result_json_file: parseError.file } : {}),
			},
		};
	}

	async #scoreMultiStepTrial(
		cell: TrialCell,
		artifacts: TrialArtifacts,
		stepDirs: readonly string[],
	): Promise<TrialScore> {
		const trialDir = artifacts.trialDir;
		const filePaths = artifacts.filePaths ?? {};

		const stepRewards: Array<{ step: string; reward: number | null; partial: number | null; error: string | null }> =
			[];
		for (const step of stepDirs) {
			const res = await this.#extractSingleReward(trialDir, filePaths, `${step}/`);
			stepRewards.push({ step, ...res });
		}

		const anyError = stepRewards.find(s => s.error !== null);
		const strategy: MultiStepRewardStrategy =
			(artifacts.extra?.multi_step_reward_strategy as MultiStepRewardStrategy) ??
			(artifacts.extra?.strategy as MultiStepRewardStrategy) ??
			"mean";

		const { usage, parseError } = await this.#extractUsage(trialDir, filePaths);
		const finalError = anyError ? `Step '${anyError.step}' failed: ${anyError.error}` : (parseError?.message ?? null);
		if (finalError) {
			return {
				reward: null,
				partial: null,
				error: finalError,
				usage,
				extra: {
					...artifacts.extra,
					cell,
					stepRewards,
					multi_step_reward_strategy: strategy,
					...(parseError
						? { result_json_parse_error: parseError.message, result_json_file: parseError.file }
						: {}),
				},
			};
		}

		const validRewards = stepRewards.map(s => s.reward as number);
		let finalReward: number;
		let partialReward: number;

		if (strategy === "final") {
			finalReward = validRewards[validRewards.length - 1] ?? 0;
			const sum = validRewards.reduce((acc, r) => acc + r, 0);
			partialReward = validRewards.length > 0 ? sum / validRewards.length : 0;
		} else {
			// "mean" strategy
			const sum = validRewards.reduce((acc, r) => acc + r, 0);
			finalReward = validRewards.length > 0 ? sum / validRewards.length : 0;
			partialReward = finalReward;
		}

		return {
			reward: finalReward,
			partial: partialReward,
			error: null,
			usage,
			extra: {
				...artifacts.extra,
				cell,
				stepRewards,
				multi_step_reward_strategy: strategy,
				...(parseError ? { result_json_parse_error: parseError.message, result_json_file: parseError.file } : {}),
			},
		};
	}
}

export const terminalBenchSuite = new TerminalBenchSuite();
