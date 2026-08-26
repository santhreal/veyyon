import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import { $env, TempDir } from "@veyyon/utils";
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
import { buildRunPlan, executeRun } from "../../../src/run";

registerBuiltinHarnesses();
registerInProcessBackend();
function createConcurrentProbeSuite(): EvalSuite {
	return {
		name: "concurrent-probe-suite",
		version: "1.0.0",
		displayName: "Concurrent Probe Suite",
		description: "Suite for testing concurrent in-process trial isolation",
		backend: "in-process",
		async discoverTasks() {
			return ["task-a", "task-b"];
		},
		async describeTask(taskId: string): Promise<TaskDescriptor> {
			return {
				id: taskId,
				path: null,
				timeBudgetSec: 30,
				instructionPath: null,
				metadata: {
					prompt: `Execute ${taskId}`,
					files: [],
				},
			};
		},
		async provenance(): Promise<SuiteProvenance> {
			return { suite: "concurrent-probe-suite", version: "1.0.0" };
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

describe("Concurrent in-process trials overlay and settings isolation", () => {
	it("two trials with different config and prompt overlays running concurrently each see their own overlay and process.env is untouched", async () => {
		const tempDir = await TempDir.create("@evals-test-concurrent-isolation-");
		const initialEnv = $env.VEYYON_EVAL_PROMPTS;

		try {
			// Arm A files
			const configA = tempDir.join("arm-a.yml");
			await fs.writeFile(configA, "argot:\n  enabled: true\nedit:\n  mode: diff\n");
			const promptA = tempDir.join("arm-a.prompts.yml");
			const authorityTextA = "OVERLAY_A_DISTINCT_AUTHORITY_TEXT_12345";
			await fs.writeFile(promptA, `session/user-instruction-authority: |\n  ${authorityTextA}\n`);

			// Arm B files
			const configB = tempDir.join("arm-b.yml");
			await fs.writeFile(configB, "argot:\n  enabled: false\nedit:\n  mode: hashline\n");
			const promptB = tempDir.join("arm-b.prompts.yml");
			const authorityTextB = "OVERLAY_B_DISTINCT_AUTHORITY_TEXT_67890";
			await fs.writeFile(promptB, `session/user-instruction-authority: |\n  ${authorityTextB}\n`);

			const suite = createConcurrentProbeSuite();
			const backend = new InProcessBackend();

			const plan = await buildRunPlan({
				suite,
				selection: {
					harnesses: ["veyyon"],
					configs: [configA, configB],
					promptVariants: [promptA, promptB],
					models: ["anthropic/claude-sonnet-4-6"],
				},
			});

			// We expect variants for each arm combination
			expect(plan.variants.length).toBeGreaterThanOrEqual(2);
			const variantA = plan.variants.find(v => v.configPath === configA && v.promptVariantPath === promptA);
			const variantB = plan.variants.find(v => v.configPath === configB && v.promptVariantPath === promptB);
			expect(variantA).toBeDefined();
			expect(variantB).toBeDefined();

			// Execute the run plan with jobs: 2 (concurrent in-process trial execution)
			const record = await executeRun({
				plan,
				backend,
				workDir: tempDir.absolute(),
				runsDir: tempDir.join("runs"),
				jobs: 2,
			});

			expect(record.results.length).toBeGreaterThanOrEqual(2);
			const resultA = record.results.find(r => r.cell.variant === variantA?.name);
			const resultB = record.results.find(r => r.cell.variant === variantB?.name);
			expect(resultA).toBeDefined();
			expect(resultB).toBeDefined();

			const artifactsA = resultA?.artifacts;
			const artifactsB = resultB?.artifacts;
			expect(artifactsA).toBeDefined();
			expect(artifactsB).toBeDefined();

			// 1. Verify Trial A received overlay A settings and prompt
			const settingsA = artifactsA?.extra?.settings as { get(k: string): unknown } | undefined;
			expect(settingsA?.get("argot.enabled")).toBe(true);
			expect(settingsA?.get("edit.mode")).toBe("diff");

			const systemPromptA = (artifactsA?.extra?.systemPrompt as string[] | undefined)?.join("\n") ?? "";
			expect(systemPromptA).toContain(authorityTextA);
			expect(systemPromptA).not.toContain(authorityTextB);

			// 2. Verify Trial B received overlay B settings and prompt
			const settingsB = artifactsB?.extra?.settings as { get(k: string): unknown } | undefined;
			expect(settingsB?.get("argot.enabled")).toBe(false);
			expect(settingsB?.get("edit.mode")).toBe("hashline");

			const systemPromptB = (artifactsB?.extra?.systemPrompt as string[] | undefined)?.join("\n") ?? "";
			expect(systemPromptB).toContain(authorityTextB);
			expect(systemPromptB).not.toContain(authorityTextA);

			// 3. Verify observable differences between concurrent arms
			expect(settingsA?.get("argot.enabled")).not.toEqual(settingsB?.get("argot.enabled"));
			expect(settingsA?.get("edit.mode")).not.toEqual(settingsB?.get("edit.mode"));
			expect(systemPromptA).not.toEqual(systemPromptB);

			// 4. Verify process.env.VEYYON_EVAL_PROMPTS was untouched
			expect($env.VEYYON_EVAL_PROMPTS).toBe(initialEnv);
		} finally {
			await tempDir.remove();
		}
	});
});
