import * as fs from "node:fs/promises";
import * as path from "node:path";
import { internalScratchDir } from "../../paths";

/** A corpus declared as data, so a new one is a value rather than a code path. */
export interface SearchCorpusSpec {
	readonly id: string;
	readonly description: string;
	/** Corpus-relative path -> exact file bytes. Parents are created for each entry. */
	readonly files: Readonly<Record<string, string>>;
	readonly limitations?: readonly string[];
}

export interface MaterializedCorpus {
	readonly corpusId: string;
	readonly corpusDir: string;
	readonly fileCount: number;
	readonly totalBytes: number;
	cleanup(): Promise<void>;
}

export async function materializeCorpus(spec: SearchCorpusSpec, baseDir?: string): Promise<MaterializedCorpus> {
	const parent = baseDir ?? internalScratchDir();
	await fs.mkdir(parent, { recursive: true });
	const root = await fs.mkdtemp(path.join(parent, `search-bench-corpus-${spec.id}-`));

	let fileCount = 0;
	let totalBytes = 0;

	for (const [relPath, content] of Object.entries(spec.files)) {
		const fullPath = path.join(root, relPath);
		await fs.mkdir(path.dirname(fullPath), { recursive: true });
		await fs.writeFile(fullPath, content, "utf8");
		fileCount += 1;
		totalBytes += Buffer.byteLength(content, "utf8");
	}

	return {
		corpusId: spec.id,
		corpusDir: root,
		fileCount,
		totalBytes,
		cleanup: async () => {
			await fs.rm(root, { recursive: true, force: true });
		},
	};
}

export const TYPESCRIPT_PROJECT_CORPUS: SearchCorpusSpec = {
	id: "typescript-project",
	description: "Deterministic single-package TypeScript project fixture for search benchmarks.",
	files: {
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
	},
};

export const MONOREPO_CORPUS: SearchCorpusSpec = {
	id: "monorepo",
	description: "Deterministic monorepo fixture exercising nesting depth, duplicate basenames, and package scoping.",
	files: {
		"package.json": JSON.stringify(
			{
				name: "bench-monorepo-fixture",
				version: "1.0.0",
				private: true,
				workspaces: ["packages/*"],
			},
			null,
			2,
		),
		".gitignore": `${["node_modules/", "dist/", "*.snap"].join("\n")}\n`,
		"packages/alpha/package.json": JSON.stringify(
			{
				name: "@monorepo/alpha",
				version: "1.0.0",
				main: "src/index.ts",
			},
			null,
			2,
		),
		"packages/beta/package.json": JSON.stringify(
			{
				name: "@monorepo/beta",
				version: "1.0.0",
				main: "src/index.ts",
			},
			null,
			2,
		),
		"packages/alpha/src/index.ts": `import { resolveRoute } from "./client";

export function initializeAlpha(config: Record<string, string>): boolean {
	return Boolean(config && resolveRoute("/home"));
}
`,
		"packages/beta/src/index.ts": `import { resolveRoute } from "./client";

export function initializeBeta(config: Record<string, string>): boolean {
	return Boolean(config && resolveRoute("/dashboard"));
}
`,
		"packages/alpha/src/client.ts": `export function resolveRoute(path: string): string {
	return \`alpha://gateway\${path}\`;
}
`,
		"packages/beta/src/client.ts": `export function resolveRoute(path: string): string {
	return \`beta://cluster\${path}\`;
}
`,
		"packages/alpha/src/deep/nested/handler.ts": `export function handleNestedRequest(reqId: string): string {
	return \`deep-alpha:\${reqId}\`;
}
`,
		"packages/beta/src/utils/format.ts": `export function formatBetaMessage(msg: string): string {
	return \`[beta] \${msg}\`;
}
`,
		"packages/alpha/dist/index.js": `module.exports = { compiled: true, package: "alpha" };\n`,
		"packages/beta/tests/client.snap": `snapshot test data for beta client\n`,
		"packages/alpha/tests/client.test.ts": `import { resolveRoute } from "../src/client";

export function testAlphaClient(): void {
	if (resolveRoute("/test") !== "alpha://gateway/test") {
		throw new Error("Alpha route failed");
	}
}
`,
		"packages/beta/tests/client.test.ts": `import { resolveRoute } from "../src/client";

export function testBetaClient(): void {
	if (resolveRoute("/test") !== "beta://cluster/test") {
		throw new Error("Beta route failed");
	}
}
`,
	},
};

function generateDisclosureFiles(): Record<string, string> {
	const files: Record<string, string> = {};
	for (let fileIndex = 0; fileIndex < 20; fileIndex++) {
		const lines = Array.from(
			{ length: 8 },
			(_, lineIndex) =>
				`export const disclosure_${fileIndex}_${lineIndex} = "DISCLOSURE_NEEDLE_${fileIndex}_${lineIndex}_${"x".repeat(56)}";`,
		);
		files[`disclosure-${fileIndex}.ts`] = `${lines.join("\n")}\n`;
	}
	return files;
}

export const DISCLOSURE_CORPUS: SearchCorpusSpec = {
	id: "disclosure",
	description: "Progressive disclosure fixture generating 160 needles across 20 files to trigger artifact spill.",
	files: generateDisclosureFiles(),
	limitations: [
		"Progressive disclosure measurements exercise text search output compaction and artifact spill, not semantic ranking.",
	],
};
