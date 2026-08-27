/**
 * WHY: a cancelled trial could hold its worker until its own timeout.
 *
 * The harbor and pier backends raced `Promise.all([exited, stdout, stderr])` against a timer, and a
 * separate abort listener killed the process tree without settling that race. When the kill
 * abandoned a descendant holding a pipe, nothing resolved: the trial had been cancelled, its tree
 * was gone or unkillable, and the worker still waited for EOF — up to 1800s for a deep-swe cell and
 * up to five hours for a terminal-bench one. Cancelling a run appeared to do nothing.
 *
 * THE CLASS THIS CLOSES: a wait that ends for one interruption and not the other.
 * `awaitTrialProcessOutput` in `src/core/process-tree.ts` is the single wait both backends use, and
 * both interruptions take the same path: terminate the tree, drain what the pipes produced under a
 * bound, report which interruption it was. Every interruption is driven here — a clean exit, a
 * deadline, a cancel mid-trial, a signal already aborted before the wait began — against pipes that
 * never reach EOF, so a wait that depends on EOF cannot pass. The listener is asserted to be
 * removed, because a run cancels once but executes thousands of trials against that one signal.
 *
 * WHAT IT DOES NOT CATCH: whether the two backends map the result to the right error text and the
 * right recorded row. `test/backends` owns that. It also does not prove `terminate` kills anything —
 * `one-terminator-ends-a-trial-process-tree-and-says-whether-it-died.test.ts` owns termination.
 */

import { describe, expect, it } from "bun:test";
import { awaitTrialProcessOutput, OUTPUT_DRAIN_GRACE_MS } from "../../src/core";

/** Short enough to keep the suite fast; that the wait ends at all is what is asserted. */
const DRAIN_MS = 20;
/** Long enough that a case reaching it would be a wait that never ended. */
const NEVER_MS = 60_000;

interface HeldPipes {
	readonly stdout: Promise<string>;
	readonly stderr: Promise<string>;
	release(): void;
}

/** Pipes a surviving descendant holds open: only the drain bound can end a wait on these. */
function pipesNobodyCloses(): HeldPipes {
	const out = Promise.withResolvers<string>();
	const err = Promise.withResolvers<string>();
	return {
		stdout: out.promise,
		stderr: err.promise,
		release: () => {
			out.resolve("");
			err.resolve("");
		},
	};
}

describe("waiting for a trial's process and output", () => {
	it("returns the exit code and both pipes when the trial finishes on its own", async () => {
		const terminated: string[] = [];

		const wait = await awaitTrialProcessOutput({
			exited: Promise.resolve(0),
			stdout: Promise.resolve("agent output"),
			stderr: Promise.resolve("agent warnings"),
			timeoutMs: NEVER_MS,
			terminate: async () => {
				terminated.push("terminate");
			},
		});

		expect(wait).toEqual({
			kind: "exited",
			exitCode: 0,
			stdout: "agent output",
			stderr: "agent warnings",
			outputComplete: true,
		});
		expect(terminated).toEqual([]);
	});

	it("ends the wait on a cancel, even when the tree left a pipe open", async () => {
		const pipes = pipesNobodyCloses();
		const exited = Promise.withResolvers<number>();
		const controller = new AbortController();
		const terminated: string[] = [];

		const waiting = awaitTrialProcessOutput({
			exited: exited.promise,
			stdout: pipes.stdout,
			stderr: pipes.stderr,
			timeoutMs: NEVER_MS,
			signal: controller.signal,
			terminate: async () => {
				terminated.push("terminate");
			},
			drainGraceMs: DRAIN_MS,
		});
		controller.abort();
		const wait = await waiting;

		expect(wait.kind).toBe("aborted");
		expect(wait.exitCode).toBe(-1);
		expect(wait.outputComplete).toBe(false);
		expect(terminated).toEqual(["terminate"]);
		pipes.release();
		exited.resolve(-1);
	});

	it("keeps the output a cancelled trial had already produced", async () => {
		const held = Promise.withResolvers<string>();
		const controller = new AbortController();

		const waiting = awaitTrialProcessOutput({
			exited: Promise.withResolvers<number>().promise,
			stdout: Promise.resolve("the last thing the agent printed"),
			stderr: held.promise,
			timeoutMs: NEVER_MS,
			signal: controller.signal,
			terminate: async () => {},
			drainGraceMs: DRAIN_MS,
		});
		controller.abort();
		const wait = await waiting;

		expect(wait.stdout).toBe("the last thing the agent printed");
		expect(wait.stderr).toBe("");
		expect(wait.outputComplete).toBe(false);
		held.resolve("");
	});

	it("ends the wait on a signal that was already aborted before it began", async () => {
		const pipes = pipesNobodyCloses();
		const controller = new AbortController();
		controller.abort();
		const terminated: string[] = [];

		const wait = await awaitTrialProcessOutput({
			exited: Promise.withResolvers<number>().promise,
			stdout: pipes.stdout,
			stderr: pipes.stderr,
			timeoutMs: NEVER_MS,
			signal: controller.signal,
			terminate: async () => {
				terminated.push("terminate");
			},
			drainGraceMs: DRAIN_MS,
		});

		expect(wait.kind).toBe("aborted");
		expect(terminated).toEqual(["terminate"]);
		pipes.release();
	});

	it("ends the wait on the trial's deadline, and says it was the deadline", async () => {
		const pipes = pipesNobodyCloses();
		const terminated: string[] = [];

		// A deadline that has effectively already passed: the interruption, not its duration, is the
		// behaviour under test.
		const wait = await awaitTrialProcessOutput({
			exited: Promise.withResolvers<number>().promise,
			stdout: pipes.stdout,
			stderr: pipes.stderr,
			timeoutMs: 10,
			terminate: async () => {
				terminated.push("terminate");
			},
			drainGraceMs: DRAIN_MS,
		});

		expect(wait.kind).toBe("timed_out");
		expect(wait.exitCode).toBe(-1);
		expect(terminated).toEqual(["terminate"]);
		pipes.release();
	});

	it("terminates the tree once, whichever interruption arrives", async () => {
		const pipes = pipesNobodyCloses();
		const controller = new AbortController();
		const terminated: string[] = [];

		const waiting = awaitTrialProcessOutput({
			exited: Promise.withResolvers<number>().promise,
			stdout: pipes.stdout,
			stderr: pipes.stderr,
			timeoutMs: 10,
			signal: controller.signal,
			terminate: async () => {
				terminated.push("terminate");
			},
			drainGraceMs: DRAIN_MS,
		});
		controller.abort();
		controller.abort();
		await waiting;

		expect(terminated).toEqual(["terminate"]);
		pipes.release();
	});

	it("leaves no listener on the run's signal once a trial is done with it", async () => {
		const controller = new AbortController();
		const listeners: string[] = [];
		const signal = controller.signal;
		const add = signal.addEventListener.bind(signal);
		const remove = signal.removeEventListener.bind(signal);
		// A recorder rather than a spy: the assertion is the pairing, not that a method was called.
		Object.assign(signal, {
			addEventListener: (type: string, listener: EventListener, opts?: AddEventListenerOptions) => {
				listeners.push(`add:${type}`);
				add(type, listener, opts);
			},
			removeEventListener: (type: string, listener: EventListener) => {
				listeners.push(`remove:${type}`);
				remove(type, listener);
			},
		});

		await awaitTrialProcessOutput({
			exited: Promise.resolve(0),
			stdout: Promise.resolve(""),
			stderr: Promise.resolve(""),
			timeoutMs: NEVER_MS,
			signal,
			terminate: async () => {},
		});

		expect(listeners).toEqual(["add:abort", "remove:abort"]);
	});

	it("drains a cancelled trial's pipes under the same bound a timeout uses", () => {
		// Pinned as a literal: every case above passes its own grace, so a default that drifted would
		// leave this file green while a cancel cost that long per in-flight trial.
		expect(OUTPUT_DRAIN_GRACE_MS).toBe(2000);
	});
});
