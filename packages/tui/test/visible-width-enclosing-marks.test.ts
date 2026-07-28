/**
 * The two width oracles have to agree about enclosing marks, or truncation overflows.
 *
 * `truncateToWidth` cuts on the Rust native engine and `visibleWidth` measures with
 * `Bun.stringWidth`. When the two disagree, a span cut to fit W re-measures as more
 * than W, and the caller that sized a viewport by that cut writes past the last
 * column. Enclosing marks were 21 of the 28 measured divergences between the pair,
 * which made them the single largest class.
 *
 * `Me` (enclosing mark) is zero-width by Unicode: the glyph draws around its base
 * character and advances the cursor by nothing. Bun agrees for most of the category
 * and charges one cell for five Cyrillic numeral signs, so those five are corrected
 * by hand and the rest are deliberately left alone. The exclusions matter as much as
 * the inclusions and each one is pinned below.
 */

import { describe, expect, it } from "bun:test";
import { Ellipsis, truncateToWidth, visibleWidth } from "../src/utils";

/** The five Bun over-counts, each with the name that explains why they cluster. */
const OVERCOUNTED = [
	{ code: 0x0488, name: "U+0488 COMBINING CYRILLIC HUNDRED THOUSANDS SIGN" },
	{ code: 0x0489, name: "U+0489 COMBINING CYRILLIC MILLIONS SIGN" },
	{ code: 0xa670, name: "U+A670 COMBINING CYRILLIC TEN MILLIONS SIGN" },
	{ code: 0xa671, name: "U+A671 COMBINING CYRILLIC HUNDRED MILLIONS SIGN" },
	{ code: 0xa672, name: "U+A672 COMBINING CYRILLIC THOUSAND MILLIONS SIGN" },
] as const;

/** The `Me` code points Bun already scores as zero, kept here so a regression there is visible too. */
const ALREADY_ZERO = [
	{ code: 0x1abe, name: "U+1ABE COMBINING PARENTHESES OVERLAY" },
	{ code: 0x20dd, name: "U+20DD COMBINING ENCLOSING CIRCLE" },
	{ code: 0x20de, name: "U+20DE COMBINING ENCLOSING SQUARE" },
	{ code: 0x20df, name: "U+20DF COMBINING ENCLOSING DIAMOND" },
	{ code: 0x20e0, name: "U+20E0 COMBINING ENCLOSING CIRCLE BACKSLASH" },
	{ code: 0x20e2, name: "U+20E2 COMBINING ENCLOSING SCREEN" },
	{ code: 0x20e4, name: "U+20E4 COMBINING ENCLOSING UPWARD POINTING TRIANGLE" },
] as const;

describe("visibleWidth on enclosing marks", () => {
	/**
	 * The correction itself: each of the five adds nothing to the base character.
	 *
	 * Asserted against a concrete base rather than measured in isolation, because
	 * a bare combining mark is not what any caller renders and a correction that
	 * only worked on the isolated form would still overflow real text.
	 */
	for (const { code, name } of OVERCOUNTED) {
		it(`adds no cells for ${name}`, () => {
			const mark = String.fromCodePoint(code);
			expect(visibleWidth(`a${mark}`)).toBe(1);
			expect(visibleWidth(`aa${mark}bb`)).toBe(4);
			expect(visibleWidth(`一${mark}一`)).toBe(4);
		});
	}

	/**
	 * Repeats stack, because the correction is per-occurrence and not a flag.
	 *
	 * A single `test`-and-subtract-one would pass every case above and still be
	 * wrong the moment a string carried two marks, which is the ordinary shape for
	 * Cyrillic numerals (a hundred-thousands sign and a millions sign on one run).
	 */
	it("subtracts once per occurrence, not once per string", () => {
		expect(visibleWidth("a҈҉")).toBe(1);
		expect(visibleWidth("a҈b҉c꙰")).toBe(3);
		expect(visibleWidth(`x${"꙲".repeat(8)}`)).toBe(1);
	});

	/**
	 * The marks Bun already zeroes must not be corrected a second time.
	 *
	 * The bug this locks out is the tempting category-wide fix: matching all of
	 * `Me` and subtracting a cell each would drive `a` + U+20DD to zero, and a
	 * zero-width run makes a layout divide by its own width or loop forever
	 * advancing by nothing.
	 */
	for (const { code, name } of ALREADY_ZERO) {
		it(`leaves ${name} alone, which Bun already scores as zero`, () => {
			const mark = String.fromCodePoint(code);
			expect(visibleWidth(`a${mark}`)).toBe(1);
			expect(visibleWidth(`aa${mark}bb`)).toBe(4);
		});
	}

	/**
	 * U+20E3, the keycap combiner, is the one `Me` code point that is genuinely wide.
	 *
	 * `1️⃣` is digit + VS16 + U+20E3, and every terminal renders it as an emoji
	 * occupying two columns, which is what Bun reports. Zeroing it as part of the
	 * category would have narrowed every keycap in the UI by two columns while
	 * every test above still passed, so it gets its own guard.
	 */
	it("keeps keycap sequences two cells wide", () => {
		expect(visibleWidth("1️⃣")).toBe(2);
		expect(visibleWidth("#️⃣")).toBe(2);
		expect(visibleWidth("1️⃣ 2️⃣")).toBe(5);
	});
});

describe("visibleWidth on keycap combiners", () => {
	/**
	 * A keycap is base + U+FE0F + U+20E3, and only that shape is two cells wide.
	 *
	 * Bun widens the cluster for ANY U+20E3, so `a` + U+20E3 read as two cells and a
	 * lone U+20E3 read as two, where the native engine and every terminal say one and
	 * zero. Both spellings appear in text pasted from chat clients, which is where a
	 * width overrun in a message view comes from.
	 */
	it("charges nothing for a keycap combiner on a base that cannot take one", () => {
		expect(visibleWidth("a⃣")).toBe(1);
		expect(visibleWidth("a️⃣")).toBe(1);
		expect(visibleWidth("一⃣")).toBe(2);
		expect(visibleWidth("aa⃣bb")).toBe(4);
	});

	/**
	 * A combiner with no base at all contributes nothing rather than two cells.
	 *
	 * This is the shape a truncation produces on its own: cut a keycap sequence at the
	 * wrong offset and the tail begins with a bare U+20E3. Charging two for it made the
	 * remainder of a wrapped line measure wider than the line it came from.
	 */
	it("charges nothing for a combiner with no base", () => {
		expect(visibleWidth("⃣")).toBe(0);
		expect(visibleWidth("⃣⃣")).toBe(0);
	});

	/**
	 * The variation selector is REQUIRED, which is the part that is easy to get wrong.
	 *
	 * The native scores `1` + U+20E3 as one cell and `1` + U+FE0F + U+20E3 as two, and
	 * matching that exactly is the whole point: a correction that accepted a digit base
	 * without the selector would leave the two oracles disagreeing on the more common
	 * of the two spellings while every keycap test still passed.
	 */
	it("requires the variation selector before treating a digit as a keycap", () => {
		expect(visibleWidth("1⃣")).toBe(1);
		expect(visibleWidth("1️⃣")).toBe(2);
		expect(visibleWidth("#⃣")).toBe(1);
		expect(visibleWidth("#️⃣")).toBe(2);
		expect(visibleWidth("*️⃣")).toBe(2);
	});
});

describe("visibleWidth on repeated variation selectors", () => {
	/**
	 * One U+FE0F with nothing to modify measures zero; two in a row measured two.
	 *
	 * Degenerate input, and still a real width-bound violation, because a native cut
	 * scores the pair at zero and keeps it inside any width. Every selector after the
	 * first in a run is dropped, which no real emoji ever has.
	 */
	it("charges nothing for a selector run with no base", () => {
		expect(visibleWidth("️")).toBe(0);
		expect(visibleWidth("️️")).toBe(0);
		expect(visibleWidth("️️️️")).toBe(0);
	});

	/**
	 * And a selector that IS doing its job still widens its base.
	 *
	 * `❤` is one cell and `❤️` is two, which is the entire reason a variation selector
	 * cannot simply be stripped. The collapse only removes the duplicates.
	 */
	it("leaves an emoji-presentation selector alone", () => {
		expect(visibleWidth("❤")).toBe(1);
		expect(visibleWidth("❤️")).toBe(2);
		expect(visibleWidth("❤️️")).toBe(2);
		expect(visibleWidth("a️")).toBe(1);
		expect(visibleWidth("a️️")).toBe(1);
	});
});

describe("the correction sees the string the width came from", () => {
	/**
	 * A mark inside an OSC sequence was never counted, so nothing may be subtracted for it.
	 *
	 * The first version of this correction subtracted a fixed cell per match while
	 * scanning the ORIGINAL string, and `visibleWidth` strips OSC sequences before
	 * measuring. The width fuzzer shrank a counterexample to exactly this in one run,
	 * and the result was a NEGATIVE width, which the no-throw invariant rejects and
	 * which would have made any layout arithmetic downstream nonsense.
	 */
	it("returns zero, not a negative width, for a mark inside an unterminated OSC", () => {
		expect(visibleWidth("\x1b]҉")).toBe(0);
		expect(visibleWidth("\x1b]0;title҉\x07")).toBe(0);
		expect(visibleWidth("\x1b]8;;https://x\x07a҉\x1b]8;;\x07")).toBe(1);
	});

	/**
	 * An escape between a base and its marks breaks the cluster, and the width follows.
	 *
	 * The native engine treats an escape sequence as a grapheme break, so `9` + U+FE0F
	 * + U+20E3 is a keycap worth two cells and the same three characters with a colour
	 * code between the digit and the selector are a `9` followed by two marks with
	 * nothing to attach to, worth one. `Bun.stringWidth` deletes the escape and
	 * measures the two sides as a single cluster, so it answers two for both, and
	 * every wrapped line that styled a keycap mid-sequence came out a cell over.
	 */
	it("does not rejoin a cluster across a style code", () => {
		expect(visibleWidth("9️⃣")).toBe(2);
		expect(visibleWidth("9\x1b[0m️⃣")).toBe(1);
		expect(visibleWidth("9\x1b[31m\x1b[0m️⃣")).toBe(1);
		expect(visibleWidth("❤\x1b[0m️")).toBe(1);
		expect(visibleWidth("❤️\x1b[0m")).toBe(2);
	});

	/**
	 * A selector after a style code has no base, which is the reverse of the case above.
	 *
	 * Both come from the same rule and both were wrong in the same direction, so both
	 * are pinned: the correction has to see the escape, because the character in front
	 * of the selector in `"\x1b[0m️"` is the `m` that terminates the sequence, and
	 * reading that as a visible base skipped exactly the case Bun over-counts.
	 */
	it("treats a selector after a style code as having no base", () => {
		expect(visibleWidth("\x1b[0m️")).toBe(0);
		expect(visibleWidth("⃝\x1b[0m️")).toBe(0);
		expect(visibleWidth("⃝\x1b[0m️ 1️⃣")).toBe(3);
	});

	/**
	 * The same for the fast path, which measures the input string directly.
	 *
	 * `visibleWidth` takes a different branch for long escape-free text, so the
	 * correction has to be right on both. Padded past the fast-path threshold with
	 * plain ASCII so the branch is the one under test.
	 */
	it("corrects long escape-free text on the fast path", () => {
		const pad = "a".repeat(200);
		expect(visibleWidth(`${pad}҉`)).toBe(200);
		expect(visibleWidth(`${pad}b⃣`)).toBe(201);
		expect(visibleWidth(`${pad}1️⃣`)).toBe(202);
	});
});

describe("truncateToWidth stays within its bound on enclosing marks", () => {
	/**
	 * The property the correction exists for, checked end to end through both oracles.
	 *
	 * This is the failure that motivated the fix: the native cut believed the mark
	 * was zero-width and kept it, then `visibleWidth` charged a cell for it and the
	 * result measured wider than the width it was cut to. Every combination below
	 * was a real violation before the correction landed.
	 */
	const bodies = OVERCOUNTED.flatMap(({ code }) => {
		const mark = String.fromCodePoint(code);
		return [mark, `aa${mark}bb`, `${mark}${mark}`, `一${mark}一`];
	});

	for (const width of [1, 2, 3, 5, 8]) {
		it(`never re-measures wider than ${width} after cutting to ${width}`, () => {
			const violations = bodies
				.map(body => ({ body, measured: visibleWidth(truncateToWidth(body, width, Ellipsis.Omit)) }))
				.filter(row => row.measured > width);
			expect(violations).toEqual([]);
		});
	}

	/**
	 * And the guard on the guard: the bodies above genuinely contain the marks.
	 *
	 * A width-bound property is vacuously true against content that was never
	 * affected, so this pins that the corpus is the one the correction touches. If
	 * a future edit narrows the mark set, this fails rather than quietly leaving
	 * the property checking nothing.
	 */
	it("exercises strings the correction actually applies to", () => {
		expect(bodies.length).toBe(20);
		for (const body of bodies) {
			expect(/[҈҉꙰-꙲]/.test(body)).toBe(true);
		}
	});
});
