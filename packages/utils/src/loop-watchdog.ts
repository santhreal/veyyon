import { performance } from "node:perf_hooks";
import { type ActivitySignal, processActivity } from "./activity-signal";
import { BUSY_CPU_RATIO } from "./idle-trim";
import * as logger from "./logger";
import { type LoopPhaseProfile, takeLoopPhaseProfile } from "./loop-phase";
import { rearmingTimeout } from "./rearming-timeout";
import type { StallStackSource } from "./stall-sampler";

export interface LoopWatchdogOptions {
	/** How far ahead each probe tick is scheduled, in ms. Default 250. */
	intervalMs?: number;
	/** A tick later than this past its deadline counts as a block. Default 250. */
	thresholdMs?: number;
	/** Monotonic clock source; injectable for tests. Default `performance.now`. */
	now?: () => number;
	/** Timer source; injectable for tests. Default `rearmingTimeout()`. */
	schedule?: (cb: () => void, ms: number) => LoopWatchdogTimer;
	/**
	 * Process CPU consumed so far, in microseconds; injectable for tests.
	 * Default `process.cpuUsage`.
	 */
	cpuUsage?: () => { user: number; system: number };
	/**
	 * Where a block's JavaScript stacks come from. Given one, every block logged is followed by a
	 * `ui.loop-blocked.stack` line at the same level, carrying the functions the samples inside
	 * the block were executing. Absent, blocks are reported without stacks.
	 */
	stacks?: StallStackSource;
	/** Quiet time, in ms, after which the watchdog parks until work is reported. Default 10 000. */
	parkAfterMs?: number;
	/** Where work is reported; the watchdog parks only while a host is attached. Default `processActivity`. */
	activity?: ActivitySignal;
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
 * The most CPU one thread can report against the wall time it spanned.
 *
 * MEASURED: a single pinned thread reports at most 1.013 of elapsed wall time,
 * the drift being clock granularity. The bound sits above that and below the
 * 1.3 a second thread reaches running only a third of the interval, so it
 * separates one busy thread from two without tuning.
 */
const SINGLE_THREAD_CPU_RATIO = 1.25;

/**
 * Event-loop lag probe for a process that is working. Each tick is scheduled `intervalMs` ahead of
 * a recorded deadline; a tick that fires `thresholdMs` past its deadline means
 * the loop did not come back on time. The overshoot is logged once on the
 * rising edge (one block ⇒ one line, deduped via `#wasBlocked`).
 *
 * LATE IS NOT THE SAME AS BLOCKED. A tick is late whenever the loop failed to
 * run it, and the loop failing to run is not by itself the product's fault: a
 * loaded host deschedules an idle process for exactly as long as a hot JS pass
 * blocks a busy one. Measured over one real 13-hour session, the overshoot
 * distribution was the same whether the process had logged anything in the
 * previous 30 seconds (p50 292ms) or had been silent for minutes (p50 270ms),
 * which is the signature of host jitter and not of work. Every one of those
 * lines was a `warn` sending a reader to optimize a pass that never ran.
 *
 * So each tick also banks the CPU the process actually consumed across the
 * interval. Time the loop spends off-CPU — descheduled, or parked in a
 * blocking syscall — costs no CPU, while a synchronous JS pass costs the whole
 * interval. `cpuMs` is reported either way and never suppresses a line; it
 * decides the LEVEL. The product burning CPU while the loop is unavailable is
 * a defect and warns; the loop simply not being given the CPU is a fact about
 * the machine and is recorded at debug.
 *
 * The line names a phase only when that phase was open for at least half the
 * block. Four spans in the whole product push a phase, so the last label before
 * a block is nearly always the render pass whatever really blocked, and naming
 * it sends a reader to optimize a pass that measures in single-digit
 * milliseconds. Below the half share the cause is genuinely unknown and the
 * line says so, carrying `topPhase` and `phaseMs` as the evidence that rules
 * that phase OUT.
 *
 * PARKED AT REST. A tick that runs between two of Bun's idle collections keeps that collector at
 * one collection a second, so after `parkAfterMs` of ticks that saw neither a block nor busy CPU
 * the watchdog parks on `activity`: it arms no tick, the stack sampler drops to its parked
 * interval, and the next reported keystroke or frame arms the next tick. A stall that begins while
 * the watchdog is parked and reports no work until it ends is not detected. A stall in the work
 * that woke it is, since that tick was armed before the work ran.
 *
 * The handle is `unref`'d so the probe never keeps the process alive, and stop()
 * cancels the armed timer and drops a parked wake. The `#generation` guard remains
 * as a fallback for injected handles that cannot cancel.
 */
export class LoopWatchdog {
	#intervalMs: number;
	#thresholdMs: number;
	#now: () => number;
	#schedule: (cb: () => void, ms: number) => LoopWatchdogTimer;
	#cpuUsage: () => { user: number; system: number };
	#expected = 0;
	#wasBlocked = false;
	#running = false;
	// Bumped by stop(); each scheduled tick captures the generation it was armed
	// under and no-ops if it no longer matches, so a start()→stop()→start() cycle
	// cannot leave the pre-stop timer chain rescheduling itself in parallel.
	#generation = 0;
	#handle: LoopWatchdogTimer | undefined;
	/** CPU consumed when the armed tick's interval began, in microseconds. */
	#cpuAtArm = 0;
	/** When the armed tick's interval began. A block's stacks are read from here to the late tick. */
	#armedAtMs = 0;
	#stacks: StallStackSource | undefined;
	#parkAfterMs: number;
	#activity: ActivitySignal;
	/** The last tick that saw a block or busy CPU, or the start or wake that followed rest. */
	#quietSinceMs = 0;
	#parked = false;
	/** Arms the next tick once work is reported after the watchdog parked. */
	#wake = (): void => {
		if (!this.#parked) return;
		this.#parked = false;
		this.#quietSinceMs = this.#now();
		// The phases recorded while parked belong to no interval the next tick measures.
		takeLoopPhaseProfile();
		this.#armTick();
	};

	constructor(options: LoopWatchdogOptions = {}) {
		this.#intervalMs = options.intervalMs ?? 250;
		this.#thresholdMs = options.thresholdMs ?? 250;
		this.#now = options.now ?? (() => performance.now());
		this.#schedule = options.schedule ?? rearmingTimeout();
		this.#cpuUsage = options.cpuUsage ?? (() => process.cpuUsage());
		this.#stacks = options.stacks;
		this.#parkAfterMs = options.parkAfterMs ?? 10_000;
		this.#activity = options.activity ?? processActivity;
	}

	start(): void {
		if (this.#running) return;
		this.#running = true;
		this.#wasBlocked = false;
		this.#quietSinceMs = this.#now();
		this.#armTick();
	}

	stop(): void {
		this.#running = false;
		this.#wasBlocked = false;
		this.#generation++;
		this.#handle?.cancel?.();
		this.#handle = undefined;
		this.#parked = false;
		this.#activity.unpark(this.#wake);
	}

	#armTick(): void {
		const generation = this.#generation;
		this.#armedAtMs = this.#now();
		this.#expected = this.#armedAtMs + this.#intervalMs;
		const cpu = this.#cpuUsage();
		this.#cpuAtArm = cpu.user + cpu.system;
		this.#handle = this.#schedule(() => this.#tick(generation), this.#intervalMs);
		this.#handle.unref?.();
	}

	#tick(generation: number): void {
		if (!this.#running || generation !== this.#generation) return;
		const now = this.#now();
		const blockedMs = now - this.#expected;
		const cpu = this.#cpuUsage();
		// Microseconds since this tick was armed. The interval the process had to
		// run in is `intervalMs + blockedMs`, so CPU is compared against the
		// overshoot it would have to account for.
		const cpuMs = (cpu.user + cpu.system - this.#cpuAtArm) / 1000;
		// Consume the profile every tick (block or not) so attribution is scoped to
		// the just-elapsed interval and never carries a stale phase forward to a
		// later, phase-less block.
		const profile = takeLoopPhaseProfile();
		if (blockedMs > this.#thresholdMs) {
			this.#quietSinceMs = now;
			if (!this.#wasBlocked) {
				this.#wasBlocked = true;
				this.#reportBlock(blockedMs, cpuMs, profile);
			}
		} else if (!this.#quietTick(now, blockedMs, cpuMs)) {
			return;
		}
		this.#armTick();
	}

	/** Log the first late tick of a block, then the stacks sampled across its interval. */
	#reportBlock(blockedMs: number, cpuMs: number, { phase, ms }: LoopPhaseProfile): void {
		const phaseMs = Math.round(ms);
		// Half the block is the bar for calling a phase the cause. Under it the
		// phase ran and finished inside an interval something else spent, which
		// is evidence AGAINST it, so the line reports it as ruled out.
		const attributed = phase !== undefined && ms * 2 >= blockedMs;
		// The process cannot have blocked the loop with work it never ran.
		// Half the overshoot is the bar, mirroring the phase rule: below it
		// the loop was off-CPU — descheduled by a loaded host, or parked in a
		// blocking syscall — and that is a fact about the machine, not a
		// defect, so it is recorded rather than warned about.
		//
		// `process.cpuUsage` is the whole process, every thread of it, and
		// this process runs threads that are not the loop: the JS eval kernel
		// and each browser tab supervisor. One thread cannot burn more CPU
		// than the wall time it spanned — measured, a pinned thread reports
		// 1.013 of it — so a figure above that bound proves another thread
		// ran, and the number then says nothing about whether the LOOP did.
		// Attributing it anyway would warn about host jitter for as long as a
		// worker is busy, which is the false alarm this split exists to end.
		const elapsedMs = this.#intervalMs + blockedMs;
		const loopThreadOnly = cpuMs <= elapsedMs * SINGLE_THREAD_CPU_RATIO;
		const ranTheBlock = loopThreadOnly && cpuMs * 2 >= blockedMs;
		const line = {
			blockedMs: Math.round(blockedMs),
			cpuMs: Math.round(cpuMs),
			phase: attributed ? phase : "unknown",
			phaseMs,
			...(attributed ? {} : { topPhase: phase ?? "none" }),
			...(loopThreadOnly ? {} : { cpuThreads: "multiple" }),
		};
		const log = ranTheBlock ? logger.warn : logger.debug;
		log("ui.loop-blocked", line);
		// The stall began somewhere after this interval was armed, possibly before its
		// deadline, so the whole interval is read. The samples arrive once the profiler has
		// answered, which is after the loop came back, so this line follows the block line.
		void this.#stacks?.stacksBetween(this.#armedAtMs, this.#now()).then(stacks => {
			if (stacks) log("ui.loop-blocked.stack", { blockedMs: line.blockedMs, ...stacks });
		});
	}

	/**
	 * Report an on-time tick's CPU share to the stack sampler and park after `parkAfterMs` of
	 * quiet ticks. False when the watchdog parked and no tick is to be armed.
	 */
	#quietTick(now: number, blockedMs: number, cpuMs: number): boolean {
		this.#wasBlocked = false;
		// The sampler drops to its idle interval while the process does no work, so each quiet
		// tick reports whether the interval's CPU went over an idle share of its wall time.
		const busy = cpuMs > (this.#intervalMs + blockedMs) * BUSY_CPU_RATIO;
		this.#stacks?.quiet(now, busy);
		if (busy) {
			this.#quietSinceMs = now;
		} else if (now - this.#quietSinceMs >= this.#parkAfterMs && this.#activity.park(this.#wake)) {
			this.#parked = true;
			this.#stacks?.park();
			return false;
		}
		return true;
	}
}
