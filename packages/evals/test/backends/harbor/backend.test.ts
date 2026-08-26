import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	HarborBackend,
	harborBackend,
	parseVariant,
	registerHarborBackend,
} from "../../../src/backends/harbor/backend";
import { buildHarborArgs } from "../../../src/backends/harbor/launch-args";
import { BackendRegistry, defaultBackendRegistry } from "../../../src/core/backend-registry";
import type {
	EvalSuite,
	PreflightVerdict,
	RunContext,
	SuiteProvenance,
	TaskDescriptor,
	TrialCell,
	TrialScore,
} from "../../../src/core/types";

function createMockSuite(overrides: Partial<EvalSuite> = {}): EvalSuite {
	return {
		name: "mock-suite",
		version: "1.0.0",
		displayName: "Mock Suite",
		description: "Mock Suite Description",
		backend: "harbor",
		async discoverTasks(): Promise<readonly string[]> {
			return ["mock-task-1"];
		},
		async describeTask(taskId: string): Promise<TaskDescriptor> {
			return {
				id: taskId,
				path: `/tmp/mock-tasks/${taskId}`,
				timeBudgetSec: 300,
				instructionPath: null,
				metadata: {
					cpus: 2,
					memory_mb: 2048,
					storage_mb: 4096,
					gpus: 0,
					artifacts: ["manifest.json"],
				},
			};
		},
		async provenance(): Promise<SuiteProvenance> {
			return {
				suite: "mock-suite",
				version: "1.0.0",
			};
		},
		async scoreTrial(): Promise<TrialScore> {
			return {
				reward: 1,
				partial: 1,
				error: null,
				usage: null,
				extra: {},
			};
		},
		async preflight(): Promise<PreflightVerdict> {
			return { ok: true };
		},
		...overrides,
	};
}

describe("HarborBackend preflight", () => {
	it("passes when harbor binary and docker are accessible", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "harbor-preflight-pass-"));
		try {
			const backend = new HarborBackend({
				which: bin => (bin === "harbor" ? "/usr/local/bin/harbor" : bin === "docker" ? "/usr/bin/docker" : null),
				exec: async (file, args) => {
					if (file === "/usr/bin/docker" && args[0] === "info") {
						return { stdout: "Server Version: 29.2.1", stderr: "" };
					}
					return { stdout: "", stderr: "" };
				},
			});

			const context: RunContext = {
				runId: "test-run",
				suite: createMockSuite(),
				workDir: tempDir,
				runsDir: tempDir,
			};

			const verdict = await backend.preflight(context);
			expect(verdict.ok).toBe(true);
			expect(verdict.reason).toBeUndefined();
			expect(verdict.missingRequirements).toBeUndefined();
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("fails closed with actionable message and missingRequirements when harbor is not on PATH", async () => {
		const backend = new HarborBackend({
			which: bin => (bin === "harbor" ? null : "/usr/bin/docker"),
			exec: async () => ({ stdout: "ok", stderr: "" }),
		});

		const context: RunContext = {
			runId: "test-run",
			suite: createMockSuite(),
			workDir: "/tmp",
			runsDir: "/tmp",
		};

		const verdict = await backend.preflight(context);
		expect(verdict.ok).toBe(false);
		expect(verdict.reason).toContain("harbor not found on PATH. Install with: uv tool install harbor");
		expect(verdict.missingRequirements).toEqual(["harbor"]);
	});

	it("fails closed with actionable message and missingRequirements when docker binary is not on PATH", async () => {
		const backend = new HarborBackend({
			which: bin => (bin === "harbor" ? "/usr/local/bin/harbor" : null),
			exec: async () => ({ stdout: "ok", stderr: "" }),
		});

		const context: RunContext = {
			runId: "test-run",
			suite: createMockSuite(),
			workDir: "/tmp",
			runsDir: "/tmp",
			options: { envType: "docker" },
		};

		const verdict = await backend.preflight(context);
		expect(verdict.ok).toBe(false);
		expect(verdict.reason).toContain("docker not found on PATH (required to run task containers).");
		expect(verdict.missingRequirements).toEqual(["docker"]);
	});

	it("fails closed when docker daemon is not accessible", async () => {
		const backend = new HarborBackend({
			which: bin => (bin === "harbor" ? "/usr/local/bin/harbor" : "/usr/bin/docker"),
			exec: async () => {
				throw new Error("Cannot connect to the Docker daemon at unix:///var/run/docker.sock");
			},
		});

		const context: RunContext = {
			runId: "test-run",
			suite: createMockSuite(),
			workDir: "/tmp",
			runsDir: "/tmp",
		};

		const verdict = await backend.preflight(context);
		expect(verdict.ok).toBe(false);
		expect(verdict.reason).toContain("Docker daemon is not accessible");
		expect(verdict.missingRequirements).toEqual(["docker-daemon"]);
	});

	it("fails closed when apple-container CLI is missing", async () => {
		const backend = new HarborBackend({
			which: bin => (bin === "harbor" ? "/usr/local/bin/harbor" : null),
			exec: async () => ({ stdout: "", stderr: "" }),
		});

		const context: RunContext = {
			runId: "test-run",
			suite: createMockSuite(),
			workDir: "/tmp",
			runsDir: "/tmp",
			options: { envType: "apple-container" },
		};

		const verdict = await backend.preflight(context);
		expect(verdict.ok).toBe(false);
		expect(verdict.reason).toContain("Apple 'container' CLI not found");
		expect(verdict.missingRequirements).toEqual(["container"]);
	});

	it("fails closed when jobs directory cannot be created", async () => {
		const backend = new HarborBackend({
			which: bin => (bin === "harbor" ? "/usr/local/bin/harbor" : "/usr/bin/docker"),
			exec: async () => ({ stdout: "ok", stderr: "" }),
		});

		const context: RunContext = {
			runId: "test-run",
			suite: createMockSuite(),
			workDir: "/tmp",
			runsDir: "/dev/null/uncreatable/jobs/dir",
		};

		const verdict = await backend.preflight(context);
		expect(verdict.ok).toBe(false);
		expect(verdict.reason).toContain("Failed to create or access jobs directory");
		expect(verdict.missingRequirements).toEqual(["jobs-dir"]);
	});
});

describe("parseVariant mapping", () => {
	it("parses oracle variant", () => {
		expect(parseVariant("oracle")).toEqual({ agent: "oracle", model: undefined });
		expect(parseVariant("oracle@anthropic/claude-sonnet-4-6")).toEqual({
			agent: "oracle",
			model: "anthropic/claude-sonnet-4-6",
		});
		expect(parseVariant("", { agent: "oracle" })).toEqual({ agent: "oracle", model: undefined });
	});

	it("parses nop variant", () => {
		expect(parseVariant("nop")).toEqual({ agent: "nop", model: undefined });
	});

	it("parses model-only variant to veyyon agent with model", () => {
		expect(parseVariant("anthropic/claude-sonnet-4-6")).toEqual({
			agent: "veyyon",
			model: "anthropic/claude-sonnet-4-6",
		});
	});

	it("parses compound agent@model variant", () => {
		expect(parseVariant("veyyon@openai/gpt-4o")).toEqual({
			agent: "veyyon",
			model: "openai/gpt-4o",
		});
		expect(parseVariant("custom-harness:config@anthropic/claude-3-5-sonnet")).toEqual({
			agent: "custom-harness",
			model: "anthropic/claude-3-5-sonnet",
		});
	});

	it("honors explicit options overrides", () => {
		expect(parseVariant("default", { agent: "oracle", model: "custom-model" })).toEqual({
			agent: "oracle",
			model: "custom-model",
		});
	});
});

describe("buildHarborArgs shared construction", () => {
	it("builds single trial task path invocation", () => {
		const args = buildHarborArgs({
			taskPath: "/datasets/terminal-bench/tasks/bun-sourcemap-leak",
			jobsDir: "/runs/run-1",
			jobName: "oracle__bun-sourcemap-leak__r0",
			concurrency: 1,
			attempts: 1,
			tasks: 1,
			agent: "oracle",
			yes: true,
			overrideCpus: 2,
			overrideMemoryMb: 2048,
			overrideStorageMb: 4096,
			overrideGpus: 1,
			artifacts: ["manifest.json", "model.patch"],
			disableVerification: false,
		});

		expect(args).toEqual([
			"run",
			"-p",
			"/datasets/terminal-bench/tasks/bun-sourcemap-leak",
			"-o",
			"/runs/run-1",
			"--job-name",
			"oracle__bun-sourcemap-leak__r0",
			"-n",
			"1",
			"-k",
			"1",
			"-l",
			"1",
			"-y",
			"--override-cpus",
			"2",
			"--override-memory-mb",
			"2048",
			"--override-storage-mb",
			"4096",
			"--override-gpus",
			"1",
			"--artifact",
			"manifest.json",
			"--artifact",
			"model.patch",
			"-a",
			"oracle",
		]);
	});

	it("builds dataset-based veyyon invocation with agent import path", () => {
		const args = buildHarborArgs({
			dataset: "terminal-bench@3.0",
			jobsDir: "/runs/run-2",
			jobName: "veyyon-run",
			concurrency: 4,
			attempts: 1,
			tasks: 20,
			models: ["anthropic/claude-sonnet-4-6"],
			agent: "veyyon",
			include: ["task-1", "task-2"],
			allowHosts: ["api.anthropic.com"],
			timeoutMultiplier: 1.5,
			yes: true,
		});

		expect(args).toEqual([
			"run",
			"-d",
			"terminal-bench@3.0",
			"-o",
			"/runs/run-2",
			"--job-name",
			"veyyon-run",
			"-n",
			"4",
			"-k",
			"1",
			"-l",
			"20",
			"-m",
			"anthropic/claude-sonnet-4-6",
			"-i",
			"task-1",
			"-i",
			"task-2",
			"--allow-agent-host",
			"api.anthropic.com",
			"--timeout-multiplier",
			"1.5",
			"-y",
			"--agent-import-path",
			"veyyon_local:VeyyonLocal",
		]);
	});
});

describe("HarborBackend registration", () => {
	it("registers harborBackend into backend registry idempotently", () => {
		const customRegistry = new BackendRegistry();
		expect(customRegistry.has("harbor")).toBe(false);

		registerHarborBackend(customRegistry);
		expect(customRegistry.has("harbor")).toBe(true);
		expect(customRegistry.get("harbor")).toBe(harborBackend);

		// Calling again must not throw DuplicateBackendRegistrationError
		expect(() => registerHarborBackend(customRegistry)).not.toThrow();
		expect(customRegistry.listIds()).toEqual(["harbor"]);
	});

	it("is registered in defaultBackendRegistry by default", () => {
		expect(defaultBackendRegistry.has("harbor")).toBe(true);
		expect(defaultBackendRegistry.get("harbor")?.id).toBe("harbor");
	});
});

describe("HarborBackend cleanup", () => {
	it("runs cleanup safely without throwing", async () => {
		const backend = new HarborBackend({
			which: () => "/usr/bin/docker",
		});
		const cell: TrialCell = {
			variant: "oracle",
			suite: "terminal-bench",
			task: "bun-sourcemap-leak",
			repeat: 0,
		};
		const context: RunContext = {
			runId: "cleanup-test-run",
			suite: createMockSuite(),
			workDir: "/tmp",
			runsDir: "/tmp",
			options: { cleanup: true },
		};

		await expect(backend.cleanup(cell, context)).resolves.toBeUndefined();
	});
});

describe("HarborBackend runTrial abort handling", () => {
	it("rejects immediately if signal is already aborted", async () => {
		const backend = new HarborBackend();
		const controller = new AbortController();
		controller.abort();

		const cell: TrialCell = {
			variant: "oracle",
			suite: "mock-suite",
			task: "mock-task-1",
			repeat: 0,
		};
		const context: RunContext = {
			runId: "abort-test-run",
			suite: createMockSuite(),
			workDir: "/tmp",
			runsDir: "/tmp",
			signal: controller.signal,
		};

		await expect(backend.runTrial(cell, context)).rejects.toThrow(/aborted/);
	});
});
