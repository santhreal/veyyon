/**
 * WHY:
 * 1. DeepSWE cell summaries must treat infrastructure errors and timeouts honestly:
 *    - Timeouts are model failures: reward 0, counted in denominators and means.
 *    - Infrastructure errors never reached a grade: excluded from denominators and means,
 *      reported in error counts.
 *    - An all-errored cell must report null pass rates and null mean rewards, never 0.00.
 *    - Reference cost per task must divide by the graded-OK population from which the
 *      numerator was summed, not a denominator inflated with timeouts.
 * 2. parseTrialResult must preserve trial.exception_info on finishedWithoutPatch trials
 *    while maintaining the reward-0 grading.
 *
 * What this defends:
 * - summarizeCell enforces honest denominators and outcome classifications.
 * - Table-driven variants over ArmResult scenarios verify boundary invariants.
 * - Exception info on finished-without-patch runs is preserved for inspection.
 */

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { TempDir } from "@veyyon/utils";
import { emptyArmResult } from "../../../src/suites/deep-swe/aggregate";
import { priceTokens } from "../../../src/suites/deep-swe/cost-model";
import { renderReport } from "../../../src/suites/deep-swe/src/aggregate/report-render";
import { summarizeCell } from "../../../src/suites/deep-swe/src/aggregate/stats";
import type { ArmResult } from "../../../src/suites/deep-swe/src/aggregate/types";
import { parseTrialResult } from "../../../src/suites/deep-swe/src/runner/trial-result";

function makeRow(over: Partial<ArmResult>): ArmResult {
	return { ...emptyArmResult("arm-a", "task-1", 0), ...over };
}

describe("deep-swe honest scoring denominators and error classification", () => {
	interface TestCase {
		readonly name: string;
		readonly rows: readonly ArmResult[];
		readonly expected: {
			readonly total: number;
			readonly errors: number;
			readonly timedOut: number;
			readonly n: number;
			readonly passes: number;
			readonly passRate: number | null;
			readonly meanReward: number | null;
			readonly meanPartial: number | null;
			readonly meanCostUsd: number | null;
			readonly refCostPerScoredTask: number | null;
		};
	}

	const cases: readonly TestCase[] = [
		{
			name: "mixed cell with pass, fail, timeout, and infrastructure error",
			rows: [
				makeRow({
					repeat: 0,
					reward: 1,
					partial: 1,
					costUsd: 0.1,
					inputTokens: 1000,
					outputTokens: 200,
					cacheReadTokens: 500,
					cacheWriteTokens: 100,
				}),
				makeRow({
					repeat: 1,
					reward: 0,
					partial: 0.5,
					costUsd: 0.2,
					inputTokens: 1200,
					outputTokens: 300,
					cacheReadTokens: 600,
					cacheWriteTokens: 150,
				}),
				makeRow({ repeat: 2, error: "trial timed out after 1800s", reward: null }),
				makeRow({ repeat: 3, error: "ContainerStartError: Docker daemon down", reward: null }),
			],
			expected: {
				total: 4,
				errors: 1, // Docker daemon down
				timedOut: 1, // timeout error
				n: 3, // scored (2) + timedOut (1)
				passes: 1,
				passRate: 1 / 3, // 1 pass out of 3 (timeout counts as graded 0)
				meanReward: (1 + 0 + 0) / 3, // (pass + fail + timeout(0)) / 3 = 1/3
				meanPartial: (1 + 0.5) / 2, // partial mean over scored rows only
				meanCostUsd: (0.1 + 0.2) / 2,
				// refCost numerator sums tokens from the 2 scored rows
				refCostPerScoredTask: priceTokens({
					inputTokens: 1000 + 1200,
					cacheReadTokens: 500 + 600,
					cacheWriteTokens: 100 + 150,
					outputTokens: 200 + 300,
				}).total,
			},
		},
		{
			name: "cell of nothing but infrastructure errors yields null rates rather than 0",
			rows: [
				makeRow({ repeat: 0, error: "UnreachableGatewayError: connection refused" }),
				makeRow({ repeat: 1, error: "ImagePullError: tag not found" }),
			],
			expected: {
				total: 2,
				errors: 2,
				timedOut: 0,
				n: 0,
				passes: 0,
				passRate: null,
				meanReward: null,
				meanPartial: null,
				meanCostUsd: null,
				refCostPerScoredTask: null,
			},
		},
		{
			name: "cell with only timeouts yields passRate 0 and meanReward 0 over denominator of timeouts",
			rows: [
				makeRow({ repeat: 0, error: "AgentTimeoutError: exceeded wall clock budget" }),
				makeRow({ repeat: 1, error: "trial timed out after 300s" }),
			],
			expected: {
				total: 2,
				errors: 0,
				timedOut: 2,
				n: 2,
				passes: 0,
				passRate: 0,
				meanReward: 0,
				meanPartial: null,
				meanCostUsd: null,
				refCostPerScoredTask: null,
			},
		},
		{
			name: "all passing scored runs",
			rows: [
				makeRow({
					repeat: 0,
					reward: 1,
					partial: 1,
					costUsd: 0.05,
					inputTokens: 500,
					outputTokens: 100,
					cacheReadTokens: 200,
					cacheWriteTokens: 50,
				}),
				makeRow({
					repeat: 1,
					reward: 1,
					partial: 1,
					costUsd: 0.05,
					inputTokens: 500,
					outputTokens: 100,
					cacheReadTokens: 200,
					cacheWriteTokens: 50,
				}),
			],
			expected: {
				total: 2,
				errors: 0,
				timedOut: 0,
				n: 2,
				passes: 2,
				passRate: 1.0,
				meanReward: 1.0,
				meanPartial: 1.0,
				meanCostUsd: 0.05,
				refCostPerScoredTask: priceTokens({
					inputTokens: 1000,
					cacheReadTokens: 400,
					cacheWriteTokens: 100,
					outputTokens: 200,
				}).total,
			},
		},
	];

	for (const tc of cases) {
		it(`summarizeCell: ${tc.name}`, () => {
			const s = summarizeCell(tc.rows);

			expect(s.total).toBe(tc.expected.total);
			expect(s.errors).toBe(tc.expected.errors);
			expect(s.timedOut).toBe(tc.expected.timedOut);
			expect(s.n).toBe(tc.expected.n);
			expect(s.passes).toBe(tc.expected.passes);

			if (tc.expected.passRate === null) {
				expect(s.passRate).toBeNull();
			} else {
				expect(s.passRate).toBeCloseTo(tc.expected.passRate, 5);
			}

			if (tc.expected.meanReward === null) {
				expect(s.meanReward).toBeNull();
			} else {
				expect(s.meanReward).toBeCloseTo(tc.expected.meanReward, 5);
			}

			if (tc.expected.meanPartial === null) {
				expect(s.meanPartial).toBeNull();
			} else {
				expect(s.meanPartial).toBeCloseTo(tc.expected.meanPartial, 5);
			}

			if (tc.expected.meanCostUsd === null) {
				expect(s.meanCostUsd).toBeNull();
			} else {
				expect(s.meanCostUsd).toBeCloseTo(tc.expected.meanCostUsd, 5);
			}

			const scoredCount = s.n - s.timedOut;
			if (tc.expected.refCostPerScoredTask === null) {
				const perScored = s.refCostMeasurable && scoredCount > 0 ? s.refCost.total / scoredCount : null;
				expect(perScored).toBeNull();
			} else {
				expect(s.refCostMeasurable).toBe(true);
				const perScored = s.refCost.total / scoredCount;
				expect(s.refCost.total).toBeCloseTo(tc.expected.refCostPerScoredTask, 5);
				expect(perScored).toBeCloseTo(tc.expected.refCostPerScoredTask / scoredCount, 5);
			}
		});
	}

	it("parseTrialResult preserves exception_info on finished-without-patch trials with reward 0", async () => {
		const temp = await TempDir.create("@evals-test-preserved-exception-");
		try {
			const jobDir = path.join(temp.absolute(), "job-1");
			const trialDir = path.join(jobDir, "trial-1");
			fs.mkdirSync(trialDir, { recursive: true });

			const exceptionInfo = {
				exception_type: "VerifierNoPatchError",
				exception_message: "model generated empty patch",
				traceback: ["Traceback (most recent call last):", "  File 'runner.py', line 42"],
			};

			fs.writeFileSync(
				path.join(trialDir, "result.json"),
				JSON.stringify({
					exception_info: exceptionInfo,
					verifier_result: null,
					agent_result: {
						n_input_tokens: 50_000,
						n_output_tokens: 1_200,
						n_cache_tokens: 10_000,
						cost_usd: 0.25,
						n_agent_steps: 12,
						metadata: null,
					},
				}),
			);
			fs.writeFileSync(
				path.join(jobDir, "job.log"),
				"Error response from daemon: Could not find the file /logs/artifacts/model.patch in container abc123",
			);

			const parsed = parseTrialResult("arm-a", "task-1", 1, jobDir);

			expect(parsed.reward).toBe(0);
			expect(parsed.partial).toBe(0);
			expect(parsed.f2p).toBe(0);
			expect(parsed.error).toBeNull();

			// The reason for a 0 is recorded on the declared field, so the run JSON a resume
			// reads back still says why the trial scored nothing.
			expect(parsed.exceptionInfo).toEqual(exceptionInfo);
		} finally {
			await temp.remove();
		}
	});
	it("renderReport reference cost uses graded-OK population and prints error counts", () => {
		// 6 paired tasks between decode and full. On each task:
		// decode runs 1 scored task and 1 timed-out task (c.n=2, c.timedOut=1, gradedOk=1)
		// full runs 1 scored task and 1 timed-out task (c.n=2, c.timedOut=1, gradedOk=1)
		// decode scored task: 1000 input, 500 cacheRead, 100 cacheWrite, 200 output
		// full scored task: 800 input, 400 cacheRead, 80 cacheWrite, 160 output
		const results: ArmResult[] = [];
		for (let i = 1; i <= 6; i++) {
			results.push(
				makeRow({
					arm: "decode",
					task: `t${i}`,
					repeat: 0,
					reward: 1,
					inputTokens: 1000,
					cacheReadTokens: 500,
					cacheWriteTokens: 100,
					outputTokens: 200,
					error: null,
				}),
				makeRow({
					arm: "decode",
					task: `t${i}`,
					repeat: 1,
					error: "trial timed out after 1800s",
				}),
				makeRow({
					arm: "full",
					task: `t${i}`,
					repeat: 0,
					reward: 1,
					inputTokens: 800,
					cacheReadTokens: 400,
					cacheWriteTokens: 80,
					outputTokens: 160,
					error: null,
				}),
				makeRow({
					arm: "full",
					task: `t${i}`,
					repeat: 1,
					error: "trial timed out after 1800s",
				}),
			);
		}

		const report = renderReport(results, "test-model", "2026-08-25T00:00:00.000Z", 2);
		expect(report).toContain("## Efficiency comparison (paired by task)");
		expect(report).toContain("| ref cost | decode → full |");

		const singleDecodeCost = priceTokens({
			inputTokens: 1000,
			cacheReadTokens: 500,
			cacheWriteTokens: 100,
			outputTokens: 200,
		}).total;
		const singleFullCost = priceTokens({
			inputTokens: 800,
			cacheReadTokens: 400,
			cacheWriteTokens: 80,
			outputTokens: 160,
		}).total;
		const expectedDelta = singleFullCost - singleDecodeCost;

		// Delta per task should match singleFullCost - singleDecodeCost (not halved by timeout in denominator)
		const deltaStr = (expectedDelta >= 0 ? "+" : "") + expectedDelta.toFixed(4);
		expect(report).toContain(deltaStr);
	});
});
