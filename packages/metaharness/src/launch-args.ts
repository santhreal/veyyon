import * as fs from "node:fs";
import * as path from "node:path";
import type { BenchmarkKind, RunRole } from "./store";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..");

export interface LaunchRequest {
	benchmark?: BenchmarkKind;
	model: string;
	dataset?: string;
	tasks?: number;
	include?: string[];
	concurrency?: number;
	timeoutMultiplier?: number;
	attempts?: number;
	agent?: string;
	jobName?: string;
	webSearch?: boolean;
	environment?: "docker" | "apple-container";
	prewalk?: { into?: string };
	role?: RunRole;
	note?: string;
	goal?: string;
	prebuiltBinaries?: boolean;
	extraArgs?: string[];
}

export function harborRunnerArgs(
	request: LaunchRequest,
	opts: { jobsDir: string; jobName: string; dataset: string },
): string[] {
	const argv = ["--model", request.model, "-d", opts.dataset, "--job-name", opts.jobName, "--jobs-dir", opts.jobsDir];
	const environment = request.environment ?? (Bun.which("container") ? "apple-container" : "docker");
	argv.push("--environment", environment);
	if (request.agent) argv.push("--agent", request.agent);
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
			const binary = path.join(REPO_ROOT, "packages", "coding-agent", "dist", name);
			if (fs.existsSync(binary)) argv.push("--binary", binary);
		}
	}
	const ea = request.extraArgs ?? [];
	for (let ai = 0; ai < ea.length; ai++) argv.push(ea[ai]!);
	return argv;
}
