/**
 * WHY: a deep-swe trial that died in agent setup was scored `reward 0`. Pier
 * downloads `/logs/artifacts/model.patch` after a failed trial, so a setup failure
 * leaves "Could not find the file /logs/artifacts/model.patch in container" in the
 * job log — the same line an agent that ran and solved nothing leaves. The parser
 * read that line alone as "finished without a patch" and converted the exception
 * into a hard zero, so an unstaged assets directory, a dead credential or an
 * unreachable gateway was reported as a task the model could not solve, and the
 * run reported zero errors.
 *
 * The class this closes: an infrastructure failure recorded as a score. A zero is
 * a claim about the model, and it needs evidence the model was asked. Evidence
 * here is spent tokens (from the session transcript or from pier's own
 * `agent_result`) or a counted agent step; with none of them the trial is reported
 * as an error carrying no reward.
 *
 * What it does not catch: whether the verifier's reward is itself correct, and a
 * provider that both reports no usage and no step count while genuinely running —
 * that trial is reported as an error rather than a zero, which is the safe
 * direction but is not free.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { TempDir } from "@veyyon/utils";
import type { TrialCell } from "../../../src/core/types";
import { parseTrialResult } from "../../../src/suites/deep-swe/src/runner/trial-result";
import { deepSweSuite } from "../../../src/suites/deep-swe/suite";

const NO_PATCH_LINE =
	"Error response from daemon: Could not find the file /logs/artifacts/model.patch in container abc123";

interface JobFixture {
	readonly jobDir: string;
	readonly trialDir: string;
}

function writeJob(root: string, name: string, trial: Record<string, unknown>, jobLog: string | null): JobFixture {
	const jobDir = path.join(root, name);
	const trialDir = path.join(jobDir, `${name}__trial`);
	fs.mkdirSync(trialDir, { recursive: true });
	fs.writeFileSync(path.join(trialDir, "result.json"), JSON.stringify(trial));
	if (jobLog !== null) fs.writeFileSync(path.join(jobDir, "job.log"), jobLog);
	return { jobDir, trialDir };
}

const SETUP_EXCEPTION = {
	exception_type: "ValueError",
	exception_message: "veyyon asset missing on host: runs/r1/assets/vey",
};

/** Pier's shape for a trial whose agent class raised before it reached a provider. */
function agentNeverRan(): Record<string, unknown> {
	return {
		exception_info: SETUP_EXCEPTION,
		verifier_result: null,
		agent_result: {
			n_input_tokens: null,
			n_cache_tokens: null,
			n_output_tokens: null,
			cost_usd: null,
			n_agent_steps: null,
			metadata: null,
		},
	};
}

describe("a trial that never reached a provider is not a zero", () => {
	it("reports a setup failure as an error carrying no reward", async () => {
		const temp = await TempDir.create("@evals-test-setup-failure-");
		try {
			const { jobDir } = writeJob(temp.absolute(), "never-ran", agentNeverRan(), NO_PATCH_LINE);

			const parsed = parseTrialResult("veyyon", "some-task", 1, jobDir);

			expect(parsed.reward).toBeNull();
			expect(parsed.partial).toBeNull();
			expect(parsed.error).toContain("veyyon asset missing on host");
		} finally {
			await temp.remove();
		}
	});

	it("still scores a zero when the agent spent tokens and produced no patch", async () => {
		const temp = await TempDir.create("@evals-test-honest-zero-");
		try {
			const { jobDir } = writeJob(
				temp.absolute(),
				"ran-and-failed",
				{
					exception_info: { exception_type: "RuntimeError", exception_message: "no patch produced" },
					verifier_result: null,
					agent_result: {
						n_input_tokens: 120_000,
						n_cache_tokens: 90_000,
						n_output_tokens: 4_200,
						cost_usd: 0.63,
						n_agent_steps: 31,
						metadata: null,
					},
				},
				NO_PATCH_LINE,
			);

			const parsed = parseTrialResult("veyyon", "some-task", 1, jobDir);

			expect(parsed.reward).toBe(0);
			expect(parsed.partial).toBe(0);
			expect(parsed.f2p).toBe(0);
			expect(parsed.error).toBeNull();
		} finally {
			await temp.remove();
		}
	});

	it("accepts a counted agent step as evidence when a provider reports no usage", async () => {
		const temp = await TempDir.create("@evals-test-step-evidence-");
		try {
			const { jobDir } = writeJob(
				temp.absolute(),
				"steps-only",
				{
					exception_info: { exception_type: "RuntimeError", exception_message: "no patch produced" },
					verifier_result: null,
					agent_result: {
						n_input_tokens: null,
						n_cache_tokens: null,
						n_output_tokens: null,
						cost_usd: null,
						n_agent_steps: 7,
						metadata: null,
					},
				},
				NO_PATCH_LINE,
			);

			const parsed = parseTrialResult("veyyon", "some-task", 1, jobDir);

			expect(parsed.reward).toBe(0);
		} finally {
			await temp.remove();
		}
	});

	it("keeps the verifier's reward when the verifier ran", async () => {
		const temp = await TempDir.create("@evals-test-verifier-reward-");
		try {
			const { jobDir } = writeJob(
				temp.absolute(),
				"verified",
				{
					exception_info: null,
					verifier_result: { rewards: { reward: 1, partial: 1, f2p: 1, p2p: 1 } },
					agent_result: {
						n_input_tokens: 10_000,
						n_output_tokens: 900,
						n_cache_tokens: 0,
						cost_usd: 0.11,
						n_agent_steps: 4,
						metadata: null,
					},
				},
				null,
			);

			const parsed = parseTrialResult("veyyon", "some-task", 1, jobDir);

			expect(parsed.reward).toBe(1);
			expect(parsed.error).toBeNull();
		} finally {
			await temp.remove();
		}
	});

	it("hands the suite an error rather than a score for a trial whose agent never ran", async () => {
		const temp = await TempDir.create("@evals-test-suite-setup-failure-");
		try {
			const { trialDir } = writeJob(temp.absolute(), "suite-never-ran", agentNeverRan(), NO_PATCH_LINE);
			const cell: TrialCell = { suite: "deep-swe", variant: "veyyon", task: "some-task", repeat: 1 };

			const score = await deepSweSuite.scoreTrial(cell, { trialDir });

			// The run's error count and its mean reward are both read off this record: a
			// zero here would report a broken container as a measured arm.
			expect(score.reward).toBeNull();
			expect(score.error).toContain("veyyon asset missing on host");
		} finally {
			await temp.remove();
		}
	});
});
