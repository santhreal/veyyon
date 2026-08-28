/** Canonical "is this a test file?" predicate for commit analysis. This is the single owner of the rule that two commit heuristics share: the */

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
