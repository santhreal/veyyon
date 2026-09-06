import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { EXIT_USAGE } from "../src/cli/exit-codes";
import { runShellCommand } from "../src/cli/shell-cli";

/**
 * WHY THIS SUITE EXISTS:
 * Launching the interactive shell console in a non-TTY environment is a usage/environment
 * error that cannot succeed on an automated retry. It must exit with EXIT_USAGE (2)
 * per the exit codes contract (exit-codes.ts:47).
 */

describe("Shell CLI non-TTY exit code", () => {
	let exitCode: number | undefined;
	let exitCalls = 0;
	let originalIsTTY: boolean | undefined;

	beforeEach(() => {
		exitCode = undefined;
		exitCalls = 0;
		originalIsTTY = process.stdin.isTTY;
		Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });

		vi.spyOn(process, "exit").mockImplementation((code?: number | string | null | undefined) => {
			exitCode = Number(code ?? 0);
			exitCalls++;
			return undefined as never;
		});
		vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	});

	afterEach(() => {
		Object.defineProperty(process.stdin, "isTTY", { value: originalIsTTY, configurable: true });
		vi.restoreAllMocks();
	});

	it("exits with EXIT_USAGE (2) when stdin is not a TTY", async () => {
		await runShellCommand({});
		expect(exitCalls).toBeGreaterThan(0);
		expect(exitCode).toBe(EXIT_USAGE);
	});
});
