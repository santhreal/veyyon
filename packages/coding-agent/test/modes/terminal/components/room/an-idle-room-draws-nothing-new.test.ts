/**
 * WHY THIS SUITE EXISTS.
 *
 * The room view can stay open for as long as the operator reads it. A stage
 * that keeps a repaint timer, a live animation or a wall-clock-dependent cell
 * while nothing on it is moving repaints the whole terminal forever: a busy
 * process, a flickering screen over SSH, and alt-frame writes for frames that
 * are byte-identical to the last one. The one thing on the stage that must
 * move on its own is a working conversation's spinner and clock.
 *
 * THE CLASS, NOT THE INCIDENT.
 *
 * - An overview whose conversations are in every state that is not working
 *   (the states are a `Record` over the state union, so a new state is a type
 *   error until it is declared working or not) renders the same bytes at any
 *   wall time, in both layouts, with no interval, no timeout and no live
 *   animation; a notice that has expired leaves it that way.
 * - A working conversation holds exactly one repaint interval at the house
 *   spinner rate, whose tick asks for a frame, and that interval is cleared
 *   when the conversation stops (to each state it can stop in), when the stage
 *   leaves the overview to enter a conversation, and when the stage is
 *   disposed. The quick switch, which has no overview, holds none.
 *
 * WHAT IT DOES NOT CATCH.
 *
 * The product clock's own ticker, which stops when no animation is live: that
 * is `MotionClock`'s suite, and here a live animation is caught as
 * `liveCount > 0`. Whether the engine skips writing a byte-identical frame: the
 * engine's alt-frame suite.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import type { RoomLayout } from "@veyyon/coding-agent/modes/terminal/components/room/room-stage";
import type {
	RoomWindowSnapshot,
	RoomWindowState,
} from "@veyyon/coding-agent/modes/terminal/components/room/room-view-model";
import { useTruecolorTheme } from "../../../../helpers/theme-assertions";
import { warmNativeTextPath } from "../../../../helpers/warm-native-text";
import { disposeStages, FakeMember, KEY, START_MS, StageDriver, screenRows, snapshotOf } from "./room-stage-driver";

useTruecolorTheme("dark");

// The first native load in the process schedules its own one-off cleanup timeout; load it before
// any test watches the timers, so what they count is the stage's.
beforeAll(() => {
	warmNativeTextPath();
});

afterEach(() => {
	vi.restoreAllMocks();
	disposeStages();
});

const WIDTH = 100;
const HEIGHT = 30;
/** The house spinner cadence (`SPINNER_REPAINT_MS` in room-stage.ts). */
const SPINNER_REPAINT_MS = 80;
const LAYOUTS: readonly RoomLayout[] = ["side-by-side", "all-windows"];

/** Every state a window can be in, and whether it is the stage's idea of working. A new state must be declared here. */
const STATES: Record<RoomWindowState["kind"], { readonly state: RoomWindowState; readonly working: boolean }> = {
	new: { state: { kind: "new" }, working: false },
	working: { state: { kind: "working", since: START_MS - 65_000, activity: "thinking" }, working: true },
	done: { state: { kind: "done", at: START_MS - 1_000 }, working: false },
	failed: { state: { kind: "failed", reason: "exit 1" }, working: false },
	stopped: { state: { kind: "stopped" }, working: false },
};
const IDLE_STATES = Object.values(STATES).filter(entry => !entry.working);

function snapshot(state: RoomWindowState): RoomWindowSnapshot {
	return snapshotOf(state, [{ kind: "prompt", text: "a question" }], { title: `in state ${state.kind}` });
}

function idleRoster(): FakeMember[] {
	return IDLE_STATES.map(
		(entry, i) =>
			new FakeMember(`m${i}`, snapshot(entry.state), { origin: i === 0, waitingDialogs: i === 1 ? 1 : 0 }),
	);
}

/** m0 is idle and on screen; m1 is working. */
function workingRoster(): FakeMember[] {
	return [
		new FakeMember("m0", snapshot(STATES.done.state), { origin: true }),
		new FakeMember("m1", snapshot(STATES.working.state)),
	];
}

/** Watch the timers the stage schedules; the spies call through, so the timers are real. */
function watchTimers() {
	const clears = vi.spyOn(globalThis, "clearInterval");
	return {
		intervals: vi.spyOn(globalThis, "setInterval"),
		timeouts: vi.spyOn(globalThis, "setTimeout"),
		/** Whether `handle`, as `setInterval` returned it, has been passed to `clearInterval`. */
		cleared: (handle: unknown): boolean => clears.mock.calls.some(call => call[0] === handle),
	};
}

async function openRoom(members: FakeMember[], layout: RoomLayout = "side-by-side"): Promise<StageDriver> {
	const stage = new StageDriver({
		width: WIDTH,
		height: HEIGHT,
		members,
		layout,
		originScreen: screenRows(WIDTH, HEIGHT, "origin"),
	});
	stage.render();
	await stage.settle();
	return stage;
}

describe("an idle room draws nothing new", () => {
	for (const layout of LAYOUTS) {
		it(`${layout}: every state that is not working renders the same bytes at any wall time, with no timer and nothing moving`, async () => {
			const timers = watchTimers();
			const stage = await openRoom(idleRoster(), layout);
			const first = [...stage.render()];
			for (const later of [SPINNER_REPAINT_MS, 1_000, 61_000, 3_600_000]) {
				stage.now = START_MS + later;
				expect({ later, frame: [...stage.render()] }).toEqual({ later, frame: first });
			}
			expect(timers.intervals).not.toHaveBeenCalled();
			expect(timers.timeouts).not.toHaveBeenCalled();
			expect(stage.clock.liveCount).toBe(0);
		});
	}

	it("a notice that has expired leaves the room as still as it was", async () => {
		const timers = watchTimers();
		const stage = await openRoom(idleRoster());
		const before = [...stage.render()];
		// x on the conversation on screen is refused with a notice, which expires on a timeout.
		await stage.press("x");
		expect(stage.render()).not.toEqual(before);
		expect(timers.timeouts).toHaveBeenCalledTimes(1);
		const [expire, delay] = timers.timeouts.mock.calls[0]!;
		stage.now += delay ?? 0;
		const requests = stage.host.renderRequests;
		if (typeof expire !== "function") throw new Error("the notice timer has no handler");
		expire();
		expect(stage.host.renderRequests).toBe(requests + 1);
		expect(stage.render()).toEqual(before);
		stage.now += 60_000;
		expect(stage.render()).toEqual(before);
		expect(timers.intervals).not.toHaveBeenCalled();
	});
});

describe("a working conversation keeps one repaint at the spinner's rate, and only while it works", () => {
	for (const [kind, end] of Object.entries(STATES).filter(([, entry]) => !entry.working)) {
		it(`stops when the conversation stops as ${kind}`, async () => {
			const timers = watchTimers();
			const stage = await openRoom(workingRoster());
			for (let i = 0; i < 3; i++) stage.render();
			expect(timers.intervals).toHaveBeenCalledTimes(1);
			const [tick, period] = timers.intervals.mock.calls[0]!;
			expect(period).toBe(SPINNER_REPAINT_MS);
			const handle = timers.intervals.mock.results[0]!.value;

			// Its tick asks for a frame, and the frame it gets has moved.
			const requests = stage.host.renderRequests;
			if (typeof tick !== "function") throw new Error("the repaint interval has no handler");
			tick();
			expect(stage.host.renderRequests).toBe(requests + 1);
			const now = [...stage.render()];
			stage.now += SPINNER_REPAINT_MS;
			expect(stage.render()).not.toEqual(now);
			expect(timers.cleared(handle)).toBe(false);

			stage.host.roster[1]!.set(snapshot(end.state));
			const still = [...stage.render()];
			expect(timers.cleared(handle)).toBe(true);
			stage.now += 10 * SPINNER_REPAINT_MS;
			expect(stage.render()).toEqual(still);
			expect(timers.intervals).toHaveBeenCalledTimes(1);
		});
	}

	it("is cleared when the stage is disposed", async () => {
		const timers = watchTimers();
		const stage = await openRoom(workingRoster());
		const handle = timers.intervals.mock.results[0]!.value;
		stage.stage.dispose();
		expect(timers.cleared(handle)).toBe(true);
	});

	it("is cleared when the stage leaves the overview to enter a conversation, and not started again", async () => {
		const timers = watchTimers();
		const stage = await openRoom(workingRoster());
		const handle = timers.intervals.mock.results[0]!.value;
		await stage.press(KEY.enter);
		for (let i = 0; i < 5; i++) await stage.step();
		expect(timers.cleared(handle)).toBe(true);
		expect(timers.intervals).toHaveBeenCalledTimes(1);
	});

	it("is never started by the quick switch, which has no overview", async () => {
		const timers = watchTimers();
		const stage = new StageDriver({
			width: WIDTH,
			height: HEIGHT,
			members: workingRoster(),
			mode: { kind: "travel", targetId: "m1" },
		});
		for (let i = 0; i < 20; i++) await stage.step();
		expect(timers.intervals).not.toHaveBeenCalled();
	});
});
