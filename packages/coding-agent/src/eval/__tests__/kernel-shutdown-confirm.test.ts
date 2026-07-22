import { describe, expect, it } from "bun:test";
import type { Subprocess } from "bun";
import { BaseKernel, type BaseKernelOptions } from "../kernel-base";

// WHY THIS SUITE EXISTS (BACKLOG KERNEL-EXIT-CONFIRM)
// --------------------------------------------------
// `BaseKernel.shutdown` decides whether the runner exited by awaiting an internal
// wait helper. That helper used to return `number | null` — the exit code, or
// `null` on timeout. Two collisions made it lie:
//   1. A CLEAN exit reports code `0`, which is FALSY, so the `if (!result)` guard
//      read a graceful exit as "still running" and escalated to SIGTERM/SIGKILL on
//      EVERY shutdown, needlessly hard-killing a process that had already left.
//   2. A SIGNAL-terminated process reports a `null` code, indistinguishable from
//      the timeout sentinel, so even a real exit was reported `confirmed: false`.
// The fix makes the wait return an OBJECT on exit (truthy for code 0 and null) and
// `null` ONLY on timeout. These tests lock all three real paths with a fake
// subprocess: a clean exit-0 confirms WITHOUT escalation, a signal exit confirms,
// and a genuinely hung kernel still escalates through SIGTERM then SIGKILL and
// confirms once the kill lands. They run without a real interpreter, so they guard
// the shared logic (python + ruby + julia) in ordinary CI.

class TestKernel extends BaseKernel {}

function testOptions(shutdownGraceMs: number): BaseKernelOptions {
	return {
		languageName: "test",
		traceIpc: false,
		exitPayload: JSON.stringify({ type: "exit" }),
		interruptEscalationMs: 50,
		shutdownGraceMs,
		buildPayload: (code, msgId) => JSON.stringify({ type: "exec", id: msgId, code }),
	};
}

interface FakeProc {
	proc: Subprocess<"pipe", "pipe", "pipe">;
	killSignals: string[];
}

/**
 * A fake subprocess whose exit is driven by `exited`. `stdin` swallows writes,
 * `stdout`/`stderr` close immediately so the kernel's readers finish cleanly, and
 * `kill` records the signals it receives (optionally resolving the exit).
 */
function makeFakeProc(exited: Promise<number | null>, onKill?: (signal: string) => void): FakeProc {
	const killSignals: string[] = [];
	const closedStream = () => new ReadableStream<Uint8Array>({ start: controller => controller.close() });
	const proc = {
		stdin: { write: () => 0, flush: () => {}, end: () => {} },
		stdout: closedStream(),
		stderr: closedStream(),
		exited,
		kill: (signal?: string | number) => {
			const name = typeof signal === "string" ? signal : String(signal ?? "SIGTERM");
			killSignals.push(name);
			onKill?.(name);
		},
	} as unknown as Subprocess<"pipe", "pipe", "pipe">;
	return { proc, killSignals };
}

describe("BaseKernel.shutdown exit confirmation", () => {
	it("confirms a clean exit (code 0) WITHOUT escalating to a kill signal", async () => {
		const kernel = new TestKernel("k-clean", testOptions(200));
		const { proc, killSignals } = makeFakeProc(Promise.resolve(0));
		kernel.setProcess(proc);

		const result = await kernel.shutdown();

		expect(result.confirmed).toBe(true);
		// The regression: exit code 0 must NOT be misread as "still running".
		expect(killSignals).toEqual([]);
	});

	it("confirms a signal-terminated exit (null code) without treating it as a timeout", async () => {
		const kernel = new TestKernel("k-signal", testOptions(200));
		// A process killed by a signal resolves `exited` with a null code.
		const { proc, killSignals } = makeFakeProc(Promise.resolve(null));
		kernel.setProcess(proc);

		const result = await kernel.shutdown();

		expect(result.confirmed).toBe(true);
		expect(killSignals).toEqual([]);
	});

	it("escalates a hung kernel through SIGTERM then SIGKILL and confirms once the kill lands", async () => {
		const kernel = new TestKernel("k-hung", testOptions(40));
		// Never exits on the graceful path; resolves only after SIGKILL is sent.
		let resolveExit: (code: number | null) => void = () => {};
		const exited = new Promise<number | null>(resolve => {
			resolveExit = resolve;
		});
		const { proc, killSignals } = makeFakeProc(exited, signal => {
			if (signal === "SIGKILL") resolveExit(null);
		});
		kernel.setProcess(proc);

		const result = await kernel.shutdown();

		expect(result.confirmed).toBe(true);
		expect(killSignals).toEqual(["SIGTERM", "SIGKILL"]);
	});

	it("leaves confirmed false only when the process never exits even after SIGKILL", async () => {
		const kernel = new TestKernel("k-zombie", testOptions(30));
		// Exit never resolves: models a truly unreapable pid. Every wait times out.
		const { proc, killSignals } = makeFakeProc(new Promise<number | null>(() => {}));
		kernel.setProcess(proc);

		const result = await kernel.shutdown();

		expect(result.confirmed).toBe(false);
		expect(killSignals).toEqual(["SIGTERM", "SIGKILL"]);
	});
});
