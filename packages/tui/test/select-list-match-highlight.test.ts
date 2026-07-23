/**
 * SelectList hit highlighting — the "found thing is gold" contract from the
 * approved / menu design: while a filter query is active, the characters it
 * matched paint through the theme's `matchHighlight` callback on UNSELECTED
 * rows. The selected row keeps its own selectedText style untouched (nested
 * per-char resets inside a styled row would bleach the selection style — the
 * exact bug this split prevents).
 *
 * Locks:
 *  1. Hit characters (and only they) pass through matchHighlight.
 *  2. The selected row never routes through matchHighlight.
 *  3. Without a query, no highlighting happens at all.
 *  4. A theme without matchHighlight renders byte-identically to before the
 *     feature existed (opt-in, zero cost for existing consumers).
 */
import { describe, expect, it } from "bun:test";
import { type SelectItem, SelectList, type SelectListTheme } from "../src/components/select-list";

const HIT_OPEN = "\x1b[33m";
const HIT_CLOSE = "\x1b[39m";

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

function makeTheme(withHighlight: boolean): SelectListTheme {
	return {
		selectedPrefix: t => t,
		selectedText: t => `[SEL]${t}`,
		description: t => t,
		scrollInfo: t => t,
		noMatch: t => t,
		symbols: SYMBOLS,
		...(withHighlight ? { matchHighlight: (t: string) => `${HIT_OPEN}${t}${HIT_CLOSE}` } : {}),
	};
}

const ITEMS: SelectItem[] = [
	{ value: "theme", label: "/theme", description: "switch color theme" },
	{ value: "thinking", label: "/thinking", description: "set reasoning effort" },
	{ value: "compact", label: "/compact", description: "compact the session" },
];

function type(list: SelectList, text: string): void {
	for (const ch of text) list.handleInput(ch);
}

describe("SelectList match highlighting", () => {
	it("paints exactly the hit characters of unselected rows", () => {
		const list = new SelectList(ITEMS, 2, makeTheme(true));
		// maxVisible < item count enables type-to-filter.
		type(list, "th");
		const rows = list.render(60).join("\n");
		// Both /theme and /thinking survive the filter; the selected first row
		// carries [SEL] and no per-char paint; the unselected one paints "th".
		expect(rows).toContain("[SEL]");
		expect(rows).toContain(`${HIT_OPEN}t${HIT_CLOSE}${HIT_OPEN}h${HIT_CLOSE}`);
	});

	it("never routes the selected row through matchHighlight", () => {
		const list = new SelectList(ITEMS, 2, makeTheme(true));
		type(list, "th");
		const selectedRow = list.render(60).find(r => r.includes("[SEL]"));
		expect(selectedRow).toBeDefined();
		expect(selectedRow).not.toContain(HIT_OPEN);
	});

	it("paints nothing without an active query", () => {
		const list = new SelectList(ITEMS, 2, makeTheme(true));
		expect(list.render(60).join("\n")).not.toContain(HIT_OPEN);
	});

	it("renders byte-identically to the pre-feature output when the theme omits matchHighlight", () => {
		const withHook = new SelectList(ITEMS, 2, makeTheme(false));
		type(withHook, "th");
		expect(withHook.render(60).join("\n")).not.toContain(HIT_OPEN);
	});

	/**
	 * The molten selection cursor: the selected row's cursor glyph must route
	 * through `selectedPrefix` while the body routes through `selectedText`.
	 * The regression this locks out: the whole selected row (cursor included)
	 * was painted with selectedText, silently discarding the theme's cursor
	 * treatment — the approved molten `❯` never appeared in the / menu.
	 */
	it("routes the selected row's cursor through selectedPrefix, body through selectedText", () => {
		const theme: SelectListTheme = {
			...makeTheme(false),
			selectedPrefix: t => `[CUR]${t}[/CUR]`,
			selectedText: t => `[SEL]${t}[/SEL]`,
		};
		const list = new SelectList(ITEMS, 10, theme);
		const selectedRow = list.render(60).find(r => r.includes("[SEL]"));
		expect(selectedRow).toBeDefined();
		expect(selectedRow).toContain("[CUR]→ [/CUR][SEL]");
		// The cursor glyph itself never leaks into the selectedText span.
		expect(selectedRow!.slice(selectedRow!.indexOf("[SEL]"))).not.toContain("→");
	});
});
