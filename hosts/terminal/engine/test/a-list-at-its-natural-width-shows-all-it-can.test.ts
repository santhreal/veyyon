// WHY THIS SUITE EXISTS.
//
// `SelectList.naturalWidth()` is what a modal sizes its card from, so it has to be a width past
// which nothing more appears. It measured a described row as the name column plus the description,
// and missed the two floors the layout applies: a description column is laid out only on a row
// wider than 40 cells, and only when it gets more than 10 cells. A short list with short
// descriptions reported a width at which every description was dropped.
//
// It also sits beside the name column fitting: a column set wider than the default yields cells to
// the descriptions on a narrow row. At `naturalWidth()` nothing may yield, or a card sized from it
// cuts the very labels it widened to show.
//
// The class this closes: any width `naturalWidth()` reports that renders differently from a much
// wider one, and any description missing from its row at that width. Swept over column caps
// (default, narrow, wide, sized to the widest label), label lengths inside and beyond the cap,
// descriptions shorter and longer than the description floor, lists with no descriptions, and
// lists long enough to scroll.
//
// WHAT IT DOES NOT CATCH: how a list degrades below its natural width, beyond the one case in the
// last test.

import { describe, expect, it } from "bun:test";
import { SelectList, type SelectListLayoutOptions, type SelectListTheme } from "@veyyon/tui/components/select-list";
import { visibleWidth } from "@veyyon/utils/width";

const box = { topLeft: "┌", topRight: "┐", bottomLeft: "└", bottomRight: "┘", horizontal: "─", vertical: "│" };
const grid = { ...box, teeDown: "┬", teeUp: "┴", teeLeft: "┤", teeRight: "├", cross: "┼" };
const theme: SelectListTheme = {
	selectedPrefix: text => text,
	selectedText: text => text,
	description: text => text,
	scrollInfo: text => text,
	noMatch: text => text,
	symbols: {
		cursor: "→",
		inputCursor: "|",
		hrChar: "─",
		quoteBorder: "│",
		boxRound: { ...box, topLeft: "╭", topRight: "╮", bottomLeft: "╰", bottomRight: "╯" },
		boxSharp: grid,
		table: grid,
		spinnerFrames: ["|"],
	},
};

interface Case {
	name: string;
	items: { value: string; label: string; description?: string }[];
	layout: SelectListLayoutOptions;
	maxVisible: number;
}

const ITEM_SETS: Record<string, { label: string; description?: string }[]> = {
	"short labels, tiny descriptions": [
		{ label: "info", description: "Info" },
		{ label: "delete", description: "Drop it" },
	],
	"short labels, long descriptions": [
		{ label: "status", description: "Show the account each provider is serving this session with" },
		{ label: "refresh", description: "Re-probe the credentials" },
	],
	"one label past every cap": [
		{ label: "add <name> [http|sse] [url <url>] [token <token>] [run <command...>]", description: "Add a server" },
		{ label: "list", description: "List all configured servers" },
	],
	"no descriptions": [{ label: "alpha" }, { label: "a considerably longer plain label" }],
	mixed: [{ label: "plain" }, { label: "described", description: "A description of moderate length" }],
};

function casesFor(): Case[] {
	const cases: Case[] = [];
	for (const [setName, set] of Object.entries(ITEM_SETS)) {
		const items = set.map((item, i) => ({ value: `v${i}`, ...item }));
		const widestLabel = Math.max(...items.map(item => visibleWidth(item.label)));
		const layouts: Record<string, SelectListLayoutOptions> = {
			default: {},
			"narrow cap": { minPrimaryColumnWidth: 8, maxPrimaryColumnWidth: 12 },
			"wide cap": { minPrimaryColumnWidth: 24, maxPrimaryColumnWidth: 64 },
			"cap at widest label": { maxPrimaryColumnWidth: widestLabel + 2 },
		};
		for (const [layoutName, layout] of Object.entries(layouts)) {
			for (const maxVisible of [10, 1]) {
				// The status legend is chrome that ellipsizes at any width; the modal hosts that size
				// from `naturalWidth()` turn it off and name the keys in their own footer.
				const rowsOnly = { ...layout, statusLegend: false, searchPrompt: false };
				cases.push({
					name: `${setName} / ${layoutName} / maxVisible ${maxVisible}`,
					items,
					layout: rowsOnly,
					maxVisible,
				});
			}
		}
	}
	return cases;
}

/**
 * Every row the list paints while the cursor visits each item. Runs of padding collapse to two
 * cells, so a wider row compares equal when only its margins and scrollbar column moved.
 */
function rowsAt(testCase: Case, width: number): string[] {
	const list = new SelectList(testCase.items, testCase.maxVisible, theme, testCase.layout);
	const rows: string[] = [];
	for (let i = 0; i < testCase.items.length; i++) {
		list.setSelectedIndex(i);
		for (const line of list.render(width)) rows.push(line.replace(/ {2,}/g, "  ").trimEnd());
	}
	return rows;
}

describe("a list at its natural width shows all it can", () => {
	for (const testCase of casesFor()) {
		it(testCase.name, () => {
			const natural = new SelectList(testCase.items, testCase.maxVisible, theme, testCase.layout).naturalWidth();
			const atNatural = rowsAt(testCase, natural);

			for (const row of atNatural) expect(visibleWidth(row)).toBeLessThanOrEqual(natural);
			for (const item of testCase.items) {
				if (!item.description) continue;
				expect(atNatural.some(row => row.includes(`  ${item.description}`))).toBe(true);
			}
			// Past the natural width a wider row reveals nothing: same rows, only more margin.
			expect(rowsAt(testCase, natural + 40)).toEqual(atNatural);
		});
	}

	it("gives a wide name column back to the descriptions below its natural width", () => {
		const testCase: Case = {
			name: "narrow",
			items: ITEM_SETS["one label past every cap"]!.map((item, i) => ({ value: `v${i}`, ...item })),
			layout: { maxPrimaryColumnWidth: 80 },
			maxVisible: 10,
		};
		const rows = rowsAt(testCase, 80);
		expect(rows.some(row => row.includes("list") && row.includes("  List all configured servers"))).toBe(true);
		expect(rows.some(row => row.includes("add <name>") && row.includes("  Add a server"))).toBe(true);
	});
});
