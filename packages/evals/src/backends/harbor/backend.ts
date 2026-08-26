import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { $which, errorMessage, readPipeText } from "@veyyon/utils";
import { type BackendRegistry, defaultBackendRegistry } from "../../core/backend-registry";
import { requireBackendBinding, resolveCellVariant } from "../../core/cell-variant";
import { requireHarness } from "../../core/harness-registry";
import type {
	BackendId,
	ExecutionBackend,
	PreflightVerdict,
	RunContext,
	TaskDescriptor,
	TrialArtifacts,
	TrialCell,
} from "../../core/types";
import { runsDir as defaultRunsDir } from "../../paths";
import { buildHarborArgs, type HarborRunArgsOptions } from "./launch-args";
import {
	buildHarborEnv,
	cleanupHarborTrialContainers,
	DEFAULT_GRACE_PERIOD_MS,
	DEFAULT_TRIAL_TIMEOUT_SEC,
	HARD_CEILING_TIMEOUT_SEC,
	prepareSourceDeps,
	type SourceMount,
	terminateProcessTree,
	truncateRawOutput,
} from "./runner";

const execFileAsync = promisify(execFile);

export type WhichLookup = (bin: string) => string | null;
export type CommandExecutor = (file: string, args: readonly string[]) => Promise<{ stdout: string; stderr: string }>;

export async function defaultCommandExecutor(
	file: string,
	args: readonly string[],
): Promise<{ stdout: string; stderr: string }> {
	return execFileAsync(file, args as string[], {
		encoding: "utf-8",
		maxBuffer: 16 * 1024 * 1024,
	});
}

export interface HarborBackendOptions {
	readonly which?: WhichLookup;
	readonly exec?: CommandExecutor;
}

function sanitizeName(s: string): string {
	return s.replace(/[^a-zA-Z0-9._-]/g, "_");
}

/**
 * ExecutionBackend implementation for Harbor benchmark tasks.
 * Executes tasks via containerized environments (Docker / Apple Container) using `harbor run`.
 */
export class HarborBackend implements ExecutionBackend {
	readonly id: BackendId = "harbor";

	readonly #which: WhichLookup;
	readonly #exec: CommandExecutor;
	#sourceMount: SourceMount | null = null;

	constructor(options: HarborBackendOptions = {}) {
		this.#which = options.which ?? $which;
		this.#exec = options.exec ?? defaultCommandExecutor;
	}

	async preflight(context: RunContext): Promise<PreflightVerdict> {
		// 1. harbor binary check
		const harborBin = this.#which("harbor");
		if (!harborBin) {
			return {
				ok: false,
				reason: "harbor not found on PATH. Install with: uv tool install harbor",
				missingRequirements: ["harbor"],
			};
		}

		// 2. Container environment check
		const envType = typeof context.options?.envType === "string" ? context.options.envType : "docker";

		if (envType === "apple-container") {
			const containerBin = this.#which("container");
			if (!containerBin) {
				return {
					ok: false,
					reason:
						"Apple 'container' CLI not found. Install with: brew install container && container system start",
					missingRequirements: ["container"],
				};
			}
		} else {
			const dockerBin = this.#which("docker");
			if (!dockerBin) {
				return {
					ok: false,
					reason: "docker not found on PATH (required to run task containers).",
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
		}

		// 3. Jobs directory creation / accessibility check
		const runsDir = context.runsDir || defaultRunsDir();
		try {
			await fs.mkdir(runsDir, { recursive: true });
		} catch (error) {
			const err = errorMessage(error);
			return {
				ok: false,
				reason: `Failed to create or access jobs directory at ${runsDir}: ${err}`,
				missingRequirements: ["jobs-dir"],
			};
		}

		return { ok: true };
	}

	async prepare(context: RunContext): Promise<void> {
		const runsDir = context.runsDir || defaultRunsDir();
		const runDir = path.join(runsDir, context.runId);
		await fs.mkdir(runDir, { recursive: true });

		// If veyyon agent is used with source install mode (default), prepare source deps once per run
		const agent = typeof context.options?.agent === "string" ? context.options.agent : undefined;
		const installMode = typeof context.options?.install === "string" ? context.options.install : "source";
		if ((!agent || agent === "veyyon") && installMode === "source") {
			try {
				const envType =
					typeof context.options?.envType === "string" && context.options.envType === "apple-container"
						? "apple-container"
						: "docker";
				this.#sourceMount = prepareSourceDeps({
					models: [],
					dataset: "terminal-bench",
					tasks: 1,
					concurrency: 1,
					attempts: 1,
					include: [],
					exclude: [],
					thinking: null,
					agentArgs: [],
					agent: "veyyon",
					install: "source",
					version: null,
					tarball: null,
					binaryArm64: null,
					binaryX64: null,
					build: true,
					jobsDir: runsDir,
					jobName: context.runId,
					gatewayUrl: "http://host.docker.internal:4000",
					gatewayToken: "no-auth",
					providers: [],
					gateway: true,
					webSearch: false,
					allowHosts: [],
					timeoutMultiplier: null,
					yes: true,
					dryRun: false,
					cleanup: false,
					cleanupForce: false,
					hostNetwork: false,
					resume: null,
					filterErrorTypes: [],
					envType,
					passthrough: [],
					env: {},
				});
			} catch {
				// Non-fatal if source deps preparation is deferred or skipped
			}
		}
	}

	async runTrial(cell: TrialCell, context: RunContext): Promise<TrialArtifacts> {
		if (context.signal?.aborted) {
			throw new Error("Run aborted before trial start");
		}

		const descriptor: TaskDescriptor = await context.suite.describeTask(cell.task, {
			workDir: context.workDir,
			signal: context.signal,
			options: context.options,
		});

		const variant = resolveCellVariant(cell, context);
		const harness = requireHarness(variant.harness);
		const optionAgent = typeof context.options?.agent === "string" ? context.options.agent : undefined;
		// An explicit `agent` option selects one of harbor's own baseline agents (oracle, nop),
		// which are not harnesses; otherwise the harness axis names the agent and the class
		// harbor imports to drive it.
		let agent: string;
		let agentImportPath: string | null = null;
		if (optionAgent) {
			agent = optionAgent;
		} else {
			const binding = requireBackendBinding(harness, this.id);
			agent = binding.agentName ?? harness.name;
			agentImportPath = binding.agentImportPath ?? null;
		}
		const optionModel = typeof context.options?.model === "string" ? context.options.model : undefined;
		const model = variant.model || optionModel || harness.defaultModel || undefined;

		const started = Date.now();
		const runsDir = context.runsDir || defaultRunsDir();
		const runDir = path.join(runsDir, sanitizeName(context.runId));
		await fs.mkdir(runDir, { recursive: true });

		const jobName = `${sanitizeName(context.runId)}__${sanitizeName(cell.variant || "default")}__${sanitizeName(cell.task)}__r${cell.repeat ?? 0}_${Date.now()}`;
		const jobDir = path.join(runDir, jobName);
		await fs.mkdir(jobDir, { recursive: true });

		const rawBudget = descriptor.timeBudgetSec > 0 ? descriptor.timeBudgetSec : DEFAULT_TRIAL_TIMEOUT_SEC;
		const multiplier =
			typeof context.options?.timeoutMultiplier === "number" && context.options.timeoutMultiplier > 0
				? context.options.timeoutMultiplier
				: 1;
		const trialTimeoutSec = Math.min(Math.round(rawBudget * multiplier), HARD_CEILING_TIMEOUT_SEC);

		// Read overrides from TaskDescriptor.metadata without re-reading task.toml
		const metadata = descriptor.metadata;
		const overrideCpus = typeof metadata.cpus === "number" ? metadata.cpus : undefined;
		const overrideMemoryMb = typeof metadata.memory_mb === "number" ? metadata.memory_mb : undefined;
		const overrideStorageMb = typeof metadata.storage_mb === "number" ? metadata.storage_mb : undefined;
		const overrideGpus = typeof metadata.gpus === "number" && metadata.gpus > 0 ? metadata.gpus : undefined;

		let artifactsList: string[] | undefined;
		if (Array.isArray(metadata.artifacts)) {
			artifactsList = metadata.artifacts.filter((a): a is string => typeof a === "string");
		}

		let disableVerification: boolean | undefined;
		if (metadata.verifier && typeof metadata.verifier === "object" && "disable" in metadata.verifier) {
			disableVerification = Boolean(metadata.verifier.disable);
		}

		const passthrough: string[] = [];
		if (Array.isArray(context.options?.extraArgs)) {
			for (const arg of context.options.extraArgs) {
				if (typeof arg === "string") passthrough.push(arg);
			}
		}

		const envType = typeof context.options?.envType === "string" ? context.options.envType : "docker";

		const harborArgsOptions: HarborRunArgsOptions = {
			taskPath: descriptor.path,
			dataset: descriptor.path ? undefined : context.suite.name || "terminal-bench",
			jobsDir: runDir,
			jobName,
			concurrency: 1,
			attempts: 1,
			tasks: 1,
			models: model && agent !== "oracle" && agent !== "nop" ? [model] : [],
			agent,
			agentImportPath,
			include: descriptor.path ? undefined : [cell.task],
			yes: true,
			timeoutMultiplier:
				typeof context.options?.timeoutMultiplier === "number" ? context.options.timeoutMultiplier : undefined,
			envType,
			overrideCpus,
			overrideMemoryMb,
			overrideStorageMb,
			overrideGpus,
			artifacts: artifactsList,
			disableVerification,
			passthrough,
		};

		const harborArgs = buildHarborArgs(harborArgsOptions);

		// Environment setup
		let harborEnv: Record<string, string>;
		if (agent === "veyyon") {
			harborEnv = buildHarborEnv(
				{
					models: model ? [model] : [],
					dataset: context.suite.name || "terminal-bench",
					tasks: 1,
					concurrency: 1,
					attempts: 1,
					include: [cell.task],
					exclude: [],
					thinking: typeof context.options?.thinking === "string" ? context.options.thinking : null,
					agentArgs: Array.isArray(context.options?.agentArgs) ? (context.options.agentArgs as string[]) : [],
					agent: "veyyon",
					install: (context.options?.install as "source" | "local" | "published") ?? "source",
					version: typeof context.options?.version === "string" ? context.options.version : null,
					tarball: typeof context.options?.tarball === "string" ? context.options.tarball : null,
					binaryArm64: null,
					binaryX64: null,
					build: false,
					jobsDir: runDir,
					jobName,
					gatewayUrl: (context.options?.gatewayUrl as string) ?? "http://host.docker.internal:4000",
					gatewayToken: (context.options?.gatewayToken as string) ?? "no-auth",
					providers: Array.isArray(context.options?.providers) ? (context.options.providers as string[]) : [],
					gateway: context.options?.gateway !== false,
					webSearch: Boolean(context.options?.webSearch),
					allowHosts: Array.isArray(context.options?.allowHosts) ? (context.options.allowHosts as string[]) : [],
					timeoutMultiplier: null,
					yes: true,
					dryRun: false,
					cleanup: false,
					cleanupForce: false,
					hostNetwork: false,
					resume: null,
					filterErrorTypes: [],
					envType: envType === "apple-container" ? "apple-container" : "docker",
					passthrough: [],
					env: (context.options?.env as Record<string, string>) ?? {},
				},
				"",
				null,
				"latest",
				this.#sourceMount,
			);
		} else {
			harborEnv = {
				...(process.env as Record<string, string>),
				...((context.options?.env as Record<string, string>) ?? {}),
			};
		}

		const proc = Bun.spawn(["harbor", ...harborArgs], {
			cwd: context.workDir,
			env: harborEnv,
			stdout: "pipe",
			stderr: "pipe",
		});

		const killTrial = async (): Promise<void> => {
			await terminateProcessTree(proc, DEFAULT_GRACE_PERIOD_MS);
			if (envType === "docker") {
				await cleanupHarborTrialContainers({ jobDir, jobName, force: true }, this.#exec);
			}
		};

		const onAbort = (): void => {
			void killTrial();
		};

		if (context.signal) {
			context.signal.addEventListener("abort", onAbort, { once: true });
		}

		const { promise: timeoutPromise, resolve: resolveTimeout } = Promise.withResolvers<"timed_out">();
		const timer = setTimeout(() => resolveTimeout("timed_out"), trialTimeoutSec * 1000);

		let stdout = "";
		let stderr = "";
		let exitCode = 0;
		let timedOut = false;

		try {
			const stdoutPromise = readPipeText(proc.stdout);
			const stderrPromise = readPipeText(proc.stderr);
			const raceResult = await Promise.race([
				Promise.all([proc.exited, stdoutPromise, stderrPromise]).then(([code, out, err]) => ({
					kind: "exited" as const,
					code,
					out,
					err,
				})),
				timeoutPromise.then(kind => ({ kind, code: -1, out: "", err: "" })),
			]);

			if (raceResult.kind === "timed_out") {
				timedOut = true;
				await killTrial();
				stdout = truncateRawOutput(await readPipeText(proc.stdout));
				stderr = truncateRawOutput(await readPipeText(proc.stderr));
				exitCode = -1;
			} else {
				exitCode = raceResult.code;
				stdout = raceResult.out;
				stderr = raceResult.err;
			}
		} finally {
			clearTimeout(timer);
			if (context.signal) {
				context.signal.removeEventListener("abort", onAbort);
			}
		}

		if (timedOut) {
			throw new Error(`Trial timed out after ${trialTimeoutSec}s (watchdog ceiling)`);
		}

		if (context.signal?.aborted) {
			await killTrial();
			throw new Error(`Trial aborted: harbor exited with code ${exitCode}`);
		}

		// Locate trial directory under jobDir (Harbor creates `<jobDir>/<task>__<suffix>/`)
		let trialDir: string | null = null;
		try {
			const entries = await fs.readdir(jobDir, { withFileTypes: true });
			for (const entry of entries) {
				if (entry.isDirectory()) {
					if (entry.name.includes("__") || entry.name.startsWith(cell.task)) {
						trialDir = path.join(jobDir, entry.name);
						break;
					}
				}
			}
			if (!trialDir) {
				const dirs = entries.filter(e => e.isDirectory());
				if (dirs.length === 1 && dirs[0]) {
					trialDir = path.join(jobDir, dirs[0].name);
				}
			}
		} catch {
			/* ignore read error */
		}

		const logPaths: string[] = [];
		const fileMap: Record<string, string> = {};

		if (trialDir) {
			// Scan for key log files and artifacts inside trialDir
			const candidateLogFiles = [
				"agent/oracle.txt",
				"agent/veyyon.txt",
				"agent/nop.txt",
				"verifier/reward.txt",
				"verifier/reward.json",
				"logs/verifier/reward.txt",
				"logs/verifier/reward.json",
				"verifier/test-stdout.txt",
				"result.json",
				"config.json",
				"lock.json",
			];

			for (const rel of candidateLogFiles) {
				const full = path.join(trialDir, rel);
				try {
					await fs.access(full);
					fileMap[rel] = full;
					logPaths.push(full);
				} catch {
					// File does not exist, continue
				}
			}
		}

		if (exitCode !== 0 && !trialDir) {
			throw new Error(`Harbor run failed with exit code ${exitCode}: ${stderr || stdout}`);
		}

		const rawOutput = truncateRawOutput(stdout || stderr);

		return {
			trialDir,
			logPaths,
			rawOutput,
			filePaths: fileMap,
			extra: {
				cell,
				jobName,
				jobDir,
				trialDir,
				exitCode,
				durationMs: Date.now() - started,
			},
		};
	}

	async cleanup(cell: TrialCell, context: RunContext): Promise<void> {
		const envType = typeof context.options?.envType === "string" ? context.options.envType : "docker";
		const runsDir = context.runsDir || defaultRunsDir();
		const runDir = path.join(runsDir, sanitizeName(context.runId));
		const prefix = `${sanitizeName(context.runId)}__${sanitizeName(cell.variant || "default")}__${sanitizeName(cell.task)}__r${cell.repeat ?? 0}`;

		if (envType === "docker") {
			try {
				let matchingJobDirs: string[] = [];
				try {
					const entries = await fs.readdir(runDir, { withFileTypes: true });
					matchingJobDirs = entries
						.filter(e => e.isDirectory() && e.name.startsWith(prefix))
						.map(e => path.join(runDir, e.name));
				} catch {
					/* directory might not exist */
				}

				if (matchingJobDirs.length > 0) {
					for (const jobDir of matchingJobDirs) {
						const jobName = path.basename(jobDir);
						await cleanupHarborTrialContainers({ jobDir, jobName, force: false }, this.#exec);
					}
				} else {
					await cleanupHarborTrialContainers({ jobDir: runDir, jobName: prefix, force: false }, this.#exec);
				}
			} catch {
				/* cleanup failure should not propagate */
			}
		}

		if (context.options?.cleanup === true) {
			try {
				const entries = await fs.readdir(runDir, { withFileTypes: true });
				for (const entry of entries) {
					if (entry.isDirectory() && entry.name.startsWith(prefix)) {
						await fs.rm(path.join(runDir, entry.name), { recursive: true, force: true });
					}
				}
			} catch {
				/* ignore */
			}
		}
	}
}

export const harborBackend = new HarborBackend();

/**
 * Registers the Harbor execution backend in the backend registry.
 * Idempotent: safe to call multiple times.
 */
export function registerHarborBackend(registry?: BackendRegistry): void {
	const target = registry ?? defaultBackendRegistry;
	if (!target.has(harborBackend.id)) {
		target.register(harborBackend);
	}
}

// Auto-register on module load
registerHarborBackend();
