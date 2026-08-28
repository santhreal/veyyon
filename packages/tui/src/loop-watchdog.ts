import { performance } from "node:perf_hooks";
import * as logger from "@veyyon/utils/logger";
import { takeRecentLoopPhase } from "@veyyon/utils/loop-phase";

export interface LoopWatchdogOptions {
	intervalMs?: number;
	thresholdMs?: number;
	now?: () => number;
	schedule?: (cb: () => void, ms: number) => LoopWatchdogTimer;
}

interface LoopWatchdogTimer {
	unref?(): void;
	cancel?(): void;
}

export class LoopWatchdog {
	#intervalMs: number;
	#thresholdMs: number;
	#now: () => number;
	#schedule: (cb: () => void, ms: number) => LoopWatchdogTimer;
	#expected = 0;
	#wasBlocked = false;
	#running = false;
	#generation = 0;
	#handle: LoopWatchdogTimer | undefined;

	constructor(options: LoopWatchdogOptions = {}) {
		this.#intervalMs = options.intervalMs ?? 250;
		this.#thresholdMs = options.thresholdMs ?? 250;
		this.#now = options.now ?? (() => performance.now());
		this.#schedule =
			options.schedule ??
			((cb, ms) => {
				const timer = setTimeout(cb, ms);
				return { unref: () => timer.unref?.(), cancel: () => clearTimeout(timer) };
			});
	}

	start(): void {
		if (this.#running) return;
		this.#running = true;
		this.#wasBlocked = false;
		this.#armTick();
	}

	stop(): void {
		this.#running = false;
		this.#wasBlocked = false;
		this.#generation++;
		this.#handle?.cancel?.();
		this.#handle = undefined;
	}

	#armTick(): void {
		const generation = this.#generation;
		this.#expected = this.#now() + this.#intervalMs;
		this.#handle = this.#schedule(() => this.#tick(generation), this.#intervalMs);
		this.#handle.unref?.();
	}

	#tick(generation: number): void {
		if (!this.#running || generation !== this.#generation) return;
		const blockedMs = this.#now() - this.#expected;
		const phase = takeRecentLoopPhase();
		if (blockedMs > this.#thresholdMs) {
			if (!this.#wasBlocked) {
				this.#wasBlocked = true;
				logger.warn("ui.loop-blocked", {
					blockedMs: Math.round(blockedMs),
					phase: phase ?? "unknown",
				});
			}
		} else {
			this.#wasBlocked = false;
		}
		this.#armTick();
	}
}
