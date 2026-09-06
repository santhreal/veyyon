import { afterAll, beforeAll } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { getProjectDir, removeSyncWithRetries, setProjectDir } from "@veyyon/utils";

/**
 * A checkout the suite owns, for the rows that read the project directory.
 *
 * WHY THIS EXISTS. The launch card renders the branch and the path from
 * `getProjectDir()` alone — no session, no injected cwd — so a suite asserting
 * on those bytes was asserting about the directory the test run happened to
 * start in. Two properties of that directory decide the outcome and neither is
 * a property of the code:
 *
 *  - Whether HEAD names a branch. A `pull_request` checkout is detached at the
 *    merge commit, so `branchLabelFromFiles` answers `null` there and every
 *    branch assertion fails on the pull-request run of a suite that is green on
 *    a push to the default branch.
 *  - How long the path is. A path shorter than the preset's `maxLength` is
 *    rendered whole, which turns "the location is clipped to the budget" into a
 *    claim about the checkout's own depth: red inside a short root such as a
 *    container's `/srv/<name>`, vacuously green in a deep worktree.
 *
 * The fixture supplies both: `.git/HEAD` naming a branch this file chose, and a
 * project directory nested deep enough to exceed any preset path budget. The
 * production read path stays real — `branchLabelFromFiles` walks up from the
 * project directory and parses `.git/HEAD` off disk, exactly as it does in a
 * checkout — because the only thing replaced is which directory the process
 * stands in.
 *
 * Call it once at the top level of a suite file, above the file's own
 * `beforeAll`, so the project directory has moved before anything reads it.
 */
export interface FixtureCheckout {
	/** The project directory, valid from the first `beforeAll` onwards. */
	dir(): string;
	/** The branch `.git/HEAD` names, which is what a row renders. */
	branch: string;
}

/**
 * @param options.branch The branch `.git/HEAD` names.
 * @param options.nested Directories below the checkout root to stand in. Each one
 *   lengthens the project path, which is what makes a clipping assertion mean
 *   something; omitted, the project directory is the checkout root itself.
 */
export function useFixtureCheckout(options: { branch: string; nested?: readonly string[] }): FixtureCheckout {
	const nested = options.nested ?? [];
	let root: string | undefined;
	let leaf = "";
	let original = "";

	beforeAll(() => {
		original = getProjectDir();
		root = mkdtempSync(path.join(tmpdir(), "veyyon-fixture-checkout-"));
		// `.git` at the root with the project directory below it, so the branch is found
		// by the same upward walk a real checkout needs rather than by a lucky sibling.
		mkdirSync(path.join(root, ".git"), { recursive: true });
		writeFileSync(path.join(root, ".git", "HEAD"), `ref: refs/heads/${options.branch}\n`);
		leaf = nested.length > 0 ? path.join(root, ...nested) : root;
		mkdirSync(leaf, { recursive: true });
		setProjectDir(leaf);
	});

	afterAll(() => {
		// The project directory is also the process working directory, so it moves back
		// before the tree is deleted: a process cannot be standing in what it unlinks.
		if (original) setProjectDir(original);
		if (root) removeSyncWithRetries(root);
		root = undefined;
	});

	return { branch: options.branch, dir: () => leaf };
}
