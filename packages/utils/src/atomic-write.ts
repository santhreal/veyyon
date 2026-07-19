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

// Monotonic per-process counter so two concurrent atomic writes to the same
// path never pick the same temp name and clobber each other's temp file. A
// fixed `${path}.tmp` suffix (the pattern several call sites used) races.
let tempCounter = 0;

function nextTempPath(dir: string, targetBasename: string): string {
	tempCounter = (tempCounter + 1) >>> 0;
	return path.join(dir, `.${targetBasename}.${process.pid}.${tempCounter}.tmp`);
}

// Windows can reject renaming a temp over an existing file. These codes mean
// "remove the destination and retry the rename", never "fall back to a
// non-atomic copy".
function isRenameClobberError(error: unknown): boolean {
	return isFsError(error) && (error.code === "EPERM" || error.code === "EEXIST" || error.code === "EACCES");
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

	// If the caller's path is a symlink (a dotfile manager pointing config.yml
	// into a synced repo), replace the file it *points to* so the link survives.
	// Renaming a temp over the link name would silently turn the link into a
	// regular file and detach it from the repo. A dangling link resolves to a
	// missing directory below and fails loudly, which is correct: a broken link
	// is a real error to surface, not something to paper over by creating dirs.
	let target = filePath;
	let viaSymlink = false;
	try {
		if ((await fsp.lstat(filePath)).isSymbolicLink()) {
			target = path.resolve(path.dirname(filePath), await fsp.readlink(filePath));
			viaSymlink = true;
		}
	} catch (error) {
		// ENOENT is the normal first-write case (the path does not exist yet).
		if (!isEnoent(error)) throw error;
	}

	const dir = path.dirname(target);
	// Create parents for a regular path (a convenience). Never fabricate the
	// target directory of a symlink: a missing one means the link is dangling.
	if (!viaSymlink) await fsp.mkdir(dir, { recursive: true });

	const tmpPath = nextTempPath(dir, path.basename(target));

	let handle: fsp.FileHandle | undefined;
	try {
		handle = await fsp.open(tmpPath, "w", mode);
		await handle.writeFile(data);
		if (fsync) await handle.sync();
	} catch (error) {
		await handle?.close().catch(() => {});
		await fsp.rm(tmpPath, { force: true }).catch(() => {});
		throw error;
	}
	await handle.close();

	try {
		await fsp.rename(tmpPath, target);
	} catch (error) {
		if (isRenameClobberError(error)) {
			await fsp.rm(target, { force: true });
			await fsp.rename(tmpPath, target);
		} else {
			await fsp.rm(tmpPath, { force: true }).catch(() => {});
			throw error;
		}
	}

	if (fsync) {
		// Persist the rename itself by flushing the directory entry. Some
		// platforms (notably Windows) do not allow opening a directory for
		// fsync; the rename is still durable enough there, so ignore the failure.
		try {
			const dirHandle = await fsp.open(dir, "r");
			try {
				await dirHandle.sync();
			} finally {
				await dirHandle.close();
			}
		} catch {
			// Directory fsync unsupported on this platform; the rename stands.
		}
	}
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

	let target = filePath;
	let viaSymlink = false;
	try {
		if (fs.lstatSync(filePath).isSymbolicLink()) {
			target = path.resolve(path.dirname(filePath), fs.readlinkSync(filePath));
			viaSymlink = true;
		}
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}

	const dir = path.dirname(target);
	if (!viaSymlink) fs.mkdirSync(dir, { recursive: true });

	const tmpPath = nextTempPath(dir, path.basename(target));

	let fd: number | undefined;
	try {
		fd = fs.openSync(tmpPath, "w", mode);
		fs.writeFileSync(fd, data);
		if (fsync) fs.fsyncSync(fd);
	} catch (error) {
		if (fd !== undefined) {
			try {
				fs.closeSync(fd);
			} catch {
				// already closed / invalid fd
			}
		}
		try {
			fs.rmSync(tmpPath, { force: true });
		} catch {
			// temp never created
		}
		throw error;
	}
	fs.closeSync(fd);

	try {
		fs.renameSync(tmpPath, target);
	} catch (error) {
		if (isRenameClobberError(error)) {
			fs.rmSync(target, { force: true });
			fs.renameSync(tmpPath, target);
		} else {
			try {
				fs.rmSync(tmpPath, { force: true });
			} catch {
				// best effort
			}
			throw error;
		}
	}

	if (fsync) {
		try {
			const dirFd = fs.openSync(dir, "r");
			try {
				fs.fsyncSync(dirFd);
			} finally {
				fs.closeSync(dirFd);
			}
		} catch {
			// Directory fsync unsupported on this platform; the rename stands.
		}
	}
}
