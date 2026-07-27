/**
 * Everything the memory LLM client decides BEFORE it calls anything.
 *
 * WHY THIS FILE EXISTS. `local-llm.ts` answers two different questions. "Is an LLM configured, what
 * is its context budget, how do I build the prompt, how do I clean the output" is configuration and
 * text. "Send this prompt to a provider" is a network round trip through `completeSimple`, which is
 * the streaming engine and reaches 299 modules.
 *
 * They were one module, so every consumer of the first question paid for the second, and the memory
 * engine is full of consumers: `core/extraction.ts` asks `llmAvailable()` and `cleanOutput()` on
 * paths that may never call a model at all, and `core/beam/consolidate.ts` sits behind extraction,
 * and `core/beam/index.ts` sits behind consolidate. One provider import was reaching the whole
 * memory subsystem through three hops.
 *
 * WHAT BELONGS HERE. Anything that reads configuration, formats a prompt, budgets tokens or cleans a
 * response. Nothing that performs a call. The helpers below are exported rather than module-private
 * because the calling half needs them too, and a second copy of "which model is configured" is the
 * one thing this split must not produce.
 */

import type { Api, ApiKey, Model } from "@veyyon/ai";
import { estimateTokensFromText, trimTrailingSlashes } from "@veyyon/utils";
import { envBool, envInt, envString } from "../util/env";
import { getHostLlmBackend } from "./llm-backends";
import { getMnemopiRuntimeOptions, isPiAiModel, type MnemopiLlmCompletion } from "./runtime-options";

const ENV_MODEL_REPO = process.env.MNEMOPI_LLM_REPO ?? "";
const ENV_MODEL_FILE = process.env.MNEMOPI_LLM_FILE ?? "";
export const DEFAULT_MODEL_REPO =
	ENV_MODEL_REPO !== "" && ENV_MODEL_FILE !== "" ? ENV_MODEL_REPO : "TheBloke/TinyLlama-1.1B-Chat-v1.0-GGUF";
export const DEFAULT_MODEL_FILE =
	ENV_MODEL_REPO !== "" && ENV_MODEL_FILE !== "" ? ENV_MODEL_FILE : "tinyllama-1.1b-chat-v1.0.Q4_K_M.gguf";

export function activeLlmOptions() {
	return getMnemopiRuntimeOptions()?.llm;
}

export function activeCustomCompletion(): MnemopiLlmCompletion | undefined {
	return activeLlmOptions()?.complete;
}

export function activePiAiModel(): Model<Api> | undefined {
	const model = activeLlmOptions()?.model;
	return isPiAiModel(model) ? model : undefined;
}

export function llmEnabled(): boolean {
	const active = activeLlmOptions();
	if (active?.enabled !== undefined) {
		return active.enabled;
	}
	if (activeCustomCompletion() !== undefined || activePiAiModel() !== undefined) {
		return true;
	}
	return envBool("MNEMOPI_LLM_ENABLED", true);
}

export function llmMaxTokens(): number {
	const active = activeLlmOptions();
	if (active?.maxTokens !== undefined) {
		return active.maxTokens;
	}
	return envInt("MNEMOPI_LLM_MAX_TOKENS", 2048);
}

export function llmContextTokens(): number {
	return envInt("MNEMOPI_LLM_N_CTX", 2048);
}

export function hostLlmEnabled(): boolean {
	if (activeCustomCompletion() !== undefined || activePiAiModel() !== undefined) {
		return false;
	}
	const active = activeLlmOptions();
	if (active?.baseUrl !== undefined || (typeof active?.model === "string" && active.model !== "")) {
		return false;
	}
	return envBool("MNEMOPI_HOST_LLM_ENABLED", false);
}

export function hostLlmContextTokens(): number {
	return envInt("MNEMOPI_HOST_LLM_N_CTX", 32000);
}

export function llmBaseUrl(): string {
	const active = activeLlmOptions();
	if (active?.baseUrl !== undefined) {
		return trimTrailingSlashes(active.baseUrl);
	}
	return trimTrailingSlashes(envString("MNEMOPI_LLM_BASE_URL"));
}

export function llmModelName(): string {
	const model = activeLlmOptions()?.model;
	if (typeof model === "string") {
		return model;
	}
	return envString("MNEMOPI_LLM_MODEL") || "local";
}

export function llmApiKey(): ApiKey {
	const active = activeLlmOptions();
	if (active?.apiKey !== undefined) {
		return active.apiKey;
	}
	return envString("MNEMOPI_LLM_API_KEY");
}

export function sleepPrompt(): string {
	return envString("MNEMOPI_SLEEP_PROMPT").trim();
}

export function memoryLines(memories: readonly string[]): string {
	return memories
		.filter(Boolean)
		.map(memory => `- ${memory}`)
		.join("\n");
}

export function formatSleepPrompt(memories: readonly string[], source = ""): string | null {
	const override = getMnemopiRuntimeOptions()?.llm?.consolidationPrompt;
	const template = override !== undefined && override !== "" ? override : sleepPrompt();
	if (template === "") {
		return null;
	}

	let rendered = template;
	rendered = rendered.split("{source}").join(source);
	rendered = rendered.split("{memories}").join(memoryLines(memories));
	rendered = rendered.split("{memory_count}").join(String(memories.filter(Boolean).length));
	return rendered;
}

/** The instruction preamble shared by every summarization prompt and the budget estimate. */
const SUMMARY_HEADER =
	"Summarize the following memories into 1-3 concise sentences. Preserve facts, names, preferences, and decisions. Discard fluff.";

/** {@link SUMMARY_HEADER} with an optional ` Source: <source>.` suffix when a source is named. */
export function summaryHeader(source: string): string {
	return source === "" ? SUMMARY_HEADER : `${SUMMARY_HEADER} Source: ${source}.`;
}

export function buildPrompt(memories: readonly string[], source = ""): string {
	const custom = formatSleepPrompt(memories, source);
	if (custom !== null) {
		return custom;
	}

	return `/no_think\n${summaryHeader(source)}\n\n${memoryLines(memories)}\n\nSummary:`;
}

export function buildHostPrompt(memories: readonly string[], source = ""): string {
	const custom = formatSleepPrompt(memories, source);
	if (custom !== null) {
		return custom;
	}

	return `${summaryHeader(source)}\n\n${memoryLines(memories)}`;
}

export function hostBackendWillHandleCall(): boolean {
	return llmEnabled() && hostLlmEnabled() && getHostLlmBackend() !== null;
}

export function configuredLlmWillHandleCall(): boolean {
	return llmEnabled() && (activeCustomCompletion() !== undefined || activePiAiModel() !== undefined);
}

export function cleanOutput(text: string): string {
	return text
		.replaceAll("<|assistant|>", "")
		.replaceAll("<|user|>", "")
		.replaceAll("</s>", "")
		.trim()
		.replace(/^(Summarize the following memories.*?[.!?:]\s*)/is, "")
		.replace(/^(Preserve facts.*?[.!?:]\s*)/is, "")
		.replace(/^Source:.*?\n/im, "")
		.replace(/^\s*[-*]\s.*\n/gm, "")
		.trim();
}

export function promptTokenBudget(): number {
	const overhead = 80;
	const nCtx = hostBackendWillHandleCall() ? hostLlmContextTokens() : llmContextTokens();
	const outputReserve = Math.min(llmMaxTokens(), Math.max(128, Math.floor(nCtx / 4)));
	const safetyMargin = Math.floor(nCtx * 0.2);
	return Math.max(64, nCtx - overhead - outputReserve - safetyMargin);
}

export function chunkMemoriesByBudget(memories: readonly string[], source = ""): string[][] {
	if (memories.length === 0) {
		return [];
	}

	const budget = promptTokenBudget();
	const chunks: string[][] = [];
	let currentChunk: string[] = [];
	let currentTokens = 0;

	const headerTokens = estimateTokensFromText(`${summaryHeader(source)}\n\n`);
	const formatOverhead = estimateTokensFromText("- \n");
	const available = budget - headerTokens;

	for (const memory of memories) {
		const memTokens = estimateTokensFromText(memory) + formatOverhead;
		if (memTokens > budget) {
			continue;
		}
		if (currentTokens + memTokens > available && currentChunk.length > 0) {
			chunks.push(currentChunk);
			currentChunk = [];
			currentTokens = 0;
		}
		currentChunk.push(memory);
		currentTokens += memTokens;
	}

	if (currentChunk.length > 0) {
		chunks.push(currentChunk);
	}
	return chunks;
}

export function llmAvailable(): boolean {
	if (configuredLlmWillHandleCall()) {
		return true;
	}
	if (hostBackendWillHandleCall()) {
		return true;
	}
	return llmEnabled() && llmBaseUrl() !== "";
}
