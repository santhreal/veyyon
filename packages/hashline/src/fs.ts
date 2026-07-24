/**
 * Storage seam for the hashline patcher. {@link Filesystem} is intentionally
 * minimal — `readText`, `writeText`, `exists` — so any backing store can be
 * adapted: disk, memory, S3, an LSP text-document protocol, a Git tree, a
 * VFS, etc.
 *
 * The patcher does its own BOM stripping and LF normalization between
 * {@link Filesystem.readText} and {@link Filesystem.writeText}; the FS deals
 * only in raw text strings.
 */
import * as fs from "node:fs/promises";
import * as pathModule from "node:path";

/**
 * Result returned by {@link Filesystem.writeText}. The patcher echoes back
 * `text` so adapters that transform on serialization (e.g. notebooks) can
 * report what actually landed on disk.
 */
export interface WriteResult {
	/** Final text that was persisted. May differ from the input if the FS transformed it. */
	text: string;
}

import type { FileOp } from "./types";

/** Optional hints for {@link Filesystem.preflightWrite}. */
export interface PreflightWriteOptions {
	fileOp?: FileOp;
}

/**
 * ENOENT-like error thrown by {@link Filesystem.readText} when a path is
 * missing. Carrying a `code` property keeps the contract compatible with
 * `node:fs` callers that already check `err.code === "ENOENT"`.
 */
export class NotFoundError extends Error {
	readonly code = "ENOENT";

	constructor(path: string, cause?: unknown) {
		super(`File not found: ${path}`);
		this.name = "NotFoundError";
		if (cause !== undefined) (this as Error & { cause?: unknown }).cause = cause;
	}
}

/** Type guard for {@link NotFoundError} and structurally-compatible errors. */
export function isNotFound(error: unknown): boolean {
	if (error instanceof NotFoundError) return true;
	if (error instanceof Error && (error as Error & { code?: string }).code === "ENOENT") return true;
	return false;
}

/**
 * True when `a` and `b` both exist and name the same underlying file, compared
 * by device + inode rather than by string. This catches the same file reached
 * under a different spelling that a textual path comparison misses: a case-only
 * difference on a case-insensitive volume, or a path routed through a symlink.
 * Returns false when either path is missing or cannot be stat'd — the caller
 * uses this to decide whether deleting the source after a content-move would
 * destroy the destination, so "not provably the same file" must be false.
 */
export async function sameExistingFile(a: string, b: string): Promise<boolean> {
	try {
		const [sa, sb] = await Promise.all([fs.stat(a), fs.stat(b)]);
		return sa.dev === sb.dev && sa.ino === sb.ino;
	} catch {
		return false;
	}
}

/** Monotonic suffix so two writes to the same target in one process never
 *  collide on a temp name. */
let atomicTempCounter = 0;

/**
 * Write `content` to `targetPath` crash-atomically: stream into a sibling temp
 * file, then rename it over the target. A rename is atomic on POSIX, so a death
 * mid-write (SIGINT, out-of-memory kill, full disk, power loss) leaves the
 * target as either the whole old file or the whole new one, never a truncated
 * mix. A plain `Bun.write`/`writeFile` truncates the target in place and streams
 * into it, so the same interruption corrupts the user's real source file.
 *
 * This is deliberately a small self-contained copy of the temp+rename pattern
 * rather than a dependency on `@veyyon/utils` (which owns the fuller
 * `atomicWriteFile`): hashline is a lean, standalone patch library with only
 * `diff` and `lru-cache` as dependencies, and pulling in the utils package would
 * drag its logging/templating/native transitive deps into every hashline
 * consumer. Keep the two in sync by behavior, not by import.
 *
 * A symlinked target is resolved so the link's target is replaced and the link
 * itself is preserved. The existing file's permission bits are carried forward
 * because the rename swaps the inode (a new file defaults to 0o644).
 */
async function writeFileAtomic(targetPath: string, content: string): Promise<void> {
	let target = targetPath;
	try {
		const linkStat = await fs.lstat(targetPath);
		if (linkStat.isSymbolicLink()) {
			target = pathModule.resolve(pathModule.dirname(targetPath), await fs.readlink(targetPath));
		}
	} catch (error) {
		if (!isNotFound(error)) throw error;
	}

	let mode = 0o644;
	try {
		mode = (await fs.stat(target)).mode & 0o777;
	} catch (error) {
		if (!isNotFound(error)) throw error;
	}

	const dir = pathModule.dirname(target);
	const tempPath = pathModule.join(dir, `.${pathModule.basename(target)}.${process.pid}.${atomicTempCounter++}.tmp`);
	try {
		await fs.writeFile(tempPath, content, { mode });
		try {
			await fs.rename(tempPath, target);
		} catch (error) {
			// Windows cannot rename onto an existing file; drop it and retry so the
			// overwrite still happens (POSIX rename already replaces atomically).
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "EEXIST" || code === "EPERM" || code === "EACCES") {
				await fs.rm(target, { force: true });
				await fs.rename(tempPath, target);
			} else {
				throw error;
			}
		}
	} catch (error) {
		await fs.rm(tempPath, { force: true }).catch(() => {});
		throw error;
	}
}

/**
 * Abstract storage backend the {@link Patcher} reads from and writes to.
 * Subclass for new backends; the package ships {@link InMemoryFilesystem} and
 * {@link NodeFilesystem} for the most common cases.
 *
 * Implementations work with raw text — the patcher handles BOM stripping and
 * line-ending normalization itself. `readText` MUST throw {@link
 * NotFoundError} (or any error for which {@link isNotFound} returns true)
 * when the path doesn't exist; that's how the patcher detects a create-vs-
 * update.
 */
export abstract class Filesystem {
	/** Read the file's full text content. Throw on missing file. */
	abstract readText(path: string): Promise<string>;

	/** Read raw bytes for backends whose text is a direct decode of persisted bytes. */
	readBinary?(path: string): Promise<Uint8Array | undefined>;

	/** Validate that `path` is writable before a prepared batch starts committing. */
	async preflightWrite(_path: string, _options?: PreflightWriteOptions): Promise<void> {}

	/** Persist `content` at `path`. Returns the actual final text that was written. */
	abstract writeText(path: string, content: string): Promise<WriteResult>;

	/** Delete the file at `path`. Default: not supported. */
	async delete(path: string): Promise<void> {
		throw new Error(`Filesystem does not support delete: ${path}`);
	}

	/**
	 * Move/rename `from` to `to`. When `content` is provided the destination
	 * receives that text; otherwise implementations may preserve the source bytes.
	 */
	async move(from: string, to: string, content?: string): Promise<void> {
		void content;
		throw new Error(`Filesystem does not support move: ${from} -> ${to}`);
	}

	/** Return true when the path exists and can be read. Default: probe via {@link readText}. */
	async exists(path: string): Promise<boolean> {
		try {
			await this.readText(path);
			return true;
		} catch (error) {
			if (isNotFound(error)) return false;
			throw error;
		}
	}

	/**
	 * Canonical path used as a key by external caches (e.g. snapshot
	 * stores). The default is identity; override to return an absolute or
	 * otherwise canonicalised path so producers and consumers of cached
	 * snapshots agree on the key without each having to redo the resolution.
	 */
	canonicalPath(path: string): string {
		return path;
	}

	/**
	 * Whether a section whose authored path is missing may be redirected to
	 * the file its snapshot tag names (tag-based path recovery in
	 * {@link Patcher.prepare}). `resolvedPath` is the canonical path the
	 * redirect would read and write. Default: allow.
	 *
	 * Hosts that grant write privileges by path shape override this to refuse
	 * redirects that could escalate beyond what the caller approved — e.g. an
	 * internal-URL authored target (approved read-only), or a `resolvedPath`
	 * outside the working tree (a sandbox/vault/out-of-tree write).
	 */
	allowTagPathRecovery(_authoredPath: string, _resolvedPath: string): boolean {
		return true;
	}
}

/**
 * In-memory {@link Filesystem}. Useful for tests, sandboxes, dry-runs, and as
 * a building block for stacked adapters (e.g. an LRU layer on top).
 */
export class InMemoryFilesystem extends Filesystem {
	#files = new Map<string, string>();

	constructor(initial?: Iterable<readonly [string, string]>) {
		super();
		if (initial) {
			for (const [path, content] of initial) this.#files.set(path, content);
		}
	}

	async readText(path: string): Promise<string> {
		const text = this.#files.get(path);
		if (text === undefined) throw new NotFoundError(path);
		return text;
	}

	async writeText(path: string, content: string): Promise<WriteResult> {
		this.#files.set(path, content);
		return { text: content };
	}

	async delete(path: string): Promise<void> {
		if (!this.#files.delete(path)) throw new NotFoundError(path);
	}

	async move(from: string, to: string, content?: string): Promise<void> {
		const existing = this.#files.get(from);
		if (existing === undefined) throw new NotFoundError(from);
		const finalContent = content ?? existing;
		this.#files.set(to, finalContent);
		// Same-key move: `from` and `to` are one entry, so the set above already
		// wrote it — deleting `from` would drop the entry we just moved. Mirrors
		// the same-file guard in the disk-backed backends: a move never destroys
		// the file it just wrote.
		if (to !== from) this.#files.delete(from);
	}

	async exists(path: string): Promise<boolean> {
		return this.#files.has(path);
	}

	/** Synchronous helper for setting up fixtures without awaiting. */
	set(path: string, content: string): void {
		this.#files.set(path, content);
	}

	/** Synchronous helper for inspecting state without awaiting. */
	get(path: string): string | undefined {
		return this.#files.get(path);
	}

	/** Wipe all entries. */
	clear(): void {
		this.#files.clear();
	}

	/** Iterate `[path, content]` pairs. */
	entries(): IterableIterator<[string, string]> {
		return this.#files.entries();
	}
}

/**
 * Disk-backed {@link Filesystem} using Bun's file APIs. The default for CLI
 * use. Paths are accepted as-is; callers responsible for any cwd or
 * jail/sandbox resolution should wrap this with their own subclass.
 */
export class NodeFilesystem extends Filesystem {
	async readText(path: string): Promise<string> {
		const file = Bun.file(path);
		if (!(await file.exists())) throw new NotFoundError(path);
		return file.text();
	}

	async readBinary(path: string): Promise<Uint8Array> {
		try {
			return await fs.readFile(path);
		} catch (error) {
			if (isNotFound(error)) throw new NotFoundError(path, error);
			throw error;
		}
	}

	async writeText(path: string, content: string): Promise<WriteResult> {
		await writeFileAtomic(path, content);
		return { text: content };
	}

	async delete(path: string): Promise<void> {
		try {
			await fs.rm(path);
		} catch (error) {
			if (isNotFound(error)) throw new NotFoundError(path, error);
			throw error;
		}
	}

	async move(from: string, to: string, content?: string): Promise<void> {
		if (content !== undefined) {
			// Write-then-delete only when `from` and `to` are genuinely different
			// files. When they are the SAME underlying file — a case-only rename on
			// a case-insensitive volume, or a move reached through a symlink — the
			// delete would erase the bytes we just wrote and the user loses the
			// file. `path.resolve` (the caller-side same-path guard in the patcher)
			// does not fold case or resolve symlinks, so this cannot be left to the
			// caller: detect same-file here by device + inode and skip the delete.
			//
			// The destination write is crash-atomic (temp + rename), so a death
			// mid-move cannot corrupt a pre-existing file the move overwrites. For a
			// symlinked `to`, the atomic write resolves the link and replaces the
			// shared target, so the post-rename inode is identical under both names
			// and `sameExistingFile` still correctly skips the delete.
			await writeFileAtomic(to, content);
			if (!(await sameExistingFile(from, to))) {
				await this.delete(from);
			}
			return;
		}
		try {
			await fs.rename(from, to);
		} catch (error) {
			if (isNotFound(error)) throw new NotFoundError(from, error);
			throw error;
		}
	}

	canonicalPath(path: string): string {
		return pathModule.resolve(path);
	}

	async exists(path: string): Promise<boolean> {
		return Bun.file(path).exists();
	}
}
