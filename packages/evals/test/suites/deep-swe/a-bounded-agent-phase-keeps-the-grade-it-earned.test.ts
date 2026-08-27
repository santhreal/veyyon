/**
 * WHY: a run that bounds the agent phase to fit a window measured nothing. Pier catches
 * its own agent timeout, downloads the logs, collects the artifacts and still runs the
 * verifier, so the trial arrives with a reward and an `exception_info` naming
 * `AgentTimeoutError`. The parser wrote that exception into the row's `error`, and a row
 * with an error is a trial that never reached a grader: the reward and the partial credit
 * the verifier had already computed were dropped, every arm read as a harness kill, and
 * the comparison had no rows left.
 *
 * CLASS: a graded trial discarded because something also failed. The sweep below drives
 * the real parser over pier's real artifact layout and covers every combination of the
 * three inputs that decide the row — which exception, whether a reward exists, whether
 * the agent produced work — so a fourth exception treated as fatal, or a reward kept
 * without evidence the agent ran, turns it red.
 *
 * NOT CAUGHT: whether pier honors `override_timeout_sec`, which runs out of process. And
 * the run still records reward 0 for a trial cut off mid-work: the bound is a parameter
 * of the run, identical across arms, and the row carries the exception so a report can
 * state it.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseTrialResult } from "../../../src/suites/deep-swe/runner/trial-result";

const AGENT_TIMEOUT = {
	exception_type: "AgentTimeoutError",
	exception_message: "Agent execution timed out after 900.0 seconds",
	exception_traceback: "Traceback (most recent call last):\n  ...\nAgentTimeoutError",
};

interface TrialFixture {
	/** What pier attached to the trial, or `null` for a clean run. */
	readonly exception: unknown;
	/** The verifier's own numbers, or `null` when it produced none. */
	readonly rewards: { reward: number; partial: number; f2p: number; p2p: number } | null;
	/** Tokens the agent spent. Zero means the container never reached a provider. */
	readonly outputTokens: number;
	readonly agentSteps: number;
}

let jobDir = "";

/** Writes the file layout pier leaves behind, and returns the job directory. */
function writeTrial(fixture: TrialFixture): string {
	const trialDir = path.join(jobDir, "task__aBcDeFg");
	fs.mkdirSync(path.join(trialDir, "verifier"), { recursive: true });
	fs.mkdirSync(path.join(trialDir, "agent"), { recursive: true });
	const trial: Record<string, unknown> = {
		agent_result: {
			n_output_tokens: fixture.outputTokens,
			n_agent_steps: fixture.agentSteps,
			metadata: {},
		},
		agent_execution: {
			started_at: "2026-08-27T04:49:34.000000",
			finished_at: "2026-08-27T05:04:34.000000",
		},
	};
	if (fixture.exception !== null) trial.exception_info = fixture.exception;
	if (fixture.rewards !== null) {
		trial.verifier_result = { rewards: fixture.rewards };
		fs.writeFileSync(path.join(trialDir, "verifier", "reward.json"), JSON.stringify(fixture.rewards));
	}
	fs.writeFileSync(path.join(trialDir, "result.json"), JSON.stringify(trial));
	return jobDir;
}

const GRADED = { reward: 0, partial: 0.0096, f2p: 0, p2p: 1 };

describe("a bounded agent phase keeps the grade it earned", () => {
	beforeEach(() => {
		jobDir = fs.mkdtempSync(path.join(os.tmpdir(), "evals-bounded-grade-"));
	});

	afterEach(() => {
		fs.rmSync(jobDir, { recursive: true, force: true });
	});

	it("scores the trial pier graded after cutting the agent phase off", () => {
		writeTrial({ exception: AGENT_TIMEOUT, rewards: GRADED, outputTokens: 12_000, agentSteps: 42 });

		const row = parseTrialResult("baseline", "task", 1, jobDir);

		expect(row.error).toBeNull();
		expect(row.reward).toBe(0);
		expect(row.partial).toBe(0.0096);
		expect(row.exceptionInfo?.exception_type).toBe("AgentTimeoutError");
	});

	it("keeps a partial credit above zero, which is the whole signal of a bounded run", () => {
		writeTrial({
			exception: AGENT_TIMEOUT,
			rewards: { reward: 0, partial: 0.62, f2p: 0.4, p2p: 1 },
			outputTokens: 40_000,
			agentSteps: 91,
		});

		const row = parseTrialResult("baseline", "task", 1, jobDir);

		expect(row.error).toBeNull();
		expect(row.partial).toBe(0.62);
		expect(row.f2p).toBe(0.4);
	});

	it("reports a bound the agent never reached a provider under as an error, not a zero", () => {
		writeTrial({ exception: AGENT_TIMEOUT, rewards: GRADED, outputTokens: 0, agentSteps: 0 });

		const row = parseTrialResult("baseline", "task", 1, jobDir);

		expect(row.error).toContain("AgentTimeoutError");
	});

	it("reports a bounded phase the verifier never graded as an error", () => {
		writeTrial({ exception: AGENT_TIMEOUT, rewards: null, outputTokens: 12_000, agentSteps: 42 });

		const row = parseTrialResult("baseline", "task", 1, jobDir);

		expect(row.error).toContain("AgentTimeoutError");
		expect(row.reward).toBeNull();
	});

	it("still reports every other exception as an error, graded or not", () => {
		const others = [
			{ exception_type: "NonZeroAgentExitCodeError", exception_message: "agent exited 1" },
			{ exception_type: "DockerComposeError", exception_message: "Docker compose command failed" },
			{ exception_type: "VerifierTimeoutError", exception_message: "Verifier timed out after 1800.0 seconds" },
			"KeyboardInterrupt",
		];

		for (const exception of others) {
			fs.rmSync(jobDir, { recursive: true, force: true });
			fs.mkdirSync(jobDir, { recursive: true });
			writeTrial({ exception, rewards: GRADED, outputTokens: 12_000, agentSteps: 42 });

			const row = parseTrialResult("baseline", "task", 1, jobDir);

			expect(row.error).not.toBeNull();
		}
	});

	it("recognizes the bound from the message when the type is wrapped", () => {
		writeTrial({
			exception: { exception_type: "TrialException", exception_message: "Agent execution timed out after 900.0 s" },
			rewards: GRADED,
			outputTokens: 12_000,
			agentSteps: 42,
		});

		const row = parseTrialResult("baseline", "task", 1, jobDir);

		expect(row.error).toBeNull();
		expect(row.reward).toBe(0);
	});

	it("leaves a clean trial's own reward and error untouched", () => {
		writeTrial({
			exception: null,
			rewards: { reward: 1, partial: 1, f2p: 1, p2p: 1 },
			outputTokens: 8_000,
			agentSteps: 20,
		});

		const row = parseTrialResult("baseline", "task", 1, jobDir);

		expect(row.error).toBeNull();
		expect(row.reward).toBe(1);
		expect(row.exceptionInfo).toBeNull();
	});

	it("still reports a trial with no verifier numbers at all", () => {
		writeTrial({ exception: null, rewards: null, outputTokens: 8_000, agentSteps: 20 });

		const row = parseTrialResult("baseline", "task", 1, jobDir);

		expect(row.error).not.toBeNull();
		expect(row.reward).toBeNull();
	});
});
