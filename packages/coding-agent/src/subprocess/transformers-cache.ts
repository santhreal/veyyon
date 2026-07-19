import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getTinyModelsCacheDir } from "@veyyon/utils";

/**
 * On-disk state of one Transformers.js model repo.
 *
 * `downloaded` is true when at least one `.onnx` weight file is present, which
 * is the same signal the worker uses to decide a model can load without a
 * network fetch. `bytes` is the total size of every file cached under the repo
 * directory, so a partial download (config and tokenizer fetched, weights not)
 * reports `downloaded: false` with a non-zero `bytes`.
 */
export interface TransformersRepoCacheState {
	downloaded: boolean;
	bytes: number;
}

/**
 * Resolve where Transformers.js stores a Hub repo on disk. The library writes a
 * repo's `main`-revision files under `<cacheDir>/<org>/<name>/...`, so the repo
 * id ("org/name") is split into path segments rather than used verbatim. The
 * cache root defaults to {@link getTinyModelsCacheDir}, which is the same
 * directory bound to `transformers.env.cacheDir` when a worker loads the
 * runtime; pass an explicit `cacheDir` in tests.
 */
export function transformersRepoDir(repo: string, cacheDir: string = getTinyModelsCacheDir()): string {
	return path.join(cacheDir, ...repo.split("/"));
}

/**
 * Inspect the Transformers.js cache for one repo: whether its weights are
 * present and the total bytes it occupies. A missing repo directory reports
 * `{ downloaded: false, bytes: 0 }` rather than throwing, so a caller can list
 * every model without special-casing the never-downloaded ones.
 */
export async function transformersRepoCacheState(
	repo: string,
	cacheDir: string = getTinyModelsCacheDir(),
): Promise<TransformersRepoCacheState> {
	const repoDir = transformersRepoDir(repo, cacheDir);
	let entries: string[];
	try {
		entries = (await fs.readdir(repoDir, { recursive: true })) as string[];
	} catch {
		return { downloaded: false, bytes: 0 };
	}
	let bytes = 0;
	let downloaded = false;
	for (const entry of entries) {
		const full = path.join(repoDir, entry);
		let stat: Awaited<ReturnType<typeof fs.stat>>;
		try {
			stat = await fs.stat(full);
		} catch {
			continue;
		}
		if (!stat.isFile()) continue;
		bytes += stat.size;
		if (full.endsWith(".onnx")) downloaded = true;
	}
	return { downloaded, bytes };
}
