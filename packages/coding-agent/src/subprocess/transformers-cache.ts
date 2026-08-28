import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getTinyModelsCacheDir } from "@veyyon/utils";

/** On-disk state of one Transformers.js model repo. `downloaded` is true when at least one `.onnx` weight file is present, which */
export interface TransformersRepoCacheState {
	downloaded: boolean;
	bytes: number;
}

/** Resolve where Transformers.js stores a Hub repo on disk. The library writes a repo's `main`-revision files under `<cacheDir>/<org>/<name>/...`, so the repo */
export function transformersRepoDir(repo: string, cacheDir: string = getTinyModelsCacheDir()): string {
	return path.join(cacheDir, ...repo.split("/"));
}

/** Inspect the Transformers.js cache for one repo: whether its weights are present and the total bytes it occupies. A missing repo directory reports */
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
