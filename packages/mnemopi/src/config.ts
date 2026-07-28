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

export const DEFAULT_DATA_DIR = join(homedir(), ".hermes", "mnemopi", "data");
export const DEFAULT_DB_FILENAME = "mnemopi.db";
export const FASTEMBED_CACHE_DIR = join(homedir(), ".hermes", "cache", "fastembed");
export const MODEL_CACHE_DIR = join(homedir(), ".hermes", "mnemopi", "models");

export const DEFAULT_EMBEDDING_MODEL = "BAAI/bge-small-en-v1.5";
/**
 * The embedding endpoint used when nothing is configured.
 *
 * Read from the owner in `@veyyon/catalog/provider-endpoints` rather than declared: three other modules spelled
 * the same URL, two of them inline inside an env fallback chain whose variable is itself called
 * `OPENROUTER_BASE_URL`.
 */
export const DEFAULT_EMBEDDING_API_URL = OPENROUTER_API_ENDPOINT;
export const DEFAULT_LLM_MODEL_REPO = "TheBloke/TinyLlama-1.1B-Chat-v1.0-GGUF";
export const DEFAULT_LLM_MODEL_FILE = "tinyllama-1.1b-chat-v1.0.Q4_K_M.gguf";
export const HOST_LLM_TIMEOUT_SECONDS = 15.0;

export type VecType = "float32" | "int8" | "bit";

/**
 * The width assumed for a model this table does not list.
 *
 * Named rather than written as a bare `384` at each site, because both resolvers
 * (`embeddingDim` here and `embeddingDimFor` in `core/embeddings.ts`) have to fall
 * back to the SAME number: they size the same vectors, and two different guesses
 * would corrupt the store rather than merely disagree. It is the dimension of the
 * default model, so an unlisted model behaves like the default instead of failing.
 */
export const FALLBACK_EMBEDDING_DIM = 384;

/**
 * Dimension by embedding model name. THE one table; `core/embeddings.ts` imports it.
 */
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
	return envOptionalString("MNEMOPI_DATA_DIR", env) ?? DEFAULT_DATA_DIR;
}

export function dbPath(env: Env = process.env): string {
	return join(dataDir(env), DEFAULT_DB_FILENAME);
}

export function beamOptimizationsEnabled(env: Env = process.env): boolean {
	return envTruthy("MNEMOPI_BEAM_OPTIMIZATIONS", env);
}

/**
 * The embedding model in force right now.
 *
 * THE ONE RESOLVER. It reads the active `withMnemopiRuntimeOptions` scope first and
 * the environment second, which is the order `core/embeddings.ts` uses when it picks
 * the model to embed WITH. This function used to read the environment alone, so a
 * caller who set `embeddings.model` on a runtime scope had the embedder produce one
 * width while `binary-vectors.ts`, which sizes packed vectors from `embeddingDim()`
 * below, packed a different one. Nothing checked the two against each other, so a
 * mismatch did not error: it wrote vectors that decode to noise and surfaced as
 * similarity scores quietly getting worse.
 *
 * Reading the scope from `config.ts` costs one module (`node:async_hooks`) and no
 * cycle: `core/runtime-options.ts` imports nothing from here.
 */
export function embeddingModel(env: Env = process.env): string {
	const scoped = getMnemopiRuntimeOptions()?.embeddings?.model;
	if (scoped !== undefined) return scoped;
	return envString("MNEMOPI_EMBEDDING_MODEL", DEFAULT_EMBEDDING_MODEL, env);
}

/**
 * The width `modelName` produces, with `MNEMOPI_EMBEDDING_DIM` overriding the table.
 *
 * Separate from {@link embeddingDim} because two callers ask two different questions:
 * this one asks about a NAMED model, the other about the model currently in force.
 * They must not answer differently for the same name, which is why the override and
 * the fallback live here once rather than at each site.
 */
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

export function embeddingsDisabled(env: Env = process.env): boolean {
	return envString("MNEMOPI_NO_EMBEDDINGS", "", env) !== "";
}

/**
 * Per-input character cap applied inside `embed()` before any provider sees the text.
 *
 * Long retention transcripts (full multi-turn session windows) routinely outgrow
 * embedding model context windows: BGE/E5 defaults are 512 tokens, bge-m3 is
 * 8192, and OpenAI's text-embedding-3-* is 8192. llama.cpp's `/embeddings`
 * server rejects oversized requests with `request (N tokens) exceeds the
 * available context size`; OpenAI silently right-truncates. Capping at the
 * source gives both backends deterministic behavior and prevents the silent
 * recall degradation we saw in issue #3126.
 *
 * Default `8192` chars is intentionally conservative for 8192-token embedding
 * contexts (bge-m3, OpenAI text-embedding-3) and CJK-heavy transcripts. Raise
 * it for larger local contexts (for example Qwen3-Embedding with 32k ctx).
 * `0` disables the cap.
 */
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

/**
 * Self-Harmonizing Memory Reconciliation, the pass that clusters near-duplicate memories
 * and reconciles the beliefs they imply. Its five knobs lived in `core/shmr.ts` and were
 * the only `MNEMOPI_*` family with no accessor here, so `mnemopi diagnose` could not report
 * them and an operator had no one place to look them up.
 *
 * Each falls back to its default rather than to `NaN`: a `NaN` threshold makes every
 * `>= threshold` comparison false, so clustering would quietly find nothing, and a `NaN`
 * size corrupts the SQLite `LIMIT` bind.
 */
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

/**
 * The recall weights when nothing overrides them: vector, full-text, importance.
 *
 * One triple, because a default written in several places is several defaults. The three
 * accessors below each read their own slot and `normalizedRecallWeights` falls back to the
 * whole triple, so retuning recall means editing this line and nothing else.
 */
export const DEFAULT_RECALL_WEIGHTS: HybridWeights = [0.5, 0.3, 0.2];

/**
 * How close a weight sum must be to 1 to count as already normalized. Dividing an
 * already-normalized triple by its own total is a float round trip that can move a weight
 * by an ulp, so the exact numbers the caller asked for are returned instead.
 */
const NORMALIZED_WEIGHT_EPSILON = 1e-10;

export function vectorWeight(env: Env = process.env): number {
	return envFloat("MNEMOPI_VEC_WEIGHT", DEFAULT_RECALL_WEIGHTS[0], env);
}

export function ftsWeight(env: Env = process.env): number {
	return envFloat("MNEMOPI_FTS_WEIGHT", DEFAULT_RECALL_WEIGHTS[1], env);
}

export function importanceWeight(env: Env = process.env): number {
	return envFloat("MNEMOPI_IMPORTANCE_WEIGHT", DEFAULT_RECALL_WEIGHTS[2], env);
}

/**
 * A weight that is negative, `NaN` or infinite contributes nothing.
 *
 * Recall's weights arrive from `RecallOptions`, which is public and typed only as `number`,
 * so a caller that computed one with `Number(input)` can hand over `NaN`. Left alone it
 * poisons the sum, and every weight comes back `NaN`: no memory then out-scores any other
 * and recall silently returns whatever order the candidates happened to be in.
 */
function usableWeight(value: number): number {
	return Number.isFinite(value) ? Math.max(0, value) : 0;
}

/**
 * The recall weights, non-negative and summing to 1.
 *
 * `null` and `undefined` both mean "use the configured weight", so a caller holding an
 * optional override can pass it straight through.
 */
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

/**
 * Sets process-wide defaults for the env-gated recall features. Host configuration
 * (e.g. the coding-agent `mnemopi.polyphonicRecall` / `mnemopi.enhancedRecall` /
 * `mnemopi.proactiveLinking` settings) lands here; the `MNEMOPI_POLYPHONIC_RECALL` /
 * `MNEMOPI_ENHANCED_RECALL` / `MNEMOPI_PROACTIVE_LINKING` environment variables still
 * win whenever they are set.
 */
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
