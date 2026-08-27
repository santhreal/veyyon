/**
 * WHY THIS SUITE EXISTS. Three copies decided how a trial's child process dies. The harbor runner's
 * and the pier runner's were identical: SIGTERM the group, wait a grace period, SIGKILL, wait again.
 * The third, in the deep-swe executor, was one `proc.kill()` followed by `await proc.exited` with no
 * bound at all. A pier child that ignores SIGTERM — a Python process blocked on a container wait
 * does — never settled that promise, so the trial's deadline fired, the kill was sent, and the run
 * stopped there: no row, no error, no further output, and a process nobody was watching.
 *
 * The unbounded wait had a second edge the copies shared. Reading a terminated child's pipes assumes
 * the pipe reaches EOF, and a pipe held by a surviving descendant never does, so a caller that kills
 * and then reads can hang after the kill succeeded.
 *
 * THE CLASS THIS CLOSES: a termination path that can wait forever, and a termination result the
 * caller cannot see. `src/core/process-tree.ts` is the only implementation; both backends and the
 * deep-swe executor call it, and it returns whether the tree is gone so a caller can decide not to
 * read pipes a survivor still holds. Every path through it is driven here: exits on SIGTERM, exits
 * on SIGKILL, survives both, a rejecting `exited`, a process with no pid, and a pid that is not its
 * own group leader. `drainTrialOutput` is the bounded read the two container backends use after a
 * kill, and its cases cover a pipe that never closes, one of two that does, and a read that threw.
 *
 * The grace periods are real time — bounding real time is the behaviour under test — so every case
 * passes a grace of a few milliseconds and asserts the outcome rather than the duration.
 *
 * WHAT IT DOES NOT CATCH: whether the OS delivers a group signal to a container's descendants. That
 * needs a real container, and it is what the harbor and pier cleanup paths do after this returns.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import {
	drainTrialOutput,
	KILL_GRACE_PERIOD_MS,
	OUTPUT_DRAIN_GRACE_MS,
	type TerminableProcess,
	type TerminationOutcome,
	terminateProcessTree,
} from "../../src/core";

interface FakeProcess extends TerminableProcess {
	readonly signals: string[];
}

interface FakeOptions {
	/** Which signal, if any, makes this process exit. */
	readonly diesOn?: "SIGTERM" | "SIGKILL";
	readonly pid?: number;
	/** Reject `exited` instead of resolving it, the way a spawn failure surfaces. */
	readonly rejects?: boolean;
}

function fakeProcess(options: FakeOptions = {}): FakeProcess {
	const signals: string[] = [];
	const settled = Promise.withResolvers<number>();
	// A process nobody ever kills keeps this promise pending for the life of the test, which is the
	// state the bound exists for.
	return {
		signals,
		pid: options.pid,
		get exited() {
			return settled.promise;
		},
		kill(signal?: "SIGTERM" | "SIGKILL" | number) {
			const name = typeof signal === "number" ? `signal-${signal}` : (signal ?? "SIGTERM");
			signals.push(name);
			if (options.diesOn && name === options.diesOn) {
				if (options.rejects) settled.reject(new Error("no such process"));
				else settled.resolve(options.diesOn === "SIGTERM" ? 0 : 137);
			}
		},
	};
}

/** Short enough to keep the suite fast, long enough that a signal handler above runs first. */
const GRACE_MS = 20;

/** Only the restore handle is used here; naming it avoids leaning on the runner's mock type. */
interface RestorableSpy {
	mockRestore(): void;
}

describe("one terminator ends a trial's process tree", () => {
	/** Every `process.kill` the terminator makes, so a group signal is observable. */
	let groupSignals: Array<{ pid: number; signal: string | number }>;
	let killSpy: RestorableSpy;

	function recordKills(fail: (pid: number) => boolean = () => false): void {
		killSpy?.mockRestore();
		killSpy = spyOn(process, "kill").mockImplementation((pid: number, signal?: string | number) => {
			if (fail(pid)) throw new Error("ESRCH");
			groupSignals.push({ pid, signal: signal ?? "SIGTERM" });
			return true;
		});
	}

	beforeEach(() => {
		groupSignals = [];
		// The fake processes here own no real pid, so nothing in this file may reach the OS: a
		// group signal for pid 0 would land on this test runner's own process group.
		recordKills();
	});

	afterEach(() => {
		killSpy.mockRestore();
	});
	it("stops at SIGTERM when the tree exits, and reports it gone", async () => {
		const proc = fakeProcess({ diesOn: "SIGTERM" });

		const outcome: TerminationOutcome = await terminateProcessTree(proc, GRACE_MS);

		expect(outcome).toBe("exited");
		expect(proc.signals).toEqual(["SIGTERM"]);
	});

	it("escalates to SIGKILL when the tree outlasts its grace period", async () => {
		const proc = fakeProcess({ diesOn: "SIGKILL" });

		const outcome = await terminateProcessTree(proc, GRACE_MS);

		expect(outcome).toBe("exited");
		expect(proc.signals).toEqual(["SIGTERM", "SIGKILL"]);
	});

	it("reports a tree it could not kill instead of waiting for it", async () => {
		// Ignores everything: the only way this call returns is both bounds.
		const proc = fakeProcess();

		const outcome = await terminateProcessTree(proc, GRACE_MS);

		expect(outcome).toBe("abandoned");
		expect(proc.signals).toEqual(["SIGTERM", "SIGKILL"]);
	});

	it("treats a rejected exit as gone rather than raising it at the caller", async () => {
		const proc = fakeProcess({ diesOn: "SIGTERM", rejects: true });

		const outcome = await terminateProcessTree(proc, GRACE_MS);

		expect(outcome).toBe("exited");
	});

	it("signals the process group before the pid, so a child's descendants are reached", async () => {
		const proc = fakeProcess({ diesOn: "SIGKILL", pid: 4242 });

		await terminateProcessTree(proc, GRACE_MS);

		expect(proc.signals).toEqual(["SIGTERM", "SIGKILL"]);
		expect(groupSignals).toEqual([
			{ pid: -4242, signal: "SIGTERM" },
			{ pid: -4242, signal: "SIGKILL" },
		]);
	});

	it("falls back to the pid when the group signal fails", async () => {
		recordKills(pid => pid < 0);
		const proc = fakeProcess({ diesOn: "SIGTERM", pid: 4242 });

		await terminateProcessTree(proc, GRACE_MS);

		expect(groupSignals).toEqual([{ pid: 4242, signal: "SIGTERM" }]);
	});

	it.each([[undefined], [0], [-1]] as [number | undefined][])(
		"signals only the handle for pid %p, never a group that is not the child's",
		async pid => {
			const proc = fakeProcess({ diesOn: "SIGTERM", pid });

			const outcome = await terminateProcessTree(proc, GRACE_MS);

			expect(outcome).toBe("exited");
			expect(proc.signals).toEqual(["SIGTERM"]);
			// pid 0 signals the caller's own process group and a negative pid an arbitrary one, so
			// neither may reach `process.kill` at all.
			expect(groupSignals).toEqual([]);
		},
	);

	it("bounds the kill grace period at half a second", () => {
		// Pinned as a literal: the abandoned case above reads this constant, so a grace that drifted
		// to a minute would leave this file green while a run stalled a minute per dead trial.
		expect(KILL_GRACE_PERIOD_MS).toBe(500);
	});
});

describe("the output a killed trial produced", () => {
	/** Short enough to keep the suite fast; the bound, not the duration, is what is asserted. */
	const DRAIN_MS = 20;

	it("keeps both pipes when both close", async () => {
		const drained = await drainTrialOutput(Promise.resolve("out"), Promise.resolve("err"), DRAIN_MS);

		expect(drained).toEqual({ stdout: "out", stderr: "err", complete: true });
	});

	it("returns rather than waiting on a pipe a survivor holds open", async () => {
		// Nothing resolves these: the only way this call returns is the bound.
		const held = Promise.withResolvers<string>();
		const also = Promise.withResolvers<string>();

		const drained = await drainTrialOutput(held.promise, also.promise, DRAIN_MS);

		expect(drained).toEqual({ stdout: "", stderr: "", complete: false });
		held.resolve("");
		also.resolve("");
	});

	it("keeps the pipe that closed and states the read was partial", async () => {
		const held = Promise.withResolvers<string>();

		const drained = await drainTrialOutput(Promise.resolve("the agent's last words"), held.promise, DRAIN_MS);

		expect(drained).toEqual({ stdout: "the agent's last words", stderr: "", complete: false });
		held.resolve("");
	});

	it("treats a failed read as empty rather than raising it at the caller", async () => {
		const drained = await drainTrialOutput(
			Promise.reject(new Error("stream already locked")),
			Promise.resolve("err"),
			DRAIN_MS,
		);

		expect(drained).toEqual({ stdout: "", stderr: "err", complete: true });
	});

	it("bounds the drain at two seconds", () => {
		// Pinned as a literal: every case above passes its own grace, so a default that drifted to a
		// minute would leave this file green while each timed-out trial cost a minute of nothing.
		expect(OUTPUT_DRAIN_GRACE_MS).toBe(2000);
	});
});
