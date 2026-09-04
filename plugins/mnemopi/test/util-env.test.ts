import { describe, expect, it } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import * as path from "node:path";
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

const SRC_DIR = path.join(import.meta.dir, "..", "src");
const OWNER = path.join("util", "env.ts");

async function sourceFiles(dir: string, out: string[] = []): Promise<string[]> {
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "node_modules" || entry.name === "dist") continue;
			await sourceFiles(full, out);
		} else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
			out.push(full);
		}
	}
	return out;
}

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

describe("env-helper source lock", () => {
	// util/env.ts is the ONE owner of the env-reading helpers. A local copy is a
	// same-name-divergence trap: local-llm.ts once carried its own `env` alias and
	// an `envBool` that returned false (not the default) on an unrecognized value,
	// so MNEMOPI_LLM_ENABLED meant two different things depending on the code path.
	// Longer names first so the reported match names the exact clone.
	const ENV_HELPER_DEF =
		/\bfunction (envOptionalString|envOneOf|envString|envValue|envTruthy|envDisabled|envBool|envInt|envFloat|env)\s*\(/;

	it("catches the def shape but not a coincidental name", () => {
		expect(ENV_HELPER_DEF.test("function envBool(name: string) {")).toBe(true);
		expect(ENV_HELPER_DEF.test("function env(name: string): string {")).toBe(true);
		expect(ENV_HELPER_DEF.test("function environment() {")).toBe(false);
		expect(ENV_HELPER_DEF.test("function readEnvBool() {")).toBe(false);
	});

	it("no production source outside util/env.ts defines an env-reading helper", async () => {
		const offenders: string[] = [];
		for (const file of await sourceFiles(SRC_DIR)) {
			if (file.endsWith(OWNER)) continue;
			if (ENV_HELPER_DEF.test(await readFile(file, "utf8"))) {
				offenders.push(path.relative(SRC_DIR, file).replaceAll(path.sep, "/"));
			}
		}
		expect(offenders, "local env helper — import it from ../util/env instead").toEqual([]);
	});
});
