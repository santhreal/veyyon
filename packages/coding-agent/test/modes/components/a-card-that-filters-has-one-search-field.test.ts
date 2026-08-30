/**
 * WHY THIS SUITE EXISTS.
 *
 * The field an operator types a filter into had five definitions. `/providers`
 * drew the search glyph in the state accent with a bold query and a right-edge
 * count; `/settings` drew a near copy whose glyph took the declared `accent`
 * token, so a theme whose accent is a neutral rendered the one live affordance
 * on the card grey; the session tree, the extension pane, the hook picker, the
 * OAuth picker and the message picker drew the literal string `Search: ` — three
 * of them with a hand-painted `_` for a caret, inside the card BODY, while still
 * asking the shell to reserve its search band. An operator learned the
 * affordance once per card, and a themed terminal showed it in a different
 * colour on each.
 *
 * THE CLASS, NOT THE INCIDENT.
 * `search-band.ts` is the one definition, and the class is "a card invents its
 * own search field". Two arms close it:
 *
 *   1. The owner's contract: pluralisation, the zero-match readout, the caret at
 *      the insertion point, exact band width, and the count's column staying put
 *      as the query grows (it used to travel across the band, because two cards
 *      put the count immediately after the query).
 *   2. A sweep of every card in `OVERLAY_SPECS`, at three widths, in every state
 *      its `reachKeys` reach: no frame carries a hand-rolled field label.
 *      `Search:`, `Type to search` and a painted `_` caret are banned outright.
 *   3. The list seam. A `SelectList` or a `SettingsList` draws its own status
 *      row, which the library writes as `Search: ` for a consumer outside this
 *      product. Both themes are built by `getSelectListTheme()` and
 *      `getSettingsListTheme()`, the choke point every one of this product's
 *      lists passes through, so the field is asserted there rather than once per
 *      call site.
 *
 * FAIL BY DEFAULT ON NEW MEMBERS.
 * The variant space is `OVERLAY_SPECS` read at run time, so a card added to the
 * product is swept the moment it is registered there (and the roll call in
 * `a-card-first-frame-is-settled.test.ts` makes it red until it is). A new card
 * that hand-rolls `Search: ` is red here.
 *
 * WHAT IT DOES NOT CATCH.
 * A card that hand-rolls bytes IDENTICAL to the band's — same glyph paint, same
 * caret, same count grammar — passes: the sweep reads frames, not call graphs,
 * and only a lint rule could see the duplicate definition. A state no
 * `reachKeys` reach is not rendered, so a field only shown after a chord the
 * spec does not send is invisible here; the per-card suites
 * (`account-manager-search.test.ts`, `oauth-selector.test.ts`,
 * `user-message-selector.test.ts`, `hook-selector-slider.test.ts`) drive those
 * fields with typed input and assert the glyph and the query on the row. The
 * setup wizard's SCENES are out of the sweep: they are in-flow surfaces rather
 * than floating cards, and `OVERLAY_SPECS` does not carry them. Their lists are
 * covered by arm 3, because they are built from the same two theme getters.
 * Whether the band LOOKS right is taste, judged in the demo scenes.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { AnsiPolicy } from "@veyyon/tui";
import {
	CURSOR_MARKER,
	getAnsiPolicy,
	SelectList,
	SettingsList,
	setAnsiPolicy,
	TERMINAL,
	visibleWidth,
} from "@veyyon/tui";
import { queryField, searchAffordance, searchBand } from "../../../src/modes/components/search-band";
import { getSelectListTheme, getSettingsListTheme, initTheme, theme } from "../../../src/modes/theme/theme";
import { OVERLAY_SPECS, type RenderableOverlay } from "./overlay-specs";

beforeAll(async () => {
	await initTheme(false, "unicode", false, "titanium", "dark");
});

/** What a terminal shows: colour gone, and the caret marker it consumes gone too. */
function plain(line: string): string {
	return stripVTControlCharacters(line).replaceAll(CURSOR_MARKER, "");
}

const COUNTS: readonly { count: { matches: number; noun: string }; reads: string }[] = [
	{ count: { matches: 0, noun: "provider" }, reads: "0 providers" },
	{ count: { matches: 1, noun: "provider" }, reads: "1 provider" },
	{ count: { matches: 12, noun: "provider" }, reads: "12 providers" },
	{ count: { matches: 1, noun: "match" }, reads: "1 match" },
	{ count: { matches: 0, noun: "match" }, reads: "0 matches" },
	{ count: { matches: 3, noun: "entry" }, reads: "3 entries" },
];

describe("a card that filters has one search field", () => {
	it("counts what survived the query, in the noun the card filters", () => {
		for (const { count, reads } of COUNTS) {
			expect(plain(searchBand(60, count, () => "q"))).toContain(reads);
		}
	});

	it("says a query matched nothing in the warning colour, not the dim one", () => {
		const empty = searchBand(60, { matches: 0, noun: "match" }, () => "zzz");
		const found = searchBand(60, { matches: 4, noun: "match" }, () => "zzz");
		expect(empty).toContain(theme.fg("warning", "0 matches"));
		expect(found).toContain(theme.fg("dim", "4 matches"));
	});

	it("is exactly as wide as the band it was given, and truncates rather than overrunning", () => {
		const widths: number[] = [];
		const overruns: number[] = [];
		for (const width of [40, 60, 98, 131]) {
			widths.push(visibleWidth(plain(searchBand(width, { matches: 7, noun: "provider" }, () => "an"))));
			const long = searchBand(width, { matches: 7, noun: "provider" }, () => "x".repeat(width * 2));
			overruns.push(visibleWidth(plain(long)));
		}
		expect(widths).toEqual([40, 60, 98, 131]);
		expect(overruns).toEqual([40, 60, 98, 131]);
	});

	/**
	 * The defect this pins: two cards wrote the count immediately after the query,
	 * so it slid one column right on every keystroke, and `type to filter providers
	 * 65 providers` said `providers` twice about two different things.
	 */
	it("keeps the count in one column while the query grows", () => {
		const columns = new Set<number>();
		for (let length = 1; length <= 10; length++) {
			const band = plain(searchBand(80, { matches: 9, noun: "provider" }, () => "q".repeat(length)));
			columns.add(band.indexOf("9 providers"));
		}
		expect([...columns]).toHaveLength(1);
		expect(columns.has(-1)).toBe(false);
	});

	it("puts the terminal's caret at the insertion point, ahead of the hint when the query is empty", () => {
		const typed = queryField("anth", "type to filter providers");
		expect(typed).toContain(theme.bold("anth"));
		expect(typed.endsWith(CURSOR_MARKER)).toBe(true);

		const empty = queryField("", "type to filter providers");
		expect(empty.startsWith(CURSOR_MARKER)).toBe(true);
		expect(plain(empty)).toBe("type to filter providers");
	});

	it("gives the field a glyph that carries colour in a theme whose accent is a neutral", () => {
		const band = searchBand(60, { matches: 1, noun: "provider" }, () => "a");
		expect(band).toContain(theme.stateAccent(theme.symbol("icon.search")));
		expect(plain(searchAffordance(60, "/ search settings"))).toBe(
			` ${theme.symbol("icon.search")} / search settings`,
		);
	});

	it("sweeps every card in the product: none of them writes a search label of its own", async () => {
		const caps: { trueColor: boolean } = TERMINAL;
		const trueColorWas = caps.trueColor;
		const policyWas: AnsiPolicy = getAnsiPolicy();
		caps.trueColor = true;
		// The caret needle is a PAINTED glyph. Under a policy that emits no colour it
		// degenerates to a bare `_`, which matches `set_cwd` in a skill description and
		// reports six findings about prose. Forcing the policy keeps the needle a needle.
		setAnsiPolicy("full");
		const unconstructable: string[] = [];
		const findings: string[] = [];
		const paintedCaret = theme.fg("accent", "_");
		try {
			for (const spec of OVERLAY_SPECS) {
				let card: RenderableOverlay;
				try {
					card = await spec.create();
				} catch (err) {
					unconstructable.push(`${spec.name}: ${err}`);
					continue;
				}
				try {
					if (spec.reachKeys && "handleInput" in card && typeof card.handleInput === "function") {
						for (const keys of spec.reachKeys) card.handleInput(keys);
					}
					for (const width of [80, 100, 140]) {
						for (const line of card.render(width)) {
							const text = plain(line);
							for (const banned of ["Search:", "Type to search"]) {
								if (text.includes(banned)) {
									findings.push(`${spec.name} at ${width}: hand-rolled "${banned}": ${text.trim()}`);
								}
							}
							if (line.includes(paintedCaret)) {
								findings.push(`${spec.name} at ${width}: painted caret: ${text.trim()}`);
							}
						}
					}
				} finally {
					if ("dispose" in card && typeof card.dispose === "function") card.dispose();
				}
			}
		} finally {
			caps.trueColor = trueColorWas;
			setAnsiPolicy(policyWas);
		}
		expect(findings).toEqual([]);
		expect(unconstructable).toEqual([]);
	});
});

/**
 * ARM 3. The list seam, asserted at the theme getters every list in this product
 * is built from, rather than at the 28 construction sites.
 *
 * A list drawn inside somebody else's surface has no band to put a field in, so
 * it draws one on its own status row: same glyph, same query, and NO caret,
 * because {@link CURSOR_MARKER} moves the one hardware cursor and the scene that
 * owns the focused input already has it.
 */
describe("a list that filters shows the same field on its status row", () => {
	const ITEMS = Array.from({ length: 12 }, (_, i) => ({ value: `v${i}`, label: `row ${i}`, description: "" }));
	const SETTINGS = Array.from({ length: 12 }, (_, i) => ({
		id: `s${i}`,
		label: `setting ${i}`,
		currentValue: "off",
		values: ["off", "on"],
	}));

	function statusRow(frame: readonly string[]): string {
		const row = frame.map(line => plain(line)).find(line => line.includes(theme.symbol("icon.search")));
		return row?.trim() ?? "";
	}

	it("shows the glyph and the query rather than the library's own label", () => {
		const list = new SelectList(ITEMS, 5, getSelectListTheme());
		list.render(60);
		list.handleInput("r");
		const frame = list.render(60).map(line => plain(line));

		expect(statusRow(frame)).toStartWith(`${theme.symbol("icon.search")} r`);
		expect(frame.join("\n")).not.toContain("Search:");
	});

	it("shows the idle hint under the same glyph before anything is typed", () => {
		const list = new SelectList(ITEMS, 5, getSelectListTheme());
		const frame = list.render(60).map(line => plain(line));

		expect(statusRow(frame)).toStartWith(`${theme.symbol("icon.search")} type to search`);
		expect(frame.join("\n")).not.toContain("Type to search");
	});

	it("claims no hardware cursor: the caret belongs to the card that opened a field", () => {
		const list = new SelectList(ITEMS, 5, getSelectListTheme());
		list.render(60);
		list.handleInput("r");

		expect(list.render(60).join("\n")).not.toContain(CURSOR_MARKER);
	});

	it("draws the same field on a settings list, which writes its own status row", () => {
		const list = new SettingsList(
			SETTINGS,
			5,
			getSettingsListTheme(),
			() => {},
			() => {},
		);
		list.render(60);
		list.handleInput("s");
		const frame = list.render(60).map(line => plain(line));

		expect(statusRow(frame)).toStartWith(`${theme.symbol("icon.search")} s`);
		expect(frame.join("\n")).not.toContain("Search:");
	});

	/**
	 * NON-VACUITY. Both assertions above are an absence plus a prefix, and both
	 * hold against a list whose status row never rendered at all. This proves the
	 * row is on screen, and that the library still writes its own text for a
	 * consumer outside this product — which is what makes the getters, not the
	 * library, the thing under test.
	 */
	it("really renders a status row, and the library keeps its own default", () => {
		const themed = new SelectList(ITEMS, 5, getSelectListTheme());
		themed.render(60);
		themed.handleInput("r");
		expect(statusRow(themed.render(60).map(line => plain(line)))).not.toBe("");

		const bare = new SelectList(ITEMS, 5, { ...getSelectListTheme(), searchField: undefined });
		bare.render(60);
		bare.handleInput("r");
		expect(
			bare
				.render(60)
				.map(line => plain(line))
				.join("\n"),
		).toContain("Search: r");
	});
});
