/**
 * WHY. A provider delivers a reply in deltas whose size and spacing vary: a steady trickle, a batch
 * every few hundred ms, jitter, fewer units than frames, a silence and then a dump. The reveal used to
 * step by a fixed share of whatever had arrived (an eighth of the backlog, at least three units, every
 * frame), so its speed followed the backlog rather than the stream: it rushed after each batch and
 * crawled before the next, a slow stream showed three units at once and then nothing for several
 * frames, and a dump after a silence took a second to drain.
 *
 * THE CLASS. Every arrival shape below, through every controller that paces a stream: assistant text
 * and streamed tool-call arguments. Once the rate is measured, no frame shows more than twice the
 * stream's rate per frame; a stream whose gaps the lead covers, regular or not, reveals on every frame
 * (one unit at a time when it is slower than a unit per frame) at no less than half its rate; no unit
 * waits more than LAG_BOUND_MS behind its arrival, with gaps up to a restart, and that holds for the
 * last arrival, after which the reveal catches up and its frame timer stops; a dump
 * after a silence starts on the next frame and is shown within the initial lead. A reveal that stood
 * still between arrivals resumes without making up for the pause, a late frame makes up for the time
 * it missed, up to four frames, a thinking block shown mid-stream is drained without being counted as
 * arriving, so the reveal returns to the stream's rate, and a stream that rewinds reveals what regrows
 * at the stream's rate.
 *
 * WHAT THIS SUITE DOES NOT CATCH. It reads what each controller hands its component, not the terminal,
 * so a reveal paced correctly and painted late passes. Gaps longer than the largest lead stall by
 * design; the patterns with such gaps are checked for lag, the step bound and termination only. A
 * controller that paces a stream without RevealPacer is outside the sweep until it is added to
 * CONTROLLERS.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import {
	RevealPacer,
	STREAMING_REVEAL_FRAME_MS,
	StreamingRevealController,
} from "@veyyon/coding-agent/modes/terminal/controllers/streaming-reveal";
import { ToolArgsRevealController } from "@veyyon/coding-agent/modes/terminal/controllers/tool-args-reveal";
import type { AssistantMessageView } from "@veyyon/wire/presentation";

const FRAME = STREAMING_REVEAL_FRAME_MS;
/** The rate estimate settles within this long of a stream's first arrival. */
const WARMUP_MS = 1000;
/** Twice the largest lead (600 ms): a unit waits behind up to one lead of backlog and the rest of its
 *  batch, drained at a velocity that falls as the backlog shrinks. */
const LAG_BOUND_MS = 1200;
/** The window the first chunk after a silence reveals over (250 ms), plus two frames. */
const DUMP_BOUND_MS = 250 + 2 * FRAME;
/** Ceiling on simulated time after the last arrival, so a reveal that never catches up fails instead of hanging. */
const GIVE_UP_MS = 10_000;

afterEach(() => {
	vi.useRealTimers();
});

interface Driver {
	arrive(total: number): void;
	shown(): number;
	stop(): void;
}

interface ControllerUnderTest {
	name: string;
	start(onReveal: (shown: number) => void): Driver;
}

function textView(units: number): AssistantMessageView {
	return { segments: [{ kind: "text", text: "x".repeat(units) }] };
}

function inputLength(args: unknown): number {
	if (typeof args !== "object" || args === null || !("input" in args) || typeof args.input !== "string") {
		throw new Error("expected raw tool input args");
	}
	return args.input.length;
}

const TOOL_CALL_ID = "call-1";
const RAW_INPUT = { rawInput: true, exposeRawPartialJson: true };

const CONTROLLERS: ControllerUnderTest[] = [
	{
		name: "assistant text",
		start(onReveal) {
			let shown = 0;
			const component = {
				updateContent(message: AssistantMessageView): void {
					const segment = message.segments[0];
					shown = segment?.kind === "text" ? segment.text.length : 0;
				},
				render: (): readonly string[] => [],
			};
			const controller = new StreamingRevealController({
				getSmoothStreaming: () => true,
				getHideThinkingBlock: () => false,
				getProseOnlyThinking: () => true,
				requestRender: () => onReveal(shown),
			});
			controller.begin(component, textView(0));
			return {
				arrive: total => controller.setTarget(textView(total)),
				shown: () => shown,
				stop: () => controller.stop(),
			};
		},
	},
	{
		name: "streamed tool-call arguments",
		start(onReveal) {
			let shown = 0;
			let bound = false;
			const component = {
				updateArgs(args: unknown): void {
					shown = inputLength(args);
				},
				render: (): readonly string[] => [],
			};
			const controller = new ToolArgsRevealController({
				getSmoothStreaming: () => true,
				requestRender: () => onReveal(shown),
			});
			return {
				arrive(total) {
					const args = controller.setTarget(TOOL_CALL_ID, "x".repeat(total), RAW_INPUT);
					if (bound) return;
					// The first slice of a call renders with the card, before any frame.
					bound = true;
					shown = inputLength(args);
					onReveal(shown);
					controller.bind(TOOL_CALL_ID, component);
				},
				shown: () => shown,
				stop: () => controller.stop(),
			};
		},
	},
];

type Arrival = [gapMs: number, units: number];

interface Pattern {
	name: string;
	/** Units per frame the stream delivers while it is delivering. */
	rate: number;
	/** Every gap stays within the largest lead, so a settled reveal never runs dry. */
	covered: boolean;
	arrivals(): Arrival[];
}

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

const PATTERNS: Pattern[] = [
	{
		name: "a steady trickle",
		rate: (4 / 25) * FRAME,
		covered: true,
		arrivals: () => repeat(120, [25, 4]),
	},
	{
		name: "a batch every 400 ms",
		rate: (120 / 400) * FRAME,
		covered: true,
		arrivals: () => repeat(10, [400, 120]),
	},
	{
		name: "jittered deltas",
		rate: (4.5 / 40) * FRAME,
		covered: true,
		arrivals: () => {
			const random = mulberry32(7);
			return Array.from(
				{ length: 100 },
				(): Arrival => [10 + Math.round(random() * 60), 3 + Math.floor(random() * 4)],
			);
		},
	},
	{
		name: "fewer units than frames",
		rate: (4 / 200) * FRAME,
		covered: true,
		arrivals: () => repeat(20, [200, 4]),
	},
	{
		name: "large fast batches",
		rate: (200 / 100) * FRAME,
		covered: true,
		arrivals: () => repeat(30, [100, 200]),
	},
	{
		name: "short and long gaps in turn",
		rate: (98 / 325) * FRAME,
		covered: true,
		arrivals: () =>
			Array.from({ length: 20 }, (): Arrival[] => [
				[25, 8],
				[300, 90],
			]).flat(),
	},
	{
		name: "a trickle with pauses shorter than a restart",
		rate: (4 / 25) * FRAME,
		covered: false,
		arrivals: () => Array.from({ length: 4 }, (): Arrival[] => [[700, 4], ...repeat(19, [25, 4])]).flat(),
	},
	{
		name: "pairs of deltas 800 ms apart",
		rate: (4 / 25) * FRAME,
		covered: false,
		arrivals: () =>
			Array.from({ length: 14 }, (): Arrival[] => [
				[800, 4],
				[25, 4],
			]).flat(),
	},
];

interface Run {
	/** [ms since start, units arrived]. */
	arrivals: Array<[number, number]>;
	/** [ms since start, units shown] for every render that showed more. */
	reveals: Array<[number, number]>;
	/** Units shown just before each arrival, by arrival index. */
	shownAtArrival: number[];
	/** ms from the last arrival until everything is shown. */
	caughtUpAfter: number;
	timersAfter: number;
}

function run(controller: ControllerUnderTest, pattern: Arrival[]): Run {
	vi.useFakeTimers();
	const start = performance.now();
	const clock = (): number => performance.now() - start;
	const reveals: Array<[number, number]> = [];
	const driver = controller.start(shown => reveals.push([clock(), shown]));
	const arrivals: Array<[number, number]> = [];
	const shownAtArrival: number[] = [];
	let total = 0;
	for (const [gap, units] of pattern) {
		vi.advanceTimersByTime(gap);
		total += units;
		shownAtArrival.push(driver.shown());
		driver.arrive(total);
		arrivals.push([clock(), total]);
	}
	const last = clock();
	while (driver.shown() < total && clock() - last < GIVE_UP_MS) vi.advanceTimersByTime(FRAME);
	const caughtUpAfter = clock() - last;
	vi.advanceTimersByTime(3 * FRAME);
	const timersAfter = vi.getTimerCount();
	driver.stop();
	return { arrivals, reveals, shownAtArrival, caughtUpAfter, timersAfter };
}

function arrivedBy(arrivals: Array<[number, number]>, at: number): number {
	let total = 0;
	for (const [time, units] of arrivals) {
		if (time > at) break;
		total = units;
	}
	return total;
}

interface Step {
	at: number;
	units: number;
	frames: number;
}

/** Consecutive reveals after the warmup and up to the last arrival. */
function settledSteps(result: Run): Step[] {
	const lastArrival = result.arrivals.at(-1)![0];
	const steps: Step[] = [];
	for (let i = 1; i < result.reveals.length; i++) {
		const [previousAt, previousShown] = result.reveals[i - 1]!;
		const [at, shown] = result.reveals[i]!;
		if (previousAt < WARMUP_MS || at > lastArrival) continue;
		steps.push({ at, units: shown - previousShown, frames: Math.round((at - previousAt) / FRAME) });
	}
	return steps;
}

describe("a stream reveals at the rate it arrives", () => {
	for (const controller of CONTROLLERS) {
		for (const pattern of PATTERNS) {
			describe(`${controller.name}, ${pattern.name}`, () => {
				const result = (() => {
					let cached: Run | undefined;
					return (): Run => {
						cached ??= run(controller, pattern.arrivals());
						return cached;
					};
				})();

				it("shows no more than twice the stream's rate on any frame", () => {
					const steps = settledSteps(result());
					expect(steps.length).toBeGreaterThan(0);
					const ceiling = Math.max(1, 2 * pattern.rate);
					const over = steps.filter(step => step.units > ceiling);
					expect(over).toEqual([]);
				});

				if (pattern.covered) {
					it("reveals on every frame, at no less than half the stream's rate", () => {
						const steps = settledSteps(result());
						expect(steps.length).toBeGreaterThan(0);
						const longestGap = Math.max(1, Math.ceil(1 / pattern.rate));
						const floor = pattern.rate / 2;
						const stalled = steps.filter(step => step.frames > longestGap || step.units / step.frames < floor);
						expect(stalled).toEqual([]);
					});
				}

				it(`shows every unit within ${LAG_BOUND_MS} ms of its arrival`, () => {
					const { arrivals, reveals, shownAtArrival } = result();
					const late: Array<[number, number, number]> = [];
					for (const [at, shown] of reveals) {
						const owed = arrivedBy(arrivals, at - LAG_BOUND_MS);
						if (shown < owed) late.push([at, shown, owed]);
					}
					for (let i = 0; i < arrivals.length; i++) {
						const at = arrivals[i]![0];
						const owed = arrivedBy(arrivals, at - LAG_BOUND_MS);
						if (shownAtArrival[i]! < owed) late.push([at, shownAtArrival[i]!, owed]);
					}
					expect(late).toEqual([]);
				});

				it(`catches up within ${LAG_BOUND_MS} ms of the last arrival and stops its frame timer`, () => {
					const { caughtUpAfter, timersAfter } = result();
					expect(caughtUpAfter).toBeLessThanOrEqual(LAG_BOUND_MS);
					expect(timersAfter).toBe(0);
				});
			});
		}

		it(`${controller.name}: a dump after a silence starts on the next frame and is shown within the initial lead`, () => {
			const dump = 400;
			const pattern: Arrival[] = [...repeat(40, [40, 4]), [1500, dump], ...repeat(20, [40, 4])];
			const { arrivals, reveals } = run(controller, pattern);
			const [dumpAt, dumpTotal] = arrivals[40]!;
			const after = reveals.filter(([at]) => at > dumpAt);
			expect(after.length).toBeGreaterThan(0);
			expect(after[0]![0] - dumpAt).toBeLessThanOrEqual(FRAME + 1);
			const shownAt = after.find(([, shown]) => shown >= dumpTotal)?.[0];
			expect(shownAt).toBeDefined();
			expect(shownAt! - dumpAt).toBeLessThanOrEqual(DUMP_BOUND_MS);
		});
	}
});

describe("a block shown mid-stream does not count as arriving", () => {
	it("the reveal returns to the stream's rate once the shown block has drained", () => {
		vi.useFakeTimers();
		const start = performance.now();
		const clock = (): number => performance.now() - start;
		const thinking = "y".repeat(3000);
		let hideThinking = true;
		let shown = 0;
		const reveals: Array<[number, number]> = [];
		const component = {
			updateContent(message: AssistantMessageView): void {
				shown = 0;
				for (const segment of message.segments) if ("text" in segment) shown += segment.text.length;
			},
			render: (): readonly string[] => [],
		};
		const controller = new StreamingRevealController({
			getSmoothStreaming: () => true,
			getHideThinkingBlock: () => hideThinking,
			getProseOnlyThinking: () => true,
			requestRender: () => reveals.push([clock(), shown]),
		});
		const view = (units: number): AssistantMessageView => ({
			segments: [
				{ kind: "thinking", text: thinking, redacted: false },
				{ kind: "text", text: "x".repeat(units) },
			],
		});
		const batch = 120;
		const gap = 400;
		controller.begin(component, view(0));
		const arrivals: Array<[number, number]> = [];
		for (let i = 1; i <= 30; i++) {
			vi.advanceTimersByTime(gap);
			controller.setTarget(view(i * batch));
			if (i === 5) {
				hideThinking = false;
				controller.resyncVisibility();
			}
			arrivals.push([clock(), i * batch + (hideThinking ? 0 : thinking.length)]);
		}
		const lastArrival = clock();
		controller.stop();

		// Drained: no more behind the arrivals than the largest lead holds at the stream's rate.
		const rate = (batch / gap) * FRAME;
		const withinLead = (batch / gap) * 600;
		const drainedAt = reveals.find(
			([at, units]) => at > arrivals[4]![0] && arrivedBy(arrivals, at) - units <= withinLead,
		)?.[0];
		expect(drainedAt).toBeDefined();
		const steps: Array<[number, number]> = [];
		for (let i = 1; i < reveals.length; i++) {
			const [at, units] = reveals[i]!;
			if (at <= drainedAt! || at > lastArrival) continue;
			steps.push([at, units - reveals[i - 1]![1]]);
		}
		expect(steps.length).toBeGreaterThan(0);
		expect(steps.filter(([, units]) => units > 2 * rate)).toEqual([]);
	});
});

describe("a stream that rewinds reveals what regrows at the stream's rate", () => {
	const SHAPES: Array<{ name: string; rate: number; before: Arrival[]; rewind: Arrival; after: Arrival[] }> = [
		{
			name: "a trickle",
			rate: (4 / 25) * FRAME,
			before: repeat(120, [25, 4]),
			rewind: [25, -300],
			after: repeat(120, [25, 4]),
		},
		{
			name: "a batch every 400 ms",
			rate: (120 / 400) * FRAME,
			before: repeat(10, [400, 120]),
			rewind: [100, -600],
			after: repeat(12, [400, 120]),
		},
	];
	for (const controller of CONTROLLERS) {
		for (const shape of SHAPES) {
			it(`${controller.name}, ${shape.name}: every frame after the rewind shows between half and twice the rate`, () => {
				const { arrivals, reveals } = run(controller, [...shape.before, shape.rewind, ...shape.after]);
				const rewoundAt = arrivals[shape.before.length]![0];
				const lastArrival = arrivals.at(-1)![0];
				const steps: Step[] = [];
				for (let i = 1; i < reveals.length; i++) {
					const [previousAt, previousShown] = reveals[i - 1]!;
					const [at, shown] = reveals[i]!;
					if (previousAt <= rewoundAt || at > lastArrival) continue;
					steps.push({ at, units: shown - previousShown, frames: Math.round((at - previousAt) / FRAME) });
				}
				expect(steps.length).toBeGreaterThan(0);
				const longestGap = Math.max(1, Math.ceil(1 / shape.rate));
				const ceiling = Math.max(1, 2 * shape.rate);
				const off = steps.filter(
					step => step.frames > longestGap || step.units / step.frames < shape.rate / 2 || step.units > ceiling,
				);
				expect(off).toEqual([]);
			});
		}
	}
});

describe("a pacer step covers the time since the previous step", () => {
	/** Arrivals of 4 units every 25 ms for 2 s, stepping every frame, then `skipped` frames with no step. */
	function settledStep(skipped: number): number {
		const pacer = new RevealPacer();
		let arrived = 0;
		let revealed = 0;
		let now = 0;
		let nextArrival = 0;
		const advanceTo = (time: number): void => {
			while (nextArrival <= time) {
				arrived += 4;
				pacer.arrive(nextArrival, arrived, revealed);
				nextArrival += 25;
			}
			now = time;
		};
		for (let frame = 1; frame <= 60; frame++) {
			advanceTo(frame * FRAME);
			revealed += pacer.step(now, arrived - revealed);
		}
		advanceTo(now + (skipped + 1) * FRAME);
		return pacer.step(now, arrived - revealed);
	}

	it("a frame three frames late reveals what the missed frames would have", () => {
		expect(settledStep(2)).toBeGreaterThanOrEqual(2.5 * settledStep(0));
	});

	it("a frame later than four frames makes up for four", () => {
		expect(settledStep(9)).toBeLessThan(1.5 * settledStep(3));
	});
});
