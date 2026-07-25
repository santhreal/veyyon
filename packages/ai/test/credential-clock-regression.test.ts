import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@veyyon/ai/auth-storage";
import {
	CREDENTIAL_CLOCK_TOLERANCE_MS,
	epochSecondsToMs,
	isRecordFromFutureClock,
} from "@veyyon/ai/credential-clock";
import { removeWithRetries } from "../../utils/src/temp";

/**
 * A rate-limit block must not outlive the clock that created it (TIME-3).
 *
 * Every block is an absolute deadline in epoch milliseconds, which is only
 * meaningful while the wall clock moves forward. An NTP step on a drifted
 * machine, a laptop resuming from suspend, a VM restored from a snapshot, or a
 * container that starts before the host syncs all move `Date.now()` BACKWARD.
 * When that happens a 60-second backoff can hold a credential for the length of
 * the jump: hours on a single-credential setup, with nothing logged and no way
 * for the operator to tell why a working credential is being refused. The
 * persisted form is worse still, because it survives every restart until the
 * stale deadline is finally reached.
 *
 * The rule proven here is that a block whose recorded write time sits ahead of
 * the reading clock is dropped, not honoured. These tests drive real
 * `AuthStorage` selection and a real SQLite store rather than asserting on the
 * predicate alone, because the predicate being correct is worthless if a read
 * path forgets to consult it.
 */

const PROVIDER = "zai";
const HOUR_MS = 60 * 60 * 1000;

describe("isRecordFromFutureClock", () => {
	/** A reference "now" so every boundary below is exact arithmetic. */
	const NOW = 1_700_000_000_000;

	it("accepts a block written in the past, which is every ordinary block", () => {
		expect(isRecordFromFutureClock(NOW - HOUR_MS, NOW)).toBe(false);
	});

	it("accepts a block written at exactly the reading instant", () => {
		// The common case on the write path: mark and read within the same tick.
		expect(isRecordFromFutureClock(NOW, NOW)).toBe(false);
	});

	it("accepts a write time inside the tolerance, so second-resolution rounding does not clear blocks", () => {
		// SQLite records `updated_at` in whole seconds and a shared-auth database
		// on a network share can be written by a second machine a few seconds off.
		// Neither is a clock jump, and treating them as one would drop live blocks
		// and send requests straight back into the provider's rate limit.
		expect(isRecordFromFutureClock(NOW + CREDENTIAL_CLOCK_TOLERANCE_MS - 1, NOW)).toBe(false);
	});

	it("accepts a write time exactly at the tolerance, so the bound is inclusive", () => {
		expect(isRecordFromFutureClock(NOW + CREDENTIAL_CLOCK_TOLERANCE_MS, NOW)).toBe(false);
	});

	it("rejects a write time one millisecond past the tolerance", () => {
		// The exact boundary, asserted from both sides so a later edit to the
		// comparison cannot slide it by a tick unnoticed.
		expect(isRecordFromFutureClock(NOW + CREDENTIAL_CLOCK_TOLERANCE_MS + 1, NOW)).toBe(true);
	});

	it("rejects a write time hours ahead, the shape a real NTP correction leaves", () => {
		expect(isRecordFromFutureClock(NOW + 2 * HOUR_MS, NOW)).toBe(true);
	});

	it("honours a block with no recorded write time instead of discarding it", () => {
		// A store that does not record the timestamp must degrade to the old rules.
		// Reading `undefined` as "written in the future" would silently drop every
		// block such a store ever set.
		expect(isRecordFromFutureClock(undefined, NOW)).toBe(false);
	});

	it("honours a block whose write time is not a finite number", () => {
		// Same reasoning for a corrupt column: unusable input means "no opinion",
		// never "clear the block".
		expect(isRecordFromFutureClock(Number.NaN, NOW)).toBe(false);
		expect(isRecordFromFutureClock(Number.POSITIVE_INFINITY, NOW)).toBe(false);
	});
});

describe("epochSecondsToMs", () => {
	it("converts whole seconds to milliseconds", () => {
		// The column is seconds and every deadline in the subsystem is
		// milliseconds. A missing factor of a thousand puts the write time in 1970,
		// which reads as a perfectly ordinary past timestamp and disables the guard.
		expect(epochSecondsToMs(1_700_000_000)).toBe(1_700_000_000_000);
	});

	it("returns undefined for a missing column so callers can tell it apart from epoch zero", () => {
		expect(epochSecondsToMs(undefined)).toBeUndefined();
	});

	it("returns undefined for a non-finite column", () => {
		expect(epochSecondsToMs(Number.NaN)).toBeUndefined();
	});
});

describe("AuthStorage credential selection across a backward clock jump", () => {
	let tempDir = "";
	let dbPath = "";
	let store: SqliteAuthCredentialStore | null = null;
	let auth: AuthStorage | null = null;
	const realNow = Date.now;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-block-clock-"));
		dbPath = path.join(tempDir, "agent.db");
		store = await SqliteAuthCredentialStore.open(dbPath);
		auth = new AuthStorage(store);
		await auth.set(PROVIDER, [
			{ type: "api_key", key: "key-a", source: "login" },
			{ type: "api_key", key: "key-b", source: "login" },
		]);
	});

	afterEach(async () => {
		Date.now = realNow;
		auth?.close();
		store?.close();
		auth = null;
		store = null;
		if (tempDir) {
			await removeWithRetries(tempDir);
			tempDir = "";
		}
	});

	/** Every key selection returns over `count` distinct sessions, deduplicated.
	 * Distinct sessions defeat per-session stickiness, so what is left is the
	 * pool the selector considers usable right now. */
	async function selectableKeys(storage: AuthStorage, label: string, count = 8): Promise<string[]> {
		const seen = new Set<string>();
		for (let i = 0; i < count; i++) {
			const key = await storage.getApiKey(PROVIDER, `${label}-${i}`);
			if (key) seen.add(key);
		}
		return [...seen].sort();
	}

	it("removes a blocked credential from the pool, then restores it once the clock moves backward", async () => {
		if (!auth) throw new Error("test setup failed");
		// Block whichever credential the first session resolved to, for an hour.
		const blocked = await auth.getApiKey(PROVIDER, "session");
		expect(blocked).toBeString();
		const sibling = blocked === "key-a" ? "key-b" : "key-a";
		await auth.markUsageLimitReached(PROVIDER, "session", { retryAfterMs: HOUR_MS });

		// Precondition: the block is real. Only the sibling is selectable.
		expect(await selectableKeys(auth, "blocked")).toEqual([sibling]);

		// The jump: the clock steps back two hours, so the block's deadline is now
		// an hour in the future by a clock that never set it.
		const jumpedTo = realNow() - 2 * HOUR_MS;
		Date.now = () => jumpedTo;

		// Both credentials are usable again. Before the guard the blocked one
		// stayed out of the pool for the full three hours the jump manufactured.
		expect(await selectableKeys(auth, "jumped")).toEqual(["key-a", "key-b"].sort());
	});

	it("keeps a blocked credential out of the pool while the clock only moves forward", async () => {
		if (!auth) throw new Error("test setup failed");
		// The control for the case above: the guard must not be a blanket
		// "expire blocks early", or every rate-limit backoff becomes a no-op and
		// the agent hammers a provider that just refused it.
		const blocked = await auth.getApiKey(PROVIDER, "session");
		const sibling = blocked === "key-a" ? "key-b" : "key-a";
		await auth.markUsageLimitReached(PROVIDER, "session", { retryAfterMs: HOUR_MS });

		const jumpedTo = realNow() + 30 * 60 * 1000; // still inside the hour
		Date.now = () => jumpedTo;

		expect(await selectableKeys(auth, "forward")).toEqual([sibling]);
	});

	it("lets the block expire normally when the clock reaches the deadline", async () => {
		if (!auth) throw new Error("test setup failed");
		// The ordinary path, asserted so the guard cannot be credited for an
		// unblock that plain expiry was going to produce anyway.
		await auth.getApiKey(PROVIDER, "session");
		await auth.markUsageLimitReached(PROVIDER, "session", { retryAfterMs: HOUR_MS });

		const jumpedTo = realNow() + HOUR_MS + 1_000;
		Date.now = () => jumpedTo;

		expect(await selectableKeys(auth, "expired")).toEqual(["key-a", "key-b"].sort());
	});

	it("re-blocks against the new clock instead of resurrecting the pre-jump deadline", async () => {
		if (!auth) throw new Error("test setup failed");
		// The in-memory write path keeps the LATER of the existing and incoming
		// deadlines, which is right for two genuine rate-limit responses and wrong
		// across a jump: the stale deadline would win the comparison forever and
		// the credential could never be re-blocked for a sane interval.
		const blocked = await auth.getApiKey(PROVIDER, "session");
		const sibling = blocked === "key-a" ? "key-b" : "key-a";
		await auth.markUsageLimitReached(PROVIDER, "session", { retryAfterMs: 6 * HOUR_MS });

		const jumpedTo = realNow() - 2 * HOUR_MS;
		Date.now = () => jumpedTo;
		expect(await selectableKeys(auth, "jumped")).toEqual(["key-a", "key-b"].sort());

		// A fresh rate-limit response on the new clock blocks for one minute.
		await auth.markUsageLimitReached(PROVIDER, "session", { retryAfterMs: 60_000 });
		expect(await selectableKeys(auth, "reblocked")).toEqual([sibling]);

		// One minute later on that same clock it is usable again. If the six-hour
		// deadline had survived the jump, this would still be blocked.
		Date.now = () => jumpedTo + 61_000;
		expect(await selectableKeys(auth, "recovered")).toEqual(["key-a", "key-b"].sort());
	});

	it("drops a persisted block written by a future clock, which no restart would otherwise clear", async () => {
		if (!auth || !store) throw new Error("test setup failed");
		// The persisted half of the same defect. The row is written with the real
		// clock, so reading it two hours in the past is exactly what a machine
		// whose clock was corrected backward does on its next launch.
		const blocked = await auth.getApiKey(PROVIDER, "session");
		const sibling = blocked === "key-a" ? "key-b" : "key-a";
		await auth.markUsageLimitReached(PROVIDER, "session", { retryAfterMs: 6 * HOUR_MS });
		expect(await selectableKeys(auth, "blocked")).toEqual([sibling]);
		auth.close();
		store.close();

		const jumpedTo = realNow() - 2 * HOUR_MS;
		Date.now = () => jumpedTo;

		// Reopen exactly as a fresh process would: only the database carries state.
		store = await SqliteAuthCredentialStore.open(dbPath);
		auth = new AuthStorage(store);
		await auth.reload();
		expect(await selectableKeys(auth, "restarted")).toEqual(["key-a", "key-b"].sort());
	});
});

describe("SqliteAuthCredentialStore.getCredentialBlock", () => {
	let tempDir = "";
	let dbPath = "";
	let store: SqliteAuthCredentialStore | null = null;
	const realNow = Date.now;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-block-clock-sql-"));
		dbPath = path.join(tempDir, "agent.db");
		store = await SqliteAuthCredentialStore.open(dbPath);
		store.saveApiKey(PROVIDER, "key-a");
	});

	afterEach(async () => {
		Date.now = realNow;
		store?.close();
		store = null;
		if (tempDir) {
			await removeWithRetries(tempDir);
			tempDir = "";
		}
	});

	/** Overwrite a block row's `updated_at`, which the upsert otherwise fills
	 * from the database's own clock. Direct SQL is the only way to pin it. */
	function stampWriteTime(credentialId: number, updatedAtSeconds: number): void {
		const db = new Database(dbPath);
		try {
			db.prepare("UPDATE auth_credential_blocks SET updated_at = ? WHERE credential_id = ?").run(
				updatedAtSeconds,
				credentialId,
			);
		} finally {
			db.close();
		}
	}

	function blockCredential(credentialId: number, blockedUntilMs: number): void {
		store?.upsertCredentialBlock({ credentialId, providerKey: `${PROVIDER}:api_key`, blockScope: "", blockedUntilMs });
	}

	function readBlock(credentialId: number): number | undefined {
		return store?.getCredentialBlock(credentialId, `${PROVIDER}:api_key`, "");
	}

	it("returns the deadline for a block written in the past", async () => {
		if (!store) throw new Error("test setup failed");
		const [row] = store.listAuthCredentials(PROVIDER);
		if (!row) throw new Error("expected a credential row");
		const deadline = realNow() + HOUR_MS;
		blockCredential(row.id, deadline);
		stampWriteTime(row.id, Math.floor((realNow() - HOUR_MS) / 1000));

		expect(readBlock(row.id)).toBe(deadline);
	});

	it("returns undefined for a block whose row was written by a clock hours ahead", async () => {
		if (!store) throw new Error("test setup failed");
		// Written at T, read at T-2h. Without the guard this row holds the
		// credential for three hours across every process that opens the database.
		const [row] = store.listAuthCredentials(PROVIDER);
		if (!row) throw new Error("expected a credential row");
		blockCredential(row.id, realNow() + HOUR_MS);
		stampWriteTime(row.id, Math.floor(realNow() / 1000));

		const jumpedTo = realNow() - 2 * HOUR_MS;
		Date.now = () => jumpedTo;

		expect(readBlock(row.id)).toBeUndefined();
	});

	it("still returns the deadline when the row is only seconds ahead", async () => {
		if (!store) throw new Error("test setup failed");
		// Second-resolution rounding and small inter-machine skew on a shared
		// database are not clock jumps, and clearing on them would waste a request
		// against a provider that has already said no.
		const [row] = store.listAuthCredentials(PROVIDER);
		if (!row) throw new Error("expected a credential row");
		const deadline = realNow() + HOUR_MS;
		blockCredential(row.id, deadline);
		stampWriteTime(row.id, Math.floor((realNow() + CREDENTIAL_CLOCK_TOLERANCE_MS - 1_000) / 1000));

		expect(readBlock(row.id)).toBe(deadline);
	});
});

describe("OAuth refresh lease across a backward clock jump", () => {
	/**
	 * The lease is the sharper half of TIME-1. Ownership is claimed by an upsert
	 * guarded on `expires_at_ms <= now`, and the waiter loop in
	 * `#withOAuthRefreshOwnership` polls until it wins with no deadline of its
	 * own. A lease stamped by a clock ahead of the reader can therefore never be
	 * stolen, and every OAuth refresh for that credential hangs for the length of
	 * the jump. A hung refresh is worse than a skipped one: nothing times out,
	 * nothing logs, and the agent simply stops making progress.
	 */
	let tempDir = "";
	let store: SqliteAuthCredentialStore | null = null;
	const realNow = Date.now;
	const LEASE_TTL_MS = 30_000;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-lease-clock-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		store.saveApiKey(PROVIDER, "key-a");
	});

	afterEach(async () => {
		Date.now = realNow;
		store?.close();
		store = null;
		if (tempDir) {
			await removeWithRetries(tempDir);
			tempDir = "";
		}
	});

	function credentialId(): number {
		const [row] = store?.listAuthCredentials(PROVIDER) ?? [];
		if (!row) throw new Error("expected a credential row");
		return row.id;
	}

	it("refuses a second owner while the lease is live", async () => {
		if (!store) throw new Error("test setup failed");
		// The control. The guard must not make leases stealable in general, or two
		// processes refresh the same credential at once and one of them writes a
		// token the other has already rotated away.
		const id = credentialId();
		expect(store.tryAcquireCredentialRefreshLease(id, "owner-a", realNow() + LEASE_TTL_MS)).toBe(true);

		expect(store.tryAcquireCredentialRefreshLease(id, "owner-b", realNow() + LEASE_TTL_MS)).toBe(false);
	});

	it("lets a second owner take over once the lease expires normally", async () => {
		if (!store) throw new Error("test setup failed");
		const id = credentialId();
		expect(store.tryAcquireCredentialRefreshLease(id, "owner-a", realNow() + LEASE_TTL_MS)).toBe(true);

		Date.now = () => realNow() + LEASE_TTL_MS + 1_000;

		expect(store.tryAcquireCredentialRefreshLease(id, "owner-b", Date.now() + LEASE_TTL_MS)).toBe(true);
	});

	it("lets a second owner steal a lease stamped by a clock hours ahead", async () => {
		if (!store) throw new Error("test setup failed");
		// Written at T, read at T-2h. Before the guard the acquire's
		// `expires_at_ms <= now` bound could not match for over two hours, so the
		// refresh loop polled the whole time.
		const id = credentialId();
		expect(store.tryAcquireCredentialRefreshLease(id, "owner-a", realNow() + LEASE_TTL_MS)).toBe(true);

		const jumpedTo = realNow() - 2 * HOUR_MS;
		Date.now = () => jumpedTo;

		expect(store.tryAcquireCredentialRefreshLease(id, "owner-b", jumpedTo + LEASE_TTL_MS)).toBe(true);
	});

	it("reports a lease from a future clock as absent, so the waiter retries instead of sleeping", async () => {
		if (!store) throw new Error("test setup failed");
		// The wait interval is derived from this reading. Left unguarded it would
		// return a deadline two hours out and the caller would wait on it.
		const id = credentialId();
		const expiresAt = realNow() + LEASE_TTL_MS;
		expect(store.tryAcquireCredentialRefreshLease(id, "owner-a", expiresAt)).toBe(true);
		expect(store.getCredentialRefreshLeaseExpiresAt(id)).toBe(expiresAt);

		Date.now = () => realNow() - 2 * HOUR_MS;

		expect(store.getCredentialRefreshLeaseExpiresAt(id)).toBeUndefined();
	});

	it("keeps reporting a live lease when the clock only drifts by seconds", async () => {
		if (!store) throw new Error("test setup failed");
		// Second-resolution rounding on `updated_at` must not read as a jump, or
		// ordinary contention turns into two concurrent refreshes.
		const id = credentialId();
		const expiresAt = realNow() + LEASE_TTL_MS;
		expect(store.tryAcquireCredentialRefreshLease(id, "owner-a", expiresAt)).toBe(true);

		Date.now = () => realNow() - (CREDENTIAL_CLOCK_TOLERANCE_MS - 2_000);

		expect(store.getCredentialRefreshLeaseExpiresAt(id)).toBe(expiresAt);
		expect(store.tryAcquireCredentialRefreshLease(id, "owner-b", Date.now() + LEASE_TTL_MS)).toBe(false);
	});
});
