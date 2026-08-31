/**
 * The one rule for deciding whether a stored deadline outlived the clock that
 * created it (TIME-1, TIME-3).
 *
 * Two records in this subsystem are ABSOLUTE deadlines: a rate-limit block
 * ("this credential is unusable until epoch millisecond N") and an OAuth
 * refresh lease ("this process owns the refresh until N"). Both are correct as
 * long as the wall clock only moves forward. It does not. An NTP correction on
 * a machine whose clock had drifted, a laptop resuming from suspend, a
 * container starting before the host has synced, a VM restored from a snapshot:
 * all of them step `Date.now()` BACKWARD, sometimes by hours.
 *
 * A 60-second backoff written at 14:00:00 with a deadline of 14:01:00, read
 * against a clock that now says 11:30:00, holds the credential for an hour and
 * a half. Nothing logs it and nothing expires it: the operator sees a working
 * credential the agent refuses to use, and on a single-credential setup that is
 * a full outage. The persisted form is worse, because it survives every restart
 * until the stale deadline is finally reached.
 *
 * A refresh lease fails harder still. Ownership is taken by an upsert guarded
 * on `expires_at_ms <= now`, so a lease stamped ahead of the reading clock can
 * never be stolen, and the waiter polls for the length of the jump with no
 * deadline of its own. That is a hung OAuth refresh, not a slow one.
 *
 * Detection is possible because both records also store WHEN they were written.
 * A row whose write time is in the future cannot have been written by the clock
 * we are reading now, so the deadline attached to it is measured in units we no
 * longer have. Rather than guess how far the clock moved, discard the deadline:
 * drop the block, steal the lease.
 *
 * Discarding (rather than keeping, or rescaling) is deliberate. The two errors
 * are not symmetric. A block wrongly kept is an outage for its full duration,
 * while a block wrongly dropped costs one request that the provider answers
 * with a fresh rate-limit response, which immediately re-blocks the credential
 * against the current clock. A lease wrongly kept hangs the refresh, while a
 * lease wrongly stolen costs one redundant refresh that the store's own
 * compare-and-set on the credential row already tolerates. Fail toward
 * availability, and let the provider be the authority it already is.
 */

/**
 * How far a record's write time may sit ahead of the reading clock before it is
 * treated as a regression rather than as noise.
 *
 * Ordinary sources of a small positive difference are benign and must not clear
 * blocks: SQLite records `updated_at` in whole seconds, so a row written at
 * `x.9s` and read at `x.1s` later reads as up to a second in the future, and a
 * shared-auth database on a network share can be written by a second machine
 * whose clock differs by a few seconds.
 *
 * Five seconds covers both while staying far below any real jump, which is a
 * minute at the very least and usually much more. The cost of choosing this
 * bound slightly too low is one early retry against the provider; the cost of
 * choosing it too high is that a jump smaller than the bound blocks a
 * credential for the length of the jump. Both are bounded and small, and the
 * first is the cheaper one to be wrong about.
 */
export const CREDENTIAL_CLOCK_TOLERANCE_MS = 5_000;

/**
 * True when `writtenAtMs` (when the record was stored) sits far enough ahead of
 * `nowMs` (the clock reading it) that the clock must have moved backward, which
 * makes the record's absolute deadline unusable.
 *
 * `undefined`/non-finite `writtenAtMs` means the backing store did not record a
 * write time, and there is nothing to compare: the record is honoured as
 * written. That is the pre-existing behaviour and is preserved deliberately, so
 * a store that omits the timestamp degrades to the old rules instead of having
 * every one of its records silently discarded.
 */
export function isRecordFromFutureClock(writtenAtMs: number | undefined, nowMs: number): boolean {
	if (typeof writtenAtMs !== "number" || !Number.isFinite(writtenAtMs)) return false;
	return nowMs + CREDENTIAL_CLOCK_TOLERANCE_MS < writtenAtMs;
}

/**
 * Converts a row's `updated_at` column to epoch milliseconds.
 *
 * The SQLite schema stores it in whole SECONDS while every deadline in this
 * subsystem is in milliseconds, and the two are only a factor of a thousand
 * apart, which is exactly the kind of difference that reads as plausible in a
 * timestamp. Doing the conversion in one named place keeps that factor from
 * being re-derived at each call site.
 *
 * Returns `undefined` for a missing or non-finite column so callers can tell
 * "no recorded write time" apart from "written at epoch zero".
 */
export function epochSecondsToMs(seconds: number | undefined): number | undefined {
	if (typeof seconds !== "number" || !Number.isFinite(seconds)) return undefined;
	return seconds * 1000;
}

/**
 * Converts epoch milliseconds to the whole seconds an `updated_at` column holds.
 *
 * The inverse of {@link epochSecondsToMs}, and it lives beside it so the
 * thousand stays in one file rather than being spelled out at a write site.
 *
 * Rounds DOWN, matching SQLite's `strftime('%s','now')`, which truncates. That
 * matters because these timestamps are compared against a cutoff that rounds up:
 * rounding a write UP could place it a second in the future relative to a reader
 * on the very same clock and make a live lease look stealable.
 */
export function msToEpochSeconds(ms: number): number {
	return Math.floor(ms / 1000);
}
