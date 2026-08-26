import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentToolResult } from "@veyyon/agent-core";
import type { FileSearchDetails } from "@veyyon/coding-agent/tools/file-search";
import type { SearchToolDetails } from "@veyyon/coding-agent/tools/search";
import {
	buildSearchBenchmarkCases,
	canonicalizeResultContent,
	createDeterministicSearchCorpus,
	formatBenchmarkSummary,
	runSearchParityBenchmark,
	SEARCH_BENCHMARK_LIMITATIONS,
	verifySearchParity,
} from "../../../src/suites/typescript-edit/search-parity-bench";

describe("search parity benchmark suite", () => {
	it("creates and cleans up the deterministic fixture corpus", async () => {
		const corpus = await createDeterministicSearchCorpus();
		try {
			expect(corpus.corpusDir.length).toBeGreaterThan(0);
			expect(corpus.fileCount).toBeGreaterThan(5);
			expect(corpus.totalBytes).toBeGreaterThan(100);

			const pkgJson = await fs.readFile(path.join(corpus.corpusDir, "package.json"), "utf8");
			expect(pkgJson).toContain("bench-corpus-fixture");

			const tsSource = await fs.readFile(path.join(corpus.corpusDir, "src", "index.ts"), "utf8");
			expect(tsSource).toContain("SearchPipeline");
		} finally {
			await corpus.cleanup();
			const existsAfter = await fs.stat(corpus.corpusDir).catch(() => null);
			expect(existsAfter).toBeNull();
		}
	});

	it("builds test cases covering all three search types", () => {
		const cases = buildSearchBenchmarkCases();
		expect(cases.length).toBeGreaterThan(10);

		const filesCases = cases.filter(c => c.type === "files");
		const textCases = cases.filter(c => c.type === "text");
		const structureCases = cases.filter(c => c.type === "structure");

		expect(filesCases.length).toBeGreaterThan(0);
		expect(textCases.length).toBeGreaterThan(0);
		expect(structureCases.length).toBeGreaterThan(0);

		for (const c of cases) {
			expect(c.input.type).toBe(c.type);
			expect(typeof c.input.input).toBe("string");
			expect(c.input.input.length).toBeGreaterThan(0);
		}
	});

	it("canonicalizes result text content across line ending variations", () => {
		const contentA = [{ type: "text" as const, text: "foo\r\nbar\r\n" }];
		const contentB = [{ type: "text" as const, text: "foo\nbar\n" }];

		expect(canonicalizeResultContent(contentA)).toBe(canonicalizeResultContent(contentB));
	});

	it("detects parity and catches mismatches in verifySearchParity", () => {
		const mockFileDetails: FileSearchDetails = {
			fileCount: 1,
			files: ["src/index.ts"],
			truncated: false,
		};

		const matchingStResult: AgentToolResult<SearchToolDetails> = {
			content: [{ type: "text", text: "src/index.ts" }],
			details: {
				type: "files",
				result: mockFileDetails,
			},
		};

		const matchingDeResult: AgentToolResult<FileSearchDetails> = {
			content: [{ type: "text", text: "src/index.ts" }],
			details: mockFileDetails,
		};

		const passCheck = verifySearchParity("files", matchingStResult, matchingDeResult);
		expect(passCheck.parity).toBe(true);
		expect(passCheck.error).toBeUndefined();

		// Content mismatch
		const mismatchedContentStResult: AgentToolResult<SearchToolDetails> = {
			content: [{ type: "text", text: "src/index.ts\nsrc/types.ts" }],
			details: {
				type: "files",
				result: mockFileDetails,
			},
		};
		const failContentCheck = verifySearchParity("files", mismatchedContentStResult, matchingDeResult);
		expect(failContentCheck.parity).toBe(false);
		expect(failContentCheck.error).toContain("Content mismatch");

		// Details type mismatch
		const mismatchedTypeStResult: AgentToolResult<SearchToolDetails> = {
			content: [{ type: "text", text: "src/index.ts" }],
			details: {
				type: "text",
				result: { matchCount: 1, files: ["src/index.ts"], truncated: false },
			},
		};
		const failTypeCheck = verifySearchParity("files", mismatchedTypeStResult, matchingDeResult);
		expect(failTypeCheck.parity).toBe(false);
		expect(failTypeCheck.error).toContain("details.type mismatch");

		// Details result payload mismatch
		const mismatchedPayloadStResult: AgentToolResult<SearchToolDetails> = {
			content: [{ type: "text", text: "src/index.ts" }],
			details: {
				type: "files",
				result: {
					fileCount: 99,
					files: ["different.ts"],
					truncated: true,
				},
			},
		};
		const failPayloadCheck = verifySearchParity("files", mismatchedPayloadStResult, matchingDeResult);
		expect(failPayloadCheck.parity).toBe(false);
		expect(failPayloadCheck.error).toContain("Details result mismatch");
	});

	it("runs the search parity benchmark across all cases with 100% exact parity", async () => {
		const report = await runSearchParityBenchmark({
			iterations: 1,
			filterType: "all",
			strictParity: true,
		});

		expect(report.parityPassed).toBe(true);
		expect(report.totalMismatches).toBe(0);
		expect(report.totalCases).toBeGreaterThan(15);
		expect(report.corpusFileCount).toBeGreaterThan(0);
		expect(report.corpusTotalBytes).toBeGreaterThan(0);

		for (const type of ["files", "text", "structure"] as const) {
			const summary = report.summaryByType[type];
			expect(summary.totalCases).toBeGreaterThan(0);
			expect(summary.parityPassedCases).toBe(summary.totalCases);
			expect(summary.parityFailedCases).toBe(0);
			expect(summary.avgSearchToolDurationMs).toBeGreaterThanOrEqual(0);
			expect(summary.avgDirectEngineDurationMs).toBeGreaterThanOrEqual(0);
			expect(summary.totalSearchToolBytes).toBeGreaterThan(0);
			expect(summary.totalDirectEngineBytes).toBeGreaterThan(0);
		}

		for (const c of report.cases) {
			expect(c.parityPassed).toBe(true);
			expect(c.outputBytesMatch).toBe(true);
			expect(c.searchTool.totalBytes).toBeGreaterThan(0);
			expect(c.directEngine.totalBytes).toBeGreaterThan(0);
		}

		expect(report.limitations).toEqual(SEARCH_BENCHMARK_LIMITATIONS);

		const summaryText = formatBenchmarkSummary(report);
		expect(summaryText).toContain("UNIFIED SEARCH PARITY & DISPATCH BENCHMARK REPORT");
		expect(summaryText).toContain("PASS (100% Exact Match)");
	});
});
