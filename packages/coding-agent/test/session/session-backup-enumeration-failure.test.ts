import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	clearUnreadableSessions,
	getUnreadableSessions,
	listSessions,
	recoverOrphanedBackups,
} from "@veyyon/coding-agent/session/session-listing";
import { MemorySessionStorage } from "@veyyon/coding-agent/session/session-storage";

const DIR = "/sessions/project";

function sessionBody(id: string): string {
	return [
		JSON.stringify({ type: "session", id, cwd: "/repo", timestamp: "2026-07-29T00:00:00.000Z" }),
		JSON.stringify({ type: "message", message: { role: "user", content: "keep this session" } }),
		"",
	].join("\n");
}

function filesystemError(code: string, message: string): Error & { code: string } {
	const error = new Error(message) as Error & { code: string };
	error.code = code;
	return error;
}

class BackupEnumerationStorage extends MemorySessionStorage {
	backupEnumerationError: (Error & { code: string }) | undefined;
	readonly renames: Array<{ from: string; to: string }> = [];

	override listFilesSync(dir: string, pattern: string): string[] {
		if (pattern === "*.bak" && this.backupEnumerationError) throw this.backupEnumerationError;
		return super.listFilesSync(dir, pattern);
	}

	override async rename(from: string, to: string): Promise<void> {
		this.renames.push({ from, to });
		await super.rename(from, to);
	}
}

beforeEach(() => {
	clearUnreadableSessions();
});

afterEach(() => {
	clearUnreadableSessions();
});

describe("session backup enumeration failure", () => {
	/**
	 * A permissions failure while globbing backups used to be swallowed, stranding the only backup copy
	 * without any operator-visible reason. It must now report the exact directory and cause, avoid every
	 * rename, preserve the backup bytes, and still list independent primary sessions safely.
	 */
	it("reports a non-ENOENT failure without mutating backups or hiding primary sessions", async () => {
		const storage = new BackupEnumerationStorage();
		const safePrimary = `${DIR}/safe.jsonl`;
		const strandedBackup = `${DIR}/stranded.jsonl.1700000000000.bak`;
		const backupBytes = sessionBody("stranded-id");
		storage.writeTextSync(safePrimary, sessionBody("safe-id"));
		storage.writeTextSync(strandedBackup, backupBytes);
		storage.backupEnumerationError = filesystemError("EACCES", "EACCES: backup enumeration denied");

		const sessions = await listSessions(DIR, storage);

		expect(sessions.map(session => session.id)).toEqual(["safe-id"]);
		expect(getUnreadableSessions()).toEqual([
			{ path: DIR, reason: "EACCES: backup enumeration denied", kind: "directory" },
		]);
		expect(storage.renames).toEqual([]);
		expect(await storage.readText(strandedBackup)).toBe(backupBytes);
		expect(storage.existsSync(`${DIR}/stranded.jsonl`)).toBe(false);
	});

	/**
	 * ENOENT means the session directory genuinely does not exist yet, which is the normal first-run case;
	 * backup recovery must remain quiet rather than presenting an actionable-looking failure to the operator.
	 */
	it("keeps an absent backup directory quiet", async () => {
		const storage = new BackupEnumerationStorage();
		storage.backupEnumerationError = filesystemError("ENOENT", "ENOENT: no such directory");

		await recoverOrphanedBackups(DIR, storage);

		expect(getUnreadableSessions()).toEqual([]);
		expect(storage.renames).toEqual([]);
	});

	/**
	 * The failure branch must not weaken ordinary crash recovery: once enumeration works, an orphaned backup
	 * whose primary is absent is still promoted byte-for-byte and appears in the normal session listing.
	 */
	it("still promotes and lists an orphaned backup when enumeration succeeds", async () => {
		const storage = new BackupEnumerationStorage();
		const primary = `${DIR}/recovered.jsonl`;
		const backup = `${primary}.1700000000000.bak`;
		const backupBytes = sessionBody("recovered-id");
		storage.writeTextSync(backup, backupBytes);

		const sessions = await listSessions(DIR, storage);

		expect(sessions.map(session => session.id)).toEqual(["recovered-id"]);
		expect(storage.renames).toEqual([{ from: backup, to: primary }]);
		expect(await storage.readText(primary)).toBe(backupBytes);
		expect(storage.existsSync(backup)).toBe(false);
		expect(getUnreadableSessions()).toEqual([]);
	});
});
