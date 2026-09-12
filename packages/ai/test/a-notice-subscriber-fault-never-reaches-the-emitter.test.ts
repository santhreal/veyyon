/**
 * WHY THIS FILE EXISTS. `AuthStorage` fans three notices out to subscribers (credential disabled,
 * credential failover, usage limit withheld) through one delivery step that isolates a subscriber
 * fault: a throw, or a rejection from an async subscriber, is logged against the hook and the rest
 * of the chain still runs, so a misbehaving notice renderer cannot break the resolve that is trying
 * to keep a request alive. The disabled hook has its own suite
 * (`auth-storage-credential-disabled-event.test.ts`); this one drives the failover and withheld
 * hooks end to end, through the rotation and the exhaustion path, and pins:
 *   - a subscriber that throws does not stop a later subscriber from receiving the notice, and the
 *     resolve that emitted it still answers;
 *   - a subscriber that rejects asynchronously does not raise `unhandledRejection`;
 *   - the warning names the hook the faulting subscriber was registered on.
 *
 * WHAT IT DOES NOT CATCH. Nothing here renders the notice; the interactive host's handling of the
 * event is pinned one package up.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, setSystemTime, test, vi } from "bun:test";
import {
	type AuthCredentialStore,
	AuthStorage,
	type CredentialFailoverEvent,
	SqliteAuthCredentialStore,
	type UsageLimitWithheldEvent,
} from "@veyyon/ai/auth-storage";
import * as oauthUtils from "@veyyon/ai/registry/oauth";
import { logger } from "@veyyon/utils";

const PROVIDER = "unit-notice-fault";
const SESSION_ID = "session-notice-fault";
const HOUR_MS = 60 * 60_000;
const NOW_MS = 1_760_000_000_000;

describe("a notice subscriber fault never reaches the emitter", () => {
	let store: AuthCredentialStore | null = null;

	beforeEach(() => {
		setSystemTime(new Date(NOW_MS));
		store = new SqliteAuthCredentialStore(new Database(":memory:"));
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
			const credential = credentials[provider];
			if (!credential) return null;
			return { newCredentials: credential, apiKey: credential.access };
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		store?.close();
		store = null;
		setSystemTime();
	});

	async function seed(storage: AuthStorage): Promise<{ targetId: number; siblingId: number }> {
		await storage.set(PROVIDER, [
			{
				type: "oauth",
				access: "access-target",
				refresh: "refresh-target",
				expires: NOW_MS + HOUR_MS,
				accountId: "account-target",
				email: "target@example.com",
			},
			{
				type: "oauth",
				access: "access-sibling",
				refresh: "refresh-sibling",
				expires: NOW_MS + HOUR_MS,
				accountId: "account-sibling",
				email: "sibling@example.com",
			},
		]);
		const rows = storage.listStoredCredentials(PROVIDER);
		return { targetId: rows[0]!.id, siblingId: rows[1]!.id };
	}

	test("a throwing failover subscriber is logged against its hook and the next subscriber still hears the move", async () => {
		if (!store) throw new Error("test setup failed");
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const storage = new AuthStorage(store, { loadBalancing: false });
		const { targetId, siblingId } = await seed(storage);
		const events: CredentialFailoverEvent[] = [];
		storage.onCredentialFailover(() => {
			throw new Error("failover renderer exploded");
		});
		storage.onCredentialFailover(event => {
			events.push(event);
		});

		await storage.rotateSessionCredential(PROVIDER, SESSION_ID, {
			credentialId: targetId,
			error: Object.assign(new Error("invalid_grant: token revoked"), { status: 401 }),
		});
		expect(await storage.getApiKey(PROVIDER, SESSION_ID)).toBe("access-sibling");

		expect(events).toEqual([
			{
				provider: PROVIDER,
				from: { credentialId: targetId, label: "target@example.com" },
				to: { credentialId: siblingId, label: "sibling@example.com" },
				cause: "invalid_grant: token revoked",
			},
		]);
		expect(warn.mock.calls.filter(([message]) => message === "onCredentialFailover listener threw")).toEqual([
			[
				"onCredentialFailover listener threw",
				{
					provider: PROVIDER,
					error: "Error: failover renderer exploded",
				},
			],
		]);
	});

	test("a rejecting withheld subscriber is logged against its hook, raises no unhandledRejection, and the exhaustion still answers", async () => {
		if (!store) throw new Error("test setup failed");
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const storage = new AuthStorage(store, { loadBalancing: false });
		const { targetId } = await seed(storage);
		const withheld: UsageLimitWithheldEvent[] = [];
		const settled = Promise.withResolvers<void>();
		storage.onUsageLimitWithheld(async () => {
			await Promise.resolve();
			settled.resolve();
			throw new Error("withheld renderer exploded");
		});
		storage.onUsageLimitWithheld(event => {
			withheld.push(event);
		});

		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown): void => {
			unhandled.push(reason);
		};
		process.on("unhandledRejection", onUnhandled);
		try {
			const result = await storage.markUsageLimitReached(PROVIDER, SESSION_ID, {
				credentialId: targetId,
				retryAfterMs: 60_000,
			});
			await settled.promise;
			await Bun.sleep(0);

			expect(result).toEqual({ switched: false, retryAtMs: NOW_MS + 60_000 });
			expect(withheld).toEqual([
				{
					provider: PROVIDER,
					account: { credentialId: targetId, label: "target@example.com" },
					idleSiblings: 1,
					retryAtMs: NOW_MS + 60_000,
				},
			]);
			expect(unhandled).toHaveLength(0);
			expect(warn.mock.calls.filter(([message]) => message === "onUsageLimitWithheld listener threw")).toEqual([
				[
					"onUsageLimitWithheld listener threw",
					{
						provider: PROVIDER,
						error: "Error: withheld renderer exploded",
					},
				],
			]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});
});
