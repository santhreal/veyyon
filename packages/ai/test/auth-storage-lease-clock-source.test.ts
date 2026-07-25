import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SqliteAuthCredentialStore } from "@veyyon/ai/auth-storage";
import { CREDENTIAL_CLOCK_TOLERANCE_MS, epochSecondsToMs, msToEpochSeconds } from "@veyyon/ai/credential-clock";
import { removeWithRetries } from "../../utils/src/temp";

/**
 * The refresh lease must be governed by ONE clock.
 *
 * A lease row carries two times: `expires_at_ms`, taken from `Date.now()`, and
 * `updated_at`, which the acquire and renew statements write. `updated_at` is
 * not merely a record of when the row was touched. The lease logic reads it back
 * and compares it against `Date.now()` to decide whether the row came from a
 * clock running ahead of this one, and a row that did is treated as stealable so
 * a backward clock jump cannot make a lease unstealable for the length of the
 * jump.
 *
 * That check only means something if the write and the comparison use the same
 * clock. It did not. `updated_at` was stamped with SQLite's own
 * `strftime('%s','now')`, evaluated in C and answerable to nothing in the
 * process, while every comparison read JavaScript's `Date.now()`. One value,
 * two clocks. Whenever they disagreed, a live lease held by a healthy peer was
 * misread as the work of a machine with a skewed clock and stolen immediately.
 *
 * How it surfaced: `mcp-manager-oauth-refresh.test.ts`'s "renews refresh
 * ownership while the token endpoint is blocked" failed deterministically with
 * `Timed out waiting for Bun.sleep(250)`. The waiting peer never reached its
 * clamped lease-wait because it never had to wait at all: it stole the lease on
 * the first attempt. Any process that moves its own clock hits the same thing,
 * and two managers then refresh concurrently and replay a single-use rotating
 * refresh token, which is the exact loss the lease exists to prevent.
 *
 * These tests drive the real SQLite store rather than the predicate alone,
 * because a correct predicate proves nothing if the write path feeds it a
 * timestamp from somewhere else.
 */

const CREDENTIAL_ID = 1;
const TTL_MS = 15_000;

describe("the refresh lease is stamped from the application clock", () => {
	let tempDir = "";
	let store: SqliteAuthCredentialStore;
	let realNow: typeof Date.now;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-lease-clock-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		realNow = Date.now;
	});

	afterEach(async () => {
		Date.now = realNow;
		store.close?.();
		await removeWithRetries(tempDir);
	});

	/** Pin the application clock without touching SQLite's, which is the whole point. */
	function setAppClock(ms: number): void {
		Date.now = () => ms;
	}

	/**
	 * The regression, stated at its narrowest. With the application clock set to a
	 * date well behind the machine's real one, SQLite would stamp `updated_at`
	 * from the real clock, the acquire's stale-write clause would read that as a
	 * write from the future, and the second acquire would succeed. A lease held by
	 * a live owner must not be stealable no matter where the process clock sits,
	 * because the only thing that makes a lease safe to take is EXPIRY.
	 */
	it("does not let a peer steal a live lease when the process clock differs from the machine's", () => {
		// Deliberately in the past relative to any real machine clock, which is what
		// made SQLite's stamp look like it came from the future.
		const now = Date.parse("2026-07-10T12:00:00.000Z");
		setAppClock(now);

		expect(store.tryAcquireCredentialRefreshLease(CREDENTIAL_ID, "owner-a", now + TTL_MS)).toBe(true);
		expect(store.tryAcquireCredentialRefreshLease(CREDENTIAL_ID, "owner-b", now + TTL_MS)).toBe(false);
	});

	/**
	 * And the lease is still readable as live. `getCredentialRefreshLeaseExpiresAt`
	 * reports a future-clock row as absent so the waiter retries the acquire
	 * instead of sleeping, so the same mismatch made it return `undefined` for a
	 * perfectly healthy lease. A waiter given `undefined` polls at the 50ms floor
	 * forever rather than waiting out the real remaining lease.
	 */
	it("reports a live lease's expiry rather than hiding it as a future-clock row", () => {
		const now = Date.parse("2026-07-10T12:00:00.000Z");
		setAppClock(now);
		store.tryAcquireCredentialRefreshLease(CREDENTIAL_ID, "owner-a", now + TTL_MS);

		expect(store.getCredentialRefreshLeaseExpiresAt(CREDENTIAL_ID)).toBe(now + TTL_MS);
	});

	/**
	 * The renewal path re-stamps `updated_at`, so it needed the same fix. Without
	 * it the bug would simply return on the first renewal, which is precisely the
	 * case that matters: a refresh slow enough to need renewing is a refresh with a
	 * peer waiting behind it.
	 */
	it("keeps the lease unstealable after a renewal", () => {
		const now = Date.parse("2026-07-10T12:00:00.000Z");
		setAppClock(now);
		store.tryAcquireCredentialRefreshLease(CREDENTIAL_ID, "owner-a", now + TTL_MS);

		setAppClock(now + 5_000);
		expect(store.renewCredentialRefreshLease(CREDENTIAL_ID, "owner-a", now + 5_000 + TTL_MS)).toBe(true);

		expect(store.tryAcquireCredentialRefreshLease(CREDENTIAL_ID, "owner-b", now + 5_000 + TTL_MS)).toBe(false);
		expect(store.getCredentialRefreshLeaseExpiresAt(CREDENTIAL_ID)).toBe(now + 5_000 + TTL_MS);
	});

	/**
	 * The negative twin, and the reason the fix is not just "delete the clause".
	 * A row genuinely written by a clock ahead of ours is STILL stealable. Without
	 * this, the suite above would pass against a build that removed the stale-write
	 * clause entirely, and a backward clock jump would hang every refresh waiter
	 * for the length of the jump.
	 */
	it("still steals a lease written by a clock genuinely ahead of ours", () => {
		const future = Date.parse("2026-07-10T12:00:00.000Z");
		setAppClock(future);
		store.tryAcquireCredentialRefreshLease(CREDENTIAL_ID, "owner-ahead", future + TTL_MS);

		// The clock jumps backward past the tolerance, as an NTP step or a restored
		// snapshot does. The existing lease now looks like it was written later than
		// the present, so it must be taken rather than waited out.
		setAppClock(future - 10 * 60 * 1000);
		expect(store.tryAcquireCredentialRefreshLease(CREDENTIAL_ID, "owner-b", Date.now() + TTL_MS)).toBe(true);
	});

	/**
	 * A lease past its expiry is stealable on the ordinary path, with no clock
	 * trickery involved. This is the case the whole mechanism exists to serve, so
	 * it is asserted rather than assumed: a fix that made leases unstealable would
	 * otherwise pass every test above.
	 */
	it("steals an expired lease", () => {
		const now = Date.parse("2026-07-10T12:00:00.000Z");
		setAppClock(now);
		store.tryAcquireCredentialRefreshLease(CREDENTIAL_ID, "owner-a", now + TTL_MS);

		setAppClock(now + TTL_MS + 1);
		expect(store.tryAcquireCredentialRefreshLease(CREDENTIAL_ID, "owner-b", Date.now() + TTL_MS)).toBe(true);
		expect(store.getCredentialRefreshLeaseExpiresAt(CREDENTIAL_ID)).toBe(now + TTL_MS + 1 + TTL_MS);
	});

	/**
	 * The tolerance boundary is exact. A write within the allowance is a peer whose
	 * clock is merely a little off and whose lease must be respected; only a write
	 * beyond it counts as the future. An off-by-one here decides whether a mildly
	 * drifted machine has its leases silently stolen.
	 */
	it("respects a lease written within the clock tolerance", () => {
		const now = Date.parse("2026-07-10T12:00:00.000Z");
		// Write one second inside the allowance, so the recorded whole second is
		// still within tolerance of the reader.
		setAppClock(now + CREDENTIAL_CLOCK_TOLERANCE_MS - 1_000);
		store.tryAcquireCredentialRefreshLease(CREDENTIAL_ID, "owner-a", Date.now() + TTL_MS);

		setAppClock(now);
		expect(store.tryAcquireCredentialRefreshLease(CREDENTIAL_ID, "owner-b", now + TTL_MS)).toBe(false);
	});

	/**
	 * The owner fence is independent of all of the above. Renewal is what keeps a
	 * long refresh's ownership alive, and a renewal that ignored the owner would
	 * let a peer that lost the race extend a lease it does not hold.
	 */
	it("refuses to renew a lease owned by someone else", () => {
		const now = Date.parse("2026-07-10T12:00:00.000Z");
		setAppClock(now);
		store.tryAcquireCredentialRefreshLease(CREDENTIAL_ID, "owner-a", now + TTL_MS);

		expect(store.renewCredentialRefreshLease(CREDENTIAL_ID, "owner-b", now + 60_000)).toBe(false);
		expect(store.getCredentialRefreshLeaseExpiresAt(CREDENTIAL_ID)).toBe(now + TTL_MS);
	});

	/**
	 * Releasing hands the row to the next caller immediately, which is the fast
	 * path after a successful refresh. If this regressed, every peer would wait out
	 * the full TTL after a refresh that already finished.
	 */
	it("lets a peer acquire immediately after the owner releases", () => {
		const now = Date.parse("2026-07-10T12:00:00.000Z");
		setAppClock(now);
		store.tryAcquireCredentialRefreshLease(CREDENTIAL_ID, "owner-a", now + TTL_MS);
		store.releaseCredentialRefreshLease(CREDENTIAL_ID, "owner-a");

		expect(store.tryAcquireCredentialRefreshLease(CREDENTIAL_ID, "owner-b", now + TTL_MS)).toBe(true);
	});
});

/**
 * The seconds/milliseconds conversion, which is where a factor of a thousand
 * could hide. `updated_at` is whole seconds and every deadline around it is
 * milliseconds, so both directions live in one file and are pinned here.
 */
describe("msToEpochSeconds", () => {
	/**
	 * Rounding DOWN is required, not incidental. SQLite's `strftime('%s','now')`
	 * truncates, so a write that rounded up would land a second ahead of a reader
	 * sharing the very same clock and read as a future-clock row, which is the bug
	 * this whole file is about, reintroduced through the conversion.
	 */
	it("truncates rather than rounding, matching strftime", () => {
		expect(msToEpochSeconds(1_700_000_000_999)).toBe(1_700_000_000);
		expect(msToEpochSeconds(1_700_000_000_001)).toBe(1_700_000_000);
		expect(msToEpochSeconds(1_700_000_000_000)).toBe(1_700_000_000);
	});

	/** Round-trips through the inverse, so the pair cannot drift apart. */
	it("round-trips a whole second through epochSecondsToMs", () => {
		const ms = 1_700_000_000_000;
		expect(epochSecondsToMs(msToEpochSeconds(ms))).toBe(ms);
	});

	/** Sub-second precision is lost by design, and the loss is downward. */
	it("loses sub-second precision downward on a round trip", () => {
		expect(epochSecondsToMs(msToEpochSeconds(1_700_000_000_750))).toBe(1_700_000_000_000);
	});
});
