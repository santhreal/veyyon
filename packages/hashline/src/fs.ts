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
import type { Stats } from "node:fs";
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
 * Resolve the file an atomic write should actually replace.
 *
 * A symlinked path is followed to the END of its chain, not one hop. One hop is
 * what a naive implementation does and it is wrong in the layout that makes
 * symlinked sources common in the first place: a linked package or a dotfile
 * manager where `pkg/src/index.ts` is a link to a link to the real file. Writing
 * after one hop replaces the INTERMEDIATE link with a regular file, so the link
 * is destroyed and the file the user actually keeps never receives the patch.
 * Both halves of that are silent, because a read afterwards returns the new
 * bytes from the file that replaced the link.
 *
 * `viaSymlink` is true whenever the caller's path was a link, including a
 * dangling one. The caller uses it to decide whether creating parent directories
 * is appropriate: fabricating the target directory of a dangling link would
 * turn "this link points nowhere" into a new tree nobody asked for.
 */
async function resolveAtomicWriteTarget(filePath: string): Promise<{ target: string; viaSymlink: boolean }> {
	try {
		const stats = await fs.lstat(filePath);
		if (!stats.isSymbolicLink()) {
			assertRegularFileTarget(stats, filePath);
			return { target: filePath, viaSymlink: false };
		}
	} catch (error) {
		// A path that does not exist yet is the normal create case.
		if (!isNotFound(error)) throw error;
		return { target: filePath, viaSymlink: false };
	}
	try {
		const target = await fs.realpath(filePath);
		assertRegularFileTarget(await fs.lstat(target), target);
		return { target, viaSymlink: true };
	} catch (error) {
		// A chain ending in a dangling link has no real path. Fall back to the
		// single hop so the failure names the missing file rather than the link.
		if (!isNotFound(error)) throw error;
		return {
			target: pathModule.resolve(pathModule.dirname(filePath), await fs.readlink(filePath)),
			viaSymlink: true,
		};
	}
}

/**
 * Refuse to replace anything that is not a regular file.
 *
 * An atomic write ends in `rename(temp, target)`, and rename does not care what
 * the target is: pointed at a FIFO it DESTROYS the named pipe and leaves a
 * regular file with the same name, silently breaking whatever process was
 * reading the other end. Sockets and device nodes go the same way. None of them
 * can be written atomically by definition, so the only honest outcomes are to
 * refuse or to destroy, and the refusal names the type so the caller can see
 * what their path actually pointed at. A missing target is not an error.
 */
function assertRegularFileTarget(stats: Stats, target: string): void {
	if (stats.isFile()) return;
	const kind = stats.isDirectory()
		? "a directory"
		: stats.isFIFO()
			? "a named pipe (FIFO)"
			: stats.isSocket()
				? "a socket"
				: stats.isBlockDevice() || stats.isCharacterDevice()
					? "a device node"
					: "not a regular file";
	throw new Error(
		`Refusing to write ${target}: it is ${kind}, and an atomic write would replace it with a regular file. ` +
			`Point the write at a regular file path instead.`,
	);
}

/**
 * Restate a failure in terms of the file the caller asked to write.
 *
 * The work happens on a temp sibling, so the OS error names that temp:
 * `EACCES: permission denied, open '/src/.index.ts.4711.1.tmp'`. That path never
 * existed as far as the caller is concerned, it changes on every attempt, and it
 * sends people looking for a stray temp file instead of at the read-only
 * directory that actually stopped them. The reason and the failing syscall are
 * kept, the real target is swapped in, and the original travels as `cause` with
 * its `code` copied across so `isNotFound` and any code match keep working.
 */
function withTargetInMessage(error: unknown, target: string, tempPath: string): unknown {
	if (!(error instanceof Error) || !error.message.includes(tempPath)) return error;
	const restated = new Error(
		`${error.message.replaceAll(tempPath, target)} (the write is staged in a temporary file beside the target, ` +
			`so it can replace it atomically; the temporary file is what the operating system named)`,
		{ cause: error },
	);
	const code = (error as NodeJS.ErrnoException).code;
	if (code !== undefined) (restated as NodeJS.ErrnoException).code = code;
	return restated;
}

/**
 * Write `content` to `targetPath` crash-atomically: stream into a sibling temp
 * file, flush it, then rename it over the target. A rename is atomic on POSIX,
 * so a death mid-write (SIGINT, out-of-memory kill, full disk, power loss)
 * leaves the target as either the whole old file or the whole new one, never a
 * truncated mix. A plain `Bun.write`/`writeFile` truncates the target in place
 * and streams into it, so the same interruption corrupts the user's real source
 * file.
 *
 * This is deliberately a small self-contained copy of the temp+rename pattern
 * rather than a dependency on `@veyyon/utils` (which owns the fuller
 * `atomicWriteFile`): hashline is a lean, standalone patch library with only
 * `diff` and `lru-cache` as dependencies, and pulling in the utils package would
 * drag its logging/templating/native transitive deps into every hashline
 * consumer.
 *
 * The two are kept in step by BEHAVIOR, not by import, and that promise is only
 * worth anything because a test checks it: `packages/coding-agent/test/
 * atomic-write-has-one-behavior.test.ts` runs this function and
 * `atomicWriteFilePreservingMode` through the same scenarios and fails when they
 * diverge. Change one, run that suite, change the other.
 *
 * The existing file's permission bits are carried forward, because the rename
 * swaps the inode and a fresh file would otherwise arrive as 0o644 and quietly
 * strip an executable script's `+x`.
 */
export async function writeFileAtomic(targetPath: string, content: string): Promise<void> {
	const { target, viaSymlink } = await resolveAtomicWriteTarget(targetPath);

	let mode = 0o644;
	try {
		mode = (await fs.stat(target)).mode & 0o777;
	} catch (error) {
		if (!isNotFound(error)) throw error;
	}

	const dir = pathModule.dirname(target);
	// Create parents for a regular path. Never for a symlink: a missing target
	// directory there means the link is dangling, and inventing the tree hides it.
	if (!viaSymlink) await fs.mkdir(dir, { recursive: true });

	const tempPath = pathModule.join(dir, `.${pathModule.basename(target)}.${process.pid}.${atomicTempCounter++}.tmp`);
	try {
		// Open with `mode` and flush the same handle that holds write access: on
		// Windows fsync requires write rights, so flushing a reopened read handle
		// is not equivalent. The flush is what protects the CONTENTS against power
		// loss; the rename alone only protects against a truncated file.
		const handle = await fs.open(tempPath, "w", mode);
		try {
			await handle.writeFile(content);
			await handle.sync();
		} finally {
			await handle.close();
		}
	} catch (error) {
		// The WRITE error is what the caller needs and it is rethrown with the paths attached. A failure to
		// remove the temp file could only be surfaced by replacing that error with a less useful one, so it is
		// deliberately dropped; the worst outcome is one leftover `*.tmp` beside the target.
		await fs.rm(tempPath, { force: true }).catch(() => {});
		throw withTargetInMessage(error, target, tempPath);
	}

	try {
		await fs.rename(tempPath, target);
	} catch (error) {
		// Windows cannot rename onto an existing file; drop it and retry so the
		// overwrite still happens (POSIX rename already replaces atomically). Any
		// other failure is real: clean up the temp and report it against the target.
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "EEXIST" || code === "EPERM" || code === "EACCES") {
			try {
				await fs.rm(target, { force: true });
				await fs.rename(tempPath, target);
			} catch (retryError) {
				await fs.rm(tempPath, { force: true }).catch(() => {});
				throw withTargetInMessage(retryError, target, tempPath);
			}
		} else {
			await fs.rm(tempPath, { force: true }).catch(() => {});
			throw withTargetInMessage(error, target, tempPath);
		}
	}

	// Persist the rename itself by flushing the directory entry. Some platforms
	// refuse to open a directory for fsync; the rename stands there regardless.
	try {
		const dirHandle = await fs.open(dir, "r");
		try {
			await dirHandle.sync();
		} finally {
			await dirHandle.close();
		}
	} catch {
		// Directory fsync unsupported on this platform.
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
	 * Whether `a` and `b` name the SAME underlying file. Used by the patcher's
	 * move guard to tell a real move-onto-a-different-file (which would clobber
	 * the user's destination and must be refused) from a rename that only changes
	 * the path's spelling of one file (a case-only rename, or a path routed
	 * through a symlink), which is legitimate and must be allowed.
	 *
	 * The default compares {@link canonicalPath}s, which is exactly right for a
	 * case-sensitive backend (in-memory, S3, a Git tree): two distinct keys are
	 * two distinct files, so a move between them is a real clobber. A disk backend
	 * on a case-insensitive volume, or one that follows symlinks, must override
	 * this to compare by identity (device + inode) so `README.md` and `readme.md`
	 * on such a volume are recognised as one file. See {@link NodeFilesystem}.
	 */
	async isSameExistingFile(a: string, b: string): Promise<boolean> {
		return this.canonicalPath(a) === this.canonicalPath(b);
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

	/**
	 * Compare by device + inode, not by path string, so the move guard treats a
	 * case-only rename on a case-insensitive volume and a symlinked path as the
	 * one file they really are (and thus a legitimate rename, not a clobber). This
	 * is the same identity test {@link move} uses to decide whether deleting the
	 * source after a content-move would destroy the destination, so both stay in
	 * agreement about what "the same file" means. `canonicalPath` alone cannot do
	 * this: {@link pathModule.resolve} folds neither case nor symlinks.
	 */
	override async isSameExistingFile(a: string, b: string): Promise<boolean> {
		return sameExistingFile(a, b);
	}
}
