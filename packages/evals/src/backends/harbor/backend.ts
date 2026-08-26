/**
 * ExecutionBackend implementation for Harbor benchmark tasks, executing tasks
 * via containerized environments (Docker / Apple Container) using harbor run.
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { $which, errorMessage, isRecord, readPipeText } from "@veyyon/utils";
import { type BackendRegistry, defaultBackendRegistry } from "../../core/backend-registry";
import { resolveCellVariant } from "../../core/cell-variant";
import { getHarness, listHarnesses, requireHarness } from "../../core/harness-registry";
import { boundRawOutput, DEFAULT_GRACE_PERIOD_MS, trialTimeoutFromOptions } from "../../core/trial-deadline";
import { resolveTrialModel } from "../../core/trial-model";
import { runDirFor, trialJobName } from "../../core/trial-naming";
import type {
	BackendId,
	ExecutionBackend,
	HarnessAdapter,
	HarnessBackendBinding,
	PreflightVerdict,
	RunContext,
	TaskDescriptor,
	TrialArtifacts,
	TrialCell,
	VariantAxis,
} from "../../core/types";
import { runsDir as defaultRunsDir } from "../../paths";
import { buildHarborArgs, type HarborRunArgsOptions } from "./launch-args";
import { cleanupHarborTrialContainers, terminateProcessTree } from "./runner/cleanup";
import { buildHarborEnv, type Config, defaultConfig } from "./runner/config";
import { prepareSourceDeps, type SourceMount } from "./runner/deps";
import { gatewayHealthOk, writeModelsYaml } from "./runner/gateway";
import { buildMountsJson, writeComposeOverlay } from "./runner/mounts";

const execFileAsync = promisify(execFile);

/**
 * harbor's own agents that reach no provider: `oracle` replays the reference solution
 * and `nop` does nothing. Every other agent runs a named model or the trial refuses,
 * because a trial that silently used the container's built-in default reports that
 * model's tokens, spend and pass rate as this arm's.
 */
export const NO_MODEL_AGENTS: ReadonlySet<string> = new Set(["nop", "oracle"]);

export class HarborBindingNotFoundError extends Error {
	readonly harnessName: string;
	readonly harborCapableHarnesses: readonly string[];

	constructor(harnessName: string, harborCapableHarnesses: readonly string[]) {
		const formatted = harborCapableHarnesses.length > 0 ? harborCapableHarnesses.join(", ") : "none";
		super(
			`Harness "${harnessName}" declares no binding for backend "harbor". Registered harbor-capable harnesses: ${formatted}`,
		);
		this.name = "HarborBindingNotFoundError";
		this.harnessName = harnessName;
		this.harborCapableHarnesses = [...harborCapableHarnesses];
	}
}

export function requireHarborBinding(harnessOrName: HarnessAdapter | string): HarnessBackendBinding {
	const harness = typeof harnessOrName === "string" ? requireHarness(harnessOrName) : harnessOrName;
	const binding = harness.backends.harbor;
	if (!binding) {
		const harborCapable = listHarnesses()
			.filter(h => Boolean(h.backends.harbor))
			.map(h => h.name);
		throw new HarborBindingNotFoundError(harness.name, harborCapable);
	}
	if (!binding.agentName || typeof binding.agentName !== "string" || binding.agentName.trim() === "") {
		throw new Error(`Harness "${harness.name}" declares a harbor backend binding with no agentName.`);
	}
	return binding;
}

export function harborAgentLogPath(agentNameOrHarness: string | HarnessAdapter): string {
	if (typeof agentNameOrHarness === "string") return `agent/${agentNameOrHarness}.txt`;
	const binding = requireHarborBinding(agentNameOrHarness);
	return `agent/${binding.agentName}.txt`;
}

export type WhichLookup = (bin: string) => string | null;
export type CommandExecutor = (file: string, args: readonly string[]) => Promise<{ stdout: string; stderr: string }>;

export async function defaultCommandExecutor(
	file: string,
	args: readonly string[],
): Promise<{ stdout: string; stderr: string }> {
	return execFileAsync(file, args as string[], { encoding: "utf-8", maxBuffer: 16 * 1024 * 1024 });
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
	/** `harbor run` takes an agent and a model and nothing else this matrix varies. */
	readonly appliesVariantAxes: readonly VariantAxis[] = [];

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
		const harborBin = this.#which("harbor");
		if (!harborBin) {
			return {
				ok: false,
				reason: "harbor not found on PATH. Install with: uv tool install harbor",
				missingRequirements: ["harbor"],
			};
		}
		const envType = typeof context.options?.envType === "string" ? context.options.envType : "docker";
		if (envType === "apple-container") {
			if (!this.#which("container")) {
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
				return {
					ok: false,
					reason: `Docker daemon is not accessible: ${errorMessage(error)}. Ensure Docker daemon is running and current user has permissions.`,
					missingRequirements: ["docker-daemon"],
				};
			}
		}
		if (context.options?.gateway !== false) {
			const gatewayUrl =
				typeof context.options?.gatewayUrl === "string"
					? context.options.gatewayUrl
					: "http://host.docker.internal:4000";
			if (!this.#gatewayHealth(gatewayUrl)) {
				return {
					ok: false,
					reason: `Auth gateway at ${gatewayUrl} is not answering /healthz. Start it on the host with \`vey auth-broker serve\` and \`vey auth-gateway serve --no-auth --bind 127.0.0.1:4000\`, or pass --no-gateway to forward host provider keys into the containers instead.`,
					missingRequirements: ["auth-gateway"],
				};
			}
		}
		const runsDir = context.runsDir || defaultRunsDir();
		try {
			await fs.mkdir(runsDir, { recursive: true });
		} catch (error) {
			return {
				ok: false,
				reason: `Failed to create or access jobs directory at ${runsDir}: ${errorMessage(error)}`,
				missingRequirements: ["jobs-dir"],
			};
		}
		return { ok: true };
	}

	#harborConfig(context: RunContext, params: HarborConfigParams): Config {
		const options = context.options;
		const cfg = defaultConfig({ defaultDataset: context.suite.name || "terminal-bench" });
		cfg.models = params.model ? [params.model] : [];
		cfg.tasks = 1;
		cfg.concurrency = 1;
		cfg.attempts = 1;
		cfg.include = params.task ? [params.task] : [];
		cfg.thinking = typeof options?.thinking === "string" ? options.thinking : null;
		cfg.agentArgs = Array.isArray(options?.agentArgs) ? (options.agentArgs as string[]) : [];
		cfg.agent = params.agent;
		cfg.install = (options?.install as "source" | "local" | "published") ?? "source";
		cfg.version = typeof options?.version === "string" ? options.version : null;
		cfg.tarball = typeof options?.tarball === "string" ? options.tarball : null;
		cfg.build = params.build;
		cfg.jobsDir = params.jobsDir;
		cfg.jobName = params.jobName;
		if (typeof options?.gatewayUrl === "string") cfg.gatewayUrl = options.gatewayUrl;
		if (typeof options?.gatewayToken === "string") cfg.gatewayToken = options.gatewayToken;
		if (Array.isArray(options?.providers)) cfg.providers = options.providers as string[];
		cfg.gateway = options?.gateway !== false;
		cfg.webSearch = Boolean(options?.webSearch);
		if (Array.isArray(options?.allowHosts)) cfg.allowHosts = options.allowHosts as string[];
		cfg.envType = params.envType;
		if (options?.env && typeof options.env === "object") cfg.env = options.env as Record<string, string>;
		return cfg;
	}

	async prepare(context: RunContext): Promise<void> {
		const runsDir = context.runsDir || defaultRunsDir();
		const runDir = path.join(runsDir, context.runId);
		await fs.mkdir(runDir, { recursive: true });
		await fs.mkdir(path.join(runsDir, "_bench"), { recursive: true });

		const agentOption = typeof context.options?.agent === "string" ? context.options.agent : undefined;
		const variantHarness = context.options?.variants?.[0]?.harness;
		const harnessName = agentOption ?? variantHarness ?? "veyyon";
		const harness = getHarness(harnessName);
		const binding = harness?.backends.harbor;
		const installMode = typeof context.options?.install === "string" ? context.options.install : "source";
		if (binding?.sourceMount && installMode === "source") {
			const cfg = this.#harborConfig(context, {
				agent: binding.agentName ?? harnessName,
				model: null,
				task: null,
				jobsDir: runsDir,
				jobName: context.runId,
				envType: harborEnvType(context),
				build: true,
			});
			this.#sourceMount = this.#prepareDeps(cfg);
			this.#composeOverlayPath = writeComposeOverlay(path.join(runsDir, "_bench"), cfg, this.#sourceMount);
		}
	}

	async runTrial(cell: TrialCell, context: RunContext): Promise<TrialArtifacts> {
		if (context.signal?.aborted) throw new Error("Run aborted before trial start");

		const descriptor: TaskDescriptor = await context.suite.describeTask(cell.task, {
			workDir: context.workDir,
			signal: context.signal,
			options: context.options,
		});

		const variant = resolveCellVariant(cell, context);
		const harness = requireHarness(variant.harness);
		const optionAgent = typeof context.options?.agent === "string" ? context.options.agent : undefined;
		let agent: string;
		let agentImportPath: string | null = null;
		let binding: HarnessBackendBinding | undefined;
		if (optionAgent) {
			agent = optionAgent;
			binding = harness.backends.harbor;
		} else {
			binding = requireHarborBinding(harness);
			agent = binding.agentName ?? harness.name;
			agentImportPath = binding.agentImportPath ?? null;
		}
		const model = NO_MODEL_AGENTS.has(agent) ? undefined : resolveTrialModel(variant, harness, context).id;

		const started = Date.now();
		const runsDir = context.runsDir || defaultRunsDir();
		const runDir = runDirFor(runsDir, context.runId);
		await fs.mkdir(runDir, { recursive: true });

		const jobName = `${trialJobName(context.runId, cell)}_${Date.now()}`;
		const jobDir = path.join(runDir, jobName);
		await fs.mkdir(jobDir, { recursive: true });

		const trialTimeoutSec = trialTimeoutFromOptions(descriptor.timeBudgetSec, context.options);

		const metadata = descriptor.metadata;
		const overrideCpus = typeof metadata.cpus === "number" ? metadata.cpus : undefined;
		const overrideMemoryMb = typeof metadata.memory_mb === "number" ? metadata.memory_mb : undefined;
		const overrideStorageMb = typeof metadata.storage_mb === "number" ? metadata.storage_mb : undefined;
		const overrideGpus = typeof metadata.gpus === "number" && metadata.gpus > 0 ? metadata.gpus : undefined;

		const artifactsList = Array.isArray(metadata.artifacts)
			? metadata.artifacts.filter((a): a is string => typeof a === "string")
			: undefined;
		const disableVerification =
			metadata.verifier && typeof metadata.verifier === "object" && "disable" in metadata.verifier
				? Boolean(metadata.verifier.disable)
				: undefined;
		const passthrough = Array.isArray(context.options?.extraArgs)
			? context.options.extraArgs.filter((a): a is string => typeof a === "string")
			: [];

		const envType = typeof context.options?.envType === "string" ? context.options.envType : "docker";

		const harborArgsOptions: HarborRunArgsOptions = {
			taskPath: descriptor.path,
			dataset: descriptor.path ? undefined : context.suite.name || "terminal-bench",
			jobsDir: runDir,
			jobName,
			concurrency: 1,
			attempts: 1,
			tasks: 1,
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

		const modelsYaml = cfg.gateway ? writeModelsYaml(jobDir, cfg) : "";
		const harborEnv: Record<string, string> =
			binding?.sourceMount || binding?.authGateway
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
				stdout = boundRawOutput(await readPipeText(proc.stdout)) ?? "";
				stderr = boundRawOutput(await readPipeText(proc.stderr)) ?? "";
				exitCode = -1;
			} else {
				exitCode = raceResult.code;
				stdout = raceResult.out;
				stderr = raceResult.err;
			}
		} finally {
			clearTimeout(timer);
			if (context.signal) context.signal.removeEventListener("abort", onAbort);
		}

		if (timedOut) throw new Error(`Trial timed out after ${trialTimeoutSec}s (watchdog ceiling)`);
		if (context.signal?.aborted) {
			await killTrial();
			throw new Error(`Trial aborted: harbor exited with code ${exitCode}`);
		}

		let trialDir: string | null = null;
		try {
			const entries = await fs.readdir(jobDir, { withFileTypes: true });
			const match = entries.find(e => e.isDirectory() && (e.name.includes("__") || e.name.startsWith(cell.task)));
			const single =
				!match && entries.filter(e => e.isDirectory()).length === 1 ? entries.find(e => e.isDirectory()) : null;
			trialDir = match || single ? path.join(jobDir, (match || single)!.name) : null;
		} catch {
			/* ignore read error */
		}

		const logPaths: string[] = [];
		const fileMap: Record<string, string> = {};
		if (trialDir) {
			const candidates = [
				harborAgentLogPath(agent),
				"verifier/reward.txt",
				"verifier/reward.json",
				"logs/verifier/reward.txt",
				"logs/verifier/reward.json",
				"verifier/test-stdout.txt",
				"result.json",
				"config.json",
				"lock.json",
			];
			for (const rel of candidates) {
				const full = path.join(trialDir, rel);
				try {
					await fs.access(full);
					fileMap[rel] = full;
					logPaths.push(full);
				} catch {
					/* ignore missing */
				}
			}
		}

		const relAgentLog = harborAgentLogPath(agent);
		const agentLog = fileMap[relAgentLog];
		if (agentLog) {
			const setupFailure = await agentSetupFailure(agentLog);
			if (setupFailure) throw new Error(`Agent never reached a provider: ${setupFailure}`);
		}

		const allowPartial = context.options?.allowPartialResults === true;
		if (exitCode !== 0 && !allowPartial) {
			const outputTail = boundRawOutput(stderr || stdout);
			throw new Error(`Harbor run failed with exit code ${exitCode}${outputTail ? `: ${outputTail}` : ""}`);
		}

		const rawOutput = boundRawOutput(stdout || stderr);
		return {
			trialDir,
			logPaths,
			rawOutput,
			filePaths: fileMap,
			extra: { cell, jobName, jobDir, trialDir, exitCode, durationMs: Date.now() - started },
		};
	}

	async cleanup(cell: TrialCell, context: RunContext): Promise<void> {
		const envType = typeof context.options?.envType === "string" ? context.options.envType : "docker";
		const runsDir = context.runsDir || defaultRunsDir();
		const runDir = runDirFor(runsDir, context.runId);
		const prefix = trialJobName(context.runId, cell);

		if (envType === "docker") {
			try {
				let matchingJobDirs: string[] = [];
				try {
					const entries = await fs.readdir(runDir, { withFileTypes: true });
					matchingJobDirs = entries
						.filter(e => e.isDirectory() && e.name.startsWith(prefix))
						.map(e => path.join(runDir, e.name));
				} catch {
					/* ignore */
				}

				if (matchingJobDirs.length > 0) {
					for (const jobDir of matchingJobDirs) {
						await cleanupHarborTrialContainers(
							{ jobDir, jobName: path.basename(jobDir), force: false },
							this.#exec,
						);
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
