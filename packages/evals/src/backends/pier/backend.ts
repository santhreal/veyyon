import * as fs from "node:fs";
import * as path from "node:path";
import { getHarness } from "../../core/harness-registry";
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
	runPierTrial,
	trialArtifactsFromExecution,
	writePierJobConfig,
} from "./runner";

export class PierExecutionBackend implements ExecutionBackend {
	readonly id: BackendId = "pier";

	async preflight(context: RunContext): Promise<PreflightVerdict> {
		return checkPierPreflight(context.options);
	}

	async prepare(context: RunContext): Promise<void> {
		const configsDir = path.join(context.workDir, "configs");
		const jobsDir = path.join(context.workDir, "jobs");
		const assetsDir = path.join(context.workDir, "assets");
		fs.mkdirSync(configsDir, { recursive: true });
		fs.mkdirSync(jobsDir, { recursive: true });
		fs.mkdirSync(assetsDir, { recursive: true });
	}

	async runTrial(cell: TrialCell, context: RunContext): Promise<TrialArtifacts> {
		const taskDescriptor = await context.suite.describeTask(cell.task, context);
		const jobName =
			cell.repeat > 1 ? `${cell.variant}__${cell.task}__r${cell.repeat}` : `${cell.variant}__${cell.task}`;
		const configDir = path.join(context.workDir, "configs");
		const jobsDir = path.join(context.workDir, "jobs");
		const assetsDir = path.join(context.workDir, "assets");

		const harness = getHarness(cell.variant);
		const pierBinding = harness?.backends.pier;
		const agentImportPath = pierBinding?.agentImportPath ?? "veyyon_agent:VeyyonAgent";
		const modelName =
			(context.options?.model as string | undefined) ??
			harness?.defaultModel ??
			"google-antigravity/gemini-3.5-flash";

		const kwargs: Record<string, unknown> = {
			arm_name: cell.variant,
			assets_dir: assetsDir,
			binary_sha: (context.options?.binarySha as string | undefined) ?? "nosha",
			...(pierBinding?.extra ?? {}),
		};

		const configPath = writePierJobConfig({
			jobName,
			jobsDir,
			taskPath: taskDescriptor.path ?? path.join(context.workDir, "tasks", cell.task),
			agentImportPath,
			modelName,
			kwargs,
			configDir,
		});

		const trialTimeoutSec = taskDescriptor.timeBudgetSec > 0 ? taskDescriptor.timeBudgetSec : 1800;

		const execution = await runPierTrial({
			jobName,
			outRoot: context.workDir,
			configPath,
			pierAgentDir: pierAgentDir(),
			trialTimeoutSec,
		});

		return trialArtifactsFromExecution(execution.trialDirPath, execution);
	}

	async cleanup(cell: TrialCell, _context: RunContext): Promise<void> {
		const jobName =
			cell.repeat > 1 ? `${cell.variant}__${cell.task}__r${cell.repeat}` : `${cell.variant}__${cell.task}`;
		await cleanupPierContainers(jobName);
	}
}

export const pierBackend = new PierExecutionBackend();
