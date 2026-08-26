import * as fs from "node:fs";
import * as path from "node:path";
import { requireBackendBinding, resolveCellVariant } from "../../core/cell-variant";
import { requireHarness } from "../../core/harness-registry";
import { resolveTrialModel } from "../../core/trial-model";
import type {
	BackendId,
	ExecutionBackend,
	PreflightVerdict,
	RunContext,
	TrialArtifacts,
	TrialCell,
	VariantAxis,
} from "../../core/types";
import { authDbPath, pierAgentDir, veyBinaryPath } from "../../paths";
import { stagePierAssets } from "./asset-staging";
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
export type StagePierAssetsFn = typeof stagePierAssets;
export type CheckPierPreflightFn = typeof checkPierPreflight;
export type PierCommandExecutor = (
	file: string,
	args: readonly string[],
) => Promise<{ stdout: string; stderr: string }>;

export interface PierBackendOptions {
	readonly stageAssets?: StagePierAssetsFn;
	readonly veyBinary?: string;
	readonly authDb?: string;
	readonly checkPreflight?: CheckPierPreflightFn;
	readonly exec?: PierCommandExecutor;
}

export class PierExecutionBackend implements ExecutionBackend {
	readonly id: BackendId = "pier";
	/** Asset staging writes an arm YAML per config and stages arm attachments; prompt
	 * overlays reach nothing inside the container. */
	readonly appliesVariantAxes: readonly VariantAxis[] = ["config", "attachments"];

	readonly #stageAssets: StagePierAssetsFn;
	readonly #veyBinary: string;
	readonly #authDb: string;
	readonly #checkPreflight: CheckPierPreflightFn;
	readonly #exec?: PierCommandExecutor;
	#binarySha: string | null = null;

	constructor(options: PierBackendOptions = {}) {
		this.#stageAssets = options.stageAssets ?? stagePierAssets;
		this.#veyBinary = options.veyBinary ?? veyBinaryPath();
		this.#authDb = options.authDb ?? authDbPath();
		this.#checkPreflight = options.checkPreflight ?? checkPierPreflight;
		this.#exec = options.exec;
	}

	#resolveVeyBinary(context: RunContext): string {
		const opt = context.options;
		if (typeof opt?.binary === "string") return path.resolve(opt.binary);
		if (typeof opt?.["vey-binary"] === "string") return path.resolve(opt["vey-binary"] as string);
		if (typeof opt?.pinnedBinary === "string") return path.resolve(opt.pinnedBinary as string);
		return this.#veyBinary;
	}

	#resolveAuthDb(context: RunContext): string {
		const opt = context.options;
		if (typeof opt?.authDb === "string") return path.resolve(opt.authDb as string);
		if (typeof opt?.["auth-db"] === "string") return path.resolve(opt["auth-db"] as string);
		return this.#authDb;
	}

	async preflight(context: RunContext): Promise<PreflightVerdict> {
		const pierVerdict = this.#checkPreflight(context.options);
		if (!pierVerdict.ok) {
			return pierVerdict;
		}

		const veyBinary = this.#resolveVeyBinary(context);
		if (!fs.existsSync(veyBinary)) {
			return {
				ok: false,
				reason: `vey binary not found at ${veyBinary} — build with: bun --cwd=packages/coding-agent scripts/build-binary.ts`,
				missingRequirements: [veyBinary],
			};
		}

		const authDb = this.#resolveAuthDb(context);
		if (!fs.existsSync(authDb)) {
			return {
				ok: false,
				reason: `auth database not found at ${authDb} — seed from ~/.veyyon/shared-auth/agent.db or log in with: vey /login`,
				missingRequirements: [authDb],
			};
		}

		return { ok: true };
	}

	async prepare(context: RunContext): Promise<void> {
		const runDir = path.join(context.workDir, "runs", sanitizeName(context.runId));
		const configsDir = path.join(runDir, "configs");
		const jobsDir = path.join(runDir, "jobs");
		const assetsDir = path.join(runDir, "assets");
		fs.mkdirSync(configsDir, { recursive: true });
		fs.mkdirSync(jobsDir, { recursive: true });
		fs.mkdirSync(assetsDir, { recursive: true });

		const variants = context.options?.variants ?? [];
		const veyBinary = this.#resolveVeyBinary(context);
		const authDb = this.#resolveAuthDb(context);

		const staged = this.#stageAssets({
			assetsDir,
			variants,
			veyBinary,
			authDb,
		});
		this.#binarySha = staged.binarySha;
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
		const modelName = resolveTrialModel(variant, harness, context).id;

		const kwargs: Record<string, unknown> = {
			arm_name: variant.name,
			assets_dir: assetsDir,
			binary_sha: (context.options?.binarySha as string | undefined) ?? this.#binarySha ?? "nosha",
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
			exec: this.#exec,
		});

		return trialArtifactsFromExecution(execution.trialDirPath, execution);
	}

	async cleanup(cell: TrialCell, context: RunContext): Promise<void> {
		const jobName = `${sanitizeName(context.runId)}__${sanitizeName(cell.variant || "default")}__${sanitizeName(cell.task)}__r${cell.repeat ?? 0}`;
		await cleanupPierContainers(jobName, this.#exec);
	}
}

export const pierBackend = new PierExecutionBackend();
