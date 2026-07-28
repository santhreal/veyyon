/**
 * Closing must not delete a draft-only session when it cannot tell whether the draft is still there.
 *
 * THE BUG, and it destroys the operator's text. `#dropIfEmptyAndNoDraft` deletes a session file whose
 * entries are all metadata, so a ctrl+D on an untouched session does not leave a zombie behind. A DRAFT is
 * the thing that makes such a session worth keeping, and the guard was
 * `if (draftPath && this.#storage.existsSync(draftPath)) return;`.
 *
 * `existsSync` answers `false` for a path it cannot reach exactly as it does for one that is absent, and
 * the draft does NOT live beside the session file: it is `<artifactsDir>/draft.txt`, a different directory.
 * So an artifacts directory that could not be traversed (permissions, a mount that went away) answered "no
 * draft", the guard fell through, and `deleteSessionWithArtifacts` removed the session together with the
 * draft inside it. The operator loses unsent text, silently, because a directory was briefly unavailable.
 *
 * THE FIX IS TO KEEP, NOT TO THROW. `existsStateSync` gives the three answers and the guard now returns for
 * anything that is not `absent`. Keeping a session that might be empty costs one small file that a later
 * close will drop once the directory is readable again; deleting one that had a draft cannot be undone.
 * Throwing was the other option and is wrong here: this runs on the close path, where an exception would
 * mask the reason the session is ending.
 *
 * `chmod 0o000` DOES NOT DENY ROOT, so the denial is verified and the case skips rather than passing for
 * the wrong reason.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { FileSessionStorage } from "@veyyon/coding-agent/session/session-storage";
import { attachFaultSink, type Fault, isEnoent, TempDir } from "@veyyon/utils";

async function fileExists(p: string): Promise<boolean> {
	try {
		await Bun.file(p).stat();
		return true;
	} catch (err) {
		if (isEnoent(err)) return false;
		throw err;
	}
}

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

describe("SessionManager.close() with an unreachable artifacts directory", () => {
	/**
	 * The session SURVIVES, and the operator is told why the answer was unknown.
	 *
	 * A draft is written (which materializes both the session file and the artifacts directory), then the
	 * artifacts directory is made untraversable, then the session is closed. Before the fix the draft read
	 * as absent and the session was deleted along with it. The fault is asserted too, because a session
	 * that survives for a reason nobody can see is the next person's mystery.
	 */
	it("keeps the session instead of deleting it with the draft inside", async () => {
		using tempDir = TempDir.createSync("@pi-session-close-unreachable-draft-");
		const faults: Fault[] = [];
		const detach = attachFaultSink(fault => faults.push(fault));
		try {
			const session = SessionManager.create(tempDir.path(), tempDir.path());
			session.appendModelChange("hai-proxy/anthropic--claude-4.6-opus");
			await session.saveDraft("text I have not sent yet");

			const sessionFile = session.getSessionFile();
			const artifactsDir = session.getArtifactsDir();
			if (!sessionFile) throw new Error("Expected persistent session file");
			if (!artifactsDir) throw new Error("Expected an artifacts directory");
			expect(await fileExists(path.join(artifactsDir, "draft.txt"))).toBe(true);

			if (!(await denyTraverse(artifactsDir))) return;
			try {
				// NON-VACUITY, pinned rather than argued. The guard this replaced was
				// `storage.existsSync(draftPath)`, and that probe answers `false` for this exact path right
				// now: "no draft", which is what fell through to the delete. So the assertions below can
				// only pass because the guard reads the three-state answer instead of the boolean, and a
				// future change back to the boolean fails this line before it fails the survival check.
				expect(new FileSessionStorage().existsSync(path.join(artifactsDir, "draft.txt"))).toBe(false);
				expect(new FileSessionStorage().existsStateSync(path.join(artifactsDir, "draft.txt"))).toBe("unreadable");

				await session.close();

				expect(await fileExists(sessionFile)).toBe(true);
				expect(faults.map(fault => fault.source)).toContain("session");
			} finally {
				await fs.chmod(artifactsDir, 0o700).catch(() => {});
			}

			// And the draft is still in there, which is the thing that was actually being lost.
			expect(await fileExists(path.join(artifactsDir, "draft.txt"))).toBe(true);
		} finally {
			detach();
		}
	});

	/**
	 * A REACHABLE artifacts directory with no draft still drops the session, unchanged.
	 *
	 * The half that must not regress. The cleanup exists because every ctrl+D on an untouched session used
	 * to leak a metadata-only file, so a fix that kept sessions whenever it was unsure would be worthless
	 * if it also kept them when it was sure. Same flow as the case above with the denial removed.
	 */
	it("still drops the session when the draft is genuinely gone", async () => {
		using tempDir = TempDir.createSync("@pi-session-close-reachable-no-draft-");
		const session = SessionManager.create(tempDir.path(), tempDir.path());
		session.appendModelChange("hai-proxy/anthropic--claude-4.6-opus");
		await session.saveDraft("text I will clear");
		await session.saveDraft("");

		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected persistent session file");

		await session.close();

		expect(await fileExists(sessionFile)).toBe(false);
	});
});
