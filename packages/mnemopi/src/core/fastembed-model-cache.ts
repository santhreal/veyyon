import * as path from "node:path";

const FASTEMBED_MODEL_SIDECARS = [
	"config.json",
	"tokenizer.json",
	"tokenizer_config.json",
	"special_tokens_map.json",
] as const;

/**
 * Every local model mnemopi can run, with both names it answers to.
 *
 * A model has two names: the Hugging Face repository you configure it by
 * (`BAAI/bge-small-en-v1.5`) and the identifier fastembed knows it as
 * (`fast-bge-small-en-v1.5`). Callers need the mapping in both directions, so both are
 * DERIVED from this one list rather than written out twice.
 *
 * They used to be two hand-written tables in two files: this one, and `KNOWN_MODEL_NAMES`
 * in `core/embeddings.ts` holding the exact inverse. Adding a model to one and not the
 * other resolved the fastembed identifier and then failed to find the repository to fetch
 * its tokenizer from, which surfaces as a model that will not initialise rather than as a
 * missing table entry.
 */
const FASTEMBED_MODELS: ReadonlyArray<{ readonly hfRepo: string; readonly fastembedId: string }> = [
	{ hfRepo: "sentence-transformers/all-MiniLM-L6-v2", fastembedId: "fast-all-MiniLM-L6-v2" },
	{ hfRepo: "BAAI/bge-base-en", fastembedId: "fast-bge-base-en" },
	{ hfRepo: "BAAI/bge-base-en-v1.5", fastembedId: "fast-bge-base-en-v1.5" },
	{ hfRepo: "BAAI/bge-small-en", fastembedId: "fast-bge-small-en" },
	{ hfRepo: "BAAI/bge-small-en-v1.5", fastembedId: "fast-bge-small-en-v1.5" },
	{ hfRepo: "BAAI/bge-small-zh-v1.5", fastembedId: "fast-bge-small-zh-v1.5" },
	{ hfRepo: "intfloat/multilingual-e5-large", fastembedId: "fast-multilingual-e5-large" },
];

/**
 * The fastembed identifier for a configured Hugging Face repository name, or `undefined`
 * for a model mnemopi cannot run locally.
 *
 * Read this rather than importing `fastembed` to resolve a name: that module eagerly
 * loads the `onnxruntime-node` native addon, which segfaults in some runtimes. This file
 * imports nothing but `node:path`, so consulting it is always safe.
 */
export const FASTEMBED_ID_BY_HF_REPO: Readonly<Record<string, string>> = Object.fromEntries(
	FASTEMBED_MODELS.map(model => [model.hfRepo, model.fastembedId]),
);

/** The Hugging Face repository a fastembed identifier's weights and tokenizer come from. */
export const HF_REPO_BY_FASTEMBED_ID: Readonly<Record<string, string>> = Object.fromEntries(
	FASTEMBED_MODELS.map(model => [model.fastembedId, model.hfRepo]),
);

/** Download missing config/tokenizer sidecars into a fastembed model cache directory. */
export async function ensureFastembedModelSidecars(model: string, cacheDir = "local_cache"): Promise<boolean> {
	const repo = HF_REPO_BY_FASTEMBED_ID[model];
	if (repo === undefined) return false;

	const modelDir = path.join(cacheDir, model);
	for (const fileName of FASTEMBED_MODEL_SIDECARS) {
		const target = path.join(modelDir, fileName);
		if (await Bun.file(target).exists()) continue;

		const response = await fetch(`https://huggingface.co/${repo}/resolve/main/${fileName}`);
		if (!response.ok) {
			throw new Error(
				`Failed to download ${model} ${fileName} from ${repo}: ${response.status} ${response.statusText}`,
			);
		}
		await Bun.write(target, await response.arrayBuffer());
	}
	return true;
}
