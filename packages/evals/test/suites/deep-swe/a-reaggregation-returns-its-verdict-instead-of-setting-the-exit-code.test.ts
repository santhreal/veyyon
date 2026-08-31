/**
 * WHY THIS SUITE EXISTS.
 *
 * `reaggregate()` is a library function: the CLI calls it, and so does anything that imports the
 * deep-swe runner. It ended a non-passing cross-system comparison by assigning
 * `process.exitCode = 1`, so importing it to re-read a finished run changed the importing process's
 * exit code, and a test file or the dashboard server that re-aggregated a losing run then exited 1
 * with every assertion green. The same run through the CLI reported the verdict only on the
 * `--reaggregate` path: a live comparison run that failed its gates exited 0.
 *
 * The class this closes: a library function reaching for the host process's exit code instead of
 * returning what it found. `reaggregate` returns the comparison, and `evals.ts` is the
 * one place that maps a non-passing verdict to exit 1.
 *
 * What it does not catch: the gate arithmetic itself, proven in
 * `a-cross-system-comparison-pairs-results-before-it-rates-them.test.ts`, and the live run path,
 * which needs pier and a container runtime.
 */

import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { TempDir } from "@veyyon/utils";
import { reaggregate } from "../../../suites/deep-swe/runner/executor";

const MODEL = "test/model";
const TASK = "task-a";

interface SystemFixture {
	readonly system: string;
	readonly reward: number;
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cacheTokens: number;
	readonly costUsd: number;
	readonly agentSeconds: number;
}

/** The reference harness wins every gate: better reward, less time, under half the tokens and price. */
const REFERENCE: SystemFixture = {
	system: "veyyon",
	reward: 1,
	inputTokens: 10,
	outputTokens: 4,
	cacheTokens: 6,
	costUsd: 0.05,
	agentSeconds: 5,
};

const COMPETITOR: SystemFixture = {
	system: "omp",
	reward: 0,
	inputTokens: 60,
	outputTokens: 20,
	cacheTokens: 20,
	costUsd: 1,
	agentSeconds: 20,
};

const EXECUTION = {
	taskInstructionsHash: "instructions-sha",
	repositoryStateHash: "repo-sha",
	wallClockLimitSeconds: 1800,
	temperature: null,
	samplingDescription: "temperature unset",
};

const temps: TempDir[] = [];

afterEach(async () => {
	for (const temp of temps.splice(0)) await temp.remove();
});

/**
 * A run directory in the shape `reaggregate` reads: one config per cell, one job directory per cell
 * holding the trial payload, and a `results.json` carrying the comparison provenance plus the
 * per-cell fields a re-read cannot recover from the trial (system, models, artifacts, execution).
 */
async function writeComparisonRun(systems: readonly SystemFixture[]): Promise<string> {
	const temp = await TempDir.create("@evals-test-reaggregate-");
	temps.push(temp);
	const runDir = temp.absolute();
	fs.mkdirSync(path.join(runDir, "configs"), { recursive: true });
	for (const fixture of systems) {
		const jobName = `${fixture.system}__${TASK}`;
		fs.writeFileSync(path.join(runDir, "configs", `${jobName}.yaml`), "");
		const trialDir = path.join(runDir, "jobs", jobName, `${jobName}__trial`);
		fs.mkdirSync(trialDir, { recursive: true });
		fs.writeFileSync(
			path.join(trialDir, "result.json"),
			JSON.stringify({
				verifier_result: { rewards: { reward: fixture.reward, partial: fixture.reward, f2p: fixture.reward } },
				agent_result: {
					n_input_tokens: fixture.inputTokens,
					n_output_tokens: fixture.outputTokens,
					n_cache_tokens: fixture.cacheTokens,
					cost_usd: fixture.costUsd,
					n_agent_steps: 4,
					metadata: { resolved_model: MODEL },
				},
				agent_execution: {
					started_at: "2026-01-01T00:00:00.000Z",
					finished_at: new Date(
						Date.parse("2026-01-01T00:00:00.000Z") + fixture.agentSeconds * 1000,
					).toISOString(),
				},
			}),
		);
	}
	fs.writeFileSync(
		path.join(runDir, "results.json"),
		JSON.stringify({
			model: MODEL,
			comparison: { run: { systems: systems.map(f => f.system) } },
			tasks: [TASK],
			results: systems.map(fixture => ({
				arm: fixture.system,
				task: TASK,
				repeat: 0,
				system: fixture.system,
				requestedModel: MODEL,
				resolvedModel: MODEL,
				providerCostSupported: true,
				qualitativeScore: null,
				recoveryReads: null,
				recoveryTokens: null,
				artifacts: { patch: "model.patch", transcript: "sessions", log: "agent.txt" },
				execution: EXECUTION,
				replay: null,
				nativeCompaction: null,
			})),
		}),
	);
	return runDir;
}

async function writeConfigArmRun(): Promise<string> {
	const temp = await TempDir.create("@evals-test-reaggregate-arms-");
	temps.push(temp);
	const runDir = temp.absolute();
	fs.mkdirSync(path.join(runDir, "configs"), { recursive: true });
	fs.writeFileSync(path.join(runDir, "results.json"), JSON.stringify({ model: MODEL, results: [] }));
	return runDir;
}

describe("re-aggregating a comparison run", () => {
	it("returns a failing verdict without touching the exit code of the process that called it", async () => {
		// Both systems solved the task, so the reference no longer wins the quality gate.
		const runDir = await writeComparisonRun([REFERENCE, { ...COMPETITOR, reward: 1 }]);
		const before = process.exitCode;
		try {
			const comparison = reaggregate(runDir);

			expect(comparison?.overall).toBe("fail");
			expect(comparison?.referenceSystem).toBe("veyyon");
			expect(process.exitCode).toBe(before);
		} finally {
			process.exitCode = before;
		}
	});

	it("returns a passing verdict when the reference wins every gate", async () => {
		const runDir = await writeComparisonRun([REFERENCE, COMPETITOR]);

		const comparison = reaggregate(runDir);

		expect(comparison?.overall).toBe("pass");
		expect(fs.readFileSync(path.join(runDir, "report.md"), "utf8")).toContain("Cross-system comparison");
	});

	it("returns no verdict for a run that recorded no comparison", async () => {
		const runDir = await writeConfigArmRun();
		const before = process.exitCode;
		try {
			expect(reaggregate(runDir)).toBeNull();
			expect(process.exitCode).toBe(before);
		} finally {
			process.exitCode = before;
		}
	});
});
