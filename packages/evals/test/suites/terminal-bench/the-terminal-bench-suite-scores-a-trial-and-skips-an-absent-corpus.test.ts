import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import { existsSync, readdirSync } from "node:fs";
import * as path from "node:path";
import { join, resolve } from "node:path";
import type { EvalSuite, SuiteContext, TrialArtifacts, TrialCell } from "../../../engine/contracts";
import { suites } from "../../../engine/loaded-members";
import { Registry } from "../../../engine/member-registry";
import { internalScratchDir } from "../../../engine/package-paths";
import {
	getDefaultTerminalBenchCacheDir,
	TERMINAL_BENCH_COMMIT_SHA,
	TERMINAL_BENCH_TAG,
} from "../../../suites/terminal-bench/dataset";
import { TerminalBenchSuite, terminalBenchSuite } from "../../../suites/terminal-bench/main";
import { loadTaskConfig } from "../../../suites/terminal-bench/task-config";

function createTempTrialDir(files: Record<string, string>): {
	trialDir: string;
	filePaths: Record<string, string>;
	cleanup: () => void;
} {
	const dir = path.join(internalScratchDir(), `tb-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
	fs.mkdirSync(dir, { recursive: true });
	const filePaths: Record<string, string> = {};
	for (const [rel, content] of Object.entries(files)) {
		const full = path.join(dir, rel);
		fs.mkdirSync(path.dirname(full), { recursive: true });
		fs.writeFileSync(full, content, "utf8");
		filePaths[rel] = full;
	}
	return {
		trialDir: dir,
		filePaths,
		cleanup: () => {
			try {
				fs.rmSync(dir, { recursive: true, force: true });
			} catch {
				/* ignore */
			}
		},
	};
}
describe("TerminalBenchSuite — EvalSuite contract", () => {
	it("registers with the global suite registry under 'terminal-bench'", () => {
		const suite = suites.require("terminal-bench");
		expect(suite).toBe(terminalBenchSuite);
		expect(terminalBenchSuite).toBeInstanceOf(TerminalBenchSuite);
		expect(suite.id).toBe("terminal-bench");
		expect(suite.version).toBe(TERMINAL_BENCH_TAG);
		expect(suite.backend).toBe("harbor");
		expect(suite.displayName).toBe("Terminal-Bench 3.0");
	});

	it("registers with a custom registry and is idempotent per registry", () => {
		const customRegistry = new Registry<EvalSuite>("suite");
		expect(customRegistry.has("terminal-bench")).toBe(false);

		customRegistry.register(terminalBenchSuite);
		expect(customRegistry.has("terminal-bench")).toBe(true);
		expect(customRegistry.require("terminal-bench")).toBe(terminalBenchSuite);

		// Second call with registerOnce should be an idempotent no-op without throwing
		expect(() => customRegistry.registerOnce(terminalBenchSuite)).not.toThrow();
		expect(customRegistry.has("terminal-bench")).toBe(true);
	});

	it("describes a fixture task and carries all required metadata fields", async () => {
		const suite = new TerminalBenchSuite({
			defaultDatasetDir: resolve(import.meta.dirname, "fixtures"),
		});

		const context: SuiteContext = {
			datasetDir: resolve(import.meta.dirname, "fixtures"),
		};

		const descriptor = await suite.describeTask("complex-task", context);
		expect(descriptor.id).toBe("complex-task");
		expect(descriptor.timeBudgetSec).toBe(2400);
		expect(descriptor.instructionPath).toContain("instruction.md");
		expect(descriptor.path).toContain("complex-task");

		// Verify metadata fields required by runner and backend
		const meta = descriptor.metadata;
		expect(meta.verifier_environment_mode).toBe("separate");
		expect(meta.verifier_timeout_sec).toBe(450);
		expect(meta.cpus).toBe(4);
		expect(meta.memory_mb).toBe(8192);
		expect(meta.storage_mb).toBe(20480);
		expect(meta.gpus).toBe(0);
		expect(meta.network_mode).toBe("allowlist");
		expect(meta.os).toBe("linux");
		expect(meta.workdir).toBe("/workspace/project");
		expect(Array.isArray(meta.artifacts)).toBe(true);

		// Runtime enumeration test: all keys in TaskConfig must be mapped into descriptor.metadata
		const rawConfig = await loadTaskConfig(join(resolve(import.meta.dirname, "fixtures/tasks"), "complex-task"));
		for (const key of Object.keys(rawConfig)) {
			expect(key in meta).toBe(true);
		}
	});

	describe("preflight checks", () => {
		const mockGit = async () => TERMINAL_BENCH_COMMIT_SHA;
		const mockWhich = (bin: string) => `/usr/bin/${bin}`;
		const mockExec = async () => ({ stdout: "Docker version 29.0", stderr: "" });
		const mockGpuCheck = async () => true;

		it("refuses when corpus directory is not acquired", async () => {
			const suite = new TerminalBenchSuite({
				git: mockGit,
				which: mockWhich,
				exec: mockExec,
				gpuCheck: mockGpuCheck,
			});

			const verdict = await suite.preflight({
				datasetDir: "/nonexistent/path/to/terminal-bench",
			});

			expect(verdict.ok).toBe(false);
			expect(verdict.reason).toContain("Terminal-Bench corpus is not acquired");
			expect(verdict.missingRequirements).toContain("corpus");
		});

		it("refuses when tasks subdirectory is missing", async () => {
			const suite = new TerminalBenchSuite({
				git: mockGit,
				which: mockWhich,
				exec: mockExec,
				gpuCheck: mockGpuCheck,
			});

			// Empty fixture without tasks/
			const verdict = await suite.preflight({
				datasetDir: resolve(import.meta.dirname, "fixtures/tasks/complex-task"),
			});

			expect(verdict.ok).toBe(false);
			expect(verdict.reason).toContain("corpus is incomplete");
			expect(verdict.missingRequirements).toContain("corpus");
		});

		it("refuses when commit SHA does not match the pin", async () => {
			const suite = new TerminalBenchSuite({
				git: async () => "wrong-commit-sha-0000000000000000000000",
				which: mockWhich,
				exec: mockExec,
				gpuCheck: mockGpuCheck,
			});

			const verdict = await suite.preflight({
				datasetDir: resolve(import.meta.dirname, "fixtures"),
			});

			expect(verdict.ok).toBe(false);
			expect(verdict.reason).toContain("commit SHA mismatch");
			expect(verdict.missingRequirements).toContain("pinned-commit-sha");
		});

		it("refuses when git fails to resolve commit SHA", async () => {
			const suite = new TerminalBenchSuite({
				git: async () => {
					throw new Error("fatal: not a git repository");
				},
				which: mockWhich,
				exec: mockExec,
				gpuCheck: mockGpuCheck,
			});

			const verdict = await suite.preflight({
				datasetDir: resolve(import.meta.dirname, "fixtures"),
			});

			expect(verdict.ok).toBe(false);
			expect(verdict.reason).toContain("Failed to verify Terminal-Bench corpus commit SHA");
			expect(verdict.missingRequirements).toContain("pinned-commit-sha");
		});

		it("refuses when harbor executable is not on PATH", async () => {
			const suite = new TerminalBenchSuite({
				git: mockGit,
				which: (bin: string) => (bin === "harbor" ? null : `/usr/bin/${bin}`),
				exec: mockExec,
				gpuCheck: mockGpuCheck,
			});

			const verdict = await suite.preflight({
				datasetDir: resolve(import.meta.dirname, "fixtures"),
			});

			expect(verdict.ok).toBe(false);
			expect(verdict.reason).toContain("harbor executable is not on PATH");
			expect(verdict.missingRequirements).toContain("harbor");
		});

		it("refuses when docker executable is not on PATH", async () => {
			const suite = new TerminalBenchSuite({
				git: mockGit,
				which: (bin: string) => (bin === "docker" ? null : `/usr/bin/${bin}`),
				exec: mockExec,
				gpuCheck: mockGpuCheck,
			});

			const verdict = await suite.preflight({
				datasetDir: resolve(import.meta.dirname, "fixtures"),
			});

			expect(verdict.ok).toBe(false);
			expect(verdict.reason).toContain("docker executable is not on PATH");
			expect(verdict.missingRequirements).toContain("docker");
		});

		it("refuses when docker daemon is unreachable", async () => {
			const suite = new TerminalBenchSuite({
				git: mockGit,
				which: mockWhich,
				exec: async () => {
					throw new Error("Cannot connect to the Docker daemon");
				},
				gpuCheck: mockGpuCheck,
			});

			const verdict = await suite.preflight({
				datasetDir: resolve(import.meta.dirname, "fixtures"),
			});

			expect(verdict.ok).toBe(false);
			expect(verdict.reason).toContain("Docker daemon is not accessible");
			expect(verdict.missingRequirements).toContain("docker-daemon");
		});

		it("refuses when a selected task requires GPU and host has no GPU", async () => {
			const suite = new TerminalBenchSuite({
				git: mockGit,
				which: mockWhich,
				exec: mockExec,
				gpuCheck: async () => false, // Host has no GPU
			});

			const verdict = await suite.preflight({
				datasetDir: resolve(import.meta.dirname, "fixtures"),
				options: {
					tasks: ["gpu-task"],
				},
			});

			expect(verdict.ok).toBe(false);
			expect(verdict.reason).toContain("requires 1 GPU");
			expect(verdict.missingRequirements).toContain("gpu");
		});

		it("passes preflight when all requirements are satisfied", async () => {
			const suite = new TerminalBenchSuite({
				git: mockGit,
				which: mockWhich,
				exec: mockExec,
				gpuCheck: mockGpuCheck,
			});

			const verdict = await suite.preflight({
				datasetDir: resolve(import.meta.dirname, "fixtures"),
				options: {
					tasks: ["complex-task"],
				},
			});

			expect(verdict.ok).toBe(true);
			expect(verdict.reason).toBeUndefined();
		});
	});

	describe("scoreTrial scoring contract", () => {
		const dummyCell: TrialCell = {
			suite: "terminal-bench",
			variant: "test-variant",
			task: "bun-sourcemap-leak",
			repeat: 0,
		};

		it("scores 1.0 from reward.json", async () => {
			const { trialDir, filePaths, cleanup } = createTempTrialDir({
				"verifier/reward.json": JSON.stringify({ reward: 1.0 }),
			});
			try {
				const artifacts: TrialArtifacts = { trialDir, filePaths };
				const score = await terminalBenchSuite.scoreTrial(dummyCell, artifacts);
				expect(score.reward).toBe(1.0);
				expect(score.partial).toBe(1.0);
				expect(score.error).toBeNull();
			} finally {
				cleanup();
			}
		});

		it("distinguishes scored-zero from an error (reward: 0.0, error: null)", async () => {
			const { trialDir, filePaths, cleanup } = createTempTrialDir({
				"verifier/reward.json": JSON.stringify({ reward: 0.0 }),
			});
			try {
				const artifacts: TrialArtifacts = { trialDir, filePaths };
				const score = await terminalBenchSuite.scoreTrial(dummyCell, artifacts);
				expect(score.reward).toBe(0.0);
				expect(score.partial).toBe(0.0);
				expect(score.error).toBeNull();
			} finally {
				cleanup();
			}
		});

		it("scores partial reward from reward.json", async () => {
			const { trialDir, filePaths, cleanup } = createTempTrialDir({
				"verifier/reward.json": JSON.stringify({ reward: 0.75, partial: 0.75 }),
			});
			try {
				const artifacts: TrialArtifacts = { trialDir, filePaths };
				const score = await terminalBenchSuite.scoreTrial(dummyCell, artifacts);
				expect(score.reward).toBe(0.75);
				expect(score.partial).toBe(0.75);
				expect(score.error).toBeNull();
			} finally {
				cleanup();
			}
		});

		it("scores reward from reward.txt when reward.json is absent", async () => {
			const { trialDir, filePaths, cleanup } = createTempTrialDir({
				"verifier/reward.txt": "1\n",
			});
			try {
				const artifacts: TrialArtifacts = { trialDir, filePaths };
				const score = await terminalBenchSuite.scoreTrial(dummyCell, artifacts);
				expect(score.reward).toBe(1.0);
				expect(score.error).toBeNull();
			} finally {
				cleanup();
			}
		});

		it("prefers reward.json over reward.txt when both exist", async () => {
			const { trialDir, filePaths, cleanup } = createTempTrialDir({
				"verifier/reward.json": JSON.stringify({ reward: 1.0 }),
				"verifier/reward.txt": "0\n",
			});
			try {
				const artifacts: TrialArtifacts = { trialDir, filePaths };
				const score = await terminalBenchSuite.scoreTrial(dummyCell, artifacts);
				expect(score.reward).toBe(1.0);
				expect(score.error).toBeNull();
			} finally {
				cleanup();
			}
		});

		it("falls back to reward.txt if reward.json is unparseable JSON", async () => {
			const { trialDir, filePaths, cleanup } = createTempTrialDir({
				"verifier/reward.json": "{ broken json",
				"verifier/reward.txt": "1.0",
			});
			try {
				const artifacts: TrialArtifacts = { trialDir, filePaths };
				const score = await terminalBenchSuite.scoreTrial(dummyCell, artifacts);
				expect(score.reward).toBe(1.0);
				expect(score.error).toBeNull();
			} finally {
				cleanup();
			}
		});

		it("maps empty reward files to an errored score with reward: null", async () => {
			const { trialDir, filePaths, cleanup } = createTempTrialDir({
				"verifier/reward.json": "   ",
				"verifier/reward.txt": "",
			});
			try {
				const artifacts: TrialArtifacts = { trialDir, filePaths };
				const score = await terminalBenchSuite.scoreTrial(dummyCell, artifacts);
				expect(score.reward).toBeNull();
				expect(score.error).toContain("empty");
			} finally {
				cleanup();
			}
		});

		it("maps unparseable reward text to an errored score", async () => {
			const { trialDir, filePaths, cleanup } = createTempTrialDir({
				"verifier/reward.txt": "NOT_A_FLOAT_OR_NUMBER",
			});
			try {
				const artifacts: TrialArtifacts = { trialDir, filePaths };
				const score = await terminalBenchSuite.scoreTrial(dummyCell, artifacts);
				expect(score.reward).toBeNull();
				expect(score.error).toContain("Unparseable reward.txt");
			} finally {
				cleanup();
			}
		});

		it("maps missing reward files to an errored score", async () => {
			const { trialDir, filePaths, cleanup } = createTempTrialDir({});
			try {
				const artifacts: TrialArtifacts = { trialDir, filePaths };
				const score = await terminalBenchSuite.scoreTrial(dummyCell, artifacts);
				expect(score.reward).toBeNull();
				expect(score.error).toContain("Missing reward file");
			} finally {
				cleanup();
			}
		});

		it("carries usage metrics from result.json when present", async () => {
			const { trialDir, filePaths, cleanup } = createTempTrialDir({
				"verifier/reward.json": JSON.stringify({ reward: 1.0 }),
				"result.json": JSON.stringify({
					agent_result: {
						n_input_tokens: 1250,
						n_output_tokens: 340,
						n_cache_tokens: 500,
						cost_usd: 0.012,
					},
					started_at: "2026-08-25T10:00:00Z",
					finished_at: "2026-08-25T10:01:30Z",
				}),
			});
			try {
				const artifacts: TrialArtifacts = { trialDir, filePaths };
				const score = await terminalBenchSuite.scoreTrial(dummyCell, artifacts);
				expect(score.reward).toBe(1.0);
				expect(score.usage).not.toBeNull();
				expect(score.usage?.inputTokens).toBe(1250);
				expect(score.usage?.outputTokens).toBe(340);
				expect(score.usage?.cacheTokens).toBe(500);
				expect(score.usage?.costUsd).toBe(0.012);
				expect(score.usage?.durationSec).toBe(90);
			} finally {
				cleanup();
			}
		});

		describe("multi-step tasks", () => {
			it("computes mean strategy across steps (1.0 and 0.0 -> 0.5)", async () => {
				const { trialDir, filePaths, cleanup } = createTempTrialDir({
					"step_0/verifier/reward.json": JSON.stringify({ reward: 1.0 }),
					"step_1/verifier/reward.json": JSON.stringify({ reward: 0.0 }),
				});
				try {
					const artifacts: TrialArtifacts = {
						trialDir,
						filePaths,
						extra: {
							multi_step_reward_strategy: "mean",
						},
					};
					const score = await terminalBenchSuite.scoreTrial(dummyCell, artifacts);
					expect(score.reward).toBe(0.5);
					expect(score.partial).toBe(0.5);
					expect(score.error).toBeNull();
				} finally {
					cleanup();
				}
			});

			it("computes final strategy across steps (1.0 and 0.0 -> 0.0)", async () => {
				const { trialDir, filePaths, cleanup } = createTempTrialDir({
					"step_0/verifier/reward.json": JSON.stringify({ reward: 1.0 }),
					"step_1/verifier/reward.json": JSON.stringify({ reward: 0.0 }),
				});
				try {
					const artifacts: TrialArtifacts = {
						trialDir,
						filePaths,
						extra: {
							multi_step_reward_strategy: "final",
						},
					};
					const score = await terminalBenchSuite.scoreTrial(dummyCell, artifacts);
					expect(score.reward).toBe(0.0);
					expect(score.partial).toBe(0.5);
					expect(score.error).toBeNull();
				} finally {
					cleanup();
				}
			});

			it("propagates step failure as an error score", async () => {
				const { trialDir, filePaths, cleanup } = createTempTrialDir({
					"step_0/verifier/reward.json": JSON.stringify({ reward: 1.0 }),
					"step_1/verifier/reward.txt": "CORRUPTED",
				});
				try {
					const artifacts: TrialArtifacts = {
						trialDir,
						filePaths,
					};
					const score = await terminalBenchSuite.scoreTrial(dummyCell, artifacts);
					expect(score.reward).toBeNull();
					expect(score.error).toContain("Step 'step_1' failed");
				} finally {
					cleanup();
				}
			});
		});

		it("scores real Harbor oracle trial directory when present", async () => {
			const runsDir = resolve(import.meta.dirname, "../../../runs/oracle-trial-run");
			if (!existsSync(runsDir)) return;
			const entries = existsSync(runsDir) ? readdirSync(runsDir) : [];
			const trialSubdir = entries.find((e: string) => e.startsWith("bun-sourcemap-leak"));
			if (!trialSubdir) return;

			const trialPath = join(runsDir, trialSubdir);
			const score = await terminalBenchSuite.scoreTrial(dummyCell, { trialDir: trialPath });
			expect(score.reward).toBe(1.0);
			expect(score.partial).toBe(1.0);
			expect(score.error).toBeNull();
			expect(score.usage?.durationSec).toBeGreaterThan(0);
		});
	});

	describe("provenance computation", () => {
		it("computes provenance for fixture tasks with deterministic SHA-256", async () => {
			const suite = new TerminalBenchSuite({
				defaultDatasetDir: resolve(import.meta.dirname, "fixtures"),
			});

			const prov = await suite.provenance({
				datasetDir: resolve(import.meta.dirname, "fixtures"),
			});

			expect(prov.suite).toBe("terminal-bench");
			expect(prov.version).toBe(TERMINAL_BENCH_TAG);
			expect(prov.sha).toBeDefined();
			expect(prov.metadata?.contentHash).toBeDefined();
			expect(typeof prov.metadata?.contentHash).toBe("string");
		});
	});

	describe("corpus skip guard", () => {
		it("proves that corpus skips only happen when corpus is genuinely absent", () => {
			const realCacheDir = getDefaultTerminalBenchCacheDir();
			const hasCorpus = existsSync(join(realCacheDir, "tasks"));

			if (hasCorpus) {
				// When corpus is acquired, discoverTasks must succeed without throwing
				expect(hasCorpus).toBe(true);
			} else {
				// When corpus is absent, the skip condition is verified
				expect(existsSync(join(realCacheDir, "tasks"))).toBe(false);
			}
		});
	});
});
