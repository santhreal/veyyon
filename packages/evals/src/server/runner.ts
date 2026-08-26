/**
 * Process manager for evals benchmark runners.
 *
 * Spawns detached runner subprocesses, registers their state in the RunStore,
 * manages their process lifecycle (signals, cancel escalation), and handles cleanup.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { isProcessAlive } from "@veyyon/utils";
import type { Subprocess } from "bun";
import { harborRunnerArgs } from "../backends/harbor/launch-args";
import { requireBenchmark } from "../manager/benchmarks";
import { experimentOf, knownExperimentIds } from "../manager/experiments";
import { assertSafeJobName, type LaunchRecord, type RunRow, type RunStore } from "../manager/store";
import { evalsPackageDir, requirePathSegment } from "../paths";
import type { LaunchRequest } from "../wire";

interface ManagedChild {
	proc: Subprocess;
	jobName: string;
	cancelled: boolean;
}

/** True when `pid` names a live process. A null pid is never live. */
function pidAlive(pid: number | null): boolean {
	return pid != null && isProcessAlive(pid);
}

/**
 * Exception types recorded in a job's result.json — the errored trials a
 * resume retries by default (reward-0 fails are completed results and stay).
 */
function erroredExceptionTypes(jobDir: string): string[] {
	try {
		const raw = JSON.parse(fs.readFileSync(path.join(jobDir, "result.json"), "utf8")) as {
			stats?: { evals?: Record<string, { exception_stats?: Record<string, unknown> }> };
		};
		const types = new Set<string>();
		for (const ev of Object.values(raw.stats?.evals ?? {})) {
			for (const t of Object.keys(ev.exception_stats ?? {})) types.add(t);
		}
		return [...types];
	} catch {
		return [];
	}
}

/**
 * Opens a run's manager log for append and writes the line that says what is starting.
 *
 * The log was opened with "w", so resuming a run truncated the log of the attempt being
 * resumed: the output explaining why the run needed resuming was gone at the moment it was
 * wanted. Each spawn now adds a header line and the earlier output stays above it.
 */
export function openRunnerLog(
	jobsDir: string,
	jobName: string,
	argv: readonly string[],
	now: () => number = Date.now,
): number {
	const logDir = path.join(jobsDir, "_manager", "logs");
	fs.mkdirSync(logDir, { recursive: true });
	const fd = fs.openSync(path.join(logDir, `${requirePathSegment(jobName, "job name")}.log`), "a");
	fs.writeSync(fd, `=== ${new Date(now()).toISOString()} ${argv.join(" ")}\n`);
	return fd;
}

export class RunnerManager {
	readonly #jobsDir: string;
	readonly #store: RunStore;
	readonly #onTick: () => void;
	readonly #children = new Map<string, ManagedChild>();
	#stopped = false;

	constructor(jobsDir: string, store: RunStore, onTick: () => void) {
		this.#jobsDir = jobsDir;
		this.#store = store;
		this.#onTick = onTick;
	}

	stop(): void {
		this.#stopped = true;
	}

	/** Liveness check that survives manager restarts: managed child, or a running row with a live pid. */
	isLive(run: RunRow): boolean {
		return this.#children.has(run.jobName) || (run.status === "running" && pidAlive(run.pid));
	}

	/** Launch any supported benchmark and register it in the uniform run store. */
	launch(request: LaunchRequest): { jobName: string; pid: number } {
		if (!request.model) throw new Error("model is required");
		const benchmark = request.benchmark ?? "harbor";
		requireBenchmark(benchmark);
		const dataset =
			request.dataset ??
			(benchmark === "harbor" ? "terminal-bench@2.0" : benchmark === "deepswe" ? "deep-swe" : "typescript-edit");
		const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
		const modelSlug = request.model.replace(/[^a-zA-Z0-9]+/g, "-");
		const jobName = request.jobName ?? `${modelSlug}-${stamp}`;
		assertSafeJobName(jobName);
		// A job name names one run. `launch` refused only a running one, so relaunching a
		// settled name dropped that run's trial rows and started writing into its job
		// directory: the disk still held the earlier trials, and syncRun read them back as
		// this run's results. Resuming or deleting the run is the way to reuse the name.
		if (this.#children.has(jobName)) {
			throw new Error(`run ${jobName} is already running; cancel it before launching it again`);
		}
		const existing = this.#store.getRun(jobName);
		if (existing) {
			throw new Error(
				`run ${jobName} already exists (status ${existing.status}); ` +
					`resume it, delete it, or launch under another job name`,
			);
		}
		const jobDir = path.join(this.#jobsDir, jobName);
		if (fs.existsSync(jobDir) && fs.readdirSync(jobDir).length > 0) {
			throw new Error(
				`job directory '${jobDir}' already holds an earlier run's files; ` +
					`delete it before launching ${jobName} again`,
			);
		}
		fs.mkdirSync(jobDir, { recursive: true });

		let argv: string[];
		let cwd: string;
		if (benchmark === "deepswe") {
			cwd = evalsPackageDir();
			argv = ["bun", "src/suites/deep-swe/run.ts", "--model", request.model, "--out", jobDir];
			if (request.tasks !== undefined) argv.push("--limit", String(request.tasks));
			if (request.concurrency !== undefined) argv.push("--jobs", String(request.concurrency));
		} else if (benchmark === "edit") {
			cwd = evalsPackageDir();
			argv = [
				"bun",
				"src/suites/typescript-edit/adapter/cli.ts",
				"--model",
				request.model,
				"--output",
				path.join(jobDir, "result.json"),
			];
			if (request.tasks !== undefined) argv.push("--max-tasks", String(request.tasks));
			if (request.include?.length) argv.push("--tasks", request.include.join(","));
			if (request.concurrency !== undefined) argv.push("--task-concurrency", String(request.concurrency));
			if (request.attempts !== undefined) argv.push("--runs", String(request.attempts));
		} else {
			cwd = evalsPackageDir();
			argv = [
				"bun",
				"src/backends/harbor/runner/cli.ts",
				...harborRunnerArgs(request, { jobsDir: this.#jobsDir, jobName, dataset }),
			];
		}
		if (benchmark !== "harbor") argv.push(...(request.extraArgs ?? []));

		const pid = this.#spawnRunner(argv, cwd, {
			benchmark,
			jobName,
			dataset,
			experiment: request.experiment,
			arm: request.arm,
			agent: request.agent ?? "veyyon",
			models: [request.model],
			prewalk: request.prewalk,
			config: { ...request },
			role: request.role,
			note: request.note,
		});
		if (request.goal) {
			this.#store.setExperimentGoal(
				experimentOf({ jobName, ...request }, knownExperimentIds(this.#store)),
				request.goal,
			);
		}
		return { jobName, pid };
	}

	/** Resume a harbor run in place via the runner's `--resume`. */
	resume(jobName: string, opts: { filterErrorTypes?: string[] } = {}): { jobName: string; pid: number } {
		assertSafeJobName(jobName);
		const run = this.#store.getRun(jobName);
		if (!run) throw new Error(`run ${jobName} not found`);
		if (run.benchmark !== "harbor") {
			throw new Error(`resume supports only harbor runs (${jobName} is ${run.benchmark})`);
		}
		if (this.isLive(run)) {
			throw new Error(`run ${jobName} is already running`);
		}
		if (run.status === "running") this.#store.markExit(jobName, null, true);
		const jobDir = path.join(this.#jobsDir, jobName);
		if (!fs.existsSync(path.join(jobDir, "config.json"))) {
			throw new Error(`${jobName} has no harbor config.json to resume from`);
		}
		const argv = ["bun", "src/backends/harbor/runner/cli.ts", "--resume", jobName, "--jobs-dir", this.#jobsDir];
		for (const t of opts.filterErrorTypes ?? erroredExceptionTypes(jobDir)) argv.push("--filter-error-type", t);
		let prewalk: LaunchRequest["prewalk"];
		try {
			prewalk = run.prewalk ? (JSON.parse(run.prewalk) as { into?: string }) : undefined;
		} catch {
			prewalk = undefined;
		}
		const pid = this.#spawnRunner(argv, evalsPackageDir(), {
			benchmark: "harbor",
			jobName,
			dataset: run.dataset,
			experiment: run.experiment,
			arm: run.arm,
			agent: run.agent,
			models: run.models ? run.models.split(",") : [],
			prewalk,
			config: run.config,
			role: run.role,
			note: run.note,
		});
		return { jobName, pid };
	}

	/** Cancel a managed run. */
	cancel(jobName: string): { jobName: string; cancelled: boolean } {
		assertSafeJobName(jobName);
		const child = this.#children.get(jobName);
		if (child) {
			child.cancelled = true;
			child.proc.kill("SIGTERM");
			const escalate = setTimeout(() => {
				try {
					child.proc.kill(9);
				} catch {}
			}, 5000);
			child.proc.exited.then(() => clearTimeout(escalate));
			return { jobName, cancelled: true };
		}
		const run = this.#store.getRun(jobName);
		if (run?.pid != null) {
			const pid = run.pid;
			// A row can outlive its process: a manager restart, or a runner killed from
			// outside. Reporting `cancelled: true` for a pid nothing signalled claimed a kill
			// that never happened, and marking the row cancelled overwrote whatever the run
			// had actually reached on disk. The store's own reconciliation decides that.
			if (!pidAlive(pid)) {
				this.#store.syncActive();
				return { jobName, cancelled: false };
			}
			try {
				process.kill(pid, "SIGTERM");
			} catch {}
			setTimeout(() => {
				try {
					process.kill(pid, "SIGKILL");
				} catch {}
			}, 5000);
			this.#store.markExit(jobName, null, true);
			return { jobName, cancelled: true };
		}
		return { jobName, cancelled: false };
	}

	/** Permanently delete a run: DB row + trials, job dir, and manager log. */
	deleteRun(jobName: string): boolean {
		assertSafeJobName(jobName);
		const run = this.#store.getRun(jobName);
		if (!run) return false;
		if (this.isLive(run)) throw new Error(`run ${jobName} is running; cancel it first`);
		this.destroyRun(jobName);
		this.#onTick();
		return true;
	}

	/** Remove a run's DB rows and on-disk artifacts (job dir + manager log). */
	destroyRun(jobName: string): void {
		assertSafeJobName(jobName);
		this.#store.deleteRun(jobName);
		fs.rmSync(path.join(this.#jobsDir, jobName), { recursive: true, force: true });
		fs.rmSync(path.join(this.#jobsDir, "_manager", "logs", `${jobName}.log`), { force: true });
	}

	/** Spawn a detached runner child, wire its exit back into the store, and register the run. */
	#spawnRunner(argv: string[], cwd: string, record: Omit<LaunchRecord, "pid">): number {
		const jobName = record.jobName;
		const logFile = openRunnerLog(this.#jobsDir, jobName, argv);
		const proc = Bun.spawn(argv, {
			cwd,
			stdout: logFile,
			stderr: logFile,
			env: { ...process.env },
			detached: true,
		});
		const child: ManagedChild = { proc, jobName, cancelled: false };
		this.#children.set(jobName, child);
		proc.exited.then(exitCode => {
			try {
				fs.closeSync(logFile);
			} catch {}
			if (this.#stopped) return;
			this.#store.markExit(jobName, exitCode, child.cancelled);
			this.#store.syncRun(jobName);
			this.#children.delete(jobName);
			this.#onTick();
		});
		this.#store.registerLaunch({ ...record, pid: proc.pid });
		this.#onTick();
		return proc.pid;
	}
}
