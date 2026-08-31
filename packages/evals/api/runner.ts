/**
 * Process manager for evals benchmark runners.
 *
 * Spawns detached runner subprocesses, registers their state in the RunStore,
 * manages their process lifecycle (signals, cancel escalation), and handles cleanup.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { getProcessStartIdentity, isProcessAlive, isProcessInstanceAlive } from "@veyyon/utils";
import type { Subprocess } from "bun";
import { DEFAULT_BENCHMARK_KIND, requireBenchmark } from "../store/benchmarks";
import { experimentOf, knownExperimentIds } from "../store/experiments";
import { assertSafeJobName, type LaunchRecord, type RunRow, type RunStore } from "../store/sqlite";
import { evalsPackageDir, requirePathSegment } from "../engine/package-paths";
import type { LaunchRequest } from "../engine/store-shapes";

interface ManagedChild {
	proc: Subprocess;
	jobName: string;
	cancelled: boolean;
}

/** True when `pid` names a live process. A null pid is never live. */
function pidAlive(pid: number | null): boolean {
	return pid != null && isProcessAlive(pid);
}

/** How long a signalled runner has to exit before the manager escalates to SIGKILL. */
export const CANCEL_ESCALATION_MS = 5000;

/**
 * Everything `cancel` needs from the operating system, in one injectable seam.
 *
 * A cancel of a run the manager did not spawn — one that survived a manager restart — signals a pid
 * recorded on disk. The escalation ran on an unconditional timer, so five seconds after a runner
 * exited on SIGTERM the manager sent SIGKILL to whatever owned that pid by then. A pid is reused,
 * and the second signal has no relationship to the run being cancelled: on a busy host it lands on
 * an unrelated process. The escalation now proves the pid is still the same incarnation it
 * signalled, which is what `identityOf` records and `instanceAlive` checks.
 */
export interface ProcessControl {
	identityOf(pid: number): string | null;
	instanceAlive(pid: number, identity: string | null): boolean;
	signal(pid: number, signal: NodeJS.Signals | number): void;
	/** Runs `escalate` after `delayMs`. The returned function cancels it. */
	schedule(escalate: () => void, delayMs: number): () => void;
}

const DEFAULT_PROCESS_CONTROL: ProcessControl = {
	identityOf: pid => getProcessStartIdentity(pid),
	instanceAlive: (pid, identity) => isProcessInstanceAlive(pid, identity),
	signal: (pid, signal) => {
		process.kill(pid, signal);
	},
	schedule: (escalate, delayMs) => {
		// Unreferenced: a pending escalation must not be the reason the manager stays up.
		const timer = setTimeout(escalate, delayMs);
		timer.unref();
		return () => clearTimeout(timer);
	},
};

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
	readonly #control: ProcessControl;
	#stopped = false;

	constructor(
		jobsDir: string,
		store: RunStore,
		onTick: () => void,
		control: ProcessControl = DEFAULT_PROCESS_CONTROL,
	) {
		this.#jobsDir = jobsDir;
		this.#store = store;
		this.#onTick = onTick;
		this.#control = control;
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
		const benchmark = request.benchmark ?? DEFAULT_BENCHMARK_KIND;
		const adapter = requireBenchmark(benchmark);
		const dataset = request.dataset ?? adapter.defaultDataset;
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

		const argv = [...adapter.launchArgv({ request, jobsDir: this.#jobsDir, jobName, jobDir, dataset })];

		const pid = this.#spawnRunner(argv, evalsPackageDir(), {
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
		const adapter = requireBenchmark(run.benchmark);
		const buildResumeArgv = adapter.resumeArgv;
		if (!buildResumeArgv) {
			throw new Error(`benchmark ${adapter.kind} cannot resume a run in place (${jobName})`);
		}
		if (this.isLive(run)) {
			throw new Error(`run ${jobName} is already running`);
		}
		if (run.status === "running") this.#store.markExit(jobName, null, true);
		const jobDir = path.join(this.#jobsDir, jobName);
		const argv = [
			...buildResumeArgv({
				jobsDir: this.#jobsDir,
				jobName,
				jobDir,
				filterErrorTypes: opts.filterErrorTypes ?? erroredExceptionTypes(jobDir),
			}),
		];
		let prewalk: LaunchRequest["prewalk"];
		try {
			prewalk = run.prewalk ? (JSON.parse(run.prewalk) as { into?: string }) : undefined;
		} catch {
			prewalk = undefined;
		}
		const pid = this.#spawnRunner(argv, evalsPackageDir(), {
			benchmark: adapter.kind,
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
			// A child handle names one process for as long as the handle exists, so escalating on it
			// cannot reach a reused pid the way the recorded-pid branch below could.
			const cancelEscalation = this.#control.schedule(() => {
				try {
					child.proc.kill(9);
				} catch {}
			}, CANCEL_ESCALATION_MS);
			child.proc.exited.then(cancelEscalation, cancelEscalation);
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
			// Recorded before the signal: the escalation below sends SIGKILL only while this pid
			// still names the incarnation the SIGTERM went to.
			const identity = this.#control.identityOf(pid);
			try {
				this.#control.signal(pid, "SIGTERM");
			} catch {}
			this.#control.schedule(() => {
				if (!this.#control.instanceAlive(pid, identity)) return;
				try {
					this.#control.signal(pid, "SIGKILL");
				} catch {}
			}, CANCEL_ESCALATION_MS);
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
