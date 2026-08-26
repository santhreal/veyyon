/**
 * WHY: Harbor containers may OOM, crash, or fail to start while still creating a trial
 * directory on disk. Previously, `runTrial` checked `if (exitCode !== 0 && !trialDir) throw`,
 * which silently tolerated non-zero exits whenever a trial directory existed and caused
 * infrastructure crashes to be graded as task score 0 instead of infrastructure error.
 *
 * This suite proves that any non-zero exit code throws an error naming the exit code
 * and output tail, failing closed unless `allowPartialResults: true` is explicitly opted in.
 */

import { afterEach, describe, expect, it, type Mock, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { HarborBackend } from "../../../src/backends/harbor/backend";
import type { EvalSuite, RunContext, TaskDescriptor, TrialCell, Variant } from "../../../src/core/types";
import "../../../src/harnesses";

/** One fully specified matrix member; the trial's identity is irrelevant to an exit-code check. */
const FIXTURE_VARIANT: Variant = {
	name: "default",
	harness: "veyyon",
	configPath: null,
	promptVariantPath: null,
	model: "anthropic/claude-opus-4-8",
	attachments: [],
};

describe("a non-zero harbor exit code is an infrastructure failure", () => {
	let tempDir: string | null = null;
	let spawnSpy: Mock<typeof Bun.spawn> | null = null;

	afterEach(async () => {
		spawnSpy?.mockRestore();
		spawnSpy = null;
		if (tempDir) {
			await fs.rm(tempDir, { recursive: true, force: true });
			tempDir = null;
		}
	});

	function createSuite(taskPath: string): EvalSuite {
		return {
			name: "terminal-bench",
			version: "1.0.0",
			displayName: "Terminal Bench",
			description: "Terminal benchmark suite",
			backend: "harbor",
			async discoverTasks(): Promise<readonly string[]> {
				return ["sample-task"];
			},
			async describeTask(taskId: string): Promise<TaskDescriptor> {
				return {
					id: taskId,
					path: taskPath,
					timeBudgetSec: 60,
					instructionPath: null,
					metadata: {
						cpus: 1,
						memory_mb: 512,
						storage_mb: 1024,
						gpus: 0,
					},
				};
			},
			async provenance() {
				return { suite: "terminal-bench", version: "1.0.0" };
			},
			async scoreTrial() {
				return { reward: 0, partial: 0, error: null, usage: null, extra: {} };
			},
			async preflight() {
				return { ok: true };
			},
		};
	}

	function mockProc(exitCode: number, stdoutText: string, stderrText: string) {
		const stdoutStream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(stdoutText));
				controller.close();
			},
		});
		const stderrStream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(stderrText));
				controller.close();
			},
		});

		return {
			exited: Promise.resolve(exitCode),
			stdout: stdoutStream,
			stderr: stderrStream,
			kill() {},
			pid: 12345,
			ref() {},
			unref() {},
		};
	}

	it("throws when harbor exits with a non-zero code even if trialDir exists on disk", async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "harbor-nonzero-test-"));
		const runsDir = path.join(tempDir, "runs");
		const workDir = path.join(tempDir, "work");
		const taskPath = path.join(tempDir, "task");
		await fs.mkdir(runsDir, { recursive: true });
		await fs.mkdir(workDir, { recursive: true });
		await fs.mkdir(taskPath, { recursive: true });

		const backend = new HarborBackend({
			which: bin => (bin === "harbor" ? "/usr/local/bin/harbor" : "/usr/bin/docker"),
			gatewayHealth: () => true,
		});

		const cell: TrialCell = {
			suite: "terminal-bench",
			task: "sample-task",
			variant: "default",
			repeat: 0,
		};

		const context: RunContext = {
			runId: "run-nonzero-1",
			suite: createSuite(taskPath),
			workDir,
			runsDir,
			options: {
				agent: "oracle",
				variants: [FIXTURE_VARIANT],
			},
		};

		// Spy on Bun.spawn to simulate Harbor exiting with 137 (OOM) while writing a trial dir
		spawnSpy = spyOn(Bun, "spawn").mockImplementation(((args: readonly string[]) => {
			const jobDirIdx = args.indexOf("-o");
			const jobNameIdx = args.indexOf("--job-name");
			if (jobDirIdx !== -1 && jobNameIdx !== -1) {
				const currentJobDir = path.join(args[jobDirIdx + 1], args[jobNameIdx + 1]);
				void fs.mkdir(path.join(currentJobDir, "sample-task__trial1"), { recursive: true });
			}
			return mockProc(137, "Container memory limit exceeded", "Killed (OOM)");
		}) as unknown as typeof Bun.spawn);

		let thrown: Error | null = null;
		try {
			await backend.runTrial(cell, context);
		} catch (error) {
			thrown = error instanceof Error ? error : new Error(String(error));
		}

		expect(thrown).not.toBeNull();
		expect(thrown?.message).toContain("Harbor run failed with exit code 137");
		expect(thrown?.message).toContain("Killed (OOM)");
	});

	it("allows returning trial artifacts when allowPartialResults is explicitly enabled", async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "harbor-nonzero-test-"));
		const runsDir = path.join(tempDir, "runs");
		const workDir = path.join(tempDir, "work");
		const taskPath = path.join(tempDir, "task");
		await fs.mkdir(runsDir, { recursive: true });
		await fs.mkdir(workDir, { recursive: true });
		await fs.mkdir(taskPath, { recursive: true });

		const backend = new HarborBackend({
			which: bin => (bin === "harbor" ? "/usr/local/bin/harbor" : "/usr/bin/docker"),
			gatewayHealth: () => true,
		});

		const cell: TrialCell = {
			suite: "terminal-bench",
			task: "sample-task",
			variant: "default",
			repeat: 0,
		};

		const context: RunContext = {
			runId: "run-nonzero-2",
			suite: createSuite(taskPath),
			workDir,
			runsDir,
			options: {
				agent: "oracle",
				allowPartialResults: true,
				variants: [FIXTURE_VARIANT],
			},
		};

		spawnSpy = spyOn(Bun, "spawn").mockImplementation((() => {
			return mockProc(1, "Partial output", "Non-fatal stderr");
		}) as unknown as typeof Bun.spawn);

		const artifacts = await backend.runTrial(cell, context);
		expect(artifacts.extra?.exitCode).toBe(1);
		expect(artifacts.rawOutput).toContain("Partial output");
	});
});
