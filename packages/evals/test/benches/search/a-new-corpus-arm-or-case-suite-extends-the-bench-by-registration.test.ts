import { describe, expect, it } from "bun:test";
import { type SearchArm, UNIFIED_TOOL_ARM } from "../../../src/benches/search/arms";
import type { SearchCaseSuite } from "../../../src/benches/search/cases";
import type { SearchCorpusSpec } from "../../../src/benches/search/corpus";
import {
	DuplicateSearchBenchMemberError,
	registerBuiltinSearchBench,
	registerSearchArm,
	registerSearchCaseSuite,
	registerSearchCorpus,
	requireSearchArm,
	requireSearchCaseSuite,
	requireSearchCorpus,
	searchArmIds,
	searchArms,
	searchCaseSuiteIds,
	searchCaseSuites,
	searchCorpora,
	searchCorpusIds,
} from "../../../src/benches/search/registry";
import {
	collectSearchBenchmarkLimitations,
	runSearchBench,
	runSearchCaseSuite,
} from "../../../src/benches/search/runner";

/**
 * WHY: the bench used to carry one corpus, one literal case list and exactly two arms named
 * inline in the runner, so extending it along any axis meant editing the runner — the defect
 * class being a measurement harness that can only measure what its author already wrote
 * down. Each axis is now a registration, and this suite proves the runner consumes the
 * registry rather than a hardcoded set: a corpus, a case suite and an arm defined entirely
 * here, registered at run time, are measured end to end with no change to any shipped module.
 *
 * It also proves the comparison is a real comparison. An arm that returns the same text with
 * a different payload has to be reported as disagreeing, named, and has to stop a strict run.
 *
 * Not covered: an arm that reaches a remote service, and the cost of preparing a stateful arm
 * (`dispose` is exercised, its timing is not).
 */

const TEST_CORPUS: SearchCorpusSpec = {
	id: "test-only-two-package",
	description: "Two annotated modules and one document, for registry coverage.",
	files: {
		"alpha.ts": "export function alpha(): number {\n\treturn 1;\n}\n",
		"nested/beta.ts": "export function beta(): number {\n\treturn 2;\n}\n",
		"notes.md": "alpha and beta are both exported\n",
	},
	limitations: ["Test-only corpus exercises custom limitation propagation into the reported union."],
};

const TEST_SUITE: SearchCaseSuite = {
	id: "test-only-registry-coverage",
	description: "Cases over the registry-coverage corpus.",
	corpusId: TEST_CORPUS.id,
	cases: [
		{
			id: "test_only_files_ts",
			type: "files",
			description: "Both TypeScript modules, and not the document",
			input: { type: "files", input: "**/*.ts" },
			expect: {
				mustMatchPaths: ["alpha.ts", "nested/beta.ts"],
				mustNotMatchPaths: ["notes.md"],
				exactMatchedPaths: 2,
			},
		},
		{
			id: "test_only_text_identifier",
			type: "text",
			description: "An identifier that appears in a module and in prose",
			input: { type: "text", input: "beta" },
			expect: { mustMatchPaths: ["nested/beta.ts", "notes.md"], minMatchedPaths: 2 },
		},
		{
			id: "test_only_structure_annotated",
			type: "structure",
			description: "Annotated exported functions in both modules",
			input: { type: "structure", input: "function $NAME($$$): $_ { $$$ }", path: "**/*.ts" },
			expect: { mustMatchPaths: ["alpha.ts", "nested/beta.ts"], minMatchedPaths: 2 },
		},
	],
};

/** Agrees with the reference arm by construction: it is the reference arm. */
const PASSTHROUGH_ARM: SearchArm = {
	id: "test-only-passthrough",
	description: "The unified tool reached through a wrapper, to prove a third arm is measurable.",
	prepare(context) {
		const inner = UNIFIED_TOOL_ARM.prepare(context);
		let disposed = false;
		return {
			run: (callId, input, signal) => inner.run(callId, input, signal),
			dispose: async () => {
				disposed = true;
				disposals.push(disposed);
			},
		};
	},
};

const disposals: boolean[] = [];

/** Same text, one file removed from the payload: a disagreement content alone cannot show. */
const DROPPING_ARM: SearchArm = {
	id: "test-only-dropping",
	description: "Returns the reference text with one file removed from the details payload.",
	prepare(context) {
		const inner = UNIFIED_TOOL_ARM.prepare(context);
		return {
			run: async (callId, input, signal) => {
				const result = await inner.run(callId, input, signal);
				const details = result.details;
				if (details && "type" in details && details.type === "files" && details.result.files) {
					return {
						...result,
						details: { type: "files", result: { ...details.result, files: details.result.files.slice(1) } },
					};
				}
				return result;
			},
		};
	},
};

describe("a lookup for something nobody registered", () => {
	it("refuses and names the axis and the registered members", () => {
		registerBuiltinSearchBench();

		expect(() => requireSearchCorpus("nope")).toThrow(
			`Unknown search bench corpus "nope". Registered corpora: ${searchCorpusIds().join(", ")}`,
		);
		expect(() => requireSearchCaseSuite("nope")).toThrow(/Unknown search bench case suite "nope"/);
		expect(() => requireSearchArm("nope")).toThrow(/Unknown search bench arm "nope"/);
	});

	it("treats re-registering the same member as a no-op and a different one as a collision", () => {
		registerBuiltinSearchBench();
		const before = searchArmIds().length;
		registerBuiltinSearchBench();
		expect(searchArmIds().length).toBe(before);

		expect(() =>
			registerSearchArm({ id: "unified-tool", description: "impostor", prepare: UNIFIED_TOOL_ARM.prepare }),
		).toThrow(DuplicateSearchBenchMemberError);
	});

	it("refuses duplicate registrations on any axis with a message naming the registered ids", () => {
		registerBuiltinSearchBench();

		const corpusIds = searchCorpusIds();
		expect(() =>
			registerSearchCorpus({
				id: "typescript-project",
				description: "impostor",
				files: {},
			}),
		).toThrowError(
			`A different search bench corpus is already registered as "typescript-project". Registered corpora: ${corpusIds.join(", ")}`,
		);

		const armIds = searchArmIds();
		expect(() =>
			registerSearchArm({
				id: "unified-tool",
				description: "impostor",
				prepare: UNIFIED_TOOL_ARM.prepare,
			}),
		).toThrowError(
			`A different search bench arm is already registered as "unified-tool". Registered arms: ${armIds.join(", ")}`,
		);

		const suiteIds = searchCaseSuiteIds();
		expect(() =>
			registerSearchCaseSuite({
				id: "unified-search",
				description: "impostor",
				corpusId: "typescript-project",
				cases: [],
			}),
		).toThrowError(
			`A different search bench case suite is already registered as "unified-search". Registered case suites: ${suiteIds.join(", ")}`,
		);
	});
});

describe("a corpus, a case suite and an arm defined outside the package", () => {
	it("is measured end to end once registered, with no change to the runner", async () => {
		registerBuiltinSearchBench();
		registerSearchCorpus(TEST_CORPUS);
		registerSearchCaseSuite(TEST_SUITE);
		registerSearchArm(PASSTHROUGH_ARM);

		// Registration is what a default run reads, so the new members are in scope for one.
		expect(searchCorpusIds()).toContain(TEST_CORPUS.id);
		expect(searchCaseSuiteIds()).toContain(TEST_SUITE.id);
		expect(searchArmIds()).toContain(PASSTHROUGH_ARM.id);

		const report = await runSearchBench({
			iterations: 1,
			caseSuiteIds: [TEST_SUITE.id],
			armIds: ["unified-tool", PASSTHROUGH_ARM.id],
			strictParity: true,
			strictExpectations: true,
		});

		expect(report.suites).toHaveLength(1);
		const suite = report.suites[0];
		expect(suite.caseSuiteId).toBe(TEST_SUITE.id);
		expect(suite.corpusId).toBe(TEST_CORPUS.id);
		expect(suite.corpusFileCount).toBe(3);
		expect(suite.totalCases).toBe(3);
		expect(suite.parityPassed).toBe(true);
		expect(suite.expectationsPassed).toBe(true);
		expect(suite.cases.map(measurement => measurement.id)).toEqual([
			"test_only_files_ts",
			"test_only_text_identifier",
			"test_only_structure_annotated",
		]);
		for (const measurement of suite.cases) {
			expect(measurement.arms.map(arm => arm.armId)).toEqual(["unified-tool", PASSTHROUGH_ARM.id]);
			expect(measurement.expectationSatisfied).toBe(true);
		}
		// The third arm's per-corpus state was released rather than leaked.
		expect(disposals.length).toBeGreaterThan(0);

		// Registered corpus limitations propagate into the reported limitations union.
		expect(report.limitations).toContain(
			"Test-only corpus exercises custom limitation propagation into the reported union.",
		);
		expect(collectSearchBenchmarkLimitations()).toContain(
			"Test-only corpus exercises custom limitation propagation into the reported union.",
		);
	}, 120_000);
});

describe("an arm that answers differently from the reference arm", () => {
	it("is reported as disagreeing by name, and stops a strict run", async () => {
		registerBuiltinSearchBench();
		registerSearchCorpus(TEST_CORPUS);
		const filesOnly = { ...TEST_SUITE, cases: TEST_SUITE.cases.filter(c => c.type === "files") };
		const arms = [UNIFIED_TOOL_ARM, DROPPING_ARM];

		const lenient = await runSearchCaseSuite(filesOnly, arms, {
			iterations: 1,
			strictParity: false,
			strictExpectations: true,
		});
		expect(lenient.parityPassed).toBe(false);
		expect(lenient.totalMismatches).toBe(1);
		const measurement = lenient.cases[0];
		expect(measurement.mismatchReason).toContain("test-only-dropping");
		expect(measurement.mismatchReason).toContain("Details payload differs");
		// The reference arm is still correct, so the declared answer holds while arms disagree.
		expect(measurement.expectationSatisfied).toBe(true);
		const dropping = measurement.arms.find(arm => arm.armId === DROPPING_ARM.id);
		expect(dropping?.matchesReference).toBe(false);
		expect(measurement.arms.find(arm => arm.armId === "unified-tool")?.matchesReference).toBe(true);

		await expect(runSearchCaseSuite(filesOnly, arms, { iterations: 1, strictParity: true })).rejects.toThrow(
			/Search arm disagreement on case "test_only_files_ts" \(files\): test-only-dropping/,
		);
	}, 120_000);
});

describe("the disclosure corpus and runtime registry enumeration", () => {
	it("reaches the disclosure corpus through the same registry as the other corpora", () => {
		registerBuiltinSearchBench();

		const registeredCorpora = searchCorpora();
		const registeredCorpusIds = searchCorpusIds();
		const registeredSuites = searchCaseSuites();
		const registeredSuiteIds = searchCaseSuiteIds();
		const registeredArms = searchArms();
		const registeredArmIds = searchArmIds();

		expect(registeredCorpusIds).toContain("disclosure");
		expect(registeredCorpora.some(corpus => corpus.id === "disclosure")).toBe(true);
		expect(registeredSuiteIds).toContain("disclosure");
		expect(registeredSuites.some(suite => suite.id === "disclosure")).toBe(true);

		const disclosureCorpus = requireSearchCorpus("disclosure");
		expect(disclosureCorpus.id).toBe("disclosure");
		expect(Object.keys(disclosureCorpus.files).length).toBe(20);
		expect(disclosureCorpus.limitations?.length).toBeGreaterThan(0);

		const disclosureSuite = requireSearchCaseSuite("disclosure");
		expect(disclosureSuite.id).toBe("disclosure");
		expect(disclosureSuite.corpusId).toBe("disclosure");
		expect(disclosureSuite.cases.length).toBeGreaterThan(0);

		// Runtime enumeration covers every registered member on every axis.
		expect(registeredCorpusIds).toEqual(registeredCorpora.map(corpus => corpus.id));
		expect(registeredSuiteIds).toEqual(registeredSuites.map(suite => suite.id));
		expect(registeredArmIds).toEqual(registeredArms.map(arm => arm.id));
	});
});
