import * as fs from "node:fs";
import * as path from "node:path";
import { requireBackendBinding, resolveCellVariant } from "../../core/cell-variant";
import {
	containerProgramPath,
	programBinarySha,
	programDirFor,
	stageHarnessProgram,
} from "../../core/container-program";
import { requireHarness } from "../../core/harness-registry";
import { containerLocalEndpointEnv } from "../../core/local-endpoint";
import { trialTimeoutFromOptions } from "../../core/trial-deadline";
import { resolveTrialModel } from "../../core/trial-model";
import { runDirFor, trialJobName } from "../../core/trial-naming";
import type {
	BackendId,
	ExecutionBackend,
	PreflightVerdict,
	RunContext,
	TrialArtifacts,
	TrialCell,
	Variant,
	VariantAxis,
} from "../../core/types";
import { authDbPath, runsDir as defaultRunsDir, pierAgentDir, veyBinaryPath } from "../../paths";
import { stagePierAssets } from "./asset-staging";
import {
	checkPierPreflight,
	cleanupPierContainers,
	runPierTrial,
	trialArtifactsFromExecution,
	writePierJobConfig,
} from "./runner";

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
	readonly #programShas = new Map<string, string | null>();

	constructor(options: PierBackendOptions = {}) {
		this.#stageAssets = options.stageAssets ?? stagePierAssets;
		this.#veyBinary = options.veyBinary ?? veyBinaryPath();
		this.#authDb = options.authDb ?? authDbPath();
		this.#checkPreflight = options.checkPreflight ?? checkPierPreflight;
		this.#exec = options.exec;
	}

	/**
	 * The build a program-delivered arm staged, hashed once per program directory.
	 *
	 * A run is resumable and a trial may be the first thing this instance does, so the digest
	 * is read off the staged directory instead of a field `prepare` filled in.
	 */
	#programSha(dir: string): string | null {
		const known = this.#programShas.get(dir);
		if (known !== undefined) return known;
		const sha = programBinarySha(dir);
		this.#programShas.set(dir, sha);
		return sha;
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

	/**
	 * The variants whose harness delivers itself through a container program, and so needs
	 * neither the vey binary nor a seeded credential store.
	 */
	#programVariants(context: RunContext): readonly Variant[] {
		const variants = context.options?.variants ?? [];
		return variants.filter(variant => requireHarness(variant.harness).containerProgram !== undefined);
	}

	/** Whether this run stages the veyyon assets: a vey binary and a credential store. */
	#needsVeyyonAssets(context: RunContext): boolean {
		const variants = context.options?.variants ?? [];
		if (variants.length === 0) return true;
		return this.#programVariants(context).length !== variants.length;
	}

	async preflight(context: RunContext): Promise<PreflightVerdict> {
		const pierVerdict = this.#checkPreflight(context.options);
		if (!pierVerdict.ok) {
			return pierVerdict;
		}

		// A run made entirely of program-delivered arms never reads the vey binary or the
		// credential store, so requiring them refused runs that had no use for them.
		if (!this.#needsVeyyonAssets(context)) {
			return { ok: true };
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
		// Where the run says its output goes, which harbor and in-process already read off the
		// context. This read `workDir/runs` instead, so `--runs-dir` split one run in two: the
		// journal and the record landed where it named, the configs, jobs and staged binary
		// under the checkout. A run whose trials execute on a host that mounts the checkout
		// over the network had no way to keep its staging off that mount, and staging a
		// binary from one network path to another stalled in an NFS server-side copy.
		const runDir = runDirFor(context.runsDir || defaultRunsDir(), context.runId);
		const configsDir = path.join(runDir, "configs");
		const jobsDir = path.join(runDir, "jobs");
		const assetsDir = path.join(runDir, "assets");
		fs.mkdirSync(configsDir, { recursive: true });
		fs.mkdirSync(jobsDir, { recursive: true });
		fs.mkdirSync(assetsDir, { recursive: true });

		const variants = context.options?.variants ?? [];

		if (this.#needsVeyyonAssets(context)) {
			const staged = this.#stageAssets({
				assetsDir,
				variants,
				veyBinary: this.#resolveVeyBinary(context),
				authDb: this.#resolveAuthDb(context),
			});
			this.#binarySha = staged.binarySha;
		}

		for (const variant of this.#programVariants(context)) {
			const harness = requireHarness(variant.harness);
			stageHarnessProgram(harness, programDirFor(assetsDir, harness.name, variant.name), {
				model: resolveTrialModel(variant, harness, context).id,
				options: context.options ?? {},
			});
		}
	}
	async runTrial(cell: TrialCell, context: RunContext): Promise<TrialArtifacts> {
		const taskDescriptor = await context.suite.describeTask(cell.task, context);
		const jobName = trialJobName(context.runId, cell);
		const runDir = runDirFor(context.runsDir || defaultRunsDir(), context.runId);
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
		const programDir = programDirFor(assetsDir, harness.name, variant.name);

		// A program-delivered harness carries its own environment in the program's env file,
		// so only a bespoke agent needs the endpoint named here.
		const localEndpoint = containerLocalEndpointEnv(modelName);
		const kwargs: Record<string, unknown> = harness.containerProgram
			? {
					program_path: containerProgramPath(programDir),
					// The staged program's own bytes outrank the run's `--binary`, which names the
					// vey build: a mixed run would otherwise stamp every program arm with it.
					binary_sha:
						this.#programSha(programDir) ?? (context.options?.binarySha as string | undefined) ?? "nosha",
					...(pierBinding.extra ?? {}),
				}
			: {
					arm_name: variant.name,
					assets_dir: assetsDir,
					binary_sha: (context.options?.binarySha as string | undefined) ?? this.#binarySha ?? "nosha",
					...(localEndpoint ? { local_endpoint_env: localEndpoint } : {}),
					...(pierBinding.extra ?? {}),
				};

		// Pier catches its own agent timeout and still verifies, so bounding the agent phase
		// yields a graded trial where bounding the trial deadline yields a killed process.
		const agentTimeout = context.options?.agentTimeoutSec;
		const configPath = writePierJobConfig({
			jobName,
			jobsDir,
			taskPath: taskDescriptor.path ?? path.join(context.workDir, "tasks", cell.task),
			agentImportPath,
			modelName,
			kwargs,
			configDir: configsDir,
			agentTimeoutSec: typeof agentTimeout === "number" ? agentTimeout : null,
		});

		const trialTimeoutSec = trialTimeoutFromOptions(taskDescriptor.timeBudgetSec, context.options);

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
		const jobName = trialJobName(context.runId, cell);
		await cleanupPierContainers(jobName, this.#exec);
	}
}

export const pierBackend = new PierExecutionBackend();
