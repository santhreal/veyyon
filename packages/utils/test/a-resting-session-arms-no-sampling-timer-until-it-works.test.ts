import { afterEach, describe, expect, test, vi } from "bun:test";
import { logger } from "@veyyon/utils";
import { ActivitySignal } from "@veyyon/utils/activity-signal";
import { IdleTrim } from "@veyyon/utils/idle-trim";
import { LoopWatchdog } from "@veyyon/utils/loop-watchdog";

/**
 * WHY THIS SUITE EXISTS. Bun's idle collector runs a collection every second until the heap holds
 * still across 30 of them, and any JavaScript that runs between two collections moves the heap. The
 * loop watchdog ticked every 250ms and the idle trim sampled every 5s for the whole life of an
 * interactive session, so a session at rest never let the collector slow down: 3,617 thread
 * wakeups in 30s on the linux-x64 binary, 2,738 of them the collector's helper threads.
 *
 * THE CLASS. A periodic sampler that keeps a timer armed while the session it watches does nothing.
 * Each sampler is driven through the same contract on an injected clock, CPU counter, timer and
 * signal: with a host attached it parks after its quiet stretch and arms nothing; one reported piece
 * of work arms exactly one timer; a quiet wake parks again; work holds parking off and restarts the
 * quiet stretch; without a host it never parks, since nothing would report the work that wakes it;
 * stop() drops a parked wake; the last host leaving wakes every parked sampler. The watchdog cases
 * add that a block restarts the quiet stretch, that a stall inside the work that woke it is still
 * logged and that its stack source parks with it; the trim case adds that work reported after a
 * trim lets the next quiet stretch trim again.
 *
 * WHAT IT DOES NOT CATCH. The `SAMPLERS` table is written by hand: a new sampler that should park
 * joins this suite by a row, and nothing fails until one is added. The engine's reports of its
 * keystrokes and frames are pinned in the terminal engine's own suite. The wakeup counts are
 * measured on the binary.
 */

interface Armed {
	cb: () => void;
	ms: number;
	fired: boolean;
	cancelled: boolean;
}

interface Env {
	activity: ActivitySignal;
	now: () => number;
	cpuUsage: () => { user: number; system: number };
	schedule: (cb: () => void, ms: number) => { unref(): void; cancel(): void };
}

interface Sampler {
	start(): void;
	stop(): void;
}

interface SamplerRow {
	name: string;
	make(env: Env): Sampler;
	/** Quiet periods it fires, from start(), before the one that parks. */
	periodsBeforeRest: number;
	/** Quiet periods it fires after a quiet wake before the one that parks again. */
	periodsBeforeRestAgain: number;
}

function idleTrim(env: Env, trim: () => void = () => {}): IdleTrim {
	return new IdleTrim({ ...env, quietMs: 30_000, sampleMs: 5_000, busyCpuRatio: 0.05, trim });
}

const SAMPLERS: SamplerRow[] = [
	{
		name: "the loop watchdog",
		// 250ms ticks; the tick that lands 10s after the start parks, and 10s after a wake.
		make: env => new LoopWatchdog({ ...env, intervalMs: 250, thresholdMs: 250, parkAfterMs: 10_000 }),
		periodsBeforeRest: 39,
		periodsBeforeRestAgain: 39,
	},
	{
		name: "the idle trim",
		// 5s windows: the sixth trims, the seventh holds the trim's own collection, the eighth parks.
		// After a quiet wake the process is still trimmed, so the first window parks again.
		make: env => idleTrim(env),
		periodsBeforeRest: 7,
		periodsBeforeRestAgain: 0,
	},
];

const started: Sampler[] = [];

/** A started sampler on an injected clock, CPU counter and timer, with `hosts` attached to its signal. */
class Rig {
	readonly activity = new ActivitySignal();
	readonly armed: Armed[] = [];
	readonly detach: Array<() => void>;
	readonly sampler: Sampler;
	#row: SamplerRow;
	#nowMs = 0;
	#cpuMs = 0;

	constructor(row: SamplerRow, hosts = 1) {
		this.#row = row;
		this.detach = Array.from({ length: hosts }, () => this.activity.attachHost());
		this.sampler = row.make({
			activity: this.activity,
			now: () => this.#nowMs,
			cpuUsage: () => ({ user: this.#cpuMs * 1000, system: 0 }),
			schedule: (cb, ms) => {
				const entry: Armed = { cb, ms, fired: false, cancelled: false };
				this.armed.push(entry);
				return {
					unref: () => {},
					cancel: () => {
						entry.cancelled = true;
					},
				};
			},
		});
		this.sampler.start();
		started.push(this.sampler);
	}

	live(): Armed[] {
		return this.armed.filter(entry => !entry.fired && !entry.cancelled);
	}

	/** Fires the one armed timer after its full delay, with `busyShare` of that delay spent on CPU. */
	period(busyShare = 0): void {
		const timers = this.live();
		if (timers.length !== 1) throw new Error(`expected one armed timer, found ${timers.length}`);
		const timer = timers[0];
		this.advance(timer.ms, timer.ms * busyShare);
		timer.fired = true;
		timer.cb();
	}

	/** Fires `count` quiet periods, each leaving one timer armed. */
	quietPeriods(count: number): void {
		for (let i = 0; i < count; i++) {
			this.period();
			expect(this.live()).toHaveLength(1);
		}
	}

	/** Drives the sampler from its start to rest: its quiet stretch, then the period that parks it. */
	rest(): void {
		this.quietPeriods(this.#row.periodsBeforeRest);
		this.period();
		expect(this.live()).toHaveLength(0);
	}

	advance(ms: number, spentMs: number): void {
		this.#nowMs += ms;
		this.#cpuMs += spentMs;
	}
}

afterEach(() => {
	for (const sampler of started.splice(0)) sampler.stop();
	vi.restoreAllMocks();
});

describe.each(SAMPLERS)("$name", row => {
	test("with a host attached it parks after its quiet stretch and arms nothing", () => {
		const rig = new Rig(row);
		// The period before the parking one still arms a timer: the stretch ends at its boundary.
		rig.quietPeriods(row.periodsBeforeRest);
		const armedBefore = rig.armed.length;
		rig.period();
		expect(rig.live()).toHaveLength(0);
		expect(rig.armed.length).toBe(armedBefore);
	});

	test("one reported piece of work arms one timer, however many reports follow", () => {
		const rig = new Rig(row);
		rig.rest();
		const armedBefore = rig.armed.length;
		rig.activity.report();
		rig.activity.report();
		expect(rig.live()).toHaveLength(1);
		expect(rig.armed.length).toBe(armedBefore + 1);
	});

	test("a quiet wake parks again after its own quiet stretch", () => {
		const rig = new Rig(row);
		rig.rest();
		rig.activity.report();
		rig.quietPeriods(row.periodsBeforeRestAgain);
		rig.period();
		expect(rig.live()).toHaveLength(0);
	});

	test("work holds parking off", () => {
		const rig = new Rig(row);
		for (let i = 0; i < (row.periodsBeforeRest + 1) * 3; i++) {
			rig.period(1);
			expect(rig.live()).toHaveLength(1);
		}
	});

	test("work restarts the quiet stretch, so the first quiet period after it does not park", () => {
		const rig = new Rig(row);
		rig.quietPeriods(row.periodsBeforeRest);
		rig.period(1);
		rig.quietPeriods(row.periodsBeforeRest);
		rig.period();
		expect(rig.live()).toHaveLength(0);
	});

	test("with no host attached it keeps its timer through rest", () => {
		const rig = new Rig(row, 0);
		rig.quietPeriods((row.periodsBeforeRest + 1) * 3);
	});

	test("stop() while parked drops the wake, and start() arms afresh", () => {
		const rig = new Rig(row);
		rig.rest();
		rig.sampler.stop();
		const armedBefore = rig.armed.length;
		rig.activity.report();
		expect(rig.armed.length).toBe(armedBefore);
		rig.sampler.start();
		expect(rig.live()).toHaveLength(1);
	});

	test("the last host leaving wakes it, and with no host it keeps ticking", () => {
		const rig = new Rig(row, 2);
		rig.rest();
		rig.detach[0]();
		expect(rig.live()).toHaveLength(0);
		// Detaching twice is one host leaving, not the last one.
		rig.detach[0]();
		expect(rig.live()).toHaveLength(0);
		rig.detach[1]();
		expect(rig.live()).toHaveLength(1);
		rig.quietPeriods((row.periodsBeforeRest + 1) * 2);
	});
});

describe("the loop watchdog at rest", () => {
	test("a block restarts the quiet stretch", () => {
		vi.spyOn(logger, "debug").mockImplementation((() => {}) as never);
		const rig = new Rig(SAMPLERS[0]);
		rig.quietPeriods(SAMPLERS[0].periodsBeforeRest);
		// The loop came back a second late, off the CPU: a block, recorded at debug.
		rig.advance(1_000, 0);
		rig.quietPeriods(1);
		rig.quietPeriods(SAMPLERS[0].periodsBeforeRest);
		rig.period();
		expect(rig.live()).toHaveLength(0);
	});

	test("a stall in the work that woke it is logged", () => {
		const warnings: string[] = [];
		vi.spyOn(logger, "warn").mockImplementation(((event: string) => void warnings.push(event)) as never);
		vi.spyOn(logger, "debug").mockImplementation((() => {}) as never);
		const rig = new Rig(SAMPLERS[0]);
		rig.rest();
		rig.activity.report();
		// The reported keystroke holds the loop on the CPU for a second before the tick can run.
		rig.advance(1_000, 1_000);
		rig.period(1);
		expect(warnings).toEqual(["ui.loop-blocked"]);
	});

	test("its stack source parks with it and hears the first tick after the wake", () => {
		const events: string[] = [];
		const activity = new ActivitySignal();
		activity.attachHost();
		let nowMs = 0;
		let tick: (() => void) | undefined;
		const watchdog = new LoopWatchdog({
			activity,
			parkAfterMs: 500,
			now: () => nowMs,
			cpuUsage: () => ({ user: 0, system: 0 }),
			schedule: cb => {
				tick = cb;
				return {};
			},
			stacks: {
				quiet: (_nowMs, busy) => void events.push(`quiet:${busy}`),
				stacksBetween: async () => undefined,
				park: () => void events.push("park"),
			},
		});
		watchdog.start();
		started.push(watchdog);
		for (const at of [250, 500]) {
			nowMs = at;
			tick?.();
		}
		expect(events).toEqual(["quiet:false", "quiet:false", "park"]);
		nowMs = 60_000;
		activity.report();
		nowMs = 60_250;
		tick?.();
		expect(events).toEqual(["quiet:false", "quiet:false", "park", "quiet:false"]);
	});
});

describe("the idle trim at rest", () => {
	test("work reported after a trim lets the next quiet stretch trim again", () => {
		let trims = 0;
		const rig = new Rig({ ...SAMPLERS[1], make: env => idleTrim(env, () => void trims++) });
		rig.rest();
		expect(trims).toBe(1);
		rig.activity.report();
		rig.period(1);
		// The busy window restarted the quiet stretch: the sixth quiet window trims.
		rig.quietPeriods(6);
		expect(trims).toBe(2);
		// The trim's own window, then the window that parks.
		rig.quietPeriods(1);
		rig.period();
		expect(rig.live()).toHaveLength(0);
		expect(trims).toBe(2);
	});
});
