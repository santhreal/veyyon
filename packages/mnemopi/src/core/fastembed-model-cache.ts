import { mkdir } from "node:fs/promises";
import * as path from "node:path";

const FASTEMBED_MODEL_SIDECARS = [
	"config.json",
	"tokenizer.json",
	"tokenizer_config.json",
	"special_tokens_map.json",
] as const;
const sidecarRepairs = new Map<string, Promise<boolean>>();

const FASTEMBED_MODELS: ReadonlyArray<{ readonly hfRepo: string; readonly fastembedId: string }> = [
	{ hfRepo: "sentence-transformers/all-MiniLM-L6-v2", fastembedId: "fast-all-MiniLM-L6-v2" },
	{ hfRepo: "BAAI/bge-base-en", fastembedId: "fast-bge-base-en" },
	{ hfRepo: "BAAI/bge-base-en-v1.5", fastembedId: "fast-bge-base-en-v1.5" },
	{ hfRepo: "BAAI/bge-small-en", fastembedId: "fast-bge-small-en" },
	{ hfRepo: "BAAI/bge-small-en-v1.5", fastembedId: "fast-bge-small-en-v1.5" },
	{ hfRepo: "BAAI/bge-small-zh-v1.5", fastembedId: "fast-bge-small-zh-v1.5" },
	{ hfRepo: "intfloat/multilingual-e5-large", fastembedId: "fast-multilingual-e5-large" },
];

export const FASTEMBED_ID_BY_HF_REPO: Readonly<Record<string, string>> = Object.fromEntries(
	FASTEMBED_MODELS.map(model => [model.hfRepo, model.fastembedId]),
);

export const HF_REPO_BY_FASTEMBED_ID: Readonly<Record<string, string>> = Object.fromEntries(
	FASTEMBED_MODELS.map(model => [model.fastembedId, model.hfRepo]),
);

export function ensureFastembedModelSidecars(model: string, cacheDir = "local_cache"): Promise<boolean> {
	const repo = HF_REPO_BY_FASTEMBED_ID[model];
	if (repo === undefined) return Promise.resolve(false);

	const modelDir = path.resolve(cacheDir, model);
	const pending = sidecarRepairs.get(modelDir);
	if (pending !== undefined) return pending;

	let repair: Promise<boolean>;
	repair = repairFastembedModelSidecars(model, repo, modelDir).finally(() => {
		if (sidecarRepairs.get(modelDir) === repair) sidecarRepairs.delete(modelDir);
	});
	sidecarRepairs.set(modelDir, repair);
	return repair;
}

async function repairFastembedModelSidecars(model: string, repo: string, modelDir: string): Promise<boolean> {
	await mkdir(modelDir, { recursive: true });
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
