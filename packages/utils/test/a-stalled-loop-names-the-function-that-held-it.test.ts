import { afterEach, describe, expect, test, vi } from "bun:test";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { logger } from "@veyyon/utils";
import { LoopWatchdog } from "@veyyon/utils/loop-watchdog";
import { parseProfile, StallSampler, type StallStacks, summarizeWindow } from "@veyyon/utils/stall-sampler";

/**
 * WHY THIS SUITE EXISTS. The loop watchdog reported every long terminal freeze as
 * `phase: "unknown"`: it names a cause only when one of four instrumented spans covered the block,
 * and a promise continuation, a parser or a session write is none of them. Months of local logs
 * held blocks of 22s and 41s with no cause at all, which left the freeze impossible to fix. A
 * block is now followed by the JavaScript stacks JSC's sampling profiler recorded inside it.
 *
 * THE CLASS. A stall whose cause the log cannot state. The end-to-end case drives the real
 * watchdog and the real profiler through a real synchronous stall and requires the line to name
 * the function that held the loop; the window cases require that samples outside the block are
 * not blamed for it and that a rotation bounds what the profiler holds; the parse cases require
 * that profiler output the sampler does not understand reads as none instead of throwing inside
 * the watchdog's tick.
 *
 * WHAT IT DOES NOT CATCH. Time the loop spent outside JavaScript — a garbage collection the
 * engine ran on its own, a synchronous native call, the host descheduling the process — records
 * no samples. The line then reports `samples: 0`, which says the stall was not JavaScript, and
 * does not say what it was.
 */

/** Holds the loop. The name is what the stack line must report. */
function holdTheLoopForMs(ms: number): number {
	const until = performance.now() + ms;
	let x = 0;
	while (performance.now() < until) x += Math.sqrt(x + 1);
	return x;
}

/** A second holder, so a window case can tell two stretches of work apart. */
function holdTheLoopElsewhereForMs(ms: number): number {
	const until = performance.now() + ms;
	let x = 1;
	while (performance.now() < until) x = (x * 1.000001) % 1e9;
	return x;
}

function framesOf(stacks: StallStacks | undefined): string[] {
	return (stacks?.self ?? []).map(entry => entry.frame);
}

const samplers: StallSampler[] = [];
function newSampler(): StallSampler {
	const sampler = new StallSampler();
	samplers.push(sampler);
	return sampler;
}

afterEach(async () => {
	vi.restoreAllMocks();
	// Stop every sampler's profile: the profiler is process-global and the next test starts its own.
	for (const sampler of samplers.splice(0)) await sampler.borrow();
});

describe("a stalled loop names the function that held it", () => {
	test("a synchronous stall is followed by a stack line naming the function that held the loop", async () => {
		const lines: Array<{ event: string; ctx: Record<string, unknown> }> = [];
		const capture = ((event: string, ctx: Record<string, unknown>) => {
			lines.push({ event, ctx });
		}) as never;
		vi.spyOn(logger, "warn").mockImplementation(capture);
		vi.spyOn(logger, "debug").mockImplementation(capture);

		const sampler = newSampler();
		const watchdog = new LoopWatchdog({ intervalMs: 50, thresholdMs: 100, stacks: sampler });
		watchdog.start();
		try {
			// Quiet ticks start the sampler; reading once waits until the start has settled.
			await sleep(200);
			await sampler.stacksBetween(0, 0);

			holdTheLoopForMs(600);

			const deadline = performance.now() + 5000;
			while (!lines.some(line => line.event === "ui.loop-blocked.stack") && performance.now() < deadline) {
				await sleep(20);
			}
		} finally {
			watchdog.stop();
		}

		const events = lines.map(line => line.event).filter(event => event.startsWith("ui.loop-blocked"));
		expect(events).toEqual(["ui.loop-blocked", "ui.loop-blocked.stack"]);
		const block = lines.find(line => line.event === "ui.loop-blocked")!.ctx;
		const stack = lines.find(line => line.event === "ui.loop-blocked.stack")!.ctx;
		expect(stack.blockedMs).toBe(block.blockedMs);
		// 600ms at a 10ms interval is 60 samples; a loaded host still records well over half.
		expect(stack.samples).toBeGreaterThanOrEqual(30);
		const self = stack.self as StallStacks["self"];
		expect(self[0]!.frame.startsWith("holdTheLoopForMs")).toBe(true);
		expect((stack.stack as string[]).some(frame => frame.startsWith("holdTheLoopForMs"))).toBe(true);
	});

	test("the stack line is logged at the level of the block it explains", async () => {
		const warnings: string[] = [];
		const debugs: string[] = [];
		vi.spyOn(logger, "warn").mockImplementation(((event: string) => void warnings.push(event)) as never);
		vi.spyOn(logger, "debug").mockImplementation(((event: string) => void debugs.push(event)) as never);
		const stacks: StallStacks = { samples: 0, self: [], stack: [] };
		let nowValue = 0;
		let scheduled: (() => void) | undefined;
		const watchdog = new LoopWatchdog({
			now: () => nowValue,
			schedule: cb => {
				scheduled = cb;
				return {};
			},
			// The loop was never given the CPU: the block is recorded at debug, not warned about.
			cpuUsage: () => ({ user: 0, system: 0 }),
			stacks: { quiet: () => {}, stacksBetween: async () => stacks, park: () => {} },
		});
		watchdog.start();
		nowValue = 900;
		scheduled!();
		await sleep(0);
		watchdog.stop();

		expect(warnings).toEqual([]);
		expect(debugs).toEqual(["ui.loop-blocked", "ui.loop-blocked.stack"]);
	});

	test("a block reads its whole interval, and only quiet ticks drive the sampler", async () => {
		vi.spyOn(logger, "warn").mockImplementation((() => {}) as never);
		vi.spyOn(logger, "debug").mockImplementation((() => {}) as never);
		const windows: Array<[number, number]> = [];
		const quietAt: number[] = [];
		let nowValue = 0;
		let scheduled: (() => void) | undefined;
		const watchdog = new LoopWatchdog({
			now: () => nowValue,
			schedule: cb => {
				scheduled = cb;
				return {};
			},
			cpuUsage: () => ({ user: nowValue * 1000, system: 0 }),
			stacks: {
				quiet: nowMs => void quietAt.push(nowMs),
				park: () => {},
				stacksBetween: async (fromMs, toMs) => {
					windows.push([fromMs, toMs]);
					return undefined;
				},
			},
		});
		watchdog.start(); // armed at 0, due at 250
		nowValue = 260; // on time
		scheduled!(); // armed at 260, due at 510
		nowValue = 2000; // 1490ms late
		scheduled!(); // armed at 2000, due at 2250
		nowValue = 3000; // still late: the same block, not a new one
		scheduled!();
		watchdog.stop();

		expect(quietAt).toEqual([260]);
		expect(windows).toEqual([[260, 2000]]);
	});

	test("samples outside the window are not blamed for the block", async () => {
		const sampler = newSampler();
		sampler.quiet(performance.now(), true);
		await sampler.stacksBetween(0, 0);

		holdTheLoopElsewhereForMs(250);
		const from = performance.now();
		holdTheLoopForMs(250);
		const to = performance.now();
		const stacks = await sampler.stacksBetween(from, to);

		const frames = framesOf(stacks);
		expect(frames[0]!.startsWith("holdTheLoopForMs")).toBe(true);
		expect(frames.some(frame => frame.startsWith("holdTheLoopElsewhereForMs"))).toBe(false);
	});

	test("a quiet tick keeps a profile younger than the rotation and discards an older one", async () => {
		const sampler = newSampler();
		sampler.quiet(performance.now(), true);
		await sampler.stacksBetween(0, 0);

		holdTheLoopForMs(200);
		sampler.quiet(performance.now() + 1_000, true);
		const kept = await sampler.stacksBetween(0, performance.now());
		expect(framesOf(kept)[0]!.startsWith("holdTheLoopForMs")).toBe(true);

		holdTheLoopForMs(200);
		sampler.quiet(performance.now() + 60_000, true);
		const rotated = await sampler.stacksBetween(0, performance.now());
		expect(rotated?.samples).toBe(0);
	});

	test("a lent sampler neither samples nor rotates until it is given back", async () => {
		const sampler = newSampler();
		sampler.quiet(performance.now(), true);
		await sampler.stacksBetween(0, 0);

		const giveBack = await sampler.borrow();
		sampler.quiet(performance.now() + 60_000, true);
		expect(await sampler.stacksBetween(0, performance.now())).toBeUndefined();

		giveBack();
		// The restart is queued behind the give-back; a read settles it before the loop is held.
		await sampler.stacksBetween(0, 0);
		holdTheLoopForMs(200);
		expect(framesOf(await sampler.stacksBetween(0, performance.now()))[0]!.startsWith("holdTheLoopForMs")).toBe(true);
	});
});

describe("profiler output", () => {
	const origin = performance.timeOrigin * 1000;
	/** Root → outer → inner, with `inner` as the leaf the samples land on. */
	const profile = {
		profile: {
			startTime: origin,
			nodes: [
				{ id: 1, callFrame: { functionName: "(root)", url: "", lineNumber: -1 }, children: [2] },
				{ id: 2, callFrame: { functionName: "outer", url: "/src/a/session.ts", lineNumber: 9 }, children: [3, 4] },
				{ id: 3, callFrame: { functionName: "inner", url: "/src/a/parse.ts", lineNumber: 41 } },
				{ id: 4, callFrame: { functionName: "", url: "/src/a/parse.ts", lineNumber: 99 } },
			],
			// Sample times in ms after timeOrigin: 10, 20, 30, 40, 50.
			samples: [3, 3, 4, 3, 2],
			timeDeltas: [10_000, 10_000, 10_000, 10_000, 10_000],
		},
	};

	test("a window counts the samples inside it and reports the hottest path outermost first", () => {
		const parsed = parseProfile(profile)!;
		expect(summarizeWindow(parsed, 15, 45)).toEqual({
			samples: 3,
			self: [
				{ frame: "inner parse.ts:42", samples: 2 },
				{ frame: "(anonymous) parse.ts:100", samples: 1 },
			],
			stack: ["outer session.ts:10", "inner parse.ts:42"],
		});
		expect(summarizeWindow(parsed, 60, 90)).toEqual({ samples: 0, self: [], stack: [] });
	});

	test("output that is not a well-formed profile reads as none", () => {
		for (const bad of [
			undefined,
			null,
			"profile",
			{},
			{ profile: {} },
			{ profile: { ...profile.profile, samples: [3] } },
			{ profile: { ...profile.profile, timeDeltas: ["10"] as unknown as number[] } },
			{ profile: { ...profile.profile, nodes: [{ callFrame: {} }] } },
		]) {
			expect(parseProfile(bad)).toBeUndefined();
		}
	});
});
