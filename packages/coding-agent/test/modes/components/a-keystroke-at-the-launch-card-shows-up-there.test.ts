/**
 * WHY: the launch card paints a composer and session startup then runs for the
 * better part of a second, so the card shows something that looks ready to type
 * into long before anything can receive a keystroke. The first frame's input
 * gate already KEEPS what is typed in that window and hands it to the real
 * composer at mount, but it did not draw it, so the operator got no echo and
 * the card read as a composer that had stopped listening.
 *
 * The class this closes is "the card lies about being live". It is not enough
 * that the text survives; the frame has to show it, at the width it will be
 * shown at, without moving the rows the mounted zone swaps into. So this pins:
 *
 * 1. The ghost prompt is what an untouched card shows.
 * 2. A draft replaces the ghost prompt rather than joining it.
 * 3. The row count does not move with the draft. The mounted composer takes
 *    these exact rows, and a card that grows a row when you type would push
 *    the whole zone and undo what the static frame exists to prevent.
 * 4. A draft wider than the row keeps its END. The next character lands there
 *    and that is where a typist is looking; keeping the head would freeze the
 *    visible text after the row filled, which is the same defect again.
 *
 * WHAT IT DOES NOT CATCH: that the gate actually calls setDraft, or that a
 * render is scheduled for it. That wiring is in `paintFirstFrame`, which owns a
 * real TUI and a real tty; it is exercised by the launch path, not here.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import {
	COMPOSER_PLACEHOLDER,
	COMPOSER_RESTING_ROWS,
	StaticComposerFrame,
} from "@veyyon/coding-agent/modes/components/composer-chrome";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";

beforeAll(async () => {
	await initTheme();
});

function rows(frame: StaticComposerFrame, width: number): string[] {
	return frame.render(width).map(row => stripVTControlCharacters(row));
}

/** The one row that carries the gutter and whatever the card is showing. */
function inputRow(frame: StaticComposerFrame, width: number): string {
	const row = rows(frame, width).find(line => line.includes("›"));
	expect(row).toBeDefined();
	return row as string;
}

describe("the launch card's composer", () => {
	it("shows the ghost prompt until something is typed", () => {
		expect(inputRow(new StaticComposerFrame(), 80)).toContain(COMPOSER_PLACEHOLDER);
	});

	it("shows what was typed at it instead of the ghost prompt", () => {
		const frame = new StaticComposerFrame();
		frame.setDraft("fix the parser");

		const row = inputRow(frame, 80);
		expect(row).toContain("fix the parser");
		expect(row).not.toContain(COMPOSER_PLACEHOLDER);
	});

	it("keeps the resting row count once a draft is showing", () => {
		const frame = new StaticComposerFrame();
		const restingRows = frame.render(80).length;
		frame.setDraft("a draft long enough to be interesting");

		expect(restingRows).toBe(COMPOSER_RESTING_ROWS);
		expect(frame.render(80)).toHaveLength(COMPOSER_RESTING_ROWS);
	});

	it("keeps the end of a draft that is wider than the row", () => {
		const frame = new StaticComposerFrame();
		frame.setDraft("abcdefghijklmnopqrstuvwxyz");

		const row = inputRow(frame, 20);
		expect(row).toContain("z");
		expect(row).not.toContain("a");
	});

	it("draws a row rather than throwing when the terminal has no room for one", () => {
		const frame = new StaticComposerFrame();
		frame.setDraft("wide enough to not fit");

		expect(frame.render(1)).toHaveLength(COMPOSER_RESTING_ROWS);
	});
});
