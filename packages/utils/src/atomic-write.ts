/**
 * Crash-safe file writes.
 *
 * A plain `writeFile` (or `Bun.write`) truncates the target and then streams the
 * new bytes in. If the process dies between those two steps (a self-update that
 * replaces the binary, a `SIGINT`, a full disk, a power loss) the file is left
 * truncated or empty. For a config file that holds every profile and setting,
 * that is silent data loss.
 *
 * {@link atomicWriteFile} avoids it the standard way: write the new bytes to a
 * unique temp file in the same directory, flush them to disk, then `rename` the
 * temp over the target. `rename` within one filesystem is atomic, so a reader or
 * a crash sees either the whole old file or the whole new file, never a partial
 * one.
 *
 * This is the single home for atomic writes. Do not hand-roll temp-file +
 * rename at a call site; import this instead.
 *
 * @example
 * ```ts
 * import { atomicWriteFile } from "@veyyon/utils";
 *
 * await atomicWriteFile(configPath, YAML.stringify(config));
 * ```
 */

import * as fs from "node:fs/promises";
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
		if ((await fs.lstat(filePath)).isSymbolicLink()) {
			target = path.resolve(path.dirname(filePath), await fs.readlink(filePath));
			viaSymlink = true;
		}
	} catch (error) {
		// ENOENT is the normal first-write case (the path does not exist yet).
		if (!isEnoent(error)) throw error;
	}

	const dir = path.dirname(target);
	// Create parents for a regular path (a convenience). Never fabricate the
	// target directory of a symlink: a missing one means the link is dangling.
	if (!viaSymlink) await fs.mkdir(dir, { recursive: true });

	tempCounter = (tempCounter + 1) >>> 0;
	const tmpPath = path.join(dir, `.${path.basename(target)}.${process.pid}.${tempCounter}.tmp`);

	let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
	try {
		handle = await fs.open(tmpPath, "w", mode);
		await handle.writeFile(data);
		if (fsync) await handle.sync();
	} catch (error) {
		await handle?.close().catch(() => {});
		await fs.rm(tmpPath, { force: true }).catch(() => {});
		throw error;
	}
	await handle.close();

	try {
		await fs.rename(tmpPath, target);
	} catch (error) {
		// Windows can reject renaming over an existing file (EPERM/EEXIST/EACCES).
		// Remove the target and retry rather than fall back to a non-atomic copy.
		if (isFsError(error) && (error.code === "EPERM" || error.code === "EEXIST" || error.code === "EACCES")) {
			await fs.rm(target, { force: true });
			await fs.rename(tmpPath, target);
		} else {
			await fs.rm(tmpPath, { force: true }).catch(() => {});
			throw error;
		}
	}

	if (fsync) {
		// Persist the rename itself by flushing the directory entry. Some
		// platforms (notably Windows) do not allow opening a directory for
		// fsync; the rename is still durable enough there, so ignore the failure.
		try {
			const dirHandle = await fs.open(dir, "r");
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
