/**
 * WHY: four entry points each carried their own `parseArgs`, and they disagreed on the
 * two cases that decide what a run does. A valueless flag swallowed the next argument
 * in the parsers that did not know it was valueless, so `--dry-run tasks/smoke.txt` ran
 * no tasks at all in one script and the smoke set in another; and a flag at the end of
 * the list produced `""`, `"true"` or `true` depending on which script read it, so the
 * same invocation meant different things.
 *
 * The class this closes: any disagreement between entry points about what an argument
 * list means. `src/core/flags.ts` is the one definition, and the deep-swe runner, the
 * dictionary generator, the bench-report writer and the edit-prompt bench all read
 * through it. Each grammar rule is pinned here once, so a change to any of them is a
 * change every entry point sees at the same time.
 *
 * What it does not catch: which flags a given script accepts (the harbor CLI keeps its
 * own typed parser and rejects an unknown flag), and whether a script's default value
 * for an absent flag is the right one.
 */

import { describe, expect, it } from "bun:test";
import { flagNumber, parseFlags, requireFlag } from "../../src/core/flags";
import { parseArgs, VALUELESS_FLAGS } from "../../src/suites/deep-swe/runner/cli-args";

describe("the flag grammar every entry point reads", () => {
	it("takes the value that follows a flag", () => {
		expect(parseFlags(["--model", "openai/gpt-5", "--jobs", "8"])).toEqual({
			model: "openai/gpt-5",
			jobs: "8",
		});
	});

	it("takes an inline value after an equals sign, whatever the grammar says about the key", () => {
		expect(parseFlags(["--jobs=8", "--dry-run=no"], { valueless: { "dry-run": true } })).toEqual({
			jobs: "8",
			"dry-run": "no",
		});
	});

	it("leaves the next argument alone for a flag declared valueless", () => {
		expect(parseFlags(["--dry-run", "tasks/smoke.txt"], { valueless: { "dry-run": true } })).toEqual({
			"dry-run": "",
		});
	});

	it("reads a flag at the end of the list as true rather than as an empty value", () => {
		expect(parseFlags(["--model", "openai/gpt-5", "--verbose"])).toEqual({
			model: "openai/gpt-5",
			verbose: "true",
		});
	});

	it("reads a flag followed by another flag as true instead of consuming that flag", () => {
		expect(parseFlags(["--reaggregate", "--tasks", "tasks/smoke.txt"])).toEqual({
			reaggregate: "true",
			tasks: "tasks/smoke.txt",
		});
	});

	it("maps a short spelling onto its long key before any other rule applies", () => {
		expect(parseFlags(["-h"], { aliases: { h: "help" }, valueless: { help: true } })).toEqual({ help: "" });
	});

	it("keeps the last value of a repeated flag, so a wrapper can append an override", () => {
		expect(parseFlags(["--model", "a/one", "--model", "b/two"])).toEqual({ model: "b/two" });
	});

	it("ignores a bare positional argument rather than inventing a key for it", () => {
		expect(parseFlags(["runs/pilot", "--out", "runs/merged"])).toEqual({ out: "runs/merged" });
	});
});

describe("reading a flag a script cannot proceed without", () => {
	it("rejects an absent flag by naming it and how to pass it", () => {
		expect(() => requireFlag(parseFlags([]), "model", "e.g. --model openai/gpt-5")).toThrow(
			/--model is required \(e\.g\. --model openai\/gpt-5\)/,
		);
	});

	it("rejects a value-taking flag that arrived with no value", () => {
		expect(() => requireFlag(parseFlags(["--model"]), "model", "usage")).toThrow(/--model is required/);
	});

	it("returns the value when one was passed", () => {
		expect(requireFlag(parseFlags(["--model", "openai/gpt-5"]), "model", "usage")).toBe("openai/gpt-5");
	});
});

describe("reading a numeric flag", () => {
	it("returns undefined for an absent flag so a caller keeps its own default", () => {
		expect(flagNumber(parseFlags([]), "limit")).toBeUndefined();
		expect(flagNumber(parseFlags(["--limit"]), "limit")).toBeUndefined();
	});

	it("parses a number, including a negative and a fractional one", () => {
		expect(flagNumber(parseFlags(["--limit", "12"]), "limit")).toBe(12);
		expect(flagNumber(parseFlags(["--offset=-3"]), "offset")).toBe(-3);
		expect(flagNumber(parseFlags(["--rate", "0.25"]), "rate")).toBe(0.25);
	});

	it("rejects a value that is not a number instead of running on NaN", () => {
		expect(() => flagNumber(parseFlags(["--limit", "ten"]), "limit")).toThrow(/--limit expects a number, got "ten"/);
	});
});

describe("the deep-swe runner reads that grammar", () => {
	it("accepts -h for --help, which the runner declares valueless", () => {
		expect(parseArgs(["-h"])).toEqual({ help: "" });
		expect(parseArgs(["--help", "--tasks", "tasks/smoke.txt"])).toEqual({ help: "", tasks: "tasks/smoke.txt" });
		expect(Object.keys(VALUELESS_FLAGS)).toContain("help");
	});
});
