import { dlopen, FFIType } from "bun:ffi";
import * as fs from "node:fs";
import * as path from "node:path";
import { getLogPath } from "./dirs";

const STDOUT_FILENO = 1;
const STDERR_FILENO = 2;

interface LibcFdOps {
	dup(fd: number): number;
	dup2(oldFd: number, newFd: number): number;
}

let libcFdOpsCache: LibcFdOps | null | undefined;

function libcFdOps(): LibcFdOps | null {
	if (libcFdOpsCache !== undefined) return libcFdOpsCache;
	libcFdOpsCache = null;
	if (process.platform === "win32") return null;
	const candidates =
		process.platform === "darwin" ? ["libSystem.B.dylib", "/usr/lib/libSystem.B.dylib"] : ["libc.so.6", "libc.so"];
	for (const candidate of candidates) {
		try {
			const libc = dlopen(candidate, {
				dup: { args: [FFIType.i32], returns: FFIType.i32 },
				dup2: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
			});
			libcFdOpsCache = libc.symbols;
			return libcFdOpsCache;
		} catch {}
	}
	return libcFdOpsCache;
}

function stderrSharesStdoutTerminal(): boolean {
	if (!process.stdout.isTTY || !process.stderr.isTTY) return false;
	try {
		const stdoutStat = fs.fstatSync(STDOUT_FILENO);
		const stderrStat = fs.fstatSync(STDERR_FILENO);
		return stdoutStat.dev === stderrStat.dev && stdoutStat.ino === stderrStat.ino;
	} catch {
		return false;
	}
}

let savedStderrFd: number | null = null;

export interface SuppressTerminalStderrOptions {
	redirectPath?: string;
	force?: boolean;
}

export function suppressTerminalStderr(options?: SuppressTerminalStderrOptions): boolean {
	if (savedStderrFd !== null) return true;
	if (!options?.force && (process.platform !== "darwin" || !stderrSharesStdoutTerminal())) {
		return false;
	}
	const libc = libcFdOps();
	if (!libc) return false;

	let redirectFd: number;
	try {
		const redirectPath = options?.redirectPath ?? getLogPath();
		fs.mkdirSync(path.dirname(redirectPath), { recursive: true });
		redirectFd = fs.openSync(redirectPath, "a");
	} catch {
		try {
			redirectFd = fs.openSync("/dev/null", "w");
		} catch {
			return false;
		}
	}

	const saved = libc.dup(STDERR_FILENO);
	if (saved === -1) {
		fs.closeSync(redirectFd);
		return false;
	}
	if (libc.dup2(redirectFd, STDERR_FILENO) === -1) {
		fs.closeSync(redirectFd);
		fs.closeSync(saved);
		return false;
	}
	fs.closeSync(redirectFd);
	savedStderrFd = saved;
	return true;
}

export function restoreTerminalStderr(): void {
	if (savedStderrFd === null) return;
	const saved = savedStderrFd;
	savedStderrFd = null;
	libcFdOps()?.dup2(saved, STDERR_FILENO);
	try {
		fs.closeSync(saved);
	} catch {}
}

export function isTerminalStderrSuppressed(): boolean {
	return savedStderrFd !== null;
}
