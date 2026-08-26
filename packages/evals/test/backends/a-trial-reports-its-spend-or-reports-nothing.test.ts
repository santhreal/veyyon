/**
 * WHY: an in-process trial recorded tokens and no spend. `InProcessSessionStats`
 * declared only `tokens` and `assistantMessages`, so the session's `cost` never
 * left the backend, `TrialUsage.costUsd` stayed undefined, and a whole run of
 * in-process suites reported $0.00 while the provider billed for every trial. A
 * fabricated $0 reads as a cheap arm and is the same class of defect as scoring a
 * failed setup 0 instead of null.
 *
 * The class this closes: a backend that observes a number and drops it on the way
 * to the score, and a backend that invents a number it did not observe. Both are
 * checked here at the seam every suite reads — `TrialArtifacts.usage` — and the
 * sweep covers every suite that has no richer source of its own.
 *
 * What it does not catch: whether the coding agent's own cost accounting is
 * correct (that is `SessionStats.cost`, owned by the session), and whether harbor
 * parses `cost_usd` out of a real harbor result (covered by the harbor suites).
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import { TempDir } from "@veyyon/utils";
import { InProcessBackend } from "../../src/backends/in-process/backend";
import type {
	EvalSuite,
	RunContext,
	SuiteProvenance,
	TaskDescriptor,
	TrialArtifacts,
	TrialCell,
	TrialScore,
	Variant,
} from "../../src/core/types";
import { typescriptEditSuite } from "../../src/suites/typescript-edit/suite";

function probeSuite(): EvalSuite {
	return {
		name: "spend-probe",
		version: "1.0.0",
		displayName: "Spend Probe",
		description: "Records what the backend reported",
		backend: "in-process",
		async discoverTasks() {
			return ["task-1"];
		},
		async describeTask(taskId: string): Promise<TaskDescriptor> {
			return {
				id: taskId,
				path: null,
				timeBudgetSec: 30,
				instructionPath: null,
				metadata: { prompt: "do the thing", files: [] },
			};
		},
		async provenance(): Promise<SuiteProvenance> {
			return { suite: "spend-probe", version: "1.0.0" };
		},
		async scoreTrial(cell: TrialCell, artifacts: TrialArtifacts): Promise<TrialScore> {
			return { reward: 1, partial: null, error: null, usage: artifacts.usage ?? null, extra: { cell } };
		},
		async preflight() {
			return { ok: true };
		},
	};
}

async function runOneTrial(cost: number): Promise<TrialArtifacts> {
	const tempDir = await TempDir.create("@evals-test-spend-");
	try {
		const configFile = tempDir.join("arm.yml");
		await fs.writeFile(configFile, "argot:\n  enabled: false\n");
		const backend = new InProcessBackend({
			clientFactory: () => ({
				async start() {},
				async prompt() {},
				async getSessionStats() {
					return {
						tokens: { input: 1200, output: 340, cacheRead: 900, cacheWrite: 100, total: 2540 },
						assistantMessages: 2,
						cost,
					};
				},
				async getLastAssistantText() {
					return "done";
				},
				async dispose() {},
			}),
		});
		const variant: Variant = {
			name: "spend-arm",
			harness: "veyyon",
			configPath: configFile,
			promptVariantPath: null,
			model: "anthropic/claude-sonnet-4-6",
			attachments: [],
		};
		const context: RunContext = {
			runId: "spend-run",
			suite: probeSuite(),
			workDir: tempDir.absolute(),
			runsDir: tempDir.join("runs"),
			options: { variants: [variant] },
		};
		const cell: TrialCell = { suite: "spend-probe", variant: "spend-arm", task: "task-1", repeat: 1 };
		return await backend.runTrial(cell, context);
	} finally {
		await tempDir.remove();
	}
}

describe("a trial reports its spend or reports nothing", () => {
	it("carries the session's provider spend and token counts out of the backend", async () => {
		const artifacts = await runOneTrial(0.4213);

		expect(artifacts.usage?.costUsd).toBe(0.4213);
		expect(artifacts.usage?.inputTokens).toBe(1200);
		expect(artifacts.usage?.outputTokens).toBe(340);
		expect(artifacts.usage?.cacheReadTokens).toBe(900);
		expect(artifacts.usage?.cacheWriteTokens).toBe(100);
		expect(artifacts.usage?.cacheTokens).toBe(1000);
		expect(artifacts.usage?.durationSec).toBeGreaterThanOrEqual(0);
	});

	it("reports an unpriced model's spend as absent rather than as zero dollars", async () => {
		const artifacts = await runOneTrial(0);

		// A model with no pricing metadata accumulates 0. Reporting that as a number
		// makes an arm look free; a reader has to be able to tell unknown from free.
		expect(artifacts.usage?.costUsd).toBeNull();
		expect(artifacts.usage?.inputTokens).toBe(1200);
	});

	it("hands the backend's usage to the suite that has no richer source of its own", async () => {
		const artifacts = await runOneTrial(0.77);
		const cell: TrialCell = { suite: "spend-probe", variant: "spend-arm", task: "task-1", repeat: 1 };

		// typescript-edit's only usage source is the backend. Its failure paths must
		// carry it too: a trial that errors still cost money.
		const score = await typescriptEditSuite.scoreTrial(cell, {
			...artifacts,
			trialDir: undefined,
		});

		expect(score.reward).toBeNull();
		expect(score.usage?.costUsd).toBe(0.77);
	});
});
