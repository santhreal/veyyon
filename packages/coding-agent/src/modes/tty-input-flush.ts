/**
 * Discard whatever the kernel has already queued as terminal input.
 *
 * A relaunched session (`/profile <name>` respawns the CLI) inherits the same
 * tty as the process that just exited. Between the moment the parent restores
 * the terminal and the moment the child installs its own reader, nothing is
 * reading fd 0, so the line discipline buffers every byte that arrives. The
 * child then resumes stdin and the kernel hands it that backlog as its first
 * input event, which lands in the composer and can submit a turn the operator
 * never typed.
 *
 * `tcflush(fd, TCIFLUSH)` is the POSIX operation for exactly this: it drops the
 * input queue without reading it, so the child starts from a known-empty tty no
 * matter who left bytes behind. There is no portable equivalent, and Windows
 * consoles have no termios at all, so this returns `false` there and the caller
 * falls back to discarding whatever it reads before startup completes.
 */
import { dlopen, FFIType } from "bun:ffi";

/**
 * `TCIFLUSH` is not the same number everywhere: Linux numbers the queue
 * selectors from 0 (`TCIFLUSH 0`, `TCOFLUSH 1`, `TCIOFLUSH 2`) while the BSDs
 * and macOS number them from 1 (`TCIFLUSH 1`, `TCOFLUSH 2`, `TCIOFLUSH 3`).
 * Passing Linux's 0 on macOS would flush nothing.
 */
const TCIFLUSH = process.platform === "linux" ? 0 : 1;

const SIGNATURE = { tcflush: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } } as const;

const tcflush = (() => {
	try {
		if (process.platform === "linux") {
			try {
				return dlopen("libc.so.6", SIGNATURE).symbols.tcflush;
			} catch {
				return dlopen("libc.so", SIGNATURE).symbols.tcflush;
			}
		}
		if (process.platform === "darwin") return dlopen("/usr/lib/libSystem.B.dylib", SIGNATURE).symbols.tcflush;
		return undefined;
	} catch {
		// No usable libc (musl under an unusual name, a hardened loader, bun:ffi
		// disabled). Startup must not fail over an input hygiene measure.
		return undefined;
	}
})();

/**
 * Drop every byte already queued for stdin.
 *
 * Returns `true` when the kernel flushed the queue, `false` when the platform
 * offers no flush and the caller must fall back to discarding what it reads.
 */
export function flushPendingTtyInput(): boolean {
	if (!process.stdin.isTTY || !tcflush) return false;
	return tcflush(0, TCIFLUSH) === 0;
}
