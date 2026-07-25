/**
 * Kernel LIFECYCLE for `executePython`: when a kernel is started, reused, torn down,
 * restarted, and when a queued cell is cancelled before it ever reaches one.
 *
 * Why this suite exists as one file: the same contract used to be covered twice, by
 * `python-executor-lifecycle.test.ts` and `python-executor.lifecycle.test.ts` — two files
 * in one directory differing only by a separator, each with its own fake kernel, and four
 * of the five tests in the second were the same behaviours as the first with weaker
 * assertions. Two suites for one contract means a change lands in one of them and the
 * other keeps passing against the old belief, and nobody can tell which file to add to.
 * This is the single home; the assertions kept are the strongest of each pair (executed
 * CODE rather than call counts wherever both existed).
 *
 * Nothing here sets `VEYYON_PYTHON_SKIP_CHECK` or stubs `checkPythonKernelAvailability`:
 * that function already returns ok without probing an interpreter under `bun test`, which
 * `core/python-availability-preflight-skip.test.ts` pins. Stubbing it again would be a
 * second place claiming the same thing.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import type { SessionKernel } from "@veyyon/coding-agent/eval/kernel-base";
import { disposeAllKernelSessions, executePython } from "@veyyon/coding-agent/eval/py/executor";
import {
	type KernelExecuteOptions,
	type KernelExecuteResult,
	type KernelShutdownResult,
	PythonKernel,
} from "@veyyon/coding-agent/eval/py/kernel";
import { getProjectDir } from "@veyyon/utils";
import { useIsolatedAgentDir } from "../helpers/isolated-agent-dir";

// The code under test opens `AgentStorage`, which resolves `agent.db` under the ACTIVE
// PROFILE's agent dir, so without this the suite writes into the developer's real
// `~/.veyyon/profiles/<profile>/agent` and the real-data tripwire fails every test.
useIsolatedAgentDir();

const OK_RESULT: KernelExecuteResult = {
	status: "ok",
	cancelled: false,
	timedOut: false,
	stdinRequested: false,
};

interface FakeKernelOptions {
	/** Whether the kernel reports itself alive before its first execute. */
	alive?: boolean;
	/** Observe (or drive) the options each execute was called with. */
	onExecute?: (options?: KernelExecuteOptions) => void;
	/** Reply to the FIRST shutdown without confirmation, as a wedged process would. */
	firstShutdownUnconfirmed?: boolean;
}

/**
 * The one fake kernel for this suite. It records the CODE of every execute rather than
 * just a count, because "the second cell ran on the replacement kernel" is the actual
 * contract in most tests here and a call count cannot express it.
 */
class FakeKernel implements SessionKernel {
	readonly executeCalls: string[] = [];
	shutdownCalls = 0;

	#result: KernelExecuteResult;
	#onExecute?: (options?: KernelExecuteOptions) => void;
	#alive: boolean;
	#firstShutdownUnconfirmed: boolean;

	constructor(result: KernelExecuteResult, options: FakeKernelOptions = {}) {
		this.#result = result;
		this.#onExecute = options.onExecute;
		this.#alive = options.alive ?? true;
		this.#firstShutdownUnconfirmed = options.firstShutdownUnconfirmed ?? false;
	}

	isAlive(): boolean {
		return this.#alive;
	}

	/** Simulate the process dying without a shutdown, e.g. a crash mid-cell. */
	kill(): void {
		this.#alive = false;
	}

	async execute(code: string, options?: KernelExecuteOptions): Promise<KernelExecuteResult> {
		this.executeCalls.push(code);
		this.#onExecute?.(options);
		return this.#result;
	}

	async shutdown(): Promise<KernelShutdownResult> {
		this.shutdownCalls += 1;
		this.#alive = false;
		return { confirmed: !(this.#firstShutdownUnconfirmed && this.shutdownCalls === 1) };
	}
}

/** Hand out the given kernels in order, and report how many starts were asked for. */
function startsWith(...kernels: FakeKernel[]): { starts: () => number } {
	const queue = [...kernels];
	let starts = 0;
	vi.spyOn(PythonKernel, "start").mockImplementation(async () => {
		starts += 1;
		const next = queue.shift();
		if (!next) throw new Error(`kernel start #${starts} was not expected by this test`);
		return next as unknown as PythonKernel;
	});
	return { starts: () => starts };
}

const CWD = getProjectDir();

afterEach(async () => {
	vi.restoreAllMocks();
	await disposeAllKernelSessions();
});

describe("executePython per-call kernels", () => {
	/** The whole per-call contract for one cell: start, run, tear down. A kernel left
	 *  running after a per-call cell is a leaked subprocess per eval. */
	it("starts and shuts down a kernel for a single cell", async () => {
		const kernel = new FakeKernel(OK_RESULT);
		const { starts } = startsWith(kernel);

		await executePython("print('hi')", { kernelMode: "per-call", cwd: CWD });

		expect(starts()).toBe(1);
		expect(kernel.executeCalls).toEqual(["print('hi')"]);
		expect(kernel.shutdownCalls).toBe(1);
	});

	/** Per-call means per CALL: the second cell must get its own kernel, not the first one
	 *  back. Reuse here would silently give per-call mode session semantics, so state from
	 *  one cell would bleed into the next. */
	it("never reuses a per-call kernel between cells", async () => {
		const first = new FakeKernel(OK_RESULT);
		const second = new FakeKernel(OK_RESULT);
		const { starts } = startsWith(first, second);

		await executePython("print('one')", { kernelMode: "per-call", cwd: CWD });
		await executePython("print('two')", { kernelMode: "per-call", cwd: CWD });

		expect(starts()).toBe(2);
		expect(first.executeCalls).toEqual(["print('one')"]);
		expect(second.executeCalls).toEqual(["print('two')"]);
		expect(first.shutdownCalls).toBe(1);
		expect(second.shutdownCalls).toBe(1);
	});
});

describe("executePython session kernels", () => {
	/** The point of session mode: one interpreter for the whole session, so names defined
	 *  in one cell exist in the next. Both cells must land on the SAME kernel. */
	it("reuses one kernel across cells in the same session", async () => {
		const kernel = new FakeKernel(OK_RESULT, { onExecute: options => options?.onChunk?.("ok\n") });
		const { starts } = startsWith(kernel);

		await executePython("print('one')", { sessionId: "session-1", cwd: CWD });
		await executePython("print('two')", { sessionId: "session-1", cwd: CWD });

		expect(starts()).toBe(1);
		expect(kernel.executeCalls).toEqual(["print('one')", "print('two')"]);
	});

	/** `reset: true` is the user asking for a clean interpreter. The old one is shut down
	 *  and the requesting cell runs on the NEW kernel — not on the one being discarded. */
	it("replaces the kernel when a cell asks for a reset", async () => {
		const first = new FakeKernel(OK_RESULT);
		const second = new FakeKernel(OK_RESULT);
		const { starts } = startsWith(first, second);

		await executePython("print('one')", { sessionId: "session-reset", cwd: CWD });
		await executePython("print('two')", { sessionId: "session-reset", reset: true, cwd: CWD });

		expect(starts()).toBe(2);
		expect(first.shutdownCalls).toBe(1);
		expect(first.executeCalls).toEqual(["print('one')"]);
		expect(second.executeCalls).toEqual(["print('two')"]);
	});

	/**
	 * A retained session whose process died must be replaced before the cell runs, and the
	 * cell must NOT be handed to the dead kernel first. The user-visible failure of getting
	 * this wrong is an eval that returns a status line and no output.
	 */
	it("restarts a session kernel that is no longer alive", async () => {
		const dead = new FakeKernel(OK_RESULT, { alive: false });
		const live = new FakeKernel(OK_RESULT, { onExecute: options => options?.onChunk?.("live\n") });
		const { starts } = startsWith(dead, live);

		await executePython("print('restart')", { sessionId: "session-restart", cwd: CWD });

		expect(starts()).toBe(2);
		expect(dead.shutdownCalls).toBe(1);
		expect(dead.executeCalls).toEqual([]);
		expect(live.executeCalls).toEqual(["print('restart')"]);
	});

	/** A kernel that dies DURING a cell (a crash, not a clean exit) is replaced and the
	 *  cell is retried, so one crash costs the user a cell rather than the session. */
	it("restarts after a cell crashes the kernel", async () => {
		const crashing = new FakeKernel(OK_RESULT);
		const replacement = new FakeKernel(OK_RESULT);
		crashing.execute = async code => {
			crashing.executeCalls.push(code);
			crashing.kill();
			throw new Error("kernel crashed");
		};
		const { starts } = startsWith(crashing, replacement);

		await executePython("1 + 1", { sessionId: "crash-session", cwd: CWD });

		expect(starts()).toBe(2);
		expect(crashing.executeCalls).toEqual(["1 + 1"]);
		expect(replacement.executeCalls).toEqual(["1 + 1"]);
	});

	/**
	 * The restart cannot be conditional on the dead kernel ACKNOWLEDGING its shutdown. A
	 * wedged process never confirms, and an executor that waits for confirmation before
	 * replacing it strands the session on a kernel that will never run anything again.
	 */
	it("restarts a dead session even when the shutdown is never confirmed", async () => {
		const dead = new FakeKernel(OK_RESULT, { alive: false, firstShutdownUnconfirmed: true });
		const live = new FakeKernel(OK_RESULT);
		const { starts } = startsWith(dead, live);

		await executePython("1 + 1", { sessionId: "retry-dead-session", cwd: CWD });
		await executePython("2 + 2", { sessionId: "retry-dead-session", cwd: CWD });

		expect(starts()).toBe(2);
		expect(dead.shutdownCalls).toBe(1);
		expect(dead.executeCalls).toEqual([]);
		expect(live.executeCalls).toEqual(["1 + 1", "2 + 2"]);
	});

	/**
	 * Two cells from one session asking for a reset at the same time used to crash the
	 * second with "Python kernel reset already in progress", which the user reported as
	 * eval returning only a status line and no executed output. The second reset now waits
	 * for the in-flight one and then proceeds, so both cells succeed.
	 */
	it("coalesces concurrent reset requests instead of failing the second cell", async () => {
		const seeded = new FakeKernel(OK_RESULT);
		const replacement = new FakeKernel(OK_RESULT);
		startsWith(seeded, replacement);

		await executePython("1 + 1", { sessionId: "coalesce", cwd: CWD });
		const [first, second] = await Promise.all([
			executePython("2 + 2", { sessionId: "coalesce", reset: true, cwd: CWD }),
			executePython("3 + 3", { sessionId: "coalesce", reset: true, cwd: CWD }),
		]);

		expect(first.exitCode).toBe(0);
		expect(second.exitCode).toBe(0);
	});

	/**
	 * A session runs one cell at a time, so a second cell WAITS. Cancelling while it waits
	 * must cancel the wait — the cell must never reach the kernel afterwards, and the cell
	 * already running must finish untouched. Sending a cancelled cell to the kernel anyway
	 * would execute code the user aborted.
	 */
	it("cancels a queued cell before it reaches the kernel, leaving the running cell alone", async () => {
		const firstStarted = Promise.withResolvers<void>();
		const releaseFirst = Promise.withResolvers<void>();
		const kernel = new FakeKernel(OK_RESULT);
		kernel.execute = async (code, options) => {
			kernel.executeCalls.push(code);
			if (kernel.executeCalls.length === 1) {
				options?.onChunk?.("first\n");
				firstStarted.resolve();
				await releaseFirst.promise;
			}
			return OK_RESULT;
		};
		const { starts } = startsWith(kernel);

		const firstPromise = executePython("print('one')", { sessionId: "session-queue", cwd: CWD });
		await firstStarted.promise;

		const abortController = new AbortController();
		const secondPromise = executePython("print('two')", {
			sessionId: "session-queue",
			signal: abortController.signal,
			cwd: CWD,
		});
		abortController.abort(Object.assign(new Error("queue wait cancelled"), { name: "AbortError" }));

		const second = await secondPromise;
		expect(second.cancelled).toBe(true);
		expect(second.exitCode).toBeUndefined();
		expect(second.output).toBe("");
		expect(kernel.executeCalls).toEqual(["print('one')"]);

		releaseFirst.resolve();
		const first = await firstPromise;

		expect(first.cancelled).toBe(false);
		expect(first.output).toContain("first");
		expect(starts()).toBe(1);
		// Asserted again AFTER the first cell settled: a cancelled cell that reached the
		// kernel late would show up here and nowhere else.
		expect(kernel.executeCalls).toEqual(["print('one')"]);
	});
});
