import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { writeFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { withFileLock, withFileLockSync } from "../src/file-lock";
import * as logger from "../src/logger";
import { removeWithRetries } from "../src/temp";

/**
 * A lock that was lost, or that could not be released, has to be said out loud.
 *
 * `releaseLock` had two silent paths. The first fired when the token on disk no
 * longer matched ours, which is not a bookkeeping detail: it means the lock
 * went stale and was reaped, or another process reclaimed it, WHILE this
 * process was still inside the critical section. Two holders overlapped, so the
 * work the lock exists to serialise was not serialised. It was a
 * `logger.debug`. The second was a bare `catch { /* Ignore errors on release
 * *\/ }` around the removal, which leaves the lock directory sitting on disk
 * blocking every other process until the stale reaper reaches it.
 *
 * Both are Law 10 in its purest form: the mechanism failed, something else
 * happened instead, the call returned normally, and the operator was told
 * nothing. The damage from the first one surfaces much later, as a corrupt
 * file or a lost write, with nothing at all connecting it back to the lock.
 *
 * Neither report changes behaviour. Not releasing a lock we no longer own is
 * still correct (removing it would wipe the rightful owner's), and release
 * still never throws at the caller because it runs in `finally` blocks where
 * an exception would mask the real error.
 */
describe("A lost or unreleasable file lock is reported", () => {
	let dir = "";
	let warnings: Array<{ message: string; fields: Record<string, unknown> }>;

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-filelock-loud-"));
		warnings = [];
		vi.spyOn(logger, "warn").mockImplementation((message: string, fields?: Record<string, unknown>) => {
			warnings.push({ message, fields: fields ?? {} });
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (dir) {
			await removeWithRetries(dir);
			dir = "";
		}
	});

	const target = () => path.join(dir, "guarded.json");
	const lockPath = () => `${target()}.lock`;
	const lostWarnings = () => warnings.filter(entry => entry.message.includes("taken by another process"));
	const releaseWarnings = () => warnings.filter(entry => entry.message.includes("could not remove the lock"));

	/**
	 * The core case, staged the way it actually happens: the lock goes stale, a
	 * reaper or rival takes it, and our holder is still running. The rival's
	 * token is written under the same path while we are inside the section.
	 */
	test("warns when another process took the lock before this holder finished", async () => {
		await withFileLock(target(), async () => {
			// Stand in for the rival process: same lock directory, different token.
			await fs.writeFile(
				path.join(lockPath(), "info"),
				JSON.stringify({ pid: process.pid, timestamp: Date.now(), token: "rival-token" }),
			);
		});

		const reported = lostWarnings();
		expect(reported).toHaveLength(1);
		expect(reported[0]?.message).toContain("not actually exclusive");
		// The tunable that fixes it has to be in the message, or the reader has
		// nothing to act on.
		expect(reported[0]?.message).toContain("longer lock timeout");
		expect(reported[0]?.fields.actualToken).toBe("rival-token");
		expect(reported[0]?.fields.lockPath).toBe(lockPath());
	});

	/**
	 * The behaviour must not change: the rival's lock is left alone. Removing it
	 * is the bug the silent skip existed to avoid, and a fix that made the code
	 * louder while wiping the rival's lock would be far worse than the original.
	 */
	test("leaves the other process's lock in place rather than wiping it", async () => {
		await withFileLock(target(), async () => {
			await fs.writeFile(
				path.join(lockPath(), "info"),
				JSON.stringify({ pid: process.pid, timestamp: Date.now(), token: "rival-token" }),
			);
		});

		const info = JSON.parse(await fs.readFile(path.join(lockPath(), "info"), "utf8")) as { token: string };
		expect(info.token).toBe("rival-token");
	});

	/**
	 * A lock that vanished entirely is the same overlap, reached by the reaper
	 * rather than a rival, and needs the same warning. The `actualToken` field
	 * has to stay readable rather than serialising as `undefined`.
	 */
	test("warns when the lock vanished before release, naming it as gone", async () => {
		await withFileLock(target(), async () => {
			await removeWithRetries(lockPath());
		});

		const reported = lostWarnings();
		expect(reported).toHaveLength(1);
		expect(reported[0]?.fields.actualToken).toBe("(lock is gone)");
	});

	/**
	 * The sync holder shares the on-disk layout, so it must share the report. A
	 * fix applied to only one path would leave `withFileLockSync` callers exactly
	 * as blind as before, and they contend on the same locks.
	 */
	test("warns from the sync path on the same overlap", () => {
		withFileLockSync(target(), () => {
			writeFileSync(
				path.join(lockPath(), "info"),
				JSON.stringify({ pid: process.pid, timestamp: Date.now(), token: "rival-token-sync" }),
			);
		});

		const reported = lostWarnings();
		expect(reported).toHaveLength(1);
		expect(reported[0]?.fields.actualToken).toBe("rival-token-sync");
	});

	/**
	 * The ordinary path must be completely silent. Without this the suite would
	 * pass against an implementation that warned on every release, which happens
	 * on every guarded write and would bury the one line that matters within
	 * seconds.
	 */
	test("says nothing when the lock is held and released normally", async () => {
		const result = await withFileLock(target(), async () => "done");

		expect(result).toBe("done");
		expect(lostWarnings()).toHaveLength(0);
		expect(releaseWarnings()).toHaveLength(0);
	});

	/**
	 * A lock that is already gone at release time is not a failed removal, it is
	 * a removal with nothing to do. This is the twin that keeps the release
	 * report from firing on the benign reaper race.
	 */
	test("says nothing about a removal that had nothing left to remove", async () => {
		await withFileLock(target(), async () => {
			await removeWithRetries(lockPath());
		});

		expect(releaseWarnings()).toHaveLength(0);
	});

	/**
	 * The lock is still released for the caller who owns it, and the section's
	 * value still comes back. This pins that adding the reports did not turn
	 * release into a path that returns early or throws.
	 */
	test("still removes the lock it owns", async () => {
		await withFileLock(target(), async () => undefined);

		await expect(fs.stat(lockPath())).rejects.toThrow();
	});
});
