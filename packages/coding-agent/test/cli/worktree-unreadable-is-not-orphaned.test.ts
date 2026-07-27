/**
 * A worktree whose health cannot be READ must never be classified as orphaned, because
 * `veyyon worktree clear` deletes every orphan.
 *
 * WHY THIS SUITE EXISTS. `classifyPrCheckout` decides that a PR-checkout worktree is orphaned by failing to
 * stat things: the parent repo's `worktrees/<name>` tracking directory, and the parent repo root. Both stats
 * were written `await fs.stat(p).catch(() => null)`, which collapses "this path does not exist" into "I
 * could not look at this path". Those are opposite facts here. A parent repo on an unreadable directory, or
 * on a network volume that is briefly unreachable -- the normal state of a repo living on a mount -- made
 * the stat fail with EACCES or ENOTCONN, the entry was reported to the user as "parent repo missing", and
 * `clear` then removed the worktree along with any uncommitted work in it. Silent data loss produced by a
 * one-line swallow, and the printed reason was a false statement about the user's filesystem.
 *
 * The fix keeps the two apart: ENOENT still yields `orphanReason`, and any other stat failure yields
 * `undeterminedReason` instead. `clear` selects targets by `orphanReason` alone, so an unknown entry is
 * listed loudly and left alone.
 *
 * The suite drives the real CLI over a fabricated `wt/` tree rather than calling the classifier, because the
 * behaviour that matters is whether the directory still exists after `clear` runs.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

const cliPath = path.resolve(import.meta.dir, "../../src/cli.ts");

interface RunResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

interface Env {
	home: string;
	wt: string;
	/** Directories chmod-ed unreadable, restored in `afterAll` so the temp trees can be removed. */
	blocked: string[];
}

const envs: Env[] = [];

function makeEnv(): Env {
	const home = mkdtempSync(path.join(tmpdir(), "veyyon-worktree-unreadable-"));
	const wt = path.join(home, "wt");
	mkdirSync(wt);
	const env: Env = { home, wt, blocked: [] };
	envs.push(env);
	return env;
}

afterAll(() => {
	for (const env of envs) {
		for (const dir of env.blocked) chmodSync(dir, 0o700);
		rmSync(env.home, { recursive: true, force: true });
	}
});

async function runWorktree(env: Env, args: string[]): Promise<RunResult> {
	const childEnv: Record<string, string | undefined> = {
		...process.env,
		HOME: env.home,
		VEYYON_WORKTREE_DIR: env.wt,
		NO_COLOR: "1",
	};
	for (const key of ["VEYYON_CODING_AGENT_DIR", "VEYYON_CONFIG_DIR", "VEYYON_PROFILE"]) {
		delete childEnv[key];
	}
	const proc = Bun.spawn(["bun", cliPath, "worktree", ...args], {
		env: childEnv,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { exitCode, stdout, stderr };
}

/**
 * A PR-checkout worktree whose parent repo lives inside a directory with no search permission.
 *
 * The block is on the PARENT of the repo, not the repo itself: `stat("<blocked>/repo")` needs search
 * permission on `<blocked>`, so this is what makes the stat fail with EACCES rather than succeed on a
 * directory that merely cannot be listed.
 */
function makeUnreadableParentRepo(env: Env, name: string): { worktree: string; repo: string } {
	const blocked = path.join(env.home, `blocked-${name}`);
	const repo = path.join(blocked, "repo");
	mkdirSync(path.join(repo, ".git", "worktrees", name), { recursive: true });
	const worktree = path.join(env.wt, name);
	mkdirSync(worktree, { recursive: true });
	writeFileSync(path.join(worktree, ".git"), `gitdir: ${path.join(repo, ".git", "worktrees", name)}\n`);
	chmodSync(blocked, 0o000);
	env.blocked.push(blocked);
	return { worktree, repo };
}

/** A PR-checkout worktree pointing at a parent repo that genuinely does not exist. */
function makeMissingParentRepo(env: Env, name: string): string {
	const worktree = path.join(env.wt, name);
	mkdirSync(worktree, { recursive: true });
	const gone = path.join(env.home, "gone-repo", ".git", "worktrees", name);
	writeFileSync(path.join(worktree, ".git"), `gitdir: ${gone}\n`);
	return worktree;
}

describe("a worktree whose parent repo cannot be read", () => {
	/**
	 * The regression, stated as the classifier's own output: the entry must carry `undeterminedReason`, and
	 * must NOT carry `orphanReason`, because that field is what selects deletions.
	 */
	it("is reported as undetermined and not as an orphan", async () => {
		const env = makeEnv();
		makeUnreadableParentRepo(env, "pr-blocked");

		const { exitCode, stdout } = await runWorktree(env, ["--json"]);

		expect(exitCode).toBe(0);
		const entries = JSON.parse(stdout) as Array<Record<string, unknown>>;
		expect(entries).toHaveLength(1);
		expect(entries[0]?.orphanReason).toBeUndefined();
		expect(String(entries[0]?.undeterminedReason)).toContain("cannot stat");
	}, 30_000);

	/** The false statement that used to be printed: the parent repo exists, so nothing may claim it is gone. */
	it("does not claim the parent repo is missing", async () => {
		const env = makeEnv();
		makeUnreadableParentRepo(env, "pr-blocked");

		const { stdout } = await runWorktree(env, []);

		expect(stdout).not.toContain("parent repo missing");
		expect(stdout).not.toContain("parent repo no longer tracks this worktree");
	}, 30_000);

	/** And the operator sees it, rather than it passing as a healthy entry. */
	it("is listed as unknown in the human output", async () => {
		const env = makeEnv();
		makeUnreadableParentRepo(env, "pr-blocked");

		const { stdout } = await runWorktree(env, []);

		expect(stdout).toContain("unknown");
		expect(stdout).toContain("cannot stat");
	}, 30_000);

	/**
	 * The consequence that makes this a data-loss bug rather than a wording bug: `clear` sweeps orphans, and
	 * the directory has to still be there afterwards.
	 */
	it("survives veyyon worktree clear", async () => {
		const env = makeEnv();
		const { worktree } = makeUnreadableParentRepo(env, "pr-blocked");

		const { exitCode, stdout } = await runWorktree(env, ["clear", "--json"]);

		expect(exitCode).toBe(0);
		expect(JSON.parse(stdout)).toMatchObject({ removed: 0 });
		expect(existsSync(worktree)).toBe(true);
	}, 30_000);
});

describe("a worktree whose parent repo is genuinely gone", () => {
	/**
	 * The behaviour that must NOT change while fixing the above. ENOENT is a real orphan verdict, and the
	 * command exists to clean these up; a fix that made everything undetermined would break the feature.
	 */
	it("is still reported as an orphan with the missing-parent reason", async () => {
		const env = makeEnv();
		makeMissingParentRepo(env, "pr-gone");

		const { stdout } = await runWorktree(env, ["--json"]);

		const entries = JSON.parse(stdout) as Array<Record<string, unknown>>;
		expect(entries).toHaveLength(1);
		expect(entries[0]?.orphanReason).toBe("parent repo no longer tracks this worktree");
		expect(entries[0]?.undeterminedReason).toBeUndefined();
	}, 30_000);

	/** And it is still removed by `clear`. */
	it("is removed by veyyon worktree clear", async () => {
		const env = makeEnv();
		const worktree = makeMissingParentRepo(env, "pr-gone");

		const { exitCode, stdout } = await runWorktree(env, ["clear", "--json"]);

		expect(exitCode).toBe(0);
		expect(JSON.parse(stdout)).toMatchObject({ removed: 1 });
		expect(existsSync(worktree)).toBe(false);
	}, 30_000);
});

describe("the two kinds mixed in one tree", () => {
	/**
	 * The realistic case, and the one a per-entry test cannot catch: one sweep must remove the real orphan
	 * and keep the unreadable one, rather than treating the tree as uniformly healthy or uniformly stale.
	 */
	it("removes only the genuine orphan", async () => {
		const env = makeEnv();
		const { worktree: blocked } = makeUnreadableParentRepo(env, "pr-blocked");
		const gone = makeMissingParentRepo(env, "pr-gone");

		const { stdout } = await runWorktree(env, ["clear", "--json"]);

		expect(JSON.parse(stdout)).toMatchObject({ removed: 1 });
		expect(existsSync(gone)).toBe(false);
		expect(existsSync(blocked)).toBe(true);
	}, 30_000);
});
