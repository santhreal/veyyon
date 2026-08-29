// WHY THIS SUITE EXISTS (A-STRUCTURAL-RULE-PAINTED-IN-THE-BRAND-ACCENT).
//
// A card's chrome is the least informative thing on it, so it takes the quietest paint the terminal
// allows: a hairline a fixed step off the ground, owned by `cardOutlineColor()`. Six cards painted a
// rule in `theme.fg("borderAccent")` instead, which resolves to `ember` (#F0862E) in titanium — the
// loudest colour in the palette. The settings card drew a full-height orange line down its middle
// between the category column and the pane; the ask dialog put one between its list and its preview;
// the model hub's group separators, and the plan review card's region rule and column divider, were
// the same. The frame around all of them had already moved to the hairline, so the interior rules
// were the last accent-painted structure left, and they were louder than the frame they sat inside.
//
// THE CLASS, NOT THE INCIDENT. The rule is not "these six sites": it is that NO box-drawing glyph a
// card renders carries an accent foreground. That covers a rule a card grows later, a rule under a
// mode this suite does not enter, and a rule someone paints with `accent` or `link` rather than
// `borderAccent` — all three tokens resolve to a brand colour in some shipped theme, and all three
// are checked.
//
// The variant space is the shared overlay roster in `overlay-specs.ts`, which
// `a-card-first-frame-is-settled.test.ts` holds the roll-call for: a new card must be constructed
// there to satisfy that suite, and being there puts it into this sweep. Every card is rendered at
// three widths, because a card that hides its split at one width shows it at another, and at both
// colour depths, because the two scans catch different spellings of the same paint.
//
// SMUGGLING ATTEMPTS. A rule hand-written as a 24-bit ember escape instead of `theme.fg` was caught
// by the truecolor arm, where the token opens as those same bytes. A rule reached only through a
// pane a fresh card does not show was caught after the spec grew `reachKeys` (the model hub's roles
// separator). A card rendered only at one width was caught by the three-width sweep.
//
// WHAT IT DOES NOT CATCH. A rule painted as a BACKGROUND rather than a foreground: this walks
// foreground spans, and a card's fill is the sibling suite's contract, which asserts a card paints
// no cell of its own. A rule in a state no `reachKeys` reach is not rendered here, so the
// choke-point arm pins the paint owner itself: any rule that goes through `cardOutlineColor()` is
// covered wherever it is drawn, and only a NEW hand-rolled paint could reintroduce the defect out of
// reach. It also says nothing about content: a mock composer inside the theme scene reproduces the
// real composer's accented edge on purpose, and text painted in the accent (a title, a cursor, a
// label) is hierarchy, not chrome.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import type { AnsiPolicy } from "@veyyon/tui";
import { getAnsiPolicy, motionClock, setAnsiPolicy, TERMINAL } from "@veyyon/tui";
import { emberTick } from "../../../src/modes/components/composer-chrome";
import { cardOutlineColor } from "../../../src/modes/theme/card-outline";
import { initTheme } from "../../../src/modes/theme/theme";
import { theme } from "../../../src/modes/theme/theme-binding";
import { OVERLAY_SPECS, type RenderableOverlay } from "./overlay-specs";

/** Every token that resolves to a brand colour in a shipped theme. */
type BrandToken = "borderAccent" | "accent" | "link";
const BRAND_TOKENS: BrandToken[] = ["borderAccent", "accent", "link"];

/**
 * Every glyph a card draws structure with, not only the ones in use today: the sharp and rounded
 * sets, heavy, double, and the dashed and dotted runs. A rule someone draws in a variant the list
 * omitted is the same defect wearing a different codepoint.
 */
const BOX_GLYPHS = "─│┌┐└┘├┤┬┴┼╭╮╰╯━┃┏┓┗┛┣┫┳┻╋═║╔╗╚╝╠╣╦╩╬┄┅┆┇┈┉┊┋╌╍╎╏▁▔▏▕";

let previousPolicy: AnsiPolicy;

beforeAll(async () => {
	// Colour is off under a test runner, because stdout is not a terminal, and every paint would
	// then be the empty string and every comparison below trivially true.
	previousPolicy = getAnsiPolicy();
	setAnsiPolicy("full");
	await initTheme(false, "unicode", false, "titanium", "dark");
});

// Restored for the files that run after this one: a leaked policy or theme changes the bytes every
// other rendering suite reads, which is how two pointer-fade suites in this package went red on a
// change neither of them touched.
afterAll(async () => {
	setAnsiPolicy(previousPolicy);
	await initTheme(false);
});

afterEach(() => {
	motionClock.clear();
});

/** The SGR a token opens with, e.g. `\x1b[38;2;240;134;46m`. */
function openFor(token: BrandToken): string {
	const painted = theme.fg(token, "x");
	const end = painted.lastIndexOf("x");
	return painted.slice(0, end);
}

/**
 * Box-drawing glyphs a line paints while a brand foreground is open, walked the way a terminal walks
 * it. A substring search would report a false positive for a card whose rule sits on the same line
 * as an accented title, which is exactly the arrangement `topBorder` renders.
 */
function accentedRuleGlyphs(line: string, open: string): string {
	const sgr = /\x1b\[[0-9;:]*m/g;
	let index = 0;
	let openNow = false;
	let found = "";
	const scan = (text: string): void => {
		if (!openNow) return;
		for (const char of text) if (BOX_GLYPHS.includes(char)) found += char;
	};
	for (let match = sgr.exec(line); match !== null; match = sgr.exec(line)) {
		scan(line.slice(index, match.index));
		index = match.index + match[0].length;
		if (match[0] === open) openNow = true;
		else if (match[0] === "\x1b[39m" || match[0] === "\x1b[0m" || match[0] === "\x1b[m") openNow = false;
		else if (match[0].startsWith("\x1b[38;")) openNow = false;
	}
	scan(line.slice(index));
	return found;
}

/**
 * The one accent-painted rule that is not this defect: the horizon tick a card's title row carries
 * right after its corner, two cells of the website's progress-sun motif, shared with the composer.
 * Its bytes come from `emberTick` at the live truecolor flag, and only the FIRST occurrence in a row
 * is exempt — without truecolor the tick degrades to plain accent-painted rule, indistinguishable
 * from a rule someone paints beside it, so exempting every match would blind the arm to a second
 * one. A card row carries at most one tick, which the planted-tick arm pins.
 */
function withoutBrandTick(line: string): string {
	for (const cells of [3, 2]) {
		const tick = emberTick(TERMINAL.trueColor, cells);
		const at = line.indexOf(tick);
		if (at !== -1) return line.slice(0, at) + line.slice(at + tick.length);
	}
	return line;
}

describe("no rule inside a card is the accent colour", () => {
	/**
	 * The choke point. Every card that wants a rule asks this one function, so a rule drawn through
	 * it is covered wherever the card puts it — including states no sweep below reaches.
	 */
	it.each(BRAND_TOKENS)("gives the frame owner a paint that is not the %s token", (token: BrandToken) => {
		expect(cardOutlineColor()("─")).not.toBe(theme.fg(token, "─"));
		expect(accentedRuleGlyphs(cardOutlineColor()("─│┌┘"), openFor(token))).toBe("");
	});

	it("finds an accented rule when one is there, so the sweep below can fail", () => {
		const planted = `sidebar ${theme.fg("borderAccent", "│")} pane`;
		expect(accentedRuleGlyphs(planted, openFor("borderAccent"))).toBe("│");
		// An accented TITLE beside a hairline rule is not a finding: same line, different span.
		const titleRow = `${cardOutlineColor()("┌─")}${theme.fg("accent", " Settings ")}${cardOutlineColor()("─┐")}`;
		expect(accentedRuleGlyphs(titleRow, openFor("accent"))).toBe("");
	});

	it("exempts the title row's horizon tick, and nothing else on that row", () => {
		const tick = emberTick(TERMINAL.trueColor, 2);
		// Load-bearing: without truecolor the tick IS accent-painted rule, so an unexempted sweep
		// would report every card in the product and prove nothing.
		if (!TERMINAL.trueColor) expect(accentedRuleGlyphs(tick, openFor("accent"))).toBe("──");
		expect(accentedRuleGlyphs(withoutBrandTick(tick), openFor("accent"))).toBe("");
		const smuggled = `${cardOutlineColor()("┌")}${tick}${theme.fg("accent", "──")} Title `;
		expect(accentedRuleGlyphs(withoutBrandTick(smuggled), openFor("accent"))).toBe("──");
	});

	/**
	 * Both colour depths, because they are two different scans. At 256 colours a token opens as
	 * `38;5;N`, so a rule someone hand-writes as a 24-bit ember escape would slip past; at 24 bits the
	 * same token opens as `38;2;R;G;B` and that escape IS the token's bytes. Running the sweep twice
	 * costs one more render per card and closes the hand-written variant.
	 */
	it.each([false, true])("sweeps every overlay at three widths with trueColor=%s", async trueColor => {
		const caps: { trueColor: boolean } = TERMINAL;
		const trueColorWas = caps.trueColor;
		caps.trueColor = trueColor;
		const unconstructable: string[] = [];
		const findings: string[] = [];
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
					// A pane a fresh card does not show carries rules too, and the roles pane of the
					// model hub is where one of the six lived. The spec names the keys that reach it,
					// and a card that declares none is rendered as it opens.
					if (spec.reachKeys && "handleInput" in card && typeof card.handleInput === "function") {
						for (const keys of spec.reachKeys) card.handleInput(keys);
					}
					for (const width of [80, 100, 140]) {
						const lines = card.render(width).map(withoutBrandTick);
						for (const token of BRAND_TOKENS) {
							const open = openFor(token);
							for (const line of lines) {
								const glyphs = accentedRuleGlyphs(line, open);
								if (glyphs) findings.push(`${spec.name} at ${width}: ${token} paints ${glyphs}`);
							}
						}
					}
				} finally {
					if ("dispose" in card && typeof card.dispose === "function") card.dispose();
				}
			}
		} finally {
			caps.trueColor = trueColorWas;
		}

		expect(findings).toEqual([]);
		expect(unconstructable).toEqual([]);
	});
});
