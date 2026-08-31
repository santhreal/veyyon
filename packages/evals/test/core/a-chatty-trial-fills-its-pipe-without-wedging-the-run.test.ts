/**
 * WHY: the deep-swe executor read a trial's pipes after the trial had exited, with the deadline
 * already cancelled.
 *
 * A child's exit does not close its pipes. A container, an agent process or a stray `&` the trial
 * left behind inherits the write end, and `readPipeText` waits for an EOF that arrives when that
 * descendant ends — which for a wedged container is never. The old shape was `await proc.exited`,
 * `clearTimeout(timer)`, then the two reads: by the time the reads could hang, the only thing that
 * could have interrupted them had been cancelled. The run stopped there with no row, no error and no
 * further output.
 *
 * THE CLASS THIS CLOSES: an unbounded read of a pipe the trial no longer owns.
 * `awaitTrialProcessOutput` keeps its deadline armed across both the exit and the reads, terminates
 * the tree when it fires, and drains what the pipes produced under its own bound — so a held pipe
 * costs the trial its deadline instead of the run. The cases drive a real child that leaves a
 * descendant holding stdout, and a negative control asserts the old ordering still hangs, because a
 * control that stopped hanging would mean these cases prove nothing.
 *
 * WHAT IT DOES NOT CATCH: a future caller that spawns a child and awaits `proc.exited` directly
 * instead of going through the wait. That is a structural invariant a lint rule owns. Bun buffers
 * pipe output the process has not read, so this suite says nothing about a 64KiB kernel pipe
 * blocking a child mid-write; it does assert a large output arrives whole.
 */

import { describe, expect, it } from "bun:test";
import { setTimeout as sleepFor } from "node:timers/promises";
import { readPipeText } from "@veyyon/utils";
import { awaitTrialProcessOutput } from "../../engine/trial-process";

/** Larger than a kernel pipe buffer, so the whole output cannot be in flight at once. */
const OUTPUT_BYTES = 400_000;
/** Long enough for 400KB through a pipe, short enough that a hang loses the race. */
const OBSERVATION_MS = 3000;
/** How long the control watches the old ordering fail to make progress. */
const CONTROL_MS = 1000;
/** A deadline that fires while the descendant still holds the pipe. */
const DEADLINE_MS = 200;
/** A child that exits at once and leaves a descendant holding its stdout for half a minute. */
const LEAVES_A_DESCENDANT = "(sleep 30 &) ; printf 'partial output' ; exit 0";

interface TrialOutcome {
	readonly kind: string;
	readonly bytes: number;
	readonly exitCode: number;
}

function chattyTrial(bytes: number): Bun.Subprocess {
	return Bun.spawn(["sh", "-c", `head -c ${bytes} /dev/zero | tr '\\0' 'x'`], { stdout: "pipe", stderr: "pipe" });
}

async function waitFor(proc: Bun.Subprocess, timeoutMs: number, terminated: string[]): Promise<TrialOutcome | "hung"> {
	const waiting = awaitTrialProcessOutput({
		exited: proc.exited,
		stdout: readPipeText(proc.stdout as ReadableStream<Uint8Array>),
		stderr: readPipeText(proc.stderr as ReadableStream<Uint8Array>),
		timeoutMs,
		// The default 2s drain is pinned by the terminator suite; this keeps the case quick.
		drainGraceMs: 50,
		terminate: async () => {
			terminated.push("terminate");
			proc.kill("SIGKILL");
		},
	}).then(wait => ({ kind: wait.kind, bytes: wait.stdout.length, exitCode: wait.exitCode }));

	// Raced against real time on purpose: the defect this closes is a wait that never ends, which an
	// await alone cannot observe. The outcome is asserted, never a duration.
	return await Promise.race([waiting, sleepFor(OBSERVATION_MS).then((): "hung" => "hung")]);
}

describe("a trial whose output outlives it", () => {
	it("ends at its deadline when a descendant holds the pipe open", async () => {
		const proc = Bun.spawn(["sh", "-c", LEAVES_A_DESCENDANT], { stdout: "pipe", stderr: "pipe" });
		const terminated: string[] = [];

		const outcome = await waitFor(proc, DEADLINE_MS, terminated);

		expect(outcome).toEqual({ kind: "timed_out", bytes: 0, exitCode: -1 });
		expect(terminated).toEqual(["terminate"]);
	});

	it("hangs when the read waits for the exit, which is the defect this closes", async () => {
		const proc = Bun.spawn(["sh", "-c", LEAVES_A_DESCENDANT], { stdout: "pipe", stderr: "pipe" });

		// The pre-fix ordering, written out: the child has exited, its deadline is gone, and the read
		// waits on an EOF the descendant will not send. A negative control — if this ever stops
		// hanging, the case above stopped proving anything.
		await proc.exited;
		const outcome = await Promise.race([
			readPipeText(proc.stdout as ReadableStream<Uint8Array>).then(text => `read ${text.length}`),
			sleepFor(CONTROL_MS).then((): "still waiting" => "still waiting"),
		]);

		expect(outcome).toBe("still waiting");
		proc.kill("SIGKILL");
	});

	it("reads a large output whole when the trial closes its own pipes", async () => {
		const outcome = await waitFor(chattyTrial(OUTPUT_BYTES), OBSERVATION_MS * 4, []);

		expect(outcome).toEqual({ kind: "exited", bytes: OUTPUT_BYTES, exitCode: 0 });
	});

	it("reports a failing trial's exit code alongside the output it managed to print", async () => {
		const proc = Bun.spawn(["sh", "-c", "head -c 200000 /dev/zero | tr '\\0' 'x'; printf boom 1>&2; exit 4"], {
			stdout: "pipe",
			stderr: "pipe",
		});

		const wait = await Promise.race([
			awaitTrialProcessOutput({
				exited: proc.exited,
				stdout: readPipeText(proc.stdout as ReadableStream<Uint8Array>),
				stderr: readPipeText(proc.stderr as ReadableStream<Uint8Array>),
				timeoutMs: OBSERVATION_MS * 4,
				terminate: async () => {
					proc.kill("SIGKILL");
				},
			}),
			sleepFor(OBSERVATION_MS).then(() => null),
		]);

		expect(wait?.kind).toBe("exited");
		expect(wait?.exitCode).toBe(4);
		expect(wait?.stdout).toHaveLength(200_000);
		expect(wait?.stderr).toBe("boom");
	});
});
