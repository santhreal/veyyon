/**
 * `veyyon worktree` list/clear over a fabricated `wt/` tree (via
 * VEYYON_WORKTREE_DIR): classification of task-isolation leftovers, orphaned
 * and live PR checkouts, legacy nesting, and — because `clear` deletes
 * directories — proof that dry-run touches nothing and that live worktrees
 * survive a plain `clear`.
 */
import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

const cliPath = path.resolve(import.meta.dir, "../../src/cli.ts");

interface RunResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

function makeEnv(): { home: string; wt: string } {
	const home = mkdtempSync(path.join(tmpdir(), "veyyon-worktree-home-"));
	const wt = path.join(home, "wt");
	mkdirSync(wt);
	return { home, wt };
}

async function runWorktree(env: { home: string; wt: string }, args: string[]): Promise<RunResult> {
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

function makeTaskIsolationLeftover(wt: string, name: string): string {
	const dir = path.join(wt, name);
	mkdirSync(path.join(dir, "m"), { recursive: true });
	return dir;
}

function makeOrphanedPrCheckout(wt: string, name: string): string {
	const dir = path.join(wt, name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(path.join(dir, ".git"), `gitdir: ${path.join(wt, "gone-repo", ".git", "worktrees", name)}\n`);
	return dir;
}

async function makeLivePrCheckout(home: string, wt: string, name: string): Promise<string> {
	const repo = path.join(home, "parent-repo");
	mkdirSync(repo, { recursive: true });
	const git = (...args: string[]) =>
		Bun.spawn(["git", ...args], { cwd: repo, stdout: "ignore", stderr: "ignore" }).exited;
	await git("init", "-q");
	await git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-q", "-m", "init");
	const dir = path.join(wt, name);
	await git("worktree", "add", "-q", dir);
	return dir;
}

describe("veyyon worktree list", () => {
	it("reports an empty tree, exit 0", async () => {
		const env = makeEnv();
		const { exitCode, stdout } = await runWorktree(env, []);
		expect(exitCode).toBe(0);
		expect(stdout).toContain("No agent-managed worktrees found");
	}, 30_000);

	it("classifies task-isolation leftovers and orphaned PR checkouts with reasons", async () => {
		const env = makeEnv();
		makeTaskIsolationLeftover(env.wt, "task-leftover");
		makeOrphanedPrCheckout(env.wt, "pr-orphan");
		const { exitCode, stdout } = await runWorktree(env, []);
		expect(exitCode).toBe(0);
		expect(stdout).toContain("task-isolation leftover");
		expect(stdout).toContain("parent repo no longer tracks this worktree");
		expect(stdout).toContain("0 live · 2 orphaned · 2 total");
	}, 30_000);

	it("marks a registered git worktree live and shows repo · branch", async () => {
		const env = makeEnv();
		await makeLivePrCheckout(env.home, env.wt, "pr-live");
		const { exitCode, stdout } = await runWorktree(env, ["--json"]);
		expect(exitCode).toBe(0);
		const entries = JSON.parse(stdout) as Array<Record<string, unknown>>;
		expect(entries).toHaveLength(1);
		expect(entries[0]?.kind).toBe("pr-checkout");
		expect(entries[0]?.orphanReason).toBeUndefined();
		expect(String(entries[0]?.parentRepo)).toContain("parent-repo");
	}, 30_000);

	it("flags a malformed .git file and a legacy empty shell", async () => {
		const env = makeEnv();
		const bad = path.join(env.wt, "bad-gitfile");
		mkdirSync(bad);
		writeFileSync(path.join(bad, ".git"), "not a gitdir pointer\n");
		mkdirSync(path.join(env.wt, "legacy-shell"));
		const { exitCode, stdout } = await runWorktree(env, ["--json"]);
		expect(exitCode).toBe(0);
		const reasons = (JSON.parse(stdout) as Array<{ orphanReason?: string }>).map(e => e.orphanReason);
		expect(reasons).toContain("malformed .git file (no gitdir line)");
		expect(reasons).toContain("empty directory");
	}, 30_000);
});

describe("veyyon worktree clear", () => {
	it("dry-run lists targets without touching the filesystem", async () => {
		const env = makeEnv();
		const leftover = makeTaskIsolationLeftover(env.wt, "task-leftover");
		const { exitCode, stdout } = await runWorktree(env, ["clear", "--dry-run"]);
		expect(exitCode).toBe(0);
		expect(stdout).toContain("would remove");
		expect(stdout).toContain("1 dir would be removed.");
		expect(existsSync(leftover)).toBe(true);
	}, 30_000);

	it("removes orphans but keeps live worktrees without --all", async () => {
		const env = makeEnv();
		const orphan = makeOrphanedPrCheckout(env.wt, "pr-orphan");
		const live = await makeLivePrCheckout(env.home, env.wt, "pr-live");
		const { exitCode, stdout } = await runWorktree(env, ["clear", "--json"]);
		expect(exitCode).toBe(0);
		const result = JSON.parse(stdout) as { removed: number; failed: number };
		expect(result.removed).toBe(1);
		expect(result.failed).toBe(0);
		expect(existsSync(orphan)).toBe(false);
		expect(existsSync(live)).toBe(true);
	}, 30_000);

	it("--all removes live worktrees too and prunes the parent's bookkeeping", async () => {
		const env = makeEnv();
		const live = await makeLivePrCheckout(env.home, env.wt, "pr-live");
		const { exitCode } = await runWorktree(env, ["clear", "--all", "--json"]);
		expect(exitCode).toBe(0);
		expect(existsSync(live)).toBe(false);
		expect(existsSync(path.join(env.home, "parent-repo", ".git", "worktrees", "pr-live"))).toBe(false);
	}, 30_000);

	it("reports nothing to remove on a clean tree", async () => {
		const env = makeEnv();
		const { exitCode, stdout } = await runWorktree(env, ["clear"]);
		expect(exitCode).toBe(0);
		expect(stdout).toContain("No orphaned worktrees to remove.");
	}, 30_000);
});
