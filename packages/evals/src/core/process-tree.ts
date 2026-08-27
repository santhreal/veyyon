/**
 * Terminating one trial's process tree.
 *
 * Three copies of this decided how a trial's child dies. Two were identical — the harbor runner's
 * and the pier runner's — and the third, in the deep-swe executor, was one `proc.kill()` followed by
 * an unbounded `await proc.exited`. A pier child that ignores SIGTERM, which a Python process
 * blocked on a container wait does, never settled that promise: the trial's deadline fired, the kill
 * was sent, and the run stopped there with no row, no error and no further output.
 *
 * A child also owns descendants. Signalling the pid alone leaves the container, the compose project
 * and the agent process it spawned running, so the group is signalled first and the pid is the
 * fallback for a child that is not its own group leader.
 */

import { DEFAULT_GRACE_PERIOD_MS } from "./trial-deadline";

/** The part of a spawned process this module uses. Both Bun and node children satisfy it. */
export interface TerminableProcess {
	readonly pid?: number;
	kill(signal?: "SIGTERM" | "SIGKILL" | number): unknown;
	readonly exited: Promise<number>;
}

/** How long a SIGKILLed tree has to disappear before termination gives up on it. */
export const KILL_GRACE_PERIOD_MS = 500;

/**
 * `exited` — the process is gone. `abandoned` — it outlasted SIGTERM, SIGKILL and both grace
 * periods, so it is unkillable from here (an uninterruptible syscall, or a pid we may not signal).
 */
export type TerminationOutcome = "exited" | "abandoned";

/** How long a terminated trial's pipes get to reach EOF before whatever arrived is kept. */
export const OUTPUT_DRAIN_GRACE_MS = 2000;

export interface DrainedTrialOutput {
	readonly stdout: string;
	readonly stderr: string;
	/** False when a pipe never reached EOF, so the text below is whatever arrived first. */
	readonly complete: boolean;
}

/**
 * Whatever a terminated trial's pipes produced, bounded.
 *
 * A killed child closes its own pipe ends; a descendant it left behind does not, and the pipe stays
 * open with a reader waiting on EOF that never comes. The harbor and pier backends read their pipes
 * again after killing a timed-out trial, so a trial the deadline had already decided held the worker
 * anyway. Pass the read promises started before the trial was killed: a second read of the same
 * stream returns nothing, because the first reader still holds the lock.
 */
export async function drainTrialOutput(
	stdout: Promise<string>,
	stderr: Promise<string>,
	graceMs = OUTPUT_DRAIN_GRACE_MS,
): Promise<DrainedTrialOutput> {
	const { promise: elapsed, resolve: markElapsed } = Promise.withResolvers<null>();
	const timer = setTimeout(() => markElapsed(null), graceMs);
	// Each pipe is bounded on its own, so output from the one that closed is kept when the other
	// is held open by a survivor.
	const bounded = (pipe: Promise<string>): Promise<string | null> =>
		Promise.race([
			pipe.then(
				text => text,
				() => "",
			),
			elapsed,
		]);
	try {
		const [out, err] = await Promise.all([bounded(stdout), bounded(stderr)]);
		return { stdout: out ?? "", stderr: err ?? "", complete: out !== null && err !== null };
	} finally {
		clearTimeout(timer);
	}
}

function signalTree(proc: TerminableProcess, signal: "SIGTERM" | "SIGKILL"): void {
	try {
		proc.kill(signal);
	} catch {
		// The process may already be gone, which is the outcome this is trying to produce.
	}
	const pid = proc.pid;
	if (typeof pid !== "number" || pid <= 0) return;
	try {
		process.kill(-pid, signal);
	} catch {
		try {
			process.kill(pid, signal);
		} catch {
			// Already exited, or not ours to signal. The wait below decides which.
		}
	}
}

async function exitedWithin(proc: TerminableProcess, graceMs: number): Promise<TerminationOutcome> {
	const { promise: elapsed, resolve: markElapsed } = Promise.withResolvers<"abandoned">();
	const timer = setTimeout(() => markElapsed("abandoned"), graceMs);
	try {
		return await Promise.race([
			proc.exited.then(
				(): TerminationOutcome => "exited",
				(): TerminationOutcome => "exited",
			),
			elapsed,
		]);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Terminate `proc` and everything it spawned: SIGTERM the group, then SIGKILL it if the tree is
 * still there after `gracePeriodMs`. Returns whether the tree is gone.
 *
 * This never waits without a bound. A caller that ignores the outcome gets the same behaviour it
 * had; a caller that goes on to read the process's pipes must not, because a pipe held by a
 * surviving child never reaches EOF.
 */
export async function terminateProcessTree(
	proc: TerminableProcess,
	gracePeriodMs = DEFAULT_GRACE_PERIOD_MS,
): Promise<TerminationOutcome> {
	signalTree(proc, "SIGTERM");
	if ((await exitedWithin(proc, gracePeriodMs)) === "exited") return "exited";
	signalTree(proc, "SIGKILL");
	return await exitedWithin(proc, KILL_GRACE_PERIOD_MS);
}
