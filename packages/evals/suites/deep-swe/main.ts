import * as fs from "node:fs";
import * as path from "node:path";
import { errorMessage } from "@veyyon/utils";
import type {
	BackendId,
	EvalSuite,
	PreflightVerdict,
	SuiteContext,
	SuiteProvenance,
	SuiteReportContext,
	TaskDescriptor,
	TrialArtifacts,
	TrialCell,
	TrialScore,
	TrialUsage,
} from "../../engine/contracts";
import { comparisonTaskListPath, resolvePackagePath, taskCorpusDir, taskListsDir } from "../../engine/package-paths";
import { parseTaskListProvenance } from "./aggregate/merge";
import { resolveBinaryPin } from "./binary-pin";
import { reaggregate } from "./runner/executor";
import { checkBinaryBuildNeeded } from "./runner/preflight";
import { parseTrialResult } from "./runner/trial-result";
import { budgetedTrialTimeoutSec, parseTaskTimeBudget } from "./trial-timeout";

export class DeepSweSuite implements EvalSuite {
	readonly id = "deep-swe";
	readonly version = "1.0.0";
	readonly displayName = "DeepSWE";
	readonly description =
		"DeepSWE benchmark runner for evaluating coding agents on realistic software engineering tasks.";
	readonly backend: BackendId = "pier";

	async discoverTasks(context: SuiteContext): Promise<readonly string[]> {
		const options = context.options ?? {};
		const tasksFile =
			typeof options.tasksFile === "string"
				? resolvePackagePath(options.tasksFile)
				: typeof options.taskList === "string"
					? resolvePackagePath(options.taskList)
					: null;

		if (tasksFile && fs.existsSync(tasksFile)) {
			const content = fs.readFileSync(tasksFile, "utf8");
			return content
				.split("\n")
				.map(line => line.trim())
				.filter(line => line.length > 0 && !line.startsWith("#"));
		}

		if (Array.isArray(options.tasks)) {
			return (options.tasks as unknown[])
				.map(t => (typeof t === "string" ? t.trim() : ""))
				.filter(t => t.length > 0);
		}

		const tasksRoot = context.datasetDir ?? taskCorpusDir();
		if (fs.existsSync(tasksRoot)) {
			const entries = fs.readdirSync(tasksRoot, { withFileTypes: true });
			return entries
				.filter(d => d.isDirectory() && fs.existsSync(path.join(tasksRoot, d.name, "task.toml")))
				.map(d => d.name)
				.sort();
		}

		const defaultList = comparisonTaskListPath();
		if (fs.existsSync(defaultList)) {
			const content = fs.readFileSync(defaultList, "utf8");
			return content
				.split("\n")
				.map(line => line.trim())
				.filter(line => line.length > 0 && !line.startsWith("#"));
		}

		return [];
	}

	async describeTask(taskId: string, context: SuiteContext): Promise<TaskDescriptor> {
		const tasksRoot = context.datasetDir ?? taskCorpusDir();
		const taskDir = path.join(tasksRoot, taskId);
		const taskToml = path.join(taskDir, "task.toml");
		const instructionPath = path.join(taskDir, "instruction.md");

		let timeBudgetSec = 1800;
		if (fs.existsSync(taskToml)) {
			try {
				const content = fs.readFileSync(taskToml, "utf8");
				const budget = parseTaskTimeBudget(content, taskId);
				timeBudgetSec = budgetedTrialTimeoutSec(budget);
			} catch {
				/* use default */
			}
		}

		return {
			id: taskId,
			path: fs.existsSync(taskDir) ? taskDir : null,
			timeBudgetSec,
			instructionPath: fs.existsSync(instructionPath) ? instructionPath : null,
			metadata: {
				suite: this.id,
				taskDir,
				hasToml: fs.existsSync(taskToml),
				hasInstruction: fs.existsSync(instructionPath),
			},
		};
	}

	async provenance(context: SuiteContext): Promise<SuiteProvenance> {
		const options = context.options ?? {};
		const tasksFile = typeof options.tasksFile === "string" ? options.tasksFile : null;
		let taskSetInfo: { marked: boolean; biased: boolean; note: string | null } = {
			marked: true,
			biased: false,
			note: "full task corpus",
		};

		if (tasksFile && fs.existsSync(resolvePackagePath(tasksFile))) {
			const content = fs.readFileSync(resolvePackagePath(tasksFile), "utf8");
			taskSetInfo = parseTaskListProvenance(content);
		}

		return {
			suite: this.id,
			version: this.version,
			sourceUrl: "https://github.com/datacurve-ai/deep-swe",
			metadata: {
				taskListsDir: taskListsDir(),
				taskCorpusDir: taskCorpusDir(),
				taskSet: taskSetInfo,
			},
		};
	}

	async scoreTrial(cell: TrialCell, artifacts: TrialArtifacts): Promise<TrialScore> {
		const trialDir = artifacts.trialDir;
		if (!trialDir || !fs.existsSync(trialDir)) {
			const extraError = typeof artifacts.extra?.error === "string" ? artifacts.extra.error : null;
			return {
				reward: null,
				partial: null,
				error: extraError ?? "trial directory not found",
				usage: null,
				extra: artifacts.extra ?? {},
			};
		}

		try {
			// Find parent job dir or use trialDir parent
			const jobDir = path.dirname(trialDir);
			const parsed = parseTrialResult(cell.variant, cell.task, cell.repeat, jobDir, null);

			const usage: TrialUsage = {
				inputTokens: parsed.inputTokens ?? null,
				outputTokens: parsed.outputTokens ?? null,
				cacheTokens: parsed.cacheTokens ?? null,
				costUsd: parsed.costUsd ?? null,
				durationSec: parsed.agentSeconds ?? null,
			};

			return {
				reward: parsed.reward,
				partial: parsed.partial,
				error: parsed.error,
				usage,
				extra: {
					artifacts: parsed.artifacts ?? {},
					nativeCompaction: parsed.nativeCompaction ?? null,
				},
			};
		} catch (err) {
			return {
				reward: null,
				partial: null,
				error: errorMessage(err),
				usage: null,
				extra: {},
			};
		}
	}

	async preflight(context: SuiteContext): Promise<PreflightVerdict> {
		const options = context.options ?? {};
		const missing: string[] = [];

		if (typeof options.binary === "string") {
			const pin = resolveBinaryPin(options.binary);
			if (pin.kind === "invalid") {
				return {
					ok: false,
					reason: `Invalid vey binary pin: ${pin.reason}`,
					missingRequirements: ["valid vey binary"],
				};
			}
			if (pin.kind === "pinned" && !fs.existsSync(pin.path)) {
				missing.push(`pinned vey binary at ${pin.path}`);
			}
		} else if (options.dryRun) {
			const status = checkBinaryBuildNeeded();
			if (status.needsBuild) {
				const desc = status.reason === "missing" ? "missing vey binary" : "stale vey binary";
				missing.push(`${desc} at ${status.binaryPath} (build with: ${status.buildCommand})`);
			}
		}

		// 1. Dataset corpus verification
		const tasksRoot = context.datasetDir ? path.resolve(context.datasetDir) : taskCorpusDir();
		try {
			const s = fs.statSync(tasksRoot);
			if (!s.isDirectory()) {
				missing.push("task-corpus");
			}
		} catch {
			missing.push("task-corpus");
		}

		// 2. Task list file verification (if explicitly given)
		const explicitTasksFile =
			typeof options.tasksFile === "string"
				? resolvePackagePath(options.tasksFile)
				: typeof options.taskList === "string"
					? resolvePackagePath(options.taskList)
					: null;

		if (explicitTasksFile) {
			try {
				const s = fs.statSync(explicitTasksFile);
				if (!s.isFile()) {
					missing.push("task-list-file");
				}
			} catch {
				missing.push("task-list-file");
			}
		}

		if (missing.length > 0) {
			const reasons: string[] = [];
			if (missing.includes("task-corpus")) {
				reasons.push(
					`DeepSWE task corpus directory is missing or not a directory at ${tasksRoot}. Fetch the corpus with: git clone https://github.com/datacurve-ai/deep-swe datasets/deep-swe/corpus`,
				);
			}
			if (missing.includes("task-list-file") && explicitTasksFile) {
				reasons.push(`DeepSWE task list file is missing at ${explicitTasksFile}.`);
			}
			for (const m of missing) {
				if (m !== "task-corpus" && m !== "task-list-file") {
					reasons.push(m);
				}
			}
			return {
				ok: false,
				reason: `Preflight failed for DeepSWE suite: ${reasons.join("; ")}`,
				missingRequirements: missing,
			};
		}

		// 3. Discover and verify per-task fixtures
		const taskIds = await this.discoverTasks(context);
		if (taskIds.length === 0) {
			return {
				ok: false,
				reason: `Preflight failed for DeepSWE suite: no tasks found in corpus at ${tasksRoot} or task list.`,
				missingRequirements: ["tasks"],
			};
		}

		const missingTaskIds: string[] = [];
		const invalidTaskTomls: string[] = [];
		for (const taskId of taskIds) {
			const taskDir = path.join(tasksRoot, taskId);
			const taskToml = path.join(taskDir, "task.toml");
			if (!fs.existsSync(taskDir) || !fs.existsSync(taskToml)) {
				missingTaskIds.push(taskId);
				continue;
			}
			try {
				const content = fs.readFileSync(taskToml, "utf8");
				parseTaskTimeBudget(content, taskId);
			} catch {
				invalidTaskTomls.push(taskId);
			}
		}

		if (missingTaskIds.length > 0) {
			const preview = missingTaskIds.slice(0, 5).join(", ");
			const more = missingTaskIds.length > 5 ? `, ... and ${missingTaskIds.length - 5} more` : "";
			return {
				ok: false,
				reason: `Preflight failed for DeepSWE suite: task corpus at ${tasksRoot} is missing ${missingTaskIds.length} task(s) named in the task list: ${preview}${more}. Fetch with: git clone https://github.com/datacurve-ai/deep-swe datasets/deep-swe/corpus`,
				missingRequirements: ["task-corpus-tasks"],
			};
		}

		if (invalidTaskTomls.length > 0) {
			const preview = invalidTaskTomls.slice(0, 5).join(", ");
			return {
				ok: false,
				reason: `Preflight failed for DeepSWE suite: task corpus at ${tasksRoot} contains ${invalidTaskTomls.length} task(s) with invalid task.toml: ${preview}`,
				missingRequirements: ["valid-task-toml"],
			};
		}

		return { ok: true };
	}

	/**
	 * Re-derive every row from the trial artifacts and write `results.json` and `report.md`
	 * beside them. The artifacts are the source: a scoring fix that landed after a trial ran
	 * reaches it here, and a run that was resumed reports one set of rows rather than two.
	 */
	writeRunReport(context: SuiteReportContext): void {
		reaggregate(context.runDir, {
			model: context.model,
			tasks: context.tasks,
			repeats: context.repeats,
		});
	}
}

export const deepSweSuite = new DeepSweSuite();

export default deepSweSuite;
