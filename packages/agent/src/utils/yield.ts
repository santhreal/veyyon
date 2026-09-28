/**
 * Cooperative yield utility for preventing Bun event-loop busy-wait.
 *
 * ## Root Cause
 *
 * Bun 1.3.x (JavaScriptCore) event loop busy-waits (spins in userspace)
 * when the only pending work is an unresolved Promise — even if there are
 * active I/O watchers (stdin, child process pipes, etc.).  The event loop
 * continuously polls for microtask resolution instead of blocking in
 * `epoll_wait`, consuming ~100% of a CPU core.
 *
 * This affects any `await` on a never-resolved Promise, including:
 * - `Promise.withResolvers()` used for user input callbacks
 * - `await proc.exited` for long-running child processes
 * - Agent loop iterations waiting for the next tool call
 *
 * ## Fix
 *
 * A recurring `setInterval` keeps the event loop sleeping in `epoll_wait`.
 * The `EventLoopKeepalive` class and `keepaliveWhile()` wrapper provide a
 * clean way to install and clean up this keepalive timer.
 *
 * The older `yieldIfDue()` and `ExponentialYield` approaches (compensated
 * sleep loops) are retained for the agent-loop hot-path where Promises
 * resolve frequently and the keepalive alone is insufficient.
 */

import { scheduler } from "node:timers/promises";
import { DAY_MS, isAbortError } from "@veyyon/utils";

// ---------------------------------------------------------------------------
// EventLoopKeepalive — the primary fix for idle-state busy-wait
// ---------------------------------------------------------------------------

export class EventLoopKeepalive {
	#tmr = setInterval(() => {}, DAY_MS).unref();
	[Symbol.dispose](): void {
		clearInterval(this.#tmr);
	}
}

// ---------------------------------------------------------------------------
// yieldIfDue — retained for agent-loop hot-path
// ---------------------------------------------------------------------------

const YIELD_SLEEP_MS = 20;
const YIELD_INTERVAL_MS = 50;

/**
 * Sleep for at least `ms` milliseconds of wall-clock time.
 * Retries the wait if it returns prematurely (which can happen when napi
 * callbacks wake the event loop via `uv_async_send`). When `signal` is
 * provided, the wait is cancellable and silently returns on abort instead
 * of throwing — callers race against another promise that decides what to
 * do next.
 */
async function sleepAtLeast(ms: number, signal?: AbortSignal): Promise<void> {
	const start = performance.now();
	let remaining = ms;
	while (remaining > 0) {
		if (signal?.aborted) return;
		try {
			await scheduler.wait(remaining, { signal });
		} catch (err) {
			if (isAbortError(err)) return;
			throw err;
		}
		remaining = ms - (performance.now() - start);
	}
}

/**
 * Cooperative yield gate. A run of calls the event loop did not turn between
 * sleeps for {@link YieldGateOptions.sleepMs} once it has lasted
 * {@link YieldGateOptions.intervalMs}; a call that follows a turn of the event
 * loop starts a new run and passes straight through.
 *
 * A caller that awaited I/O since its previous call already let the event loop
 * poll, so a sleep there only delays what the caller does next: a streamed
 * token arriving after a quiet interval, or the request that opens a turn.
 * Only a chain of promises that settle without the loop polling, such as a
 * buffered burst of stream events, runs long enough to sleep.
 *
 * The clock, the sleep and the turn signal are injectable so tests drive the
 * gate logic without touching process-global `performance.now`,
 * `scheduler.wait` or `setImmediate` — globals a concurrent test file can
 * restore mid-run.
 */
export interface YieldGateOptions {
	now?: () => number;
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
	/** Calls `callback` once, the next time the event loop turns. */
	onTurn?: (callback: () => void) => void;
	intervalMs?: number;
	sleepMs?: number;
}

export class YieldGate {
	/** When the current run of calls began; undefined once the event loop has turned since the last call. */
	#busySince: number | undefined;
	#watching = false;
	readonly #now: () => number;
	readonly #sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
	readonly #onTurn: (callback: () => void) => void;
	readonly #intervalMs: number;
	readonly #sleepMs: number;

	constructor(opts: YieldGateOptions = {}) {
		this.#now = opts.now ?? (() => performance.now());
		this.#sleep = opts.sleep ?? sleepAtLeast;
		this.#onTurn = opts.onTurn ?? (callback => void setImmediate(callback));
		this.#intervalMs = opts.intervalMs ?? YIELD_INTERVAL_MS;
		this.#sleepMs = opts.sleepMs ?? YIELD_SLEEP_MS;
	}

	#turned = (): void => {
		this.#watching = false;
		this.#busySince = undefined;
	};

	async yieldIfDue(signal?: AbortSignal): Promise<void> {
		const now = this.#now();
		if (!this.#watching) {
			this.#watching = true;
			this.#onTurn(this.#turned);
		}
		const busy = this.#busySince === undefined ? -1 : now - this.#busySince;
		// A negative span is a first call, a call after a turn, or an injected
		// clock that moved backward: each starts a new run rather than sleeping.
		if (busy < 0) {
			this.#busySince = now;
			return;
		}
		if (busy < this.#intervalMs) return;
		await this.#sleep(this.#sleepMs, signal);
		// The sleep let the event loop poll, which is what a turn records.
		this.#busySince = undefined;
	}
}

/**
 * Process-wide gate shared by all hot-path callers so tight loops collectively
 * respect the interval rather than each sleeping independently.
 */
const sharedYieldGate = new YieldGate();

/**
 * Yield to the Bun event loop, sleeping for at least 20 ms once the callers
 * together have run for {@link YIELD_INTERVAL_MS} without the event loop turning.
 */
export function yieldIfDue(): Promise<void> {
	return sharedYieldGate.yieldIfDue();
}

// ---------------------------------------------------------------------------
// ExponentialYield — retained for bash-executor long waits
// ---------------------------------------------------------------------------

const EXP_DEFAULT_MIN_MS = 20;
const EXP_DEFAULT_MAX_MS = 10_000;
const EXP_DEFAULT_MULTIPLIER = 2;

export class ExponentialYield {
	#currentMs: number;
	readonly #minMs: number;
	readonly #maxMs: number;
	readonly #multiplier: number;

	constructor(opts?: { minMs?: number; maxMs?: number; multiplier?: number }) {
		this.#minMs = opts?.minMs ?? EXP_DEFAULT_MIN_MS;
		this.#maxMs = opts?.maxMs ?? EXP_DEFAULT_MAX_MS;
		this.#multiplier = opts?.multiplier ?? EXP_DEFAULT_MULTIPLIER;
		this.#currentMs = this.#minMs;
	}

	notifyActivity(): void {
		this.#currentMs = this.#minMs;
	}

	async sleep(signal?: AbortSignal): Promise<number> {
		const ms = this.#currentMs;
		await sleepAtLeast(ms, signal);
		this.#currentMs = Math.min(this.#currentMs * this.#multiplier, this.#maxMs);
		return ms;
	}

	/**
	 * Race `racers` against an exponentially-backed-off cooperative yield.
	 * The losing sleep is cancelled as soon as a racer settles, so no stray
	 * timers keep the event loop alive past the racer's resolution.
	 */
	async race<T>(racers: Array<Promise<T>>): Promise<T> {
		const racer = Promise.race(racers);
		const controller = new AbortController();
		try {
			const yieldMarker = Symbol("exp-yield");
			for (;;) {
				const result = await Promise.race<T | typeof yieldMarker>([
					racer,
					this.sleep(controller.signal).then(() => yieldMarker as T | typeof yieldMarker),
				]);
				if (result !== yieldMarker) {
					this.notifyActivity();
					return result;
				}
			}
		} finally {
			controller.abort();
		}
	}
}
