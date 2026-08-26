/**
 * WHY THIS SUITE EXISTS. The DeepSWE runner shipped a parser where a value flag
 * with a missing value consumed whatever came next, so `--tasks --dry-run` ran a
 * real benchmark against a task literally named `--dry-run`: money spent, no dry
 * run, no error. `a-valueless-benchmark-flag-never-consumes-the-next-option.test.ts`
 * closed it for that runner. This CLI is a second parser over the same axes, so it
 * inherits the same class and closes it the same way.
 *
 * THE CLASS: any flag that reads a value must refuse a missing one instead of
 * absorbing a neighbouring flag, and any flag that reads no value must refuse a
 * value instead of ignoring it. Both directions sweep the parser's own flag tables,
 * so a flag added later is covered the moment it is declared — and a flag that the
 * printed help does not mention fails the last case below.
 *
 * WHAT IT DOES NOT CATCH: whether a suite interprets a resolved config or prompt
 * path correctly. That is the suite's own contract.
 */

import { describe, expect, it } from "bun:test";
import { BOOLEAN_FLAGS, CliUsageError, parseEvalsArgs, USAGE, VALUE_FLAGS } from "../../src/cli";

const valueFlags = Object.keys(VALUE_FLAGS);
const booleanFlags = Object.keys(BOOLEAN_FLAGS);

describe("a value flag refuses a missing value", () => {
	it("has value flags to sweep", () => {
		expect(valueFlags.length).toBeGreaterThan(5);
	});

	it.each(valueFlags)("%s followed by another flag is an error, not a value", flag => {
		expect(() => parseEvalsArgs([flag, "--dry-run"])).toThrow(CliUsageError);
	});

	it.each(valueFlags)("%s at the end of argv is an error", flag => {
		expect(() => parseEvalsArgs([flag])).toThrow(/needs a value/);
	});

	it.each(valueFlags)("%s= with an empty value is an error", flag => {
		expect(() => parseEvalsArgs([`${flag}=`])).toThrow(/non-empty/);
	});

	it("keeps the following flag intact once the value is supplied", () => {
		const args = parseEvalsArgs(["--tasks", "task-a", "--dry-run"]);

		expect(args.tasks).toEqual(["task-a"]);
		expect(args.dryRun).toBe(true);
	});
});

describe("a boolean flag refuses a value", () => {
	it.each(booleanFlags)("%s=true is an error rather than a silently ignored value", flag => {
		expect(() => parseEvalsArgs([`${flag}=true`])).toThrow(/takes no value/);
	});
});

describe("axis flags", () => {
	it("splits a comma list into one variant member per entry", () => {
		const args = parseEvalsArgs(["--model", "a/one, b/two", "--harness", "veyyon,omp"]);

		expect(args.models).toEqual(["a/one", "b/two"]);
		expect(args.harnesses).toEqual(["veyyon", "omp"]);
	});

	it("accumulates a repeated flag instead of replacing the earlier value", () => {
		const args = parseEvalsArgs(["--config", "arms/a.yml", "--config", "arms/b.yml"]);

		expect(args.configs).toEqual(["arms/a.yml", "arms/b.yml"]);
	});

	it("accepts both --flag value and --flag=value", () => {
		expect(parseEvalsArgs(["--suite", "terminal-bench"]).suite).toBe("terminal-bench");
		expect(parseEvalsArgs(["--suite=terminal-bench"]).suite).toBe("terminal-bench");
	});
});

describe("numeric flags", () => {
	it.each(["0", "-1", "1.5", "many"])("refuses --repeats %p", value => {
		expect(() => parseEvalsArgs(["--repeats", value])).toThrow(/--repeats must be an integer/);
	});

	it.each(["0", "-2", "2.5", "lots"])("refuses --jobs %p", value => {
		expect(() => parseEvalsArgs(["--jobs", value])).toThrow(/--jobs must be an integer/);
	});

	it("defaults repeats and jobs to one", () => {
		const args = parseEvalsArgs(["--suite=terminal-bench"]);

		expect(args.repeats).toBe(1);
		expect(args.jobs).toBe(1);
	});
});

describe("anything the parser does not know", () => {
	it("refuses an unknown flag rather than ignoring it", () => {
		expect(() => parseEvalsArgs(["--turbo"])).toThrow(/Unknown flag "--turbo"/);
	});

	it("refuses a positional argument, so a mistyped flag cannot become a task id", () => {
		expect(() => parseEvalsArgs(["terminal-bench"])).toThrow(/Unexpected positional/);
	});
});

describe("the parser and the help it prints agree", () => {
	/**
	 * A flag the parser accepts and the help never mentions is undiscoverable, and a
	 * flag the help promises and the parser rejects is a lie. Both directions read the
	 * live tables and the live help string, so neither can drift in silence.
	 */
	it("documents every flag it accepts", () => {
		const undocumented = [...valueFlags, ...booleanFlags].filter(flag => !USAGE.includes(flag));
		expect(undocumented).toEqual([]);
	});

	it("accepts every flag its help advertises", () => {
		const advertised = [...new Set([...USAGE.matchAll(/(--[a-z][a-z-]+)/g)].map(match => match[1] as string))];
		const rejected = advertised.filter(flag => !VALUE_FLAGS[flag] && !BOOLEAN_FLAGS[flag]);

		expect(rejected).toEqual([]);
	});
});
