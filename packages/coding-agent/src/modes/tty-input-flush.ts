import { dlopen, FFIType } from "bun:ffi";

const TCIFLUSH = process.platform === "linux" ? 0 : 1;

const SIGNATURE = { tcflush: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } } as const;

type TcFlush = (fd: number, queue: number) => number;

let resolved: { fn: TcFlush | undefined } | undefined;

function loadTcFlush(): TcFlush | undefined {
	if (resolved) return resolved.fn;
	resolved = { fn: undefined };
	try {
		if (process.platform === "linux") {
			try {
				resolved.fn = dlopen("libc.so.6", SIGNATURE).symbols.tcflush;
			} catch {
				resolved.fn = dlopen("libc.so", SIGNATURE).symbols.tcflush;
			}
		} else if (process.platform === "darwin") {
			resolved.fn = dlopen("/usr/lib/libSystem.B.dylib", SIGNATURE).symbols.tcflush;
		}
	} catch {}
	return resolved.fn;
}

export function flushPendingTtyInput(): boolean {
	if (!process.stdin.isTTY) return false;
	const flush = loadTcFlush();
	return flush ? flush(0, TCIFLUSH) === 0 : false;
}

export const RELAUNCH_MARKER = "VEYYON_RELAUNCHED";

export function consumeRelaunchMarker(): boolean {
	const relaunched = process.env[RELAUNCH_MARKER] === "1";
	delete process.env[RELAUNCH_MARKER];
	return relaunched;
}
