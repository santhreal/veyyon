import type { Api, ApiKey, Model } from "@veyyon/ai";
import { estimateTokensFromText, trimTrailingSlashes } from "@veyyon/utils";
import {
	hostLlmContext,
	hostLlmEnabled as hostLlmEnabledFromEnv,
	llmApiKey as llmApiKeyFromEnv,
	llmBaseUrl as llmBaseUrlFromEnv,
	llmContext,
	llmEnabled as llmEnabledFromEnv,
	llmMaxTokens as llmMaxTokensFromEnv,
	llmModel as llmModelFromEnv,
	sleepPrompt as sleepPromptFromEnv,
} from "../config";
import { getHostLlmBackend } from "./llm-backends";
import { getMnemopiRuntimeOptions, isPiAiModel, type MnemopiLlmCompletion } from "./runtime-options";

function activeLlmOptions() {
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
	return llmEnabledFromEnv();
}

export function llmMaxTokens(): number {
	const active = activeLlmOptions();
	if (active?.maxTokens !== undefined) {
		return active.maxTokens;
	}
	return llmMaxTokensFromEnv();
}

export function llmContextTokens(): number {
	return llmContext();
}

export function hostLlmEnabled(): boolean {
	if (activeCustomCompletion() !== undefined || activePiAiModel() !== undefined) {
		return false;
	}
	const active = activeLlmOptions();
	if (active?.baseUrl !== undefined || (typeof active?.model === "string" && active.model !== "")) {
		return false;
	}
	return hostLlmEnabledFromEnv();
}

function hostLlmContextTokens(): number {
	return hostLlmContext();
}

export function llmBaseUrl(): string {
	const active = activeLlmOptions();
	if (active?.baseUrl !== undefined) {
		return trimTrailingSlashes(active.baseUrl);
	}
	return llmBaseUrlFromEnv();
}

export function llmModelName(): string {
	const model = activeLlmOptions()?.model;
	if (typeof model === "string") {
		return model;
	}
	return llmModelFromEnv() || "local";
}

export function llmApiKey(): ApiKey {
	const active = activeLlmOptions();
	if (active?.apiKey !== undefined) {
		return active.apiKey;
	}
	return llmApiKeyFromEnv();
}

export function sleepPrompt(): string {
	return sleepPromptFromEnv();
}

function memoryLines(memories: readonly string[]): string {
	return memories
		.filter(Boolean)
		.map(memory => `- ${memory}`)
		.join("\n");
}

function formatSleepPrompt(memories: readonly string[], source = ""): string | null {
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

const SUMMARY_HEADER =
	"Summarize the following memories into 1-3 concise sentences. Preserve facts, names, preferences, and decisions. Discard fluff.";

function summaryHeader(source: string): string {
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

function promptTokenBudget(): number {
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
