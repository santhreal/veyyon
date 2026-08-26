import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import { TempDir } from "@veyyon/utils";
import { InProcessBackend, inProcessBackend } from "../../../src/backends/in-process/backend";
import { getBackend, requireBackend } from "../../../src/core/backend-registry";
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

function createProbeSuite(): EvalSuite {
	return {
		name: "probe-suite",
		version: "1.0.0",
		displayName: "Probe Suite",
		description: "In-process probe suite",
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
				metadata: {
					prompt: "Perform test action",
					files: [],
				},
			};
		},
		async provenance(): Promise<SuiteProvenance> {
			return { suite: "probe-suite", version: "1.0.0" };
		},
		async scoreTrial(cell: TrialCell, artifacts: TrialArtifacts): Promise<TrialScore> {
			return {
				reward: 1,
				partial: null,
				error: null,
				usage: null,
				extra: { cell, artifacts },
			};
		},
		async preflight() {
			return { ok: true };
		},
	};
}

describe("InProcessBackend — overlay preflight and execution", () => {
	it("registers in global backend registry", () => {
		const backend = requireBackend("in-process");
		expect(backend).toBe(inProcessBackend);
		expect(getBackend("in-process")).toBe(inProcessBackend);
		expect(backend.id).toBe("in-process");
	});

	describe("preflight overlay validation", () => {
		it("passes preflight when variants carry valid overlays", async () => {
			const tempDir = await TempDir.create("@evals-test-in-proc-preflight-valid-");
			try {
				const configFile = tempDir.join("valid-config.yml");
				await fs.writeFile(configFile, "argot:\n  enabled: true\n");

				const promptFile = tempDir.join("valid-prompts.yml");
				await fs.writeFile(promptFile, "tools/bash: |\n  Custom test bash description\n");

				const suite = createProbeSuite();
				const backend = new InProcessBackend({
					clientFactory: () => ({
						async start() {},
						async prompt() {},
						async getSessionStats() {
							return { tokens: { input: 10, output: 10, total: 20 }, assistantMessages: 1 };
						},
						async getLastAssistantText() {
							return "done";
						},
						async dispose() {},
					}),
				});

				const variants: readonly Variant[] = [
					{
						name: "valid-arm",
						harness: "veyyon",
						configPath: configFile,
						promptVariantPath: promptFile,
						model: "anthropic/claude-sonnet-4-6",
						attachments: [],
					},
				];

				const context: RunContext = {
					runId: "test-run",
					suite,
					workDir: tempDir.absolute(),
					runsDir: tempDir.join("runs"),
					options: { variants },
				};

				const verdict = await backend.preflight(context);
				expect(verdict.ok).toBe(true);
			} finally {
				await tempDir.remove();
			}
		});

		it("refuses preflight with missing file path when config overlay is missing", async () => {
			const tempDir = await TempDir.create("@evals-test-in-proc-preflight-missing-cfg-");
			try {
				const missingPath = tempDir.join("nonexistent-config.yml");
				const suite = createProbeSuite();
				const backend = new InProcessBackend();

				const variants: readonly Variant[] = [
					{
						name: "missing-cfg-arm",
						harness: "veyyon",
						configPath: missingPath,
						promptVariantPath: null,
						model: "anthropic/claude-sonnet-4-6",
						attachments: [],
					},
				];

				const context: RunContext = {
					runId: "test-run",
					suite,
					workDir: tempDir.absolute(),
					runsDir: tempDir.join("runs"),
					options: { variants },
				};

				const verdict = await backend.preflight(context);
				expect(verdict.ok).toBe(false);
				expect(verdict.reason).toContain("Config overlay file not found");
				expect(verdict.reason).toContain(missingPath);
				expect(verdict.missingRequirements).toContain("valid-config-overlay");
			} finally {
				await tempDir.remove();
			}
		});

		it("refuses preflight with key and file path when config overlay names unknown keys", async () => {
			const tempDir = await TempDir.create("@evals-test-in-proc-preflight-unknown-cfg-");
			try {
				const invalidConfigFile = tempDir.join("invalid-config.yml");
				await fs.writeFile(invalidConfigFile, "argot:\n  completelyUnknownSettingKey999: true\n");

				const suite = createProbeSuite();
				const backend = new InProcessBackend();

				const variants: readonly Variant[] = [
					{
						name: "unknown-cfg-arm",
						harness: "veyyon",
						configPath: invalidConfigFile,
						promptVariantPath: null,
						model: "anthropic/claude-sonnet-4-6",
						attachments: [],
					},
				];

				const context: RunContext = {
					runId: "test-run",
					suite,
					workDir: tempDir.absolute(),
					runsDir: tempDir.join("runs"),
					options: { variants },
				};

				const verdict = await backend.preflight(context);
				expect(verdict.ok).toBe(false);
				expect(verdict.reason).toContain(invalidConfigFile);
				expect(verdict.reason).toContain("argot.completelyUnknownSettingKey999");
				expect(verdict.missingRequirements).toContain("valid-config-overlay");
			} finally {
				await tempDir.remove();
			}
		});

		it("refuses preflight with missing file path when prompt overlay is missing", async () => {
			const tempDir = await TempDir.create("@evals-test-in-proc-preflight-missing-prompt-");
			try {
				const missingPromptPath = tempDir.join("nonexistent-prompts.yml");
				const suite = createProbeSuite();
				const backend = new InProcessBackend();

				const variants: readonly Variant[] = [
					{
						name: "missing-prompt-arm",
						harness: "veyyon",
						configPath: null,
						promptVariantPath: missingPromptPath,
						model: "anthropic/claude-sonnet-4-6",
						attachments: [],
					},
				];

				const context: RunContext = {
					runId: "test-run",
					suite,
					workDir: tempDir.absolute(),
					runsDir: tempDir.join("runs"),
					options: { variants },
				};

				const verdict = await backend.preflight(context);
				expect(verdict.ok).toBe(false);
				expect(verdict.reason).toContain("Prompt overlay file not found");
				expect(verdict.reason).toContain(missingPromptPath);
				expect(verdict.missingRequirements).toContain("valid-prompt-overlay");
			} finally {
				await tempDir.remove();
			}
		});

		it("refuses preflight with prompt ID and file path when prompt overlay names unknown prompt IDs", async () => {
			const tempDir = await TempDir.create("@evals-test-in-proc-preflight-unknown-prompt-");
			try {
				const invalidPromptFile = tempDir.join("invalid-prompts.yml");
				await fs.writeFile(invalidPromptFile, "tools/completely_nonexistent_prompt_id_888: |\n  Some text\n");

				const suite = createProbeSuite();
				const backend = new InProcessBackend();

				const variants: readonly Variant[] = [
					{
						name: "unknown-prompt-arm",
						harness: "veyyon",
						configPath: null,
						promptVariantPath: invalidPromptFile,
						model: "anthropic/claude-sonnet-4-6",
						attachments: [],
					},
				];

				const context: RunContext = {
					runId: "test-run",
					suite,
					workDir: tempDir.absolute(),
					runsDir: tempDir.join("runs"),
					options: { variants },
				};

				const verdict = await backend.preflight(context);
				expect(verdict.ok).toBe(false);
				expect(verdict.reason).toContain(invalidPromptFile);
				expect(verdict.reason).toContain("tools/completely_nonexistent_prompt_id_888");
				expect(verdict.missingRequirements).toContain("valid-prompt-overlay");
			} finally {
				await tempDir.remove();
			}
		});
	});

	describe("trial execution with clientFactory", () => {
		it("forwards resolved overlay options to clientFactory and records artifacts", async () => {
			const tempDir = await TempDir.create("@evals-test-in-proc-exec-");
			try {
				const configFile = tempDir.join("test-arm.yml");
				await fs.writeFile(configFile, "argot:\n  enabled: true\n");

				const promptFile = tempDir.join("test-arm.prompts.yml");
				await fs.writeFile(promptFile, "tools/bash: |\n  Custom test bash description\n");

				let passedConfigPath: string | undefined;
				let passedPromptOverrides: Record<string, string> | undefined;

				const suite = createProbeSuite();
				const backend = new InProcessBackend({
					clientFactory: options => {
						passedConfigPath = options.configPath ?? undefined;
						passedPromptOverrides = options.promptOverrides ?? undefined;
						return {
							async start() {},
							async prompt() {},
							async getSessionStats() {
								return { tokens: { input: 100, output: 40, total: 140 }, assistantMessages: 1 };
							},
							async getLastAssistantText() {
								return "Executed successfully.";
							},
							async dispose() {},
						};
					},
				});

				const variants: readonly Variant[] = [
					{
						name: "test-arm",
						harness: "veyyon",
						configPath: configFile,
						promptVariantPath: promptFile,
						model: "anthropic/claude-sonnet-4-6",
						attachments: [],
					},
				];

				const context: RunContext = {
					runId: "test-run-exec",
					suite,
					workDir: tempDir.absolute(),
					runsDir: tempDir.join("runs"),
					options: { variants, cleanup: true },
				};

				const cell: TrialCell = {
					suite: "probe-suite",
					variant: "test-arm",
					task: "task-1",
					repeat: 1,
				};

				const artifacts = await backend.runTrial(cell, context);
				expect(artifacts.trialDir).toBeTruthy();
				expect(artifacts.rawOutput).toBe("Executed successfully.");
				expect(passedConfigPath).toBe(configFile);
				expect(passedPromptOverrides).toEqual({
					"tools/bash": "Custom test bash description\n",
				});

				// Cleanup should remove the trial directory
				await backend.cleanup(cell, context);
				const exists = await fs.stat(artifacts.trialDir!).catch(() => null);
				expect(exists).toBeNull();
			} finally {
				await tempDir.remove();
			}
		});
	});
});
