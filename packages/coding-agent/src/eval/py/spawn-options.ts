/** Subprocess spawn-option helpers for the Python kernel. Pure helpers (`shouldHideKernelWindow`, `consoleAttachedViaTTY`) live here */
import { dlopen, FFIType } from "bun:ffi";

/** Decide whether the long-lived Python kernel subprocess should be spawned with `windowsHide: true`. */
export function shouldHideKernelWindow(opts: {
	platform: NodeJS.Platform;
	hostHasInheritableConsole: boolean;
}): boolean {
	if (opts.platform !== "win32") return false;
	return !opts.hostHasInheritableConsole;
}

/** Keep eval kernels outside the host's POSIX terminal session. User code can start an interactive shell which calls `tcsetpgrp(3)`. If the */
export function shouldDetachKernel(platform: NodeJS.Platform): boolean {
	return platform !== "win32";
}

/** TTY-based fallback used when the Win32 console probe is unavailable. Returns `true` if any of stdin/stdout/stderr is currently a TTY. This */
export function consoleAttachedViaTTY(opts: {
	stdinIsTTY: boolean;
	stdoutIsTTY: boolean;
	stderrIsTTY: boolean;
}): boolean {
	return opts.stdinIsTTY || opts.stdoutIsTTY || opts.stderrIsTTY;
}

/** Probe `kernel32.dll!GetConsoleWindow()` to detect whether the current Windows process owns a console window. */
type ConsoleProbeResult = boolean | null;
let cachedWindowsConsoleProbe: { value: ConsoleProbeResult } | undefined;

function probeWindowsConsoleWindow(): ConsoleProbeResult {
	if (cachedWindowsConsoleProbe) return cachedWindowsConsoleProbe.value;
	let value: ConsoleProbeResult = null;
	try {
		const lib = dlopen("kernel32.dll", {
			GetConsoleWindow: { args: [], returns: FFIType.ptr },
		});
		try {
			const hwnd = lib.symbols.GetConsoleWindow();
			// FFIType.ptr returns `Pointer | null`; a 0 pointer should also be
			// treated as NULL defensively in case Bun ever returns 0n / 0.
			value = hwnd !== null && hwnd !== 0;
		} finally {
			lib.close();
		}
	} catch {
		value = null;
	}
	cachedWindowsConsoleProbe = { value };
	return value;
}

/** Reset the cached Win32 probe result. Test-only; not part of the public surface. */
export function __resetWindowsConsoleProbeCache(): void {
	cachedWindowsConsoleProbe = undefined;
}

/** Whether the host process owns a console its children can inherit. - On Windows, the authoritative signal is `GetConsoleWindow()`. It returns */
export function hostHasInheritableConsole(): boolean {
	if (process.platform === "win32") {
		const native = probeWindowsConsoleWindow();
		if (native !== null) return native;
	}
	return consoleAttachedViaTTY({
		stdinIsTTY: !!process.stdin.isTTY,
		stdoutIsTTY: !!process.stdout.isTTY,
		stderrIsTTY: !!process.stderr.isTTY,
	});
}
