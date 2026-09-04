import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { EXIT_USAGE } from "../src/cli/exit-codes";
import { runSearchCommand } from "../src/cli/web-search-cli";

/**
 * WHY THIS SUITE EXISTS:
 * Command line usage errors (missing query, unknown provider, invalid recency, NaN limit)
 * must exit with EXIT_USAGE (2) rather than EXIT_FAILURE (1) so calling scripts and wrappers
 * can tell an invalid invocation from a runtime search failure.
 */

describe("Web search CLI exit codes on usage errors", () => {
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

	it("exits with EXIT_USAGE (2) when query is empty", async () => {
		await runSearchCommand({ query: "", expanded: false });
		expect(exitCalls).toBeGreaterThan(0);
		expect(exitCode).toBe(EXIT_USAGE);
	});

	it("exits with EXIT_USAGE (2) when provider is unknown", async () => {
		// @ts-expect-error testing invalid provider
		await runSearchCommand({ query: "test", provider: "nonexistent-provider", expanded: false });
		expect(exitCalls).toBeGreaterThan(0);
		expect(exitCode).toBe(EXIT_USAGE);
	});

	it("exits with EXIT_USAGE (2) when recency is invalid", async () => {
		// @ts-expect-error testing invalid recency
		await runSearchCommand({ query: "test", recency: "invalid-recency", expanded: false });
		expect(exitCalls).toBeGreaterThan(0);
		expect(exitCode).toBe(EXIT_USAGE);
	});

	it("exits with EXIT_USAGE (2) when limit is NaN", async () => {
		await runSearchCommand({ query: "test", limit: Number.NaN, expanded: false });
		expect(exitCalls).toBeGreaterThan(0);
		expect(exitCode).toBe(EXIT_USAGE);
	});
});
