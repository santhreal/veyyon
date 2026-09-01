/**
 * Text a status row displays carries no escape sequence, no control character and no run of spaces.
 *
 * WHY THIS SUITE EXISTS. `@veyyon/utils/sanitize-status-text` is what stands between a
 * single-line status indicator and whatever a tool, a branch name or a model wrote. An escape
 * sequence there moves the cursor or repaints colour inside a row the renderer measured as plain
 * text, and a newline turns a one-line row into two. Nothing named the module: it was exercised only
 * through whichever status-row suite happened to render a string that needed cleaning, so the rules
 * it owns were asserted by coincidence.
 *
 * WHAT IT DOES NOT CATCH. Width. A sanitized string is still as long as it was, and truncation is
 * `truncateToWidth`'s subject.
 */
import { describe, expect, it } from "bun:test";
import { sanitizeStatusText } from "@veyyon/utils/sanitize-status-text";

describe("status text is reduced to one plain line", () => {
	it("strips a colour escape and keeps the text it wrapped", () => {
		expect(sanitizeStatusText("\u001b[31mfailed\u001b[0m")).toBe("failed");
	});

	it("strips an 8-bit CSI, which a 7-bit-only rule would leave in the row", () => {
		// `\u009b` is the one-byte CSI. A rule that only knew `ESC [` would publish `31mfailed`.
		expect(sanitizeStatusText("\u009b31mfailed")).toBe("failed");
	});

	it("strips a cursor move, which would reposition unrelated output", () => {
		// Not colour: `ESC [ 2 A` moves the cursor two rows up, so a row that kept it repaints
		// over whatever the renderer drew above.
		expect(sanitizeStatusText("a\u001b[2Ab")).toBe("ab");
	});

	it("turns a tab into a space rather than a variable-width hole", () => {
		// A tab measures one character and paints up to eight columns, so the differ accounts for
		// a row narrower than the one on screen.
		expect(sanitizeStatusText("name\tvalue")).toBe("name value");
	});

	it("answers with the empty string when nothing printable is left", () => {
		expect(sanitizeStatusText("\u001b[0m\n\t")).toBe("");
	});

	it("maps a C1 control that introduces nothing to a space", () => {
		// NEL is not an escape introducer, so the strip leaves it and the control-character rule owns
		// it. Left alone it moves the cursor to the next line inside a one-line row.
		expect(sanitizeStatusText("first\u0085second")).toBe("first second");
	});

	it("turns a newline into a space, so a row stays one row", () => {
		expect(sanitizeStatusText("first\nsecond")).toBe("first second");
	});

	it("maps a C0 control character to a space and collapses the run", () => {
		expect(sanitizeStatusText("a\u0000\u0001\u0007b")).toBe("a b");
	});

	it("collapses a run of spaces and trims the ends", () => {
		expect(sanitizeStatusText("  branch    name  ")).toBe("branch name");
	});

	it("leaves ordinary text, including non-ASCII, exactly as it is", () => {
		expect(sanitizeStatusText("feature/añadir-café")).toBe("feature/añadir-café");
	});
});
