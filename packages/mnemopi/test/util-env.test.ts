import { describe, expect, it } from "bun:test";
import {
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

describe("envValue / envString / envOptionalString", () => {
	it("envValue returns the raw value or undefined, preserving empty strings", () => {
		expect(envValue("X", { X: "abc" })).toBe("abc");
		expect(envValue("X", { X: "" })).toBe("");
		expect(envValue("X", {})).toBeUndefined();
	});

	it("envString defaults only on undefined, not empty", () => {
		expect(envString("X", "d", { X: "v" })).toBe("v");
		expect(envString("X", "d", { X: "" })).toBe("");
		expect(envString("X", "d", {})).toBe("d");
		expect(envString("X", undefined, {})).toBe("");
	});

	it("envOptionalString trims and treats blank as unset", () => {
		expect(envOptionalString("X", { X: "  v  " })).toBe("v");
		expect(envOptionalString("X", { X: "   " })).toBeUndefined();
		expect(envOptionalString("X", {})).toBeUndefined();
	});
});

describe("envTruthy / envDisabled", () => {
	it("envTruthy accepts only the truthy table, case-insensitively", () => {
		for (const v of ["1", "true", "YES", " On "]) expect(envTruthy("X", { X: v })).toBe(true);
		for (const v of ["0", "false", "2", "enabled", ""]) expect(envTruthy("X", { X: v })).toBe(false);
		expect(envTruthy("X", {})).toBe(false);
	});

	it("envDisabled accepts only the falsy table", () => {
		for (const v of ["0", "FALSE", "no", " off "]) expect(envDisabled("X", { X: v })).toBe(true);
		for (const v of ["1", "true", "disabled", ""]) expect(envDisabled("X", { X: v })).toBe(false);
		expect(envDisabled("X", {})).toBe(false);
	});
});

describe("envBool", () => {
	it("maps both tables and falls back to the default on garbage or blank", () => {
		expect(envBool("X", false, { X: "yes" })).toBe(true);
		expect(envBool("X", true, { X: "Off" })).toBe(false);
		expect(envBool("X", true, { X: "garbage" })).toBe(true);
		expect(envBool("X", false, { X: "garbage" })).toBe(false);
		expect(envBool("X", true, { X: "  " })).toBe(true);
		expect(envBool("X", false, {})).toBe(false);
	});
});

describe("envInt / envFloat", () => {
	it("envInt parses base-10 integers and defaults on blank/garbage", () => {
		expect(envInt("X", 7, { X: "42" })).toBe(42);
		expect(envInt("X", 7, { X: " -3 " })).toBe(-3);
		expect(envInt("X", 7, { X: "12abc" })).toBe(12); // parseInt prefix semantics
		expect(envInt("X", 7, { X: "abc" })).toBe(7);
		expect(envInt("X", 7, { X: "" })).toBe(7);
		expect(envInt("X", 7, {})).toBe(7);
	});

	it("envFloat parses floats and defaults on non-finite", () => {
		expect(envFloat("X", 0.5, { X: "3.25" })).toBe(3.25);
		expect(envFloat("X", 0.5, { X: "1e2" })).toBe(100);
		expect(envFloat("X", 0.5, { X: "Infinity" })).toBe(0.5);
		expect(envFloat("X", 0.5, { X: "nope" })).toBe(0.5);
		expect(envFloat("X", 0.5, {})).toBe(0.5);
	});
});

describe("envOneOf", () => {
	const allowed = ["fast", "slow", "auto"] as const;

	it("matches allowed values case-insensitively after trim", () => {
		expect(envOneOf("X", allowed, "auto", { X: " FAST " })).toBe("fast");
		expect(envOneOf("X", allowed, "auto", { X: "slow" })).toBe("slow");
	});

	it("returns the default for unknown or blank values", () => {
		expect(envOneOf("X", allowed, "auto", { X: "turbo" })).toBe("auto");
		expect(envOneOf("X", allowed, "auto", { X: "" })).toBe("auto");
		expect(envOneOf("X", allowed, "auto", {})).toBe("auto");
	});
});
