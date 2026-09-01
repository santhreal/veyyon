#!/usr/bin/env bun

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getEnumValues, getType, isSettingPath } from "@veyyon/coding-agent/config/settings-schema";
import { readPipeText } from "@veyyon/utils";
import YAML from "yaml";
import {
	type ArmResult,
	armCanaryFailure,
	effectiveTemperature,
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
} from "./aggregate";
import {
	ARM_ATTACHMENT_KINDS,
	type ArmAttachmentManifestEntry,
	type ArmAttachmentValues,
	isArmAttachmentError,
	mappingOf,
	readArmAttachment,
	stageArmAttachment,
	writeArmAttachmentManifest,
} from "./arm-attachments";
import { armNamesIn, armSelectionError, computeArmFingerprint, findZeroIvCollisions } from "./arm-fingerprint";
import { formatArmPrediction, predictArmSaving } from "./arm-prediction";
import { promptOverrideIdError } from "./arm-prompts";
import { resolveBinaryPin } from "./binary-pin";
import { conversationCollapsed, measureRunPrefix, PREFIX_CATEGORIES, prefixShares } from "./prefix-composition";
import { type LoadedReplayManifest, loadReplayManifest } from "./replay-manifest";
import {
	AUTH_DB,
	BENCH_DIR,
	ensureAuthDbSeeded,
	ensureBinaryUpToDate,
	parseArgs,
	parseTrialResult,
	requireFile,
	requireStagedAuthCanServeToken,
	sha256File,
	type TrialComparisonContext,
	VEY_BINARY,
} from "./run-helpers";
import {
	aggregateSystemComparison,
	COMPARISON_MODEL,
	COMPARISON_SYSTEMS,
	COMPARISON_TASK_LIST,
	COMPARISON_TASK_LIST_SHA256,
	type ComparisonArmResult,
	type ComparisonExecution,
	type ComparisonSystem,
	comparisonTrialsFromArmResults,
	DEFAULT_MODEL,
	renderSystemComparison,
	type SystemComparison,
} from "./system-comparison";
import {
	encodeArmModelMismatch,
	encodePreambleSilentlyDropped,
	isEncodeArm,
	mistypedArmSettings,
	unknownArmSettings,
} from "./treatment-guard";
import {
	parseTaskTimeBudget,
	parseTrialTimeoutFlag,
	type ResolvedTrialTimeout,
	resolveTrialTimeout,
	truncationWarning,
} from "./trial-timeout";

function reaggregate(runDir: string): void {
	const configDir = path.join(runDir, "configs");
	const jobsRoot = path.join(runDir, "jobs");
	let prior: Record<string, any> | null = null;
	try {
		prior = JSON.parse(fs.readFileSync(path.join(runDir, "results.json"), "utf8"));
	} catch {}
	const priorByCell = new Map<string, ComparisonArmResult>(
		((prior?.results ?? []) as ComparisonArmResult[]).map(result => [
			`${result.arm}\u0000${result.task}\u0000${result.repeat}`,
			result,
		]),
	);
	const results: ComparisonArmResult[] = [];
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
			comparisonRejection = error instanceof Error ? error.message : String(error);
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
		console.error(
			`\n${comparisonRejection}\nRaw results and artifacts were retained; no comparison report was written.`,
		);
		process.exit(1);
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

function mergeIntoReport(runDirs: string[], outDir: string | null): void {
	if (runDirs.length < 2) {
		console.error(`--merge needs at least two run directories, got ${runDirs.length}.`);
		process.exit(1);
	}
	const runs: RunToMerge[] = [];
	for (const dir of runDirs) {
		const file = path.join(dir, "results.json");
		if (!fs.existsSync(file)) {
			console.error(`missing: ${file}\nRun --reaggregate on that directory first.`);
			process.exit(1);
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
			console.error(`refusing to merge: ${err.message}`);
			process.exit(1);
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

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	if (args.reaggregate) {
		reaggregate(path.resolve(args.reaggregate));
		return;
	}
	if (args.merge) {
		mergeIntoReport(
			args.merge
				.split(",")
				.map(dir => dir.trim())
				.filter(Boolean)
				.map(dir => path.resolve(dir)),
			args.out ? path.resolve(args.out) : null,
		);
		return;
	}
	const localTasks = path.join(BENCH_DIR, "deep-swe", "tasks");
	const tasksRootArg =
		args["tasks-root"] ?? process.env.DEEPSWE_TASKS_ROOT ?? (fs.existsSync(localTasks) ? localTasks : undefined);
	if (!tasksRootArg) {
		console.error("pass --tasks-root <dir> (or clone https://github.com/datacurve-ai/deep-swe into this package)");
		process.exit(1);
	}
	const tasksRoot = path.resolve(BENCH_DIR, tasksRootArg);
	const comparisonMode = args.systems !== undefined;
	if (comparisonMode && args.arms !== undefined) {
		console.error("error: --systems and --arms are mutually exclusive");
		process.exit(1);
	}
	const armsArg = comparisonMode ? args.systems : (args.arms ?? "baseline,full");
	const arms = (armsArg ?? "")
		.split(",")
		.map(a => a.trim())
		.filter(Boolean);
	if (arms.length === 0) {
		console.error(`error: --${comparisonMode ? "systems" : "arms"} must specify at least one name`);
		process.exit(1);
	}
	if (comparisonMode) {
		const selected = new Set(arms);
		const invalid = arms.filter(arm => !COMPARISON_SYSTEMS.includes(arm as ComparisonSystem));
		const missing = COMPARISON_SYSTEMS.filter(system => !selected.has(system));
		if (invalid.length > 0 || missing.length > 0 || selected.size !== arms.length) {
			console.error(
				`error: --systems must name each comparison arm exactly once: ${COMPARISON_SYSTEMS.join(",")} ` +
					`(invalid: ${invalid.join(",") || "none"}; missing: ${missing.join(",") || "none"})`,
			);
			process.exit(1);
		}
	}
	const model = args.model ?? (comparisonMode ? COMPARISON_MODEL : DEFAULT_MODEL);
	if (comparisonMode && model !== COMPARISON_MODEL) {
		console.error(`error: cross-system comparisons require exact model ${COMPARISON_MODEL}, got ${model}`);
		process.exit(1);
	}
	const rawRepeats = Number(args.repeats ?? "1");
	if (!Number.isFinite(rawRepeats) || rawRepeats < 1 || !Number.isInteger(rawRepeats)) {
		console.error(`error: --repeats must be a positive integer (got ${JSON.stringify(args.repeats)})`);
		process.exit(1);
	}
	const repeats = rawRepeats;
	const rawJobs = Number(args.jobs ?? "2");
	const jobParallel = Number.isFinite(rawJobs) && rawJobs > 0 ? Math.floor(rawJobs) : 2;
	let trialTimeoutOverrideSec: number | undefined;
	try {
		trialTimeoutOverrideSec = parseTrialTimeoutFlag(args["trial-timeout"]);
	} catch (err) {
		console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
		process.exit(1);
	}
	let limit: number | undefined;
	if (args.limit !== undefined) {
		const parsedLimit = Number(args.limit);
		if (!Number.isInteger(parsedLimit) || parsedLimit <= 0) {
			console.error(`error: --limit must be a positive integer (got ${JSON.stringify(args.limit)})`);
			process.exit(1);
		}
		limit = parsedLimit;
	}
	if (comparisonMode && limit !== undefined) {
		console.error(
			`error: cross-system comparisons use all tasks from ${COMPARISON_TASK_LIST}; --limit is not allowed`,
		);
		process.exit(1);
	}
	const outRoot = path.resolve(
		args.out ?? path.join(BENCH_DIR, "runs", new Date().toISOString().replace(/[:.]/g, "-")),
	);
	const comparisonTaskList = path.resolve(BENCH_DIR, COMPARISON_TASK_LIST);
	const taskListFile = args.tasks
		? path.resolve(BENCH_DIR, args.tasks)
		: comparisonMode
			? comparisonTaskList
			: undefined;
	if (comparisonMode && taskListFile !== comparisonTaskList) {
		console.error(`error: initial cross-system comparisons must use ${COMPARISON_TASK_LIST} unchanged`);
		process.exit(1);
	}
	let tasks: string[];
	let taskSetProvenance: TaskSetProvenance;
	if (taskListFile) {
		const content = fs.readFileSync(taskListFile, "utf8");
		if (comparisonMode && createHash("sha256").update(content).digest("hex") !== COMPARISON_TASK_LIST_SHA256) {
			console.error(`error: ${COMPARISON_TASK_LIST} changed; restore the pinned shared task list before comparison`);
			process.exit(1);
		}
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
	if (comparisonMode && tasks.length !== 10) {
		console.error(
			`error: ${COMPARISON_TASK_LIST} must contain the unchanged shared 10-task set; found ${tasks.length}`,
		);
		process.exit(1);
	}
	const totalTasksAvailable = tasks.length;
	if (limit !== undefined && limit < totalTasksAvailable) {
		tasks = selectTasks(tasks, limit);
		console.error(
			`note: --limit ${limit} selects ${tasks.length} of ${totalTasksAvailable} tasks as an even-stride ` +
				`representative sample; the reported pass rate covers this subset, not the full suite ` +
				`(the exact task list is recorded in results.json).`,
		);
	}
	if (tasks.length === 0) {
		console.error("no tasks selected");
		process.exit(1);
	}

	const pin = resolveBinaryPin(args.binary);
	if (pin.kind === "invalid") {
		console.error(`error: ${pin.reason}`);
		process.exit(1);
	}
	const pinnedBinary = pin.kind === "pinned" ? pin.path : null;
	if (pinnedBinary) {
		requireFile(pinnedBinary, "point --binary at a previous run's assets/vey");
		console.log(
			`binary PINNED to ${pinnedBinary} (sha256 ${sha256File(pinnedBinary).slice(0, 12)}).\n` +
				`  The working tree is NOT rebuilt, so this run measures that binary's code, not today's.\n` +
				`  That is the point: it is what lets this run pool with the one it came from.`,
		);
	} else {
		await ensureBinaryUpToDate();
	}
	ensureAuthDbSeeded();
	await requireStagedAuthCanServeToken(model, args["dry-run"] !== undefined);
	requireFile(pinnedBinary ?? VEY_BINARY, "build it: cd ../coding-agent && bun scripts/build-binary.ts");
	if (comparisonMode) {
		requireFile(path.join(BENCH_DIR, "arms", "baseline.yml"), "the Veyyon comparison arm requires arms/baseline.yml");
	} else {
		for (const arm of arms) {
			requireFile(path.join(BENCH_DIR, "arms", `${arm}.yml`), `create arms/${arm}.yml`);
		}
	}
	const trialTimeouts = new Map<string, ResolvedTrialTimeout>();
	for (const task of tasks) {
		const taskToml = path.join(tasksRoot, task, "task.toml");
		requireFile(taskToml, `no such DeepSWE task: ${task}`);
		try {
			const budget = parseTaskTimeBudget(fs.readFileSync(taskToml, "utf8"), task);
			trialTimeouts.set(task, resolveTrialTimeout(budget, trialTimeoutOverrideSec));
		} catch (err) {
			console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
			process.exit(1);
		}
	}
	const replayManifests = new Map<string, LoadedReplayManifest>();
	if (comparisonMode) {
		const replayRootArg = args["replay-root"];
		if (!replayRootArg) {
			console.error(
				"error: --systems requires --replay-root <absolute-dir> with one validated <task>.json real-session manifest per task",
			);
			process.exit(1);
		}
		const replayRoot = path.resolve(replayRootArg);
		for (const task of tasks) {
			const loaded = loadReplayManifest(path.join(replayRoot, `${task}.json`));
			replayManifests.set(task, loaded);
		}
	}
	const truncation = truncationWarning(trialTimeouts);
	if (truncation) console.error(truncation);
	const undeclaredPhases = [...trialTimeouts].filter(([, r]) => r.missingPhases.length > 0);
	if (undeclaredPhases.length > 0) {
		const [firstTask, firstResolved] = undeclaredPhases[0] as [string, ResolvedTrialTimeout];
		console.error(
			`warning: ${undeclaredPhases.length} task(s) declare no budget for some trial phase ` +
				`(e.g. ${firstTask} omits ${firstResolved.missingPhases.join(", ")}); those phases contribute 0s ` +
				`to the derived trial timeout.`,
		);
	}
	const pier = Bun.which("pier") ?? `${os.homedir()}/.local/bin/pier`;
	if (!fs.existsSync(pier)) {
		console.error("pier not found on PATH or ~/.local/bin — uv tool install datacurve-pier");
		process.exit(1);
	}
	let factoryBinary: string | null = null;
	let factoryBinarySha: string | null = null;
	let factoryAuth: string | null = null;
	let factorySettings: string | null = null;
	let hermesAuth: string | null = null;
	if (comparisonMode) {
		factoryBinary = args["factory-binary"] ? path.resolve(args["factory-binary"]) : (Bun.which("droid") ?? null);
		if (!factoryBinary) {
			console.error("error: Factory CLI binary unavailable; pass --factory-binary or install droid on PATH");
			process.exit(1);
		}
		requireFile(factoryBinary, "Factory comparison cannot fall back to another agent or binary");
		if (!fs.statSync(factoryBinary).isFile()) {
			console.error(`error: Factory CLI path is not a file: ${factoryBinary}`);
			process.exit(1);
		}
		factoryBinarySha = sha256File(factoryBinary);
		factoryAuth = args["factory-auth"] ? path.resolve(args["factory-auth"]) : null;
		if (!factoryAuth) {
			console.error("error: Factory auth unavailable; pass --factory-auth <nonempty API-key file>");
			process.exit(1);
		}
		requireFile(factoryAuth, "Factory comparison requires an explicit credential path");
		if (!fs.statSync(factoryAuth).isFile()) {
			console.error(`error: Factory auth path is not a file: ${factoryAuth}`);
			process.exit(1);
		}
		if (fs.statSync(factoryAuth).size === 0) {
			console.error(`error: Factory auth file is empty: ${factoryAuth}`);
			process.exit(1);
		}
		if (args["factory-settings"]) {
			factorySettings = path.resolve(args["factory-settings"]);
			requireFile(factorySettings, "Factory settings path was supplied but is unavailable");
			if (!fs.statSync(factorySettings).isFile()) {
				console.error(`error: Factory settings path is not a file: ${factorySettings}`);
				process.exit(1);
			}
		}
		hermesAuth = args["hermes-auth"] ? path.resolve(args["hermes-auth"]) : null;
		if (!hermesAuth) {
			console.error("error: Hermes auth unavailable; pass --hermes-auth <nonempty .env file>");
			process.exit(1);
		}
		requireFile(hermesAuth, "Hermes comparison requires an explicit credential path");
		if (!fs.statSync(hermesAuth).isFile()) {
			console.error(`error: Hermes auth path is not a file: ${hermesAuth}`);
			process.exit(1);
		}
		if (fs.statSync(hermesAuth).size === 0) {
			console.error(`error: Hermes auth file is empty: ${hermesAuth}`);
			process.exit(1);
		}
	}

	const binarySha = sha256File(pinnedBinary ?? VEY_BINARY);

	const assetsDir = path.join(outRoot, "assets");
	fs.mkdirSync(path.join(assetsDir, "arms"), { recursive: true });
	fs.copyFileSync(pinnedBinary ?? VEY_BINARY, path.join(assetsDir, "vey"));
	fs.chmodSync(path.join(assetsDir, "vey"), 0o755);
	fs.copyFileSync(AUTH_DB, path.join(assetsDir, "auth-agent.db"));
	if (comparisonMode) {
		fs.copyFileSync(factoryBinary!, path.join(assetsDir, "droid"));
		fs.chmodSync(path.join(assetsDir, "droid"), 0o755);
		fs.copyFileSync(factoryAuth!, path.join(assetsDir, "factory-api-key"));
		fs.chmodSync(path.join(assetsDir, "factory-api-key"), 0o600);
		if (factorySettings) fs.copyFileSync(factorySettings, path.join(assetsDir, "settings.json"));
		fs.copyFileSync(hermesAuth!, path.join(assetsDir, "hermes.env"));
		fs.chmodSync(path.join(assetsDir, "hermes.env"), 0o600);
	}
	if (!comparisonMode) {
		const available = armNamesIn(fs.readdirSync(path.join(BENCH_DIR, "arms")));
		for (const arm of arms) {
			const problem = armSelectionError(arm, available);
			if (problem !== null) {
				console.error(`error: ${problem}`);
				process.exit(1);
			}
		}
	}
	const armFingerprints = new Map<string, string>();
	const armTemperature = new Map<string, number>();
	const encodeArms = new Set<string>();
	const stagedAttachments = new Map<string, readonly ArmAttachmentManifestEntry[]>();
	for (const arm of arms) {
		if (comparisonMode && arm !== "veyyon") {
			armTemperature.set(arm, PINNED_TEMPERATURE);
			armFingerprints.set(arm, createHash("sha256").update(`system-adapter:${arm}`).digest("hex"));
			stagedAttachments.set(arm, []);
			continue;
		}
		const configArm = comparisonMode ? "baseline" : arm;
		const ymlText = fs.readFileSync(path.join(BENCH_DIR, "arms", `${configArm}.yml`), "utf8");
		let config: unknown;
		try {
			config = YAML.parse(ymlText) ?? {};
		} catch (err) {
			console.error(`error: arm "${arm}" has invalid YAML in arms/${arm}.yml:\n${err}`);
			process.exit(1);
		}
		if (config === null || typeof config !== "object" || Array.isArray(config)) {
			console.error(
				`error: arm "${arm}" arms/${arm}.yml must be a mapping of setting -> value, ` +
					`got ${Array.isArray(config) ? "a sequence" : typeof config}.`,
			);
			process.exit(1);
		}
		const mistyped = mistypedArmSettings(config, path =>
			isSettingPath(path) ? { kind: getType(path), values: getEnumValues(path) } : undefined,
		);
		if (mistyped.length > 0) {
			console.error(
				`error: arm "${arm}" arms/${arm}.yml sets ${mistyped.length} key(s) to a value the settings\n` +
					`schema would reject:\n` +
					mistyped.map(m => `  ${m.path}: expected ${m.expected}, got ${m.actual}`).join("\n") +
					`\nAn unusable value is merged and then ignored, so the arm would run as the\n` +
					`control while claiming a treatment. Note that YAML reads bare yes/no/on/off\n` +
					`as booleans and quoted "0.1" as a string.`,
			);
			process.exit(1);
		}
		const unknown = unknownArmSettings(config, isSettingPath);
		if (unknown.length > 0) {
			console.error(
				`error: arm "${arm}" arms/${arm}.yml sets ${unknown.length} key(s) that are not veyyon settings:\n` +
					unknown.map(p => `  ${p}`).join("\n") +
					`\nAn unknown key is merged and never read, so the arm would run as the\n` +
					`control while claiming a treatment. Check the spelling against\n` +
					`docs/handbook/src/reference/settings-reference.md, or remove the key.`,
			);
			process.exit(1);
		}
		const temperature = effectiveTemperature(config);
		(config as Record<string, unknown>).temperature = temperature;
		armTemperature.set(arm, temperature);
		if (isEncodeArm(config)) encodeArms.add(arm);
		fs.writeFileSync(path.join(assetsDir, "arms", `${arm}.yml`), YAML.stringify(config));
		const mismatch = encodeArmModelMismatch(config, model);
		if (mismatch !== null) {
			console.error(
				`error: arm "${arm}" enables argot encoding with an allowlist that does not\n` +
					`include the model under test, so it would SILENTLY degrade to decode-only\n` +
					`and measure the wrong condition:\n` +
					`  arms/${arm}.yml argot.models = [${mismatch.join(", ")}]\n` +
					`  --model = ${model}\n` +
					`Fix: add the model to arms/${arm}.yml argot.models (a bare name like\n` +
					`"${model.slice(model.lastIndexOf("/") + 1)}" matches any provider), or bench a --model the arm\n` +
					`already lists, or use arms/decode.yml if you meant the decode-only condition.`,
			);
			process.exit(1);
		}
		const attachments: ArmAttachmentValues = {};
		const staged: ArmAttachmentManifestEntry[] = [];
		for (const kind of ARM_ATTACHMENT_KINDS) {
			const read = readArmAttachment(kind, path.join(BENCH_DIR, "arms"), arm, configArm);
			if (isArmAttachmentError(read)) {
				console.error(`error: ${read.error}`);
				process.exit(1);
			}
			if (!read.present) continue;
			if (kind.field === "prompts") {
				const problem = promptOverrideIdError(arm, mappingOf(read.payload) ?? {});
				if (problem !== null) {
					console.error(`error: ${problem}`);
					process.exit(1);
				}
			}
			attachments[kind.field] = ("mapping" in read.payload ? read.payload.mapping : read.payload.bytes) as never;
			staged.push(stageArmAttachment(kind, assetsDir, arm, read.payload));
		}
		stagedAttachments.set(arm, staged);
		armFingerprints.set(arm, computeArmFingerprint({ config, ...attachments }));
	}
	writeArmAttachmentManifest(assetsDir, stagedAttachments);
	if (arms.length >= 2) {
		const collisions = findZeroIvCollisions(armFingerprints);
		if (collisions.length > 0) {
			const detail = collisions.map(group => `  {${group.join(", ")}} reduce to identical inputs`).join("\n");
			console.error(
				"error: zero-IV arm collision — a controlled comparison must vary exactly one\n" +
					"independent variable, but these arms reduce to the same (config, sections, statements,\n" +
					`prompts, rule), so every delta between them is noise:\n${detail}\n` +
					"Fix: give each arm a distinct config, a distinct .sections.yml, a distinct\n" +
					".statements.yml, a distinct .prompts.yml, or a distinct .rule.md, or drop the redundant arm from --arms. See\n" +
					"README 'Single Independent Variable Rule'.",
			);
			process.exit(1);
		}
	}

	const comparisonExecutionByTask = new Map<string, ComparisonExecution>();
	if (comparisonMode) {
		for (const task of tasks) {
			const timeout = trialTimeouts.get(task);
			const replay = replayManifests.get(task);
			if (!timeout || !replay) throw new Error(`internal: incomplete comparison provenance for ${task}`);
			const instructionPath = path.join(tasksRoot, task, "instruction.md");
			requireFile(instructionPath, `task ${task} has no instruction.md`);
			comparisonExecutionByTask.set(task, {
				taskInstructionsHash: sha256File(instructionPath),
				repositoryStateHash: replay.manifest.repository_checkpoint_sha256,
				wallClockLimitSeconds: timeout.timeoutSec,
				temperature: PINNED_TEMPERATURE,
				samplingDescription:
					"temperature 0 where the native API exposes sampling; otherwise native fixed/default sampling",
			});
		}
	}
	const results: ComparisonArmResult[] = [];
	const queue = trialQueue(arms, tasks, repeats);
	const totalQueued = queue.length;
	const canarySize = Math.max(1, Math.min(Math.max(1, jobParallel), totalQueued));
	let canaryTripped = false;

	console.log(
		`deepswe-bench: ${arms.length} arm(s) x ${tasks.length} task(s)` +
			`${repeats > 1 ? ` x ${repeats} repeat(s)` : ""} = ${queue.length} run(s), model ${model}`,
	);
	console.log(`assets: ${assetsDir} (binary sha256 ${binarySha.slice(0, 12)}) → jobs under ${outRoot}`);
	const overrides = arms.filter(a => (armTemperature.get(a) ?? PINNED_TEMPERATURE) !== PINNED_TEMPERATURE);
	console.log(
		`sampling: temperature pinned to ${PINNED_TEMPERATURE} (greedy) for every arm, stamped into results.json` +
			(overrides.length > 0
				? `; arm(s) with an explicit override: ${overrides.map(a => `${a}=${armTemperature.get(a)}`).join(", ")}`
				: ""),
	);

	if (args["dry-run"] !== undefined) {
		console.log("\nDRY RUN — every pre-run guard passed. No container was started and no report written.\n");
		console.log(`  model      ${model}`);
		const provenance = taskSetProvenance.marked
			? taskSetProvenance.biased
				? `@biased (never a headline)${taskSetProvenance.note ? ` — ${taskSetProvenance.note}` : ""}`
				: "@headline"
			: "UNMARKED (no @headline/@biased directive)";
		console.log(`  tasks      ${tasks.length} from ${args.tasks ?? "(full corpus)"}  ${provenance}`);
		console.log(`  arms       ${arms.length}`);
		for (const arm of arms) {
			const sectionsFile = path.join(BENCH_DIR, "arms", `${arm}.sections.yml`);
			const statementsFile = path.join(BENCH_DIR, "arms", `${arm}.statements.yml`);
			const promptsFile = path.join(BENCH_DIR, "arms", `${arm}.prompts.yml`);
			const ruleFile = path.join(BENCH_DIR, "arms", `${arm}.rule.md`);
			const parts = [
				`temp=${armTemperature.get(arm)}`,
				encodeArms.has(arm) ? "ENCODE" : "no-encode",
				fs.existsSync(sectionsFile) ? "sections" : null,
				fs.existsSync(statementsFile) ? "statements" : null,
				fs.existsSync(promptsFile) ? "prompts" : null,
				fs.existsSync(ruleFile) ? "rule" : null,
			].filter(Boolean);
			console.log(`    ${arm.padEnd(28)} ${parts.join(" ")}  fp=${(armFingerprints.get(arm) ?? "").slice(0, 12)}`);
		}
		console.log(
			`  queue      ${queue.length} run(s) = ${arms.length} arm(s) x ${tasks.length} task(s) x ${repeats} repeat(s)`,
		);
		console.log(`  staged     ${assetsDir}`);
		console.log("             (the exact bytes a container would mount; inspect them, then delete the dir)");
		console.log(`  would cost ${queue.length} trial(s) of real model quota\n`);
		console.log("Re-run without --dry-run to execute.");
		process.exit(0);
	}

	const provenance = {
		model,
		binarySha,
		comparison: comparisonMode
			? {
					systems: COMPARISON_SYSTEMS,
					taskList: COMPARISON_TASK_LIST,
					replayManifests: Object.fromEntries(
						tasks.map(task => [task, replayManifests.get(task)?.sha256 ?? null]),
					),
					factoryBinarySha,
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
		taskSet: { file: args.tasks ?? (comparisonMode ? COMPARISON_TASK_LIST : null), ...taskSetProvenance },
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
		let agent: string[];
		if (!comparisonMode || arm === "veyyon") {
			agent = [
				"  - import_path: veyyon_agent:VeyyonAgent",
				`    model_name: ${JSON.stringify(model)}`,
				"    kwargs:",
				`      arm_name: ${JSON.stringify(arm)}`,
				`      assets_dir: ${JSON.stringify(assetsDir)}`,
				`      binary_sha: ${JSON.stringify(binarySha)}`,
				`      prompt_template_path: ${JSON.stringify(path.join(BENCH_DIR, "pier_agent", "oneshot_prompt.md.j2"))}`,
				...(comparisonMode ? [`      replay_path: ${JSON.stringify(replayManifests.get(task)?.path)}`] : []),
			];
		} else if (arm === "factory") {
			agent = [
				"  - import_path: factory_agent:FactoryAgent",
				`    model_name: ${JSON.stringify(model)}`,
				"    kwargs:",
				`      assets_dir: ${JSON.stringify(assetsDir)}`,
				`      binary_sha: ${JSON.stringify(factoryBinarySha)}`,
				`      replay_path: ${JSON.stringify(replayManifests.get(task)?.path)}`,
			];
		} else {
			agent = [
				"  - import_path: hermes_agent:HermesAgent",
				`    model_name: ${JSON.stringify(model)}`,
				"    kwargs:",
				`      replay_path: ${JSON.stringify(replayManifests.get(task)?.path)}`,
				`      auth_path: ${JSON.stringify(path.join(assetsDir, "hermes.env"))}`,
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
				await Bun.spawn(["sh", "-c", `docker rm -f $(docker ps -aq --filter name=${jobName}) 2>/dev/null || true`])
					.exited;
				await Bun.spawn(["docker", "network", "prune", "-f"]).exited;
			} catch {}
		}
		const started = Date.now();
		const proc = Bun.spawn([pier, "run", "-c", writeJobConfig(arm, task, repeat), "-q"], {
			cwd: path.join(BENCH_DIR, "pier_agent"),
			env: { ...process.env, PYTHONPATH: path.join(BENCH_DIR, "pier_agent") },
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
			const comparisonContext: TrialComparisonContext | null = comparisonMode
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
				console.log(
					`[retry] ${jobName} hit container startup collision; pruning docker network & retrying (attempt 2)...`,
				);
				return await runOne(arm, task, repeat, 2);
			}
			result = { ...emptyArmResult(arm, task, repeat), error: errStr };
		}
		if (comparisonMode) result.agentSeconds = (Date.now() - started) / 1000;
		results.push(result);
		const mark = result.error ? "ERROR" : result.reward === 1 ? "pass" : `reward=${result.reward}`;
		console.log(
			`[${results.length}/${totalQueued}] ${jobName}: ${mark} out=${result.outputTokens ?? "?"}tok cost=$${result.costUsd?.toFixed(3) ?? "?"} (${((Date.now() - started) / 1000).toFixed(0)}s)`,
		);
		const quotaStop = !canaryTripped ? providerQuotaStop(result.error) : null;
		if (quotaStop) {
			canaryTripped = true;
			const until = quotaStop.resetAt ? ` Quota resets at ${quotaStop.resetAt}.` : "";
			const which = quotaStop.model ? ` for model "${quotaStop.model}"` : "";
			console.error(
				`\nABORTING: the provider refused on quota${which} (HTTP 429 RESOURCE_EXHAUSTED).${until} ` +
					`Every one of the ${queue.length} remaining trials would fail the same way and produce no ` +
					`tokens, leaving a comparison against arms with missing samples. ${results.length} trials ` +
					`completed before the stop; their jobs are on disk and can be reaggregated. Rerun after the ` +
					`reset, or point --model at a credential with quota left. No report was written.`,
			);
		}
		if (!canaryTripped && shouldTripCanary(results, canarySize)) {
			canaryTripped = true;
			const hardErrors = results.filter(isHardError).map(r => r.error ?? "");
			console.error(
				`\nABORTING: the first ${results.length} trials ALL failed before the agent produced any output ` +
					`(0 successful runs). This is a systematic config failure, not task flakiness — the remaining ` +
					`${queue.length} queued trials would fail identically. Most common agent-side reason:\n\n` +
					`  ${mostCommonAgentReason(hardErrors)}\n\n` +
					`Fix the config (model id must be servable in the sandbox; see run.ts) and rerun. No report was written.`,
			);
		}
		if (!canaryTripped) {
			const deadArm = armCanaryFailure(results, canarySize);
			if (deadArm !== undefined) {
				canaryTripped = true;
				const armErrors = results.filter(r => r.arm === deadArm && isHardError(r)).map(r => r.error ?? "");
				console.error(
					`\nABORTING: every one of the ${armErrors.length} completed trials for arm "${deadArm}" failed before ` +
						`the agent produced any output. Other arms are running, so this is not a global config failure — ` +
						`it is "${deadArm}" specifically, and the remaining ${queue.length} queued trials would leave you ` +
						`with a comparison against an arm that produced nothing. Most common agent-side reason:\n\n` +
						`  ${mostCommonAgentReason(armErrors)}\n\n` +
						`Fix that arm's config and rerun. No report was written.`,
				);
			}
		}
	}

	const workers = Array.from({ length: Math.max(1, jobParallel) }, async () => {
		for (;;) {
			if (canaryTripped) return;
			const next = queue.shift();
			if (!next) return;
			await runOne(next.arm, next.task, next.repeat);
		}
	});
	await Promise.all(workers);

	if (canaryTripped) {
		process.exit(1);
	}

	results.sort((a, b) => a.arm.localeCompare(b.arm) || a.task.localeCompare(b.task) || a.repeat - b.repeat);
	let systemComparison: SystemComparison | null = null;
	let comparisonRejection: string | null = null;
	if (comparisonMode) {
		try {
			systemComparison = aggregateSystemComparison(comparisonTrialsFromArmResults(results), tasks, model);
		} catch (error) {
			comparisonRejection = error instanceof Error ? error.message : String(error);
		}
	}
	fs.writeFileSync(
		path.join(outRoot, "results.json"),
		JSON.stringify(
			{
				model,
				binarySha,
				comparison: comparisonMode
					? {
							run: provenance.comparison,
							aggregate: systemComparison,
							rejected: comparisonRejection,
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
				taskSet: { file: args.tasks ?? (comparisonMode ? COMPARISON_TASK_LIST : null), ...taskSetProvenance },
				arms,
				tasks,
				repeats,
				incomplete: false,
				results,
			},
			null,
			2,
		),
	);
	if (comparisonRejection) {
		console.error(
			`\n${comparisonRejection}\nRaw results and artifacts were retained; no comparison report was written.`,
		);
		process.exit(1);
	}
	const report = systemComparison
		? renderSystemComparison(systemComparison)
		: renderReport(results, model, new Date().toISOString(), repeats, taskSetProvenance);
	fs.writeFileSync(path.join(outRoot, "report.md"), report);
	console.log(`\nwrote ${path.join(outRoot, "report.md")} and results.json`);

	if (systemComparison) {
		if (systemComparison.overall !== "pass") process.exitCode = 1;
	} else {
		reportPredictedVsActual(outRoot, arms, results);
	}

	const degraded: string[] = [];
	for (const arm of encodeArms) {
		const flags = results.filter(r => r.arm === arm && !r.error).map(r => r.argotPreamblePresent);
		if (encodePreambleSilentlyDropped(flags)) degraded.push(arm);
	}
	if (degraded.length > 0) {
		console.error(
			`\nerror: encode arm(s) [${degraded.join(", ")}] never taught the argot preamble in ANY\n` +
				`OK trial, so they SILENTLY ran decode-only and every token delta against them is inert.\n` +
				`The likely cause is a model-id resolution mismatch: the requested --model = ${model}\n` +
				`resolves through the catalog to a different logical id that is not on the arm's\n` +
				`argot.models allowlist. Check the run's session_init model vs arms/<arm>.yml argot.models,\n` +
				`and set the allowlist to the RESOLVED logical id (see report.md "Argot treatment applied?").`,
		);
		process.exitCode = 1;
	}
}

function reportPredictedVsActual(runDir: string, arms: string[], results: ArmResult[]): void {
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

await main();
