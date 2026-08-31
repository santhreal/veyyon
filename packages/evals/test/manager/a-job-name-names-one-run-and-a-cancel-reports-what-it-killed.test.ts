/**
 * WHY THIS SUITE EXISTS.
 *
 * `RunnerManager.launch` refused a job name only while that run was still running. Launching a
 * settled name went through: `registerLaunch` deleted the earlier run's trial rows and reset the
 * row to running, while the job directory on disk still held the earlier run's trial output, so
 * `syncRun` read those files back and reported them as the new run's results. Two runs then
 * shared one row, one directory and one set of numbers.
 *
 * `cancel` had the matching problem in the other direction. A row can outlive its process — a
 * manager restart, or a runner killed from outside — and `cancel` signalled the recorded pid,
 * swallowed the ESRCH, marked the row cancelled and reported `cancelled: true`. That claimed a
 * kill that never happened and overwrote whatever the run had actually reached on disk.
 *
 * The class this closes: a manager operation that reports success for work it did not do, and a
 * name that identifies two runs. The suite drives the real `RunnerManager` against a real
 * `RunStore` on a temp jobs directory, and every case here refuses before a child process could
 * exist, so nothing in it spawns a runner.
 *
 * The same class covers the manager's own log. It was opened with "w", so resuming a run
 * truncated the log of the attempt being resumed: the output explaining why the run needed
 * resuming was gone at the moment it was wanted.
 *
 * What it does not catch: the live-child branch of `cancel`, which needs a spawned runner to
 * signal, and the reconciliation `syncActive` performs, which is proven where the store is.
 */

import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { openRunnerLog, RunnerManager } from "../../api/runner";
import type { LaunchRequest } from "../../engine/store-shapes";
import { RunStore } from "../../store/sqlite";

const cleanups: Array<() => void> = [];

afterEach(() => {
	while (cleanups.length > 0) {
		cleanups.pop()?.();
	}
});

interface Harness {
	readonly jobsDir: string;
	readonly store: RunStore;
	readonly manager: RunnerManager;
	ticks: number;
}

function harness(): Harness {
	const jobsDir = fs.mkdtempSync(path.join(os.tmpdir(), "job-name-identity-test-"));
	const store = new RunStore(jobsDir);
	const state = { jobsDir, store, ticks: 0 } as { jobsDir: string; store: RunStore; ticks: number };
	const manager = new RunnerManager(jobsDir, store, () => {
		state.ticks += 1;
	});
	cleanups.push(() => {
		store.close();
		try {
			fs.rmSync(jobsDir, { recursive: true, force: true });
		} catch {}
	});
	return Object.assign(state, { manager });
}

const REQUEST: LaunchRequest = {
	model: "anthropic/claude-sonnet-4-5",
	benchmark: "harbor",
	dataset: "terminal-bench@2.0",
};

/** A settled run: the row a manager writes at launch, then the exit its child reported. */
function settledRun(h: Harness, jobName: string, exitCode: number): void {
	h.store.registerLaunch({
		benchmark: "harbor",
		jobName,
		dataset: "terminal-bench@2.0",
		agent: "veyyon",
		models: ["anthropic/claude-sonnet-4-5"],
		config: {},
		pid: 1,
	});
	h.store.markExit(jobName, exitCode);
	fs.mkdirSync(path.join(h.jobsDir, jobName), { recursive: true });
	fs.writeFileSync(path.join(h.jobsDir, jobName, "result.json"), JSON.stringify({ trials: [] }));
}

describe("a launch under a name that already names a run", () => {
	it("is refused, and states the status of the run holding the name", () => {
		const h = harness();
		settledRun(h, "held-name", 0);

		expect(() => h.manager.launch({ ...REQUEST, jobName: "held-name" })).toThrow(/already exists \(status/);
		expect(() => h.manager.launch({ ...REQUEST, jobName: "held-name" })).toThrow(/resume it, delete it/);
	});

	it("is refused whatever the earlier run ended as", () => {
		for (const [jobName, exitCode] of [
			["ended-clean", 0],
			["ended-red", 1],
		] as Array<[string, number]>) {
			const h = harness();
			settledRun(h, jobName, exitCode);
			expect(() => h.manager.launch({ ...REQUEST, jobName })).toThrow(/already exists/);
		}
	});

	it("leaves the earlier run's row and files exactly as they were", () => {
		const h = harness();
		settledRun(h, "kept-run", 0);
		const before = h.store.getRun("kept-run");
		expect(before?.status).toBe("complete");

		expect(() => h.manager.launch({ ...REQUEST, jobName: "kept-run" })).toThrow();

		const after = h.store.getRun("kept-run");
		expect(after?.status).toBe("complete");
		expect(after?.pid).toBeNull();
		expect(fs.existsSync(path.join(h.jobsDir, "kept-run", "result.json"))).toBe(true);
	});

	it("is refused when a job directory holds files but no run row was ever written", () => {
		const h = harness();
		const jobDir = path.join(h.jobsDir, "orphan-dir");
		fs.mkdirSync(jobDir, { recursive: true });
		fs.writeFileSync(path.join(jobDir, "config.json"), "{}");
		expect(h.store.getRun("orphan-dir")).toBeNull();

		expect(() => h.manager.launch({ ...REQUEST, jobName: "orphan-dir" })).toThrow(/already holds an earlier run/);
	});

	it("refuses a path in a job name before it decides anything else", () => {
		const h = harness();
		expect(() => h.manager.launch({ ...REQUEST, jobName: "../escaped" })).toThrow();
		expect(fs.existsSync(path.join(h.jobsDir, "..", "escaped"))).toBe(false);
	});
});

describe("a cancel of a run whose process is gone", () => {
	/** A pid no process owns: the row outlived its runner. */
	function deadPid(): number {
		for (let candidate = 2 ** 22 - 1; candidate > 100_000; candidate -= 7) {
			try {
				process.kill(candidate, 0);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ESRCH") return candidate;
			}
		}
		throw new Error("no unused pid found");
	}

	it("reports that it cancelled nothing instead of claiming a kill", () => {
		const h = harness();
		h.store.registerLaunch({
			benchmark: "harbor",
			jobName: "vanished",
			dataset: "terminal-bench@2.0",
			agent: "veyyon",
			models: ["anthropic/claude-sonnet-4-5"],
			config: {},
			pid: deadPid(),
		});
		expect(h.store.getRun("vanished")?.status).toBe("running");

		expect(h.manager.cancel("vanished")).toEqual({ jobName: "vanished", cancelled: false });
	});

	it("does not record the run as cancelled by an operator who cancelled nothing", () => {
		const h = harness();
		h.store.registerLaunch({
			benchmark: "harbor",
			jobName: "vanished-status",
			dataset: "terminal-bench@2.0",
			agent: "veyyon",
			models: ["anthropic/claude-sonnet-4-5"],
			config: {},
			pid: deadPid(),
		});

		h.manager.cancel("vanished-status");
		expect(h.store.getRun("vanished-status")?.status).not.toBe("cancelled");
	});

	it("reports nothing cancelled for a run it has never heard of", () => {
		const h = harness();
		expect(h.manager.cancel("never-launched")).toEqual({ jobName: "never-launched", cancelled: false });
	});

	it("refuses a path in the name it is asked to cancel", () => {
		const h = harness();
		expect(() => h.manager.cancel("../escaped")).toThrow();
	});
});

describe("a run's manager log", () => {
	it("keeps the earlier attempt's output when the run is spawned again", () => {
		const h = harness();
		const logPath = path.join(h.jobsDir, "_manager", "logs", "twice.log");

		const first = openRunnerLog(h.jobsDir, "twice", ["bun", "runner.ts", "--model", "m"], () => 0);
		fs.writeSync(first, "first attempt said this\n");
		fs.closeSync(first);

		const second = openRunnerLog(h.jobsDir, "twice", ["bun", "runner.ts", "--resume", "twice"], () => 1000);
		fs.writeSync(second, "second attempt said that\n");
		fs.closeSync(second);

		const written = fs.readFileSync(logPath, "utf-8");
		expect(written).toContain("first attempt said this");
		expect(written).toContain("second attempt said that");
		expect(written.indexOf("first attempt")).toBeLessThan(written.indexOf("second attempt"));
	});

	it("states what each spawn ran, so two attempts are told apart", () => {
		const h = harness();
		const fd = openRunnerLog(h.jobsDir, "stated", ["bun", "runner.ts", "--resume", "stated"], () => 0);
		fs.closeSync(fd);
		const written = fs.readFileSync(path.join(h.jobsDir, "_manager", "logs", "stated.log"), "utf-8");
		expect(written).toStartWith("=== 1970-01-01T00:00:00.000Z bun runner.ts --resume stated\n");
	});

	it("refuses a job name that is a path rather than writing outside the log directory", () => {
		const h = harness();
		expect(() => openRunnerLog(h.jobsDir, "../escaped", ["bun", "runner.ts"])).toThrow();
		expect(fs.existsSync(path.join(h.jobsDir, "_manager", "escaped.log"))).toBe(false);
	});
});
