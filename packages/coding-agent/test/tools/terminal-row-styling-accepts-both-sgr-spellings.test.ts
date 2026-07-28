/**
 * A colour written with colons is the same colour, and the row must keep it.
 *
 * `styleTerminalRow` replays a virtual terminal's row into the TUI, keeping only the styles
 * that are safe to re-emit: colours and the plain attributes, never cursor moves or anything
 * that could move the caret out of the block. It reads each SGR sequence, validates the
 * parameter list, and passes the original bytes through when the list is safe.
 *
 * Truecolor has two spellings. `ESC [ 38;2;r;g;b m` is the common one and `ESC [ 38:2:r:g:b m`
 * is the other, emitted by libvte and by several test runners, and both mean the same colour.
 * Two separate defects meant the colon form never survived: the module's own SGR pattern
 * spelled its parameter class `[0-9;]`, so a colon sequence did not match at all and its bytes
 * fell through to the text sanitizer, and the parameter split was on `;` alone, so once the
 * pattern was fixed the whole `38:2:255:0:0` read as one non-numeric token and the validator
 * rejected a colour it fully understands. Either way the output came back unstyled.
 *
 * The pattern now comes from `@veyyon/tui/ansi`, which owns it, and the split accepts both
 * separators.
 */

import { describe, expect, it } from "bun:test";
import { styleTerminalRow } from "@veyyon/coding-agent/tools/terminal-output";

/** The colour the TUI applies underneath whatever the row asks for. */
const BASE = "\x1b[38;5;250m";
const RESET = "\x1b[0m";

describe("styleTerminalRow keeps truecolor in either spelling", () => {
	/**
	 * The semicolon form, which always worked. Kept so a regression here is not hidden by the
	 * colon cases passing.
	 */
	it("replays a semicolon truecolor sequence verbatim", () => {
		const row = "\x1b[38;2;255;0;0mred\x1b[0m";
		expect(styleTerminalRow(row, BASE)).toBe(`${BASE}\x1b[38;2;255;0;0mred${RESET}${BASE}${RESET}`);
	});

	/**
	 * The colon form, which is the defect. The bytes are replayed exactly as written, not
	 * rewritten into the semicolon form, because the terminal that receives them accepts both
	 * and rewriting would be a second place that has to know the encoding.
	 */
	it("replays a colon truecolor sequence verbatim", () => {
		const row = "\x1b[38:2:255:0:0mred\x1b[0m";
		expect(styleTerminalRow(row, BASE)).toBe(`${BASE}\x1b[38:2:255:0:0mred${RESET}${BASE}${RESET}`);
	});

	/**
	 * The 256-colour form in both spellings, which takes a different branch of the validator
	 * (one parameter after the mode rather than three).
	 */
	it("replays a 256-colour sequence in either spelling", () => {
		expect(styleTerminalRow("\x1b[38;5;196mx", BASE)).toBe(`${BASE}\x1b[38;5;196mx${RESET}`);
		expect(styleTerminalRow("\x1b[38:5:196mx", BASE)).toBe(`${BASE}\x1b[38:5:196mx${RESET}`);
	});

	/**
	 * And the text is still the text.
	 *
	 * The failure this rules out is a pattern loose enough to swallow the row's content along
	 * with its escapes, which would leave every assertion above green against empty output.
	 */
	it("keeps the row's visible characters", () => {
		expect(styleTerminalRow("\x1b[38:2:0:255:0mhello world", BASE)).toContain("hello world");
		expect(styleTerminalRow("plain", BASE)).toBe(`${BASE}plain${RESET}`);
	});
});

describe("styleTerminalRow still refuses what it always refused", () => {
	/**
	 * A widened parameter class must not widen what counts as SAFE.
	 *
	 * The colon change is about spelling, not about policy: an out-of-range channel is still
	 * rejected whichever separator it is written with, and the sequence is dropped rather than
	 * replayed. Without this, "accept colons" could quietly become "accept anything with
	 * colons in it".
	 */
	it("drops an out-of-range truecolor channel in either spelling", () => {
		expect(styleTerminalRow("\x1b[38;2;300;0;0mx", BASE)).toBe(`${BASE}x${RESET}`);
		expect(styleTerminalRow("\x1b[38:2:300:0:0mx", BASE)).toBe(`${BASE}x${RESET}`);
	});

	/**
	 * And a sequence that is not an SGR at all is not a colour.
	 *
	 * `ESC [ 2J` clears the screen and `ESC [ H` homes the cursor. Neither ends in `m`, so
	 * neither is matched as a style, and both must be gone from the output rather than
	 * replayed into the transcript where they would erase the surrounding render.
	 */
	it("does not replay a non-SGR control sequence", () => {
		const styled = styleTerminalRow("\x1b[2J\x1b[Hafter", BASE);
		expect(styled).not.toContain("\x1b[2J");
		expect(styled).not.toContain("\x1b[H");
		expect(styled).toContain("after");
	});
});
