/**
 * All terminal modes enabled at startup are restored on teardown.
 *
 * WHY THIS SUITE EXISTS:
 * A TUI owns the terminal while it runs: bracketed paste, focus reporting, mouse
 * tracking, appearance notifications and synchronized output are all private
 * modes it turns on, and the hardware cursor stays hidden between paints. A mode
 * left on hands the host shell back broken — an invisible cursor, escape bytes
 * printed on every mouse move, typed text swallowed by a paste bracket that
 * never closes.
 *
 * WHAT IT DRIVES:
 * `ProcessTerminal`, the terminal the product runs on, captured at its only
 * external boundary: the bytes it writes to stdout. A virtual terminal cannot
 * stand in here. It is a grid that records what was painted into it, it emits no
 * mode sequences of its own, and a check pointed at one passes on an empty
 * string no matter what the real teardown does.
 *
 * Headless mode suppresses every terminal side effect under `bun test`, which is
 * what keeps escape bytes out of the developer's terminal. Each case turns it off
 * for the length of the case only, with stdout already captured, and restores the
 * previous value through a `finally`.
 *
 * WHAT IT DOES NOT CATCH:
 * The conditional resets — enhanced paste, in-band resize, Kitty keyboard,
 * modifyOtherKeys, the xterm scroll-to-bottom set — fire only when `start()`
 * armed them, and `start()` is not driven here because it takes raw mode on the
 * runner's own stdin. This covers what teardown owes unconditionally.
 */

import { describe, expect, it, spyOn } from "bun:test";
import { settleFrames, VirtualTerminal } from "@veyyon/render-oracle";
import { ProcessTerminal, STARTUP_PRIVATE_MODE_PROBES } from "@veyyon/tui/terminal";
import { type Component, TUI } from "@veyyon/tui/tui";
import { FOCUS_REPORTING_DISABLE } from "@veyyon/tui/window-focus";
import { setTerminalHeadless } from "@veyyon/utils/env";

class StaticTextComponent implements Component {
	constructor(private readonly text: string) {}

	invalidate(): void {}

	render(_width: number): readonly string[] {
		return [this.text];
	}
}

/**
 * Run `body` against a live `ProcessTerminal` and return everything it wrote.
 *
 * stdout is replaced before headless mode is lifted, so no escape byte reaches
 * the terminal running the suite, and `isTTY` is forced on because `#safeWrite`
 * drops control sequences when stdout is a pipe, which it is under a test runner.
 */
function captureTerminalWrites(body: (terminal: ProcessTerminal) => void): string {
	const chunks: string[] = [];
	const stdout = process.stdout as NodeJS.WriteStream;
	const priorIsTTY = stdout.isTTY;
	const writeSpy = spyOn(stdout, "write").mockImplementation((chunk: string | Uint8Array): boolean => {
		chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
		return true;
	});
	stdout.isTTY = true;
	// Constructed after the flip: `#headless` is read once per instance, so a
	// terminal built while headless is still on writes nothing however this is
	// driven afterwards.
	const priorHeadless = setTerminalHeadless(false);
	try {
		body(new ProcessTerminal());
	} finally {
		setTerminalHeadless(priorHeadless);
		stdout.isTTY = priorIsTTY;
		writeSpy.mockRestore();
	}
	return chunks.join("");
}

/** Every private mode the text turns off, as `CSI ? Ps l`. */
function disabledPrivateModes(written: string): Set<number> {
	const modes = new Set<number>();
	for (const match of written.matchAll(/\x1b\[\?(\d+)l/g)) modes.add(Number(match[1]));
	return modes;
}

describe("all startup terminal modes are restored on teardown", () => {
	it("turns off exactly the private modes teardown owns unconditionally", () => {
		const written = captureTerminalWrites(terminal => {
			terminal.stop();
		});

		// Pinned by exact equality rather than by count or by a subset check, so
		// adding a mode to teardown, or dropping one, fails here until the change
		// is recorded. 2026 synchronized output, 2004 bracketed paste, 1004 focus
		// reporting, 1000/1003/1006 mouse tracking, 2031 appearance notifications.
		expect(disabledPrivateModes(written)).toEqual(new Set([2026, 2004, 1004, 1006, 1003, 1000, 2031]));

		// Autowrap is restored rather than disabled, so it is asserted apart from
		// the disable set: a paint may clear it, and a shell that gets the terminal
		// back with autowrap off wraps nothing.
		expect(written).toContain("\x1b[?7h");
	});

	it("turns off every startup probe that teardown is responsible for", () => {
		// The probe list is read from the terminal module at run time. A mode added
		// to it is either disabled by teardown or named below as armed-only, and a
		// mode that is neither fails this case.
		const probed = new Set(STARTUP_PRIVATE_MODE_PROBES);
		expect(probed.size).toBeGreaterThan(0);

		const written = captureTerminalWrites(terminal => {
			terminal.stop();
		});
		const disabled = disabledPrivateModes(written);

		// Pinned by exact equality: a probe added to the list lands here until
		// someone decides whether teardown owes it a reset. 2048 in-band resize and
		// 5522 enhanced paste are reset only when `start()` armed them, because a
		// blind reset writes to terminals that never enabled the mode — kitty logs
		// a parse error for 5522. 1010 and 1011 are xterm scroll-to-bottom modes,
		// restored by setting them back on rather than off, so they never appear as
		// a disable at all.
		const armedOnly = [...probed].filter(mode => !disabled.has(mode));
		expect(armedOnly).toEqual([2048, 5522, 1010, 1011]);
	});

	it("hands back focus reporting so the next program is not sent focus events", () => {
		const written = captureTerminalWrites(terminal => {
			terminal.stop();
		});

		expect(written).toContain(FOCUS_REPORTING_DISABLE);
	});

	it("shows the hardware cursor again when the TUI stops", async () => {
		// The cursor is hidden between paints by the TUI, and the TUI is what shows
		// it again: `ProcessTerminal.stop()` deliberately leaves it alone, since the
		// terminal never hid it. Driving the layer that owns the state is what makes
		// this fail if the restore is dropped.
		// `showCursor` is the seam: a virtual terminal routes it straight into its
		// engine rather than through `write`, so the byte never appears in a write
		// log however the restore is performed. The subject here is `TUI.stop`, and
		// the terminal interface is the boundary it acts through.
		const terminal = new VirtualTerminal(80, 24);
		let cursorShown = 0;
		const showCursor = terminal.showCursor.bind(terminal);
		terminal.showCursor = () => {
			cursorShown++;
			showCursor();
		};

		const tui = new TUI(terminal);
		const component = new StaticTextComponent("Hello, world!");
		tui.addChild(component);
		tui.setFocus(component);
		tui.start();
		await settleFrames(terminal, tui);

		terminal.hideCursor();
		cursorShown = 0;
		tui.stop();

		expect(cursorShown).toBeGreaterThan(0);
	});

	it("finishes teardown instead of waiting on anything", () => {
		// A teardown that blocks is worse than one that leaks a mode: the process
		// never reaches its exit path, so nothing else is restored either. Asserting
		// it ends is what separates a hang from a wrong value.
		const start = performance.now();
		captureTerminalWrites(terminal => {
			terminal.stop();
		});
		expect(performance.now() - start).toBeLessThanOrEqual(500);
	});
});
