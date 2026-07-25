import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	type AuthCredentialStore,
	AuthStorage,
	type CredentialDisabledEvent,
	SqliteAuthCredentialStore,
} from "@veyyon/ai/auth-storage";
import * as oauthUtils from "@veyyon/ai/registry/oauth";
import { removeWithRetries } from "../../utils/src/temp";

const SOURCE_ID = "auth-storage-oauth-refresh-reenable-test";

/**
 * Regression suite for the persistent half of the "logged out after a rebuild" bug.
 *
 * When two veyyon processes share one credential store (the machine-wide shared-auth
 * DB), both can refresh the same OAuth credential in the same window. Providers like
 * Anthropic rotate the refresh token on every use, so the two refreshes race: process
 * A rotates R1 -> R2, while process B, still holding the stale R1, gets `invalid_grant`
 * and — because the store row still shows R1 — CAS-disables it. Process A then persists
 * R2 with an unconditional by-id write.
 *
 * The disable write only sets `disabled_cause`; the data write only sets `data`. Before
 * the fix, `updateAuthCredential` did NOT clear `disabled_cause`, so the row ended up
 * holding a perfectly LIVE R2 while still flagged disabled. `listAuthCredentials`
 * filters out disabled rows, so the credential silently vanished and the user appeared
 * logged out — with a valid token sitting right there — until a fresh login. A
 * successful refresh is proof the grant is alive, so persisting it now re-enables the
 * row (`updateAuthCredentialEnabling`). These tests pin that heal.
 */
describe("A successful OAuth refresh re-enables a concurrently-disabled row", () => {
	let tempDir = "";
	let store: AuthCredentialStore | null = null;
	let authStorage: AuthStorage | null = null;
	let events: CredentialDisabledEvent[] = [];

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-auth-reenable-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		events = [];
		authStorage = new AuthStorage(store, {
			onCredentialDisabled: event => {
				events.push(event);
			},
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		oauthUtils.unregisterOAuthProviders(SOURCE_ID);
		store?.close();
		store = null;
		authStorage = null;
		if (tempDir) {
			await removeWithRetries(tempDir);
			tempDir = "";
		}
	});

	test("heals a row a peer disabled mid-refresh: live token, active row, working key", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");

		const provider = "unit-oauth-reenable";
		const expired = Date.now() - 60_000;
		const refreshedExpires = Date.now() + 60 * 60_000;
		const refreshStarted = Promise.withResolvers<void>();
		const allowRefresh = Promise.withResolvers<void>();

		oauthUtils.registerOAuthProvider({
			id: provider,
			name: "Unit OAuth Re-enable",
			sourceId: SOURCE_ID,
			async login() {
				return { access: "unused", refresh: "unused", expires: refreshedExpires };
			},
			async refreshToken(credentials) {
				refreshStarted.resolve();
				// Hold the rotation open while a "peer process" disables the still-stale row.
				await allowRefresh.promise;
				return {
					...credentials,
					access: "rotated-access",
					refresh: "rotated-refresh",
					expires: refreshedExpires,
				};
			},
			getApiKey(credentials) {
				return credentials.access;
			},
		});

		await authStorage.set(provider, [
			{ type: "oauth", access: "stale-access", refresh: "stale-refresh", expires: expired },
		]);
		const credentialId = store.listAuthCredentials(provider)[0]!.id;

		// A genuine second process: its own connection to the same shared DB, so its
		// disable writes to disk without touching process A's in-memory selection (the
		// way a real peer process would).
		const peerStore = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		let key: string | undefined;
		try {
			const pending = authStorage.getApiKey(provider, "reenable-session");
			await refreshStarted.promise;

			// Peer process B, holding the same stale R1, fails its own refresh with
			// invalid_grant and disables the row (its data still matches R1) — writing
			// disabled_cause to the shared DB while A's rotation is still in flight.
			peerStore.deleteAuthCredential(credentialId, "oauth refresh failed: HTTP 400 invalid_grant");
			// The row is now disabled and invisible to the active list on disk.
			expect(peerStore.listAuthCredentials(provider)).toHaveLength(0);

			// Our refresh now completes and persists the rotated token.
			allowRefresh.resolve();
			key = await pending;
		} finally {
			peerStore.close();
		}

		// The request still resolves with the live rotated access token...
		expect(key).toBe("rotated-access");

		// ...and, critically, the row is ACTIVE again (disabled_cause cleared) carrying
		// the rotated token — not a live token stranded on a disabled row.
		const active = store.listAuthCredentials(provider);
		expect(active).toHaveLength(1);
		expect(active[0]?.id).toBe(credentialId);
		expect(active[0]?.credential.type).toBe("oauth");
		if (active[0]?.credential.type === "oauth") {
			expect(active[0].credential.refresh).toBe("rotated-refresh");
			expect(active[0].credential.access).toBe("rotated-access");
		}

		// A follow-up request (the "next run") reads the healed row directly.
		const next = await authStorage.getApiKey(provider, "next-session");
		expect(next).toBe("rotated-access");
		expect(authStorage.list()).toContain(provider);
	});

	test("a genuinely dead grant is NOT resurrected — a failed refresh leaves the row disabled", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");

		const provider = "unit-oauth-no-resurrect";
		const expired = Date.now() - 60_000;

		oauthUtils.registerOAuthProvider({
			id: provider,
			name: "Unit OAuth No Resurrect",
			sourceId: SOURCE_ID,
			async login() {
				return { access: "unused", refresh: "unused", expires: Date.now() + 60_000 };
			},
			async refreshToken() {
				// The grant is truly dead: refresh always fails definitively.
				throw new Error('HTTP 400 invalid_grant {"error":"invalid_grant"}');
			},
			getApiKey(credentials) {
				return credentials.access;
			},
		});

		await authStorage.set(provider, [
			{ type: "oauth", access: "dead-access", refresh: "dead-refresh", expires: expired },
		]);

		const key = await authStorage.getApiKey(provider, "dead-session");
		expect(key).toBeUndefined();
		// The re-enable path only fires on a SUCCESSFUL refresh; a dead grant must stay
		// disabled so it drops out instead of being retried forever.
		expect(events).toHaveLength(1);
		expect(store.listAuthCredentials(provider)).toHaveLength(0);
	});

	test("a refresh landing after a LOGOUT does not resurrect the credential (only refresh-failure disables heal)", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");

		const provider = "unit-oauth-no-logout-resurrect";
		const refreshedExpires = Date.now() + 60 * 60_000;
		const refreshStarted = Promise.withResolvers<void>();
		const allowRefresh = Promise.withResolvers<void>();

		oauthUtils.registerOAuthProvider({
			id: provider,
			name: "Unit OAuth No Logout Resurrect",
			sourceId: SOURCE_ID,
			async login() {
				return { access: "unused", refresh: "unused", expires: refreshedExpires };
			},
			async refreshToken(credentials) {
				refreshStarted.resolve();
				// Hold the rotation open while the user logs out mid-refresh.
				await allowRefresh.promise;
				return { ...credentials, access: "rotated-access", refresh: "rotated-refresh", expires: refreshedExpires };
			},
			getApiKey(credentials) {
				return credentials.access;
			},
		});

		await authStorage.set(provider, [
			{ type: "oauth", access: "stale-access", refresh: "stale-refresh", expires: Date.now() - 60_000 },
		]);
		const credentialId = store.listAuthCredentials(provider)[0]!.id;

		const pending = authStorage.getApiKey(provider, "logout-session");
		await refreshStarted.promise;

		// The user logs out while the refresh is still in flight. Logout disables the row
		// with a NON-refresh-failure cause (not the "oauth refresh failed…" prefix).
		expect(authStorage.disableCredentialById(credentialId, "user logged out")).toBe(true);
		expect(store.listAuthCredentials(provider)).toHaveLength(0);

		// The refresh now completes successfully. A successful refresh proves the grant is
		// alive, but the row was disabled by a LOGOUT, not a spurious refresh failure, so
		// it must stay gone — landing the rotation here would silently log the user back in.
		allowRefresh.resolve();
		await pending;

		expect(store.listAuthCredentials(provider)).toHaveLength(0);
		expect(authStorage.list()).not.toContain(provider);
		// A follow-up request still sees no credential — the logout stuck.
		expect(await authStorage.getApiKey(provider, "after-logout")).toBeUndefined();
	});
});
