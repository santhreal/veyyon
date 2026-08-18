// WHY THIS SUITE EXISTS (THE-POINTER-BAND-IS-A-VALUE-NOT-A-FLAG).
//
// The hover band used to be a boolean: the row under the pointer was painted on the frame a motion
// report arrived and unpainted on the frame it left. Dragging down a list strobed, and every fix
// for that opens the same four ways of being wrong:
//
//   1. A band that never arrives, or never leaves. A fade is a value with a target; a target that
//      is never reached is a row banded forever, or a row that never lights at all.
//   2. A gesture with a hole in it. Moving from row A to row B has to paint BOTH for a few frames.
//      Fading A out and only then fading B in doubles the latency of the one interaction that has
//      to feel instant, and shows a frame with no band at all in the middle of a hover.
//   3. Unbounded state. A pointer swept down two hundred rows must not leave two hundred live
//      animations, or a map that keeps every row it ever touched.
//   4. A terminal that shows no motion getting motion anyway. With the fade off, the band must be
//      byte-identical to the switched band it replaced, and register nothing with the clock.
//
// The invariant: hover strength is a per-row value on the shared clock, every fade terminates, and
// a list with no motion wired paints exactly what it painted before this existed.
//
// The cases drive the real `SelectList` and the real `SettingsList` against a hand-ticked
// `MotionClock` — no wall clock, no sleeps. The band theme records the strength it was called with,
// which is the contract between a list and a theme: the list decides WHEN, the theme decides what
// a strength looks like.
//
// WHAT IT DOES NOT CATCH: what a half-strength band LOOKS like (that is the theme's blend, asserted
// in the coding-agent suite that owns the band bytes), and hover on the lists that still track a
// hovered row themselves (session, tree, message, extension) — those have not been moved onto this
// primitive yet.

import { describe, expect, it } from "bun:test";
import { type SelectItem, SelectList, type SelectListTheme } from "@veyyon/tui/components/select-list";
import { SettingsList, type SettingsListTheme } from "@veyyon/tui/components/settings-list";
import { MOTION, MotionClock } from "@veyyon/tui/motion";
import { HoverFade } from "@veyyon/tui/motion-hover";

const FRAME = 1000 / 60;

const SYMBOLS = {
	cursor: "→",
	inputCursor: "|",
	hrChar: "─",
	quoteBorder: "│",
	boxRound: { topLeft: "╭", topRight: "╮", bottomLeft: "╰", bottomRight: "╯", horizontal: "─", vertical: "│" },
	boxSharp: {
		topLeft: "┌",
		topRight: "┐",
		bottomLeft: "└",
		bottomRight: "┘",
		horizontal: "─",
		vertical: "│",
		teeDown: "┬",
		teeUp: "┴",
		teeLeft: "┤",
		teeRight: "├",
		cross: "┼",
	},
	table: {
		topLeft: "┌",
		topRight: "┐",
		bottomLeft: "└",
		bottomRight: "┘",
		horizontal: "─",
		vertical: "│",
		teeDown: "┬",
		teeUp: "┴",
		teeLeft: "┤",
		teeRight: "├",
		cross: "┼",
	},
	spinnerFrames: ["|"],
};

/** The band renders its own strength, so a frame says which rows are lit and how much. */
function bandTheme(): SelectListTheme {
	return {
		selectedPrefix: t => t,
		selectedText: t => t,
		description: t => t,
		scrollInfo: t => t,
		noMatch: t => t,
		symbols: SYMBOLS,
		hovered: (text, strength) => `[${strength.toFixed(3)}]${text}`,
	};
}

function settingsBandTheme(): SettingsListTheme {
	return {
		label: t => t,
		value: t => t,
		description: t => t,
		cursor: "→ ",
		hint: t => t,
		hovered: (text, strength) => `[${strength.toFixed(3)}]${text}`,
	};
}

const ITEMS: SelectItem[] = [
	{ value: "a", label: "alpha" },
	{ value: "b", label: "bravo" },
	{ value: "c", label: "charlie" },
	{ value: "d", label: "delta" },
];

/** Every band strength painted in this frame, by the label it sits on. */
function bands(rows: readonly string[]): Map<string, number> {
	const found = new Map<string, number>();
	for (const row of rows) {
		const match = /^\[(\d\.\d{3})\](.*)$/.exec(row);
		if (match === null) continue;
		const label = ITEMS.find(item => match[2]?.includes(item.label))?.label ?? match[2] ?? "";
		found.set(label, Number(match[1]));
	}
	return found;
}

function advance(clock: MotionClock, ms: number, from = 0): number {
	let now = from;
	for (let elapsed = 0; elapsed < ms; elapsed += FRAME) {
		now += FRAME;
		clock.tick(now);
	}
	return now;
}

describe("a hover band fades in instead of switching", () => {
	it("arrives over the hover duration rather than on the report's own frame", () => {
		const clock = new MotionClock();
		let renders = 0;
		const list = new SelectList(ITEMS, 10, bandTheme());
		list.setHoverMotion({ requestRender: () => renders++, clock });

		list.setHoverIndex(2);
		// The report itself paints nothing: the fade starts at 0 and the row is not banded at all,
		// which is what makes this a fade and not a switch with extra steps.
		expect(bands(list.render(40)).get("charlie")).toBeUndefined();

		const mid = advance(clock, MOTION.hover.duration / 2);
		const half = bands(list.render(40)).get("charlie");
		expect(half).toBeGreaterThan(0);
		expect(half).toBeLessThan(1);

		advance(clock, MOTION.hover.duration, mid);
		expect(bands(list.render(40)).get("charlie")).toBe(1);
		// The clock let go: a settled fade is not a registered animation.
		expect(clock.liveCount).toBe(0);
		// Every frame of the fade asked for a repaint, or the operator sees one frame of it.
		expect(renders).toBeGreaterThan(3);
	});

	it("paints the row being left and the row being entered in the same frame", () => {
		const clock = new MotionClock();
		const list = new SelectList(ITEMS, 10, bandTheme());
		list.setHoverMotion({ requestRender: () => {}, clock });

		list.setHoverIndex(1);
		let now = advance(clock, MOTION.hover.duration);
		expect(bands(list.render(40)).get("bravo")).toBe(1);

		list.setHoverIndex(2);
		now = advance(clock, MOTION.hover.duration / 3, now);
		const crossing = bands(list.render(40));
		// Both lit at once. This is the frame a fade-out-then-fade-in cannot produce.
		expect(crossing.get("bravo")).toBeGreaterThan(0);
		expect(crossing.get("bravo")).toBeLessThan(1);
		expect(crossing.get("charlie")).toBeGreaterThan(0);
		expect(crossing.get("charlie")).toBeLessThan(1);

		advance(clock, MOTION.hover.duration, now);
		const settled = bands(list.render(40));
		expect(settled.get("charlie")).toBe(1);
		expect(settled.get("bravo")).toBeUndefined();
	});

	it("resumes a re-entered row from where it got to, not from nothing", () => {
		const clock = new MotionClock();
		const list = new SelectList(ITEMS, 10, bandTheme());
		list.setHoverMotion({ requestRender: () => {}, clock });

		list.setHoverIndex(1);
		let now = advance(clock, MOTION.hover.duration);
		list.setHoverIndex(2);
		now = advance(clock, MOTION.hover.duration / 3, now);
		const leaving = bands(list.render(40)).get("bravo");
		expect(leaving).toBeGreaterThan(0);

		// The pointer comes back before the row finished leaving.
		list.setHoverIndex(1);
		const resumed = bands(list.render(40)).get("bravo");
		expect(resumed).toBe(leaving);
		now = advance(clock, FRAME * 2, now);
		expect(bands(list.render(40)).get("bravo")).toBeGreaterThan(leaving!);
	});

	it("ends every fade and keeps no state for a row the pointer has left", () => {
		const clock = new MotionClock();
		const list = new SelectList(ITEMS, 10, bandTheme());
		const fade = new HoverFade({ requestRender: () => {}, clock });
		list.setHoverMotion({ requestRender: () => {}, clock });

		// Sweep the pointer over every row twice, a third of a fade apart, then off the list.
		let now = 0;
		for (let pass = 0; pass < 2; pass++) {
			for (let row = 0; row < ITEMS.length; row++) {
				list.setHoverIndex(row);
				fade.set(row);
				now = advance(clock, MOTION.hover.duration / 3, now);
			}
		}
		// Bounded while the gesture runs: a sweep leaves fades for the rows it touched recently,
		// never one per row it ever crossed.
		expect(fade.liveCount).toBeLessThanOrEqual(ITEMS.length);

		list.setHoverIndex(null);
		fade.set(null);
		advance(clock, MOTION.hover.duration * 2, now);
		// Terminated: nothing registered, nothing remembered, nothing painted.
		expect(clock.liveCount).toBe(0);
		expect(fade.liveCount).toBe(0);
		expect(fade.key).toBeNull();
		expect(bands(list.render(40)).size).toBe(0);
	});

	it("paints the switched band and registers nothing when motion is off", () => {
		const clock = new MotionClock();
		const switched = new SelectList(ITEMS, 10, bandTheme());
		switched.setHoverMotion({ requestRender: () => {}, clock, enabled: false });
		switched.setHoverIndex(2);

		// Full strength on the report's own frame, with no tick in between.
		expect(bands(switched.render(40)).get("charlie")).toBe(1);
		expect(clock.liveCount).toBe(0);

		// And byte-identical to a list that was never given motion at all, which is the pre-fade
		// behavior every existing host has.
		const unwired = new SelectList(ITEMS, 10, bandTheme());
		unwired.setHoverIndex(2);
		expect(switched.render(40)).toEqual(unwired.render(40));

		switched.setHoverIndex(3);
		const moved = bands(switched.render(40));
		expect(moved.get("delta")).toBe(1);
		expect(moved.get("charlie")).toBeUndefined();
	});

	it("drops every fade on dispose so a list nobody can see stops asking for frames", () => {
		const clock = new MotionClock();
		let renders = 0;
		const list = new SelectList(ITEMS, 10, bandTheme());
		list.setHoverMotion({ requestRender: () => renders++, clock });
		list.setHoverIndex(2);
		advance(clock, MOTION.hover.duration / 3);
		expect(clock.liveCount).toBe(1);

		list.disposeHoverMotion();
		const after = renders;
		advance(clock, MOTION.hover.duration * 2, MOTION.hover.duration);
		expect(clock.liveCount).toBe(0);
		expect(renders).toBe(after);
		// The band is gone with the fade, not frozen mid-strength.
		expect(bands(list.render(40)).size).toBe(0);
	});

	/**
	 * WHY: the band used to be suppressed on the selected row, and that is what made a list have a
	 * cell the pointer could not reach — the row the keyboard already sat on answered nothing, so it
	 * read as dead, and reaching the row above it meant pointing at something else first. The pointer
	 * and the keyboard are ONE highlight now: every row bands, the selected one included, and the
	 * pointer never moves the selection (a mouse crossing the card must not change what Enter picks).
	 *
	 * NOT CAUGHT: how the band and the selected row's own paint compose visually. This asserts the
	 * band's strength, not that the blend is legible in a given theme.
	 */
	it("bands the selected row too, and never moves the selection to do it", () => {
		const clock = new MotionClock();
		const list = new SelectList(ITEMS, 10, bandTheme());
		list.setHoverMotion({ requestRender: () => {}, clock });
		list.setSelectedIndex(3);

		list.setHoverIndex(1);
		const now = advance(clock, MOTION.hover.duration);
		expect(bands(list.render(40)).get("bravo")).toBe(1);

		// The keyboard moves onto the hovered row: the band stays, because the row the pointer is on
		// is the row the pointer is on whatever the cursor is doing.
		list.setSelectedIndex(1);
		expect(bands(list.render(40)).get("bravo")).toBe(1);

		// And pointing at the row the cursor already occupies bands it, rather than nothing.
		list.setHoverIndex(null);
		advance(clock, MOTION.hover.duration, now);
		expect(bands(list.render(40)).get("bravo")).toBeUndefined();
		list.setHoverIndex(1);
		const settled = advance(clock, MOTION.hover.duration);
		expect(bands(list.render(40)).get("bravo")).toBe(1);
		expect(list.getSelectedItem()?.label).toBe("bravo");
		advance(clock, FRAME, settled);
	});

	it("keeps a settings row's band on the row rather than on the line it was drawn at", () => {
		const clock = new MotionClock();
		const list = new SettingsList(
			[
				{ id: "alpha", label: "Alpha", currentValue: "1" },
				{ id: "bravo", label: "Bravo", currentValue: "2" },
				{ id: "charlie", label: "Charlie", currentValue: "3" },
			],
			10,
			settingsBandTheme(),
			() => {},
			() => {},
		);
		list.setHoverMotion({ requestRender: () => {}, clock });
		expect(list.selectItem("alpha")).toBe(true);

		list.setHoverItem("charlie");
		const now = advance(clock, MOTION.hover.duration);
		const charlieRow = (): string | undefined => list.render(40).find(row => row.includes("Charlie"));
		expect(charlieRow()).toContain("[1.000]");

		// The settings screen rebuilds its item list on every change, which moves rows. The band
		// belongs to the SETTING, so it survives that intact and does not restart: a fade keyed by
		// the line a row was drawn at would light whatever row landed there instead.
		list.setItems([
			{ id: "charlie", label: "Charlie", currentValue: "3" },
			{ id: "alpha", label: "Alpha", currentValue: "1" },
			{ id: "bravo", label: "Bravo", currentValue: "2" },
		]);
		advance(clock, FRAME, now);
		expect(charlieRow()).toContain("[1.000]");
		expect(list.render(40).indexOf(charlieRow() ?? "")).toBe(0);
		expect(clock.liveCount).toBe(0);
	});

	it("fades a dimmed row too — the split layout's second paint path is not exempt", () => {
		// A settings row outside the active section renders through its own branch, under one dim
		// wash rather than as label + value. That branch takes the band separately, and a band that
		// switches there while every other row fades is the same defect, one path further in.
		const clock = new MotionClock();
		const list = new SettingsList(
			[
				{ id: "__h:one", label: "Section One", currentValue: "", heading: true },
				{ id: "alpha", label: "Alpha", currentValue: "1" },
				{ id: "__h:two", label: "Section Two", currentValue: "", heading: true },
				{ id: "bravo", label: "Bravo", currentValue: "2" },
			],
			10,
			settingsBandTheme(),
			() => {},
			() => {},
		);
		list.setHoverMotion({ requestRender: () => {}, clock });
		// The selection sits in section one, so Bravo is outside the active section and dimmed.
		const dimmedRow = (): string | undefined => list.render(80).find(row => row.includes("Bravo"));
		expect(dimmedRow()).toBeDefined();

		list.setHoverItem("bravo");
		const mid = advance(clock, MOTION.hover.duration / 2);
		const partial = /\[(\d\.\d{3})\]/.exec(dimmedRow() ?? "");
		expect(partial).not.toBeNull();
		expect(Number(partial?.[1])).toBeGreaterThan(0);
		expect(Number(partial?.[1])).toBeLessThan(1);

		advance(clock, MOTION.hover.duration, mid);
		expect(dimmedRow()).toContain("[1.000]");
	});
});
