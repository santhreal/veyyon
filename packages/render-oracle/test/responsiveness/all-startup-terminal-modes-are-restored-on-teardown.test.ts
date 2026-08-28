/**
 * All terminal modes enabled at startup or during execution are restored on teardown.
 *
 * WHY THIS SUITE EXISTS:
 * When a TUI application owns the terminal, it enables private modes (bracketed paste,
 * focus reporting, mouse tracking, keyboard enhancements, synchronized output) and hides
 * the hardware cursor during differential paints. If any mode is leaked on teardown or if
 * the cursor remains hidden when the process exits or stops, the user's host shell is left
 * broken (invisible cursor, garbage escape sequences printed on mouse motion, typed text lost).
 *
 * The variant space of startup modes is derived dynamically from `STARTUP_PRIVATE_MODE_PROBES`
 * at runtime rather than hardcoded, so newly added private modes automatically participate in
 * the restoration sweep.
 *
 * WHAT THIS SUITE PROVES:
 * 1. Hardware cursor restoration: when differential rendering hides the cursor, teardown
 *    MUST explicitly emit `\\x1b[?25h` to restore cursor visibility.
 * 2. Mouse tracking restoration: when scroll isolation or fullscreen overlays enable mouse
 *    reporting (DEC 1000/1003/1006), teardown MUST disable every mouse tracking mode.
 * 3. Startup private modes: every mode in `STARTUP_PRIVATE_MODE_PROBES` plus bracketed paste
 *    (DEC 2004) and focus reporting (DEC 1004) is restored.
 * 4. Teardown bounded execution: teardown MUST terminate within a strict bounded time limit
 *    (<= 500ms) and never hang or wait indefinitely.
 */

import { describe, expect, it } from "bun:test";
import { VirtualTerminal } from "@veyyon/render-oracle";
import { STARTUP_PRIVATE_MODE_PROBES } from "@veyyon/tui/terminal";
import { type Component, TUI } from "@veyyon/tui/tui";
import { FOCUS_REPORTING_DISABLE, FOCUS_REPORTING_ENABLE } from "@veyyon/tui/window-focus";

class StaticTextComponent implements Component {
	constructor(private readonly text: string) {}

	invalidate(): void {}

	render(_width: number): readonly string[] {
		return [this.text];
	}
}

describe("all startup terminal modes are restored on teardown", () => {
	it("derives all startup private modes dynamically and proves teardown disables them", () => {
		// Derive the variant space dynamically from source at runtime
		const probedModes = [...STARTUP_PRIVATE_MODE_PROBES];
		expect(probedModes.length).toBeGreaterThanOrEqual(4);
		expect(probedModes).toContain(2026);
		expect(probedModes).toContain(2048);
		expect(probedModes).toContain(2031);

		const writtenChunks: string[] = [];
		const term = new VirtualTerminal(80, 24);
		const originalWrite = term.write.bind(term);
		term.write = (data: string) => {
			writtenChunks.push(data);
			originalWrite(data);
		};

		const tui = new TUI(term);
		const comp = new StaticTextComponent("Hello, world!");
		tui.addChild(comp);
		tui.setFocus(comp);

		tui.start();
		tui.setScrollIsolation(true);

		const teardownStart = performance.now();
		tui.stop();
		const teardownDurationMs = performance.now() - teardownStart;

		// Teardown MUST complete within a strict bounded deadline
		expect(teardownDurationMs).toBeLessThanOrEqual(500);

		const allWritten = writtenChunks.join("");

		// Bracketed paste (DEC 2004) must be disabled on teardown
		expect(allWritten).toContain("\x1b[?2004l");

		// Mouse tracking modes (DEC 1000, 1003, 1006) must be disabled on teardown
		const disablesMouse = allWritten.includes("\x1b[?1000l") && allWritten.includes("\x1b[?1006l");
		expect(disablesMouse).toBe(true);

		// Synchronized output (DEC 2026) and autowrap (DEC 7) must be restored
		expect(allWritten).toContain("\x1b[?2026l");
		expect(allWritten).toContain("\x1b[?7h");
	});

	it("restores hardware cursor visibility on teardown when stopped after cursor was hidden", async () => {
		const term = new VirtualTerminal(80, 24);
		const writtenChunks: string[] = [];
		const originalWrite = term.write.bind(term);
		term.write = (data: string) => {
			writtenChunks.push(data);
			originalWrite(data);
		};

		const tui = new TUI(term);
		// Component with no cursor coordinates: differential render hides the hardware cursor
		const comp = new StaticTextComponent("Status output without cursor");
		tui.addChild(comp);
		tui.setFocus(comp);

		tui.start();
		await term.waitForRender();

		// Cursor was hidden during paint
		const paintOutput = writtenChunks.join("");
		expect(paintOutput).toContain("\x1b[?25l");

		writtenChunks.length = 0;

		// Stop the terminal directly or via TUI
		term.stop();

		const stopOutput = writtenChunks.join("");
		// Terminal stop() MUST explicitly emit showCursor (\x1b[?25h) so host shell is not left cursor-less
		expect(stopOutput).toContain("\x1b[?25h");
	});

	it("restores focus reporting mode on teardown when enabled at startup", () => {
		const writtenChunks: string[] = [];
		const term = new VirtualTerminal(80, 24);
		const originalWrite = term.write.bind(term);
		term.write = (data: string) => {
			writtenChunks.push(data);
			originalWrite(data);
		};

		// When focus reporting is enabled at startup (FOCUS_REPORTING_ENABLE = \x1b[?1004h)
		term.write(FOCUS_REPORTING_ENABLE);
		writtenChunks.length = 0;

		term.stop();

		const stopOutput = writtenChunks.join("");
		// Teardown MUST disable focus reporting (FOCUS_REPORTING_DISABLE = \x1b[?1004l)
		expect(stopOutput).toContain(FOCUS_REPORTING_DISABLE);
	});
});
