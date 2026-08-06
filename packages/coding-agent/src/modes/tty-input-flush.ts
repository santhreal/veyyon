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
 *
 * Only linux and darwin ever reach the call, because those plus Windows are
 * the platforms Bun ships. The non-linux branch is therefore macOS in practice;
 * it is written as a platform test rather than a darwin constant so that a
 * future BSD target gets the right selector at the same time it gets a loader.
 */
const TCIFLUSH = process.platform === "linux" ? 0 : 1;

const SIGNATURE = { tcflush: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } } as const;

type TcFlush = (fd: number, queue: number) => number;

let resolved: { fn: TcFlush | undefined } | undefined;

/**
 * Resolve `tcflush` from libc, once, on first use.
 *
 * Lazy rather than at module scope because the flush is gated on an interactive
 * tty and this module is imported by every startup, including the non-tty and
 * test ones that will never call it: opening libc for them is work done for a
 * branch that cannot be taken.
 */
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
		// No usable libc: musl under a name neither lookup guesses, or a
		// hardened loader refusing the open. Startup must not fail over an input
		// hygiene measure, and the caller has a fallback. (A `bun:ffi` that did
		// not exist would throw at the import above instead, which is why this
		// does not claim to cover that.)
	}
	return resolved.fn;
}

/**
 * Drop every byte already queued for stdin.
 *
 * Returns `true` when the kernel flushed the queue, `false` when the platform
 * offers no flush and the caller must fall back to discarding what it reads.
 */
export function flushPendingTtyInput(): boolean {
	// Not a correctness barrier: `tcflush` on a pipe fails with ENOTTY and
	// discards nothing, so a piped stdin is safe either way. It skips loading
	// libc for the many runs that are not interactive at all, and it makes the
	// `false` those runs return mean "not applicable" rather than "the platform
	// could not do it", which is the distinction the caller logs.
	if (!process.stdin.isTTY) return false;
	const flush = loadTcFlush();
	// fd 0 rather than `process.stdin.fd`: the guard above already established
	// that stdin is the tty being flushed.
	return flush ? flush(0, TCIFLUSH) === 0 : false;
}
