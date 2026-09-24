/**
 * WHY: the room's last slot opens a new conversation. Drawn as a frame the
 * size of a window, it was the largest thing in a grid of two conversations
 * and the whole front of the row when selected, an empty window that drew the
 * eye away from the ones with something in them. It is a tile: at most
 * 30 cells by 7 rows, centred in whatever room the layout gives the slot, and
 * the whole slot when the slot is smaller than that.
 *
 * The class: a tile painted off centre, a tile that overflows a small slot,
 * and ground around the tile that carries anything but blank cells. The exact
 * size of every paint at every width and height is the frame sweep's.
 *
 * What it does NOT catch: where the layout puts the slot (the geometry
 * suites), and a click on the ground around the tile, which still opens a
 * conversation because the slot is the whole cell.
 */

import { describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { paintRoomNewSlot } from "@veyyon/coding-agent/modes/terminal/components/room/room-window";
import { theme } from "@veyyon/coding-agent/theme/theme";
import { useTruecolorTheme } from "../../../../helpers/theme-assertions";
import { START_MS } from "./room-stage-driver";

useTruecolorTheme("dark");

function slot(width: number, height: number, selected = false): string[] {
	return paintRoomNewSlot({ width, height, strength: 1, selected, starting: false, now: START_MS }).map(row =>
		stripVTControlCharacters(row),
	);
}

describe("the new-conversation slot", () => {
	it("is a 30 by 7 tile centred in a slot larger than that, on blank ground", () => {
		for (const selected of [false, true]) {
			const rows = slot(80, 30, selected);
			const box = theme.boxRound;
			const left = " ".repeat(25);
			expect(rows[11]).toBe(`${left}${box.topLeft}${box.horizontal.repeat(28)}${box.topRight}${left}`);
			expect(rows[17]).toBe(`${left}${box.bottomLeft}${box.horizontal.repeat(28)}${box.bottomRight}${left}`);
			expect(rows.slice(12, 17).join("\n")).toContain("New conversation");
			expect(rows[13]?.trim()).toBe(`${box.vertical}             +              ${box.vertical}`);
			const ground = [...rows.slice(0, 11), ...rows.slice(18)];
			expect(ground.every(row => row === " ".repeat(80))).toBe(true);
		}
	});

	it("fills a slot smaller than the tile, frame to frame", () => {
		const box = theme.boxRound;
		const rows = slot(20, 5);
		expect(rows[0]).toBe(`${box.topLeft}${box.horizontal.repeat(18)}${box.topRight}`);
		expect(rows[4]).toBe(`${box.bottomLeft}${box.horizontal.repeat(18)}${box.bottomRight}`);
	});
});
