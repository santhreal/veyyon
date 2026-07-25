/**
 * The credential-staging decision.
 *
 * WHY THIS SUITE EXISTS. Every task container authenticates with the copy of
 * `agent.db` this decision produces. A wrong choice does not raise: the agent
 * launches, fails to authenticate, and the run comes back as N failed tasks that
 * read like a model or harness regression. A real 40-trial run was lost to
 * exactly that, so both historical failure modes are pinned here.
 *
 * Mode 1, a pre-move store winning over the live one: logins moved from
 * `profiles/<name>/shared-auth` to the machine-wide `~/.veyyon/shared-auth`, and
 * the abandoned files stay on disk indefinitely. The old candidate order tried
 * them FIRST, so on any machine that has both, the expired leftover was staged
 * and the live store went unread.
 *
 * Mode 2, a frozen snapshot: the staged copy was kept whenever the file merely
 * existed. OAuth access tokens rotate, so once the live store refreshed, every
 * container got a token the provider had already retired.
 */
import { describe, expect, it } from "bun:test";
import { type AuthSeedDecision, decideAuthSeed } from "./auth-seed";

const CANONICAL = "/home/u/.veyyon/shared-auth/agent.db";
const LEGACY_DEFAULT = "/home/u/.veyyon/profiles/default/shared-auth/agent.db";
const LEGACY_WORK = "/home/u/.veyyon/profiles/work/shared-auth/agent.db";
const SOURCES = [CANONICAL, LEGACY_DEFAULT, LEGACY_WORK] as const;
const STAGED = "/bench/assets/auth-agent.db";

/** A fake filesystem: path -> mtime. Absent key means the file does not exist. */
const fsWith = (files: Record<string, number>) => (p: string) => files[p];

const decide = (files: Record<string, number>): AuthSeedDecision => decideAuthSeed(SOURCES, STAGED, fsWith(files));

describe("which store gets staged", () => {
	/**
	 * Mode 1, the exact regression. A stale pre-move file next to a live store is
	 * the common state of any machine that has been through the move, and the live
	 * store must win. Reversing the candidate order turns this red.
	 */
	it("prefers the machine-wide store over a pre-move per-profile leftover", () => {
		const decision = decide({ [CANONICAL]: 2_000, [LEGACY_DEFAULT]: 1_000, [LEGACY_WORK]: 500 });
		expect(decision).toEqual({ kind: "seed", source: CANONICAL, legacy: false });
	});

	/**
	 * Recency must NOT override canonicity. A pre-move file can easily be the newer
	 * one (a stray write, a restored backup, a copied home directory) while still
	 * holding credentials for an account the operator no longer uses.
	 */
	it("still prefers the machine-wide store when a legacy file is newer", () => {
		const decision = decide({ [CANONICAL]: 1_000, [LEGACY_DEFAULT]: 9_999 });
		expect(decision).toEqual({ kind: "seed", source: CANONICAL, legacy: false });
	});

	/** An operator who has not logged in since the move has only the old file, and
	 * must still be able to run: fall back, but report it as legacy so the caller
	 * can warn instead of proceeding silently. */
	it("falls back to a pre-move store and marks it legacy", () => {
		expect(decide({ [LEGACY_DEFAULT]: 1_000 })).toEqual({
			kind: "seed",
			source: LEGACY_DEFAULT,
			legacy: true,
		});
	});

	/** Fallback follows declaration order among the legacy entries too, so the
	 * choice is deterministic rather than dependent on directory iteration. */
	it("takes the first available legacy store in declared order", () => {
		const decision = decide({ [LEGACY_WORK]: 5_000, [LEGACY_DEFAULT]: 1_000 });
		expect(decision).toEqual({ kind: "seed", source: LEGACY_DEFAULT, legacy: true });
	});

	/** With no store anywhere the run cannot authenticate at all. Reporting it here
	 * is what turns "40 mysterious task failures" into one message before any
	 * container starts. */
	it("reports missing when no candidate exists", () => {
		expect(decide({})).toEqual({ kind: "missing" });
		expect(decide({ [STAGED]: 1_000 })).toEqual({ kind: "missing" });
	});
});

describe("when the staged copy is rewritten", () => {
	/**
	 * Mode 2, the exact regression: the live store has been refreshed since the
	 * copy was staged, so the copy may carry a rotated-out access token. The old
	 * code returned early on existence alone and never reached this case.
	 */
	it("re-seeds when the live store is newer than the staged copy", () => {
		expect(decide({ [CANONICAL]: 2_000, [STAGED]: 1_000 })).toEqual({
			kind: "reseed",
			source: CANONICAL,
			legacy: false,
		});
	});

	/** The staged copy is current, so rewriting it would be pure churn. */
	it("keeps a staged copy that is newer than the live store", () => {
		expect(decide({ [CANONICAL]: 1_000, [STAGED]: 2_000 })).toEqual({
			kind: "current",
			source: CANONICAL,
			legacy: false,
		});
	});

	/** Boundary: equal mtimes mean the store has not been touched since staging.
	 * Copying on equality would rewrite the asset on every single run. */
	it("treats an equal mtime as current, not stale", () => {
		expect(decide({ [CANONICAL]: 1_000, [STAGED]: 1_000 })).toEqual({
			kind: "current",
			source: CANONICAL,
			legacy: false,
		});
	});

	/** Boundary: mtime 0 is a real timestamp, not "absent". Conflating the two
	 * would make an epoch-stamped store look missing and abort a runnable bench. */
	it("does not confuse an mtime of 0 with a missing file", () => {
		expect(decide({ [CANONICAL]: 0 })).toEqual({ kind: "seed", source: CANONICAL, legacy: false });
		expect(decide({ [CANONICAL]: 0, [STAGED]: 0 })).toEqual({
			kind: "current",
			source: CANONICAL,
			legacy: false,
		});
	});

	/** Staleness is judged against the store that was actually CHOSEN. Comparing
	 * against some other candidate would let an untouched legacy file suppress a
	 * needed re-seed. */
	it("judges staleness against the chosen store, not another candidate", () => {
		const decision = decide({ [CANONICAL]: 3_000, [LEGACY_DEFAULT]: 1_000, [STAGED]: 2_000 });
		expect(decision).toEqual({ kind: "reseed", source: CANONICAL, legacy: false });
	});

	/** A legacy fallback is subject to the same freshness rule; nothing about
	 * falling back should also freeze the copy. */
	it("re-seeds from a legacy store too when it is newer than the copy", () => {
		expect(decide({ [LEGACY_DEFAULT]: 2_000, [STAGED]: 1_000 })).toEqual({
			kind: "reseed",
			source: LEGACY_DEFAULT,
			legacy: true,
		});
	});
});
