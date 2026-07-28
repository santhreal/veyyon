/**
 * Kernel-backed path publication primitives used by the secret vault.
 *
 * Plain `rename()` overwrites any destination that appears after a userspace check. These
 * wrappers use each platform's atomic no-replace and replacement-with-rollback operations so a
 * racing pathname is either preserved or restored, never silently clobbered.
 */
import { dlopen, FFIType, ptr } from "bun:ffi";

const AT_FDCWD = -100;
const RENAME_NOREPLACE = 1;
const RENAME_EXCHANGE = 2;
const RENAME_SWAP = 0x0000_0002;
const RENAME_EXCL = 0x0000_0004;
const MOVEFILE_WRITE_THROUGH = 0x0000_0008;
const REPLACEFILE_WRITE_THROUGH = 0x0000_0002;

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
				} as const;
				const renameat2 = (() => {
					try {
						return dlopen("libc.so.6", signature).symbols.renameat2;
					} catch {
						return dlopen("libc.so", signature).symbols.renameat2;
					}
				})();
				return (from: string, to: string, flags: number): boolean => {
					const fromBytes = cString(from);
					const toBytes = cString(to);
					return renameat2(AT_FDCWD, ptr(fromBytes), AT_FDCWD, ptr(toBytes), flags) === 0;
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
				});
				return (from: string, to: string, flags: number): boolean => {
					const fromBytes = cString(from);
					const toBytes = cString(to);
					return library.symbols.renamex_np(ptr(fromBytes), ptr(toBytes), flags) === 0;
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
				});
				return {
					moveNoReplace(from: string, to: string): boolean {
						const fromBytes = wideString(from);
						const toBytes = wideString(to);
						return library.symbols.MoveFileExW(ptr(fromBytes), ptr(toBytes), MOVEFILE_WRITE_THROUGH) !== 0;
					},
					replace(to: string, from: string, backup: string): boolean {
						const toBytes = wideString(to);
						const fromBytes = wideString(from);
						const backupBytes = wideString(backup);
						return (
							library.symbols.ReplaceFileW(
								ptr(toBytes),
								ptr(fromBytes),
								ptr(backupBytes),
								REPLACEFILE_WRITE_THROUGH,
								null,
								null,
							) !== 0
						);
					},
				};
			})()
		: undefined;

/** Move `stagedPath` into an absent destination without overwriting a racing entry. */
export function moveNoReplace(stagedPath: string, destinationPath: string): boolean {
	if (linuxRename !== undefined) return linuxRename(stagedPath, destinationPath, RENAME_NOREPLACE);
	if (darwinRename !== undefined) return darwinRename(stagedPath, destinationPath, RENAME_EXCL);
	if (windowsPaths !== undefined) return windowsPaths.moveNoReplace(stagedPath, destinationPath);
	throw new Error("Secure atomic no-replace publication is unavailable on this platform.");
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
		if (!linuxRename(stagedPath, destinationPath, RENAME_EXCHANGE)) {
			throw new Error("The kernel refused the atomic vault exchange.");
		}
		return {
			displacedPath: stagedPath,
			rollback(): void {
				if (!linuxRename(stagedPath, destinationPath, RENAME_EXCHANGE)) {
					throw new Error("The kernel refused to roll back the atomic vault exchange.");
				}
			},
		};
	}
	if (darwinRename !== undefined) {
		if (!darwinRename(stagedPath, destinationPath, RENAME_SWAP)) {
			throw new Error("The kernel refused the atomic vault exchange.");
		}
		return {
			displacedPath: stagedPath,
			rollback(): void {
				if (!darwinRename(stagedPath, destinationPath, RENAME_SWAP)) {
					throw new Error("The kernel refused to roll back the atomic vault exchange.");
				}
			},
		};
	}
	if (windowsPaths !== undefined) {
		if (!windowsPaths.replace(destinationPath, stagedPath, windowsBackupPath)) {
			throw new Error("Windows refused the atomic vault replacement.");
		}
		return {
			displacedPath: windowsBackupPath,
			rollback(): void {
				if (!windowsPaths.replace(destinationPath, windowsBackupPath, stagedPath)) {
					throw new Error("Windows refused to roll back the atomic vault replacement.");
				}
			},
		};
	}
	throw new Error("Secure atomic replacement is unavailable on this platform.");
}
