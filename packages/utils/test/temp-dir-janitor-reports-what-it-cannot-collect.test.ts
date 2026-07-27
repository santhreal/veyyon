/**
 * When the janitor cannot remove a scratch directory, it must SAY SO.
 *
 * WHY THIS SUITE EXISTS. The cleanup hook called `removeRecordedTempDirs()` and threw the
 * return value away. That function reports what it failed to remove precisely so a caller
 * can act on it, and discarding the report reintroduced, inside the module built to stop
 * it, the exact failure the module exists for: a directory left in the system temp
 * directory with nothing anywhere naming it. The quiet case is the one that matters. A
 * directory the janitor CAN remove needs no announcement; a directory it cannot remove is
 * the one that stays forever, and a run where that happens looks identical to a clean one.
 *
 * Two halves are pinned here, and the second is as important as the first. The failure is
 * reported, naming the path and the reason. And the report is not a THROW: teardown runs
 * after the last test, so throwing there is reported as a failure of whichever file
 * happened to finish last, which blames the wrong suite for a leak somebody else caused.
 *
 * The assertions run against real CHILD processes rather than by calling the removal
 * function here. This file shares a worker with other test files and the janitor's record
 * is one per process, so removing here would delete scratch a sibling suite is still
 * using. A child is also the only place the real question can be asked, which is not "does
 * the function report" but "does a process that preloads the janitor tell anyone".
 */

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describeUncollected } from "./helpers/temp-dir-janitor";

const REPO_ROOT = path.join(import.meta.dir, "..", "..", "..");
const TRIPWIRE = path.join(REPO_ROOT, "packages/utils/test/helpers/real-data-tripwire.ts");

/** Run `body` as a one-test file in a child that preloads the janitor. */
async function runInChild(body: string): Promise<{ output: string; exitCode: number }> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-janitor-report-script-"));
	const file = path.join(dir, "child.test.ts");
	fs.writeFileSync(
		file,
		`import { it } from "bun:test";\n` +
			`import * as fs from "node:fs";\n` +
			`import * as os from "node:os";\n` +
			`import * as path from "node:path";\n` +
			`it("child", async () => {\n${body}\n});\n`,
	);
	const proc = Bun.spawn(["bun", "test", "--preload", TRIPWIRE, file], {
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		cwd: REPO_ROOT,
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	fs.rmSync(dir, { recursive: true, force: true });
	return { output: `${stdout}\n${stderr}`, exitCode };
}

/**
 * A child body that makes a scratch directory the janitor cannot remove.
 *
 * Removal is blocked by taking write permission away from the PARENT, which is what a real
 * permission test leaves behind and what `rm` genuinely refuses. Two details are load
 * bearing and neither is obvious.
 *
 * The parent is created by a SEPARATE PROCESS. If this process made it, the janitor would
 * have recorded the parent too, sorted it ahead of the child, and removed it recursively,
 * taking the child with it and reporting nothing. A directory another process created is
 * the janitor's documented blind spot, which makes it the honest way to arrange a failure.
 *
 * And permission is taken from the parent rather than the directory itself, because the
 * janitor retries: it restores permission on the directory it was handed and tries again,
 * so a read-only TARGET is collected successfully and would prove nothing.
 */
const MAKE_UNCOLLECTABLE = `
	const parent = path.join(os.tmpdir(), "veyyon-janitor-locked-parent-" + process.pid);
	Bun.spawnSync(["mkdir", "-p", parent]);
	const dir = fs.mkdtempSync(path.join(parent, "veyyon-janitor-locked-"));
	fs.writeFileSync(path.join(dir, "occupant.txt"), "held");
	fs.chmodSync(parent, 0o500);
	console.log("PARENT=" + parent);
	console.log("TEMPDIR=" + dir);
`;

/** Pull a `KEY=value` line out of a child's output. */
function reported(output: string, key: string): string {
	const line = output.split("\n").find(candidate => candidate.startsWith(`${key}=`));
	if (!line) throw new Error(`the child did not report ${key}; output was:\n${output}`);
	return line.slice(key.length + 1).trim();
}

/** Restore permission and remove, so this suite does not become the leak it tests for. */
function cleanUp(parent: string): void {
	if (!parent || !fs.existsSync(parent)) return;
	fs.chmodSync(parent, 0o700);
	fs.rmSync(parent, { recursive: true, force: true });
}

// Running as root ignores the permission bits the whole suite relies on, so the removal
// would succeed and every assertion below would pass vacuously.
const asRoot = typeof process.getuid === "function" && process.getuid() === 0;

describe("a scratch directory the janitor cannot remove", () => {
	it("is named in the output, with the reason it could not be removed", async () => {
		if (asRoot) throw new Error("run this suite as a non-root user: root ignores the permission bits it relies on");
		const { output } = await runInChild(MAKE_UNCOLLECTABLE);
		const parent = reported(output, "PARENT");
		const dir = reported(output, "TEMPDIR");

		try {
			// The path has to be in the message. "Some directory could not be removed" sends
			// the reader to look for it by hand, which is what nobody did for 38,600 of them.
			expect(output).toContain("temp-dir-janitor:");
			expect(output).toContain(dir);
			// And the reason, or the reader has no way to tell a permission problem from a
			// bug in the janitor.
			expect(output).toMatch(/EACCES|EPERM|permission denied/i);
		} finally {
			cleanUp(parent);
		}
	}, 30_000);

	it("says the directory is left behind, and it really is", async () => {
		if (asRoot) throw new Error("run this suite as a non-root user: root ignores the permission bits it relies on");
		const { output } = await runInChild(MAKE_UNCOLLECTABLE);
		const parent = reported(output, "PARENT");
		const dir = reported(output, "TEMPDIR");

		try {
			// The claim in the message is checked against the filesystem, so the wording
			// cannot drift into saying something the code does not do.
			expect(output).toContain("left behind");
			expect(fs.existsSync(dir)).toBe(true);
		} finally {
			cleanUp(parent);
		}
	}, 30_000);

	it("does not fail the run, because teardown would blame the wrong suite", async () => {
		if (asRoot) throw new Error("run this suite as a non-root user: root ignores the permission bits it relies on");
		const { output, exitCode } = await runInChild(MAKE_UNCOLLECTABLE);
		const parent = reported(output, "PARENT");

		try {
			// Loud, not fatal. A throw in `afterAll` is attributed to whichever test file
			// finished last, so a leak caused by one suite would be reported against another.
			expect(exitCode).toBe(0);
			expect(output).toContain("1 pass");
		} finally {
			cleanUp(parent);
		}
	}, 30_000);
});

describe("a scratch directory the janitor can remove", () => {
	it("is removed and nothing is reported", async () => {
		// The negative twin. A message on every ordinary run trains readers to ignore the
		// one that matters, which is the same as not reporting it at all.
		const { output, exitCode } = await runInChild(`
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-janitor-collectable-"));
			fs.writeFileSync(path.join(dir, "payload.txt"), "x".repeat(512));
			console.log("TEMPDIR=" + dir);
		`);
		const dir = reported(output, "TEMPDIR");

		expect(exitCode).toBe(0);
		expect(fs.existsSync(dir)).toBe(false);
		expect(output).not.toContain("temp-dir-janitor:");
	}, 30_000);

	it("stays quiet when a suite already removed its own scratch", async () => {
		// Cleaning up after yourself is the outcome this module wants, so it must not be
		// reported as a failure to collect.
		const { output } = await runInChild(`
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-janitor-selfcleaned-"));
			fs.rmSync(dir, { recursive: true, force: true });
			console.log("TEMPDIR=" + dir);
		`);

		expect(output).not.toContain("temp-dir-janitor:");
	}, 30_000);
});

describe("the wording of the report", () => {
	/** No failures is silence, not an empty line printed on every clean run. */
	it("is null when nothing failed", () => {
		expect(describeUncollected([])).toBeNull();
	});

	/** Exact bytes for one failure: the path and the reason both appear, on their own line. */
	it("names the single directory and its reason", () => {
		const message = describeUncollected([{ dir: "/tmp/veyyon-a", reason: "EACCES: permission denied" }]);

		expect(message).toBe(
			"temp-dir-janitor: 1 scratch directory could not be removed and is left behind:\n" +
				"  /tmp/veyyon-a: EACCES: permission denied",
		);
	});

	/** Plural agreement, because a message that reads "1 directories" gets ignored as noise. */
	it("agrees in number for more than one", () => {
		const message = describeUncollected([
			{ dir: "/tmp/veyyon-a", reason: "EACCES" },
			{ dir: "/tmp/veyyon-b", reason: "EBUSY" },
		]);

		expect(message).toBe(
			"temp-dir-janitor: 2 scratch directories could not be removed and are left behind:\n" +
				"  /tmp/veyyon-a: EACCES\n" +
				"  /tmp/veyyon-b: EBUSY",
		);
	});

	/** Every path is listed, not a truncated sample: the ones omitted are the ones nobody finds. */
	it("lists every directory rather than a sample", () => {
		const failed = Array.from({ length: 12 }, (_, index) => ({
			dir: `/tmp/veyyon-${index}`,
			reason: "EACCES",
		}));

		const message = describeUncollected(failed) ?? "";

		for (const { dir } of failed) expect(message).toContain(dir);
		expect(message.split("\n").length).toBe(13);
	});
});
