/**
 * A list sized to a viewport must fit in it, chrome included.
 *
 * WHY THIS SUITE EXISTS. `render` emits the item window AND, whenever the list
 * overflows or is being filtered, one status row ("Type to search" / "Search:
 * …"). `maxVisible` counts only the items, so every host that needed the whole
 * render to fit a fixed number of terminal rows had to subtract that row by
 * hand. In the setup wizard three separate scenes each got the correction
 * differently — one forgot it entirely — and the host then clipped a row off the
 * bottom of the list, which is how "Browse all…" and the last providers became
 * unreachable during onboarding. `setRowBudget` derives the correction once, so
 * a caller can name the rows it owns and get a render that fits.
 *
 * WHAT IS PINNED. The rendered row count never exceeds the budget, at budgets
 * that do and do not force the status row, with a filter live, and with
 * `overflowSearch` disabled (no status row, so the whole budget is items).
 * `setMaxVisible` keeps its item-only meaning, because callers that size a popup
 * around the list still depend on it.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { SelectList, type SelectListTheme } from "@veyyon/tui/components/select-list";
import { KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "@veyyon/tui/keybindings";
import type { BoxSymbols } from "@veyyon/tui/symbols";

const box: BoxSymbols = {
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
};

const theme: SelectListTheme = {
	selectedPrefix: (text: string) => text,
	selectedText: (text: string) => text,
	description: (text: string) => text,
	scrollInfo: (text: string) => text,
	noMatch: (text: string) => text,
	symbols: {
		cursor: "→",
		inputCursor: "|",
		boxRound: { topLeft: "╭", topRight: "╮", bottomLeft: "╰", bottomRight: "╯", horizontal: "─", vertical: "│" },
		boxSharp: box,
		table: box,
		quoteBorder: "│",
		hrChar: "─",
		spinnerFrames: ["|", "/", "-", "\\"],
	},
};

function items(count: number): Array<{ value: string; label: string }> {
	return Array.from({ length: count }, (_, index) => ({ value: `item-${index}`, label: `item-${index}` }));
}

describe("SelectList.setRowBudget", () => {
	beforeEach(() => {
		setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
	});
	afterEach(() => {
		setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
	});

	/**
	 * The defect in one assertion. Twenty items into eight rows overflows, so the
	 * status row is rendered, so only seven items may be shown. Sizing with
	 * `setMaxVisible(8)` yields nine rows and the host clips one; `setRowBudget(8)`
	 * yields eight.
	 */
	it("fits the whole render in the budget when the status row is forced", () => {
		const list = new SelectList(items(20), 20, theme);
		list.setMaxVisible(8);
		expect(list.render(60).length).toBe(9);

		list.setRowBudget(8);
		const rows = list.render(60);
		expect(rows.length).toBe(8);
		expect(rows.filter(row => row.includes("Type to search")).length).toBe(1);
	});

	/** Every budget from small to large must hold, not just the one that was
	 *  debugged: an off-by-one that only appears at one size is the same bug. */
	it("never exceeds the budget at any budget", () => {
		for (const budget of [1, 2, 3, 5, 8, 13, 19, 20, 25]) {
			const list = new SelectList(items(20), 20, theme);
			list.setRowBudget(budget);
			expect(list.render(60).length).toBeLessThanOrEqual(budget);
		}
	});

	/**
	 * When the items all fit there is no status row to pay for, so the full budget
	 * is items. Reserving a row unconditionally would waste one on every list that
	 * fits, which across a wizard step is a row of real content.
	 */
	it("spends the whole budget on items when nothing overflows", () => {
		const list = new SelectList(items(4), 4, theme);
		list.setRowBudget(6);
		const rows = list.render(60);
		expect(rows.length).toBe(4);
		expect(rows.some(row => row.includes("Type to search"))).toBe(false);
	});

	/**
	 * A live filter renders the status row even when the surviving matches would
	 * fit without it, so the budget has to account for it then too. This is the
	 * case a naive `items.length > budget` check gets wrong.
	 */
	it("stays inside the budget while a filter is live", () => {
		const list = new SelectList(items(20), 20, theme);
		list.setRowBudget(6);
		list.setFilter("item-1");
		expect(list.render(60).length).toBeLessThanOrEqual(6);
		const rows = list.render(60);
		expect(rows.filter(row => row.includes("Search: item-1")).length).toBe(1);
	});

	/** With search disabled there is no status row at any size, so the budget is
	 *  entirely items — the correction must not be applied blindly. */
	it("spends the whole budget on items when overflow search is disabled", () => {
		const list = new SelectList(items(20), 20, theme, { overflowSearch: false });
		list.setRowBudget(8);
		const rows = list.render(60);
		expect(rows.length).toBe(8);
		expect(rows.some(row => row.includes("Type to search"))).toBe(false);
	});

	/** A budget below one row cannot render a list; it must clamp rather than
	 *  produce an empty or negative window. */
	it("clamps a nonsensical budget to one item row", () => {
		const list = new SelectList(items(20), 20, theme);
		list.setRowBudget(0);
		expect(list.render(60).length).toBeGreaterThanOrEqual(1);
		list.setRowBudget(-5);
		expect(list.render(60).length).toBeGreaterThanOrEqual(1);
	});
});

describe("SelectList status legend", () => {
	/**
	 * The wizard footer names every key for the whole step, and its Esc leaves
	 * onboarding rather than closing the list, so the built-in "esc close" legend
	 * contradicted the footer on the same screen. Suppressing the legend must not
	 * take the search text with it: that text is the only thing telling you a
	 * filter is live.
	 */
	it("can be suppressed without losing the search text", () => {
		const list = new SelectList(items(20), 20, theme, { statusLegend: false });
		list.setRowBudget(8);
		const status = list.render(60).find(row => row.includes("Type to search"));
		expect(status).toBeDefined();
		expect(status).not.toContain("esc close");
		expect(status).not.toContain("↑↓ move");

		list.setFilter("item-1");
		const filtered = list.render(60).find(row => row.includes("Search: item-1"));
		expect(filtered).toBeDefined();
		expect(filtered).not.toContain("esc clear");
	});

	/** The legend is on by default: every other picker in the app relies on it as
	 *  its only visible affordance. */
	it("stays on by default", () => {
		const list = new SelectList(items(20), 20, theme);
		list.setRowBudget(8);
		const status = list.render(60).find(row => row.includes("Type to search"));
		expect(status).toContain("esc close");
		expect(status).toContain("↑↓ move");
	});
});
