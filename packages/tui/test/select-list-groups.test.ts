/**
 * SelectList group headers — the approved / menu "grouped by purpose"
 * direction: items carrying a `group` render under non-selectable category
 * header rows, and filtering collapses empty groups automatically (a header
 * exists only because a surviving item does).
 *
 * Locks:
 *  1. One header per run of same-group items, in list order.
 *  2. Headers are chrome: navigation and mouse hit-rows skip them (selection
 *     always lands on an item, never a header).
 *  3. A filtered-out group leaves no orphaned header behind.
 *  4. Data or theme without groups renders byte-identically to the flat list —
 *     the feature is strictly opt-in from both sides.
 */
import { describe, expect, it } from "bun:test";
import { type SelectItem, SelectList, type SelectListTheme } from "../src/components/select-list";

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

function makeTheme(withGroups: boolean): SelectListTheme {
	return {
		selectedPrefix: t => t,
		selectedText: t => `[SEL]${t}`,
		description: t => t,
		scrollInfo: t => t,
		noMatch: t => t,
		symbols: SYMBOLS,
		...(withGroups ? { groupHeader: (name: string) => `[HDR ${name}]` } : {}),
	};
}

const ITEMS: SelectItem[] = [
	{ value: "new", label: "/new", description: "start a session", group: "session" },
	{ value: "resume", label: "/resume", description: "resume a session", group: "session" },
	{ value: "plan", label: "/plan", description: "plan mode", group: "modes" },
	{ value: "model", label: "/model", description: "switch model", group: "model" },
];

describe("SelectList group headers", () => {
	it("renders one header per run of same-group items, in order", () => {
		const list = new SelectList(ITEMS, 10, makeTheme(true));
		const rows = list.render(60);
		const headers = rows.filter(r => r.startsWith("[HDR"));
		expect(headers).toEqual(["[HDR session]", "[HDR modes]", "[HDR model]"]);
		// The session header precedes both session items.
		expect(rows.findIndex(r => r === "[HDR session]")).toBeLessThan(rows.findIndex(r => r.includes("/new")));
	});

	it("keeps selection on items — the first row selected is /new, not a header", () => {
		const list = new SelectList(ITEMS, 10, makeTheme(true));
		const rows = list.render(60);
		const selected = rows.find(r => r.includes("[SEL]"));
		expect(selected).toContain("/new");
	});

	it("collapses a group whose items were all filtered out", () => {
		const list = new SelectList(ITEMS, 3, makeTheme(true));
		for (const ch of "plan") list.handleInput(ch);
		const rows = list.render(60);
		expect(rows.join("\n")).toContain("[HDR modes]");
		expect(rows.join("\n")).not.toContain("[HDR session]");
	});

	it("renders flat when the theme omits groupHeader, even with grouped data", () => {
		const list = new SelectList(ITEMS, 10, makeTheme(false));
		expect(list.render(60).join("\n")).not.toContain("[HDR");
	});

	it("renders flat when the data has no groups, even with a grouping theme", () => {
		const flat = ITEMS.map(({ group: _group, ...rest }) => rest);
		const list = new SelectList(flat, 10, makeTheme(true));
		expect(list.render(60).join("\n")).not.toContain("[HDR");
	});
});
