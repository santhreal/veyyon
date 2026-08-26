import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readPipeText } from "@veyyon/utils";
import type { PreflightVerdict, TrialArtifacts } from "../../core/types";
import { MINIMUM_DEEPSWE_PIER_VERSION, pierSupportsSeparateVerifierCollect } from "../../suites/deep-swe/pier-version";

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
	readonly configPath: string;
	readonly pierAgentDir: string;
	readonly trialTimeoutSec: number;
	readonly attempt?: number;
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

export async function cleanupPierContainers(jobName: string): Promise<void> {
	try {
		await Bun.spawn(["sh", "-c", `docker rm -f $(docker ps -aq --filter name=${jobName}) 2>/dev/null || true`])
			.exited;
		await Bun.spawn(["docker", "network", "prune", "-f"]).exited;
	} catch {
		/* best effort */
	}
}

export async function runPierTrial(options: PierTrialRunOptions): Promise<PierExecutionResult> {
	const attempt = options.attempt ?? 1;
	const jobDir = path.join(options.outRoot, "jobs", options.jobName);

	if (attempt > 1 && fs.existsSync(jobDir)) {
		fs.rmSync(jobDir, { recursive: true, force: true });
		await cleanupPierContainers(options.jobName);
	}

	const pier = findPierBinary();
	if (!pier) {
		throw new Error(`pier executable not found`);
	}

	const started = Date.now();
	const proc = Bun.spawn([pier, "run", "-c", options.configPath, "-q"], {
		cwd: options.pierAgentDir,
		env: { ...process.env, PYTHONPATH: options.pierAgentDir },
		stdout: "pipe",
		stderr: "pipe",
	});

	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		proc.kill();
	}, options.trialTimeoutSec * 1000);

	const exitCode = await proc.exited;
	clearTimeout(timer);
	const stdout = await readPipeText(proc.stdout);
	const stderr = await readPipeText(proc.stderr);
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
			error: `trial timed out after ${options.trialTimeoutSec}s`,
		};
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
	const files: Record<string, string> = {};

	if (trialDirPath && fs.existsSync(trialDirPath)) {
		const patchPath = path.join(trialDirPath, "artifacts", "model.patch");
		if (fs.existsSync(patchPath)) {
			files.patch = patchPath;
		}
		const transcriptPath = path.join(trialDirPath, "agent", "sessions");
		if (fs.existsSync(transcriptPath)) {
			files.transcript = transcriptPath;
		}
	}

	return {
		trialDir: trialDirPath,
		logPaths,
		rawOutput: execution.stdout || execution.stderr,
		files,
		extra: {
			exitCode: execution.exitCode,
			durationMs: execution.durationMs,
			timedOut: execution.timedOut,
			error: execution.error,
		},
	};
}
