import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	$envpos,
	$flag,
	$pickenv,
	filterChildShellEnv,
	filterProcessEnv,
	isTerminalHeadless,
	isValidEnvName,
	parseEnvFile,
	setTerminalHeadless,
} from "@veyyon/utils/env";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, { force: true, recursive: true });
	}
});

function writeTempEnv(content: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-utils-env-"));
	tempDirs.push(dir);
	const filePath = path.join(dir, ".env");
	fs.writeFileSync(filePath, content);
	return filePath;
}

describe("parseEnvFile", () => {
	it("ignores malformed names and nul-containing values", () => {
		const filePath = writeTempEnv(
			[
				"GOOD=value",
				"_ALSO_GOOD='quoted value'",
				"1BAD=value",
				"BAD-NAME=value",
				"BAD NAME=value",
				"BAD_VALUE=before\0after",
				"# comment",
				"NO_EQUALS",
			].join("\n"),
		);

		expect(parseEnvFile(filePath)).toEqual({
			GOOD: "value",
			_ALSO_GOOD: "quoted value",
		});
	});

	it("parses keys verbatim and drops NUL-corrupted values (no cross-brand mirroring)", () => {
		const filePath = writeTempEnv("VEYYON_FEATURE=enabled\nVEYYON_BAD=before\0after\n");

		// Clean break: no VEYYON_/OMP_ → PI_ mirror. Keys are returned as-is and
		// a value containing a NUL byte is dropped.
		expect(parseEnvFile(filePath)).toEqual({
			VEYYON_FEATURE: "enabled",
		});
	});
});

describe("filterProcessEnv", () => {
	it("drops entries that cannot be passed to process spawn env", () => {
		expect(
			filterProcessEnv({
				GOOD: "value",
				EMPTY: "",
				"BAD=NAME": "value",
				BAD_VALUE: "before\0after",
				MISSING: undefined,
			}),
		).toEqual({
			GOOD: "value",
			EMPTY: "",
		});
	});

	it("drops macOS malloc stack logging toggles instead of forwarding disabled values", () => {
		expect(
			filterProcessEnv({
				GOOD: "value",
				MallocStackLogging: "0",
				MallocStackLoggingNoCompact: "0",
			}),
		).toEqual({
			GOOD: "value",
		});
	});

	it("preserves Windows-style variable names containing parentheses", () => {
		// `ProgramFiles(x86)` and friends are standard on Windows and must
		// survive the scrub so Git Bash discovery in procmgr.ts can resolve
		// 32-bit Program Files installations.
		expect(
			filterProcessEnv({
				"ProgramFiles(x86)": "C:\\Program Files (x86)",
				"CommonProgramFiles(x86)": "C:\\Program Files (x86)\\Common Files",
			}),
		).toEqual({
			"ProgramFiles(x86)": "C:\\Program Files (x86)",
			"CommonProgramFiles(x86)": "C:\\Program Files (x86)\\Common Files",
		});
	});
});

describe("parseEnvFile syntax", () => {
	it("strips quotes, skips comments/blank/eq-less lines, and trims", () => {
		const filePath = writeTempEnv(
			[
				"# comment",
				"",
				"NOEQUALS",
				'DOUBLE="quoted value"',
				"SINGLE='single value'",
				"  SPACED  =  padded  ",
				"EMPTY=",
			].join("\n"),
		);
		expect(parseEnvFile(filePath)).toEqual({
			DOUBLE: "quoted value",
			SINGLE: "single value",
			SPACED: "padded",
			EMPTY: "",
		});
	});

	it("returns an empty object for a missing file", () => {
		expect(parseEnvFile("/definitely/not/here/.env")).toEqual({});
	});
});

describe("filterChildShellEnv", () => {
	it("removes values that came from the launch cwd .env.local", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-utils-env-"));
		tempDirs.push(dir);
		fs.writeFileSync(path.join(dir, ".env.local"), "LOCAL_ONLY=secret\nSHARED=from-local\n");
		const result = filterChildShellEnv({ LOCAL_ONLY: "secret", SHARED: "different-value", KEEP: "yes" }, dir);
		// exact .env.local matches are stripped; differing values survive
		expect(result).toEqual({ SHARED: "different-value", KEEP: "yes" });
	});
});

describe("env accessors", () => {
	it("isValidEnvName enforces shell-identifier shape", () => {
		expect(isValidEnvName("GOOD_NAME1")).toBe(true);
		expect(isValidEnvName("_leading")).toBe(true);
		expect(isValidEnvName("1BAD")).toBe(false);
		expect(isValidEnvName("HAS-DASH")).toBe(false);
		expect(isValidEnvName("")).toBe(false);
	});

	it("$pickenv returns the first non-blank value in key order", () => {
		Bun.env.PICKENV_A = "";
		Bun.env.PICKENV_B = "  ";
		Bun.env.PICKENV_C = "found";
		try {
			expect($pickenv("PICKENV_A", "PICKENV_B", "PICKENV_C")).toBe("found");
			expect($pickenv("PICKENV_A", "PICKENV_MISSING")).toBeUndefined();
		} finally {
			delete Bun.env.PICKENV_A;
			delete Bun.env.PICKENV_B;
			delete Bun.env.PICKENV_C;
		}
	});

	it("$envpos accepts only positive integers, else the default", () => {
		try {
			Bun.env.ENVPOS_T = "12";
			expect($envpos("ENVPOS_T", 5)).toBe(12);
			Bun.env.ENVPOS_T = "0";
			expect($envpos("ENVPOS_T", 5)).toBe(5);
			Bun.env.ENVPOS_T = "-3";
			expect($envpos("ENVPOS_T", 5)).toBe(5);
			Bun.env.ENVPOS_T = "abc";
			expect($envpos("ENVPOS_T", 5)).toBe(5);
			delete Bun.env.ENVPOS_T;
			expect($envpos("ENVPOS_T", 5)).toBe(5);
		} finally {
			delete Bun.env.ENVPOS_T;
		}
	});

	it("$flag treats the documented truthy spellings as true, everything else as false", () => {
		try {
			for (const truthy of ["1", "true", "TRUE", "yes", "YES", "on", "y"]) {
				Bun.env.FLAG_T = truthy;
				expect($flag("FLAG_T")).toBe(true);
			}
			for (const falsy of ["0", "false", "off", "no", "garbage"]) {
				Bun.env.FLAG_T = falsy;
				expect($flag("FLAG_T")).toBe(false);
			}
			delete Bun.env.FLAG_T;
			expect($flag("FLAG_T")).toBe(false);
			expect($flag("FLAG_T", true)).toBe(true);
		} finally {
			delete Bun.env.FLAG_T;
		}
	});

	it("setTerminalHeadless returns the previous value for exact restore", () => {
		const initial = isTerminalHeadless();
		expect(initial).toBe(true); // bun test runtime defaults headless
		const prev = setTerminalHeadless(false);
		expect(prev).toBe(initial);
		expect(isTerminalHeadless()).toBe(false);
		setTerminalHeadless(prev);
		expect(isTerminalHeadless()).toBe(initial);
	});
});
