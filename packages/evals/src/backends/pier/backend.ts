import * as fs from "node:fs";
import * as path from "node:path";
import { requireBackendBinding, resolveCellVariant } from "../../core/cell-variant";
import { requireHarness } from "../../core/harness-registry";
import type {
	BackendId,
	ExecutionBackend,
	PreflightVerdict,
	RunContext,
	TrialArtifacts,
	TrialCell,
} from "../../core/types";
import { pierAgentDir } from "../../paths";
import {
	checkPierPreflight,
	cleanupPierContainers,
	DEFAULT_TRIAL_TIMEOUT_SEC,
	HARD_CEILING_TIMEOUT_SEC,
	runPierTrial,
	trialArtifactsFromExecution,
	writePierJobConfig,
} from "./runner";

function sanitizeName(s: string): string {
	return s.replace(/[^a-zA-Z0-9._-]/g, "_");
}
export class PierExecutionBackend implements ExecutionBackend {
	readonly id: BackendId = "pier";

	async preflight(context: RunContext): Promise<PreflightVerdict> {
		return checkPierPreflight(context.options);
	}

	async prepare(context: RunContext): Promise<void> {
		const runDir = path.join(context.workDir, "runs", sanitizeName(context.runId));
		const configsDir = path.join(runDir, "configs");
		const jobsDir = path.join(runDir, "jobs");
		const assetsDir = path.join(runDir, "assets");
		fs.mkdirSync(configsDir, { recursive: true });
		fs.mkdirSync(jobsDir, { recursive: true });
		fs.mkdirSync(assetsDir, { recursive: true });
	}

	async runTrial(cell: TrialCell, context: RunContext): Promise<TrialArtifacts> {
		const taskDescriptor = await context.suite.describeTask(cell.task, context);
		const jobName = `${sanitizeName(context.runId)}__${sanitizeName(cell.variant || "default")}__${sanitizeName(cell.task)}__r${cell.repeat ?? 0}`;
		const runDir = path.join(context.workDir, "runs", sanitizeName(context.runId));
		const configsDir = path.join(runDir, "configs");
		const jobsDir = path.join(runDir, "jobs");
		const assetsDir = path.join(runDir, "assets");

		const variant = resolveCellVariant(cell, context);
		const harness = requireHarness(variant.harness);
		const pierBinding = requireBackendBinding(harness, this.id);
		const agentImportPath = pierBinding.agentImportPath;
		if (!agentImportPath) {
			throw new Error(
				`Harness "${harness.name}" declares a pier binding without an agentImportPath, so pier has no agent class to load.`,
			);
		}
		const modelName = variant.model || (context.options?.model as string | undefined) || harness.defaultModel;
		if (!modelName) {
			throw new Error(
				`Variant "${variant.name}" names no model and harness "${harness.name}" has no default model.`,
			);
		}

		const kwargs: Record<string, unknown> = {
			arm_name: variant.name,
			assets_dir: assetsDir,
			binary_sha: (context.options?.binarySha as string | undefined) ?? "nosha",
			...(pierBinding.extra ?? {}),
		};

		const configPath = writePierJobConfig({
			jobName,
			jobsDir,
			taskPath: taskDescriptor.path ?? path.join(context.workDir, "tasks", cell.task),
			agentImportPath,
			modelName,
			kwargs,
			configDir: configsDir,
		});

		const rawBudget = taskDescriptor.timeBudgetSec > 0 ? taskDescriptor.timeBudgetSec : DEFAULT_TRIAL_TIMEOUT_SEC;
		const multiplier =
			typeof context.options?.timeoutMultiplier === "number" && context.options.timeoutMultiplier > 0
				? context.options.timeoutMultiplier
				: 1;
		const trialTimeoutSec = Math.min(Math.round(rawBudget * multiplier), HARD_CEILING_TIMEOUT_SEC);

		const execution = await runPierTrial({
			jobName,
			outRoot: runDir,
			jobsDir,
			configPath,
			pierAgentDir: pierAgentDir(),
			trialTimeoutSec,
			signal: context.signal,
		});

		return trialArtifactsFromExecution(execution.trialDirPath, execution);
	}

	async cleanup(cell: TrialCell, context: RunContext): Promise<void> {
		const jobName = `${sanitizeName(context.runId)}__${sanitizeName(cell.variant || "default")}__${sanitizeName(cell.task)}__r${cell.repeat ?? 0}`;
		await cleanupPierContainers(jobName);
	}
}

export const pierBackend = new PierExecutionBackend();
