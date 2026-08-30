/**
 * WHY: a settings row used to say what kind of thing it was only in colour, and
 * said where it sat in the list not at all. Every row started at the same column
 * whether it was a group heading or a member of that group; a row that opened a
 * submenu looked exactly like a row that held a value; the values ended wherever
 * their labels stopped, so no two rows shared an edge; and the selected row's
 * description was spliced in beneath it, which reflowed every row below the
 * cursor each time the cursor moved.
 *
 * The class this closes is structural legibility: a reader must be able to tell a
 * row's kind, its depth and its value from the row's SHAPE, with paint switched
 * off entirely — which is how this suite renders, through an identity theme. So
 * every assertion below is on plain text and on cells, and none of them can be
 * satisfied by a colour. It also closes the reflow class: the row stream is a
 * function of the scroll position, never of the cursor.
 *
 * What it does not catch: whether the glyphs chosen are the right glyphs, or
 * whether the inset is two columns rather than three. Those are the theme's and
 * the constants' business. It does not check the paint, deliberately: a sibling
 * suite owns that, and a structural claim that needed the colour would be the
 * defect this file exists to prevent.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	type SettingItem,
	type SettingsDescriptionMode,
	SettingsList,
	type SettingsListTheme,
} from "@veyyon/tui/components/settings-list";
import { KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "@veyyon/tui/keybindings";

const CURSOR = "→ ";
/** What `theme.nav.next` resolves to, which is what the real theme passes in. */
const DRILL = "▸";

/** Identity theme: every assertion here is about shape, so nothing is painted. */
const plainTheme: SettingsListTheme = {
	label: (text: string) => text,
	value: (text: string) => text,
	description: (text: string) => text,
	cursor: CURSOR,
	hint: (text: string) => text,
	drillIn: DRILL,
};

function list(items: SettingItem[], maxVisible = 12, options = {}): SettingsList {
	return new SettingsList(
		items,
		maxVisible,
		plainTheme,
		() => {},
		() => {},
		options,
	);
}

/** The cursor lives in a gutter, so a row's depth is read past it. */
function body(line: string): string {
	return line.startsWith(CURSOR) ? `  ${line.slice(CURSOR.length)}` : line;
}

function rowsOf(rendered: readonly string[]): string[] {
	const stop = rendered.findIndex(line => line.includes("to search") || line.includes("esc to"));
	// Untrimmed: the reserved affordance cell of a row that does not drill in IS
	// trailing whitespace, and trimming it away would hide the reservation.
	return stop === -1 ? [...rendered] : rendered.slice(0, stop);
}

/** The row a label is drawn on, or -1. Used to prove the stream did not move. */
function rowOf(rendered: readonly string[], label: string): number {
	return rendered.findIndex(line => line.includes(label));
}

const grouped: SettingItem[] = [
	{ id: "ga", label: "Appearance", currentValue: "", heading: true },
	{ id: "theme", label: "Theme", currentValue: "dark", values: ["dark", "light"] },
	{ id: "font", label: "Font Ligatures", currentValue: "off", values: ["off", "on"] },
	{ id: "gb", label: "Editor", currentValue: "", heading: true },
	{ id: "tabs", label: "Tab Width", currentValue: "4", values: ["2", "4", "8"] },
];

describe("a settings row shows its kind in its shape", () => {
	beforeEach(() => {
		setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
	});
	afterEach(() => {
		setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
	});

	it("ends every value on one right edge, whatever its label's length", () => {
		const rows = rowsOf(
			list([
				{ id: "a", label: "A", currentValue: "off", values: ["off", "on"] },
				{ id: "b", label: "A Considerably Longer Label", currentValue: "always", values: ["always", "never"] },
				{ id: "c", label: "Mid Label", currentValue: "2", values: ["1", "2"] },
			]).render(60),
		).filter(line => line.trim() !== "");

		expect(rows).toHaveLength(3);
		expect(new Set(rows.map(line => line.length)).size).toBe(1);
		// The edge is the value column's, not the longest label's.
		expect(rows[0]?.length).toBeGreaterThan("  A Considerably Longer Label".length);
	});

	it("insets a group's members past its heading, and spaces one group from the next", () => {
		const rows = rowsOf(list(grouped, 12, { layout: "flat" }).render(60));
		const depth = (label: string) => {
			const line = rows.find(r => r.includes(label));
			if (line === undefined) throw new Error(`no row for ${label}`);
			return body(line).search(/\S/);
		};

		// A member sits deeper than the heading it belongs to.
		expect(depth("Theme")).toBeGreaterThan(depth("Appearance"));
		expect(depth("Tab Width")).toBeGreaterThan(depth("Editor"));
		// Every heading starts at one depth, and every member at one other.
		expect(depth("Editor")).toBe(depth("Appearance"));
		expect(depth("Tab Width")).toBe(depth("Theme"));

		// A blank row separates the second group from the first, and the first
		// group does not open with one.
		expect(rows[rows.findIndex(r => r.includes("Editor")) - 1]?.trim()).toBe("");
		expect(rows[0]).toContain("Appearance");
	});

	it("reserves the row's last cell for the drill-in glyph, and leaves it blank otherwise", () => {
		const rows = rowsOf(
			list([
				{ id: "plain", label: "Plain", currentValue: "off", values: ["off", "on"] },
				{
					id: "deep",
					label: "Deep",
					currentValue: "custom",
					submenu: () => {
						throw new Error("not opened by this test");
					},
				},
			]).render(60),
		).filter(line => line.trim() !== "");

		const plain = rows.find(r => r.includes("Plain")) ?? "";
		const deep = rows.find(r => r.includes("Deep")) ?? "";
		// The cell is RESERVED, not appended: both rows are the same width, so the
		// values still share their edge across a drill-in row and a value row.
		expect(deep.length).toBe(plain.length);
		expect(deep.endsWith(DRILL)).toBe(true);
		expect(plain).not.toContain(DRILL);
		// A value row's last cell is empty, so the glyph reads as this row's own
		// kind and not as a column every row happens to fill.
		expect(plain.endsWith(" ")).toBe(true);
	});

	it("moves the cursor without moving any row", () => {
		const described: SettingItem[] = [
			{ id: "a", label: "Alpha", currentValue: "off", values: ["off", "on"], description: "The first setting." },
			{
				id: "b",
				label: "Beta",
				currentValue: "off",
				values: ["off", "on"],
				description: "The second setting, whose description is a different length entirely.",
			},
			{ id: "c", label: "Gamma", currentValue: "off", values: ["off", "on"] },
		];
		const subject = list(described);

		const before = subject.render(60);
		const wasAt = described.map(item => rowOf(before, item.label));
		subject.handleInput("\u001B[B"); // down
		const after = subject.render(60);

		// The frame is one height and every row is where it was, though the two
		// descriptions differ in length and the third row has none: a description
		// of any length costs the same rows.
		expect(after).toHaveLength(before.length);
		expect(described.map(item => rowOf(after, item.label))).toEqual(wasAt);
		expect(wasAt.every(row => row >= 0)).toBe(true);
		// Only the cursor and the selected row's own affordance changed.
		expect(rowOf(after, CURSOR)).toBe(rowOf(before, CURSOR) + 1);
	});

	it("spends rows on the description band only when no setting loses a row for it", () => {
		const many = (count: number): SettingItem[] =>
			Array.from({ length: count }, (_, i) => ({
				id: `i${i}`,
				label: `Item ${i}`,
				currentValue: "off",
				values: ["off", "on"],
				description: `Description of item ${i}.`,
			}));
		const bandShown = (items: SettingItem[], maxVisible: number) =>
			list(items, maxVisible).render(60).join("\n").includes("Description of item 0.");

		// Room for every row AND the band: the band appears.
		expect(bandShown(many(4), 12)).toBe(true);
		// The list fits exactly, so the band would push its tail out of a frame
		// that could have shown all of it: the rows win.
		expect(bandShown(many(9), 9)).toBe(false);
		expect(bandShown(many(11), 12)).toBe(false);
		// Already overflowing: the band changes how far you scroll, not whether,
		// so it costs nothing a reader could otherwise have seen.
		expect(bandShown(many(40), 12)).toBe(true);
		// A frame too short to hold both keeps its rows.
		expect(bandShown(many(40), 5)).toBe(false);
	});

	it("keeps every row of a fitting list on screen once groups claim their spacers", () => {
		// A spacer is a physical row, so a viewport measured in items overflowed
		// the moment a group was added and silently dropped the last group.
		const rendered = list(grouped, 12, { layout: "flat" }).render(60).join("\n");
		for (const item of grouped) expect(rendered).toContain(item.label);
	});

	it("steps the value with the arrow keys the row's frame advertises", () => {
		const changes: Array<[string, string]> = [];
		const subject = new SettingsList(
			[{ id: "tabs", label: "Tab Width", currentValue: "4", values: ["2", "4", "8"] }],
			8,
			plainTheme,
			(id, value) => changes.push([id, value]),
			() => {},
		);

		expect(subject.render(60)[0]).toContain("‹ 4 ›");
		subject.handleInput("\u001B[C"); // right
		subject.handleInput("\u001B[D"); // left
		// Right steps forward and left steps back over the same value list, so the
		// pair returns to where it started.
		expect(changes).toEqual([
			["tabs", "8"],
			["tabs", "4"],
		]);
	});

	it("wears no cycling frame on a row with nothing to cycle to", () => {
		const rows = rowsOf(
			list([
				{ id: "one", label: "Only", currentValue: "fixed", values: ["fixed"] },
				{ id: "none", label: "Bare", currentValue: "shown" },
			]).render(60),
		).filter(line => line.trim() !== "");

		// The frame is the promise of a step, so a row without one must not wear it.
		for (const row of rows) expect(row).not.toContain("‹");
		expect(rows[0]).toContain("fixed");
		expect(rows[1]).toContain("shown");
	});

	/**
	 * Fail-by-default: a fourth description mode cannot be added to
	 * {@link SettingsDescriptionMode} without a row here, because the map is
	 * exhaustive over the union and the type check rejects a missing key.
	 */
	it("gives every description mode a frame of its own", () => {
		const expected: Record<SettingsDescriptionMode, boolean> = {
			footnote: true,
			reserved: true,
			none: false,
		};

		const modes = Object.keys(expected) as SettingsDescriptionMode[];
		expect(modes).toHaveLength(3);
		for (const mode of modes) {
			const rendered = list(
				[
					{
						id: "a",
						label: "Alpha",
						currentValue: "off",
						values: ["off", "on"],
						description: "The first setting.",
					},
					{ id: "b", label: "Beta", currentValue: "off", values: ["off", "on"] },
				],
				12,
				{ descriptionMode: mode },
			)
				.render(60)
				.join("\n");
			expect(rendered.includes("The first setting.")).toBe(expected[mode]);
		}
	});
});
