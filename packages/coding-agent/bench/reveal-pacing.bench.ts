/**
 * Reveal pacing benchmark.
 *
 * Replays provider arrival shapes on a virtual clock, with the frame timer the reveal controllers run:
 * it starts when units arrive while the reveal has caught up, ticks every `STREAMING_REVEAL_FRAME_MS`,
 * and stops on the tick that catches up. Each shape runs twice: `legacy` steps by the eighth of the
 * backlog, at least three units, that the reveal took before `RevealPacer`, and `paced` steps by
 * `RevealPacer`. Time is simulated, so every run prints the same numbers.
 *
 * Per shape, after the first second (the rate estimate's warmup) and up to the last arrival:
 * - step: units revealed per tick that revealed any, as min..max and mean;
 * - stalled: ticks that revealed nothing while units were waiting;
 * - lag: ms between a unit arriving and being revealed, mean and max over the whole stream;
 * - drain: ms from the last arrival until everything is revealed.
 *
 * Run: bun run packages/coding-agent/bench/reveal-pacing.bench.ts
 */
import { RevealPacer, STREAMING_REVEAL_FRAME_MS } from "../src/modes/terminal/controllers/streaming-reveal";

interface Pacer {
	arrive(now: number, total: number, revealed: number): void;
	step(now: number, backlog: number): number;
}

/** The step the reveal took before `RevealPacer`, which read no arrival. */
const legacyPacer = (): Pacer => ({
	arrive: () => {},
	step: (_now, backlog) => Math.min(backlog, Math.max(3, Math.ceil(backlog / 8))),
});

const FRAME = STREAMING_REVEAL_FRAME_MS;
const WARMUP_MS = 1000;

type Arrival = [gapMs: number, units: number];

function repeat(count: number, arrival: Arrival): Arrival[] {
	return Array.from({ length: count }, () => arrival);
}

/** Deterministic uniform [0, 1) sequence. */
function mulberry32(seed: number): () => number {
	let state = seed;
	return () => {
		state = (state + 0x6d2b79f5) | 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const SHAPES: Array<[name: string, arrivals: Arrival[]]> = [
	["steady 4 units / 25 ms", repeat(120, [25, 4])],
	["batches 120 units / 400 ms", repeat(10, [400, 120])],
	[
		"jitter 3-6 units / 10-70 ms",
		(() => {
			const random = mulberry32(7);
			return Array.from(
				{ length: 100 },
				(): Arrival => [10 + Math.round(random() * 60), 3 + Math.floor(random() * 4)],
			);
		})(),
	],
	["slow 4 units / 200 ms", repeat(20, [200, 4])],
	["fast 200 units / 100 ms", repeat(30, [100, 200])],
	[
		"pauses 700 ms every 500 ms",
		Array.from({ length: 4 }, (): Arrival[] => [[700, 4], ...repeat(19, [25, 4])]).flat(),
	],
	[
		"8 units / 25 ms, 90 / 300 ms in turn",
		Array.from({ length: 20 }, (): Arrival[] => [
			[25, 8],
			[300, 90],
		]).flat(),
	],
	[
		"pairs of 4 units 800 ms apart",
		Array.from({ length: 14 }, (): Arrival[] => [
			[800, 4],
			[25, 4],
		]).flat(),
	],
	["silence 1.5 s then 400 units", [...repeat(40, [40, 4]), [1500, 400], ...repeat(20, [40, 4])]],
];

interface Result {
	stepMin: number;
	stepMax: number;
	stepMean: number;
	stalled: number;
	lagMean: number;
	lagMax: number;
	drain: number;
}

function replay(shape: Arrival[], pacer: Pacer): Result {
	const arrivals: Array<[number, number]> = [];
	let at = 0;
	let total = 0;
	for (const [gap, units] of shape) {
		at += gap;
		total += units;
		arrivals.push([at, total]);
	}
	const lastArrival = at;
	const arrivedAt: number[] = [];
	for (const [time, units] of arrivals) while (arrivedAt.length < units) arrivedAt.push(time);

	let revealed = 0;
	let arrived = 0;
	let next = 0;
	let tickAt = Number.POSITIVE_INFINITY;
	const steps: number[] = [];
	let stalled = 0;
	let lagSum = 0;
	let lagMax = 0;
	let drainedAt = lastArrival;
	while (next < arrivals.length || tickAt !== Number.POSITIVE_INFINITY) {
		const arrival = arrivals[next];
		if (arrival && arrival[0] <= tickAt) {
			arrived = arrival[1];
			pacer.arrive(arrival[0], arrived, revealed);
			if (tickAt === Number.POSITIVE_INFINITY && revealed < arrived) tickAt = arrival[0] + FRAME;
			next++;
			continue;
		}
		const now = tickAt;
		const step = pacer.step(now, arrived - revealed);
		for (let unit = revealed; unit < revealed + step; unit++) {
			const lag = now - arrivedAt[unit]!;
			lagSum += lag;
			if (lag > lagMax) lagMax = lag;
		}
		revealed += step;
		if (now >= WARMUP_MS && now <= lastArrival) {
			if (step > 0) steps.push(step);
			else stalled++;
		}
		if (revealed >= arrived) {
			tickAt = Number.POSITIVE_INFINITY;
			if (next >= arrivals.length) drainedAt = now;
		} else {
			tickAt = now + FRAME;
		}
	}
	return {
		stepMin: Math.min(...steps),
		stepMax: Math.max(...steps),
		stepMean: steps.reduce((sum, step) => sum + step, 0) / steps.length,
		stalled,
		lagMean: lagSum / total,
		lagMax,
		drain: drainedAt - lastArrival,
	};
}

for (const [name, shape] of SHAPES) {
	for (const [arm, pacer] of [
		["legacy", legacyPacer()],
		["paced", new RevealPacer()],
	] as const) {
		const r = replay(shape, pacer);
		console.log(
			`${name.padEnd(36)} ${arm.padEnd(6)} step ${r.stepMin}..${r.stepMax} (mean ${r.stepMean.toFixed(1)})  stalled ${r.stalled}  lag mean ${r.lagMean.toFixed(0)} ms, max ${r.lagMax.toFixed(0)} ms  drain ${r.drain.toFixed(0)} ms`,
		);
	}
}
