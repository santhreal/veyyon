/**
 * WHY: Rule 3 states that only the CLI entry point maps failures to exit codes.
 * Any process.exit outside it becomes a thrown named error, with the entry point
 * preserving the mapped code (prerequisite=2, gateway=3, harbor execution=exitCode,
 * help=0, generic=1).
 */
import { describe, expect, it } from "bun:test";
import {
	GatewayHealthError,
	HarborConfigError,
	HarborExecutionError,
	HarborPrerequisiteError,
	HelpRequestedError,
	main,
	mapErrorToExitCode,
	parseArgs,
} from "../../../src/backends/harbor/runner/cli";

describe("a harbor cli maps each failure class to its exit code", () => {
	it("maps HelpRequestedError to exit code 0", () => {
		expect(mapErrorToExitCode(new HelpRequestedError())).toBe(0);
	});

	it("maps HarborPrerequisiteError to exit code 2", () => {
		expect(mapErrorToExitCode(new HarborPrerequisiteError("docker not found"))).toBe(2);
	});

	it("maps GatewayHealthError to exit code 3", () => {
		expect(mapErrorToExitCode(new GatewayHealthError("gateway down"))).toBe(3);
	});

	it("maps HarborExecutionError to the exact exit code emitted by harbor", () => {
		expect(mapErrorToExitCode(new HarborExecutionError(137, "OOM killed"))).toBe(137);
		expect(mapErrorToExitCode(new HarborExecutionError(42, "process failure"))).toBe(42);
	});

	it("maps a wrong command line to exit code 2, the code that means nothing ran", () => {
		expect(mapErrorToExitCode(new HarborConfigError("bad arg"))).toBe(2);
	});

	it("maps unknown or general errors to exit code 1", () => {
		expect(mapErrorToExitCode(new Error("generic failure"))).toBe(1);
		expect(mapErrorToExitCode("string error")).toBe(1);
	});

	it("throws HelpRequestedError on --help rather than calling process.exit directly", () => {
		expect(() => parseArgs(["--help"])).toThrow(HelpRequestedError);
	});

	it("main resolves to 0 when invoked with --help", async () => {
		const code = await main(["--help"]);
		expect(code).toBe(0);
	});

	it("main resolves to the usage exit code when required arguments are missing", async () => {
		// Missing --model flag: nothing ran, so this is 2 rather than the code a failed run returns.
		const code = await main([]);
		expect(code).toBe(2);
	});
});
