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

export function isEexist(err: unknown): err is FsError {
	return isFsError(err) && err.code === "EEXIST";
}

export function isEnotempty(err: unknown): err is FsError {
	return isFsError(err) && err.code === "ENOTEMPTY";
}

export function hasFsCode(err: unknown, code: string): err is FsError {
	return isFsError(err) && err.code === code;
}
