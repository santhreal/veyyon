/**
 * WHY: dispose waits up to three seconds for the eval runs still in flight, racing them against a
 * timer. The timer was never cancelled, so a run that finished in 20 ms still left a three-second
 * timer holding the event loop: a host that disposed a session and let the process end on its own
 * exited three seconds late.
 *
 * Each case runs the wait in its own process and measures when that process exits, which is the only
 * observation that sees a leftover timer; an in-process test returns as soon as the race resolves.
 *
 * Not caught: a leftover timer shorter than the margin below, and a wait on a run that never settles
 * (that path takes the full four seconds by design and is bounded by the constants, not by this test).
 */
import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";

const MODULE = new URL("../../src/session/runtime/user-executions.ts", import.meta.url).pathname;

/** Well under the three-second settle window, well over a cold process start. */
const EXIT_MARGIN_MS = 2_500;

function exitTime(runs: string): { stdout: string; elapsedMs: number } {
	const script = [
		`import { UserExecutions } from ${JSON.stringify(MODULE)};`,
		"const executions = new UserExecutions({ isStreaming: () => false, append() {} });",
		`for (const run of [${runs}]) executions.trackEval(run, new AbortController());`,
		"console.log(await executions.settleEvalForDispose());",
	].join("\n");
	const start = performance.now();
	const child = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 10_000 });
	const elapsedMs = performance.now() - start;
	if (child.status !== 0) throw new Error(`wait script failed: ${child.stderr}`);
	return { stdout: child.stdout.trim(), elapsedMs };
}

describe("the dispose wait on eval runs", () => {
	it("lets the process exit once the runs it waited on finished", () => {
		const { stdout, elapsedMs } = exitTime("new Promise(resolve => setTimeout(resolve, 20))");
		expect(stdout).toBe("true");
		expect(elapsedMs).toBeLessThan(EXIT_MARGIN_MS);
	});

	it("lets the process exit once the slowest of several runs finished", () => {
		const { stdout, elapsedMs } = exitTime(
			"new Promise(resolve => setTimeout(resolve, 20)), new Promise(resolve => setTimeout(resolve, 200))",
		);
		expect(stdout).toBe("true");
		expect(elapsedMs).toBeLessThan(EXIT_MARGIN_MS);
	});
});
