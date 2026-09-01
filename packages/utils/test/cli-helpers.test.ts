import { describe, expect, it } from "bun:test";
import {
	CLI_EXIT_USAGE,
	maskNegativeNumbers,
	NEGATIVE_MASK,
	NEGATIVE_NUMBER,
	type ParsedArgs,
} from "../src/cli-helpers";

describe("NEGATIVE_NUMBER regex", () => {
	it("matches negative integers", () => {
		expect(NEGATIVE_NUMBER.test("-1")).toBe(true);
		expect(NEGATIVE_NUMBER.test("-42")).toBe(true);
	});

	it("matches negative decimals", () => {
		expect(NEGATIVE_NUMBER.test("-.5")).toBe(true);
		expect(NEGATIVE_NUMBER.test("-3.14")).toBe(true);
	});

	it("does not match positive numbers", () => {
		expect(NEGATIVE_NUMBER.test("1")).toBe(false);
		expect(NEGATIVE_NUMBER.test("42")).toBe(false);
	});

	it("does not match flags starting with --", () => {
		expect(NEGATIVE_NUMBER.test("--flag")).toBe(false);
		expect(NEGATIVE_NUMBER.test("--help")).toBe(false);
	});

	it("does not match empty string", () => {
		expect(NEGATIVE_NUMBER.test("")).toBe(false);
	});
});

describe("maskNegativeNumbers", () => {
	it("returns identity when no negative numbers present", () => {
		const { args, restore } = maskNegativeNumbers(["--flag", "value", "--help"]);
		expect(args).toEqual(["--flag", "value", "--help"]);
		const parsed: ParsedArgs = { values: { flag: "value" }, positionals: ["--help"] };
		expect(restore(parsed)).toBe(parsed);
	});

	it("masks negative numbers in args", () => {
		const { args } = maskNegativeNumbers(["-1", "-2.5", "--flag"]);
		expect(args[0]).toContain(NEGATIVE_MASK);
		expect(args[1]).toContain(NEGATIVE_MASK);
		expect(args[2]).toBe("--flag");
	});

	it("preserves order with mask indices", () => {
		const { args } = maskNegativeNumbers(["-1", "normal", "-3"]);
		expect(args[0]).toBe(`${NEGATIVE_MASK}0`);
		expect(args[1]).toBe("normal");
		expect(args[2]).toBe(`${NEGATIVE_MASK}1`);
	});

	it("does not mask after double dash", () => {
		const { args } = maskNegativeNumbers(["--", "-1", "-2"]);
		expect(args).toEqual(["--", "-1", "-2"]);
	});

	it("masks before double dash but not after", () => {
		const { args } = maskNegativeNumbers(["-1", "--", "-2"]);
		expect(args[0]).toBe(`${NEGATIVE_MASK}0`);
		expect(args[1]).toBe("--");
		expect(args[2]).toBe("-2");
	});

	it("restores negative numbers in values", () => {
		const { args, restore } = maskNegativeNumbers(["-1", "--flag"]);
		const parsed: ParsedArgs = {
			values: { flag: args[0] },
			positionals: [],
		};
		const restored = restore(parsed);
		expect(restored.values.flag).toBe("-1");
	});

	it("restores negative numbers in positionals", () => {
		const { args, restore } = maskNegativeNumbers(["-42"]);
		const parsed: ParsedArgs = {
			values: {},
			positionals: [args[0]],
		};
		const restored = restore(parsed);
		expect(restored.positionals).toEqual(["-42"]);
	});

	it("restores negative numbers in array values", () => {
		const { args, restore } = maskNegativeNumbers(["-1", "-2"]);
		const parsed: ParsedArgs = {
			values: { nums: [args[0], args[1]] },
			positionals: [],
		};
		const restored = restore(parsed);
		expect(restored.values.nums).toEqual(["-1", "-2"]);
	});

	it("preserves boolean values during restore", () => {
		const { restore } = maskNegativeNumbers(["-1"]);
		const parsed: ParsedArgs = {
			values: { verbose: true, count: args_placeholder() },
			positionals: [],
		};
		const restored = restore(parsed);
		expect(restored.values.verbose).toBe(true);
	});

	it("preserves undefined values during restore", () => {
		const { restore } = maskNegativeNumbers(["-1"]);
		const parsed: ParsedArgs = {
			values: { missing: undefined },
			positionals: [],
		};
		const restored = restore(parsed);
		expect(restored.values.missing).toBeUndefined();
	});

	it("handles empty argv", () => {
		const { args, restore } = maskNegativeNumbers([]);
		expect(args).toEqual([]);
		const parsed: ParsedArgs = { values: {}, positionals: [] };
		expect(restore(parsed)).toBe(parsed);
	});

	it("handles multiple negative numbers interspersed with flags", () => {
		const { args } = maskNegativeNumbers(["--start", "-5", "--end", "-10", "file.txt"]);
		expect(args[1]).toBe(`${NEGATIVE_MASK}0`);
		expect(args[3]).toBe(`${NEGATIVE_MASK}1`);
		expect(args[0]).toBe("--start");
		expect(args[2]).toBe("--end");
		expect(args[4]).toBe("file.txt");
	});

	it("restore handles mixed string and boolean array values", () => {
		const { args, restore } = maskNegativeNumbers(["-1"]);
		const parsed: ParsedArgs = {
			values: { mixed: [args[0], true, "normal"] },
			positionals: [],
		};
		const restored = restore(parsed);
		expect(restored.values.mixed).toEqual(["-1", true, "normal"]);
	});

	it("CLI_EXIT_USAGE is 2", () => {
		expect(CLI_EXIT_USAGE).toBe(2);
	});
});

// Helper to avoid lint complaints about unused vars
function args_placeholder(): string {
	return `${NEGATIVE_MASK}0`;
}
