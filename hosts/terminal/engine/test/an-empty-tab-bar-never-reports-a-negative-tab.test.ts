import { describe, expect, it } from "bun:test";
import { TabBar, type TabBarTheme } from "@veyyon/tui/components/tab-bar";

/**
 * WHY: `setActiveIndex` sized the index with `clamp(index, 0, tabs.length - 1)`.
 * With no tabs the high bound is -1, and `clamp` tests `value > max` first, so
 * it returns that INVERTED bound rather than the low one. That is what `clamp`
 * is specified to do when max < min, which is why `@veyyon/utils/math` also
 * ships `clampLow` — and why `setTabs`, twelve lines below, already used it.
 *
 * The result is observable at the component's own callback boundary:
 * `#activeIndex` becomes -1 and `onTabChange` is handed `this.#tabs[-1]`, i.e.
 * `undefined`, through a parameter its type declares as a `Tab`. Any consumer
 * that reads a field off that tab throws on a tab bar that merely happens to be
 * empty.
 *
 * CLASS CLOSED: the callback may never observe a negative index or a missing
 * tab, and the clamped index is asserted to stay in range for the empty, the
 * populated, and the over-range cases.
 *
 * NOT CAUGHT: this does not police new call sites. An index setter added later
 * with a raw `clamp(..., length - 1)` goes undetected until exercised. The
 * sibling `SelectList.setSelectedIndex` carried the same shape but no reachable
 * consumer distinguishes -1 from 0 there, so it is corrected without a test
 * rather than pinned by one that cannot fail.
 */

const theme: TabBarTheme = {
	activeTab: (text: string) => text,
	inactiveTab: (text: string) => text,
	label: (text: string) => text,
	hint: (text: string) => text,
};

describe("an empty tab bar never reports a negative tab", () => {
	it("hands onTabChange neither a negative index nor a missing tab when it holds no tabs", () => {
		const seen: Array<{ tab: unknown; index: number }> = [];
		const bar = new TabBar("", [], theme, 0);
		bar.onTabChange = (tab, index) => seen.push({ tab, index });

		bar.setActiveIndex(0);
		bar.setActiveIndex(2);

		for (const entry of seen) {
			expect(entry.index).toBeGreaterThanOrEqual(0);
			expect(entry.tab).toBeDefined();
		}
	});

	it("keeps the active index at the low bound when it holds no tabs", () => {
		const bar = new TabBar("", [], theme, 0);
		bar.setActiveIndex(3);
		expect(bar.getActiveIndex()).toBe(0);
	});

	it("still clamps to the last tab when tabs exist", () => {
		const bar = new TabBar(
			"",
			[
				{ id: "a", label: "A" },
				{ id: "b", label: "B" },
			],
			theme,
			0,
		);
		bar.setActiveIndex(99);
		expect(bar.getActiveIndex()).toBe(1);
	});

	it("still selects the requested tab when it is in range", () => {
		const bar = new TabBar(
			"",
			[
				{ id: "a", label: "A" },
				{ id: "b", label: "B" },
			],
			theme,
			0,
		);
		bar.setActiveIndex(1);
		expect(bar.getActiveIndex()).toBe(1);
	});
});
