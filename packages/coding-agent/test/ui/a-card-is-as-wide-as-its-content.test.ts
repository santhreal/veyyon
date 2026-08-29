/**
 * WHY: floating cards took a fixed share of the terminal whatever was in them, and a
 * hosted `SelectList` given only a `maxPrimaryColumnWidth` PINNED its label column to
 * that cap. `/session` drew two short rows into a 120-column frame and read as a list
 * that had failed to load the rest; `/account` had `use <provider> <account>` cut to
 * `use <provider> <acco` with forty columns of screen unused beside the card. One
 * default produced both symptoms, and the frame around all of it was painted in the
 * palette's accent colour.
 *
 * THE CLASS: any surface whose size comes from a share of the screen rather than from
 * its own measured content, and any two-column list whose column is set by a bound
 * instead of measured against its rows. Both are closed at the choke points — one card
 * width owner (`ModalSelectListComponent`), one column owner (`SelectList`), one frame
 * paint owner (`cardOutlineColor`) — rather than per caller, and the bounds sweep below
 * is derived from the four ways a caller can state them, so a fifth spelling has to be
 * added here before it can ship.
 *
 * WHAT IT DOES NOT CATCH: it says nothing about cards that do not host a `SelectList`
 * (the account manager, the settings selector, the model hub), which size their own
 * bodies; nothing about height, which the sibling resize suite owns; and nothing about
 * how the hairline READS on a given terminal, only that the frame and the accent are
 * not the same paint.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { ModalSelectListComponent } from "@veyyon/coding-agent/modes/components/modal-select-list";
import { cardOutlineColor } from "@veyyon/coding-agent/modes/theme/card-outline";
import { getSelectListTheme, initTheme, theme } from "@veyyon/coding-agent/modes/theme/theme";
import { type AnsiPolicy, getAnsiPolicy, SelectList, type SelectListLayoutOptions, setAnsiPolicy } from "@veyyon/tui";

beforeAll(async () => {
	await initTheme(false, "unicode", false, "titanium", "titanium");
});

/** `/session`: two short labels, one long description. The card used to be far too wide. */
const SHORT_ITEMS = [
	{ value: "info", label: "info", description: "Show session info and stats" },
	{ value: "delete", label: "delete", description: "Delete current session and return to selector" },
];

/** `/account`: the usage strings that were being truncated. */
const LONG_ITEMS = [
	{ value: "status", label: "status", description: "Show the account each provider is serving this session with" },
	{ value: "manager", label: "manager", description: "Open the account manager" },
	{
		value: "use",
		label: "use <provider> <account>",
		description: "Switch a provider to one account, everywhere on this machine",
	},
	{ value: "logout", label: "logout [provider]", description: "Log an account out" },
];

function card(items: typeof SHORT_ITEMS, title = "/session"): ModalSelectListComponent {
	return new ModalSelectListComponent(
		{ title, items, theme: getSelectListTheme(), getTerminalRows: () => 40 },
		{ onSelect: () => {}, onCancel: () => {} },
	);
}

/** The rendered card's own rows, ANSI stripped, columns intact. */
function cardRows(component: ModalSelectListComponent, width: number): string[] {
	const lines = component.render(width).map(line => stripVTControlCharacters(line));
	const top = lines.findIndex(line => line.includes("┌"));
	const bottom = lines.findIndex(line => line.includes("└"));
	expect(top).toBeGreaterThanOrEqual(0);
	expect(bottom).toBeGreaterThan(top);
	return lines.slice(top, bottom + 1);
}

/** Cells the card's frame spans, measured off its own top border. */
function cardWidth(component: ModalSelectListComponent, width: number): number {
	const top = cardRows(component, width)[0] ?? "";
	return top.trimEnd().length - top.search(/\S/);
}

describe("a card is as wide as its content", () => {
	/**
	 * The defect exactly: a card wider than anything in it. Two rows whose widest is
	 * under 55 cells were given 60% of a 120-column terminal (72) and then, once the
	 * card could grow, must not take more than the rows need either.
	 */
	it("sizes a short list well under the share of the screen it used to take", () => {
		const component = card(SHORT_ITEMS);
		const width = cardWidth(component, 120);
		expect(width).toBeLessThan(Math.floor(120 * 0.6));
		// And not so narrow that the rows it was measured from no longer fit.
		for (const row of cardRows(component, 120).slice(1, -1)) {
			expect(row).not.toContain("…");
		}
	});

	/**
	 * The other half of the same defect. A list that wants MORE than the share grows
	 * into the room the terminal has, up to `maxWidth`, rather than truncating with the
	 * screen empty beside it.
	 */
	it("grows a long list past the share of the screen, and keeps every label whole", () => {
		const rows = cardRows(card(LONG_ITEMS, "/account"), 120);
		expect(rows[0]!.trimEnd().length - rows[0]!.search(/\S/)).toBeGreaterThan(Math.floor(120 * 0.6));
		expect(rows.join("\n")).toContain("use <provider> <account>");
		for (const row of rows.slice(1, -1)) {
			expect(row).not.toContain("…");
		}
	});

	/** A card can never exceed the terminal, whatever its content asks for. */
	it.each([40, 60, 80, 100, 120, 160])("fits inside a %i-column terminal", areaWidth => {
		for (const items of [SHORT_ITEMS, LONG_ITEMS]) {
			const component = card(items);
			for (const row of cardRows(component, areaWidth)) {
				expect(stripVTControlCharacters(row).length).toBeLessThanOrEqual(areaWidth);
			}
		}
	});

	/**
	 * Filtering removes rows, so a card measured from the CURRENT rows would narrow on a
	 * keystroke and the frame would move under the reader. The high-water mark is what
	 * prevents it, and it is per terminal width.
	 */
	it("does not narrow while the list filters down", () => {
		const component = card(LONG_ITEMS, "/account");
		const before = cardWidth(component, 120);
		component.getSelectList().setFilter("logout");
		expect(cardWidth(component, 120)).toBe(before);
	});

	/**
	 * The mark may accelerate within a width and never leak across one: the same rows
	 * lay out differently at a new width, so a card resized and returned must match a
	 * fresh card at that width exactly.
	 */
	it("is the same width after a resize as a fresh card is", () => {
		const resized = card(LONG_ITEMS, "/account");
		resized.render(120);
		resized.render(60);
		expect(cardWidth(resized, 120)).toBe(cardWidth(card(LONG_ITEMS, "/account"), 120));
	});
});

describe("a measured label column", () => {
	/**
	 * SHORT labels with a GENEROUS cap is the one shape that can see the defect. Where
	 * the widest label exceeds the cap, a pinned column and a measured one produce the
	 * same width — the cap decides both — so a suite built on long labels passes against
	 * the bug. `/session` was the reported case exactly: `info` and `delete` under a
	 * 22-cell cap, drawn 22 cells from their descriptions.
	 */
	const SHORT = [
		{ value: "info", label: "info", description: "FIRSTDESC" },
		{ value: "delete", label: "delete", description: "SECONDDESC" },
	];
	/** A label wider than any cap here, for the cap's own contract. */
	const WIDE = [
		{ value: "short", label: "info", description: "FIRSTDESC" },
		{ value: "long", label: "a much longer label than the other", description: "SECONDDESC" },
	];
	const CAP = 22;

	function list(items: typeof SHORT, layout: SelectListLayoutOptions): SelectList {
		return new SelectList(items, 10, getSelectListTheme(), layout);
	}

	/** Column where a row's description starts, measured from the row's first cell. */
	function descriptionColumn(rendered: readonly string[], rowIndex: number, description: string): number {
		const row = stripVTControlCharacters(rendered[rowIndex] ?? "");
		const at = row.indexOf(description);
		expect(at).toBeGreaterThan(0);
		return at;
	}

	/**
	 * The four ways a caller can state the bounds, swept rather than sampled, because
	 * the defect was one of them cross-defaulting into the other: a lone cap became the
	 * floor as well, so it PINNED the column and every short label sat out at the cap.
	 * A fifth spelling has to be added here before it can ship.
	 */
	it.each([
		["neither bound", {}],
		["floor only", { minPrimaryColumnWidth: 6 }],
		["cap only", { maxPrimaryColumnWidth: CAP }],
		["both bounds", { minPrimaryColumnWidth: 6, maxPrimaryColumnWidth: CAP }],
	])("%s measures short labels rather than resting them on a bound", (_name, layout) => {
		const rendered = list(SHORT, layout).render(80);
		// The widest label is `delete` at 6 cells, so with the two-cell column gap the
		// descriptions belong at the prefix plus 8 — not out at the cap, and not out at
		// the 32-cell default either.
		for (const [rowIndex, description] of [
			[0, "FIRSTDESC"],
			[1, "SECONDDESC"],
		] as const) {
			expect(descriptionColumn(rendered, rowIndex, description)).toBeLessThan(CAP);
		}
		// Both descriptions in the SAME column: that is what makes it a column at all.
		expect(descriptionColumn(rendered, 0, "FIRSTDESC")).toBe(descriptionColumn(rendered, 1, "SECONDDESC"));
	});

	/** A cap is a cap: the column may not exceed it even when a label wants more. */
	it("truncates a label that will not fit the cap", () => {
		const capped = stripVTControlCharacters(list(WIDE, { maxPrimaryColumnWidth: 12 }).render(80)[1] ?? "");
		expect(capped).not.toContain("a much longer label than the other");
		// And the row it capped still carries its description, which is the point of capping.
		expect(capped).toContain("SECONDDESC");
	});

	/** The column never takes so much of the row that the description it sits beside is squeezed out. */
	it.each([44, 60, 80, 120])("leaves the description half the row at width %i", width => {
		const row = stripVTControlCharacters(list(WIDE, {}).render(width)[1] ?? "");
		expect(row.indexOf("SECONDDESC")).toBeLessThanOrEqual(Math.floor(width / 2) + 4);
	});

	/** The measurement a card sizes itself from is an upper bound on what the list needs. */
	it("reports a natural width at which nothing is truncated", () => {
		const measured = list(WIDE, {});
		const natural = measured.naturalWidth(200);
		for (const row of measured.render(natural)) {
			expect(stripVTControlCharacters(row)).not.toContain("…");
		}
	});
});

describe("a card frame is not the accent colour", () => {
	/**
	 * Colour is off under a test runner, because stdout is not a terminal, and every
	 * paint would then be the empty string and every comparison below trivially true.
	 * Restored after this block rather than set for the file: the width assertions above
	 * read stripped text and must not depend on it.
	 */
	let previousPolicy: AnsiPolicy;
	beforeAll(() => {
		previousPolicy = getAnsiPolicy();
		setAnsiPolicy("full");
	});
	afterAll(() => {
		setAnsiPolicy(previousPolicy);
	});

	/**
	 * The frame used to be `theme.fg("borderAccent")`, which is `ember` (#F0862E) in
	 * titanium: the loudest colour in the palette on the least informative pixels. Every
	 * token that resolves to an accent is checked, so restoring any of them turns this
	 * red rather than only the one that was there.
	 */
	it.each(["borderAccent", "accent", "link"] as const)("differs from the %s token", token => {
		expect(cardOutlineColor()("─")).not.toBe(theme.fg(token, "─"));
	});

	/** And the card the shell actually renders uses that paint on its border rows. */
	it("paints the rendered border with the frame owner's paint", () => {
		const lines = card(SHORT_ITEMS).render(120);
		const top = lines.find(line => line.includes("┌")) ?? "";
		const bottom = lines.find(line => line.includes("└")) ?? "";
		const framePrefix = cardOutlineColor()("─").replace("─", "").replace("\x1b[39m", "");
		expect(framePrefix.length).toBeGreaterThan(0);
		expect(top).toContain(framePrefix);
		expect(bottom).toContain(framePrefix);
		expect(bottom).not.toContain(theme.fg("borderAccent", "─"));
	});
});
