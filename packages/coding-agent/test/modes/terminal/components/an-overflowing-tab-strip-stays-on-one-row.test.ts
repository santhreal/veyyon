// WHY THIS SUITE EXISTS.
//
// The extensions dashboard shows its provider tabs on one row and pages them with `◀` / `▶` when
// they overflow. It renders the TabBar and keeps only the first line, so a window that the
// fitting code reports as fitting but that TabBar wraps loses whatever landed on line two: the last
// tab, or the `▶` that says more tabs exist. The fitting code costed each paging tab as its own three
// cells and forgot the two-cell separator TabBar puts beside it, undercounting by up to four cells.
//
// The class this closes: any disagreement between what `visibleTabWindow` charges for a window and
// what TabBar draws for it. The sweep renders the window through the real TabBar at every width
// from the narrowest that holds the active tab and both arrows up past the full strip, for every
// active tab, over label sets of mixed lengths, and asserts one row no wider than the budget.
//
// The tabs carry no `short` form, so TabBar cannot collapse a label to hide an undercount.
//
// WHAT IT DOES NOT CATCH: a window narrower than it could be (it asserts fit, not that the window
// is maximal), and widths too narrow for the active tab plus both arrows, where no one-row window
// exists and TabBar truncates.

import { describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { visibleTabWindow } from "@veyyon/coding-agent/modes/terminal/components/extensions/extension-dashboard";
import { type Tab, TabBar, type TabBarTheme } from "@veyyon/tui";
import { visibleWidth } from "@veyyon/utils/width";

const plainTheme: TabBarTheme = {
	label: text => text,
	activeTab: text => text,
	inactiveTab: text => text,
	hint: text => text,
};

/** Deterministic label sets: uniform short, uniform long, and mixed with counts and wide glyphs. */
const LABEL_SETS: readonly (readonly string[])[] = [
	["ALL (32)", "Builtin Defaults (31)", "Claude Code", "Agents (standard)", "OpenAI Codex", "Gemini CLI", "OpenCode"],
	Array.from({ length: 12 }, (_, i) => `P${i}`),
	Array.from({ length: 9 }, (_, i) => `Provider number ${i} (${i * 7})`),
	["A", "a much longer provider label", "B", "⊘ Disabled source", "C (1)", "漢字 provider", "D"],
];

function tabsOf(labels: readonly string[]): Tab[] {
	return labels.map((label, i) => ({ id: `t${i}`, label }));
}

function cost(tab: Tab): number {
	return visibleWidth(tab.label) + 2;
}

describe("an overflowing tab strip stays on one row", () => {
	for (const labels of LABEL_SETS) {
		const tabs = tabsOf(labels);
		const fullWidth = tabs.reduce((sum, t) => sum + cost(t), 0) + 2 * (tabs.length - 1);

		it(`fits every window on one row: ${labels.length} tabs, full strip ${fullWidth} cells`, () => {
			const failures: string[] = [];
			for (let active = 0; active < tabs.length; active++) {
				// The narrowest budget with a one-row answer: the active tab with an arrow on each side.
				const floor = cost(tabs[active]!) + 2 * (3 + 2);
				for (let width = floor; width <= fullWidth + 4; width++) {
					const window = visibleTabWindow(tabs, active, width);
					const bar = new TabBar("", window, plainTheme);
					bar.showHint = false;
					bar.setActiveById(tabs[active]!.id);
					const lines = bar.render(width).map(line => stripVTControlCharacters(line).trimEnd());
					const where = `active ${active}, width ${width}`;
					if (lines.length !== 1) failures.push(`${where}: ${lines.length} rows ${JSON.stringify(lines)}`);
					else if (visibleWidth(lines[0]!) > width)
						failures.push(`${where}: row is ${visibleWidth(lines[0]!)} cells`);

					const ids = window.map(t => t.id);
					if (!ids.includes(tabs[active]!.id)) failures.push(`${where}: active tab missing`);
					const shown = window.filter(t => !t.id.startsWith("__"));
					const firstShown = tabs.findIndex(t => t.id === shown[0]?.id);
					const lastShown = tabs.findIndex(t => t.id === shown.at(-1)?.id);
					if (firstShown > 0 !== (ids[0] === "__prev_tab"))
						failures.push(`${where}: ◀ disagrees with hidden head`);
					if (lastShown < tabs.length - 1 !== (ids.at(-1) === "__next_tab")) {
						failures.push(`${where}: ▶ disagrees with hidden tail`);
					}
				}
			}
			expect(failures).toEqual([]);
		});
	}

	it("returns the whole strip without paging tabs when it fits", () => {
		const tabs = tabsOf(LABEL_SETS[0]!);
		const fullWidth = tabs.reduce((sum, t) => sum + cost(t), 0) + 2 * (tabs.length - 1);
		expect(visibleTabWindow(tabs, 3, fullWidth).map(t => t.id)).toEqual(tabs.map(t => t.id));
	});
});
