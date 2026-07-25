import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SqliteAuthCredentialStore } from "@veyyon/ai/auth-storage";
import {
	__resetDirsFromEnvForTests,
	getAgentDbPath,
	getAgentDir,
	migrateLegacyDefaultProfileLayout,
} from "@veyyon/utils/dirs";
import { removeWithRetries } from "../../../utils/src/temp";
import { assertIsolatedAppPath, guardDestructivePath } from "../../../utils/test/helpers/destructive-guard";

/**
 * PROF-7: the one-time move from the legacy `~/.veyyon/agent` layout to
 * `~/.veyyon/profiles/default/` must carry the CREDENTIAL STORE across intact,
 * exactly once.
 *
 * `global-config.test.ts` already covers the migration's structure: no-op on a
 * fresh root, loud refusal on a genuine conflict, and resuming an interrupted
 * move. What it does not cover is the payload, which is the part a user feels. A
 * migration that moves directories correctly but leaves the credential database
 * behind, copies it to both locations, or lands it somewhere the store no longer
 * opens, presents to the user as being logged out after an upgrade. That is the
 * same symptom this whole campaign exists for, arriving by a different route.
 *
 * So these tests seed a REAL SQLite credential store in the legacy layout, run the
 * REAL migration, and then open the store through the REAL resolver at its new
 * location and assert the exact token is readable.
 */
describe("the legacy-layout migration carries credentials across exactly once", () => {
	let tempRoot = "";
	const KEYS = [
		"XDG_DATA_HOME",
		"XDG_STATE_HOME",
		"XDG_CACHE_HOME",
		"XDG_CONFIG_HOME",
		"VEYYON_PROFILE",
		"VEYYON_CONFIG_DIR",
		"VEYYON_CODING_AGENT_DIR",
	];
	const saved: Record<string, string | undefined> = {};

	beforeEach(() => {
		for (const key of KEYS) saved[key] = process.env[key];
		for (const key of KEYS) delete process.env[key];
		tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-legacy-mig-"));
		process.env.VEYYON_CONFIG_DIR = path.relative(os.homedir(), tempRoot);
		__resetDirsFromEnvForTests();
		assertIsolatedAppPath(getAgentDir(), "legacy-migration-credentials");
	});

	afterEach(async () => {
		for (const key of KEYS) {
			if (saved[key] === undefined) delete process.env[key];
			else process.env[key] = saved[key];
		}
		__resetDirsFromEnvForTests();
		if (tempRoot) {
			await removeWithRetries(guardDestructivePath(tempRoot, "legacy-migration-credentials"));
			tempRoot = "";
		}
	});

	/** Build the legacy `<root>/agent` layout holding one real OAuth credential. */
	async function seedLegacyStore(refresh: string): Promise<string> {
		const legacyAgentDir = path.join(tempRoot, "agent");
		fs.mkdirSync(legacyAgentDir, { recursive: true });
		const dbPath = assertIsolatedAppPath(path.join(legacyAgentDir, "agent.db"), "legacy-migration-credentials");
		const store = await SqliteAuthCredentialStore.open(dbPath);
		try {
			store.replaceAuthCredentialsForProvider("anthropic", [
				{ type: "oauth", access: `access-${refresh}`, refresh, expires: Date.now() + 3_600_000 },
			]);
		} finally {
			store.close();
		}
		return dbPath;
	}

	/** The refresh tokens readable from the db at `dbPath` (empty when absent). */
	async function tokensAt(dbPath: string): Promise<string[]> {
		if (!fs.existsSync(dbPath)) return [];
		const store = await SqliteAuthCredentialStore.open(dbPath);
		try {
			return store
				.listAuthCredentials()
				.map(row => (row.credential.type === "oauth" ? row.credential.refresh : undefined))
				.filter((token): token is string => token !== undefined)
				.sort();
		} finally {
			store.close();
		}
	}

	test("the credential is readable at the NEW location after migrating", async () => {
		const legacyDb = await seedLegacyStore("legacy-refresh");

		const result = migrateLegacyDefaultProfileLayout();
		expect(result.migrated).toBe(true);
		expect(result.movedEntries).toContain("agent");

		__resetDirsFromEnvForTests();
		// Resolved through the real path helper, not a hand-built path: the migration is
		// only successful if the store the APP will open is the one holding the token.
		const activeDb = assertIsolatedAppPath(getAgentDbPath(getAgentDir()), "legacy-migration-credentials");
		expect(await tokensAt(activeDb)).toEqual(["legacy-refresh"]);
		// And it is genuinely the new layout, not the old path still in use.
		expect(activeDb).toContain(`${path.sep}profiles${path.sep}default${path.sep}`);
		expect(activeDb).not.toBe(legacyDb);
	});

	test("no orphan copy is left at the legacy path", async () => {
		const legacyDb = await seedLegacyStore("legacy-refresh");
		migrateLegacyDefaultProfileLayout();

		// A leftover copy is worse than it looks: two stores drift apart, and a later
		// process that resolves the old path would rotate tokens nobody else sees.
		expect(fs.existsSync(legacyDb)).toBe(false);
		expect(fs.existsSync(path.join(tempRoot, "agent"))).toBe(false);
	});

	test("exactly ONE credential database exists under the root afterwards", async () => {
		await seedLegacyStore("legacy-refresh");
		migrateLegacyDefaultProfileLayout();

		const found: string[] = [];
		const walk = (dir: string): void => {
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) walk(full);
				else if (entry.name === "agent.db") found.push(full);
			}
		};
		walk(tempRoot);

		// Counted across the whole tree rather than checked at two known paths, so a
		// copy landing anywhere unexpected still fails.
		expect(found).toHaveLength(1);
		expect(found[0]).toContain(`${path.sep}profiles${path.sep}default${path.sep}`);
	});

	test("running the migration a SECOND time is a no-op that does not duplicate or lose the credential", async () => {
		await seedLegacyStore("legacy-refresh");
		migrateLegacyDefaultProfileLayout();

		const second = migrateLegacyDefaultProfileLayout();
		// Idempotence matters because this runs on every launch: a second pass that
		// re-moved or re-created anything would corrupt an already-good layout.
		expect(second.migrated).toBe(false);
		expect(second.movedEntries).toEqual([]);

		__resetDirsFromEnvForTests();
		expect(await tokensAt(getAgentDbPath(getAgentDir()))).toEqual(["legacy-refresh"]);
	});

	test("an interrupted migration resumes and still ends with the credential intact", async () => {
		await seedLegacyStore("legacy-refresh");

		// Recreate the mid-migration state the marker exists for: the target claimed,
		// the legacy entries not yet moved.
		const targetDir = path.join(tempRoot, "profiles", "default");
		fs.mkdirSync(targetDir, { recursive: true });
		// The exact marker name the migration writes; a resume is recognised by its presence.
		fs.writeFileSync(path.join(targetDir, ".migration-in-progress"), "");

		const result = migrateLegacyDefaultProfileLayout();
		expect(result.migrated).toBe(true);

		__resetDirsFromEnvForTests();
		// The token survives the resume path too, which is the case most likely to
		// strand data because it runs after a crash.
		expect(await tokensAt(getAgentDbPath(getAgentDir()))).toEqual(["legacy-refresh"]);
	});

	test("a genuine conflict refuses loudly rather than merging two credential stores", async () => {
		await seedLegacyStore("legacy-refresh");
		// A completed new-layout directory with NO marker, beside the legacy one.
		fs.mkdirSync(path.join(tempRoot, "profiles", "default"), { recursive: true });

		// Guessing here could silently discard one of two real credential sets, so the
		// only safe behavior is to stop and say so.
		expect(() => migrateLegacyDefaultProfileLayout()).toThrow(/cannot guess which is current/i);
		// And nothing was moved while deciding.
		expect(fs.existsSync(path.join(tempRoot, "agent", "agent.db"))).toBe(true);
	});
});
