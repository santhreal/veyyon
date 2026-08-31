/**
 * WHY: `terminalBenchDatasetDir(tag)` joined a dataset tag straight into the cache directory, so a
 * tag read from a CLI flag, a config file or a run record could contain `../..` and place an
 * extraction anywhere the process could write. The same module also declared a bespoke path getter
 * per suite, so adding a suite meant editing shared layout code.
 *
 * The class this closes: every dynamic component joined into an evals directory. `suiteDatasetDir`
 * and `suiteCacheDir` are the only shapes, `requirePathSegment` is the only validator, and the
 * sweep below drives a table of hostile segments through every public entry point that accepts one.
 * A new entry point that skips the validator turns the suite red once it is added to `ACCEPTORS`.
 *
 * What it does not catch: a caller that builds a path with `path.join` by hand instead of using
 * these helpers, and permissions on the directories themselves.
 */
import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import {
	cacheDir,
	datasetsDir,
	evalsPackageDir,
	requirePathSegment,
	suiteCacheDir,
	suiteDatasetDir,
	UnsafePathSegmentError,
} from "../../engine/package-paths";
import {
	TERMINAL_BENCH_SUITE_NAME,
	terminalBenchDatasetDir,
	terminalBenchTaskListsDir,
} from "../../suites/terminal-bench/paths";
import {
	TYPESCRIPT_EDIT_SUITE_NAME,
	typescriptEditCacheDir,
	typescriptEditFixturesArchive,
	typescriptEditFixturesArchiveRelative,
} from "../../suites/typescript-edit/paths";

/** Segments that must be rejected wherever a dynamic path component is accepted. */
const HOSTILE_SEGMENTS = ["..", ".", "", " ", "../../etc", "a/b", "a\\b", "v3.0.0 ", " v3.0.0", "tag\0null"] as const;

/** Every public entry point that accepts a dynamic path segment. */
const ACCEPTORS: readonly { readonly name: string; readonly call: (segment: string) => string }[] = [
	{ name: "suiteDatasetDir(suite)", call: segment => suiteDatasetDir(segment) },
	{ name: "suiteDatasetDir(suite, segment)", call: segment => suiteDatasetDir("demo", segment) },
	{ name: "suiteCacheDir(suite)", call: segment => suiteCacheDir(segment) },
	{ name: "suiteCacheDir(suite, segment)", call: segment => suiteCacheDir("demo", segment) },
	{ name: "terminalBenchDatasetDir(tag)", call: segment => terminalBenchDatasetDir(segment) },
];

describe("a dataset path segment cannot escape its directory", () => {
	test("every entry point rejects every hostile segment by name", () => {
		for (const acceptor of ACCEPTORS) {
			for (const segment of HOSTILE_SEGMENTS) {
				let thrown: unknown = null;
				try {
					acceptor.call(segment);
				} catch (err) {
					thrown = err;
				}
				expect(thrown, `${acceptor.name} accepted ${JSON.stringify(segment)}`).toBeInstanceOf(
					UnsafePathSegmentError,
				);
				expect((thrown as UnsafePathSegmentError).segment).toBe(segment);
			}
		}
	});

	test("a rejected segment names what it was and what a segment may be", () => {
		expect(() => suiteCacheDir("terminal-bench", "../../evil")).toThrow(
			/Unsafe path segment "\.\.\/\.\.\/evil".*single name.*"\.\."/s,
		);
		expect(() => suiteDatasetDir("../secrets")).toThrow(/Unsafe suite name/);
	});

	test("a valid segment is returned unchanged and stays inside its root", () => {
		expect(requirePathSegment("v3.0.0", "tag")).toBe("v3.0.0");
		const dir = suiteCacheDir("terminal-bench", "v3.0.0");
		expect(dir).toBe(path.join(cacheDir(), "datasets", "terminal-bench", "v3.0.0"));
		expect(path.relative(cacheDir(), dir).startsWith("..")).toBe(false);
	});

	test("the datasets root is inside the package and shared by every suite", () => {
		expect(datasetsDir()).toBe(path.join(evalsPackageDir(), "datasets"));
		expect(suiteDatasetDir("demo", "tasks")).toBe(path.join(datasetsDir(), "demo", "tasks"));
	});

	test("each suite derives its own paths from one declared suite name", () => {
		expect(terminalBenchTaskListsDir()).toBe(path.join(datasetsDir(), TERMINAL_BENCH_SUITE_NAME, "tasks"));
		expect(terminalBenchDatasetDir("v3.0.0")).toBe(
			path.join(cacheDir(), "datasets", TERMINAL_BENCH_SUITE_NAME, "v3.0.0"),
		);
		expect(typescriptEditCacheDir()).toBe(path.join(cacheDir(), "datasets", TYPESCRIPT_EDIT_SUITE_NAME));
		expect(typescriptEditFixturesArchive()).toBe(
			path.join(datasetsDir(), TYPESCRIPT_EDIT_SUITE_NAME, "fixtures.tar.gz"),
		);
	});

	test("the archive path recorded in provenance is package-relative and slash-separated", () => {
		const relative = typescriptEditFixturesArchiveRelative();
		expect(relative).toBe("datasets/typescript-edit/fixtures.tar.gz");
		expect(path.posix.isAbsolute(relative)).toBe(false);
		expect(path.resolve(evalsPackageDir(), relative)).toBe(typescriptEditFixturesArchive());
	});
});
