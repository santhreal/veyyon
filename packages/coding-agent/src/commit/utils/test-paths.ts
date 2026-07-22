/**
 * Canonical "is this a test file?" predicate for commit analysis.
 *
 * This is the single owner of the rule that two commit heuristics share: the
 * fallback commit-type inference (`commit/agentic/fallback.ts`) and the git diff
 * prioritizer (`commit/agentic/tools/git-file-diff.ts`). Both previously inlined
 * the same `["/test/", "/tests/", "/__tests__/", "_test.", ".test.", ".spec.",
 * "_spec."]` list and the same `.some(p => path.includes(p))` check, so the two
 * could drift and both carried the same blind spot.
 *
 * A path is a test file when either:
 *   - one of its DIRECTORY segments is exactly `test`, `tests`, or `__tests__`,
 *     at ANY depth including the top level, or
 *   - its name carries a test marker: `_test.`, `.test.`, `.spec.`, `_spec.`.
 *
 * Matching directories by whole segment (rather than a `"/tests/"` substring)
 * fixes two things at once: a top-level `tests/foo.go` now counts as a test
 * (the old leading-slash pattern only matched nested `a/tests/foo.go`), and a
 * directory that merely ends in `tests`, such as `latests/`, does not.
 */

const TEST_DIR_SEGMENTS: ReadonlySet<string> = new Set(["test", "tests", "__tests__"]);
const TEST_FILENAME_MARKERS = ["_test.", ".test.", ".spec.", "_spec."] as const;

/** True when `filePath` looks like a test file by its directory or its name. */
export function isTestFilePath(filePath: string): boolean {
	const lower = filePath.toLowerCase();
	const segments = lower.split("/");
	// Every segment except the last is a directory component.
	for (let i = 0; i < segments.length - 1; i++) {
		const segment = segments[i];
		if (segment && TEST_DIR_SEGMENTS.has(segment)) return true;
	}
	return TEST_FILENAME_MARKERS.some(marker => lower.includes(marker));
}
