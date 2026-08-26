/**
 * Single owner of directory layout and path resolution for @veyyon/evals.
 */
import * as fs from "node:fs";
import * as path from "node:path";

/** Root directory of the @veyyon/evals package (packages/evals). */
export function evalsPackageDir(): string {
	return path.resolve(import.meta.dirname, "..");
}

/** Root directory of the DeepSWE suite (packages/evals/src/suites/deep-swe). */
export function deepSweSuiteDir(): string {
	return path.join(import.meta.dirname, "suites", "deep-swe");
}

/** Arms configuration directory (packages/evals/arms). */
export function armsDir(): string {
	return path.join(evalsPackageDir(), "arms");
}

/** Curated task lists directory (packages/evals/datasets/deep-swe/tasks). */
export function taskListsDir(): string {
	return path.join(evalsPackageDir(), "datasets", "deep-swe", "tasks");
}

/** Task definitions corpus directory (packages/evals/datasets/deep-swe/corpus/tasks or corpus). */
export function taskCorpusDir(): string {
	const nested = path.join(evalsPackageDir(), "datasets", "deep-swe", "corpus", "tasks");
	if (fs.existsSync(nested)) return nested;
	return path.join(evalsPackageDir(), "datasets", "deep-swe", "corpus");
}

/** Dictionary datasets directory (packages/evals/datasets/dicts). */
export function dictsDir(): string {
	return path.join(evalsPackageDir(), "datasets", "dicts");
}

/** Fixtures directory (packages/evals/datasets/deep-swe/fixtures). */
export function fixturesDir(): string {
	return path.join(evalsPackageDir(), "datasets", "deep-swe", "fixtures");
}

/** In-container Pier agents directory (packages/evals/agents/pier). */
export function pierAgentDir(): string {
	return path.join(evalsPackageDir(), "agents", "pier");
}

/** Harbor agents directory (packages/evals/agents/harbor). */
export function harborAgentDir(): string {
	return path.join(evalsPackageDir(), "agents", "harbor");
}

/** Default jobs directory for Harbor runs (runs/harbor at repository root). */
export function harborJobsDir(): string {
	return path.join(repoRootDir(), "runs", "harbor");
}

/** Cache directory for the evals package (packages/evals/.cache). */
export function cacheDir(): string {
	return path.join(evalsPackageDir(), ".cache");
}

/** TerminalBench dataset directory for a specific tag (packages/evals/.cache/datasets/terminal-bench/<tag>). */
export function terminalBenchDatasetDir(tag: string): string {
	return path.join(cacheDir(), "datasets", "terminal-bench", tag);
}

/** TerminalBench curated task lists directory (packages/evals/datasets/terminal-bench/tasks). */
export function terminalBenchTaskListsDir(): string {
	return path.join(evalsPackageDir(), "datasets", "terminal-bench", "tasks");
}

/** Path to bundled TypeScript edit benchmark fixtures archive (packages/evals/datasets/typescript-edit/fixtures.tar.gz). */
export function typescriptEditFixturesArchive(): string {
	return path.join(evalsPackageDir(), "datasets", "typescript-edit", "fixtures.tar.gz");
}

/** TypeScript edit benchmark dataset cache directory (packages/evals/.cache/datasets/typescript-edit). */
export function typescriptEditCacheDir(): string {
	return path.join(cacheDir(), "datasets", "typescript-edit");
}

/** Repository workspace internal scratch directory (.internal at repository root). */
export function internalScratchDir(): string {
	return path.join(repoRootDir(), ".internal");
}

/** Shared evals assets directory (packages/evals/assets). */
export function assetsDir(): string {
	return path.join(evalsPackageDir(), "assets");
}

/** Runs output directory (packages/evals/runs). */
export function runsDir(): string {
	return path.join(evalsPackageDir(), "runs");
}

/** DeepSWE documentation directory (packages/evals/docs/deep-swe). */
export function docsDir(): string {
	return path.join(evalsPackageDir(), "docs", "deep-swe");
}

/** Repository workspace root directory. */
export function repoRootDir(): string {
	return path.resolve(evalsPackageDir(), "../..");
}

/** Coding agent package directory (packages/coding-agent). */
export function codingAgentDir(): string {
	return path.resolve(evalsPackageDir(), "../coding-agent");
}

/** Path to staged auth-agent.db. */
export function authDbPath(): string {
	return path.join(assetsDir(), "auth-agent.db");
}

/** Path to compiled vey binary. */
export function veyBinaryPath(): string {
	return path.join(codingAgentDir(), "dist", "vey");
}

/** Path to default comparison task list (datasets/deep-swe/tasks/pilot-10.txt). */
export function comparisonTaskListPath(): string {
	return path.join(taskListsDir(), "pilot-10.txt");
}

/** Path to oneshot prompt template. */
export function oneshotPromptTemplatePath(): string {
	return path.join(pierAgentDir(), "oneshot_prompt.md.j2");
}

/** Resolve a relative path against the evals package root. Absolute paths are returned unchanged. */
export function resolvePackagePath(p: string): string {
	if (path.isAbsolute(p)) return p;
	return path.resolve(evalsPackageDir(), p);
}
