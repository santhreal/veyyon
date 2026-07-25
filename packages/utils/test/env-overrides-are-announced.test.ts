/**
 * An environment override that cannot be used is reported, not quietly replaced by the default.
 *
 * WHY THIS SUITE EXISTS. Two silent paths in `env.ts`.
 *
 * `$envpos` returned `defaultValue` for anything that did not parse to a positive integer, including
 * a variable the user had deliberately set. Someone who writes `VEYYON_TASK_MAX_OUTPUT_BYTES=5OO000`
 * (letter O for zero), `=1_000_000` (underscores, which `parseInt` stops at), or `=0` got the
 * built-in default with no indication their setting did nothing, and then reasoned about limits that
 * were never in effect. `task/types.ts` had a second copy of this parser with a dead `try/catch`
 * around `Number.parseInt`, which does not throw; that copy is gone and `$envpos` is the one owner.
 *
 * `parseEnvFile` swallowed every error with the comment "File doesn't exist or can't be read". Those
 * are not the same thing. Four candidate paths are probed at startup and most are absent, which is
 * ordinary; a `.env` that EXISTS and cannot be read is usually the one holding the user's API keys,
 * and dropping it silently surfaces later as an authentication failure nobody can trace back to a
 * permission bit (Law 10).
 *
 * Both stay non-fatal: a typo in an override must not stop the process from starting. The contract
 * is that the operator hears about it, so both halves are pinned here — loud when it matters, silent
 * on the ordinary miss so the warning that matters is not buried.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { $envpos, logger, parseEnvFile } from "@veyyon/utils";

const NAME = "VEYYON_TEST_ENVPOS_FIXTURE";

let warnings: Array<{ message: string; fields: Record<string, unknown> }>;

beforeEach(() => {
	warnings = [];
	vi.spyOn(logger, "warn").mockImplementation((message: string, fields?: Record<string, unknown>) => {
		warnings.push({ message, fields: fields ?? {} });
	});
});

afterEach(() => {
	vi.restoreAllMocks();
	// This suite writes a process-global; leaving it set would make every later file in the
	// run read a variable it never asked about. See docs/internal/testing.md on isolation.
	delete process.env[NAME];
});

describe("$envpos", () => {
	it("returns the value when the variable is a positive integer", () => {
		process.env[NAME] = "1234";

		expect($envpos(NAME, 99)).toBe(1234);
		expect(warnings).toEqual([]);
	});

	it("says nothing when the variable is unset, which is the ordinary case", () => {
		// The load-bearing silence. Nearly every call reaches this path, and a warning here
		// would bury the ones below.
		expect($envpos(NAME, 99)).toBe(99);
		expect(warnings).toEqual([]);
	});

	it("says nothing when the variable is set to an empty string", () => {
		// `FOO=` in a shell profile means "unset it", not "I asked for something specific".
		process.env[NAME] = "";

		expect($envpos(NAME, 99)).toBe(99);
		expect(warnings).toEqual([]);
	});

	it("reports a value that is not a number at all, and names the variable and the default", () => {
		// The operator needs three things to fix this: which variable, what they typed, and
		// what is being used instead.
		process.env[NAME] = "not-a-number";

		expect($envpos(NAME, 500_000)).toBe(500_000);
		expect(warnings.length).toBe(1);
		expect(warnings[0]?.message).toBe("Environment variable is not a positive integer; using the default instead.");
		expect(warnings[0]?.fields).toEqual({ name: NAME, value: "not-a-number", default: 500_000 });
	});

	it("reports zero and negative values, which parse fine and are still unusable", () => {
		// `=0` is the interesting one: it looks like a deliberate "disable this", it parses,
		// and the limit it produces is the default rather than anything the user asked for.
		process.env[NAME] = "0";
		expect($envpos(NAME, 7)).toBe(7);
		process.env[NAME] = "-5";
		expect($envpos(NAME, 7)).toBe(7);

		expect(warnings.map(entry => entry.fields.value)).toEqual(["0", "-5"]);
	});

	it("refuses a value with a trailing unit rather than taking its leading digits", () => {
		// `parseInt("10s")` is 10. Accepting that would mean `=10s` and `=10` are the same
		// setting, and it is the same leniency that turned `5OO000` into 5 — a number nobody
		// chose. The whole value has to be digits.
		process.env[NAME] = "10s";

		expect($envpos(NAME, 7)).toBe(7);
		expect(warnings.length).toBe(1);
		expect(warnings[0]?.fields.value).toBe("10s");
	});

	it("refuses a typo that parseInt would silently read as a much smaller number", () => {
		// The regression this rule exists for. `Number.parseInt("5OO000", 10)` is 5, so a
		// single mistyped character capped agent output at five BYTES with no warning and no
		// way to tell from the outside.
		process.env[NAME] = "5OO000";

		expect($envpos(NAME, 500_000)).toBe(500_000);
		expect(warnings.length).toBe(1);
		expect(warnings[0]?.fields.value).toBe("5OO000");
	});

	it("accepts a value padded with whitespace, which a shell profile makes easy to produce", () => {
		process.env[NAME] = "  4096  ";

		expect($envpos(NAME, 7)).toBe(4096);
		expect(warnings).toEqual([]);
	});

	it("reports a value whose digits parseInt cannot reach", () => {
		// Underscore grouping is valid in TypeScript source and not in an environment
		// variable. `parseInt("_1000")` is NaN, so this is a real silent-default case.
		process.env[NAME] = "_1000";

		expect($envpos(NAME, 7)).toBe(7);
		expect(warnings.length).toBe(1);
		expect(warnings[0]?.fields.value).toBe("_1000");
	});
});

describe("parseEnvFile", () => {
	let dir: string;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-env-file-"));
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("says nothing about a file that does not exist", () => {
		// Four candidates are probed on every start (cwd, agent dir, config root, home) and
		// most are absent. This silence is why the warning below is worth reading.
		expect(parseEnvFile(path.join(dir, ".env"))).toEqual({});
		expect(warnings).toEqual([]);
	});

	it("parses a real file without comment", () => {
		fs.writeFileSync(path.join(dir, ".env"), '# a comment\nFOO=bar\nQUOTED="spaced value"\n\n');

		expect(parseEnvFile(path.join(dir, ".env"))).toEqual({ FOO: "bar", QUOTED: "spaced value" });
		expect(warnings).toEqual([]);
	});

	it("reports a file that exists but cannot be read, and says its variables were dropped", () => {
		// A directory named `.env` reaches the same catch as a permission denial, and it is
		// the case a test can create portably. The message has to say the variables were
		// dropped, because that is the consequence the user will otherwise see as a
		// mysterious missing credential.
		fs.mkdirSync(path.join(dir, ".env"));

		expect(parseEnvFile(path.join(dir, ".env"))).toEqual({});
		expect(warnings.length).toBe(1);
		expect(warnings[0]?.message).toBe(
			"Environment file exists but could not be read; none of its variables were applied.",
		);
		expect(warnings[0]?.fields.path).toBe(path.join(dir, ".env"));
		expect(String(warnings[0]?.fields.error)).toContain("EISDIR");
	});

	it("says nothing when a path component is not a directory", () => {
		// `ENOTDIR`: there is no file there either, so this is absence and not a failure.
		fs.writeFileSync(path.join(dir, "file"), "x");

		expect(parseEnvFile(path.join(dir, "file", ".env"))).toEqual({});
		expect(warnings).toEqual([]);
	});
});
