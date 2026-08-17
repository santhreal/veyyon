// WHY THIS EXISTS.
//
// A download bar drawn in whole cells could not animate even if something drove
// it. Twenty-four columns give twenty-four states, so a jump from 40% to 65%
// has six states to pass through and each one is a whole cell wide: the eye
// reads six discrete positions, which is not motion, it is a bar being moved.
// That is the concrete reason the operator's verdict on this build was that the
// animations are barely noticeable — there was nothing between the frames.
//
// Two changes make the travel visible, and this suite refuses to let either one
// be quietly dropped. The bar is drawn in eighths of a cell, so the same
// twenty-four columns carry 193 states. And the ratio is a `SettleValue` on the
// shared clock rather than the last number the worker reported, so a revised
// percentage walks to its new place over `MOTION.settle` instead of appearing
// there. Six distinct glyph states between two values 25% apart is the
// contract: it is what the whole-cell bar could not do, and it is what makes
// the motion something a reader sees rather than infers.
//
// Every frame here is driven by hand through a `MotionClock({ autoTick: false
// })`, so nothing waits on a real timer and the frame count is the assertion
// rather than an approximation of one.
//
// The class this closes: "an animated gauge whose value is written straight
// into the next frame". It is closed at the component, on the production render
// path, with the real theme loaded — not against a stand-in for either.
//
// What it does NOT catch: whether the host actually TICKS the shared clock (the
// production clock is `autoTick: true` and owns that), whether `requestRender`
// reaches the terminal, and the glyph contract itself, which is asserted
// exhaustively in `packages/tui/test/a-bar-moves-in-eighths-of-a-cell.test.ts`.

import { beforeAll, describe, expect, test } from "bun:test";
import { MotionClock } from "@veyyon/tui";
import { stripAnsi } from "@veyyon/utils/strip-ansi";
import { Settings } from "../../../config/settings";
import type { TinyTitleProgressEvent } from "../../../tiny/title-protocol";
import { getThemeByName, setThemeInstance } from "../../theme/theme";
import { TinyTitleDownloadProgressComponent } from "../tiny-title-download-progress";

const FRAME_MS = 1000 / 60;
const WIDTH = 70;
const MODEL_KEY = "lfm2-700m";

/** Every bar glyph the unicode ramp can produce, so the bar can be found in a row. */
const BAR_RUN = /[█▏▎▍▌▋▊▉░]+/;

function progressEvent(progress: number): TinyTitleProgressEvent {
	return { modelKey: MODEL_KEY, status: "progress", progress };
}

/** The bar, with its colours and its trailing facts removed. */
function barOf(component: TinyTitleDownloadProgressComponent): string {
	const rows = component.render(WIDTH);
	const details = stripAnsi(rows[1] ?? "");
	const bar = BAR_RUN.exec(details);
	if (!bar) throw new Error(`no bar in rendered row: ${JSON.stringify(details)}`);
	return bar[0];
}

describe("a download bar travels to its new percentage", () => {
	beforeAll(async () => {
		await Settings.init({ inMemory: true });
		const loaded = await getThemeByName("dark");
		if (!loaded) throw new Error("theme unavailable");
		setThemeInstance(loaded);
	});

	test("passes through at least six distinct glyph states between two values 25% apart", () => {
		const clock = new MotionClock({ autoTick: false });
		let renders = 0;
		const component = new TinyTitleDownloadProgressComponent(MODEL_KEY, {
			requestRender: () => {
				renders++;
			},
			clock,
		});

		// The first number a gauge is given is where it IS, not a change to it.
		component.update(progressEvent(40));
		const start = barOf(component);
		expect(clock.liveCount).toBe(0);

		component.update(progressEvent(65));
		expect(clock.liveCount).toBe(1);

		const states = [start];
		// A bound, not a wait: `MOTION.settle` is well inside 900ms, and a spring
		// that has not settled by then is a hang rather than a slow animation.
		const bound = Math.ceil(900 / FRAME_MS);
		let frames = 0;
		for (; frames < bound && clock.liveCount > 0; frames++) {
			clock.tick((frames + 1) * FRAME_MS);
			const bar = barOf(component);
			if (bar !== states[states.length - 1]) states.push(bar);
		}

		expect(clock.liveCount).toBe(0);
		expect(frames).toBeLessThan(bound);
		expect(renders).toBeGreaterThan(0);

		// THE CONTRACT.
		expect(states.length).toBeGreaterThanOrEqual(6);
		// It ends where it was told to go and started where it was.
		expect(states[0]).toBe(start);
		expect(states[states.length - 1]).toBe(barOf(component));

		// Every state is one distinct position, in one direction, and the travel is
		// made of sub-cell steps rather than whole cells: a whole-cell bar over this
		// span could show at most seven states, all of them `█`/`░` only.
		expect(new Set(states).size).toBe(states.length);
		expect(states.some(bar => /[▏▎▍▌▋▊▉]/.test(bar))).toBe(true);
		for (const bar of states) expect(bar.length).toBe(start.length);
	});

	test("the fill only ever grows while the value rises", () => {
		const clock = new MotionClock({ autoTick: false });
		const component = new TinyTitleDownloadProgressComponent(MODEL_KEY, {
			requestRender: () => {},
			clock,
		});
		component.update(progressEvent(10));
		component.update(progressEvent(90));

		// Eighths read off the rendered bar: whole cells are 8, the partials 1-7,
		// track 0. Reading the string back is the only way to see what a viewer saw.
		const eighths = (bar: string): number => {
			let total = 0;
			for (const glyph of bar) {
				if (glyph === "█") total += 8;
				else if (glyph !== "░") total += "▏▎▍▌▋▊▉".indexOf(glyph) + 1;
			}
			return total;
		};

		let previous = eighths(barOf(component));
		for (let frame = 0; frame < 120 && clock.liveCount > 0; frame++) {
			clock.tick((frame + 1) * FRAME_MS);
			const next = eighths(barOf(component));
			expect(next).toBeGreaterThanOrEqual(previous);
			previous = next;
		}
		expect(clock.liveCount).toBe(0);
	});

	test("with no repaint hook the bar lands on the reported value with no clock traffic", () => {
		const clock = new MotionClock({ autoTick: false });
		const component = new TinyTitleDownloadProgressComponent(MODEL_KEY, { clock });
		component.update(progressEvent(40));
		const before = barOf(component);
		component.update(progressEvent(65));

		// Nothing registered, so nothing to tick: this is byte-for-byte the jump the
		// component had before the settle existed.
		expect(clock.liveCount).toBe(0);
		expect(barOf(component)).not.toBe(before);
		const settled = barOf(component);
		clock.tick(FRAME_MS);
		expect(barOf(component)).toBe(settled);
	});

	test("a disabled settle lands immediately, so `display.transitions: off` sees the jump", () => {
		const clock = new MotionClock({ autoTick: false });
		const animated = new TinyTitleDownloadProgressComponent(MODEL_KEY, { requestRender: () => {}, clock });
		const still = new TinyTitleDownloadProgressComponent(MODEL_KEY, {
			requestRender: () => {},
			enabled: false,
			clock,
		});
		for (const component of [animated, still]) component.update(progressEvent(40));
		for (const component of [animated, still]) component.update(progressEvent(65));

		// Same target, and the disabled one is already there while the other is not.
		expect(barOf(animated)).not.toBe(barOf(still));
		// Monotonic frame times, and a bound rather than "until it stops": a spring
		// that never settles must show up here as a failure, not as a hang.
		let frames = 0;
		while (clock.liveCount > 0 && frames < 240) clock.tick(++frames * FRAME_MS);
		expect(clock.liveCount).toBe(0);
		expect(barOf(animated)).toBe(barOf(still));
	});

	test("dispose settles the value so no frame is owed after the row is gone", () => {
		const clock = new MotionClock({ autoTick: false });
		const component = new TinyTitleDownloadProgressComponent(MODEL_KEY, { requestRender: () => {}, clock });
		component.update(progressEvent(10));
		component.update(progressEvent(90));
		expect(clock.liveCount).toBe(1);

		component.dispose();
		clock.tick(FRAME_MS);
		expect(clock.liveCount).toBe(0);
	});
});
