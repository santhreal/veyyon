/**
 * WHY: natural input paces every click, key and scroll of the browser tool when `browser.naturalInput`
 * is on, so a plan that overruns its ranges slows every action a model takes, a path that ends beside
 * its target presses the wrong point, a straight or evenly paced path is the robot it replaces, and a
 * typing plan that outgrows its budget times the action out.
 *
 * The contract, for every seed of the generator: a pointer travel ends exactly on its target, stays in
 * the viewport, bends away from the straight line, starts and ends slower than it moves in between,
 * lasts within its range, longer the farther and the smaller the target; each keystroke's hold, pause
 * and Shift lead lies in its range, and a text whose slowest pace outgrows its budget is typed within
 * it, key by key; `fill` types a value only when it is one line, 24 characters or fewer, and typed in
 * time; a wheel flick scrolls whole notches, the distance rounded to one, in at most eight events.
 *
 * What it does NOT catch: what Chromium makes of the plan (coalesced moves, a page that ignores the
 * wheel), which `a-natural-input-session-moves-rests-and-types-as-a-person-does.test.ts` drives.
 */

import { describe, expect, it } from "bun:test";
import {
	fillTypesKeyByKey,
	NATURAL_INPUT,
	planKeystrokes,
	planPointerPath,
	planWheel,
	seededRandom,
	worstCaseTypingMs,
} from "@veyyon/coding-agent/tools/web/browser/natural-input";

const SEEDS = Array.from({ length: 400 }, (_, seed) => seed);
const VIEWPORT = { width: 1365, height: 768 };

/** Travels across the viewport, short and long, to small and large targets. */
const TRAVELS = [
	{ from: { x: 60, y: 40 }, to: { x: 780, y: 525 }, target: { width: 160, height: 50 } },
	{ from: { x: 700, y: 400 }, to: { x: 720, y: 390 }, target: { width: 24, height: 24 } },
	{ from: { x: 1300, y: 700 }, to: { x: 10, y: 10 }, target: { width: 12, height: 12 } },
	{ from: { x: 400, y: 100 }, to: { x: 400, y: 650 }, target: { width: 300, height: 30 } },
] as const;

function median(values: readonly number[]): number {
	const sorted = values.toSorted((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
}

function travelMs(distance: number, size: number): number {
	return median(
		SEEDS.map(seed => {
			const path = planPointerPath(
				{ x: 10, y: 10 },
				{ x: 10 + distance, y: 10 },
				{ width: size, height: size },
				{ width: 4000, height: 800 },
				NATURAL_INPUT.moveMs,
				seededRandom(seed),
			);
			return path.at(-1)?.atMs ?? 0;
		}),
	);
}

describe("a pointer travel", () => {
	it("ends on its target, inside the viewport, within its duration and step ranges, for every seed", () => {
		const breaches: string[] = [];
		for (const seed of SEEDS) {
			for (const { from, to, target } of TRAVELS) {
				const path = planPointerPath(from, to, target, VIEWPORT, NATURAL_INPUT.moveMs, seededRandom(seed));
				const last = path.at(-1);
				if (last?.x !== to.x || last.y !== to.y) breaches.push(`${seed}: ends at ${last?.x},${last?.y}`);
				if (path.length < NATURAL_INPUT.moveSteps[0] || path.length > NATURAL_INPUT.moveSteps[1]) {
					breaches.push(`${seed}: ${path.length} samples`);
				}
				const duration = last?.atMs ?? 0;
				if (duration < NATURAL_INPUT.moveMs[0] || duration > NATURAL_INPUT.moveMs[1]) {
					breaches.push(`${seed}: lasts ${duration} ms`);
				}
				let previous = 0;
				for (const sample of path) {
					if (sample.atMs <= previous) breaches.push(`${seed}: sample at ${sample.atMs} after ${previous}`);
					previous = sample.atMs;
					if (sample.x < 0 || sample.y < 0 || sample.x >= VIEWPORT.width || sample.y >= VIEWPORT.height) {
						breaches.push(`${seed}: sample ${sample.x},${sample.y} outside the viewport`);
					}
				}
			}
		}
		expect(breaches).toEqual([]);
	});

	it("bends away from the straight line, and moves slower at both ends than in between", () => {
		const straight: string[] = [];
		const even: string[] = [];
		for (const seed of SEEDS) {
			for (const { from, to, target } of TRAVELS) {
				const distance = Math.hypot(to.x - from.x, to.y - from.y);
				if (distance < 100) continue;
				const path = planPointerPath(from, to, target, VIEWPORT, NATURAL_INPUT.moveMs, seededRandom(seed));
				const deviation = Math.max(
					...path.map(
						sample =>
							Math.abs((to.x - from.x) * (from.y - sample.y) - (from.x - sample.x) * (to.y - from.y)) / distance,
					),
				);
				if (deviation < 0.015 * distance)
					straight.push(`${seed}: ${deviation.toFixed(1)} px off a ${distance} px line`);
				const points = [{ ...from, atMs: 0 }, ...path];
				const speeds = points
					.slice(1)
					.map(
						(sample, index) =>
							Math.hypot(sample.x - points[index]!.x, sample.y - points[index]!.y) /
							(sample.atMs - points[index]!.atMs),
					);
				const peak = Math.max(...speeds);
				if (!(speeds[0]! < peak && speeds.at(-1)! < peak)) even.push(`${seed}: ${speeds.map(s => s.toFixed(2))}`);
			}
		}
		expect({ straight, even }).toEqual({ straight: [], even: [] });
	});

	it("takes longer the farther and the smaller its target, and not at all when the pointer is on it", () => {
		expect(travelMs(900, 20)).toBeGreaterThan(travelMs(120, 20));
		expect(travelMs(300, 10)).toBeGreaterThan(travelMs(300, 200));
		expect(
			planPointerPath(
				{ x: 50, y: 50 },
				{ x: 50.2, y: 50 },
				{ width: 20, height: 20 },
				VIEWPORT,
				NATURAL_INPUT.moveMs,
				seededRandom(1),
			),
		).toEqual([]);
	});

	it("is the same plan for the same seed", () => {
		const plan = (seed: number) =>
			planPointerPath(
				{ x: 1, y: 2 },
				{ x: 600, y: 400 },
				{ width: 40, height: 40 },
				VIEWPORT,
				NATURAL_INPUT.moveMs,
				seededRandom(seed),
			);
		expect(plan(7)).toEqual(plan(7));
		expect(plan(7)).not.toEqual(plan(8));
	});
});

describe("a keystroke plan", () => {
	const TEXT = "Hello, World! it's 42°C";

	it("holds, pauses and leads with Shift within their ranges, one keystroke per character", () => {
		const breaches: string[] = [];
		const inside = (value: number, [low, high]: readonly [number, number]) => value >= low && value <= high;
		for (const seed of SEEDS) {
			const strokes = planKeystrokes(TEXT, 60_000, seededRandom(seed));
			if (strokes.map(stroke => stroke.char).join("") !== TEXT) breaches.push(`${seed}: characters differ`);
			strokes.forEach((stroke, index) => {
				const last = index === strokes.length - 1;
				if (!inside(stroke.holdMs, NATURAL_INPUT.keyHoldMs)) breaches.push(`${seed}: hold ${stroke.holdMs}`);
				if (last ? stroke.gapMs !== 0 : !inside(stroke.gapMs, NATURAL_INPUT.keyGapMs)) {
					breaches.push(`${seed}: gap ${stroke.gapMs} after key ${index}`);
				}
				const shifted = /^[A-Z!]$/.test(stroke.char);
				if (stroke.shift !== shifted) breaches.push(`${seed}: shift ${stroke.shift} for ${stroke.char}`);
				if (shifted ? !inside(stroke.shiftLeadMs, NATURAL_INPUT.shiftLeadMs) : stroke.shiftLeadMs !== 0) {
					breaches.push(`${seed}: shift lead ${stroke.shiftLeadMs} for ${stroke.char}`);
				}
			});
		}
		expect(breaches).toEqual([]);
	});

	it("shrinks every delay to type within a budget its slowest pace outgrows, keeping every key", () => {
		const text = "x".repeat(200);
		const budget = 2_000;
		expect(worstCaseTypingMs(text)).toBeGreaterThan(budget);
		for (const seed of SEEDS.slice(0, 50)) {
			const strokes = planKeystrokes(text, budget, seededRandom(seed));
			const total = strokes.reduce((sum, stroke) => sum + stroke.shiftLeadMs + stroke.holdMs + stroke.gapMs, 0);
			expect(strokes.length).toBe(200);
			expect(total).toBeLessThanOrEqual(budget);
			expect(total).toBeGreaterThan(0);
		}
	});
});

describe("fill", () => {
	it("types a one-line value of 24 characters or fewer that its budget covers, and pastes every other", () => {
		const roomy = 60_000;
		expect({
			short: fillTypesKeyByKey("jo@example.test", roomy),
			atTheLimit: fillTypesKeyByKey("a".repeat(NATURAL_INPUT.fillTypedMaxChars), roomy),
			pastTheLimit: fillTypesKeyByKey("a".repeat(NATURAL_INPUT.fillTypedMaxChars + 1), roomy),
			astral: fillTypesKeyByKey("😀".repeat(NATURAL_INPUT.fillTypedMaxChars), roomy),
			empty: fillTypesKeyByKey("", roomy),
			lineBreak: fillTypesKeyByKey("one\ntwo", roomy),
			tab: fillTypesKeyByKey("one\ttwo", roomy),
			outOfTime: fillTypesKeyByKey("jo@example.test", worstCaseTypingMs("jo@example.test") - 1),
			justInTime: fillTypesKeyByKey("jo@example.test", worstCaseTypingMs("jo@example.test")),
		}).toEqual({
			short: true,
			atTheLimit: true,
			pastTheLimit: false,
			astral: true,
			empty: false,
			lineBreak: false,
			tab: false,
			outOfTime: false,
			justInTime: true,
		});
	});

	it("types its longest value within half of the default action deadline", () => {
		expect(worstCaseTypingMs("a".repeat(NATURAL_INPUT.fillTypedMaxChars))).toBeLessThanOrEqual(4_000);
	});
});

describe("a wheel flick", () => {
	it("scrolls the distance rounded to whole notches, in at most eight events with bounded pauses", () => {
		const notch = NATURAL_INPUT.wheelNotchPx;
		const cases = [
			{ dx: 0, dy: 2_640 },
			{ dx: 0, dy: -388 },
			{ dx: 260, dy: 90 },
			{ dx: -40, dy: 49 },
		];
		for (const seed of SEEDS.slice(0, 50)) {
			for (const { dx, dy } of cases) {
				const flick = planWheel(dx, dy, seededRandom(seed));
				// `+ 0` turns the -0 a small negative distance rounds to into the 0 a sum of no notches is.
				expect(flick.reduce((sum, step) => sum + step.deltaY, 0)).toBe(Math.round(dy / notch) * notch + 0);
				expect(flick.reduce((sum, step) => sum + step.deltaX, 0)).toBe(Math.round(dx / notch) * notch + 0);
				expect(flick.length).toBeLessThanOrEqual(NATURAL_INPUT.wheelEventsMax);
				expect(flick.every(step => step.deltaX % notch === 0 && step.deltaY % notch === 0)).toBe(true);
				expect(flick[0]?.gapMs ?? 0).toBe(0);
				for (const step of flick.slice(1)) {
					expect(step.gapMs).toBeGreaterThanOrEqual(NATURAL_INPUT.wheelGapMs[0]);
					expect(step.gapMs).toBeLessThanOrEqual(NATURAL_INPUT.wheelGapMs[1]);
				}
			}
		}
		expect(planWheel(-40, 49, seededRandom(1))).toEqual([]);
	});
});
