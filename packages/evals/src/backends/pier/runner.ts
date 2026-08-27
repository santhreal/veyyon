import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readPipeText } from "@veyyon/utils";
import { awaitTrialProcessOutput, DEFAULT_GRACE_PERIOD_MS, runBoundedCommand, terminateProcessTree } from "../../core";
import { boundRawOutput, resolveTrialTimeoutSec } from "../../core/trial-deadline";
import type { PreflightVerdict, TrialArtifacts } from "../../core/types";
import { MINIMUM_DEEPSWE_PIER_VERSION, pierSupportsSeparateVerifierCollect } from "./version";

export interface PierJobConfigOptions {
	readonly jobName: string;
	readonly jobsDir: string;
	readonly taskPath: string;
	readonly agentImportPath: string;
	readonly modelName: string;
	readonly kwargs: Readonly<Record<string, unknown>>;
	readonly configDir: string;
}

export interface PierTrialRunOptions {
	readonly jobName: string;
	readonly outRoot: string;
	readonly jobsDir?: string;
	readonly configPath: string;
	readonly pierAgentDir: string;
	readonly trialTimeoutSec: number;
	readonly attempt?: number;
	readonly signal?: AbortSignal;
	readonly exec?: (file: string, args: readonly string[]) => Promise<{ stdout: string; stderr: string }>;
}

export interface PierExecutionResult {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
	readonly trialDirPath: string | null;
	readonly durationMs: number;
	readonly timedOut: boolean;
	readonly error: string | null;
}

export function findPierBinary(explicitPath?: string | null): string | null {
	if (explicitPath && fs.existsSync(explicitPath)) {
		return path.resolve(explicitPath);
	}
	const fromPath = Bun.which("pier");
	if (fromPath && fs.existsSync(fromPath)) {
		return fromPath;
	}
	const fallback = path.join(os.homedir(), ".local", "bin", "pier");
	if (fs.existsSync(fallback)) {
		return fallback;
	}
	return null;
}

export function checkPierPreflight(options?: Readonly<Record<string, unknown>>): PreflightVerdict {
	const explicit = typeof options?.pierBinary === "string" ? options.pierBinary : null;
	const pier = findPierBinary(explicit);
	if (!pier) {
		return {
			ok: false,
			reason: `pier not found on PATH or ~/.local/bin — uv tool install 'datacurve-pier>=${MINIMUM_DEEPSWE_PIER_VERSION}'`,
			missingRequirements: [`datacurve-pier>=${MINIMUM_DEEPSWE_PIER_VERSION}`],
		};
	}

	const versionRun = spawnSync(pier, ["--version"], { encoding: "utf8", timeout: 30_000 });
	const versionOutput = `${versionRun.stdout ?? ""}\n${versionRun.stderr ?? ""}`.trim();
	if (versionRun.error || versionRun.status !== 0 || !pierSupportsSeparateVerifierCollect(versionOutput)) {
		return {
			ok: false,
			reason: `DeepSWE requires Pier >=${MINIMUM_DEEPSWE_PIER_VERSION} for separate-verifier collect hooks; found ${versionOutput || "an unreadable version"}.`,
			missingRequirements: [`datacurve-pier>=${MINIMUM_DEEPSWE_PIER_VERSION}`],
		};
	}

	return { ok: true };
}

export function writePierJobConfig(options: PierJobConfigOptions): string {
	fs.mkdirSync(options.configDir, { recursive: true });
	const configPath = path.join(options.configDir, `${options.jobName}.yaml`);
	const lines = [
		`job_name: ${JSON.stringify(options.jobName)}`,
		`jobs_dir: ${JSON.stringify(options.jobsDir)}`,
		"quiet: true",
		"n_concurrent_trials: 1",
		"tasks:",
		`  - path: ${JSON.stringify(options.taskPath)}`,
		"agents:",
		`  - import_path: ${options.agentImportPath}`,
		`    model_name: ${JSON.stringify(options.modelName)}`,
		"    kwargs:",
		...Object.entries(options.kwargs).map(([k, v]) => `      ${k}: ${JSON.stringify(v)}`),
		"",
	];
	fs.writeFileSync(configPath, lines.join("\n"));
	return configPath;
}

export async function cleanupPierContainers(
	jobName: string,
	exec?: (file: string, args: readonly string[]) => Promise<{ stdout: string; stderr: string }>,
): Promise<void> {
	const runExec = exec ?? runBoundedCommand;

	try {
		const psRes = await runExec("docker", [
			"ps",
			"-a",
			"--format",
			'{{.ID}}\t{{.Names}}\t{{.Label "com.docker.compose.project"}}',
		]);

		const matchedContainerIds: string[] = [];
		for (const line of psRes.stdout.trim().split("\n")) {
			if (!line.trim()) continue;
			const [id, names, project] = line.split("\t");
			if (!id) continue;

			if (
				project === jobName ||
				names === jobName ||
				names?.startsWith(`${jobName}-`) ||
				names?.startsWith(`${jobName}_`) ||
				names?.startsWith(`/${jobName}-`) ||
				names?.startsWith(`/${jobName}_`)
			) {
				matchedContainerIds.push(id);
			}
		}

		if (matchedContainerIds.length > 0) {
			try {
				await runExec("docker", ["rm", "-f", ...matchedContainerIds]);
			} catch {
				/* ignore */
			}
		}

		const netRes = await runExec("docker", [
			"network",
			"ls",
			"--format",
			'{{.ID}}\t{{.Name}}\t{{.Label "com.docker.compose.project"}}',
		]);

		const matchedNetIds: string[] = [];
		for (const line of netRes.stdout.trim().split("\n")) {
			if (!line.trim()) continue;
			const [netId, name, project] = line.split("\t");
			if (!netId) continue;

			if (
				project === jobName ||
				name === jobName ||
				name === `${jobName}_default` ||
				name?.startsWith(`${jobName}-`) ||
				name?.startsWith(`${jobName}_`)
			) {
				matchedNetIds.push(netId);
			}
		}

		if (matchedNetIds.length > 0) {
			for (const netId of matchedNetIds) {
				try {
					await runExec("docker", ["network", "rm", netId]);
				} catch {
					/* ignore */
				}
			}
		}
	} catch {
		/* best effort */
	}
}

export async function runPierTrial(options: PierTrialRunOptions): Promise<PierExecutionResult> {
	const attempt = options.attempt ?? 1;
	const jobDir = options.jobsDir
		? path.join(options.jobsDir, options.jobName)
		: path.join(options.outRoot, "jobs", options.jobName);

	if (attempt > 1 && fs.existsSync(jobDir)) {
		fs.rmSync(jobDir, { recursive: true, force: true });
		await cleanupPierContainers(options.jobName, options.exec);
	}

	const pier = findPierBinary();
	if (!pier) {
		throw new Error("pier executable not found");
	}

	const timeoutSec = resolveTrialTimeoutSec({ timeBudgetSec: options.trialTimeoutSec });

	const started = Date.now();
	const proc = Bun.spawn([pier, "run", "-c", options.configPath, "-q"], {
		cwd: options.pierAgentDir,
		env: { ...process.env, PYTHONPATH: options.pierAgentDir },
		stdout: "pipe",
		stderr: "pipe",
	});

	const killTrial = async (): Promise<void> => {
		await terminateProcessTree(proc, DEFAULT_GRACE_PERIOD_MS);
		await cleanupPierContainers(options.jobName, options.exec);
	};

	const wait = await awaitTrialProcessOutput({
		exited: proc.exited,
		stdout: readPipeText(proc.stdout),
		stderr: readPipeText(proc.stderr),
		timeoutMs: timeoutSec * 1000,
		signal: options.signal,
		terminate: killTrial,
	});

	const stdout = boundRawOutput(wait.stdout) ?? "";
	const stderr = boundRawOutput(wait.stderr) ?? "";
	const exitCode = wait.exitCode;
	const timedOut = wait.kind === "timed_out";

	const durationMs = Date.now() - started;

	let trialDirPath: string | null = null;
	if (fs.existsSync(jobDir)) {
		const entries = fs.readdirSync(jobDir, { withFileTypes: true });
		const trialDirEntry = entries.find(d => d.isDirectory());
		if (trialDirEntry) {
			trialDirPath = path.join(jobDir, trialDirEntry.name);
		}
	}

	if (timedOut) {
		return {
			exitCode,
			stdout,
			stderr,
			trialDirPath,
			durationMs,
			timedOut: true,
			error: wait.outputComplete
				? `trial timed out after ${timeoutSec}s`
				: `trial timed out after ${timeoutSec}s; its process tree held its output open, so the text above is partial`,
		};
	}

	// The wait already terminated the tree for an abort, so this path only reports it.
	if (wait.kind === "aborted" || options.signal?.aborted) {
		throw new Error("Trial aborted: pier execution cancelled");
	}

	const errStr = `pier exit ${exitCode}; ${stderr.slice(-300) || stdout.slice(-300)}`;
	if (
		attempt === 1 &&
		(errStr.includes("Docker compose command failed") ||
			errStr.includes("FileExistsError") ||
			errStr.includes("ENOENT"))
	) {
		return await runPierTrial({ ...options, attempt: 2 });
	}

	return {
		exitCode,
		stdout,
		stderr,
		trialDirPath,
		durationMs,
		timedOut: false,
		error: exitCode !== 0 ? errStr : null,
	};
}

export function trialArtifactsFromExecution(
	trialDirPath: string | null,
	execution: PierExecutionResult,
): TrialArtifacts {
	const logPaths: string[] = [];
	const filePaths: Record<string, string> = {};

	if (trialDirPath && fs.existsSync(trialDirPath)) {
		const patchPath = path.join(trialDirPath, "artifacts", "model.patch");
		if (fs.existsSync(patchPath)) {
			filePaths.patch = patchPath;
		}
		const transcriptPath = path.join(trialDirPath, "agent", "sessions");
		if (fs.existsSync(transcriptPath)) {
			filePaths.transcript = transcriptPath;
		}
	}

	return {
		trialDir: trialDirPath,
		logPaths,
		filePaths,
		rawOutput: boundRawOutput(execution.stdout || execution.stderr),
		extra: {
			exitCode: execution.exitCode,
			durationMs: execution.durationMs,
			timedOut: execution.timedOut,
			error: execution.error,
		},
	};
}
