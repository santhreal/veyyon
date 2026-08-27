/**
 * A run that must fit a window bounds the agent phase, not the trial deadline.
 *
 * WHY THIS SUITE EXISTS. The two bounds have opposite outcomes. `--trial-timeout`
 * is the harness's own timer around `pier run`: when it fires the process tree is
 * killed, so the verifier never runs and the trial carries no reward at all.
 * Pier's agent budget is different — `TrialExecution.run_agent` wraps the agent in
 * `asyncio.wait_for`, and the trial catches `AgentTimeoutError`, downloads the
 * agent logs, collects the artifacts and still verifies. A DeepSWE task that
 * grants its agent 5400s therefore cannot be shortened to fit an overnight window
 * through the deadline flag without discarding every score, which is what a run
 * exists to produce. `--agent-timeout` writes `override_timeout_sec` on the agent
 * pier loads, which is the one number that shortens the phase and keeps the grade.
 *
 * THE CLASS IT CLOSES. "A time bound reaches the wrong owner." The parse, the
 * options bag and the bytes pier reads are asserted as one chain, and the two
 * bounds are asserted to be independent, so wiring one flag into the other's
 * owner turns this red.
 *
 * WHAT IT DOES NOT CATCH. It asserts the config this repository writes, not pier's
 * own honoring of `override_timeout_sec` (that is pier's contract, pinned by the
 * minimum version this suite's backend requires), and it starts no container, so
 * nothing here proves what a real timed-out agent scores.
 */

import { beforeAll, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { PierExecutionBackend } from "../../../src/backends/pier/backend";
import * as pierRunner from "../../../src/backends/pier/runner";
import { CliUsageError, parseEvalsArgs, suiteContext } from "../../../src/cli";
import { listSuites } from "../../../src/core";
import type { EvalSuite, RunContext, TaskDescriptor, TrialCell, TrialScore, Variant } from "../../../src/core/types";
import { registerBuiltinHarnesses } from "../../../src/harnesses/index";
import { registerAllSuites } from "../../../src/suites/index";

const TASK = "bound-the-agent";
const MODEL = "vendor/model-x";
const ARM = "baseline";

/** A task that grants its agent far more time than an overnight window allows. */
function stubSuite(): EvalSuite {
	return {
		name: "agent-bound-suite",
		version: "1.0.0",
		displayName: "Agent Bound Suite",
		description: "Fixture suite whose task grants a long agent budget.",
		backend: "pier",
		async discoverTasks(): Promise<readonly string[]> {
			return [TASK];
		},
		async describeTask(taskId: string): Promise<TaskDescriptor> {
			return { id: taskId, path: null, timeBudgetSec: 9000, instructionPath: null, metadata: {} };
		},
		async provenance() {
			return { suite: "agent-bound-suite", version: "1.0.0" };
		},
		async scoreTrial(): Promise<TrialScore> {
			return { reward: null, partial: null, error: null, usage: null, extra: {} };
		},
		async preflight() {
			return { ok: true };
		},
	};
}

const variant: Variant = {
	name: ARM,
	harness: "veyyon",
	configPath: null,
	promptVariantPath: null,
	model: MODEL,
	attachments: [],
};

async function contextWith(options: Record<string, unknown>): Promise<RunContext> {
	const root = await fsp.mkdtemp(path.join(os.tmpdir(), "evals-agent-bound-"));
	return {
		runId: "run-agent-bound",
		suite: stubSuite(),
		workDir: root,
		runsDir: path.join(root, "runs"),
		options: { variants: [variant], ...options },
	};
}

const cell: TrialCell = { variant: ARM, suite: "agent-bound-suite", task: TASK, repeat: 0 };

/** Run one trial with the real config writer and no container, returning the config text. */
async function configWrittenFor(options: Record<string, unknown>): Promise<{ yaml: string; deadlineSec: number }> {
	const context = await contextWith(options);
	const written: string[] = [];
	const deadlines: number[] = [];
	const realWrite = pierRunner.writePierJobConfig;
	const writeSpy = spyOn(pierRunner, "writePierJobConfig").mockImplementation(opts => {
		const configPath = realWrite(opts);
		written.push(configPath);
		return configPath;
	});
	const runSpy = spyOn(pierRunner, "runPierTrial").mockImplementation(async opts => {
		deadlines.push(opts.trialTimeoutSec);
		return { exitCode: 0, stdout: "", stderr: "", trialDirPath: null, durationMs: 1, timedOut: false, error: null };
	});
	const artifactSpy = spyOn(pierRunner, "trialArtifactsFromExecution").mockImplementation(() => ({}));
	try {
		await new PierExecutionBackend().runTrial(cell, context);
	} finally {
		writeSpy.mockRestore();
		runSpy.mockRestore();
		artifactSpy.mockRestore();
	}
	const configPath = written[0];
	if (configPath === undefined) throw new Error("the backend wrote no pier config");
	const deadlineSec = deadlines[0];
	if (deadlineSec === undefined) throw new Error("the backend started no trial");
	return { yaml: fs.readFileSync(configPath, "utf8"), deadlineSec };
}

describe("a bounded agent phase still gets graded", () => {
	beforeAll(() => {
		registerBuiltinHarnesses();
		registerAllSuites();
	});

	it("carries --agent-timeout to the options bag the backend reads", () => {
		const suite = listSuites().find(entry => entry.name === "deep-swe");
		if (!suite) throw new Error("the deep-swe suite is not registered");
		const args = parseEvalsArgs(["--suite", "deep-swe", "--agent-timeout", "1200"]);

		expect(args.agentTimeoutSec).toBe(1200);
		expect(suiteContext(args, suite).options?.agentTimeoutSec).toBe(1200);
	});

	it("states no agent bound when the flag is absent, so the task's budget stands", () => {
		const suite = listSuites().find(entry => entry.name === "deep-swe");
		if (!suite) throw new Error("the deep-swe suite is not registered");
		const args = parseEvalsArgs(["--suite", "deep-swe"]);

		expect(args.agentTimeoutSec).toBeNull();
		expect("agentTimeoutSec" in (suiteContext(args, suite).options ?? {})).toBe(false);
	});

	it("refuses a bound that is not a whole number of seconds", () => {
		for (const value of ["0", "-5", "12.5", "soon", ""]) {
			expect(() => parseEvalsArgs(["--suite", "deep-swe", "--agent-timeout", value])).toThrow(CliUsageError);
		}
	});

	it("writes the bound as the agent's own override, which pier grades after", async () => {
		const { yaml } = await configWrittenFor({ agentTimeoutSec: 1200 });

		expect(yaml).toContain("override_timeout_sec: 1200");
		// On the agent entry pier loads, not on the job or the task.
		const agentBlock = yaml.slice(yaml.indexOf("agents:"));
		expect(agentBlock).toContain("override_timeout_sec: 1200");
	});

	it("writes no override when no bound was asked for", async () => {
		const { yaml } = await configWrittenFor({});

		expect(yaml).not.toContain("override_timeout_sec");
	});

	it("leaves the trial deadline alone, which the task's own budget still owns", async () => {
		const bounded = await configWrittenFor({ agentTimeoutSec: 1200 });
		const unbounded = await configWrittenFor({});

		expect(bounded.deadlineSec).toBe(unbounded.deadlineSec);
		expect(bounded.deadlineSec).toBe(9000);
	});

	it("keeps the deadline flag on the deadline, which grades nothing when it fires", async () => {
		const { yaml, deadlineSec } = await configWrittenFor({ trialTimeoutSec: 1500 });

		expect(deadlineSec).toBe(1500);
		expect(yaml).not.toContain("override_timeout_sec");
	});
});
