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
import {
	MNEMOPI_LLM_ATTEMPT_PLACEHOLDER,
	type CompleteOptions,
	callHostLlm,
	getHostLlmBackend,
} from "./llm-backends";
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
import {
	getMnemopiRuntimeOptions,
	type MnemopiLlmCompleteOptions,
	type MnemopiLlmPayloadHook,
} from "./runtime-options";

export * from "./local-llm-config";

/** Transport override for {@link callRemoteLlm}, so a test can supply its own `fetch`. */
export interface RemoteLlmOptions {
	fetch?: FetchImpl;
	onPayload?: MnemopiLlmPayloadHook;
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
 * Build a fresh projection from raw prompt state every time a physical online
 * attempt invokes the hook. The placeholder is the only prompt text present
 * before then, so an adapter that skips the hook cannot leak the raw context.
 */
function createAttemptPayloadHook(buildPrompt: () => string): MnemopiLlmPayloadHook {
	return payload => {
		let providerPrompt: string | undefined;
		const visit = (value: unknown): unknown => {
			if (typeof value === "string") {
				if (value === MNEMOPI_LLM_ATTEMPT_PLACEHOLDER) {
					providerPrompt ??= buildPrompt();
					return providerPrompt;
				}
				return sanitizeLlmProviderText(value);
			}
			if (Array.isArray(value)) {
				for (let index = 0; index < value.length; index += 1) value[index] = visit(value[index]);
				return value;
			}
			if (value === null || typeof value !== "object") return value;
			const mutable = value as Record<string, unknown>;
			for (const [key, child] of Object.entries(mutable)) mutable[key] = visit(child);
			return mutable;
		};
		return visit(payload);
	};
}

function createAttemptFetch(baseFetch: FetchImpl, onPayload: MnemopiLlmPayloadHook): FetchImpl {
	const attemptFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		let requestInput = input;
		let requestInit = init;
		if (init?.body !== undefined && init.body !== null) {
			if (typeof init.body !== "string") {
				throw new Error("Mnemopi could not apply attempt-time sanitization to a non-JSON provider body.");
			}
			let payload: unknown;
			try {
				payload = JSON.parse(init.body) as unknown;
			} catch {
				throw new Error("Mnemopi could not apply attempt-time sanitization to an invalid provider body.");
			}
			requestInit = { ...init, body: JSON.stringify(await onPayload(payload)) };
		} else if (input instanceof Request) {
			let payload: unknown;
			try {
				payload = JSON.parse(await input.clone().text()) as unknown;
			} catch {
				throw new Error("Mnemopi could not apply attempt-time sanitization to an invalid provider request.");
			}
			requestInput = new Request(input, { body: JSON.stringify(await onPayload(payload)) });
		} else {
			throw new Error("Mnemopi online completion produced no interceptable request body.");
		}
		return baseFetch(requestInput, requestInit);
	};
	return attemptFetch as FetchImpl;
}

function configuredCompletionRequiresAttemptHook(): boolean {
	const completion = activeCustomCompletion();
	return (
		getMnemopiRuntimeOptions()?.llm?.sanitizeProviderText !== undefined ||
		completion?.online === true ||
		activePiAiModel()?.transport === "pi-native"
	);
}

export async function callConfiguredCompletion(
	prompt: string,
	temperature: number,
	opts: MnemopiLlmCompleteOptions = {},
): Promise<string | null> {
	const completion = activeCustomCompletion();
	const commonOptions = {
		maxTokens: opts.maxTokens ?? llmMaxTokens(),
		temperature,
		timeout: opts.timeout,
		provider: opts.provider,
		model: opts.model,
		fetch: opts.fetch,
	};
	if (completion !== undefined) {
		if (!configuredCompletionRequiresAttemptHook()) {
			const raw = await completion(prompt, commonOptions);
			return typeof raw === "string" ? raw : null;
		}
		if (completion.supportsAttemptPayload !== true) {
			throw new Error("Online Mnemopi completion does not support attempt-time payload sanitization.");
		}

		const hook = opts.onPayload ?? createAttemptPayloadHook(() => sanitizeLlmProviderText(prompt));
		let applied = false;
		const onPayload: MnemopiLlmPayloadHook = async payload => {
			applied = true;
			return await hook(payload);
		};
		const raw = await completion(MNEMOPI_LLM_ATTEMPT_PLACEHOLDER, { ...commonOptions, onPayload });
		if (!applied) {
			throw new Error("Online Mnemopi completion did not apply its attempt-time payload hook.");
		}
		return typeof raw === "string" ? raw : null;
	}

	const model = activePiAiModel();
	if (model === undefined) {
		return null;
	}
	const needsAttemptHook = configuredCompletionRequiresAttemptHook() || opts.onPayload !== undefined;
	let physicalAttempts = 0;
	const hook = opts.onPayload ?? createAttemptPayloadHook(() => sanitizeLlmProviderText(prompt));
	const contextPrompt = needsAttemptHook ? MNEMOPI_LLM_ATTEMPT_PLACEHOLDER : prompt;
	const message = await completeSimple(
		model,
		{
			messages: [{ role: "user", content: contextPrompt, timestamp: Date.now() }],
		},
		{
			apiKey: llmApiKey() || undefined,
			maxTokens: opts.maxTokens ?? llmMaxTokens(),
			temperature,
			fetch: needsAttemptHook
				? createAttemptFetch(opts.fetch ?? globalThis.fetch, async payload => {
						physicalAttempts += 1;
						return await hook(payload);
					})
				: opts.fetch,
		},
	);
	if (needsAttemptHook && physicalAttempts === 0) {
		throw new Error("Mnemopi SDK completion did not expose a physical attempt payload.");
	}
	return assistantText(message).trim() || null;
}

async function tryHostLlm(
	prompt: string,
	maxTokens: number,
	temperature: number,
	onPayload?: MnemopiLlmPayloadHook,
): Promise<[boolean, string | null]> {
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
			onPayload,
		});
		const text = typeof raw === "string" ? raw.trim() : "";
		return [true, text === "" ? null : text];
	} catch (exc) {
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
			// Credentials are resolved before this callback, and every auth retry
			// re-enters it. A summary hook reconstructs its capped/chunked prompt
			// from raw memories here; ordinary calls sanitize their raw prompt here.
			const projected =
				options.onPayload === undefined
					? sanitizeLlmProviderText(prompt)
					: await options.onPayload(MNEMOPI_LLM_ATTEMPT_PLACEHOLDER);
			if (typeof projected !== "string") {
				throw new Error("Mnemopi LLM attempt hook did not return a string prompt.");
			}
			const body = JSON.stringify({
				model: llmModelName(),
				messages: [{ role: "user", content: projected }],
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

interface SummaryAttemptState {
	chunkCount: number;
}

function buildSummaryAttemptPrompt(
	memories: readonly string[],
	source: string,
	chunkIndex: number,
	hostPrompt: boolean,
	online: boolean,
	state: SummaryAttemptState,
): string {
	const sanitize = online ? getMnemopiRuntimeOptions()?.llm?.sanitizeProviderText : undefined;
	const providerMemories = sanitize === undefined ? memories : memories.map(sanitizeLlmProviderText);
	const providerSource = sanitize === undefined ? source : sanitizeLlmProviderText(source);
	const chunks = chunkMemoriesByBudget(providerMemories, providerSource);
	state.chunkCount = chunks.length;
	const chunk = chunks[chunkIndex];
	if (chunk === undefined) {
		throw new Error("Mnemopi summary attempt has no input chunk after payload sanitization.");
	}
	return hostPrompt ? buildHostPrompt(chunk, providerSource) : buildPrompt(chunk, providerSource);
}

function summaryAttemptHook(
	memories: readonly string[],
	source: string,
	chunkIndex: number,
	hostPrompt: boolean,
	state: SummaryAttemptState,
): MnemopiLlmPayloadHook {
	return createAttemptPayloadHook(() =>
		buildSummaryAttemptPrompt(memories, source, chunkIndex, hostPrompt, true, state),
	);
}

async function summarizeChunk(
	memories: readonly string[],
	source: string,
	chunkIndex: number,
	state: SummaryAttemptState,
	options: RemoteLlmOptions,
): Promise<string | null> {
	if (configuredLlmWillHandleCall()) {
		if (configuredCompletionRequiresAttemptHook()) {
			const rawContext = buildHostPrompt(memories, source);
			return await summaryOrNull("configured completion", () =>
				callConfiguredCompletion(rawContext, 0.3, {
					maxTokens: llmMaxTokens(),
					fetch: options.fetch,
					onPayload: summaryAttemptHook(memories, source, chunkIndex, true, state),
				}),
			);
		}
		const prompt = buildSummaryAttemptPrompt(memories, source, chunkIndex, true, false, state);
		return await summaryOrNull("configured completion", () =>
			callConfiguredCompletion(prompt, 0.3, { maxTokens: llmMaxTokens(), fetch: options.fetch }),
		);
	}

	if (hostBackendWillHandleCall()) {
		const hostOnline = getHostLlmBackend()?.online === true;
		const hostPrompt = hostOnline
			? buildHostPrompt(memories, source)
			: buildSummaryAttemptPrompt(memories, source, chunkIndex, true, false, state);
		const [attempted, hostText] = await tryHostLlm(
			hostPrompt,
			llmMaxTokens(),
			0.3,
			hostOnline ? summaryAttemptHook(memories, source, chunkIndex, true, state) : undefined,
		);
		if (attempted) {
			return hostText;
		}
	}

	if (remoteBackendAllowed()) {
		const rawContext = buildPrompt(memories, source);
		return await summaryOrNull("remote LLM", () =>
			callRemoteLlm(rawContext, 0.3, {
				...options,
				onPayload: summaryAttemptHook(memories, source, chunkIndex, false, state),
			}),
		);
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

	const chunkSummaries: string[] = [];
	let chunkCount = 1;
	for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
		const state: SummaryAttemptState = { chunkCount: 0 };
		const summary = await summarizeChunk(memories, source, chunkIndex, state, options);
		if (state.chunkCount === 0) break;
		chunkCount = state.chunkCount;
		if (summary !== null) {
			chunkSummaries.push(summary);
		}
	}

	if (chunkSummaries.length === 0) {
		return null;
	}
	if (chunkSummaries.length > 1) {
		const state: SummaryAttemptState = { chunkCount: 0 };
		const final = await summarizeChunk(
			chunkSummaries,
			`${source} [chunked ${chunkCount} parts]`,
			0,
			state,
			options,
		);
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
			callConfiguredCompletion(prompt, temperature, {
				maxTokens: llmMaxTokens(),
				fetch: options.fetch,
				onPayload: options.onPayload,
			}),
		);
	}
	const [attempted, hostText] = await tryHostLlm(prompt, llmMaxTokens(), temperature, options.onPayload);
	if (attempted) {
		return hostText;
	}
	if (remoteBackendAllowed()) {
		return await summaryOrNull("remote LLM", () => callRemoteLlm(prompt, temperature, options));
	}
	return null;
}
