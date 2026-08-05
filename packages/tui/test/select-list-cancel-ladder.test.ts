/**
 * Cancel-key ladder contract for SelectList (TOUCH-3).
 *
 * Why this suite exists: esc behavior diverged across pickers. The model
 * browser cleared a live search query on the first cancel and closed on the
 * second (its documented "cancel-key ladder"), while SelectList closed the
 * whole overlay outright even mid-search — the same key doing different
 * things in two pickers, and a mistyped search cost the user the entire
 * overlay. SelectList now implements the same ladder, and its status-line
 * legend must say "esc clear" (not "close") while a query is live so the
 * chrome never advertises an action the key will not perform.
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

const ESC = "\x1b";

/** More items than maxVisible so the incremental search is editable. */
function overflowingList(): { list: SelectList; cancels: () => number } {
	const items = Array.from({ length: 8 }, (_, i) => ({ value: `item-${i}`, label: `item-${i}` }));
	const list = new SelectList(items, 3, theme);
	let cancelCount = 0;
	list.onCancel = () => {
		cancelCount++;
	};
	return { list, cancels: () => cancelCount };
}

describe("SelectList cancel-key ladder", () => {
	beforeEach(() => {
		setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
	});
	afterEach(() => {
		setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
	});

	it("first esc clears a live query instead of closing; the full list returns", () => {
		const { list, cancels } = overflowingList();
		list.handleInput("i");
		list.handleInput("7");
		expect(list.render(60).join("\n")).toContain("item-7");
		expect(list.render(60).join("\n")).not.toContain("item-0");

		list.handleInput(ESC);

		// The overlay stays open (no cancel bubbled) and the filter is gone.
		expect(cancels()).toBe(0);
		const rendered = list.render(60).join("\n");
		expect(rendered).toContain("item-0");
		expect(rendered).toContain("Type to search");
	});

	it("second esc (query already empty) bubbles onCancel and closes", () => {
		const { list, cancels } = overflowingList();
		list.handleInput("i");
		list.handleInput(ESC);
		expect(cancels()).toBe(0);

		list.handleInput(ESC);
		expect(cancels()).toBe(1);
	});

	it("esc with no query closes immediately (the ladder has no empty first rung)", () => {
		const { list, cancels } = overflowingList();
		list.handleInput(ESC);
		expect(cancels()).toBe(1);
	});

	it("esc closes rather than strands when a filter was set programmatically on a non-searchable list", () => {
		// A list too small to overflow has no editable search, but a host can
		// still call setFilter(). Esc must not loop forever "clearing" a query
		// the user cannot even see an input for — it closes.
		const items = [{ value: "only", label: "only" }];
		const list = new SelectList(items, 5, theme);
		let cancelCount = 0;
		list.onCancel = () => {
			cancelCount++;
		};
		list.setFilter("onl");

		list.handleInput(ESC);
		expect(cancelCount).toBe(1);
	});

	it("status legend says 'esc clear' while a query is live and 'esc close' when it is not", () => {
		const { list } = overflowingList();
		expect(list.render(80).join("\n")).toContain("esc close");
		expect(list.render(80).join("\n")).not.toContain("esc clear");

		list.handleInput("i");
		expect(list.render(80).join("\n")).toContain("esc clear");
		expect(list.render(80).join("\n")).not.toContain("esc close");

		list.handleInput(ESC);
		expect(list.render(80).join("\n")).toContain("esc close");
	});

	/**
	 * `hasActiveFilter()` exists for one caller shape: a host that owns Escape
	 * asking whether the list wants it first. It therefore has to report the
	 * LADDER'S first rung, not "a query string is set". A host that trusted the
	 * looser reading would claim Escape for a query the list refuses to clear,
	 * and the key would then do nothing at all.
	 *
	 * IF IT REGRESSES: the setup wizard claims Escape on a step where Escape
	 * cannot clear anything, so the user's only advertised way out stops
	 * responding.
	 */
	it("reports exactly whether esc will clear the filter, not merely that one is set", () => {
		const { list, cancels } = overflowingList();
		expect(list.hasActiveFilter()).toBe(false);

		list.handleInput("i");
		expect(list.hasActiveFilter()).toBe(true);

		list.handleInput(ESC);
		expect(list.hasActiveFilter()).toBe(false);
		expect(cancels()).toBe(0);

		// A host-pushed query on a list with no editable search is the case the
		// ladder deliberately closes on, so this must NOT claim it.
		const small = new SelectList([{ value: "only", label: "only" }], 5, theme);
		small.setFilter("onl");
		expect(small.hasActiveFilter()).toBe(false);
	});

	/**
	 * A row budget is not fixed: the setup wizard re-sizes every list on every
	 * terminal resize. Growing the terminal past the item count used to switch
	 * the search off underneath a query the user had already typed, and both Esc
	 * and Backspace then refused it, leaving a filtered list with no route back
	 * to the full one.
	 *
	 * IF IT REGRESSES: resizing the terminal mid-search strands the user on a
	 * list showing one row, with the rest of the choices unreachable.
	 */
	it("keeps a typed query clearable after the list stops overflowing", () => {
		const { list, cancels } = overflowingList();
		list.handleInput("i");
		list.handleInput("7");
		expect(list.render(60).join("\n")).toContain("item-7");

		// The window now holds all eight items, so the search is no longer
		// editable by the `items.length > maxVisible` rule.
		list.setMaxVisible(20);
		expect(list.hasActiveFilter()).toBe(true);

		list.handleInput(ESC);
		expect(cancels()).toBe(0);
		expect(list.render(60).join("\n")).toContain("item-0");
		expect(list.hasActiveFilter()).toBe(false);
	});
});
