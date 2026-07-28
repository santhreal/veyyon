import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { replaceBinaryForUpdate } from "../src/cli/update-cli";

/**
 * `veyyon update` replaces the binary that is running it.
 *
 * That is the ordinary case, not an edge one: the user types `veyyon update` and
 * the process doing the work IS the file being overwritten. Every other test of
 * the swap operates on a binary nothing is executing, which is the one state a
 * real update never happens in.
 *
 * The contract has two halves and they pull in opposite directions. The running
 * process must survive to finish its own update and print its own summary, and
 * the very next invocation must get the NEW version. Both hold only because the
 * swap is a rename: the running process keeps the inode it was started from, and
 * the path stops pointing at it. A swap that truncated and rewrote the file in
 * place would satisfy the second half and kill the first, mid-update, leaving
 * the user with no idea whether it finished.
 *
 * These are POSIX assertions. Windows cannot delete the image of a live process
 * at all, which is why the backup removal is best effort there and
 * `sweepStaleBackups` finishes the job on a later run; that half is covered by
 * `update-killed-mid-swap.test.ts`.
 */

/** Sleeps long enough to still be running through the swap, then reports its version. */
function longRunningBinary(version: string): string {
	return `#!/bin/sh\nif [ "\${1:-}" = "--wait" ]; then sleep 2; fi\necho "veyyon/${version}"\n`;
}

const OLD_VERSION = "1.0.0";
const NEW_VERSION = "2.0.0";

interface Layout {
	dir: string;
	target: string;
	temp: string;
	backup: string;
}

async function makeLayout(): Promise<Layout> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-update-running-"));
	const target = path.join(dir, "veyyon");
	const temp = path.join(dir, "veyyon.new");
	await fs.writeFile(target, longRunningBinary(OLD_VERSION), { mode: 0o755 });
	await fs.writeFile(temp, longRunningBinary(NEW_VERSION), { mode: 0o755 });
	return { dir, target, temp, backup: path.join(dir, "veyyon.1700000000000.4242.bak") };
}

async function swap(layout: Layout): Promise<void> {
	await replaceBinaryForUpdate({
		targetPath: layout.target,
		tempPath: layout.temp,
		backupPath: layout.backup,
		expectedVersion: NEW_VERSION,
		// Bound to the path, which is what production does: re-resolving the name
		// through PATH would ask what PATH picks right now, a different question.
		verifyInstalledVersion: async () => ({ ok: true, reportedVersion: NEW_VERSION }),
	});
}

describe("replacing the binary that is currently running", () => {
	/**
	 * The half that a truncate-and-rewrite implementation would break: the process
	 * already executing the old image has to run to completion. Asserted by its
	 * exit code AND its output, because a killed process and a process that never
	 * started both fail to produce output, and only one of them is the defect.
	 */
	it("lets the already-running process finish normally", async () => {
		const layout = await makeLayout();
		try {
			const running = Bun.spawn([layout.target, "--wait"], { stdout: "pipe", stderr: "pipe" });
			// Give it a moment to be executing rather than merely spawned.
			await Bun.sleep(200);

			await swap(layout);

			expect(await running.exited).toBe(0);
			expect((await new Response(running.stdout).text()).trim()).toBe(`veyyon/${OLD_VERSION}`);
		} finally {
			await fs.rm(layout.dir, { recursive: true, force: true });
		}
	}, 20_000);

	/**
	 * The other half. A rename that the running process somehow held open would
	 * leave the path serving the old version, so the update would report success
	 * and change nothing until the machine was rebooted.
	 */
	it("serves the new version to the very next invocation", async () => {
		const layout = await makeLayout();
		try {
			const running = Bun.spawn([layout.target, "--wait"], { stdout: "pipe", stderr: "pipe" });
			await Bun.sleep(200);

			await swap(layout);

			const next = Bun.spawnSync([layout.target]);
			expect(next.exitCode).toBe(0);
			expect(next.stdout.toString().trim()).toBe(`veyyon/${NEW_VERSION}`);

			await running.exited;
		} finally {
			await fs.rm(layout.dir, { recursive: true, force: true });
		}
	}, 20_000);

	/**
	 * The bytes on disk, not just what the file prints. A partial write also
	 * changes the output, and a file left non-executable is an install the user's
	 * shell can no longer run.
	 */
	it("leaves the new binary whole and executable at the same path", async () => {
		const layout = await makeLayout();
		try {
			const running = Bun.spawn([layout.target, "--wait"], { stdout: "pipe", stderr: "pipe" });
			await Bun.sleep(200);

			await swap(layout);

			expect(await fs.readFile(layout.target, "utf8")).toBe(longRunningBinary(NEW_VERSION));
			expect(((await fs.stat(layout.target)).mode & 0o111) !== 0).toBe(true);
			await running.exited;
		} finally {
			await fs.rm(layout.dir, { recursive: true, force: true });
		}
	}, 20_000);

	/**
	 * And it leaves nothing behind, even though a process is still executing the
	 * image it just moved aside. That is safe on POSIX precisely because the
	 * running process holds the INODE: unlinking the backup takes the name away
	 * and the bytes stay alive until the last descriptor closes. On Windows the
	 * same removal fails while the process lives, which is why the removal is
	 * best effort and `sweepStaleBackups` exists to finish the job later.
	 */
	it("leaves no backup or staged download in the install directory", async () => {
		const layout = await makeLayout();
		try {
			const running = Bun.spawn([layout.target, "--wait"], { stdout: "pipe", stderr: "pipe" });
			await Bun.sleep(200);

			await swap(layout);

			expect(await fs.readdir(layout.dir)).toEqual(["veyyon"]);
			// The still-running process is unaffected by losing the backup's name.
			expect(await running.exited).toBe(0);
		} finally {
			await fs.rm(layout.dir, { recursive: true, force: true });
		}
	}, 20_000);
});
