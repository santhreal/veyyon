/**
 * The JS and Rust width oracles agree on Kitty OSC 66 text-sizing spans.
 *
 * WHY THIS SUITE EXISTS. Two independent implementations answer "how many columns
 * does this string draw": the Rust `visibleWidth`/`truncateToWidth` in
 * `crates/veyyon-text`, which every cut and slice goes through, and the JS
 * `visibleWidth` in `packages/tui/src/utils.ts`, which the compositor uses to pad
 * and to decide whether a line fits. When they disagree the native cuts a line to
 * W and the JS re-measures it at more than W, and the line overflows the terminal
 * by the difference. That is BUG-WIDTH-MODEL-DIVERGENCE, and OSC 66 was one of its
 * two open classes.
 *
 * The row's own description of the class was stale, which is why every case here
 * measures the native rather than quoting a number. It said the native "strips the
 * span to zero"; it does not, it has had full OSC 66 support with `s=` scaling and
 * an explicit `w=` for as long as the JS side has. Measured against the native
 * directly, thirteen of thirty span shapes disagreed, in three root causes:
 *
 *   1. TABS INSIDE ANY OSC. The JS counted tabs over the RAW string and measured
 *      width over the string with OSC sequences REMOVED, so a tab inside a
 *      hyperlink's URL, or inside a window-title OSC, was charged a full tab stop
 *      for text the terminal never draws. This is the live half: veyyon emits OSC 8
 *      hyperlinks on real output, and nothing stops a URL or a title from carrying
 *      a tab.
 *   2. TABS INSIDE AN OSC 66 PAYLOAD were charged once, unscaled, by that same
 *      outer pass, while the native scales everything in the span. `s=3` with two
 *      tabs measured 6 here against 18 natively.
 *   3. `Number.parseInt` ON THE METADATA. It takes a numeric prefix, a leading
 *      sign, and leading whitespace, so `s=2x`, `w=+5` and `w= 5` all parsed as
 *      numbers here and as malformed on the native side. This one over-measures,
 *      which is the direction that overflows: the native leaves a line whole
 *      because it measured 2, and the compositor then pads it as if it were 5.
 *
 * WHAT IS STILL OPEN, deliberately, and asserted as open at the bottom of this
 * file: an ESCAPE inside an OSC 66 payload. There the native over-counts, charging
 * the escape bytes as cells, and the JS is closer to what a terminal draws (an ESC
 * aborts an OSC payload, so the terminal renders the rest as ordinary output). It
 * cannot overflow, since the JS number is the smaller one, and fixing it means
 * changing the Rust side. It is pinned here so the day the native changes, this
 * file says so rather than silently passing.
 */

import { describe, expect, it } from "bun:test";
import { visibleWidth as nativeVisibleWidth } from "@veyyon/natives";
import { DEFAULT_TAB_WIDTH, Ellipsis, truncateToWidth, visibleWidth } from "@veyyon/tui";

/** Both oracles' answer for one string, so a case cannot assert only one of them. */
function widths(text: string): { js: number; native: number } {
	return { js: visibleWidth(text), native: nativeVisibleWidth(text, DEFAULT_TAB_WIDTH) };
}

/** Assert the two oracles agree, and that they agree ON the expected number. */
function expectWidth(text: string, expected: number): void {
	const { js, native } = widths(text);
	expect({ js, native }).toEqual({ js: expected, native: expected });
}

describe("an OSC 66 span measures the same in both width oracles", () => {
	/**
	 * The baseline the rest of the suite is a deviation from: a scaled span is its
	 * payload width times the scale. Present so a change that broke ordinary OSC 66
	 * measurement while fixing an edge case fails here first.
	 */
	it("charges a scaled span its payload width times the scale", () => {
		expectWidth("\x1b]66;s=2;Hi\x1b\\", 4);
		expectWidth("\x1b]66;s=2;Hi\x07", 4);
		expectWidth("\x1b]66;;ab\x1b\\", 2);
	});

	/**
	 * An explicit `w=` replaces the payload's measured width and is itself scaled,
	 * which is the protocol's rule and the native's. Pinned because the JS reads
	 * `w=` and `s=` in one loop, so a fix to one has broken the other before.
	 */
	it("uses an explicit w= in place of the payload width, still scaled", () => {
		expectWidth("\x1b]66;w=5;Hi\x07", 5);
		expectWidth("\x1b]66;s=3:w=4;X\x1b\\", 12);
	});

	/**
	 * A wide payload is measured at its cell width, not its length, before scaling.
	 * The two oracles reach that number through completely different width tables
	 * (`Bun.stringWidth` here, the Rust UAX#11 tables there), so this is the case
	 * that proves the agreement is real rather than both sides counting characters.
	 */
	it("measures a wide payload in cells before scaling it", () => {
		expectWidth("\x1b]66;s=2;一\x1b\\", 4);
		expectWidth("\x1b]66;;一一\x1b\\", 4);
	});
});

describe("a tab is charged to the text that actually draws it", () => {
	/**
	 * ROOT CAUSE 1, and the live one. The tab is inside a hyperlink's URL. The
	 * terminal draws the label and nothing else, so the tab draws no cells. Before
	 * the fix the JS counted every tab in the raw string, including this one, and
	 * reported the line three cells wider than it is.
	 */
	it("does not charge a tab inside an OSC 8 hyperlink target", () => {
		expectWidth("\x1b]8;;http://a\tb\x1b\\label\x1b]8;;\x1b\\", 5);
	});

	/**
	 * The same defect through a window-title OSC, which draws nothing at all. The
	 * whole string is zero cells, and the old code called it a tab stop wide.
	 */
	it("does not charge a tab inside a window-title OSC", () => {
		expectWidth("\x1b]0;ti\ttle\x07", 0);
	});

	/**
	 * The positive twin, without which the fix above could have been "stop counting
	 * tabs" and every one of these cases would still pass. A tab in ordinary text
	 * is still a tab stop wide, and so is a tab that merely sits NEXT to an OSC.
	 */
	it("still charges a tab that is not inside an OSC", () => {
		expectWidth("a\t", 1 + DEFAULT_TAB_WIDTH);
		expectWidth("a\t\x1b]66;s=2;b\x1b\\", 1 + DEFAULT_TAB_WIDTH + 2);
		expectWidth("\x1b]0;title\x07a\tb", 2 + DEFAULT_TAB_WIDTH);
	});

	/**
	 * ROOT CAUSE 2. A tab inside a scaled span scales with the span, like every
	 * other cell in it. The outer pass charged it once at one tab stop no matter
	 * the scale, so this case was short by `(scale - 1)` stops per tab.
	 */
	it("scales a tab inside an OSC 66 payload with the span", () => {
		expectWidth("\x1b]66;;a\t\x1b\\", 1 + DEFAULT_TAB_WIDTH);
		expectWidth("\x1b]66;s=2;a\t\x1b\\", 2 * (1 + DEFAULT_TAB_WIDTH));
		expectWidth("\x1b]66;s=3;\t\t\x1b\\", 3 * 2 * DEFAULT_TAB_WIDTH);
	});

	/**
	 * An explicit `w=` is the whole span's width, so the payload's tabs are not
	 * counted on top of it. Written as its own case because the fix adds the tab
	 * width to the MEASURED payload, and adding it to the explicit one instead
	 * would pass every case above.
	 */
	it("ignores a payload tab when the span declares its own width", () => {
		expectWidth("\x1b]66;w=4;a\t\x1b\\", 4);
		expectWidth("\x1b]66;s=2:w=4;a\t\x1b\\", 8);
	});
});

describe("OSC 66 metadata is a run of digits or it is not a number", () => {
	/**
	 * ROOT CAUSE 3, in the direction that overflows a terminal. `Number.parseInt`
	 * accepts a leading `+`, so this span claimed five columns here and measured
	 * two natively. The native therefore left a five-column line whole inside a
	 * four-column budget, and the compositor padded to five.
	 */
	it("rejects a signed value", () => {
		expectWidth("\x1b]66;w=+5;Hi\x1b\\", 2);
		expectWidth("\x1b]66;s=+2;Hi\x1b\\", 2);
	});

	/**
	 * `Number.parseInt` also stops at the first non-digit and keeps the prefix, so
	 * `s=2x` scaled by two. The native reads the value as a whole or not at all.
	 */
	it("rejects a value with trailing junk", () => {
		expectWidth("\x1b]66;s=2x;Hi\x1b\\", 2);
		expectWidth("\x1b]66;w=2abc;Hi\x1b\\", 2);
		expectWidth("\x1b]66;w=0x5;Hi\x1b\\", 2);
	});

	/**
	 * And it skips leading whitespace. This is the one that reads most like a
	 * typo a real emitter would make rather than an attack.
	 */
	it("rejects a value with leading whitespace", () => {
		expectWidth("\x1b]66;w= 5;Hi\x1b\\", 2);
	});

	/**
	 * The cases both implementations already agreed on, kept so a stricter parse
	 * cannot start rejecting the values that ARE numbers. `w=0` is absent by rule
	 * (a zero-width span is not a declaration), an out-of-range scale falls back to
	 * one, and an empty value is not a number.
	 */
	it("keeps rejecting the values that were already rejected", () => {
		expectWidth("\x1b]66;w=0;Hi\x1b\\", 2);
		expectWidth("\x1b]66;w=;Hi\x1b\\", 2);
		expectWidth("\x1b]66;s=9;Hi\x1b\\", 2);
		expectWidth("\x1b]66;s=0;Hi\x1b\\", 2);
	});

	/**
	 * The non-vacuity twin for the whole describe: the same shapes with valid
	 * values must still be read. Without this, "reject everything" passes every
	 * other case in this block.
	 */
	it("still reads a plain digit run", () => {
		expectWidth("\x1b]66;w=5;Hi\x1b\\", 5);
		expectWidth("\x1b]66;s=7;Hi\x1b\\", 14);
		expectWidth("\x1b]66;s=1;Hi\x1b\\", 2);
	});

	/**
	 * A `w=` of forty digits. The native accumulates in a saturating `usize` and its
	 * binding clamps the answer to `u32`, so the JS stops climbing at the same
	 * ceiling. Before the fix this produced a float no native answer could match.
	 */
	it("clamps an absurd width to the ceiling the native clamps to", () => {
		const digits = "9".repeat(40);
		const { js, native } = widths(`\x1b]66;w=${digits};Hi\x1b\\`);
		expect(js).toBe(0xffff_ffff);
		expect(native).toBe(js);
	});
});

describe("stripping an OSC does not change the text around it", () => {
	/**
	 * The shrunk counterexample from width fuzz seed 0x1234, first form. The two
	 * patterns that decide what an OSC sequence IS disagreed: the stripper's payload
	 * class stops at an escape, and the OSC 66 pattern's metadata group used to
	 * accept one. So `\x1b]66;\x1b\\` was stripped as an empty OSC and then a
	 * DIFFERENT, longer span starting at the same place was added back on top of the
	 * text the stripper had left visible, and the line measured two cells wider than
	 * the terminal drew it.
	 */
	it("does not add back a span the stripper read as a shorter sequence", () => {
		expectWidth("\x1b]66;\x1b\\=+5;Hi\x1b\\m]m", 9);
	});

	/**
	 * The same seed's second form, and a different root cause: deleting a stripped
	 * sequence JOINS the text on either side of it. Here a `9`, a span, and a bare
	 * keycap combiner become a real keycap once the span between them is gone, and a
	 * one-cell string measured two. The native treats an escape as a grapheme break,
	 * so it never saw the cluster. The stripper leaves an `ESC \` behind now.
	 */
	it("does not let a deleted span join a digit to a keycap combiner", () => {
		expectWidth("9\x1b]66;;i\x1b\\️⃣", 2);
		// The twin that proves the number above is the JOIN and not the keycap: with
		// nothing between them the same three code points ARE a keycap, two cells.
		expectWidth("9️⃣", 2);
		// And with an OSC between them the digit stands alone and the combiner draws
		// nothing, which is one cell for the digit and one for the payload's `i`.
	});

	/**
	 * The same join through the other keycap bases and through a non-66 OSC, so the
	 * fix cannot be read as being about OSC 66 or about the digit `9`. Each of these
	 * is a keycap the moment the sequence between the base and the selector is
	 * deleted, and one cell as long as it is not.
	 */
	it("does not let any OSC be deleted out from between a base and its selector", () => {
		expectWidth("#\x1b]0;t\x07️⃣", 1);
		expectWidth("*\x1b]8;;u\x1b\\️⃣", 1);
		expectWidth("#️⃣", 2); // the twin: adjacent, it really is a keycap
	});
});

describe("the width bound holds over OSC 66 content", () => {
	/**
	 * The contract the whole row exists for, stated directly: a string the native
	 * cut to W never re-measures wider than W here. Every fix above was found by
	 * this property failing over a pool that contained OSC 66 spans, and the pool
	 * below is the one that failed.
	 */
	it("never re-measures a native truncation wider than its target", () => {
		const fragments = [
			"a",
			"一",
			"\t",
			"\x1b[31m",
			"\x1b]66;s=2;Hi\x1b\\",
			"\x1b]66;w=5;Hi\x07",
			"\x1b]66;s=3:w=4;X\x1b\\",
			"\x1b]66;s=2;a\t\x1b\\",
			"\x1b]66;w=+5;Hi\x1b\\",
			"\x1b]66;s=2x;Hi\x1b\\",
			"\x1b]0;ti\ttle\x07",
			"\x1b]8;;http://a\tb\x1b\\label\x1b]8;;\x1b\\",
		];
		let seed = 0x9e37_79b9;
		const rand = () => ((seed = (seed * 1_664_525 + 1_013_904_223) >>> 0) / 0x1_0000_0000);
		const overflows: string[] = [];
		for (let n = 0; n < 20_000; n++) {
			let text = "";
			const parts = Math.floor(rand() * 6);
			for (let p = 0; p < parts; p++) text += fragments[Math.floor(rand() * fragments.length)];
			const target = Math.floor(rand() * 24);
			const cut = truncateToWidth(text, target, Ellipsis.Omit);
			const measured = visibleWidth(cut);
			if (measured > target) {
				overflows.push(`${JSON.stringify(text)} @${target} -> ${measured} ${JSON.stringify(cut)}`);
			}
		}
		expect(overflows).toEqual([]);
	});

	/**
	 * The guard on the guard. A `truncateToWidth` that returned the empty string
	 * for everything would satisfy the bound above, so pin that it actually cuts
	 * where there is room to cut and keeps what fits.
	 */
	it("still returns the content that fits", () => {
		expect(truncateToWidth("abcdef", 3, Ellipsis.Omit)).toBe("abc");
		expect(truncateToWidth("\x1b]66;s=2;Hi\x1b\\", 10, Ellipsis.Omit)).toBe("\x1b]66;s=2;Hi\x1b\\");
		// Three, not four: after the leading `a` the span advances two cells per
		// payload character, so four is not a reachable column and the cut lands one
		// short of the budget rather than one over it. That asymmetry is the whole
		// reason a scaled span needs its own truncation path.
		expect(visibleWidth(truncateToWidth("a\x1b]66;s=2;Hi\x1b\\b", 4, Ellipsis.Omit))).toBe(3);
	});
});

/** The malformed spans on which the two oracles still differ. See the describe below. */
const MALFORMED_SPANS = [
	"\x1b]66;;\x1b[31ma\x1b\\",
	"\x1b]66;;\x1b[31m\x1b\\",
	"\x1b]66;;a\x1bZb\x1b\\",
	"\x1b]66;s=2;\x1b[31ma\x07",
	"\x1b]66;s=2;Hi",
	"\x1b]66;;ab",
];

describe("the malformed-span class is still the native's to fix", () => {
	/**
	 * The one remaining disagreement, asserted as a disagreement so it is recorded
	 * rather than forgotten. Two shapes reach it. An ESC inside an OSC 66 payload is
	 * malformed: a real terminal aborts the OSC at the escape and renders what
	 * follows as ordinary output, one cell for the `a`. An UNTERMINATED span is
	 * malformed the other way: the terminal keeps consuming bytes looking for a
	 * terminator and draws nothing at all. In both the JS gives the number a
	 * terminal would draw and the native charges the raw bytes as cells.
	 *
	 * It stays open because it is the SAFE direction. The native's number is the
	 * larger one, so it cuts earlier than it needs to and nothing overflows; the
	 * cost is a span clipped short, not a broken line. Closing it means changing
	 * `crates/veyyon-text` to treat an escape and an end-of-input as aborting the
	 * span, and shipping a rebuilt native. When that lands this test fails, which is
	 * the point: the fix has to come here and delete this block, it cannot land and
	 * leave the class undocumented.
	 */
	it("has the native charging bytes as cells where the JS does not", () => {
		for (const text of MALFORMED_SPANS) {
			const { js, native } = widths(text);
			expect({ text, wider: native > js }).toEqual({ text, wider: true });
		}
	});

	/**
	 * And the direction is what makes it safe, stated as its own assertion so a
	 * future change that flips it (JS wider than native) fails here instead of
	 * silently reintroducing overflow. This is the assertion that would have caught
	 * the `w=+5` bug on its own.
	 */
	it("never has the JS wider than the native on that class", () => {
		for (const text of MALFORMED_SPANS) {
			const { js, native } = widths(text);
			expect(js).toBeLessThanOrEqual(native);
		}
	});
});
