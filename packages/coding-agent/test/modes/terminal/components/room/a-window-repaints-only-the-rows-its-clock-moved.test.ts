/**
 * WHY: the room view repaints every working window on the spinner cadence for
 * as long as it is open. A full paint rewraps the window's whole body for a
 * frame whose only change is the spinner glyph, its colour and the turn's
 * clock, all on the top edge. `repaintRoomWindowClock` paints only the rows
 * the clock moved and reuses the rest.
 *
 * The class: a clock repaint that draws anything a full paint at that instant
 * would not. The sweep crosses every size path the painter has (too small for
 * a frame, a glyph-only frame, a compact frame, a card, a card dissolving into
 * the screen, the whole-terminal crop), every state and every activity read
 * from `ROOM_ACTIVITIES`, a window holding a question, a draft, the selection
 * and a receding strength, and asserts the clock repaint equals a full paint
 * row for row. A future edit that reads the clock anywhere below the top edge
 * fails here on every working case of the card path.
 *
 * What it does NOT catch: the stage deciding to reuse rows for a change that
 * is not the clock (its key over the snapshot, the draft, the screen and the
 * geometry); the frame sweeps and the idle-room suite pin that.
 */

import { describe, expect, it } from "bun:test";
import {
	ROOM_ACTIVITIES,
	type RoomFeedBlock,
	type RoomWindowState,
} from "@veyyon/coding-agent/modes/terminal/components/room/room-view-model";
import {
	paintRoomWindow,
	type RoomWindowPaint,
	repaintRoomWindowClock,
} from "@veyyon/coding-agent/modes/terminal/components/room/room-window";
import { useTruecolorTheme } from "../../../../helpers/theme-assertions";
import { START_MS, snapshotOf } from "./room-stage-driver";

useTruecolorTheme("dark");

const BLOCKS: readonly RoomFeedBlock[] = [
	{ kind: "prompt", text: "split the tokenizer out of the parser" },
	{ kind: "text", text: "The tokenizer now owns its state machine." },
	{ kind: "tool", label: "bash", detail: "bun test test/parser", state: "running" },
];

const STATES: ReadonlyArray<readonly [string, RoomWindowState]> = [
	...ROOM_ACTIVITIES.map(
		activity => [`working ${activity}`, { kind: "working", since: START_MS - 41_000, activity }] as const,
	),
	["done", { kind: "done", at: START_MS - 120_000 }],
	["failed", { kind: "failed", reason: "overloaded" }],
	["stopped", { kind: "stopped" }],
	["new", { kind: "new" }],
];

const SCREEN = Array.from({ length: 40 }, (_, i) => `screen row ${i} of the conversation`);

/** Every size path the painter takes, by the geometry that selects it. */
const SIZES: ReadonlyArray<{
	readonly name: string;
	readonly width: number;
	readonly height: number;
	readonly framed: boolean;
	readonly mix?: number;
}> = [
	{ name: "no room for a frame", width: 3, height: 2, framed: true },
	{ name: "glyph-only frame", width: 9, height: 6, framed: true },
	{ name: "compact frame", width: 20, height: 10, framed: true },
	{ name: "card", width: 60, height: 16, framed: true },
	{ name: "card dissolving into its screen", width: 60, height: 16, framed: true, mix: 0.7 },
	{ name: "card over the start of its screen", width: 60, height: 16, framed: true, mix: 0.3 },
	{ name: "the whole terminal", width: 80, height: 24, framed: false, mix: 1 },
];

/** Two instants several spinner frames and several clock seconds apart. */
const BEFORE = START_MS;
const AFTER = START_MS + 7 * 80 + 3_210;

describe("a window's clock repaint", () => {
	it("draws exactly what a full paint at that instant draws, on every path", () => {
		const mismatches: string[] = [];
		let moved = 0;
		for (const size of SIZES) {
			for (const [stateName, state] of STATES) {
				for (const variant of [
					{ name: "plain", selected: false, strength: 1, waitingDialogs: 0 },
					{ name: "selected", selected: true, strength: 1, waitingDialogs: 0 },
					{ name: "receding", selected: false, strength: 0.55, waitingDialogs: 0 },
					{ name: "waiting with a draft", selected: false, strength: 1, waitingDialogs: 1, draft: true },
				]) {
					const paintAt = (now: number): RoomWindowPaint => ({
						width: size.width,
						height: size.height,
						snapshot: snapshotOf(state, state.kind === "new" ? [] : BLOCKS, { title: "parser rewrite" }),
						ordinal: 2,
						strength: variant.strength,
						selected: variant.selected,
						framed: size.framed,
						waitingDialogs: variant.waitingDialogs,
						draft: variant.draft ? { line: "explain the second fact", images: 1, files: 0 } : undefined,
						screen: size.mix === undefined ? undefined : { rows: SCREEN, mix: size.mix },
						now,
					});
					const earlier = paintRoomWindow(paintAt(BEFORE));
					const full = paintRoomWindow(paintAt(AFTER));
					if (earlier.join("\n") !== full.join("\n")) moved++;
					const repainted = repaintRoomWindowClock(paintAt(AFTER), earlier);
					if (repainted.join("\n") !== full.join("\n")) {
						mismatches.push(`${size.name} / ${stateName} / ${variant.name}`);
					}
				}
			}
		}
		expect(mismatches).toEqual([]);
		// The sweep is not vacuous: between the two instants the clock moved rows
		// on every working window on the five framed sizes with a state glyph,
		// plain, selected and receding. A waiting window's glyph is its question,
		// not the clock, and does not move.
		expect(moved).toBe(ROOM_ACTIVITIES.length * 5 * 3);
	});
});
