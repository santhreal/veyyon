import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import { TempDir } from "@veyyon/utils";
import { InProcessBackend, registerInProcessBackend } from "../../../src/backends/in-process/backend";
import type {
	EvalSuite,
	SuiteProvenance,
	TaskDescriptor,
	TrialArtifacts,
	TrialCell,
	TrialScore,
} from "../../../src/core/types";
import { registerBuiltinHarnesses } from "../../../src/harnesses";
import { BackendPreflightError, buildRunPlan, executeRun } from "../../../src/run";

registerBuiltinHarnesses();
registerInProcessBackend();

function createProbeSuite(): EvalSuite {
	return {
		name: "probe-suite",
		version: "1.0.0",
		displayName: "Probe Suite",
		description: "In-process probe suite for overlay verification",
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
					prompt: "Run probe task",
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

describe("End-to-end overlay propagation on in-process backend", () => {
	it("a config overlay changes an observable session setting, and differs from default", async () => {
		const tempDir = await TempDir.create("@evals-test-config-overlay-");
		try {
			const overlayFile = tempDir.join("custom-settings.yml");
			await fs.writeFile(overlayFile, "argot:\n  enabled: true\nedit:\n  mode: diff\n");

			const suite = createProbeSuite();
			const backend = new InProcessBackend();

			// 1. Run plan with default arm (no overlay) vs overlaid arm
			const plan = await buildRunPlan({
				suite,
				selection: {
					harnesses: ["veyyon"],
					configs: [null, overlayFile],
					models: ["anthropic/claude-sonnet-4-6"],
				},
			});

			expect(plan.variants).toHaveLength(2);
			const defaultVariant = plan.variants[0];
			const overlaidVariant = plan.variants[1];

			expect(defaultVariant.configPath).toBeNull();
			expect(overlaidVariant.configPath).toBe(overlayFile);
			expect(overlaidVariant.name).toBe("custom-settings");

			const record = await executeRun({
				plan,
				backend,
				workDir: tempDir.absolute(),
				runsDir: tempDir.join("runs"),
			});

			expect(record.results).toHaveLength(2);

			const defaultResult = record.results.find(r => r.cell.variant === defaultVariant.name);
			const overlaidResult = record.results.find(r => r.cell.variant === overlaidVariant.name);

			expect(defaultResult).toBeDefined();
			expect(overlaidResult).toBeDefined();

			// Assert default arm has default settings
			const defaultExtra = defaultResult?.artifacts?.extra;
			const defaultSettings = defaultExtra?.settings as { get(k: string): unknown } | undefined;
			expect(defaultSettings?.get("argot.enabled")).toBe(false);
			expect(defaultSettings?.get("edit.mode")).toBe("hashline");

			// Assert overlaid arm has changed settings matching the overlay
			const overlaidExtra = overlaidResult?.artifacts?.extra;
			const overlaidSettings = overlaidExtra?.settings as { get(k: string): unknown } | undefined;
			expect(overlaidSettings?.get("argot.enabled")).toBe(true);
			expect(overlaidSettings?.get("edit.mode")).toBe("diff");
			// Assert observable difference
			expect(overlaidSettings?.get("argot.enabled")).not.toEqual(defaultSettings?.get("argot.enabled"));
			expect(overlaidSettings?.get("edit.mode")).not.toEqual(defaultSettings?.get("edit.mode"));
		} finally {
			await tempDir.remove();
		}
	});

	it("a prompt overlay changes the prompt text the session builds, and differs from default", async () => {
		const tempDir = await TempDir.create("@evals-test-prompt-overlay-");
		try {
			const promptOverlayFile = tempDir.join("trimmed-bash.prompts.yml");
			const customBashText = "UNIQUE TEST BASH TOOL INSTRUCTIONS FOR OVERLAY TEST";
			const customAuthorityText = "UNIQUE TEST USER INSTRUCTION AUTHORITY OVERLAY";
			await fs.writeFile(
				promptOverlayFile,
				`tools/bash: |\n  ${customBashText}\nsession/user-instruction-authority: |\n  ${customAuthorityText}\n`,
			);

			const suite = createProbeSuite();
			const backend = new InProcessBackend();

			const plan = await buildRunPlan({
				suite,
				selection: {
					harnesses: ["veyyon"],
					promptVariants: [null, promptOverlayFile],
					models: ["anthropic/claude-sonnet-4-6"],
				},
			});

			expect(plan.variants).toHaveLength(2);
			const defaultVariant = plan.variants[0];
			const promptVariant = plan.variants[1];

			expect(defaultVariant.promptVariantPath).toBeNull();
			expect(promptVariant.promptVariantPath).toBe(promptOverlayFile);
			expect(promptVariant.name).toBe("veyyon+trimmed-bash");

			const record = await executeRun({
				plan,
				backend,
				workDir: tempDir.absolute(),
				runsDir: tempDir.join("runs"),
			});

			expect(record.results).toHaveLength(2);

			const defaultResult = record.results.find(r => r.cell.variant === defaultVariant.name);
			const promptResult = record.results.find(r => r.cell.variant === promptVariant.name);

			expect(defaultResult).toBeDefined();
			expect(promptResult).toBeDefined();

			const defaultSysPrompt =
				(defaultResult?.artifacts?.extra?.systemPrompt as string[] | undefined)?.join("\n") ?? "";
			const promptSysPrompt =
				(promptResult?.artifacts?.extra?.systemPrompt as string[] | undefined)?.join("\n") ?? "";
			// Assert default does NOT have custom prompt text
			expect(defaultSysPrompt).not.toContain(customAuthorityText);

			// Assert prompt variant DOES have custom prompt text
			expect(promptSysPrompt).toContain(customAuthorityText);

			// Assert observable difference between arms
			expect(promptSysPrompt).not.toEqual(defaultSysPrompt);
		} finally {
			await tempDir.remove();
		}
	});

	it("fails loudly naming the file when a config overlay file is missing", async () => {
		const tempDir = await TempDir.create("@evals-test-missing-cfg-file-");
		try {
			const missingConfigFile = tempDir.join("does-not-exist-config.yml");
			const suite = createProbeSuite();
			const backend = new InProcessBackend();

			const plan = await buildRunPlan({
				suite,
				selection: {
					harnesses: ["veyyon"],
					configs: [missingConfigFile],
					models: ["anthropic/claude-sonnet-4-6"],
				},
			});

			let caughtError: Error | undefined;
			try {
				await executeRun({
					plan,
					backend,
					workDir: tempDir.absolute(),
					runsDir: tempDir.join("runs"),
				});
			} catch (err) {
				caughtError = err as Error;
			}

			expect(caughtError).toBeInstanceOf(BackendPreflightError);
			expect(caughtError?.message).toContain("Config overlay file not found");
			expect(caughtError?.message).toContain(missingConfigFile);
		} finally {
			await tempDir.remove();
		}
	});

	it("fails loudly naming the file when a prompt overlay file is missing", async () => {
		const tempDir = await TempDir.create("@evals-test-missing-prompt-file-");
		try {
			const missingPromptFile = tempDir.join("does-not-exist-prompts.yml");
			const suite = createProbeSuite();
			const backend = new InProcessBackend();

			const plan = await buildRunPlan({
				suite,
				selection: {
					harnesses: ["veyyon"],
					promptVariants: [missingPromptFile],
					models: ["anthropic/claude-sonnet-4-6"],
				},
			});

			let caughtError: Error | undefined;
			try {
				await executeRun({
					plan,
					backend,
					workDir: tempDir.absolute(),
					runsDir: tempDir.join("runs"),
				});
			} catch (err) {
				caughtError = err as Error;
			}

			expect(caughtError).toBeInstanceOf(BackendPreflightError);
			expect(caughtError?.message).toContain("Prompt overlay file not found");
			expect(caughtError?.message).toContain(missingPromptFile);
		} finally {
			await tempDir.remove();
		}
	});

	it("fails loudly naming the key and file when a config overlay names an unknown setting key", async () => {
		const tempDir = await TempDir.create("@evals-test-unknown-cfg-key-");
		try {
			const invalidConfigFile = tempDir.join("bad-key-config.yml");
			await fs.writeFile(invalidConfigFile, "invalidNamespace:\n  unknownKey777: true\n");

			const suite = createProbeSuite();
			const backend = new InProcessBackend();

			const plan = await buildRunPlan({
				suite,
				selection: {
					harnesses: ["veyyon"],
					configs: [invalidConfigFile],
					models: ["anthropic/claude-sonnet-4-6"],
				},
			});

			let caughtError: Error | undefined;
			try {
				await executeRun({
					plan,
					backend,
					workDir: tempDir.absolute(),
					runsDir: tempDir.join("runs"),
				});
			} catch (err) {
				caughtError = err as Error;
			}

			expect(caughtError).toBeInstanceOf(BackendPreflightError);
			expect(caughtError?.message).toContain(invalidConfigFile);
			expect(caughtError?.message).toContain("invalidNamespace.unknownKey777");
		} finally {
			await tempDir.remove();
		}
	});

	it("fails loudly naming the ID and file when a prompt overlay names an unknown prompt ID", async () => {
		const tempDir = await TempDir.create("@evals-test-unknown-prompt-id-");
		try {
			const invalidPromptFile = tempDir.join("bad-prompt-id.prompts.yml");
			await fs.writeFile(invalidPromptFile, "tools/completely_unknown_prompt_999: |\n  Some text\n");

			const suite = createProbeSuite();
			const backend = new InProcessBackend();

			const plan = await buildRunPlan({
				suite,
				selection: {
					harnesses: ["veyyon"],
					promptVariants: [invalidPromptFile],
					models: ["anthropic/claude-sonnet-4-6"],
				},
			});

			let caughtError: Error | undefined;
			try {
				await executeRun({
					plan,
					backend,
					workDir: tempDir.absolute(),
					runsDir: tempDir.join("runs"),
				});
			} catch (err) {
				caughtError = err as Error;
			}

			expect(caughtError).toBeInstanceOf(BackendPreflightError);
			expect(caughtError?.message).toContain(invalidPromptFile);
			expect(caughtError?.message).toContain("tools/completely_unknown_prompt_999");
		} finally {
			await tempDir.remove();
		}
	});

	it("two overlay files on one axis produce two variants with attributable run directories", async () => {
		const tempDir = await TempDir.create("@evals-test-two-variants-");
		try {
			const cfgA = tempDir.join("treatment-alpha.yml");
			await fs.writeFile(cfgA, "argot:\n  enabled: true\n");

			const cfgB = tempDir.join("treatment-beta.yml");
			await fs.writeFile(cfgB, "edit:\n  mode: diff\n");

			const suite = createProbeSuite();
			const backend = new InProcessBackend();

			const plan = await buildRunPlan({
				suite,
				selection: {
					harnesses: ["veyyon"],
					configs: [cfgA, cfgB],
					models: ["anthropic/claude-sonnet-4-6"],
				},
			});

			expect(plan.variants).toHaveLength(2);
			expect(plan.variants.map(v => v.name)).toEqual(["treatment-alpha", "treatment-beta"]);

			const record = await executeRun({
				plan,
				backend,
				workDir: tempDir.absolute(),
				runsDir: tempDir.join("runs"),
			});

			expect(record.results).toHaveLength(2);

			const resultAlpha = record.results[0];
			const resultBeta = record.results[1];

			expect(resultAlpha.cell.variant).toBe("treatment-alpha");
			expect(resultBeta.cell.variant).toBe("treatment-beta");

			// Trial directories are partitioned by variant name
			expect(resultAlpha.artifacts?.trialDir).toContain("treatment-alpha");
			expect(resultBeta.artifacts?.trialDir).toContain("treatment-beta");
			expect(resultAlpha.artifacts?.trialDir).not.toEqual(resultBeta.artifacts?.trialDir);

			// Individual variants carry their own distinct settings
			const extraAlpha = resultAlpha.artifacts?.extra;
			const extraBeta = resultBeta.artifacts?.extra;
			const settingsAlpha = extraAlpha?.settings as { get(k: string): unknown } | undefined;
			const settingsBeta = extraBeta?.settings as { get(k: string): unknown } | undefined;
			expect(settingsAlpha?.get("edit.mode")).toBe("hashline");

			expect(settingsBeta?.get("argot.enabled")).toBe(false);
			expect(settingsBeta?.get("edit.mode")).toBe("diff");
		} finally {
			await tempDir.remove();
		}
	});

	it("two prompt overlay files produce two variants with attributable run directories and distinct prompt texts", async () => {
		const tempDir = await TempDir.create("@evals-test-two-prompt-variants-");
		try {
			const promptFileA = tempDir.join("variant-alpha.prompts.yml");
			const textA = "UNIQUE PROMPT OVERLAY ALPHA 111";
			await fs.writeFile(promptFileA, `session/user-instruction-authority: |\n  ${textA}\n`);

			const promptFileB = tempDir.join("variant-beta.prompts.yml");
			const textB = "UNIQUE PROMPT OVERLAY BETA 222";
			await fs.writeFile(promptFileB, `session/user-instruction-authority: |\n  ${textB}\n`);

			const suite = createProbeSuite();
			const backend = new InProcessBackend();

			const plan = await buildRunPlan({
				suite,
				selection: {
					harnesses: ["veyyon"],
					promptVariants: [promptFileA, promptFileB],
					models: ["anthropic/claude-sonnet-4-6"],
				},
			});

			expect(plan.variants).toHaveLength(2);
			expect(plan.variants.map(v => v.name)).toEqual(["veyyon+variant-alpha", "veyyon+variant-beta"]);

			const record = await executeRun({
				plan,
				backend,
				workDir: tempDir.absolute(),
				runsDir: tempDir.join("runs"),
			});

			expect(record.results).toHaveLength(2);

			const resultA = record.results.find(r => r.cell.variant === "veyyon+variant-alpha");
			const resultB = record.results.find(r => r.cell.variant === "veyyon+variant-beta");

			expect(resultA).toBeDefined();
			expect(resultB).toBeDefined();

			expect(resultA!.artifacts?.trialDir).toContain("variant-alpha");
			expect(resultB!.artifacts?.trialDir).toContain("variant-beta");
			expect(resultA!.artifacts?.trialDir).not.toEqual(resultB!.artifacts?.trialDir);

			const promptA = (resultA?.artifacts?.extra?.systemPrompt as string[] | undefined)?.join("\n") ?? "";
			const promptB = (resultB?.artifacts?.extra?.systemPrompt as string[] | undefined)?.join("\n") ?? "";
			expect(promptA).toContain(textA);
			expect(promptA).not.toContain(textB);

			expect(promptB).toContain(textB);
			expect(promptB).not.toContain(textA);
		} finally {
			await tempDir.remove();
		}
	});
});
