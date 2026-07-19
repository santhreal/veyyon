import * as fs from "node:fs";
import * as path from "node:path";
import { isEnoent, isEnotdir, isFsError } from "@veyyon/utils/fs-error";
import * as logger from "@veyyon/utils/logger";
import { errorMessage } from "@veyyon/utils/type-guards";

const contentCache = new Map<string, string | null>();
const dirCache = new Map<string, fs.Dirent[]>();

function resolvePath(filePath: string): string {
	return path.resolve(filePath);
}

export async function readFile(filePath: string): Promise<string | null> {
	const abs = resolvePath(filePath);
	if (contentCache.has(abs)) {
		return contentCache.get(abs) ?? null;
	}

	try {
		// Gate on the file type first: discovery scans foreign config dirs
		// (~/.claude, ~/.cursor, project trees), and reading a FIFO/socket/char
		// device with `.text()` blocks until EOF — i.e. forever — hanging
		// startup with zero output. `stat` follows symlinks, so symlinked
		// context files (CLAUDE.md -> AGENTS.md) still resolve.
		const stats = await fs.promises.stat(abs);
		if (!stats.isFile()) {
			contentCache.set(abs, null);
			return null;
		}
		const content = await Bun.file(abs).text();
		contentCache.set(abs, content);
		return content;
	} catch (err) {
		contentCache.set(abs, null);
		// ENOENT/ENOTDIR mean the path genuinely is not there: the common,
		// benign case when discovery probes optional context files. Anything
		// else (EACCES, EIO, EMFILE, EBUSY, ...) means the file EXISTS but we
		// could not read it. Surface that loudly instead of silently dropping
		// the context, so the operator learns why a CLAUDE.md/AGENTS.md went
		// missing from the prompt (Law 10: no silent recall loss). We still
		// return null so startup proceeds; the cached null above suppresses
		// re-warning on repeat reads of the same path.
		if (!isEnoent(err) && !isEnotdir(err)) {
			logger.warn("Context file exists but could not be read; dropped from discovery", {
				path: abs,
				code: isFsError(err) ? err.code : undefined,
				error: errorMessage(err),
			});
		}
		return null;
	}
}

export async function readDirEntries(dirPath: string): Promise<fs.Dirent[]> {
	const abs = resolvePath(dirPath);
	if (dirCache.has(abs)) {
		return dirCache.get(abs) ?? [];
	}

	try {
		const entries = await fs.promises.readdir(abs, { withFileTypes: true });
		dirCache.set(abs, entries);
		return entries;
	} catch (err) {
		dirCache.set(abs, []);
		// Same split as readFile: a missing directory (ENOENT/ENOTDIR) is the
		// expected probe-miss during discovery, but a directory that exists yet
		// cannot be listed (EACCES, EMFILE, ...) is a real error that would
		// otherwise silently hide every context file beneath it. Warn, cache
		// the empty result so we do not re-warn, and fail soft with [].
		if (!isEnoent(err) && !isEnotdir(err)) {
			logger.warn("Directory exists but could not be listed; skipped during discovery", {
				path: abs,
				code: isFsError(err) ? err.code : undefined,
				error: errorMessage(err),
			});
		}
		return [];
	}
}

export async function readDir(dirPath: string): Promise<string[]> {
	const entries = await readDirEntries(dirPath);
	return entries.map(entry => entry.name);
}

export async function walkUp(
	startDir: string,
	name: string,
	opts: { file?: boolean; dir?: boolean } = {},
): Promise<string | null> {
	const { file = true, dir = true } = opts;
	let current = resolvePath(startDir);

	while (true) {
		const entries = await readDirEntries(current);
		const entry = entries.find(e => e.name === name);
		if (entry) {
			if (file && entry.isFile()) return path.join(current, name);
			if (dir && entry.isDirectory()) return path.join(current, name);
		}
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

/**
 * Walk up from startDir looking for a `.git` entry (file or directory).
 * Returns the directory containing `.git` (the repo root), or null if not in a git repo.
 * Results are based on the cached readDirEntries, so repeated calls are cheap.
 */
export async function findRepoRoot(startDir: string): Promise<string | null> {
	let current = resolvePath(startDir);
	while (true) {
		const entries = await readDirEntries(current);
		if (entries.some(e => e.name === ".git")) {
			return current;
		}
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

export function cacheStats(): { content: number; dir: number } {
	return {
		content: contentCache.size,
		dir: dirCache.size,
	};
}

export function clearCache(): void {
	contentCache.clear();
	dirCache.clear();
}

export function invalidate(filePath: string): void {
	const abs = resolvePath(filePath);
	contentCache.delete(abs);
	dirCache.delete(abs);
	const parent = path.dirname(abs);
	if (parent !== abs) {
		dirCache.delete(parent);
	}
}
