// WHY: the status row is one line of a live TUI frame. Text reaching it comes from tool output,
// model text and error messages, so it carries colour, cursor moves, tabs and newlines. Any one of
// those escaping into the row corrupts the frame around it: a newline pushes the rest of the card
// down, a cursor move repositions unrelated output, a tab opens a hole the differ cannot account
// for. The class this closes is "a control sequence reaches the status row", across the 7-bit and
// 8-bit escape forms, C0 and C1 controls, and the whitespace they leave behind.
//
// It also pins the one-owner claim: the leaf exists so the launch card can reach it without paying
// for `modes/shared.ts`, which re-exports it for everyone else.
//
// Not covered: display width. Sanitizing is not truncation, so a long line is still long here, and
// a wide grapheme still measures wide. `TRUNCATE_LENGTHS` and the width measurement own that.

import { describe, expect, it } from "bun:test";
import { sanitizeStatusText } from "../../src/modes/sanitize-status-text";
import { sanitizeStatusText as reExported } from "../../src/modes/shared";

describe("a status string survives as one printable line", () => {
	it("strips a 7-bit colour sequence and keeps the text", () => {
		expect(sanitizeStatusText("\u001b[31mfailed\u001b[0m")).toBe("failed");
	});

	it("strips an 8-bit CSI introducer", () => {
		// C1 0x9b is the single-byte form of `ESC [`; a stripper that only knows ESC leaves the
		// parameters behind as visible junk.
		expect(sanitizeStatusText("\u009b31mfailed\u009b0m")).toBe("failed");
	});

	it("strips a cursor move, which would reposition unrelated output", () => {
		expect(sanitizeStatusText("a\u001b[2Ab")).toBe("ab");
	});

	it("turns every newline into a space so the row stays one line", () => {
		expect(sanitizeStatusText("first\nsecond\r\nthird")).toBe("first second third");
	});

	it("turns a tab into a space rather than a variable-width hole", () => {
		expect(sanitizeStatusText("name\tvalue")).toBe("name value");
	});

	it("maps a lone C1 control to a space", () => {
		expect(sanitizeStatusText("a\u0085b")).toBe("a b");
	});

	it("collapses the run of spaces a stripped sequence leaves behind", () => {
		expect(sanitizeStatusText("a\n\n\n\tb")).toBe("a b");
	});

	it("trims the edges, including whitespace that was a control character", () => {
		expect(sanitizeStatusText("\n  spaced  \t")).toBe("spaced");
	});

	it("returns an empty string when nothing printable is left", () => {
		expect(sanitizeStatusText("\u001b[0m\n\t")).toBe("");
	});

	it("leaves ordinary text untouched", () => {
		expect(sanitizeStatusText("reading src/app.ts")).toBe("reading src/app.ts");
	});

	it("keeps a single interior space and non-ascii text", () => {
		// Collapsing must not eat the space that separates two words, and must not touch a
		// multi-byte character on its way past.
		expect(sanitizeStatusText("récupéré 12 fichiers")).toBe("récupéré 12 fichiers");
	});

	it("is the same binding modes/shared re-exports", () => {
		expect(reExported).toBe(sanitizeStatusText);
	});
});
