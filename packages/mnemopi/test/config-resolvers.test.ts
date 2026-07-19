import { describe, expect, it } from "bun:test";
import {
	apiEmbeddingsAvailable,
	autoMigrateEnabled,
	beamOptimizationsEnabled,
	DEFAULT_DB_FILENAME,
	DEFAULT_EMBEDDING_API_URL,
	DEFAULT_EMBEDDING_MODEL,
	DEFAULT_LLM_MODEL_FILE,
	DEFAULT_LLM_MODEL_REPO,
	dataDir,
	dbPath,
	degradeBatchSize,
	embeddingApiKey,
	embeddingApiUrl,
	embeddingDim,
	embeddingMaxInputChars,
	embeddingModel,
	embeddingsDisabled,
	embeddingsViaApi,
	episodicRecallLimit,
	ftsWeight,
	hostLlmContext,
	hostLlmEnabled,
	hostLlmModel,
	hostLlmProvider,
	importanceWeight,
	importedWeight,
	inferredWeight,
	isApiEmbeddingModel,
	llmApiKey,
	llmBaseUrl,
	llmContext,
	llmEnabled,
	llmFile,
	llmMaxTokens,
	llmModel,
	llmModelFiles,
	llmRepo,
	llmThreads,
	maxEpisodeChars,
	recencyHalflifeHours,
	scratchpadMaxItems,
	sleepBatchSize,
	sleepPrompt,
	smartCompressEnabled,
	statedWeight,
	temporalHalflifeHours,
	tier1Weight,
	tier2Days,
	tier2Weight,
	tier3Days,
	tier3MaxChars,
	tier3Weight,
	toolWeight,
	unknownWeight,
	vecType,
	vectorWeight,
	veracityWeightOverrides,
	workingMemoryMaxItems,
	workingMemoryTtlHours,
} from "@veyyon/mnemopi/config";

// Every resolver takes an explicit env map, so these assert the default AND the
// override branch without touching process.env. The point is exact values: the
// default, the parsed override, and every fallback-chain rung.

describe("data-dir resolvers", () => {
	it("defaults to ~/.hermes and overrides via MNEMOPI_DATA_DIR", () => {
		const def = dataDir({});
		expect(def.endsWith("/.hermes/mnemopi/data")).toBe(true);
		expect(dataDir({ MNEMOPI_DATA_DIR: "/custom/dir" })).toBe("/custom/dir");
		expect(dbPath({ MNEMOPI_DATA_DIR: "/custom/dir" })).toBe(`/custom/dir/${DEFAULT_DB_FILENAME}`);
		expect(dbPath({})).toBe(`${def}/${DEFAULT_DB_FILENAME}`);
	});
});

describe("embedding model + dim resolvers", () => {
	it("returns the default model and overrides it", () => {
		expect(embeddingModel({})).toBe(DEFAULT_EMBEDDING_MODEL);
		expect(embeddingModel({ MNEMOPI_EMBEDDING_MODEL: "BAAI/bge-large-en-v1.5" })).toBe("BAAI/bge-large-en-v1.5");
	});

	it("resolves the dim from an explicit override, the model table, then 384", () => {
		expect(embeddingDim({ MNEMOPI_EMBEDDING_DIM: "512" })).toBe(512);
		// Known model with no explicit dim -> table lookup.
		expect(embeddingDim({ MNEMOPI_EMBEDDING_MODEL: "openai/text-embedding-3-large" })).toBe(3072);
		expect(embeddingDim({ MNEMOPI_EMBEDDING_MODEL: "BAAI/bge-base-en-v1.5" })).toBe(768);
		// Unknown model, no override -> 384 fallback.
		expect(embeddingDim({ MNEMOPI_EMBEDDING_MODEL: "some/unknown-model" })).toBe(384);
		// Default model.
		expect(embeddingDim({})).toBe(384);
	});
});

describe("embedding api key + url fallback chains", () => {
	it("prefers MNEMOPI_EMBEDDING_API_KEY, then OPENROUTER, then OPENAI, then empty", () => {
		expect(embeddingApiKey({ MNEMOPI_EMBEDDING_API_KEY: "mk", OPENROUTER_API_KEY: "or", OPENAI_API_KEY: "oa" })).toBe(
			"mk",
		);
		expect(embeddingApiKey({ OPENROUTER_API_KEY: "or", OPENAI_API_KEY: "oa" })).toBe("or");
		expect(embeddingApiKey({ OPENAI_API_KEY: "oa" })).toBe("oa");
		expect(embeddingApiKey({})).toBe("");
	});

	it("prefers MNEMOPI_EMBEDDING_API_URL, then OPENROUTER_BASE_URL, then the default", () => {
		expect(embeddingApiUrl({ MNEMOPI_EMBEDDING_API_URL: "https://a/v1", OPENROUTER_BASE_URL: "https://b/v1" })).toBe(
			"https://a/v1",
		);
		expect(embeddingApiUrl({ OPENROUTER_BASE_URL: "https://b/v1" })).toBe("https://b/v1");
		expect(embeddingApiUrl({})).toBe(DEFAULT_EMBEDDING_API_URL);
	});
});

describe("embedding toggles + input cap", () => {
	it("reads the via-api and disabled flags", () => {
		expect(embeddingsViaApi({})).toBe(false);
		expect(embeddingsViaApi({ MNEMOPI_EMBEDDINGS_VIA_API: "1" })).toBe(true);
		expect(embeddingsDisabled({})).toBe(false);
		expect(embeddingsDisabled({ MNEMOPI_NO_EMBEDDINGS: "1" })).toBe(true);
		// Any non-empty value disables.
		expect(embeddingsDisabled({ MNEMOPI_NO_EMBEDDINGS: "yes" })).toBe(true);
		expect(embeddingsDisabled({ MNEMOPI_NO_EMBEDDINGS: "" })).toBe(false);
	});

	it("clamps the input-char cap at 0 and honors 0-disables", () => {
		expect(embeddingMaxInputChars({})).toBe(8192);
		expect(embeddingMaxInputChars({ MNEMOPI_EMBEDDING_MAX_INPUT_CHARS: "4096" })).toBe(4096);
		expect(embeddingMaxInputChars({ MNEMOPI_EMBEDDING_MAX_INPUT_CHARS: "0" })).toBe(0);
		expect(embeddingMaxInputChars({ MNEMOPI_EMBEDDING_MAX_INPUT_CHARS: "-50" })).toBe(0);
	});
});

describe("isApiEmbeddingModel", () => {
	it("is true for openai-prefixed and text-embedding models", () => {
		expect(isApiEmbeddingModel("openai/text-embedding-3-small", {})).toBe(true);
		expect(isApiEmbeddingModel("text-embedding-3-large", {})).toBe(true);
		expect(isApiEmbeddingModel("my-text-embedding-thing", {})).toBe(true);
	});

	it("is true for a local model behind a non-openrouter base url", () => {
		expect(
			isApiEmbeddingModel("BAAI/bge-small-en-v1.5", { MNEMOPI_EMBEDDING_API_URL: "https://api.example.com/v1" }),
		).toBe(true);
	});

	it("falls back to the via-api flag for a local model with no api url", () => {
		expect(isApiEmbeddingModel("BAAI/bge-small-en-v1.5", {})).toBe(false);
		expect(isApiEmbeddingModel("BAAI/bge-small-en-v1.5", { MNEMOPI_EMBEDDINGS_VIA_API: "1" })).toBe(true);
	});

	it("does not count an openrouter base url as an api-embedding trigger", () => {
		expect(
			isApiEmbeddingModel("BAAI/bge-small-en-v1.5", { MNEMOPI_EMBEDDING_API_URL: DEFAULT_EMBEDDING_API_URL }),
		).toBe(false);
	});
});

describe("apiEmbeddingsAvailable", () => {
	it("is false when embeddings are disabled", () => {
		expect(
			apiEmbeddingsAvailable({ MNEMOPI_NO_EMBEDDINGS: "1", MNEMOPI_EMBEDDING_MODEL: "text-embedding-3-small" }),
		).toBe(false);
	});

	it("is false for a non-api model", () => {
		expect(apiEmbeddingsAvailable({ MNEMOPI_EMBEDDING_MODEL: "BAAI/bge-small-en-v1.5" })).toBe(false);
	});

	it("is true for an api model with a key or a non-openrouter url", () => {
		expect(apiEmbeddingsAvailable({ MNEMOPI_EMBEDDING_MODEL: "text-embedding-3-small", OPENAI_API_KEY: "sk" })).toBe(
			true,
		);
		expect(
			apiEmbeddingsAvailable({
				MNEMOPI_EMBEDDING_MODEL: "BAAI/bge-small-en-v1.5",
				MNEMOPI_EMBEDDING_API_URL: "https://api.example.com/v1",
			}),
		).toBe(true);
	});
});

describe("memory-limit + batch integer resolvers", () => {
	it("returns each default and its override", () => {
		expect(workingMemoryMaxItems({})).toBe(10000);
		expect(workingMemoryMaxItems({ MNEMOPI_WM_MAX_ITEMS: "42" })).toBe(42);
		expect(workingMemoryTtlHours({})).toBe(24);
		expect(workingMemoryTtlHours({ MNEMOPI_WM_TTL_HOURS: "6" })).toBe(6);
		expect(episodicRecallLimit({})).toBe(50000);
		expect(episodicRecallLimit({ MNEMOPI_EP_LIMIT: "100" })).toBe(100);
		expect(sleepBatchSize({})).toBe(5000);
		expect(sleepBatchSize({ MNEMOPI_SLEEP_BATCH: "10" })).toBe(10);
		expect(scratchpadMaxItems({})).toBe(1000);
		expect(scratchpadMaxItems({ MNEMOPI_SP_MAX: "7" })).toBe(7);
		expect(degradeBatchSize({})).toBe(100);
		expect(degradeBatchSize({ MNEMOPI_DEGRADE_BATCH: "25" })).toBe(25);
		expect(tier3MaxChars({})).toBe(300);
		expect(tier3MaxChars({ MNEMOPI_TIER3_MAX_CHARS: "80" })).toBe(80);
	});

	it("clamps maxEpisodeChars to a floor of 1", () => {
		expect(maxEpisodeChars({})).toBe(100000);
		expect(maxEpisodeChars({ MNEMOPI_MAX_EPISODE_CHARS: "5" })).toBe(5);
		expect(maxEpisodeChars({ MNEMOPI_MAX_EPISODE_CHARS: "0" })).toBe(1);
		expect(maxEpisodeChars({ MNEMOPI_MAX_EPISODE_CHARS: "-3" })).toBe(1);
	});
});

describe("tier + recency float resolvers", () => {
	it("returns tier day/weight defaults and overrides", () => {
		expect(recencyHalflifeHours({})).toBe(168);
		expect(recencyHalflifeHours({ MNEMOPI_RECENCY_HALFLIFE: "12.5" })).toBe(12.5);
		expect(temporalHalflifeHours({})).toBe(24);
		expect(temporalHalflifeHours({ MNEMOPI_TEMPORAL_HALFLIFE_HOURS: "6.25" })).toBe(6.25);
		expect(tier2Days({})).toBe(30);
		expect(tier2Days({ MNEMOPI_TIER2_DAYS: "45" })).toBe(45);
		expect(tier3Days({})).toBe(180);
		expect(tier3Days({ MNEMOPI_TIER3_DAYS: "365" })).toBe(365);
		expect(tier1Weight({})).toBe(1.0);
		expect(tier2Weight({})).toBe(0.5);
		expect(tier3Weight({})).toBe(0.25);
		expect(tier1Weight({ MNEMOPI_TIER1_WEIGHT: "0.9" })).toBe(0.9);
		expect(tier2Weight({ MNEMOPI_TIER2_WEIGHT: "0.4" })).toBe(0.4);
		expect(tier3Weight({ MNEMOPI_TIER3_WEIGHT: "0.1" })).toBe(0.1);
	});
});

describe("veracity weight resolvers", () => {
	it("returns each default and override", () => {
		expect(statedWeight({})).toBe(1.0);
		expect(inferredWeight({})).toBe(0.7);
		expect(toolWeight({})).toBe(0.5);
		expect(importedWeight({})).toBe(0.6);
		expect(unknownWeight({})).toBe(0.8);
		expect(statedWeight({ MNEMOPI_STATED_WEIGHT: "0.95" })).toBe(0.95);
		expect(inferredWeight({ MNEMOPI_INFERRED_WEIGHT: "0.65" })).toBe(0.65);
		expect(toolWeight({ MNEMOPI_TOOL_WEIGHT: "0.45" })).toBe(0.45);
		expect(importedWeight({ MNEMOPI_IMPORTED_WEIGHT: "0.55" })).toBe(0.55);
		expect(unknownWeight({ MNEMOPI_UNKNOWN_WEIGHT: "0.75" })).toBe(0.75);
	});

	it("lists exactly the veracity weight env names that are set (trimmed)", () => {
		expect(veracityWeightOverrides({})).toEqual([]);
		expect(veracityWeightOverrides({ MNEMOPI_STATED_WEIGHT: "   " })).toEqual([]);
		expect(veracityWeightOverrides({ MNEMOPI_STATED_WEIGHT: "1", MNEMOPI_UNKNOWN_WEIGHT: "0.5" })).toEqual([
			"MNEMOPI_STATED_WEIGHT",
			"MNEMOPI_UNKNOWN_WEIGHT",
		]);
	});
});

describe("recall-weight + vec-type resolvers", () => {
	it("reads the vec/fts/importance weights", () => {
		expect(vectorWeight({})).toBe(0.5);
		expect(ftsWeight({})).toBe(0.3);
		expect(importanceWeight({})).toBe(0.2);
		expect(vectorWeight({ MNEMOPI_VEC_WEIGHT: "0.7" })).toBe(0.7);
		expect(ftsWeight({ MNEMOPI_FTS_WEIGHT: "0.25" })).toBe(0.25);
		expect(importanceWeight({ MNEMOPI_IMPORTANCE_WEIGHT: "0.15" })).toBe(0.15);
	});

	it("accepts only the three vec types, falling back to int8", () => {
		expect(vecType({})).toBe("int8");
		expect(vecType({ MNEMOPI_VEC_TYPE: "float32" })).toBe("float32");
		expect(vecType({ MNEMOPI_VEC_TYPE: "bit" })).toBe("bit");
		expect(vecType({ MNEMOPI_VEC_TYPE: "garbage" })).toBe("int8");
	});
});

describe("boolean toggle resolvers", () => {
	it("reads beam-optimizations, smart-compress, and auto-migrate", () => {
		expect(beamOptimizationsEnabled({})).toBe(false);
		expect(beamOptimizationsEnabled({ MNEMOPI_BEAM_OPTIMIZATIONS: "1" })).toBe(true);
		// smart-compress is on unless explicitly disabled.
		expect(smartCompressEnabled({})).toBe(true);
		expect(smartCompressEnabled({ MNEMOPI_SMART_COMPRESS: "0" })).toBe(false);
		// auto-migrate is on unless exactly "0".
		expect(autoMigrateEnabled({})).toBe(true);
		expect(autoMigrateEnabled({ MNEMOPI_AUTO_MIGRATE: "0" })).toBe(false);
		expect(autoMigrateEnabled({ MNEMOPI_AUTO_MIGRATE: "1" })).toBe(true);
	});
});

describe("llm resolvers", () => {
	it("reads the llm enable flag and numeric knobs", () => {
		expect(llmEnabled({})).toBe(true);
		expect(llmEnabled({ MNEMOPI_LLM_ENABLED: "false" })).toBe(false);
		expect(llmMaxTokens({})).toBe(2048);
		expect(llmMaxTokens({ MNEMOPI_LLM_MAX_TOKENS: "512" })).toBe(512);
		expect(llmThreads({})).toBe(4);
		expect(llmThreads({ MNEMOPI_LLM_N_THREADS: "8" })).toBe(8);
		expect(llmContext({})).toBe(2048);
		expect(llmContext({ MNEMOPI_LLM_N_CTX: "4096" })).toBe(4096);
	});

	it("reads the repo/file defaults and model-file pairing", () => {
		expect(llmRepo({})).toBe(DEFAULT_LLM_MODEL_REPO);
		expect(llmFile({})).toBe(DEFAULT_LLM_MODEL_FILE);
		expect(llmRepo({ MNEMOPI_LLM_REPO: "org/repo" })).toBe("org/repo");
		expect(llmFile({ MNEMOPI_LLM_FILE: "model.gguf" })).toBe("model.gguf");
		// Both must be set to use the pair; otherwise both defaults.
		expect(llmModelFiles({ MNEMOPI_LLM_REPO: "org/repo", MNEMOPI_LLM_FILE: "m.gguf" })).toEqual([
			"org/repo",
			"m.gguf",
		]);
		expect(llmModelFiles({ MNEMOPI_LLM_REPO: "org/repo" })).toEqual([DEFAULT_LLM_MODEL_REPO, DEFAULT_LLM_MODEL_FILE]);
		expect(llmModelFiles({})).toEqual([DEFAULT_LLM_MODEL_REPO, DEFAULT_LLM_MODEL_FILE]);
	});

	it("reads the remote-llm string knobs, trimming the base url", () => {
		expect(llmBaseUrl({})).toBe("");
		expect(llmBaseUrl({ MNEMOPI_LLM_BASE_URL: "https://llm.local/v1///" })).toBe("https://llm.local/v1");
		expect(llmApiKey({})).toBe("");
		expect(llmApiKey({ MNEMOPI_LLM_API_KEY: "sk-1" })).toBe("sk-1");
		expect(llmModel({})).toBe("");
		expect(llmModel({ MNEMOPI_LLM_MODEL: "gpt-4o" })).toBe("gpt-4o");
	});
});

describe("host-llm resolvers", () => {
	it("reads the host-llm flag, provider, model, and context", () => {
		expect(hostLlmEnabled({})).toBe(false);
		expect(hostLlmEnabled({ MNEMOPI_HOST_LLM_ENABLED: "true" })).toBe(true);
		expect(hostLlmProvider({})).toBeUndefined();
		expect(hostLlmProvider({ MNEMOPI_HOST_LLM_PROVIDER: "anthropic" })).toBe("anthropic");
		expect(hostLlmModel({})).toBeUndefined();
		expect(hostLlmModel({ MNEMOPI_HOST_LLM_MODEL: "claude" })).toBe("claude");
		expect(hostLlmContext({})).toBe(32000);
		expect(hostLlmContext({ MNEMOPI_HOST_LLM_N_CTX: "8000" })).toBe(8000);
	});
});

describe("sleep prompt", () => {
	it("defaults to empty and trims the override", () => {
		expect(sleepPrompt({})).toBe("");
		expect(sleepPrompt({ MNEMOPI_SLEEP_PROMPT: "  do the thing  " })).toBe("do the thing");
	});
});
