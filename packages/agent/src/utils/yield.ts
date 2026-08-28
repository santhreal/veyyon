import { scheduler } from "node:timers/promises";
import { DAY_MS, isAbortError } from "@veyyon/utils";

export class EventLoopKeepalive {
	#tmr = setInterval(() => {}, DAY_MS).unref();
	[Symbol.dispose](): void {
		clearInterval(this.#tmr);
	}
}

const YIELD_SLEEP_MS = 20;
const YIELD_INTERVAL_MS = 50;

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

export interface YieldGateOptions {
	now?: () => number;
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
	intervalMs?: number;
	sleepMs?: number;
}

export class YieldGate {
	#lastYieldAt = 0;
	readonly #now: () => number;
	readonly #sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
	readonly #intervalMs: number;
	readonly #sleepMs: number;

	constructor(opts: YieldGateOptions = {}) {
		this.#now = opts.now ?? (() => Date.now());
		this.#sleep = opts.sleep ?? sleepAtLeast;
		this.#intervalMs = opts.intervalMs ?? YIELD_INTERVAL_MS;
		this.#sleepMs = opts.sleepMs ?? YIELD_SLEEP_MS;
	}

	async yieldIfDue(signal?: AbortSignal): Promise<void> {
		const now = this.#now();
		const elapsed = now - this.#lastYieldAt;
		if (elapsed >= 0 && elapsed < this.#intervalMs) return;
		await this.#sleep(this.#sleepMs, signal);
		this.#lastYieldAt = this.#now();
	}
}

const sharedYieldGate = new YieldGate();

export function yieldIfDue(): Promise<void> {
	return sharedYieldGate.yieldIfDue();
}

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
