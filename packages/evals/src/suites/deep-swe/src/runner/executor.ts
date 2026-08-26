/**
 * Trial execution queue, Pier orchestration, canary watchdogs, and re-aggregation.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clampLow, errorMessage, readPipeText } from "@veyyon/utils";
import YAML from "yaml";
import { cleanupPierContainers } from "../../../../backends/pier/runner";
import {
	getHarness,
	hasHarness,
	listHarnesses,
	listHarnessNames,
	requireHarness,
} from "../../../../core/harness-registry";
import type { HarnessAdapter } from "../../../../core/types";
import {
	aggregateSystemComparison,
	type ComparisonSystem,
	comparisonTrialsFromArmResults,
	renderSystemComparison,
} from "../../../../harnesses/system-comparison";

export const COMPARISON_TASK_LIST = "datasets/deep-swe/tasks/pilot-10.txt";
export const COMPARISON_TASK_LIST_SHA256 = "439b07dfbf30a988286e614b6b200def41b56f2447b249583560a78152cbfa06";

import type { ComparisonArmResult, ComparisonExecution, SystemComparison } from "../../../../harnesses/types";
import {
	armsDir,
	comparisonTaskListPath,
	oneshotPromptTemplatePath,
	pierAgentDir,
	resolvePackagePath,
	runsDir,
	taskCorpusDir,
	taskListsDir,
} from "../../../../paths";
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
} from "../aggregate";
import {
	conversationCollapsed,
	formatArmPrediction,
	isArmConfigFile,
	type LoadedReplayManifest,
	loadReplayManifest,
	MINIMUM_DEEPSWE_PIER_VERSION,
	measureRunPrefix,
	PREFIX_CATEGORIES,
	parseTaskTimeBudget,
	parseTrialTimeoutFlag,
	pierSupportsSeparateVerifierCollect,
	predictArmSaving,
	prefixShares,
	type ResolvedTrialTimeout,
	resolveBinaryPin,
	resolveTrialTimeout,
	truncationWarning,
} from "../shared";
import { stageAllArms } from "./arm-staging";
import { parseBenchCliArgs, printHelp } from "./cli-args";
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

export function reaggregate(runDir: string): void {
	const configDir = path.join(runDir, "configs");
	const jobsRoot = path.join(runDir, "jobs");
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
			const { arm, task, repeat } = parseJobName(jobName);
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
	let model = "unknown";
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
	const repeats = results.length ? Math.max(...results.map(r => r.repeat)) + 1 : 1;
	const comparisonRun = prior?.comparison?.run ?? prior?.comparison ?? null;
	const comparisonMode = Array.isArray(comparisonRun?.systems);
	const orderedTasks: string[] = Array.isArray(prior?.tasks) ? prior.tasks : tasks;
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
	if (systemComparison) {
		if (systemComparison.overall !== "pass") process.exitCode = 1;
	} else {
		reportPredictedVsActual(runDir, [...new Set(results.map(r => r.arm))], results);
	}
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

function printAvailable(): void {
	const armFiles = fs.readdirSync(armsDir()).filter(isArmConfigFile).sort();
	const taskSets = fs
		.readdirSync(taskListsDir())
		.filter(f => f.endsWith(".txt"))
		.sort();
	const adapters = listHarnesses();

	console.log("\nArms:");
	for (const file of armFiles) {
		const name = file.replace(/\.yml$/, "");
		const content = fs.readFileSync(path.join(armsDir(), file), "utf8");
		const desc = content.match(/^#\s*(.+)/)?.[1]?.slice(0, 70) ?? "";
		console.log(`  ${name.padEnd(40)} ${desc}`);
	}

	console.log("\nSystem adapters:");
	for (const adapter of adapters) {
		console.log(`  ${adapter.name.padEnd(15)} ${adapter.displayName} — ${adapter.description.slice(0, 60)}`);
	}

	console.log("\nTask sets:");
	for (const file of taskSets) {
		const content = fs.readFileSync(path.join(taskListsDir(), file), "utf8");
		const lines = content.split("\n").filter(l => l.trim() && !l.startsWith("#"));
		const header = content.match(/^#\s*@(headline|biased)\s*(.*)/m);
		const tag = header ? `[${header[1]}]` : "[unmarked]";
		console.log(`  ${file.padEnd(25)} ${lines.length} tasks  ${tag}`);
	}
	console.log();
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
			`harness "${harness.name}" declares no pier agent import path; add a pier binding to its backends map before running it on pier`,
		);
	}
	return importPath;
}

export async function runBench(argv: string[]): Promise<void> {
	const args = parseBenchCliArgs(argv);
	if (args.help) {
		printHelp();
		return;
	}
	if (args.reaggregate && args.runDir) {
		reaggregate(path.resolve(args.runDir));
		return;
	}
	if (args.mergeDirs && args.mergeDirs.length > 0) {
		mergeIntoReport(
			args.mergeDirs.map(dir => path.resolve(dir)),
			args.outDir ? path.resolve(args.outDir) : null,
		);
		return;
	}
	if (args.list) {
		printAvailable();
		return;
	}

	const benchDir = getBenchDir();
	const localTasks = taskCorpusDir();
	const tasksRootArg =
		args.tasksRoot ?? process.env.DEEPSWE_TASKS_ROOT ?? (fs.existsSync(localTasks) ? localTasks : undefined);
	if (!tasksRootArg) {
		throw new MissingTasksRootError(
			"pass --tasks-root <dir> (or clone https://github.com/datacurve-ai/deep-swe into this package)",
		);
	}
	const tasksRoot = resolvePackagePath(tasksRootArg);

	// --systems is a legacy shorthand for --arms with system adapter names.
	// --arms accepts any mix of config arm names (baseline, full, …) and
	// system adapter names (veyyon, omp, factory, hermes).
	const legacySystemComparison = args.raw["system-comparison"] === "true" || args.raw["system-comparison"] === "";
	const rawArms =
		args.arms ?? args.comparisonSystems ?? (legacySystemComparison ? listHarnessNames() : ["baseline", "full"]);
	const arms = rawArms.map(a => a.trim()).filter(Boolean);
	if (arms.length === 0) {
		throw new EmptyArmsError("error: --arms must specify at least one name");
	}

	// Classify each arm: a registered system adapter, or a veyyon config arm
	// backed by arms/<name>.yml.
	const systemArms = arms.filter(a => hasHarness(a));
	const configArms = arms.filter(a => !hasHarness(a));
	const hasSystemArms = systemArms.length > 0;
	const pureSystemComparison = hasSystemArms && configArms.length === 0;

	for (const arm of configArms) {
		const armYml = path.join(armsDir(), `${arm}.yml`);
		if (!fs.existsSync(armYml)) {
			throw new UnknownArmError(
				`error: unknown arm "${arm}". Not a system adapter and no arms/${arm}.yml found. ` +
					`Available systems: ${listHarnessNames().join(", ")}`,
			);
		}
	}

	// No model default: the run's tokens, spend and pass rate all belong to whichever
	// model ran, and a substituted one reports another model's numbers under this run's
	// name.
	if (!args.model) {
		throw new MissingModelError("error: --model <provider/model-id> is required.");
	}
	const model = args.model;
	const repeats = args.repeats ?? 1;
	const jobParallel = args.jobs ?? 2;

	let trialTimeoutOverrideSec: number | undefined;
	try {
		trialTimeoutOverrideSec = parseTrialTimeoutFlag(args.trialTimeout);
	} catch (err) {
		throw new InvalidTrialTimeoutError(`error: ${errorMessage(err)}`);
	}

	const limit = args.limit;
	const outRoot = resolvePackagePath(
		args.outDir ?? path.join(runsDir(), new Date().toISOString().replace(/[:.]/g, "-")),
	);
	const comparisonTaskList = comparisonTaskListPath();
	const taskListFile = args.tasksFile
		? resolvePackagePath(args.tasksFile)
		: pureSystemComparison
			? comparisonTaskList
			: undefined;

	let tasks: string[];
	let taskSetProvenance: TaskSetProvenance;
	if (taskListFile) {
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
	if (limit !== undefined && limit < totalTasksAvailable) {
		tasks = selectTasks(tasks, limit);
		console.error(
			`note: --limit ${limit} selects ${tasks.length} of ${totalTasksAvailable} tasks as an even-stride ` +
				`representative sample; the reported pass rate covers this subset, not the full suite.`,
		);
	}
	if (tasks.length === 0) {
		throw new NoTasksSelectedError("no tasks selected");
	}

	const pin = resolveBinaryPin(args.raw.binary);
	if (pin.kind === "invalid") {
		throw new InvalidBinaryPinError(`error: ${pin.reason}`);
	}
	const pinnedBinary = pin.kind === "pinned" ? pin.path : null;
	if (pinnedBinary) {
		requireFile(pinnedBinary, "point --binary at a previous run's assets/vey");
		console.log(`binary PINNED to ${pinnedBinary} (sha256 ${sha256File(pinnedBinary).slice(0, 12)}).`);
	} else if (!args.dryRun) {
		await ensureBinaryUpToDate();
	} else {
		const status = checkBinaryBuildNeeded();
		if (status.needsBuild) {
			console.log(
				`deep-swe: [dry-run] binary build needed (${status.reason === "missing" ? "missing binary" : "stale binary"} at ${status.binaryPath}). Build command: ${status.buildCommand}`,
			);
		}
	}

	if (!args.dryRun) {
		ensureAuthDbSeeded();
	}
	const authDbToProbe =
		args.dryRun && !fs.existsSync(getAuthDbPath()) ? (AUTH_DB_SOURCES[0] ?? getAuthDbPath()) : getAuthDbPath();
	await requireStagedAuthCanServeToken(model, Boolean(args.dryRun), authDbToProbe);
	if (!args.dryRun) {
		requireFile(pinnedBinary ?? getVeyBinaryPath(), "build it: cd ../coding-agent && bun scripts/build-binary.ts");
	}
	const trialTimeouts = new Map<string, ResolvedTrialTimeout>();
	for (const task of tasks) {
		const taskToml = path.join(tasksRoot, task, "task.toml");
		requireFile(taskToml, `no such DeepSWE task: ${task}`);
		try {
			const budget = parseTaskTimeBudget(fs.readFileSync(taskToml, "utf8"), task);
			trialTimeouts.set(task, resolveTrialTimeout(budget, trialTimeoutOverrideSec));
		} catch (err) {
			throw new InvalidTaskBudgetError(`error: ${errorMessage(err)}`);
		}
	}

	const replayManifests = new Map<string, LoadedReplayManifest>();
	if (hasSystemArms && args.raw["replay-root"]) {
		const replayRoot = path.resolve(args.raw["replay-root"]);
		for (const task of tasks) {
			const loaded = loadReplayManifest(path.join(replayRoot, `${task}.json`), model);
			replayManifests.set(task, loaded);
		}
	}

	const truncation = truncationWarning(trialTimeouts);
	if (truncation) console.error(truncation);

	const pier = Bun.which("pier") ?? `${os.homedir()}/.local/bin/pier`;
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

	const assetsDir = path.join(outRoot, "assets");
	fs.mkdirSync(assetsDir, { recursive: true });
	const effectiveBinary = pinnedBinary ?? getVeyBinaryPath();
	const binarySha = sha256File(effectiveBinary);
	fs.copyFileSync(effectiveBinary, path.join(assetsDir, "vey"));
	fs.chmodSync(path.join(assetsDir, "vey"), 0o755);
	fs.copyFileSync(getAuthDbPath(), path.join(assetsDir, "auth-agent.db"));

	for (const sys of systemArms) {
		const adapter = getHarness(sys);
		if (!adapter) continue;
		if (adapter.validatePreflight) {
			const preflight = await adapter.validatePreflight({
				system: sys,
				model,
				args: args.raw,
				dryRun: Boolean(args.dryRun),
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
			args: args.raw,
			model,
		});
	}

	const { armTemperature, armFingerprints } = stageAllArms({
		arms,
		benchDir,
		armsDir: armsDir(),
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
	// One slot per arm means the same (task, repeat) cell can run its whole arm set
	// together, so no arm races ahead into a different provider load or cache state.
	const pairedWaveScheduling = jobParallel === arms.length;

	console.log(
		`deep-swe: ${arms.length} arm(s) x ${tasks.length} task(s)` +
			`${repeats > 1 ? ` x ${repeats} repeat(s)` : ""} = ${queue.length} run(s), model ${model}`,
	);
	console.log(`assets: ${assetsDir} (binary sha256 ${binarySha.slice(0, 12)}) → jobs under ${outRoot}`);
	console.log(
		`scheduling: ${pairedWaveScheduling ? `paired waves of ${arms.length} arm(s) per task` : `worker pool of ${clampLow(jobParallel, 1, totalQueued)} trial(s)`}`,
	);

	if (args.dryRun) {
		console.log("\nDRY RUN — every pre-run guard passed. No container was started and no report written.\n");
		console.log(`  model      ${model}`);
		console.log(`  tasks      ${tasks.length} from ${args.tasksFile ?? "(full corpus)"}`);
		console.log(`  arms       ${arms.join(", ")}`);
		return;
	}

	const provenance = {
		model,
		binarySha,
		comparison: pureSystemComparison
			? {
					systems: systemArms,
					taskList: args.tasksFile ?? COMPARISON_TASK_LIST,
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
		taskSet: { file: args.tasksFile ?? (pureSystemComparison ? COMPARISON_TASK_LIST : null), ...taskSetProvenance },
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

		const adapter = getHarness(arm);
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
			// A config arm is a veyyon run under a different settings file, so it executes the
			// veyyon harness with the arm name as its only distinguishing kwarg.
			agent = [
				`  - import_path: ${requirePierAgentImportPath(requireHarness("veyyon"))}`,
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
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			proc.kill();
		}, trialTimeoutSec * 1000);

		const exitCode = await proc.exited;
		clearTimeout(timer);
		const stdout = await readPipeText(proc.stdout);
		const stderr = await readPipeText(proc.stderr);

		let result: ComparisonArmResult;
		try {
			if (timedOut) throw new Error(`trial timed out after ${trialTimeoutSec}s`);
			const isSystemArm = hasHarness(arm);
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
		if (hasHarness(arm)) result.agentSeconds = (Date.now() - started) / 1000;
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
			systemComparison = aggregateSystemComparison(comparisonTrialsFromArmResults(results), orderedTasks, model);
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
}
