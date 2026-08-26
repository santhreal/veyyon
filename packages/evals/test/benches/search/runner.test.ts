import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentToolResult } from "@veyyon/agent-core";
import type { FileSearchDetails } from "@veyyon/coding-agent/tools/file-search";
import type { SearchToolDetails } from "@veyyon/coding-agent/tools/search";
import { materializeCorpus } from "../../../src/benches/search/corpus";
import {
	registerBuiltinSearchBench,
	requireSearchCaseSuite,
	requireSearchCorpus,
	searchArms,
	searchCaseSuites,
} from "../../../src/benches/search/registry";
import {
	canonicalizeResultContent,
	compareArmResult,
	formatSearchBenchReport,
	runSearchBench,
	SEARCH_BENCHMARK_LIMITATIONS,
} from "../../../src/benches/search/runner";

describe("the search bench corpus", () => {
	it("materializes a registered spec on disk and removes it again", async () => {
		registerBuiltinSearchBench();
		const spec = requireSearchCorpus("typescript-project");
		const corpus = await materializeCorpus(spec);
		try {
			expect(corpus.corpusId).toBe("typescript-project");
			expect(corpus.fileCount).toBe(Object.keys(spec.files).length);
			expect(corpus.totalBytes).toBeGreaterThan(100);

			// Every declared entry reached disk with its exact bytes, nested parents included.
			for (const [relPath, content] of Object.entries(spec.files)) {
				const written = await fs.readFile(path.join(corpus.corpusDir, relPath), "utf8");
				expect(written).toBe(content);
			}
		} finally {
			await corpus.cleanup();
			expect(await fs.stat(corpus.corpusDir).catch(() => null)).toBeNull();
		}
	});

	it("materializes the second corpus with its nesting and duplicate basenames intact", async () => {
		registerBuiltinSearchBench();
		const spec = requireSearchCorpus("monorepo");
		const corpus = await materializeCorpus(spec);
		try {
			const relPaths = Object.keys(spec.files);
			// The corpus exists to separate scoping from finding, so it has to carry at least one
			// basename that appears under more than one package.
			const basenames = relPaths.map(entry => path.basename(entry));
			const duplicated = basenames.filter((name, index) => basenames.indexOf(name) !== index);
			expect(duplicated.length).toBeGreaterThan(0);
			// And at least one path nested three levels below a package root.
			expect(relPaths.some(entry => entry.split("/").length >= 4)).toBe(true);

			for (const relPath of relPaths) {
				expect((await fs.stat(path.join(corpus.corpusDir, relPath))).isFile()).toBe(true);
			}
		} finally {
			await corpus.cleanup();
		}
	});
});

describe("every registered case suite", () => {
	it("declares a corpus that exists and cases whose input type matches their declared type", () => {
		registerBuiltinSearchBench();
		const suites = searchCaseSuites();
		expect(suites.length).toBeGreaterThan(1);

		for (const suite of suites) {
			expect(() => requireSearchCorpus(suite.corpusId)).not.toThrow();
			expect(suite.cases.length).toBeGreaterThan(0);
			for (const benchCase of suite.cases) {
				expect(benchCase.input.type).toBe(benchCase.type);
				expect(benchCase.input.input.length).toBeGreaterThan(0);
			}
		}

		// The shipped suite still covers all three representations.
		const unified = requireSearchCaseSuite("unified-search");
		for (const type of ["files", "text", "structure"] as const) {
			expect(unified.cases.filter(benchCase => benchCase.type === type).length).toBeGreaterThan(0);
		}
	});
});

describe("comparing one arm against the reference arm", () => {
	const fileDetails: FileSearchDetails = { fileCount: 1, files: ["src/index.ts"], truncated: false };
	const reference: AgentToolResult<SearchToolDetails> = {
		content: [{ type: "text", text: "src/index.ts" }],
		details: { type: "files", result: fileDetails },
	};
	const engineArm: AgentToolResult<FileSearchDetails> = {
		content: [{ type: "text", text: "src/index.ts" }],
		details: fileDetails,
	};

	it("accepts a wrapped and a bare details payload carrying the same bytes", () => {
		const verdict = compareArmResult("files", reference, engineArm);
		expect(verdict.matches).toBe(true);
		expect(verdict.error).toBeUndefined();
	});

	it("rejects differing content", () => {
		const verdict = compareArmResult("files", reference, {
			content: [{ type: "text", text: "src/index.ts\nsrc/types.ts" }],
			details: fileDetails,
		});
		expect(verdict.matches).toBe(false);
		expect(verdict.error).toContain("Content mismatch");
	});

	it("rejects an arm that declares another result type", () => {
		const verdict = compareArmResult("files", reference, {
			content: [{ type: "text", text: "src/index.ts" }],
			details: { type: "text", result: { matchCount: 1, files: ["src/index.ts"], truncated: false } },
		});
		expect(verdict.matches).toBe(false);
		expect(verdict.error).toContain("details.type mismatch");
	});

	it("rejects a differing payload behind identical content", () => {
		const verdict = compareArmResult("files", reference, {
			content: [{ type: "text", text: "src/index.ts" }],
			details: { fileCount: 99, files: ["different.ts"], truncated: true },
		});
		expect(verdict.matches).toBe(false);
		expect(verdict.error).toContain("Details payload differs");
	});

	it("rejects an arm that returned no details at all", () => {
		const verdict = compareArmResult("files", reference, { content: [{ type: "text", text: "src/index.ts" }] });
		expect(verdict.matches).toBe(false);
		expect(verdict.error).toContain("undefined details");
	});

	it("canonicalizes content across line-ending variations", () => {
		expect(canonicalizeResultContent([{ type: "text", text: "foo\r\nbar\r\n" }])).toBe(
			canonicalizeResultContent([{ type: "text", text: "foo\nbar\n" }]),
		);
	});
});

describe("a run over every registered axis", () => {
	it("measures every arm on every case of every suite and reports them all agreeing", async () => {
		registerBuiltinSearchBench();
		const armIds = searchArms().map(arm => arm.id);
		expect(armIds.length).toBeGreaterThan(1);

		const report = await runSearchBench({ iterations: 1, filterType: "all", strictParity: true });

		expect(report.parityPassed).toBe(true);
		expect(report.totalMismatches).toBe(0);
		expect(report.armIds).toEqual(armIds);
		expect(report.referenceArmId).toBe("unified-tool");
		expect(report.limitations).toEqual(SEARCH_BENCHMARK_LIMITATIONS);

		for (const suite of report.suites) {
			expect(suite.armIds).toEqual(armIds);
			for (const measurement of suite.cases) {
				expect(measurement.parityPassed).toBe(true);
				expect(measurement.mismatchReason).toBeUndefined();
				// One measurement per arm, reference first, each one actually timed.
				expect(measurement.arms.map(arm => arm.armId)).toEqual([
					"unified-tool",
					...armIds.filter(id => id !== "unified-tool"),
				]);
				for (const arm of measurement.arms) {
					expect(arm.matchesReference).toBe(true);
					expect(arm.totalBytes).toBe(arm.contentBytes + arm.detailsBytes);
					expect(arm.meanDurationMs).toBeGreaterThanOrEqual(0);
					expect(arm.minDurationMs).toBeLessThanOrEqual(arm.maxDurationMs);
				}
				const referenceArm = measurement.arms.find(arm => arm.armId === measurement.referenceArmId);
				expect(referenceArm?.overheadVsReferenceMs).toBe(0);
			}
			expect(suite.totalCases).toBe(suite.cases.length);
		}

		const text = formatSearchBenchReport(report);
		expect(text).toContain("OFFLINE UNIFIED SEARCH BENCH");
		for (const armId of armIds) expect(text).toContain(armId);
		expect(text).not.toContain("arms disagree");
	}, 180_000);

	it("runs one named suite with one named arm when a run selects them", async () => {
		registerBuiltinSearchBench();
		const report = await runSearchBench({
			iterations: 1,
			caseSuiteIds: ["monorepo-scoping"],
			armIds: ["direct-engine"],
			referenceArmId: "direct-engine",
			filterType: "files",
			strictParity: true,
		});

		expect(report.suites.map(suite => suite.caseSuiteId)).toEqual(["monorepo-scoping"]);
		expect(report.armIds).toEqual(["direct-engine"]);
		expect(report.referenceArmId).toBe("direct-engine");
		expect(report.totalCases).toBeGreaterThan(0);
		// The type filter is honoured, so a selective run is cheap rather than a full run.
		for (const measurement of report.suites[0].cases) expect(measurement.type).toBe("files");
		expect(report.suites[0].summaryByType.text.totalCases).toBe(0);
	}, 120_000);

	it("refuses a run whose reference arm is not among the arms it measures", async () => {
		registerBuiltinSearchBench();
		await expect(
			runSearchBench({ iterations: 1, armIds: ["direct-engine"], referenceArmId: "unified-tool" }),
		).rejects.toThrow(/Reference arm "unified-tool" is not among the arms this run measures \(direct-engine\)/);
	});
});
