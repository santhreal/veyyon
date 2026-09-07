import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { Component } from "@veyyon/tui";
import { readGitFileBuffer, readGitTree } from "../../../../scripts/git-baseline";

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
	`historical-v2-${ORACLE_SNAPSHOT_COMMIT}`,
);
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
const requireOracle = createRequire(import.meta.url);

function blobHash(content: Buffer): string {
	return createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");
}

/** Load unmodified approved source from Git; never accept source supplied by a cache. */
export function loadHistoricalOracle(
	name: string,
	cacheDirectory: string = ORACLE_CACHE_DIRECTORY,
): Record<string, unknown> {
	if (!Object.hasOwn(ORACLE_EXPORTS, name)) throw new Error(`Unknown historical oracle: ${name}`);
	const sourcePath = `${ORACLE_SOURCE_DIRECTORY}/${name}.ts`;
	const entry = snapshotTree.get(sourcePath);
	if (entry?.type !== "blob") throw new Error(`Historical oracle is absent from the pinned snapshot: ${sourcePath}`);
	const source = readGitFileBuffer(sourcePath, ORACLE_SNAPSHOT_COMMIT);
	if (!source || blobHash(source) !== entry.sha) throw new Error(`Historical oracle Git blob mismatch: ${sourcePath}`);
	const cacheFile = path.join(cacheDirectory, `${name}.ts`);
	fs.mkdirSync(cacheDirectory, { recursive: true });
	try {
		fs.writeFileSync(cacheFile, source, { flag: "wx" });
	} catch (error) {
		if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
	}
	if (!fs.readFileSync(cacheFile).equals(source)) {
		throw new Error(
			`Historical oracle cache differs from the pinned Git blob: ${name}; remove the stale cache and retry`,
		);
	}
	const module = requireOracle(cacheFile) as Record<string, unknown>;
	for (const exported of ORACLE_EXPORTS[name]) {
		if (!Object.hasOwn(module, exported) || module[exported] === undefined) {
			throw new Error(`Historical oracle ${name} is missing required export: ${exported}`);
		}
	}
	return module;
}
