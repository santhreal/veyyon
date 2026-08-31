import { describe, expect, it } from "bun:test";
import {
	type Env,
	envBool,
	envDisabled,
	envFloat,
	envInt,
	envOneOf,
	envOptionalString,
	envString,
	envTruthy,
	envValue,
} from "../src/util/env";

describe("envValue", () => {
	it("returns value when present", () => {
		expect(envValue("FOO", { FOO: "bar" })).toBe("bar");
	});
	it("returns undefined when absent", () => {
		expect(envValue("FOO", {})).toBeUndefined();
	});
	it("returns empty string when set to empty", () => {
		expect(envValue("FOO", { FOO: "" })).toBe("");
	});
});

describe("envString", () => {
	it("returns value when present", () => {
		expect(envString("FOO", "default", { FOO: "bar" })).toBe("bar");
	});
	it("returns default when absent", () => {
		expect(envString("FOO", "default", {})).toBe("default");
	});
	it("returns empty string when set to empty", () => {
		expect(envString("FOO", "default", { FOO: "" })).toBe("");
	});
	it("default is empty string when not provided", () => {
		const env: Env = {};
		expect(envString("FOO", "", env)).toBe("");
	});
});

describe("envOptionalString", () => {
	it("returns trimmed value when present", () => {
		expect(envOptionalString("FOO", { FOO: "  bar  " })).toBe("bar");
	});
	it("returns undefined when absent", () => {
		expect(envOptionalString("FOO", {})).toBeUndefined();
	});
	it("returns undefined for empty string", () => {
		expect(envOptionalString("FOO", { FOO: "" })).toBeUndefined();
	});
	it("returns undefined for whitespace-only string", () => {
		expect(envOptionalString("FOO", { FOO: "   " })).toBeUndefined();
	});
});

describe("envTruthy", () => {
	it("returns true for '1'", () => {
		expect(envTruthy("FOO", { FOO: "1" })).toBe(true);
	});
	it("returns true for 'true'", () => {
		expect(envTruthy("FOO", { FOO: "true" })).toBe(true);
	});
	it("returns true for 'yes'", () => {
		expect(envTruthy("FOO", { FOO: "yes" })).toBe(true);
	});
	it("returns true for 'on'", () => {
		expect(envTruthy("FOO", { FOO: "on" })).toBe(true);
	});
	it("returns true for 'TRUE' case-insensitively", () => {
		expect(envTruthy("FOO", { FOO: "TRUE" })).toBe(true);
	});
	it("returns false for '0'", () => {
		expect(envTruthy("FOO", { FOO: "0" })).toBe(false);
	});
	it("returns false for 'false'", () => {
		expect(envTruthy("FOO", { FOO: "false" })).toBe(false);
	});
	it("returns false for absent", () => {
		expect(envTruthy("FOO", {})).toBe(false);
	});
	it("returns false for unknown value", () => {
		expect(envTruthy("FOO", { FOO: "maybe" })).toBe(false);
	});
	it("trims whitespace", () => {
		expect(envTruthy("FOO", { FOO: "  true  " })).toBe(true);
	});
});

describe("envDisabled", () => {
	it("returns true for '0'", () => {
		expect(envDisabled("FOO", { FOO: "0" })).toBe(true);
	});
	it("returns true for 'false'", () => {
		expect(envDisabled("FOO", { FOO: "false" })).toBe(true);
	});
	it("returns true for 'no'", () => {
		expect(envDisabled("FOO", { FOO: "no" })).toBe(true);
	});
	it("returns true for 'off'", () => {
		expect(envDisabled("FOO", { FOO: "off" })).toBe(true);
	});
	it("returns false for '1'", () => {
		expect(envDisabled("FOO", { FOO: "1" })).toBe(false);
	});
	it("returns false for absent", () => {
		expect(envDisabled("FOO", {})).toBe(false);
	});
	it("returns false for unknown value", () => {
		expect(envDisabled("FOO", { FOO: "maybe" })).toBe(false);
	});
});

describe("envBool", () => {
	it("returns true for '1'", () => {
		expect(envBool("FOO", false, { FOO: "1" })).toBe(true);
	});
	it("returns false for '0'", () => {
		expect(envBool("FOO", true, { FOO: "0" })).toBe(false);
	});
	it("returns default for absent", () => {
		expect(envBool("FOO", true, {})).toBe(true);
	});
	it("returns default for unknown value", () => {
		expect(envBool("FOO", true, { FOO: "maybe" })).toBe(true);
	});
	it("returns default for empty string", () => {
		expect(envBool("FOO", false, { FOO: "" })).toBe(false);
	});
});

describe("envInt", () => {
	it("returns parsed int", () => {
		expect(envInt("FOO", 10, { FOO: "42" })).toBe(42);
	});
	it("returns default for absent", () => {
		expect(envInt("FOO", 10, {})).toBe(10);
	});
	it("returns default for non-numeric", () => {
		expect(envInt("FOO", 10, { FOO: "abc" })).toBe(10);
	});
	it("returns default for empty string", () => {
		expect(envInt("FOO", 10, { FOO: "" })).toBe(10);
	});
	it("handles negative numbers", () => {
		expect(envInt("FOO", 10, { FOO: "-5" })).toBe(-5);
	});
	it("trims whitespace", () => {
		expect(envInt("FOO", 10, { FOO: "  42  " })).toBe(42);
	});
	it("handles float string as int", () => {
		expect(envInt("FOO", 10, { FOO: "42.9" })).toBe(42);
	});
});

describe("envFloat", () => {
	it("returns parsed float", () => {
		expect(envFloat("FOO", 1.5, { FOO: "3.14" })).toBe(3.14);
	});
	it("returns default for absent", () => {
		expect(envFloat("FOO", 1.5, {})).toBe(1.5);
	});
	it("returns default for non-numeric", () => {
		expect(envFloat("FOO", 1.5, { FOO: "abc" })).toBe(1.5);
	});
	it("handles negative floats", () => {
		expect(envFloat("FOO", 1.5, { FOO: "-2.5" })).toBe(-2.5);
	});
	it("handles integer strings", () => {
		expect(envFloat("FOO", 1.5, { FOO: "42" })).toBe(42);
	});
	it("trims whitespace", () => {
		expect(envFloat("FOO", 1.5, { FOO: "  3.14  " })).toBe(3.14);
	});
});

describe("envOneOf", () => {
	it("returns value when in allowed list", () => {
		expect(envOneOf("FOO", ["a", "b", "c"], "a", { FOO: "b" })).toBe("b");
	});
	it("returns default when absent", () => {
		expect(envOneOf("FOO", ["a", "b", "c"], "a", {})).toBe("a");
	});
	it("returns default when not in allowed list", () => {
		expect(envOneOf("FOO", ["a", "b", "c"], "a", { FOO: "d" })).toBe("a");
	});
	it("is case insensitive", () => {
		expect(envOneOf("FOO", ["a", "b", "c"], "a", { FOO: "B" })).toBe("b");
	});
	it("trims whitespace", () => {
		expect(envOneOf("FOO", ["a", "b", "c"], "a", { FOO: "  b  " })).toBe("b");
	});
	it("returns default for empty string", () => {
		expect(envOneOf("FOO", ["a", "b", "c"], "a", { FOO: "" })).toBe("a");
	});
});
