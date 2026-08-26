import * as fs from "node:fs";
import * as path from "node:path";
import { errorMessage } from "@veyyon/utils";
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
import { comparisonTaskListPath, resolvePackagePath, taskCorpusDir, taskListsDir } from "../../paths";
import { parseTaskListProvenance } from "./src/aggregate";
import {
	AUTH_DB_SOURCES,
	checkBinaryBuildNeeded,
	ensureAuthDbSeeded,
	ensureBinaryUpToDate,
	getAuthDbPath,
	getVeyBinaryPath,
	requireStagedAuthCanServeToken,
} from "./src/runner/preflight";
import { parseTrialResult } from "./src/runner/trial-result";
import {
	budgetedTrialTimeoutSec,
	decideAuthSeed,
	parseTaskTimeBudget,
	probeCredentialStore,
	resolveBinaryPin,
} from "./src/shared";

export class DeepSweSuite implements EvalSuite {
	readonly name = "deep-swe";
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
				suite: this.name,
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
			suite: this.name,
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

		const pin = resolveBinaryPin(typeof options.binary === "string" ? options.binary : undefined);
		if (pin.kind === "invalid") {
			return {
				ok: false,
				reason: `Invalid vey binary pin: ${pin.reason}`,
				missingRequirements: ["valid vey binary"],
			};
		}

		const pinnedBinary = pin.kind === "pinned" ? pin.path : null;
		if (pinnedBinary) {
			if (!fs.existsSync(pinnedBinary)) {
				missing.push(`pinned vey binary at ${pinnedBinary}`);
			}
		} else if (!options.dryRun && options.ensureBinary !== false) {
			try {
				await ensureBinaryUpToDate();
			} catch (err) {
				missing.push(`up-to-date vey binary: ${errorMessage(err)}`);
			}
		} else {
			const status = checkBinaryBuildNeeded();
			if (status.needsBuild) {
				const desc = status.reason === "missing" ? "missing vey binary" : "stale vey binary";
				missing.push(`${desc} at ${status.binaryPath} (build with: ${status.buildCommand})`);
			}
		}

		const effectiveBinary = pinnedBinary ?? getVeyBinaryPath();
		if (!fs.existsSync(effectiveBinary) && !options.dryRun && !pinnedBinary) {
			missing.push(`vey binary at ${effectiveBinary}`);
		}

		const authDb = getAuthDbPath();
		const mtimeOf = (p: string): number | undefined => (fs.existsSync(p) ? fs.statSync(p).mtimeMs : undefined);
		const authDecision = decideAuthSeed(AUTH_DB_SOURCES, authDb, mtimeOf, probeCredentialStore);

		if (authDecision.kind === "missing") {
			missing.push(`credential store: no agent.db at any of ${AUTH_DB_SOURCES.join(", ")}`);
		} else {
			try {
				if (!options.dryRun) {
					ensureAuthDbSeeded();
					const model = typeof options.model === "string" ? options.model : "google-antigravity/gemini-3.5-flash";
					await requireStagedAuthCanServeToken(model, false);
				} else {
					const candidateDb =
						fs.existsSync(authDb) && probeCredentialStore(authDb) === undefined ? authDb : authDecision.source;
					const model = typeof options.model === "string" ? options.model : "google-antigravity/gemini-3.5-flash";
					await requireStagedAuthCanServeToken(model, true, candidateDb);
				}
			} catch (err) {
				missing.push(`staged auth DB: ${errorMessage(err)}`);
			}
		}
		if (missing.length > 0) {
			return {
				ok: false,
				reason: `Preflight failed for DeepSWE suite: ${missing.join(", ")}`,
				missingRequirements: missing,
			};
		}

		return { ok: true };
	}
}

export const deepSweSuite = new DeepSweSuite();
