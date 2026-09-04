import { describe, expect, it } from "bun:test";
import type { FileSearchDetails } from "@veyyon/coding-agent/tools/search/file-search";
import type { SearchToolDetails } from "@veyyon/coding-agent/tools/search/search";
import type { StructureSearchDetails } from "@veyyon/coding-agent/tools/search/structure-search";
import type { TextSearchDetails } from "@veyyon/coding-agent/tools/search/text-search";
import { materializeCorpus } from "../../../benches/search/corpus";
import {
	collectMatchedPaths,
	formatExpectationFailures,
	type SearchExpectation,
	verifySearchExpectation,
} from "../../../benches/search/expectations";
import {
	createSearchBenchmarkSession,
	formatSearchBenchReport,
	measureSearchCase,
	runSearchBench,
} from "../../../benches/search/main";
import {
	registerBuiltinSearchBench,
	requireSearchArm,
	requireSearchCorpus,
	searchCaseSuiteIds,
	searchCaseSuites,
} from "../../../benches/search/registry";

/**
 * WHY: the parity arm compares `SearchTool` against the engine functions the tool
 * itself calls, so parity is satisfied by construction and a green parity run says
 * nothing about whether either arm answered correctly. The defect class this closes is
 * a search engine that regresses in both arms at once — a glob that stops recursing, a
 * gitignore rule read the wrong way round, a structural pattern that matches no node —
 * which parity reports as PASS while the bench measures the cost of finding nothing.
 * The class was live: three structure cases were matching zero files under a green
 * parity run until the declared answers were introduced.
 *
 * The suite pins the verdict layer (`collectMatchedPaths`, `verifySearchExpectation`)
 * against every details variant and every clause, requires each bench case to declare
 * a non-empty answer, drives the whole bench over the real corpus and real engines, and
 * proves strict mode fails a case whose answer is not produced.
 *
 * What it does not catch: whether a declared answer is the *right* answer for the
 * corpus. A wrong expectation and a wrong engine agreeing is invisible here; the
 * answers are derived from the corpus literals in `parity.ts`, which this file reads
 * through the search engines rather than by parsing source.
 */

const fileDetails = (files: string[]): FileSearchDetails => ({ fileCount: files.length, files });

const textDetails = (fileMatches: Array<{ path: string; count: number }>, files?: string[]): TextSearchDetails => ({
	matchCount: fileMatches.reduce((acc, entry) => acc + entry.count, 0),
	fileCount: fileMatches.length,
	files,
	fileMatches,
});

const structureDetails = (fileMatches: Array<{ path: string; count: number }>): StructureSearchDetails => ({
	matchCount: fileMatches.reduce((acc, entry) => acc + entry.count, 0),
	fileCount: fileMatches.length,
	filesSearched: fileMatches.length,
	limitReached: false,
	fileMatches,
});

describe("the files a search reported", () => {
	it("comes from a file result's files list", () => {
		expect(collectMatchedPaths(fileDetails(["src/index.ts", "src/types.ts"]))).toEqual([
			"src/index.ts",
			"src/types.ts",
		]);
	});

	it("comes from a text result's per-file match counts", () => {
		expect(collectMatchedPaths(textDetails([{ path: "src/core/engine.ts", count: 3 }]))).toEqual([
			"src/core/engine.ts",
		]);
	});

	it("comes from a structural result's per-file match counts", () => {
		expect(collectMatchedPaths(structureDetails([{ path: "src/utils/math.ts", count: 2 }]))).toEqual([
			"src/utils/math.ts",
		]);
	});

	it("unwraps the unified tool's { type, result } envelope", () => {
		const wrapped: SearchToolDetails = { type: "files", result: fileDetails(["docs/overview.md"]) };
		expect(collectMatchedPaths(wrapped)).toEqual(["docs/overview.md"]);
	});

	it("unions files and fileMatches without repeating a path", () => {
		const details = textDetails(
			[
				{ path: "src/index.ts", count: 1 },
				{ path: "src/types.ts", count: 4 },
			],
			["src/index.ts"],
		);
		expect(collectMatchedPaths(details)).toEqual(["src/index.ts", "src/types.ts"]);
	});

	it("is empty for a result that reported no files and for absent details", () => {
		expect(collectMatchedPaths(fileDetails([]))).toEqual([]);
		expect(collectMatchedPaths(undefined)).toEqual([]);
	});
});

describe("a declared answer the search did not produce", () => {
	const matched = fileDetails(["src/index.ts", "src/types.ts"]);

	it("is satisfied when every clause holds", () => {
		const verdict = verifySearchExpectation(matched, {
			mustMatchPaths: ["src/index.ts"],
			mustNotMatchPaths: ["tests/engine.test.ts"],
			minMatchedPaths: 2,
			exactMatchedPaths: 2,
		});
		expect(verdict.satisfied).toBe(true);
		expect(verdict.failures).toEqual([]);
		expect(verdict.matchedPaths).toEqual(["src/index.ts", "src/types.ts"]);
	});

	it("names the required path that never matched, and what did", () => {
		const verdict = verifySearchExpectation(matched, { mustMatchPaths: ["src/core/engine.ts"] });
		expect(verdict.satisfied).toBe(false);
		expect(verdict.failures).toHaveLength(1);
		expect(verdict.failures[0].clause).toBe("mustMatchPaths");
		expect(verdict.failures[0].detail).toBe("never matched src/core/engine.ts (matched src/index.ts, src/types.ts)");
	});

	it("says nothing matched rather than listing an empty set", () => {
		const verdict = verifySearchExpectation(fileDetails([]), { mustMatchPaths: ["src/index.ts"] });
		expect(verdict.failures[0].detail).toBe("never matched src/index.ts (matched nothing)");
	});

	it("names the forbidden path that matched", () => {
		const verdict = verifySearchExpectation(matched, { mustNotMatchPaths: ["src/types.ts", "docs/api-guide.md"] });
		expect(verdict.satisfied).toBe(false);
		expect(verdict.failures[0].clause).toBe("mustNotMatchPaths");
		expect(verdict.failures[0].detail).toBe("matched src/types.ts, which it must not");
	});

	it("holds the lower bound at equality and fails one below it", () => {
		expect(verifySearchExpectation(matched, { minMatchedPaths: 2 }).satisfied).toBe(true);
		const short = verifySearchExpectation(matched, { minMatchedPaths: 3 });
		expect(short.satisfied).toBe(false);
		expect(short.failures[0].clause).toBe("minMatchedPaths");
		expect(short.failures[0].detail).toBe("matched 2 file(s), fewer than the 3 required");
	});

	it("fails an exact count in either direction, including a required zero", () => {
		const tooMany = verifySearchExpectation(matched, { exactMatchedPaths: 1 });
		expect(tooMany.failures[0].clause).toBe("exactMatchedPaths");
		expect(tooMany.failures[0].detail).toBe("matched 2 file(s), not the exact 1 required");
		expect(verifySearchExpectation(matched, { exactMatchedPaths: 3 }).satisfied).toBe(false);
		expect(verifySearchExpectation(matched, { exactMatchedPaths: 0 }).satisfied).toBe(false);
		expect(verifySearchExpectation(fileDetails([]), { exactMatchedPaths: 0 }).satisfied).toBe(true);
	});

	it("reports every violated clause, not the first", () => {
		const verdict = verifySearchExpectation(matched, {
			mustMatchPaths: ["src/core/engine.ts"],
			mustNotMatchPaths: ["src/index.ts"],
			minMatchedPaths: 9,
			exactMatchedPaths: 9,
		});
		expect(verdict.failures.map(failure => failure.clause)).toEqual([
			"mustMatchPaths",
			"mustNotMatchPaths",
			"minMatchedPaths",
			"exactMatchedPaths",
		]);
		expect(formatExpectationFailures(verdict.failures).split("; ")).toHaveLength(4);
	});

	it("is satisfied by an expectation that declares no clause, which is why a case may not ship one", () => {
		expect(verifySearchExpectation(fileDetails([]), {}).satisfied).toBe(true);
	});
});

describe("every registered case", () => {
	it("claims a file it must find or a count it must reach, so a new case cannot ship answerless", () => {
		registerBuiltinSearchBench();
		const suites = searchCaseSuites();
		expect(suites.length).toBeGreaterThan(1);

		// `mustNotMatchPaths` alone is satisfied by a search that returns nothing, so it is
		// not an answer on its own. Each case has to make one positive claim.
		const answerless: string[] = [];
		const ids: string[] = [];
		for (const suite of suites) {
			expect(suite.cases.length).toBeGreaterThan(0);
			// A suite naming a corpus nobody registered cannot have derived its answers.
			expect(() => requireSearchCorpus(suite.corpusId)).not.toThrow();
			for (const benchCase of suite.cases) {
				ids.push(`${suite.id}/${benchCase.id}`);
				const answer: SearchExpectation = benchCase.expect;
				if (
					(answer.mustMatchPaths ?? []).length === 0 &&
					answer.minMatchedPaths === undefined &&
					answer.exactMatchedPaths === undefined
				) {
					answerless.push(`${suite.id}/${benchCase.id}`);
				}
			}
		}
		expect(answerless).toEqual([]);
		expect(new Set(ids).size).toBe(ids.length);
	});
});

describe("the bench over every registered corpus", () => {
	it("produces the declared answer for every case of every suite and says so in the report", async () => {
		const report = await runSearchBench({ iterations: 1, filterType: "all", strictParity: true });

		expect(report.expectationsPassed).toBe(true);
		expect(report.totalExpectationFailures).toBe(0);
		// Every registered suite ran, not just the first one.
		expect(report.suites.map(suite => suite.caseSuiteId).sort()).toEqual([...searchCaseSuiteIds()].sort());
		expect(report.suites.length).toBeGreaterThan(1);

		const allCases = report.suites.flatMap(suite => suite.cases);
		expect(allCases.length).toBe(report.totalCases);
		expect(allCases.filter(c => !c.expectationSatisfied).map(c => c.id)).toEqual([]);
		for (const measurement of allCases) {
			expect(measurement.expectationFailureReason).toBeUndefined();
			expect(measurement.matchedPaths.every(p => p.length > 0)).toBe(true);
		}

		for (const suite of report.suites) {
			expect(suite.corpusFileCount).toBeGreaterThan(0);
			for (const summary of Object.values(suite.summaryByType)) {
				expect(summary.expectationPassedCases).toBe(summary.totalCases);
				expect(summary.expectationFailedCases).toBe(0);
			}
		}

		const text = formatSearchBenchReport(report);
		expect(text).toContain("Declared answers:   PASS");
		expect(text).toContain("Arm agreement:      PASS");
		expect(text).not.toContain("declared answer not produced");
	}, 180_000);

	it("finds the corpus files each search type is supposed to reach", async () => {
		const report = await runSearchBench({
			iterations: 1,
			caseSuiteIds: ["unified-search", "monorepo-scoping"],
			strictParity: true,
		});
		const byId = new Map(report.suites.flatMap(suite => suite.cases).map(c => [c.id, c]));

		// Anchored on the corpus contents, through the engines rather than by reading source.
		expect([...(byId.get("files_glob_recursive_ts")?.matchedPaths ?? [])].sort()).toEqual([
			"src/core/engine.ts",
			"src/index.ts",
			"src/types.ts",
			"src/utils/math.ts",
			"src/utils/string-helpers.ts",
		]);
		expect(byId.get("files_gitignore_respected")?.matchedPaths).toEqual([]);
		expect(byId.get("files_gitignore_bypassed")?.matchedPaths.length).toBe(2);
		expect(byId.get("text_case_sensitive_comment")?.matchedPaths).toEqual(["src/core/engine.ts"]);
		expect([...(byId.get("structure_function_declaration")?.matchedPaths ?? [])].sort()).toEqual([
			"src/core/engine.ts",
			"src/utils/math.ts",
			"src/utils/string-helpers.ts",
		]);
		// A structural pattern with no return-type slot matches no annotated function.
		expect(byId.get("structure_missing_return_annotation")?.matchedPaths).toEqual([]);

		// The second corpus exists to separate scoping from finding: an unscoped query reaches
		// both packages' same-named file, and the scoped one reaches exactly one.
		const unscoped = byId.get("monorepo_text_shared_identifier_unscoped")?.matchedPaths ?? [];
		const scoped = byId.get("monorepo_text_shared_identifier_scoped")?.matchedPaths ?? [];
		expect(unscoped.length).toBeGreaterThanOrEqual(2);
		expect(scoped.length).toBe(1);
		expect(unscoped).toEqual(expect.arrayContaining([...scoped]));
	}, 180_000);
});

describe("a case whose answer the search cannot produce", () => {
	it("throws under strict expectations and is reported without it", async () => {
		registerBuiltinSearchBench();
		const corpus = await materializeCorpus(requireSearchCorpus("typescript-project"));
		try {
			const session = createSearchBenchmarkSession(corpus.corpusDir);
			const arm = requireSearchArm("unified-tool");
			const prepared = [{ arm, runner: arm.prepare({ session, corpusDir: corpus.corpusDir }) }];
			const impossible = {
				id: "impossible_answer",
				type: "files" as const,
				description: "A glob whose declared answer names a file the corpus does not hold",
				input: { type: "files" as const, input: "src/**/*.ts" },
				expect: { mustMatchPaths: ["src/does-not-exist.ts"], exactMatchedPaths: 99 },
			};
			const options = {
				iterations: 1,
				caseSuiteId: "ad-hoc",
				corpusId: "typescript-project",
				referenceArmId: "unified-tool",
				strictParity: true,
			};

			await expect(
				measureSearchCase(impossible, prepared, { ...options, strictExpectations: true }),
			).rejects.toThrow(
				/Search expectation failure on case "impossible_answer" \(files\): mustMatchPaths: never matched src\/does-not-exist\.ts/,
			);

			const lenient = await measureSearchCase(impossible, prepared, { ...options, strictExpectations: false });
			expect(lenient.parityPassed).toBe(true);
			expect(lenient.expectationSatisfied).toBe(false);
			expect(lenient.expectationFailureReason).toContain("mustMatchPaths: never matched src/does-not-exist.ts");
			expect(lenient.expectationFailureReason).toContain("exactMatchedPaths: matched 5 file(s), not the exact 99");
			expect(lenient.matchedPaths.length).toBe(5);
		} finally {
			await corpus.cleanup();
		}
	}, 60_000);
});
