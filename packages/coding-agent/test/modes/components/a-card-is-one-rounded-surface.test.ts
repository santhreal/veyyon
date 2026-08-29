// WHY THIS SUITE EXISTS (A-CARD-DRAWN-AS-A-STACK-OF-BOXES).
//
// A floating card is one surface. Three details said otherwise, and all three were shape rather
// than colour, so the sibling suites — which own a card's paint and its fill — could not see any of
// them.
//
// 1. SQUARE CORNERS. `theme.boxRound` existed and had zero consumers: every card drew `boxSharp`,
//    and two modules decided its corners independently (`overlay-box.ts` for the borders and rows,
//    `modal-shell.ts` for the title row), so a card's top-left and bottom-left corners were separate
//    decisions that happened to agree.
// 2. WELDED SECTION RULES. A section rule was `├────┤`, tees driven into both verticals. On a card
//    with three or four bands the frame stopped being one edge: each band read as its own container
//    stacked inside a box.
// 3. A LITERAL `[x]`. The close affordance was three cells of brackets-and-letter on a hairline
//    frame — the one thing on a card drawn in a grammar nothing else uses, and a literal cannot
//    follow the symbol preset, so an ASCII terminal and a Nerd Font terminal got the same bytes.
//
// THE CLASS, NOT THE INCIDENT. The contracts are: a card's shape has ONE owner and every corner of
// every card comes from it; NO chrome row of a card welds a frame tee, into either of its own
// verticals or into its own inset rule; and the close affordance is ONE preset-resolved glyph with a
// rule cell each side, which is exactly what the width arithmetic reserves for it. Corners and welds
// are swept over the shared overlay roster in
// `overlay-specs.ts`, so a new card is covered the day it is constructed there, and the glyph
// contracts are swept over `SYMBOL_PRESETS` at run time, so a new preset fails until it declares the
// glyph.
//
// WHAT IT DOES NOT CATCH. Nothing about paint (the joinery suite owns which colour a rule carries)
// and nothing about fill (the first-frame suite owns that a card paints no cell of its own). A card
// that draws a box in its BODY as content — the theme scene's mock composer, a tree's connectors — is
// not a finding here: the claims below are anchored to the card's own two border columns, which is
// the only place a weld can happen. A state no `reachKeys` reach is not rendered, so the shape claim
// is also asserted against the owner itself, where every card's corners come from.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { AnsiPolicy } from "@veyyon/tui";
import { getAnsiPolicy, setAnsiPolicy, visibleWidth } from "@veyyon/tui";
import { MODAL_SIZING_MEDIUM, modalWidthForTitle, renderModalShell } from "../../../src/modes/components/modal-shell";
import * as overlayBox from "../../../src/modes/components/overlay-box";
import { bottomBorder, cardBox, divider, row, topBorder } from "../../../src/modes/components/overlay-box";
import { SYMBOL_PRESETS, type SymbolPreset } from "../../../src/modes/theme/symbols";
import { initTheme } from "../../../src/modes/theme/theme";
import { theme } from "../../../src/modes/theme/theme-binding";
import { OVERLAY_SPECS, type RenderableOverlay } from "./overlay-specs";

/** Junctions that weld a rule into a border. A card's own two columns never carry one. */
const WELDS = "├┤┬┴┼╠╣╦╩╬┝┥┰┸┿";

const WIDTHS = [80, 100, 140] as const;
const AREA_HEIGHT = 40;

let previousPolicy: AnsiPolicy;

beforeAll(async () => {
	previousPolicy = getAnsiPolicy();
	setAnsiPolicy("full");
	await initTheme(false, "unicode", false, "titanium", "dark");
});

afterAll(async () => {
	setAnsiPolicy(previousPolicy);
	await initTheme(false);
});

/** A rendered frame with every SGR removed, so a column index means a screen cell. */
function plainFrame(card: RenderableOverlay, width: number): string[] {
	return card.render(width).map(line => stripVTControlCharacters(line));
}

/**
 * The card's own rectangle inside a full-screen frame: the two border rows and the two border
 * columns. Found by the CORNERS the shape owner names, so the finder cannot disagree with the
 * renderer about what a card looks like.
 */
interface CardRect {
	top: number;
	bottom: number;
	left: number;
	right: number;
}

function cardRect(frame: readonly string[]): CardRect | undefined {
	const box = cardBox(theme);
	const top = frame.findIndex(line => line.includes(box.topLeft) && line.includes(box.topRight));
	if (top === -1) return undefined;
	const left = frame[top]!.indexOf(box.topLeft);
	const right = frame[top]!.lastIndexOf(box.topRight);
	const bottom = frame.findIndex((line, row) => row > top && line[left] === box.bottomLeft);
	if (bottom === -1 || right <= left) return undefined;
	return { top, bottom, left, right };
}

/** A titled card with a close chip, rendered through the shipped shell. */
function shellWithClose(title: string, width: number) {
	return renderModalShell({
		title,
		sizing: MODAL_SIZING_MEDIUM,
		areaWidth: width,
		areaHeight: AREA_HEIGHT,
		body: ["one", "two"],
		showClose: true,
	});
}

/**
 * The same card forced to an exact width, so an arithmetic claim is measured at the width it names
 * rather than at whatever share of the terminal the sizing ratio happens to take.
 */
function shellAtExactly(title: string, width: number) {
	return renderModalShell({
		title,
		sizing: { ...MODAL_SIZING_MEDIUM, minWidth: width, maxWidth: width, widthPct: 1 },
		areaWidth: width,
		areaHeight: AREA_HEIGHT,
		body: ["one", "two"],
		showClose: true,
	});
}

describe("a card is one rounded surface", () => {
	/**
	 * The choke point for shape. Every border, row and title row asks this one function, so a card
	 * reached by no sweep below still draws the corners asserted here.
	 */
	it("gives a card's shape one owner, and it is the rounded box", () => {
		expect(cardBox(theme)).toEqual(theme.boxRound);
		expect(cardBox(theme).topLeft).not.toBe(theme.boxSharp.topLeft);
		expect(cardBox(theme).bottomRight).not.toBe(theme.boxSharp.bottomRight);
	});

	/**
	 * The finder has to be able to fail: a frame drawn with square corners must not resolve to a
	 * card rect, or the sweep below would pass on a frame it never located.
	 */
	it("locates no card in a square-cornered frame", () => {
		const sharp = theme.boxSharp;
		const square = [
			`  ${sharp.topLeft}${sharp.horizontal.repeat(6)}${sharp.topRight}  `,
			`  ${sharp.vertical} body ${sharp.vertical}  `,
			`  ${sharp.bottomLeft}${sharp.horizontal.repeat(6)}${sharp.bottomRight}  `,
		];
		expect(cardRect(square)).toBeUndefined();
	});

	/**
	 * The card's own columns carry its verticals and nothing else. A welded rule is the one way a
	 * junction reaches them, so this is the inset-rule contract stated where it can be measured.
	 */
	it("finds a weld when one is there, so the sweep below can fail", () => {
		const box = cardBox(theme);
		const welded = [
			`${box.topLeft}${box.horizontal.repeat(6)}${box.topRight}`,
			`${box.teeRight}${box.horizontal.repeat(6)}${box.teeLeft}`,
			`${box.bottomLeft}${box.horizontal.repeat(6)}${box.bottomRight}`,
		];
		const rect = cardRect(welded)!;
		expect(rect).toBeDefined();
		expect(WELDS).toContain(welded[1]![rect.left]!);
	});

	/**
	 * Every card, at three widths. A card whose sections collapse at one width shows them at
	 * another, and the settings and ask cards only draw their column divider once they are wide
	 * enough for two panes.
	 *
	 * One member of the roster draws no frame at all: the OAuth provider list is an in-flow list,
	 * not a floating card. It is pinned by name rather than skipped by a guess, so a card that STOPS
	 * drawing its frame joins it and fails, and a list that starts drawing one is swept.
	 */
	it("draws every overlay as one rounded frame with nothing welded into it", async () => {
		const unconstructable: string[] = [];
		const findings: string[] = [];
		const frameless: string[] = [];
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
				for (const width of WIDTHS) {
					const frame = plainFrame(card, width);
					const rect = cardRect(frame);
					if (!rect) {
						if (!frameless.includes(spec.name)) frameless.push(spec.name);
						continue;
					}
					const box = cardBox(theme);
					const bottomRow = frame[rect.bottom]!;
					if (bottomRow[rect.right] !== box.bottomRight) {
						findings.push(`${spec.name} at ${width}: bottom-right is ${bottomRow[rect.right]}`);
					}
					for (let row = rect.top + 1; row < rect.bottom; row++) {
						const line = frame[row]!;
						for (const [edge, col] of [
							["left", rect.left],
							["right", rect.right],
						] as const) {
							const glyph = line[col] ?? "";
							if (WELDS.includes(glyph)) {
								findings.push(`${spec.name} at ${width}: row ${row} welds ${glyph} into its ${edge} border`);
							}
						}
						// A rule can also be inset by a cell and then welded to ITSELF (`│├───┤│`), which
						// reads as a nested box on the card exactly the way the old welded rule did. The
						// card's own columns are clean in that spelling, so a chrome row is judged on its
						// interior too: the column joins (`┬`/`┴`) close a sidebar and stay, the frame tees
						// never belong on a card at all. Only chrome rows are judged, so a box drawn in a
						// card's BODY as content is not a finding.
						const interior = line.slice(rect.left + 1, rect.right);
						const isChromeRow = !/[0-9A-Za-z]/.test(interior) && interior.includes(box.horizontal.repeat(3));
						if (isChromeRow) {
							for (const tee of [box.teeRight, box.teeLeft]) {
								if (interior.includes(tee)) {
									findings.push(`${spec.name} at ${width}: row ${row} welds ${tee} into its own rule`);
								}
							}
						}
					}
				}
			} finally {
				if ("dispose" in card && typeof card.dispose === "function") card.dispose();
			}
		}

		expect(findings).toEqual([]);
		expect(frameless).toEqual(["OAuthSelectorComponent"]);
		expect(unconstructable).toEqual([]);
	});

	/**
	 * The builders themselves, enumerated from the module at run time. A card the roster does not
	 * reach — the `/advisor` detail screens, the debug log and SSE viewers, any shell rendered
	 * without a close chip — still draws through these, and a builder that looked up its own corners
	 * instead of asking the owner was the original defect. The arg table is checked against the
	 * module's exports, so a new builder fails here until it is given a call and a claim.
	 */
	it("takes every chrome builder's corners from the shape owner", () => {
		const box = cardBox(theme);
		const sharp = theme.boxSharp;
		const calls: Record<string, { line: string; left: string; right: string } | null> = {
			cardBox: null,
			fit: null,
			// A strip of readings draws no frame, so it has no corners to take from the
			// shape owner. Recorded rather than omitted: the set equality below is what
			// makes a new export fail until someone decides.
			statStrip: null,
			topBorder: { line: topBorder(80, "Title", theme), left: box.topLeft, right: box.topRight },
			bottomBorder: { line: bottomBorder(80, theme), left: box.bottomLeft, right: box.bottomRight },
			divider: { line: divider(80, theme), left: box.vertical, right: box.vertical },
			row: { line: row("body", 80, theme), left: box.vertical, right: box.vertical },
		};

		// Fail by default on a new export rather than silently leaving it unswept.
		expect(Object.keys(calls).sort()).toEqual(Object.keys(overlayBox).sort());

		const cornersDiffer = box.topLeft !== sharp.topLeft;
		for (const call of Object.values(calls)) {
			if (!call) continue;
			const plain = stripVTControlCharacters(call.line);
			expect(visibleWidth(plain)).toBe(80);
			expect(plain[0]).toBe(call.left);
			expect(plain[plain.length - 1]).toBe(call.right);
			if (cornersDiffer) {
				for (const corner of [sharp.topLeft, sharp.topRight, sharp.bottomLeft, sharp.bottomRight]) {
					expect(plain).not.toContain(corner);
				}
			}
		}
	});

	/**
	 * A card with no close affordance goes down the other title-row branch, which is the branch that
	 * calls {@link topBorder}. Both branches draw the same card, so their corners are the same cells.
	 */
	it("draws the same rounded corners with and without a close chip", () => {
		const box = cardBox(theme);
		const withChip = shellWithClose("Accounts", 120);
		const plain = renderModalShell({
			title: "Accounts",
			sizing: MODAL_SIZING_MEDIUM,
			areaWidth: 120,
			areaHeight: AREA_HEIGHT,
			body: ["one", "two"],
			showClose: false,
		});
		for (const { lines, geometry } of [withChip, plain]) {
			const titleRow = stripVTControlCharacters(lines[geometry!.titleRow]!);
			const bottomRow = stripVTControlCharacters(lines[geometry!.cardRowEnd - 1]!);
			expect(titleRow[geometry!.cardColStart]).toBe(box.topLeft);
			expect(titleRow[geometry!.cardColEnd - 1]).toBe(box.topRight);
			expect(bottomRow[geometry!.cardColStart]).toBe(box.bottomLeft);
			expect(bottomRow[geometry!.cardColEnd - 1]).toBe(box.bottomRight);
		}
		expect(stripVTControlCharacters(plain.lines[plain.geometry!.titleRow]!)).not.toContain(theme.nav.close);
	});

	/**
	 * The close chip is a glyph on the rule, not a glyph in a hole. The cells used to be literal
	 * spaces, which left two unpainted gaps in the top border with the corner stranded past them.
	 */
	it("sets the close glyph on the rule, with the frame running through both sides of it", () => {
		const box = cardBox(theme);
		const { lines, geometry } = shellWithClose("Accounts", 120);
		expect(geometry).not.toBeNull();
		const titleRow = stripVTControlCharacters(lines[geometry!.titleRow]!);
		const glyph = theme.nav.close;

		expect(geometry!.closeColEnd - geometry!.closeColStart).toBe(visibleWidth(glyph) + 2);
		expect(titleRow[geometry!.closeColStart]).toBe(box.horizontal);
		expect(titleRow.slice(geometry!.closeColStart + 1, geometry!.closeColEnd - 1)).toBe(glyph);
		expect(titleRow[geometry!.closeColEnd - 1]).toBe(box.horizontal);
		expect(titleRow).not.toContain("[x]");
	});

	/**
	 * The width the title arithmetic advertises is the width that shows the title. Its terms are the
	 * borders, the padding, the leading decoration and the close chip; dropping or mis-sizing the
	 * chip term truncates a title at the width a caller was told is enough, which is how a card ends
	 * up with an ellipsis it never asked for.
	 */
	it("reserves exactly the chip's cells in the width a full title needs", () => {
		const title = "A Reasonably Long Card Title";
		const needed = modalWidthForTitle(visibleWidth(title));

		const fits = shellAtExactly(title, needed);
		expect(stripVTControlCharacters(fits.lines[fits.geometry!.titleRow]!)).toContain(title);

		// One cell narrower and the title is the thing that gives, so the assertion above is
		// load-bearing rather than trivially true of any width a card happens to take.
		const tight = shellAtExactly(title, needed - 1);
		const tightRow = stripVTControlCharacters(tight.lines[tight.geometry!.titleRow]!);
		expect(tightRow).not.toContain(title);
		expect(tightRow).toContain("…");
	});

	/**
	 * Every preset, enumerated at run time. A preset that declares no close glyph, or declares one
	 * the width arithmetic cannot measure, fails here rather than shipping a card whose chip is a
	 * cell wider than its hit box.
	 */
	it.each(Object.keys(SYMBOL_PRESETS) as SymbolPreset[])(
		"resolves the close chip under the %s preset",
		async preset => {
			await initTheme(false, preset, false, "titanium", "dark");
			try {
				const box = cardBox(theme);
				const glyph = theme.nav.close;
				expect(glyph.length).toBeGreaterThan(0);
				expect(glyph).not.toBe("[x]");

				const { lines, geometry } = shellWithClose("Accounts", 120);
				const titleRow = stripVTControlCharacters(lines[geometry!.titleRow]!);
				expect(geometry!.closeColEnd - geometry!.closeColStart).toBe(visibleWidth(glyph) + 2);
				expect(titleRow.slice(geometry!.closeColStart + 1, geometry!.closeColEnd - 1)).toBe(glyph);
				// The corners come from the same preset, so an ASCII terminal gets ASCII chrome around an
				// ASCII glyph rather than a mix of the two.
				expect(titleRow[geometry!.cardColStart]).toBe(box.topLeft);
				const bottomRow = stripVTControlCharacters(lines[geometry!.cardRowEnd - 1]!);
				expect(bottomRow[geometry!.cardColStart]).toBe(box.bottomLeft);
				expect(bottomRow[geometry!.cardColEnd - 1]).toBe(box.bottomRight);
			} finally {
				await initTheme(false, "unicode", false, "titanium", "dark");
			}
		},
	);
});
