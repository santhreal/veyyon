/**
 * Trial execution queue, Pier orchestration, canary watchdogs, and re-aggregation.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { $which, clampLow, errorMessage, readPipeText } from "@veyyon/utils";
import YAML from "yaml";
import { cleanupPierContainers } from "../../../backends/pier/runner";
import { MINIMUM_DEEPSWE_PIER_VERSION, pierSupportsSeparateVerifierCollect } from "../../../backends/pier/version";
import { awaitTrialProcessOutput, terminateProcessTree } from "../../../engine/trial-process";
import type { HarnessAdapter, HarnessLookup } from "../../../engine/contracts";
import {
	aggregateSystemComparison,
	type ComparisonSystem,
	comparisonTrialsFromArmResults,
	renderSystemComparison,
} from "../../../engine/system-comparison";

export const COMPARISON_TASK_LIST = "datasets/deep-swe/tasks/pilot-10.txt";
export const COMPARISON_TASK_LIST_SHA256 = "439b07dfbf30a988286e614b6b200def41b56f2447b249583560a78152cbfa06";

import type { ComparisonArmResult, ComparisonExecution } from "../../../engine/arm-result";
import type { SystemComparison } from "../../../engine/system-comparison-shapes";
import {
	armsDir,
	comparisonTaskListPath,
	oneshotPromptTemplatePath,
	pierAgentDir,
	resolvePackagePath,
	runsDir,
	taskCorpusDir,
	taskListsDir,
} from "../../../engine/package-paths";
import {
	type ArmResult,
	armCanaryFailure,
	emptyArmResult,
	isHardError,
	jobNameOf,
	MergeRefused,
	mergeRuns,
	mostCommonAgentReason,
	onPairedTasks,
	PINNED_TEMPERATURE,
	parseJobName,
	parseTaskListProvenance,
	predictedVsActual,
	providerQuotaStop,
	type RunToMerge,
	renderReport,
	selectTasks,
	shouldTripCanary,
	type TaskSetProvenance,
	trialQueue,
} from "../aggregate/index";
import { isArmConfigFile } from "../arm-fingerprint";
import { formatArmPrediction, predictArmSaving } from "../arm-prediction";
import { resolveBinaryPin } from "../binary-pin";
import { PREFIX_CATEGORIES, prefixShares } from "../prefix-mass";
import { conversationCollapsed, measureRunPrefix } from "../prefix-run";
import { type LoadedReplayManifest, loadReplayManifest } from "../replay-manifest";
import {
	parseTaskTimeBudget,
	parseTrialTimeoutFlag,
	type ResolvedTrialTimeout,
	resolveTrialTimeout,
	truncationWarning,
} from "../trial-timeout";
import { stageAllArms } from "./arm-staging";
import {
	CanaryTrippedError,
	ComparisonRejectionError,
	EmptyArmsError,
	InvalidBinaryPinError,
	InvalidTaskBudgetError,
	InvalidTrialTimeoutError,
	MergeArgsError,
	MergeMissingResultsError,
	MergeRefusedError,
	MissingBackendBindingError,
	MissingModelError,
	MissingTasksRootError,
	NoTasksSelectedError,
	PierIncompatibleError,
	PierMissingError,
	SystemPreflightError,
	UnknownArmError,
} from "./errors";
import {
	AUTH_DB_SOURCES,
	checkBinaryBuildNeeded,
	ensureAuthDbSeeded,
	ensureBinaryUpToDate,
	getAuthDbPath,
	getBenchDir,
	getVeyBinaryPath,
	requireFile,
	requireStagedAuthCanServeToken,
	sha256File,
} from "./preflight";
import { parseTrialResult, type TrialComparisonContext } from "./trial-result";
import { drainTrialQueueInPairedWaves } from "./trial-scheduler";

interface PriorRunResults {
	model?: string;
	binarySha?: string | null;
	armFingerprints?: Record<string, string> | null;
	limit?: number | null;
	totalTasksAvailable?: number | null;
	sampling?: unknown;
	taskSet?: TaskSetProvenance & { file: string | null };
	tasks?: string[];
	incomplete?: boolean;
	results?: ComparisonArmResult[];
	comparison?: {
		run?: { systems?: string[] };
		systems?: string[];
	} | null;
}

/**
 * What a run knows about itself that its artifacts do not carry: the model it ran, the task
 * order it planned, and how many repeats each cell had. A directory that has been aggregated
 * before states these in its own `results.json` and that record wins; these are the values a
 * first aggregation would otherwise report as "unknown".
 */
export interface ReaggregateDefaults {
	readonly model?: string;
	readonly tasks?: readonly string[];
	readonly repeats?: number;
}

/**
 * Recompute a finished run's aggregation and rewrite its report. Returns the cross-system
 * comparison when the run recorded one, so a caller states the verdict; a library function never
 * sets the host process's exit code.
 */
export function reaggregate(runDir: string, defaults?: ReaggregateDefaults): SystemComparison | null {
	const configDir = path.join(runDir, "configs");
	const jobsRoot = path.join(runDir, "jobs");
	const runId = path.basename(runDir);
	let prior: PriorRunResults | null = null;
	try {
		const raw = JSON.parse(fs.readFileSync(path.join(runDir, "results.json"), "utf8"));
		if (raw && typeof raw === "object") {
			prior = raw as PriorRunResults;
		}
	} catch {
		/* first aggregation */
	}
	const priorByCell = new Map<string, ComparisonArmResult>(
		((prior?.results ?? []) as ComparisonArmResult[]).map(result => [
			`${result.arm}\u0000${result.task}\u0000${result.repeat}`,
			result,
		]),
	);
	const results: ComparisonArmResult[] = [];
	if (fs.existsSync(configDir)) {
		for (const file of fs.readdirSync(configDir).filter(f => f.endsWith(".yaml"))) {
			const jobName = file.slice(0, -".yaml".length);
			const { arm, task, repeat } = parseJobName(jobName, runId);
			try {
				const refreshed = parseTrialResult(arm, task, repeat, path.join(jobsRoot, jobName));
				const old = priorByCell.get(`${arm}\u0000${task}\u0000${repeat}`);
				results.push(
					old
						? {
								...refreshed,
								system: old.system,
								requestedModel: old.requestedModel,
								resolvedModel: old.resolvedModel,
								providerCostSupported: old.providerCostSupported,
								qualitativeScore: old.qualitativeScore,
								recoveryReads: old.recoveryReads,
								recoveryTokens: old.recoveryTokens,
								artifacts: old.artifacts,
								execution: old.execution,
								replay: old.replay,
								nativeCompaction: old.nativeCompaction,
							}
						: refreshed,
				);
			} catch (err) {
				results.push({ ...emptyArmResult(arm, task, repeat), error: String(err) });
			}
		}
	}
	results.sort((a, b) => a.arm.localeCompare(b.arm) || a.task.localeCompare(b.task) || a.repeat - b.repeat);
	const arms = [...new Set(results.map(r => r.arm))];
	const tasks = [...new Set(results.map(r => r.task))];
	let model = defaults?.model ?? "unknown";
	let limit: number | null = null;
	let totalTasksAvailable: number | null = null;
	let sampling: unknown = null;
	let armFingerprints: unknown = null;
	let binarySha: string | null = null;
	let taskSet: (TaskSetProvenance & { file: string | null }) | undefined;
	let incomplete = false;
	if (prior) {
		model = prior.model ?? model;
		limit = prior.limit ?? null;
		totalTasksAvailable = prior.totalTasksAvailable ?? null;
		sampling = prior.sampling ?? null;
		armFingerprints = prior.armFingerprints ?? null;
		binarySha = prior.binarySha ?? null;
		taskSet = prior.taskSet ?? undefined;
		incomplete = prior.incomplete === true;
	}
	// A modular job name carries a 1-based repeat, a legacy one a 0-based index, so the
	// derived count is right for the old shape and one too many for the new. The plan's own
	// count settles it whenever the caller passed it.
	const repeats = defaults?.repeats ?? (results.length ? Math.max(...results.map(r => r.repeat)) + 1 : 1);
	const comparisonRun = prior?.comparison?.run ?? prior?.comparison ?? null;
	const comparisonMode = Array.isArray(comparisonRun?.systems);
	const orderedTasks: string[] = Array.isArray(prior?.tasks)
		? prior.tasks
		: defaults?.tasks
			? [...defaults.tasks]
			: tasks;
	let systemComparison: SystemComparison | null = null;
	let comparisonRejection: string | null = null;
	if (comparisonMode) {
		try {
			systemComparison = aggregateSystemComparison(comparisonTrialsFromArmResults(results), orderedTasks, model);
		} catch (error) {
			comparisonRejection = errorMessage(error);
		}
	}
	fs.writeFileSync(
		path.join(runDir, "results.json"),
		JSON.stringify(
			{
				model,
				binarySha,
				comparison: comparisonMode
					? { run: comparisonRun, aggregate: systemComparison, rejected: comparisonRejection }
					: null,
				limit,
				totalTasksAvailable,
				sampling,
				armFingerprints,
				taskSet,
				arms,
				tasks: orderedTasks,
				repeats,
				incomplete,
				results,
			},
			null,
			2,
		),
	);
	if (comparisonRejection) {
		throw new ComparisonRejectionError(
			`${comparisonRejection}\nRaw results and artifacts were retained; no comparison report was written.`,
		);
	}
	const report = systemComparison
		? renderSystemComparison(systemComparison)
		: renderReport(results, model, new Date().toISOString(), repeats, taskSet);
	fs.writeFileSync(path.join(runDir, "report.md"), report);
	console.log(`reaggregated ${results.length} runs into ${path.join(runDir, "report.md")}`);
	if (systemComparison) return systemComparison;
	reportPredictedVsActual(runDir, [...new Set(results.map(r => r.arm))], results);
	return null;
}

export function mergeIntoReport(runDirs: string[], outDir: string | null): void {
	if (runDirs.length < 2) {
		throw new MergeArgsError(`--merge needs at least two run directories, got ${runDirs.length}.`);
	}
	const runs: RunToMerge[] = [];
	for (const dir of runDirs) {
		const file = path.join(dir, "results.json");
		if (!fs.existsSync(file)) {
			throw new MergeMissingResultsError(`missing: ${file}\nRun --reaggregate on that directory first.`);
		}
		const prior = JSON.parse(fs.readFileSync(file, "utf8"));
		runs.push({
			label: path.basename(dir),
			model: prior.model ?? "unknown",
			binarySha: prior.binarySha ?? null,
			armFingerprints: prior.armFingerprints ?? null,
			results: prior.results ?? [],
		});
	}
	let merged: { results: ArmResult[]; model: string };
	try {
		merged = mergeRuns(runs);
	} catch (err) {
		if (err instanceof MergeRefused) {
			throw new MergeRefusedError(`refusing to merge: ${err.message}`);
		}
		throw err;
	}
	const target = outDir ?? runDirs[runDirs.length - 1]!;
	fs.mkdirSync(target, { recursive: true });
	const arms = [...new Set(merged.results.map(r => r.arm))];
	const tasks = [...new Set(merged.results.map(r => r.task))];
	const repeats = merged.results.length ? Math.max(...merged.results.map(r => r.repeat)) + 1 : 1;
	fs.writeFileSync(
		path.join(target, "merged-results.json"),
		JSON.stringify(
			{
				model: merged.model,
				mergedFrom: runDirs,
				arms,
				tasks,
				repeats,
				results: merged.results,
			},
			null,
			2,
		),
	);
	fs.writeFileSync(
		path.join(target, "merged-report.md"),
		renderReport(merged.results, merged.model, new Date().toISOString(), repeats, undefined),
	);
	console.log(
		`merged ${runDirs.length} runs (${merged.results.length} trials, ${tasks.length} tasks) into ` +
			`${path.join(target, "merged-report.md")}`,
	);
}

export function reportPredictedVsActual(runDir: string, arms: string[], results: ArmResult[]): void {
	const baseline = arms.find(arm => arm === "baseline");
	if (!baseline || arms.length < 2) return;
	const jobsRoot = path.join(runDir, "jobs");
	if (!fs.existsSync(jobsRoot)) return;

	const stagedConfig = (arm: string): unknown => {
		const staged = path.join(runDir, "assets", "arms", `${arm}.yml`);
		if (!fs.existsSync(staged)) return undefined;
		try {
			return YAML.parse(fs.readFileSync(staged, "utf8")) ?? {};
		} catch (err) {
			console.error(`predicted-vs-actual: staged overlay ${staged} could not be parsed: ${String(err)}`);
			return undefined;
		}
	};
	const measured = measureRunPrefix(jobsRoot, `${baseline}__`);
	if (measured.sessions === 0) {
		console.log("\npredicted vs actual: no baseline transcripts on disk, nothing to predict from.");
		return;
	}
	console.log("\npredicted vs actual saving (prediction derived from this run's own baseline):");
	for (const arm of arms) {
		if (arm === baseline) continue;
		const config = stagedConfig(arm);
		if (config === undefined) {
			console.log(`  ${arm}: no staged arm file in this run, so no prediction can be derived.`);
			continue;
		}
		const prediction = predictArmSaving(arm, config, measured.perSession, measured.mass, measured.usage);
		for (const line of formatArmPrediction(prediction)) console.log(line);
		if (prediction.levers.length === 0) continue;

		const treated = measureRunPrefix(jobsRoot, `${arm}__`);
		if (conversationCollapsed(measured.mass, measured.sessions, treated.mass, treated.sessions)) {
			console.log(
				`    ${arm} sessions carry almost no conversation, so its trials died before doing work.` +
					` No composition comparison is possible.`,
			);
		} else if (treated.sessions > 0) {
			const before = prefixShares(measured.mass);
			const after = prefixShares(treated.mass);
			for (const category of PREFIX_CATEGORIES) {
				const moved = after[category] - before[category];
				if (Math.abs(moved) < 0.01) continue;
				console.log(
					`    ${category.padEnd(14)} ${(100 * before[category]).toFixed(1)}% of prefix` +
						`  ->  ${(100 * after[category]).toFixed(1)}%` +
						`  (${moved >= 0 ? "+" : ""}${(100 * moved).toFixed(1)} points)`,
				);
			}
		}
		const comparison = predictedVsActual(onPairedTasks(results, baseline, arm), baseline, arm, prediction.netSaving);
		if (!comparison) {
			console.log(`  ${arm}: no paired trials with usage, so the actual saving cannot be measured.`);
			continue;
		}
		console.log(
			`  ${arm}  actual ${(100 * comparison.actual).toFixed(1)}%` +
				`  vs predicted ${(100 * comparison.predicted).toFixed(1)}%` +
				`  ->  gap ${100 * comparison.gap >= 0 ? "+" : ""}${(100 * comparison.gap).toFixed(1)} points`,
		);
	}
	console.log("  A gap near zero means the simulator can be trusted for the next lever without buying it.");
	console.log("  Cost is not the gate: read the paired sign test on reward first.");
}

/**
 * The pier agent import path a harness runs under, read from the one place it is declared.
 *
 * A harness that reaches the pier job config without a pier binding produced
 * `import_path: undefined` in the YAML, which pier reported as an import failure per trial.
 */
export function requirePierAgentImportPath(harness: HarnessAdapter): string {
	const importPath = harness.backends.pier?.agentImportPath;
	if (!importPath) {
		throw new MissingBackendBindingError(
			`harness "${harness.id}" declares no pier agent import path; add a pier binding to its backends map before running it on pier`,
		);
	}
	return importPath;
}

/**
 * Options for programmatic execution of the DeepSWE suite.
 */
export interface DeepSweRunOptions {
	readonly tasksRoot?: string;
	readonly tasks?: readonly string[];
	readonly tasksFile?: string;
	readonly arms?: readonly string[];
	readonly model?: string;
	readonly limit?: number;
	readonly repeats?: number;
	readonly jobs?: number;
	readonly outDir?: string;
	readonly binary?: string;
	readonly dryRun?: boolean;
	readonly trialTimeout?: string | number;
	readonly replayRoot?: string;
	readonly harnesses?: HarnessLookup;
	readonly customArmsDir?: string;
}

/**
 * Resolves the DeepSWE tasks root directory, falling back to DEEPSWE_TASKS_ROOT environment variable
 * or the local package task corpus directory. Throws MissingTasksRootError if none is available.
 */
export function resolveTasksRoot(tasksRoot?: string): string {
	if (tasksRoot !== undefined) {
		if (tasksRoot.trim().length === 0) {
			throw new MissingTasksRootError(
				"pass datasetDir / tasksRoot (or clone https://github.com/datacurve-ai/deep-swe into this package)",
			);
		}
		return resolvePackagePath(tasksRoot);
	}
	const localTasks = taskCorpusDir();
	const candidate = process.env.DEEPSWE_TASKS_ROOT ?? (fs.existsSync(localTasks) ? localTasks : undefined);
	if (!candidate) {
		throw new MissingTasksRootError(
			"pass datasetDir / tasksRoot (or clone https://github.com/datacurve-ai/deep-swe into this package)",
		);
	}
	return resolvePackagePath(candidate);
}

/**
 * Validates and classifies arm names into registered system adapters and veyyon config arms.
 * Throws EmptyArmsError if no arms are specified, or UnknownArmError if an arm is neither
 * a registered system adapter nor a valid arm configuration YAML file.
 */
export function resolveArmSelection(
	arms?: readonly string[],
	harnesses?: HarnessLookup,
	customArmsDir?: string,
): { systemArms: string[]; configArms: string[] } {
	const cleaned = (arms ?? []).flatMap(a => a.split(",")).map(a => a.trim()).filter(Boolean);
	if (cleaned.length === 0) {
		throw new EmptyArmsError("error: arms must specify at least one name");
	}
	const systemArms = cleaned.filter(a => (harnesses ? harnesses.get(a) !== undefined : false));
	const configArms = cleaned.filter(a => (harnesses ? harnesses.get(a) === undefined : true));
	const baseArmsDir = customArmsDir ?? armsDir();

	for (const arm of configArms) {
		const armYml = path.join(baseArmsDir, `${arm}.yml`);
		if (!fs.existsSync(armYml)) {
			throw new UnknownArmError(
				`error: unknown arm "${arm}". Not a system adapter and no arms/${arm}.yml found. ` +
					`Available systems: ${harnesses ? harnesses.ids().join(", ") : "none"}`,
			);
		}
	}

	return { systemArms, configArms };
}

/**
 * Requires an explicit model ID for execution, throwing MissingModelError if absent.
 */
export function requireModel(model?: string | null): string {
	if (!model || model.trim().length === 0) {
		throw new MissingModelError("error: --model <provider/model-id> is required.");
	}
	return model;
}

/**
 * Parses and validates an optional trial timeout override, throwing InvalidTrialTimeoutError if invalid.
 */
export function resolveTrialTimeoutOverride(trialTimeout?: string | number): number | undefined {
	if (trialTimeout === undefined || trialTimeout === null) return undefined;
	if (typeof trialTimeout === "number") {
		if (Number.isNaN(trialTimeout) || trialTimeout <= 0) {
			throw new InvalidTrialTimeoutError(`error: invalid trial timeout ${trialTimeout}`);
		}
		return trialTimeout;
	}
	try {
		return parseTrialTimeoutFlag(trialTimeout);
	} catch (err) {
		throw new InvalidTrialTimeoutError(`error: ${errorMessage(err)}`);
	}
}

/**
 * Resolves binary pin specification, throwing InvalidBinaryPinError if invalid.
 */
export function resolveEffectiveBinaryPin(binary?: string): string | null {
	const pin = resolveBinaryPin(binary);
	if (pin.kind === "invalid") {
		throw new InvalidBinaryPinError(`error: ${pin.reason}`);
	}
	return pin.kind === "pinned" ? pin.path : null;
}

/**
 * Loads task definitions from task.toml files and computes resolved trial timeouts.
 * Throws InvalidTaskBudgetError if any task.toml contains an invalid time budget.
 */
export function loadTaskTimeBudgets(
	tasks: readonly string[],
	tasksRoot: string,
	timeoutOverrideSec?: number,
): Map<string, ResolvedTrialTimeout> {
	const trialTimeouts = new Map<string, ResolvedTrialTimeout>();
	for (const task of tasks) {
		const taskToml = path.join(tasksRoot, task, "task.toml");
		requireFile(taskToml, `no such DeepSWE task: ${task}`);
		try {
			const budget = parseTaskTimeBudget(fs.readFileSync(taskToml, "utf8"), task);
			trialTimeouts.set(task, resolveTrialTimeout(budget, timeoutOverrideSec));
		} catch (err) {
			throw new InvalidTaskBudgetError(`error: ${errorMessage(err)}`);
		}
	}
	return trialTimeouts;
}

/**
 * Selects an even-stride subset of tasks if limit is specified.
 * Throws NoTasksSelectedError if the task list is empty.
 */
export function selectTaskSubset(tasks: readonly string[], limit?: number): string[] {
	if (tasks.length === 0) {
		throw new NoTasksSelectedError("no tasks selected");
	}
	if (limit !== undefined && limit < tasks.length) {
		return selectTasks([...tasks], limit);
	}
	return [...tasks];
}

/**
 * Verifies that pier is installed and meets the minimum version requirement for DeepSWE execution.
 * Throws PierMissingError or PierIncompatibleError on failure.
 */
export function verifyPierPrerequisites(): string {
	const pier = $which("pier") ?? `${os.homedir()}/.local/bin/pier`;
	if (!fs.existsSync(pier)) {
		throw new PierMissingError(
			`pier not found on PATH or ~/.local/bin — uv tool install 'datacurve-pier>=${MINIMUM_DEEPSWE_PIER_VERSION}'`,
		);
	}
	const pierVersionRun = spawnSync(pier, ["--version"], { encoding: "utf8", timeout: 30_000 });
	const pierVersion = `${pierVersionRun.stdout ?? ""}\n${pierVersionRun.stderr ?? ""}`.trim();
	if (pierVersionRun.error || pierVersionRun.status !== 0 || !pierSupportsSeparateVerifierCollect(pierVersion)) {
		throw new PierIncompatibleError(
			`DeepSWE requires Pier >=${MINIMUM_DEEPSWE_PIER_VERSION} for separate-verifier collect hooks; ` +
				`found ${pierVersion || "an unreadable version"}.`,
		);
	}
	return pier;
}

/**
 * Programmatic executor for the DeepSWE suite.
 */
export async function executeDeepSweRun(options: DeepSweRunOptions): Promise<SystemComparison | null> {
	const harnesses = options.harnesses;
	const tasksRoot = resolveTasksRoot(options.tasksRoot);
	const { systemArms, configArms } = resolveArmSelection(options.arms, harnesses, options.customArmsDir);
	const arms = [...systemArms, ...configArms];
	const hasSystemArms = systemArms.length > 0;
	const pureSystemComparison = hasSystemArms && configArms.length === 0;

	const model = requireModel(options.model);
	const repeats = options.repeats ?? 1;
	const jobParallel = options.jobs ?? 2;
	const trialTimeoutOverrideSec = resolveTrialTimeoutOverride(options.trialTimeout);

	const limit = options.limit;
	const outRoot = resolvePackagePath(
		options.outDir ?? path.join(runsDir(), new Date().toISOString().replace(/[:.]/g, "-")),
	);
	const comparisonTaskList = comparisonTaskListPath();
	const taskListFile = options.tasksFile
		? resolvePackagePath(options.tasksFile)
		: pureSystemComparison
			? comparisonTaskList
			: undefined;

	let tasks: string[];
	let taskSetProvenance: TaskSetProvenance;
	if (options.tasks && options.tasks.length > 0) {
		tasks = [...options.tasks];
		taskSetProvenance = { marked: true, biased: false, note: "explicit task list" };
	} else if (taskListFile) {
		const content = fs.readFileSync(taskListFile, "utf8");
		taskSetProvenance = parseTaskListProvenance(content);
		tasks = content
			.split("\n")
			.map(l => l.trim())
			.filter(l => l && !l.startsWith("#"));
	} else {
		tasks = fs
			.readdirSync(tasksRoot)
			.filter(d => fs.existsSync(path.join(tasksRoot, d, "task.toml")))
			.sort();
		taskSetProvenance = { marked: true, biased: false, note: "full task corpus (directory scan)" };
	}

	const totalTasksAvailable = tasks.length;
	tasks = selectTaskSubset(tasks, limit);
	if (limit !== undefined && limit < totalTasksAvailable) {
		console.error(
			`note: limit ${limit} selects ${tasks.length} of ${totalTasksAvailable} tasks as an even-stride ` +
				`representative sample; the reported pass rate covers this subset, not the full suite.`,
		);
	}

	const pinnedBinary = resolveEffectiveBinaryPin(options.binary);
	if (pinnedBinary) {
		requireFile(pinnedBinary, "point binary at a previous run's assets/vey");
		console.log(`binary PINNED to ${pinnedBinary} (sha256 ${sha256File(pinnedBinary).slice(0, 12)}).`);
	} else if (!options.dryRun) {
		await ensureBinaryUpToDate();
	} else {
		const status = checkBinaryBuildNeeded();
		if (status.needsBuild) {
			console.log(
				`deep-swe: [dry-run] binary build needed (${status.reason === "missing" ? "missing binary" : "stale binary"} at ${status.binaryPath}). Build command: ${status.buildCommand}`,
			);
		}
	}

	if (!options.dryRun) {
		ensureAuthDbSeeded();
	}
	const authDbToProbe =
		options.dryRun && !fs.existsSync(getAuthDbPath()) ? (AUTH_DB_SOURCES[0] ?? getAuthDbPath()) : getAuthDbPath();
	await requireStagedAuthCanServeToken(model, Boolean(options.dryRun), authDbToProbe);
	if (!options.dryRun) {
		requireFile(pinnedBinary ?? getVeyBinaryPath(), "build it: cd ../coding-agent && bun scripts/build-binary.ts");
	}

	const trialTimeouts = loadTaskTimeBudgets(tasks, tasksRoot, trialTimeoutOverrideSec);

	const replayManifests = new Map<string, LoadedReplayManifest>();
	if (hasSystemArms && options.replayRoot) {
		const replayRoot = path.resolve(options.replayRoot);
		for (const task of tasks) {
			const loaded = loadReplayManifest(path.join(replayRoot, `${task}.json`), model);
			replayManifests.set(task, loaded);
		}
	}

	const truncation = truncationWarning(trialTimeouts);
	if (truncation) console.error(truncation);

	const pier = verifyPierPrerequisites();

	const assetsDir = path.join(outRoot, "assets");
	fs.mkdirSync(assetsDir, { recursive: true });
	const effectiveBinary = pinnedBinary ?? getVeyBinaryPath();
	const binarySha = sha256File(effectiveBinary);
	fs.copyFileSync(effectiveBinary, path.join(assetsDir, "vey"));
	fs.chmodSync(path.join(assetsDir, "vey"), 0o755);
	fs.copyFileSync(getAuthDbPath(), path.join(assetsDir, "auth-agent.db"));

	for (const sys of systemArms) {
		const adapter = harnesses?.get(sys);
		if (!adapter) continue;
		if (adapter.validatePreflight) {
			const preflight = await adapter.validatePreflight({
				system: sys,
				model,
				args: {},
				dryRun: Boolean(options.dryRun),
			});
			if (!preflight.valid) {
				throw new SystemPreflightError(`preflight failed for system "${sys}": ${preflight.errors.join(", ")}`);
			}
		}
		await adapter.stageAssets({
			system: sys,
			assetsDir,
			outRoot,
			binarySha,
			args: {},
			model,
		});
	}

	const { armTemperature, armFingerprints } = stageAllArms({
		arms,
		benchDir: getBenchDir(),
		armsDir: options.customArmsDir ?? armsDir(),
		assetsDir,
		model,
		systemArms: new Set(systemArms),
	});

	const comparisonExecutionByTask = new Map<string, ComparisonExecution>();
	if (hasSystemArms) {
		for (const task of tasks) {
			const timeout = trialTimeouts.get(task);
			const replay = replayManifests.get(task);
			const instructionPath = path.join(tasksRoot, task, "instruction.md");
			requireFile(instructionPath, `task ${task} has no instruction.md`);
			comparisonExecutionByTask.set(task, {
				taskInstructionsHash: sha256File(instructionPath),
				repositoryStateHash: replay?.manifest.repository_checkpoint_sha256 ?? "",
				wallClockLimitSeconds: timeout?.timeoutSec ?? 1800,
				temperature: PINNED_TEMPERATURE,
				samplingDescription:
					"temperature 0 where the native API exposes sampling; otherwise native fixed/default sampling",
			});
		}
	}

	const results: ComparisonArmResult[] = [];
	const queue = trialQueue(arms, tasks, repeats);
	const totalQueued = queue.length;
	const canarySize = clampLow(jobParallel, 1, totalQueued);
	let canaryTripped = false;
	let canaryTripReason: string | null = null;
	const pairedWaveScheduling = jobParallel === arms.length;

	console.log(
		`deep-swe: ${arms.length} arm(s) x ${tasks.length} task(s)` +
			`${repeats > 1 ? ` x ${repeats} repeat(s)` : ""} = ${queue.length} run(s), model ${model}`,
	);
	console.log(`assets: ${assetsDir} (binary sha256 ${binarySha.slice(0, 12)}) → jobs under ${outRoot}`);
	console.log(
		`scheduling: ${pairedWaveScheduling ? `paired waves of ${arms.length} arm(s) per task` : `worker pool of ${clampLow(jobParallel, 1, totalQueued)} trial(s)`}`,
	);

	if (options.dryRun) {
		console.log("\nDRY RUN — every pre-run guard passed. No container was started and no report written.\n");
		console.log(`  model      ${model}`);
		console.log(`  tasks      ${tasks.length} from ${options.tasksFile ?? "(full corpus)"}`);
		console.log(`  arms       ${arms.join(", ")}`);
		return null;
	}

	const provenance = {
		model,
		binarySha,
		comparison: pureSystemComparison
			? {
					systems: systemArms,
					taskList: options.tasksFile ?? COMPARISON_TASK_LIST,
					replayManifests: Object.fromEntries(
						tasks.map(task => [task, replayManifests.get(task)?.sha256 ?? null]),
					),
				}
			: null,
		limit: limit ?? null,
		totalTasksAvailable,
		sampling: {
			pinnedTemperature: PINNED_TEMPERATURE,
			perArm: Object.fromEntries(arms.map(a => [a, armTemperature.get(a) ?? PINNED_TEMPERATURE])),
			note: "greedy at temperature 0: top-p / top-k are irrelevant, so temperature alone fixes the regime",
		},
		armFingerprints: Object.fromEntries(arms.map(a => [a, armFingerprints.get(a) ?? null])),
		taskSet: { file: options.tasksFile ?? (pureSystemComparison ? COMPARISON_TASK_LIST : null), ...taskSetProvenance },
		arms,
		tasks,
		repeats,
		incomplete: true,
		results: [],
	};
	fs.writeFileSync(path.join(outRoot, "results.json"), JSON.stringify(provenance, null, 2));

	function writeJobConfig(arm: string, task: string, repeat: number): string {
		const jobName = jobNameOf(arm, task, repeat, repeats);
		const configDir = path.join(outRoot, "configs");
		fs.mkdirSync(configDir, { recursive: true });
		const configPath = path.join(configDir, `${jobName}.yaml`);
		const common = [
			`job_name: ${JSON.stringify(jobName)}`,
			`jobs_dir: ${JSON.stringify(path.join(outRoot, "jobs"))}`,
			"quiet: true",
			"n_concurrent_trials: 1",
			"tasks:",
			`  - path: ${JSON.stringify(path.join(tasksRoot, task))}`,
			"agents:",
		];

		const adapter = harnesses?.get(arm);
		let agent: string[];
		if (adapter?.buildJobConfigKwargs) {
			const kwargs = adapter.buildJobConfigKwargs({
				system: arm,
				task,
				repeat,
				model,
				assetsDir,
				binarySha,
				replayPath: replayManifests.get(task)?.path,
				promptTemplatePath: oneshotPromptTemplatePath(),
				armName: arm,
				comparisonMode: pureSystemComparison,
			});
			agent = [
				`  - import_path: ${requirePierAgentImportPath(adapter)}`,
				`    model_name: ${JSON.stringify(model)}`,
				"    kwargs:",
				...Object.entries(kwargs).map(([k, v]) => `      ${k}: ${JSON.stringify(v)}`),
			];
		} else {
			const veyyonHarness = harnesses?.get("veyyon");
			const veyyonImportPath = veyyonHarness
				? requirePierAgentImportPath(veyyonHarness)
				: "veyyon_agent:VeyyonAgent";
			agent = [
				`  - import_path: ${veyyonImportPath}`,
				`    model_name: ${JSON.stringify(model)}`,
				"    kwargs:",
				`      arm_name: ${JSON.stringify(arm)}`,
				`      assets_dir: ${JSON.stringify(assetsDir)}`,
				`      binary_sha: ${JSON.stringify(binarySha)}`,
				`      prompt_template_path: ${JSON.stringify(oneshotPromptTemplatePath())}`,
			];
		}

		const yaml = [...common, ...agent, ""].join("\n");
		fs.writeFileSync(configPath, yaml);
		return configPath;
	}

	async function runOne(arm: string, task: string, repeat: number, attempt = 1): Promise<void> {
		const jobName = jobNameOf(arm, task, repeat, repeats);
		const jobDir = path.join(outRoot, "jobs", jobName);
		if (attempt > 1 && fs.existsSync(jobDir)) {
			fs.rmSync(jobDir, { recursive: true, force: true });
			try {
				await cleanupPierContainers(jobName);
			} catch {
				/* best effort */
			}
		}
		const started = Date.now();
		const proc = Bun.spawn([pier, "run", "-c", writeJobConfig(arm, task, repeat), "-q"], {
			cwd: pierAgentDir(),
			env: { ...process.env, PYTHONPATH: pierAgentDir() },
			stdout: "pipe",
			stderr: "pipe",
		});

		const resolvedTimeout = trialTimeouts.get(task);
		if (!resolvedTimeout) throw new Error(`internal: no resolved trial timeout for task ${task}`);
		const trialTimeoutSec = resolvedTimeout.timeoutSec;
		const wait = await awaitTrialProcessOutput({
			exited: proc.exited,
			stdout: readPipeText(proc.stdout),
			stderr: readPipeText(proc.stderr),
			timeoutMs: trialTimeoutSec * 1000,
			terminate: () => terminateProcessTree(proc).then(() => undefined),
		});
		const timedOut = wait.kind === "timed_out";
		const stdout = wait.stdout;
		const stderr = wait.stderr;
		const exitCode = wait.exitCode;

		let result: ComparisonArmResult;
		try {
			if (timedOut) throw new Error(`trial timed out after ${trialTimeoutSec}s`);
			const isSystemArm = harnesses ? harnesses.get(arm) !== undefined : false;
			const comparisonContext: TrialComparisonContext | null = isSystemArm
				? {
						system: arm as ComparisonSystem,
						requestedModel: model,
						execution: comparisonExecutionByTask.get(task)!,
						replayManifest: replayManifests.get(task) ?? null,
					}
				: null;
			result = parseTrialResult(arm, task, repeat, jobDir, comparisonContext);
		} catch (err) {
			const errStr = `${err}; pier exit ${exitCode}; ${stderr.slice(-300) || stdout.slice(-300)}`;
			if (
				attempt === 1 &&
				!timedOut &&
				(errStr.includes("Docker compose command failed") ||
					errStr.includes("FileExistsError") ||
					errStr.includes("ENOENT"))
			) {
				console.log(`[retry] ${jobName} hit startup collision; retrying (attempt 2)...`);
				return await runOne(arm, task, repeat, 2);
			}
			result = { ...emptyArmResult(arm, task, repeat), error: errStr };
		}
		if (harnesses && harnesses.get(arm) !== undefined) result.agentSeconds = (Date.now() - started) / 1000;
		results.push(result);
		const mark = result.error ? "ERROR" : result.reward === 1 ? "pass" : `reward=${result.reward}`;
		console.log(
			`[${results.length}/${totalQueued}] ${jobName}: ${mark} out=${result.outputTokens ?? "?"}tok cost=$${result.costUsd?.toFixed(3) ?? "?"} (${((Date.now() - started) / 1000).toFixed(0)}s)`,
		);

		const quotaStop = !canaryTripped ? providerQuotaStop(result.error) : null;
		if (quotaStop) {
			canaryTripped = true;
			canaryTripReason = `ABORTING: provider quota exhausted (${quotaStop.model ?? "model"}).`;
			console.error(`\n${canaryTripReason}`);
		}
		if (!canaryTripped && shouldTripCanary(results, canarySize)) {
			canaryTripped = true;
			const hardErrors = results.filter(isHardError).map(r => r.error ?? "");
			canaryTripReason = `ABORTING: canary tripped (${mostCommonAgentReason(hardErrors)}).`;
			console.error(`\n${canaryTripReason}`);
		}
		if (!canaryTripped) {
			const deadArm = armCanaryFailure(results, canarySize);
			if (deadArm !== undefined) {
				canaryTripped = true;
				const armErrors = results.filter(r => r.arm === deadArm && isHardError(r)).map(r => r.error ?? "");
				canaryTripReason = `ABORTING: arm "${deadArm}" failed canary (${mostCommonAgentReason(armErrors)}).`;
				console.error(`\n${canaryTripReason}`);
			}
		}
	}

	if (pairedWaveScheduling) {
		await drainTrialQueueInPairedWaves(queue, {
			armsPerWave: arms.length,
			shouldStop: () => canaryTripped,
			run: next => runOne(next.arm, next.task, next.repeat),
		});
	} else {
		const workers = Array.from({ length: Math.max(1, jobParallel) }, async () => {
			for (;;) {
				if (canaryTripped) return;
				const next = queue.shift();
				if (!next) return;
				await runOne(next.arm, next.task, next.repeat);
			}
		});
		await Promise.all(workers);
	}

	if (canaryTripped) {
		throw new CanaryTrippedError(canaryTripReason ?? "canary tripped");
	}

	results.sort((a, b) => a.arm.localeCompare(b.arm) || a.task.localeCompare(b.task) || a.repeat - b.repeat);
	const orderedTasks = tasks;
	let systemComparison: SystemComparison | null = null;
	let comparisonRejection: string | null = null;
	if (pureSystemComparison) {
		try {
			systemComparison = aggregateSystemComparison(comparisonTrialsFromArmResults(results), orderedTasks, model, undefined, harnesses);
		} catch (error) {
			comparisonRejection = errorMessage(error);
		}
	}

	fs.writeFileSync(
		path.join(outRoot, "results.json"),
		JSON.stringify(
			{
				...provenance,
				incomplete: false,
				comparison: pureSystemComparison
					? {
							run: provenance.comparison,
							aggregate: systemComparison,
							rejected: comparisonRejection,
						}
					: null,
				results,
			},
			null,
			2,
		),
	);

	if (comparisonRejection) {
		throw new ComparisonRejectionError(`${comparisonRejection}\nRaw results retained; no report written.`);
	}

	const report = systemComparison
		? renderSystemComparison(systemComparison)
		: renderReport(results, model, new Date().toISOString(), repeats, taskSetProvenance);
	fs.writeFileSync(path.join(outRoot, "report.md"), report);
	console.log(`\nReport written to ${path.join(outRoot, "report.md")}`);

	if (!pureSystemComparison) {
		reportPredictedVsActual(outRoot, arms, results);
	}
	return systemComparison;
}
