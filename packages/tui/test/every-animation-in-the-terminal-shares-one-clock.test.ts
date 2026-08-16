// WHY THIS EXISTS.
//
// Animation in this terminal used to be per-component: a `setInterval` per
// surface, a hand-written easing per surface, a settle deadline per surface.
// The class of defect that produces is not one bug, it is four: two surfaces
// animating on unsynchronized timers, a timer that keeps waking the process
// after its component is gone, a curve that never reaches its target (or
// overshoots and stays there), and a "disable motion" switch that some
// surfaces honor and others do not.
//
// This suite pins the shared clock against all four, and it enumerates the
// MOTION preset table AT RUN TIME, so a preset added later is swept by every
// termination and overshoot assertion without anyone remembering to add it.
// A preset whose spring never settles, or whose curve overshoots, turns this
// suite RED on the commit that adds it.
//
// What it does NOT catch: whether a component wired itself to the clock at all
// (that is each surface's own suite), and whether the motion looks right — a
// curve can settle perfectly and still feel wrong. It also asserts nothing
// about real wall-clock scheduling: every test here drives frames by hand,
// because a test that waits on a timer is a test that flakes.

import { describe, expect, test } from "bun:test";
import { type Animation, type AnimationCurve, easeOutCubic, MOTION, MotionClock } from "../src/motion";
import { blendHex, fadeLinesTowards, fadeLineTowards, revealedRows, toHexColor } from "../src/motion-paint";

const FRAME = 1000 / 60;

/** Drive `clock` for `frames` frames of 60Hz, starting at t = 0. */
function run(clock: MotionClock, frames: number, startAt = 0): void {
	for (let i = 1; i <= frames; i++) clock.tick(startAt + i * FRAME);
}

/** Frames until every live animation on the clock has settled, or `limit`. */
function framesToSettle(clock: MotionClock, limit = 600): number {
	for (let i = 1; i <= limit; i++) {
		clock.tick(i * FRAME);
		if (clock.liveCount === 0) return i;
	}
	return limit + 1;
}

describe("the shared clock", () => {
	test("advances every registered animation on one tick and forgets them when they settle", () => {
		const clock = new MotionClock();
		const seenA: number[] = [];
		const seenB: number[] = [];
		clock.animate(MOTION.enter, { to: 1, onFrame: v => seenA.push(v) });
		clock.animate(MOTION.hover, { to: 10, onFrame: v => seenB.push(v) });
		expect(clock.liveCount).toBe(2);

		clock.tick(FRAME);
		// One tick, both sampled: the whole point of a single clock.
		expect(seenA.length).toBe(1);
		expect(seenB.length).toBe(1);

		const frames = framesToSettle(clock);
		expect(frames).toBeLessThanOrEqual(Math.ceil(MOTION.enter.duration / FRAME) + 1);
		// Nothing left registered, so nothing is sampled or ticked afterwards.
		expect(clock.liveCount).toBe(0);
		const after = seenB.length;
		clock.tick(10_000);
		expect(seenB.length).toBe(after);
	});

	test("a disabled animation lands on its target without ever registering", () => {
		const clock = new MotionClock();
		let done = 0;
		const frames: number[] = [];
		const animation = clock.animate(MOTION.enter, {
			from: 0,
			to: 1,
			enabled: false,
			onFrame: v => frames.push(v),
			onDone: () => done++,
		});
		expect(animation.value).toBe(1);
		expect(animation.done).toBe(true);
		expect(done).toBe(1);
		expect(frames).toEqual([1]);
		expect(clock.liveCount).toBe(0);
	});

	test("finish settles and reports once; cancel settles and never reports", () => {
		const clock = new MotionClock();
		let finished = 0;
		const a = clock.animate(MOTION.enter, { to: 1, onDone: () => finished++ });
		a.finish();
		a.finish();
		expect(a.value).toBe(1);
		expect(finished).toBe(1);

		let cancelledDone = 0;
		const b = clock.animate(MOTION.enter, { to: 1, onDone: () => cancelledDone++ });
		clock.tick(FRAME);
		const mid = b.value;
		b.cancel();
		clock.tick(FRAME * 2);
		expect(b.value).toBe(mid);
		expect(b.done).toBe(true);
		expect(cancelledDone).toBe(0);
	});

	test("a stalled frame advances by one clamped frame instead of replaying the gap", () => {
		const clock = new MotionClock();
		const animation = clock.animate({ duration: 1000, easing: t => t }, { to: 1 });
		clock.tick(FRAME);
		// Debugger, blocked loop, laptop lid: five seconds with no frames.
		clock.tick(5000);
		// 100ms is the clamp, so ~116ms of a 1000ms linear ramp has elapsed.
		expect(animation.value).toBeLessThan(0.2);
		expect(animation.value).toBeGreaterThan(0.1);
		expect(Number.isFinite(animation.value)).toBe(true);
	});
});

describe("curves", () => {
	test("a curve is monotone, never overshoots, and lands exactly on its target", () => {
		const clock = new MotionClock();
		const values: number[] = [];
		const animation = clock.animate(MOTION.enter, { from: 0, to: 1, onFrame: v => values.push(v) });
		framesToSettle(clock);
		expect(animation.value).toBe(1);
		for (let i = 1; i < values.length; i++) {
			expect(values[i]!).toBeGreaterThanOrEqual(values[i - 1]!);
			expect(values[i]!).toBeLessThanOrEqual(1);
		}
	});

	test("a curve runs backwards just as exactly", () => {
		const clock = new MotionClock();
		const animation = clock.animate(MOTION.exit, { from: 1, to: 0 });
		framesToSettle(clock);
		expect(animation.value).toBe(0);
	});

	test("easeOutCubic is normalized at both ends", () => {
		expect(easeOutCubic(0)).toBe(0);
		expect(easeOutCubic(1)).toBe(1);
		expect(easeOutCubic(0.5)).toBeGreaterThan(0.5); // decelerating, not linear
	});
});

describe("springs", () => {
	test("a retarget keeps the value continuous and carries its velocity", () => {
		const clock = new MotionClock();
		const animation = clock.animate(MOTION.move, { from: 0, to: 10 });
		run(clock, 6);
		const before = animation.value;
		expect(before).toBeGreaterThan(0);
		expect(before).toBeLessThan(10);

		animation.retarget(20);
		// No jump at the seam: the pointer moved, the row did not teleport.
		expect(animation.value).toBe(before);

		clock.tick(7 * FRAME);
		const travelled = animation.value - before;

		// A spring that dropped its velocity at the seam would also move toward
		// the new target, so "it moved" proves nothing. The same spring starting
		// from the same value AT REST is the control: carrying momentum has to
		// cover meaningfully more ground on the very next frame.
		const control = new MotionClock();
		const fromRest = control.animate(MOTION.move, { from: before, to: 20 });
		control.tick(FRAME);
		const restTravel = fromRest.value - before;
		expect(travelled).toBeGreaterThan(restTravel * 1.25);

		framesToSettle(clock);
		expect(animation.value).toBe(20);
	});

	test("a settled spring can be resumed toward a new target", () => {
		const clock = new MotionClock();
		const animation = clock.animate(MOTION.move, { from: 0, to: 1 });
		framesToSettle(clock);
		expect(clock.liveCount).toBe(0);

		animation.retarget(5);
		expect(animation.done).toBe(false);
		clock.resume(animation);
		expect(clock.liveCount).toBe(1);
		framesToSettle(clock);
		expect(animation.value).toBe(5);
	});
});

describe("the MOTION preset table", () => {
	// Enumerated from the module, not from a list written here: a preset added
	// later is swept without anyone remembering this file exists.
	const presets = Object.entries(MOTION) as Array<[string, AnimationCurve]>;

	test("every preset is one of the two supported shapes", () => {
		expect(presets.length).toBeGreaterThan(0);
		for (const [name, curve] of presets) {
			const shape = "spring" in curve ? "spring" : "duration" in curve ? "curve" : "unknown";
			expect(`${name}:${shape}`).not.toContain("unknown");
		}
	});

	// 800ms is the outer bound for anything in this table: past that the motion
	// is no longer feedback, it is a delay, and a spring whose tail creeps for
	// longer is also a clock that keeps waking for nothing.
	test("every preset settles, exactly on target, inside 800ms", () => {
		const budget = Math.ceil(800 / FRAME);
		for (const [name, curve] of presets) {
			const clock = new MotionClock();
			const animation: Animation = clock.animate(curve, { from: 0, to: 1 });
			const frames = framesToSettle(clock, budget);
			expect(`${name}:${frames <= budget}`).toBe(`${name}:true`);
			expect(`${name}:${animation.value}`).toBe(`${name}:1`);
			expect(`${name}:${clock.liveCount}`).toBe(`${name}:0`);
		}
	});

	test("no preset overshoots enough to read as a bounce", () => {
		for (const [name, curve] of presets) {
			const clock = new MotionClock();
			let peak = 0;
			clock.animate(curve, { from: 0, to: 1, onFrame: v => (peak = Math.max(peak, v)) });
			framesToSettle(clock);
			// 2% is a landing; more is a wobble, which is the thing this product's
			// motion is explicitly not.
			expect(`${name}:${peak <= 1.02}`).toBe(`${name}:true`);
		}
	});

	test("every preset honors the disable switch identically", () => {
		for (const [name, curve] of presets) {
			const clock = new MotionClock();
			const animation = clock.animate(curve, { from: 0, to: 1, enabled: false });
			expect(`${name}:${animation.value}`).toBe(`${name}:1`);
			expect(`${name}:${clock.liveCount}`).toBe(`${name}:0`);
		}
	});
});

describe("frame transforms", () => {
	test("blendHex hits both endpoints exactly and moves in between", () => {
		expect(blendHex("#000000", "#ffffff", 0)).toBe("#000000");
		expect(blendHex("#000000", "#ffffff", 1)).toBe("#ffffff");
		expect(blendHex("#000000", "#ffffff", 0.5)).toBe("#808080");
		// Out of range is clamped, not extrapolated into a wrong color.
		expect(blendHex("#000000", "#ffffff", 2)).toBe("#ffffff");
		expect(blendHex("#000000", "#ffffff", -1)).toBe("#000000");
	});

	test("toHexColor clamps rather than wrapping", () => {
		expect(toHexColor(300, -20, 12.6)).toBe("#ff000d");
	});

	test("a full-strength fade is byte-identical and a zero fade is the ground", () => {
		const line = "\x1b[1;38;2;200;100;50mtext\x1b[0m";
		expect(fadeLineTowards(line, "#000000", 1)).toBe(line);
		expect(fadeLineTowards(line, "#000000", 0)).toBe("\x1b[1;38;2;0;0;0mtext\x1b[0m");
		expect(fadeLineTowards(line, "#000000", 0.5)).toBe("\x1b[1;38;2;100;50;25mtext\x1b[0m");
	});

	test("a fade rewrites foreground and background in one compound sequence", () => {
		const line = "\x1b[38;2;100;100;100;48;2;20;20;20mrow\x1b[0m";
		expect(fadeLineTowards(line, "#000000", 0.5)).toBe("\x1b[38;2;50;50;50;48;2;10;10;10mrow\x1b[0m");
	});

	test("a fade leaves an indexed color alone rather than guessing its palette", () => {
		expect(fadeLineTowards("\x1b[38;5;196mred\x1b[0m", "#000000", 0)).toBe("\x1b[38;5;196mred\x1b[0m");
		// An indexed foreground in front of a truecolor background is where a
		// fade that does not check the `5` reads the palette index as the first
		// channel and rewrites the wrong three numbers.
		const mixed = "\x1b[38;5;196;48;2;20;40;60mrow\x1b[0m";
		expect(fadeLineTowards(mixed, "#000000", 0.5)).toBe("\x1b[38;5;196;48;2;10;20;30mrow\x1b[0m");
	});

	test("a colon-form truecolor sequence fades and stays colon-form", () => {
		// libvte and several runners emit this spelling; a fade that only knows
		// semicolons drops the color entirely on those terminals.
		expect(fadeLineTowards("\x1b[38:2:200:100:50mtext\x1b[0m", "#000000", 0.5)).toBe(
			"\x1b[38:2:100:50:25mtext\x1b[0m",
		);
	});

	test("an unparsable ground is a no-op, not a black frame", () => {
		const line = "\x1b[38;2;200;100;50mtext\x1b[0m";
		expect(fadeLineTowards(line, "transparent", 0)).toBe(line);
	});

	test("fading a block fades every line and copies rather than aliasing", () => {
		const lines = ["\x1b[38;2;80;80;80ma\x1b[0m", "plain"];
		const faded = fadeLinesTowards(lines, "#000000", 0.5);
		expect(faded).toEqual(["\x1b[38;2;40;40;40ma\x1b[0m", "plain"]);
		expect(fadeLinesTowards(lines, "#000000", 1)).not.toBe(lines);
	});

	test("revealedRows grows to the full block and never dips under its floor", () => {
		expect(revealedRows(10, 0)).toBe(0);
		expect(revealedRows(10, 0, 2)).toBe(2);
		expect(revealedRows(10, 0.5)).toBe(5);
		expect(revealedRows(10, 1)).toBe(10);
		expect(revealedRows(10, 2)).toBe(10);
		// A block shorter than the floor cannot show more rows than it has.
		expect(revealedRows(1, 0, 2)).toBe(1);
	});
});
