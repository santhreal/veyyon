/**
 * The recovery countdown and the summary after it name the recovery that ran.
 *
 * WHY THIS EXISTS. A retry and a continuation share one event, deliberately: a
 * continuation of an unreplayable tool batch waits the same backoff, holds the
 * same `isRetrying` gate so the same key cancels it, and resolves through the
 * same end event, so every consumer already wired for a retry gets it for free.
 * What they must not share is the word. The continuation raises an operator
 * notice saying the batch is being continued with the calls that never ran, and
 * a countdown beside it reading `Retrying (1/2)` contradicts it on the same
 * screen; the summary left behind afterwards would claim a retry that never
 * happened, on a turn whose whole point is that the batch could not be resent.
 *
 * WHAT IT DOES NOT CATCH. This pins the wording, not the wiring: that the
 * session actually stamps `mode: "continue"` on the continuation's events, and
 * `retry` on the ladder's, is driven end to end in
 * `packages/simulations/src/turn-sim/unreplayable-batch-continue.test.ts`.
 *
 * The two maps below are `Record<RetryRecoveryMode, string>`, so a third
 * recovery kind fails the type check until someone decides what it is called,
 * rather than silently inheriting the retry wording.
 */
import { describe, expect, it } from "bun:test";
import { formatRetryLine, formatRetrySummary, type RetryRecoveryMode } from "@veyyon/coding-agent/modes/retry-display";

const VERBS: Record<RetryRecoveryMode, string> = { continue: "Continuing", retry: "Retrying" };
const NOUNS: Record<RetryRecoveryMode, string> = { continue: "continuation", retry: "retry" };

describe("formatRetryLine", () => {
	for (const [mode, verb] of Object.entries(VERBS) as Array<[RetryRecoveryMode, string]>) {
		it(`names a ${mode} wait with "${verb}"`, () => {
			const line = formatRetryLine({ attempt: 1, maxAttempts: 3, delayMs: 2_000, mode });
			expect(line).toBe(`${verb} (1/3) in 2s`);
		});
	}

	it("keeps the retry wording when no kind is given, which is what the ladder emits", () => {
		expect(formatRetryLine({ attempt: 2, maxAttempts: 3, delayMs: 1_000 })).toBe("Retrying (2/3) in 1s");
	});

	it("changes only the verb, so the reason and the policy source still ride along", () => {
		const shared = { attempt: 1, maxAttempts: 2, delayMs: 0, policySource: "cursor provider default" };
		const retrying = formatRetryLine({ ...shared, mode: "retry" });
		const continuing = formatRetryLine({ ...shared, mode: "continue" });
		expect(retrying).toBe("Retrying (1/2) in 0s · cursor provider default");
		expect(continuing).toBe("Continuing (1/2) in 0s · cursor provider default");
	});
});

describe("formatRetrySummary", () => {
	for (const [mode, noun] of Object.entries(NOUNS) as Array<[RetryRecoveryMode, string]>) {
		it(`counts one ${mode} as "1 ${noun}"`, () => {
			expect(formatRetrySummary({ attempts: 1, totalDelayMs: 0, mode })).toBe(`Recovered after 1 ${noun}`);
		});

		it(`pluralizes several as "${noun}s"`, () => {
			expect(formatRetrySummary({ attempts: 2, totalDelayMs: 400, mode })).toBe(
				`Recovered after 2 ${noun}s (400ms waiting)`,
			);
		});
	}

	it("keeps the retry wording when no kind is given", () => {
		expect(formatRetrySummary({ attempts: 1, totalDelayMs: 0 })).toBe("Recovered after 1 retry");
	});

	it("stays silent when nothing was recovered, whichever kind it was", () => {
		expect(formatRetrySummary({ attempts: 0, totalDelayMs: 5_000, mode: "continue" })).toBeUndefined();
		expect(formatRetrySummary({ attempts: 0, totalDelayMs: 5_000, mode: "retry" })).toBeUndefined();
	});
});
