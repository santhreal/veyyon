// WHY THIS SUITE EXISTS (THE-CATEGORY-SIDEBAR-IS-A-LIST-TOO).
//
// The pointer band became a per-row value on the shared clock for `SelectList`, `SettingsList` and
// the four hand-painted pickers. The tab bar was left behind, and it is the surface a settings
// pointer touches FIRST: the category sidebar down the left of the settings card is
// `TabBar.renderVertical`, so the one card showed a fading band in its pane and a switching band in
// its sidebar, two columns apart, in the same frame.
//
// The four ways this goes wrong are the ones the list suite names, plus one this component owns:
//
//   1. A band that never arrives or never leaves.
//   2. A gesture with a hole in it: moving between two tabs must paint BOTH for a few frames.
//   3. A terminal with no motion getting motion anyway — with the fade off the bytes must be
//      exactly the switched band that shipped before.
//   4. Two render paths that disagree. A tab bar draws horizontally and vertically from the same
//      state, so a strength wired into one path and not the other is a band that appears in the
//      settings card and not in a horizontal bar of the same component.
//   5. A band keyed by POSITION. `setTabs` reorders and replaces the tab set on every settings
//      search keystroke; a fade keyed by index lights whichever tab lands on the old slot.
//   6. A band on a tab that is not a pointer target. A muted tab is skipped by navigation, so a
//      band on it offers a destination that does not exist.
//
// The invariant: hover strength is a per-TAB value on the shared clock, both render paths read the
// same value, every fade terminates, and a bar with no motion wired paints exactly what it painted
// before this existed.
//
// The cases drive the real `TabBar` against a hand-ticked `MotionClock`. The theme records the
// strength it was handed, which is the contract: the component decides WHEN, the theme decides what
// a strength looks like.
//
// WHAT IT DOES NOT CATCH: what a half-strength tab LOOKS like — that is the theme's blend, owned by
// the coding-agent band-bytes suite — and whether a host actually lends the tab bar its repaint,
// which is asserted against the real settings card in
// `a-settings-category-fades-under-the-pointer.test.ts`.

import { describe, expect, it } from "bun:test";
import { type Tab, TabBar, type TabBarTheme } from "@veyyon/tui/components/tab-bar";
import { MOTION, MotionClock } from "@veyyon/tui/motion";
import { HoverFade } from "@veyyon/tui/motion-hover";

const FRAME = 1000 / 60;

const TABS: Tab[] = [
	{ id: "appearance", label: "Appearance" },
	{ id: "model", label: "Model" },
	{ id: "tools", label: "Tools" },
	{ id: "plugins", label: "Plugins" },
];

/** The band renders its own strength, so a frame says which tabs are lit and how much. */
function bandTheme(): TabBarTheme {
	return {
		label: t => t,
		activeTab: t => `*${t}`,
		inactiveTab: t => t,
		hint: t => t,
		hoverTab: (text, strength) => `[${strength.toFixed(3)}]${text}`,
	};
}

function bar(theme: TabBarTheme = bandTheme()): TabBar {
	const tabs = new TabBar("Settings", [...TABS], theme);
	tabs.showHint = false;
	return tabs;
}

/** Every band strength painted in this frame, by the tab label it sits on. */
function bands(rows: readonly string[]): Map<string, number> {
	const found = new Map<string, number>();
	for (const row of rows) {
		for (const match of row.matchAll(/\[(\d\.\d{3})\]([^[]*)/g)) {
			const label = TABS.find(tab => match[2]?.includes(tab.label))?.label;
			if (label !== undefined) found.set(label, Number(match[1]));
		}
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

describe("a category tab fades in under the pointer", () => {
	it("arrives over the hover duration rather than on the report's own frame", () => {
		const clock = new MotionClock();
		let renders = 0;
		const tabs = bar();
		tabs.setHoverMotion({ requestRender: () => renders++, clock });

		tabs.setHoverTab("tools");
		// The report paints nothing: the fade starts at 0, and strength 0 is the ABSENCE of a
		// band rather than a band mixed all the way out.
		expect(bands(tabs.renderVertical(20)).get("Tools")).toBeUndefined();

		const mid = advance(clock, MOTION.hover.duration / 2);
		const half = bands(tabs.renderVertical(20)).get("Tools");
		expect(half).toBeGreaterThan(0);
		expect(half).toBeLessThan(1);

		advance(clock, MOTION.hover.duration, mid);
		expect(bands(tabs.renderVertical(20)).get("Tools")).toBe(1);
		expect(clock.liveCount).toBe(0);
		expect(renders).toBeGreaterThan(3);
	});

	it("paints the tab being left and the tab being entered in the same frame", () => {
		const clock = new MotionClock();
		const tabs = bar();
		tabs.setHoverMotion({ requestRender: () => {}, clock });

		tabs.setHoverTab("model");
		let now = advance(clock, MOTION.hover.duration);
		expect(bands(tabs.renderVertical(20)).get("Model")).toBe(1);

		tabs.setHoverTab("tools");
		now = advance(clock, MOTION.hover.duration / 3, now);
		const crossing = bands(tabs.renderVertical(20));
		expect(crossing.get("Model")).toBeGreaterThan(0);
		expect(crossing.get("Model")).toBeLessThan(1);
		expect(crossing.get("Tools")).toBeGreaterThan(0);
		expect(crossing.get("Tools")).toBeLessThan(1);

		advance(clock, MOTION.hover.duration, now);
		const settled = bands(tabs.renderVertical(20));
		expect(settled.get("Tools")).toBe(1);
		expect(settled.get("Model")).toBeUndefined();
	});

	it("hands the horizontal bar the same strength as the sidebar, in the same frame", () => {
		const clock = new MotionClock();
		const tabs = bar();
		tabs.setHoverMotion({ requestRender: () => {}, clock });

		tabs.setHoverTab("plugins");
		advance(clock, MOTION.hover.duration / 2);

		const sidebar = bands(tabs.renderVertical(20)).get("Plugins");
		const horizontal = bands(tabs.render(200)).get("Plugins");
		expect(sidebar).toBeGreaterThan(0);
		expect(sidebar).toBeLessThan(1);
		// One state, two paints. A strength wired into one path only is a band that exists in the
		// settings card and nowhere else.
		expect(horizontal).toBe(sidebar);
	});

	it("keeps the band on the tab rather than on the row it was drawn at", () => {
		const clock = new MotionClock();
		const tabs = bar();
		tabs.setHoverMotion({ requestRender: () => {}, clock });

		tabs.setHoverTab("tools");
		const now = advance(clock, MOTION.hover.duration);
		expect(bands(tabs.renderVertical(20)).get("Tools")).toBe(1);

		// Settings search rebuilds the tab set on every keystroke, which moves tabs between rows.
		// The band belongs to the CATEGORY, so it survives that and does not restart.
		tabs.setTabs([
			{ id: "tools", label: "Tools" },
			{ id: "appearance", label: "Appearance" },
			{ id: "model", label: "Model" },
			{ id: "plugins", label: "Plugins" },
		]);
		advance(clock, FRAME, now);
		const rows = tabs.renderVertical(20);
		expect(bands(rows).get("Tools")).toBe(1);
		expect(rows[0]).toContain("Tools");
		expect(clock.liveCount).toBe(0);
	});

	it("never bands the active tab, or a muted one", () => {
		const clock = new MotionClock();
		const tabs = bar();
		tabs.setHoverMotion({ requestRender: () => {}, clock });
		tabs.setTabs([...TABS.slice(0, 3), { id: "plugins", label: "Plugins", muted: true }]);

		// The pointer resting on the active tab: its own accent is the stronger signal.
		tabs.setHoverTab("appearance");
		advance(clock, MOTION.hover.duration);
		expect(bands(tabs.renderVertical(20)).size).toBe(0);

		// And a muted tab is not a target at all, so it never lights.
		tabs.setHoverTab("plugins");
		advance(clock, MOTION.hover.duration * 2, MOTION.hover.duration);
		expect(bands(tabs.renderVertical(20)).get("Plugins")).toBeUndefined();
	});

	it("paints the switched band and registers nothing when motion is off", () => {
		const clock = new MotionClock();
		const switched = bar();
		switched.setHoverMotion({ requestRender: () => {}, clock, enabled: false });
		switched.setHoverTab("tools");

		// Full strength on the report's own frame, with no tick in between.
		expect(bands(switched.renderVertical(20)).get("Tools")).toBe(1);
		expect(clock.liveCount).toBe(0);

		// And byte-identical to a bar that was never given motion at all, which is what every host
		// painted before this existed.
		const unwired = bar();
		unwired.setHoverTab("tools");
		expect(switched.renderVertical(20)).toEqual(unwired.renderVertical(20));
		expect(switched.render(200)).toEqual(unwired.render(200));

		switched.setHoverTab("plugins");
		const moved = bands(switched.renderVertical(20));
		expect(moved.get("Plugins")).toBe(1);
		expect(moved.get("Tools")).toBeUndefined();
	});

	it("ends every fade and keeps no state for a tab the pointer has left", () => {
		const clock = new MotionClock();
		const tabs = bar();
		const fade = new HoverFade<string>({ requestRender: () => {}, clock });
		tabs.setHoverMotion({ requestRender: () => {}, clock });

		let now = 0;
		for (let pass = 0; pass < 2; pass++) {
			for (const tab of TABS) {
				tabs.setHoverTab(tab.id);
				fade.set(tab.id);
				now = advance(clock, MOTION.hover.duration / 3, now);
			}
		}
		expect(fade.liveCount).toBeLessThanOrEqual(TABS.length);

		tabs.setHoverTab(null);
		fade.set(null);
		advance(clock, MOTION.hover.duration * 2, now);
		expect(clock.liveCount).toBe(0);
		expect(fade.liveCount).toBe(0);
		expect(bands(tabs.renderVertical(20)).size).toBe(0);
	});

	it("drops every fade on dispose so a card nobody can see stops asking for frames", () => {
		const clock = new MotionClock();
		let renders = 0;
		const tabs = bar();
		tabs.setHoverMotion({ requestRender: () => renders++, clock });
		tabs.setHoverTab("tools");
		advance(clock, MOTION.hover.duration / 3);
		expect(clock.liveCount).toBe(1);

		tabs.disposeHoverMotion();
		const after = renders;
		advance(clock, MOTION.hover.duration * 2, MOTION.hover.duration);
		expect(clock.liveCount).toBe(0);
		expect(renders).toBe(after);
		// The band is gone with the fade, not frozen mid-strength.
		expect(bands(tabs.renderVertical(20)).size).toBe(0);
	});

	it("falls back to the inactive style when the theme has no hover style at all", () => {
		// A theme predating the pointer band must not start rendering `undefined` through a
		// strength-aware call site.
		const clock = new MotionClock();
		const plain: TabBarTheme = { label: t => t, activeTab: t => `*${t}`, inactiveTab: t => t, hint: t => t };
		const tabs = bar(plain);
		tabs.setHoverMotion({ requestRender: () => {}, clock });
		tabs.setHoverTab("tools");
		advance(clock, MOTION.hover.duration);

		const rows = tabs.renderVertical(20);
		expect(rows.some(row => row.includes("undefined"))).toBe(false);
		expect(rows[2]).toBe(bar(plain).renderVertical(20)[2]);
	});

	it("never bands a muted tab, which is not a pointer target", () => {
		// A muted tab is skipped by navigation and only becomes "active" transiently through a
		// `setTabs` swap. Lighting one under the pointer offers a destination that does not exist.
		const clock = new MotionClock();
		const tabs = bar();
		tabs.setTabs([...TABS.slice(0, 3), { id: "plugins", label: "Plugins", muted: true }]);
		tabs.setHoverMotion({ requestRender: () => {}, clock });

		const quiet = tabs.renderVertical(20);
		tabs.setHoverTab("plugins");
		const now = advance(clock, MOTION.hover.duration * 2);
		expect(bands(tabs.renderVertical(20)).size).toBe(0);
		expect(tabs.renderVertical(20)).toEqual(quiet);
		// Horizontally too: one paint owner, so a muted tab that bands in one path bands in both.
		expect(bands(tabs.render(200)).size).toBe(0);

		// And the tab beside it still bands, so this is a muted-tab rule rather than a dead fade.
		tabs.setHoverTab("tools");
		advance(clock, MOTION.hover.duration * 2, now);
		expect(bands(tabs.renderVertical(20)).get("Tools")).toBe(1);
	});
});
