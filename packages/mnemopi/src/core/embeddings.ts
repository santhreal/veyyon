import { createHmac, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import type { ApiKey } from "@veyyon/ai";
import { withAuth } from "@veyyon/ai/auth-retry";
import { ProviderHttpError } from "@veyyon/ai/error/classes";
import { getOpenRouterHeaders } from "@veyyon/ai/utils/openrouter-headers";
import { hostMatchesUrl } from "@veyyon/catalog/hosts";
import { OPENROUTER_API_ENDPOINT } from "@veyyon/catalog/provider-endpoints";
import {
	$env,
	extractHttpStatusFromError,
	fetchWithRetry,
	getFastembedCacheDir,
	logger,
	trimTrailingSlashes,
	withScopedTimeoutSignal,
} from "@veyyon/utils";
import type { EmbeddingModel } from "fastembed";
import { LRUCache } from "lru-cache/raw";
import {
	type Env,
	embeddingModel,
	embeddingsDisabled as embeddingsDisabledFromEnv,
	isApiEmbeddingModel,
} from "../config";
import type { DenseVector as Vector } from "../types";
import { ensureFastembedModelSidecars, FASTEMBED_ID_BY_HF_REPO } from "./fastembed-model-cache";
import { loadFastembed } from "./fastembed-runtime";
import {
	type EmbeddingOutput,
	getMnemopiRuntimeOptions,
	mnemopiDebugEnabled,
	resolveEmbeddingProvider,
} from "./runtime-options";

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
const localModelPromises = new Map<string, Promise<LocalEmbeddingModel>>();
let localModelInitializer: LocalModelInitializer = defaultLocalModelInitializer;
let localModelInitializerGeneration = 0;
let apiCallCount = 0;
const queryCache = new LRUCache<string, Vector>({ max: QUERY_CACHE_MAX });
const pendingQueryEmbeddings = new Map<string, Promise<Vector | null>>();
const queryCacheHmacKey = randomBytes(32);
let queryCacheGeneration = 0;

const providerIds = new WeakMap<object, number>();
const sanitizerIds = new WeakMap<object, number>();
const credentialIds = new WeakMap<object, number>();
let nextProviderId = 1;
let nextSanitizerId = 1;
let nextCredentialId = 1;

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

function queryCacheKey(text: string): string | null {
	const active = activeEmbeddingOptions();
	const provider = active?.provider;
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
	let sanitizerScope = "local";
	let credentialScope = "local";
	if (provider === undefined && providerOverride === null && isApiModel(model)) {
		const sanitizer = active?.sanitizeProviderText;
		if (sanitizer !== undefined) {
			if (sanitizer.epoch === undefined) return null;
			let sanitizerId = sanitizerIds.get(sanitizer);
			if (sanitizerId === undefined) {
				sanitizerId = nextSanitizerId++;
				sanitizerIds.set(sanitizer, sanitizerId);
			}
			sanitizerScope = `${sanitizerId}:${String(sanitizer.epoch)}`;
		} else {
			sanitizerScope = "none";
		}
		const apiKey = embeddingApiKey();
		if (typeof apiKey === "function") {
			let credentialId = credentialIds.get(apiKey);
			if (credentialId === undefined) {
				credentialId = nextCredentialId++;
				credentialIds.set(apiKey, credentialId);
			}
			credentialScope = `resolver:${credentialId}`;
		} else {
			credentialScope = createHmac("sha256", queryCacheHmacKey).update(apiKey, "utf8").digest("hex");
		}
	}

	const textDigest = createHmac("sha256", queryCacheHmacKey).update(text, "utf8").digest("hex");
	return [
		queryCacheGeneration,
		providerId,
		model,
		embeddingBaseUrl(),
		effectiveMaxInputChars(),
		sanitizerScope,
		credentialScope,
		textDigest,
	].join("::");
}

function inTestRuntime(): boolean {
	return $env.NODE_ENV === "test" || $env.BUN_ENV === "test";
}

export function embeddingsDisabled(): boolean {
	const active = activeEmbeddingOptions();
	if (active?.disabled !== undefined) {
		return active.disabled;
	}
	return embeddingsDisabledFromEnv();
}

function effectiveMaxInputChars(): number {
	const override = activeEmbeddingOptions()?.maxInputChars;
	if (override !== undefined) return Math.max(0, Math.trunc(override));
	const envValue = Number.parseInt($env.MNEMOPI_EMBEDDING_MAX_INPUT_CHARS ?? "", 10);
	if (Number.isFinite(envValue) && envValue >= 0) return envValue;
	return 8192;
}

const EMBEDDING_ELISION_MARKER = "\n\n[...]\n\n";

function clipToWindow(text: string, max: number): string {
	if (text.length <= max) return text;
	if (max <= EMBEDDING_ELISION_MARKER.length + 16) return text.slice(text.length - max);
	const budget = max - EMBEDDING_ELISION_MARKER.length;
	const headLen = budget >>> 1;
	const tailLen = budget - headLen;
	return text.slice(0, headLen) + EMBEDDING_ELISION_MARKER + text.slice(text.length - tailLen);
}

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

export function embeddingApiKey(): ApiKey {
	const active = activeEmbeddingOptions();
	if (active?.apiKey !== undefined) {
		return active.apiKey;
	}
	return $env.MNEMOPI_EMBEDDING_API_KEY || $env.OPENROUTER_API_KEY || $env.OPENAI_API_KEY || "";
}

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

function defaultModel(): string {
	return embeddingModel();
}

export function currentEmbeddingModel(): string {
	return defaultModel();
}

export function isApiModel(modelName: string): boolean {
	const apiUrl = activeEmbeddingOptions()?.apiUrl;
	const env: Env = apiUrl === undefined ? process.env : { ...process.env, MNEMOPI_EMBEDDING_API_URL: apiUrl };
	return isApiEmbeddingModel(modelName, env);
}

export { embeddingDimFor } from "../config";

function toEmbeddingVector(row: unknown): Vector {
	if (
		!Array.isArray(row) ||
		row.length === 0 ||
		!row.every(value => typeof value === "number" && Number.isFinite(value))
	) {
		throw new Error("Mnemopi embedding provider returned an invalid vector row.");
	}
	const vector = new Float32Array(row);
	if (!vector.every(Number.isFinite)) {
		throw new Error("Mnemopi embedding provider returned a vector outside the Float32 range.");
	}
	return vector;
}
async function collectMatrix(batches: EmbeddingOutput, expectedRows: number): Promise<EmbeddingMatrix> {
	const rows: Vector[] = [];
	for await (const batch of batches) {
		if (!Array.isArray(batch)) {
			throw new Error("Mnemopi embedding provider returned a non-array batch.");
		}
		for (const row of batch) {
			if (rows.length >= expectedRows) {
				throw new Error("Mnemopi embedding provider returned more vectors than requested.");
			}
			rows.push(toEmbeddingVector(row));
		}
	}
	if (rows.length !== expectedRows) {
		throw new Error(`Mnemopi embedding provider returned ${rows.length} vectors for ${expectedRows} inputs.`);
	}
	return rows;
}

function fastembedModelName(modelName: string): StandardEmbeddingModel | null {
	const id = FASTEMBED_ID_BY_HF_REPO[modelName];
	return id === undefined ? null : (id as StandardEmbeddingModel);
}

async function getLocalModel(): Promise<LocalEmbeddingModel | null> {
	const configuredModel = defaultModel();
	if (isApiModel(configuredModel) || embeddingsDisabled() || inTestRuntime()) {
		return null;
	}

	const modelName = fastembedModelName(configuredModel);
	if (modelName === null) {
		reportEmbeddingFailure(
			`the configured local embedding model "${configuredModel}" is not one this build can load`,
			`local:${configuredModel}`,
		);
		return null;
	}
	const cacheDir = getFastembedCacheDir();
	const generation = localModelInitializerGeneration;
	const cacheKey = JSON.stringify([generation, modelName, cacheDir]);
	const cached = localModelPromises.get(cacheKey);
	if (cached !== undefined) {
		try {
			return await cached;
		} catch {
			return null;
		}
	}

	mkdirSync(cacheDir, { recursive: true });
	const initializer = localModelInitializer;
	const loading = Promise.resolve().then(() =>
		initializer({
			model: modelName,
			cacheDir,
			showDownloadProgress: false,
		}),
	);
	localModelPromises.set(cacheKey, loading);
	try {
		return await loading;
	} catch (error) {
		logger[mnemopiDebugEnabled() ? "warn" : "debug"]("mnemopi: local embedding model failed to load", {
			model: modelName,
			error: String(error),
		});
		if (localModelPromises.get(cacheKey) === loading) localModelPromises.delete(cacheKey);
		return null;
	}
}

async function embedApi(texts: readonly string[]): Promise<EmbeddingMatrix | null> {
	const baseUrl = embeddingBaseUrl();
	const isCustom = !hostMatchesUrl(baseUrl, "openrouter");
	const apiKey = embeddingApiKey();
	if (!isCustom && !embeddingKeyConfigured(apiKey)) {
		reportEmbeddingFailure("no embeddings API key is configured", baseUrl);
		return null;
	}

	try {
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
			if (!response.ok) {
				reportEmbeddingFailure(`the embeddings endpoint returned HTTP ${response.status}`, baseUrl);
				return null;
			}
			const payload: unknown = await response.json();
			if (payload === null || typeof payload !== "object" || !("data" in payload) || !Array.isArray(payload.data)) {
				reportEmbeddingFailure("the embeddings endpoint returned a response with no `data` array", baseUrl);
				return null;
			}
			if (payload.data.length !== texts.length) {
				throw new Error(
					`Mnemopi embeddings endpoint returned ${payload.data.length} vectors for ${texts.length} inputs.`,
				);
			}
			const vectors = payload.data.map(row => {
				if (row === null || typeof row !== "object" || !("embedding" in row)) {
					throw new Error("Mnemopi embeddings endpoint returned a row with no `embedding` vector.");
				}
				return toEmbeddingVector(row.embedding);
			});
			apiCallCount += 1;
			return vectors;
		});
	} catch (error) {
		const status = extractHttpStatusFromError(error);
		reportEmbeddingFailure(status !== undefined ? `the request failed with HTTP ${status}` : String(error), baseUrl);
		return null;
	}
}

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
		return (await provider.available()) === true;
	} catch {
		return false;
	}
}

export function setEmbeddingProviderForTests(provider: EmbeddingProvider | null | undefined): void {
	providerOverride = provider ?? null;
	queryCacheGeneration += 1;
	queryCache.clear();
	pendingQueryEmbeddings.clear();
}

export const setEmbeddingProvider = setEmbeddingProviderForTests;

export function setLocalModelInitializerForTests(initializer: LocalModelInitializer | null | undefined): void {
	localModelInitializer = initializer ?? defaultLocalModelInitializer;
	localModelInitializerGeneration += 1;
	queryCacheGeneration += 1;
	queryCache.clear();
	pendingQueryEmbeddings.clear();
}

export const setLocalModelInitializer = setLocalModelInitializerForTests;

export function resetEmbeddingProviderForTests(): void {
	providerOverride = null;
	localModelPromises.clear();
	localModelInitializer = defaultLocalModelInitializer;
	localModelInitializerGeneration += 1;
	queryCacheGeneration += 1;
	apiCallCount = 0;
	queryCache.clear();
	pendingQueryEmbeddings.clear();
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
	if (key === null) {
		const vectors = await embed([text]);
		return vectors?.[0] ?? null;
	}
	const cached = queryCache.get(key);
	if (cached !== undefined) {
		return cached.slice();
	}
	const pending = pendingQueryEmbeddings.get(key);
	if (pending !== undefined) {
		const vector = await pending;
		return vector?.slice() ?? null;
	}
	const loading = (async () => {
		const vectors = await embed([text]);
		const vector = vectors?.[0] ?? null;
		if (vector !== null && queryCacheKey(text) === key) {
			queryCache.set(key, vector.slice());
		}
		return vector;
	})();
	pendingQueryEmbeddings.set(key, loading);
	try {
		const vector = await loading;
		return vector?.slice() ?? null;
	} finally {
		if (pendingQueryEmbeddings.get(key) === loading) pendingQueryEmbeddings.delete(key);
	}
}

export async function embed(texts: readonly string[]): Promise<EmbeddingMatrix | null> {
	if (texts.length === 0 || embeddingsDisabled()) {
		return null;
	}
	const activeProvider = resolveEmbeddingProvider(activeEmbeddingOptions()?.provider);
	if (activeProvider !== undefined) {
		texts = capInputs(texts);
		try {
			return await collectMatrix(await activeProvider.embed(texts), texts.length);
		} catch (error) {
			reportEmbeddingFailure(String(error), `provider:${activeEmbeddingOptions()?.provider ?? "active"}`);
			return null;
		}
	}
	if (providerOverride !== null) {
		texts = capInputs(texts);
		try {
			return await collectMatrix(await providerOverride.embed(texts), texts.length);
		} catch (error) {
			reportEmbeddingFailure(String(error), "provider:override");
			return null;
		}
	}
	if (isApiModel(defaultModel())) {
		return embedApi(texts);
	}
	texts = capInputs(texts);
	const localCacheKey = texts.length === 1 ? queryCacheKey(texts[0] ?? "") : null;
	if (localCacheKey !== null) {
		const cached = queryCache.get(localCacheKey);
		if (cached !== undefined) {
			return [cached.slice()];
		}
	}
	const model = await getLocalModel();
	if (model === null) {
		return null;
	}
	try {
		const vectors = await collectMatrix(model.embed([...texts]), texts.length);
		if (vectors.length === 1) {
			const vector = vectors[0];
			if (vector !== undefined && localCacheKey !== null && queryCacheKey(texts[0] ?? "") === localCacheKey) {
				queryCache.set(localCacheKey, vector.slice());
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

export function getEmbeddingQueryCacheKeysForTests(): readonly string[] {
	return [...queryCache.keys()];
}
