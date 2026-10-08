import { releaseFreeHeapPages } from "@veyyon/natives";
import { type ActivitySignal, processActivity } from "./activity-signal";
import * as logger from "./logger";
import { rearmingTimeout } from "./rearming-timeout";
import { errorMessage } from "./type-guards";

/**
 * A window whose process CPU exceeds this share of its wall time is busy: an idle interactive
 * session measures 0.5%, a streaming turn tens of percent.
 */
export const BUSY_CPU_RATIO = 0.05;

export interface IdleTrimOptions {
	/** Quiet time after the last busy window before the trim runs, in ms. Default 30 000. */
	quietMs?: number;
	/** Length of one CPU sampling window, in ms. Default 5 000. */
	sampleMs?: number;
	/** A window whose process CPU exceeds this share of its wall time is busy. Default `BUSY_CPU_RATIO`. */
	busyCpuRatio?: number;
	/** Monotonic clock source; injectable for tests. Default `performance.now`. */
	now?: () => number;
	/** Process CPU consumed so far, in microseconds; injectable for tests. Default `process.cpuUsage`. */
	cpuUsage?: () => { user: number; system: number };
	/** Timer source; injectable for tests. Default `rearmingTimeout()`. */
	schedule?: (cb: () => void, ms: number) => IdleTrimTimer;
	/** The trim itself; injectable for tests and for a caller that releases more. Default `trimEngine`. */
	trim?: () => void;
	/**
	 * Work cheap enough to run on every quiet stretch: on the first quiet window after a busy one,
	 * and again after each trim. Default none.
	 */
	release?: () => void;
	/** Where work is reported; a trimmed process parks only while a host is attached. Default `processActivity`. */
	activity?: ActivitySignal;
}

/**
 * Deletes the engine's compiled code, runs a full collection and releases the free pages of the
 * engine's heaps, then returns the free pages of the C allocator's arenas, which `Bun.shrink()`
 * leaves mapped: native work on the addon's worker threads leaves its peak resident there.
 * `Bun.shrink()` has no `node:*` equivalent: V8 exposes no call that discards compiled code.
 */
export function trimEngine(): void {
	Bun.shrink();
	releaseFreeHeapPages();
}

/** Timer handle the trim arms. `cancel`, when present, is invoked on stop(). */
interface IdleTrimTimer {
	unref?(): void;
	cancel?(): void;
}

/**
 * Discards the JavaScript engine's compiled code and returns the allocator's free pages once the
 * process has been quiet for `quietMs`.
 *
 * A session waiting on its user keeps every function it has run compiled: the startup path, the
 * last turn's streaming and rendering, each tool it called. JavaScriptCore regenerates any of it
 * from source on the next call. `Bun.shrink()` deletes the code blocks, runs a full collection and
 * releases free malloc pages, on the next idle point of the loop.
 *
 * MEASURED on the linux-x64 binary, interactive session against a local endpoint:
 * - idle after startup: RSS 337 -> 323 MiB, JS heap 70.6 -> 49.7 MiB.
 * - idle after eight turns: RSS 374 -> 349 MiB.
 * - the trim holds the loop 36-46 ms and costs 81-105 ms of CPU across the collector threads.
 * - the next keystroke echoes in 6.5 ms instead of 3.2 ms; the next turn takes 115 ms instead of
 *   75 ms, and RSS after it stays 15 MiB under the untrimmed run, since only the code that turn
 *   ran is compiled again.
 *
 * Quiet is read from process CPU rather than from any one source of work, so a turn, a subagent,
 * a tool, a render or a keystroke all hold the trim off without reporting to it, in every mode.
 * A window whose CPU stays under `busyCpuRatio` of its wall time is quiet. After a trim the
 * process stays trimmed until a busy window is seen, so an idle process trims once rather than
 * every `quietMs`. The window holding the trim is not judged: its CPU is the trim's own collection.
 *
 * `release` runs on the first quiet window after work, so a session whose turns come less than
 * `quietMs` apart still drops what the release covers between them, and once more after each trim.
 * A release that throws is not called again; sampling and the trim continue.
 *
 * After a trim, the first quiet window after the trim's own parks the sampling on `activity`
 * when a host is attached to it: no window is armed until the host reports work, and the window
 * armed then judges that work. Work the host does not report is not sampled, so a burst of it
 * after a trim is followed by no second trim. Without a host the sampling continues every
 * `sampleMs`.
 *
 * The sampling timer is `unref`'d and never keeps the process alive; stop() cancels it and drops a
 * parked wake.
 */
export class IdleTrim {
	#quietMs: number;
	#sampleMs: number;
	#busyCpuRatio: number;
	#now: () => number;
	#cpuUsage: () => { user: number; system: number };
	#schedule: (cb: () => void, ms: number) => IdleTrimTimer;
	#trim: () => void;
	#release: (() => void) | undefined;
	#running = false;
	// Bumped by stop(); a tick armed under an older generation no-ops, so start()→stop()→start()
	// never leaves two sampling chains running.
	#generation = 0;
	#handle: IdleTrimTimer | undefined;
	#windowStartMs = 0;
	/** Process CPU at the start of the armed window, in microseconds. */
	#windowStartCpuUs = 0;
	/** End of the most recent busy window: the quiet period is measured from here. */
	#quietSinceMs = 0;
	/** A trim ran and no busy window has been seen since. */
	#trimmed = false;
	/** The armed window holds the trim's own collection and is not judged. */
	#skipWindow = false;
	/** The release ran and no busy window has been seen since. */
	#released = false;
	#activity: ActivitySignal;
	#parked = false;
	/** Arms the next window once work is reported after sampling parked. */
	#wake = (): void => {
		if (!this.#parked) return;
		this.#parked = false;
		this.#arm();
	};

	constructor(options: IdleTrimOptions = {}) {
		this.#quietMs = options.quietMs ?? 30_000;
		this.#sampleMs = options.sampleMs ?? 5_000;
		this.#busyCpuRatio = options.busyCpuRatio ?? BUSY_CPU_RATIO;
		this.#now = options.now ?? (() => performance.now());
		this.#cpuUsage = options.cpuUsage ?? (() => process.cpuUsage());
		this.#schedule = options.schedule ?? rearmingTimeout();
		this.#trim = options.trim ?? trimEngine;
		this.#release = options.release;
		this.#activity = options.activity ?? processActivity;
	}

	/** Start sampling. The quiet period starts now. Idempotent. */
	start(): void {
		if (this.#running) return;
		this.#running = true;
		this.#trimmed = false;
		this.#released = false;
		this.#skipWindow = false;
		this.#quietSinceMs = this.#now();
		this.#arm();
	}

	/** Stop sampling and cancel the armed window. */
	stop(): void {
		this.#running = false;
		this.#generation++;
		this.#handle?.cancel?.();
		this.#handle = undefined;
		this.#parked = false;
		this.#activity.unpark(this.#wake);
	}

	get running(): boolean {
		return this.#running;
	}

	#arm(): void {
		const generation = this.#generation;
		this.#windowStartMs = this.#now();
		const cpu = this.#cpuUsage();
		this.#windowStartCpuUs = cpu.user + cpu.system;
		this.#handle = this.#schedule(() => this.#sample(generation), this.#sampleMs);
		this.#handle.unref?.();
	}

	#sample(generation: number): void {
		if (!this.#running || generation !== this.#generation) return;
		const now = this.#now();
		const cpu = this.#cpuUsage();
		const cpuMs = (cpu.user + cpu.system - this.#windowStartCpuUs) / 1000;
		const wallMs = now - this.#windowStartMs;
		if (this.#skipWindow) {
			this.#skipWindow = false;
		} else if (cpuMs > wallMs * this.#busyCpuRatio) {
			this.#quietSinceMs = now;
			this.#trimmed = false;
			this.#released = false;
		} else if (!this.#quietWindow(now)) {
			return;
		}
		this.#arm();
	}

	/**
	 * Run the release on the first quiet window, then trim once the quiet period has elapsed, or
	 * park a trimmed process on its activity signal. False when sampling stopped or parked and no
	 * window is to be armed.
	 */
	#quietWindow(now: number): boolean {
		if (!this.#released) {
			this.#released = true;
			this.#runRelease();
		}
		if (!this.#trimmed && now - this.#quietSinceMs >= this.#quietMs) {
			try {
				this.#trim();
			} catch (error) {
				// The engine offers no trim; sampling for one that can never run is waste.
				logger.warn("Idle trim failed; sampling stopped", { error: errorMessage(error) });
				this.stop();
				return false;
			}
			this.#trimmed = true;
			this.#skipWindow = true;
			logger.debug("Idle trim ran", { quietMs: Math.round(now - this.#quietSinceMs) });
			this.#runRelease();
		} else if (this.#trimmed && this.#activity.park(this.#wake)) {
			this.#parked = true;
			return false;
		}
		return true;
	}

	#runRelease(): void {
		const release = this.#release;
		if (!release) return;
		try {
			release();
		} catch (error) {
			// A release that fails here fails on every quiet stretch; the trim does not depend on it.
			this.#release = undefined;
			logger.warn("Idle release failed; release stopped", { error: errorMessage(error) });
		}
	}
}
