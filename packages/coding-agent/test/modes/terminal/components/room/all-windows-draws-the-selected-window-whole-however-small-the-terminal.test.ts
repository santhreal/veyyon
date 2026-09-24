/**
 * All windows draws the selected window whole, however small the terminal.
 *
 * WHY THIS SUITE EXISTS. The all-windows grid picks a shape whose windows read
 * at a useful size. On a short terminal with many conversations no shape fits,
 * and a grid that laid every row out anyway pushed the later rows past the
 * bottom of the room: the arrows moved the highlight onto windows nobody could
 * see, and a row cut by the chrome bands drew a window half over the pager and
 * the key hints.
 *
 * THE CLASS CLOSED. For every terminal size from the smallest the room lays
 * out to a large one, every window count from one to sixteen and every
 * selected slot, at rest in all windows: the selected window is placed, every
 * placed window lies whole inside the card area between the chrome bands, no
 * two placed windows overlap, and a grid whose rows all fit places every
 * window. The shape comes from `roomGridShape` and the placements from
 * `placeRoomWindows`, the functions the stage draws from.
 *
 * NOT CAUGHT. The frames of the transition into and out of all windows, which
 * the stage suites pin cell by cell at ordinary sizes. Whether a window this
 * small is worth reading: the minimums are a design decision, not a contract.
 */

import { describe, expect, it } from "bun:test";
import {
	placeRoomWindows,
	type RoomRect,
	type RoomViewport,
	roomCardArea,
	roomGridShape,
} from "@veyyon/coding-agent/modes/terminal/components/room/room-geometry";

const WIDTHS = [18, 30, 40, 60, 80, 120, 200];
const HEIGHTS = [9, 10, 12, 14, 18, 24, 40];
const MAX_COUNT = 16;

function overlaps(a: RoomRect, b: RoomRect): boolean {
	return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** What is wrong with one resting grid, or nothing. */
function faults(viewport: RoomViewport, count: number, selected: number): string[] {
	const found: string[] = [];
	const area = roomCardArea(viewport);
	const placements = placeRoomWindows(viewport, { count, scroll: selected, selected, zoom: 0, mix: 1 });
	if (!placements.some(placement => placement.slot === selected)) found.push("the selected window is not drawn");
	for (const { slot, rect } of placements) {
		if (rect.x < 0 || rect.x + rect.w > viewport.width) found.push(`window ${slot} runs past the side`);
		if (rect.y < area.top || rect.y + rect.h > area.top + area.height) {
			found.push(`window ${slot} (rows ${rect.y}..${rect.y + rect.h - 1}) leaves the card area`);
		}
	}
	for (let i = 0; i < placements.length; i++) {
		for (let j = i + 1; j < placements.length; j++) {
			if (overlaps(placements[i]!.rect, placements[j]!.rect)) {
				found.push(`windows ${placements[i]!.slot} and ${placements[j]!.slot} overlap`);
			}
		}
	}
	const { rows } = roomGridShape(viewport, count);
	const fitsWhole = rows * 6 - 1 <= area.height;
	if (fitsWhole && placements.length !== count) found.push(`${placements.length} of ${count} windows drawn`);
	return found;
}

describe("all windows at rest", () => {
	for (const width of WIDTHS) {
		for (const height of HEIGHTS) {
			it(`${width}x${height}: the selected window is drawn whole inside the room, for one to ${MAX_COUNT} windows`, () => {
				const viewport = { width, height };
				const wrong: string[] = [];
				for (let count = 1; count <= MAX_COUNT; count++) {
					for (let selected = 0; selected < count; selected++) {
						for (const fault of faults(viewport, count, selected)) {
							wrong.push(`${count} windows, slot ${selected} selected: ${fault}`);
						}
					}
				}
				expect(wrong).toEqual([]);
			});
		}
	}

	it("a grid that pages shows more than one window when the width holds more than one column", () => {
		// 80 columns, a room of 8 rows: nine conversations cannot each get a
		// readable row, and the fallback reads as a grid, not a single column.
		const viewport = { width: 80, height: 14 };
		expect(roomGridShape(viewport, 9).columns).toBeGreaterThan(1);
		const placed = placeRoomWindows(viewport, { count: 9, scroll: 0, selected: 0, zoom: 0, mix: 1 });
		expect(placed.length).toBeGreaterThan(1);
	});
});
