import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { EXIT_USAGE } from "../src/cli/exit-codes";
import { runTtsrCommand } from "../src/cli/ttsr-cli";

/**
 * WHY THIS SUITE EXISTS:
 * Usage errors in `veyyon ttsr` (missing test payload, missing scan args, unknown action)
 * must exit with EXIT_USAGE (2) rather than EXIT_FAILURE (1) so calling scripts and wrappers
 * recognize that retrying the same invalid command line will not succeed.
 */

describe("TTSR CLI exit codes on usage errors", () => {
	let exitCode: number | undefined;
	let exitCalls = 0;

	beforeEach(() => {
		exitCode = undefined;
		exitCalls = 0;
		vi.spyOn(process, "exit").mockImplementation((code?: number | string | null | undefined) => {
			exitCode = Number(code ?? 0);
			exitCalls++;
			return undefined as never;
		});
		vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("exits with EXIT_USAGE (2) when `ttsr test` is called without test input", async () => {
		await runTtsrCommand({ action: "test" });
		expect(exitCalls).toBeGreaterThan(0);
		expect(exitCode).toBe(EXIT_USAGE);
	});

	it("exits with EXIT_USAGE (2) when `ttsr scan` is called without scan args", async () => {
		await runTtsrCommand({ action: "scan" });
		expect(exitCalls).toBeGreaterThan(0);
		expect(exitCode).toBe(EXIT_USAGE);
	});

	it("exits with EXIT_USAGE (2) when an unknown action is passed", async () => {
		// @ts-expect-error testing invalid action
		await runTtsrCommand({ action: "nonexistent-action" });
		expect(exitCalls).toBeGreaterThan(0);
		expect(exitCode).toBe(EXIT_USAGE);
	});
});
