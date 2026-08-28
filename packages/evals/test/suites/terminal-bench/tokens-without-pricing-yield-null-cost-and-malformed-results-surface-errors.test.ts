/**
 * WHY:
 * 1. A trial that reported token usage but had no provider pricing (e.g. subscription
 *    or local model) was previously treated as costUsd = 0 because hasUsage was true
 *    and costUsd initialized to 0, falsely reporting unknown spend as free.
 * 2. A malformed container result.json was swallowed by a bare catch block, causing
 *    scoring to treat the trial as a zero-cost run with missing usage rather than
 *    surfacing the container output corruption as an infrastructure error.
 *
 * What this defends:
 * - Token counts without pricing produce usage with exact tokens and costUsd === null.
 * - Pricing when present sums across agent_result and step_results.
 * - Malformed result.json surfaces an error and never scores as a silent zero-cost pass.
 */

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { TrialArtifacts, TrialCell } from "../../../engine/contracts";
import { internalScratchDir } from "../../../engine/package-paths";
import { terminalBenchSuite } from "../../../suites/terminal-bench/main";

function createTempTrialDir(files: Record<string, string>): {
	trialDir: string;
	filePaths: Record<string, string>;
	cleanup: () => void;
} {
	const dir = path.join(internalScratchDir(), `tb-spend-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
	fs.mkdirSync(dir, { recursive: true });
	const filePaths: Record<string, string> = {};
	for (const [rel, content] of Object.entries(files)) {
		const full = path.join(dir, rel);
		fs.mkdirSync(path.dirname(full), { recursive: true });
		fs.writeFileSync(full, content, "utf-8");
		filePaths[rel] = full;
	}
	return {
		trialDir: dir,
		filePaths,
		cleanup: () => {
			try {
				fs.rmSync(dir, { recursive: true, force: true });
			} catch {
				// Ignore cleanup error
			}
		},
	};
}

const dummyCell: TrialCell = {
	suite: "terminal-bench",
	variant: "default",
	task: "sample-task",
	repeat: 1,
};

describe("terminal-bench usage extraction and spend honesty", () => {
	it("returns costUsd === null when tokens are present without pricing", async () => {
		const { trialDir, filePaths, cleanup } = createTempTrialDir({
			"verifier/reward.json": JSON.stringify({ reward: 1.0 }),
			"result.json": JSON.stringify({
				agent_result: {
					n_input_tokens: 1500,
					n_output_tokens: 250,
					n_cache_tokens: 400,
					// cost_usd is absent/unpriced
				},
				started_at: "2026-08-25T10:00:00Z",
				finished_at: "2026-08-25T10:01:00Z",
			}),
		});

		try {
			const artifacts: TrialArtifacts = { trialDir, filePaths };
			const score = await terminalBenchSuite.scoreTrial(dummyCell, artifacts);

			expect(score.reward).toBe(1.0);
			expect(score.error).toBeNull();
			expect(score.usage).not.toBeNull();
			expect(score.usage?.inputTokens).toBe(1500);
			expect(score.usage?.outputTokens).toBe(250);
			expect(score.usage?.cacheTokens).toBe(400);
			expect(score.usage?.costUsd).toBeNull();
			expect(score.usage?.durationSec).toBe(60);
		} finally {
			cleanup();
		}
	});

	it("sums cost_usd exactly across agent_result and step_results when pricing is present", async () => {
		const { trialDir, filePaths, cleanup } = createTempTrialDir({
			"verifier/reward.json": JSON.stringify({ reward: 1.0 }),
			"result.json": JSON.stringify({
				agent_result: {
					n_input_tokens: 1000,
					n_output_tokens: 200,
					cost_usd: 0.015,
				},
				step_results: [
					{
						agent_result: {
							n_input_tokens: 500,
							n_output_tokens: 100,
							cost_usd: 0.005,
						},
					},
					{
						agent_result: {
							n_input_tokens: 300,
							n_output_tokens: 50,
							cost_usd: 0.003,
						},
					},
				],
				started_at: "2026-08-25T10:00:00Z",
				finished_at: "2026-08-25T10:00:30Z",
			}),
		});

		try {
			const artifacts: TrialArtifacts = { trialDir, filePaths };
			const score = await terminalBenchSuite.scoreTrial(dummyCell, artifacts);

			expect(score.reward).toBe(1.0);
			expect(score.error).toBeNull();
			expect(score.usage).not.toBeNull();
			expect(score.usage?.inputTokens).toBe(1800);
			expect(score.usage?.outputTokens).toBe(350);
			expect(score.usage?.costUsd).toBeCloseTo(0.023, 5);
			expect(score.usage?.durationSec).toBe(30);
		} finally {
			cleanup();
		}
	});

	it("surfaces an error when result.json is malformed instead of a silent zero-cost pass", async () => {
		const { trialDir, filePaths, cleanup } = createTempTrialDir({
			"verifier/reward.json": JSON.stringify({ reward: 1.0 }),
			"result.json": "{ malformed json: not valid syntax",
		});

		try {
			const artifacts: TrialArtifacts = { trialDir, filePaths };
			const score = await terminalBenchSuite.scoreTrial(dummyCell, artifacts);

			expect(score.reward).toBeNull();
			expect(score.error).not.toBeNull();
			expect(score.error).toContain("Failed to parse result.json");
			expect(score.extra.result_json_parse_error).toBeDefined();
		} finally {
			cleanup();
		}
	});

	it("surfaces an error for malformed result.json in multi-step task scoring", async () => {
		const { trialDir, filePaths, cleanup } = createTempTrialDir({
			"step_0/verifier/reward.json": JSON.stringify({ reward: 1.0 }),
			"step_1/verifier/reward.json": JSON.stringify({ reward: 1.0 }),
			"result.json": '{"unclosed": ',
		});

		try {
			const artifacts: TrialArtifacts = {
				trialDir,
				filePaths,
				extra: { multi_step_reward_strategy: "mean" },
			};
			const score = await terminalBenchSuite.scoreTrial(dummyCell, artifacts);

			expect(score.reward).toBeNull();
			expect(score.error).not.toBeNull();
			expect(score.error).toContain("Failed to parse result.json");
			expect(score.extra.result_json_parse_error).toBeDefined();
		} finally {
			cleanup();
		}
	});
});
