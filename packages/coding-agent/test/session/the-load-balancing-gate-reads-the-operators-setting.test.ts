/**
 * WHY THIS FILE EXISTS. Whether quota exhaustion may continue on another of your accounts is the
 * operator's setting, and the entire path from that setting to the routing decision is one line of
 * wiring (`discoverAuthStorage` passing a `loadBalancing` resolver that reads
 * `accounts.loadBalancing`). A wiring line is exactly what gets dropped in a refactor while every
 * library-level test in `packages/ai` stays green, and the failure is invisible: the session simply
 * stops using an account, or starts using one, with nothing on screen either way.
 *
 * The product default is ON. Signing an account in is the decision to use it, and the previous
 * default turned an idle credential into a hard stop plus a warning telling the operator to go and
 * enable it. Because it is on, the interesting direction reversed: the value of this file is now
 * mostly that turning it OFF is honoured, which is the setting an operator walling one account off
 * depends on.
 *
 * So this file drives the REAL `discoverAuthStorage` against the REAL `Settings` and pins:
 *   - the product default moves the session to the idle account, and it does so because the
 *     setting's declared default is `true`, not because something forgot to pass a resolver;
 *   - turning the setting off actually reaches the routing decision, so the session waits out the
 *     window it was told to wait out;
 *   - the flip reaches the NEXT decision on a storage that already exists, in BOTH directions,
 *     because the operator flips it from `/settings` mid-session and a snapshot taken at
 *     construction would ignore them until relaunch;
 *   - storage constructed BEFORE `Settings` exists (the boot path, and any embedder that never
 *     initializes settings) resolves to the DECLARED default, read from the schema. This is the one
 *     the flip broke: the resolver used to answer `false` for absent settings by writing that
 *     polarity into the line, so it silently disagreed with the shipped default the moment the
 *     default changed;
 *   - auth death still moves accounts with the gate OFF, since a dead credential is not a spending
 *     decision.
 *
 * WHAT IT DOES NOT CATCH. The gate's own semantics (that the exhausted account is still recorded as
 * blocked, that `retryAtMs` is that account's reset and never a sibling's, and every failover-notice
 * rule) are the library contract and live in
 * `packages/ai/test/exhaustion-moves-accounts-only-when-load-balancing-is-on.test.ts`; `packages/ai`
 * cannot import the coding-agent's `Settings`, which is why the coverage is split across two files.
 * Nothing here covers the settings screen's rendering of the toggle, or the broker-backed store
 * (`discoverAuthStorage` resolves to the local sqlite store when no broker is configured, which is
 * the shape every local install has).
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as oauthUtils from "@veyyon/ai/registry/oauth";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { settingsOrThrow } from "@veyyon/coding-agent/config/settings-instance";
import { getDefault } from "@veyyon/coding-agent/config/settings-schema";
import { discoverAuthStorage } from "@veyyon/coding-agent/session/auth-broker-config";
import type { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { useIsolatedConfigRoot } from "../helpers/isolated-agent-dir";

const PROVIDER = "unit-operator-gate";
const SESSION_ID = "session-under-quota";
const HOUR_MS = 60 * 60_000;

// The store this suite opens is the machine-wide shared credential store, resolved from the config
// root. Isolating the root is what keeps it off the operator's real `~/.veyyon`.
useIsolatedConfigRoot();

describe("the load balancing gate reads the operator's setting", () => {
	let storage: AuthStorage | null = null;

	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
			const credential = credentials[provider];
			if (!credential) return null;
			return { newCredentials: credential, apiKey: credential.access };
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (storage) {
			await storage.remove(PROVIDER);
			storage.close();
			storage = null;
		}
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
	});

	/** Two accounts of one provider, which is the only situation in which the gate means anything. */
	async function openStorageWithTwoAccounts(): Promise<{ targetId: number; siblingId: number }> {
		const opened = await discoverAuthStorage();
		storage = opened;
		const now = Date.now();
		await opened.set(PROVIDER, [
			{
				type: "oauth",
				access: "access-target",
				refresh: "refresh-target",
				expires: now + HOUR_MS,
				accountId: "account-target",
				email: "target@example.com",
			},
			{
				type: "oauth",
				access: "access-sibling",
				refresh: "refresh-sibling",
				expires: now + HOUR_MS,
				accountId: "account-sibling",
				email: "sibling@example.com",
			},
		]);
		const rows = opened.listStoredCredentials(PROVIDER);
		expect(rows.length).toBe(2);
		return { targetId: rows[0]!.id, siblingId: rows[1]!.id };
	}

	function exhaust(target: number): Promise<{ switched: boolean; retryAtMs?: number }> {
		if (!storage) throw new Error("test setup failed");
		return storage.markUsageLimitReached(PROVIDER, SESSION_ID, {
			credentialId: target,
			retryAfterMs: 30_000,
		});
	}

	test("a fresh install continues on the account that is idle", async () => {
		const { targetId } = await openStorageWithTwoAccounts();
		// The move must come from the DECLARED default, not from a resolver nobody passed: read the
		// schema here so this row fails if the shipped default and the behaviour ever disagree, in
		// either direction, rather than restating `true` and agreeing with itself.
		expect(getDefault("accounts.loadBalancing")).toBe(true);
		expect(settingsOrThrow().get("accounts.loadBalancing")).toBe(true);

		const result = await exhaust(targetId);

		expect(result).toEqual({ switched: true });
	});

	test("turning the setting off makes the session wait out the window", async () => {
		const { targetId } = await openStorageWithTwoAccounts();
		settingsOrThrow().set("accounts.loadBalancing", false);

		const result = await exhaust(targetId);

		expect(result.switched).toBe(false);
		expect(result.retryAtMs).toBeGreaterThan(Date.now());
	});

	/**
	 * The operator flips the toggle from `/settings` while a session is running, on a storage built at
	 * launch. Both directions, on the one instance: a value captured at construction would answer the
	 * launch-time setting for the rest of the process. Both directions are set explicitly, so this row
	 * says nothing about which one the default is and cannot go green on the default alone.
	 */
	test("a mid-session flip reaches the next decision on the storage that already exists", async () => {
		const { targetId } = await openStorageWithTwoAccounts();
		const settings = settingsOrThrow();

		settings.set("accounts.loadBalancing", false);
		const refused = await exhaust(targetId);
		expect(refused.switched).toBe(false);
		expect(refused.retryAtMs).toBeGreaterThan(Date.now());

		settings.set("accounts.loadBalancing", true);
		expect((await exhaust(targetId)).switched).toBe(true);

		settings.set("accounts.loadBalancing", false);
		const refusedAgain = await exhaust(targetId);
		expect(refusedAgain.switched).toBe(false);
		expect(refusedAgain.retryAtMs).toBeGreaterThan(Date.now());
	});

	/**
	 * Storage is constructed on the boot path before `Settings.init` has run, and an embedder may
	 * never initialize settings at all. Absent settings mean the DECLARED default, so the resolver
	 * reads the schema instead of naming a polarity: the version of this line that answered `false`
	 * for absent settings was correct for exactly as long as the default was `false`, and then it
	 * quietly served the opposite of the shipped behaviour on the one path with no operator in it.
	 */
	test("storage built before settings exist follows the declared default, and the flip still reaches it", async () => {
		const { targetId } = await openStorageWithTwoAccounts();
		resetSettingsForTest();

		expect((await exhaust(targetId)).switched).toBe(getDefault("accounts.loadBalancing"));

		await Settings.init({ inMemory: true });
		settingsOrThrow().set("accounts.loadBalancing", false);
		const refused = await exhaust(targetId);
		expect(refused.switched).toBe(false);
		expect(refused.retryAtMs).toBeGreaterThan(Date.now());
	});

	/** A revoked credential is not a spending decision, so even a walled-off account must not strand the session. */
	test("auth death still moves accounts with the gate off", async () => {
		const { targetId } = await openStorageWithTwoAccounts();
		if (!storage) throw new Error("test setup failed");
		settingsOrThrow().set("accounts.loadBalancing", false);

		const moved = await storage.rotateSessionCredential(PROVIDER, SESSION_ID, {
			credentialId: targetId,
			error: Object.assign(new Error("invalid_grant: token revoked"), { status: 401 }),
		});

		expect(moved).toBe(true);
		expect(await storage.getApiKey(PROVIDER, SESSION_ID)).toBe("access-sibling");
	});
});
