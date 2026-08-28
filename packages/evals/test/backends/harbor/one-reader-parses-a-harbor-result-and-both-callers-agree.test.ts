/**
 * WHY: two parsers read the same harbor `result.json`. The runner had `parseTrial` and the manager
 * had `parseHarborTrialFromJson`, and they disagreed three times: on a trial whose verifier recorded
 * no reward (fail vs error), on a trial whose agent context reported no token counts (absent vs a
 * summed zero, so an unmeasured run read as a run that used no tokens), and on a `result.json`
 * holding an array (skipped as no trial vs read as a record with no reward). Each divergence was
 * found separately, months apart, because nothing compared the two readers.
 *
 * The class closed here: one on-disk shape parsed by two owners. `parseFinishedTrialResult` in
 * `runner/results.ts` is the only reader; the manager wraps it to attach the trace path. This suite
 * drives both entry points over one fixture table and asserts they agree field for field, so
 * re-forking either one turns it red. The table sweeps the shapes that produced the divergences
 * plus the ones around them, and each row states the parse it expects, so a change to the shared
 * rules has to be recorded here.
 *
 * WHAT THIS DOES NOT CATCH: harbor's own format — if harbor renames `verifier_result.rewards`, both
 * readers agree on the wrong answer. It also does not cover the running-trial branch, which is not
 * shared: the runner probes the live agent log and the manager reads the directory mtime, each with
 * its own suite.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseFinishedTrialResult, parseTrial } from "../../../backends/harbor/results";
import type { TrialStatus } from "../../../engine/store-shapes";
import { clearBenchmarkCache, readBenchmarkSnapshot } from "../../../store/benchmarks";

interface Expected {
	readonly status: TrialStatus;
	readonly reward: number | null;
	readonly costUsd: number | null;
	readonly tokIn: number | null;
	readonly detail?: string;
}

interface Case {
	readonly label: string;
	readonly result: unknown;
	/** null when the file records no trial result at all. */
	readonly expected: Expected | null;
}

const AGENT = { cost_usd: 0.25, n_input_tokens: 100, n_output_tokens: 20, n_cache_tokens: 5 };

const CASES: Case[] = [
	{
		label: "a graded pass",
		result: {
			started_at: "2026-01-01T10:00:00",
			finished_at: "2026-01-01T10:01:00",
			verifier_result: { rewards: { reward: 1 } },
			agent_result: AGENT,
		},
		expected: { status: "pass", reward: 1, costUsd: 0.25, tokIn: 100 },
	},
	{
		label: "a graded failure",
		result: { verifier_result: { rewards: { reward: 0 } }, agent_result: AGENT },
		expected: { status: "fail", reward: 0, costUsd: 0.25, tokIn: 100 },
	},
	{
		label: "a partial reward under one",
		result: { verifier_result: { rewards: { reward: 0.5 } }, agent_result: AGENT },
		expected: { status: "fail", reward: 0.5, costUsd: 0.25, tokIn: 100 },
	},
	{
		label: "a verifier that recorded no reward",
		result: { verifier_result: { rewards: {} }, agent_result: AGENT },
		expected: { status: "error", reward: null, costUsd: 0.25, tokIn: 100, detail: "missing or unparsable reward" },
	},
	{
		label: "no verifier result at all",
		result: { agent_result: AGENT },
		expected: { status: "error", reward: null, costUsd: 0.25, tokIn: 100, detail: "missing or unparsable reward" },
	},
	{
		label: "an exception, whatever the reward says",
		result: {
			exception_info: { exception_type: "TimeoutError" },
			verifier_result: { rewards: { reward: 1 } },
			agent_result: AGENT,
		},
		expected: { status: "error", reward: 1, costUsd: 0.25, tokIn: 100, detail: "TimeoutError" },
	},
	{
		label: "a reward under a key other than reward",
		result: { verifier_result: { rewards: { tests_passed: 1 } }, agent_result: AGENT },
		expected: { status: "pass", reward: 1, costUsd: 0.25, tokIn: 100 },
	},
	{
		label: "a reward recorded in a step result",
		result: { step_results: [{ verifier_result: { rewards: { reward: 1 } }, agent_result: AGENT }] },
		expected: { status: "pass", reward: 1, costUsd: 0.25, tokIn: 100 },
	},
	{
		label: "usage spread across steps",
		result: {
			verifier_result: { rewards: { reward: 1 } },
			step_results: [
				{ agent_result: { cost_usd: 0.1, n_input_tokens: 10 } },
				{ agent_result: { cost_usd: 0.2, n_input_tokens: 5 } },
			],
		},
		expected: { status: "pass", reward: 1, costUsd: 0.30000000000000004, tokIn: 15 },
	},
	{
		label: "an agent context nobody priced",
		result: { verifier_result: { rewards: { reward: 1 } }, agent_result: { n_input_tokens: 100 } },
		expected: { status: "pass", reward: 1, costUsd: null, tokIn: 100 },
	},
	{
		label: "an agent context that counted no tokens",
		result: { verifier_result: { rewards: { reward: 1 } }, agent_result: { cost_usd: 0.25 } },
		expected: { status: "pass", reward: 1, costUsd: 0.25, tokIn: null },
	},
	{
		label: "a measured zero cost",
		result: { verifier_result: { rewards: { reward: 1 } }, agent_result: { cost_usd: 0, n_input_tokens: 0 } },
		expected: { status: "pass", reward: 1, costUsd: 0, tokIn: 0 },
	},
	{
		label: "a non-finite cost",
		result: { verifier_result: { rewards: { reward: 1 } }, agent_result: { cost_usd: "0.25", n_input_tokens: 100 } },
		expected: { status: "pass", reward: 1, costUsd: null, tokIn: 100 },
	},
	{ label: "an array", result: [], expected: null },
	{ label: "a string", result: "done", expected: null },
	{ label: "null", result: null, expected: null },
];

/** A harbor job dir holding one trial whose `result.json` is `result`, serialized verbatim. */
function writeJob(result: unknown): { jobDir: string; cleanup: () => void } {
	const jobsDir = fs.mkdtempSync(path.join(os.tmpdir(), "evals-one-reader-"));
	const jobDir = path.join(jobsDir, "job");
	fs.mkdirSync(path.join(jobDir, "task__1", "agent"), { recursive: true });
	fs.writeFileSync(path.join(jobDir, "task__1", "agent", "veyyon.txt"), "log\n");
	fs.writeFileSync(path.join(jobDir, "task__1", "result.json"), JSON.stringify(result));
	fs.writeFileSync(path.join(jobDir, "result.json"), JSON.stringify({ n_total_trials: 1, stats: {} }));
	return { jobDir, cleanup: () => fs.rmSync(jobsDir, { recursive: true, force: true }) };
}

describe("one reader parses a harbor trial result", () => {
	it.each(CASES.map(c => [c.label, c] as [string, Case]))("%s", (_label, testCase) => {
		const trial = parseFinishedTrialResult(testCase.result, "task__1");
		if (testCase.expected === null) {
			expect(trial).toBeNull();
			return;
		}
		expect(trial).not.toBeNull();
		if (trial === null) return;
		expect(trial.status).toBe(testCase.expected.status);
		expect(trial.reward).toBe(testCase.expected.reward);
		expect(trial.costUsd).toBe(testCase.expected.costUsd);
		expect(trial.tokIn).toBe(testCase.expected.tokIn);
		if (testCase.expected.detail !== undefined) expect(trial.detail).toBe(testCase.expected.detail);
	});

	it.each(CASES.map(c => [c.label, c] as [string, Case]))(
		"the runner's directory reader and the manager's snapshot agree on %s",
		(_label, testCase) => {
			const { jobDir, cleanup } = writeJob(testCase.result);
			try {
				clearBenchmarkCache();
				const fromDir = parseTrial(path.join(jobDir, "task__1"), "task__1");
				const [trace] = readBenchmarkSnapshot("harbor", jobDir).traces;
				if (testCase.expected === null) {
					// Neither reader invents a graded outcome; the manager keeps the row and says why.
					expect(fromDir).toBeNull();
					expect(trace.status).toBe("error");
					expect(trace.reward).toBeNull();
					expect(trace.detail).toBe("result.json holds no trial result object");
					return;
				}
				expect(fromDir).not.toBeNull();
				if (fromDir === null) return;
				expect(fromDir.status).toBe(trace.status);
				expect(fromDir.reward).toBe(trace.reward);
				expect(fromDir.costUsd).toBe(trace.costUsd);
				expect(fromDir.detail).toBe(trace.detail);
				expect(trace.status).toBe(testCase.expected.status);
			} finally {
				cleanup();
			}
		},
	);

	it("reports the totals the parsed trials measured, and no total they did not", () => {
		const { jobDir, cleanup } = writeJob({
			verifier_result: { rewards: { reward: 1 } },
			agent_result: { n_input_tokens: 40 },
		});
		try {
			clearBenchmarkCache();
			const snapshot = readBenchmarkSnapshot("harbor", jobDir);
			expect(snapshot.pass).toBe(1);
			expect(snapshot.done).toBe(1);
			// Nothing priced the trial: absent, not free.
			expect(snapshot.costUsd).toBeNull();
			expect(snapshot.tokCache).toBeNull();
			expect(snapshot.tokIn).toBe(40);
		} finally {
			cleanup();
		}
	});
});
