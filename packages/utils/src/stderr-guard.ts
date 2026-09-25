/**
 * Terminal output guard: keeps every write the renderer did not make off the
 * terminal while a TUI owns the viewport.
 *
 * The renderer tracks which rows it painted. Any other byte that reaches the
 * terminal moves the cursor behind its back, so the next frame paints against
 * rows that shifted: the composer is pushed down and old frames are left in
 * scrollback. Three paths put such bytes there, and each needs its own redirect:
 *
 * - Native writes to the process's stderr: Rust `eprintln!` in the addon (the
 *   shell minimizer reporting a malformed user filter), macOS libmalloc
 *   diagnostics, Bun runtime warnings. POSIX redirects fd 2 with dup/dup2;
 *   Windows swaps the process standard-error handle with SetStdHandle, which
 *   Rust's stdio reads back through GetStdHandle on every write.
 * - JavaScript stderr: `console.error`/`warn`/`trace` and `process.stderr.write`.
 *   On POSIX the fd redirect already covers them. On Windows Bun writes through
 *   a console handle it opened at startup, so no handle swap reaches it; a
 *   stale addon cache the loader could not delete wrote its warning this way
 *   and shifted the composer on every launch while a second veyyon was open.
 * - JavaScript stdout text: `console.log`/`info`/`debug`/`dir`. These share fd 1
 *   with the renderer, so no fd redirect can separate them from a frame.
 *
 * The JavaScript paths are routed by replacing the console methods and
 * `process.stderr.write` for the duration; the renderer writes through
 * `process.stdout.write`, which is left alone, as are the escape sequences
 * other modules emit through it on purpose (OSC 52 clipboard, window title).
 *
 * Everything intercepted is appended to the veyyon log file, not discarded, so
 * the diagnostics stay greppable and Bun native-crash reports (which abort
 * before any JS cleanup can restore fd 2) are preserved. A message meant for
 * the operator goes through a notice surface instead of any of these paths.
 * Ownership is released at every point the terminal is handed back (external
 * editor, Ctrl+Z suspend, shutdown, crash restore).
 *
 * Only dup/dup2 go through bun:ffi on POSIX. fcntl is avoided: it is variadic,
 * and the arm64-darwin ABI passes variadic arguments on the stack, so a
 * fixed-arity FFI signature would read garbage for the third argument.
 */
import { dlopen, FFIType } from "bun:ffi";
import * as fs from "node:fs";
import * as path from "node:path";
// `node:util` is required when a routed console call formats its arguments, not imported here: this
// module is on the launch card path, where the import would cost its evaluation before the first
// frame for calls most sessions never make.
import type * as nodeUtil from "node:util";
import { isMainThread } from "node:worker_threads";
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
	if (process.platform !== "darwin" && process.platform !== "linux") return null;
	// Darwin: dyld resolves libSystem from the shared cache. Linux: glibc
	// first, then the generic soname for musl-style layouts.
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
		} catch {
			// Try the next candidate; the guard stays inert if none load.
		}
	}
	return libcFdOpsCache;
}

/** `STD_ERROR_HANDLE`, `(DWORD)-12`. */
const STD_ERROR_HANDLE = 0xffff_fff4;
const INVALID_HANDLE_VALUE = 0xffff_ffff_ffff_ffffn;
const FILE_APPEND_DATA = 0x4;
const FILE_SHARE_READ_WRITE_DELETE = 0x7;
const OPEN_ALWAYS = 4;
const FILE_ATTRIBUTE_NORMAL = 0x80;

interface Kernel32HandleOps {
	GetStdHandle(which: number): bigint;
	SetStdHandle(which: number, handle: bigint): number;
	CreateFileW(
		path: Uint8Array,
		access: number,
		share: number,
		security: bigint,
		disposition: number,
		flags: number,
		template: bigint,
	): bigint;
	CloseHandle(handle: bigint): number;
}

let kernel32Cache: Kernel32HandleOps | null | undefined;

function kernel32HandleOps(): Kernel32HandleOps | null {
	if (kernel32Cache !== undefined) return kernel32Cache;
	kernel32Cache = null;
	if (process.platform !== "win32") return null;
	try {
		// HANDLE is pointer-sized; u64 keeps INVALID_HANDLE_VALUE (all ones) exact.
		const kernel32 = dlopen("kernel32.dll", {
			GetStdHandle: { args: [FFIType.u32], returns: FFIType.u64 },
			SetStdHandle: { args: [FFIType.u32, FFIType.u64], returns: FFIType.i32 },
			CreateFileW: {
				args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.u64, FFIType.u32, FFIType.u32, FFIType.u64],
				returns: FFIType.u64,
			},
			CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
		});
		kernel32Cache = kernel32.symbols as unknown as Kernel32HandleOps;
	} catch {
		// The guard stays inert for native writes; the JavaScript routing still applies.
	}
	return kernel32Cache;
}

/**
 * True when fd 2 writes would land on the same terminal the TUI paints to. A
 * stderr the user already redirected (`2>file`, `2>/dev/null`, a different tty)
 * must keep flowing untouched.
 */
function stderrSharesStdoutTerminal(): boolean {
	if (!process.stdout.isTTY || !process.stderr.isTTY) return false;
	// A Windows process has one console, and both console handles write to it.
	if (process.platform === "win32") return true;
	try {
		const stdoutStat = fs.fstatSync(STDOUT_FILENO);
		const stderrStat = fs.fstatSync(STDERR_FILENO);
		return stdoutStat.dev === stderrStat.dev && stdoutStat.ino === stderrStat.ino;
	} catch {
		// Cannot prove the two fds share a terminal, so assume they do not and leave stderr alone:
		// redirecting a stderr that was not ours to redirect would swallow output the user is watching.
		return false;
	}
}

/** How the native standard error is currently redirected, or null when it is not. */
type NativeRedirect = { kind: "fd"; savedFd: number } | { kind: "handle"; savedHandle: bigint; redirect: bigint };

let nativeRedirect: NativeRedirect | null = null;

interface ConsoleRoute {
	/** Where intercepted JavaScript output is appended. */
	fd: number;
	/** The originals, reinstated on restore. */
	restore: () => void;
}

let consoleRoute: ConsoleRoute | null = null;

export interface SuppressTerminalStderrOptions {
	/** Redirect target path; defaults to today's veyyon log file, then the null device. */
	redirectPath?: string;
	/** Bypass the same-terminal gates. Tests only. */
	force?: boolean;
}

function openRedirectTarget(redirectPath: string | undefined): number | null {
	try {
		const target = redirectPath ?? getLogPath();
		// getLogsDir() only computes the path; the logger creates it lazily, so on a fresh profile the
		// logs directory may not exist yet. Create it so diagnostics land in the log.
		fs.mkdirSync(path.dirname(target), { recursive: true });
		return fs.openSync(target, "a");
	} catch {
		try {
			return fs.openSync(process.platform === "win32" ? "NUL" : "/dev/null", "w");
		} catch {
			return null;
		}
	}
}

function redirectNativeStderr(redirectPath: string | undefined): boolean {
	const libc = libcFdOps();
	if (libc) {
		const redirectFd = openRedirectTarget(redirectPath);
		if (redirectFd === null) return false;
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
		nativeRedirect = { kind: "fd", savedFd: saved };
		return true;
	}

	const kernel32 = kernel32HandleOps();
	if (!kernel32) return false;
	const target = redirectPath ?? getLogPath();
	try {
		fs.mkdirSync(path.dirname(target), { recursive: true });
	} catch {
		return false;
	}
	const wide = Buffer.from(`${path.resolve(target)}\0`, "utf16le");
	const redirect = kernel32.CreateFileW(
		wide,
		FILE_APPEND_DATA,
		FILE_SHARE_READ_WRITE_DELETE,
		0n,
		OPEN_ALWAYS,
		FILE_ATTRIBUTE_NORMAL,
		0n,
	);
	if (redirect === INVALID_HANDLE_VALUE || redirect === 0n) return false;
	const savedHandle = kernel32.GetStdHandle(STD_ERROR_HANDLE);
	if (kernel32.SetStdHandle(STD_ERROR_HANDLE, redirect) === 0) {
		kernel32.CloseHandle(redirect);
		return false;
	}
	nativeRedirect = { kind: "handle", savedHandle, redirect };
	return true;
}

function restoreNativeStderr(): void {
	const active = nativeRedirect;
	if (active === null) return;
	nativeRedirect = null;
	if (active.kind === "fd") {
		libcFdOps()?.dup2(active.savedFd, STDERR_FILENO);
		try {
			fs.closeSync(active.savedFd);
		} catch {
			// The dup'ed fd is process-owned; a close failure leaves nothing to recover.
		}
		return;
	}
	const kernel32 = kernel32HandleOps();
	if (!kernel32) return;
	kernel32.SetStdHandle(STD_ERROR_HANDLE, active.savedHandle);
	kernel32.CloseHandle(active.redirect);
}

type ConsoleMethod = "log" | "info" | "debug" | "dir" | "warn" | "error" | "trace";
type StderrWrite = typeof process.stderr.write;

let utilModule: typeof nodeUtil | undefined;

function util(): typeof nodeUtil {
	utilModule ??= require("node:util") as typeof nodeUtil;
	return utilModule;
}

/**
 * Replace the console methods (and `process.stderr.write` when stderr is the
 * terminal) with writers that append to the redirect target. Each entry is
 * tagged with the call that produced it, so a stray write found in the log
 * names its path.
 */
function routeJavaScriptOutput(redirectPath: string | undefined, routeStderr: boolean): void {
	const fd = openRedirectTarget(redirectPath);
	if (fd === null) return;
	const append = (source: string, text: string): void => {
		try {
			fs.writeSync(fd, `[${source}] ${text.endsWith("\n") ? text : `${text}\n`}`);
		} catch {
			// The log is the only destination; a failed append has nowhere else to go.
		}
	};

	const methods: ConsoleMethod[] = routeStderr
		? ["log", "info", "debug", "dir", "warn", "error", "trace"]
		: ["log", "info", "debug", "dir"];
	const saved = new Map<ConsoleMethod, (...args: unknown[]) => void>();
	for (const method of methods) {
		saved.set(method, console[method]);
		const source = `console.${method}`;
		console[method] =
			method === "dir"
				? (value: unknown) => append(source, util().inspect(value))
				: method === "trace"
					? (...args: unknown[]) => append(source, `Trace: ${util().format(...args)}\n${new Error().stack ?? ""}`)
					: (...args: unknown[]) => append(source, util().format(...args));
	}

	let savedStderrWrite: StderrWrite | undefined;
	if (routeStderr) {
		savedStderrWrite = process.stderr.write;
		const routedWrite = (chunk: unknown, encodingOrCallback?: unknown, callback?: unknown): boolean => {
			append(
				"process.stderr",
				typeof chunk === "string"
					? chunk
					: Buffer.from(chunk as Uint8Array).toString(
							typeof encodingOrCallback === "string" ? (encodingOrCallback as BufferEncoding) : "utf8",
						),
			);
			const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
			if (typeof done === "function") queueMicrotask(() => done());
			return true;
		};
		process.stderr.write = routedWrite as StderrWrite;
	}

	consoleRoute = {
		fd,
		restore: () => {
			for (const [method, original] of saved) console[method] = original;
			if (savedStderrWrite) process.stderr.write = savedStderrWrite;
		},
	};
}

/**
 * Keep every write the renderer did not make off the terminal while the TUI
 * owns it. Returns true when the native stderr is (already) redirected; the
 * JavaScript routing is installed independently and is reported by
 * {@link isTerminalOutputRouted}. Nothing happens for a stream the user already
 * pointed elsewhere.
 */
export function suppressTerminalStderr(options?: SuppressTerminalStderrOptions): boolean {
	const force = options?.force === true;
	const stderrIsTerminal = force || stderrSharesStdoutTerminal();
	if (consoleRoute === null && (force || process.stdout.isTTY)) {
		routeJavaScriptOutput(options?.redirectPath, stderrIsTerminal);
	}
	if (nativeRedirect !== null) return true;
	if (!stderrIsTerminal) return false;
	return redirectNativeStderr(options?.redirectPath);
}

/**
 * Hand the terminal's stdout and stderr back. Safe to call unconditionally:
 * a no-op when nothing is routed. Called at every terminal-ownership release
 * and by the postmortem fatal handlers before they print, so crash reports
 * reach the real terminal.
 */
export function restoreTerminalStderr(): void {
	restoreNativeStderr();
	const route = consoleRoute;
	if (route === null) return;
	consoleRoute = null;
	route.restore();
	try {
		fs.closeSync(route.fd);
	} catch {
		// Process-owned fd; nothing to recover.
	}
}

/** Whether the native stderr is currently redirected away from the terminal. */
export function isTerminalStderrSuppressed(): boolean {
	return nativeRedirect !== null;
}

/** Whether console output and JavaScript stderr writes are currently routed to the log. */
export function isTerminalOutputRouted(): boolean {
	return consoleRoute !== null;
}

/**
 * Route this worker thread's console output to the log for the rest of its life.
 *
 * A worker thread has its own `console`, and Bun writes it straight to fd 1 and
 * fd 2, beside the main thread's router: a worker's `console.log` painted into
 * the viewport, and on Windows so did its `console.warn`. A worker never owns
 * the terminal, so nothing it prints belongs there. A no-op on the main thread,
 * whose routing follows terminal ownership through {@link suppressTerminalStderr}.
 */
export function routeWorkerThreadOutput(options?: { redirectPath?: string }): void {
	if (isMainThread || consoleRoute !== null) return;
	routeJavaScriptOutput(options?.redirectPath, true);
}
