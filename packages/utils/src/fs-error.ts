/**
 * Type-safe filesystem error handling utilities.
 *
 * Use these to check error codes without string matching on messages:
 *
 * @example
 * ```ts
 * import { isEnoent, isFsError } from "@veyyon/utils";
 *
 * try {
 *     return await Bun.file(path).text();
 * } catch (err) {
 *     if (isEnoent(err)) return null;
 *     throw err;
 * }
 * ```
 */

export interface FsError extends Error {
	code: string;
	errno?: number;
	syscall?: string;
	path?: string;
}

export function isFsError(err: unknown): err is FsError {
	return err instanceof Error && "code" in err && typeof (err as FsError).code === "string";
}

export function isEnoent(err: unknown): err is FsError {
	return isFsError(err) && err.code === "ENOENT";
}

/**
 * Build an `ENOENT` filesystem error for a path, shaped like the Node
 * `ErrnoException` a real `fs` call throws (`code`, `errno`, `syscall`, `path`),
 * so a synthetic "no such file" reads identically to a native one at the
 * boundary and passes {@link isEnoent}. Storage backends use this when a
 * requested session/blob is absent.
 */
export function enoentError(path: string): FsError {
	const err = new Error(`ENOENT: no such file, '${path}'`) as FsError;
	err.code = "ENOENT";
	err.errno = -2;
	err.syscall = "open";
	err.path = path;
	return err;
}

export function isEacces(err: unknown): err is FsError {
	return isFsError(err) && err.code === "EACCES";
}

export function isEisdir(err: unknown): err is FsError {
	return isFsError(err) && err.code === "EISDIR";
}

export function isEnotdir(err: unknown): err is FsError {
	return isFsError(err) && err.code === "ENOTDIR";
}

/**
 * True when a filesystem error means the path is NOT THERE, as opposed to being
 * there and unusable.
 *
 * `ENOENT` is the obvious case. `ENOTDIR` is the same fact reached differently:
 * a component of the path is not a directory, so nothing can exist below it.
 * Every other code means something IS there and the read failed — `EACCES` (no
 * permission), `EISDIR` (a directory where a file was expected), `ELOOP`,
 * `EIO`, `EMFILE`. Code that probes optional paths must not treat those as
 * absence: that is how a permission error becomes "no config file here" and
 * silently drops a user's configuration with no symptom to chase (Law 10).
 *
 * This is the single owner of that split. It was written out at least six ways —
 * `isEnoent(e) || isEnotdir(e)`, `hasFsCode(e, "ENOENT") || hasFsCode(e,
 * "ENOTDIR")`, a raw `code === "ENOENT" || code === "ENOTDIR"`, one file casting
 * to `NodeJS.ErrnoException` for the second half — under three different local
 * names (`isNotFoundError`, `isMissingDirectoryError`, `isMissingFileError`).
 * Deciding "does absence include EISDIR?" in six places is how they drift.
 */
export function isMissingPath(err: unknown): err is FsError {
	return isEnoent(err) || isEnotdir(err);
}

export function isEexist(err: unknown): err is FsError {
	return isFsError(err) && err.code === "EEXIST";
}

export function isEnotempty(err: unknown): err is FsError {
	return isFsError(err) && err.code === "ENOTEMPTY";
}

export function hasFsCode(err: unknown, code: string): err is FsError {
	return isFsError(err) && err.code === code;
}
