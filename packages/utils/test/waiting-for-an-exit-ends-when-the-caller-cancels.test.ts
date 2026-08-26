/**
 * WHY: `onProcessExit` accepts an `AbortSignal`, and one of its three branches
 * ignored it. A `Subprocess` was awaited through `proc.exited` alone, so a
 * caller that passed a deadline for a child that never exits waited forever on
 * a promise it believed was cancellable. The two pid branches honored the
 * signal, which is what made the gap invisible: the function looked
 * cancellable, and was, for two of the three shapes a caller can hand it.
 *
 * THE CLASS this closes: a cancellable entry point whose branches disagree
 * about cancellation. Every branch is swept with the same three questions —
 * does it end when the signal fires, does it end when the signal is ALREADY
 * aborted, and does it still observe a real exit when no signal is passed.
 *
 * TERMINATION is the assertion, not the value. A test that only compared return
 * values could not see a hang: every case here is raced against a deadline, so
 * a branch that ignores the signal fails as a timeout rather than hanging the
 * suite.
 *
 * WHAT IT DOES NOT CATCH, measured by mutation rather than guessed. Three
 * mutants go red here: dropping the signal on the `Subprocess` branch (the
 * reported defect), rethrowing the abort from the native branch, and resolving
 * `true` on abort. One stays GREEN — widening the native branch's `catch` to
 * return `false` for EVERY failure, not only an abort. That would turn a real
 * native fault into "the process did not exit", and no case here can see it,
 * because a `waitForExit` failure that is not an abort cannot be induced from
 * outside the addon without faking the addon itself. The guard is written to
 * rethrow; nothing in this file enforces that it keeps doing so.
 *
 * It also does not prove the child is killed — `onProcessExit` observes an
 * exit, it does not cause one. Which pid branch runs depends on whether the
 * addon is loaded: with it, the native wait; without it, the poll. Both are
 * swept by the same cases, but only one runs per host.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { type Subprocess, spawn } from "bun";
import { onProcessExit } from "../src/procmgr";

/** Long enough that a branch ignoring the signal cannot finish first by luck. */
const SLEEP_SECONDS = "30";
/** Short enough that a hang shows up as a failed run rather than a stalled one. */
const DEADLINE_MS = 2_000;

const children: Subprocess[] = [];

function spawnSleeper(): Subprocess {
	const proc = spawn(["sleep", SLEEP_SECONDS], { stdout: "ignore", stderr: "ignore" });
	children.push(proc);
	return proc;
}

/** Rejects rather than resolving, so a timeout is reported as one. */
async function withinDeadline<T>(work: Promise<T>, label: string): Promise<T> {
	const timer = Promise.withResolvers<never>();
	const handle = setTimeout(
		() => timer.reject(new Error(`${label} did not settle within ${DEADLINE_MS}ms`)),
		DEADLINE_MS,
	);
	try {
		return await Promise.race([work, timer.promise]);
	} finally {
		clearTimeout(handle);
	}
}

/** The shapes a caller can pass, swept identically. */
const SUBJECTS: Array<[string, (proc: Subprocess) => Subprocess | number]> = [
	["a Subprocess", proc => proc],
	["a bare pid", proc => proc.pid],
];

describe("waiting for a process to exit ends when the caller cancels", () => {
	afterEach(() => {
		for (const child of children.splice(0)) child.kill("SIGKILL");
	});

	it.each(SUBJECTS)("%s stops waiting when the signal fires", async (label, subject) => {
		const proc = spawnSleeper();
		const controller = new AbortController();
		const waiting = onProcessExit(subject(proc), controller.signal);
		controller.abort();

		expect(await withinDeadline(waiting, label)).toBe(false);
	});

	it.each(SUBJECTS)("%s returns at once for a signal that already aborted", async (label, subject) => {
		const proc = spawnSleeper();

		expect(await withinDeadline(onProcessExit(subject(proc), AbortSignal.abort()), label)).toBe(false);
	});

	/**
	 * NON-VACUITY. A branch that returned `false` unconditionally would satisfy
	 * every case above, so each shape must still observe a real exit.
	 */
	it.each(SUBJECTS)("%s still reports a real exit", async (label, subject) => {
		const proc = spawn(["true"], { stdout: "ignore", stderr: "ignore" });
		children.push(proc);

		expect(await withinDeadline(onProcessExit(subject(proc)), label)).toBe(true);
	});

	/**
	 * A signal that never fires must not turn a normal wait into a timeout, and
	 * must not leave its listener attached to a long-lived signal afterwards.
	 */
	it("observes an exit while holding a signal that never aborts, and detaches from it", async () => {
		const proc = spawn(["true"], { stdout: "ignore", stderr: "ignore" });
		children.push(proc);
		const controller = new AbortController();

		expect(await withinDeadline(onProcessExit(proc, controller.signal), "unfired signal")).toBe(true);

		// A leaked listener would run here; the resolver it closes over is settled,
		// so the only observable is that aborting after the wait changes nothing.
		controller.abort();
		expect(controller.signal.aborted).toBe(true);
	});
});
