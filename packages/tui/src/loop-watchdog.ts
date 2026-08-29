import { performance } from "node:perf_hooks";
import * as logger from "@veyyon/utils/logger";
import { takeLoopPhaseProfile } from "@veyyon/utils/loop-phase";

import type { LoopWatchdogOptions, LoopWatchdogTimer } from "./loop-watchdog-helpers";

export class LoopWatchdog {
	#intervalMs: number;
	#thresholdMs: number;
	#now: () => number;
	#schedule: (cb: () => void, ms: number) => LoopWatchdogTimer;
	#expected = 0;
	#wasBlocked = false;
	#running = false;
	// Bumped by stop(); each scheduled tick captures the generation it was armed
	// under and no-ops if it no longer matches, so a start()→stop()→start() cycle
	// cannot leave the pre-stop timer chain rescheduling itself in parallel.
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
		// Consume the profile every tick (block or not) so attribution is scoped to
		// the just-elapsed interval and never carries a stale phase forward to a
		// later, phase-less block.
		const { phase, ms } = takeLoopPhaseProfile();
		if (blockedMs > this.#thresholdMs) {
			if (!this.#wasBlocked) {
				this.#wasBlocked = true;
				const phaseMs = Math.round(ms);
				// Half the block is the bar for calling a phase the cause. Under it the
				// phase ran and finished inside an interval something else spent, which
				// is evidence AGAINST it, so the line reports it as ruled out.
				const attributed = phase !== undefined && ms * 2 >= blockedMs;
				logger.warn("ui.loop-blocked", {
					blockedMs: Math.round(blockedMs),
					phase: attributed ? phase : "unknown",
					phaseMs,
					...(attributed ? {} : { topPhase: phase ?? "none" }),
				});
			}
		} else {
			this.#wasBlocked = false;
		}
		this.#armTick();
	}
}
