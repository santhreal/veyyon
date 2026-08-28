/**
 * WHY: an entry point that accepts a flag it cannot act on measures something other than what it
 * was asked to measure, and reports the result under the caller's headings. Every kind of that
 * defect was live in this package at once:
 *  - `goal-budget-context-bench.ts` read no argument list at all, so every flag was dropped and it
 *    exited 0 having measured the defaults;
 *  - `context-encode-ceiling.ts` read `--holdout` with `argv.includes`, so `--holdut` ran the
 *    in-sample sweep and printed it under the holdout headings, and `process.argv[3]` became the
 *    dictionary source whatever it was;
 *  - `online-codec-ceiling.ts` filtered every `--`-prefixed argument out of its path list, so a
 *    misspelled flag vanished and `--minLength 40` left "40" behind as a file to read;
 *  - `measure-retype-likelihood.ts` read `--repo` as `argv[indexOf + 1]`, so `--repo --json` used
 *    "--json" as the repository path, and a trailing `--sessions` silently fell back to the default
 *    transcript tree;
 *  - `edit-prompt-bench.ts`, `bench-report.ts` and `gen-dicts.ts` let the grammar's refusal escape
 *    as an uncaught exception, printing source frames and exiting 1, the code that means a run
 *    happened and failed;
 *  - `generate.ts` and `trace-report.ts` kept `node:util parseArgs`, which refuses with a TypeError
 *    and reads a count through `parseInt`, so `--count-per-type abc` generated nothing.
 *
 * The class this closes is any entry point in this package that does not refuse an argument it
 * cannot act on. The sweep discovers every `import.meta.main` module under the package root at run
 * time and spawns each one, so a new entry point is covered the moment it exists and turns this
 * suite red until it reads the grammar. `EXIT_NOTHING_RAN` is pinned by exact equality: nothing
 * ran, so the exit is 2, never 1.
 *
 * What it does not catch: whether a script's default for an absent flag is the right one, whether a
 * declared flag reaches the behavior it names (each entry point's own suite covers that), and a
 * module that performs a run at import time without an `import.meta.main` guard.
 *
 * One mutation stays green and is equivalent rather than uncovered: reading `--holdout` back off
 * `process.argv.includes` in `context-encode-ceiling.ts`. The grammar has already refused every
 * spelling the flag is not, so both readings answer the same question by then.
 */

import { describe, expect, it } from "bun:test";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import {
	type FlagGrammar,
	FlagValueError,
	flagText,
	parseArgv,
	parseFlags,
	UnknownFlagError,
} from "../../engine/flag-grammar";

const run = promisify(execFile);

/** Nothing ran, so the invocation is the failure. A run that happened and failed exits 1. */
const EXIT_NOTHING_RAN = 2;

const PACKAGE_ROOT = path.join(import.meta.dirname, "..", "..");

/** A flag no entry point declares, and no shell would produce by accident. */
const BOGUS_FLAG = "--veyyon-not-a-flag";

/**
 * Entry points are discovered rather than listed: a new script under the package root with an
 * `import.meta.main` guard joins this sweep without anyone remembering to add it.
 * `dashboard/` is excluded because those modules load in a browser and have no argument list.
 * Non-source directories (`test`, `.cache`, `runs`, `.internal`, `node_modules`, `assets`,
 * `agents`, `scripts`, `dashboard`) are skipped.
 */
const SKIP_DIRS = new Set([
	"test",
	".cache",
	"runs",
	".internal",
	"node_modules",
	"assets",
	"agents",
	"scripts",
	"dashboard",
	".git",
]);

async function discoverEntryPoints(dir: string, acc: string[] = []): Promise<string[]> {
	for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (SKIP_DIRS.has(entry.name)) continue;
			await discoverEntryPoints(full, acc);
			continue;
		}
		if (!entry.name.endsWith(".ts")) continue;
		const source = await fs.readFile(full, "utf8");
		if (source.includes("import.meta.main")) acc.push(full);
	}
	return acc;
}

const ENTRY_POINTS = (await discoverEntryPoints(PACKAGE_ROOT)).sort();

interface Refusal {
	code: number;
	output: string;
}

async function invoke(script: string, args: readonly string[]): Promise<Refusal> {
	try {
		const { stdout, stderr } = await run(process.execPath, [script, ...args], { maxBuffer: 8 << 20 });
		return { code: 0, output: `${stdout}${stderr}` };
	} catch (error) {
		const failure = error as { code?: number; stdout?: string; stderr?: string };
		return { code: failure.code ?? -1, output: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
	}
}

describe("an entry point that cannot act on a flag", () => {
	it("discovers every entry point in the package, so the sweep cannot go stale", () => {
		expect(ENTRY_POINTS.length).toBeGreaterThanOrEqual(15);
		expect(ENTRY_POINTS.some(file => file.endsWith("evals.ts"))).toBe(true);
	});

	it.each(ENTRY_POINTS.map(file => [path.relative(PACKAGE_ROOT, file), file] as [string, string]))(
		"%s refuses a flag it does not declare, and says nothing ran",
		async (_name, script) => {
			const refusal = await invoke(script, [BOGUS_FLAG]);

			expect(refusal.code).toBe(EXIT_NOTHING_RAN);
			expect(refusal.output).toContain(BOGUS_FLAG);
			// A refusal states the invocation was wrong; a stack trace states the script broke.
			expect(refusal.output).not.toContain("[Uncaught Exception]");
		},
		60_000,
	);

	// A valued flag at the end of the argument list parses as "true". These two scripts passed that
	// on as a directory path and reported "no transcript tree at true" after measuring nothing; one
	// of them fell back to the default tree instead and reported those numbers as the requested ones.
	it.each([
		["measurements/channel-split.ts", "sessions"],
		["measurements/retype-likelihood.ts", "sessions"],
		["measurements/retype-likelihood.ts", "repo"],
	] as [string, string][])(
		"%s refuses --%s given without its value",
		async (script, flag) => {
			const refusal = await invoke(path.join(PACKAGE_ROOT, script), [`--${flag}`]);

			expect(refusal.code).toBe(EXIT_NOTHING_RAN);
			expect(refusal.output).toContain(`--${flag} expects a value`);
		},
		60_000,
	);

	// The grammar sweep proves `flagCount` refuses; these prove each entry point routes its count
	// through it, rather than reading `Number(...)` and running with NaN.
	it.each([
		["tools/trace-report.ts", "concurrency", ["--concurrency", "abc"]],
		["suites/typescript-edit/generate.ts", "count-per-type", ["--count-per-type", "abc"]],
		["benches/edit-prompt.ts", "limit", ["--model", "openai/gpt-5", "--limit", "0"]],
		["tools/generate-dicts.ts", "jobs", ["--all", "--jobs", "-1"]],
	] as [string, string, string[]][])(
		"%s refuses a --%s it cannot count",
		async (script, flag, args) => {
			const refusal = await invoke(path.join(PACKAGE_ROOT, script), args);

			expect(refusal.code).toBe(EXIT_NOTHING_RAN);
			expect(refusal.output).toContain(`--${flag} expects`);
		},
		60_000,
	);

	it("refuses an argument past the count a positional entry point takes", async () => {
		const refusal = await invoke(path.join(PACKAGE_ROOT, "measurements/prefix-composition.ts"), [
			"jobs",
			"baseline__",
			"extra",
		]);

		expect(refusal.code).toBe(EXIT_NOTHING_RAN);
		expect(refusal.output).toContain("at most 2 arguments");
	}, 60_000);
});

describe("the grammar that carries a positional argument", () => {
	const TWO: FlagGrammar = { valued: {}, valueless: { holdout: true }, positionals: { max: 2 } };

	it("collects the arguments an entry point names positionally, in order", () => {
		expect(parseArgv(["corpus.json", "dict.json", "--holdout"], TWO)).toEqual({
			flags: { holdout: "" },
			positionals: ["corpus.json", "dict.json"],
		});
	});

	it("refuses one argument past what the entry point takes, naming the bound", () => {
		expect(() => parseArgv(["a.json", "b.json", "c.json"], TWO)).toThrow(UnknownFlagError);
		expect(() => parseArgv(["a.json", "b.json", "c.json"], TWO)).toThrow(/at most 2 arguments/);
	});

	it("refuses any bare argument when the entry point names every input by a flag", () => {
		expect(() => parseFlags(["tasks/smoke.txt"], { valued: { tasks: true } })).toThrow(
			/every input is named by a flag/,
		);
	});

	it("accepts a variadic list when the entry point declares one", () => {
		const variadic: FlagGrammar = { valued: {}, positionals: { max: Number.POSITIVE_INFINITY } };

		expect(parseArgv(["a", "b", "c", "d", "e"], variadic).positionals).toEqual(["a", "b", "c", "d", "e"]);
	});

	it("reads a valued flag, and refuses the one that arrived without its value", () => {
		const grammar: FlagGrammar = { valued: { sessions: true } };

		expect(flagText(parseFlags(["--sessions", "/tmp/tree"], grammar), "sessions")).toBe("/tmp/tree");
		expect(flagText(parseFlags([], grammar), "sessions")).toBeUndefined();
		expect(() => flagText(parseFlags(["--sessions"], grammar), "sessions")).toThrow(FlagValueError);
		expect(() => flagText(parseFlags(["--sessions"], grammar), "sessions")).toThrow(/--sessions expects a value/);
	});
});
