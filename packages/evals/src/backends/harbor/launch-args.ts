/**
 * Shared launch surface: the POST /api/runs request shape and its mapping to
 * runner CLI argv. The server uses it to spawn new harbor runs; the runner's
 * `--resume` uses it to rebuild the original invocation from a job dir's
 * manager.json launch record when no runner-config.json snapshot exists.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { getHarness } from "../../core/harness-registry";
import { codingAgentDir } from "../../paths";
import type { LaunchRequest, RunRole } from "../../wire";

export type { LaunchRequest, RunRole };
export const AGENT_IMPORT_PATH = "veyyon_local:VeyyonLocal";

export interface HarborRunArgsOptions {
	/** Path to a specific task or dataset directory (-p). */
	taskPath?: string | null;
	/** Dataset name@version (-d). */
	dataset?: string | null;
	/** Output jobs directory (-o). */
	jobsDir: string;
	/** Job name (--job-name). */
	jobName: string;
	/** Concurrency (-n). */
	concurrency?: number;
	/** Number of attempts per task (-k). */
	attempts?: number;
	/** Max tasks limit (-l). */
	tasks?: number;
	/** Models (-m, repeatable). */
	models?: readonly string[];
	/** Agent name or custom import path (-a or --agent-import-path). Default "veyyon". */
	agent?: string;
	/** Custom agent import path (--agent-import-path). */
	agentImportPath?: string | null;
	/** Included task IDs/patterns (-i, repeatable). */
	include?: readonly string[];
	/** Excluded task IDs/patterns (-x, repeatable). */
	exclude?: readonly string[];
	/** Allowed agent hosts (--allow-agent-host, repeatable). */
	allowHosts?: readonly string[];
	/** Timeout multiplier (--timeout-multiplier). */
	timeoutMultiplier?: number | null;
	/** Auto-confirm prompts (-y). Default true. */
	yes?: boolean;
	/** Additional Docker Compose overlay file (--extra-docker-compose). */
	composeOverlayPath?: string | null;
	/** Environment backend (-e, e.g. "apple-container"). Defaults to docker. */
	envType?: "docker" | "apple-container" | string;
	/** Mounts JSON array (--mounts). */
	mountsJson?: string | null;
	/** Override CPUs (--override-cpus). */
	overrideCpus?: number | null;
	/** Override memory in MB (--override-memory-mb). */
	overrideMemoryMb?: number | null;
	/** Override storage in MB (--override-storage-mb). */
	overrideStorageMb?: number | null;
	/** Override GPUs (--override-gpus). */
	overrideGpus?: number | null;
	/** Artifacts to collect (--artifact, repeatable). */
	artifacts?: readonly string[];
	/** Disable verification (--disable-verification). */
	disableVerification?: boolean;
	/** Extra passthrough arguments. */
	passthrough?: readonly string[];
}

/**
 * Construct `harbor run` command-line arguments.
 * Shared by both the Harbor standalone runner and the ExecutionBackend.
 */
export function buildHarborArgs(options: HarborRunArgsOptions): string[] {
	const a: string[] = ["run"];
	if (options.taskPath) {
		a.push("-p", options.taskPath);
	} else if (options.dataset) {
		a.push("-d", options.dataset);
	}
	a.push("-o", options.jobsDir, "--job-name", options.jobName);
	if (options.concurrency !== undefined) a.push("-n", String(options.concurrency));
	if (options.attempts !== undefined) a.push("-k", String(options.attempts));
	if (options.tasks !== undefined) a.push("-l", String(options.tasks));
	for (const m of options.models ?? []) a.push("-m", m);
	for (const inc of options.include ?? []) a.push("-i", inc);
	for (const exc of options.exclude ?? []) a.push("-x", exc);
	for (const h of options.allowHosts ?? []) a.push("--allow-agent-host", h);
	if (options.timeoutMultiplier !== undefined && options.timeoutMultiplier !== null) {
		a.push("--timeout-multiplier", String(options.timeoutMultiplier));
	}
	if (options.yes ?? true) a.push("-y");
	if (options.composeOverlayPath) {
		a.push("--extra-docker-compose", options.composeOverlayPath);
	}
	if (options.envType && options.envType !== "docker") {
		a.push("-e", options.envType);
	}
	if (options.mountsJson) {
		a.push("--mounts", options.mountsJson);
	}
	if (options.overrideCpus !== undefined && options.overrideCpus !== null) {
		a.push("--override-cpus", String(options.overrideCpus));
	}
	if (options.overrideMemoryMb !== undefined && options.overrideMemoryMb !== null) {
		a.push("--override-memory-mb", String(options.overrideMemoryMb));
	}
	if (options.overrideStorageMb !== undefined && options.overrideStorageMb !== null) {
		a.push("--override-storage-mb", String(options.overrideStorageMb));
	}
	if (options.overrideGpus !== undefined && options.overrideGpus !== null && options.overrideGpus > 0) {
		a.push("--override-gpus", String(options.overrideGpus));
	}
	for (const art of options.artifacts ?? []) {
		a.push("--artifact", art);
	}
	if (options.disableVerification) {
		a.push("--disable-verification");
	}

	const agent = options.agent ?? "veyyon";
	if (options.agentImportPath) {
		a.push("--agent-import-path", options.agentImportPath);
	} else {
		const harness = getHarness(agent);
		const binding = harness?.backends.harbor;
		if (binding?.agentImportPath) {
			a.push("--agent-import-path", binding.agentImportPath);
		} else {
			a.push("-a", binding?.agentName ?? agent);
		}
	}

	if (options.passthrough && options.passthrough.length > 0) {
		a.push(...options.passthrough);
	}
	return a;
}

/** Runner CLI flags (sans the `bun src/runner.ts` prefix) for a harbor launch. */
export function harborRunnerArgs(
	request: LaunchRequest,
	opts: { jobsDir: string; jobName: string; dataset: string },
): string[] {
	const argv = ["--model", request.model, "-d", opts.dataset, "--job-name", opts.jobName, "--jobs-dir", opts.jobsDir];
	// Prefer Apple Container when its CLI is present: native arm64 task
	// containers with no Docker daemon. The runner itself defaults to
	// docker, so the preference must be stated here.
	const environment = request.environment ?? (Bun.which("container") ? "apple-container" : "docker");
	argv.push("--environment", environment);
	if (request.agent) argv.push("--agent", request.agent);
	// An explicit include list IS the sample — never let the runner's
	// default task cap truncate it.
	const tasks = request.tasks ?? (request.include && request.include.length > 0 ? request.include.length : undefined);
	if (tasks !== undefined) argv.push("--tasks", String(tasks));
	if (request.concurrency !== undefined) argv.push("--concurrency", String(request.concurrency));
	if (request.attempts !== undefined) argv.push("--attempts", String(request.attempts));
	if (request.timeoutMultiplier !== undefined) argv.push("--timeout-multiplier", String(request.timeoutMultiplier));
	if (request.webSearch) argv.push("--web-search");
	for (const task of request.include ?? []) argv.push("--include", task);
	if (request.prewalk) {
		argv.push("--agent-arg", "--prewalk");
		if (request.prewalk.into) {
			argv.push("--agent-arg", "--prewalk-into", "--agent-arg", request.prewalk.into);
			const provider = request.prewalk.into.split("/", 1)[0];
			if (provider && request.prewalk.into.includes("/")) argv.push("--providers", provider);
		}
	}
	if (request.prebuiltBinaries) {
		for (const name of ["vey-linux-arm64", "vey-linux-x64"]) {
			const binary = path.join(codingAgentDir(), "dist", name);
			if (fs.existsSync(binary)) argv.push("--binary", binary);
		}
	}
	argv.push(...(request.extraArgs ?? []));
	return argv;
}
