/**
 * WHY: the CLI's exit code counted infrastructure errors and nothing else, so a run whose trials
 * all settled without ever reaching a grade exited 0 and reported success. A caller polling the
 * exit code — CI, a wrapper script, the manager — read "the eval passed" from a run that measured
 * nothing at all.
 *
 * The class this closes: every way a run can fail to produce a measurement. `judgeRunOutcome` is
 * the single owner of the verdict, `RunFailure` enumerates the failure kinds at run time, and the
 * sweep below asserts each kind is reachable and each maps to a non-zero exit code. Adding a
 * failure kind without a case here turns the suite red.
 *
 * What it does not catch: the wording of the CLI's stderr lines, and whether a backend correctly
 * reports `error` versus a null reward in the first place. It asserts the verdict over a record,
 * not the transport that produced the record.
 */
import { describe, expect, test } from "bun:test";
import type { TrialScore } from "../../engine/contracts";
import type { EvalRunRecord, TrialResultRecord } from "../../engine/run-record";
import { judgeRunOutcome, type RunFailure } from "../../engine/run-record";

function score(overrides: Partial<TrialScore> = {}): TrialScore {
	return { reward: 1, partial: null, error: null, usage: null, extra: {}, ...overrides };
}

function trial(task: string, overrides: Partial<TrialScore> = {}): TrialResultRecord {
	return {
		cell: { variant: "v1", suite: "demo", task, repeat: 0 },
		score: score(overrides),
		startedAt: "2026-01-01T00:00:00.000Z",
		finishedAt: "2026-01-01T00:00:01.000Z",
	};
}

function record(results: readonly TrialResultRecord[]): EvalRunRecord {
	return {
		id: "run-1",
		suite: { name: "demo", version: "1.0.0" },
		variants: [
			{
				name: "v1",
				harness: "veyyon",
				configPath: null,
				promptVariantPath: null,
				model: "test/model",
				attachments: [],
			},
		],
		tasks: [...new Set(results.map(result => result.cell.task))],
		repeats: 1,
		results: [...results],
		createdAt: "2026-01-01T00:00:00.000Z",
		completedAt: "2026-01-01T00:00:02.000Z",
	};
}

/** Every failure kind, each with a run that reaches it. Sweeps `RunFailure` at run time. */
const REACHED_BY: Readonly<Record<RunFailure, EvalRunRecord>> = {
	"infrastructure-errors": record([trial("t1"), trial("t2", { reward: null, error: "container died" })]),
	"no-trial-settled": record([]),
	"nothing-measured": record([trial("t1", { reward: null }), trial("t2", { reward: null })]),
};

describe("a run that measured nothing is not a passing run", () => {
	test("a run with graded trials and no error exits 0", () => {
		const verdict = judgeRunOutcome(record([trial("t1"), trial("t2", { reward: 0 })]));
		expect(verdict).toEqual({ exitCode: 0, settled: 2, measured: 2, errors: 0, failure: null });
	});

	test("a run where every graded trial failed still exits 0: the reward is the answer", () => {
		const verdict = judgeRunOutcome(record([trial("t1", { reward: 0 }), trial("t2", { reward: 0 })]));
		expect(verdict.failure).toBeNull();
		expect(verdict.exitCode).toBe(0);
		expect(verdict.measured).toBe(2);
	});

	test("a run whose trials never reached a grade exits non-zero", () => {
		const verdict = judgeRunOutcome(REACHED_BY["nothing-measured"]);
		expect(verdict.failure).toBe("nothing-measured");
		expect(verdict.exitCode).toBe(1);
		expect(verdict.settled).toBe(2);
		expect(verdict.measured).toBe(0);
		expect(verdict.errors).toBe(0);
	});

	test("a run that settled no trial exits non-zero and is distinguished from an unmeasured one", () => {
		const verdict = judgeRunOutcome(REACHED_BY["no-trial-settled"]);
		expect(verdict.failure).toBe("no-trial-settled");
		expect(verdict.exitCode).toBe(1);
		expect(verdict.settled).toBe(0);
	});

	test("an infrastructure error outranks a measurement that did land", () => {
		const verdict = judgeRunOutcome(REACHED_BY["infrastructure-errors"]);
		expect(verdict.failure).toBe("infrastructure-errors");
		expect(verdict.exitCode).toBe(1);
		expect(verdict.measured).toBe(1);
		expect(verdict.errors).toBe(1);
	});

	test("a timed-out trial is a measurement, so a run of timeouts reports a graded failure", () => {
		const timedOut = trial("t1", { reward: null, extra: { timedOut: true } });
		const verdict = judgeRunOutcome(record([timedOut]));
		expect(verdict.measured).toBe(1);
		expect(verdict.errors).toBe(0);
		expect(verdict.failure).toBeNull();
		expect(verdict.exitCode).toBe(0);
	});

	test("every declared failure kind is reachable and every one exits non-zero", () => {
		const kinds = Object.keys(REACHED_BY) as RunFailure[];
		expect(kinds.length).toBeGreaterThan(0);
		for (const kind of kinds) {
			const verdict = judgeRunOutcome(REACHED_BY[kind]);
			expect(verdict.failure).toBe(kind);
			expect(verdict.exitCode).not.toBe(0);
		}
	});
});
