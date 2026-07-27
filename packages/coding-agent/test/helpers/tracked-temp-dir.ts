import { afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { removeSyncWithRetries } from "@veyyon/utils";

/**
 * A temp-directory factory that deletes what it made when the file finishes.
 *
 * WHY THIS EXISTS. Forty-seven suites called `mkdtempSync` and registered no
 * cleanup, and thirteen of those hand a temp directory to a SPAWNED CLI as its
 * HOME. The CLI writes a whole config root under the home it is given, so one
 * abandoned run of one of those was about 289MB. Measured on a developer machine
 * on 2026-07-26: 3,265 leaked directories, 34GB, in `/tmp`, growing at roughly
 * that rate per week until the disk filled.
 *
 * The reason it went unnoticed for so long is worth stating, because it decides
 * where the fix belongs. CI hands each process a disposable HOME and then destroys
 * the container, so a leaked temp directory costs nothing there and no gate in
 * this repository can see it. The cost lands only on the machine of whoever runs
 * `bun test` while working. So the cleanup cannot be a convention anybody has to
 * remember, and it cannot be a CI check: it has to be attached to the act of
 * making the directory, which is what this does.
 *
 * `useTrackedTempDirs` calls `afterAll` itself, at the importing file's module
 * scope, so a suite adopts it by replacing its `mkdtempSync` call and nothing
 * else. There is no cleanup step for a suite to forget, and no ordering for it to
 * get wrong.
 *
 * @example
 * const makeHome = useTrackedTempDirs("veyyon-agents-home-");
 * // then, in a test or a spawn helper:
 * const home = makeHome();
 */
export function useTrackedTempDirs(prefix: string): () => string {
	const make = useTrackedTempDirFactory();
	return () => make(prefix);
}

/**
 * The same tracking, for a suite that picks the prefix per call.
 *
 * A few suites name each directory after the case that made it, so the prefix is an
 * argument rather than a constant. They get this instead of hand-rolling a second
 * `afterAll`, so there stays exactly one implementation of "make a temp dir and
 * delete it later" for the whole test tree.
 *
 * @example
 * const makeTempDir = useTrackedTempDirFactory();
 * const cwd = makeTempDir("veyyon-plugin-dir-cwd-");
 */
export function useTrackedTempDirFactory(): (prefix: string) => string {
	const made: string[] = [];

	afterAll(() => {
		// `removeSyncWithRetries` rather than `rmSync`, because a spawned CLI may still
		// be releasing file handles under the directory when the suite ends; a bare
		// unlink loses that race on Windows and intermittently on a loaded Linux box.
		for (const dir of made) removeSyncWithRetries(dir);
		made.length = 0;
	});

	return (prefix: string) => {
		const dir = mkdtempSync(path.join(tmpdir(), prefix));
		made.push(dir);
		return dir;
	};
}
