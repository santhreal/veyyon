/**
 * WHY THIS SUITE EXISTS. `RunnerManager.cancel` of a run the manager did not spawn — one whose row
 * outlived a manager restart — sent SIGTERM to the pid recorded on disk and then queued an
 * unconditional SIGKILL five seconds later. A runner that exited on the SIGTERM freed its pid, the
 * kernel reused it, and the escalation delivered SIGKILL to whatever owned that number by then. The
 * second signal had no relationship to the run being cancelled, and on a host running other work it
 * killed a process the operator never asked about.
 *
 * THE CLASS THIS CLOSES: a delayed destructive action addressed by a name that stops being unique.
 * The escalation now records the process incarnation before it signals and re-proves it before the
 * kill, through the same `@veyyon/utils` identity primitives the lock reaper uses. This file covers
 * the recorded-pid branch, which is the one addressed by a number the kernel reuses.
 *
 * Time is injected, not slept: the escalation is a `schedule` call on the process-control seam, so
 * each case fires it when the state it wants to test is in place. Nothing here spawns a runner.
 *
 * WHAT IT DOES NOT CATCH: whether the OS identity primitives themselves distinguish a reused pid —
 * that is proven where they live, in `packages/utils`. A platform returning no identity is treated
 * as still-alive by `isProcessInstanceAlive`, so on such a platform this bound degrades to the
 * liveness check, and one case pins that. The managed-child branch is not driven here: it needs a
 * spawned runner. Its handle names one process for its lifetime, so no identity check applies, and
 * what matters there is that the child's exit cancels the pending escalation.
 */

import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CANCEL_ESCALATION_MS, type ProcessControl, RunnerManager } from "../../api/runner";
import { RunStore } from "../../store/sqlite";

const cleanups: Array<() => void> = [];

afterEach(() => {
	while (cleanups.length > 0) {
		cleanups.pop()?.();
	}
});

interface SignalRecord {
	readonly pid: number;
	readonly signal: NodeJS.Signals | number;
}

interface FakeControl extends ProcessControl {
	/** Called after each signal is recorded, so a case can make the process exit under it. */
	onSignal?: (signal: NodeJS.Signals | number) => void;
	readonly sent: SignalRecord[];
	readonly scheduled: Array<{ delayMs: number; escalate: () => void }>;
	readonly cancelled: number[];
	/** The pid table the fake answers from: pid to identity, absent meaning gone. */
	readonly table: Map<number, string | null>;
}

function fakeControl(table: Map<number, string | null>): FakeControl {
	const sent: SignalRecord[] = [];
	const scheduled: Array<{ delayMs: number; escalate: () => void }> = [];
	const cancelled: number[] = [];
	return {
		sent,
		scheduled,
		cancelled,
		table,
		identityOf: pid => table.get(pid) ?? null,
		instanceAlive: (pid, identity) => {
			if (!table.has(pid)) return false;
			const actual = table.get(pid) ?? null;
			// Mirrors isProcessInstanceAlive: an unverifiable identity counts as alive.
			return identity === null || actual === null || actual === identity;
		},
		signal(pid, signal) {
			sent.push({ pid, signal });
			this.onSignal?.(signal);
		},
		schedule: (escalate, delayMs) => {
			const index = scheduled.length;
			scheduled.push({ delayMs, escalate });
			return () => cancelled.push(index);
		},
	};
}

interface Harness {
	readonly jobsDir: string;
	readonly store: RunStore;
	readonly manager: RunnerManager;
	readonly control: FakeControl;
}

/** A running row whose process the manager did not spawn, holding `pid`. */
function harness(pid: number, table: Map<number, string | null>): Harness {
	const jobsDir = fs.mkdtempSync(path.join(os.tmpdir(), "cancel-escalation-test-"));
	const store = new RunStore(jobsDir);
	const control = fakeControl(table);
	const manager = new RunnerManager(jobsDir, store, () => {}, control);
	store.registerLaunch({
		benchmark: "harbor",
		jobName: "adopted",
		dataset: "terminal-bench@2.0",
		agent: "veyyon",
		models: ["anthropic/claude-sonnet-4-5"],
		config: {},
		pid,
	});
	cleanups.push(() => {
		store.close();
		try {
			fs.rmSync(jobsDir, { recursive: true, force: true });
		} catch {}
	});
	return { jobsDir, store, manager, control };
}

/** A pid no process owns, so the manager's own liveness check reaches the fake. */
const LIVE_PID = process.pid;

describe("a cancel of a run the manager did not spawn", () => {
	it("signals the recorded pid and queues one escalation", () => {
		const h = harness(LIVE_PID, new Map([[LIVE_PID, "boot-a:1000"]]));

		expect(h.manager.cancel("adopted")).toEqual({ jobName: "adopted", cancelled: true });
		expect(h.control.sent).toEqual([{ pid: LIVE_PID, signal: "SIGTERM" }]);
		// Pinned as a literal: an escalation that fires immediately gives a runner no chance to
		// exit on the SIGTERM it was just sent, and every other case here reads the constant.
		expect(h.control.scheduled.map(entry => entry.delayMs)).toEqual([5000]);
		expect(CANCEL_ESCALATION_MS).toBe(5000);
	});

	it("escalates to SIGKILL while the pid still names the process it signalled", () => {
		const h = harness(LIVE_PID, new Map([[LIVE_PID, "boot-a:1000"]]));

		h.manager.cancel("adopted");
		h.control.scheduled[0]?.escalate();

		expect(h.control.sent).toEqual([
			{ pid: LIVE_PID, signal: "SIGTERM" },
			{ pid: LIVE_PID, signal: "SIGKILL" },
		]);
	});

	it("sends nothing when the pid has been reused by another process", () => {
		const table = new Map([[LIVE_PID, "boot-a:1000"]]);
		const h = harness(LIVE_PID, table);

		h.manager.cancel("adopted");
		// The runner exited on the SIGTERM and the kernel handed its pid to something else.
		table.set(LIVE_PID, "boot-a:9999");
		h.control.scheduled[0]?.escalate();

		expect(h.control.sent).toEqual([{ pid: LIVE_PID, signal: "SIGTERM" }]);
	});

	it("sends nothing when the signalled process is simply gone", () => {
		const table = new Map([[LIVE_PID, "boot-a:1000"]]);
		const h = harness(LIVE_PID, table);

		h.manager.cancel("adopted");
		table.delete(LIVE_PID);
		h.control.scheduled[0]?.escalate();

		expect(h.control.sent).toEqual([{ pid: LIVE_PID, signal: "SIGTERM" }]);
	});

	it("sends nothing when the pid is reused before the escalation is even queued", () => {
		const table = new Map([[LIVE_PID, "boot-a:1000"]]);
		const h = harness(LIVE_PID, table);
		// The runner dies on the SIGTERM and the pid is handed on immediately. An identity read
		// after the signal would record the new process and then kill it.
		h.control.onSignal = () => table.set(LIVE_PID, "boot-a:9999");

		h.manager.cancel("adopted");
		h.control.scheduled[0]?.escalate();

		expect(h.control.sent).toEqual([{ pid: LIVE_PID, signal: "SIGTERM" }]);
	});

	it("still escalates on a platform that cannot prove incarnation", () => {
		// identityOf returns null there, and a bound that refused to escalate would leave a runner
		// that ignores SIGTERM running for the rest of the operator's day.
		const h = harness(LIVE_PID, new Map([[LIVE_PID, null]]));

		h.manager.cancel("adopted");
		h.control.scheduled[0]?.escalate();

		expect(h.control.sent).toEqual([
			{ pid: LIVE_PID, signal: "SIGTERM" },
			{ pid: LIVE_PID, signal: "SIGKILL" },
		]);
	});
});
