/**
 * WHY:
 * Edit benchmark trials require exact prompt composition across system prompts, initial
 * tasks, and iterative retries. Malformed prompt variables, leaked placeholders (such as
 * literal "undefined" or "null"), broken multi-file instructions, or non-deterministic
 * provider session hashing would silently skew agent performance metrics, corrupt cache keys,
 * or cause incorrect tool usage instructions across benchmark runs.
 *
 * This suite verifies:
 * 1. buildInstructions formats correct guidance based on noEditRequired config.
 * 2. buildBenchmarkSystemPrompt renders single-file vs multi-file constraint blocks and instructions.
 * 3. buildInitialBenchmarkPrompt renders task prompt with optional guided context and omits placeholders.
 * 4. buildRetryBenchmarkPrompt formats follow-up retry context and authoritative guided fixes.
 * 5. buildBenchmarkPromptDelivery routes between "prompt" (initial) and "followUp" (retry) delivery kinds.
 * 6. buildBenchmarkProviderSessionId generates deterministic hashed identifiers across all input dimensions.
 * 7. buildBenchmarkRpcArgs synthesizes benchmark RPC flags and preserves tool lists.
 * 8. prepareBenchmarkSessionSetup coordinates guided context resolution and session argument preparation.
 *
 * What this does not catch:
 * Live network transport errors or provider-side tokenization mismatches.
 */

import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@veyyon/utils";
import {
	buildBenchmarkPromptDelivery,
	buildBenchmarkProviderSessionId,
	buildBenchmarkRpcArgs,
	buildBenchmarkSystemPrompt,
	buildInitialBenchmarkPrompt,
	buildInstructions,
	buildRetryBenchmarkPrompt,
	prepareBenchmarkSessionSetup,
} from "../../../../src/suites/typescript-edit/adapter/runner/prompt-delivery";
import {
	BENCHMARK_TOOL_NAMES,
	type BenchmarkConfig,
} from "../../../../src/suites/typescript-edit/adapter/runner/types";
import type { EditTask } from "../../../../src/suites/typescript-edit/tasks";

const tempDirs: TempDir[] = [];

async function createTempDir(prefix: string): Promise<TempDir> {
	const dir = await TempDir.create(prefix);
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(
		tempDirs.splice(0).map(async dir => {
			await dir.remove();
		}),
	);
});

function createSampleConfig(overrides: Partial<BenchmarkConfig> = {}): BenchmarkConfig {
	return {
		provider: "anthropic",
		model: "claude-3-5-sonnet-20241022",
		runsPerTask: 1,
		timeout: 60000,
		taskConcurrency: 2,
		...overrides,
	};
}

function createSampleTask(overrides: Partial<EditTask> = {}): EditTask {
	return {
		id: "sample-task-001",
		name: "Fix bug in parser",
		prompt: "Refactor parseToken to handle escaped strings correctly.",
		files: ["src/parser.ts"],
		inputDir: "/tmp/fake-input",
		expectedDir: "/tmp/fake-expected",
		...overrides,
	};
}

describe("buildInstructions", () => {
	it("returns read-and-apply instructions when noEditRequired is true", () => {
		const config = createSampleConfig({ noEditRequired: true });
		const instructions = buildInstructions(config);
		expect(instructions).toBe("Read the relevant files first, then apply the fix.");
	});

	it("returns tool-usage instructions when noEditRequired is false or omitted", () => {
		const configFalse = createSampleConfig({ noEditRequired: false });
		expect(buildInstructions(configFalse)).toBe(
			"Read the relevant files first, then use the edit or vim tool to apply the fix.",
		);

		const configOmitted = createSampleConfig();
		expect(buildInstructions(configOmitted)).toBe(
			"Read the relevant files first, then use the edit or vim tool to apply the fix.",
		);
	});
});

describe("buildBenchmarkSystemPrompt", () => {
	it("renders single-file constraints and instructions when multiFile is false", () => {
		const config = createSampleConfig({ noEditRequired: false });
		const promptText = buildBenchmarkSystemPrompt({ multiFile: false, config });

		expect(promptText).toContain("a single edit task");
		expect(promptText).not.toContain("multiple unrelated files");
		expect(promptText).not.toContain("Only modify the file(s) referenced by the task or follow-up messages");
		expect(promptText).toContain("Read the relevant files first, then use the edit or vim tool to apply the fix.");
		expect(promptText).toContain("This benchmark is scored on exactness. Get the edit right.");
		expect(promptText).toContain("Make the minimum change necessary.");
		expect(promptText).toContain("Treat the first user message as the task definition.");
		expect(promptText).toContain("Treat later follow-up messages as incremental retry context");
	});

	it("renders multi-file constraints when multiFile is true", () => {
		const config = createSampleConfig({ noEditRequired: true });
		const promptText = buildBenchmarkSystemPrompt({ multiFile: true, config });

		expect(promptText).toContain("multiple unrelated files");
		expect(promptText).not.toContain("a single edit task");
		expect(promptText).toContain(
			"- Only modify the file(s) referenced by the task or follow-up messages. Leave all other files unchanged.",
		);
		expect(promptText).toContain("Read the relevant files first, then apply the fix.");
	});
});

describe("buildInitialBenchmarkPrompt", () => {
	it("renders task prompt without guided context and omits placeholder literals", () => {
		const taskPrompt = "Fix issue with integer overflow in calculator.ts";
		const promptText = buildInitialBenchmarkPrompt({ taskPrompt });

		expect(promptText).toContain(taskPrompt);
		expect(promptText).not.toContain("## Guided fix");
		expect(promptText).not.toContain("undefined");
		expect(promptText).not.toContain("null");

		const promptWithNull = buildInitialBenchmarkPrompt({ taskPrompt, guidedContext: null });
		expect(promptWithNull).toBe(promptText);
	});

	it("renders task prompt with authoritative guided fix when guidedContext is provided", () => {
		const taskPrompt = "Fix issue with integer overflow in calculator.ts";
		const guidedContext =
			"Target file: `src/calculator.ts`.\nApply this patch:\n```diff\n- a + b\n+ safeAdd(a, b)\n```";
		const promptText = buildInitialBenchmarkPrompt({ taskPrompt, guidedContext });

		expect(promptText).toContain(taskPrompt);
		expect(promptText).toContain("## Guided fix (authoritative)");
		expect(promptText).toContain(guidedContext);
	});
});

describe("buildRetryBenchmarkPrompt", () => {
	it("renders retry context without guided context and omits placeholder literals", () => {
		const retryContext = "Timeout retry 1/3: 30000ms elapsed with 0 tool executions.";
		const promptText = buildRetryBenchmarkPrompt({ retryContext });

		expect(promptText).toContain("Additional context for the same benchmark task.");
		expect(promptText).toContain("## Retry context");
		expect(promptText).toContain(retryContext);
		expect(promptText).toContain("Apply one minimal concrete edit attempt using this new information.");
		expect(promptText).not.toContain("## Guided fix");
		expect(promptText).not.toContain("undefined");
		expect(promptText).not.toContain("null");

		const promptWithNull = buildRetryBenchmarkPrompt({ retryContext, guidedContext: null });
		expect(promptWithNull).toBe(promptText);
	});

	it("renders retry context alongside guided context when both are provided", () => {
		const retryContext = "Provider auth failure 401: Invalid API key";
		const guidedContext = "Target file: `src/auth.ts`.\nLine: 42";
		const promptText = buildRetryBenchmarkPrompt({ retryContext, guidedContext });

		expect(promptText).toContain("Additional context for the same benchmark task.");
		expect(promptText).toContain("## Guided fix (authoritative)");
		expect(promptText).toContain(guidedContext);
		expect(promptText).toContain("## Retry context");
		expect(promptText).toContain(retryContext);
		expect(promptText).toContain("Apply one minimal concrete edit attempt using this new information.");
	});
});

describe("buildBenchmarkPromptDelivery", () => {
	it("formats initial prompt delivery with kind 'prompt'", () => {
		const delivery = buildBenchmarkPromptDelivery({
			taskPrompt: "Implement fast binary search.",
			guidedContext: null,
			retryContext: null,
		});

		expect(delivery.kind).toBe("prompt");
		expect(delivery.message).toContain("Implement fast binary search.");
		expect(delivery.message).not.toContain("## Retry context");
	});

	it("formats retry prompt delivery with kind 'followUp'", () => {
		const delivery = buildBenchmarkPromptDelivery({
			taskPrompt: "Implement fast binary search.",
			guidedContext: null,
			retryContext: "Edit failed with error: Diff line 2 unrecognized op.",
		});

		expect(delivery.kind).toBe("followUp");
		expect(delivery.message).toContain("## Retry context");
		expect(delivery.message).toContain("Edit failed with error: Diff line 2 unrecognized op.");
		expect(delivery.message).toContain("Additional context for the same benchmark task.");
	});
});

describe("buildBenchmarkProviderSessionId", () => {
	it("starts with 'reb_' prefix and is deterministic across identical parameters", () => {
		const config = createSampleConfig();
		const task = createSampleTask();

		const id1 = buildBenchmarkProviderSessionId({
			config,
			task,
			multiFile: false,
			initialGuidedContext: null,
		});
		const id2 = buildBenchmarkProviderSessionId({
			config,
			task,
			multiFile: false,
			initialGuidedContext: null,
		});

		expect(id1.startsWith("reb_")).toBe(true);
		expect(id1).toBe(id2);
	});

	it("changes when any configuration or prompt parameter changes", () => {
		const baseConfig = createSampleConfig();
		const baseTask = createSampleTask();

		const baseId = buildBenchmarkProviderSessionId({
			config: baseConfig,
			task: baseTask,
			multiFile: false,
			initialGuidedContext: null,
		});

		const diffProviderId = buildBenchmarkProviderSessionId({
			config: createSampleConfig({ provider: "openai" }),
			task: baseTask,
			multiFile: false,
			initialGuidedContext: null,
		});
		expect(diffProviderId).not.toBe(baseId);

		const diffModelId = buildBenchmarkProviderSessionId({
			config: createSampleConfig({ model: "gpt-4o" }),
			task: baseTask,
			multiFile: false,
			initialGuidedContext: null,
		});
		expect(diffModelId).not.toBe(baseId);

		const diffTaskId = buildBenchmarkProviderSessionId({
			config: baseConfig,
			task: createSampleTask({ id: "sample-task-002" }),
			multiFile: false,
			initialGuidedContext: null,
		});
		expect(diffTaskId).not.toBe(baseId);

		const diffPromptId = buildBenchmarkProviderSessionId({
			config: baseConfig,
			task: createSampleTask({ prompt: "Completely different prompt task." }),
			multiFile: false,
			initialGuidedContext: null,
		});
		expect(diffPromptId).not.toBe(baseId);

		const diffMultiFileId = buildBenchmarkProviderSessionId({
			config: baseConfig,
			task: baseTask,
			multiFile: true,
			initialGuidedContext: null,
		});
		expect(diffMultiFileId).not.toBe(baseId);

		const diffInstructionsId = buildBenchmarkProviderSessionId({
			config: createSampleConfig({ noEditRequired: true }),
			task: baseTask,
			multiFile: false,
			initialGuidedContext: null,
		});
		expect(diffInstructionsId).not.toBe(baseId);

		const diffGuidedId = buildBenchmarkProviderSessionId({
			config: baseConfig,
			task: baseTask,
			multiFile: false,
			initialGuidedContext: "Guided fix content",
		});
		expect(diffGuidedId).not.toBe(baseId);
	});
});

describe("buildBenchmarkRpcArgs", () => {
	it("formats benchmark RPC command arguments with system prompt and declared tool names", () => {
		const config = createSampleConfig({ noEditRequired: false });
		const sessionId = "reb_test_session_123";
		const rpcArgs = buildBenchmarkRpcArgs(config, false, sessionId);

		expect(rpcArgs).toEqual([
			"--provider-session-id",
			sessionId,
			"--append-system-prompt",
			buildBenchmarkSystemPrompt({ multiFile: false, config }),
			"--tools",
			BENCHMARK_TOOL_NAMES.join(","),
			"--no-skills",
			"--no-title",
			"--no-rules",
			"--no-lsp",
		]);

		expect(rpcArgs).toContain("--tools");
		expect(rpcArgs[rpcArgs.indexOf("--tools") + 1]).toBe("read,edit,write,apply_patch");
	});
});

describe("prepareBenchmarkSessionSetup", () => {
	it("prepares unguided session setup with null guided context and computed rpc args", async () => {
		const tempDir = await createTempDir("evals-prompt-delivery-test-");
		const cwd = tempDir.join("work");
		const expectedDir = tempDir.join("expected");
		await fs.mkdir(cwd, { recursive: true });
		await fs.mkdir(expectedDir, { recursive: true });

		const task = createSampleTask({
			inputDir: cwd,
			expectedDir,
			files: ["index.ts"],
		});
		const config = createSampleConfig({ guided: false });

		const setup = await prepareBenchmarkSessionSetup({
			config,
			task,
			cwd,
			expectedDir,
			multiFile: false,
		});

		expect(setup.initialGuidedContext).toBeNull();
		expect(setup.providerSessionId.startsWith("reb_")).toBe(true);
		expect(setup.rpcArgs).toContain("--provider-session-id");
		expect(setup.rpcArgs).toContain(setup.providerSessionId);
		expect(setup.rpcArgs).toContain("--tools");
	});

	it("prepares guided session setup when guided is enabled and file difference is expressible", async () => {
		const tempDir = await createTempDir("evals-prompt-delivery-guided-");
		const cwd = tempDir.join("work");
		const expectedDir = tempDir.join("expected");
		await fs.mkdir(cwd, { recursive: true });
		await fs.mkdir(expectedDir, { recursive: true });

		await fs.writeFile(path.join(cwd, "index.ts"), "const y = 2;\n", "utf8");
		await fs.writeFile(path.join(expectedDir, "index.ts"), "const x = 1;\nconst y = 2;\n", "utf8");

		const task = createSampleTask({
			inputDir: cwd,
			expectedDir,
			files: ["index.ts"],
			metadata: { fileName: "index.ts", lineNumber: 1, mutationType: "insert" },
		});
		const config = createSampleConfig({ guided: true, editVariant: "hashline" });

		const setup = await prepareBenchmarkSessionSetup({
			config,
			task,
			cwd,
			expectedDir,
			multiFile: false,
		});

		expect(setup.initialGuidedContext).not.toBeNull();
		expect(setup.initialGuidedContext).toContain("Line: 1");
		expect(setup.providerSessionId.startsWith("reb_")).toBe(true);
		expect(setup.rpcArgs).toContain(setup.providerSessionId);
	});
});
