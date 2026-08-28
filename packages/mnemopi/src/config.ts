import { homedir } from "node:os";
import { join } from "node:path";
import { hostMatchesUrl } from "@veyyon/catalog/hosts";
import { OPENROUTER_API_ENDPOINT } from "@veyyon/catalog/provider-endpoints";
import { trimTrailingSlashes } from "@veyyon/utils";
import { getMnemopiRuntimeOptions } from "./core/runtime-options";
import {
	type Env,
	envBool,
	envDisabled,
	envFloat,
	envInt,
	envOneOf,
	envOptionalString,
	envString,
	envTruthy,
} from "./util/env";

export type { Env };
export { envBool, envDisabled, envFloat, envInt, envOneOf, envOptionalString, envString, envTruthy };

/** Derive base home directory for mnemopi. */
export function mnemopiHome(env: Env = process.env): string {
	return envOptionalString("MNEMOPI_HOME", env) ?? envOptionalString("HOME", env) ?? homedir();
}

/** The `.hermes` root: data, models, blobs, plugins and the embedding cache live under it. */
export function hermesRoot(env: Env = process.env): string {
	return join(mnemopiHome(env), ".hermes");
}

export const DEFAULT_DB_FILENAME = "mnemopi.db";

export function fastembedCacheDir(env: Env = process.env): string {
	return join(hermesRoot(env), "cache", "fastembed");
}

export function modelCacheDir(env: Env = process.env): string {
	return join(hermesRoot(env), "mnemopi", "models");
}

export const DEFAULT_EMBEDDING_MODEL = "BAAI/bge-small-en-v1.5";
/** Default embedding API URL. */
export const DEFAULT_EMBEDDING_API_URL = OPENROUTER_API_ENDPOINT;
export const DEFAULT_LLM_MODEL_REPO = "TheBloke/TinyLlama-1.1B-Chat-v1.0-GGUF";
export const DEFAULT_LLM_MODEL_FILE = "tinyllama-1.1b-chat-v1.0.Q4_K_M.gguf";
export const HOST_LLM_TIMEOUT_SECONDS = 15.0;

export type VecType = "float32" | "int8" | "bit";

/** Fallback embedding dimension. */
export const FALLBACK_EMBEDDING_DIM = 384;
/** Dimension by embedding model name. */
export const EMBEDDING_DIMS: Readonly<Record<string, number>> = {
	"BAAI/bge-small-en-v1.5": 384,
	"BAAI/bge-base-en-v1.5": 768,
	"BAAI/bge-large-en-v1.5": 1024,
	"BAAI/bge-small-zh-v1.5": 512,
	"BAAI/bge-base-zh-v1.5": 768,
	"BAAI/bge-large-zh-v1.5": 1024,
	"intfloat/multilingual-e5-small": 384,
	"intfloat/multilingual-e5-base": 768,
	"intfloat/multilingual-e5-large": 1024,
	"BAAI/bge-m3": 1024,
	"BAAI/bge-multilingual-gemma2": 3584,
	"openai/text-embedding-3-small": 1536,
	"openai/text-embedding-3-large": 3072,
	"text-embedding-3-small": 1536,
	"text-embedding-3-large": 3072,
	"jina-embeddings-v5-omni-nano": 768,
	"jina-embeddings-v5-omni-small": 1024,
};

export const VERACITY_WEIGHT_DEFAULTS = {
	stated: 1.0,
	inferred: 0.7,
	tool: 0.5,
	imported: 0.6,
	unknown: 0.8,
} as const;

export function dataDir(env: Env = process.env): string {
	return envOptionalString("MNEMOPI_DATA_DIR", env) ?? join(hermesRoot(env), "mnemopi", "data");
}

export function dbPath(env: Env = process.env): string {
	return join(dataDir(env), DEFAULT_DB_FILENAME);
}

export function beamOptimizationsEnabled(env: Env = process.env): boolean {
	return envTruthy("MNEMOPI_BEAM_OPTIMIZATIONS", env);
}

/** The embedding model in force right now. */
export function embeddingModel(env: Env = process.env): string {
	const scoped = getMnemopiRuntimeOptions()?.embeddings?.model;
	if (scoped !== undefined) return scoped;
	return envString("MNEMOPI_EMBEDDING_MODEL", DEFAULT_EMBEDDING_MODEL, env);
}

/** Dimension for named embedding model. */
export function embeddingDimFor(modelName: string, env: Env = process.env): number {
	const explicit = envInt("MNEMOPI_EMBEDDING_DIM", NaN, env);
	if (Number.isFinite(explicit)) return explicit;
	return EMBEDDING_DIMS[modelName] ?? FALLBACK_EMBEDDING_DIM;
}

/** The width the model in force produces. Scope-aware, because {@link embeddingModel} is. */
export function embeddingDim(env: Env = process.env): number {
	return embeddingDimFor(embeddingModel(env), env);
}

export function embeddingApiKey(env: Env = process.env): string {
	return envString(
		"MNEMOPI_EMBEDDING_API_KEY",
		envString("OPENROUTER_API_KEY", envString("OPENAI_API_KEY", "", env), env),
		env,
	);
}

export function embeddingApiUrl(env: Env = process.env): string {
	return envString("MNEMOPI_EMBEDDING_API_URL", envString("OPENROUTER_BASE_URL", DEFAULT_EMBEDDING_API_URL, env), env);
}

export function embeddingsViaApi(env: Env = process.env): boolean {
	return envTruthy("MNEMOPI_EMBEDDINGS_VIA_API", env);
}

/** Check if embeddings are explicitly disabled. */
export function embeddingsDisabled(env: Env = process.env): boolean {
	return envTruthy("MNEMOPI_NO_EMBEDDINGS", env);
}

/** Per-input character cap applied before embedding. */
export function embeddingMaxInputChars(env: Env = process.env): number {
	return Math.max(0, envInt("MNEMOPI_EMBEDDING_MAX_INPUT_CHARS", 8192, env));
}

export function isApiEmbeddingModel(model = embeddingModel(), env: Env = process.env): boolean {
	if (model.startsWith("openai/") || model.includes("text-embedding") || model.startsWith("text-embedding"))
		return true;
	const baseUrl = envString("MNEMOPI_EMBEDDING_API_URL", envString("OPENROUTER_BASE_URL", "", env), env);
	if (baseUrl && !hostMatchesUrl(baseUrl, "openrouter")) return true;
	return embeddingsViaApi(env);
}

export function apiEmbeddingsAvailable(env: Env = process.env): boolean {
	if (embeddingsDisabled(env)) return false;
	if (!isApiEmbeddingModel(embeddingModel(env), env)) return false;
	const baseUrl = envString("MNEMOPI_EMBEDDING_API_URL", envString("OPENROUTER_BASE_URL", "", env), env);
	return Boolean(baseUrl && !hostMatchesUrl(baseUrl, "openrouter")) || Boolean(embeddingApiKey(env));
}

export function workingMemoryMaxItems(env: Env = process.env): number {
	return envInt("MNEMOPI_WM_MAX_ITEMS", 10000, env);
}

export function workingMemoryTtlHours(env: Env = process.env): number {
	return envInt("MNEMOPI_WM_TTL_HOURS", 24, env);
}

export function episodicRecallLimit(env: Env = process.env): number {
	return envInt("MNEMOPI_EP_LIMIT", 50000, env);
}

export function maxEpisodeChars(env: Env = process.env): number {
	return Math.max(1, envInt("MNEMOPI_MAX_EPISODE_CHARS", 100000, env));
}

export function sleepBatchSize(env: Env = process.env): number {
	return envInt("MNEMOPI_SLEEP_BATCH", 5000, env);
}

export function scratchpadMaxItems(env: Env = process.env): number {
	return envInt("MNEMOPI_SP_MAX", 1000, env);
}

/** SHMR configuration accessors. */
export function shmrBatchSize(env: Env = process.env): number {
	return envInt("MNEMOPI_SHMR_BATCH_SIZE", 50, env);
}

export function shmrMaxIterations(env: Env = process.env): number {
	return envInt("MNEMOPI_SHMR_MAX_ITERATIONS", 3, env);
}

export function shmrSimilarityThreshold(env: Env = process.env): number {
	return envFloat("MNEMOPI_SHMR_SIMILARITY_THRESHOLD", 0.7, env);
}

export function shmrHarmonyThreshold(env: Env = process.env): number {
	return envFloat("MNEMOPI_SHMR_HARMONY_THRESHOLD", 0.6, env);
}

export function shmrMinClusterSize(env: Env = process.env): number {
	return envInt("MNEMOPI_SHMR_MIN_CLUSTER_SIZE", 2, env);
}

export function recencyHalflifeHours(env: Env = process.env): number {
	return envFloat("MNEMOPI_RECENCY_HALFLIFE", 168, env);
}

export function tier2Days(env: Env = process.env): number {
	return envInt("MNEMOPI_TIER2_DAYS", 30, env);
}

export function tier3Days(env: Env = process.env): number {
	return envInt("MNEMOPI_TIER3_DAYS", 180, env);
}

export function tier1Weight(env: Env = process.env): number {
	return envFloat("MNEMOPI_TIER1_WEIGHT", 1.0, env);
}

export function tier2Weight(env: Env = process.env): number {
	return envFloat("MNEMOPI_TIER2_WEIGHT", 0.5, env);
}

export function tier3Weight(env: Env = process.env): number {
	return envFloat("MNEMOPI_TIER3_WEIGHT", 0.25, env);
}

export function degradeBatchSize(env: Env = process.env): number {
	return envInt("MNEMOPI_DEGRADE_BATCH", 100, env);
}

export function smartCompressEnabled(env: Env = process.env): boolean {
	return !envDisabled("MNEMOPI_SMART_COMPRESS", env);
}

export function tier3MaxChars(env: Env = process.env): number {
	return envInt("MNEMOPI_TIER3_MAX_CHARS", 300, env);
}

export function statedWeight(env: Env = process.env): number {
	return envFloat("MNEMOPI_STATED_WEIGHT", VERACITY_WEIGHT_DEFAULTS.stated, env);
}

export function inferredWeight(env: Env = process.env): number {
	return envFloat("MNEMOPI_INFERRED_WEIGHT", VERACITY_WEIGHT_DEFAULTS.inferred, env);
}

export function toolWeight(env: Env = process.env): number {
	return envFloat("MNEMOPI_TOOL_WEIGHT", VERACITY_WEIGHT_DEFAULTS.tool, env);
}

export function importedWeight(env: Env = process.env): number {
	return envFloat("MNEMOPI_IMPORTED_WEIGHT", VERACITY_WEIGHT_DEFAULTS.imported, env);
}

export function unknownWeight(env: Env = process.env): number {
	return envFloat("MNEMOPI_UNKNOWN_WEIGHT", VERACITY_WEIGHT_DEFAULTS.unknown, env);
}

export function veracityWeightOverrides(env: Env = process.env): string[] {
	const names = [
		"MNEMOPI_STATED_WEIGHT",
		"MNEMOPI_INFERRED_WEIGHT",
		"MNEMOPI_TOOL_WEIGHT",
		"MNEMOPI_IMPORTED_WEIGHT",
		"MNEMOPI_UNKNOWN_WEIGHT",
	];
	const overrides: string[] = [];
	for (const name of names) {
		if (env[name]?.trim()) overrides.push(name);
	}
	return overrides;
}

export function vecType(env: Env = process.env): VecType {
	return envOneOf("MNEMOPI_VEC_TYPE", ["float32", "int8", "bit"] as const, "int8", env);
}

/** The three recall scoring weights, in the order recall applies them. */
export type HybridWeights = readonly [vecWeight: number, ftsWeight: number, importanceWeight: number];

/** Default recall weights (vector, fts, importance). */
export const DEFAULT_RECALL_WEIGHTS: HybridWeights = [0.5, 0.3, 0.2];

const NORMALIZED_WEIGHT_EPSILON = 1e-6;
export function vectorWeight(env: Env = process.env): number {
	return envFloat("MNEMOPI_VEC_WEIGHT", DEFAULT_RECALL_WEIGHTS[0], env);
}

export function ftsWeight(env: Env = process.env): number {
	return envFloat("MNEMOPI_FTS_WEIGHT", DEFAULT_RECALL_WEIGHTS[1], env);
}

export function importanceWeight(env: Env = process.env): number {
	return envFloat("MNEMOPI_IMPORTANCE_WEIGHT", DEFAULT_RECALL_WEIGHTS[2], env);
}

/** Sanitize weight value to finite non-negative number. */
function usableWeight(value: number): number {
	return Number.isFinite(value) ? Math.max(0, value) : 0;
}

/** Normalized recall weights summing to 1. */
export function normalizedRecallWeights(
	vec: number | null | undefined = vectorWeight(),
	fts: number | null | undefined = ftsWeight(),
	importance: number | null | undefined = importanceWeight(),
): HybridWeights {
	const vw = usableWeight(vec ?? vectorWeight());
	const fw = usableWeight(fts ?? ftsWeight());
	const iw = usableWeight(importance ?? importanceWeight());
	const total = vw + fw + iw;
	if (total === 0) return DEFAULT_RECALL_WEIGHTS;
	if (Math.abs(total - 1) < NORMALIZED_WEIGHT_EPSILON) return [vw, fw, iw];
	return [vw / total, fw / total, iw / total];
}

export function autoMigrateEnabled(env: Env = process.env): boolean {
	return envString("MNEMOPI_AUTO_MIGRATE", "1", env) !== "0";
}

export interface RecallFeatureFlags {
	polyphonicRecall?: boolean;
	enhancedRecall?: boolean;
	proactiveLinking?: boolean;
}

let polyphonicRecallDefault = false;
let enhancedRecallDefault = false;
let proactiveLinkingDefault = false;

/** Configure default recall feature flags. */
export function configureRecallFeatures(flags: RecallFeatureFlags): void {
	if (flags.polyphonicRecall !== undefined) polyphonicRecallDefault = flags.polyphonicRecall;
	if (flags.enhancedRecall !== undefined) enhancedRecallDefault = flags.enhancedRecall;
	if (flags.proactiveLinking !== undefined) proactiveLinkingDefault = flags.proactiveLinking;
}

export function polyphonicRecallEnabled(env: Env = process.env): boolean {
	const value = envOptionalString("MNEMOPI_POLYPHONIC_RECALL", env);
	return value === undefined ? polyphonicRecallDefault : value === "1";
}

export function temporalHalflifeHours(env: Env = process.env): number {
	return envFloat("MNEMOPI_TEMPORAL_HALFLIFE_HOURS", 24, env);
}

export function enhancedRecallEnabled(env: Env = process.env): boolean {
	const value = envOptionalString("MNEMOPI_ENHANCED_RECALL", env);
	return value === undefined ? enhancedRecallDefault : value === "1";
}

export function proactiveLinkingEnabled(env: Env = process.env): boolean {
	const value = envOptionalString("MNEMOPI_PROACTIVE_LINKING", env);
	return value === undefined ? proactiveLinkingDefault : value === "1";
}

export function llmEnabled(env: Env = process.env): boolean {
	return envBool("MNEMOPI_LLM_ENABLED", true, env);
}

export function llmMaxTokens(env: Env = process.env): number {
	return envInt("MNEMOPI_LLM_MAX_TOKENS", 2048, env);
}

/** `MNEMOPI_FORCE_LOCAL`: keep extraction on the local tier even when a remote endpoint is configured. */
export function forceLocalLlm(env: Env = process.env): boolean {
	return envBool("MNEMOPI_FORCE_LOCAL", false, env);
}

/** `MNEMOPI_EXTRACTION_PROMPT`: replaces the bundled extraction template when set. */
export function extractionPromptOverride(env: Env = process.env): string {
	return envString("MNEMOPI_EXTRACTION_PROMPT", "", env);
}

/** The model the cloud extraction tier asks for when nothing names another one. */
export const BUNDLED_EXTRACTION_MODEL = "google/gemini-2.5-flash";

/** `MNEMOPI_EXTRACTION_MODEL`: the model the cloud extraction tier asks for first. */
export function extractionModel(env: Env = process.env): string {
	return envString("MNEMOPI_EXTRACTION_MODEL", BUNDLED_EXTRACTION_MODEL, env);
}

export function llmThreads(env: Env = process.env): number {
	return envInt("MNEMOPI_LLM_N_THREADS", 4, env);
}

export function llmContext(env: Env = process.env): number {
	return envInt("MNEMOPI_LLM_N_CTX", 2048, env);
}

export function llmRepo(env: Env = process.env): string {
	return envString("MNEMOPI_LLM_REPO", DEFAULT_LLM_MODEL_REPO, env);
}

export function llmFile(env: Env = process.env): string {
	return envString("MNEMOPI_LLM_FILE", DEFAULT_LLM_MODEL_FILE, env);
}

export function llmModelFiles(env: Env = process.env): readonly [repo: string, file: string] {
	const repo = envOptionalString("MNEMOPI_LLM_REPO", env);
	const file = envOptionalString("MNEMOPI_LLM_FILE", env);
	return repo && file ? [repo, file] : [DEFAULT_LLM_MODEL_REPO, DEFAULT_LLM_MODEL_FILE];
}

export function llmBaseUrl(env: Env = process.env): string {
	return trimTrailingSlashes(envString("MNEMOPI_LLM_BASE_URL", "", env));
}

export function llmApiKey(env: Env = process.env): string {
	return envString("MNEMOPI_LLM_API_KEY", "", env);
}

export function llmModel(env: Env = process.env): string {
	return envString("MNEMOPI_LLM_MODEL", "", env);
}

export function hostLlmEnabled(env: Env = process.env): boolean {
	return envBool("MNEMOPI_HOST_LLM_ENABLED", false, env);
}

export function hostLlmProvider(env: Env = process.env): string | undefined {
	return envOptionalString("MNEMOPI_HOST_LLM_PROVIDER", env);
}

export function hostLlmModel(env: Env = process.env): string | undefined {
	return envOptionalString("MNEMOPI_HOST_LLM_MODEL", env);
}

export function hostLlmContext(env: Env = process.env): number {
	return envInt("MNEMOPI_HOST_LLM_N_CTX", 32000, env);
}

export function sleepPrompt(env: Env = process.env): string {
	return envString("MNEMOPI_SLEEP_PROMPT", "", env).trim();
}
