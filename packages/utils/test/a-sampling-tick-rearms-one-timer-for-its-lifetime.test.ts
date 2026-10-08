import { afterEach, describe, expect, test, vi } from "bun:test";
import { spawnSync } from "node:child_process";
import { IdleTrim } from "@veyyon/utils/idle-trim";
import { LoopWatchdog } from "@veyyon/utils/loop-watchdog";
import { rearmingTimeout } from "@veyyon/utils/rearming-timeout";

/**
 * Contract: a ticker that arms its own next run on the default schedule (the loop watchdog and
 * the idle trim) creates one timeout per `start()` and re-arms it for every later tick, keeps
 * ticking, never holds the process open, and leaves no armed timer after `stop()`.
 *
 * Defect closed: both tickers created a new `setTimeout`, and a handle object and two closures
 * around it, on every tick. MEASURED on Bun 1.4.0 over a 600,000-object heap: a 250 ms tick that
 * creates a timeout kept the engine's GC timer collecting, 2,762 collector helper-thread wakeups
 * and 32 ms of CPU in 30 s at rest, against 327 wakeups and 11 ms for one re-armed timeout.
 *
 * Class: a default-scheduled ticker in this package that allocates a timer per tick, a re-armed
 * timer that loses its `unref`, a cancelled timer that fires again or never re-arms, and a
 * re-arm that keeps a stale delay or callback. The engine test counts every timeout the two
 * tickers create; the helper tests cover each branch of `rearmingTimeout`.
 *
 * Not caught: a new ticker that calls `setTimeout` itself instead of `rearmingTimeout`. The
 * engine test constructs the two tickers it imports.
 */

afterEach(() => {
	vi.useRealTimers();
});

describe("rearmingTimeout", () => {
	test("runs only the latest call's callback, at the latest call's deadline", () => {
		vi.useFakeTimers();
		const schedule = rearmingTimeout();
		const ran: string[] = [];
		schedule(() => ran.push("first"), 100);
		vi.advanceTimersByTime(60);
		schedule(() => ran.push("second"), 100);
		vi.advanceTimersByTime(60);
		expect(ran).toEqual([]);
		vi.advanceTimersByTime(40);
		expect(ran).toEqual(["second"]);
		vi.advanceTimersByTime(1_000);
		expect(ran).toEqual(["second"]);
	});

	test("a call with a different delay arms at that delay", () => {
		vi.useFakeTimers();
		const schedule = rearmingTimeout();
		let runs = 0;
		schedule(() => runs++, 100);
		vi.advanceTimersByTime(100);
		expect(runs).toBe(1);
		schedule(() => runs++, 300);
		vi.advanceTimersByTime(299);
		expect(runs).toBe(1);
		vi.advanceTimersByTime(1);
		expect(runs).toBe(2);
	});

	test("cancel disarms the timeout, and the next call arms it again", () => {
		vi.useFakeTimers();
		const schedule = rearmingTimeout();
		let runs = 0;
		schedule(() => runs++, 100).cancel();
		vi.advanceTimersByTime(500);
		expect(runs).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
		schedule(() => runs++, 100);
		vi.advanceTimersByTime(100);
		expect(runs).toBe(1);
	});
});

describe("a restarted ticker", () => {
	test("the loop watchdog leaves no timer when stopped and ticks again when restarted", () => {
		vi.useFakeTimers();
		let quietTicks = 0;
		const watchdog = new LoopWatchdog({
			now: () => Date.now(),
			cpuUsage: () => ({ user: 0, system: 0 }),
			stacks: { quiet: () => void quietTicks++, stacksBetween: async () => undefined, park: () => {} },
		});
		watchdog.start();
		vi.advanceTimersByTime(3 * 250);
		expect(quietTicks).toBe(3);
		watchdog.stop();
		expect(vi.getTimerCount()).toBe(0);
		vi.advanceTimersByTime(10 * 250);
		expect(quietTicks).toBe(3);
		watchdog.start();
		vi.advanceTimersByTime(3 * 250);
		expect(quietTicks).toBe(6);
		watchdog.stop();
	});

	test("the idle trim leaves no timer when stopped and samples again when restarted", () => {
		vi.useFakeTimers();
		const sampleMs = 5_000;
		const trims: number[] = [];
		const startedAt = Date.now();
		const idle = new IdleTrim({
			quietMs: 3 * sampleMs,
			sampleMs,
			now: () => Date.now(),
			cpuUsage: () => ({ user: 0, system: 0 }),
			trim: () => void trims.push(Date.now() - startedAt),
		});
		idle.start();
		vi.advanceTimersByTime(2 * sampleMs);
		idle.stop();
		expect(vi.getTimerCount()).toBe(0);
		vi.advanceTimersByTime(10 * sampleMs);
		expect(trims).toEqual([]);
		// The restart begins a new quiet period: the trim runs on its third window.
		idle.start();
		vi.advanceTimersByTime(3 * sampleMs);
		expect(trims).toEqual([15 * sampleMs]);
		idle.stop();
	});
});

describe("against the engine", () => {
	const watchdogUrl = import.meta.resolve("@veyyon/utils/loop-watchdog");
	const trimUrl = import.meta.resolve("@veyyon/utils/idle-trim");

	// The child runs the engine's own timers: what is under test is how Bun's `refresh()` treats a
	// timer's allocation and its `unref`, which fake timers replace.
	test("both tickers create one timeout each across many ticks and never hold the process open", () => {
		const result = spawnSync(
			process.execPath,
			[
				"-e",
				`
				const realSetTimeout = globalThis.setTimeout;
				let created = 0;
				globalThis.setTimeout = (cb, ms, ...rest) => {
					if (ms === 20) created++;
					return realSetTimeout(cb, ms, ...rest);
				};
				const { LoopWatchdog } = await import(${JSON.stringify(watchdogUrl)});
				const { IdleTrim } = await import(${JSON.stringify(trimUrl)});
				let quiet = 0;
				new LoopWatchdog({
					intervalMs: 20,
					thresholdMs: 60_000,
					stacks: { quiet: () => void quiet++, stacksBetween: async () => undefined, park: () => {} },
				}).start();
				let samples = 0;
				new IdleTrim({
					sampleMs: 20,
					quietMs: 1e9,
					cpuUsage: () => (samples++, process.cpuUsage()),
				}).start();
				realSetTimeout(() => console.log(JSON.stringify({ created, quiet, samples })), 400);
			`,
			],
			{ encoding: "utf8", timeout: 20_000 },
		);
		expect(result.stderr).toBe("");
		// A ticker whose re-armed timer lost its unref holds the child until the spawn timeout,
		// which ends it by signal with no exit status.
		expect(result.status).toBe(0);
		const { created, quiet, samples } = JSON.parse(result.stdout) as {
			created: number;
			quiet: number;
			samples: number;
		};
		expect(created).toBe(2);
		// 400 ms at a 20 ms tick is 20 ticks each; a loaded host still runs well over a quarter.
		expect(quiet).toBeGreaterThanOrEqual(5);
		// Each idle-trim window reads the CPU counter twice: once to judge it, once to arm the next.
		expect(samples).toBeGreaterThanOrEqual(10);
	}, 30_000);
});
