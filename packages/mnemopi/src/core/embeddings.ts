import { mkdirSync } from "node:fs";
import type { ApiKey } from "@veyyon/ai";
// The owners, not the barrel. Embedding a query needs a retry wrapper and one
// header builder; through `@veyyon/ai` it was paying for the whole streaming
// stack behind them.
import { withAuth } from "@veyyon/ai/auth-retry";
import { ProviderHttpError } from "@veyyon/ai/error";
import { getOpenRouterHeaders } from "@veyyon/ai/utils/openrouter-headers";
import { hostMatchesUrl } from "@veyyon/catalog/hosts";
import { OPENROUTER_API_ENDPOINT } from "@veyyon/catalog/provider-endpoints";
import {
	$env,
	$flag,
	extractHttpStatusFromError,
	fetchWithRetry,
	getFastembedCacheDir,
	logger,
	trimTrailingSlashes,
	withScopedTimeoutSignal,
} from "@veyyon/utils";
import type { EmbeddingModel } from "fastembed";
import { LRUCache } from "lru-cache/raw";
import { embeddingModel } from "../config";
import type { DenseVector as Vector } from "../types";
import { ensureFastembedModelSidecars, FASTEMBED_ID_BY_HF_REPO } from "./fastembed-model-cache";
import { loadFastembed } from "./fastembed-runtime";
import {
	type EmbeddingOutput,
	getMnemopiRuntimeOptions,
	mnemopiDebugEnabled,
	resolveEmbeddingProvider,
} from "./runtime-options";

// `Vector` here has always meant the dense `Float32Array` this module produces, which is
// `DenseVector` in `../types`. Imported for local use and re-exported under the old name
// so this module's published surface is unchanged; the definition lives in one place.
export type { DenseVector as Vector } from "../types";
export type { EmbeddingOutput } from "./runtime-options";
export { cosineSimilarity } from "./vector-math";
export type EmbeddingMatrix = Vector[];

export interface EmbeddingProvider {
	embed(texts: readonly string[]): EmbeddingOutput | Promise<EmbeddingOutput>;
	available?(): boolean | Promise<boolean>;
}

export type StandardEmbeddingModel = Exclude<EmbeddingModel, EmbeddingModel.CUSTOM>;

export interface LocalEmbeddingModel {
	embed(texts: string[], batchSize?: number): EmbeddingOutput;
	queryEmbed?(query: string): Promise<number[]>;
}

export type LocalModelInitOptions = {
	model: StandardEmbeddingModel;
	cacheDir?: string;
	showDownloadProgress?: boolean;
};
export type LocalModelInitializer = (options: LocalModelInitOptions) => Promise<LocalEmbeddingModel>;

const QUERY_CACHE_MAX = 512;

let providerOverride: EmbeddingProvider | null = null;
let localModelPromise: Promise<LocalEmbeddingModel> | null = null;
let localModelInitializer: LocalModelInitializer = defaultLocalModelInitializer;
let apiCallCount = 0;
const queryCache = new LRUCache<string, Vector>({ max: QUERY_CACHE_MAX });

// Provider identity table for the cache key. Each unique `provider` object/function
// (configured via `withMnemopiRuntimeOptions`) gets a stable integer id so the cache
// scope reflects the runtime's actual embedding source. Two Mnemopi instances in the
// same process using different providers/models hash to disjoint keys and never
// collide on the same query text. `0` is the sentinel for "env-default fallback".
const providerIds = new WeakMap<object, number>();
let nextProviderId = 1;

async function defaultLocalModelInitializer(options: LocalModelInitOptions): Promise<LocalEmbeddingModel> {
	const { FlagEmbedding } = await loadFastembed();
	try {
		return await FlagEmbedding.init(options);
	} catch (error) {
		const message = error instanceof Error ? error.message : "";
		if (
			!/(?:Config file not found at .*config|Tokenizer file not found at .*tokenizer|Tokens map file not found at .*special_tokens_map)/u.test(
				message,
			)
		) {
			throw error;
		}
		if (!(await ensureFastembedModelSidecars(options.model, options.cacheDir))) throw error;
		return FlagEmbedding.init(options);
	}
}

function activeEmbeddingOptions() {
	return getMnemopiRuntimeOptions()?.embeddings;
}

function sanitizeEmbeddingProviderText(text: string): string {
	const sanitize = activeEmbeddingOptions()?.sanitizeProviderText;
	if (sanitize === undefined) return text;
	try {
		return sanitize(text);
	} catch {
		throw new Error("Mnemopi provider text sanitization failed.");
	}
}

/**
 * Compose the per-query cache key. Includes the active provider's identity, the
 * resolved model name, and the API base URL so two `Mnemopi` instances in the same
 * process that point at different providers/models never share a cached query
 * vector. Provider identity comes from `providerIds` (WeakMap-assigned integer);
 * `0` is the sentinel for "no provider configured, fall back to env defaults".
 */
function queryCacheKey(text: string): string {
	const active = activeEmbeddingOptions();
	const provider = active?.provider as object | undefined;
	let providerId = 0;
	if (provider !== undefined) {
		const existing = providerIds.get(provider);
		if (existing === undefined) {
			providerId = nextProviderId++;
			providerIds.set(provider, providerId);
		} else {
			providerId = existing;
		}
	}
	const model = defaultModel();
	const apiUrl = active?.apiUrl ?? "";
	return `${providerId}::${model}::${apiUrl}::${text}`;
}

function inTestRuntime(): boolean {
	return $env.NODE_ENV === "test" || $env.BUN_ENV === "test";
}

export function embeddingsDisabled(): boolean {
	const active = activeEmbeddingOptions();
	if (active?.disabled !== undefined) {
		return active.disabled;
	}
	return $flag("MNEMOPI_NO_EMBEDDINGS");
}

/**
 * Resolved per-input character cap for {@link embed}.
 *
 * Reads (in order): the active runtime scope's `embeddings.maxInputChars`, then
 * `MNEMOPI_EMBEDDING_MAX_INPUT_CHARS`, then the bundled `8192` default. `0`
 * disables the cap entirely.
 */
function effectiveMaxInputChars(): number {
	const override = activeEmbeddingOptions()?.maxInputChars;
	if (override !== undefined) return Math.max(0, Math.trunc(override));
	const envValue = Number.parseInt($env.MNEMOPI_EMBEDDING_MAX_INPUT_CHARS ?? "", 10);
	if (Number.isFinite(envValue) && envValue >= 0) return envValue;
	return 8192;
}

/** Elision marker injected between the retained head and tail of an oversized input. */
const EMBEDDING_ELISION_MARKER = "\n\n[...]\n\n";

/**
 * Right-clip a single oversized input to {@link max} chars while preserving
 * both ends. Retention transcripts are chronological (oldest → newest), so a
 * naive `slice(0, max)` would drop the most recent — and most semantically
 * loaded — turns once a session passed the cap, leaving every later retained
 * episode with essentially the same prefix vector. Keeping a head/tail split
 * lets the embedding capture the topic setup at the start AND the latest
 * exchanges at the end. Falls back to a tail-only clip when `max` is too
 * small to fit the elision marker plus a useful slice on either side.
 */
function clipToWindow(text: string, max: number): string {
	if (text.length <= max) return text;
	if (max <= EMBEDDING_ELISION_MARKER.length + 16) return text.slice(text.length - max);
	const budget = max - EMBEDDING_ELISION_MARKER.length;
	const headLen = budget >>> 1;
	const tailLen = budget - headLen;
	return text.slice(0, headLen) + EMBEDDING_ELISION_MARKER + text.slice(text.length - tailLen);
}

/**
 * Clip every input to {@link effectiveMaxInputChars} so a runaway retention
 * transcript can't blow past the embedding model's context window. Uses a
 * head/tail split via {@link clipToWindow} so the embedding still sees the
 * tail of the conversation (where the latest topic shifts live) and not just
 * the stale prefix. Returns the original array when no input needs trimming
 * (the common case); the new array is allocated only when at least one input
 * is oversized so we don't churn arrays for the typical short-query path
 * through `embedQuery`. Emits one debug-or-warn log per call summarizing how
 * many inputs were trimmed and by how much — silent truncation was the
 * original bug (#3126).
 */
function capInputs(texts: readonly string[]): readonly string[] {
	const max = effectiveMaxInputChars();
	if (max === 0) return texts;
	let trimmed: string[] | null = null;
	let trimmedCount = 0;
	let maxOriginalLen = 0;
	for (let i = 0; i < texts.length; i++) {
		const text = texts[i] ?? "";
		if (text.length <= max) continue;
		if (trimmed === null) trimmed = texts.slice() as string[];
		trimmed[i] = clipToWindow(text, max);
		trimmedCount++;
		if (text.length > maxOriginalLen) maxOriginalLen = text.length;
	}
	if (trimmed === null) return texts;
	logger[mnemopiDebugEnabled() ? "warn" : "debug"]("mnemopi: embedding input truncated", {
		inputCount: texts.length,
		trimmedCount,
		maxOriginalLen,
		maxInputChars: max,
	});
	return trimmed;
}

function embeddingApiKey(): ApiKey {
	const active = activeEmbeddingOptions();
	if (active?.apiKey !== undefined) {
		return active.apiKey;
	}
	return $env.MNEMOPI_EMBEDDING_API_KEY || $env.OPENROUTER_API_KEY || $env.OPENAI_API_KEY || "";
}

/** A resolver always counts as configured; a static key only when non-empty. */
function embeddingKeyConfigured(key: ApiKey = embeddingApiKey()): boolean {
	return typeof key === "function" || key !== "";
}

function embeddingBaseUrl(): string {
	const active = activeEmbeddingOptions();
	if (active?.apiUrl !== undefined) {
		return active.apiUrl;
	}
	return $env.MNEMOPI_EMBEDDING_API_URL || $env.OPENROUTER_BASE_URL || OPENROUTER_API_ENDPOINT;
}

/**
 * The model to embed with, from the one resolver in `../config`.
 *
 * This used to be its own scope-then-env lookup, byte-for-byte the order
 * `config.embeddingModel()` now uses, and that was the divergence: `config` read
 * the environment ALONE, so a runtime scope naming a different model moved the
 * embedder and left the vector packer on the environment's model. Delegating means
 * there is one place the precedence is written and the packer cannot fall behind.
 */
function defaultModel(): string {
	return embeddingModel();
}

/**
 * Resolve the embedding model name for the currently active runtime scope.
 *
 * Reads (in order): the active provider's `model` from `withMnemopiRuntimeOptions`,
 * the `MNEMOPI_EMBEDDING_MODEL` env var, then the bundled fastembed default. Stored
 * alongside each row in `memory_embeddings.model` so migrations can re-embed when
 * the active model changes.
 */
export function currentEmbeddingModel(): string {
	return defaultModel();
}

export function isApiModel(modelName: string): boolean {
	if (
		modelName.startsWith("openai/") ||
		modelName.includes("text-embedding") ||
		modelName.startsWith("text-embedding")
	) {
		return true;
	}
	const active = activeEmbeddingOptions();
	const baseUrl = active?.apiUrl ?? ($env.MNEMOPI_EMBEDDING_API_URL || $env.OPENROUTER_BASE_URL);
	if (baseUrl !== undefined && baseUrl !== "" && !hostMatchesUrl(baseUrl, "openrouter")) {
		return true;
	}
	return $flag("MNEMOPI_EMBEDDINGS_VIA_API");
}

/**
 * The dimension a named embedding model produces.
 *
 * Re-exported from `../config`, not implemented here. There were three copies of
 * this idea at once: a byte-identical seventeen-entry `MODEL_DIMS` table (deleted),
 * then two functions that shared the table and still disagreed, because this one
 * read `MNEMOPI_EMBEDDING_DIM` off `$env` while `config.embeddingDim` read it off
 * the `env` argument it was given, and the model NAME each resolved was different
 * again. One owner now, in `../config`, so the width the embedder expects and the
 * width `binary-vectors.ts` packs cannot come apart.
 */
export { embeddingDimFor } from "../config";

/** Drain an embedding stream (a custom provider or fastembed) into a `Float32Array` matrix. */
async function collectMatrix(batches: EmbeddingOutput): Promise<EmbeddingMatrix> {
	const rows: Vector[] = [];
	for await (const batch of batches) {
		for (const row of batch) {
			rows.push(new Float32Array(row));
		}
	}
	return rows;
}

/**
 * The fastembed identifier for a configured model name, or `null` when mnemopi cannot run
 * that model locally.
 *
 * The name pairs live in `./fastembed-model-cache`, which owns both directions. This file
 * held `KNOWN_MODEL_NAMES`, the exact inverse of that module's table, written out by hand
 * a second time: adding a model to one and not the other resolved here and then failed to
 * find the repository its tokenizer comes from. The values are still fastembed's
 * `EmbeddingModel` enum strings, and resolving one still never imports `fastembed`, whose
 * module eagerly loads the `onnxruntime-node` native addon and segfaults in some runtimes.
 */
function fastembedModelName(modelName: string): StandardEmbeddingModel | null {
	const id = FASTEMBED_ID_BY_HF_REPO[modelName];
	return id === undefined ? null : (id as StandardEmbeddingModel);
}

async function getLocalModel(): Promise<LocalEmbeddingModel | null> {
	if (isApiModel(defaultModel()) || embeddingsDisabled() || inTestRuntime()) {
		return null;
	}
	if (localModelPromise !== null) {
		return localModelPromise;
	}

	const modelName = fastembedModelName(defaultModel());
	if (modelName === null) {
		return null;
	}
	const cacheDir = getFastembedCacheDir();
	mkdirSync(cacheDir, { recursive: true });
	const loading = localModelInitializer({
		model: modelName,
		cacheDir,
		showDownloadProgress: false,
	});
	localModelPromise = loading;
	try {
		return await loading;
	} catch (error) {
		logger[mnemopiDebugEnabled() ? "warn" : "debug"]("mnemopi: local embedding model failed to load", {
			model: modelName,
			error: String(error),
		});
		if (localModelPromise === loading) localModelPromise = null;
		return null;
	}
}

async function embedApi(texts: readonly string[]): Promise<EmbeddingMatrix | null> {
	const baseUrl = embeddingBaseUrl();
	const isCustom = !hostMatchesUrl(baseUrl, "openrouter");
	const apiKey = embeddingApiKey();
	if (!isCustom && !embeddingKeyConfigured(apiKey)) {
		return null;
	}

	try {
		// withAuth re-resolves the key on 401 (force-refresh, then sibling
		// rotation) when `apiKey` is a resolver. The 429 backoff stays inside
		// the attempt via fetchWithRetry. An empty static key attempts without
		// an Authorization header (local/proxy setups).
		// The 30s deadline was already absolute across retry attempts; the
		// scoped fence keeps that, extends it over the body read, and clears
		// the timer on settle instead of lingering like AbortSignal.timeout.
		return await withScopedTimeoutSignal(30000, async signal => {
			const response = await withAuth(apiKey, async key => {
				const headers: Record<string, string> = {
					"Content-Type": "application/json",
					...getOpenRouterHeaders(),
				};
				if (key !== "") {
					headers.Authorization = `Bearer ${key}`;
				}
				const res = await fetchWithRetry(`${trimTrailingSlashes(baseUrl)}/embeddings`, {
					method: "POST",
					headers,
					signal,
					maxAttempts: 3,
					defaultDelayMs: attempt => 2 ** attempt * 1000,
					// This runs after every backoff and on every auth attempt. Re-read
					// the live transform and build a fresh body at the last send seam.
					prepareInit: () => {
						const sanitize = activeEmbeddingOptions()?.sanitizeProviderText;
						const providerTexts = sanitize === undefined ? texts : texts.map(sanitizeEmbeddingProviderText);
						return {
							body: JSON.stringify({
								model: defaultModel(),
								input: capInputs(providerTexts),
							}),
						};
					},
				});
				if (res.status === 401) {
					throw new ProviderHttpError("mnemopi embedding request unauthorized (401)", 401, {
						headers: res.headers,
					});
				}
				return res;
			});
			// Every `null` below drops memory search back to keyword matching for this
			// call. That is a real recall loss the user cannot see: results just get
			// worse, with no error and no marker. The `!response.ok` and missing-rows
			// branches reported NOTHING at all, and the throw reported at debug level,
			// so a mistyped base URL or an expired key degraded memory indefinitely in
			// silence (Law 10).
			if (!response.ok) {
				reportEmbeddingFailure(`the embeddings endpoint returned HTTP ${response.status}`, baseUrl);
				return null;
			}
			const { data: rows } = (await response.json()) as { data?: Array<{ embedding: number[] }> };
			if (rows === undefined) {
				reportEmbeddingFailure("the embeddings endpoint returned a response with no `data` array", baseUrl);
				return null;
			}
			apiCallCount += 1;
			return rows.map(row => new Float32Array(row.embedding));
		});
	} catch (error) {
		const status = extractHttpStatusFromError(error);
		reportEmbeddingFailure(status !== undefined ? `the request failed with HTTP ${status}` : String(error), baseUrl);
		return null;
	}
}

/**
 * The one place that reports a failed embedding request.
 *
 * Every caller answers the failure the same way, by falling back to keyword-only
 * search, so every caller owes the operator the same explanation: what broke,
 * which endpoint or provider, and what it costs them.
 *
 * `target` is the embeddings base URL for the HTTP path, or `provider:<name>` for
 * a registered provider, which has no URL of its own to name.
 */
function reportEmbeddingFailure(cause: string, target: string): void {
	logger.warn("Memory embedding failed, falling back to keyword-only search", {
		cause,
		target,
		impact: "Semantic recall is unavailable for this query, so memory results will be less relevant.",
		fix: "Check the embedding base URL and API key in your memory settings, or disable embeddings to stop retrying.",
	});
}

async function providerAvailable(provider: EmbeddingProvider): Promise<boolean> {
	if (provider.available === undefined) {
		return true;
	}
	try {
		return await provider.available();
	} catch {
		// A provider whose own availability check throws is not available, which is the answer this asks for.
		// Quiet here on purpose: the caller that then tries to embed reports the loss through
		// `reportEmbeddingFailure`, and warning twice for one unusable provider trains the reader to ignore it.
		return false;
	}
}

export function setEmbeddingProviderForTests(provider: EmbeddingProvider | null | undefined): void {
	providerOverride = provider ?? null;
	queryCache.clear();
}

export const setEmbeddingProvider = setEmbeddingProviderForTests;

export function setLocalModelInitializerForTests(initializer: LocalModelInitializer | null | undefined): void {
	localModelInitializer = initializer ?? defaultLocalModelInitializer;
	localModelPromise = null;
	queryCache.clear();
}

/**
 * Override the function used to construct the local fastembed model the next
 * time `embed()` is called. Lets a host (e.g. the agent CLI) keep
 * `onnxruntime-node` out of its own address space by routing every fastembed
 * load + inference through a dedicated subprocess. Same wipe semantics as the
 * `*ForTests` form: clears the cached model promise and the query cache so
 * subsequent embeds run through the new initializer immediately.
 */
export const setLocalModelInitializer = setLocalModelInitializerForTests;

export function resetEmbeddingProviderForTests(): void {
	providerOverride = null;
	localModelPromise = null;
	localModelInitializer = defaultLocalModelInitializer;
	apiCallCount = 0;
	queryCache.clear();
}

export const resetEmbeddingStateForTests = resetEmbeddingProviderForTests;

export async function available(): Promise<boolean> {
	if (embeddingsDisabled()) {
		return false;
	}
	const active = activeEmbeddingOptions();
	const activeProvider = resolveEmbeddingProvider(active?.provider);
	if (activeProvider !== undefined) {
		return providerAvailable(activeProvider);
	}
	if (providerOverride !== null) {
		return providerAvailable(providerOverride);
	}
	if (isApiModel(defaultModel())) {
		const baseUrl = active?.apiUrl ?? ($env.MNEMOPI_EMBEDDING_API_URL || $env.OPENROUTER_BASE_URL);
		if (baseUrl !== undefined && baseUrl !== "" && !hostMatchesUrl(baseUrl, "openrouter")) {
			return true;
		}
		return embeddingKeyConfigured();
	}
	if (inTestRuntime()) {
		return false;
	}
	return fastembedModelName(defaultModel()) !== null;
}

export function availableApi(): boolean {
	return embeddingKeyConfigured();
}

export async function embedQuery(text: string): Promise<Vector | null> {
	if (text === "" || embeddingsDisabled()) {
		return null;
	}
	const key = queryCacheKey(text);
	const cached = queryCache.get(key);
	if (cached !== undefined) {
		return cached;
	}
	const vectors = await embed([text]);
	const vector = vectors?.[0] ?? null;
	if (vector !== null) {
		queryCache.set(key, vector);
	}
	return vector;
}

export async function embed(texts: readonly string[]): Promise<EmbeddingMatrix | null> {
	if (texts.length === 0 || embeddingsDisabled()) {
		return null;
	}
	const activeProvider = resolveEmbeddingProvider(activeEmbeddingOptions()?.provider);
	if (activeProvider !== undefined) {
		texts = capInputs(texts);
		try {
			return await collectMatrix(await activeProvider.embed(texts));
		} catch (error) {
			// Null makes every caller fall back to keyword-only search, which is the same thing "embeddings are
			// switched off" produces, so a provider that is failing looked exactly like a provider nobody
			// configured. Reported through the one owner so the operator learns semantic recall is gone.
			reportEmbeddingFailure(String(error), `provider:${activeEmbeddingOptions()?.provider ?? "active"}`);
			return null;
		}
	}
	if (providerOverride !== null) {
		texts = capInputs(texts);
		try {
			return await collectMatrix(await providerOverride.embed(texts));
		} catch (error) {
			// Same loss through the override path, which tests and embedders set: silent null here made a
			// broken override indistinguishable from embeddings being disabled.
			reportEmbeddingFailure(String(error), "provider:override");
			return null;
		}
	}
	if (isApiModel(defaultModel())) {
		// Exact-secret replacement must see each raw query/transcript before the
		// head/tail cap can split it into fragments that no longer match. Keep
		// this pre-cap projection raw-sized so a sanitizer added by a later key
		// refresh can run against complete bytes inside embedApi as well.
		const sanitize = activeEmbeddingOptions()?.sanitizeProviderText;
		const providerTexts = sanitize === undefined ? texts : texts.map(sanitizeEmbeddingProviderText);
		return embedApi(providerTexts);
	}
	texts = capInputs(texts);
	if (texts.length === 1) {
		const key = queryCacheKey(texts[0] ?? "");
		const cached = queryCache.get(key);
		if (cached !== undefined) {
			return [cached];
		}
	}
	const model = await getLocalModel();
	if (model === null) {
		return null;
	}
	try {
		const vectors = await collectMatrix(model.embed([...texts]));
		if (vectors.length === 1) {
			const vector = vectors[0];
			if (vector !== undefined) {
				queryCache.set(queryCacheKey(texts[0] ?? ""), vector);
			}
		}
		return vectors;
	} catch (error) {
		logger[mnemopiDebugEnabled() ? "warn" : "debug"]("mnemopi: local embedding failed", {
			textCount: texts.length,
			error: String(error),
		});
		return null;
	}
}

export function getEmbeddingApiCallCountForTests(): number {
	return apiCallCount;
}

// `DEFAULT_MODEL` and `EMBEDDING_DIM` used to be exported from here, evaluated once
// at module load. Nothing imported either of them, and both were a trap: a scope
// activated after this file was first imported could not move them, so the two
// values that named the current model and its width were frozen to whatever the
// process happened to look like at import time. Ask `embeddingModel()` and
// `embeddingDim()` in `../config` instead, which answer at the moment of the call.
