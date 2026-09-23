/**
 * WHY THIS SUITE EXISTS.
 *
 * The room view is a transition between two screens the terminal really
 * shows: it opens from the screen the operator was on and it lands on the
 * screen of the conversation they chose. A cut at either end (a first frame
 * that is not the screen, a last frame that is not the screen that follows) is
 * the flash the view exists to remove. Between them the stage waits on the host
 * to put the chosen conversation on screen, and every way that wait can go
 * wrong is a stage stuck on screen: a land before the conversation is there, a
 * second land, a land after a refusal, a zoom that runs to full size over a
 * window with nothing behind it, a key that starts a second switch mid-flight.
 *
 * THE CLASS, NOT THE INCIDENT.
 *
 * Every way into a conversation is driven through the real stage on a manual
 * clock, in both layouts: entering a member whose conversation comes on screen
 * before the zoom reaches the hold, while the zoom is past the hold, and after
 * the zoom has waited at the hold; a refusal; the quick switch; transitions
 * off; Escape and the toggle key. Each asserts the first frame (the screen it
 * opened from), the last frame before the land (the rows the host composed,
 * cell for cell and style for style), that the land comes exactly once and
 * within the motion's duration, and that the stage holds at the hold for as
 * long as the conversation is not there.
 *
 * WHAT IT DOES NOT CATCH.
 *
 * Whether the host's composed rows are what the terminal paints after the
 * overlay lifts: that is the engine's `composeViewport` contract and the room
 * controller's, driven in their own suites. Frames the product clock drops
 * under load: the driver renders every tick.
 */

import { describe, expect, it } from "bun:test";
import { placeRoomWindows, type RoomRect } from "@veyyon/coding-agent/modes/terminal/components/room/room-geometry";
import type { RoomLayout } from "@veyyon/coding-agent/modes/terminal/components/room/room-stage";
import { MOTION } from "@veyyon/utils/motion";
import { useTruecolorTheme } from "../../../../helpers/theme-assertions";
import { cellText, rowCells } from "./room-frame-oracle";
import {
	FakeMember,
	FRAME_MS,
	KEY,
	pagerSelection,
	START_MS,
	StageDriver,
	type StageDriverOptions,
	screenRows,
	selectedWindowEdge,
	sgrMouse,
	snapshotOf,
} from "./room-stage-driver";

useTruecolorTheme("dark");

const WIDTH = 100;
const HEIGHT = 30;
const VIEWPORT = { width: WIDTH, height: HEIGHT };
const LAYOUTS: readonly RoomLayout[] = ["side-by-side", "all-windows"];
/** How far an entering window zooms before it waits for its conversation (`ENTER_HOLD` in room-stage.ts). */
const ENTER_HOLD = 0.72;
/** The most frames a curve of `duration` ms takes on a 60Hz clock, plus the frame that lands it. */
const framesFor = (duration: number): number => Math.ceil(duration / FRAME_MS) + 1;

function roster(count = 3): FakeMember[] {
	return Array.from(
		{ length: count },
		(_, i) =>
			new FakeMember(
				`m${i}`,
				snapshotOf({ kind: "done", at: START_MS - 1_000 }, [{ kind: "prompt", text: `question ${i}` }], {
					title: `conversation ${i}`,
				}),
				{ origin: i === 0 },
			),
	);
}

function driver(options: Partial<StageDriverOptions> & { members?: FakeMember[] } = {}): StageDriver {
	return new StageDriver({
		width: WIDTH,
		height: HEIGHT,
		members: options.members ?? roster(),
		originScreen: screenRows(WIDTH, HEIGHT, "origin"),
		...options,
	});
}

/** The first row where two frames differ in a glyph or a style, or undefined when they are the same screen. */
function screenDifference(frame: readonly string[], screen: readonly string[]): string | undefined {
	if (frame.length !== screen.length) return `${frame.length} rows against ${screen.length}`;
	for (let y = 0; y < screen.length; y++) {
		const got = rowCells(frame[y]!);
		const want = rowCells(screen[y]!);
		const width = Math.max(got.length, want.length);
		for (let x = 0; x < width; x++) {
			const a = got[x] ?? { text: " ", style: "" };
			const b = want[x] ?? { text: " ", style: "" };
			if (a.text !== b.text || a.style !== b.style) {
				return `row ${y} col ${x}: ${JSON.stringify(a)} where the screen has ${JSON.stringify(b)}`;
			}
		}
	}
	return undefined;
}

/** Where `slot` sits at `zoom`, with the row centred on it: the geometry the stage lays its frame out from. */
function rectAt(slot: number, zoom: number, layout: RoomLayout, count: number): RoomRect {
	const placements = placeRoomWindows(VIEWPORT, {
		count,
		scroll: slot,
		selected: slot,
		zoom,
		mix: layout === "all-windows" ? 1 : 0,
	});
	const placement = placements.find(p => p.slot === slot);
	if (!placement) throw new Error(`slot ${slot} is not on screen at zoom ${zoom}`);
	return placement.rect;
}

/** Open the room, settle, and move the selection to `slot`. */
async function overviewOn(stage: StageDriver, slot: number): Promise<void> {
	stage.render();
	await stage.settle();
	await stage.press(KEY.home);
	for (let i = 0; i < slot; i++) await stage.press(KEY.right);
	await stage.settle();
	expect(pagerSelection(stage.lastFrame, stage.host.roster.length)).toBe(slot);
}

/** Step until the host lands the stage, failing past `limit` frames. Returns the frames it took. */
async function stepUntilLanded(stage: StageDriver, limit: number): Promise<number> {
	let frames = 0;
	while (stage.host.lands.length === 0) {
		if (++frames > limit) throw new Error(`no land after ${limit} frames`);
		await stage.step();
	}
	return frames;
}

describe("the room opens from the screen the operator was on", () => {
	for (const layout of LAYOUTS) {
		for (const size of [
			{ width: 100, height: 30 },
			{ width: 37, height: 12 },
			{ width: 213, height: 60 },
		]) {
			for (const originSlot of [0, 2]) {
				it(`${layout}, ${size.width}x${size.height}, origin in slot ${originSlot}: the first frame is that screen`, () => {
					const origin = screenRows(size.width, size.height, "origin");
					const stage = new StageDriver({
						...size,
						members: roster(),
						originId: `m${originSlot}`,
						originScreen: origin,
						layout,
					});
					expect(screenDifference(stage.render(), origin)).toBeUndefined();
				});
			}
		}

		it(`${layout}: the open comes to rest within the zoom's duration, on the overview`, async () => {
			const stage = driver({ layout });
			stage.render();
			const frames = await stage.settle();
			expect(frames).toBeLessThanOrEqual(framesFor(MOTION.zoom.duration));
			expect(cellText(rowCells(stage.lastFrame[0]!))).toContain("Room");
			expect(pagerSelection(stage.lastFrame, 3)).toBe(0);
		});
	}
});

describe("entering a member lands on the screen its host composed", () => {
	for (const layout of LAYOUTS) {
		for (const slot of [0, 1, 2]) {
			it(`${layout}, slot ${slot}, the conversation ready at once: one prepare, one land, the last frame is its screen`, async () => {
				const stage = driver({ layout });
				await overviewOn(stage, slot);
				await stage.press(KEY.enter);
				expect(stage.host.prepares.map(call => call.id)).toEqual([`m${slot}`]);
				const composed = screenRows(WIDTH, HEIGHT, `m${slot}`);
				stage.host.prepares[0]!.resolve(composed);
				const frames = await stepUntilLanded(stage, framesFor(MOTION.zoom.duration));
				expect(frames).toBeLessThanOrEqual(framesFor(MOTION.zoom.duration));
				expect(stage.host.lands).toEqual([{ id: `m${slot}`, afterFrames: stage.frames.length }]);
				expect(screenDifference(stage.frames.at(-1)!, composed)).toBeUndefined();

				// After the land nothing the stage still receives lands it again or starts another switch.
				for (let i = 0; i < 30; i++) await stage.step();
				for (const key of [KEY.enter, KEY.escape, KEY.toggle, "1", "n"]) await stage.press(key);
				expect(stage.host.lands).toHaveLength(1);
				expect(stage.host.prepares).toHaveLength(1);
				expect(stage.host.creates).toEqual([]);
			});
		}

		it(`${layout}: a conversation that comes on screen only after the zoom reached the hold still lands, and the zoom waits at the hold until then`, async () => {
			const stage = driver({ layout });
			await overviewOn(stage, 1);
			const hold = rectAt(1, ENTER_HOLD, layout, 4);
			const full = rectAt(1, 1, layout, 4);
			expect(hold.w).toBeLessThan(full.w);
			await stage.press(KEY.enter);

			// Long past the zoom's own duration, the conversation still not there.
			const waiting = framesFor(MOTION.zoom.duration) + 30;
			const widths: number[] = [];
			for (let i = 0; i < waiting; i++) {
				const edge = selectedWindowEdge(await stage.step(), 2);
				expect(edge).toBeDefined();
				widths.push(edge!.w);
			}
			expect(Math.max(...widths)).toBe(hold.w);
			expect(widths.at(-1)).toBe(hold.w);
			expect(selectedWindowEdge(stage.lastFrame, 2)).toEqual({ x: hold.x, y: hold.y, w: hold.w });
			expect(stage.clock.liveCount).toBe(0);
			expect(stage.host.lands).toEqual([]);

			const composed = screenRows(WIDTH, HEIGHT, "m1");
			stage.host.prepares[0]!.resolve(composed);
			// The conversation comes on screen between two frames; the next frame is the first after it.
			await stage.flush();
			const resolvedAt = stage.frames.length;
			const frames = await stepUntilLanded(stage, framesFor(MOTION.expand.duration));
			expect(frames).toBeLessThanOrEqual(framesFor(MOTION.expand.duration));
			expect(stage.host.lands).toEqual([{ id: "m1", afterFrames: stage.frames.length }]);
			expect(screenDifference(stage.frames.at(-1)!, composed)).toBeUndefined();

			// From the hold, not from where the zoom's curve had got to.
			const resumed = rectAt(
				1,
				ENTER_HOLD + (1 - ENTER_HOLD) * MOTION.expand.easing(FRAME_MS / MOTION.expand.duration),
				layout,
				4,
			);
			expect(selectedWindowEdge(stage.frames[resolvedAt]!, 2)).toEqual({ x: resumed.x, y: resumed.y, w: resumed.w });
			let previous = hold.w;
			for (const frame of stage.frames.slice(resolvedAt, -1)) {
				const edge = selectedWindowEdge(frame, 2);
				if (edge === undefined) {
					expect(screenDifference(frame, composed)).toBeUndefined();
					continue;
				}
				expect(edge.w).toBeGreaterThanOrEqual(previous);
				previous = edge.w;
			}
		});

		it(`${layout}: a conversation that comes on screen while the zoom is past the hold resumes from the hold`, async () => {
			const stage = driver({ layout });
			await overviewOn(stage, 1);
			await stage.press(KEY.enter);
			// Half the zoom's duration: its curve is past the hold and still moving.
			for (let i = 0; i < Math.ceil(framesFor(MOTION.zoom.duration) / 2); i++) {
				const edge = selectedWindowEdge(await stage.step(), 2);
				expect(edge!.w).toBeLessThanOrEqual(rectAt(1, ENTER_HOLD, layout, 4).w);
			}
			expect(stage.clock.liveCount).toBeGreaterThan(0);
			const composed = screenRows(WIDTH, HEIGHT, "m1");
			stage.host.prepares[0]!.resolve(composed);
			await stage.flush();
			const resolvedAt = stage.frames.length;
			await stepUntilLanded(stage, framesFor(MOTION.expand.duration));
			const resumed = rectAt(
				1,
				ENTER_HOLD + (1 - ENTER_HOLD) * MOTION.expand.easing(FRAME_MS / MOTION.expand.duration),
				layout,
				4,
			);
			expect(selectedWindowEdge(stage.frames[resolvedAt]!, 2)).toEqual({ x: resumed.x, y: resumed.y, w: resumed.w });
			expect(stage.host.lands).toEqual([{ id: "m1", afterFrames: stage.frames.length }]);
			expect(screenDifference(stage.frames.at(-1)!, composed)).toBeUndefined();
		});

		it(`${layout}: a conversation that comes on screen before the zoom reaches the hold lands when the zoom does`, async () => {
			const stage = driver({ layout });
			await overviewOn(stage, 2);
			await stage.press(KEY.enter);
			const composed = screenRows(WIDTH, HEIGHT, "m2");
			await stage.step();
			stage.host.prepares[0]!.resolve(composed);
			const frames = 1 + (await stepUntilLanded(stage, framesFor(MOTION.zoom.duration)));
			expect(frames).toBeLessThanOrEqual(framesFor(MOTION.zoom.duration));
			// Not before the zoom arrives: a land that jumps the zoom is a cut.
			expect(frames).toBeGreaterThanOrEqual(framesFor(MOTION.zoom.duration) - 2);
			expect(stage.host.lands).toEqual([{ id: "m2", afterFrames: stage.frames.length }]);
			expect(screenDifference(stage.frames.at(-1)!, composed)).toBeUndefined();
			let previous = 0;
			for (const frame of stage.frames.slice(-frames, -1)) {
				const edge = selectedWindowEdge(frame, 3);
				if (edge === undefined) continue;
				expect(edge.w).toBeGreaterThanOrEqual(previous);
				previous = edge.w;
			}
		});

		it(`${layout}: a conversation that cannot be shown never lands; the stage returns to the overview and says why`, async () => {
			const stage = driver({ layout });
			await overviewOn(stage, 1);
			await stage.press(KEY.enter);
			for (let i = 0; i < 8; i++) await stage.step();
			const zoomedWidth = selectedWindowEdge(stage.lastFrame, 2)!.w;
			stage.host.prepares[0]!.reject(new Error("That conversation has closed."));
			await stage.settle();
			expect(stage.host.lands).toEqual([]);
			expect(stage.stage.destination).toBeUndefined();

			const rest = rectAt(1, 0, layout, 4);
			expect(selectedWindowEdge(stage.lastFrame, 2)).toEqual({ x: rest.x, y: rest.y, w: rest.w });
			expect(rest.w).toBeLessThan(zoomedWidth);
			expect(cellText(rowCells(stage.lastFrame[0]!))).toContain("Room");
			expect(cellText(rowCells(stage.lastFrame[HEIGHT - 3]!)).trim()).toBe(
				"Could not switch: That conversation has closed.",
			);

			// It stays refused however long the stage runs, and the overview answers keys again.
			for (let i = 0; i < 60; i++) await stage.step();
			expect(stage.host.lands).toEqual([]);
			await stage.press(KEY.enter);
			expect(stage.host.prepares.map(call => call.id)).toEqual(["m1", "m1"]);
		});

		it(`${layout}: Escape and the toggle key enter the conversation the room was opened from, not the selected one`, async () => {
			for (const key of [KEY.escape, KEY.toggle]) {
				for (const originSlot of [0, 2]) {
					const stage = driver({ layout, originId: `m${originSlot}` });
					await overviewOn(stage, originSlot === 0 ? 2 : 0);
					await stage.press(key);
					expect(stage.host.prepares.map(call => call.id)).toEqual([`m${originSlot}`]);
				}
			}
		});

		it(`${layout}: while entering, no key and no click starts anything else`, async () => {
			const stage = driver({ layout });
			await overviewOn(stage, 1);
			await stage.press(KEY.enter);
			await stage.step();
			const edge = selectedWindowEdge(stage.lastFrame, 2)!;
			for (const key of [
				KEY.enter,
				KEY.escape,
				KEY.toggle,
				KEY.tab,
				KEY.right,
				KEY.home,
				"1",
				"3",
				"n",
				"x",
				sgrMouse(0, edge.x + 2, edge.y + 2),
			]) {
				await stage.press(key);
				await stage.step();
			}
			expect(stage.host.prepares.map(call => call.id)).toEqual(["m1"]);
			expect(stage.host.creates).toEqual([]);
			expect(stage.host.closes).toEqual([]);
			expect(stage.stage.layout).toBe(layout);
			expect(stage.stage.destination).toBe("m1");
			stage.host.prepares[0]!.resolve(screenRows(WIDTH, HEIGHT, "m1"));
			await stepUntilLanded(stage, framesFor(MOTION.zoom.duration));
			expect(stage.host.lands.map(land => land.id)).toEqual(["m1"]);
		});

		for (const readyBeforeFirstTick of [true, false]) {
			it(`${layout}: Enter before the open has drawn a frame still lands, the conversation ready ${readyBeforeFirstTick ? "before" : "after"} the first tick`, async () => {
				// The open has not ticked, so the zoom is still exactly at the screen: the enter's zoom
				// starts at its own target.
				const stage = driver({ layout });
				stage.render();
				await stage.press(KEY.escape);
				expect(stage.host.prepares.map(call => call.id)).toEqual(["m0"]);
				const composed = screenRows(WIDTH, HEIGHT, "m0");
				if (readyBeforeFirstTick) {
					stage.host.prepares[0]!.resolve(composed);
					await stage.flush();
				} else {
					await stage.step();
					stage.host.prepares[0]!.resolve(composed);
				}
				await stepUntilLanded(stage, framesFor(MOTION.zoom.duration));
				expect(stage.host.lands).toEqual([{ id: "m0", afterFrames: stage.frames.length }]);
				expect(screenDifference(stage.frames.at(-1)!, composed)).toBeUndefined();
			});
		}
	}
});

describe("the quick switch travels to its target without the room's chrome", () => {
	it("never lands before the conversation is on screen, never shows chrome, lands once on the target's screen", async () => {
		const origin = screenRows(WIDTH, HEIGHT, "origin");
		const stage = driver({ originScreen: origin, mode: { kind: "travel", targetId: "m1" } });
		expect(screenDifference(stage.render(), origin)).toBeUndefined();
		expect(stage.host.prepares.map(call => call.id)).toEqual(["m1"]);

		// The pull back plays and then the stage waits, still, for as long as the host takes.
		for (let i = 0; i < 90; i++) await stage.step();
		expect(stage.host.lands).toEqual([]);
		expect(stage.clock.liveCount).toBe(0);
		expect(stage.frames.at(-1)).toEqual(stage.frames.at(-2)!);

		// Keys wait while the stage is in flight.
		for (const key of [KEY.enter, KEY.escape, KEY.toggle, "2", "n", "x", KEY.tab]) await stage.press(key);
		expect(stage.host.prepares).toHaveLength(1);
		expect(stage.host.creates).toEqual([]);
		expect(stage.host.closes).toEqual([]);

		const composed = screenRows(WIDTH, HEIGHT, "m1");
		stage.host.prepares[0]!.resolve(composed);
		const frames = await stepUntilLanded(stage, framesFor(MOTION.travel.duration));
		expect(frames).toBeLessThanOrEqual(framesFor(MOTION.travel.duration));
		expect(stage.host.lands).toEqual([{ id: "m1", afterFrames: stage.frames.length }]);
		expect(screenDifference(stage.frames.at(-1)!, composed)).toBeUndefined();

		for (const [index, frame] of stage.frames.entries()) {
			const text = frame.map(row => cellText(rowCells(row))).join("\n");
			expect({ index, room: text.includes("Room"), hints: text.includes("esc back") }).toEqual({
				index,
				room: false,
				hints: false,
			});
		}
	});

	// 0: the host refuses before the pull back has drawn a frame, while the zoom is still exactly at
	// the screen, so the push back starts at its own target.
	for (const refusedAfter of [0, 3, 30]) {
		it(`a target refused ${refusedAfter} frames in pushes back into the screen it left and lands there once, with the reason`, async () => {
			const origin = screenRows(WIDTH, HEIGHT, "origin");
			const stage = driver({ originScreen: origin, mode: { kind: "travel", targetId: "m1" } });
			stage.render();
			for (let i = 0; i < refusedAfter; i++) await stage.step();
			const reason = new Error("That conversation has closed.");
			stage.host.prepares[0]!.reject(reason);
			await stage.flush();
			const frames = await stepUntilLanded(stage, framesFor(MOTION.expand.duration));
			expect(frames).toBeLessThanOrEqual(framesFor(MOTION.expand.duration));
			expect(stage.host.lands).toEqual([{ id: "m0", afterFrames: stage.frames.length, failure: reason }]);
			expect(screenDifference(stage.frames.at(-1)!, origin)).toBeUndefined();
			for (let i = 0; i < 30; i++) await stage.step();
			expect(stage.host.lands).toHaveLength(1);
			for (const frame of stage.frames) {
				expect(frame.some(row => cellText(rowCells(row)).includes("Room"))).toBe(false);
			}
		});
	}
});

describe("with transitions off the stage cuts instead of moving", () => {
	for (const layout of LAYOUTS) {
		it(`${layout}: the overview is at rest on its first render, the frame the animated open comes to rest on`, async () => {
			const still = driver({ layout, motion: false });
			const first = still.render();
			expect(still.clock.liveCount).toBe(0);
			const moving = driver({ layout });
			moving.render();
			await moving.settle();
			expect(first).toEqual(moving.lastFrame);
			expect(cellText(rowCells(first[0]!))).toContain("Room");
		});

		it(`${layout}: entering lands as soon as the conversation is on screen, with no frame and no clock tick between`, async () => {
			const stage = driver({ layout, motion: false });
			stage.render();
			await stage.press(KEY.right);
			await stage.press(KEY.enter);
			expect(stage.host.prepares.map(call => call.id)).toEqual(["m1"]);
			expect(stage.clock.liveCount).toBe(0);
			await stage.flush();
			expect(stage.host.lands).toEqual([]);
			const framesBefore = stage.frames.length;
			stage.host.prepares[0]!.resolve(screenRows(WIDTH, HEIGHT, "m1"));
			await stage.flush();
			expect(stage.host.lands).toEqual([{ id: "m1", afterFrames: framesBefore }]);
			expect(stage.clock.liveCount).toBe(0);
		});
	}
});
