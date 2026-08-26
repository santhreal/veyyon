import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@veyyon/utils";
import {
	capRawOutputTail,
	DEFAULT_TRIAL_TIMEOUT_SEC,
	HARD_CEILING_TRIAL_TIMEOUT_SEC,
	InProcessBackend,
	RAW_OUTPUT_TAIL_CAP_BYTES,
} from "../../../src/backends/in-process/backend";
import type {
	EvalSuite,
	RunContext,
	SuiteProvenance,
	TaskDescriptor,
	TrialArtifacts,
	TrialCell,
	TrialScore,
	Variant,
} from "../../../src/core/types";

function createDeadlineProbeSuite(timeBudgetSec = 1): EvalSuite {
	return {
		name: "deadline-probe-suite",
		version: "1.0.0",
		displayName: "Deadline Probe Suite",
		description: "Suite for testing deadline termination and artifact paths",
		backend: "in-process",
		async discoverTasks() {
			return ["deadline-task"];
		},
		async describeTask(taskId: string): Promise<TaskDescriptor> {
			return {
				id: taskId,
				path: null,
				timeBudgetSec,
				instructionPath: null,
				metadata: {
					prompt: "Perform task",
					files: [],
				},
			};
		},
		async provenance(): Promise<SuiteProvenance> {
			return { suite: "deadline-probe-suite", version: "1.0.0" };
		},
		async scoreTrial(_cell: TrialCell, artifacts: TrialArtifacts): Promise<TrialScore> {
			if (artifacts.extra?.error) {
				return {
					reward: null,
					partial: null,
					error: String(artifacts.extra.error),
					usage: null,
					extra: { infrastructureError: artifacts.extra.infrastructureError },
				};
			}
			return {
				reward: 1,
				partial: 1,
				error: null,
				usage: null,
				extra: {},
			};
		},
		async preflight() {
			return { ok: true };
		},
	};
}

describe("InProcessBackend — trial deadline and artifact paths", () => {
	it("terminates a wedged trial at deadline and reports infrastructure error, not reward 0", async () => {
		const tempDir = await TempDir.create("@evals-test-trial-deadline-");
		try {
			const suite = createDeadlineProbeSuite(1); // 1 second deadline
			const { promise: neverResolves } = Promise.withResolvers<void>();
			let aborted = false;

			const backend = new InProcessBackend({
				clientFactory: () => ({
					async start() {},
					async prompt() {
						await neverResolves;
					},
					async getSessionStats() {
						return { tokens: { input: 0, output: 0, total: 0 }, assistantMessages: 0 };
					},
					async getLastAssistantText() {
						return null;
					},
					abort() {
						aborted = true;
					},
					async dispose() {},
				}),
			});

			const variants: readonly Variant[] = [
				{
					name: "default",
					harness: "veyyon",
					configPath: null,
					promptVariantPath: null,
					model: "anthropic/claude-sonnet-4-6",
					attachments: [],
				},
			];

			const context: RunContext = {
				runId: "deadline-run",
				suite,
				workDir: tempDir.absolute(),
				runsDir: tempDir.join("runs"),
				options: { variants, trialTimeoutSec: 1 },
			};

			const cell: TrialCell = {
				suite: "deadline-probe-suite",
				variant: "default",
				task: "deadline-task",
				repeat: 0,
			};

			const startTime = Date.now();
			const artifacts = await backend.runTrial(cell, context);
			const elapsedMs = Date.now() - startTime;

			// Assert bounded execution time (1s deadline + grace buffer < 3s)
			expect(elapsedMs).toBeLessThan(3500);
			expect(aborted).toBe(true);
			expect(artifacts.extra?.timedOut).toBe(true);
			expect(artifacts.extra?.error).toContain("Trial exceeded deadline of 1s");
			expect(artifacts.extra?.infrastructureError).toContain("Trial exceeded deadline of 1s");

			// Score the trial: verify it produces an infrastructure error with null reward, NOT reward 0
			const score = await suite.scoreTrial(cell, artifacts);
			expect(score.reward).toBeNull();
			expect(score.error).toContain("Trial exceeded deadline of 1s");
		} finally {
			await tempDir.remove();
		}
	});

	it("returns disk paths for files and caps raw output tail at 64 KiB", async () => {
		const tempDir = await TempDir.create("@evals-test-artifact-paths-");
		try {
			const suite = createDeadlineProbeSuite(30);

			// Generate large output text (> 64 KiB) with a recognizable tail marker
			const largePrefix = "X".repeat(80 * 1024);
			const expectedTail = "TAIL_DISTINCT_OUTPUT_MARKER_FINISHED";
			const fullOutput = `${largePrefix}\n${expectedTail}`;

			const backend = new InProcessBackend({
				clientFactory: options => ({
					async start() {
						// Create actual files on disk in trialDir
						await fs.writeFile(path.join(options.cwd, "output.txt"), "hello world");
						await fs.mkdir(path.join(options.cwd, "nested"), { recursive: true });
						await fs.writeFile(path.join(options.cwd, "nested", "data.json"), '{"key":"value"}');
					},
					async prompt() {},
					async getSessionStats() {
						return { tokens: { input: 100, output: 50, total: 150 }, assistantMessages: 1 };
					},
					async getLastAssistantText() {
						return fullOutput;
					},
					async dispose() {},
				}),
			});

			const variants: readonly Variant[] = [
				{
					name: "default",
					harness: "veyyon",
					configPath: null,
					promptVariantPath: null,
					model: "anthropic/claude-sonnet-4-6",
					attachments: [],
				},
			];

			const context: RunContext = {
				runId: "artifact-paths-run",
				suite,
				workDir: tempDir.absolute(),
				runsDir: tempDir.join("runs"),
				options: { variants },
			};

			const cell: TrialCell = {
				suite: "deadline-probe-suite",
				variant: "default",
				task: "deadline-task",
				repeat: 0,
			};

			const artifacts = await backend.runTrial(cell, context);

			// 1. filePaths carries disk paths, not file contents
			expect(artifacts.filePaths).toBeDefined();
			const filePaths = artifacts.filePaths as Record<string, string>;
			expect(filePaths["output.txt"]).toBe(path.join(artifacts.trialDir!, "output.txt"));
			expect(filePaths["nested/data.json"]).toBe(path.join(artifacts.trialDir!, "nested/data.json"));
			expect(path.isAbsolute(filePaths["output.txt"])).toBe(true);
			expect(path.isAbsolute(filePaths["nested/data.json"])).toBe(true);
			// 2. rawOutput is capped to <= 64 KiB and contains the tail
			expect(artifacts.rawOutput).toBeDefined();
			const rawOutputBytes = Buffer.from(artifacts.rawOutput!, "utf-8").byteLength;
			expect(rawOutputBytes).toBeLessThanOrEqual(RAW_OUTPUT_TAIL_CAP_BYTES);
			expect(artifacts.rawOutput).toContain(expectedTail);
			// The start of the large prefix was trimmed away
			expect(artifacts.rawOutput?.length).toBeLessThan(fullOutput.length);
		} finally {
			await tempDir.remove();
		}
	});

	it("capRawOutputTail helper bounds strings correctly", () => {
		expect(capRawOutputTail(null)).toBeNull();
		expect(capRawOutputTail(undefined)).toBeNull();
		expect(capRawOutputTail("short text", 64)).toBe("short text");

		const longText = "A".repeat(100) + "B".repeat(100);
		const capped = capRawOutputTail(longText, 50);
		expect(capped).toBe("B".repeat(50));
	});

	it("defines observable timeout defaults and ceilings", () => {
		expect(DEFAULT_TRIAL_TIMEOUT_SEC).toBe(1800);
		expect(HARD_CEILING_TRIAL_TIMEOUT_SEC).toBe(7200);
		expect(RAW_OUTPUT_TAIL_CAP_BYTES).toBe(65536);
	});
});
