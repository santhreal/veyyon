/**
 * WHY THIS SUITE EXISTS.
 *
 * The row a filtering surface shows when the query matched nothing had nine
 * definitions, and they disagreed about everything except the words. Five cards
 * painted it `muted`; the hook picker and the move overlay painted it `dim`; the
 * settings card arrived at a third weight because the list library paints this
 * row with its `hint` style, which is what the product uses for a keyboard hint
 * and not for a fact about the list. The history search prefixed an info glyph
 * no other card showed, and the move overlay wrote it flush against the frame
 * while the rows it replaced were indented two cells, so the sentence moved
 * sideways as the list emptied.
 *
 * THE CLASS, NOT THE INCIDENT.
 * `emptyRow` and `noMatchRow` in `search-band.ts` are the one definition — the
 * counterpart of the search field, which had the same defect and the same fix —
 * and the class is "a surface invents its own empty row". Four arms close it:
 *
 *   1. The owner's contract: one paint, one indent, and the no-match sentence
 *      built from the noun the surface filters.
 *   2. A sweep of every card in `OVERLAY_SPECS`, driven into its search state
 *      and then given a query nothing can match, at three widths: every row
 *      that reads as an empty state must carry the owner's opening bytes for its
 *      own words. A card's row arrives inside its frame, so the sentence is
 *      matched anywhere on the line and the owner's paint plus indent is
 *      required in front of it. A hand-rolled paint, a missing indent or an
 *      extra glyph is a finding naming the card and the width.
 *   3. The list seam. `SelectList` and `SettingsList` draw this row themselves
 *      for a consumer outside this product; both themes come from
 *      `getSelectListTheme()` and `getSettingsListTheme()`, the choke point
 *      every list in the product is built through, so the row is asserted there
 *      rather than at the construction sites — and the library's own default is
 *      asserted to survive for a consumer who supplies neither.
 *   4. The hook picker, constructed directly with a list long enough to open its
 *      search. Its search is gated on the option rows outgrowing the viewport,
 *      so the sweep's short fixture can never reach its empty row.
 *
 * FAIL BY DEFAULT ON NEW MEMBERS.
 * The variant space is `OVERLAY_SPECS` read at run time, so a card registered
 * in the product is swept without being named here. A card that writes its own
 * empty row is red, and a card excused from the sweep has to be listed in
 * `NOT_AN_EMPTY_ROW` by exact text, which is pinned by equality so a stale
 * excuse is red too.
 *
 * WHAT IT DOES NOT CATCH.
 * A card that hand-rolls bytes IDENTICAL to the owner's passes: the sweep reads
 * frames, not call graphs. A state no key sequence in a card's spec can reach is
 * not rendered, so it is invisible here — the account manager's "no providers at
 * all" row is one, since the spec's card always resolves a provider — and the
 * sweep asserts it saw the row on several cards rather than trusting an empty
 * finding list. Transcript output written by the slash-command controllers is a
 * message body rather than a card row and keeps its own unindented voice. The
 * words themselves are prose, judged by reading them, not by this file.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { AnsiPolicy } from "@veyyon/tui";
import { CURSOR_MARKER, getAnsiPolicy, SelectList, setAnsiPolicy, SettingsList, TERMINAL } from "@veyyon/tui";
import { HookSelectorComponent } from "../../../src/modes/components/hook-selector";
import { CARD_BODY_COL_INSET } from "../../../src/modes/components/modal-shell";
import { emptyRow, noMatchRow } from "../../../src/modes/components/search-band";
import { getSelectListTheme, getSettingsListTheme, initTheme, theme } from "../../../src/modes/theme/theme";
import { OVERLAY_SPECS, type RenderableOverlay } from "./overlay-specs";

const caps: { trueColor: boolean } = TERMINAL;
let trueColorWas = false;
let policyWas: AnsiPolicy = "full";

beforeAll(async () => {
	await initTheme(false, "unicode", false, "titanium", "dark");
	// Every assertion here is about a PAINT, so the policy that decides whether
	// paint is emitted is part of the fixture: under the default the owner's row
	// and the hint row are the same bytes and the suite proves nothing.
	trueColorWas = caps.trueColor;
	policyWas = getAnsiPolicy();
	caps.trueColor = true;
	setAnsiPolicy("full");
});

afterAll(() => {
	caps.trueColor = trueColorWas;
	setAnsiPolicy(policyWas);
});

/** What a terminal shows: colour gone, and the caret marker it consumes gone too. */
function plain(line: string): string {
	return stripVTControlCharacters(line).replaceAll(CURSOR_MARKER, "");
}

/**
 * A sentence that reads as an empty state, found anywhere on a row: a card's row
 * arrives inside its frame, so the row an operator reads is never the whole
 * rendered line. `No` opens every one of them in this product; a surface that
 * says it another way is a wording change and belongs in the owner, which is
 * what makes this pattern the right net.
 */
const READS_AS_EMPTY = /\bNo [A-Za-z][^│]*/;

/**
 * Sentences that open with `No` and are NOT an empty row, by exact text. Each is
 * a value or a label a card renders, so it takes the paint of the thing it
 * belongs to. Pinned by equality below, so an excuse that stops applying is red.
 */
const NOT_AN_EMPTY_ROW: readonly string[] = [];

/** Characters no label in the product contains, typed to empty every list. */
const NOTHING_MATCHES = "zqxjv";

/**
 * The bytes the owner opens its row with: the paint, then the indent. A card
 * that reaches for a different grey, or drops the indent, does not contain them.
 */
function ownerRowPrefix(): string {
	return emptyRow("X").split("  X")[0] ?? "";
}

/**
 * The part of a clipped sentence that is still painted. A narrow card truncates
 * the row, and `truncateToWidth` closes the paint before it appends its ellipsis,
 * so the owner's bytes end one character short of what the terminal shows.
 */
function paintedPart(sentence: string): string {
	return sentence.replace(/…$/, "");
}

describe("a surface with nothing to show says so in one voice", () => {
	it("paints one weight at one indent", () => {
		expect(emptyRow("No matching providers")).toBe(theme.fg("muted", "  No matching providers"));
		expect(noMatchRow("providers")).toBe(emptyRow("No matching providers"));
		expect(plain(noMatchRow("directories"))).toBe("  No matching directories");
	});

	it("names the noun the surface filters rather than a generic miss", () => {
		expect(plain(noMatchRow("messages"))).toContain("No matching messages");
		expect(plain(noMatchRow("history"))).toContain("No matching history");
	});

	it("sweeps every card in the product: an empty row is the owner's row", async () => {
		const findings: string[] = [];
		const unconstructable: string[] = [];
		const seen: string[] = [];
		for (const spec of OVERLAY_SPECS) {
			let card: RenderableOverlay;
			try {
				card = await spec.create();
			} catch (err) {
				unconstructable.push(`${spec.name}: ${err}`);
				continue;
			}
			try {
				const typing = "handleInput" in card && typeof card.handleInput === "function";
				if (spec.reachKeys && typing) {
					for (const keys of spec.reachKeys) card.handleInput(keys);
				}
				if (typing) {
					for (const character of NOTHING_MATCHES) card.handleInput(character);
				}
				const prefix = ownerRowPrefix();
				for (const width of [80, 100, 140]) {
					for (const line of card.render(width)) {
						const match = plain(line).match(READS_AS_EMPTY);
						if (!match) continue;
						const sentence = match[0].trim();
						if (NOT_AN_EMPTY_ROW.includes(sentence)) continue;
						seen.push(`${spec.name}: ${sentence}`);
						if (!line.includes(`${prefix}  ${paintedPart(sentence)}`)) {
							findings.push(`${spec.name} at ${width}: hand-rolled empty row: ${JSON.stringify(sentence)}`);
						}
					}
				}
			} finally {
				if ("dispose" in card && typeof card.dispose === "function") card.dispose();
			}
		}
		expect(findings).toEqual([]);
		expect(unconstructable).toEqual([]);
		// Non-vacuity: an empty findings list means nothing unless the sweep
		// actually reached the state on several cards.
		expect(seen.length).toBeGreaterThan(2);
	});
});

/**
 * ARM 3. The seam, asserted at the two theme getters every list in this product
 * is built from.
 */
describe("a list with nothing left after the filter shows the same row", () => {
	const ITEMS = Array.from({ length: 12 }, (_, i) => ({ value: `v${i}`, label: `row ${i}`, description: "" }));
	const SETTINGS = Array.from({ length: 12 }, (_, i) => ({
		id: `s${i}`,
		label: `setting ${i}`,
		currentValue: "off",
		values: ["off", "on"],
	}));

	function emptyLine(frame: readonly string[]): string {
		return frame.find(line => READS_AS_EMPTY.test(plain(line).trim())) ?? "";
	}

	it("paints a select list's no-match row through the owner", () => {
		const list = new SelectList(ITEMS, 5, getSelectListTheme());
		list.render(60);
		for (const character of NOTHING_MATCHES) list.handleInput(character);

		const line = emptyLine(list.render(60));

		expect(plain(line).trim()).toBe("No matching items");
		expect(line.trim()).toBe(emptyRow("No matching items").trim());
	});

	it("paints a settings list's no-match row through the owner rather than as a hint", () => {
		const list = new SettingsList(
			SETTINGS,
			5,
			getSettingsListTheme(),
			() => {},
			() => {},
		);
		list.render(60);
		for (const character of NOTHING_MATCHES) list.handleInput(character);

		const line = emptyLine(list.render(60));

		expect(plain(line).trim()).toBe("No matching settings");
		expect(line.trim()).toBe(emptyRow("No matching settings").trim());
		// The hint weight is what this row used to take, and it is still the
		// weight of the row underneath it that says how to edit the search.
		expect(line.trim()).not.toBe(getSettingsListTheme().hint("  No matching settings").trim());
	});

	it("leaves the library's own row for a consumer that supplies neither painter", () => {
		const list = new SettingsList(
			SETTINGS,
			5,
			{ ...getSettingsListTheme(), emptyRow: undefined },
			() => {},
			() => {},
		);
		list.render(60);
		for (const character of NOTHING_MATCHES) list.handleInput(character);

		const line = emptyLine(list.render(60));

		expect(plain(line).trim()).toBe("No matching settings");
		expect(line.trim()).toBe(getSettingsListTheme().hint("  No matching settings").trim());
	});
});

/**
 * ARM 4. A picker whose search only opens once the list outgrows the viewport.
 * The sweep constructs it with the handful of options its spec passes, so typing
 * never reaches its filter and its empty row is unreachable there — the state
 * exists in the product the moment a caller hands it a long list.
 */
describe("a picker whose search opens on a long list says it in the same voice", () => {
	it("paints the owner's row once the filter empties the list", () => {
		const options = Array.from({ length: 20 }, (_, index) => `option ${index}`);
		const picker = new HookSelectorComponent(
			"Pick one",
			options,
			() => {},
			() => {},
		);
		// The gate reads the last render width, so the card has to have been drawn
		// once before typing counts as a search rather than as a shortcut.
		picker.render(80);
		for (const character of NOTHING_MATCHES) picker.handleInput(character);

		const frame = picker.render(80);
		const row = frame.find(line => plain(line).includes("No matching options"));

		expect(row).toBeDefined();
		// This card re-emits its body rows to pad them to the frame, so the owner's
		// indent arrives ahead of the paint rather than inside it. Both halves of
		// the row's contract survive that: the sentence sits at the body inset the
		// option rows use, and it carries the owner's grey.
		const inner = plain(row ?? "").split("│")[1] ?? "";
		expect(inner.startsWith(`${" ".repeat(CARD_BODY_COL_INSET)}${plain(noMatchRow("options"))}`)).toBe(true);
		expect(row ?? "").toContain(ownerRowPrefix());
	});
});
