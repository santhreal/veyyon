/**
 * The half of the memory LLM client that actually calls a model.
 *
 * The configuration, prompt building, token budgeting and output cleaning live in
 * `local-llm-config.ts`, which reaches a handful of leaves. This file imports `completeSimple` and
 * therefore the streaming engine, which is correct for a module whose job is the round trip, and is
 * why the two halves are separate files: `core/extraction.ts` asks whether an LLM is available far
 * more often than it calls one, and the memory engine sits behind extraction.
 *
 * The configuration names are re-exported so the module's public surface is unchanged. There is no
 * cycle to worry about: the config half imports nothing from here.
 */

import type { FetchImpl } from "@veyyon/ai";
import { withAuth } from "@veyyon/ai/auth-retry";
import { ProviderHttpError } from "@veyyon/ai/error";
import { completeSimple } from "@veyyon/ai/stream";
import { assistantText } from "@veyyon/ai/utils/message-text";
import { withScopedTimeoutSignal } from "@veyyon/utils";
import { envBool, envString } from "../util/env";
import { safeForLog } from "./extraction/diagnostics";
import { type CompleteOptions, callHostLlm } from "./llm-backends";
import {
	activeCustomCompletion,
	activePiAiModel,
	buildHostPrompt,
	buildPrompt,
	chunkMemoriesByBudget,
	cleanOutput,
	configuredLlmWillHandleCall,
	hostBackendWillHandleCall,
	llmApiKey,
	llmBaseUrl,
	llmEnabled,
	llmMaxTokens,
	llmModelName,
} from "./local-llm-config";
import { getMnemopiRuntimeOptions, type MnemopiLlmCompleteOptions } from "./runtime-options";

export * from "./local-llm-config";

/** Transport override for {@link callRemoteLlm}, so a test can supply its own `fetch`. */
export interface RemoteLlmOptions {
	fetch?: FetchImpl;
}

function sanitizeLlmProviderText(text: string): string {
	const sanitize = getMnemopiRuntimeOptions()?.llm?.sanitizeProviderText;
	if (sanitize === undefined) return text;
	try {
		return sanitize(text);
	} catch {
		throw new Error("Mnemopi provider text sanitization failed.");
	}
}

/**
 * This is restricted to completeSimple's freshly built, one-message request.
 * It must not be reused for restored/native replay payloads whose authenticated
 * or encrypted fields are intentionally opaque.
 * Mutating in place also covers provider adapters that invoke onPayload but
 * ignore its replacement return value.
 */
function sanitizeFreshLlmPayload(payload: unknown): unknown {
	if (typeof payload === "string") return sanitizeLlmProviderText(payload);
	if (Array.isArray(payload)) {
		for (let index = 0; index < payload.length; index++) payload[index] = sanitizeFreshLlmPayload(payload[index]);
		return payload;
	}
	if (payload === null || typeof payload !== "object") return payload;
	const mutable = payload as Record<string, unknown>;
	for (const [key, value] of Object.entries(mutable)) mutable[key] = sanitizeFreshLlmPayload(value);
	return mutable;
}

export async function callConfiguredCompletion(
	prompt: string,
	temperature: number,
	opts: MnemopiLlmCompleteOptions = {},
): Promise<string | null> {
	const completion = activeCustomCompletion();
	const providerPrompt = sanitizeLlmProviderText(prompt);
	if (completion !== undefined) {
		const raw = await completion(providerPrompt, {
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
			messages: [{ role: "user", content: providerPrompt, timestamp: Date.now() }],
		},
		{
			apiKey: llmApiKey() || undefined,
			maxTokens: opts.maxTokens ?? llmMaxTokens(),
			temperature,
			onPayload: sanitizeFreshLlmPayload,
		},
	);
	return assistantText(message).trim() || null;
}

async function tryHostLlm(prompt: string, maxTokens: number, temperature: number): Promise<[boolean, string | null]> {
	if (!hostBackendWillHandleCall()) {
		return [false, null];
	}

	try {
		const raw = await callHostLlm(sanitizeLlmProviderText(prompt), {
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

export async function callRemoteLlm(
	prompt: string,
	temperature = 0.3,
	options: RemoteLlmOptions = {},
): Promise<string | null> {
	const baseUrl = llmBaseUrl();
	if (baseUrl === "") {
		return null;
	}

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
			// withAuth has resolved/refreshed credentials before entering this
			// callback, and re-enters it for every auth retry. Build a new body
			// here so a runtime sanitizer swap is authoritative for each send.
			const body = JSON.stringify({
				model: llmModelName(),
				messages: [{ role: "user", content: sanitizeLlmProviderText(prompt) }],
				max_tokens: llmMaxTokens(),
				temperature,
				stop: ["</s>", "<|user|>"],
			});
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

/**
 * Whether the remote HTTP backend may be called: the one owner of that three-part condition.
 *
 * It was written out twice, in `summarizeChunk` and in `complete`, so the two could disagree about
 * when memory traffic is allowed to leave the machine. That is the wrong thing to have two copies of.
 *
 * `MNEMOPI_FORCE_LOCAL` keeps its spelling even though it no longer names anything: an operator sets
 * it to keep memory traffic off the network, and renaming the variable would silently re-enable those
 * calls for everyone who set it. What it does is SUPPRESS the remote backend. It does not select a
 * local one, because the local-GGUF tier it was named for never had an implementation and is gone.
 */
function remoteBackendAllowed(): boolean {
	return llmEnabled() && llmBaseUrl() !== "" && !envBool("MNEMOPI_FORCE_LOCAL", false);
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
		// The host backend answered, so it OWNS this call: a null here means it produced no usable
		// text, not that another backend should be tried. There used to be a `callLocalLlm` attempt
		// after this and after the remote branch below, both of them a `return null` stub with no
		// loader behind them, so each one cleaned and inspected output that could not arrive.
		return hostText;
	}

	if (remoteBackendAllowed()) {
		return await summaryOrNull("remote LLM", () => callRemoteLlm(prompt, 0.3, options));
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

	const sanitize = getMnemopiRuntimeOptions()?.llm?.sanitizeProviderText;
	const providerMemories = sanitize === undefined ? memories : memories.map(sanitizeLlmProviderText);
	const providerSource = sanitize === undefined ? source : sanitizeLlmProviderText(source);
	const chunks = chunkMemoriesByBudget(providerMemories, providerSource);
	const chunkSummaries: string[] = [];
	for (const chunk of chunks) {
		const summary = await summarizeChunk(chunk, providerSource, options);
		if (summary !== null) {
			chunkSummaries.push(summary);
		}
	}

	if (chunkSummaries.length === 0) {
		return null;
	}
	if (chunkSummaries.length > 1) {
		const final = await summarizeChunk(chunkSummaries, `${providerSource} [chunked ${chunks.length} parts]`, options);
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
	if (remoteBackendAllowed()) {
		return await summaryOrNull("remote LLM", () => callRemoteLlm(prompt, temperature, options));
	}
	// No backend is configured. Null is the honest answer, and the caller (extraction, consolidation)
	// records it as such. This used to `return callLocalLlm(prompt)`, which returned this same null
	// through a function that read nothing.
	return null;
}
