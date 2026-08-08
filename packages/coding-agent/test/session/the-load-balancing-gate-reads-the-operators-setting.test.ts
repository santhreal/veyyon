/**
 * WHY THIS FILE EXISTS. `packages/ai` defaults load balancing ON, because an SDK embedder that hands
 * the library two credentials has already decided both are fair game. The product decides the
 * opposite: two accounts in veyyon are usually a personal plan beside an employer's, so quota
 * exhaustion on one must not quietly start spending the other. That difference lives entirely in one
 * line of wiring (`discoverAuthStorage` passing a `loadBalancing` resolver that reads
 * `accounts.loadBalancing`), and a wiring line is exactly the kind of thing that gets dropped in a
 * refactor while every library-level test stays green.
 *
 * So this file drives the REAL `discoverAuthStorage` against the REAL `Settings` and pins:
 *   - the product default is off, and it is off because the setting's declared default is `false`,
 *     not because something forgot to pass a resolver;
 *   - turning the setting on actually reaches the routing decision;
 *   - the flip reaches the NEXT decision on a storage that already exists, because the operator
 *     flips it from `/settings` mid-session and a snapshot taken at construction would ignore them
 *     until relaunch;
 *   - storage constructed BEFORE `Settings` exists (the boot path, and any embedder that never
 *     initializes settings) resolves to the product default rather than throwing or falling back to
 *     the library's permissive default;
 *   - auth death still moves accounts under the product default, since a dead credential is not a
 *     spending decision.
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

	test("a fresh install does not spend the second account", async () => {
		const { targetId } = await openStorageWithTwoAccounts();
		// The refusal must come from the DECLARED default, not from an absent resolver: an
		// `accounts.loadBalancing` that defaulted to true would make the assertion below a coincidence.
		expect(settingsOrThrow().get("accounts.loadBalancing")).toBe(false);

		const result = await exhaust(targetId);

		expect(result.switched).toBe(false);
		expect(result.retryAtMs).toBeGreaterThan(Date.now());
	});

	test("turning the setting on lets exhaustion move to the sibling", async () => {
		const { targetId } = await openStorageWithTwoAccounts();
		settingsOrThrow().set("accounts.loadBalancing", true);

		const result = await exhaust(targetId);

		expect(result).toEqual({ switched: true });
	});

	/**
	 * The operator flips the toggle from `/settings` while a session is running, on a storage built at
	 * launch. Both directions, on the one instance: a value captured at construction would answer the
	 * launch-time setting for the rest of the process.
	 */
	test("a mid-session flip reaches the next decision on the storage that already exists", async () => {
		const { targetId } = await openStorageWithTwoAccounts();
		const settings = settingsOrThrow();

		expect((await exhaust(targetId)).switched).toBe(false);

		settings.set("accounts.loadBalancing", true);
		expect((await exhaust(targetId)).switched).toBe(true);

		settings.set("accounts.loadBalancing", false);
		const refusedAgain = await exhaust(targetId);
		expect(refusedAgain.switched).toBe(false);
		expect(refusedAgain.retryAtMs).toBeGreaterThan(Date.now());
	});

	/**
	 * Storage is constructed on the boot path before `Settings.init` has run, and an embedder may
	 * never initialize settings at all. Absent settings mean the product default, so the resolver must
	 * answer "off" rather than throwing or letting the library's permissive default through.
	 */
	test("storage built before settings exist still refuses, and picks the setting up once it does", async () => {
		const { targetId } = await openStorageWithTwoAccounts();
		resetSettingsForTest();

		const refused = await exhaust(targetId);
		expect(refused.switched).toBe(false);

		await Settings.init({ inMemory: true });
		settingsOrThrow().set("accounts.loadBalancing", true);
		expect((await exhaust(targetId)).switched).toBe(true);
	});

	/** A revoked credential is not a spending decision, so the product default must not strand the session. */
	test("auth death still moves accounts under the product default", async () => {
		const { targetId } = await openStorageWithTwoAccounts();
		if (!storage) throw new Error("test setup failed");
		expect(settingsOrThrow().get("accounts.loadBalancing")).toBe(false);

		const moved = await storage.rotateSessionCredential(PROVIDER, SESSION_ID, {
			credentialId: targetId,
			error: Object.assign(new Error("invalid_grant: token revoked"), { status: 401 }),
		});

		expect(moved).toBe(true);
		expect(await storage.getApiKey(PROVIDER, SESSION_ID)).toBe("access-sibling");
	});
});
