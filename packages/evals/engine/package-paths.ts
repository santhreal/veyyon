/**
 * Single owner of directory layout and path resolution for @veyyon/evals.
 */
import * as fs from "node:fs";
import * as path from "node:path";

/** Root directory of the @veyyon/evals package (packages/evals). */
export function evalsPackageDir(): string {
	return path.resolve(import.meta.dirname, "..");
}

/** A dynamic path segment that would escape the directory it is joined into. */
export class UnsafePathSegmentError extends Error {
	readonly segment: string;

	constructor(segment: string, what: string) {
		super(
			`Unsafe ${what} ${JSON.stringify(segment)}: a path segment must be a single name, ` +
				`without a separator, and must not be "." or "..".`,
		);
		this.name = "UnsafePathSegmentError";
		this.segment = segment;
	}
}

/**
 * Validate one dynamic path segment and return it unchanged.
 *
 * A dataset tag, suite name or arm label reaches this module from a CLI flag, a config file or a
 * run record. Joining such a value unchecked lets `../../..` reach any directory the process can
 * write, so every dynamic segment passes through here.
 */
export function requirePathSegment(value: string, what: string): string {
	if (value.length === 0 || value.trim() !== value) throw new UnsafePathSegmentError(value, what);
	if (value === "." || value === "..") throw new UnsafePathSegmentError(value, what);
	if (value.includes("/") || value.includes("\\") || value.includes("\0")) {
		throw new UnsafePathSegmentError(value, what);
	}
	if (path.basename(value) !== value) throw new UnsafePathSegmentError(value, what);
	return value;
}

function checkedSegments(segments: readonly string[]): string[] {
	return segments.map(segment => requirePathSegment(segment, "path segment"));
}

/** Characters a derived path segment keeps; every other character becomes `_`. */
const DISALLOWED_IN_SEGMENT = /[^a-zA-Z0-9._-]/g;

/**
 * Derive one safe path segment from an untrusted name.
 *
 * A task id, a variant label and a run id reach a trial directory from a CLI flag or a dataset
 * listing, and a name that is not a valid segment is rewritten rather than rejected. Replacing
 * separators is not enough: `.` and `..` contain no disallowed character, so they survive a
 * character filter and resolve to the directory above. A trial directory built from one lands
 * outside the run, and the cleanup that removes the trial directory then removes whatever is
 * there instead. Every derived segment passes through here; a segment that must be rejected
 * rather than rewritten passes through `requirePathSegment`.
 */
export function pathSegmentFrom(value: string, fallback: string): string {
	const filtered = value.trim().replace(DISALLOWED_IN_SEGMENT, "_");
	if (filtered.length === 0) return requirePathSegment(fallback, "path segment fallback");
	if (/^\.+$/.test(filtered)) return `_${filtered}`;
	return filtered;
}

/** Root directory of the DeepSWE suite (packages/evals/suites/deep-swe). */
export function deepSweSuiteDir(): string {
	return path.join(evalsPackageDir(), "suites", "deep-swe");
}

/** Arms configuration directory (packages/evals/arms). */
export function armsDir(): string {
	return path.join(evalsPackageDir(), "arms");
}

/** Curated task lists directory (packages/evals/datasets/deep-swe/tasks). */
export function taskListsDir(): string {
	return suiteDatasetDir("deep-swe", "tasks");
}

/** Task definitions corpus directory (packages/evals/datasets/deep-swe/corpus/tasks or corpus). */
export function taskCorpusDir(): string {
	const nested = suiteDatasetDir("deep-swe", "corpus", "tasks");
	if (fs.existsSync(nested)) return nested;
	return suiteDatasetDir("deep-swe", "corpus");
}

/** Dictionary datasets directory (packages/evals/datasets/dicts). */
export function dictsDir(): string {
	return path.join(datasetsDir(), "dicts");
}

/** Fixtures directory (packages/evals/datasets/deep-swe/fixtures). */
export function fixturesDir(): string {
	return suiteDatasetDir("deep-swe", "fixtures");
}

/** Python agent root (packages/evals/agents), the import root of the `common` package. */
export function agentsDir(): string {
	return path.join(evalsPackageDir(), "agents");
}

/** In-container Pier agents directory (packages/evals/agents/pier). */
export function pierAgentDir(): string {
	return path.join(agentsDir(), "pier");
}

/** Harbor agents directory (packages/evals/agents/harbor). */
export function harborAgentDir(): string {
	return path.join(agentsDir(), "harbor");
}

/** Default jobs directory for Harbor runs (runs/harbor at repository root). */
export function harborJobsDir(): string {
	return path.join(repoRootDir(), "runs", "harbor");
}

/** Cache directory for the evals package (packages/evals/.cache). */
export function cacheDir(): string {
	return path.join(evalsPackageDir(), ".cache");
}

/** Datasets directory shared by every suite (packages/evals/datasets). */
export function datasetsDir(): string {
	return path.join(evalsPackageDir(), "datasets");
}

/**
 * Committed dataset directory for one suite (packages/evals/datasets/<suite>/...).
 *
 * Every segment is validated, so a suite name or a dataset tag read from a config file or a CLI
 * flag cannot escape the datasets directory.
 */
export function suiteDatasetDir(suite: string, ...segments: readonly string[]): string {
	return path.join(datasetsDir(), requirePathSegment(suite, "suite name"), ...checkedSegments(segments));
}

/**
 * Downloaded or extracted dataset cache for one suite
 * (packages/evals/.cache/datasets/<suite>/...). Segments are validated as in `suiteDatasetDir`.
 */
export function suiteCacheDir(suite: string, ...segments: readonly string[]): string {
	return path.join(cacheDir(), "datasets", requirePathSegment(suite, "suite name"), ...checkedSegments(segments));
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
