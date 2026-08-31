/**
 * Points every home-derived mnemopi root at a temp directory, for the whole test
 * process, before any suite runs.
 *
 * ## Why this exists
 *
 * `mnemopiHome()` is the one lever over `.hermes` (data dir, blob store, plugin
 * dir, model cache, embedding cache) and over `.mnemopi` (the cost log), and
 * `useMnemopiTestEnv()` sets it — in the 18 of 109 suites that call the helper.
 * The other 91 run with whatever the process was started with, which on a
 * developer machine and on a CI runner is the real home. `useMnemopiTestEnv()`'s
 * `afterAll` lists the home before and after and fails when a root appears, and
 * that is how it showed up: `Test TS workspace fast` went red with
 *
 *     expect(homeRootsAMnemopiRunCouldCreate()).toEqual(rootsBefore)
 *     +   ".hermes",
 *         ".veyyon",
 *
 * reported by a suite that had isolated itself correctly. Under `--parallel`,
 * the file that creates the directory and the file that observes it are
 * different processes, so the guard names a witness rather than a culprit and
 * the failure moves between runs.
 *
 * A preload rather than a helper, for the same reason the fastembed tripwire is
 * one: nothing opts in and nothing can forget to call it. The helper-shaped
 * version of this guard has been in the tree for months and covers a sixth of
 * the package.
 *
 * ## What it does not cover
 *
 * Code that reads `os.homedir()` directly instead of resolving through
 * `mnemopiHome()`. That is a different defect with its own suite
 * (`home-derived-roots-answer-to-one-lever.test.ts`, which sweeps the resolvers
 * and refuses one that answers with a home path), and the `afterAll` guard stays
 * exactly as sharp for it: this moves the roots a resolver WOULD produce, so
 * anything still landing in the home is a resolver ignoring the lever.
 *
 * An explicit `MNEMOPI_HOME` in the environment wins: a suite that sets its own
 * home, and the operator debugging against a real one, both mean it.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.MNEMOPI_HOME) {
	const root = mkdtempSync(join(tmpdir(), "mnemopi-test-home-"));
	process.env.MNEMOPI_HOME = root;
	process.on("exit", () => {
		rmSync(root, { recursive: true, force: true });
	});
}

/**
 * The one entry a mnemopi suite creates in the shared home on purpose.
 *
 * `the-config-root-never-lands-in-the-home.test.ts` creates it, asserts the
 * detector reports it, and removes it inside a single test body. Every test
 * process resolves the same `os.homedir()`, so under `--parallel` another
 * file's `beforeAll` can snapshot the home while this marker exists, and that
 * file's `afterAll` then reports a root that disappeared underneath it —
 * naming a witness rather than a culprit, and moving between runs.
 *
 * The cross-file snapshot therefore skips this exact name. It is one fixed
 * literal with one creator, so skipping it leaves the guard sharp for every
 * other `.veyyon*`, `.hermes` and `.mnemopi` entry, which is what it exists to
 * catch. The control suite's own detector does NOT skip it: reporting it is
 * that suite's assertion.
 */
export const DELIBERATE_HOME_CONTROL_ROOT = ".veyyon-mnemopi-config-root-control";
