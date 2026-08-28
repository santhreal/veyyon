/**
 * WHY THIS SUITE DEFENDS ERROR CLASSIFICATION AND EXCLUSION BOUNDARIES.
 *
 * Errored trials (such as infrastructure failures, content-filter stops, or
 * mid-run cancellation) must be excluded from pass rates and mean metrics rather
 * than counted as graded agent task failures, but must be grouped and reported
 * distinctly to make refusal asymmetries visible. Unscored trials are not task
 * failures, and quota exhaustion stops must banner truncated runs to prevent
 * survivor bias.
 *
 * What this does not catch: silent agent non-zero exit codes that leave no logs.
 */

import { describe, expect, test } from "bun:test";
import { emptyArmResult } from "../../../suites/deep-swe/aggregate/empty-result";
import {
	classifyError,
	finishedWithoutPatch,
	NO_REWARD_ERROR,
	noRewardError,
	providerFinishReason,
	providerQuotaStop,
	quotaStopMarker,
} from "../../../suites/deep-swe/aggregate/error-classification";
import { renderQuotaTruncationBanner, renderReport } from "../../../suites/deep-swe/aggregate/report-render";
import { summarizeCell } from "../../../suites/deep-swe/aggregate/stats";
import type { ArmResult } from "../../../suites/deep-swe/aggregate/types";
import {
	FINISHED_WITHOUT_PATCH_JOB_LOG,
	KILLED_MID_RUN_JOB_LOG,
	QUOTA_429_AGENT_LOG,
	res,
} from "./aggregate-test-helpers";

describe("finishedWithoutPatch — an agent that produced nothing has failed, not errored", () => {
	/**
	 * THE CASE THE BENCH COULD NOT EXPRESS. The agent ran to completion, wrote no
	 * patch, and pier could only report that as a teardown crash. Its honest score
	 * is reward 0 inside the denominator.
	 */
	test("fires when the patch is missing and nothing cancelled the trial", () => {
		expect(finishedWithoutPatch(FINISHED_WITHOUT_PATCH_JOB_LOG)).toBe(true);
	});

	/**
	 * THE REAL INSTANCE IN HAND, and the reason detection is two-part. Matching the
	 * cp failure alone would score this trial 0, but the agent was killed by SIGTERM
	 * mid-turn (its own log tail is still `Working...`). Charging an arm for that
	 * would be the mirror of the bug being fixed, so this is the single most
	 * important assertion in the suite.
	 */
	test("does not fire on the real killed-mid-run log that motivated it", () => {
		expect(finishedWithoutPatch(KILLED_MID_RUN_JOB_LOG)).toBe(false);
	});

	/**
	 * Each cancellation marker vetoes on its own. Pier can stop a trial through
	 * three different paths and only one of them was present in the log above, so a
	 * predicate that happened to key on `KeyboardInterrupt` alone would still
	 * mis-score the other two.
	 */
	test("treats every cancellation spelling as a veto, one at a time", () => {
		for (const marker of ["KeyboardInterrupt", "CancelledError", "AgentTimeoutError"]) {
			const log = `${marker}\n${FINISHED_WITHOUT_PATCH_JOB_LOG}`;
			expect(finishedWithoutPatch(log)).toBe(false);
		}
	});

	/**
	 * A cancellation counts wherever it appears, including BELOW the download
	 * failure. Python prints chained exceptions oldest-first, but a teardown that
	 * is itself interrupted inverts that, and ordering is not evidence of cause.
	 */
	test("vetoes on a cancellation that appears after the download failure", () => {
		expect(finishedWithoutPatch(`${FINISHED_WITHOUT_PATCH_JOB_LOG}\nasyncio.exceptions.CancelledError`)).toBe(false);
	});

	/**
	 * THE NECESSARY TWIN. Every other kind of crash keeps today's exclusion. A
	 * predicate that answered true for infrastructure failures would convert the
	 * bench's whole error bucket into fake task failures and understate every arm.
	 */
	test("does not fire on an unrelated crash", () => {
		expect(finishedWithoutPatch("RuntimeError: Docker compose command failed. Return code: 137")).toBe(false);
		expect(finishedWithoutPatch('Model "gpt-5.5" not found')).toBe(false);
		expect(finishedWithoutPatch("container build failed")).toBe(false);
	});

	/**
	 * A DIFFERENT missing artifact is a different fact. Only the graded patch means
	 * "the agent produced nothing"; a missing log or trace is a harness problem and
	 * must keep its exclusion, so the phrase is matched whole rather than by the
	 * words "Could not find the file".
	 */
	test("does not fire when some other artifact is the one missing", () => {
		expect(
			finishedWithoutPatch("Error response from daemon: Could not find the file /logs/agent.log in container abc"),
		).toBe(false);
	});

	/**
	 * A passing job's log carries neither half of the discriminator, and a trial
	 * with no log at all must classify rather than throw. Absence is normal input
	 * here: a trial killed during setup writes no log.
	 */
	test("returns false for a clean log, an empty log, and no log at all", () => {
		expect(finishedWithoutPatch("trial completed, verifier scored 1.0")).toBe(false);
		expect(finishedWithoutPatch("")).toBe(false);
		expect(finishedWithoutPatch(null)).toBe(false);
		expect(finishedWithoutPatch(undefined)).toBe(false);
	});

	/**
	 * The predicate is fed the JOB log, never the trial's own `exception.txt`. On
	 * the real instance that narrower file records the cancellation and stops there,
	 * with no trace of the download that failed afterwards. A caller that passed it
	 * would see no patch signature at all and the predicate would silently never
	 * fire, which is the quiet half of the same bias. This pins the fact rather than
	 * the file name, so a caller reading the wrong file has a test explaining why.
	 */
	test("cannot classify from an exception file that omits the teardown failure", () => {
		const exceptionTxtOnly = ['  File "pier/cli/jobs.py", line 149, in _handle_sigterm', "KeyboardInterrupt"].join(
			"\n",
		);
		expect(exceptionTxtOnly).not.toContain("/logs/artifacts/model.patch");
		expect(finishedWithoutPatch(exceptionTxtOnly)).toBe(false);
	});
});

describe("providerQuotaStop — the provider declaring a global refusal, with a recovery time", () => {
	/**
	 * THE REAL PAYLOAD. Both facts worth having are buried in `details[].metadata`
	 * rather than beside the message, so this pins the extraction against the actual
	 * bytes instead of a convenient reconstruction of them.
	 */
	test("extracts the reset timestamp and model from the real 429 payload", () => {
		expect(providerQuotaStop(QUOTA_429_AGENT_LOG)).toEqual({
			resetAt: "2026-07-25T23:50:11Z",
			model: "gemini-3-flash-agent",
		});
	});

	/**
	 * A provider that refuses without naming a reset time still has to trip the
	 * abort. Returning null here would trade a known-fatal condition for a silent
	 * one, which is the opposite of the point: the run must stop either way, and the
	 * operator merely loses the "come back at" hint.
	 */
	test("still fires when the provider names no reset time", () => {
		expect(providerQuotaStop('{"code":429,"status":"RESOURCE_EXHAUSTED"}')).toEqual({
			resetAt: null,
			model: null,
		});
	});

	/**
	 * THE ROUND TRIP. A live trial and a re-read `results.json` must classify
	 * identically, or `--reaggregate` would quietly disagree with the run that
	 * produced the data. The runner cannot store the raw payload (the error field
	 * truncates at 300 characters), so it stores the compact marker, and that marker
	 * has to parse back to the same two facts.
	 */
	test("reads its own compact marker back out of a stored error string", () => {
		const stop = providerQuotaStop(QUOTA_429_AGENT_LOG);
		expect(stop).not.toBeNull();
		const marker = quotaStopMarker(stop as NonNullable<typeof stop>);
		expect(marker).toBe("QUOTA_EXHAUSTED resets_at=2026-07-25T23:50:11Z quota_model=gemini-3-flash-agent");
		const stored = `{"exception_type":"RuntimeError","exception_message":"agent exited 1"} ${marker}`;
		expect(providerQuotaStop(stored)).toEqual(stop);
	});

	/** A marker for a quota stop that named nothing degrades to the bare token, and still parses. */
	test("round-trips a marker with no reset time or model", () => {
		expect(quotaStopMarker({ resetAt: null, model: null })).toBe("QUOTA_EXHAUSTED");
		expect(providerQuotaStop("QUOTA_EXHAUSTED")).toEqual({ resetAt: null, model: null });
	});

	/**
	 * THE NECESSARY TWIN, and the expensive direction to get wrong. This predicate
	 * aborts an entire run on ONE hit, with no statistical safety margin behind it,
	 * so a false positive throws away a whole measurement. Ordinary failures,
	 * including other 429-adjacent rate limiting that a retry would clear, must not
	 * match.
	 */
	test("does not fire on ordinary failures or on plain rate limiting", () => {
		expect(providerQuotaStop("HTTP 429: too many requests, retrying in 5s")).toBeNull();
		expect(providerQuotaStop('{"exception_type":"CancelledError"}')).toBeNull();
		expect(providerQuotaStop('Model "gpt-5.5" not found')).toBeNull();
		expect(providerQuotaStop("finish reason: PROHIBITED_CONTENT")).toBeNull();
		expect(providerQuotaStop("trial timed out after 900s")).toBeNull();
	});

	/** A trial with no captured output must classify rather than throw. */
	test("returns null for empty and absent input", () => {
		expect(providerQuotaStop("")).toBeNull();
		expect(providerQuotaStop(null)).toBeNull();
		expect(providerQuotaStop(undefined)).toBeNull();
	});

	/**
	 * The two spellings the provider uses are accepted independently. Google sends
	 * `RESOURCE_EXHAUSTED` as the status and `QUOTA_EXHAUSTED` as the reason, and a
	 * predicate keyed on only one of them would miss any payload carrying the other.
	 */
	test("accepts either exhaustion spelling on its own", () => {
		expect(providerQuotaStop("status: RESOURCE_EXHAUSTED")).not.toBeNull();
		expect(providerQuotaStop("reason: QUOTA_EXHAUSTED")).not.toBeNull();
	});
});

describe("renderQuotaTruncationBanner — an incomplete run must not read as a result", () => {
	const quotaError = "QUOTA_EXHAUSTED resets_at=2026-07-25T23:50:11Z quota_model=gemini-3-flash-agent";
	const stopped = (arm: string, task: string): ArmResult => ({
		...emptyArmResult(arm, task, 0),
		error: quotaError,
	});
	const scored = (arm: string, task: string): ArmResult => ({
		...emptyArmResult(arm, task, 0),
		reward: 1,
		outputTokens: 50_000,
	});

	/**
	 * A clean run must print NO banner. A caveat that appears on every report is
	 * one readers learn to ignore, which would disarm it for the run that needs it.
	 */
	test("says nothing when no sample hit quota", () => {
		expect(renderQuotaTruncationBanner([scored("baseline", "a"), scored("sig-last1", "a")])).toBeNull();
	});

	/**
	 * THE SHAPE THAT MOTIVATED THIS. One arm keeps its samples, the other loses all
	 * of them. Naming the affected arm is the point: "some trials failed" leaves a
	 * reader to assume the loss was symmetric, and here it was total for one side.
	 */
	test("names the arms that lost samples and the reset time", () => {
		const banner = renderQuotaTruncationBanner([
			scored("baseline", "a"),
			scored("baseline", "b"),
			stopped("sig-last1", "a"),
			stopped("sig-last1", "b"),
		]);
		expect(banner).toContain("CUT SHORT by provider quota");
		expect(banner).toContain("2 trial(s)");
		expect(banner).toContain("arm(s): sig-last1");
		expect(banner).not.toContain("baseline");
		expect(banner).toContain("2026-07-25T23:50:11Z");
	});

	/** Both arms losing samples is still a truncated run, and both are named. */
	test("names every affected arm, in a stable order", () => {
		const banner = renderQuotaTruncationBanner([stopped("sig-last1", "a"), stopped("baseline", "a")]);
		expect(banner).toContain("arm(s): baseline, sig-last1");
	});

	/** A quota stop that named no reset time still banners, just without the hint. */
	test("banners without a reset time when the provider named none", () => {
		const banner = renderQuotaTruncationBanner([{ ...emptyArmResult("baseline", "a", 0), error: "QUOTA_EXHAUSTED" }]);
		expect(banner).toContain("CUT SHORT by provider quota");
		expect(banner).not.toContain("Quota reset was");
	});

	/**
	 * THE NECESSARY TWIN. Ordinary errors are a normal part of every run and must
	 * not raise this banner, or it would fire on almost every report and mean
	 * nothing.
	 */
	test("does not banner on ordinary errors", () => {
		const banner = renderQuotaTruncationBanner([
			{ ...emptyArmResult("baseline", "a", 0), error: "trial timed out after 900s" },
			{ ...emptyArmResult("baseline", "b", 0), error: '{"exception_type":"CancelledError"}' },
		]);
		expect(banner).toBeNull();
	});

	/**
	 * The banner has to reach the rendered report, above the provenance line. A
	 * predicate nobody calls is the same as no predicate, and this is the assertion
	 * that would catch the wiring being dropped.
	 */
	test("appears at the top of the rendered report, before the provenance banner", () => {
		const report = renderReport(
			[scored("baseline", "a"), stopped("sig-last1", "a")],
			"google-antigravity/gemini-3.5-flash",
			"2026-07-25T21:00:00Z",
			1,
			{ marked: true, biased: false, note: null },
		);
		const quotaAt = report.indexOf("CUT SHORT by provider quota");
		const provenanceAt = report.indexOf("Task set: headline");
		expect(quotaAt).toBeGreaterThan(-1);
		expect(provenanceAt).toBeGreaterThan(-1);
		expect(quotaAt).toBeLessThan(provenanceAt);
	});

	/** A clean report stays clean: no banner text leaks into a run that never hit quota. */
	test("leaves a clean report free of quota text", () => {
		const report = renderReport(
			[scored("baseline", "a"), scored("sig-last1", "a")],
			"google-antigravity/gemini-3.5-flash",
			"2026-07-25T21:00:00Z",
		);
		expect(report).not.toContain("CUT SHORT by provider quota");
	});
});

describe("summarizeCell — errors are excluded, not counted as failures", () => {
	test("an errored sample drops out of n and the rate, but is counted in errors", () => {
		// The bug: treating a container that never produced a trial as a task failure.
		// Two OK passes plus one error must read as rate 1.0 over n=2, with 1 error —
		// not rate 0.67 over 3. A dead container is missing data, not a wrong answer.
		const s = summarizeCell([res({ reward: 1 }), res({ reward: 1 }), res({ error: "boom" })]);
		expect(s.total).toBe(3);
		expect(s.errors).toBe(1);
		expect(s.n).toBe(2);
		expect(s.passRate).toBe(1);
	});

	test("an all-errored cell has n 0 and null rate/se, never a fake 0", () => {
		const s = summarizeCell([res({ error: "x" }), res({ error: "y" })]);
		expect(s.n).toBe(0);
		expect(s.passRate).toBeNull();
		expect(s.stdErr).toBeNull();
		expect(s.errors).toBe(2);
	});

	test("token and cost means are over OK samples only, but sums include what exists", () => {
		const s = summarizeCell([
			res({ reward: 1, outputTokens: 100, costUsd: 0.2 }),
			res({ reward: 0, outputTokens: 200, costUsd: 0.4 }),
			res({ error: "x", outputTokens: null, costUsd: null }),
		]);
		expect(s.meanOutputTokens).toBe(150);
		expect(s.meanCostUsd).toBeCloseTo(0.3, 12);
		expect(s.sumOutputTokens).toBe(300);
		expect(s.sumCostUsd).toBeCloseTo(0.6, 12);
	});
});

describe("providerFinishReason — a content-filter stop is not a generic crash", () => {
	// A provider that aborts generation (PROHIBITED_CONTENT/SAFETY/RECITATION) makes
	// the agent exit non-zero, which the bench excludes as an error. Recovering the
	// finish reason is what lets the report tell a refusal apart from a real crash —
	// and a refusal that tracks the treatment is a confound, not a null result.

	test("extracts PROHIBITED_CONTENT from the real gemini message", () => {
		// The exact string the smoke run produced.
		expect(providerFinishReason("Working...\nGeneration failed with finish reason: PROHIBITED_CONTENT")).toBe(
			"PROHIBITED_CONTENT",
		);
	});

	test("matches the underscore spelling finish_reason too", () => {
		expect(providerFinishReason("stopped, finish_reason SAFETY, aborting")).toBe("SAFETY");
	});

	test("returns null when there is no finish-reason marker", () => {
		expect(providerFinishReason("some ordinary stdout with no policy stop")).toBeNull();
	});

	test("does not match lowercase prose that merely contains the words", () => {
		// Guards against a false positive on narration like "the finish reason was fine".
		expect(providerFinishReason("the finish reason was fine")).toBeNull();
	});
});

describe("classifyError — group excluded samples by a stable, comparable label", () => {
	// The report groups errors by this label to expose an arm asymmetry. It must pull
	// a stable label out of pier's exception_info JSON, refine it with a provider
	// finish reason when present, and never throw on a runner-side string.

	test("a bare exception_info JSON classifies by its exception type", () => {
		expect(classifyError('{"exception_type":"NonZeroAgentExitCodeError","exception_message":"boom"}')).toBe(
			"NonZeroAgentExitCodeError",
		);
	});

	test("a content-filter refusal is named distinctly from a plain crash", () => {
		// The run.ts path appends the finish reason it recovered from the agent log.
		const err =
			'{"exception_type":"NonZeroAgentExitCodeError","exception_message":"exit 1"} finish_reason: PROHIBITED_CONTENT';
		expect(classifyError(err)).toBe("NonZeroAgentExitCodeError (PROHIBITED_CONTENT)");
	});

	test("a runner-side timeout string classifies as timeout, never throws", () => {
		expect(classifyError("trial timed out after 1800s; pier exit 1; ...")).toBe("timeout");
	});

	test("an unrecognized non-JSON string falls back to other", () => {
		expect(classifyError("mystery failure")).toBe("other");
	});

	test("a verifier-no-reward is labelled distinctly, not folded into other", () => {
		// A scorer outage must be its own comparable failure mode so its per-arm asymmetry
		// is visible; bucketing it as "other" would hide a verifier that trips on one arm.
		expect(classifyError(NO_REWARD_ERROR)).toBe("verifier-no-reward");
	});
});

describe("noRewardError — an unscored trial is not a task failure", () => {
	// The silent-fallback this locks out (Law 10): a trial the agent completed but the
	// verifier never scored parses to reward=null. Counted as-is it becomes a fail
	// (reward !== 1), understating the pass rate and turning a scorer outage that tracks
	// one arm into a phantom correctness loss. noRewardError marks exactly those trials
	// so the runner can reclassify them as errors (excluded + surfaced), never as fails.

	test("null and undefined rewards are unscored", () => {
		expect(noRewardError(null)).toBe(true);
	});

	test("a reward of 0 is a REAL scored failure, not unscored", () => {
		// The critical distinction: 0 is a number the verifier assigned (all tests failed),
		// so it must stay a counted failure. Only a missing score is an error.
		expect(noRewardError(0)).toBe(false);
	});

	test("finite fractional and full rewards are scored", () => {
		expect(noRewardError(0.5)).toBe(false);
		expect(noRewardError(1)).toBe(false);
	});

	test("a non-finite reward (NaN/Infinity) is unscored", () => {
		// JSON has no NaN, but a defensive guard: any non-finite value means no real score.
		expect(noRewardError(Number.NaN)).toBe(true);
		expect(noRewardError(Number.POSITIVE_INFINITY)).toBe(true);
	});
});

describe("renderReport — the Errors (per arm) section exposes a refusal asymmetry", () => {
	const STAMP = "2026-07-24T00:00:00.000Z";

	test("shows every arm (including zero-error arms) so the asymmetry is visible", () => {
		// The smoke shape: decode passed, full was refused by the content filter. The
		// section must show full's 1 refusal AND decode's 0, side by side, because a
		// delta measured against an arm that lost a sample can be a selection effect.
		const results: ArmResult[] = [
			res({ arm: "decode", task: "t1", reward: 1, outputTokens: 80000 }),
			res({
				arm: "full",
				task: "t1",
				reward: null,
				error: '{"exception_type":"NonZeroAgentExitCodeError","exception_message":"exit 1"} finish_reason: PROHIBITED_CONTENT',
			}),
		];
		const report = renderReport(results, "google-antigravity/gemini-3.6-flash", STAMP, 1);
		expect(report).toContain("## Errors (per arm)");
		expect(report).toContain("NonZeroAgentExitCodeError (PROHIBITED_CONTENT)");
		// full errored once under that reason; decode errored zero times — both rows
		// present so the reader sees the imbalance, not just full's count.
		expect(report).toContain("| full | 1 | 1 |");
		expect(report).toContain("| decode | 0 | 0 |");
	});

	test("omits the Errors section entirely when no sample errored", () => {
		const results: ArmResult[] = [
			res({ arm: "decode", task: "t1", reward: 1 }),
			res({ arm: "full", task: "t1", reward: 0 }),
		];
		const report = renderReport(results, "m", STAMP, 1);
		expect(report).not.toContain("## Errors (per arm)");
	});

	test("an unscored trial (verifier-no-reward) is EXCLUDED from the pass rate, not counted as a fail", () => {
		// The Law-10 fix end to end: `full` has two OK passes and one trial the verifier
		// never scored (stamped NO_REWARD_ERROR by the runner). If the unscored trial were
		// folded in as a fail, full's pass rate would read 2/3; excluded, it is the honest
		// 2/2 with the unscored trial surfaced in Errors under its own label.
		const results: ArmResult[] = [
			res({ arm: "full", task: "t1", reward: 1 }),
			res({ arm: "full", task: "t2", reward: 1 }),
			res({ arm: "full", task: "t3", reward: null, error: NO_REWARD_ERROR }),
		];
		const report = renderReport(results, "m", STAMP, 1);
		// Pass rate is 2/2 (the unscored trial is not a denominator fail)...
		expect(report).toContain("(2/2)");
		// ...and the trial is surfaced as its own error class, not hidden.
		expect(report).toContain("## Errors (per arm)");
		expect(report).toContain("verifier-no-reward");
		expect(report).toContain("| full | 1 | 1 |");
	});
});
