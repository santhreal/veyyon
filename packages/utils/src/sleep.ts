/**
 * Block the current thread for `ms` milliseconds.
 *
 * This is the one home for synchronous sleeping. It exists for the rare
 * synchronous retry loop (a file-lock acquire, a temp-dir removal retry) that
 * cannot be made async. Prefer an async delay everywhere else — a sync sleep
 * freezes the event loop for its whole duration.
 *
 * Uses `Bun.sleepSync` when available and falls back to `Atomics.wait` on a
 * throwaway shared buffer, which blocks without a busy spin.
 */

const kSleepBuffer = new Int32Array(new SharedArrayBuffer(4));

export function sleepSync(ms: number): void {
	if (ms <= 0) return;
	if ("sleepSync" in Bun && typeof Bun.sleepSync === "function") {
		Bun.sleepSync(ms);
		return;
	}
	Atomics.wait(kSleepBuffer, 0, 0, ms);
}
