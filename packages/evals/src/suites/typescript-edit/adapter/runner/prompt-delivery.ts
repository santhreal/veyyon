/**
 * Prompt generation, delivery formatting, and session identifier construction.
 *
 * Renders system, initial task, and retry prompts, constructs deterministically hashed
 * provider session identifiers, and prepares benchmark RPC execution arguments.
 */

import { prompt } from "@veyyon/utils";
import type { EditTask } from "../../tasks";
import { EDIT_BENCHMARK_PROMPTS } from "../prompts/registry";
import { buildGuidedContext } from "./guided";
import { BENCHMARK_TOOL_NAMES, type BenchmarkConfig } from "./types";

export type BenchmarkPromptDelivery = {
	kind: "prompt" | "followUp";
	message: string;
};

export function buildInstructions(config: BenchmarkConfig): string {
	return config.noEditRequired
		? "Read the relevant files first, then apply the fix."
		: "Read the relevant files first, then use the edit or vim tool to apply the fix.";
}

export function buildBenchmarkSystemPrompt(params: { multiFile: boolean; config: BenchmarkConfig }): string {
	return prompt.render(EDIT_BENCHMARK_PROMPTS["benchmark-system"].text, {
		multiFile: params.multiFile,
		instructions: buildInstructions(params.config),
	});
}

export function buildInitialBenchmarkPrompt(params: { taskPrompt: string; guidedContext?: string | null }): string {
	return prompt.render(EDIT_BENCHMARK_PROMPTS["benchmark-task"].text, {
		task_prompt: params.taskPrompt,
		guided_context: params.guidedContext ?? undefined,
	});
}

export function buildRetryBenchmarkPrompt(params: { retryContext: string; guidedContext?: string | null }): string {
	return prompt.render(EDIT_BENCHMARK_PROMPTS["benchmark-retry"].text, {
		retry_context: params.retryContext,
		guided_context: params.guidedContext ?? undefined,
	});
}

export function buildBenchmarkPromptDelivery(params: {
	taskPrompt: string;
	guidedContext?: string | null;
	retryContext?: string | null;
}): BenchmarkPromptDelivery {
	if (params.retryContext) {
		return {
			kind: "followUp",
			message: buildRetryBenchmarkPrompt({
				retryContext: params.retryContext,
				guidedContext: params.guidedContext,
			}),
		};
	}

	return {
		kind: "prompt",
		message: buildInitialBenchmarkPrompt({
			taskPrompt: params.taskPrompt,
			guidedContext: params.guidedContext,
		}),
	};
}

const BENCHMARK_PROVIDER_SESSION_VERSION = 1;

export function buildBenchmarkProviderSessionId(params: {
	config: BenchmarkConfig;
	task: EditTask;
	multiFile: boolean;
	initialGuidedContext?: string | null;
}): string {
	const keyMaterial = [
		`version:${BENCHMARK_PROVIDER_SESSION_VERSION}`,
		`provider:${params.config.provider}`,
		`model:${params.config.model}`,
		`task:${params.task.id}`,
		`system:${buildBenchmarkSystemPrompt({ multiFile: params.multiFile, config: params.config })}`,
		`initial:${buildInitialBenchmarkPrompt({ taskPrompt: params.task.prompt, guidedContext: params.initialGuidedContext })}`,
	].join("\n");
	return `reb_${Bun.hash(keyMaterial).toString(36)}`;
}

export function buildBenchmarkRpcArgs(
	config: BenchmarkConfig,
	multiFile: boolean,
	providerSessionId: string,
): string[] {
	return [
		"--provider-session-id",
		providerSessionId,
		"--append-system-prompt",
		buildBenchmarkSystemPrompt({ multiFile, config }),
		"--tools",
		BENCHMARK_TOOL_NAMES.join(","),
		"--no-skills",
		"--no-title",
		"--no-rules",
		"--no-lsp",
	];
}

export async function prepareBenchmarkSessionSetup(params: {
	config: BenchmarkConfig;
	task: EditTask;
	cwd: string;
	expectedDir: string;
	multiFile: boolean;
}): Promise<{ initialGuidedContext: string | null; providerSessionId: string; rpcArgs: string[] }> {
	const initialGuidedContext = await buildGuidedContext(params.task, params.cwd, params.expectedDir, params.config);
	const providerSessionId = buildBenchmarkProviderSessionId({
		config: params.config,
		task: params.task,
		multiFile: params.multiFile,
		initialGuidedContext,
	});
	return {
		initialGuidedContext,
		providerSessionId,
		rpcArgs: buildBenchmarkRpcArgs(params.config, params.multiFile, providerSessionId),
	};
}
