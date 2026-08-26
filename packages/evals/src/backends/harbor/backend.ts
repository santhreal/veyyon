import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { $which, errorMessage, isRecord, readPipeText } from "@veyyon/utils";
import { type BackendRegistry, defaultBackendRegistry } from "../../core/backend-registry";
import { requireBackendBinding, resolveCellVariant } from "../../core/cell-variant";
import { requireHarness } from "../../core/harness-registry";
import { resolveTrialModel } from "../../core/trial-model";
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
	buildMountsJson,
	type Config,
	cleanupHarborTrialContainers,
	DEFAULT_GRACE_PERIOD_MS,
	DEFAULT_TRIAL_TIMEOUT_SEC,
	gatewayHealthOk,
	HARD_CEILING_TIMEOUT_SEC,
	prepareSourceDeps,
	type SourceMount,
	terminateProcessTree,
	truncateRawOutput,
	writeComposeOverlay,
	writeModelsYaml,
} from "./runner";

const execFileAsync = promisify(execFile);

/**
 * harbor's own agents that reach no provider: `oracle` replays the reference solution
 * and `nop` does nothing. Every other agent runs a named model or the trial refuses,
 * because a trial that silently used the container's built-in default reports that
 * model's tokens, spend and pass rate as this arm's.
 */
export const NO_MODEL_AGENTS: ReadonlySet<string> = new Set(["nop", "oracle"]);

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

export type SourceDepsPreparer = (cfg: Config) => SourceMount;
export type GatewayHealthProbe = (url: string) => boolean;

export interface HarborBackendOptions {
	readonly which?: WhichLookup;
	readonly exec?: CommandExecutor;
	/** Builds the linux deps tree the source mount serves; the real one runs a container. */
	readonly prepareDeps?: SourceDepsPreparer;
	/** Probes the host auth gateway the containers route model calls through. */
	readonly gatewayHealth?: GatewayHealthProbe;
}

function sanitizeName(s: string): string {
	return s.replace(/[^a-zA-Z0-9._-]/g, "_");
}

/** The per-call parts of a harbor `Config`; everything else comes from run options. */
interface HarborConfigParams {
	readonly agent: string;
	readonly model: string | null;
	readonly task: string | null;
	readonly jobsDir: string;
	readonly jobName: string;
	readonly envType: "docker" | "apple-container";
	readonly build: boolean;
}

function harborEnvType(context: RunContext): "docker" | "apple-container" {
	return context.options?.envType === "apple-container" ? "apple-container" : "docker";
}

/**
 * Reads a veyyon JSONL transcript and reports why the agent never produced work:
 * a final turn that errored with zero tokens spent means no request reached a
 * provider (an unreachable auth gateway, a revoked credential, a bad model id).
 * Returns null when the agent did reach one, whatever it then scored.
 */
export async function agentSetupFailure(logPath: string): Promise<string | null> {
	let text: string;
	try {
		text = await fs.readFile(logPath, "utf-8");
	} catch {
		return null;
	}
	let spentTokens = false;
	let lastError: string | null = null;
	for (const line of text.split("\n")) {
		if (!line.startsWith("{")) continue;
		let event: unknown;
		try {
			event = JSON.parse(line);
		} catch {
			continue;
		}
		if (!isRecord(event) || !Array.isArray(event.messages)) continue;
		for (const message of event.messages) {
			if (!isRecord(message)) continue;
			const usage = isRecord(message.usage) ? message.usage : null;
			if (typeof usage?.totalTokens === "number" && usage.totalTokens > 0) spentTokens = true;
			if (message.stopReason === "error") {
				lastError = typeof message.errorMessage === "string" ? message.errorMessage : "unknown error";
			}
		}
	}
	if (spentTokens || lastError === null) return null;
	return lastError;
}

/**
 * ExecutionBackend implementation for Harbor benchmark tasks.
 * Executes tasks via containerized environments (Docker / Apple Container) using `harbor run`.
 */
export class HarborBackend implements ExecutionBackend {
	readonly id: BackendId = "harbor";

	readonly #which: WhichLookup;
	readonly #exec: CommandExecutor;
	readonly #prepareDeps: SourceDepsPreparer;
	readonly #gatewayHealth: GatewayHealthProbe;
	#sourceMount: SourceMount | null = null;
	#composeOverlayPath: string | null = null;

	constructor(options: HarborBackendOptions = {}) {
		this.#which = options.which ?? $which;
		this.#exec = options.exec ?? defaultCommandExecutor;
		this.#prepareDeps = options.prepareDeps ?? prepareSourceDeps;
		this.#gatewayHealth = options.gatewayHealth ?? gatewayHealthOk;
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

		// 3. Auth gateway. A container never carries provider credentials: models.yml
		// points every provider's baseUrl at the host gateway. When that gateway is
		// down every trial still runs, the agent's first request fails, and the
		// verifier scores an honest-looking 0 — a whole run of zeros that says nothing
		// about the harness. Refuse instead.
		if (context.options?.gateway !== false) {
			const gatewayUrl =
				typeof context.options?.gatewayUrl === "string"
					? context.options.gatewayUrl
					: "http://host.docker.internal:4000";
			if (!this.#gatewayHealth(gatewayUrl)) {
				return {
					ok: false,
					reason:
						`Auth gateway at ${gatewayUrl} is not answering /healthz. Start it on the host with ` +
						"`vey auth-broker serve` and `vey auth-gateway serve --no-auth --bind 127.0.0.1:4000`, " +
						"or pass --no-gateway to forward host provider keys into the containers instead.",
					missingRequirements: ["auth-gateway"],
				};
			}
		}

		// 4. Jobs directory creation / accessibility check
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

	/**
	 * The legacy runner's `Config`, which `prepareSourceDeps`, `writeComposeOverlay`,
	 * `writeModelsYaml` and `buildHarborEnv` all read. One builder, because a second
	 * literal drifts from the first and the container then mounts a different tree than
	 * the deps step built.
	 */
	#harborConfig(context: RunContext, params: HarborConfigParams): Config {
		const options = context.options;
		return {
			models: params.model ? [params.model] : [],
			dataset: context.suite.name || "terminal-bench",
			tasks: 1,
			concurrency: 1,
			attempts: 1,
			include: params.task ? [params.task] : [],
			exclude: [],
			thinking: typeof options?.thinking === "string" ? options.thinking : null,
			agentArgs: Array.isArray(options?.agentArgs) ? (options.agentArgs as string[]) : [],
			agent: params.agent,
			install: (options?.install as "source" | "local" | "published") ?? "source",
			version: typeof options?.version === "string" ? options.version : null,
			tarball: typeof options?.tarball === "string" ? options.tarball : null,
			binaryArm64: null,
			binaryX64: null,
			build: params.build,
			jobsDir: params.jobsDir,
			jobName: params.jobName,
			gatewayUrl: (options?.gatewayUrl as string) ?? "http://host.docker.internal:4000",
			gatewayToken: (options?.gatewayToken as string) ?? "no-auth",
			providers: Array.isArray(options?.providers) ? (options.providers as string[]) : [],
			gateway: options?.gateway !== false,
			webSearch: Boolean(options?.webSearch),
			allowHosts: Array.isArray(options?.allowHosts) ? (options.allowHosts as string[]) : [],
			timeoutMultiplier: null,
			yes: true,
			dryRun: false,
			cleanup: false,
			cleanupForce: false,
			hostNetwork: false,
			resume: null,
			filterErrorTypes: [],
			envType: params.envType,
			passthrough: [],
			env: (options?.env as Record<string, string>) ?? {},
		};
	}

	async prepare(context: RunContext): Promise<void> {
		const runsDir = context.runsDir || defaultRunsDir();
		const runDir = path.join(runsDir, context.runId);
		await fs.mkdir(runDir, { recursive: true });
		await fs.mkdir(path.join(runsDir, "_bench"), { recursive: true });

		// Source install (the default) runs veyyon from the repo mounted into the task
		// container, so the linux deps tree has to exist before the first trial. A failure
		// here is fatal: without the mount every trial dies in agent setup with
		// "bun mount missing", which is how a whole run used to report 100% errors.
		const agent = typeof context.options?.agent === "string" ? context.options.agent : undefined;
		const installMode = typeof context.options?.install === "string" ? context.options.install : "source";
		if ((!agent || agent === "veyyon") && installMode === "source") {
			const cfg = this.#harborConfig(context, {
				agent: "veyyon",
				model: null,
				task: null,
				jobsDir: runsDir,
				jobName: context.runId,
				envType: harborEnvType(context),
				build: true,
			});
			this.#sourceMount = this.#prepareDeps(cfg);
			// One overlay per run: its bytes depend only on the source mount, so writing it
			// here keeps concurrent trials off a shared file.
			this.#composeOverlayPath = writeComposeOverlay(path.join(runsDir, "_bench"), cfg, this.#sourceMount);
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
		const model = NO_MODEL_AGENTS.has(agent) ? undefined : resolveTrialModel(variant, harness, context).id;

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
			// `model` is already absent for a no-model agent; nothing re-derives that here.
			models: model ? [model] : [],
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
			composeOverlayPath: envType === "docker" ? this.#composeOverlayPath : null,
			mountsJson: envType === "docker" ? null : buildMountsJson(this.#sourceMount),
		};

		const harborArgs = buildHarborArgs(harborArgsOptions);

		const cfg = this.#harborConfig(context, {
			agent,
			model: model ?? null,
			task: cell.task,
			jobsDir: runDir,
			jobName,
			envType: envType === "apple-container" ? "apple-container" : "docker",
			build: false,
		});

		// The gateway proxies model calls back to the host, so each trial gets its own
		// providers file: its contents follow this trial's model.
		const modelsYaml = cfg.gateway ? writeModelsYaml(jobDir, cfg) : "";
		const harborEnv: Record<string, string> =
			agent === "veyyon"
				? buildHarborEnv(cfg, modelsYaml, null, "latest", this.#sourceMount)
				: {
						...(process.env as Record<string, string>),
						...((context.options?.env as Record<string, string>) ?? {}),
					};

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

		// A trial whose agent never reached a provider produced no attempt at the task,
		// and its verifier's 0 is a measurement of the infrastructure, not of the
		// harness. Report it as an error so the run records `reward: null`.
		const agentLog = fileMap["agent/veyyon.txt"];
		if (agentLog) {
			const setupFailure = await agentSetupFailure(agentLog);
			if (setupFailure) {
				throw new Error(`Agent never reached a provider: ${setupFailure}`);
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
