import { describe, expect, it } from "bun:test";
import { collectPackageSources } from "./support/package-sources";

// Repo-wide source lock on ONE mistake class: a mechanism that stands a watchdog
// DOWN must itself be bounded.
//
// The case it is built from is issue #4593. A healthy Cursor stream was being
// killed by the idle watchdog while a local tool ran, so the fix taught the
// watchdog to slide its deadline forward for as long as `hasPendingLocalWork()`
// returned true. That removed the deadline rather than raising it: a local tool
// that never returns held the stand-down open for the whole turn, so the stream
// went silent with no error and no timeout, and only a user cancel ended it.
// Nothing caught it for three weeks, because every test drove tools that return.
//
// The structural signature of that defect is two things in one file:
//
//   A. a stand-down: code that reports "the silence is ours, keep waiting";
//   B. a re-arm: an assignment that pushes a deadline / last-progress clock
//      forward.
//
// A file that does both is a watchdog it can switch off. Such a file must also
// carry C: a cap on how long the stand-down may run, DECLARED (a `max…HoldMs` /
// `MAX_…_HOLD_MS` name) and COMPARED (that name on one side of a relational
// operator), because a cap that is declared and never compared is decoration.
// Today exactly one file in the monorepo matches A and B — the watchdog itself,
// `ai/src/utils/idle-iterator.ts` — and it carries C.
//
// The register below is the fail-by-default gate. It is not an allow-list of
// offenders: it is the list of files ALLOWED to hold a watchdog off at all, each
// with the behavioural test that proves its bound actually fires. A new
// stand-down site turns this lock red even when it is correctly capped, because
// the decision to add one belongs in review and in a test, not in a diff nobody
// looked at. A stale entry fails too, so the register cannot drift.
//
// WHAT THIS DELIBERATELY DOES NOT CATCH, stated plainly so nobody mistakes it
// for a proof of boundedness:
//
//   - It does not check that the cap is REACHABLE or correct. `maxHoldMs` set
//     absurdly high, or compared in dead code, reads as green here. The
//     behavioural proof of the bound is
//     `ai/test/a-wedged-local-tool-cannot-hold-the-watchdog-forever.test.ts`,
//     which HANGS (not asserts) when the bound is gone. This lock exists so a
//     future mechanism cannot ship without such a test, not to replace it.
//   - It is blind to a stand-down expressed in vocabulary nobody in this repo
//     uses (`vibesArePending()`, `tickleTheClock()`). Signature B is the harder
//     half to rename, since the deadline variable has to be read back by the
//     timer, but a determined rewrite escapes. A name-only lock would be worse:
//     it would fire on `busy_timeout` PRAGMAs and `#pendingWorkingMessage`, and
//     a lock that cries wolf gets deleted.
//   - It says nothing about ordinary unbounded awaits (a `fetch` with no
//     signal, a queue drain with no deadline). That class is far too broad for a
//     text scan; it belongs to review and to per-surface timeout tests.
//   - Comments are stripped before matching, so prose that NAMES these
//     mechanisms to explain them is never an offender. The bound must be in the
//     code, not in a sentence about the code.
const STAND_DOWN_SITES: Record<string, string> = {
	// Bounded by `maxLocalWorkHoldMs` / `DEFAULT_MAX_LOCAL_WORK_HOLD_MS`; proved
	// to terminate by ai/test/a-wedged-local-tool-cannot-hold-the-watchdog-forever
	// .test.ts and per provider by ai/test/provider-stream-budget-coverage.test.ts.
	"ai/src/utils/idle-iterator.ts": "maxLocalWorkHoldMs",
};

/** Source with `//` and block comments removed, so prose cannot trip a code lock. */
function codeOnly(text: string): string {
	return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

/**
 * A. The stand-down: an identifier saying "keep waiting, this silence is ours".
 * Anchored on the shapes this repo actually uses to hold a watchdog off, so
 * SQLite `busy_timeout`, `#pendingWorkingMessage` and friends stay out.
 */
const STAND_DOWN =
	/hasPending[A-Za-z0-9]*Work|holdsWatchdog|holdWatchdog|suppress(?:es)?(?:Idle|Timeout|Watchdog)|pause(?:Idle|Timeout|Watchdog)|standDown|extendDeadline|slideDeadline|deferDeadline|keepWatchdog/;

/** B. The re-arm: an assignment that pushes a deadline or progress clock forward. */
const DEADLINE_REARM = /\b(?:lastProgressAt|lastActivityAt|lastEventAt|[A-Za-z0-9_$]*DeadlineMs)\s*=[^=]/;

/**
 * The NAME of a cap: a word that means "upper bound" (max / limit / cap) beside
 * a word that means "stand-down" (hold / stand-down / extension), in either
 * order, ending in a millisecond unit. Both halves are required because a
 * hold-shaped name on its own is usually a clock rather than a bound:
 * `#partialHoldStartMs = 0` in `tui/src/stdin-buffer.ts` resets when the hold
 * ends, and reading it as a disabled cap was this lock's one false positive.
 * That file's real cap, `#partialHoldMaxMs` / `PARTIAL_HOLD_MAX_MS`, matches.
 */
const CAP_NAME =
	"(?:[A-Za-z0-9_$]*(?:[Mm]ax|MAX|[Ll]imit|LIMIT|[Cc]ap|CAP)[A-Za-z0-9_$]*(?:Hold|HOLD|Standdown|StandDown|STANDDOWN|Extension|EXTENSION)[A-Za-z0-9_$]*(?:Ms|MS)|[A-Za-z0-9_$]*(?:Hold|HOLD|Standdown|StandDown|STANDDOWN|Extension|EXTENSION)[A-Za-z0-9_$]*(?:[Mm]ax|MAX|[Ll]imit|LIMIT|[Cc]ap|CAP)[A-Za-z0-9_$]*(?:Ms|MS))";

/** C1. The cap, declared: a named upper bound on one stretch of stand-down. */
const CAP_DECLARED = new RegExp(`\\b${CAP_NAME}\\b`);

/** C2. The cap, compared: that bound on one side of a relational operator. */
const CAP_COMPARED = new RegExp(
	`(?:>=|<=|>|<)\\s*[A-Za-z_$][A-Za-z0-9_$.]*${CAP_NAME}\\b|\\b[A-Za-z0-9_$.]*${CAP_NAME}\\s*(?:>=|<=|>|<)`,
);

/**
 * A cap neutralized by its value. `0` is how `idle-iterator` spells "no bound",
 * and a non-finite cap is a bound that can never be reached, so both are the
 * #4593 defect wearing the fix's name.
 */
const CAP_DISABLED = new RegExp(`\\b${CAP_NAME}\\s*[:=]\\s*(?:0\\b|-1\\b|Infinity\\b|Number\\.POSITIVE_INFINITY\\b)`);

// The monorepo walk + skip-set is shared with every other source-ownership lock
// (see ./support/package-sources).
describe("bounded-wait source lock", () => {
	it("every file that stands a watchdog down is registered and carries a compared cap", async () => {
		const uncapped: string[] = [];
		const declaredButNeverCompared: string[] = [];
		const seen: string[] = [];
		for (const { rel, text } of await collectPackageSources({ dirs: ["src"] })) {
			const code = codeOnly(text);
			if (!STAND_DOWN.test(code) || !DEADLINE_REARM.test(code)) continue;
			seen.push(rel);
			if (!CAP_DECLARED.test(code)) uncapped.push(rel);
			else if (!CAP_COMPARED.test(code)) declaredButNeverCompared.push(rel);
		}
		// Fail by default in both directions: an unregistered stand-down site is
		// red, and a registered site that stopped matching is red too (the lock
		// would otherwise be silently guarding nothing).
		expect(seen.sort()).toEqual(Object.keys(STAND_DOWN_SITES).sort());
		expect(uncapped).toEqual([]);
		expect(declaredButNeverCompared).toEqual([]);
		// Each registered site must carry the cap its row names, so the row cannot
		// describe a bound the file no longer has.
		const missingNamedCap: string[] = [];
		for (const { rel, text } of await collectPackageSources({ dirs: ["src"] })) {
			const named = STAND_DOWN_SITES[rel];
			if (named === undefined) continue;
			if (!codeOnly(text).includes(named)) missingNamedCap.push(`${rel} (${named})`);
		}
		expect(missingNamedCap).toEqual([]);
	});

	it("no production source sets a stand-down cap to a value that can never be reached", async () => {
		const offenders: string[] = [];
		for (const { rel, text } of await collectPackageSources({ dirs: ["src"] })) {
			if (CAP_DISABLED.test(codeOnly(text))) offenders.push(rel);
		}
		expect(offenders).toEqual([]);
	});
});
