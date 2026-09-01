import { dlopen, FFIType } from "bun:ffi";

export function shouldHideKernelWindow(opts: {
	platform: NodeJS.Platform;
	hostHasInheritableConsole: boolean;
}): boolean {
	if (opts.platform !== "win32") return false;
	return !opts.hostHasInheritableConsole;
}

export function shouldDetachKernel(platform: NodeJS.Platform): boolean {
	return platform !== "win32";
}

export function consoleAttachedViaTTY(opts: {
	stdinIsTTY: boolean;
	stdoutIsTTY: boolean;
	stderrIsTTY: boolean;
}): boolean {
	return opts.stdinIsTTY || opts.stdoutIsTTY || opts.stderrIsTTY;
}

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

export function __resetWindowsConsoleProbeCache(): void {
	cachedWindowsConsoleProbe = undefined;
}

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
