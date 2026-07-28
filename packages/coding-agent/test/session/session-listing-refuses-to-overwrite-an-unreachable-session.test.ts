/**
 * Recovering an orphaned session backup must never rename it over a session that is merely out of reach.
 *
 * WHAT THE RECOVERY IS FOR. `FileSessionStorage.writeTextAtomic` moves the live session file aside to
 * `<primary>.<snowflake>.bak` before publishing a new body, so a crash between its two renames can leave the
 * user's last good state stranded under a name the `*.jsonl` loader never globs. `recoverOrphanedBackups`
 * runs once per session-dir scan and promotes such a backup back to its primary path.
 *
 * THE BUG, and it destroys the very thing the recovery exists to protect. Promotion is a `rename`, which
 * overwrites its destination without asking, so the probe deciding whether to promote is one whose false
 * branch is destructive. That probe was `storage.existsSync(primaryPath)`, and `existsSync` answers `false`
 * for a path it cannot REACH exactly as it does for one that is ABSENT. A session directory that could not be
 * traversed, or a primary path resolving through one that could not, therefore read as "no session here" and
 * the recovery renamed a stale `.bak` over a live conversation. The operator's history silently replaced by
 * an older copy of itself, because a mount was briefly unavailable.
 *
 * THE FIX REFUSES rather than throws. `existsStateSync` separates the two answers and only a definite
 * `absent` promotes; `unreadable` leaves both files exactly where they are and records through this module's
 * existing `recordUnreadableSession` channel, so the backup stays recoverable on the next scan once the path
 * is reachable again. Throwing would be wrong here: this runs inside directory listing, where one unreachable
 * session must not take out the whole list.
 *
 * THE SECOND HALF is the backup that cannot be MEASURED. The mtime pick used to `continue` on any `statSync`
 * failure, which dropped the candidate entirely: the only copy of a session stayed stranded as a `.bak` and
 * nothing anywhere said why. It now competes at mtime 0, so a measurable backup still wins the pick and a
 * lone unmeasurable one is still attempted, with its own failure reported by the promotion below.
 *
 * `chmod 0o000` DOES NOT DENY ROOT, so the real-filesystem case verifies the denial and skips rather than
 * passing for the wrong reason.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	clearUnreadableSessions,
	getUnreadableSessions,
	recoverOrphanedBackups,
} from "@veyyon/coding-agent/session/session-listing";
import { FileSessionStorage, MemorySessionStorage } from "@veyyon/coding-agent/session/session-storage";
import { type PathState, TempDir } from "@veyyon/utils";

const LIVE = '{"type":"session","id":"live","keep":true}\n';
const STALE = '{"type":"session","id":"live","stale":true}\n';

/**
 * A storage whose reachability answer is dictated per path.
 *
 * The real fault is a filesystem state, and reproducing it on a real disk needs a symlink through a denied
 * directory (done below) which cannot run as root. This stub covers the BRANCH deterministically and
 * everywhere: what the recovery does once a path answers `unreadable`, whatever produced that answer.
 */
class ReachabilityStubStorage extends MemorySessionStorage {
	readonly states = new Map<string, PathState>();
	/** Paths whose `statSync` throws, and the code it throws with. */
	readonly statFailures = new Map<string, string>();
	renames: Array<{ from: string; to: string }> = [];

	override existsStateSync(p: string): PathState {
		return this.states.get(p) ?? super.existsStateSync(p);
	}

	override statSync(p: string): ReturnType<MemorySessionStorage["statSync"]> {
		const code = this.statFailures.get(p);
		if (code !== undefined) {
			const error = new Error(`${code}: forced stat failure for ${p}`) as Error & { code: string };
			error.code = code;
			throw error;
		}
		return super.statSync(p);
	}

	override async rename(from: string, to: string): Promise<void> {
		this.renames.push({ from, to });
		await super.rename(from, to);
	}
}

const tempDirs: TempDir[] = [];

/** Make a directory untraversable, and say whether that actually denied us. */
async function denyTraverse(dir: string): Promise<boolean> {
	await fs.chmod(dir, 0o000);
	try {
		await fs.stat(path.join(dir, "probe"));
		await fs.chmod(dir, 0o700);
		return false;
	} catch (err) {
		if ((err as { code?: string }).code === "ENOENT") {
			await fs.chmod(dir, 0o700);
			return false;
		}
		return true;
	}
}

beforeEach(() => {
	clearUnreadableSessions();
});

afterEach(async () => {
	clearUnreadableSessions();
	for (const dir of tempDirs) await fs.chmod(dir.path(), 0o700).catch(() => {});
	await Promise.all(tempDirs.splice(0).map(dir => dir.remove()));
});

describe("recoverOrphanedBackups with a primary it cannot reach", () => {
	/**
	 * It PROMOTES NOTHING, and both files survive byte-for-byte.
	 *
	 * The core assertion of the whole suite: the destructive branch is not taken. Asserted on the primary's
	 * CONTENT rather than on its existence, because a `rename` over it leaves a file at that path either
	 * way and only the bytes say which one won.
	 */
	it("leaves the live session and its backup exactly where they are", async () => {
		const storage = new ReachabilityStubStorage();
		const dir = "/sessions/proj";
		const primary = `${dir}/session-live.jsonl`;
		const backup = `${primary}.1700000000000.bak`;
		storage.writeTextSync(primary, LIVE);
		storage.writeTextSync(backup, STALE);
		storage.states.set(primary, "unreadable");

		// NON-VACUITY, pinned rather than argued. The probe this replaced answers `false` for this exact
		// path, which is the answer that used to promote the stale backup over the live session, so a
		// change back to the boolean fails here before it fails the content check below.
		expect(storage.existsSync(primary)).toBe(true);
		expect(storage.existsStateSync(primary)).toBe("unreadable");

		await recoverOrphanedBackups(dir, storage);

		expect(storage.renames).toEqual([]);
		expect(await storage.readText(primary)).toBe(LIVE);
		expect(await storage.readText(backup)).toBe(STALE);
	});

	/**
	 * The refusal is VISIBLE, because a recovery that quietly declines is the next person's mystery.
	 *
	 * `getUnreadableSessions()` is the channel a surface already reads to tell the operator what the last
	 * listing could not see, so the refusal reports there rather than into the log alone. Asserted on the
	 * recorded path and kind, so the entry names the file the operator has to fix.
	 */
	it("records the primary it could not reach", async () => {
		const storage = new ReachabilityStubStorage();
		const dir = "/sessions/proj";
		const primary = `${dir}/session-live.jsonl`;
		storage.writeTextSync(primary, LIVE);
		storage.writeTextSync(`${primary}.1700000000000.bak`, STALE);
		storage.states.set(primary, "unreadable");

		await recoverOrphanedBackups(dir, storage);

		const recorded = getUnreadableSessions();
		expect(recorded.map(entry => entry.path)).toEqual([primary]);
		expect(recorded[0]?.kind).toBe("file");
		expect(recorded[0]?.reason).toContain("could not be reached");
	});

	/**
	 * An ABSENT primary still gets its backup promoted, unchanged.
	 *
	 * The half that must not regress, and the reason the fix is a three-state read rather than "never
	 * promote when unsure": the recovery exists because a crash mid-rewrite strands the user's last good
	 * state, and a version that refused whenever it could not be certain would strand it forever.
	 */
	it("still promotes the backup when the primary is genuinely absent", async () => {
		const storage = new ReachabilityStubStorage();
		const dir = "/sessions/proj";
		const primary = `${dir}/session-gone.jsonl`;
		const backup = `${primary}.1700000000000.bak`;
		storage.writeTextSync(backup, STALE);

		expect(storage.existsStateSync(primary)).toBe("absent");

		await recoverOrphanedBackups(dir, storage);

		expect(storage.renames).toEqual([{ from: backup, to: primary }]);
		expect(await storage.readText(primary)).toBe(STALE);
		expect(storage.existsSync(backup)).toBe(false);
		expect(getUnreadableSessions()).toEqual([]);
	});

	/**
	 * A PRESENT primary is still left alone without reporting anything.
	 *
	 * The quiet case, pinned so the new reporting cannot start firing on the ordinary path: a primary that
	 * is simply there is not a fault, and a listing that recorded one on every scan would train the
	 * operator to ignore the channel.
	 */
	it("says nothing when the primary is present", async () => {
		const storage = new ReachabilityStubStorage();
		const dir = "/sessions/proj";
		const primary = `${dir}/session-here.jsonl`;
		storage.writeTextSync(primary, LIVE);
		storage.writeTextSync(`${primary}.1700000000000.bak`, STALE);

		await recoverOrphanedBackups(dir, storage);

		expect(storage.renames).toEqual([]);
		expect(await storage.readText(primary)).toBe(LIVE);
		expect(getUnreadableSessions()).toEqual([]);
	});

	/**
	 * The refusal is per-primary, so one unreachable session does not block the recovery of another.
	 *
	 * The scan covers a whole directory, and the earlier `continue`-shaped failures in this function all
	 * had the property that one bad entry cost the others nothing. The fix must keep that: an operator with
	 * one broken path still gets every other session back.
	 */
	it("recovers the reachable sessions in the same directory anyway", async () => {
		const storage = new ReachabilityStubStorage();
		const dir = "/sessions/proj";
		const blocked = `${dir}/session-blocked.jsonl`;
		const recoverable = `${dir}/session-recoverable.jsonl`;
		storage.writeTextSync(blocked, LIVE);
		storage.writeTextSync(`${blocked}.100.bak`, STALE);
		storage.writeTextSync(`${recoverable}.200.bak`, STALE);
		storage.states.set(blocked, "unreadable");

		await recoverOrphanedBackups(dir, storage);

		expect(storage.renames).toEqual([{ from: `${recoverable}.200.bak`, to: recoverable }]);
		expect(await storage.readText(blocked)).toBe(LIVE);
		expect(await storage.readText(recoverable)).toBe(STALE);
	});
});

describe("recoverOrphanedBackups with a backup it cannot measure", () => {
	/**
	 * A lone unmeasurable backup is STILL PROMOTED, where it used to be dropped in silence.
	 *
	 * This is the second defect the fix addresses. `catch { continue }` on the mtime read discarded the
	 * candidate, so a session whose only copy was a `.bak` the scan could not stat stayed invisible to the
	 * loader permanently, with nothing said. It competes at mtime 0 now, which for a single candidate means
	 * it is attempted exactly as a measurable one would be.
	 */
	it("promotes it instead of dropping the only copy of the session", async () => {
		const storage = new ReachabilityStubStorage();
		const dir = "/sessions/proj";
		const primary = `${dir}/session-unmeasured.jsonl`;
		const backup = `${primary}.1700000000000.bak`;
		storage.writeTextSync(backup, STALE);
		storage.statFailures.set(backup, "EACCES");

		await recoverOrphanedBackups(dir, storage);

		expect(storage.renames).toEqual([{ from: backup, to: primary }]);
		expect(await storage.readText(primary)).toBe(STALE);
	});

	/** And it says so, because a promotion made without knowing the mtime is worth one line. */
	it("records the backup whose mtime could not be read", async () => {
		const storage = new ReachabilityStubStorage();
		const dir = "/sessions/proj";
		const backup = `${dir}/session-unmeasured.jsonl.1700000000000.bak`;
		storage.writeTextSync(backup, STALE);
		storage.statFailures.set(backup, "EACCES");

		await recoverOrphanedBackups(dir, storage);

		const recorded = getUnreadableSessions();
		expect(recorded.map(entry => entry.path)).toEqual([backup]);
		expect(recorded[0]?.reason).toContain("could not be measured");
	});

	/**
	 * A backup that RACED AWAY stays quiet and is skipped.
	 *
	 * The boundary between the two answers. Between the glob and the stat, a concurrent recovery in another
	 * process can promote and unlink the same backup; ENOENT there means it is genuinely gone, so reporting
	 * it would be noise on a path that worked correctly.
	 */
	it("skips a backup that disappeared between the glob and the stat, without reporting it", async () => {
		const storage = new ReachabilityStubStorage();
		const dir = "/sessions/proj";
		const backup = `${dir}/session-raced.jsonl.1700000000000.bak`;
		storage.writeTextSync(backup, STALE);
		storage.statFailures.set(backup, "ENOENT");

		await recoverOrphanedBackups(dir, storage);

		expect(storage.renames).toEqual([]);
		expect(getUnreadableSessions()).toEqual([]);
	});

	/**
	 * A MEASURABLE backup beats an unmeasurable one for the same primary.
	 *
	 * Keeping the unmeasurable candidate must not corrupt the newest-wins pick, which is the function's
	 * whole reason for building a candidate map. Competing at mtime 0 is what makes that true, and the two
	 * backups are registered in the order that would fail if the comparison were `>=` or if the fallback
	 * overwrote a real measurement.
	 */
	it("prefers the backup whose mtime it can read", async () => {
		const storage = new ReachabilityStubStorage();
		const dir = "/sessions/proj";
		const primary = `${dir}/session-pick.jsonl`;
		const unmeasurable = `${primary}.100.bak`;
		const measurable = `${primary}.200.bak`;
		storage.writeTextSync(unmeasurable, "unmeasurable");
		storage.writeTextSync(measurable, "measurable");
		storage.statFailures.set(unmeasurable, "EACCES");

		await recoverOrphanedBackups(dir, storage);

		expect(await storage.readText(primary)).toBe("measurable");
		expect(storage.existsSync(measurable)).toBe(false);
		expect(storage.existsSync(unmeasurable)).toBe(true);
	});
});

describe("recoverOrphanedBackups on a real filesystem", () => {
	/**
	 * The fault the stub stands in for, reproduced on a real disk.
	 *
	 * WHY A SYMLINK. The refusal needs a primary that is unreachable while its directory is still listable,
	 * and a denied session directory cannot give that: the glob fails first and the function returns before
	 * reaching the probe. A primary that resolves THROUGH a denied directory does, and it is also a real
	 * shape rather than a contrived one, since a session directory holding symlinks into per-project storage
	 * is exactly where a permission change on one project produces this.
	 *
	 * It proves the piece the stub cannot: that `existsStateSync` really answers `unreadable` for a genuine
	 * filesystem fault, so the branch the other tests exercise is one production actually reaches.
	 */
	it("refuses to promote over a primary that resolves through a denied directory", async () => {
		const root = TempDir.createSync("@pi-session-recovery-unreachable-");
		tempDirs.push(root);
		const sessionDir = path.join(root.path(), "sessions");
		const denied = path.join(root.path(), "denied");
		await fs.mkdir(sessionDir, { recursive: true });
		await fs.mkdir(denied, { recursive: true });

		const target = path.join(denied, "real.jsonl");
		await fs.writeFile(target, LIVE);
		const primary = path.join(sessionDir, "session-linked.jsonl");
		await fs.symlink(target, primary);
		const backup = `${primary}.1700000000000.bak`;
		await fs.writeFile(backup, STALE);

		if (!(await denyTraverse(denied))) return;
		const storage = new FileSessionStorage();
		try {
			// The genuine fault, and the non-vacuity check in one: the boolean probe answers `false` for a
			// primary that is really there, which is what used to overwrite it.
			expect(storage.existsSync(primary)).toBe(false);
			expect(storage.existsStateSync(primary)).toBe("unreadable");

			await recoverOrphanedBackups(sessionDir, storage);

			expect(getUnreadableSessions().map(entry => entry.path)).toContain(primary);
		} finally {
			await fs.chmod(denied, 0o700).catch(() => {});
		}

		// The backup was not consumed and the linked session still holds its own bytes, which is the loss
		// this refusal prevents.
		expect(await Bun.file(backup).text()).toBe(STALE);
		expect(await Bun.file(target).text()).toBe(LIVE);
	});

	/**
	 * The same directory, reachable, still recovers: proof the real-filesystem path is not simply inert.
	 *
	 * Without this, the test above passes just as well against a recovery that never promotes anything on a
	 * real disk, which is the failure mode a refusal-shaped fix invites.
	 */
	it("promotes an orphaned backup when nothing is denied", async () => {
		const root = TempDir.createSync("@pi-session-recovery-reachable-");
		tempDirs.push(root);
		const sessionDir = path.join(root.path(), "sessions");
		await fs.mkdir(sessionDir, { recursive: true });

		const primary = path.join(sessionDir, "session-orphan.jsonl");
		const backup = `${primary}.1700000000000.bak`;
		await fs.writeFile(backup, STALE);

		await recoverOrphanedBackups(sessionDir, new FileSessionStorage());

		expect(await Bun.file(primary).text()).toBe(STALE);
		expect(await Bun.file(backup).exists()).toBe(false);
		expect(getUnreadableSessions()).toEqual([]);
	});
});
