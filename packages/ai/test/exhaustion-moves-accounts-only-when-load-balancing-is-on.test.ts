/**
 * WHY THIS FILE EXISTS. Quota exhaustion on one account used to move traffic to the next account
 * silently, which spends a second subscription the operator never offered up. Two accounts exist for
 * plenty of reasons that are not "use whichever has quota left": a personal plan beside an
 * employer's, a paid plan beside a trial. So the MOVE is now gated by `accounts.loadBalancing`,
 * while the exhaustion itself is still recorded.
 *
 * The gate is easy to get wrong in three ways, and all three are pinned below:
 *   1. Gating the block as well as the move, which loses the only record of when the window returns.
 *   2. Reporting a SIBLING's reset as the time to retry while refusing to use that sibling, which is
 *      the same leak in the shape of a number: it tells the caller to come back when somebody
 *      else's window opens.
 *   3. Gating AUTH DEATH. A revoked or dead credential is not a spending decision; refusing to move
 *      there just stops the session working, so failover on auth death is deliberately never gated.
 *
 * The failover NOTICE has its own failure modes, because it is emitted from the resolve that
 * actually served rather than from the rotation that predicted a move: it must fire exactly once,
 * must not fire when the session lands back on the same account, must not fire for a rotation that
 * no resolve ever followed, and must name the dying account by the label it was known by even
 * though its row is gone by the time the notice is built.
 *
 * The WITHHELD notice is the other half of the gate, and it exists because a setting the operator
 * never hears about is a setting they cannot revisit: the moment it costs something is the moment
 * quota is gone while idle accounts sit there. It must fire when a move was actually withheld, stay
 * silent when nothing could have served (no sibling, or every sibling blocked) and when the setting
 * is on, and announce one exhausted window once however many times a turn retries into it, while
 * still announcing the NEXT window.
 *
 * WHAT IT DOES NOT CATCH. This file is the library-level contract: it constructs `AuthStorage`
 * directly and passes its own `loadBalancing` resolver. The coding-agent's product default (OFF) and
 * the wiring that reads the operator's `accounts.loadBalancing` setting live one package up and are
 * pinned in `packages/coding-agent/test/session/the-load-balancing-gate-reads-the-operators-setting.test.ts`
 * (`packages/ai` cannot import the coding-agent's `Settings`). Nothing here covers the interactive
 * mode's rendering of the notice, and nothing here covers `markCredentialSuspect` on a broker store:
 * the sqlite store implements no suspect hook, so the "row is gone when the notice fires" state is
 * produced by removing the credential outright, which is the same state the soft delete leaves.
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

const PROVIDER = "unit-load-balancing-gate";
const SESSION_ID = "session-under-quota";
const HOUR_MS = 60 * 60_000;
const NOW_MS = 1_760_000_000_000;
/** Mirrors `FAILOVER_NOTICE_WINDOW_MS` in `auth-storage.ts`; the notice describes a request in flight. */
const NOTICE_WINDOW_MS = 60_000;

describe("exhaustion moves accounts only when load balancing is on", () => {
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

	async function seed(
		storage: AuthStorage,
	): Promise<{ targetId: number; siblingId: number; targetEmail: string; siblingEmail: string }> {
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
		return {
			targetId: rows[0]!.id,
			siblingId: rows[1]!.id,
			targetEmail: "target@example.com",
			siblingEmail: "sibling@example.com",
		};
	}

	/**
	 * The library default is ON, and that is not the product default. An SDK embedder holding two
	 * credentials asked for both to be usable by handing both over; the coding-agent is the caller
	 * that turns it off, and it does so explicitly.
	 */
	test("a library embedder that says nothing gets the move", async () => {
		if (!store) throw new Error("test setup failed");
		const storage = new AuthStorage(store);
		const { targetId } = await seed(storage);

		const result = await storage.markUsageLimitReached(PROVIDER, SESSION_ID, {
			credentialId: targetId,
			retryAfterMs: 30_000,
		});

		expect(result).toEqual({ switched: true });
	});

	/**
	 * With the gate off the exhaustion is still recorded, and the time to come back is THIS account's
	 * own window. The sibling here is blocked until a much earlier moment on purpose: a
	 * `retryAtMs` computed from siblings would report that earlier time, which reads as "your account
	 * is back in a second" and is the number version of spending the other subscription.
	 */
	test("with load balancing off the block still stands and retryAtMs is this account's own reset", async () => {
		if (!store) throw new Error("test setup failed");
		const storage = new AuthStorage(store, { loadBalancing: false });
		const { targetId, siblingId } = await seed(storage);
		const siblingResetMs = NOW_MS + 1_000;
		const targetResetMs = NOW_MS + 60_000;

		const siblingResult = await storage.markUsageLimitReached(PROVIDER, SESSION_ID, {
			credentialId: siblingId,
			retryAfterMs: 1_000,
		});
		expect(siblingResult).toEqual({ switched: false, retryAtMs: siblingResetMs });

		expect(storage.pinSessionCredential(PROVIDER, SESSION_ID, targetId)).toBe(true);
		const result = await storage.markUsageLimitReached(PROVIDER, SESSION_ID, {
			credentialId: targetId,
			retryAfterMs: 60_000,
		});

		expect(result).toEqual({ switched: false, retryAtMs: targetResetMs });
		expect(result.retryAtMs).not.toBe(siblingResetMs);
		// Recorded as blocked, which is what lets the account list say when the window returns.
		const routing = storage.sessionCredentialRouting(PROVIDER, SESSION_ID);
		expect(routing?.selectedCredentialId).toBe(targetId);
		expect(routing?.selectedBlockedUntilMs).toBe(targetResetMs);
	});

	/**
	 * The gate is a resolver, read at every decision, because the operator flips it in `/settings`
	 * mid-session and a value captured when the storage was constructed would ignore them until the
	 * next launch.
	 */
	test("the gate is read at each decision, not captured when the storage was built", async () => {
		if (!store) throw new Error("test setup failed");
		let enabled = false;
		const storage = new AuthStorage(store, { loadBalancing: () => enabled });
		const { targetId } = await seed(storage);

		const refused = await storage.markUsageLimitReached(PROVIDER, SESSION_ID, {
			credentialId: targetId,
			retryAfterMs: 30_000,
		});
		expect(refused).toEqual({ switched: false, retryAtMs: NOW_MS + 30_000 });

		enabled = true;
		const allowed = await storage.markUsageLimitReached(PROVIDER, SESSION_ID, {
			credentialId: targetId,
			retryAfterMs: 30_000,
		});
		expect(allowed).toEqual({ switched: true });
	});

	/**
	 * Auth death is not a spending decision, so the gate does not apply to it. Same storage, same
	 * setting, opposite answers: quota exhaustion refuses to move and a dead credential moves.
	 */
	test("auth death moves accounts even with load balancing off", async () => {
		if (!store) throw new Error("test setup failed");
		const storage = new AuthStorage(store, { loadBalancing: false });
		const { targetId } = await seed(storage);

		const quota = await storage.markUsageLimitReached(PROVIDER, SESSION_ID, {
			credentialId: targetId,
			retryAfterMs: 30_000,
		});
		expect(quota.switched).toBe(false);

		const moved = await storage.rotateSessionCredential(PROVIDER, SESSION_ID, {
			credentialId: targetId,
			error: Object.assign(new Error("invalid_grant: token revoked"), { status: 401 }),
		});

		expect(moved).toBe(true);
		expect(await storage.getApiKey(PROVIDER, SESSION_ID)).toBe("access-sibling");
	});

	/**
	 * The notice names both accounts and fires ONCE. It is parked by the rotation and emitted by the
	 * resolve that actually served, so the danger is the opposite of a missing event: one notice per
	 * subsequent resolve, or per listener re-entry, would tell the operator their account moved again
	 * and again when it moved once.
	 */
	test("the failover notice fires exactly once, naming both accounts and the cause", async () => {
		if (!store) throw new Error("test setup failed");
		const events: CredentialFailoverEvent[] = [];
		const storage = new AuthStorage(store, {
			loadBalancing: false,
			onCredentialFailover: event => {
				events.push(event);
			},
		});
		const { targetId, siblingId, targetEmail, siblingEmail } = await seed(storage);

		await storage.rotateSessionCredential(PROVIDER, SESSION_ID, {
			credentialId: targetId,
			error: Object.assign(new Error("invalid_grant: token revoked"), { status: 401 }),
		});
		expect(events).toEqual([]);

		expect(await storage.getApiKey(PROVIDER, SESSION_ID)).toBe("access-sibling");
		expect(await storage.getApiKey(PROVIDER, SESSION_ID)).toBe("access-sibling");

		expect(events).toEqual([
			{
				provider: PROVIDER,
				from: { credentialId: targetId, label: targetEmail },
				to: { credentialId: siblingId, label: siblingEmail },
				cause: "invalid_grant: token revoked",
			},
		]);
	});

	/**
	 * The dying account's label is read when the rotation parks it, not when the notice is built: by
	 * then the row is gone (the broker store soft-deletes it as suspect), and a label resolved late
	 * degrades to `#<row id>` — a notice that cannot say which account stopped working.
	 */
	test("the notice still names the dying account after its row is gone", async () => {
		if (!store) throw new Error("test setup failed");
		const events: CredentialFailoverEvent[] = [];
		const storage = new AuthStorage(store, {
			onCredentialFailover: event => {
				events.push(event);
			},
		});
		const { targetId, targetEmail } = await seed(storage);

		await storage.rotateSessionCredential(PROVIDER, SESSION_ID, {
			credentialId: targetId,
			error: Object.assign(new Error("invalid_grant: token revoked"), { status: 401 }),
		});
		expect(await storage.removeCredential(PROVIDER, targetId)).toBe(true);

		expect(await storage.getApiKey(PROVIDER, SESSION_ID)).toBe("access-sibling");

		expect(events.length).toBe(1);
		expect(events[0]?.from).toEqual({ credentialId: targetId, label: targetEmail });
		expect(storage.listStoredCredentials(PROVIDER).some(row => row.id === targetId)).toBe(false);
	});

	/**
	 * Landing back on the same account is not a move. A refresh can heal the credential that just
	 * failed, and with no other account left it is also the only one that can serve; announcing a
	 * failover there names one account as both `from` and `to`.
	 */
	test("resolving back onto the same account announces nothing", async () => {
		if (!store) throw new Error("test setup failed");
		const events: CredentialFailoverEvent[] = [];
		const storage = new AuthStorage(store, {
			onCredentialFailover: event => {
				events.push(event);
			},
		});
		const { targetId, siblingId } = await seed(storage);

		// A sibling must exist for the rotation to park anything at all.
		const moved = await storage.rotateSessionCredential(PROVIDER, SESSION_ID, {
			credentialId: targetId,
			error: Object.assign(new Error("invalid_grant: token revoked"), { status: 401 }),
		});
		expect(moved).toBe(true);
		// ...and then it is gone, so the only credential that can serve is the one that failed.
		expect(await storage.removeCredential(PROVIDER, siblingId)).toBe(true);

		expect(await storage.getApiKey(PROVIDER, SESSION_ID)).toBe("access-target");

		expect(events).toEqual([]);
	});

	/**
	 * A notice describes the request in flight. A rotation that no resolve ever followed inside the
	 * window is an abandoned attempt, and announcing it later would describe a move that never
	 * happened. Time is advanced rather than waited out, and the second resolve proves the entry was
	 * DROPPED rather than deferred to whenever the next request lands.
	 */
	test("a rotation with no resolve inside the notice window announces nothing, then or later", async () => {
		if (!store) throw new Error("test setup failed");
		const events: CredentialFailoverEvent[] = [];
		const storage = new AuthStorage(store, {
			onCredentialFailover: event => {
				events.push(event);
			},
		});
		const { targetId } = await seed(storage);
		// Blocked well past the notice window, so the resolve below genuinely lands on the SIBLING:
		// otherwise the target's own backoff has expired by then, the same account serves again, and
		// the silence would be explained by the same-account rule instead of the window.
		await storage.markUsageLimitReached(PROVIDER, SESSION_ID, {
			credentialId: targetId,
			retryAfterMs: 10 * 60_000,
		});

		await storage.rotateSessionCredential(PROVIDER, SESSION_ID, {
			credentialId: targetId,
			error: Object.assign(new Error("invalid_grant: token revoked"), { status: 401 }),
		});

		setSystemTime(new Date(NOW_MS + NOTICE_WINDOW_MS + 1));
		expect(await storage.getApiKey(PROVIDER, SESSION_ID)).toBe("access-sibling");
		expect(events).toEqual([]);

		setSystemTime(new Date(NOW_MS + NOTICE_WINDOW_MS + 2));
		expect(await storage.getApiKey(PROVIDER, SESSION_ID)).toBe("access-sibling");
		expect(events).toEqual([]);
	});

	/**
	 * The one moment the setting costs something is the one moment it announces itself: quota is
	 * gone, idle accounts exist, and the operator is about to wait instead of using them. The event
	 * carries what a sentence about that needs, and the exhausted account is named by the label the
	 * account list shows rather than by its row id.
	 */
	test("withholding a move from idle siblings announces itself once, with the count and this account's reset", async () => {
		if (!store) throw new Error("test setup failed");
		const withheld: UsageLimitWithheldEvent[] = [];
		const storage = new AuthStorage(store, {
			loadBalancing: false,
			onUsageLimitWithheld: event => {
				withheld.push(event);
			},
		});
		const { targetId, targetEmail } = await seed(storage);

		const result = await storage.markUsageLimitReached(PROVIDER, SESSION_ID, {
			credentialId: targetId,
			retryAfterMs: 60_000,
		});

		expect(result).toEqual({ switched: false, retryAtMs: NOW_MS + 60_000 });
		expect(withheld).toEqual([
			{
				provider: PROVIDER,
				account: { credentialId: targetId, label: targetEmail },
				idleSiblings: 1,
				retryAtMs: NOW_MS + 60_000,
			},
		]);
	});

	/**
	 * A turn retries into the same exhausted window several times, and each retry re-enters this
	 * path. Announcing per call would repeat one fact until it is noise, so the notice is deduped by
	 * the window it describes. A LATER exhaustion is a different window and is announced again,
	 * which is what separates deduping from announcing once per process.
	 */
	test("one exhausted window is announced once, and a later window is announced again", async () => {
		if (!store) throw new Error("test setup failed");
		const withheld: UsageLimitWithheldEvent[] = [];
		const storage = new AuthStorage(store, {
			loadBalancing: false,
			onUsageLimitWithheld: event => {
				withheld.push(event);
			},
		});
		const { targetId } = await seed(storage);

		await storage.markUsageLimitReached(PROVIDER, SESSION_ID, { credentialId: targetId, retryAfterMs: 60_000 });
		await storage.markUsageLimitReached(PROVIDER, SESSION_ID, { credentialId: targetId, retryAfterMs: 60_000 });
		expect(withheld).toHaveLength(1);

		// The window reset arrived and quota ran out again, which the operator has not been told
		// about: same account, different window.
		setSystemTime(new Date(NOW_MS + 2 * 60_000));
		await storage.markUsageLimitReached(PROVIDER, SESSION_ID, { credentialId: targetId, retryAfterMs: 60_000 });

		expect(withheld.map(event => event.retryAtMs)).toEqual([NOW_MS + 60_000, NOW_MS + 3 * 60_000]);
	});

	/**
	 * Nothing was withheld, so there is nothing to say. Both shapes of "no idle sibling" are here
	 * because they arrive by different routes: no sibling exists at all, and every sibling is
	 * already blocked. A notice in either case would advertise a setting that could not have helped,
	 * which is how a useful sentence becomes one the operator learns to skip.
	 */
	test("nothing is announced when no idle sibling could have served", async () => {
		if (!store) throw new Error("test setup failed");
		const withheld: UsageLimitWithheldEvent[] = [];
		const storage = new AuthStorage(store, {
			loadBalancing: false,
			onUsageLimitWithheld: event => {
				withheld.push(event);
			},
		});
		await storage.set(PROVIDER, [
			{
				type: "oauth",
				access: "access-only",
				refresh: "refresh-only",
				expires: NOW_MS + HOUR_MS,
				accountId: "account-only",
				email: "only@example.com",
			},
		]);
		const onlyId = storage.listStoredCredentials(PROVIDER)[0]!.id;

		await storage.markUsageLimitReached(PROVIDER, SESSION_ID, { credentialId: onlyId, retryAfterMs: 60_000 });
		expect(withheld).toEqual([]);

		// Now two accounts, both exhausted. The second mark has a sibling, and that sibling is
		// blocked, so the gate withheld nothing.
		const { targetId, siblingId } = await seed(storage);
		await storage.markUsageLimitReached(PROVIDER, SESSION_ID, { credentialId: siblingId, retryAfterMs: 60_000 });
		const before = withheld.length;
		await storage.markUsageLimitReached(PROVIDER, SESSION_ID, { credentialId: targetId, retryAfterMs: 60_000 });

		expect(withheld.slice(before).filter(event => event.account.credentialId === targetId)).toEqual([]);
	});

	/**
	 * With the setting ON the move happens, so there is nothing withheld and nothing to announce.
	 * The notice pointing at a setting that is already on would be advice to do what was done.
	 */
	test("nothing is announced when load balancing is on", async () => {
		if (!store) throw new Error("test setup failed");
		const withheld: UsageLimitWithheldEvent[] = [];
		const storage = new AuthStorage(store, {
			loadBalancing: true,
			onUsageLimitWithheld: event => {
				withheld.push(event);
			},
		});
		const { targetId } = await seed(storage);

		const result = await storage.markUsageLimitReached(PROVIDER, SESSION_ID, {
			credentialId: targetId,
			retryAfterMs: 60_000,
		});

		expect(result).toEqual({ switched: true });
		expect(withheld).toEqual([]);
	});
});
