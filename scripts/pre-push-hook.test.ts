/**
 * Contract tests for `.githooks/pre-push`.
 *
 * The hook is the last thing standing between a tree that does not typecheck
 * and a red `main`. It has to refuse a broken tree, allow a good one, stay out
 * of the way for a branch deletion, and above all fail closed when it cannot
 * run at all: a hook that silently exits 0 when its tool is missing is worse
 * than no hook, because everyone believes they are covered.
 *
 * Each test drives the real script through bash with a stubbed PATH, so what is
 * asserted is the shipped file's behaviour rather than a reimplementation of it.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@veyyon/utils";

const HOOK = path.join(import.meta.dir, "..", ".githooks", "pre-push");
const ZERO = "0".repeat(40);
/** Replaced with the temp repo's real HEAD, which the hook must be able to check out. */
const SHA = "__SHA__";

interface HookRun {
	exitCode: number;
	stderr: string;
	stdout: string;
	/** Whether the stub recorded a `bun run check:ts` invocation. */
	ranCheck: boolean;
	/** True when the check ran somewhere other than the repo's own directory. */
	checkedInWorktree: boolean;
	/**
	 * Where `node_modules/@veyyon/pkg` actually resolved during the check. The
	 * whole point of the worktree is that this lands inside it, not in the repo.
	 */
	workspaceLinkTarget: string;
	/** Worktrees still registered after the hook exited; must always be empty. */
	leftoverWorktrees: string[];
	/** The temp repo the hook ran in, so a test can assert a path is NOT inside it. */
	repoRoot: string;
}

/**
 * Run the hook with a fake `bun` on PATH that exits with `bunExit`, feeding
 * `stdin` the ref lines git would supply.
 *
 * The temp repo gets one real commit, because the hook checks out each pushed
 * sha into a throwaway worktree rather than reading the working tree. Callers
 * that need a pushable sha use the `sha` handed to the stdin builder.
 */
async function runHook(options: {
	stdin: string;
	bunExit?: number;
	withBun?: boolean;
	env?: Record<string, string>;
	/** Leave uncommitted and untracked files behind before the hook runs. */
	dirty?: boolean;
}): Promise<HookRun> {
	using dir = TempDir.createSync("veyyon-hooktest-");
	// TempDir.path() is relative to the process cwd. The hook runs as a child
	// with its own cwd and reads PATH, and a relative PATH entry resolves against
	// that child's cwd, so the stub would be invisible and every case would take
	// the "bun is not on PATH" branch instead of the one under test.
	const root = path.resolve(dir.path());
	const binDir = path.join(root, "bin");
	const marker = path.join(root, "check-ran");
	const linkMarker = path.join(root, "workspace-link");
	if (options.withBun !== false) {
		await Bun.write(
			path.join(binDir, "bun"),
			`#!/usr/bin/env bash\nif [ "$1" = "run" ] && [ "$2" = "check:ts" ]; then\n  pwd > ${JSON.stringify(marker)}\n  readlink -f node_modules/@veyyon/pkg > ${JSON.stringify(linkMarker)} 2>/dev/null || true\nfi\nexit ${options.bunExit ?? 0}\n`,
		);
		await Bun.$`chmod +x ${path.join(binDir, "bun")}`.quiet();
	}
	// A real repo with a real commit: the hook checks out the pushed sha, so
	// there has to be something to check out.
	await Bun.$`git init -q -b main ${root}`.quiet();
	await Bun.write(path.join(root, "seed.txt"), "seed\n");
	await Bun.$`git -C ${root} config user.email t@t`.quiet();
	await Bun.$`git -C ${root} config user.name t`.quiet();
	await Bun.$`git -C ${root} add seed.txt`.quiet();
	await Bun.$`git -C ${root} commit -qm seed`.quiet();
	// A workspace layout: a package plus the RELATIVE link bun installs for it.
	// The relative link is the whole hazard, so it is reproduced exactly rather
	// than approximated with an absolute one.
	await Bun.write(path.join(root, "packages", "pkg", "index.ts"), "export const committed = 1;\n");
	await fs.mkdir(path.join(root, "node_modules", "@veyyon"), { recursive: true });
	await fs.symlink("../../packages/pkg", path.join(root, "node_modules", "@veyyon", "pkg"));
	await Bun.$`git -C ${root} add packages/pkg/index.ts`.quiet();
	await Bun.$`git -C ${root} commit -qm workspace`.quiet();
	const head = (await Bun.$`git -C ${root} rev-parse HEAD`.text()).trim();
	if (options.dirty) {
		await Bun.write(path.join(root, "seed.txt"), "locally edited, never committed\n");
		await Bun.write(path.join(root, "untracked.ts"), "export const brokenWorkInProgress = 1;\n");
	}

	const proc = Bun.spawn(["/usr/bin/bash", HOOK], {
		cwd: root,
		stdin: new TextEncoder().encode(options.stdin.replaceAll("__SHA__", head)),
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...process.env,
			// `withBun: false` drops the stub and leaves a PATH that still has git
			// and coreutils but no bun (bun installs to ~/.bun/bin), which is how
			// the missing-tool branch is reached without breaking the shell itself.
			PATH: options.withBun === false ? "/usr/bin:/bin" : `${binDir}:/usr/bin:/bin`,
			...options.env,
		},
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	const ranCheck = await Bun.file(marker).exists();
	const checkedIn = ranCheck ? (await Bun.file(marker).text()).trim() : "";
	const workspaceLinkTarget = (await Bun.file(linkMarker).exists()) ? (await Bun.file(linkMarker).text()).trim() : "";
	const worktrees = (await Bun.$`git -C ${root} worktree list`.text())
		.split("\n")
		.filter(Boolean)
		.map(line => line.split(" ")[0] ?? "")
		.filter(p => p !== root && p !== "");
	return {
		exitCode,
		stdout,
		stderr,
		ranCheck,
		checkedInWorktree: ranCheck && checkedIn !== root,
		workspaceLinkTarget,
		leftoverWorktrees: worktrees,
		repoRoot: root,
	};
}

describe("pre-push hook", () => {
	/** The whole point: a tree that fails check:ts must not reach the remote. */
	it("refuses the push when check:ts fails", async () => {
		const run = await runHook({ stdin: `refs/heads/main ${SHA} refs/heads/main ${SHA}\n`, bunExit: 1 });
		expect(run.ranCheck).toBe(true);
		expect(run.exitCode).not.toBe(0);
	});

	/**
	 * The refusal has to say what to do next. A hook that blocks a push without
	 * naming its own bypass gets deleted by the first person it inconveniences.
	 */
	it("names the bypass and the blast radius when it refuses", async () => {
		const run = await runHook({ stdin: `refs/heads/main ${SHA} refs/heads/main ${SHA}\n`, bunExit: 1 });
		expect(run.stderr).toContain("git push --no-verify");
		expect(run.stderr).toContain("every");
	});

	/** A passing tree must push with no interference. */
	it("allows the push when check:ts passes", async () => {
		const run = await runHook({ stdin: `refs/heads/main ${SHA} refs/heads/main ${SHA}\n`, bunExit: 0 });
		expect(run.ranCheck).toBe(true);
		expect(run.exitCode).toBe(0);
	});

	/**
	 * Deleting a remote branch pushes the all-zero sha and carries no tree, so
	 * there is nothing to typecheck. Running the gate there would spend 40s to
	 * check a tree the push is not sending.
	 */
	it("skips the check entirely for a branch deletion", async () => {
		const run = await runHook({ stdin: `(delete) ${ZERO} refs/heads/gone ${SHA}\n`, bunExit: 1 });
		expect(run.ranCheck).toBe(false);
		expect(run.exitCode).toBe(0);
	});

	/**
	 * A push that deletes one branch and updates another still has a tree going
	 * out, so the deletion must not excuse the rest of the push.
	 */
	it("still checks when a deletion is mixed with a real update", async () => {
		const run = await runHook({
			stdin: `(delete) ${ZERO} refs/heads/gone ${SHA}\nrefs/heads/main ${SHA} refs/heads/main ${SHA}\n`,
			bunExit: 1,
		});
		expect(run.ranCheck).toBe(true);
		expect(run.exitCode).not.toBe(0);
	});

	/**
	 * Fails closed, the single most important property here. With bun missing the
	 * hook cannot know whether the tree is sound, and exiting 0 would hand back a
	 * false all-clear on every machine where the toolchain is not set up.
	 */
	it("refuses rather than waving the push through when bun is missing", async () => {
		const run = await runHook({ stdin: `refs/heads/main ${SHA} refs/heads/main ${SHA}\n`, withBun: false });
		expect(run.exitCode).not.toBe(0);
		expect(run.stderr).toContain("bun is not on PATH");
		expect(run.stderr).toContain("VEYYON_SKIP_PREPUSH=1");
	});

	/** The documented escape hatch has to actually work, and say that it fired. */
	it("honours VEYYON_SKIP_PREPUSH=1 and says so", async () => {
		const run = await runHook({
			stdin: `refs/heads/main ${SHA} refs/heads/main ${SHA}\n`,
			bunExit: 1,
			env: { VEYYON_SKIP_PREPUSH: "1" },
		});
		expect(run.ranCheck).toBe(false);
		expect(run.exitCode).toBe(0);
		expect(run.stderr).toContain("skipped");
	});

	/** An empty stdin (no refs at all) is not a reason to run a 40s gate. */
	it("does nothing when git supplies no refs", async () => {
		const run = await runHook({ stdin: "", bunExit: 1 });
		expect(run.ranCheck).toBe(false);
		expect(run.exitCode).toBe(0);
	});
	/**
	 * The bug this hook shipped with, caught on its own first push. The canonical
	 * tree here is dirty essentially all the time, and the first version
	 * typechecked the WORKING TREE, so an untracked half-written test blocked a
	 * push whose commits were perfectly sound. A hook that blocks pushes over
	 * files that are not going anywhere gets disabled within a day, which is
	 * worse than having none. The commit is what CI will judge, so the commit is
	 * what this checks.
	 */
	it("ignores uncommitted and untracked work, checking the pushed commit instead", async () => {
		const run = await runHook({
			stdin: `refs/heads/main ${SHA} refs/heads/main ${SHA}\n`,
			bunExit: 0,
			dirty: true,
		});
		expect(run.exitCode).toBe(0);
		expect(run.ranCheck).toBe(true);
		// The check ran somewhere other than the dirty tree.
		expect(run.checkedInWorktree).toBe(true);
	});

	/**
	 * The defect that made the hook lie, found when it blocked a push over an
	 * error that existed only in an uncommitted file.
	 *
	 * The first version linked node_modules as a single symlink. Workspace
	 * packages are linked RELATIVELY (`@veyyon/pkg -> ../../packages/pkg`), and a
	 * relative link resolves against the directory it really lives in, which
	 * through a symlinked node_modules is the main repo. So every cross-package
	 * import was typechecked against the WORKING TREE while the hook reported it
	 * had checked the commit: a half-finished edit could fail a sound push, and a
	 * broken commit could pass because its fix was sitting uncommitted on disk.
	 *
	 * A hook that reports a check it did not perform is worse than no hook, so
	 * this asserts the resolved path, not merely that the link exists.
	 */
	it("resolves workspace packages inside the checkout, not in the working tree", async () => {
		const run = await runHook({
			stdin: `refs/heads/main ${SHA} refs/heads/main ${SHA}\n`,
			bunExit: 0,
			dirty: true,
		});
		expect(run.exitCode).toBe(0);
		expect(run.ranCheck).toBe(true);
		// The link resolved somewhere, that somewhere is a package directory, and it
		// is NOT the one in the repo. The last assertion is the whole test: with the
		// old single-symlink node_modules the relative link resolved right back into
		// the working tree and every other assertion here still passed.
		expect(run.workspaceLinkTarget).not.toBe("");
		expect(run.workspaceLinkTarget).toEndWith("/packages/pkg");
		expect(run.workspaceLinkTarget).not.toBe(path.join(run.repoRoot, "packages", "pkg"));
		expect(run.workspaceLinkTarget).toContain("veyyon-prepush-");
	});

	/** The throwaway checkout must not survive the hook, clean run or refusal. */
	it("removes its temporary worktree afterwards, including when it refuses", async () => {
		const pass = await runHook({ stdin: `refs/heads/main ${SHA} refs/heads/main ${SHA}\n`, bunExit: 0 });
		expect(pass.leftoverWorktrees).toEqual([]);
		const fail = await runHook({ stdin: `refs/heads/main ${SHA} refs/heads/main ${SHA}\n`, bunExit: 1 });
		expect(fail.leftoverWorktrees).toEqual([]);
	});
});
