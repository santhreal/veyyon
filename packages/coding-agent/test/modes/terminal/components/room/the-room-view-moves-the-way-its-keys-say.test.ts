/**
 * WHY THIS SUITE EXISTS.
 *
 * The room view's key hints and its pager are a promise: this key moves the
 * highlight there, this digit opens that conversation, `x` closes the selected
 * one (and asks first when it is working, and never closes the one on screen),
 * `n` opens a new one, Tab flips the layout, the pointer picks what it points
 * at. A stage that moves the highlight somewhere other than where the key
 * says, lets a digit open a conversation that does not exist, or closes a
 * working conversation on one keystroke breaks that promise silently: the
 * frame still looks like a room.
 *
 * THE CLASS, NOT THE INCIDENT.
 *
 * Every key the overview answers is driven through the real stage and read
 * back from the frame the operator sees: the lit ordinal in the pager and the
 * selection cursor on the window's top edge. The grid arrows are swept over
 * every slot and every direction for one to nine conversations at two terminal
 * sizes against `moveGridSelection`'s own answer, so a stage that stops asking
 * it, or asks it with the wrong count or viewport, fails. Digits are swept 0..9
 * against one to nine conversations. The close confirmation is pinned on both
 * sides of its three-second window.
 *
 * WHAT IT DOES NOT CATCH.
 *
 * Keys the terminal encodes differently (kitty protocol, keypad): that is the
 * key parser's contract. Whether `moveGridSelection` itself is the right
 * geometry: it is the oracle here. The keys while the stage is entering or
 * travelling are the entering suite's.
 */

import { afterEach, describe, expect, it, vi } from "bun:test";
import {
	moveGridSelection,
	placeRoomWindows,
	type RoomRect,
} from "@veyyon/coding-agent/modes/terminal/components/room/room-geometry";
import type { RoomLayout } from "@veyyon/coding-agent/modes/terminal/components/room/room-stage";
import { useTruecolorTheme } from "../../../../helpers/theme-assertions";
import { cellText, rowCells } from "./room-frame-oracle";
import {
	disposeStages,
	FakeMember,
	KEY,
	pagerSelection,
	START_MS,
	StageDriver,
	selectedWindowEdge,
	sgrMouse,
	snapshotOf,
} from "./room-stage-driver";

useTruecolorTheme("dark");

afterEach(() => {
	vi.restoreAllMocks();
	disposeStages();
});

const WIDTH = 100;
const HEIGHT = 30;
/** Quiet time after the last wheel notch before the row settles (`WHEEL_SETTLE_MS` in room-stage.ts). */
const WHEEL_SETTLE_MS = 140;
/** How long a first `x` on a working conversation waits for the second (`CLOSE_CONFIRM_MS`). */
const CLOSE_CONFIRM_MS = 3000;
const BUTTON = { left: 0, motion: 35, wheelUp: 64, wheelDown: 65, wheelLeft: 66, wheelRight: 67 } as const;

const DONE = snapshotOf({ kind: "done", at: START_MS - 1_000 }, [{ kind: "prompt", text: "a finished question" }]);
const WORKING = snapshotOf({ kind: "working", since: START_MS - 5_000, activity: "writing" }, [
	{ kind: "prompt", text: "a question in progress" },
]);

/**
 * The wheel's quiet-period timers, watched through `setTimeout`/`clearTimeout`
 * rather than waited out: `elapse` runs the standing one, which is the quiet
 * period ending without the test sleeping through it.
 */
function watchWheelQuiet(): { scheduled: () => number; standing: () => number; elapse: () => void } {
	const timeouts = vi.spyOn(globalThis, "setTimeout");
	const clears = vi.spyOn(globalThis, "clearTimeout");
	const settles = (): Array<{ handler: unknown; timer: unknown }> =>
		timeouts.mock.calls.flatMap((call, index) =>
			call[1] === WHEEL_SETTLE_MS ? [{ handler: call[0], timer: timeouts.mock.results[index]?.value }] : [],
		);
	const cleared = (timer: unknown): boolean => clears.mock.calls.some(call => call[0] === timer);
	return {
		scheduled: () => settles().length,
		standing: () => settles().filter(settle => !cleared(settle.timer)).length,
		elapse: () => {
			const standing = settles().filter(settle => !cleared(settle.timer));
			const handler = standing.at(-1)?.handler;
			if (standing.length !== 1 || typeof handler !== "function") throw new Error("no single quiet timer standing");
			handler();
		},
	};
}

/** m0 is the one on screen; m1 is working; m2 and m3 are idle. */
function roster(): FakeMember[] {
	return [
		new FakeMember("m0", DONE, { origin: true }),
		new FakeMember("m1", WORKING),
		new FakeMember("m2", DONE),
		new FakeMember("m3", snapshotOf({ kind: "stopped" })),
	];
}

function idleRoster(count: number): FakeMember[] {
	return Array.from({ length: count }, (_, i) => new FakeMember(`m${i}`, DONE, { origin: i === 0 }));
}

async function openRoom(
	options: { layout?: RoomLayout; members?: FakeMember[]; width?: number; height?: number; motion?: boolean } = {},
): Promise<StageDriver> {
	const stage = new StageDriver({
		width: options.width ?? WIDTH,
		height: options.height ?? HEIGHT,
		members: options.members ?? roster(),
		layout: options.layout,
		motion: options.motion,
	});
	stage.render();
	await stage.settle();
	return stage;
}

/** Press a key, let the row come to rest, and read back which slot the pager lights. */
async function pressAndRead(stage: StageDriver, key: string): Promise<number | undefined> {
	await stage.press(key);
	await stage.settle();
	return pagerSelection(stage.lastFrame, stage.host.roster.length);
}

function restRect(stage: StageDriver, slot: number, layout: RoomLayout, selected = slot): RoomRect {
	const placements = placeRoomWindows(
		{ width: stage.width, height: stage.height },
		{
			count: stage.host.roster.length + 1,
			scroll: selected,
			selected,
			zoom: 0,
			mix: layout === "all-windows" ? 1 : 0,
		},
	);
	const placement = placements.find(p => p.slot === slot);
	if (!placement) throw new Error(`slot ${slot} is not on screen`);
	return placement.rect;
}

function pagerText(stage: StageDriver): string {
	return cellText(rowCells(stage.lastFrame[stage.height - 3]!)).trim();
}

function titleText(stage: StageDriver): string {
	return cellText(rowCells(stage.lastFrame[0]!));
}

describe("side by side, the arrows walk the row and stop at its ends", () => {
	it("Left, Right, Home and End move the highlight, centre the window and clamp at both ends", async () => {
		const stage = await openRoom();
		const walk: Array<[string, number]> = [
			[KEY.left, 0],
			[KEY.right, 1],
			[KEY.right, 2],
			[KEY.end, 4],
			[KEY.right, 4],
			[KEY.left, 3],
			[KEY.up, 3],
			[KEY.down, 3],
			[KEY.home, 0],
			[KEY.left, 0],
		];
		for (const [key, slot] of walk) {
			expect({ key, slot: await pressAndRead(stage, key) }).toEqual({ key, slot });
			if (slot < stage.host.roster.length) {
				const rect = restRect(stage, slot, "side-by-side");
				expect(selectedWindowEdge(stage.lastFrame, slot + 1)).toEqual({ x: rect.x, y: rect.y, w: rect.w });
			}
		}
	});
});

describe("digits open the conversation they number, and only one that exists", () => {
	for (let count = 1; count <= 9; count++) {
		it(`${count} conversation${count === 1 ? "" : "s"}: digits 0..9`, async () => {
			for (let digit = 0; digit <= 9; digit++) {
				const stage = await openRoom({ members: idleRoster(count), motion: false });
				await stage.press(String(digit));
				const expected = digit >= 1 && digit <= count ? [`m${digit - 1}`] : [];
				expect({ digit, prepared: stage.host.prepares.map(call => call.id) }).toEqual({
					digit,
					prepared: expected,
				});
				expect(stage.host.creates).toEqual([]);
			}
		});
	}
});

describe("n and the new-conversation slot open a conversation and enter it", () => {
	it("n creates a conversation, adds it to the room and enters it", async () => {
		const stage = await openRoom();
		await stage.press("n");
		expect(stage.host.creates).toEqual(["created-1"]);
		expect(stage.host.roster.map(member => member.id)).toEqual(["m0", "m1", "m2", "m3", "created-1"]);
		expect(stage.host.prepares.map(call => call.id)).toEqual(["created-1"]);
	});

	it("Enter on the + slot does the same", async () => {
		const stage = await openRoom();
		expect(await pressAndRead(stage, KEY.end)).toBe(4);
		await stage.press(KEY.enter);
		expect(stage.host.creates).toEqual(["created-1"]);
		expect(stage.host.prepares.map(call => call.id)).toEqual(["created-1"]);
	});
});

describe("x closes the selected conversation, asks first when it is working, and never closes the one on screen", () => {
	const confirmNotice = "Conversation 2 is working. Press x again to stop it and close it.";

	it("a working conversation needs a second x; the first one only asks", async () => {
		const stage = await openRoom();
		await pressAndRead(stage, KEY.right);
		await stage.press("x");
		stage.render();
		expect(stage.host.closes).toEqual([]);
		expect(pagerText(stage)).toBe(confirmNotice);
		await stage.press("x");
		expect(stage.host.closes).toEqual(["m1"]);
		expect(stage.host.roster.map(member => member.id)).toEqual(["m0", "m2", "m3"]);
	});

	it("the second x closes up to the last millisecond of the confirmation window, not at its end", async () => {
		for (const [wait, closes] of [
			[CLOSE_CONFIRM_MS - 1, ["m1"]],
			[CLOSE_CONFIRM_MS, []],
		] as const) {
			const stage = await openRoom();
			await pressAndRead(stage, KEY.right);
			await stage.press("x");
			stage.now += wait;
			await stage.press("x");
			expect({ wait, closes: stage.host.closes }).toEqual({ wait, closes: [...closes] });
		}
	});

	it("moving the highlight away disarms the first x", async () => {
		const stage = await openRoom();
		await pressAndRead(stage, KEY.right);
		await stage.press("x");
		await pressAndRead(stage, KEY.right);
		await pressAndRead(stage, KEY.left);
		await stage.press("x");
		stage.render();
		expect(stage.host.closes).toEqual([]);
		expect(pagerText(stage)).toBe(confirmNotice);
	});

	it("an idle conversation closes on the first x, and the highlight stays in the room", async () => {
		const stage = await openRoom();
		expect(await pressAndRead(stage, KEY.end)).toBe(4);
		await pressAndRead(stage, KEY.left);
		await stage.press("x");
		expect(stage.host.closes).toEqual(["m3"]);
		await stage.settle();
		expect(pagerSelection(stage.lastFrame, stage.host.roster.length)).toBe(3);
	});

	it("the conversation on screen is refused however often x is pressed", async () => {
		const stage = await openRoom();
		await stage.press("x");
		await stage.press("x");
		stage.render();
		expect(stage.host.closes).toEqual([]);
		expect(pagerText(stage)).toBe(
			"This is the conversation on screen. Enter another one, then close this one from there.",
		);
	});

	it("x on the + slot closes nothing, and a close the host refuses keeps the conversation and says why", async () => {
		const stage = await openRoom();
		await pressAndRead(stage, KEY.end);
		await stage.press("x");
		expect(stage.host.closes).toEqual([]);
		stage.host.closeRefusal = "It is holding a question for you.";
		await pressAndRead(stage, KEY.left);
		await stage.press("x");
		stage.render();
		expect(stage.host.closes).toEqual(["m3"]);
		expect(stage.host.roster).toHaveLength(4);
		expect(pagerText(stage)).toBe("It is holding a question for you.");
	});
});

describe("Tab flips the layout the title row names", () => {
	it("side by side and all windows, back and forth", async () => {
		const stage = await openRoom();
		expect(titleText(stage).trimEnd().endsWith("side by side")).toBe(true);
		for (const layout of ["all-windows", "side-by-side", "all-windows"] as const) {
			await stage.press(KEY.tab);
			await stage.settle();
			expect(stage.stage.layout).toBe(layout);
			expect(
				titleText(stage)
					.trimEnd()
					.endsWith(layout === "all-windows" ? "all windows" : "side by side"),
			).toBe(true);
			expect(cellText(rowCells(stage.lastFrame[HEIGHT - 1]!))).toContain(
				layout === "all-windows" ? "tab side by side" : "tab all windows",
			);
		}
	});
});

describe("in all windows the arrows follow the grid", () => {
	for (const size of [
		{ width: 100, height: 30 },
		{ width: 213, height: 60 },
	]) {
		it(`${size.width}x${size.height}: every slot and every arrow for one to nine conversations, as moveGridSelection answers`, async () => {
			const moves: string[] = [];
			let verticalMoves = 0;
			for (let count = 1; count <= 9; count++) {
				const stage = await openRoom({ ...size, members: idleRoster(count), layout: "all-windows", motion: false });
				const slots = count + 1;
				for (let start = 0; start < slots; start++) {
					for (const direction of ["left", "right", "up", "down"] as const) {
						await stage.press(KEY.home);
						for (let i = 0; i < start; i++) await stage.press(KEY.right);
						stage.render();
						const from = pagerSelection(stage.lastFrame, count);
						const expected = moveGridSelection(size, slots, start, direction);
						await stage.press(KEY[direction]);
						stage.render();
						const to = pagerSelection(stage.lastFrame, count);
						if (from !== start || to !== expected)
							moves.push(`${count} members, ${direction} from ${start}: ${from} -> ${to}, expected ${expected}`);
						if ((direction === "up" || direction === "down") && expected !== start) verticalMoves++;
					}
				}
			}
			expect(moves).toEqual([]);
			// The sweep reaches grids with more than one row, so up and down are exercised, not only answered in place.
			expect(verticalMoves).toBeGreaterThan(0);
		});
	}
});

describe("the pointer picks what it points at", () => {
	for (const layout of ["side-by-side", "all-windows"] as const) {
		it(`${layout}: a left click on a window enters it, on the + slot creates one, on bare ground does nothing`, async () => {
			const stage = await openRoom({ layout });
			const ground = sgrMouse(BUTTON.left, 0, 1);
			await stage.press(ground);
			expect(stage.host.prepares).toEqual([]);
			// With one conversation the + slot sits beside it in either layout.
			const onPlus = await openRoom({ layout, members: idleRoster(1) });
			const plus = restRect(onPlus, 1, layout, 0);
			await onPlus.press(sgrMouse(BUTTON.left, Math.max(0, plus.x) + 1, plus.y + 1));
			expect(onPlus.host.creates).toEqual(["created-1"]);
			const target = restRect(stage, 2, layout, 0);
			await stage.press(sgrMouse(BUTTON.left, Math.max(0, target.x) + 1, target.y + 1));
			expect(stage.host.prepares.map(call => call.id)).toEqual(["m2"]);
		});
	}

	it("side by side: wheel and sideways wheel notches slide the row, then it settles on a whole window once quiet", async () => {
		for (const button of [BUTTON.wheelRight, BUTTON.wheelDown]) {
			const reference = await openRoom({ members: idleRoster(4) });
			await pressAndRead(reference, KEY.right);
			const stage = await openRoom({ members: idleRoster(4) });
			const quiet = watchWheelQuiet();
			for (let notch = 0; notch < 3; notch++) await stage.press(sgrMouse(button, 50, 10));
			await stage.settle();
			// Three notches are just past one window: the row rests between windows until it is quiet.
			expect(stage.lastFrame).not.toEqual(reference.lastFrame);
			expect(pagerSelection(stage.lastFrame, 4)).toBe(1);
			// Each notch restarts the quiet period, so only the last one's timer is still standing.
			expect(quiet.scheduled()).toBe(3);
			expect(quiet.standing()).toBe(1);
			quiet.elapse();
			await stage.settle();
			expect(stage.lastFrame).toEqual(reference.lastFrame);
			vi.restoreAllMocks();
		}
	});

	it("side by side: notches never carry the row past either end", async () => {
		const stage = await openRoom({ members: idleRoster(3) });
		for (let notch = 0; notch < 20; notch++) await stage.press(sgrMouse(BUTTON.wheelRight, 50, 10));
		await stage.settle();
		expect(pagerSelection(stage.lastFrame, 3)).toBe(3);
		for (let notch = 0; notch < 20; notch++) await stage.press(sgrMouse(BUTTON.wheelLeft, 50, 10));
		await stage.settle();
		expect(pagerSelection(stage.lastFrame, 3)).toBe(0);
	});

	it("all windows: the wheel moves the highlight a row, the sideways wheel a window", async () => {
		const size = { width: WIDTH, height: HEIGHT };
		const stage = await openRoom({ layout: "all-windows", members: idleRoster(5) });
		const slots = 6;
		let selected = 0;
		for (const [button, direction] of [
			[BUTTON.wheelDown, "down"],
			[BUTTON.wheelRight, "right"],
			[BUTTON.wheelUp, "up"],
			[BUTTON.wheelLeft, "left"],
		] as const) {
			selected = moveGridSelection(size, slots, selected, direction);
			await stage.press(sgrMouse(button, 50, 10));
			await stage.settle();
			expect({ direction, slot: pagerSelection(stage.lastFrame, 5) }).toEqual({ direction, slot: selected });
		}
	});

	it("all windows: the highlight follows the pointer; side by side it does not", async () => {
		const grid = await openRoom({ layout: "all-windows" });
		for (const slot of [2, 4, 1]) {
			const rect = restRect(grid, slot, "all-windows", 0);
			await grid.press(sgrMouse(BUTTON.motion, rect.x + 2, rect.y + 2));
			grid.render();
			expect(pagerSelection(grid.lastFrame, 4)).toBe(slot);
		}
		await grid.press(sgrMouse(BUTTON.motion, 0, 0));
		grid.render();
		expect(pagerSelection(grid.lastFrame, 4)).toBe(1);

		const row = await openRoom();
		const neighbour = restRect(row, 1, "side-by-side", 0);
		await row.press(sgrMouse(BUTTON.motion, neighbour.x + 2, neighbour.y + 2));
		await row.settle();
		expect(pagerSelection(row.lastFrame, 4)).toBe(0);
	});
});
