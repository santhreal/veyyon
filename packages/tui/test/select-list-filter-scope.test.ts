/**
 * What a row is matched against when the user types.
 *
 * By default a row is searchable by everything it shows, which is right for a
 * list of prose settings: you find "Automatic Updates" by typing part of its
 * description. It is wrong when the description carries DATA OF THE SAME SHAPE
 * as the value. The version picker is the case that forced this: rows read
 * `1.5.0` beside `2026-06-24 · previously run`, and a query of `1.1` matched
 * every row whose date happened to contain a 1. Nothing about the result told
 * the user why, so the filter simply looked broken.
 *
 * `SelectItem.filterText` replaces the searchable text outright rather than
 * adding to it, because the whole point is to EXCLUDE what the row also shows.
 * These tests hold both halves: the default still searches everything, and an
 * explicit filter text is the only thing searched.
 */
import { describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { type SelectItem, SelectList } from "@veyyon/tui/components/select-list";
import { defaultSelectListTheme } from "./test-themes.js";

/** Versions beside dates, the shape that produced the false matches. */
const VERSION_ROWS: SelectItem[] = [
	{ value: "1.3.0", label: "1.3.0", description: "2026-07-01 · newer", filterText: "1.3.0" },
	{ value: "1.2.0", label: "1.2.0", description: "2026-06-01 · current", filterText: "1.2.0" },
	{ value: "1.1.0", label: "1.1.0", description: "2026-05-01 · previously run", filterText: "1.1.0" },
];

/** The same rows without the opt-in, to prove the default is unchanged. */
const DEFAULT_ROWS: SelectItem[] = VERSION_ROWS.map(({ filterText: _drop, ...rest }) => rest);

function visible(items: SelectItem[], query: string): string {
	const list = new SelectList(items, 10, defaultSelectListTheme);
	list.setFilter(query);
	return list
		.render(60)
		.map(line => stripVTControlCharacters(line))
		.join("\n");
}

describe("with an explicit filterText", () => {
	it("matches the version and nothing else", () => {
		const shown = visible(VERSION_ROWS, "1.1");

		expect(shown).toContain("1.1.0");
		expect(shown).not.toContain("1.3.0");
		expect(shown).not.toContain("1.2.0");
	});

	it("stops the description from answering the query", () => {
		// "2026" is in every row's description and in no row's filter text, so a
		// list that still matched it would prove the description is being searched.
		expect(visible(VERSION_ROWS, "2026")).toContain("No matching items");
	});

	it("still shows the description on the rows that do match", () => {
		// Excluding text from SEARCH must not exclude it from DISPLAY.
		expect(visible(VERSION_ROWS, "1.1")).toContain("2026-05-01");
	});

	it("leaves an empty query showing everything", () => {
		const shown = visible(VERSION_ROWS, "");

		for (const version of ["1.3.0", "1.2.0", "1.1.0"]) expect(shown).toContain(version);
	});
});

describe("without one", () => {
	it("keeps searching the description, which most lists want", () => {
		// The default is load-bearing: a settings list is found by its prose.
		expect(visible(DEFAULT_ROWS, "previously")).toContain("1.1.0");
	});

	it("shows the date-driven false match this option exists to remove", () => {
		// Documents the default's cost rather than hiding it: "1.1" against
		// "1.3.0 / 2026-07-01" matches, because the date supplies the second 1.
		expect(visible(DEFAULT_ROWS, "1.1")).toContain("1.3.0");
	});
});
