import { afterEach, describe, expect, it, vi } from "bun:test";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as git from "@veyyon/coding-agent/utils/git";
import {
	branchLabelFromFiles,
	parseHeadStateFromFiles,
	resolveHeadStateFromFiles,
	resolveInProgressOperation,
	resolveRepositorySync,
} from "@veyyon/coding-agent/utils/git-head";
import { TempDir } from "@veyyon/utils";

/**
 * WHY: the launch card paints the composer's footline on the frame the
 * terminal is already owed, roughly a second before the session mounts, and
 * the branch is half of what that row says. The branch reader it calls
 * therefore has to answer from `.git` alone. The sync path in `utils/git.ts`
 * could not: it reached `Bun.spawnSync(["git", ...])` for a reftable
 * repository, so importing it onto the first-frame path put a subprocess one
 * unlucky checkout away from the startup budget.
 *
 * The class this closes is wider than "the card is slow in a reftable repo".
 * It is: a second copy of "read the branch" that agrees with the first only
 * until someone edits one of them. So every case here is asserted twice —
 * once against the file-only reader, once against `git.head` — and the two
 * must return the same string. Extracting the shared helpers rather than
 * copying them is what makes that hold; these tests are what notice if it
 * stops holding.
 *
 * WHAT IT DOES NOT CATCH, stated plainly: it builds `.git` directories by
 * writing the files git writes, so a layout a future git version introduces is
 * invisible here until someone adds it. It does not run git, by design, so it
 * cannot notice that git would disagree with the files. And it asserts that no
 * subprocess is spawned through `Bun.spawn*` or `node:child_process`; a reader
 * that shelled out through some third mechanism would pass.
 */

const HEAD_ON_MAIN = "ref: refs/heads/main\n";
const SHA = "0123456789abcdef0123456789abcdef01234567";

interface Fixture {
	dir: TempDir;
	root: string;
}

const fixtures: TempDir[] = [];

/** A checkout on disk, described by the files git would have written into it. */
function checkout(files: Record<string, string>): Fixture {
	const dir = TempDir.createSync("git-head-");
	fixtures.push(dir);
	// macOS hands out `/var/...`, which is a symlink to `/private/var`; the
	// reader resolves paths and the comparison below would see two spellings of
	// one directory.
	const root = fs.realpathSync(dir.path());
	for (const [relative, content] of Object.entries(files)) {
		const target = path.join(root, relative);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, content);
	}
	return { dir, root };
}

/** What `git.head` — the spawning composer — makes of the same directory. */
function throughGitModule(cwd: string): string | null {
	const state = git.head.resolveSync(cwd);
	if (!state) return null;
	const label = git.head.label(state, git.head.operation(state));
	return label === "detached" ? null : label;
}

afterEach(() => {
	vi.restoreAllMocks();
	while (fixtures.length > 0) fixtures.pop()?.removeSync();
});

describe("the branch a checkout is on, read from its files", () => {
	it("names the branch HEAD points at", () => {
		const { root } = checkout({ ".git/HEAD": HEAD_ON_MAIN });
		expect(branchLabelFromFiles(root)).toBe("main");
		expect(throughGitModule(root)).toBe("main");
	});

	it("keeps the slashes in a branch name", () => {
		const { root } = checkout({ ".git/HEAD": "ref: refs/heads/feature/nested/thing\n" });
		expect(branchLabelFromFiles(root)).toBe("feature/nested/thing");
		expect(throughGitModule(root)).toBe("feature/nested/thing");
	});

	it("finds the repository from a directory inside it", () => {
		const { root } = checkout({ ".git/HEAD": HEAD_ON_MAIN, "src/deep/file.ts": "" });
		expect(branchLabelFromFiles(path.join(root, "src/deep"))).toBe("main");
	});

	it("has no branch outside a repository", () => {
		const { root } = checkout({ "file.ts": "" });
		expect(resolveRepositorySync(root)).toBeNull();
		expect(branchLabelFromFiles(root)).toBeNull();
	});

	it("has no branch on a detached HEAD", () => {
		const { root } = checkout({ ".git/HEAD": `${SHA}\n` });
		const state = resolveHeadStateFromFiles(root);
		expect(state?.kind).toBe("detached");
		expect(branchLabelFromFiles(root)).toBeNull();
		expect(throughGitModule(root)).toBeNull();
	});

	it("follows a linked worktree's gitdir pointer", () => {
		const { root } = checkout({
			"main/.git/HEAD": HEAD_ON_MAIN,
			"main/.git/worktrees/wt/HEAD": "ref: refs/heads/topic\n",
			"main/.git/worktrees/wt/commondir": "../..\n",
			"wt/.git": `gitdir: ${path.join("..", "main", ".git", "worktrees", "wt")}\n`,
		});
		expect(branchLabelFromFiles(path.join(root, "wt"))).toBe("topic");
		expect(throughGitModule(path.join(root, "wt"))).toBe("topic");
	});

	it("says nothing when the refs live in a reftable, because there are no ref files", () => {
		// The one case the file-only reader cannot answer. `null` is what sends
		// the caller to the live row, which may spawn; a guess would be a branch
		// name invented from a HEAD stub git no longer keeps current.
		const { root } = checkout({
			".git/HEAD": "ref: refs/heads/wrong-and-stale\n",
			".git/config": "[extensions]\n\trefstorage = reftable\n",
		});
		expect(resolveHeadStateFromFiles(root)).toBeNull();
		expect(branchLabelFromFiles(root)).toBeNull();
	});

	it("reads a quoted and commented reftable declaration the same way", () => {
		const { root } = checkout({
			".git/HEAD": HEAD_ON_MAIN,
			".git/config": '# a comment\n[extensions]\n\trefStorage = "reftable" ; trailing\n',
		});
		expect(branchLabelFromFiles(root)).toBeNull();
	});

	it("is unaffected by a refstorage key outside the extensions section", () => {
		const { root } = checkout({
			".git/HEAD": HEAD_ON_MAIN,
			".git/config": "[core]\n\trefstorage = reftable\n",
		});
		expect(branchLabelFromFiles(root)).toBe("main");
	});
});

describe("the commit HEAD resolves to", () => {
	it("comes from the loose ref file", () => {
		const { root } = checkout({ ".git/HEAD": HEAD_ON_MAIN, ".git/refs/heads/main": `${SHA}\n` });
		expect(resolveHeadStateFromFiles(root)?.commit).toBe(SHA);
	});

	it("falls back to packed-refs when the loose file is gone", () => {
		const { root } = checkout({
			".git/HEAD": HEAD_ON_MAIN,
			".git/packed-refs": `# pack-refs with: peeled fully-peeled sorted \n${SHA} refs/heads/main\n^${SHA}\n`,
		});
		expect(resolveHeadStateFromFiles(root)?.commit).toBe(SHA);
	});

	it("is null when neither records the ref", () => {
		const { root } = checkout({ ".git/HEAD": HEAD_ON_MAIN });
		expect(resolveHeadStateFromFiles(root)?.commit).toBeNull();
	});
});

describe("a multi-step operation in progress", () => {
	it("recovers the branch a rebase detached HEAD away from", () => {
		const { root } = checkout({
			".git/HEAD": `${SHA}\n`,
			".git/rebase-merge/head-name": "refs/heads/topic\n",
		});
		expect(branchLabelFromFiles(root)).toBe("topic|REBASE");
		expect(throughGitModule(root)).toBe("topic|REBASE");
	});

	it("tells an am apart from a rebase by the applying marker", () => {
		const applying = checkout({
			".git/HEAD": `${SHA}\n`,
			".git/rebase-apply/head-name": "refs/heads/topic\n",
			".git/rebase-apply/applying": "",
		});
		expect(branchLabelFromFiles(applying.root)).toBe("topic|AM");

		const rebasing = checkout({
			".git/HEAD": `${SHA}\n`,
			".git/rebase-apply/head-name": "refs/heads/topic\n",
		});
		expect(branchLabelFromFiles(rebasing.root)).toBe("topic|REBASE");
	});

	it("reports the enclosing rebase, not the merge marker a conflict leaves", () => {
		// git's own status resolves the ambiguity this way. Announcing MERGE
		// mid-rebase would send someone to `git merge --abort`, which does not
		// apply to the state they are in.
		const { root } = checkout({
			".git/HEAD": `${SHA}\n`,
			".git/rebase-merge/head-name": "refs/heads/topic\n",
			".git/MERGE_HEAD": `${SHA}\n`,
		});
		expect(branchLabelFromFiles(root)).toBe("topic|REBASE");
	});

	it("keeps the branch HEAD is still on through a merge, cherry-pick, revert and bisect", () => {
		for (const [marker, suffix] of [
			["MERGE_HEAD", "MERGE"],
			["CHERRY_PICK_HEAD", "CHERRY-PICK"],
			["REVERT_HEAD", "REVERT"],
			["BISECT_LOG", "BISECT"],
		] as const) {
			const { root } = checkout({ ".git/HEAD": HEAD_ON_MAIN, [`.git/${marker}`]: `${SHA}\n` });
			expect(branchLabelFromFiles(root)).toBe(`main|${suffix}`);
			expect(throughGitModule(root)).toBe(`main|${suffix}`);
		}
	});

	it("does not present git's literal `detached HEAD` record as a branch name", () => {
		const { root } = checkout({
			".git/HEAD": `${SHA}\n`,
			".git/rebase-merge/head-name": "detached HEAD\n",
		});
		const state = resolveHeadStateFromFiles(root);
		expect(state).not.toBeNull();
		expect(resolveInProgressOperation(state as NonNullable<typeof state>)?.branch).toBeNull();
		expect(branchLabelFromFiles(root)).toBe("detached|REBASE");
	});

	it("prefers the branch HEAD names over the one the operation recorded", () => {
		const { root } = checkout({
			".git/HEAD": HEAD_ON_MAIN,
			".git/rebase-merge/head-name": "refs/heads/stale\n",
		});
		expect(branchLabelFromFiles(root)).toBe("main|REBASE");
	});
});

describe("reading the branch spawns nothing", () => {
	it("runs no subprocess for an ordinary checkout, a worktree, or a rebase", () => {
		const spawnSync = vi.spyOn(Bun, "spawnSync");
		const spawn = vi.spyOn(Bun, "spawn");
		const cpSpawnSync = vi.spyOn(childProcess, "spawnSync");
		const cpExecFileSync = vi.spyOn(childProcess, "execFileSync");

		const plain = checkout({ ".git/HEAD": HEAD_ON_MAIN });
		const worktree = checkout({
			"main/.git/HEAD": HEAD_ON_MAIN,
			"main/.git/worktrees/wt/HEAD": "ref: refs/heads/topic\n",
			"main/.git/worktrees/wt/commondir": "../..\n",
			"wt/.git": `gitdir: ${path.join("..", "main", ".git", "worktrees", "wt")}\n`,
		});
		const rebasing = checkout({
			".git/HEAD": `${SHA}\n`,
			".git/rebase-merge/head-name": "refs/heads/topic\n",
		});

		expect(branchLabelFromFiles(plain.root)).toBe("main");
		expect(branchLabelFromFiles(path.join(worktree.root, "wt"))).toBe("topic");
		expect(branchLabelFromFiles(rebasing.root)).toBe("topic|REBASE");

		expect(spawnSync).not.toHaveBeenCalled();
		expect(spawn).not.toHaveBeenCalled();
		expect(cpSpawnSync).not.toHaveBeenCalled();
		expect(cpExecFileSync).not.toHaveBeenCalled();
	});

	it("runs no subprocess for a reftable repository either — it declines instead", () => {
		// The whole reason this module exists. `git.head.resolveSync` answers
		// this case by spawning `git symbolic-ref`, which is exactly what must
		// not happen on the frame the terminal is owed.
		const spawnSync = vi.spyOn(Bun, "spawnSync");
		const { root } = checkout({
			".git/HEAD": HEAD_ON_MAIN,
			".git/config": "[extensions]\n\trefstorage = reftable\n",
		});
		expect(branchLabelFromFiles(root)).toBeNull();
		expect(spawnSync).not.toHaveBeenCalled();
	});
});

describe("head state parsing", () => {
	it("treats an empty HEAD as detached with no commit rather than throwing", () => {
		const { root } = checkout({ ".git/HEAD": "" });
		const repository = resolveRepositorySync(root);
		expect(repository).not.toBeNull();
		const state = parseHeadStateFromFiles(repository as NonNullable<typeof repository>, "");
		expect(state).toMatchObject({ kind: "detached", commit: null });
		expect(branchLabelFromFiles(root)).toBeNull();
	});

	it("keeps a non-branch symbolic ref as the label", () => {
		const { root } = checkout({ ".git/HEAD": "ref: refs/remotes/origin/main\n" });
		const state = resolveHeadStateFromFiles(root);
		expect(state).toMatchObject({ kind: "ref", branchName: null, ref: "refs/remotes/origin/main" });
		expect(branchLabelFromFiles(root)).toBe("refs/remotes/origin/main");
		expect(throughGitModule(root)).toBe("refs/remotes/origin/main");
	});
});
