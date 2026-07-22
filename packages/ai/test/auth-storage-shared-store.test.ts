import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type OAuthCredential, SqliteAuthCredentialStore } from "@veyyon/ai";
import { discoverAuthStorage } from "@veyyon/ai/auth-broker/discover";
import { getAgentDbPath } from "@veyyon/utils";
import { removeWithRetries } from "../../utils/src/temp";

// PROF-1: with `profileSharing` on (the default), the coding-agent wrapper points
// the local credential store at a shared, cross-profile dir. These tests exercise
// the @veyyon/ai seam directly: `storeAgentDir` redirects the local store and the
// first read promotes an existing per-profile login so nobody is logged out.

function oauth(suffix: string): OAuthCredential {
	return {
		type: "oauth",
		access: `access-${suffix}`,
		refresh: `refresh-${suffix}`,
		expires: Date.now() + 60_000,
		accountId: `acct-${suffix}`,
		email: `${suffix}@example.com`,
	};
}

async function writeCredential(dbPath: string, provider: string, credential: OAuthCredential): Promise<void> {
	const store = await SqliteAuthCredentialStore.open(dbPath);
	try {
		store.replaceAuthCredentialsForProvider(provider, [credential]);
	} finally {
		store.close();
	}
}

let profileDir = "";
let sharedDir = "";
let otherProfileDir = "";
const savedBrokerEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
	for (const key of ["VEYYON_AUTH_BROKER_URL", "VEYYON_AUTH_BROKER_TOKEN"]) {
		savedBrokerEnv[key] = process.env[key];
		delete process.env[key];
	}
	const root = path.join(os.tmpdir(), `veyyon-shared-store-${process.pid}-${Math.trunc(performance.now())}`);
	profileDir = path.join(root, "profiles", "work", "agent");
	otherProfileDir = path.join(root, "profiles", "personal", "agent");
	sharedDir = path.join(root, "shared-auth");
	await fs.mkdir(profileDir, { recursive: true });
	await fs.mkdir(otherProfileDir, { recursive: true });
});

afterEach(async () => {
	for (const [key, value] of Object.entries(savedBrokerEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	const root = path.dirname(path.dirname(path.dirname(profileDir)));
	await removeWithRetries(root);
});

describe("shared credential store (PROF-1)", () => {
	it("promotes an existing per-profile login into the empty shared store on first read", async () => {
		await writeCredential(getAgentDbPath(profileDir), "google-antigravity", oauth("live"));

		const storage = await discoverAuthStorage({ agentDir: profileDir, storeAgentDir: sharedDir });
		expect(storage.hasAuth("google-antigravity")).toBe(true);

		// The full credential — including the refresh token — landed in the shared
		// store, so no re-login is forced.
		const shared = await SqliteAuthCredentialStore.open(getAgentDbPath(sharedDir));
		try {
			const rows = shared.listAuthCredentials("google-antigravity");
			expect(rows).toHaveLength(1);
			expect(rows[0]?.credential).toMatchObject({ type: "oauth", refresh: "refresh-live" });
		} finally {
			shared.close();
		}
	});

	it("is read by a second profile pointed at the same shared store", async () => {
		await writeCredential(getAgentDbPath(profileDir), "google-antigravity", oauth("live"));
		// Seed once from the first profile.
		await discoverAuthStorage({ agentDir: profileDir, storeAgentDir: sharedDir });

		// A different profile with an EMPTY per-profile store still sees the login,
		// because the shared store is the one being read.
		const storage = await discoverAuthStorage({ agentDir: otherProfileDir, storeAgentDir: sharedDir });
		expect(storage.hasAuth("google-antigravity")).toBe(true);
	});

	it("never clobbers a shared store that already has credentials", async () => {
		await writeCredential(getAgentDbPath(sharedDir), "google-antigravity", oauth("shared"));
		await writeCredential(getAgentDbPath(profileDir), "google-antigravity", oauth("profile"));

		await discoverAuthStorage({ agentDir: profileDir, storeAgentDir: sharedDir });

		const shared = await SqliteAuthCredentialStore.open(getAgentDbPath(sharedDir));
		try {
			const rows = shared.listAuthCredentials("google-antigravity");
			expect(rows).toHaveLength(1);
			// The pre-existing shared credential wins; the per-profile one is not merged in.
			expect(rows[0]?.credential).toMatchObject({ refresh: "refresh-shared" });
		} finally {
			shared.close();
		}
	});

	it("does not promote a disabled per-profile credential", async () => {
		const dbPath = getAgentDbPath(profileDir);
		const store = await SqliteAuthCredentialStore.open(dbPath);
		try {
			const stored = store.replaceAuthCredentialsForProvider("google-antigravity", [oauth("bad")]);
			// Soft-delete sets disabled_cause; the row is then excluded from the
			// active listing the promotion reads.
			store.deleteAuthCredential(stored[0]!.id, "expired");
		} finally {
			store.close();
		}

		await discoverAuthStorage({ agentDir: profileDir, storeAgentDir: sharedDir });

		const shared = await SqliteAuthCredentialStore.open(getAgentDbPath(sharedDir));
		try {
			expect(shared.listAuthCredentials("google-antigravity")).toHaveLength(0);
		} finally {
			shared.close();
		}
	});

	// PROF-1 regression (the "lost all my creds after an update" bug): the shared
	// store moved to a new location, so on first read the CURRENT profile store is
	// empty and the only surviving login sits in an OLD per-profile `shared-auth`
	// dir. `seedSourceDbPaths` lists newest-to-oldest candidates; the first
	// non-empty one seeds the shared store, so the update recovers the login
	// instead of leaving the user logged out.
	it("seeds from a legacy source when the current profile store is empty", async () => {
		const legacyDir = path.join(path.dirname(path.dirname(profileDir)), "work", "shared-auth");
		await fs.mkdir(legacyDir, { recursive: true });
		await writeCredential(getAgentDbPath(legacyDir), "google-antigravity", oauth("legacy"));
		// Current profile store is intentionally empty (the update moved things).

		const storage = await discoverAuthStorage({
			agentDir: profileDir,
			storeAgentDir: sharedDir,
			seedSourceDbPaths: [getAgentDbPath(profileDir), getAgentDbPath(legacyDir)],
		});
		expect(storage.hasAuth("google-antigravity")).toBe(true);

		const shared = await SqliteAuthCredentialStore.open(getAgentDbPath(sharedDir));
		try {
			const rows = shared.listAuthCredentials("google-antigravity");
			expect(rows).toHaveLength(1);
			expect(rows[0]?.credential).toMatchObject({ type: "oauth", refresh: "refresh-legacy" });
		} finally {
			shared.close();
		}
	});

	// First non-empty source wins: a live current-profile login is not overwritten
	// by an older legacy store listed after it (no merge, no stale-token clobber).
	it("prefers the first non-empty seed source over later legacy ones", async () => {
		const legacyDir = path.join(path.dirname(path.dirname(profileDir)), "work", "shared-auth");
		await fs.mkdir(legacyDir, { recursive: true });
		await writeCredential(getAgentDbPath(profileDir), "google-antigravity", oauth("current"));
		await writeCredential(getAgentDbPath(legacyDir), "google-antigravity", oauth("legacy"));

		await discoverAuthStorage({
			agentDir: profileDir,
			storeAgentDir: sharedDir,
			seedSourceDbPaths: [getAgentDbPath(profileDir), getAgentDbPath(legacyDir)],
		});

		const shared = await SqliteAuthCredentialStore.open(getAgentDbPath(sharedDir));
		try {
			const rows = shared.listAuthCredentials("google-antigravity");
			expect(rows).toHaveLength(1);
			expect(rows[0]?.credential).toMatchObject({ refresh: "refresh-current" });
		} finally {
			shared.close();
		}
	});

	it("isolation (no storeAgentDir) reads the per-profile store, not the shared one", async () => {
		await writeCredential(getAgentDbPath(profileDir), "google-antigravity", oauth("profile"));

		const storage = await discoverAuthStorage({ agentDir: profileDir });
		expect(storage.hasAuth("google-antigravity")).toBe(true);
		// Nothing was written to the shared location.
		let sharedExists = true;
		try {
			await fs.access(getAgentDbPath(sharedDir));
		} catch {
			sharedExists = false;
		}
		expect(sharedExists).toBe(false);
	});
});
