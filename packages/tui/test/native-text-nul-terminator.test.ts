/**
 * No string returned by the native text layer may carry a NUL terminator.
 *
 * WHAT THE BOUNDARY IS. The text primitives (`wrapTextWithAnsi`,
 * `truncateToWidth`, `sliceWithWidth`, `extractSegments`) are thin wrappers over
 * a Rust addon that speaks UTF-16. Node hands the addon a NUL-terminated buffer
 * and the addon hands back a vector that Node turns into a string using its full
 * length, so anything left in that vector is a character you can see.
 *
 * THE BUG THIS LOCKS OUT. The outbound wrapper appended a NUL, on the belief
 * that the string type wanted a terminated buffer. It does not. Every returned
 * string then ended in `\u0000`:
 *
 *   truncateToWidth("hello world", 5, "")   ->  "hello\u0000"   (want "hello")
 *   wrapTextWithAnsi("First\r\nSecond", 40) ->  ["First\u0000", "Second\u0000"]
 *
 * A NUL occupies no cell, so it survived every width assertion and every visual
 * check while corrupting exact-string comparisons everywhere downstream: about
 * 149 cases across this package failed at once, and the renderer's
 * viewport-fidelity oracle failed on the first frame it drew, because the frame
 * row held a character the terminal had already dropped.
 *
 * WHY IT IS TESTED AS A CLASS. The two cases above are witnesses, not the
 * contract. Any entry point that returns text can regrow the terminator on its
 * own, so every one of them is asserted here, with exact expected values rather
 * than a width check: a width check is what let this ship.
 */

import { describe, expect, it } from "bun:test";
import {
	Ellipsis,
	extractSegments,
	sliceWithWidth,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@veyyon/tui";

/** Code points of `s` in hex, so a failure names the offending unit instead of printing an invisible one. */
const codePoints = (s: string): string[] => Array.from(s).map(c => c.codePointAt(0)!.toString(16));

/** Assert `s` is exactly `expected`, reporting code points when it is not. */
const exactly = (s: string, expected: string, what: string): void => {
	expect(`${what}: ${codePoints(s).join(" ")}`).toBe(`${what}: ${codePoints(expected).join(" ")}`);
	expect(s).toBe(expected);
};

describe("native text layer does not leak its NUL terminator", () => {
	describe("truncateToWidth", () => {
		/**
		 * The reduced witness. Five cells of budget must produce five code units,
		 * and the sixth was the terminator masquerading as content.
		 */
		it("returns exactly the cells that fit, with nothing appended", () => {
			exactly(truncateToWidth("hello world", 5, Ellipsis.Omit), "hello", "truncated");
		});

		/**
		 * Truncation that does not truncate takes a different path (the input is
		 * returned rather than rebuilt), so it needs its own case: a terminator
		 * added on only one of the two paths is worse than one added on both,
		 * because half the callers keep working and hide it.
		 */
		it("returns the input untouched when it already fits", () => {
			exactly(truncateToWidth("hi", 40, Ellipsis.Omit), "hi", "untruncated");
		});

		/** With an ellipsis the tail is rebuilt, which is where an append would land. */
		it("ends with the ellipsis and not with a terminator", () => {
			const out = truncateToWidth("hello world", 6, Ellipsis.Unicode);
			exactly(out, "hello…", "ellipsized");
			expect(out.endsWith("…")).toBe(true);
		});

		/** The ASCII ellipsis is a separate branch with its own tail write. */
		it("ends with the ASCII ellipsis and not with a terminator", () => {
			exactly(truncateToWidth("hello world", 8, Ellipsis.Ascii), "hello...", "ascii-ellipsized");
		});

		/**
		 * Padding appends spaces after the content, so a terminator buried before
		 * them cannot be found by looking at the last character. This is the case
		 * the original code comments called out as unreachable by a trailing pop.
		 */
		it("pads with spaces only, burying no terminator mid-string", () => {
			exactly(truncateToWidth("hi", 5, Ellipsis.Omit, true), "hi   ", "padded");
		});

		/** A zero budget must produce the empty string, not a lone terminator. */
		it("returns the empty string for a zero budget", () => {
			exactly(truncateToWidth("hello", 0, Ellipsis.Omit), "", "empty");
		});
	});

	describe("wrapTextWithAnsi", () => {
		/**
		 * The second witness. Both rows carried a terminator, which is why the
		 * failure looked like a stray trailing space on every wrapped line.
		 */
		it("returns clean rows across a CRLF break", () => {
			const rows = wrapTextWithAnsi("First\r\nSecond", 40);
			expect(rows.length).toBe(2);
			exactly(rows[0]!, "First", "row 0");
			exactly(rows[1]!, "Second", "row 1");
		});

		/** A single unwrapped row is the most common call and still gets its own case. */
		it("returns a single row unchanged", () => {
			const rows = wrapTextWithAnsi("First", 40);
			expect(rows.length).toBe(1);
			exactly(rows[0]!, "First", "row 0");
		});

		/**
		 * Real wrapping (a break the wrapper chooses, not one the input dictates)
		 * builds each row from scratch, so it is the path most likely to regrow a
		 * terminator per row.
		 *
		 * `charlie` is seven cells against a six-cell width, so it also takes the
		 * hard-break path that splits a single word, which assembles its rows
		 * differently again. Both kinds of break appear in one fixture on purpose.
		 */
		it("returns clean rows when it chooses the breaks itself", () => {
			const rows = wrapTextWithAnsi("alpha bravo charlie", 6);
			expect(rows).toEqual(["alpha", "bravo", "charli", "e"]);
			for (const [index, row] of rows.entries()) {
				expect(`row ${index} has no NUL: ${row.includes("\u0000")}`).toBe(`row ${index} has no NUL: false`);
			}
		});

		/** ANSI carry rewrites the row prefix, another independent build path. */
		it("returns clean rows when SGR state carries across a break", () => {
			const rows = wrapTextWithAnsi("\x1b[31malpha bravo\x1b[0m", 5);
			for (const row of rows) {
				expect(row.includes("\u0000")).toBe(false);
			}
			expect(rows.map(visibleWidth)).toEqual([5, 5]);
		});
	});

	describe("sliceWithWidth", () => {
		/** The slice result carries its own string field, built by the same wrapper. */
		it("returns the selected columns with nothing appended", () => {
			const slice = sliceWithWidth("hello world", 0, 5);
			exactly(slice.text, "hello", "slice");
			expect(slice.width).toBe(5);
		});

		/** A slice starting mid-string is a different code path to a slice from zero. */
		it("returns an interior run with nothing appended", () => {
			const slice = sliceWithWidth("hello world", 6, 5);
			exactly(slice.text, "world", "slice");
			expect(slice.width).toBe(5);
		});

		/** An empty selection must be the empty string, not a lone terminator. */
		it("returns the empty string for a zero-length selection", () => {
			exactly(sliceWithWidth("hello", 0, 0).text, "", "slice");
		});
	});

	describe("extractSegments", () => {
		/**
		 * Two strings come back from one call, and each is built by the wrapper
		 * separately, so a terminator can appear on one and not the other.
		 */
		it("returns both segments with nothing appended", () => {
			const segments = extractSegments("hello world", 5, 6, 5, false);
			exactly(segments.before, "hello", "before");
			exactly(segments.after, "world", "after");
			expect(segments.beforeWidth).toBe(5);
			expect(segments.afterWidth).toBe(5);
		});

		/** An empty `before` is the boundary case for the segment built first. */
		it("returns an empty before segment as the empty string", () => {
			const segments = extractSegments("hello", 0, 0, 5, false);
			exactly(segments.before, "", "before");
		});

		/** And an empty `after` for the one built second. */
		it("returns an empty after segment as the empty string", () => {
			const segments = extractSegments("hello", 5, 5, 0, false);
			exactly(segments.after, "", "after");
		});
	});

	describe("the terminator never round-trips", () => {
		/**
		 * Feeding a result straight back in is what turned one stray unit into a
		 * growing tail: the old outbound wrapper appended unconditionally, so each
		 * trip added another. Two trips must give the same answer as one.
		 */
		it("survives repeated passes through the layer unchanged", () => {
			let text = truncateToWidth("hello world", 5, Ellipsis.Omit);
			for (let pass = 0; pass < 4; pass++) {
				text = truncateToWidth(text, 5, Ellipsis.Omit);
				exactly(text, "hello", `after pass ${pass + 1}`);
			}
		});

		/**
		 * A NUL the CALLER wrote is content and must survive, which is the
		 * opposite failure and the reason the rule trims only the tail. Stripping
		 * every NUL would silently shorten a string someone deliberately built.
		 */
		it("keeps an interior NUL the caller supplied", () => {
			const slice = sliceWithWidth("a\u0000b", 0, 3);
			expect(codePoints(slice.text)).toEqual(["61", "0", "62"]);
		});
	});
});
