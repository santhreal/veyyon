import { performance } from "node:perf_hooks";
import * as logger from "@veyyon/utils/logger";
import { takeLoopPhaseProfile } from "@veyyon/utils/loop-phase";

export interface LoopWatchdogOptions {
	/** How far ahead each probe tick is scheduled, in ms. Default 250. */
	intervalMs?: number;
	/** A tick later than this past its deadline counts as a block. Default 250. */
	thresholdMs?: number;
	/** Monotonic clock source; injectable for tests. Default `performance.now`. */
	now?: () => number;
	/** Timer source; injectable for tests. Default `setTimeout`. */
	schedule?: (cb: () => void, ms: number) => LoopWatchdogTimer;
}

/**
 * Timer handle the watchdog arms. `cancel`, when present, is invoked on stop()
 * so a stopped watchdog leaves no armed timer to wake the loop even once.
 */
interface LoopWatchdogTimer {
	unref?(): void;
	cancel?(): void;
}

/**
 * Always-on event-loop lag probe. Each tick is scheduled `intervalMs` ahead of
 * a recorded deadline; a tick that fires `thresholdMs` past its deadline means
 * the loop was blocked that long. The overshoot is logged once on the rising
 * edge (one block ⇒ one line, deduped via `#wasBlocked`).
 *
 * The line names a phase only when that phase was open for at least half the
 * block. Four spans in the whole product push a phase, so the last label before
 * a block is nearly always the render pass whatever really blocked, and naming
 * it sends a reader to optimize a pass that measures in single-digit
 * milliseconds. Below the half share the cause is genuinely unknown and the
 * line says so, carrying `topPhase` and `phaseMs` as the evidence that rules
 * that phase OUT.
 *
 * The handle is `unref`'d so the probe never keeps the process alive, and stop()
 * cancels the armed timer when the handle exposes `cancel` (the default
 * `setTimeout` handle does, via `clearTimeout`). The `#generation` guard remains
 * as a fallback for injected handles that cannot cancel.
 */
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
