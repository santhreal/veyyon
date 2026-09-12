import { describe, expect, it } from "bun:test";
import * as path from "node:path";

/**
 * A non-interactive mode's last frame reaches the pipe before the process exits.
 *
 * WHY THIS SUITE EXISTS. `process.exit` does not wait for stdout: a pipe holds at most its
 * kernel buffer of what `process.stdout.write` accepted, and the rest of the queue is dropped
 * with the process. A one-shot RPC client that sent `get_state` and closed stdin received the
 * response cut at 131072 bytes, which is the Linux pipe buffer to the byte. Print mode and RPC
 * mode exit through `exitAfterStdoutDrain`, whose contract is pinned here: every byte written
 * before the call is read by the parent, and the exit code the caller passed is the child's.
 *
 * CLASS. Any non-interactive exit that writes a frame larger than a pipe buffer and then
 * exits. The child writes several buffers' worth so a drain that only waited for the first
 * chunk would still fail; the exit code row catches a drain that resolves and then exits 0.
 *
 * DOES NOT CATCH. A mode that exits through a bare `process.exit` without this helper; the
 * exit-code suites for print and RPC mode drive those paths and own that wiring.
 */

const repoRoot = path.resolve(import.meta.dir, "..", "..");
const drainModule = path.join(repoRoot, "src", "cli", "stdout-drain.ts");

/** Well past a 64 KiB or 128 KiB pipe buffer, so a truncated write is a visible loss. */
const PAYLOAD_BYTES = 1024 * 1024;

async function runChild(code: number): Promise<{ exitCode: number; stdoutBytes: number }> {
	const script = [
		`import { exitAfterStdoutDrain } from ${JSON.stringify(drainModule)};`,
		`process.stdout.write("x".repeat(${PAYLOAD_BYTES}));`,
		`await exitAfterStdoutDrain(${code});`,
		// Never reached: a helper that returned instead of exiting would fail the exit-code row.
		"process.exit(99);",
	].join("\n");
	const proc = Bun.spawn([process.execPath, "-e", script], {
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).arrayBuffer(), proc.exited]);
	return { exitCode, stdoutBytes: stdout.byteLength };
}

describe("a non-interactive exit waits for stdout to drain", () => {
	it("delivers every byte written before the exit to a piped reader", async () => {
		const { stdoutBytes } = await runChild(0);
		expect(stdoutBytes).toBe(PAYLOAD_BYTES);
	}, 20_000);

	it("exits with the code the caller passed", async () => {
		const { exitCode, stdoutBytes } = await runChild(3);
		expect(exitCode).toBe(3);
		expect(stdoutBytes).toBe(PAYLOAD_BYTES);
	}, 20_000);
});
