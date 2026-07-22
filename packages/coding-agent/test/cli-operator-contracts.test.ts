import { describe, expect, it } from "bun:test";
import { parseArgs, reportUnrecognizedFlags } from "@veyyon/coding-agent/cli/args";

/**
 * Operator-facing CLI parse contracts: unknown flags are recorded (issue #2459)
 * and reported loud; help/version/print modes set exact fields.
 */

describe("CLI operator contracts (parseArgs)", () => {
	it("records unknown long flags without consuming them as the prompt", () => {
		const parsed = parseArgs(["--definitely-not-a-real-flag-xyz"]);
		expect(parsed.unrecognizedFlags).toEqual(["--definitely-not-a-real-flag-xyz"]);
		expect(parsed.messages).toEqual([]);
	});

	it("sets help and version booleans", () => {
		expect(parseArgs(["--help"]).help).toBe(true);
		expect(parseArgs(["--version"]).version).toBe(true);
	});

	it("parses --print with a prompt string", () => {
		const args = parseArgs(["--print", "hello operator"]);
		expect(args.print).toBe(true);
		expect(args.messages).toEqual(["hello operator"]);
		expect(args.unrecognizedFlags).toEqual([]);
	});

	it("parses empty argv into defaults with no messages and no unknown flags", () => {
		const args = parseArgs([]);
		expect(args.messages).toEqual([]);
		expect(args.unrecognizedFlags).toEqual([]);
		expect(args.help).toBeFalsy();
		expect(args.print).toBeFalsy();
	});

	it("reportUnrecognizedFlags returns true when unknowns remain", () => {
		const parsed = parseArgs(["--list-models"]);
		// reportUnrecognizedFlags writes to stderr and returns whether it reported.
		const reported = reportUnrecognizedFlags(parsed);
		expect(parsed.unrecognizedFlags).toEqual(["--list-models"]);
		expect(reported).toBe(true);
	});

	it("reportUnrecognizedFlags returns false when the parse is clean", () => {
		const parsed = parseArgs(["--print", "hi"]);
		expect(reportUnrecognizedFlags(parsed)).toBe(false);
	});
});
