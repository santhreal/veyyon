/**
 * WHY: four entry points each carried their own `parseArgs`, and they disagreed on the
 * two cases that decide what a run does. A valueless flag swallowed the next argument
 * in the parsers that did not know it was valueless, so `--dry-run tasks/smoke.txt` ran
 * no tasks at all in one script and the smoke set in another; and a flag at the end of
 * the list produced `""`, `"true"` or `true` depending on which script read it, so the
 * same invocation meant different things.
 *
 * They also agreed on the wrong thing: a flag none of them declared was dropped, so
 * `--armz baseline` ran the default arms, `--iterations 0` silently became five, and
 * `--type bogus` measured every type. A misspelled knob has to refuse the invocation,
 * because the caller was trying to change the value it silently kept.
 *
 * The class this closes: any disagreement between entry points about what an argument
 * list means, and any flag that reaches a run without being declared. `src/core/flags.ts`
 * is the one definition; `FlagGrammar.valued` is required, so a call site cannot parse
 * without stating the keys it accepts. Every entry point's grammar is swept here, so a
 * flag added to one is covered the moment it is declared.
 *
 * What it does not catch: an entry point that hand-rolls its own loop instead of calling
 * `parseFlags` (the harbor CLI keeps its own typed parser, which rejects an unknown flag
 * itself), and whether a script's default for an absent flag is the right one.
 */

import { describe, expect, it, test } from "bun:test";
import { EDIT_PROMPT_BENCH_FLAGS } from "../../src/benches/edit-prompt-bench";
import { DISCLOSURE_BENCH_FLAGS } from "../../src/benches/search/disclosure";
import { SEARCH_BENCH_FLAGS } from "../../src/benches/search/runner";
import {
	type FlagGrammar,
	flagChoice,
	flagCount,
	flagNumber,
	parseFlags,
	requireFlag,
	UnknownFlagError,
} from "../../src/core/flags";
import { registerBuiltinHarnesses } from "../../src/harnesses";
import { BENCH_REPORT_FLAGS } from "../../src/report/bench-report";
import { parseServerArgs, SERVER_FLAGS } from "../../src/server/main";
import { GEN_DICTS_FLAGS } from "../../src/suites/deep-swe/gen-dicts";
import { parseArgs, VALUED_FLAGS, VALUELESS_FLAGS } from "../../src/suites/deep-swe/runner/cli-args";

/** Every grammar an evals entry point reads its invocation through. */
const GRAMMARS: Readonly<Record<string, FlagGrammar>> = {
	"deep-swe runner": { valued: VALUED_FLAGS, valueless: VALUELESS_FLAGS, aliases: { h: "help" } },
	"search bench": SEARCH_BENCH_FLAGS,
	"search disclosure bench": DISCLOSURE_BENCH_FLAGS,
	"edit-prompt bench": EDIT_PROMPT_BENCH_FLAGS,
	"bench-report writer": BENCH_REPORT_FLAGS,
	"dictionary generator": GEN_DICTS_FLAGS,
	"manager server": SERVER_FLAGS,
};

const MODEL: FlagGrammar = { valued: { model: true, jobs: true, limit: true, offset: true, rate: true } };

const VALUED_GRAMMAR: FlagGrammar = { valued: { reaggregate: true, tasks: true } };

describe("the flag grammar every entry point reads", () => {
	it("takes the value that follows a flag", () => {
		expect(parseFlags(["--model", "openai/gpt-5", "--jobs", "8"], MODEL)).toEqual({
			model: "openai/gpt-5",
			jobs: "8",
		});
	});

	it("takes an inline value after an equals sign, whatever the grammar says about the key", () => {
		expect(
			parseFlags(["--jobs=8", "--dry-run=no"], { valued: { jobs: true }, valueless: { "dry-run": true } }),
		).toEqual({ jobs: "8", "dry-run": "no" });
	});

	it("leaves the next argument alone for a flag declared valueless", () => {
		expect(parseFlags(["--dry-run"], { valued: {}, valueless: { "dry-run": true } })).toEqual({ "dry-run": "" });
	});

	it("reads a flag at the end of the list as true rather than as an empty value", () => {
		expect(parseFlags(["--model", "openai/gpt-5", "--verbose"], { valued: { model: true, verbose: true } })).toEqual({
			model: "openai/gpt-5",
			verbose: "true",
		});
	});

	it("reads a flag followed by another flag as true instead of consuming that flag", () => {
		expect(parseFlags(["--reaggregate", "--tasks", "tasks/smoke.txt"], VALUED_GRAMMAR)).toEqual({
			reaggregate: "true",
			tasks: "tasks/smoke.txt",
		});
	});

	it("maps a short spelling onto its long key before any other rule applies", () => {
		expect(parseFlags(["-h"], { valued: {}, aliases: { h: "help" }, valueless: { help: true } })).toEqual({
			help: "",
		});
	});

	it("keeps the last value of a repeated flag, so a wrapper can append an override", () => {
		expect(parseFlags(["--model", "a/one", "--model", "b/two"], MODEL)).toEqual({ model: "b/two" });
	});
});

describe("a flag the grammar does not declare", () => {
	it("refuses the invocation and states the flags it accepts", () => {
		const attempt = () => parseFlags(["--modl", "openai/gpt-5"], MODEL);
		expect(attempt).toThrow(UnknownFlagError);
		expect(attempt).toThrow(/Unknown flag "--modl"/);
		expect(attempt).toThrow(/--jobs, --limit, --model/);
	});

	it("refuses whether it arrived with a value, inline, or alone", () => {
		for (const argv of [["--nope", "x"], ["--nope=x"], ["--nope"]]) {
			expect(() => parseFlags(argv, MODEL)).toThrow(UnknownFlagError);
		}
	});

	it("refuses a stray argument that names no flag, instead of dropping it", () => {
		const attempt = () => parseFlags(["runs/pilot", "--model", "a/b"], MODEL);
		expect(attempt).toThrow(UnknownFlagError);
		expect(attempt).toThrow(/Unexpected argument "runs\/pilot"/);
	});

	it("accepts a key an entry point's plugin contributed", () => {
		const grammar: FlagGrammar = { valued: { model: true }, extraValued: ["omp-binary"] };
		expect(parseFlags(["--omp-binary", "/usr/bin/omp"], grammar)).toEqual({ "omp-binary": "/usr/bin/omp" });
		expect(() => parseFlags(["--ompbinary", "/usr/bin/omp"], grammar)).toThrow(UnknownFlagError);
	});
});

describe("reading a flag a script cannot proceed without", () => {
	it("rejects an absent flag by naming it and how to pass it", () => {
		expect(() => requireFlag(parseFlags([], MODEL), "model", "e.g. --model openai/gpt-5")).toThrow(
			/--model is required \(e\.g\. --model openai\/gpt-5\)/,
		);
	});

	it("rejects a value-taking flag that arrived with no value", () => {
		expect(() => requireFlag(parseFlags(["--model"], MODEL), "model", "usage")).toThrow(/--model is required/);
	});

	it("returns the value when one was passed", () => {
		expect(requireFlag(parseFlags(["--model", "openai/gpt-5"], MODEL), "model", "usage")).toBe("openai/gpt-5");
	});
});

describe("reading a numeric flag", () => {
	it("returns undefined for an absent flag so a caller keeps its own default", () => {
		expect(flagNumber(parseFlags([], MODEL), "limit")).toBeUndefined();
		expect(flagNumber(parseFlags(["--limit"], MODEL), "limit")).toBeUndefined();
	});

	it("parses a number, including a negative and a fractional one", () => {
		expect(flagNumber(parseFlags(["--limit", "12"], MODEL), "limit")).toBe(12);
		expect(flagNumber(parseFlags(["--offset=-3"], MODEL), "offset")).toBe(-3);
		expect(flagNumber(parseFlags(["--rate", "0.25"], MODEL), "rate")).toBe(0.25);
	});

	it("rejects a value that is not a number instead of running on NaN", () => {
		expect(() => flagNumber(parseFlags(["--limit", "ten"], MODEL), "limit")).toThrow(
			/--limit expects a number, got "ten"/,
		);
	});
});

describe("reading a flag that counts something", () => {
	it("keeps the caller's default when the flag is absent", () => {
		expect(flagCount(parseFlags([], MODEL), "limit")).toBeUndefined();
		expect(flagCount(parseFlags(["--limit"], MODEL), "limit")).toBeUndefined();
	});

	it.each(["0", "-3", "1.5", "ten"])("refuses %p rather than substituting a default", value => {
		expect(() => flagCount(parseFlags(["--limit", value], MODEL), "limit")).toThrow(/--limit expects/);
	});

	it("returns a positive integer", () => {
		expect(flagCount(parseFlags(["--limit", "12"], MODEL), "limit")).toBe(12);
	});
});

describe("reading a flag pinned to a set of spellings", () => {
	const grammar: FlagGrammar = { valued: { type: true } };
	const choices = ["files", "text", "structure", "all"] as const;

	it("returns the choice that was passed", () => {
		expect(flagChoice(parseFlags(["--type", "text"], grammar), "type", choices)).toBe("text");
	});

	it("keeps the caller's default when the flag is absent", () => {
		expect(flagChoice(parseFlags([], grammar), "type", choices)).toBeUndefined();
	});

	it("refuses a spelling outside the set and names the ones it accepts", () => {
		expect(() => flagChoice(parseFlags(["--type", "bogus"], grammar), "type", choices)).toThrow(
			/--type expects one of files, text, structure, all, got "bogus"/,
		);
	});
});

describe.each(Object.entries(GRAMMARS))("the %s grammar", (_name, grammar) => {
	const declared = [...Object.keys(grammar.valued), ...Object.keys(grammar.valueless ?? {})];

	it("declares at least one flag, so its entry point states what it accepts", () => {
		expect(declared.length).toBeGreaterThan(0);
	});

	it("refuses a flag it does not declare", () => {
		expect(() => parseFlags(["--not-a-flag-any-entry-point-has"], grammar)).toThrow(UnknownFlagError);
	});

	test.each(declared)("accepts --%s", flag => {
		const valueless = Object.hasOwn(grammar.valueless ?? {}, flag);
		const parsed = parseFlags(valueless ? [`--${flag}`] : [`--${flag}`, "value"], grammar);
		expect(Object.keys(parsed)).toContain(flag);
		expect(parsed[flag]).toBe(valueless ? "" : "value");
	});
});

describe("the manager server reads that grammar", () => {
	it("refuses a misspelled flag instead of serving the default it names", () => {
		expect(() => parseServerArgs(["--prt", "4712"])).toThrow(/Unknown flag "--prt"/);
	});

	it("refuses a port outside the range a socket can bind", () => {
		for (const port of ["0", "99999", "-1", "4700.5"]) {
			expect(() => parseServerArgs(["--port", port])).toThrow();
		}
	});

	it("reads the flags it declares, and defaults the rest", () => {
		const args = parseServerArgs(["--port", "4712", "--host", "0.0.0.0", "--token", "abc"]);
		expect(args.port).toBe(4712);
		expect(args.host).toBe("0.0.0.0");
		expect(args.token).toBe("abc");
		const bare = parseServerArgs([]);
		expect(bare.port).toBe(4700);
		expect(bare.host).toBe("127.0.0.1");
		expect(bare.token).toBeUndefined();
	});
});

describe("the deep-swe runner reads that grammar", () => {
	it("accepts -h for --help, which the runner declares valueless", () => {
		expect(parseArgs(["-h"])).toEqual({ help: "" });
		expect(parseArgs(["--help", "--tasks", "tasks/smoke.txt"])).toEqual({ help: "", tasks: "tasks/smoke.txt" });
		expect(Object.keys(VALUELESS_FLAGS)).toContain("help");
	});

	it("refuses a misspelled arm flag instead of running the default arms", () => {
		expect(() => parseArgs(["--armz", "baseline"])).toThrow(/Unknown flag "--armz"/);
	});

	it("accepts every flag a registered harness reads, and only those", () => {
		registerBuiltinHarnesses();
		const harnessFlags = ["omp-binary", "omp-api-key", "factory-binary", "factory-auth", "hermes-auth", "auth-db"];
		for (const flag of harnessFlags) {
			expect(Object.keys(parseArgs([`--${flag}`, "x"], harnessFlags))).toContain(flag);
			expect(() => parseArgs([`--${flag}`, "x"])).toThrow(UnknownFlagError);
		}
	});
});
