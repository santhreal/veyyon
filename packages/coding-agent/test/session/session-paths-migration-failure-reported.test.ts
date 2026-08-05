/**
 * Locks out the two `catch {}` bodies around `migrateSessionDirPath` in
 * `session/session-paths.ts`.
 *
 * The legacy-to-canonical session directory migration runs once per sessions
 * root per process. When it threw, the catch discarded the error and the
 * canonical directory was created empty alongside the legacy one, so the
 * operator opened the session picker and saw a history that starts today: every
 * transcript that lived under the old directory name is still on disk and is
 * never listed again. Nothing said so.
 *
 * The fix is visibility, not fragility: the migration is still best-effort and
 * still must not fail session creation. If this regresses, a permanently failing
 * migration (a read-only sessions root, a directory the user cannot enter)
 * becomes undiagnosable.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { computeDefaultSessionDir } from "@veyyon/coding-agent/session/session-paths";
import type { SessionStorage } from "@veyyon/coding-agent/session/session-storage";
import { logger, removeWithRetries } from "@veyyon/utils";

let tempRoot = "";
let home = "";
let sessionsRoot = "";
let warnings: Array<{ message: string; fields: Record<string, unknown> }>;

const storage = {
	ensureDirSync: (dir: string) => {
		fs.mkdirSync(dir, { recursive: true });
	},
} as unknown as SessionStorage;

/** The legacy directory name `migrateHomeSessionDirs` looks for. */
function legacyName(relative: string): string {
	const homeEncoded = home.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-");
	return `--${homeEncoded}-${relative}--`;
}

beforeEach(async () => {
	tempRoot = fs.realpathSync(await fs.promises.mkdtemp(path.join(os.tmpdir(), "session-paths-migrate-")));
	home = path.join(tempRoot, "home");
	sessionsRoot = path.join(tempRoot, "sessions");
	fs.mkdirSync(home, { recursive: true });
	fs.mkdirSync(sessionsRoot, { recursive: true });
	warnings = [];
	vi.spyOn(os, "homedir").mockReturnValue(home);
	vi.spyOn(logger, "warn").mockImplementation((message: string, fields?: Record<string, unknown>) => {
		warnings.push({ message, fields: fields ?? {} });
	});
});

afterEach(async () => {
	vi.restoreAllMocks();
	// The unreadable fixture must be readable again before the tree can be removed.
	const legacy = path.join(sessionsRoot, legacyName("proj"));
	if (fs.existsSync(legacy)) fs.chmodSync(legacy, 0o700);
	await removeWithRetries(tempRoot);
});

describe("A failed session directory migration is reported", () => {
	test("warns with both directory names and says the transcripts will not be listed", () => {
		const cwd = path.join(home, "proj");
		fs.mkdirSync(cwd, { recursive: true });
		const legacy = path.join(sessionsRoot, legacyName("proj"));
		fs.mkdirSync(legacy, { recursive: true });
		fs.writeFileSync(path.join(legacy, "old-session.jsonl"), "{}\n");
		// The merge target already exists, so the migration reads the legacy
		// directory, and an unreadable legacy directory makes that read throw.
		fs.mkdirSync(path.join(sessionsRoot, "-proj"), { recursive: true });
		fs.chmodSync(legacy, 0o000);

		const dir = computeDefaultSessionDir(cwd, storage, sessionsRoot);

		expect(dir).toBe(path.join(sessionsRoot, "-proj"));
		// A home-relative cwd encodes to the same legacy name under both migration
		// passes, so both of them try it and both must report the failure.
		const reported = warnings.filter(w => w.message.includes("could not be migrated"));
		expect(reported).toHaveLength(2);
		expect(reported.map(w => w.message.startsWith("Legacy absolute")).sort()).toEqual([false, true]);
		for (const entry of reported) {
			expect(entry.message).toContain("will not be listed");
			expect(entry.fields.from).toBe(legacy);
			expect(entry.fields.to).toBe(path.join(sessionsRoot, "-proj"));
			expect(String(entry.fields.error)).not.toBe("");
		}
	});

	/**
	 * The half that must be preserved: a migration failure is still not fatal.
	 * The session directory is created and returned exactly as before.
	 */
	test("still returns a usable session directory", () => {
		const cwd = path.join(home, "proj");
		fs.mkdirSync(cwd, { recursive: true });
		const legacy = path.join(sessionsRoot, legacyName("proj"));
		fs.mkdirSync(legacy, { recursive: true });
		fs.mkdirSync(path.join(sessionsRoot, "-proj"), { recursive: true });
		fs.chmodSync(legacy, 0o000);

		const dir = computeDefaultSessionDir(cwd, storage, sessionsRoot);

		expect(fs.existsSync(dir)).toBe(true);
	});

	/** A migration that works must stay silent, and must actually move the files. */
	test("says nothing when the migration succeeds", () => {
		const cwd = path.join(home, "proj");
		fs.mkdirSync(cwd, { recursive: true });
		const legacy = path.join(sessionsRoot, legacyName("proj"));
		fs.mkdirSync(legacy, { recursive: true });
		fs.writeFileSync(path.join(legacy, "old-session.jsonl"), "{}\n");

		const dir = computeDefaultSessionDir(cwd, storage, sessionsRoot);

		expect(warnings.filter(w => w.message.includes("could not be migrated"))).toEqual([]);
		expect(fs.existsSync(path.join(dir, "old-session.jsonl"))).toBe(true);
		expect(fs.existsSync(legacy)).toBe(false);
	});
});
