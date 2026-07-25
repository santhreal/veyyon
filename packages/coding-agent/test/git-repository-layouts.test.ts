import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as git from "@veyyon/coding-agent/utils/git";
import { removeWithRetries } from "@veyyon/utils";

/**
 * Which repository am I in, when the answer is not obvious?
 *
 * A checkout is usually one working tree beside one `.git` directory, and every
 * path question has a boring answer. Two ordinary layouts break that assumption,
 * and both are layouts people work in daily:
 *
 * A LINKED WORKTREE has its own working tree and its own HEAD, but its git
 * directory lives inside the primary checkout, under
 * `<primary>/.git/worktrees/<name>`. Resolving to the primary checkout's root
 * would attribute every file to the wrong tree, and reading the primary's HEAD
 * would report the wrong branch entirely, since the whole point of a worktree is
 * to be on a different one.
 *
 * A SUBMODULE'S `.git` is a FILE, not a directory: a `gitdir:` pointer into
 * `<super>/.git/modules/<path>`. Code that tests for a `.git` directory walks
 * straight past a submodule and reports the superproject, so editing inside a
 * submodule would show the parent's branch and stage against the parent's index.
 *
 * These resolve correctly today. This suite exists because nothing proved it:
 * both failures are silent, both produce a plausible-looking wrong answer rather
 * than an error, and the existing worktree coverage exercised only
 * `repo.linkedWorktreeSync` rather than the head and root resolution every
 * caller actually goes through.
 *
 * Fixtures drive the real `git` binary. A hand-written `gitdir:` file would pin
 * what this suite believes git's layout is, which is the thing under test.
 */

const gitBin = (cwd: string, ...args: string[]): string =>
	execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();

let root = "";

function newRepo(name: string, file = "a.txt"): string {
	const dir = path.join(root, name);
	fs.mkdirSync(dir, { recursive: true });
	gitBin(dir, "init", "-q", "-b", "main");
	gitBin(dir, "config", "user.email", "test@example.invalid");
	gitBin(dir, "config", "user.name", "test");
	gitBin(dir, "config", "commit.gpgsign", "false");
	fs.writeFileSync(path.join(dir, file), "one\n");
	gitBin(dir, "add", "-A");
	gitBin(dir, "commit", "-qm", "first");
	return dir;
}

function stateOf(dir: string) {
	const state = git.head.resolveSync(dir);
	if (!state) throw new Error(`expected a repository at ${dir}`);
	return state;
}

function labelOf(dir: string): string {
	const state = stateOf(dir);
	return git.head.label(state, git.head.operation(state));
}

beforeAll(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-git-layouts-"));
});

afterAll(async () => {
	if (root) await removeWithRetries(root);
});

describe("a linked worktree", () => {
	let primary = "";
	let worktree = "";

	beforeAll(() => {
		primary = newRepo("primary");
		gitBin(primary, "branch", "feature");
		worktree = path.join(root, "wt-feature");
		gitBin(primary, "worktree", "add", "-q", worktree, "feature");
	});

	/**
	 * The root must be the WORKTREE's own directory. Returning the primary
	 * checkout would attribute every edited file to a tree it is not in, which is
	 * silent: paths still exist there, they are just the wrong copies.
	 */
	it("resolves to its own root, not the primary checkout's", () => {
		expect(stateOf(worktree).repoRoot).toBe(fs.realpathSync(worktree));
		expect(stateOf(primary).repoRoot).toBe(fs.realpathSync(primary));
	});

	/**
	 * Its git directory lives INSIDE the primary checkout. Asserted explicitly
	 * because it is the surprising part of the layout, and because the operation
	 * detection reads marker files from exactly this directory.
	 */
	it("uses a git directory nested in the primary checkout", () => {
		const gitDir = stateOf(worktree).gitDir;

		expect(gitDir).toBe(path.join(fs.realpathSync(primary), ".git", "worktrees", "wt-feature"));
	});

	/**
	 * Each tree reports ITS OWN branch. This is the entire reason worktrees
	 * exist, so reading the primary's HEAD here would make the feature useless
	 * while looking perfectly reasonable.
	 */
	it("reports its own branch, independent of the primary checkout", () => {
		expect(labelOf(worktree)).toBe("feature");
		expect(labelOf(primary)).toBe("main");
	});

	/** Resolution walks up from a nested directory, as every real cwd is. */
	it("resolves from a nested subdirectory of the worktree", () => {
		const deep = path.join(worktree, "sub", "deep");
		fs.mkdirSync(deep, { recursive: true });

		expect(stateOf(deep).repoRoot).toBe(fs.realpathSync(worktree));
		expect(labelOf(deep)).toBe("feature");
	});
});

describe("an operation running in one worktree", () => {
	/**
	 * A rebase in a linked worktree must be visible THERE and invisible in the
	 * primary checkout. The marker files live in the per-worktree git directory,
	 * so reading them from the shared common directory instead would report a
	 * rebase in a tree that is sitting still, and tell the user in the rebasing
	 * tree nothing at all.
	 */
	it("is reported only in the worktree that is running it", () => {
		const primary = newRepo("op-primary");
		gitBin(primary, "branch", "topic");
		const worktree = path.join(root, "op-wt");
		gitBin(primary, "worktree", "add", "-q", worktree, "topic");

		fs.writeFileSync(path.join(worktree, "a.txt"), "topic\n");
		gitBin(worktree, "commit", "-qam", "topic");
		fs.writeFileSync(path.join(primary, "a.txt"), "trunk\n");
		gitBin(primary, "commit", "-qam", "trunk");
		try {
			gitBin(worktree, "rebase", "main");
		} catch {
			// The conflict is the fixture.
		}

		expect(labelOf(worktree)).toBe("topic|REBASE");
		expect(git.head.operation(stateOf(worktree))?.kind).toBe("rebase");

		// The primary checkout is untouched and must say so.
		expect(labelOf(primary)).toBe("main");
		expect(git.head.operation(stateOf(primary))).toBeNull();
	});
});

describe("a submodule", () => {
	let superproject = "";
	let submodule = "";

	beforeAll(() => {
		const dependency = newRepo("dependency", "lib.txt");
		superproject = newRepo("superproject");
		// `protocol.file.allow` is passed per-command: git refuses file-transport
		// clones by default (CVE-2022-39253), and a submodule add runs a clone.
		gitBin(superproject, "-c", "protocol.file.allow=always", "submodule", "--quiet", "add", dependency, "vendor/lib");
		gitBin(superproject, "commit", "-qm", "add submodule");
		submodule = path.join(superproject, "vendor", "lib");
	});

	/**
	 * The precondition that makes this layout tricky, asserted so the rest of the
	 * suite cannot pass against a git that stopped using the pointer file. If
	 * `.git` were a directory here, none of the checks below would be testing
	 * anything.
	 */
	it("has a .git FILE pointing into the superproject, not a directory", () => {
		const dotGit = path.join(submodule, ".git");

		expect(fs.statSync(dotGit).isFile()).toBe(true);
		expect(fs.readFileSync(dotGit, "utf8")).toContain("gitdir:");
	});

	/**
	 * The root must be the submodule's own working directory. Resolving to the
	 * superproject would stage a submodule edit against the parent's index, which
	 * is the kind of wrong that is only noticed after it is committed.
	 */
	it("resolves to its own working directory, not the superproject", () => {
		expect(stateOf(submodule).repoRoot).toBe(fs.realpathSync(submodule));
		expect(stateOf(superproject).repoRoot).toBe(fs.realpathSync(superproject));
	});

	/** Its real git directory is the superproject's `modules/<path>` entry. */
	it("follows the pointer to the superproject's modules directory", () => {
		const gitDir = stateOf(submodule).gitDir;

		expect(gitDir).toBe(path.join(fs.realpathSync(superproject), ".git", "modules", "vendor", "lib"));
	});

	/** And resolution still works from inside it, as a real cwd would be. */
	it("resolves from a subdirectory of the submodule", () => {
		const deep = path.join(submodule, "deep");
		fs.mkdirSync(deep, { recursive: true });

		expect(stateOf(deep).repoRoot).toBe(fs.realpathSync(submodule));
	});
});
