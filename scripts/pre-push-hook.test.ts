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
import * as path from "node:path";
import { TempDir } from "@veyyon/utils";

const HOOK = path.join(import.meta.dir, "..", ".githooks", "pre-push");
const ZERO = "0".repeat(40);
const SHA = "a".repeat(40);

interface HookRun {
	exitCode: number;
	stderr: string;
	stdout: string;
	/** Whether the stub recorded a `bun run check:ts` invocation. */
	ranCheck: boolean;
}

/**
 * Run the hook with a fake `bun` on PATH that exits with `bunExit`, feeding
 * `stdin` the ref lines git would supply.
 */
async function runHook(options: { stdin: string; bunExit?: number; withBun?: boolean; env?: Record<string, string> }): Promise<HookRun> {
	using dir = TempDir.createSync("veyyon-prepush-");
	// TempDir.path() is relative to the process cwd. The hook runs as a child
	// with its own cwd and reads PATH, and a relative PATH entry resolves against
	// that child's cwd, so the stub would be invisible and every case would take
	// the "bun is not on PATH" branch instead of the one under test.
	const root = path.resolve(dir.path());
	const binDir = path.join(root, "bin");
	const marker = path.join(root, "check-ran");
	if (options.withBun !== false) {
		await Bun.write(
			path.join(binDir, "bun"),
			`#!/usr/bin/env bash\nif [ "$1" = "run" ] && [ "$2" = "check:ts" ]; then echo ran > ${JSON.stringify(marker)}; fi\nexit ${options.bunExit ?? 0}\n`,
		);
		await Bun.$`chmod +x ${path.join(binDir, "bun")}`.quiet();
	}
	// A real repo so `git rev-parse --show-toplevel` resolves.
	await Bun.$`git init -q ${root}`.quiet();

	const proc = Bun.spawn(["/usr/bin/bash", HOOK], {
		cwd: root,
		stdin: new TextEncoder().encode(options.stdin),
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
	return { exitCode, stdout, stderr, ranCheck: await Bun.file(marker).exists() };
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
});
