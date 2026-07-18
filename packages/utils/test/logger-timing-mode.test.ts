import { afterEach, describe, expect, it } from "bun:test";
import { shouldExitAfterTimings, timingModeIncludes } from "../src/logger";

const ORIGINAL = process.env.VEYYON_TIMING;

afterEach(() => {
	if (ORIGINAL === undefined) delete process.env.VEYYON_TIMING;
	else process.env.VEYYON_TIMING = ORIGINAL;
});

describe("timingModeIncludes", () => {
	it("is false when VEYYON_TIMING is unset or empty", () => {
		delete process.env.VEYYON_TIMING;
		expect(timingModeIncludes("full")).toBe(false);
		process.env.VEYYON_TIMING = "";
		expect(timingModeIncludes("x")).toBe(false);
	});

	it("matches an exact single value", () => {
		process.env.VEYYON_TIMING = "full";
		expect(timingModeIncludes("full")).toBe(true);
		expect(timingModeIncludes("x")).toBe(false);
	});

	it("matches whole tokens across every documented separator", () => {
		for (const value of ["x,full", "x:full", "x;full", "x+full", "x full"]) {
			process.env.VEYYON_TIMING = value;
			expect(timingModeIncludes("x")).toBe(true);
			expect(timingModeIncludes("full")).toBe(true);
		}
	});

	it("does not substring-match inside longer tokens", () => {
		process.env.VEYYON_TIMING = "xfull,extra";
		expect(timingModeIncludes("x")).toBe(false);
		expect(timingModeIncludes("full")).toBe(false);
	});
});

describe("shouldExitAfterTimings", () => {
	it("is true for either x or full, false otherwise", () => {
		process.env.VEYYON_TIMING = "x";
		expect(shouldExitAfterTimings()).toBe(true);
		process.env.VEYYON_TIMING = "full";
		expect(shouldExitAfterTimings()).toBe(true);
		process.env.VEYYON_TIMING = "other";
		expect(shouldExitAfterTimings()).toBe(false);
	});
});
