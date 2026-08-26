/**
 * WHY THIS SUITE DEFENDS THE FAIL-FAST CANARY AND SYSTEMATIC OUTAGE DEFENSE.
 *
 * When an environment, credentials, or network outage breaks all trials, continuing
 * to run wastes tokens and compute. The canary must abort if and only if a full wave
 * consists entirely of hard errors (zero output tokens and error set), while allowing
 * genuine scored failures and timeouts to proceed, reporting the deterministic most
 * common root cause.
 *
 * What this does not catch: transient intermittent network blips that recover before a full wave completes.
 */

import { describe, expect, test } from "bun:test";
import { mostCommonAgentReason, shouldTripCanary } from "../../../src/suites/deep-swe/src/aggregate/canary";
import { isHardError } from "../../../src/suites/deep-swe/src/aggregate/error-classification";

describe("isHardError — the fail-fast canary's definition of a systematic (not task) failure", () => {
	// WHY THIS SUITE EXISTS. A whole bench run (120 jobs × ~1min of container
	// setup) was once burned proving one typo: the default model id was
	// discovery-gated and unservable in the offline sandbox, so EVERY trial died
	// before the agent ran. The canary aborts on exactly that signature. The
	// predicate must fire only for "the agent never produced output" and must NOT
	// misclassify a scored fail or a partial/timed-out run that still emitted
	// tokens — those reflect the task or the arm and are legitimate data, so
	// tripping on them would abort valid runs.
	test("an error with no parsed session (null outputTokens) is a hard error", () => {
		// The unservable-model signature: pier exited non-zero, no session jsonl to
		// parse, so outputTokens stayed null. This is the ONE case that trips.
		expect(isHardError({ error: 'Model "google-antigravity/gemini-3.6-flash" not found', outputTokens: null })).toBe(
			true,
		);
	});

	test("a clean scored fail (error null) is NOT a hard error", () => {
		// reward 0 with real output is the task being hard, not the config being
		// broken. outputTokens is present precisely because the agent ran.
		expect(isHardError({ error: null, outputTokens: 4200 })).toBe(false);
	});

	test("a timed-out run that still produced tokens is NOT a hard error", () => {
		// A timeout sets error, but if the agent emitted tokens before the wall
		// clock cut it off, outputTokens is non-null: the agent DID run, so this is
		// task/arm behavior, not a systematic config failure. Aborting here would
		// throw away a slow-but-valid arm.
		expect(isHardError({ error: "trial timed out after 1800s; pier exit 1; ...", outputTokens: 1536 })).toBe(false);
	});

	test("error set AND zero output tokens is still a hard error (0 is not null)", () => {
		// A run that errored with an explicit zero token count is as dead as one
		// with null: the boundary is `outputTokens === null`, and a genuine 0-token
		// emission with an error is the same "agent never usefully ran" signature.
		expect(isHardError({ error: "boom; pier exit 1", outputTokens: null })).toBe(true);
		// Guard the other side of the boundary: a real (however small) emission with
		// an error is NOT hard, so a one-token partial is preserved as data.
		expect(isHardError({ error: "boom; pier exit 1", outputTokens: 1 })).toBe(false);
	});

	test("no error but null tokens (an unscored/parse-skip) is NOT a hard error", () => {
		// A trial with no error recorded is never systematic-config-dead by this
		// definition, even if usage parsing yielded null — the canary keys on a
		// LOUD error, not on missing usage, so it never trips on a quiet gap.
		expect(isHardError({ error: null, outputTokens: null })).toBe(false);
	});
});

describe("shouldTripCanary — abort only when a full wave is all hard errors", () => {
	// WHY THIS SUITE EXISTS. The abort decision used to be an inline boolean in
	// run.ts, verifiable only by running a whole ~110-min bench. Extracting it here
	// makes the exact trip contract testable: a FULL wave (>= canarySize completed)
	// where EVERY trial is a hard error, and never on a partial mix. Getting this
	// wrong either aborts a valid run (one flaky task among successes) or fails to
	// abort a doomed one (burning the whole queue on a config typo).
	const hard = { error: 'Model "x" not found', outputTokens: null };
	const good = { error: null, outputTokens: 800 };

	test("a full wave of hard errors trips", () => {
		expect(shouldTripCanary([hard, hard, hard, hard], 4)).toBe(true);
	});

	test("does NOT trip before the wave is complete", () => {
		// 3 hard errors but the wave is 4: too early to conclude the config is dead.
		expect(shouldTripCanary([hard, hard, hard], 4)).toBe(false);
	});

	test("one good run in the wave prevents a trip", () => {
		// The critical false-positive guard: a single successful trial proves the
		// config works, so the failures are task flakiness, not a systematic bug.
		expect(shouldTripCanary([hard, good, hard, hard], 4)).toBe(false);
	});

	test("an empty result set never trips", () => {
		// Nothing has run yet; there is nothing to conclude.
		expect(shouldTripCanary([], 4)).toBe(false);
	});

	test("with a canary window of 1, the very first hard error trips", () => {
		// On a single-item queue the wave is 1, so one hard error is a full wave.
		expect(shouldTripCanary([hard], 1)).toBe(true);
		expect(shouldTripCanary([good], 1)).toBe(false);
	});

	test("extra hard errors past the window still trip (stays tripped)", () => {
		// The window is a floor, not a ceiling: more than canarySize all-hard results
		// is still a trip, so a late check after several waves behaves the same.
		expect(shouldTripCanary([hard, hard, hard, hard, hard, hard], 4)).toBe(true);
	});
});

describe("mostCommonAgentReason — the single cause behind an all-errored canary trip", () => {
	// WHY THIS SUITE EXISTS. When the canary trips, the operator needs the ONE
	// reason killing every run, not a wall of repeated stack traces. This returns
	// the mode so the abort message reads `Model "..." not found` once. It must be
	// stable (ties keep first-seen), must ignore blank strings, and must never
	// throw on empty input — the caller only reaches it once at least one hard
	// error exists, but a defensive fallback beats a crash inside an abort path.
	test("returns the most frequent reason across the hard errors", () => {
		const reasons = [
			'Model "gemini-3.6-flash" not found',
			'Model "gemini-3.6-flash" not found',
			"some other transient blip",
			'Model "gemini-3.6-flash" not found',
		];
		expect(mostCommonAgentReason(reasons)).toBe('Model "gemini-3.6-flash" not found');
	});

	test("blank and whitespace-only reasons are ignored, not counted", () => {
		// Hard-error strings can be empty when no agent-side line was captured;
		// those must not win the mode and drown out the real cause.
		const reasons = ["", "   ", "real cause here", "real cause here", ""];
		expect(mostCommonAgentReason(reasons)).toBe("real cause here");
	});

	test("a tie keeps the first-seen reason, so the message is deterministic", () => {
		// Two causes at equal count must resolve the same way every run, or the
		// abort message would flicker between reruns of the same broken config.
		expect(mostCommonAgentReason(["cause A", "cause B"])).toBe("cause A");
	});

	test("all-blank or empty input returns a guidance string, never throws", () => {
		// The abort path must not itself crash. With nothing usable, point the
		// operator at where the real reason lives instead of throwing.
		expect(mostCommonAgentReason([])).toContain("agent/veyyon.txt");
		expect(mostCommonAgentReason(["", "  "])).toContain("agent/veyyon.txt");
	});

	test("reasons are trimmed so trailing whitespace does not split the mode", () => {
		// The same cause captured with and without a trailing newline must collapse
		// to one bucket, or the mode could fragment and pick a rarer cause.
		expect(mostCommonAgentReason(["Model X not found\n", "Model X not found", "  Model X not found  "])).toBe(
			"Model X not found",
		);
	});
});
