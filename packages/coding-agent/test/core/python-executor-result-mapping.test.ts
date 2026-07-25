/**
 * How a raw kernel result becomes the tool result the model sees: exit codes, the
 * timeout annotation, output truncation, and terminal-control sanitizing.
 *
 * Why this suite exists as one file: this contract used to be spread over four —
 * `python-executor-mapping`, `python-executor.result`, `python-executor-timeout` and
 * `python-executor-streaming` — and the timeout annotation was asserted in ALL FOUR with
 * the same three lines (three of them with the same 5000ms budget), while
 * error-status-to-exit-code was asserted twice. Four copies of one assertion is not four
 * times the coverage: it is four places to update and three that keep passing against the
 * old belief when someone changes the message. What the copies actually disagreed about —
 * the budget in the annotation — is now a table, so the formatting rule is covered rather
 * than restated.
 */
import { describe, expect, it } from "bun:test";
import { executePythonWithKernel } from "@veyyon/coding-agent/eval/py/executor";
import { DEFAULT_MAX_BYTES } from "@veyyon/coding-agent/session/streaming-output";
// The code under test opens `AgentStorage`, which resolves `agent.db` under the ACTIVE
// PROFILE's agent dir, so without this the suite writes into the developer's real
// `~/.veyyon/profiles/<profile>/agent` and the real-data tripwire fails every test.
import { useIsolatedAgentDir } from "../helpers/isolated-agent-dir";
import { FakeKernel } from "./helpers";

useIsolatedAgentDir();

const OK = { status: "ok", cancelled: false, timedOut: false, stdinRequested: false } as const;
const TIMED_OUT = { status: "ok", cancelled: true, timedOut: true, stdinRequested: false } as const;
const ERRORED = { status: "error", cancelled: false, timedOut: false, stdinRequested: false } as const;

describe("executePythonWithKernel exit codes", () => {
	/**
	 * A cell that raised must be a FAILURE the model can see, and the traceback the kernel
	 * streamed has to survive into the output. Reporting a raising cell as success is how a
	 * model ends up building on a result that never existed.
	 */
	it("maps kernel error status to exit code 1 and keeps the traceback", async () => {
		const kernel = new FakeKernel(ERRORED, options => {
			options?.onChunk?.("Traceback (most recent call last):\nValueError: boom\n");
		});

		const result = await executePythonWithKernel(kernel, "raise ValueError('boom')");

		expect(result.exitCode).toBe(1);
		expect(result.output).toContain("Traceback (most recent call last):");
		expect(result.output).toContain("ValueError: boom");
		// Not a stdin request: an errored cell must not be reported as one waiting for
		// input, or the caller would sit waiting to answer a prompt that never came.
		expect(result.stdinRequested).toBe(false);
	});

	/** The success path, as the counterweight: a clean cell is exit code 0 and not
	 *  cancelled, so the two error assertions above cannot pass by accident. */
	it("maps a clean run to exit code 0", async () => {
		const kernel = new FakeKernel(OK, options => options?.onChunk?.("42\n"));

		const result = await executePythonWithKernel(kernel, "print(42)");

		expect(result.exitCode).toBe(0);
		expect(result.cancelled).toBe(false);
		expect(result.output).toBe("42\n");
	});

	/**
	 * A timed-out cell has NO exit code. It is cancelled, not failed: the kernel was
	 * interrupted mid-cell, so there is no status to report, and inventing a `1` would be
	 * indistinguishable from a real exception.
	 */
	it("reports a timed-out cell as cancelled with no exit code", async () => {
		const kernel = new FakeKernel(TIMED_OUT, options => options?.onChunk?.("tick\n"));

		const result = await executePythonWithKernel(kernel, "sleep(10)", { timeoutMs: 5_000 });

		expect(result.cancelled).toBe(true);
		expect(result.exitCode).toBeUndefined();
	});
});

describe("executePythonWithKernel timeout annotation", () => {
	/**
	 * The annotation names the budget that actually expired, so the operator can tell a
	 * 2-second limit from a 30-minute one. Four suites used to assert this sentence and
	 * three of them used the same budget, which is why the rule itself was never covered:
	 * `timeoutSeconds` ROUNDS to whole seconds and CLAMPS at 1, so a sub-second budget
	 * still reads as `1s` rather than `0s`.
	 */
	const budgets: ReadonlyArray<{ timeoutMs: number; reads: string }> = [
		{ timeoutMs: 2_000, reads: "2s" },
		{ timeoutMs: 5_000, reads: "5s" },
		{ timeoutMs: 1_500, reads: "2s" },
		{ timeoutMs: 400, reads: "1s" },
		{ timeoutMs: 1_800_000, reads: "1800s" },
	];

	for (const { timeoutMs, reads } of budgets) {
		it(`names a ${timeoutMs}ms budget as ${reads}`, async () => {
			const kernel = new FakeKernel(TIMED_OUT);

			const result = await executePythonWithKernel(kernel, "sleep(10)", { timeoutMs });

			expect(result.output).toContain(`eval cell timed out after ${reads}`);
		});
	}

	/** With no budget configured the annotation still has to be a sentence, not a hole
	 *  where a number should be: `undefined` seconds would read as "timed out after
	 *  undefineds". */
	it("says the configured timeout when no budget was given", async () => {
		const kernel = new FakeKernel(TIMED_OUT);

		const result = await executePythonWithKernel(kernel, "sleep(10)");

		expect(result.output).toContain("eval cell timed out after the configured timeout");
	});

	/** The annotation tells the operator the kernel SURVIVED and how to get a clean one.
	 *  Without that, a timeout looks like a lost session and the state is abandoned. */
	it("says the kernel is still running and how to reset it", async () => {
		const kernel = new FakeKernel(TIMED_OUT);

		const result = await executePythonWithKernel(kernel, "sleep(10)", { timeoutMs: 5_000 });

		expect(result.output).toContain("kernel interrupted but remains running");
		expect(result.output).toContain("{ reset: true }");
	});

	/** A cell that finished normally gets NO annotation. An unconditional one would tell
	 *  the model every cell timed out. */
	it("adds no annotation to a run that did not time out", async () => {
		const kernel = new FakeKernel(OK, options => options?.onChunk?.("done\n"));

		const result = await executePythonWithKernel(kernel, "print('done')", { timeoutMs: 5_000 });

		expect(result.output).toBe("done\n");
	});
});

describe("executePythonWithKernel output handling", () => {
	/** Output is capped, and the caller is told both that it was capped and how much there
	 *  really was. Silently dropping the tail would make a truncated result look complete. */
	it("truncates oversized output and reports the real total", async () => {
		const largeOutput = "a".repeat(DEFAULT_MAX_BYTES + 128);
		const kernel = new FakeKernel(OK, options => options?.onChunk?.(largeOutput));

		const result = await executePythonWithKernel(kernel, "print('hi')");

		expect(result.truncated).toBe(true);
		expect(result.outputBytes).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
		expect(result.totalBytes).toBe(largeOutput.length);
		expect(result.output.length).toBeLessThan(largeOutput.length);
	});

	/** Output that fits is NOT marked truncated and its totals agree, so the flag above
	 *  means something. */
	it("leaves output that fits untouched", async () => {
		const kernel = new FakeKernel(OK, options => options?.onChunk?.("small\n"));

		const result = await executePythonWithKernel(kernel, "print('small')");

		expect(result.truncated).toBe(false);
		expect(result.output).toBe("small\n");
		expect(result.totalBytes).toBe(result.outputBytes);
	});

	/**
	 * Terminal control bytes are stripped before the output reaches the model: an SGR
	 * escape and a bare CR are display instructions, and left in they both waste context
	 * and make an exact-match assertion (or a diff) meaningless.
	 */
	it("strips ANSI escapes and carriage returns", async () => {
		const kernel = new FakeKernel(OK, options => options?.onChunk?.("\u001b[31mhello\r\n"));

		const result = await executePythonWithKernel(kernel, "print('hello')");

		expect(result.output).toBe("hello\n");
	});
});
