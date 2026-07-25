import { describe, expect, it } from "bun:test";
import { visibleWidth } from "../src/utils";

/**
 * Width accounting for OSC 8 hyperlinks, the surface upstream #6282 was ported
 * onto (PR #201) with no test of any kind.
 *
 * An OSC 8 hyperlink wraps visible text in two escape sequences that occupy no
 * cells: `ESC ] 8 ; params ; uri ST` opens it, `ESC ] 8 ; ; ST` closes it. Only
 * the text between them is drawn. Getting this wrong is not cosmetic, because
 * `visibleWidth` is what table layout and wrapping measure with: a link counted
 * as wider than it draws leaves a column short and the border lands mid-cell,
 * and one counted as narrower overflows the row.
 *
 * The terminator is the interesting part. OSC sequences may end with either ST
 * (`ESC \`) or BEL (`\x07`), and the ST spelling is the one that regressed
 * upstream, so both are pinned here for every case. Every expectation is a
 * counted cell width, never a comparison against another call of the same
 * function, so a change in stripping cannot move the test and the code together.
 */

const ESC = "\x1b";
const ST = `${ESC}\\`;
const BEL = "\x07";

/** `ESC ] 8 ; ; <uri> <term> <text> ESC ] 8 ; ; <term>` — one hyperlink. */
const link = (text: string, uri: string, term: string) => `${ESC}]8;;${uri}${term}${text}${ESC}]8;;${term}`;

describe("visibleWidth: OSC 8 hyperlinks", () => {
	/**
	 * The base case the port was about. Only the label is drawn, so the URI, the
	 * introducer, and the terminator must all contribute zero cells. If the
	 * sequence is counted at all this returns something near 30 rather than 5.
	 */
	it("counts only the label of a hyperlink, not its URI or escapes", () => {
		expect(visibleWidth(link("click", "https://example.com", ST))).toBe(5);
		expect(visibleWidth(link("click", "https://example.com", BEL))).toBe(5);
	});

	/**
	 * The regression that motivates the whole suite. A hyperlink is normally not
	 * the last thing on a line, and an over-greedy strip that runs to the end of
	 * the string swallows the text after the link, which then measures as zero
	 * width. A table cell built that way silently loses everything after the
	 * link, so this asserts the trailing text is still counted.
	 */
	it("keeps counting text that follows a hyperlink", () => {
		for (const term of [ST, BEL]) {
			// "click" (5) + " after" (6)
			expect(visibleWidth(`${link("click", "https://example.com", term)} after`)).toBe(11);
		}
	});

	/** Text on both sides: "pre " (4) + "mid" (3) + " post" (5). */
	it("counts text on both sides of a hyperlink", () => {
		for (const term of [ST, BEL]) {
			expect(visibleWidth(`pre ${link("mid", "https://example.com", term)} post`)).toBe(12);
		}
	});

	/**
	 * Two links in one cell is where an over-greedy strip does the most damage:
	 * it consumes from the first introducer to the end, taking the second link's
	 * label and the separator with it. Counted cells here are "a" + " | " + "b".
	 */
	it("counts every label when one string holds several hyperlinks", () => {
		for (const term of [ST, BEL]) {
			const two = `${link("a", "https://x.test", term)} | ${link("b", "https://y.test", term)}`;
			expect(visibleWidth(two)).toBe(5);
		}
	});

	/** A hyperlink whose label is empty draws nothing at all. */
	it("returns zero for a hyperlink with no label", () => {
		expect(visibleWidth(link("", "https://example.com", ST))).toBe(0);
		expect(visibleWidth(link("", "https://example.com", BEL))).toBe(0);
	});

	/**
	 * Wide characters inside a link still occupy two cells each. This pins that
	 * the link handling defers to the UAX#11 width tables rather than counting
	 * code units, which is the difference between 4 and 2 for this label.
	 */
	it("gives full-width label characters two cells each", () => {
		expect(visibleWidth(link("日本", "https://example.com", ST))).toBe(4);
	});

	/**
	 * A URI containing a semicolon or a bracket must not be mistaken for the end
	 * of the sequence, or the tail of the URI is counted as visible text.
	 */
	it("does not count URI characters that look like sequence delimiters", () => {
		expect(visibleWidth(link("go", "https://x.test/a;b?c=d;e", ST))).toBe(2);
		expect(visibleWidth(link("go", "https://x.test/a]8;;b", ST))).toBe(2);
	});

	/**
	 * OSC 8 links appearing in a Markdown table row is the exact shape upstream
	 * #6282 reported: the row measures wider than it draws and every column
	 * boundary after the link shifts. Drawn cells are "| " (2) + "a" (1) +
	 * " | " (3) + "b" (1) + " |" (2).
	 */
	it("measures a table row containing a hyperlink by its drawn cells", () => {
		const row = `| ${link("a", "https://x.test", ST)} | b |`;
		expect(visibleWidth(row)).toBe(9);
	});
});
