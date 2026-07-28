/**
 * Moving a session to a new cwd must not leave its transcript behind and carry on as though empty.
 *
 * WHAT `setCwd` DOES. When the session directory changes, the manager renames the session file into the
 * new directory, repoints `#sessionFile` at the new path, and rewrites there if the file existed or there
 * is history worth materializing. Whether to rename at all came from
 * `sessionFileExisted = this.#storage.existsSync(oldSessionFile)`.
 *
 * THE BUG. `existsSync` answers `false` for a path it cannot reach as readily as for one that is absent,
 * and `#sessionFile` is repointed either way. So an old session directory that could not be traversed (a
 * mount that went away, permissions changed under it) skipped the rename, left the transcript orphaned at
 * the old path, and continued with a session that believed it had no file: with no assistant message to
 * force a rewrite, the operator's history was simply gone from their point of view, and nothing failed.
 *
 * WHY THIS ONE THROWS while the draft-only cleanup KEEPS. Opposite resolutions of the same contract,
 * because the branches differ. There, `false` deletes, and refusing to delete costs one small file. Here,
 * `false` silently loses the past, and the only way to not lose it is to attempt the work: the flag governs
 * both the rename and the closing rewrite, so treating an unreachable old file as present makes whichever
 * step cannot proceed fail with the real errno, roll back, and rethrow. In THIS construction the session
 * directory comes from the agent directory rather than the cwd, so the path does not change and the failure
 * arrives through the atomic rewrite; when the directory really does change it arrives through the rename.
 * Either way `setCwd` reports EACCES, which is recoverable, instead of succeeding into an amnesiac session,
 * and `setCwd` is an interactive operation with a caller who can be told.
 *
 * `chmod 0o000` DOES NOT DENY ROOT, so the denial is verified and the case skips rather than passing for
 * the wrong reason.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { FileSessionStorage } from "@veyyon/coding-agent/session/session-storage";
import { TempDir } from "@veyyon/utils";

const tempDirs: TempDir[] = [];

function makeTempDir(prefix: string): string {
	const dir = TempDir.createSync(prefix);
	tempDirs.push(dir);
	return dir.path();
}

afterEach(async () => {
	for (const dir of tempDirs) await fs.chmod(dir.path(), 0o700).catch(() => {});
	await Promise.all(tempDirs.splice(0).map(dir => dir.remove()));
});

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

describe("setCwd with an unreachable session file", () => {
	/**
	 * It FAILS rather than moving on without the transcript.
	 *
	 * The session is materialized first (a draft is enough), then the directory holding the session file is
	 * made untraversable, then the cwd moves. Before the fix this resolved without error, having quietly
	 * left the only copy of the conversation at a path the session no longer refers to.
	 *
	 * Non-vacuity is pinned in the assertion above the call rather than argued in prose: the boolean probe
	 * answers `false` for that exact path right now, which is the answer that used to skip the rename, so a
	 * change back to it fails here first.
	 */
	it("throws instead of silently orphaning the session file", async () => {
		const root = makeTempDir("@pi-setcwd-unreachable-");
		const first = path.join(root, "first");
		const second = path.join(root, "second");
		await fs.mkdir(first, { recursive: true });
		await fs.mkdir(second, { recursive: true });

		const session = SessionManager.create(first, root);
		session.appendModelChange("hai-proxy/anthropic--claude-4.6-opus");
		await session.saveDraft("history that must not be abandoned");

		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected persistent session file");
		const holdingDir = path.dirname(sessionFile);

		if (!(await denyTraverse(holdingDir))) return;
		try {
			expect(new FileSessionStorage().existsSync(sessionFile)).toBe(false);
			expect(new FileSessionStorage().existsStateSync(sessionFile)).toBe("unreadable");

			await expect(session.setCwd(second)).rejects.toThrow();
		} finally {
			await fs.chmod(holdingDir, 0o700).catch(() => {});
		}

		// The transcript is still where it was, which is the point: nothing was moved or lost, and the
		// caller was told, so the operator can fix the directory and try again.
		expect(await Bun.file(sessionFile).exists()).toBe(true);
	});

	/**
	 * A reachable move still succeeds, so the guard has not made every `setCwd` fail.
	 *
	 * The half that must not regress: `setCwd` runs whenever the operator changes directory, and a fix that
	 * refused whenever it was unsure would break the common path.
	 *
	 * Asserted on the resolved cwd and on the transcript surviving, NOT on the file changing path. The
	 * session directory here comes from the AGENT directory rather than from the cwd, so this move leaves
	 * the file where it is; an assertion that the path changed passed for a while only because it was never
	 * run against this construction, and it is the reason the failure above surfaces through the atomic
	 * rewrite rather than through the rename.
	 */
	it("still succeeds when the old location is reachable", async () => {
		const root = makeTempDir("@pi-setcwd-reachable-");
		const first = path.join(root, "first");
		const second = path.join(root, "second");
		await fs.mkdir(first, { recursive: true });
		await fs.mkdir(second, { recursive: true });

		const session = SessionManager.create(first, root);
		session.appendModelChange("hai-proxy/anthropic--claude-4.6-opus");
		await session.saveDraft("history that travels");

		const before = session.getSessionFile();
		if (!before) throw new Error("Expected persistent session file");

		expect(await session.setCwd(second)).toBe(second);

		const after = session.getSessionFile();
		if (!after) throw new Error("Expected the session to keep a file after the move");
		expect(await Bun.file(after).exists()).toBe(true);
	});
});
