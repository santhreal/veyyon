/**
 * A stderr capture that stops early says so inside the tail, rather than looking complete.
 *
 * WHY THIS SUITE EXISTS. `ChildProcess` eagerly drains a child's stderr into `#stderrTail`, and that
 * tail is not a debug convenience: it is the entire diagnostic. `NonZeroExitError`'s message is
 * `Process exited with code N:\n<tail>`, `peekStderr()` returns it, and `exec` hands it back as
 * `result.stderr`. When a subprocess fails, that string is what a person reads to find out why.
 *
 * The drain loop was wrapped in `catch {}`. If the stream errored partway — a broken pipe, a killed
 * child mid-write, a tee'd branch cancelled by the other consumer — the loop stopped, the partial tail
 * was kept, and it was indistinguishable from a child that had finished writing. So the reader saw a
 * trace that ended mid-sentence and concluded the child said nothing more, which is the most expensive
 * possible way to be wrong about a failing subprocess (Law 10).
 *
 * Dropping the capture is still the right behaviour: a stderr read failure must not turn into a thrown
 * error that replaces the child's own exit reason. The contract is that the tail carries a marker, and
 * the marker is placed in the tail rather than a log because the tail is the surface the reader is
 * already looking at.
 *
 * These tests construct `ChildProcess` over a hand-built subprocess rather than spawning a real
 * command, which the rest of `ptree.test.ts` deliberately avoids. That is on purpose and it is the only
 * way: a real child cannot be made to fail its parent's stderr READ at a chosen point, since the pipe
 * is owned by the runtime. The healthy cases stay covered by the real-subprocess suite next door.
 */

import { describe, expect, it } from "bun:test";
import { ChildProcess } from "../src/ptree";

const CAPTURE_STOPPED = "[stderr capture stopped early:";

/** A stream that yields the given chunks and then fails, the way a broken pipe reads. */
function failingAfter(chunks: string[], reason: Error): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	let index = 0;
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			if (index < chunks.length) {
				controller.enqueue(encoder.encode(chunks[index]));
				index += 1;
				return;
			}
			controller.error(reason);
		},
	});
}

/** A stream that yields the given chunks and closes cleanly. */
function completing(chunks: string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	let index = 0;
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			if (index < chunks.length) {
				controller.enqueue(encoder.encode(chunks[index]));
				index += 1;
				return;
			}
			controller.close();
		},
	});
}

/**
 * The parts of a piped Bun subprocess `ChildProcess` reads in its constructor.
 *
 * Only `stderr` and `exited` participate in the tail behaviour under test; the rest exist so the
 * shape type-checks and so `exited` can settle without the exit path touching anything absent.
 */
function fakeProc(stderr: ReadableStream<Uint8Array>, exitCode: number) {
	return {
		stderr,
		stdout: completing([]),
		stdin: null,
		exited: Promise.resolve(exitCode),
		exitCode,
		killed: false,
		pid: 0,
		kill() {},
		unref() {},
		ref() {},
		// `any` rather than the real `PipedSubprocess`: that type is not exported, and a partial
		// stand-in is the whole point of this helper (see the header for why a real child cannot
		// be used here).
	} as any;
}

describe("ChildProcess stderr tail", () => {
	it("marks the tail when the stderr stream fails partway, keeping what it did read", async () => {
		// The regression. Both halves matter: the bytes already captured are still the best
		// evidence available, and the marker is what stops them from being read as the whole story.
		const child = new ChildProcess(
			fakeProc(failingAfter(["first line\n"], new Error("EPIPE: broken pipe")), 1),
			false,
		);
		await child.exited.catch(() => null);

		const tail = child.peekStderr();
		expect(tail).toContain("first line\n");
		expect(tail).toContain(CAPTURE_STOPPED);
		// The cause is named, because "capture stopped" without a reason sends the reader
		// looking at the child when the problem was on this side of the pipe.
		expect(tail).toContain("EPIPE: broken pipe");
	});

	it("puts the marker at the end, so it reads as a note about the trace above it", async () => {
		const child = new ChildProcess(
			fakeProc(failingAfter(["stack frame one\n"], new Error("stream cancelled")), 1),
			false,
		);
		await child.exited.catch(() => null);

		const tail = child.peekStderr();
		expect(tail.indexOf(CAPTURE_STOPPED)).toBeGreaterThan(tail.indexOf("stack frame one"));
		expect(tail.endsWith("]")).toBe(true);
	});

	it("carries the marker into the NonZeroExitError message the caller actually sees", async () => {
		// The point of the whole change: the marker has to travel with the exit error, not sit in
		// a field nobody reads. This is the string that reaches a log or a user-facing message.
		const child = new ChildProcess(
			fakeProc(failingAfter(["fatal: bad object\n"], new Error("read failed")), 7),
			false,
		);
		await child.exited.catch(() => null);

		const reason = child.exitReason;
		expect(reason).toBeDefined();
		expect(reason?.exitCode).toBe(7);
		expect(reason?.message).toContain("Process exited with code 7:");
		expect(reason?.message).toContain("fatal: bad object");
		expect(reason?.message).toContain(CAPTURE_STOPPED);
		expect(reason?.stderr).toContain(CAPTURE_STOPPED);
	});

	it("adds nothing when the stream ends cleanly, which is every ordinary run", async () => {
		// The load-bearing silence. A marker on every capture would make it noise, and the tail
		// is compared byte-for-byte by other suites and by users reading a trace.
		const child = new ChildProcess(fakeProc(completing(["warning: deprecated\n", "done\n"]), 1), false);
		await child.exited.catch(() => null);

		expect(child.peekStderr()).toBe("warning: deprecated\ndone\n");
	});

	it("adds nothing when the child wrote no stderr at all", async () => {
		const child = new ChildProcess(fakeProc(completing([]), 0), false);
		await child.exited;

		expect(child.peekStderr()).toBe("");
	});

	it("marks a failure that happens before any output, so an empty tail is not read as silence", async () => {
		// The worst-looking case for the old behaviour: the tail was empty, which says "the child
		// exited without explaining itself" when in fact nothing was ever read.
		const child = new ChildProcess(fakeProc(failingAfter([], new Error("stderr unavailable")), 1), false);
		await child.exited.catch(() => null);

		const tail = child.peekStderr();
		expect(tail).toContain(CAPTURE_STOPPED);
		expect(tail).toContain("stderr unavailable");
	});
});
