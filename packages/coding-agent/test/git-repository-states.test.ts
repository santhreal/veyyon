import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as git from "@veyyon/coding-agent/utils/git";
import { removeWithRetries } from "@veyyon/utils";
import { useTrackedTempDirs } from "./helpers/tracked-temp-dir";

// Tracked temp directories: the factory deletes what it made when this file finishes.
// These call sites used a bare `mkdtempSync` with no teardown, so every run left the
// directory in `/tmp` forever. Cleanup is attached to creation so a new case cannot
// reintroduce the leak by forgetting an `afterAll`.
const makeGitStatesDir = useTrackedTempDirs("veyyon-git-states-");

/**
 * What veyyon reports for a repository that is part-way through something.
 *
 * A repository is not always sitting on a branch. It can be detached, midway
 * through a rebase, holding a conflicted merge, cherry-picking, reverting,
 * applying a mailbox, bisecting, bare, or freshly initialised with no commit at
 * all. Every one of those states is ordinary, and each one used to be described
 * by reading HEAD alone, which cannot see most of them.
 *
 * Two failures came out of that, and this suite exists to lock both out.
 *
 * A rebase DETACHES HEAD. So a user midway through rebasing `topic` saw the bare
 * word "detached": not the branch they were rebasing, and no hint that a rebase
 * was running at all. The information needed to say better was on disk the whole
 * time, in the rebase's own `head-name`.
 *
 * A merge does NOT move HEAD. So a conflicted merge looked exactly like an
 * ordinary checkout of the branch, while every command behaved differently.
 *
 * Every fixture below drives the real `git` binary into the real state rather
 * than writing marker files by hand. Hand-built fixtures would pin what this
 * suite BELIEVES git does, which is precisely the thing worth checking, and they
 * would keep passing after a change to git's on-disk layout that broke the
 * feature for real.
 */

const gitBin = (cwd: string, ...args: string[]): string =>
	execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();

/** Run a git command that is EXPECTED to fail, e.g. a conflicting merge. */
function gitExpectingFailure(cwd: string, ...args: string[]): void {
	try {
		gitBin(cwd, ...args);
	} catch {
		// The conflict is the point of the fixture.
	}
}

let root = "";

/** A repository with one commit on `main`, isolated from the user's git config. */
function newRepo(name: string): string {
	const dir = path.join(root, name);
	fs.mkdirSync(dir, { recursive: true });
	gitBin(dir, "init", "-q", "-b", "main");
	gitBin(dir, "config", "user.email", "test@example.invalid");
	gitBin(dir, "config", "user.name", "test");
	gitBin(dir, "config", "commit.gpgsign", "false");
	fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
	gitBin(dir, "add", "-A");
	gitBin(dir, "commit", "-qm", "first");
	return dir;
}

/**
 * Drive the repository into a conflicted rebase of `topic` onto `main`.
 * Both branches change the same line, so the rebase stops mid-flight.
 */
function repoMidRebase(name: string): string {
	const dir = newRepo(name);
	gitBin(dir, "checkout", "-q", "-b", "topic");
	fs.writeFileSync(path.join(dir, "a.txt"), "topic\n");
	gitBin(dir, "commit", "-qam", "topic");
	gitBin(dir, "checkout", "-q", "main");
	fs.writeFileSync(path.join(dir, "a.txt"), "trunk\n");
	gitBin(dir, "commit", "-qam", "trunk");
	gitBin(dir, "checkout", "-q", "topic");
	gitExpectingFailure(dir, "rebase", "main");
	return dir;
}

/** Drive the repository into a conflicted merge of `side` into `main`. */
function repoMidMerge(name: string): string {
	const dir = newRepo(name);
	gitBin(dir, "checkout", "-q", "-b", "side");
	fs.writeFileSync(path.join(dir, "a.txt"), "side\n");
	gitBin(dir, "commit", "-qam", "side");
	gitBin(dir, "checkout", "-q", "main");
	fs.writeFileSync(path.join(dir, "a.txt"), "trunk\n");
	gitBin(dir, "commit", "-qam", "trunk");
	gitExpectingFailure(dir, "merge", "side");
	return dir;
}

/** The label the status line would show for this directory. */
function labelFor(dir: string): string | null {
	const state = git.head.resolveSync(dir);
	if (!state) return null;
	return git.head.label(state, git.head.operation(state));
}

/** The branch a pull-request lookup would use for this directory. */
function lookupBranchFor(dir: string): string | null {
	const state = git.head.resolveSync(dir);
	if (!state) return null;
	return git.head.branchForLookup(state, git.head.operation(state));
}

beforeAll(() => {
	root = makeGitStatesDir();
});

afterAll(async () => {
	if (root) await removeWithRetries(root);
});

describe("an ordinary checkout", () => {
	/**
	 * The floor. Without it every assertion below could pass against an
	 * implementation that decorated every label, and the common case (which is
	 * almost every render) would be silently wrong.
	 */
	it("shows the branch name and nothing else", () => {
		const dir = newRepo("plain");

		expect(labelFor(dir)).toBe("main");
		expect(git.head.operation(git.head.resolveSync(dir)!)).toBeNull();
	});

	/** And it is a real branch, so a pull request can be looked up against it. */
	it("offers the branch for a pull request lookup", () => {
		const dir = newRepo("plain-lookup");

		expect(lookupBranchFor(dir)).toBe("main");
	});
});

describe("a detached HEAD", () => {
	/**
	 * Detached with nothing in progress is the one case where "detached" is the
	 * honest answer: there is no branch, and no operation that knows one.
	 */
	it("reads as detached", () => {
		const dir = newRepo("detached");
		gitBin(dir, "checkout", "-q", "--detach", "HEAD");

		expect(git.head.resolveSync(dir)?.kind).toBe("detached");
		expect(labelFor(dir)).toBe("detached");
	});

	/**
	 * And it must NOT be looked up as a branch. "detached" is not a ref, and a
	 * forge query against it either errors or, worse, matches something unrelated
	 * that a user genuinely named `detached`.
	 */
	it("offers no branch for a pull request lookup", () => {
		const dir = newRepo("detached-lookup");
		gitBin(dir, "checkout", "-q", "--detach", "HEAD");

		expect(lookupBranchFor(dir)).toBeNull();
	});
});

describe("a rebase in progress", () => {
	/**
	 * THE regression. A rebase detaches HEAD, so reading HEAD alone reports
	 * "detached" and loses both facts a user needs: which branch is being
	 * rebased, and that a rebase is what is happening. git records the branch in
	 * the rebase's own state directory, so the information was always available.
	 */
	it("names the branch being rebased and says a rebase is running", () => {
		const dir = repoMidRebase("rebasing");

		// The precondition, asserted so a fixture that silently stopped producing a
		// conflict cannot let this pass for the wrong reason.
		expect(git.head.resolveSync(dir)?.kind).toBe("detached");

		expect(labelFor(dir)).toBe("topic|REBASE");
	});

	/** The operation is reported structurally, not only as a rendered string. */
	it("reports the operation as a rebase carrying the branch", () => {
		const dir = repoMidRebase("rebasing-structured");

		expect(git.head.operation(git.head.resolveSync(dir)!)).toEqual({ branch: "topic", kind: "rebase" });
	});

	/**
	 * No pull request lookup mid-rebase. A branch being rebased does not yet
	 * point where it is going to, so a pull request fetched against it describes
	 * a state that is about to be replaced.
	 */
	it("offers no branch for a pull request lookup", () => {
		const dir = repoMidRebase("rebasing-lookup");

		expect(lookupBranchFor(dir)).toBeNull();
	});

	/**
	 * Aborting returns the repository to an ordinary checkout, which proves the
	 * detection is reading live state rather than a marker that is written once
	 * and never cleaned up. A stale REBASE suffix that never cleared would be
	 * worse than no suffix at all.
	 */
	it("goes back to a plain branch label once the rebase is aborted", () => {
		const dir = repoMidRebase("rebasing-aborted");
		expect(labelFor(dir)).toBe("topic|REBASE");

		gitBin(dir, "rebase", "--abort");

		expect(labelFor(dir)).toBe("topic");
		expect(lookupBranchFor(dir)).toBe("topic");
	});
});

describe("a merge in progress", () => {
	/**
	 * A merge leaves HEAD on its branch, so this state was completely invisible:
	 * the label was identical to an ordinary checkout of `main` while the working
	 * tree held conflict markers and commands behaved differently.
	 */
	it("keeps the branch and says a merge is running", () => {
		const dir = repoMidMerge("merging");

		// The precondition: HEAD really has not moved, which is why HEAD alone
		// could never have detected this.
		expect(git.head.resolveSync(dir)?.kind).toBe("ref");

		expect(labelFor(dir)).toBe("main|MERGE");
	});

	/** Cleared once the merge is resolved, same liveness argument as the rebase. */
	it("goes back to a plain branch label once the merge is aborted", () => {
		const dir = repoMidMerge("merging-aborted");
		expect(labelFor(dir)).toBe("main|MERGE");

		gitBin(dir, "merge", "--abort");

		expect(labelFor(dir)).toBe("main");
	});
});

describe("other multi-step operations", () => {
	/**
	 * A conflicted cherry-pick. Reported distinctly from a merge because the way
	 * out differs: `git cherry-pick --abort`, not `git merge --abort`. A label
	 * that named the wrong operation would send the user to a command that does
	 * not apply.
	 */
	it("reports a cherry-pick", () => {
		const dir = newRepo("cherry-picking");
		gitBin(dir, "checkout", "-q", "-b", "side");
		fs.writeFileSync(path.join(dir, "a.txt"), "side\n");
		gitBin(dir, "commit", "-qam", "side");
		gitBin(dir, "checkout", "-q", "main");
		fs.writeFileSync(path.join(dir, "a.txt"), "trunk\n");
		gitBin(dir, "commit", "-qam", "trunk");
		gitExpectingFailure(dir, "cherry-pick", "side");

		expect(labelFor(dir)).toBe("main|CHERRY-PICK");
	});

	/** A conflicted revert, distinct again for the same reason. */
	it("reports a revert", () => {
		const dir = newRepo("reverting");
		fs.writeFileSync(path.join(dir, "a.txt"), "second\n");
		gitBin(dir, "commit", "-qam", "second");
		fs.writeFileSync(path.join(dir, "a.txt"), "third\n");
		gitBin(dir, "commit", "-qam", "third");
		gitExpectingFailure(dir, "revert", "HEAD~1");

		expect(labelFor(dir)).toBe("main|REVERT");
	});

	/**
	 * A bisect. HEAD is detached at whatever commit is being tested, and without
	 * the operation the label would read "detached" for what is a deliberate,
	 * ongoing search the user is steering.
	 */
	it("reports a bisect", () => {
		const dir = newRepo("bisecting");
		fs.writeFileSync(path.join(dir, "a.txt"), "second\n");
		gitBin(dir, "commit", "-qam", "second");
		fs.writeFileSync(path.join(dir, "a.txt"), "third\n");
		gitBin(dir, "commit", "-qam", "third");
		gitBin(dir, "bisect", "start");
		gitBin(dir, "bisect", "bad", "HEAD");
		gitBin(dir, "bisect", "good", "HEAD~2");

		expect(git.head.operation(git.head.resolveSync(dir)!)?.kind).toBe("bisect");
		expect(labelFor(dir)).toContain("|BISECT");
	});
});

describe("repositories with no ordinary branch state", () => {
	/**
	 * A bare repository has no working tree. It must not crash and must not claim
	 * a branch; the resolver reporting nothing is what lets the status line omit
	 * the segment rather than render something false.
	 */
	it("returns nothing for a bare repository rather than throwing", () => {
		const dir = path.join(root, "bare.git");
		fs.mkdirSync(dir, { recursive: true });
		gitBin(dir, "init", "-q", "--bare", "-b", "main");

		expect(git.head.resolveSync(dir)).toBeNull();
		expect(labelFor(dir)).toBeNull();
	});

	/**
	 * A freshly initialised repository points HEAD at a branch that does not
	 * exist yet. The branch name is real and worth showing; what must not happen
	 * is a crash or a claim to a commit.
	 */
	it("names the unborn branch and reports no commit", () => {
		const dir = path.join(root, "unborn");
		fs.mkdirSync(dir, { recursive: true });
		gitBin(dir, "init", "-q", "-b", "main");

		const state = git.head.resolveSync(dir);
		expect(state?.kind).toBe("ref");
		expect(state && "branchName" in state ? state.branchName : undefined).toBe("main");
		expect(state?.commit).toBeNull();
		expect(labelFor(dir)).toBe("main");
	});

	/** A plain directory is not a repository, and asking must be cheap and quiet. */
	it("returns nothing outside a repository", () => {
		const dir = path.join(root, "notrepo");
		fs.mkdirSync(dir, { recursive: true });

		expect(git.head.resolveSync(dir)).toBeNull();
		expect(labelFor(dir)).toBeNull();
	});
});

describe("label composition", () => {
	/**
	 * The rule stated directly on the owner, so a regression is diagnosed here
	 * rather than through a git fixture. HEAD's own branch wins when it has one:
	 * mid-merge, HEAD is authoritative and the operation records nothing, and a
	 * recorded name must never override a live HEAD.
	 */
	it("prefers HEAD's branch over the operation's recorded one", () => {
		const state = { branchName: "live", kind: "ref", ref: "refs/heads/live" } as never;

		expect(git.head.label(state, { branch: "recorded", kind: "rebase" })).toBe("live|REBASE");
	});

	/**
	 * And falls back to the recorded branch only when HEAD cannot supply one,
	 * which is exactly the detached-during-rebase case this work fixed.
	 */
	it("falls back to the operation's branch when HEAD is detached", () => {
		const state = { kind: "detached" } as never;

		expect(git.head.label(state, { branch: "recorded", kind: "rebase" })).toBe("recorded|REBASE");
	});

	/**
	 * A rebase of an already-detached HEAD records no branch, so there is nothing
	 * to fall back to and the label must still be readable rather than showing an
	 * empty name or the word "null".
	 */
	it("stays readable when neither HEAD nor the operation names a branch", () => {
		const state = { kind: "detached" } as never;

		expect(git.head.label(state, { branch: null, kind: "rebase" })).toBe("detached|REBASE");
	});
});
