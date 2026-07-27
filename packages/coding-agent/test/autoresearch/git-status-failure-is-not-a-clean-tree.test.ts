/**
 * A git status autoresearch cannot read must never be reported as a clean worktree.
 *
 * WHY THIS SUITE EXISTS. `tryGitStatus` answered any git failure with `""`, and `""` parses to "no paths
 * are dirty". Three separate things acted on that, each producing a statement that was not merely
 * incomplete but FALSE:
 *
 *   1. A `discard` computed the files to revert from it, found none, and returned "nothing to revert" --
 *      while the experiment's changes sat in the worktree. A discard that reports success and reverts
 *      nothing is the one outcome that loses the user's baseline.
 *   2. `log_experiment` recorded the run's modified paths as empty, so the scope-deviation check compared
 *      nothing against `off_limits` and passed vacuously: an experiment that touched a forbidden file was
 *      logged as having stayed inside its scope.
 *   3. `run_experiment` recorded the PRE-RUN dirty set as empty, which claims the tree was clean before
 *      the run, so every file the user already had uncommitted would later be attributed to the
 *      experiment and reverted along with it.
 *
 * The probes now propagate, and every caller has an error channel it already used for other git failures.
 * What this suite pins is the pair of answers that must stay distinct: a cwd OUTSIDE a repository is
 * answered with `""`, because there genuinely are no tracked changes and autoresearch is allowed to run
 * there, while a cwd inside a repository whose git invocation fails raises. Those two were the same
 * `""` before, and the first is why the swallow looked reasonable.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { gitStatusPorcelain, gitWorkDirPrefix } from "@veyyon/coding-agent/autoresearch/helpers";
import { $ } from "bun";

let dir: string;

beforeEach(async () => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-autoresearch-status-"));
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

/** Turn the fixture directory into a repository with one commit, which is the shape every caller expects. */
async function initRepo(at: string = dir): Promise<void> {
	fs.writeFileSync(path.join(at, "tracked.txt"), "baseline\n");
	await $`git init --initial-branch=main && git config user.email t@example.com && git config user.name T && git add -A && git commit -m baseline`
		.cwd(at)
		.quiet();
}

describe("a working tree that can be read", () => {
	/** The ordinary clean case: an empty status is the true answer and must not be confused with a failure. */
	it("answers an empty status for a clean repository", async () => {
		await initRepo();

		expect(await gitStatusPorcelain(dir)).toBe("");
	});

	/**
	 * A dirty tree has to come back with the real porcelain bytes, since every caller parses paths out of
	 * them. Asserted on content rather than on being non-empty, because "some output" is exactly what the
	 * old swallow could never be distinguished from.
	 */
	it("reports the modified and untracked paths", async () => {
		await initRepo();
		fs.writeFileSync(path.join(dir, "tracked.txt"), "changed\n");
		fs.writeFileSync(path.join(dir, "new.txt"), "added\n");

		const status = await gitStatusPorcelain(dir);

		expect(status).toContain("tracked.txt");
		expect(status).toContain("new.txt");
		// `-z` output is NUL separated, which is what the path parser splits on.
		expect(status).toContain("\0");
	});

	/** The prefix of the repository root is empty, and that is a real value the callers depend on. */
	it("answers an empty prefix at the repository root", async () => {
		await initRepo();

		expect(await gitWorkDirPrefix(dir)).toBe("");
	});

	/**
	 * From a subdirectory the prefix is that subdirectory, with a trailing slash. This is the value that
	 * makes status paths relative to the work directory, so an empty answer here would resolve every path
	 * against the wrong directory -- which is precisely what the old swallow did on failure.
	 */
	it("answers the subdirectory prefix from inside the tree", async () => {
		await initRepo();
		fs.mkdirSync(path.join(dir, "nested"));

		expect(await gitWorkDirPrefix(path.join(dir, "nested"))).toBe("nested/");
	});
});

describe("a directory that is not a repository", () => {
	/**
	 * The one case answered rather than raised, and the reason the swallow looked reasonable: autoresearch
	 * may run outside a repository, and then there truly are no tracked changes. It is decided by resolving
	 * the repository, a walk up the directory chain with no subprocess, so it is never confused with a
	 * `git status` that failed for some other reason.
	 */
	it("answers an empty status and prefix rather than raising", async () => {
		expect(await gitStatusPorcelain(dir)).toBe("");
		expect(await gitWorkDirPrefix(dir)).toBe("");
	});

	/**
	 * A directory that does not exist at all takes the same path: there is no repository above it either,
	 * and a cwd can be removed while a session is open.
	 */
	it("answers empty for a directory that has been removed", async () => {
		const gone = path.join(dir, "removed");

		expect(await gitStatusPorcelain(gone)).toBe("");
		expect(await gitWorkDirPrefix(gone)).toBe("");
	});
});

describe("a repository whose git invocation fails", () => {
	/**
	 * The regression this suite exists for. The repository is real -- `.git` is right there, so the
	 * not-a-repository shortcut above does not apply -- but git cannot complete the command. Before, this
	 * came back as `""` and every caller read it as a clean tree; now it raises, and the callers turn it
	 * into the error they already had a channel for.
	 *
	 * The failure is provoked by making `.git` unreadable, so the mode bits do the work rather than a
	 * mocked git. Permission bits do not bind root, so the root case is asserted honestly instead of
	 * skipped: there the command genuinely succeeds and an empty status is correct.
	 */
	it("raises instead of answering an empty status", async () => {
		await initRepo();
		const gitDir = path.join(dir, ".git");
		fs.chmodSync(gitDir, 0o000);

		let readableAsRoot = false;
		try {
			fs.readdirSync(gitDir);
			readableAsRoot = true;
		} catch {
			readableAsRoot = false;
		}

		try {
			if (readableAsRoot) {
				// Running as root: git can still read the repository, so there is no failure to report.
				expect(await gitStatusPorcelain(dir)).toBe("");
			} else {
				expect(gitStatusPorcelain(dir)).rejects.toThrow();
			}
		} finally {
			fs.chmodSync(gitDir, 0o755);
		}
	});

	/**
	 * A `.git` FILE pointing at a git directory that is gone -- the shape a worktree or submodule uses, and
	 * a stale link is common after moving a checkout -- is NOT one of these failures, which was written as
	 * one first and turned out otherwise.
	 *
	 * Repository resolution is the one owner of "is this a repository", and for an unresolvable link it
	 * answers no, so this takes the not-a-repository path and comes back empty. That is safe here rather
	 * than another false "clean tree", because the same resolution gates everything else: autoresearch
	 * cannot name a branch for this directory, so it finds no session, and nothing is logged or reverted
	 * against it at all. Pinned so the behaviour is a recorded decision rather than a surprise.
	 */
	it("treats a .git file pointing at a directory that is gone as not a repository", async () => {
		fs.writeFileSync(path.join(dir, ".git"), `gitdir: ${path.join(dir, "no-such-git-dir")}\n`);
		fs.writeFileSync(path.join(dir, "tracked.txt"), "x\n");

		expect(await gitStatusPorcelain(dir)).toBe("");
	});
});
