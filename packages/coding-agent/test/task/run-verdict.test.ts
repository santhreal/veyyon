/**
 * Contracts: the ONE place a subagent run's outcome is decided.
 *
 * WHY THIS SUITE EXISTS. The verdict used to be computed in three places from five sites: four
 * inside `driveSessionToYield`, a fifth inside `runSubprocess`, and then re-derived in
 * `finalizeRunResult`, which silently overrode the others. The copies did not agree (one was written
 * inverted, one demoted any aborted run without consulting the yield), and nothing could see the
 * disagreement because whichever ran last won. `resolveRunVerdict` is now the only thing that turns
 * facts into an outcome, so the rules are testable directly instead of through a spawned run.
 *
 * WHAT A RULE MEANS HERE. Every test names the operator question it answers, because the whole point
 * of the rules is what a person sees after a cancellation: whether their subagent's finished work
 * survived, whether a timeout is distinguishable from a user cancel, and whether a failure that was
 * nobody's cancellation gets called one.
 *
 * The end-to-end halves live in `executor-yield-versus-caller-abort.test.ts` (a real run through
 * `runSubprocess`) and `executor-wall-clock.test.ts`. This file pins the rules themselves.
 */
import { describe, expect, it } from "bun:test";
import { type RunVerdictInputs, resolveRunVerdict } from "@veyyon/coding-agent/task/executor";

const ABORT_REASON = "runtime limit exceeded (task.maxRuntimeMs=50)";
const SIGNAL_REASON = "Cancelled by caller";

/** A clean run: nothing was cut short, a yield landed, the payload validated. */
function baseInputs(overrides: Partial<RunVerdictInputs> = {}): RunVerdictInputs {
	return {
		exitCodeAfterFinalize: 0,
		hasYield: true,
		abortedViaYield: false,
		runtimeLimitExceeded: false,
		turnCutShort: false,
		turnAborted: false,
		callerAborted: false,
		resolveAbortReason: () => ABORT_REASON,
		resolveSignalAbortReason: () => SIGNAL_REASON,
		...overrides,
	};
}

describe("a run that finished on its own", () => {
	it("passes, and is not reported as aborted", () => {
		expect(resolveRunVerdict(baseInputs())).toEqual({ exitCode: 0, aborted: false });
	});

	/**
	 * The finalizer's exit code is carried through untouched when no abort rule fires. A schema
	 * violation is a failure of the RESULT, not a cancellation, and must not be relabelled as one.
	 */
	it("keeps a payload failure as a failure rather than promoting it to an abort", () => {
		const verdict = resolveRunVerdict(baseInputs({ exitCodeAfterFinalize: 1 }));

		expect(verdict).toEqual({ exitCode: 1, aborted: false });
	});
});

describe("a caller abort around a delivered yield", () => {
	/**
	 * THE RULE THIS SUITE EXISTS FOR. The subagent called yield, so its work exists and belongs to the
	 * caller. An abort arriving around that point (the user pressed ^C, the parent turn ended, a batch
	 * sibling failed) must not turn the finished run into a failure.
	 */
	it("keeps the run successful when the caller's signal fired", () => {
		const verdict = resolveRunVerdict(baseInputs({ callerAborted: true, turnCutShort: true }));

		expect(verdict).toEqual({ exitCode: 0, aborted: false });
	});

	/** Same rule through the other fact: the turn itself was classified as a cancellation. */
	it("keeps the run successful when the turn was cancelled", () => {
		const verdict = resolveRunVerdict(
			baseInputs({ turnCutShort: true, turnAborted: true, turnAbortReason: "Request was aborted" }),
		);

		expect(verdict).toEqual({ exitCode: 0, aborted: false });
	});
});

describe("a cut-short run that delivered nothing", () => {
	/**
	 * The mirror case, and the reason a yield cannot simply be assumed. Nothing was delivered, so the
	 * run fails rather than reporting success with no result.
	 */
	it("fails and reports the turn's own reason", () => {
		const verdict = resolveRunVerdict(
			baseInputs({
				hasYield: false,
				turnCutShort: true,
				turnAborted: true,
				turnAbortReason: "Request was aborted",
			}),
		);

		expect(verdict).toEqual({ exitCode: 1, aborted: true, abortReason: "Request was aborted" });
	});

	/**
	 * A caller signal with no turn-level reason falls back to the SIGNAL resolver, not the generic one.
	 * The two produce different text, and telling a user "cancelled by caller" when the wall clock
	 * fired is exactly the confusion the reasons exist to prevent.
	 */
	it("uses the signal's reason when the turn had none", () => {
		const verdict = resolveRunVerdict(baseInputs({ hasYield: false, turnCutShort: true, callerAborted: true }));

		expect(verdict).toEqual({ exitCode: 1, aborted: true, abortReason: SIGNAL_REASON });
	});

	/**
	 * THE CASE THAT KEEPS A FAILURE FROM BEING CALLED A CANCELLATION. An internal teardown (a tool
	 * event handler failing, which aborts the session to stop the run) cuts the turn short without
	 * being anyone's cancellation: `turnCutShort` is true and `turnAborted` is false. Reporting it as
	 * aborted would tell the operator their run was cancelled when it actually broke.
	 */
	it("fails without claiming the run was aborted when the cut was an internal teardown", () => {
		const verdict = resolveRunVerdict(baseInputs({ hasYield: false, turnCutShort: true }));

		expect(verdict).toEqual({ exitCode: 1, aborted: false });
	});

	/** A turn that ended cleanly without yielding is the finalizer's call, so the verdict adds nothing. */
	it("leaves a clean turn's missing-yield exit code alone", () => {
		const verdict = resolveRunVerdict(baseInputs({ hasYield: false, exitCodeAfterFinalize: 1 }));

		expect(verdict).toEqual({ exitCode: 1, aborted: false });
	});
});

describe("a wall-clock timeout", () => {
	/**
	 * The override that outranks the yield rule. A hung subagent can emit a `yield` during teardown,
	 * after the timer already aborted it; without this, `hasYield` would zero the exit code and the
	 * run would report success, masking a run that blew its runtime.
	 */
	it("fails a timed-out run even though a late yield landed", () => {
		const verdict = resolveRunVerdict(
			baseInputs({ runtimeLimitExceeded: true, turnCutShort: true, turnAborted: true }),
		);

		expect(verdict).toEqual({ exitCode: 1, aborted: true, abortReason: ABORT_REASON });
	});

	/**
	 * The timeout's reason wins over the turn's, because the turn's is the vaguer one: a stalled turn
	 * reports "Request was aborted" while the timer knows the limit it exceeded and its setting name.
	 */
	it("reports the timeout's reason rather than the turn's", () => {
		const verdict = resolveRunVerdict(
			baseInputs({
				runtimeLimitExceeded: true,
				turnCutShort: true,
				turnAborted: true,
				turnAbortReason: "Request was aborted",
				callerAborted: true,
			}),
		);

		expect(verdict.abortReason).toBe(ABORT_REASON);
	});

	/** A timeout is an abort with or without any turn-level fact, because the timer is the canceller. */
	it("aborts on the timer alone, with no turn facts at all", () => {
		const verdict = resolveRunVerdict(baseInputs({ runtimeLimitExceeded: true }));

		expect(verdict).toEqual({ exitCode: 1, aborted: true, abortReason: ABORT_REASON });
	});
});

describe("a yield that reported its own abort", () => {
	/**
	 * The child answered, and the answer is "I stopped": permission denied, a blocked path, a task it
	 * refuses. That is a delivered result, so the exit code stays 0, and it is still an abort, so the
	 * status says so and carries the child's reason rather than the harness's.
	 */
	it("keeps exit code 0 and reports the child's own reason", () => {
		const verdict = resolveRunVerdict(
			baseInputs({ abortedViaYield: true, yieldAbortReason: "blocked by permissions" }),
		);

		expect(verdict).toEqual({ exitCode: 0, aborted: true, abortReason: "blocked by permissions" });
	});

	/**
	 * The one thing that overrides a child's own abort: the wall clock. A run that exceeded its runtime
	 * is not one whose self-report you want to trust for the exit status.
	 */
	it("still fails when the wall clock also fired", () => {
		const verdict = resolveRunVerdict(
			baseInputs({
				abortedViaYield: true,
				yieldAbortReason: "blocked by permissions",
				runtimeLimitExceeded: true,
			}),
		);

		expect(verdict.exitCode).toBe(1);
		expect(verdict.aborted).toBe(true);
	});

	/**
	 * A yielded abort that ALSO failed its payload keeps the non-zero code the finalizer arrived at.
	 * The abort demotion must not overwrite a real failure with a success.
	 */
	it("does not zero an exit code the finalizer set", () => {
		const verdict = resolveRunVerdict(
			baseInputs({ abortedViaYield: true, yieldAbortReason: "blocked", exitCodeAfterFinalize: 1 }),
		);

		expect(verdict.exitCode).toBe(1);
	});
});

describe("which reason resolver is consulted", () => {
	/**
	 * A resolver is a function so the verdict can be formed without paying for text nobody will read,
	 * and so a test can prove WHICH one answered. A successful run must call neither: reading an abort
	 * reason for a run that was not aborted is how "Cancelled by caller" ends up on a clean result.
	 */
	it("asks for no reason at all when the run was not aborted", () => {
		const calls: string[] = [];
		resolveRunVerdict(
			baseInputs({
				resolveAbortReason: () => {
					calls.push("generic");
					return ABORT_REASON;
				},
				resolveSignalAbortReason: () => {
					calls.push("signal");
					return SIGNAL_REASON;
				},
			}),
		);

		expect(calls).toEqual([]);
	});

	/** A turn that carried its own reason is authoritative, so neither resolver is consulted. */
	it("prefers the turn's reason over both resolvers", () => {
		const calls: string[] = [];
		const verdict = resolveRunVerdict(
			baseInputs({
				hasYield: false,
				turnCutShort: true,
				turnAborted: true,
				turnAbortReason: "Request was aborted",
				callerAborted: true,
				resolveAbortReason: () => {
					calls.push("generic");
					return ABORT_REASON;
				},
				resolveSignalAbortReason: () => {
					calls.push("signal");
					return SIGNAL_REASON;
				},
			}),
		);

		expect(verdict.abortReason).toBe("Request was aborted");
		expect(calls).toEqual([]);
	});

	/**
	 * An abort with no caller signal and no turn reason is an internal cancellation, so the generic
	 * resolver answers. Using the signal resolver here would claim a caller cancelled a run nobody
	 * cancelled.
	 */
	it("falls back to the generic resolver when no signal fired", () => {
		const verdict = resolveRunVerdict(baseInputs({ hasYield: false, turnCutShort: true, turnAborted: true }));

		expect(verdict.abortReason).toBe(ABORT_REASON);
	});
});

describe("the verdict is a pure function of its inputs", () => {
	/**
	 * Called twice with the same facts it must answer the same way. The rules used to live in mutable
	 * locals across a try/catch/finally, where the answer depended on which site ran first; that is the
	 * property this pins.
	 */
	it("returns the same verdict for the same facts", () => {
		const inputs = baseInputs({ hasYield: false, turnCutShort: true, turnAborted: true, callerAborted: true });

		expect(resolveRunVerdict(inputs)).toEqual(resolveRunVerdict(inputs));
	});

	/** And it does not mutate what it was handed, so a caller can reuse the fact object. */
	it("leaves its inputs untouched", () => {
		const inputs = baseInputs({ hasYield: false, turnCutShort: true, turnAborted: true });
		const before = JSON.stringify({ ...inputs, resolveAbortReason: undefined, resolveSignalAbortReason: undefined });

		resolveRunVerdict(inputs);

		expect(JSON.stringify({ ...inputs, resolveAbortReason: undefined, resolveSignalAbortReason: undefined })).toBe(
			before,
		);
	});
});
