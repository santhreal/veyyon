/**
 * WHY:
 * Session startup runs for over a second, and `paintFirstFrame` puts a
 * `StaticComposerFrame` on screen for all of it, so the launch card shows a
 * composer that looks ready to type into. The input gate installed alongside it
 * consumed every keystroke until the real composer mounted, so anything typed
 * in that window was discarded: the operator typed a prompt at a visible
 * composer and watched it vanish when the session landed.
 *
 * The class this closes is "input accepted by the screen is dropped instead of
 * reaching the composer". The gate now keeps what was typed after the tty flush
 * and hands it back from `releaseInput()`, and `InteractiveMode.init` puts that
 * text in the composer unsubmitted.
 *
 * The gate reads raw terminal bytes, so the adversarial half of this suite is
 * everything on stdin that is NOT typing: the terminal's own answers to the
 * probes the screen just issued (OSC 11 ground, DA, sixel), cursor keys, mouse
 * reports and bracketed-paste wrappers. A probe reply captured as typing would
 * paste escape bytes into the operator's draft, and a captured carriage return
 * would resurrect the queued-newline submit this gate exists to prevent.
 *
 * What it does NOT catch: it drives the gate through the terminal's own input
 * callback rather than a live tty, so it cannot prove the kernel delivers a
 * pre-launch backlog inside the flush window; that boundary is owned by
 * `flushPendingTtyInput` and asserted here only through the degrade path.
 */

import { afterEach, beforeAll, describe, expect, it, mock, spyOn } from "bun:test";
import { ProcessTerminal } from "@veyyon/tui";
import { TempDir } from "@veyyon/utils";
import { Settings } from "../src/config/settings";
import { type FirstFrame, paintFirstFrame, takeFirstFrame } from "../src/modes/first-frame";
import { resetGroundTintsForTest } from "../src/modes/theme/ground-tints";
import { initTheme } from "../src/modes/theme/theme";
import * as ttyInputFlush from "../src/modes/tty-input-flush";

let tempDir: TempDir;
beforeAll(async () => {
	tempDir = TempDir.createSync("pi-launch-typeahead-");
	await Settings.init({ inMemory: true, cwd: tempDir.path() });
	await initTheme(false);
});

/**
 * A painted card plus the terminal callback that feeds it.
 *
 * `paintFirstFrame` builds its own `ProcessTerminal`, so the callback the TUI
 * hands the terminal is the only way in. Spying on the prototype captures that
 * callback and keeps the run off the real tty: nothing enters raw mode and no
 * escape sequence reaches the operator's screen.
 */
interface PaintedCard {
	readonly frame: FirstFrame;
	readonly send: (data: string) => void;
}

function paintCard(options: { flushed: boolean }): PaintedCard {
	spyOn(ttyInputFlush, "flushPendingTtyInput").mockReturnValue(options.flushed);
	let onInput: ((data: string) => void) | undefined;
	spyOn(ProcessTerminal.prototype, "start").mockImplementation((handler: (data: string) => void): void => {
		onInput = handler;
	});
	spyOn(ProcessTerminal.prototype, "stop").mockImplementation((): void => {});
	const frame = paintFirstFrame("1.1.1");
	if (!onInput) throw new Error("the painted card never started its terminal");
	const send = onInput;
	return { frame, send };
}

const cards: PaintedCard[] = [];
function card(options: { flushed: boolean } = { flushed: true }): PaintedCard {
	const painted = paintCard(options);
	cards.push(painted);
	return painted;
}

afterEach(() => {
	for (const painted of cards) {
		painted.frame.release();
		painted.frame.ui.stop();
	}
	cards.length = 0;
	takeFirstFrame();
	// The paint reports the terminal's ground to a module-level cache, and a
	// cached ground changes every band and card rendered after this file in the
	// same process.
	resetGroundTintsForTest();
	// `spyOn` on a shared prototype and on an imported module object outlives
	// the test that installed it.
	mock.restore();
});

describe("what you type at the launch card reaches the composer", () => {
	it("hands back the prompt typed while the session was still starting", () => {
		const { frame, send } = card();
		send("fix");
		send(" the bug");
		expect(frame.releaseInput()).toBe("fix the bug");
	});

	it("returns nothing when the operator typed nothing", () => {
		const { frame } = card();
		expect(frame.releaseInput()).toBe("");
	});

	it("empties on release, so a second release cannot paste the draft twice", () => {
		const { frame, send } = card();
		send("hello");
		expect(frame.releaseInput()).toBe("hello");
		expect(frame.releaseInput()).toBe("");
	});

	it("keeps typing that arrives after the gate has already been released", () => {
		const { frame, send } = card();
		send("before");
		expect(frame.releaseInput()).toBe("before");
		// The listener is gone, so this reaches the composer as an ordinary
		// keystroke instead of being held a second time.
		send("after");
		expect(frame.releaseInput()).toBe("");
	});

	describe("what the terminal sends that is not typing", () => {
		// Every one of these arrives on stdin during startup. Capturing any of
		// them would paste control bytes into the operator's first prompt.
		const notTyping: ReadonlyArray<readonly [string, string]> = [
			["an OSC 11 background report", "\x1b]11;rgb:1e1e/1e1e/1e1e\x07"],
			["a primary device attributes reply", "\x1b[?62;1;6;9;15;22c"],
			["a sixel geometry reply", "\x1b[?2;1;0S"],
			["a cursor key", "\x1b[A"],
			["an SGR mouse report", "\x1b[<0;12;24M"],
			["a bracketed paste wrapper", "\x1b[200~pasted\x1b[201~"],
			["a carriage return", "\r"],
			["a newline", "\n"],
			["a tab", "\t"],
			["a backspace", "\x7f"],
			["ctrl+c", "\x03"],
		];

		for (const [name, data] of notTyping) {
			it(`drops ${name}`, () => {
				const { frame, send } = card();
				send(data);
				expect(frame.releaseInput()).toBe("");
			});
		}

		it("drops a chunk that mixes typing with a control byte rather than splitting it", () => {
			const { frame, send } = card();
			// A submit typed at the card: the text is held only when it arrives
			// without the newline, so the queued-return guard still holds.
			send("send this\r");
			expect(frame.releaseInput()).toBe("");
		});

		it("keeps ordinary text arriving between two probe replies", () => {
			const { frame, send } = card();
			send("\x1b]11;rgb:0000/0000/0000\x07");
			send("draft");
			send("\x1b[?62;c");
			expect(frame.releaseInput()).toBe("draft");
		});
	});

	it("holds non-ASCII typing, which is text the operator can see", () => {
		const { frame, send } = card();
		send("résumé 日本語");
		expect(frame.releaseInput()).toBe("résumé 日本語");
	});

	it("bounds what a held key can accumulate", () => {
		const { frame, send } = card();
		for (let i = 0; i < 200; i++) send("x".repeat(100));
		const held = frame.releaseInput();
		expect(held.length).toBe(4096);
		expect(held).toBe("x".repeat(4096));
	});

	it("discards everything when the tty queue could not be flushed", () => {
		// Without the flush the pre-launch backlog is still queued and cannot be
		// told apart from typing, so the documented degrade is to drop it all
		// rather than paste a previous session's keystrokes into the composer.
		const { frame, send } = card({ flushed: false });
		send("this was queued before launch");
		expect(frame.releaseInput()).toBe("");
	});
});
