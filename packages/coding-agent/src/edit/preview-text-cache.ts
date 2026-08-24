/**
 * Raw text of an edit preview's target file, cached for the streaming pass.
 *
 * A streamed edit preview recomputes on every chunk the model emits, and each
 * pass needs the same file it needed a frame earlier: re-reading it dominates
 * the pass on a large file (a 11.7MiB source read ~30 times over two seconds of
 * 30Hz args). The cache is keyed by mtime+size so any on-disk change
 * invalidates it, and only the streaming pass consults it -- the args-complete
 * pass reads fresh, because that is the text the edit will be applied to.
 */
import { errorMessage } from "@veyyon/utils";
import { readEditFileText } from "./read-file";

interface CachedText {
	mtimeMs: number;
	size: number;
	rawContent: string;
}

/**
 * One entry per file, bounded because an entry holds a whole file: a preview
 * only ever revisits the file it is previewing, and a session touching more
 * files than this in one stream evicts the oldest rather than growing.
 */
const MAX_ENTRIES = 8;
const cache = new Map<string, CachedText>();

async function readFresh(absolutePath: string, displayPath: string): Promise<string> {
	try {
		return await readEditFileText(absolutePath, displayPath);
	} catch (error) {
		const message = errorMessage(error);
		throw new Error(message || `Unable to read ${displayPath}`);
	}
}

/**
 * Read the preview target. `streaming` reads through the cache; anything else
 * reads from disk and leaves the cache alone.
 */
export async function readPreviewText(
	absolutePath: string,
	displayPath: string,
	streaming: boolean | undefined,
): Promise<string> {
	if (!streaming) return readFresh(absolutePath, displayPath);

	let stamp: { mtimeMs: number; size: number } | undefined;
	try {
		const stat = await Bun.file(absolutePath).stat();
		stamp = { mtimeMs: stat.mtimeMs, size: stat.size };
	} catch {
		stamp = undefined;
	}
	if (stamp) {
		const cached = cache.get(absolutePath);
		if (cached && cached.mtimeMs === stamp.mtimeMs && cached.size === stamp.size) return cached.rawContent;
	}
	const rawContent = await readFresh(absolutePath, displayPath);
	if (stamp) {
		if (cache.size >= MAX_ENTRIES && !cache.has(absolutePath)) {
			const oldest = cache.keys().next().value;
			if (oldest !== undefined) cache.delete(oldest);
		}
		cache.set(absolutePath, { mtimeMs: stamp.mtimeMs, size: stamp.size, rawContent });
	}
	return rawContent;
}

/**
 * Drop every retained file. Production has no reason to call this -- an entry
 * is invalidated by its own mtime+size -- but a test that writes the same path
 * twice within one filesystem timestamp tick needs the slot cleared.
 */
export function clearPreviewTextCache(): void {
	cache.clear();
}
