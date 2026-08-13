import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type BashResult, executeBash } from "@veyyon/coding-agent/exec/bash-executor";
import {
	__resetDirsFromEnvForTests,
	captureDirOverrides,
	type DirOverridesSnapshot,
	removeWithRetries,
	restoreDirOverrides,
	setAgentDir,
} from "@veyyon/utils";

/**
 * A command that prints 100MB must cost the agent kilobytes, not 100MB.
 *
 * WHY THIS SUITE EXISTS (EXEC-1). `bun test` on a large repo, `cat` on a binary,
 * a build with a stuck progress bar, a runaway `yes`: every one of these is an
 * ordinary command an agent runs, and every one can emit output far larger than
 * the process should ever hold. There are two separate ways that hurts, and this
 * suite pins both.
 *
 * The first is memory. If the executor accumulated the stream and truncated at
 * the end, a 100MB command would allocate 100MB (in fact 200MB, since a JS
 * string is UTF-16) before deciding to throw almost all of it away. It does not:
 * `OutputSink` keeps a bounded head window plus a rolling tail and discards the
 * middle AS IT ARRIVES. That is a design property with no visible symptom until
 * the day it regresses and the agent is OOM-killed mid-task, which is why it is
 * asserted against a real 100MB command rather than assumed from reading the
 * code.
 *
 * The second is honesty. Bounding the output is only safe if the agent is TOLD
 * the output was bounded and by how much. A result that silently drops 99.9% of
 * a build log and reads as complete is worse than one that fails: the agent
 * concludes the build printed nothing and reasons from that. So the reported
 * totals are asserted to describe the WHOLE stream while the returned body is
 * asserted to be small.
 *
 * These run real subprocesses on purpose. A mocked stream would exercise the
 * sink's arithmetic and prove nothing about what happens when a pipe delivers
 * 100MB as fast as the kernel can move it.
 */

/**
 * 100MB of 200-byte lines (199 `a`s and a newline), exactly. The ordinary
 * shape: many lines.
 *
 * `yes` writes in large blocks and `head -c` cuts the pipe at exactly 100MB, so
 * this costs about a tenth of a second. It used to be
 * `head -c 100000000 /dev/zero | tr '\0' 'a' | fold -w 200`, and `fold` moves a
 * character at a time: on a loaded two-core CI runner that pipeline delivered
 * 62MB in 180 seconds, hit the executor's timeout, and failed an assertion
 * about the OUTPUT SINK because of the throughput of `fold`. A suite about a
 * memory bound must not be a benchmark of the command it uses to reach it.
 */
const HUGE_MULTILINE = "__huge_line=$(head -c 199 /dev/zero | tr '\\0' 'a'); yes \"$__huge_line\" | head -c 100000000";
/** 100MB with NO newline at all. The pathological shape for anything line-buffered. */
const HUGE_SINGLE_LINE = "head -c 100000000 /dev/zero | tr '\\0' 'a'";

// `executeBash` initializes the global Settings singleton, which opens the agent
// storage db. Both roots move to a temp dir so the real `~/.veyyon` is never
// touched (the real-data tripwire refuses it outright, and rightly).
let agentDir = "";
let configRoot = "";
let dirOverrides: DirOverridesSnapshot;
let originalEnv: Array<[string, string | undefined]> = [];

beforeAll(async () => {
	originalEnv = ["VEYYON_CODING_AGENT_DIR", "VEYYON_CONFIG_DIR"].map(key => [key, process.env[key]]);
	agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-hugeout-agent-"));
	configRoot = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-hugeout-config-"));
	// Resolved relative to os.homedir(), which Bun fixes at process start, so a
	// relative path from the real home is the only way to move the config root.
	process.env.VEYYON_CONFIG_DIR = path.relative(os.homedir(), configRoot);
	dirOverrides = captureDirOverrides();
	setAgentDir(agentDir);
	__resetDirsFromEnvForTests();
});

afterAll(async () => {
	for (const [key, value] of originalEnv) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	restoreDirOverrides(dirOverrides);
	await removeWithRetries(agentDir);
	await removeWithRetries(configRoot);
});

const MB = 1024 * 1024;
const HUGE_BYTES = 100_000_000;
/**
 * Heap growth allowed across a 100MB command.
 *
 * Deliberately loose: the point is to catch accumulation, which shows up as tens
 * or hundreds of megabytes, not to police allocator noise. A run that buffered
 * the stream would blow through this by more than an order of magnitude.
 */
const HEAP_BUDGET_MB = 96;

async function heapDeltaMB(run: () => Promise<unknown>): Promise<number> {
	Bun.gc(true);
	const before = process.memoryUsage().heapUsed;
	await run();
	Bun.gc(true);
	return (process.memoryUsage().heapUsed - before) / MB;
}

describe("a 100MB command does not put 100MB in memory", () => {
	/**
	 * THE CORE BOUND. Many-line output, the common case, held to a small fraction
	 * of what it streamed. If the sink ever starts accumulating, this is where it
	 * shows.
	 */
	it("holds heap growth far below the streamed size for multi-line output", async () => {
		let result: BashResult | undefined;
		const delta = await heapDeltaMB(async () => {
			result = await executeBash(HUGE_MULTILINE, { timeout: 60_000 });
		});

		// Asserted before the size, so a run that never finished says so instead
		// of reporting a byte count that is really a stopwatch reading.
		expect(result?.cancelled).toBe(false);
		expect(result?.totalBytes).toBe(HUGE_BYTES);
		expect(delta).toBeLessThan(HEAP_BUDGET_MB);
	}, 90_000);

	/**
	 * THE PATHOLOGICAL SHAPE. One 100MB line with no newline anywhere. Any
	 * implementation that buffers "until the end of the current line" before
	 * trimming has no trim point here and holds the whole thing.
	 */
	it("holds heap growth below the streamed size for a single 100MB line", async () => {
		let result: BashResult | undefined;
		const delta = await heapDeltaMB(async () => {
			result = await executeBash(HUGE_SINGLE_LINE, { timeout: 60_000 });
		});

		expect(result?.cancelled).toBe(false);
		expect(result?.totalBytes).toBe(HUGE_BYTES);
		expect(delta).toBeLessThan(HEAP_BUDGET_MB);
	}, 90_000);

	/**
	 * The returned body is what actually enters the conversation and gets re-read
	 * on every later turn, so it is bounded much more tightly than the heap. A
	 * megabyte here would be a cost regression even with memory under control.
	 */
	it("returns a body of kilobytes, not megabytes", async () => {
		const result = await executeBash(HUGE_MULTILINE, { timeout: 60_000 });

		expect(result.cancelled).toBe(false);
		expect(Buffer.byteLength(result.output, "utf-8")).toBeLessThan(1024 * 1024);
		expect(result.outputBytes).toBeLessThan(1024 * 1024);
	}, 90_000);
});

describe("the bound is reported, never silent", () => {
	/**
	 * THE HONESTY HALF. `truncated` is set and the totals describe the FULL
	 * stream, not the kept sample. Without this an agent reads a 70KB tail of a
	 * 100MB build log and has no way to know the other 99.93MB existed.
	 */
	it("reports the real streamed size alongside the much smaller kept size", async () => {
		const result = await executeBash(HUGE_MULTILINE, { timeout: 60_000 });

		expect(result.cancelled).toBe(false);
		expect(result.truncated).toBe(true);
		expect(result.totalBytes).toBe(HUGE_BYTES);
		expect(result.outputBytes).toBeLessThan(result.totalBytes / 100);
		// 500,000 newline-terminated lines, plus the empty segment after the final
		// newline: the sink counts segments, not newlines.
		expect(result.totalLines).toBe(HUGE_BYTES / 200 + 1);
		expect(result.outputLines).toBeLessThan(result.totalLines);
	}, 90_000);

	/**
	 * A single line reports one line and its full byte count. The line count must
	 * not be derived from the kept sample, or a 100MB line would report its size
	 * as the few hundred bytes that survived.
	 */
	it("reports the full byte count for a single unterminated line", async () => {
		const result = await executeBash(HUGE_SINGLE_LINE, { timeout: 60_000 });

		expect(result.cancelled).toBe(false);
		expect(result.truncated).toBe(true);
		expect(result.totalBytes).toBe(HUGE_BYTES);
		expect(result.outputBytes).toBeLessThan(HUGE_BYTES);
	}, 90_000);

	/**
	 * THE NEGATIVE TWIN. Ordinary output is not touched at all: no truncation
	 * flag, exact bytes, exact text. A bound that fires on small output would
	 * corrupt every normal command, which is a far commoner failure than the one
	 * this suite is about.
	 */
	it("leaves small output byte-identical and unflagged", async () => {
		const result = await executeBash("printf 'hello\\nworld\\n'", { timeout: 30_000 });

		expect(result.output).toBe("hello\nworld\n");
		expect(result.truncated).toBe(false);
		expect(result.totalBytes).toBe(12);
		expect(result.outputBytes).toBe(12);
		expect(result.exitCode).toBe(0);
	}, 60_000);

	/**
	 * The exit code survives the volume. A command whose status was lost because
	 * its output was large would be reported as a failure of an unknown kind,
	 * which is exactly the wrong conclusion for a successful noisy build.
	 *
	 * The status comes from a CHILD (`sh -c`), not a bare `exit 3`. The executor
	 * reuses one persistent shell per session key, so a bare `exit` would tear
	 * that shell down and hang the next command in this file rather than testing
	 * anything about output volume.
	 */
	it("still reports the exit code of a command that printed 100MB", async () => {
		const result = await executeBash(`${HUGE_MULTILINE}; sh -c 'exit 3'`, { timeout: 60_000 });

		expect(result.exitCode).toBe(3);
		expect(result.cancelled).toBe(false);
	}, 90_000);
});
