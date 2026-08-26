/**
 * WHY: the search bench answers two questions with a boolean each — do the arms AGREE, and are
 * they RIGHT — and both booleans defaulted to true over an empty set. A selection that matched
 * nothing (`--suite ""`, a `--type` no case in the suite carries, a suite registered with no
 * cases) therefore printed "Arm agreement: PASS", "Declared answers: PASS" and exited 0 having
 * measured nothing at all, which is the one answer a bench must never give.
 *
 * The class this closes is a bench stating a verdict it did not earn:
 *  - an empty selection, at either entry point, is refused by name instead of passing;
 *  - a case count of zero is refused before a corpus is written to disk;
 *  - an arm with no case of a type reports its average as absent, not as 0 ms, which would read
 *    as the fastest arm in the table;
 *  - the iteration count the report states is the count the loop ran, since one owner resolves
 *    it and refuses a fractional or non-positive count rather than clamping it;
 *  - a wrong command line exits 2, so a caller can tell "nothing ran" from "the arms disagreed".
 *
 * It does not catch a case suite whose declared answer is wrong for its corpus (that is
 * a-search-bench-case-declares-the-answer-the-corpus-has.test.ts), and it does not measure
 * timing accuracy — only that a stated number came from samples that exist. The report reading
 * its own count is enforced by the refusal rather than by an assertion here: once a fractional or
 * non-positive count throws, no accepted value differs from what the loop ran, so a report that
 * re-derives the count from the raw option cannot be observed to disagree.
 */
import { describe, expect, it } from "bun:test";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { TempDir } from "@veyyon/utils";
import type { SearchArm } from "../../../src/benches/search/arms";
import type { SearchBenchmarkCase, SearchCaseSuite } from "../../../src/benches/search/cases";
import { registerBuiltinSearchBench, searchArms, searchCaseSuites } from "../../../src/benches/search/registry";
import {
	DEFAULT_ITERATIONS_PER_CASE,
	resolveIterations,
	runSearchBench,
	runSearchCaseSuite,
	sampleExtremes,
} from "../../../src/benches/search/runner";
import { FlagValueError, flagChoice, flagCount, flagNumber, requireFlag } from "../../../src/core/flags";

const run = promisify(execFile);

const filesCase = (id: string): SearchBenchmarkCase => ({
	id,
	type: "files",
	description: `files case ${id}`,
	input: { type: "files", input: "src/**/*.ts" },
	expect: { mustMatchPaths: [] },
});

const suiteWith = (cases: readonly SearchBenchmarkCase[]): SearchCaseSuite => ({
	id: "suite-under-test",
	description: "a suite built for this test, not registered",
	corpusId: "monorepo",
	cases,
});

describe("resolving how many times a case is measured", () => {
	it("defaults to the declared default when a run states none", () => {
		expect(resolveIterations(undefined)).toBe(DEFAULT_ITERATIONS_PER_CASE);
		expect(DEFAULT_ITERATIONS_PER_CASE).toBeGreaterThanOrEqual(1);
	});

	it("accepts any positive integer", () => {
		for (const value of [1, 2, 12, 1000]) expect(resolveIterations(value)).toBe(value);
	});

	it("refuses a count the loop could not run as stated", () => {
		for (const value of [0, -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(() => resolveIterations(value)).toThrow(/iterations must be an integer >= 1/);
		}
	});

	it("states in the report the count it resolved, not the caller's raw value", async () => {
		registerBuiltinSearchBench();
		const report = await runSearchBench({
			iterations: 2,
			caseSuiteIds: ["monorepo-scoping"],
			armIds: ["direct-engine"],
			referenceArmId: "direct-engine",
			filterType: "files",
		});

		expect(report.iterationsPerCase).toBe(2);
	}, 120_000);

	it("refuses a fractional count instead of measuring one number and reporting another", async () => {
		registerBuiltinSearchBench();
		await expect(runSearchBench({ iterations: 2.5, armIds: ["direct-engine"] })).rejects.toThrow(
			/iterations must be an integer >= 1, got 2.5/,
		);
	});
});

describe("a selection that measures nothing", () => {
	it("refuses an empty case-suite list, naming the suites it does have", async () => {
		registerBuiltinSearchBench();
		const registered = [...searchCaseSuites()].map(suite => suite.id);
		expect(registered.length).toBeGreaterThan(0);

		const attempt = runSearchBench({ iterations: 1, caseSuiteIds: [] });

		await expect(attempt).rejects.toThrow(/selected no case suite/);
		for (const id of registered) await expect(attempt).rejects.toThrow(new RegExp(id));
	});

	it("refuses an empty arm list, naming the arms it does have", async () => {
		registerBuiltinSearchBench();
		const registered = [...searchArms()].map(arm => arm.id);
		expect(registered.length).toBeGreaterThan(1);

		const attempt = runSearchBench({ iterations: 1, armIds: [] });

		await expect(attempt).rejects.toThrow(/selected no arm/);
		for (const id of registered) await expect(attempt).rejects.toThrow(new RegExp(id));
	});

	it("refuses a type filter no case in the suite carries, naming the types it holds", async () => {
		registerBuiltinSearchBench();
		const arms = [...searchArms()] as readonly SearchArm[];

		await expect(
			runSearchCaseSuite(suiteWith([filesCase("a"), filesCase("b")]), arms, {
				iterations: 1,
				filterType: "structure",
				referenceArmId: arms[0].id,
			}),
		).rejects.toThrow(/holds no "structure" case to measure \(it holds: files\)/);
	});

	it("refuses a suite registered with no cases at all", async () => {
		registerBuiltinSearchBench();
		const arms = [...searchArms()] as readonly SearchArm[];

		await expect(
			runSearchCaseSuite(suiteWith([]), arms, { iterations: 1, referenceArmId: arms[0].id }),
		).rejects.toThrow(/holds no cases to measure\./);
	});

	it("refuses a suite given no arms at all", async () => {
		registerBuiltinSearchBench();

		await expect(runSearchCaseSuite(suiteWith([filesCase("a")]), [], { iterations: 1 })).rejects.toThrow(
			/was given no arms to measure/,
		);
	});

	it("refuses before writing a corpus to disk, so a mistake costs nothing", async () => {
		registerBuiltinSearchBench();
		const arms = [...searchArms()] as readonly SearchArm[];
		const temp = await TempDir.create("search-bench-empty-selection");
		try {
			const base = temp.absolute();

			await expect(
				runSearchCaseSuite(suiteWith([filesCase("a")]), arms, {
					iterations: 1,
					filterType: "text",
					referenceArmId: arms[0].id,
					corpusBaseDir: base,
				}),
			).rejects.toThrow(/holds no "text" case/);

			// materializeCorpus would have created the parent and a corpus directory inside it.
			await expect(fs.readdir(base)).resolves.toEqual([]);
		} finally {
			await temp.remove();
		}
	});
});

describe("an arm that ran no case of a type", () => {
	it("reports its average as absent rather than as the fastest arm", async () => {
		registerBuiltinSearchBench();
		const report = await runSearchBench({
			iterations: 1,
			caseSuiteIds: ["monorepo-scoping"],
			armIds: ["direct-engine"],
			referenceArmId: "direct-engine",
			filterType: "files",
		});

		const summary = report.suites[0].summaryByType;
		expect(summary.files.totalCases).toBeGreaterThan(0);
		for (const average of summary.files.armAverages) {
			expect(average.avgDurationMs).not.toBeNull();
			expect(average.avgDurationMs).toBeGreaterThanOrEqual(0);
		}

		for (const type of ["text", "structure"] as const) {
			expect(summary[type].totalCases).toBe(0);
			for (const average of summary[type].armAverages) {
				expect(average.avgDurationMs).toBeNull();
				expect(average.totalBytes).toBe(0);
			}
		}
	}, 120_000);
});

describe("the fastest and slowest sample of a case", () => {
	it("reads the extremes of the samples it was given", () => {
		expect(sampleExtremes([3, 1, 2])).toEqual({ min: 1, max: 3 });
		expect(sampleExtremes([7])).toEqual({ min: 7, max: 7 });
		expect(sampleExtremes([2, 2])).toEqual({ min: 2, max: 2 });
		expect(sampleExtremes([])).toEqual({ min: 0, max: 0 });
	});

	it("survives more samples than a call can take arguments", () => {
		const samples = Array.from({ length: 200_000 }, (_, index) => index + 1);
		samples[123_456] = 0.5;

		expect(sampleExtremes(samples)).toEqual({ min: 0.5, max: 200_000 });
	});
});

describe("a flag value the invocation cannot use", () => {
	it("is its own class of refusal at every flag reader", () => {
		expect(() => flagNumber({ jobs: "eight" }, "jobs")).toThrow(FlagValueError);
		expect(() => flagCount({ jobs: "0" }, "jobs")).toThrow(FlagValueError);
		expect(() => flagCount({ jobs: "1.5" }, "jobs")).toThrow(FlagValueError);
		expect(() => flagChoice({ type: "txt" }, "type", ["files", "text"])).toThrow(FlagValueError);
		expect(() => requireFlag({}, "run", "the run to read")).toThrow(FlagValueError);
	});
});

describe("the search bench command line", () => {
	const runnerPath = path.join(import.meta.dirname, "../../../src/benches/search/runner.ts");

	const invoke = async (args: readonly string[]): Promise<{ code: number; stderr: string }> => {
		try {
			const { stderr } = await run(process.execPath, [runnerPath, ...args], { maxBuffer: 8 << 20 });
			return { code: 0, stderr };
		} catch (error) {
			const failure = error as { code?: number; stderr?: string };
			return { code: failure.code ?? -1, stderr: failure.stderr ?? "" };
		}
	};

	it("exits 2 on a wrong invocation, before it runs anything", async () => {
		const cases: readonly { args: readonly string[]; names: RegExp }[] = [
			{ args: ["--iterations", "0"], names: /--iterations expects an integer >= 1/ },
			{ args: ["--iterations", "abc"], names: /--iterations expects a number/ },
			{ args: ["--type", "bogus"], names: /--type expects one of files, text, structure, all/ },
			{ args: ["--nope"], names: /Unknown flag "--nope"/ },
			{ args: ["--suite="], names: /--suite names nothing, got ""/ },
			{ args: ["--arms", "a,,"], names: /Unknown search bench arm "a"\. Registered arms: / },
			{ args: ["--arms", "direct-engine"], names: /Reference arm "unified-tool" is not among/ },
			{ args: ["--suite", "nope"], names: /Unknown search bench case suite "nope"/ },
		];

		for (const { args, names } of cases) {
			const result = await invoke(args);
			expect({ args, code: result.code }).toEqual({ args, code: 2 });
			expect(result.stderr).toMatch(names);
		}
	}, 180_000);

	it("prints its usage text with a refusal so the caller can fix the line", async () => {
		const result = await invoke(["--iterations", "0"]);

		expect(result.stderr).toContain("--iterations <n>     timed repetitions per case");
	}, 60_000);
});
