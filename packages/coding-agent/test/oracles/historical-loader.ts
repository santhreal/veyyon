import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "@babel/parser";
import * as searchCardLimits from "@veyyon/coding-agent/tools/search/search-card-limits";
import type { Component } from "@veyyon/tui";
import { readGitFileBuffer, readGitTree } from "../../../../scripts/git-baseline";

/**
 * Tool modules whose card limits moved to `tools/search/search-card-limits`. A pinned oracle that
 * takes only limit names (plus erased `type` specifiers) from one of these is redirected to the leaf,
 * which is where the number it draws with is declared now; an oracle that takes anything else from
 * the tool module keeps its import and fails loudly on the missing export.
 */
const SEARCH_LIMIT_SPECIFIERS = new Set([
	"@veyyon/coding-agent/tools/search/structure-search",
	"@veyyon/coding-agent/tools/search/text-search",
]);
const SEARCH_LIMIT_NAMES = new Set(Object.keys(searchCardLimits));
const SEARCH_LIMIT_MODULE = "@veyyon/coding-agent/tools/search/search-card-limits";

export type RenderFn<TArgs = unknown, TOptions = unknown, TTheme = unknown, TRes = Component> = (
	args?: TArgs,
	options?: TOptions,
	theme?: TTheme,
	extra?: unknown,
) => TRes;

export interface LegacyRenderer {
	readonly renderCall: RenderFn;
	readonly renderResult: RenderFn;
	readonly animatedPartialResult?: unknown;
	readonly animatedPendingPreview?: unknown;
	readonly callIsLiveWidget?: unknown;
	readonly forceFirstResultViewportRepaint?: unknown;
	readonly forceResultViewportRepaintOnSettle?: unknown;
	readonly inline?: unknown;
	readonly mergeCallAndResult?: unknown;
}

// This commit contains the approved frozen renderers, including their import adaptations.
// Their original production commits remain recorded in each historical file's header.
export const ORACLE_SNAPSHOT_COMMIT = "81eee11283051f29967dbfc506b297d45fd375b1";
export const ORACLE_SOURCE_DIRECTORY = "packages/coding-agent/test/oracles";
export const ORACLE_CACHE_DIRECTORY = path.join(
	import.meta.dirname,
	".cache",
	`historical-v7-${ORACLE_SNAPSHOT_COMMIT}`,
);
export const ADAPTER_FILENAME = "historical-render-utils-adapter.ts";
export const ADAPTER_SPECIFIER = "historical-render-utils-adapter";
const PINNED_RENDER_UTILS_SOURCE_PATH = "packages/coding-agent/src/tools/core/render-utils.ts";
export const ORACLE_EXPORTS: Readonly<Record<string, readonly string[]>> = {
	"ask-main-renderer": ["askMainRenderer"],
	"ast-edit-main-renderer": ["astEditToolRenderer"],
	"bash-main-renderer": ["getBashEnvForDisplay", "formatBashCommandLines", "createShellRenderer", "bashMainRenderer"],
	"browser-main-renderer": ["browserToolRenderer"],
	"certify-arms-main-renderer": ["renderCall", "renderResult"],
	"debug-main-renderer": ["debugToolRenderer"],
	"edit-main-renderer": ["editToolRenderer"],
	"eval-main-renderer": ["EVAL_DEFAULT_PREVIEW_LINES", "evalToolRenderer"],
	"fetch-main-renderer": ["renderReadUrlCall", "renderReadUrlResult"],
	"file-search-main-renderer": ["fileSearchRenderer"],
	"gh-main-renderer": ["githubToolRenderer"],
	"goal-main-renderer": ["renderCall", "renderResult"],
	"init-experiment-main-renderer": ["renderCall", "renderResult"],
	"inspect-image-main-renderer": ["inspectImageToolRenderer"],
	"irc-main-renderer": ["createIrcMessageCard", "ircToolRenderer"],
	"job-main-renderer": ["jobToolRenderer"],
	"launch-main-renderer": ["launchToolRenderer"],
	"log-experiment-main-renderer": ["renderCall", "renderResult"],
	"lsp-main-renderer": ["renderCall", "renderResult", "lspToolRenderer"],
	"mcp-main-renderer": ["renderMCPCall", "renderMCPResult"],
	"memory-main-renderer": ["retainToolRenderer", "recallToolRenderer", "reflectToolRenderer"],
	"read-main-renderer": ["readToolRenderer"],
	"resolve-main-renderer": ["renderCall", "renderResult"],
	"review-main-renderer": ["renderCall", "renderResult"],
	"run-experiment-main-renderer": ["renderCall", "renderResult"],
	"search-main-renderer": ["searchToolRenderer"],
	"search-tool-bm25-main-renderer": ["searchToolBm25Renderer"],
	"set-cwd-main-renderer": ["renderCall", "renderResult"],
	"ssh-main-renderer": ["sshMainRenderer"],
	"structure-search-main-renderer": ["structureSearchRenderer"],
	"task-main-renderer": ["formatTaskId", "renderCall", "renderResult"],
	"text-search-main-renderer": ["textSearchRenderer"],
	"todo-main-renderer": [
		"TODO_STRIKE_HOLD_FRAMES",
		"TODO_STRIKE_REVEAL_FRAMES",
		"TODO_STRIKE_TOTAL_FRAMES",
		"todoStrikeReveal",
		"todoToolRenderer",
	],
	"update-notes-main-renderer": ["renderCall", "renderResult"],
	"vibe-main-renderer": ["createVibeToolRenderer"],
	"web-search-main-renderer": ["renderSearchResult", "renderSearchCall", "webSearchToolRenderer"],
	"write-main-renderer": ["mainWriteToolRenderer", "mainFormatStreamingContent"],
};

const snapshotTree = readGitTree(ORACLE_SNAPSHOT_COMMIT);

function blobHash(content: Buffer): string {
	return createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");
}
let cachedAdapterBuffer: Buffer | null = null;

function getPinnedExportSources(sourcePath: string, names: readonly string[]): string {
	const entry = snapshotTree.get(sourcePath);
	if (entry?.type !== "blob") {
		throw new Error(`Pinned helper source is absent from the approved snapshot: ${sourcePath}`);
	}
	const sourceBuffer = readGitFileBuffer(sourcePath, ORACLE_SNAPSHOT_COMMIT);
	if (!sourceBuffer || blobHash(sourceBuffer) !== entry.sha) {
		throw new Error(`Pinned helper Git blob mismatch: ${sourcePath}`);
	}
	const sourceText = sourceBuffer.toString("utf-8");
	const ast = parse(sourceText, { sourceType: "module", plugins: ["typescript"] });
	const missing = new Set(names);
	const sources: string[] = [];
	for (const node of ast.program.body) {
		if (
			node.type !== "ExportNamedDeclaration" ||
			!node.declaration ||
			typeof node.start !== "number" ||
			typeof node.end !== "number"
		) {
			continue;
		}
		const declaration = node.declaration;
		const exportedNames: string[] = [];
		if (declaration.type === "FunctionDeclaration" && declaration.id) {
			exportedNames.push(declaration.id.name);
		} else if (declaration.type === "VariableDeclaration") {
			for (const declarator of declaration.declarations) {
				if (declarator.id.type === "Identifier") exportedNames.push(declarator.id.name);
			}
		}
		if (!exportedNames.some(name => missing.has(name))) continue;
		sources.push(sourceText.slice(node.start, node.end));
		for (const name of exportedNames) missing.delete(name);
	}
	if (missing.size > 0) {
		throw new Error(`Pinned helper exports are absent from ${sourcePath}: ${[...missing].join(", ")}`);
	}
	return sources.join("\n\n");
}

function getHistoricalRenderUtilsAdapterBuffer(): Buffer {
	if (cachedAdapterBuffer !== null) return cachedAdapterBuffer;
	const formatDiagnosticsSource = getPinnedExportSources(PINNED_RENDER_UTILS_SOURCE_PATH, ["formatDiagnostics"]);
	const diagnosticSources = getPinnedExportSources("packages/coding-agent/src/tools/core/diagnostics.ts", [
		"sanitizeDiagnosticDisplayText",
		"getSeverityRank",
		"parseDiagnosticMessage",
		"groupByFile",
	]);
	const writeDisplaySource = getPinnedExportSources("packages/coding-agent/src/tools/fs/write.ts", [
		"normalizeDisplayText",
		"WRITE_STREAMING_PREVIEW_LINES",
	]);
	const readDisplaySource = getPinnedExportSources("packages/coding-agent/src/tools/fs/read.ts", ["readSourceFsPath"]);
	const adapterSource = `import type { Theme } from "@veyyon/coding-agent/theme/theme";
import type { ParsedDiagnostic } from "@veyyon/coding-agent/tools/core/diagnostics";
import { replaceTabs } from "@veyyon/utils/tab-width";
import { formatExpandHint } from "@veyyon/coding-agent/tools/core/render-utils";
import type { ReadToolDetails } from "@veyyon/coding-agent/tools/fs/read";

export * from "@veyyon/coding-agent/tools/core/render-utils";
export * from "@veyyon/coding-agent/tools/core/path-utils";
export type * from "@veyyon/coding-agent/tools/fs/read";

${diagnosticSources}

${formatDiagnosticsSource}

${writeDisplaySource}

${readDisplaySource}
`;
	cachedAdapterBuffer = Buffer.from(adapterSource, "utf-8");
	return cachedAdapterBuffer;
}

function deriveExecutableSource(originalSource: string): string {
	const ast = parse(originalSource, {
		sourceType: "module",
		plugins: ["typescript"],
	});

	const replacements: Array<{ start: number; end: number; replacement: string }> = [];
	for (const node of ast.program.body) {
		if (
			(node.type === "ImportDeclaration" ||
				node.type === "ExportNamedDeclaration" ||
				node.type === "ExportAllDeclaration") &&
			node.source &&
			(node.source.value === "@veyyon/coding-agent/tools/core/render-utils" ||
				node.source.value === "@veyyon/coding-agent/tools/fs/write" ||
				node.source.value === "@veyyon/coding-agent/tools/fs/read") &&
			typeof node.source.start === "number" &&
			typeof node.source.end === "number"
		) {
			replacements.push({
				start: node.source.start,
				end: node.source.end,
				replacement: `"./${ADAPTER_SPECIFIER}"`,
			});
		} else if (
			node.type === "ImportDeclaration" &&
			node.importKind !== "type" &&
			SEARCH_LIMIT_SPECIFIERS.has(node.source.value) &&
			typeof node.source.start === "number" &&
			typeof node.source.end === "number" &&
			node.specifiers.every(
				specifier =>
					specifier.type === "ImportSpecifier" &&
					(specifier.importKind === "type" ||
						(specifier.imported.type === "Identifier" && SEARCH_LIMIT_NAMES.has(specifier.imported.name))),
			)
		) {
			replacements.push({
				start: node.source.start,
				end: node.source.end,
				replacement: `"${SEARCH_LIMIT_MODULE}"`,
			});
		}
	}

	if (replacements.length === 0) {
		return originalSource;
	}

	replacements.sort((a, b) => b.start - a.start);
	let derived = originalSource;
	for (const { start, end, replacement } of replacements) {
		derived = derived.slice(0, start) + replacement + derived.slice(end);
	}
	return derived;
}

function ensureCacheFile(filePath: string, expectedBuffer: Buffer, errorMessage: string): void {
	try {
		fs.writeFileSync(filePath, expectedBuffer, { flag: "wx" });
	} catch (error) {
		if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
	}
	if (!fs.readFileSync(filePath).equals(expectedBuffer)) {
		throw new Error(errorMessage);
	}
}

/**
 * Load unmodified approved source from Git; never accept source supplied by a cache.
 * Retains byte-exact original Git bytes in the primary cache file and redirects only
 * historical dependency imports in a derived cache file for execution.
 */
export async function loadHistoricalOracle(
	name: string,
	cacheDirectory: string = ORACLE_CACHE_DIRECTORY,
): Promise<Record<string, unknown>> {
	if (!Object.hasOwn(ORACLE_EXPORTS, name)) throw new Error(`Unknown historical oracle: ${name}`);
	const sourcePath = `${ORACLE_SOURCE_DIRECTORY}/${name}.ts`;
	const entry = snapshotTree.get(sourcePath);
	if (entry?.type !== "blob") throw new Error(`Historical oracle is absent from the pinned snapshot: ${sourcePath}`);
	const source = readGitFileBuffer(sourcePath, ORACLE_SNAPSHOT_COMMIT);
	if (!source || blobHash(source) !== entry.sha) throw new Error(`Historical oracle Git blob mismatch: ${sourcePath}`);

	fs.mkdirSync(cacheDirectory, { recursive: true });

	// 1. Materialize and validate the adapter cache
	const adapterBuffer = getHistoricalRenderUtilsAdapterBuffer();
	const adapterFile = path.join(cacheDirectory, ADAPTER_FILENAME);
	ensureCacheFile(
		adapterFile,
		adapterBuffer,
		"Historical render-utils adapter cache differs from verified generated source; remove the stale cache and retry",
	);

	// 2. Materialize and validate the original cache (byte-identical to Git blob)
	const cacheFile = path.join(cacheDirectory, `${name}.ts`);
	ensureCacheFile(
		cacheFile,
		source,
		`Historical oracle cache differs from the pinned Git blob: ${name}; remove the stale cache and retry`,
	);

	// 3. Materialize and validate the derived executable cache
	const derivedSource = deriveExecutableSource(source.toString("utf-8"));
	const derivedBuffer = Buffer.from(derivedSource, "utf-8");
	const derivedFile = path.join(cacheDirectory, `${name}.derived.ts`);
	ensureCacheFile(
		derivedFile,
		derivedBuffer,
		`Historical oracle derived executable cache differs from generated source: ${name}; remove the stale cache and retry`,
	);

	// 4. Import the derived executable module via native ESM.
	// Dynamic import is required here because the module specifier is derived at runtime
	// and materialized into a temporary cache directory from historical Git blobs.
	const module = (await import(pathToFileURL(derivedFile).href)) as Record<string, unknown>;
	for (const exported of ORACLE_EXPORTS[name]) {
		if (!Object.hasOwn(module, exported) || module[exported] === undefined) {
			throw new Error(`Historical oracle ${name} is missing required export: ${exported}`);
		}
	}
	return module;
}
