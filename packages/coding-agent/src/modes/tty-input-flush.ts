/** Discard whatever the kernel has already queued as terminal input. A relaunched session (`/profile <name>` respawns the CLI) inherits the same */
import { dlopen, FFIType } from "bun:ffi";

/** `TCIFLUSH` is not the same number everywhere: Linux numbers the queue selectors from 0 (`TCIFLUSH 0`, `TCOFLUSH 1`, `TCIOFLUSH 2`) while the BSDs */
const TCIFLUSH = process.platform === "linux" ? 0 : 1;

const SIGNATURE = { tcflush: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } } as const;

type TcFlush = (fd: number, queue: number) => number;

let resolved: { fn: TcFlush | undefined } | undefined;

/** Resolve `tcflush` from libc, once, on first use. Lazy rather than at module scope because the flush is gated on an interactive */
function loadTcFlush(): TcFlush | undefined {
	if (resolved) return resolved.fn;
	resolved = { fn: undefined };
	try {
		if (process.platform === "linux") {
			try {
				resolved.fn = dlopen("libc.so.6", SIGNATURE).symbols.tcflush;
			} catch {
				// musl and other libcs do not ship the glibc soname.
				resolved.fn = dlopen("libc.so", SIGNATURE).symbols.tcflush;
			}
		} else if (process.platform === "darwin") {
			resolved.fn = dlopen("/usr/lib/libSystem.B.dylib", SIGNATURE).symbols.tcflush;
		}
	} catch {
		// No usable libc: musl under a name neither lookup guesses, or a hardened loader refusing the open. Startup must not fail over an input
	}
	return resolved.fn;
}

/** Drop every byte already queued for stdin. Returns `true` when the kernel flushed the queue, `false` when the platform */
export function flushPendingTtyInput(): boolean {
	// Not a correctness barrier: `tcflush` on a pipe fails with ENOTTY and discards nothing, so a piped stdin is safe either way. It skips loading
	if (!process.stdin.isTTY) return false;
	const flush = loadTcFlush();
	// fd 0 rather than `process.stdin.fd`: the guard above already established
	// that stdin is the tty being flushed.
	return flush ? flush(0, TCIFLUSH) === 0 : false;
}

/** Env marker a relaunch sets on its child, so the child knows the bytes already queued on the tty predate it. */
export const RELAUNCH_MARKER = "VEYYON_RELAUNCHED";

/** Whether this process was started by a relaunch, clearing the marker as it reads it so a child this session spawns for any other reason does not inherit */
export function consumeRelaunchMarker(): boolean {
	const relaunched = process.env[RELAUNCH_MARKER] === "1";
	delete process.env[RELAUNCH_MARKER];
	return relaunched;
}
