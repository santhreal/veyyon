import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SqliteAuthCredentialStore } from "@veyyon/ai/auth-storage";
import {
	__resetDirsFromEnvForTests,
	getActiveAuthDbPath,
	getAgentDbPath,
	getAgentDir,
	getSharedAuthDir,
	getSharedAuthStoreDirIfEnabled,
	MAIN_CONFIG_FILENAMES,
	PROFILE_SHARING_CONFIG_KEY,
} from "@veyyon/utils/dirs";
import { removeWithRetries } from "../../../utils/src/temp";
import { assertIsolatedAppPath, guardDestructivePath } from "../../../utils/test/helpers/destructive-guard";

/**
 * PROF-1 / PROF-2: the credential-sharing posture decides WHICH `agent.db` a
 * profile's logins live in, and both of its outcomes are load-bearing.
 *
 *  - `profileSharing: false` is an ISOLATION promise. A user who splits work and
 *    client profiles apart is relying on profile A never seeing profile B's
 *    tokens. A leak here is not a cosmetic bug: it hands one context's
 *    credentials to another.
 *  - `profileSharing: true` (the default) is a CONVENIENCE promise, and its
 *    failure mode is the one this session has been chasing: if flipping the
 *    posture points the store at a different, empty file, the user is silently
 *    logged out and the next login overwrites a file that still held tokens.
 *
 * These tests drive the REAL path resolution (`getActiveAuthDbPath`, which routes
 * through the single sharing owner `getSharedAuthStoreDirIfEnabled`) and the REAL
 * SQLite store, not a mock, because the bug class lives precisely in the seam
 * between "which path did we compute" and "which file did we open".
 */
describe("credentials follow the profile-sharing posture exactly", () => {
	let tempHome = "";
	const KEYS = [
		"HOME",
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
		tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-prof-"));
		// Isolation MUST come from the app's own config-root override, not from
		// `process.env.HOME`: Bun resolves `os.homedir()` once at process start, so
		// assigning HOME here would change nothing and every path below would resolve
		// to the developer's real `~/.veyyon`. `VEYYON_CONFIG_DIR` is joined onto the
		// home directory, so a relative path pointing back out of it lands the whole
		// config root inside the temp dir, which `assertIsolatedAppPath` then verifies
		// on every single path before anything is written.
		process.env.VEYYON_CONFIG_DIR = path.relative(os.homedir(), tempHome);
		__resetDirsFromEnvForTests();
		assertIsolatedAppPath(getAgentDir(), "profile-credential-isolation");
	});

	afterEach(async () => {
		for (const key of KEYS) {
			if (saved[key] === undefined) delete process.env[key];
			else process.env[key] = saved[key];
		}
		__resetDirsFromEnvForTests();
		if (tempHome) {
			await removeWithRetries(guardDestructivePath(tempHome, "profile-credential-isolation"));
			tempHome = "";
		}
	});

	/** Write the global config's sharing posture the way the product does, then re-resolve. */
	function setSharing(shared: boolean): void {
		// `VEYYON_CONFIG_DIR` points the config root AT `tempHome`, so the global
		// config file is `<tempHome>/config.yml`, not a `.veyyon` subdirectory.
		fs.mkdirSync(tempHome, { recursive: true });
		fs.writeFileSync(
			path.join(tempHome, MAIN_CONFIG_FILENAMES[0]),
			`${PROFILE_SHARING_CONFIG_KEY}: ${shared ? "true" : "false"}\n`,
		);
		__resetDirsFromEnvForTests();
	}

	/** Switch to `profile` (undefined = default) and return the auth db path it resolves to. */
	function activeDbFor(profile: string | undefined): string {
		if (profile === undefined) delete process.env.VEYYON_PROFILE;
		else process.env.VEYYON_PROFILE = profile;
		__resetDirsFromEnvForTests();
		// Guard the APP-RESOLVED path, which is the only value that proves where the
		// write will actually land.
		return assertIsolatedAppPath(getActiveAuthDbPath(), "profile-credential-isolation");
	}

	/** Store one OAuth credential for `provider` in the db at `dbPath`. */
	async function login(dbPath: string, provider: string, refresh: string): Promise<void> {
		assertIsolatedAppPath(dbPath, "profile-credential-isolation login");
		fs.mkdirSync(path.dirname(dbPath), { recursive: true });
		const store = await SqliteAuthCredentialStore.open(dbPath);
		try {
			store.replaceAuthCredentialsForProvider(provider, [
				{ type: "oauth", access: `access-${refresh}`, refresh, expires: Date.now() + 3_600_000 },
			]);
		} finally {
			store.close();
		}
	}

	/** Every refresh token visible in the db at `dbPath` (empty when the file does not exist). */
	async function visibleRefreshTokens(dbPath: string): Promise<string[]> {
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

	describe("PROF-1: sharing OFF isolates every profile", () => {
		test("profile A cannot see profile B's credentials, in either direction", async () => {
			setSharing(false);

			const dbA = activeDbFor("work");
			const dbB = activeDbFor("client");

			// The isolation is only real if the two profiles resolve to DIFFERENT files.
			// Asserting the token lists alone would pass trivially if both were empty.
			expect(dbA).not.toBe(dbB);
			expect(dbA).toContain(`${path.sep}profiles${path.sep}work${path.sep}`);
			expect(dbB).toContain(`${path.sep}profiles${path.sep}client${path.sep}`);

			await login(dbA, "anthropic", "work-refresh");
			await login(dbB, "anthropic", "client-refresh");

			// Exact token sets, not counts: a leak that swapped the values would still
			// have the right length.
			expect(await visibleRefreshTokens(dbA)).toEqual(["work-refresh"]);
			expect(await visibleRefreshTokens(dbB)).toEqual(["client-refresh"]);
		});

		test("the shared store is not consulted at all when sharing is off", async () => {
			setSharing(false);

			// The single sharing owner must report "no redirection", which is what makes
			// every downstream path per-profile.
			expect(getSharedAuthStoreDirIfEnabled()).toBeUndefined();

			// Seed the machine-wide shared store with a token that MUST NOT appear.
			const sharedDb = getAgentDbPath(getSharedAuthDir());
			await login(sharedDb, "anthropic", "machine-wide-refresh");

			const dbA = activeDbFor("work");
			await login(dbA, "anthropic", "work-refresh");

			expect(await visibleRefreshTokens(dbA)).toEqual(["work-refresh"]);
			expect(dbA).not.toBe(sharedDb);
		});

		test("the isolated store is this profile's own agent.db, not a sibling nobody opens", () => {
			setSharing(false);
			const dbA = activeDbFor("work");

			// The bug this pins: user-facing "your credentials live in …" messages used to
			// name a path the store never opened. Under isolation the two must be the
			// SAME file.
			expect(dbA).toBe(getAgentDbPath(getAgentDir()));
		});
	});

	describe("PROF-2: sharing ON points every profile at the ONE shared store", () => {
		test("a login in one profile is visible from another", async () => {
			setSharing(true);

			const dbA = activeDbFor("work");
			const dbB = activeDbFor("client");

			// Sharing means literally the same file, which is the property that makes the
			// credential visible without any copy step.
			expect(dbA).toBe(dbB);
			expect(dbA).toBe(getAgentDbPath(getSharedAuthDir()));

			await login(dbA, "anthropic", "shared-refresh");
			expect(await visibleRefreshTokens(activeDbFor("client"))).toEqual(["shared-refresh"]);
		});

		test("sharing is the DEFAULT when the global config has no posture key at all", async () => {
			// No config file written: absent must mean shared, matching the documented
			// default. A first run resolving to a per-profile store instead would split
			// every later login off from the shared one.
			__resetDirsFromEnvForTests();
			expect(getSharedAuthStoreDirIfEnabled()).toBe(getSharedAuthDir());
			expect(activeDbFor(undefined)).toBe(getAgentDbPath(getSharedAuthDir()));
		});

		test("an invalid posture value falls back to shared rather than crashing an import", () => {
			fs.mkdirSync(tempHome, { recursive: true });
			fs.writeFileSync(path.join(tempHome, MAIN_CONFIG_FILENAMES[0]), `${PROFILE_SHARING_CONFIG_KEY}: "yes"\n`);
			__resetDirsFromEnvForTests();

			// The module-load-safe reader must not throw here (a bad value must not crash
			// a bare import); the CLI re-validates loudly. Shared is the safe default
			// because it keeps pointing at the store that already holds the tokens.
			expect(getSharedAuthStoreDirIfEnabled()).toBe(getSharedAuthDir());
		});

		test("flipping OFF then back ON returns to the SAME shared file, losing nothing", async () => {
			setSharing(true);
			const sharedDb = activeDbFor("work");
			await login(sharedDb, "anthropic", "shared-refresh");

			// Isolate: the shared token becomes invisible (that is the point of isolating)
			// but must remain ON DISK, untouched.
			setSharing(false);
			const isolatedDb = activeDbFor("work");
			expect(isolatedDb).not.toBe(sharedDb);
			expect(await visibleRefreshTokens(isolatedDb)).toEqual([]);

			// Re-share: the original token is back, byte-identical. A posture flip that
			// lost it would be the exact "logged out after changing a setting" bug.
			setSharing(true);
			expect(activeDbFor("work")).toBe(sharedDb);
			expect(await visibleRefreshTokens(sharedDb)).toEqual(["shared-refresh"]);
		});

		test("a per-profile login made while isolated survives re-enabling sharing", async () => {
			setSharing(false);
			const isolatedDb = activeDbFor("work");
			await login(isolatedDb, "anthropic", "isolated-refresh");

			setSharing(true);
			// Sharing does not DELETE the per-profile store, it stops reading it. The
			// bytes must still be there so a promotion path (or the user flipping back)
			// can recover the login instead of forcing a re-auth.
			expect(await visibleRefreshTokens(isolatedDb)).toEqual(["isolated-refresh"]);
		});
	});
});
