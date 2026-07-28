/**
 * Crash-safe file writes.
 *
 * A plain `writeFile` (or `Bun.write`) truncates the target and then streams the
 * new bytes in. If the process dies between those two steps (a self-update that
 * replaces the binary, a `SIGINT`, a full disk, a power loss) the file is left
 * truncated or empty. For a config file that holds every profile and setting,
 * that is silent data loss.
 *
 * {@link atomicWriteFile} (and its blocking twin {@link atomicWriteFileSync})
 * avoid it the standard way: write the new bytes to a unique temp file in the
 * same directory, flush them to disk, then `rename` the temp over the target.
 * `rename` within one filesystem is atomic, so a reader or a crash sees either
 * the whole old file or the whole new file, never a partial one.
 *
 * This is the single home for atomic writes. Do not hand-roll temp-file +
 * rename at a call site; import one of these instead.
 *
 * @example
 * ```ts
 * import { atomicWriteFile } from "@veyyon/utils";
 *
 * await atomicWriteFile(configPath, YAML.stringify(config));
 * ```
 */

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { isEnoent, isFsError } from "./fs-error";

export interface AtomicWriteOptions {
	/**
	 * Permission bits for the created file. Defaults to `0o600` (owner
	 * read/write only) because config files routinely hold tokens. The final
	 * file inherits the temp file's permissions, so this also governs the
	 * replacement even when the previous file was more permissive.
	 */
	mode?: number;
	/**
	 * Flush the file (and its directory entry) to physical storage before
	 * returning. Defaults to `true`. `rename` already prevents a *truncated*
	 * file on a crash; the flush additionally protects the *contents* against
	 * power loss. Set to `false` only for high-churn caches where durability
	 * does not matter and the extra `fsync` cost does.
	 */
	fsync?: boolean;
}

// Monotonic per-process counter gives every in-flight writer a distinct name.
// The temp is then reserved with O_EXCL, so wraparound or debris from a killed
// process cannot make a later writer truncate a file it does not own.
let tempCounter = 0;

function nextTempPath(dir: string, targetBasename: string): string {
	tempCounter = (tempCounter + 1) >>> 0;
	return path.join(dir, `.${targetBasename}.${process.pid}.${tempCounter}.tmp`);
}


function removeTempSync(tmpPath: string): void {
	fs.rmSync(tmpPath, { force: true, recursive: true });
}

async function reserveTempFile(
	dir: string,
	targetBasename: string,
	mode: number,
	target: string,
): Promise<{ handle: fsp.FileHandle; tmpPath: string }> {
	for (;;) {
		const tmpPath = nextTempPath(dir, targetBasename);
		try {
			return { handle: await fsp.open(tmpPath, "wx", mode), tmpPath };
		} catch (error) {
			if (isFsError(error) && error.code === "EEXIST") continue;
			throw withTargetInMessage(error, target, tmpPath);
		}
	}
}

function reserveTempFileSync(
	dir: string,
	targetBasename: string,
	mode: number,
	target: string,
): { fd: number; tmpPath: string } {
	for (;;) {
		const tmpPath = nextTempPath(dir, targetBasename);
		try {
			return { fd: fs.openSync(tmpPath, "wx", mode), tmpPath };
		} catch (error) {
			if (isFsError(error) && error.code === "EEXIST") continue;
			throw withTargetInMessage(error, target, tmpPath);
		}
	}
}

// Windows can reject renaming a temp over an existing file. Never apply this
// destructive compatibility path on POSIX: EACCES/EPERM there describes a real
// permissions failure and removing the destination would turn it into data loss.
function isRenameClobberError(error: unknown): boolean {
	return (
		process.platform === "win32" &&
		isFsError(error) &&
		(error.code === "EPERM" || error.code === "EEXIST" || error.code === "EACCES")
	);
}

// The bytes writer and the path writer share the tricky, drift-prone parts of an
// atomic write — symlink resolution, the rename-clobber fallback, the directory
// fsync. These three helpers are that single home; both public writers call them
// so the behavior can only ever be defined once.

// Follow every basename symlink ourselves instead of using realpath. realpath
// cannot return the resolved prefix of a dangling chain; falling back to a
// single readlink hop would then rename over the next link and destroy it.
async function resolveWriteTarget(filePath: string): Promise<{ target: string; viaSymlink: boolean }> {
	let target = filePath;
	let viaSymlink = false;
	const seen = new Set<string>();

	for (;;) {
		let stats: fs.Stats;
		try {
			stats = await fsp.lstat(target);
		} catch (error) {
			if (!isEnoent(error)) throw error;
			return { target, viaSymlink };
		}
		if (!stats.isSymbolicLink()) {
			assertRegularFileTarget(stats, target);
			return { target, viaSymlink };
		}

		viaSymlink = true;
		const absoluteTarget = path.resolve(target);
		if (seen.has(absoluteTarget)) {
			const error = new Error(`Too many symbolic links while resolving ${filePath}`) as NodeJS.ErrnoException;
			error.code = "ELOOP";
			throw error;
		}
		seen.add(absoluteTarget);
		target = path.resolve(path.dirname(target), await fsp.readlink(target));
	}
}

/**
 * Refuse to replace anything that is not a regular file.
 *
 * An atomic write finishes with `rename(temp, target)`, and rename does not care
 * what the target is: pointed at a FIFO it DESTROYS the named pipe and leaves a
 * regular file with the same name, silently breaking whatever process was
 * reading the other end. The same goes for a socket or a device node. None of
 * these can be written atomically by definition, so the only honest outcomes are
 * to refuse or to destroy, and the refusal names the type so the operator can
 * see what their path actually pointed at.
 *
 * Directories are included: rename would fail there anyway, with an `EISDIR`
 * that says nothing about which path was wrong.
 *
 * A missing target is not an error — creating the file is the normal first write.
 */
function assertRegularFileTarget(stats: fs.Stats, target: string): void {
	if (stats.isFile()) return;
	const kind = stats.isDirectory()
		? "a directory"
		: stats.isSymbolicLink()
			? "a symbolic link"
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

/** Blocking twin of {@link resolveWriteTarget}; see that function for the reasoning. */
function resolveWriteTargetSync(filePath: string): { target: string; viaSymlink: boolean } {
	let target = filePath;
	let viaSymlink = false;
	const seen = new Set<string>();

	for (;;) {
		let stats: fs.Stats;
		try {
			stats = fs.lstatSync(target);
		} catch (error) {
			if (!isEnoent(error)) throw error;
			return { target, viaSymlink };
		}
		if (!stats.isSymbolicLink()) {
			assertRegularFileTarget(stats, target);
			return { target, viaSymlink };
		}

		viaSymlink = true;
		const absoluteTarget = path.resolve(target);
		if (seen.has(absoluteTarget)) {
			const error = new Error(`Too many symbolic links while resolving ${filePath}`) as NodeJS.ErrnoException;
			error.code = "ELOOP";
			throw error;
		}
		seen.add(absoluteTarget);
		target = path.resolve(path.dirname(target), fs.readlinkSync(target));
	}
}

/**
 * Restate a failure in terms of the file the caller asked to write.
 *
 * An atomic write does its work on a temp sibling, so the OS error names that
 * temp: `EACCES: permission denied, open '/etc/veyyon/.config.yml.4711.1.tmp'`.
 * That path never existed as far as the operator is concerned, it changes on
 * every attempt, and it sends people looking for a stray temp file instead of at
 * the read-only directory that actually stopped them. The rewrite keeps the OS
 * reason and the failing syscall, swaps in the real target, and says why a temp
 * was involved at all.
 *
 * `code` is copied onto the new error and the original travels as `cause`, so
 * `isEnoent`, `isFsError` and any caller matching on a code keep working.
 *
 * Only a message that quotes THE TEMP PATH is rewritten. An error naming the
 * target already reads correctly and is passed through untouched.
 */
function withTargetInMessage(error: unknown, target: string, tmpPath: string): unknown {
	if (!(error instanceof Error) || !error.message.includes(tmpPath)) return error;
	const restated = new Error(
		`${error.message.replaceAll(tmpPath, target)} (the write is staged in a temporary file beside the target, ` +
			`so it can replace it atomically; the temporary file is what the operating system named)`,
		{ cause: error },
	);
	const code = (error as NodeJS.ErrnoException).code;
	if (code !== undefined) (restated as NodeJS.ErrnoException).code = code;
	return restated;
}

async function assertReplaceableTarget(target: string): Promise<void> {
	try {
		assertRegularFileTarget(await fsp.lstat(target), target);
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
}

function assertReplaceableTargetSync(target: string): void {
	try {
		assertRegularFileTarget(fs.lstatSync(target), target);
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
}

async function renameTempOverTarget(tmpPath: string, target: string): Promise<void> {
	try {
		await fsp.rename(tmpPath, target);
		return;
	} catch (error) {
		if (!isRenameClobberError(error)) throw error;
	}

	// Windows lacks a consistently atomic replace-existing rename. Preserve the
	// displaced inode under an owned sibling until the replacement succeeds, so
	// a failed second rename can restore the caller's original bytes.
	await assertReplaceableTarget(target);
	const backupPath = nextTempPath(path.dirname(target), `${path.basename(target)}.previous`);
	try {
		await fsp.rename(target, backupPath);
	} catch (error) {
		if (!isEnoent(error)) throw error;
		// Another writer removed the target after our failed clobber attempt.
		await fsp.rename(tmpPath, target);
		return;
	}
	try {
		await fsp.rename(tmpPath, target);
	} catch (replacementError) {
		try {
			await fsp.rename(backupPath, target);
		} catch (restoreError) {
			throw new AggregateError(
				[replacementError, restoreError],
				`Failed to replace ${target}, then failed to restore its previous contents`,
			);
		}
		throw replacementError;
	}
	await fsp.rm(backupPath, { force: true, recursive: true });
}

const DIRECTORY_FSYNC_UNSUPPORTED: Readonly<Record<string, true>> = {
	EINVAL: true,
	EISDIR: true,
	ENOSYS: true,
	ENOTSUP: true,
};

function isDirectoryFsyncUnsupported(error: unknown): boolean {
	if (!isFsError(error) || error.code === undefined) return false;
	if (DIRECTORY_FSYNC_UNSUPPORTED[error.code]) return true;
	// Windows refuses directory handles with either access code depending on
	// filesystem and Node version. On POSIX those codes are real failures.
	return process.platform === "win32" && (error.code === "EACCES" || error.code === "EPERM");
}

async function fsyncDirEntry(dir: string): Promise<void> {
	let dirHandle: fsp.FileHandle;
	try {
		dirHandle = await fsp.open(dir, "r");
	} catch (error) {
		if (isDirectoryFsyncUnsupported(error)) return;
		throw error;
	}

	let syncError: unknown;
	try {
		await dirHandle.sync();
	} catch (error) {
		if (!isDirectoryFsyncUnsupported(error)) syncError = error;
	}
	try {
		await dirHandle.close();
	} catch (error) {
		// A failed durability operation is the primary diagnosis; a close failure
		// must not replace it. If sync succeeded, the close failure still matters.
		if (syncError === undefined) syncError = error;
	}
	if (syncError !== undefined) throw syncError;
}

/**
 * Write `data` to `filePath` atomically. Creates parent directories as needed.
 * Either fully succeeds (the target now holds `data`) or throws with the target
 * left untouched.
 */
export async function atomicWriteFile(
	filePath: string,
	data: string | NodeJS.ArrayBufferView,
	options: AtomicWriteOptions = {},
): Promise<void> {
	const { mode = 0o600, fsync = true } = options;
	await atomicWriteBytes(filePath, data, mode, fsync, false);
}

async function atomicWriteBytes(
	filePath: string,
	data: string | NodeJS.ArrayBufferView,
	mode: number,
	fsync: boolean,
	preserveModeExactly: boolean,
): Promise<void> {
	await atomicWriteFileWithImpl(
		filePath,
		{
			kind: "handle",
			write: async handle => {
				await handle.writeFile(data);
				if (preserveModeExactly) await handle.chmod(mode);
				if (fsync) await handle.sync();
			},
		},
		{ fsync, mode },
	);
}

/**
 * Atomic write that carries the target's CURRENT permission bits forward.
 *
 * {@link atomicWriteFile} replaces the file by renaming a fresh temp over it, so
 * the result takes the temp's mode — `0o600` by default. That is right for a
 * secret-bearing config file, but wrong when you are rewriting a file whose mode
 * matters: an executable script would silently lose its `+x`, a group-readable
 * file its group bit. Use this when you are overwriting an existing file and must
 * not change how it is permissioned — source files an editor rewrites, a move
 * that overwrites a destination, any content update to a pre-existing path.
 *
 * The current mode is read with `stat` (which follows a symlink to the file that
 * will actually be replaced), so a symlinked path preserves its target's mode. A
 * path that does not exist yet is created with `defaultMode` (0o644 — a normal,
 * non-secret file default), still subject to the process umask at creation.
 */
export async function atomicWriteFilePreservingMode(
	filePath: string,
	data: string | NodeJS.ArrayBufferView,
	options: { fsync?: boolean; defaultMode?: number } = {},
): Promise<void> {
	const { fsync = true, defaultMode = 0o644 } = options;
	let mode = defaultMode;
	let existed = true;
	try {
		mode = (await fsp.stat(filePath)).mode & 0o7777;
	} catch (error) {
		if (!isEnoent(error)) throw error;
		existed = false;
	}
	await atomicWriteBytes(filePath, data, mode, fsync, existed);
}

/**
 * Serialize `data` as pretty-printed JSON (2-space indent, trailing newline)
 * and write it to `filePath` atomically via {@link atomicWriteFile}. The
 * trailing newline keeps the file POSIX-clean and diff-friendly. Use this for
 * any on-disk JSON registry or config so every writer produces byte-identical
 * formatting instead of each caller hand-rolling `JSON.stringify(...) + "\n"`.
 */
export async function atomicWriteJson(
	filePath: string,
	data: unknown,
	options: AtomicWriteOptions = {},
): Promise<void> {
	await atomicWriteFile(filePath, `${JSON.stringify(data, null, 2)}\n`, options);
}

/**
 * The producer form of {@link atomicWriteFile}: instead of handing over bytes,
 * you get the temp path and write to it however you like (a streaming writer, a
 * third-party encoder that only takes a path). The same crash-safety holds — the
 * temp is renamed over the target only after `write` resolves, so a failure
 * leaves the target untouched — and the same symlink handling applies.
 *
 * Use this only when the payload is produced by something that writes to a path
 * rather than returning bytes. When you already have the bytes, call
 * {@link atomicWriteFile}; it routes through here.
 *
 * @example
 * ```ts
 * await atomicWriteFileWith(archivePath, tmpPath => writeArchive(tmpPath, format, entries));
 * ```
 */
export async function atomicWriteFileWith(
	filePath: string,
	write: (tempPath: string) => Promise<void>,
	options: AtomicWriteOptions & {
		/**
		 * Reopen the finished temp file and fsync it before the rename. Defaults
		 * to `true`, which is what a path writer needs: it closes its own fd, so
		 * the owner must flush the bytes. {@link atomicWriteFile} passes `false`
		 * because it already fsyncs its own write handle (the Windows-correct way).
		 */
		fsyncTempFile?: boolean;
	} = {},
): Promise<void> {
	await atomicWriteFileWithImpl(filePath, { kind: "path", write }, options);
}

type AtomicTempWriter =
	| { kind: "handle"; write: (handle: fsp.FileHandle) => Promise<void> }
	| { kind: "path"; write: (tempPath: string) => Promise<void> };

interface AtomicWriteInternalOptions extends AtomicWriteOptions {
	fsyncTempFile?: boolean;
}

async function atomicWriteFileWithImpl(
	filePath: string,
	writer: AtomicTempWriter,
	options: AtomicWriteInternalOptions,
): Promise<void> {
	const { fsync = true, fsyncTempFile = true, mode = 0o600 } = options;
	const { target, viaSymlink } = await resolveWriteTarget(filePath);
	const dir = path.dirname(target);
	if (!viaSymlink) await fsp.mkdir(dir, { recursive: true });

	const reserved = await reserveTempFile(dir, path.basename(target), mode, target);
	const { tmpPath } = reserved;
	try {
		if (writer.kind === "handle") {
			let operationError: unknown;
			try {
				await writer.write(reserved.handle);
			} catch (error) {
				operationError = error;
			}
			try {
				await reserved.handle.close();
			} catch (error) {
				if (operationError === undefined) operationError = error;
			}
			if (operationError !== undefined) throw operationError;
		} else {
			await reserved.handle.close();
			await writer.write(tmpPath);

			// The producer owns only the bytes, never the type or permissions of
			// the staging entry. A directory or link must not become the target.
			assertRegularFileTarget(await fsp.lstat(tmpPath), tmpPath);
			const handle = await fsp.open(tmpPath, "r+");
			let operationError: unknown;
			try {
				const finalMode = process.platform === "win32" ? mode : mode & ~process.umask();
				await handle.chmod(finalMode);
				if (fsync && fsyncTempFile) await handle.sync();
			} catch (error) {
				operationError = error;
			}
			try {
				await handle.close();
			} catch (error) {
				if (operationError === undefined) operationError = error;
			}
			if (operationError !== undefined) throw operationError;
		}

		// Recheck both names after user-controlled work and immediately before
		// rename. This preserves a raced-in special destination and catches a
		// swapped staging entry.
		assertRegularFileTarget(await fsp.lstat(tmpPath), tmpPath);
		await assertReplaceableTarget(target);
		await renameTempOverTarget(tmpPath, target);
	} catch (error) {
		await fsp.rm(tmpPath, { force: true, recursive: true }).catch(() => {});
		throw withTargetInMessage(error, target, tmpPath);
	}
	if (fsync) await fsyncDirEntry(dir);
}

/**
 * Blocking twin of {@link atomicWriteFile} with identical crash-safety and
 * symlink semantics. Use only where the call site cannot be async (for example
 * a synchronous config accessor); prefer the async form everywhere else.
 */
export function atomicWriteFileSync(
	filePath: string,
	data: string | NodeJS.ArrayBufferView,
	options: AtomicWriteOptions = {},
): void {
	const { mode = 0o600, fsync = true } = options;
	const { target, viaSymlink } = resolveWriteTargetSync(filePath);
	const dir = path.dirname(target);
	if (!viaSymlink) fs.mkdirSync(dir, { recursive: true });

	const { fd, tmpPath } = reserveTempFileSync(dir, path.basename(target), mode, target);
	let operationError: unknown;
	try {
		fs.writeFileSync(fd, data);
		if (fsync) fs.fsyncSync(fd);
	} catch (error) {
		operationError = error;
	}
	try {
		fs.closeSync(fd);
	} catch (error) {
		if (operationError === undefined) operationError = error;
	}
	if (operationError !== undefined) {
		try {
			removeTempSync(tmpPath);
		} catch {}
		throw withTargetInMessage(operationError, target, tmpPath);
	}

	try {
		assertRegularFileTarget(fs.lstatSync(tmpPath), tmpPath);
		assertReplaceableTargetSync(target);
		fs.renameSync(tmpPath, target);
	} catch (error) {
		if (isRenameClobberError(error)) {
			assertReplaceableTargetSync(target);
			const backupPath = nextTempPath(dir, `${path.basename(target)}.previous`);
			try {
				fs.renameSync(target, backupPath);
			} catch (backupError) {
				if (!isEnoent(backupError)) throw withTargetInMessage(backupError, target, tmpPath);
				fs.renameSync(tmpPath, target);
				if (fsync) fsyncDirEntrySync(dir);
				return;
			}
			try {
				fs.renameSync(tmpPath, target);
			} catch (renameError) {
				try {
					fs.renameSync(backupPath, target);
				} catch (restoreError) {
					throw new AggregateError(
						[renameError, restoreError],
						`Failed to replace ${target}, then failed to restore its previous contents`,
					);
				}
				try {
					removeTempSync(tmpPath);
				} catch {}
				throw withTargetInMessage(renameError, target, tmpPath);
			}
			try {
				removeTempSync(backupPath);
			} catch (cleanupError) {
				throw withTargetInMessage(cleanupError, target, backupPath);
			}
		} else {
			try {
				removeTempSync(tmpPath);
			} catch {}
			throw withTargetInMessage(error, target, tmpPath);
		}
	}

	if (fsync) fsyncDirEntrySync(dir);
}

function fsyncDirEntrySync(dir: string): void {
	let dirFd: number;
	try {
		dirFd = fs.openSync(dir, "r");
	} catch (error) {
		if (isDirectoryFsyncUnsupported(error)) return;
		throw error;
	}

	let syncError: unknown;
	try {
		fs.fsyncSync(dirFd);
	} catch (error) {
		if (!isDirectoryFsyncUnsupported(error)) syncError = error;
	}
	try {
		fs.closeSync(dirFd);
	} catch (error) {
		if (syncError === undefined) syncError = error;
	}
	if (syncError !== undefined) throw syncError;
}
