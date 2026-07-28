/**
 * Kernel-backed path publication primitives used by the secret vault.
 *
 * Plain `rename()` overwrites any destination that appears after a userspace check. These
 * wrappers use each platform's atomic no-replace and replacement-with-rollback operations so a
 * racing pathname is either preserved or restored, never silently clobbered.
 */
import { dlopen, FFIType, type Pointer, ptr, read } from "bun:ffi";

const AT_FDCWD = -100;
const RENAME_NOREPLACE = 1;
const RENAME_EXCHANGE = 2;
const RENAME_SWAP = 0x0000_0002;
const RENAME_EXCL = 0x0000_0004;
const MOVEFILE_WRITE_THROUGH = 0x0000_0008;
const REPLACEFILE_WRITE_THROUGH = 0x0000_0002;
const POSIX_EEXIST = 17;
const WINDOWS_ERROR_FILE_EXISTS = 80;
const WINDOWS_ERROR_ALREADY_EXISTS = 183;

type AtomicCallResult = { readonly ok: true } | { readonly ok: false; readonly error: number };

function atomicFailure(operation: string, error: number): Error {
	return new Error(`${operation} failed with operating-system error ${error}.`);
}

/**
 * Read `errno` from the pointer libc hands back, refusing rather than guessing when there is none.
 *
 * `__errno_location` and `__error` are typed `Pointer | null`, and the null case cannot be papered
 * over with a cast or a `?? 0`. This number is not just a message: {@link publishWithoutReplacing}
 * compares it against `EEXIST` to tell "the destination already existed", which is the SAFE outcome
 * this module exists to produce, from a genuine failure. A fabricated `0` reads as neither, so the
 * caller would throw "failed with operating-system error 0" over a race it was supposed to handle.
 * A null location means the libc handle is unusable and the failure cannot be classified at all, so
 * that is what gets reported (Law 10: no silent fallback).
 */
function readErrno(location: Pointer | null, symbol: string): number {
	if (location === null) {
		throw new Error(
			`Secure atomic path publication could not read errno: ${symbol}() returned no location, so the failure cannot be classified.`,
		);
	}
	return read.i32(location);
}

function cString(value: string): Buffer {
	return Buffer.from(`${value}\0`, "utf8");
}

function wideString(value: string): Buffer {
	return Buffer.from(`${value}\0`, "utf16le");
}

const linuxRename =
	process.platform === "linux"
		? (() => {
				const signature = {
					renameat2: {
						args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32],
						returns: FFIType.i32,
					},
					__errno_location: {
						args: [],
						returns: FFIType.ptr,
					},
				} as const;
				const library = (() => {
					try {
						return dlopen("libc.so.6", signature);
					} catch {
						return dlopen("libc.so", signature);
					}
				})();
				return (from: string, to: string, flags: number): AtomicCallResult => {
					const fromBytes = cString(from);
					const toBytes = cString(to);
					if (library.symbols.renameat2(AT_FDCWD, ptr(fromBytes), AT_FDCWD, ptr(toBytes), flags) === 0) {
						return { ok: true };
					}
					return { ok: false, error: readErrno(library.symbols.__errno_location(), "__errno_location") };
				};
			})()
		: undefined;

const darwinRename =
	process.platform === "darwin"
		? (() => {
				const library = dlopen("/usr/lib/libSystem.B.dylib", {
					renamex_np: {
						args: [FFIType.ptr, FFIType.ptr, FFIType.u32],
						returns: FFIType.i32,
					},
					__error: {
						args: [],
						returns: FFIType.ptr,
					},
				});
				return (from: string, to: string, flags: number): AtomicCallResult => {
					const fromBytes = cString(from);
					const toBytes = cString(to);
					if (library.symbols.renamex_np(ptr(fromBytes), ptr(toBytes), flags) === 0) return { ok: true };
					return { ok: false, error: readErrno(library.symbols.__error(), "__error") };
				};
			})()
		: undefined;

const windowsPaths =
	process.platform === "win32"
		? (() => {
				const library = dlopen("kernel32.dll", {
					MoveFileExW: {
						args: [FFIType.ptr, FFIType.ptr, FFIType.u32],
						returns: FFIType.i32,
					},
					ReplaceFileW: {
						args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr],
						returns: FFIType.i32,
					},
					GetLastError: {
						args: [],
						returns: FFIType.u32,
					},
				});
				return {
					moveNoReplace(from: string, to: string): AtomicCallResult {
						const fromBytes = wideString(from);
						const toBytes = wideString(to);
						if (library.symbols.MoveFileExW(ptr(fromBytes), ptr(toBytes), MOVEFILE_WRITE_THROUGH) !== 0) {
							return { ok: true };
						}
						return { ok: false, error: library.symbols.GetLastError() };
					},
					replace(to: string, from: string, backup: string): AtomicCallResult {
						const toBytes = wideString(to);
						const fromBytes = wideString(from);
						const backupBytes = wideString(backup);
						if (
							library.symbols.ReplaceFileW(
								ptr(toBytes),
								ptr(fromBytes),
								ptr(backupBytes),
								REPLACEFILE_WRITE_THROUGH,
								null,
								null,
							) !== 0
						) {
							return { ok: true };
						}
						return { ok: false, error: library.symbols.GetLastError() };
					},
				};
			})()
		: undefined;

/** Move `stagedPath` into an absent destination without overwriting a racing entry. */
export function moveNoReplace(stagedPath: string, destinationPath: string): boolean {
	const result =
		linuxRename !== undefined
			? linuxRename(stagedPath, destinationPath, RENAME_NOREPLACE)
			: darwinRename !== undefined
				? darwinRename(stagedPath, destinationPath, RENAME_EXCL)
				: windowsPaths !== undefined
					? windowsPaths.moveNoReplace(stagedPath, destinationPath)
					: undefined;
	if (result === undefined) {
		throw new Error("Secure atomic no-replace publication is unavailable on this platform.");
	}
	if (result.ok) return true;
	const destinationExists =
		(linuxRename !== undefined || darwinRename !== undefined) && result.error === POSIX_EEXIST
			? true
			: windowsPaths !== undefined &&
				(result.error === WINDOWS_ERROR_FILE_EXISTS || result.error === WINDOWS_ERROR_ALREADY_EXISTS);
	if (destinationExists) {
		return false;
	}
	throw atomicFailure("Secure atomic no-replace publication", result.error);
}

export interface AtomicReplacement {
	/** Path containing the destination inode displaced by the atomic operation. */
	readonly displacedPath: string;
	/** Restore the displaced inode to the destination without an overwrite window. */
	rollback(): void;
}

/** Replace an existing destination atomically while retaining an atomic rollback path. */
export function replaceWithRollback(
	stagedPath: string,
	destinationPath: string,
	windowsBackupPath: string,
): AtomicReplacement {
	if (linuxRename !== undefined) {
		const replacement = linuxRename(stagedPath, destinationPath, RENAME_EXCHANGE);
		if (!replacement.ok) {
			throw atomicFailure("The atomic vault exchange", replacement.error);
		}
		return {
			displacedPath: stagedPath,
			rollback(): void {
				const rollback = linuxRename(stagedPath, destinationPath, RENAME_EXCHANGE);
				if (!rollback.ok) {
					throw atomicFailure("The atomic vault exchange rollback", rollback.error);
				}
			},
		};
	}
	if (darwinRename !== undefined) {
		const replacement = darwinRename(stagedPath, destinationPath, RENAME_SWAP);
		if (!replacement.ok) {
			throw atomicFailure("The atomic vault exchange", replacement.error);
		}
		return {
			displacedPath: stagedPath,
			rollback(): void {
				const rollback = darwinRename(stagedPath, destinationPath, RENAME_SWAP);
				if (!rollback.ok) {
					throw atomicFailure("The atomic vault exchange rollback", rollback.error);
				}
			},
		};
	}
	if (windowsPaths !== undefined) {
		const replacement = windowsPaths.replace(destinationPath, stagedPath, windowsBackupPath);
		if (!replacement.ok) {
			throw atomicFailure("The Windows atomic vault replacement", replacement.error);
		}
		return {
			displacedPath: windowsBackupPath,
			rollback(): void {
				const rollback = windowsPaths.replace(destinationPath, windowsBackupPath, stagedPath);
				if (!rollback.ok) {
					throw atomicFailure("The Windows atomic vault replacement rollback", rollback.error);
				}
			},
		};
	}
	throw new Error("Secure atomic replacement is unavailable on this platform.");
}
