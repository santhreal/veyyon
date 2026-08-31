import * as path from "node:path";
import { isProcessAlive } from "@veyyon/utils";
import type { Subprocess } from "bun";
import { experimentOf } from "./experiments";
import type { LaunchRequest } from "./launch-args";
import { DEFAULT_JOBS_DIR } from "./paths";
import type { RunRole, RunRow, RunStore } from "./store";

export const PKG_DIR = path.resolve(import.meta.dir, "..");

export type { LaunchRequest } from "./launch-args";

export interface AddArmRequest {
	arm: string;
	model: string;
	prewalk?: LaunchRequest["prewalk"];
	include?: string[];
	role?: RunRole;
	note?: string;
	extraArgs?: string[];
}

export interface ManagedChild {
	proc: Subprocess;
	jobName: string;
	cancelled: boolean;
}

export const enum SseState {
	Open = 0,
	Closed = 1,
}

export interface SseClient {
	controller: ReadableStreamDefaultController<Uint8Array>;
	state: SseState;
}

export function parseServerArgs(argv: string[]): { port: number; jobsDir: string } {
	let port = 4700;
	let jobsDir = DEFAULT_JOBS_DIR;
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--port" && argv[i + 1]) port = Number(argv[++i]);
		else if (argv[i] === "--jobs-dir" && argv[i + 1]) jobsDir = path.resolve(argv[++i]);
	}
	if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("--port must be 1..65535");
	return { port, jobsDir };
}

export function assertSafeJobName(jobName: string): void {
	if (!jobName || jobName === "." || jobName === ".." || /[/\\]/.test(jobName)) {
		throw new Error(`invalid job name: ${jobName}`);
	}
}

export function pidAlive(pid: number | null): boolean {
	return pid != null && isProcessAlive(pid);
}

export function resolveArmLaunch(store: RunStore, experimentId: string, req: AddArmRequest): LaunchRequest {
	if (!req.arm || /[^\w.-]/.test(req.arm)) throw new Error("arm must be a non-empty [A-Za-z0-9_.-] token");
	if (!req.model) throw new Error("model is required");
	const siblings = store.listRuns().filter(r => experimentOf(r.jobName) === experimentId);
	if (siblings.length === 0) throw new Error(`experiment '${experimentId}' has no runs to inherit from`);
	const strings = (v: unknown): string[] =>
		Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
	const recordedInclude = (r: RunRow): string[] => strings((r.config as Partial<LaunchRequest>).include);
	const score = (r: RunRow): [number, number] => {
		const recorded = recordedInclude(r).length;
		return recorded > 0 ? [1, recorded] : [0, store.listTraces(r.jobName).length];
	};
	let template = siblings[0];
	let templateScore = score(template);
	for (const r of siblings.slice(1)) {
		const s = score(r);
		if (s[0] > templateScore[0] || (s[0] === templateScore[0] && s[1] > templateScore[1])) {
			[template, templateScore] = [r, s];
		}
	}
	const cfg = template.config as Partial<LaunchRequest>;
	const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
	const numberOr = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
	let include = req.include && req.include.length > 0 ? req.include : strings(cfg.include);
	if (include.length === 0) {
		const org = template.dataset.includes("/") ? `${template.dataset.split("/", 1)[0]}/` : "";
		include = [
			...new Set(
				store
					.listTraces(template.jobName)
					.map(t => t.task)
					.filter(Boolean)
					.map(task => (task.includes("/") ? task : `${org}${task}`)),
			),
		];
	}
	const jobName = `${experimentId}-${req.arm}`;
	if (store.getRun(jobName)) throw new Error(`arm '${req.arm}' already exists in '${experimentId}'`);
	return {
		benchmark: template.benchmark,
		model: req.model,
		dataset: template.dataset,
		include: include.length > 0 ? include : undefined,
		tasks: include.length > 0 ? include.length : numberOr(cfg.tasks),
		concurrency: numberOr(cfg.concurrency),
		timeoutMultiplier: numberOr(cfg.timeoutMultiplier),
		attempts: numberOr(cfg.attempts),
		agent: str(cfg.agent),
		webSearch: cfg.webSearch === true || undefined,
		prebuiltBinaries: cfg.prebuiltBinaries === true || undefined,
		jobName,
		prewalk: req.prewalk,
		role: req.role,
		note: req.note,
		environment: cfg.environment === "docker" || cfg.environment === "apple-container" ? cfg.environment : undefined,
		extraArgs: req.extraArgs,
	};
}
