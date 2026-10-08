import { afterEach, describe, expect, test } from "bun:test";
import { performance } from "node:perf_hooks";
import { BUSY_CPU_RATIO } from "@veyyon/utils/idle-trim";
import { LoopWatchdog } from "@veyyon/utils/loop-watchdog";
import { StallSampler } from "@veyyon/utils/stall-sampler";

/**
 * WHY THIS SUITE EXISTS. JSC's sampling profiler thread wakes at its sampling interval whether or
 * not JavaScript runs, and the sampler restarted its profile every 10s. An idle session therefore
 * woke 100 times a second for the sampler's thread and about 80 times a second for the collector's
 * helper threads the restarts woke, measured on the shipped binary: 13,087 wakeups over 60 idle
 * seconds, 5,972 of them the profiler's thread and 5,800 the helpers.
 *
 * THE CLASS. A sampler that keeps its busy cost while the process does nothing. The cases drive the
 * real profiler and read its samples back: a profile started after 10s without a busy tick samples
 * at the idle interval, one busy tick restores the busy interval at once, a process that worked
 * inside the idle stretch keeps the busy interval through a rotation, the boundary of the idle
 * stretch falls on 10s exactly, and a profile is replaced once it could hold 1,000 samples, which
 * is 10s at the busy interval and 100s at the idle one. A parked sampler samples once a second, and
 * the first quiet tick after the watchdog wakes restores the idle interval. The watchdog cases pin
 * what a quiet tick reports as busy: CPU over `BUSY_CPU_RATIO` of the wall time the tick's interval
 * spanned.
 *
 * WHAT IT DOES NOT CATCH. The wakeup counts themselves are a property of the engine's profiler
 * thread and are measured on the binary, not here. Sample counts read the interval: a held loop of
 * 500ms records about 50 samples at 10ms and about 5 at 100ms, and the bounds below sit far enough
 * from both that a loaded host does not move a case across them.
 */

/** Holds the loop so the profiler records samples. */
function holdTheLoopForMs(ms: number): number {
	const until = performance.now() + ms;
	let x = 0;
	while (performance.now() < until) x += Math.sqrt(x + 1);
	return x;
}

/** At most this many samples land in a 500ms hold at the 100ms idle interval. */
const IDLE_MAX = 10;
/** At least this many samples land in a 500ms hold at the 10ms busy interval. */
const BUSY_MIN = 25;
/** At most this many samples land in a 2s hold at the 1s parked interval. */
const PARKED_MAX = 3;
/** At least this many land in a 2s hold that starts inside a parked wait and ends at the idle interval. */
const RESTORED_MIN = 6;

const samplers: StallSampler[] = [];

/** A running sampler, started by a busy tick at `nowMs`, its start settled. */
async function startedSampler(nowMs: number): Promise<StallSampler> {
	const sampler = new StallSampler();
	samplers.push(sampler);
	sampler.quiet(nowMs, true);
	await sampler.stacksBetween(0, 0);
	return sampler;
}

/**
 * Settles every queued restart, holds the loop for `holdMs` and returns the samples the profile
 * recorded inside the hold. Reading restarts the profile at the interval it had.
 */
async function samplesInHold(sampler: StallSampler, holdMs = 500): Promise<number> {
	await sampler.stacksBetween(0, 0);
	const from = performance.now();
	holdTheLoopForMs(holdMs);
	const stacks = await sampler.stacksBetween(from, performance.now());
	if (!stacks) throw new Error("the sampler is not running");
	return stacks.samples;
}

/** Drives `sampler` into the idle interval: a quiet tick 10s past its last busy tick, with its profile full. */
async function idleSampler(): Promise<StallSampler> {
	const busyAt = performance.now();
	const sampler = await startedSampler(busyAt);
	sampler.quiet(Math.max(busyAt, performance.now()) + 10_000, false);
	await sampler.stacksBetween(0, 0);
	return sampler;
}

afterEach(async () => {
	// The profiler is process-global; stop every sampler's profile before the next case starts its own.
	for (const sampler of samplers.splice(0)) await sampler.borrow();
});

describe("an idle process samples its stack ten times less often", () => {
	test("a sampler that starts samples at the busy interval", async () => {
		const sampler = await startedSampler(performance.now());
		expect(await samplesInHold(sampler)).toBeGreaterThanOrEqual(BUSY_MIN);
	});

	test("the first rotation 10s after the last busy tick restarts at the idle interval", async () => {
		const sampler = await idleSampler();
		const samples = await samplesInHold(sampler);
		expect(samples).toBeGreaterThan(0);
		expect(samples).toBeLessThanOrEqual(IDLE_MAX);
	});

	test("a process idle past the stretch keeps the busy interval until its profile is full", async () => {
		// The last busy tick was 20s ago; the profile restarted when the start settled.
		const sampler = await startedSampler(performance.now() - 20_000);
		sampler.quiet(performance.now() + 5_000, false);
		// The profile was not full, so going idle queued no restart: the hold runs on the busy profile.
		const from = performance.now();
		holdTheLoopForMs(500);
		const stacks = await sampler.stacksBetween(from, performance.now());
		expect(stacks?.samples).toBeGreaterThanOrEqual(BUSY_MIN);
	});

	test("one busy tick restores the busy interval without waiting for a rotation", async () => {
		const sampler = await idleSampler();
		sampler.quiet(performance.now(), true);
		expect(await samplesInHold(sampler)).toBeGreaterThanOrEqual(BUSY_MIN);
	});

	test("a process that worked inside the idle stretch keeps the busy interval through a rotation", async () => {
		const started = performance.now();
		const sampler = await startedSampler(started);
		const workedAt = performance.now() + 5_000;
		sampler.quiet(workedAt, true);
		// The profile is full 10s after it started; the work was 7s before this tick.
		sampler.quiet(workedAt + 7_000, false);
		expect(await samplesInHold(sampler)).toBeGreaterThanOrEqual(BUSY_MIN);
	});

	test("the idle stretch ends at 10s exactly", async () => {
		// Far enough ahead that every tick below finds the profile full.
		const busyAt = Math.ceil(performance.now()) + 1_000_000;
		const sampler = await startedSampler(busyAt);

		sampler.quiet(busyAt + 9_999, false);
		expect(await samplesInHold(sampler)).toBeGreaterThanOrEqual(BUSY_MIN);

		sampler.quiet(busyAt + 10_000, false);
		expect(await samplesInHold(sampler)).toBeLessThanOrEqual(IDLE_MAX);
	});

	test("an idle-interval profile is kept until it could hold 1,000 samples, 100s, and replaced after", async () => {
		const sampler = await idleSampler();

		holdTheLoopForMs(500);
		sampler.quiet(performance.now() + 95_000, false);
		const kept = await sampler.stacksBetween(0, performance.now());
		expect(kept?.samples).toBeGreaterThan(0);

		// Reading restarted the profile at the idle interval.
		holdTheLoopForMs(500);
		sampler.quiet(performance.now() + 100_000, false);
		const rotated = await sampler.stacksBetween(0, performance.now());
		expect(rotated?.samples).toBe(0);
		expect(await samplesInHold(sampler)).toBeLessThanOrEqual(IDLE_MAX);
	});

	test("a busy-interval profile is replaced once it could hold 1,000 samples, 10s", async () => {
		const sampler = await startedSampler(performance.now());

		holdTheLoopForMs(300);
		sampler.quiet(performance.now() + 8_000, true);
		expect((await sampler.stacksBetween(0, performance.now()))?.samples).toBeGreaterThan(0);

		holdTheLoopForMs(300);
		sampler.quiet(performance.now() + 10_000, true);
		expect((await sampler.stacksBetween(0, performance.now()))?.samples).toBe(0);
	});

	test("a parked sampler samples once a second", async () => {
		const sampler = await idleSampler();
		sampler.park();
		// The thread finishes its 100ms wait, then waits a second per sample.
		expect(await samplesInHold(sampler, 2_000)).toBeLessThanOrEqual(PARKED_MAX);
	});

	test("the first quiet tick after a park restores the idle interval", async () => {
		const sampler = await idleSampler();
		sampler.park();
		await sampler.stacksBetween(0, 0);
		sampler.quiet(performance.now() + 20_000, false);
		// The thread applies the idle interval when its parked wait ends, at most a second in.
		expect(await samplesInHold(sampler, 2_000)).toBeGreaterThanOrEqual(RESTORED_MIN);
	});
});

describe("what a quiet tick reports as busy", () => {
	test("CPU over the busy share of the tick's whole elapsed interval is busy, and at it is idle", () => {
		const reports: Array<[number, boolean]> = [];
		let nowValue = 0;
		let cpuMs = 0;
		let scheduled: (() => void) | undefined;
		const watchdog = new LoopWatchdog({
			now: () => nowValue,
			schedule: cb => {
				scheduled = cb;
				return {};
			},
			cpuUsage: () => ({ user: cpuMs * 1000, system: 0 }),
			stacks: {
				quiet: (nowMs, busy) => void reports.push([nowMs, busy]),
				stacksBetween: async () => undefined,
				park: () => {},
			},
		});
		watchdog.start(); // armed at 0, due at 250
		nowValue = 250;
		cpuMs += 250 * BUSY_CPU_RATIO; // at the share
		scheduled!();
		nowValue = 500;
		cpuMs += 250 * BUSY_CPU_RATIO + 1; // one millisecond over
		scheduled!();
		// 150ms late, under the block threshold: the share is of the 400ms the interval spanned, not of 250.
		nowValue = 900;
		cpuMs += 400 * BUSY_CPU_RATIO;
		scheduled!();
		nowValue = 1150;
		scheduled!(); // no CPU at all
		watchdog.stop();

		expect(reports).toEqual([
			[250, false],
			[500, true],
			[900, false],
			[1150, false],
		]);
	});
});
