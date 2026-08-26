/**
 * Unified Search Parity & Dispatch Benchmark.
 *
 * Compares the first-class unified `SearchTool` against direct execution of
 * production internal search engines (`executeFileSearch`, `executeTextSearch`,
 * `executeStructureSearch`) over a deterministic local fixture corpus.
 *
 * This benchmark:
 * 1. Proves exact result parity between `SearchTool` and direct engine calls
 *    for all three search representations (`files`, `text`, `structure`).
 * 2. Compares canonicalized result content and details `{ type, result }`.
 * 3. Measures real execution timing and output payload bytes per arm.
 * 4. Consumes zero provider quota (runs 100% offline on a deterministic local corpus).
 * 5. Makes no synthetic historical baseline claims; compares the production tool
 *    facade against the same current production internal engines.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import type { AgentToolResult } from "@veyyon/agent-core";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { executeFileSearch, type FileSearchDetails } from "@veyyon/coding-agent/tools/file-search";
import {
	SearchTool,
	type SearchToolDetails,
	type SearchToolInput,
	type SearchType,
} from "@veyyon/coding-agent/tools/search";
import { executeStructureSearch, type StructureSearchDetails } from "@veyyon/coding-agent/tools/structure-search";
import { executeTextSearch, type TextSearchDetails } from "@veyyon/coding-agent/tools/text-search";
import { errorMessage } from "@veyyon/utils";
import { internalScratchDir } from "../../paths";
import { formatExpectationFailures, type SearchExpectation, verifySearchExpectation } from "./expectations";

export interface SearchBenchmarkCase {
	id: string;
	type: SearchType;
	description: string;
	input: SearchToolInput;
	/** The answer the corpus has for this query. Required: see `expectations.ts`. */
	expect: SearchExpectation;
}

export interface SearchArmMeasurement {
	meanDurationMs: number;
	minDurationMs: number;
	maxDurationMs: number;
	contentBytes: number;
	detailsBytes: number;
	totalBytes: number;
}

export interface SearchCaseMeasurement {
	id: string;
	type: SearchType;
	description: string;
	parityPassed: boolean;
	mismatchReason?: string;
	/** The search produced the answer the corpus has for this query. */
	expectationSatisfied: boolean;
	/** Every violated clause, one phrase each. Absent when satisfied. */
	expectationFailureReason?: string;
	/** The files the search reported, which the verdict was formed from. */
	matchedPaths: readonly string[];
	searchTool: SearchArmMeasurement;
	directEngine: SearchArmMeasurement;
	dispatchOverheadMs: number;
	outputBytesMatch: boolean;
}

export interface SearchTypeSummary {
	type: SearchType;
	totalCases: number;
	parityPassedCases: number;
	parityFailedCases: number;
	expectationPassedCases: number;
	expectationFailedCases: number;
	avgSearchToolDurationMs: number;
	avgDirectEngineDurationMs: number;
	avgDispatchOverheadMs: number;
	totalSearchToolBytes: number;
	totalDirectEngineBytes: number;
}

export interface SearchBenchmarkReport {
	timestamp: string;
	iterationsPerCase: number;
	corpusFileCount: number;
	corpusTotalBytes: number;
	totalCases: number;
	parityPassed: boolean;
	totalMismatches: number;
	/** Every case produced the answer the corpus has for it. */
	expectationsPassed: boolean;
	totalExpectationFailures: number;
	summaryByType: Record<SearchType, SearchTypeSummary>;
	cases: SearchCaseMeasurement[];
	limitations: string[];
}

export interface SearchBenchmarkOptions {
	iterations?: number;
	filterType?: SearchType | "all";
	strictParity?: boolean;
	/** Throw on the first case whose declared answer the search did not produce. */
	strictExpectations?: boolean;
	corpusBaseDir?: string;
}

/** Known limitations of this benchmark artifact. */
export const SEARCH_BENCHMARK_LIMITATIONS: string[] = [
	"Measures local in-process dispatch, result-envelope, and execution overhead on a deterministic synthetic corpus; direct calls to SearchTool.execute do not measure provider schema validation, remote filesystems, or SSH targets.",
	"Structural queries rely on local ast-grep native parser support and are benchmarked on TypeScript/JavaScript source files.",
	"Does not evaluate model-side tool-selection accuracy, token prompt efficiency, or remote provider latency because the benchmark runs 100% offline with zero provider quota.",
	"Direct engine baseline uses current production engine functions (executeFileSearch, executeTextSearch, executeStructureSearch) directly without tool schema validation; no historical or synthetic legacy numbers are claimed.",
];

/** Create an isolated test ToolSession bound to a specific working directory. */
export function createSearchBenchmarkSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
	};
}

/** Populate a rich deterministic fixture corpus for all three search representations. */
export async function createDeterministicSearchCorpus(
	baseDir?: string,
): Promise<{ corpusDir: string; fileCount: number; totalBytes: number; cleanup: () => Promise<void> }> {
	const parent = baseDir ?? internalScratchDir();
	await fs.mkdir(parent, { recursive: true });
	const root = await fs.mkdtemp(path.join(parent, "unified-search-bench-corpus-"));

	const corpusFiles: Record<string, string> = {
		"package.json": JSON.stringify(
			{
				name: "bench-corpus-fixture",
				version: "1.0.0",
				private: true,
				description: "Deterministic fixture corpus for search parity benchmarks",
				main: "src/index.ts",
				dependencies: {
					typescript: "^5.4.0",
				},
			},
			null,
			2,
		),
		"tsconfig.json": JSON.stringify(
			{
				compilerOptions: {
					target: "ESNext",
					module: "ESNext",
					moduleResolution: "bundler",
					strict: true,
				},
				include: ["src/**/*", "tests/**/*"],
			},
			null,
			2,
		),
		".gitignore": `${["node_modules/", "ignored/", "*.tmp", "*.log", ".env.local"].join("\n")}\n`,
		".env.example": "API_KEY=example_key_here\nDATABASE_URL=postgres://localhost:5432/bench\n",
		".hidden/config.json": JSON.stringify({ hiddenConfig: true, secretMode: "enabled" }, null, 2),
		".hidden/credentials.txt": "oauth_token=sample_deterministic_token_12345\n",
		"ignored/cache.tmp": "TEMPORARY_CACHE_DATA_DO_NOT_INDEX\n",
		"ignored/build.log": "[2026-08-22 10:00:00] Build started\n[2026-08-22 10:00:05] Build complete\n",
		"docs/overview.md": `# Unified Search Overview

Unified search provides first-class discovery across three representations:
- \`files\`: Path and repository layout matching.
- \`text\`: Syntax-irrelevant literal and regex content matching.
- \`structure\`: AST-aware code relationship matching.

## Architecture Guidelines
Always prefer structural search when code relationships matter.
`,
		"docs/api-guide.md": `# API Guide

## Search Options
- Use \`limit\` to constrain file counts.
- Use \`case\` for case-sensitive text matching.
- Use \`skip\` for pagination across text and structural results.
`,
		"src/types.ts": `export interface SearchQuery {
	type: "files" | "text" | "structure";
	input: string;
	path?: string;
	case?: boolean;
	hidden?: boolean;
	gitignore?: boolean;
	limit?: number;
	skip?: number;
}

export interface SearchResultItem {
	path: string;
	lineNumber?: number;
	matchedText?: string;
}

export interface EngineStats {
	totalSearched: number;
	matchedCount: number;
	durationMs: number;
}
`,
		"src/index.ts": `import { SearchQuery, SearchResultItem, EngineStats } from "./types";
import { processSearchTask, formatSearchOutput } from "./core/engine";
import { calculateMean, calculateStdDev } from "./utils/math";
import { capitalize, truncateString } from "./utils/string-helpers";

export class SearchPipeline {
	#stats: EngineStats = { totalSearched: 0, matchedCount: 0, durationMs: 0 };

	execute(query: SearchQuery): SearchResultItem[] {
		console.log("Executing search query:", query.type);
		const results = processSearchTask(query);
		this.#stats.totalSearched += 1;
		this.#stats.matchedCount += results.length;
		return results;
	}

	getStats(): EngineStats {
		return { ...this.#stats };
	}
}

export { processSearchTask, formatSearchOutput, calculateMean, calculateStdDev, capitalize, truncateString };
`,
		"src/core/engine.ts": `import { SearchQuery, SearchResultItem } from "../types";

export function processSearchTask(query: SearchQuery): SearchResultItem[] {
	// TODO: Add support for advanced boolean expressions in input
	// FIXME: Handle rare multi-byte encoding edge cases gracefully
	const items: SearchResultItem[] = [];
	if (!query.input) {
		return items;
	}

	console.log("Processing task for type:", query.type);
	items.push({
		path: "src/index.ts",
		lineNumber: 10,
		matchedText: query.input,
	});

	return items;
}

export function formatSearchOutput(items: SearchResultItem[]): string {
	console.log("Formatting items count:", items.length);
	return items.map(item => \`\${item.path}:\${item.lineNumber ?? 0}: \${item.matchedText ?? ""}\`).join("\\n");
}
`,
		"src/utils/math.ts": `export function calculateMean(values: number[]): number {
	if (values.length === 0) return 0;
	const sum = values.reduce((acc, val) => acc + val, 0);
	return sum / values.length;
}

export function calculateStdDev(values: number[]): number {
	if (values.length <= 1) return 0;
	const mean = calculateMean(values);
	const squaredDiffs = values.map(val => Math.pow(val - mean, 2));
	const variance = calculateMean(squaredDiffs);
	return Math.sqrt(variance);
}
`,
		"src/utils/string-helpers.ts": `export function capitalize(str: string): string {
	if (!str) return "";
	return str.charAt(0).toUpperCase() + str.slice(1);
}

export function truncateString(str: string, maxLength: number): string {
	if (str.length <= maxLength) return str;
	return str.slice(0, Math.max(0, maxLength - 3)) + "...";
}

export function countOccurrences(haystack: string, needle: string): number {
	if (!needle) return 0;
	return haystack.split(needle).length - 1;
}
`,
		"src/components/SearchHeader.tsx": `export function SearchHeader(props: { title: string; count: number }) {
	console.log("Rendering header with title:", props.title);
	return (
		<header className="search-header">
			<h1>{props.title}</h1>
			<span className="count-badge">{props.count} matches</span>
		</header>
	);
}
`,
		"src/components/SearchResultList.tsx": `export function SearchResultList(props: { items: string[] }) {
	console.log("Rendering results list:", props.items.length);
	return (
		<ul className="results-list">
			{props.items.map((item, index) => (
				<li key={index} className="result-row">{item}</li>
			))}
		</ul>
	);
}
`,
		"tests/engine.test.ts": `import { processSearchTask, formatSearchOutput } from "../src/core/engine";

export function runEngineTests() {
	console.log("Running engine test suite");
	const results = processSearchTask({ type: "text", input: "needle" });
	if (results.length === 0) {
		throw new Error("Expected at least one result");
	}
	const output = formatSearchOutput(results);
	if (!output.includes("src/index.ts")) {
		throw new Error("Expected formatted output to contain index path");
	}
}
`,
		"tests/utils.test.ts": `import { calculateMean, calculateStdDev } from "../src/utils/math";
import { capitalize, truncateString } from "../src/utils/string-helpers";

export function runUtilsTests() {
	console.log("Running utils test suite");
	const mean = calculateMean([10, 20, 30]);
	if (mean !== 20) throw new Error("Mean calculation failed");
	const cap = capitalize("search");
	if (cap !== "Search") throw new Error("Capitalize failed");
}
`,
	};

	let fileCount = 0;
	let totalBytes = 0;

	for (const [relPath, content] of Object.entries(corpusFiles)) {
		const fullPath = path.join(root, relPath);
		await fs.mkdir(path.dirname(fullPath), { recursive: true });
		await fs.writeFile(fullPath, content, "utf8");
		fileCount += 1;
		totalBytes += Buffer.byteLength(content, "utf8");
	}

	return {
		corpusDir: root,
		fileCount,
		totalBytes,
		cleanup: async () => {
			await fs.rm(root, { recursive: true, force: true });
		},
	};
}

/**
 * Build the benchmark cases: one query per capability, each declaring the answer the
 * deterministic corpus has for it.
 *
 * `expect` is required rather than optional, so a case added without a declared answer
 * does not compile. Parity alone cannot catch an engine that stops finding things,
 * because both arms call the same engine.
 */
export function buildSearchBenchmarkCases(): SearchBenchmarkCase[] {
	return [
		// Files search cases
		{
			id: "files_glob_recursive_ts",
			type: "files",
			description: "Find all TypeScript source files recursively",
			input: { type: "files", input: "src/**/*.ts" },
			expect: {
				mustMatchPaths: [
					"src/types.ts",
					"src/index.ts",
					"src/core/engine.ts",
					"src/utils/math.ts",
					"src/utils/string-helpers.ts",
				],
				// `.tsx` is not `.ts`, and `tests/` is not `src/`.
				mustNotMatchPaths: ["src/components/SearchHeader.tsx", "tests/engine.test.ts"],
			},
		},
		{
			id: "files_glob_semicolon_multi",
			type: "files",
			description: "Find files matching multiple semicolon-delimited scopes",
			input: { type: "files", input: "src/**/*.ts; docs/*.md" },
			expect: {
				mustMatchPaths: ["src/types.ts", "src/core/engine.ts", "docs/overview.md", "docs/api-guide.md"],
			},
		},
		{
			id: "files_glob_json_all",
			type: "files",
			description: "Find all JSON configuration files",
			input: { type: "files", input: "**/*.json" },
			expect: { mustMatchPaths: ["package.json", "tsconfig.json"] },
		},
		{
			id: "files_exact_single_file",
			type: "files",
			description: "Locate a specific single file by relative path",
			input: { type: "files", input: "src/index.ts" },
			expect: { mustMatchPaths: ["src/index.ts"], exactMatchedPaths: 1 },
		},
		{
			id: "files_glob_with_limit",
			type: "files",
			description: "Constrain file search results with limit",
			input: { type: "files", input: "src/**/*.ts", limit: 2 },
			// The cap is the contract; which two files survive it is mtime order.
			expect: { exactMatchedPaths: 2 },
		},
		{
			id: "files_hidden_included",
			type: "files",
			description: "Search hidden directories with hidden=true",
			input: { type: "files", input: ".hidden/*", hidden: true },
			expect: { mustMatchPaths: [".hidden/config.json", ".hidden/credentials.txt"] },
		},
		{
			id: "files_gitignore_respected",
			type: "files",
			description: "Respect .gitignore rules with gitignore=true",
			input: { type: "files", input: "ignored/*", gitignore: true },
			expect: { mustNotMatchPaths: ["ignored/cache.tmp", "ignored/build.log"], exactMatchedPaths: 0 },
		},
		{
			id: "files_gitignore_bypassed",
			type: "files",
			description: "Bypass .gitignore rules with gitignore=false",
			input: { type: "files", input: "ignored/*", gitignore: false },
			expect: { mustMatchPaths: ["ignored/cache.tmp", "ignored/build.log"] },
		},

		// Text search cases
		{
			id: "text_literal_identifier",
			type: "text",
			description: "Find exact literal interface identifier in src",
			input: { type: "text", input: "SearchQuery", path: "src" },
			expect: { mustMatchPaths: ["src/types.ts", "src/index.ts", "src/core/engine.ts"] },
		},
		{
			id: "text_regex_exports",
			type: "text",
			description: "Match regex export declarations in src",
			input: { type: "text", input: "export (function|class)", path: "src" },
			expect: {
				mustMatchPaths: [
					"src/index.ts",
					"src/core/engine.ts",
					"src/utils/math.ts",
					"src/utils/string-helpers.ts",
					"src/components/SearchHeader.tsx",
				],
			},
		},
		{
			id: "text_case_sensitive_comment",
			type: "text",
			description: "Case-sensitive search for uppercase TODO marker",
			input: { type: "text", input: "TODO", path: "src", case: true },
			expect: { mustMatchPaths: ["src/core/engine.ts"], exactMatchedPaths: 1 },
		},
		{
			id: "text_case_insensitive_comment",
			type: "text",
			description: "Case-insensitive search for todo marker",
			input: { type: "text", input: "todo", path: "src", case: false },
			expect: { mustMatchPaths: ["src/core/engine.ts"] },
		},
		{
			id: "text_scoped_directory",
			type: "text",
			description: "Scoped search inside utils directory",
			input: { type: "text", input: "calculate", path: "src/utils" },
			// `calculateMean` is imported in src/index.ts too; the scope has to exclude it.
			expect: { mustMatchPaths: ["src/utils/math.ts"], mustNotMatchPaths: ["src/index.ts"] },
		},
		{
			id: "text_semicolon_delimited_scopes",
			type: "text",
			description: "Search across multiple semicolon-delimited directory scopes",
			input: { type: "text", input: "test", path: "src; tests" },
			expect: { mustMatchPaths: ["tests/engine.test.ts", "tests/utils.test.ts"] },
		},
		{
			id: "text_gitignore_respected",
			type: "text",
			description: "Respected gitignore hides ignored temporary cache marker",
			input: { type: "text", input: "TEMPORARY_CACHE", path: ".", gitignore: true },
			expect: { mustNotMatchPaths: ["ignored/cache.tmp"], exactMatchedPaths: 0 },
		},
		{
			id: "text_gitignore_bypassed",
			type: "text",
			description: "Bypassed gitignore surfaces ignored temporary cache marker",
			input: { type: "text", input: "TEMPORARY_CACHE", path: ".", gitignore: false },
			expect: { mustMatchPaths: ["ignored/cache.tmp"] },
		},
		{
			id: "text_pagination_skip",
			type: "text",
			description: "Paginate text search results using skip",
			input: { type: "text", input: "return", path: "src", skip: 2 },
			// A later page still has to carry files; an empty page two means the window
			// collapsed rather than advanced.
			expect: { minMatchedPaths: 1 },
		},

		// Structure search cases
		{
			id: "structure_call_expression",
			type: "structure",
			description: "Structural match for console.log calls with arbitrary arguments",
			input: { type: "structure", input: "console.log($$$)", path: "src/**/*.ts" },
			expect: {
				mustMatchPaths: ["src/core/engine.ts"],
				// The .tsx components log too, and the glob excludes them.
				mustNotMatchPaths: ["src/components/SearchHeader.tsx"],
			},
		},
		{
			id: "structure_function_declaration",
			type: "structure",
			description: "Structural match for top-level function declarations",
			input: { type: "structure", input: "function $NAME($$$ARGS): $_ { $$$BODY }", path: "src/**/*.ts" },
			expect: { mustMatchPaths: ["src/core/engine.ts", "src/utils/math.ts", "src/utils/string-helpers.ts"] },
		},
		{
			id: "structure_class_declaration",
			type: "structure",
			description: "Structural match for class definitions",
			input: { type: "structure", input: "class $NAME { $$$MEMBERS }", path: "src/**/*.ts" },
			expect: { mustMatchPaths: ["src/index.ts"] },
		},
		{
			id: "structure_scoped_path",
			type: "structure",
			description: "Structural search scoped to utils directory",
			input: { type: "structure", input: "function $NAME($$$): $_ { $$$ }", path: "src/utils/*.ts" },
			expect: {
				mustMatchPaths: ["src/utils/math.ts", "src/utils/string-helpers.ts"],
				mustNotMatchPaths: ["src/core/engine.ts"],
			},
		},
		{
			id: "structure_pagination_skip",
			type: "structure",
			description: "Paginate structural search results using skip",
			input: { type: "structure", input: "function $NAME($$$): $_ { $$$ }", path: "src/**/*.ts", skip: 1 },
			expect: { minMatchedPaths: 1 },
		},
		{
			id: "structure_missing_return_annotation",
			type: "structure",
			description: "A declaration pattern without a return-type slot matches no annotated function",
			// Records a real property of structural matching: the pattern's node has to carry
			// every child the target does, so a pattern with no return type never matches a
			// function that has one. Every corpus function is annotated, so the answer is zero.
			// This case goes red if that stops holding, which the tool's guidance depends on.
			input: { type: "structure", input: "function $NAME($$$ARGS) { $$$BODY }", path: "src/**/*.ts" },
			expect: { exactMatchedPaths: 0 },
		},
	];
}

/** Extract canonical text content representation from tool results. */
export function canonicalizeResultContent(content: AgentToolResult["content"]): string {
	return content
		.map(item => {
			if (item.type === "text") return item.text.replace(/\r\n/g, "\n");
			return JSON.stringify(item);
		})
		.join("\n");
}

/** Execute a direct search engine invocation corresponding to a unified search query. */
export async function executeDirectEngine(
	session: ToolSession,
	input: SearchToolInput,
	signal?: AbortSignal,
): Promise<AgentToolResult<FileSearchDetails | TextSearchDetails | StructureSearchDetails>> {
	if (input.type === "files") {
		return executeFileSearch(
			session,
			{
				path: input.input,
				hidden: input.hidden,
				gitignore: input.gitignore,
				limit: input.limit,
			},
			signal,
		);
	}
	if (input.type === "text") {
		return executeTextSearch(
			session,
			{
				pattern: input.input,
				path: input.path,
				case: input.case,
				gitignore: input.gitignore,
				skip: input.skip,
			},
			signal,
		);
	}
	return executeStructureSearch(
		session,
		{
			pattern: input.input,
			path: input.path,
			skip: input.skip,
		},
		signal,
	);
}

/** Verify exact canonical parity between SearchTool result and direct engine result. */
export function verifySearchParity(
	queryType: SearchType,
	searchToolResult: AgentToolResult<SearchToolDetails>,
	directEngineResult: AgentToolResult<FileSearchDetails | TextSearchDetails | StructureSearchDetails>,
): { parity: boolean; error?: string } {
	// 1. Compare content text
	const stContent = canonicalizeResultContent(searchToolResult.content);
	const deContent = canonicalizeResultContent(directEngineResult.content);

	if (stContent !== deContent) {
		return {
			parity: false,
			error: `Content mismatch: SearchTool emitted ${stContent.length} chars, direct engine emitted ${deContent.length} chars`,
		};
	}

	// 2. Validate details envelope
	const stDetails = searchToolResult.details;
	const deDetails = directEngineResult.details;

	if (!stDetails) {
		return { parity: false, error: "SearchTool returned undefined details" };
	}
	if (!deDetails) {
		return { parity: false, error: "Direct engine returned undefined details" };
	}

	if (stDetails.type !== queryType) {
		return {
			parity: false,
			error: `SearchTool details.type mismatch: expected "${queryType}", got "${stDetails.type}"`,
		};
	}

	// 3. Deep compare details payload
	const stSerialized = JSON.stringify(stDetails.result);
	const deSerialized = JSON.stringify(deDetails);

	if (stSerialized !== deSerialized) {
		return {
			parity: false,
			error: `Details result mismatch: SearchTool result differs from direct engine details payload`,
		};
	}

	return { parity: true };
}

/** Measure a single search case across iterations for both arms. */
export async function measureSearchCase(
	session: ToolSession,
	searchTool: SearchTool,
	benchCase: SearchBenchmarkCase,
	iterations: number,
	strictParity = true,
	strictExpectations = true,
): Promise<SearchCaseMeasurement> {
	const stDurations: number[] = [];
	const deDurations: number[] = [];

	let lastStResult: AgentToolResult<SearchToolDetails> | undefined;
	let lastDeResult: AgentToolResult<FileSearchDetails | TextSearchDetails | StructureSearchDetails> | undefined;

	// Warmup run
	await searchTool.execute("warmup-st", benchCase.input);
	await executeDirectEngine(session, benchCase.input);

	// Alternate arm order so filesystem/native cache warmth does not always favor
	// the direct engine. Each pair still observes the same corpus state.
	for (let i = 0; i < iterations; i++) {
		if (i % 2 === 0) {
			const stStart = performance.now();
			lastStResult = await searchTool.execute(`bench-st-${i}`, benchCase.input);
			stDurations.push(performance.now() - stStart);

			const deStart = performance.now();
			lastDeResult = await executeDirectEngine(session, benchCase.input);
			deDurations.push(performance.now() - deStart);
		} else {
			const deStart = performance.now();
			lastDeResult = await executeDirectEngine(session, benchCase.input);
			deDurations.push(performance.now() - deStart);

			const stStart = performance.now();
			lastStResult = await searchTool.execute(`bench-st-${i}`, benchCase.input);
			stDurations.push(performance.now() - stStart);
		}
	}

	if (!lastStResult || !lastDeResult) {
		throw new Error(`Failed to obtain results for case ${benchCase.id}`);
	}

	// Parity verification
	const parityCheck = verifySearchParity(benchCase.type, lastStResult, lastDeResult);
	if (strictParity && !parityCheck.parity) {
		throw new Error(
			`Search parity failure on case "${benchCase.id}" (${benchCase.type}): ${parityCheck.error ?? "unknown mismatch"}`,
		);
	}

	const stContentText = canonicalizeResultContent(lastStResult.content);
	const deContentText = canonicalizeResultContent(lastDeResult.content);
	const stContentBytes = Buffer.byteLength(stContentText, "utf8");
	const deContentBytes = Buffer.byteLength(deContentText, "utf8");
	const stDetailsBytes = Buffer.byteLength(JSON.stringify(lastStResult.details ?? {}), "utf8");
	const deDetailsBytes = Buffer.byteLength(JSON.stringify(lastDeResult.details ?? {}), "utf8");

	const stMean = stDurations.reduce((acc, v) => acc + v, 0) / stDurations.length;
	const deMean = deDurations.reduce((acc, v) => acc + v, 0) / deDurations.length;

	// The declared answer is checked against the tool arm, which is the surface a model
	// reaches. Parity above already pinned the engine arm to the same bytes.
	const expectation = verifySearchExpectation(lastStResult.details, benchCase.expect);
	if (strictExpectations && !expectation.satisfied) {
		throw new Error(
			`Search expectation failure on case "${benchCase.id}" (${benchCase.type}): ${formatExpectationFailures(expectation.failures)}`,
		);
	}

	return {
		id: benchCase.id,
		type: benchCase.type,
		description: benchCase.description,
		parityPassed: parityCheck.parity,
		mismatchReason: parityCheck.error,
		expectationSatisfied: expectation.satisfied,
		expectationFailureReason: expectation.satisfied ? undefined : formatExpectationFailures(expectation.failures),
		matchedPaths: expectation.matchedPaths,
		searchTool: {
			meanDurationMs: Number(stMean.toFixed(3)),
			minDurationMs: Number(Math.min(...stDurations).toFixed(3)),
			maxDurationMs: Number(Math.max(...stDurations).toFixed(3)),
			contentBytes: stContentBytes,
			detailsBytes: stDetailsBytes,
			totalBytes: stContentBytes + stDetailsBytes,
		},
		directEngine: {
			meanDurationMs: Number(deMean.toFixed(3)),
			minDurationMs: Number(Math.min(...deDurations).toFixed(3)),
			maxDurationMs: Number(Math.max(...deDurations).toFixed(3)),
			contentBytes: deContentBytes,
			detailsBytes: deDetailsBytes,
			totalBytes: deContentBytes + deDetailsBytes,
		},
		dispatchOverheadMs: Number((stMean - deMean).toFixed(3)),
		outputBytesMatch: stContentBytes === deContentBytes,
	};
}

/** Run the complete unified search parity & dispatch benchmark. */
export async function runSearchParityBenchmark(options: SearchBenchmarkOptions = {}): Promise<SearchBenchmarkReport> {
	const iterations = Math.max(1, options.iterations ?? 5);
	const filterType = options.filterType ?? "all";
	const strictParity = options.strictParity ?? true;
	const strictExpectations = options.strictExpectations ?? true;

	const corpus = await createDeterministicSearchCorpus(options.corpusBaseDir);

	try {
		const session = createSearchBenchmarkSession(corpus.corpusDir);
		const searchTool = new SearchTool(session);

		const allCases = buildSearchBenchmarkCases();
		const casesToRun = filterType === "all" ? allCases : allCases.filter(c => c.type === filterType);

		const measurements: SearchCaseMeasurement[] = [];

		for (const benchCase of casesToRun) {
			const measurement = await measureSearchCase(
				session,
				searchTool,
				benchCase,
				iterations,
				strictParity,
				strictExpectations,
			);
			measurements.push(measurement);
		}

		const types: SearchType[] = ["files", "text", "structure"];
		const summaryByType = {} as Record<SearchType, SearchTypeSummary>;

		for (const t of types) {
			const typeCases = measurements.filter(m => m.type === t);
			const total = typeCases.length;
			const passed = typeCases.filter(m => m.parityPassed).length;
			const failed = total - passed;
			const expectationPassed = typeCases.filter(m => m.expectationSatisfied).length;
			const avgSt = total > 0 ? typeCases.reduce((acc, c) => acc + c.searchTool.meanDurationMs, 0) / total : 0;
			const avgDe = total > 0 ? typeCases.reduce((acc, c) => acc + c.directEngine.meanDurationMs, 0) / total : 0;
			const avgOverhead = total > 0 ? typeCases.reduce((acc, c) => acc + c.dispatchOverheadMs, 0) / total : 0;
			const totalStBytes = typeCases.reduce((acc, c) => acc + c.searchTool.totalBytes, 0);
			const totalDeBytes = typeCases.reduce((acc, c) => acc + c.directEngine.totalBytes, 0);

			summaryByType[t] = {
				type: t,
				totalCases: total,
				parityPassedCases: passed,
				parityFailedCases: failed,
				expectationPassedCases: expectationPassed,
				expectationFailedCases: total - expectationPassed,
				avgSearchToolDurationMs: Number(avgSt.toFixed(3)),
				avgDirectEngineDurationMs: Number(avgDe.toFixed(3)),
				avgDispatchOverheadMs: Number(avgOverhead.toFixed(3)),
				totalSearchToolBytes: totalStBytes,
				totalDirectEngineBytes: totalDeBytes,
			};
		}

		const totalMismatches = measurements.filter(m => !m.parityPassed).length;
		const totalExpectationFailures = measurements.filter(m => !m.expectationSatisfied).length;

		return {
			timestamp: new Date().toISOString(),
			iterationsPerCase: iterations,
			corpusFileCount: corpus.fileCount,
			corpusTotalBytes: corpus.totalBytes,
			totalCases: measurements.length,
			parityPassed: totalMismatches === 0,
			totalMismatches,
			expectationsPassed: totalExpectationFailures === 0,
			totalExpectationFailures,
			summaryByType,
			cases: measurements,
			limitations: SEARCH_BENCHMARK_LIMITATIONS,
		};
	} finally {
		await corpus.cleanup();
	}
}

/** Format human-readable summary table of benchmark results. */
export function formatBenchmarkSummary(report: SearchBenchmarkReport): string {
	const lines: string[] = [];
	lines.push("================================================================================");
	lines.push("               UNIFIED SEARCH PARITY & DISPATCH BENCHMARK REPORT                ");
	lines.push("================================================================================");
	lines.push(`Timestamp:             ${report.timestamp}`);
	lines.push(`Corpus Files:          ${report.corpusFileCount} files (${report.corpusTotalBytes} bytes)`);
	lines.push(`Iterations Per Case:   ${report.iterationsPerCase}`);
	lines.push(`Total Cases Evaluated: ${report.totalCases}`);
	lines.push(
		`Result Parity Status:  ${report.parityPassed ? "PASS (100% Exact Match)" : `FAIL (${report.totalMismatches} mismatches)`}`,
	);
	lines.push(
		`Declared Answer Status:${report.expectationsPassed ? " PASS (every case matched the corpus)" : ` FAIL (${report.totalExpectationFailures} cases)`}`,
	);
	lines.push("--------------------------------------------------------------------------------");
	lines.push("TYPE SUMMARY:");
	lines.push("Type       | Cases | Parity | Answer | SearchTool (ms) | DirectEngine (ms) | Overhead (ms) | ST Bytes");
	lines.push("-----------+-------+--------+--------+-----------------+-------------------+---------------+---------");

	for (const summary of Object.values(report.summaryByType)) {
		const typeCol = summary.type.padEnd(10);
		const casesCol = String(summary.totalCases).padStart(5);
		const parityCol = `${summary.parityPassedCases}/${summary.totalCases}`.padStart(6);
		const answerCol = `${summary.expectationPassedCases}/${summary.totalCases}`.padStart(6);
		const stMsCol = summary.avgSearchToolDurationMs.toFixed(3).padStart(15);
		const deMsCol = summary.avgDirectEngineDurationMs.toFixed(3).padStart(17);
		const overheadCol = (
			summary.avgDispatchOverheadMs >= 0
				? `+${summary.avgDispatchOverheadMs.toFixed(3)}`
				: summary.avgDispatchOverheadMs.toFixed(3)
		).padStart(13);
		const bytesCol = String(summary.totalSearchToolBytes).padStart(8);
		lines.push(
			`${typeCol} | ${casesCol} | ${parityCol} | ${answerCol} | ${stMsCol} | ${deMsCol} | ${overheadCol} | ${bytesCol}`,
		);
	}

	lines.push("--------------------------------------------------------------------------------");
	lines.push("CASE DETAILS:");
	lines.push("Case ID                        | Type      | Parity | Answer | Files | ST (ms) | DE (ms) | Delta (ms)");
	lines.push("-------------------------------+-----------+--------+--------+-------+---------+---------+-----------");

	for (const c of report.cases) {
		const idCol = c.id.padEnd(30);
		const typeCol = c.type.padEnd(9);
		const parityCol = c.parityPassed ? "PASS  " : "FAIL  ";
		const answerCol = c.expectationSatisfied ? "PASS  " : "FAIL  ";
		const stCol = c.searchTool.meanDurationMs.toFixed(3).padStart(7);
		const deCol = c.directEngine.meanDurationMs.toFixed(3).padStart(7);
		const delta = c.dispatchOverheadMs >= 0 ? `+${c.dispatchOverheadMs.toFixed(3)}` : c.dispatchOverheadMs.toFixed(3);
		const deltaCol = delta.padStart(10);
		const filesCol = String(c.matchedPaths.length).padStart(5);
		lines.push(
			`${idCol} | ${typeCol} | ${parityCol} | ${answerCol} | ${filesCol} | ${stCol} | ${deCol} | ${deltaCol}`,
		);
		if (c.expectationFailureReason) {
			lines.push(`  -> declared answer not produced: ${c.expectationFailureReason}`);
		}
	}

	lines.push("================================================================================");
	lines.push("LIMITATIONS & BENCHMARK METHODOLOGY:");
	for (const limitation of report.limitations) {
		lines.push(`- ${limitation}`);
	}
	lines.push("================================================================================");

	return `${lines.join("\n")}\n`;
}

// CLI runner entrypoint
if (import.meta.main) {
	const args = process.argv.slice(2);
	let iterations = 5;
	let filterType: SearchType | "all" = "all";
	let jsonOutput: string | null = null;
	let jsonStdout = false;

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--iterations" && i + 1 < args.length) {
			iterations = parseInt(args[++i], 10) || 5;
		} else if (arg === "--type" && i + 1 < args.length) {
			const val = args[++i];
			if (val === "files" || val === "text" || val === "structure" || val === "all") {
				filterType = val;
			}
		} else if (arg === "--json") {
			if (i + 1 < args.length && !args[i + 1].startsWith("-")) {
				jsonOutput = args[++i];
			} else {
				jsonStdout = true;
			}
		}
	}

	try {
		const report = await runSearchParityBenchmark({
			iterations,
			filterType,
			strictParity: false,
			strictExpectations: false,
		});

		if (jsonStdout) {
			process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
		} else {
			process.stdout.write(formatBenchmarkSummary(report));
		}

		if (jsonOutput) {
			await fs.writeFile(jsonOutput, JSON.stringify(report, null, 2), "utf8");
		}

		if (!report.parityPassed || !report.expectationsPassed) {
			process.exit(1);
		}
	} catch (err) {
		process.stderr.write(`Unified search benchmark error: ${errorMessage(err)}\n`);
		process.exit(1);
	}
}
