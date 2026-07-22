import { type Api, type ApiKey, assistantText, completeSimple, type FetchImpl, type Model, withAuth } from "@veyyon/ai";
import { ProviderHttpError } from "@veyyon/ai/error";
import { estimateTokensFromText, trimTrailingSlashes, withScopedTimeoutSignal } from "@veyyon/utils";
import { envBool, envInt, envString } from "../util/env";
import { safeForLog } from "./extraction/diagnostics";
import { type CompleteOptions, callHostLlm, getHostLlmBackend } from "./llm-backends";
import {
	getMnemopiRuntimeOptions,
	isPiAiModel,
	type MnemopiLlmCompleteOptions,
	type MnemopiLlmCompletion,
} from "./runtime-options";

const ENV_MODEL_REPO = process.env.MNEMOPI_LLM_REPO ?? "";
export interface RemoteLlmOptions {
	fetch?: FetchImpl;
}

const ENV_MODEL_FILE = process.env.MNEMOPI_LLM_FILE ?? "";
export const DEFAULT_MODEL_REPO =
	ENV_MODEL_REPO !== "" && ENV_MODEL_FILE !== "" ? ENV_MODEL_REPO : "TheBloke/TinyLlama-1.1B-Chat-v1.0-GGUF";
export const DEFAULT_MODEL_FILE =
	ENV_MODEL_REPO !== "" && ENV_MODEL_FILE !== "" ? ENV_MODEL_FILE : "tinyllama-1.1b-chat-v1.0.Q4_K_M.gguf";

function activeLlmOptions() {
	return getMnemopiRuntimeOptions()?.llm;
}

function activeCustomCompletion(): MnemopiLlmCompletion | undefined {
	return activeLlmOptions()?.complete;
}

function activePiAiModel(): Model<Api> | undefined {
	const model = activeLlmOptions()?.model;
	return isPiAiModel(model) ? model : undefined;
}

function llmEnabled(): boolean {
	const active = activeLlmOptions();
	if (active?.enabled !== undefined) {
		return active.enabled;
	}
	if (activeCustomCompletion() !== undefined || activePiAiModel() !== undefined) {
		return true;
	}
	return envBool("MNEMOPI_LLM_ENABLED", true);
}

function llmMaxTokens(): number {
	const active = activeLlmOptions();
	if (active?.maxTokens !== undefined) {
		return active.maxTokens;
	}
	return envInt("MNEMOPI_LLM_MAX_TOKENS", 2048);
}

function llmContextTokens(): number {
	return envInt("MNEMOPI_LLM_N_CTX", 2048);
}

function hostLlmEnabled(): boolean {
	if (activeCustomCompletion() !== undefined || activePiAiModel() !== undefined) {
		return false;
	}
	const active = activeLlmOptions();
	if (active?.baseUrl !== undefined || (typeof active?.model === "string" && active.model !== "")) {
		return false;
	}
	return envBool("MNEMOPI_HOST_LLM_ENABLED", false);
}

function hostLlmContextTokens(): number {
	return envInt("MNEMOPI_HOST_LLM_N_CTX", 32000);
}

function llmBaseUrl(): string {
	const active = activeLlmOptions();
	if (active?.baseUrl !== undefined) {
		return trimTrailingSlashes(active.baseUrl);
	}
	return trimTrailingSlashes(envString("MNEMOPI_LLM_BASE_URL"));
}

function llmModelName(): string {
	const model = activeLlmOptions()?.model;
	if (typeof model === "string") {
		return model;
	}
	return envString("MNEMOPI_LLM_MODEL") || "local";
}

function llmApiKey(): ApiKey {
	const active = activeLlmOptions();
	if (active?.apiKey !== undefined) {
		return active.apiKey;
	}
	return envString("MNEMOPI_LLM_API_KEY");
}

function sleepPrompt(): string {
	return envString("MNEMOPI_SLEEP_PROMPT").trim();
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

/** The instruction preamble shared by every summarization prompt and the budget estimate. */
const SUMMARY_HEADER =
	"Summarize the following memories into 1-3 concise sentences. Preserve facts, names, preferences, and decisions. Discard fluff.";

/** {@link SUMMARY_HEADER} with an optional ` Source: <source>.` suffix when a source is named. */
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

export async function callConfiguredCompletion(
	prompt: string,
	temperature: number,
	opts: MnemopiLlmCompleteOptions = {},
): Promise<string | null> {
	const completion = activeCustomCompletion();
	if (completion !== undefined) {
		const raw = await completion(prompt, {
			maxTokens: opts.maxTokens ?? llmMaxTokens(),
			temperature,
			timeout: opts.timeout,
			provider: opts.provider,
			model: opts.model,
		});
		return typeof raw === "string" ? raw : null;
	}
	const model = activePiAiModel();
	if (model === undefined) {
		return null;
	}
	// Do NOT swallow a model error to null here. Like the custom-completion path
	// above (which already propagates), a throw from completeSimple (the provider
	// crashed, rate-limited, or timed out) is a real failure and must reach the
	// caller: extraction records it as configured_completion_raised, and
	// summarization logs it and falls through. A `catch { return null }` would
	// misreport a crashed model as "no output" (a Law 10 silent fallback).
	const message = await completeSimple(
		model,
		{
			messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
		},
		{
			apiKey: llmApiKey() || undefined,
			maxTokens: opts.maxTokens ?? llmMaxTokens(),
			temperature,
		},
	);
	return assistantText(message).trim() || null;
}

export function buildHostPrompt(memories: readonly string[], source = ""): string {
	const custom = formatSleepPrompt(memories, source);
	if (custom !== null) {
		return custom;
	}

	return `${summaryHeader(source)}\n\n${memoryLines(memories)}`;
}

function hostBackendWillHandleCall(): boolean {
	return llmEnabled() && hostLlmEnabled() && getHostLlmBackend() !== null;
}

export function configuredLlmWillHandleCall(): boolean {
	return llmEnabled() && (activeCustomCompletion() !== undefined || activePiAiModel() !== undefined);
}

async function tryHostLlm(prompt: string, maxTokens: number, temperature: number): Promise<[boolean, string | null]> {
	if (!hostBackendWillHandleCall()) {
		return [false, null];
	}

	try {
		const raw = await callHostLlm(prompt, {
			maxTokens,
			temperature,
			timeout: 15,
			provider: envString("MNEMOPI_HOST_LLM_PROVIDER").trim() || null,
			model: envString("MNEMOPI_HOST_LLM_MODEL").trim() || null,
		});
		const text = typeof raw === "string" ? raw.trim() : "";
		return [true, text === "" ? null : text];
	} catch (exc) {
		// The host backend threw. This is a real failure, not "no output":
		// surface it loudly (never a silent swallow) and report the call as
		// attempted-but-empty so summarization falls through to a local backend
		// with the error on the record. A fallback is allowed only when it is
		// loud and recall-preserving (Law 10).
		console.warn(`mnemopi summarize: host LLM backend raised: ${safeForLog(exc)}`);
		return [true, null];
	}
}

// Run a summarization LLM call, surfacing any failure loudly and falling
// through to the next backend. A thrown error here (network, timeout, HTTP
// non-2xx, a crashed configured/host model) is a real failure, never "no
// output": log it (never silently swallow, Law 10) and return null so the
// caller tries the next path. This is the ONE place the summarization backends
// (configured, remote) turn a failure into a loud, recall-preserving fallback.
async function summaryOrNull(label: string, call: () => Promise<string | null>): Promise<string | null> {
	try {
		const raw = await call();
		if (raw === null) {
			return null;
		}
		const cleaned = cleanOutput(raw);
		return cleaned === "" ? null : cleaned;
	} catch (exc) {
		console.warn(`mnemopi summarize: ${label} raised: ${safeForLog(exc)}`);
		return null;
	}
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

export async function callRemoteLlm(
	prompt: string,
	temperature = 0.3,
	options: RemoteLlmOptions = {},
): Promise<string | null> {
	const baseUrl = llmBaseUrl();
	if (baseUrl === "") {
		return null;
	}

	const body = JSON.stringify({
		model: llmModelName(),
		messages: [{ role: "user", content: prompt }],
		max_tokens: llmMaxTokens(),
		temperature,
		stop: ["</s>", "<|user|>"],
	});
	const fetchImpl = options.fetch ?? fetch;
	// Do NOT wrap this in `catch { return null }`. A thrown error (network down,
	// timeout, JSON parse failure) or a non-2xx HTTP response is a real failure
	// and must reach the caller: extraction records it as remote_call_raised, and
	// summarization logs it and falls through to a local backend. Swallowing it to
	// null would misreport a hard failure as "the model produced no output",
	// hiding the error from the operator (a Law 10 silent fallback).
	//
	// withAuth re-resolves the key on 401 (force-refresh, then sibling rotation)
	// when the configured key is a resolver. An empty static key attempts without
	// an Authorization header (local/proxy setups). One 60s fence spans every auth
	// attempt AND the body read (a stalled stream is only interrupted by the armed
	// signal); the timer clears on settle instead of lingering like a bare
	// AbortSignal.timeout.
	return await withScopedTimeoutSignal(60000, async signal => {
		const response = await withAuth(llmApiKey(), async key => {
			const headers: Record<string, string> = { "Content-Type": "application/json" };
			if (key !== "") {
				headers.Authorization = `Bearer ${key}`;
			}
			const res = await fetchImpl(`${baseUrl}/chat/completions`, {
				method: "POST",
				headers,
				body,
				signal,
			});
			if (res.status === 401) {
				throw new ProviderHttpError("mnemopi remote LLM request unauthorized (401)", 401, {
					headers: res.headers,
				});
			}
			return res;
		});
		if (!response.ok) {
			throw new ProviderHttpError(`mnemopi remote LLM request failed (HTTP ${response.status})`, response.status, {
				headers: response.headers,
			});
		}
		const data = (await response.json()) as {
			choices?: Array<{ message?: { content?: unknown } }>;
		};
		const content = data.choices?.[0]?.message?.content;
		return typeof content === "string" ? content : null;
	});
}

export function localGgufAvailable(): false {
	return false;
}

export async function callLocalLlm(_prompt: string): Promise<string | null> {
	return null;
}

async function summarizeChunk(
	memories: readonly string[],
	source = "",
	options: RemoteLlmOptions = {},
): Promise<string | null> {
	const hostPrompt = buildHostPrompt(memories, source);
	const prompt = buildPrompt(memories, source);
	if (configuredLlmWillHandleCall()) {
		return await summaryOrNull("configured completion", () =>
			callConfiguredCompletion(hostPrompt, 0.3, { maxTokens: llmMaxTokens() }),
		);
	}
	const [attempted, hostText] = await tryHostLlm(hostPrompt, llmMaxTokens(), 0.3);
	if (attempted) {
		if (hostText !== null) {
			return hostText;
		}
		const raw = await callLocalLlm(prompt);
		if (raw !== null) {
			const cleaned = cleanOutput(raw);
			return cleaned === "" ? null : cleaned;
		}
		return null;
	}

	if (llmEnabled() && llmBaseUrl() !== "" && !envBool("MNEMOPI_FORCE_LOCAL", false)) {
		const summary = await summaryOrNull("remote LLM", () => callRemoteLlm(prompt, 0.3, options));
		if (summary !== null) {
			return summary;
		}
	}

	const raw = await callLocalLlm(prompt);
	if (raw !== null) {
		const cleaned = cleanOutput(raw);
		return cleaned === "" ? null : cleaned;
	}
	return null;
}

export async function summarizeMemories(
	memories: readonly string[],
	source = "",
	options: RemoteLlmOptions = {},
): Promise<string | null> {
	if (memories.length === 0) {
		return null;
	}

	const chunks = chunkMemoriesByBudget(memories, source);
	const chunkSummaries: string[] = [];
	for (const chunk of chunks) {
		const summary = await summarizeChunk(chunk, source, options);
		if (summary !== null) {
			chunkSummaries.push(summary);
		}
	}

	if (chunkSummaries.length === 0) {
		return null;
	}
	if (chunkSummaries.length > 1) {
		const final = await summarizeChunk(chunkSummaries, `${source} [chunked ${chunks.length} parts]`, options);
		return final ?? chunkSummaries[0] ?? null;
	}
	return chunkSummaries[0] ?? null;
}

export async function complete(
	prompt: string,
	temperature = 0.3,
	options: CompleteOptions = {},
): Promise<string | null> {
	if (configuredLlmWillHandleCall()) {
		return await summaryOrNull("configured completion", () =>
			callConfiguredCompletion(prompt, temperature, { maxTokens: llmMaxTokens() }),
		);
	}
	const [attempted, hostText] = await tryHostLlm(prompt, llmMaxTokens(), temperature);
	if (attempted) {
		return hostText;
	}
	if (llmEnabled() && llmBaseUrl() !== "" && !envBool("MNEMOPI_FORCE_LOCAL", false)) {
		return await summaryOrNull("remote LLM", () => callRemoteLlm(prompt, temperature, options));
	}
	return callLocalLlm(prompt);
}
