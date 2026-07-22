/**
 * Whether the process with this pid still exists.
 *
 * This is the one owner of that question. It was hand-rolled in seven places
 * under three different names, and the copies disagreed on the case that
 * matters: what `process.kill(pid, 0)` throwing actually means.
 *
 * Sending signal 0 does not send a signal. It performs the error checks that a
 * real signal would, so it answers "could I signal this process?" and the kernel
 * distinguishes two failures:
 *
 * - `ESRCH`, no such process. The process is gone, and this returns false.
 * - `EPERM`, the process exists but belongs to a user you may not signal. It is
 *   alive, and this returns true.
 *
 * The naive form catches everything and reports dead, which is wrong under a
 * container, a sandbox, or any setup where the pid belongs to another user. That
 * matters most where liveness decides whether to reap something: a lock whose
 * owner is wrongly judged dead is taken from a live holder, and two processes
 * end up inside a critical section that was supposed to admit one.
 *
 * Liveness alone is not proof that work is still progressing, because a pid can
 * be reused by an unrelated process. Pair it with a timestamp the owner
 * refreshes, and treat a lease as abandoned when either the owner is gone or the
 * timestamp has aged out.
 *
 * ```ts
 * if (!isProcessAlive(info.pid)) return true; // owner died, safe to reap
 * return Date.now() - info.timestamp > staleMs;
 * ```
 */
export function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// Only "no such process" proves death. Anything else, most importantly
		// EPERM, means the process is there and we simply may not signal it.
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}
