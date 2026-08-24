/**
 * An OSC 66 span that the terminal aborts must measure as what the terminal draws.
 *
 * WHY THIS SUITE EXISTS. `visible-width-osc66-spans.test.ts` records that the
 * native oracle still charges raw escape bytes as cells on this class, and it
 * PASSES while that remains true. The compositor truncates and slices through
 * the native number. A span that a terminal draws as one cell (`a` after an
 * aborted OSC) but the native reports as many is clipped short. That is a
 * width-model defect, not an open footnote.
 *
 * Terminal rules pinned here, as cell counts, not as "native > JS":
 *   - ESC inside an OSC 66 payload aborts the OSC. What follows is ordinary
 *     output. `ESC]66;;ESC[31ma ST` therefore draws the `a` (SGR and ST
 *     occupy no cells): width 1.
 *   - An unterminated OSC 66 is still open at end of string: the terminal
 *     consumes the payload and draws nothing: width 0.
 *
 * Both oracles must answer those numbers. JS is already close; the native is
 * not. This file is supposed to fail until `crates/veyyon-text` treats ESC and
 * end-of-input as aborting the span.
 */
import { describe, expect, it } from "bun:test";
import { visibleWidth as nativeVisibleWidth } from "@veyyon/natives";
import { DEFAULT_TAB_WIDTH, visibleWidth } from "@veyyon/tui";

function expectTerminalWidth(text: string, cells: number): void {
	expect({ js: visibleWidth(text), native: nativeVisibleWidth(text, DEFAULT_TAB_WIDTH) }).toEqual({
		js: cells,
		native: cells,
	});
}

describe("OSC 66 that a terminal aborts measures as drawn cells", () => {
	it("an ESC inside the payload leaves the following graphic cell", () => {
		expectTerminalWidth("\x1b]66;;\x1b[31ma\x1b\\", 1);
	});

	it("an unterminated span draws nothing", () => {
		expectTerminalWidth("\x1b]66;s=2;Hi", 0);
		expectTerminalWidth("\x1b]66;;ab", 0);
	});
});
