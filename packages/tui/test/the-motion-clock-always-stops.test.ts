// WHY THIS EXISTS.
//
// The clock stops ticking on one condition and one only: every animation it
// holds has reported `done`. An animation that never reports it is not a slow
// animation, it is a `setInterval` at 60Hz calling the host's `requestRender`
// for as long as the process lives — a full terminal repaint sixty times a
// second, forever, with nothing on screen moving. That is a single missing
// branch away at all times, because a spring is an asymptote with a threshold
// on it and a threshold is exactly the kind of condition that can be missed
// forever.
//
// Six ways it was reachable before this suite existed, every one of them
// through the public `curve` option that `SettleValue`, `BlockReveal` and
// `MotionClock.animate` all take: a target of NaN or Infinity (a spring never
// re-enters a rest band it cannot compute), a `duration` of NaN or Infinity (a
// normalized time that never reaches 1), a spring with zero or negative
// damping (an integrator that conserves or pumps energy and oscillates
// forever), zero stiffness or infinite mass (a value that never travels), a
// `restDelta` of 0 (a threshold an asymptote never crosses), and a stiffness
// the 60Hz sub-step cannot resolve (an integrator that diverges to NaN). Each
// one is asserted here by name.
//
// The class this closes: "an animation that stays in the clock's live set
// without ever reporting done". It is closed two ways, and both are asserted —
// a spec that provably cannot settle never registers at all, and everything
// that does register lands within a hard deadline measured from its last
// retarget. The deadline is the part that makes the claim unconditional, so
// there is a test that a value which cannot settle on its own is stopped BY
// the deadline rather than by luck.
//
// What it does NOT catch: a HOST that calls `requestRender` on its own
// schedule (the clock is not the only thing that can ask for a frame), a
// component that forgets to `dispose()` and leaves a fade registered against a
// screen that is gone, and whether a settled value looks right. It also says
// nothing about wall-clock scheduling: every frame here is driven by hand,
// because a test that waits on a real timer is a test that flakes.

import { describe, expect, test } from "bun:test";
import { type AnimationCurve, MOTION, MotionClock } from "../src/motion";
import { BlockReveal } from "../src/motion-grow";
import { HoverFade } from "../src/motion-hover";
import { SettleValue } from "../src/motion-settle";

const FRAME = 1000 / 60;

/**
 * The contract, in frames at 60Hz. Nothing the clock accepts may still be live
 * after this many frames without a retarget: it is the 4s settle deadline plus
 * the frame the accumulated float time can land on either side of it.
 */
const HARD_BOUND = Math.ceil(4000 / FRAME) + 2;

/**
 * What a real motion is allowed to cost. Every preset in the table is under
 * 800ms of travel; 900ms of frames is that with a frame of slack, and it is
 * four times under {@link HARD_BOUND}, so a test that passes this bound has
 * settled naturally rather than been cut off by the deadline.
 */
const SETTLE_BOUND = Math.ceil(900 / FRAME);

/**
 * Exactly how many times one settled animation asks the host to repaint. This
 * is the operator-visible cost of the whole motion system, so it is pinned by
 * value rather than by bound: a preset that starts costing more frames is a
 * decision someone makes on purpose. A preset added to MOTION with no row here
 * fails the sweep below.
 */
const RENDERS_PER_SETTLE: Record<string, number> = {
	enter: 16,
	exit: 8,
	hover: 6,
	expand: 11,
	sweep: 32,
	move: 28,
	settle: 39,
};

interface Run {
	/** Frames ticked before the clock went quiet, or `limit + 1` if it never did. */
	frames: number;
	/** Host repaints requested across those frames. */
	renders: number;
	live: number;
}

/**
 * A clock whose frame times this test owns outright. `now` is injected and
 * frozen: nothing here may sample a real timer, and `autoTick` off means the
 * only frames that happen are the ones a test asks for by hand.
 */
function hand(): { clock: MotionClock } {
	return { clock: new MotionClock({ now: () => 0, autoTick: false }) };
}

/** Tick until nothing is live, or until `limit` frames have passed. */
function drain(clock: MotionClock, renders: () => number, startAt: number, limit = HARD_BOUND * 4): Run {
	const before = renders();
	let t = startAt;
	for (let i = 1; i <= limit; i++) {
		t += FRAME;
		clock.tick(t);
		if (clock.liveCount === 0) return { frames: i, renders: renders() - before, live: 0 };
	}
	return { frames: limit + 1, renders: renders() - before, live: clock.liveCount };
}

const presets = Object.entries(MOTION) as Array<[string, AnimationCurve]>;

describe("the motion table is swept whole", () => {
	test("every preset has a recorded repaint cost, and only presets do", () => {
		// Fail-by-default: a curve added to MOTION has no row in
		// RENDERS_PER_SETTLE, so this goes red until someone measures it and
		// records what it costs the operator per appearance.
		expect(Object.keys(RENDERS_PER_SETTLE).sort()).toEqual(Object.keys(MOTION).sort());
		expect(presets.length).toBeGreaterThan(0);
	});
});

describe.each(presets)("MOTION.%s", (name, curve) => {
	test("lands on target and hands the clock back, inside its bound", () => {
		let renders = 0;
		const { clock } = hand();
		const animation = clock.animate(curve, { from: 0, to: 10, onFrame: () => renders++ });
		const run = drain(clock, () => renders, 0);

		expect(run.live).toBe(0);
		expect(animation.done).toBe(true);
		expect(animation.value).toBe(10);
		// The bound, not just the landing: a preset that settles only because
		// the deadline cut it off would pass a "did it stop" assertion.
		expect(run.frames).toBeLessThanOrEqual(SETTLE_BOUND);
		expect(run.frames).toBeGreaterThan(0);
		// One repaint per live frame, and that is the whole bill.
		expect(run.renders).toBe(run.frames);
		expect(run.renders).toBe(RENDERS_PER_SETTLE[name]);
	});

	test("asks for zero repaints once it has stopped", () => {
		let renders = 0;
		const { clock } = hand();
		clock.animate(curve, { from: 0, to: 10, onFrame: () => renders++ });
		const run = drain(clock, () => renders, 0);
		expect(run.live).toBe(0);

		const settled = renders;
		let t = run.frames * FRAME;
		for (let i = 0; i < 600; i++) {
			t += FRAME;
			clock.tick(t);
		}
		expect(renders).toBe(settled);
		expect(clock.liveCount).toBe(0);
	});

	test("a value retargeted every frame for 600 frames still stops once the host lets go", () => {
		let renders = 0;
		const { clock } = hand();
		const animation = clock.animate(curve, { from: 0, to: 1, onFrame: () => renders++ });

		let t = 0;
		for (let i = 0; i < 600; i++) {
			t += FRAME;
			// A host revising the target on every single frame: a streaming
			// estimate, a viewport chasing content that is still arriving.
			animation.retarget(1 + (i % 17));
			clock.resume(animation);
			clock.tick(t);
		}
		// The storm has to have actually kept it awake, or "it stops afterwards"
		// is a claim about an animation that was already asleep.
		expect(clock.liveCount).toBe(1);
		expect(animation.done).toBe(false);
		expect(renders).toBeGreaterThanOrEqual(595);

		animation.retarget(4);
		clock.resume(animation);
		const after = drain(clock, () => renders, t);

		expect(after.live).toBe(0);
		expect(animation.value).toBe(4);
		expect(after.frames).toBeLessThanOrEqual(SETTLE_BOUND);
		expect(after.renders).toBe(after.frames);

		const settled = renders;
		let quiet = t + after.frames * FRAME;
		for (let i = 0; i < 600; i++) {
			quiet += FRAME;
			clock.tick(quiet);
		}
		expect(renders).toBe(settled);
	});
});

// Every one of these ran forever before the guards landed: the clock held the
// animation, `liveCount` never returned to 0, and `onFrame` fired on every
// frame for the life of the process. They reach the clock through the public
// `curve` and `to` options, so each is named rather than counted.
const NEVER_SETTLED: Array<[string, AnimationCurve, number]> = [
	["a spring aimed at NaN", MOTION.move, Number.NaN],
	["a spring aimed at Infinity", MOTION.settle, Number.POSITIVE_INFINITY],
	["a curve aimed at NaN", MOTION.enter, Number.NaN],
];

const UNSETTLEABLE_CURVES: Array<[string, AnimationCurve]> = [
	["a duration of NaN", { duration: Number.NaN, easing: t => t }],
	["a duration of Infinity", { duration: Number.POSITIVE_INFINITY, easing: t => t }],
	["a spring with no damping", { spring: { stiffness: 260, damping: 0, mass: 1 } }],
	["a spring with negative damping", { spring: { stiffness: 260, damping: -1, mass: 1 } }],
	["a spring with no stiffness", { spring: { stiffness: 0, damping: 30, mass: 1 } }],
	["a spring with zero mass", { spring: { stiffness: 260, damping: 30, mass: 0 } }],
	["a spring with infinite mass", { spring: { stiffness: 260, damping: 30, mass: Number.POSITIVE_INFINITY } }],
	["a rest band of zero", { spring: { stiffness: 260, damping: 30, mass: 1, restDelta: 0 } }],
	["a stiffness the sub-step cannot resolve", { spring: { stiffness: 1e6, damping: 30, mass: 1 } }],
];

describe("a spec that cannot settle never becomes an unending repaint", () => {
	test.each(NEVER_SETTLED)("%s registers nothing and repaints nothing", (_name, curve, to) => {
		let renders = 0;
		const { clock } = hand();
		const animation = clock.animate(curve, { from: 3, to, onFrame: () => renders++ });

		expect(clock.liveCount).toBe(0);
		expect(animation.done).toBe(true);
		// Not a destination, so the value stays where it was rather than
		// becoming NaN on screen.
		expect(animation.value).toBe(3);

		let t = 0;
		for (let i = 0; i < 600; i++) {
			t += FRAME;
			clock.tick(t);
		}
		expect(renders).toBe(0);
		expect(clock.liveCount).toBe(0);
	});

	test.each(UNSETTLEABLE_CURVES)("%s registers nothing and repaints nothing", (_name, curve) => {
		let renders = 0;
		const { clock } = hand();
		const animation = clock.animate(curve, { from: 0, to: 7, onFrame: () => renders++ });

		// Not "it stops eventually" — it never starts. A spec that provably
		// cannot settle is answered before a single frame is spent on it, so
		// there is no window in which the terminal repaints for nothing.
		expect(clock.liveCount).toBe(0);
		expect(animation.done).toBe(true);
		expect(animation.value).toBe(7);
		expect(renders).toBe(0);

		let t = 0;
		for (let i = 0; i < 600; i++) {
			t += FRAME;
			clock.tick(t);
		}
		expect(renders).toBe(0);
		expect(clock.liveCount).toBe(0);
	});

	test.each(UNSETTLEABLE_CURVES)("%s cannot be resurrected by a retarget", (_name, curve) => {
		// The curve is rejected once, at construction, and `#curve` never
		// changes — so a host that retargets the handle it was given back must
		// not be able to put an animation that cannot settle back on the clock.
		let renders = 0;
		const { clock } = hand();
		const animation = clock.animate(curve, { from: 0, to: 7, onFrame: () => renders++ });

		let t = 0;
		for (let i = 0; i < 300; i++) {
			t += FRAME;
			animation.retarget(1 + (i % 19));
			clock.resume(animation);
			clock.tick(t);
		}
		expect(clock.liveCount).toBe(0);
		expect(animation.done).toBe(true);
		expect(renders).toBe(0);
	});

	test.each(presets)("MOTION.%s started from a value that is not a number still stops", (_name, curve) => {
		// `from` reaches the clock from a caller's own state — a gauge whose
		// measurement divided by zero, a viewport offset read before it existed.
		// A spring started at NaN computes a NaN displacement forever.
		for (const from of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
			let renders = 0;
			const { clock } = hand();
			const animation = clock.animate(curve, { from, to: 9, onFrame: () => renders++ });
			const run = drain(clock, () => renders, 0);

			expect(run.live).toBe(0);
			expect(animation.value).toBe(9);
			expect(run.frames).toBeLessThanOrEqual(SETTLE_BOUND);
			expect(run.renders).toBe(run.frames);
		}
	});

	test("retargeting a live animation to NaN mid-flight does not strand it", () => {
		let renders = 0;
		const { clock } = hand();
		const animation = clock.animate(MOTION.settle, { from: 0, to: 10, onFrame: () => renders++ });
		const t = FRAME;
		clock.tick(t);
		expect(clock.liveCount).toBe(1);

		animation.retarget(Number.NaN);
		clock.resume(animation);
		const run = drain(clock, () => renders, t);

		expect(run.live).toBe(0);
		expect(animation.value).toBe(10);
		expect(run.frames).toBeLessThanOrEqual(SETTLE_BOUND);
	});
});

describe("the settle deadline is the thing that stops the ones nothing else can", () => {
	// Damping this small passes every parameter check there is — it is finite
	// and positive, the spring is well-formed, the integrator is stable — and
	// the decay it produces outlives the session. Parameter validation cannot
	// see this one. Only a deadline can, which is why there is one.
	const glacial: AnimationCurve = { spring: { stiffness: 260, damping: 1e-30, mass: 1 } };

	test("a spring that cannot decay is landed by the deadline, not by settling", () => {
		let renders = 0;
		const { clock } = hand();
		const animation = clock.animate(glacial, { from: 0, to: 5, onFrame: () => renders++ });
		const run = drain(clock, () => renders, 0);

		expect(run.live).toBe(0);
		expect(animation.value).toBe(5);
		// Both sides of the bound. Under SETTLE_BOUND would mean it settled on
		// its own and this test is measuring nothing; over HARD_BOUND would
		// mean the deadline is not a deadline.
		expect(run.frames).toBeGreaterThan(SETTLE_BOUND);
		expect(run.frames).toBeLessThanOrEqual(HARD_BOUND);
		expect(run.renders).toBe(run.frames);

		const settled = renders;
		let t = run.frames * FRAME;
		for (let i = 0; i < 600; i++) {
			t += FRAME;
			clock.tick(t);
		}
		expect(renders).toBe(settled);
	});

	test("a host that keeps retargeting is never cut off mid-travel by the deadline", () => {
		const { clock } = hand();
		const animation = clock.animate(MOTION.move, { from: 0, to: 1 });
		let t = 0;
		// Four times the deadline's worth of frames, retargeted throughout.
		for (let i = 0; i < HARD_BOUND * 4; i++) {
			t += FRAME;
			animation.retarget(1 + (i % 23));
			clock.resume(animation);
			clock.tick(t);
		}
		expect(clock.liveCount).toBe(1);
		expect(animation.done).toBe(false);
	});
});

describe("the components that own a requestRender", () => {
	test("a hover band stops asking for frames once the pointer settles", () => {
		let renders = 0;
		const { clock } = hand();
		const fade = new HoverFade<number>({ requestRender: () => renders++, clock });

		let t = 0;
		// A pointer dragged down a list: a new row every frame for 600 frames.
		for (let i = 0; i < 600; i++) {
			t += FRAME;
			fade.set(i % 40);
			clock.tick(t);
		}
		fade.set(7);
		const run = drain(clock, () => renders, t);

		expect(run.live).toBe(0);
		expect(run.frames).toBeLessThanOrEqual(SETTLE_BOUND);
		expect(fade.strengthAt(7)).toBe(1);

		const settled = renders;
		let quiet = t + run.frames * FRAME;
		for (let i = 0; i < 600; i++) {
			quiet += FRAME;
			clock.tick(quiet);
		}
		expect(renders).toBe(settled);
	});

	test("a settling value stops asking for frames once the revisions stop", () => {
		let renders = 0;
		const { clock } = hand();
		const gauge = new SettleValue({ requestRender: () => renders++, clock });
		gauge.set(0);

		let t = 0;
		for (let i = 0; i < 600; i++) {
			t += FRAME;
			gauge.set(1 + (i % 31));
			clock.tick(t);
		}
		expect(gauge.live).toBe(true);

		gauge.set(12);
		const run = drain(clock, () => renders, t);

		expect(run.live).toBe(0);
		expect(gauge.live).toBe(false);
		expect(gauge.value).toBe(12);
		expect(run.frames).toBeLessThanOrEqual(SETTLE_BOUND);

		const settled = renders;
		let quiet = t + run.frames * FRAME;
		for (let i = 0; i < 600; i++) {
			quiet += FRAME;
			clock.tick(quiet);
		}
		expect(renders).toBe(settled);
	});

	test("a settling value refuses a target that is not a number", () => {
		let renders = 0;
		const { clock } = hand();
		const gauge = new SettleValue({ requestRender: () => renders++, clock });
		gauge.set(4);
		expect(gauge.set(Number.NaN)).toBe(false);
		expect(gauge.set(Number.POSITIVE_INFINITY)).toBe(false);
		expect(clock.liveCount).toBe(0);

		let t = 0;
		for (let i = 0; i < 600; i++) {
			t += FRAME;
			clock.tick(t);
		}
		expect(renders).toBe(0);
		expect(gauge.value).toBe(4);
	});

	test("a block reveal grows once and then stops asking", () => {
		let renders = 0;
		const { clock } = hand();
		const reveal = new BlockReveal({ requestRender: () => renders++, clock });
		reveal.arm();
		// Re-arming per keystroke must not restart the grow, which is what would
		// hold the clock awake for as long as someone is typing.
		for (let i = 0; i < 50; i++) reveal.arm();
		reveal.apply(["a", "b", "c"]);

		const run = drain(clock, () => renders, 0);
		expect(run.live).toBe(0);
		expect(run.frames).toBeLessThanOrEqual(SETTLE_BOUND);
		expect(reveal.value).toBe(1);

		const settled = renders;
		let t = run.frames * FRAME;
		for (let i = 0; i < 600; i++) {
			t += FRAME;
			clock.tick(t);
			reveal.apply(["a", "b", "c"]);
		}
		expect(renders).toBe(settled);
		expect(clock.liveCount).toBe(0);
	});
});
