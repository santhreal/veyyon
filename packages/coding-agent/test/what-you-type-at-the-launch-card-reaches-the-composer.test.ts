/**
 * WHY:
 * Session startup runs for over a second, and `paintFirstFrame` puts a composer
 * on screen for all of it, so the launch card shows something that looks ready
 * to type into. It has to BE ready: the class this closes is "input accepted by
 * the screen is dropped instead of reaching the composer", and every earlier
 * shape of the launch card lost a keystroke somewhere -- flushed by the tty
 * handover, swallowed by a gate, or held in a draft that the mounted editor
 * never received.
 *
 * The card now mounts the real `CustomEditor` and focuses it, so there is no
 * hand-over to lose anything in: what is on screen at the first paint is the
 * editor the session comes up behind. These tests drive the production input
 * path -- a real `ProcessTerminal` reading real `process.stdin` data events --
 * because the adversarial half of the class is everything on stdin that is NOT
 * typing. The terminal's own answers to the probes the screen just issued
 * (OSC 11 ground, DA1, sixel geometry) arrive inside this exact window, and a
 * reply that reached a focused editor would paste escape bytes into the
 * operator's first prompt.
 *
 * The carriage return is the other half. A key pressed before the process
 * started is still in the kernel's queue when the card paints, so a queued
 * newline reaches an editor whose `onSubmit` the session has not wired yet.
 * Submitting there would clear the draft and hand it to nobody.
 *
 * What it does NOT catch: the loop turn `settleQueuedInput` spends so the
 * redraw reaches the terminal before the caller blocks on the main module's
 * evaluation. Nothing in-process observes a write that never left the buffer;
 * only a pty run shows it.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { setTerminalHeadless, TempDir } from "@veyyon/utils";
import { Settings } from "../src/config/settings";
import { type FirstFrame, paintFirstFrame, takeFirstFrame } from "../src/modes/terminal/first-frame";
import * as ttyInputFlush from "../src/modes/terminal/tty-input-flush";
import { resetGroundTintsForTest } from "../src/theme/ground-tints";
import { initTheme } from "../src/theme/theme";

let tempDir: TempDir;
beforeAll(async () => {
	tempDir = TempDir.createSync("pi-launch-typeahead-");
	await Settings.init({ inMemory: true, cwd: tempDir.path() });
	await initTheme(false);
});

const stdinIsTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const stdoutIsTty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
const stdinSetRawMode = Object.getOwnPropertyDescriptor(process.stdin, "setRawMode");
let previousHeadless = false;

function restoreProperty(target: object, key: string, descriptor: PropertyDescriptor | undefined): void {
	if (descriptor) {
		Object.defineProperty(target, key, descriptor);
		return;
	}
	delete (target as Record<string, unknown>)[key];
}

/** A painted card, plus the bytes the terminal wrote while it was up. */
interface PaintedCard {
	readonly frame: FirstFrame;
	/** How many times the paint discarded the kernel's tty queue. */
	readonly flushCount: () => number;
	readonly draft: () => string;
}

/** Defaults describe an ordinary launch, which is every launch but a relaunch. */
interface LaunchKind {
	readonly relaunched?: boolean;
	readonly flushed?: boolean;
}

/**
 * Bytes the operator's terminal put on stdin. Emitted on the real stream the
 * real `ProcessTerminal` is reading, so a sequence the terminal layer consumes
 * is consumed here too rather than being handed to the composer by a stub.
 */
function send(data: string): void {
	process.stdin.emit("data", data);
}

const cards: PaintedCard[] = [];

function card(options: LaunchKind = {}): PaintedCard {
	const flush = spyOn(ttyInputFlush, "flushPendingTtyInput").mockReturnValue(options.flushed ?? true);
	if (options.relaunched) process.env[ttyInputFlush.RELAUNCH_MARKER] = "1";
	else delete process.env[ttyInputFlush.RELAUNCH_MARKER];
	const frame = paintFirstFrame("1.1.1");
	const painted: PaintedCard = {
		frame,
		flushCount: () => flush.mock.calls.length,
		draft: () => frame.editor.getText(),
	};
	cards.push(painted);
	return painted;
}

beforeEach(() => {
	Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
	Object.defineProperty(process.stdin, "setRawMode", { value: () => process.stdin, configurable: true });
	previousHeadless = setTerminalHeadless(false);
	spyOn(process.stdin, "resume").mockImplementation(() => process.stdin);
	spyOn(process.stdin, "pause").mockImplementation(() => process.stdin);
	spyOn(process.stdin, "setEncoding").mockImplementation(() => process.stdin);
	spyOn(process.stdout, "write").mockReturnValue(true);
});

afterEach(() => {
	for (const painted of cards) {
		painted.frame.release();
		painted.frame.ui.stop();
	}
	cards.length = 0;
	// A paint that is not reached leaves the marker set for the next file.
	delete process.env[ttyInputFlush.RELAUNCH_MARKER];
	takeFirstFrame();
	// The paint reports the terminal's ground to a module-level cache, and a
	// cached ground changes every band and card rendered after this file in the
	// same process.
	resetGroundTintsForTest();
	setTerminalHeadless(previousHeadless);
	restoreProperty(process.stdin, "isTTY", stdinIsTty);
	restoreProperty(process.stdout, "isTTY", stdoutIsTty);
	restoreProperty(process.stdin, "setRawMode", stdinSetRawMode);
	// `spyOn` on a shared prototype and on an imported module object outlives
	// the test that installed it.
	mock.restore();
});

describe("what you type at the launch card reaches the composer", () => {
	it("puts the prompt typed while the session was still starting in the draft", () => {
		const { draft } = card();
		send("fix");
		send(" the bug");
		expect(draft()).toBe("fix the bug");
	});

	it("focuses the composer, which is how the keystroke gets there at all", () => {
		const { frame } = card();
		expect(frame.ui.getFocused()).toBe(frame.editor);
	});

	it("hands the mode the very editor that took the keystroke", () => {
		const { frame } = card();
		send("carried over");
		// `takeFirstFrame` is what `InteractiveMode` reads; the draft survives
		// because the editor is adopted rather than rebuilt.
		const adopted = takeFirstFrame();
		expect(adopted?.editor).toBe(frame.editor);
		expect(adopted?.editor.getText()).toBe("carried over");
	});

	it("keeps the container the editor is mounted in, so the zone re-parents nothing", () => {
		const { frame } = card();
		expect(frame.editorContainer.children).toContain(frame.editor);
	});

	it("holds non-ASCII typing, which is text the operator can see", () => {
		const { draft } = card();
		send("résumé 日本語");
		expect(draft()).toBe("résumé 日本語");
	});

	describe("a carriage return still queued from before the process started", () => {
		// The composer is live before the session wires `onSubmit`, and the
		// editor's submit path clears the draft on its way out. A queued newline
		// reaching it would destroy the prompt and deliver it to no one.
		it("does not clear the draft it arrives behind", () => {
			const { draft } = card();
			send("fix the parser");
			send("\r");
			expect(draft()).toBe("fix the parser");
		});

		it("does not clear it when it shares a chunk with the text", () => {
			const { draft } = card();
			send("send this\r");
			expect(draft()).toBe("send this");
		});

		it("leaves an empty composer empty rather than inserting a blank line", () => {
			const { draft } = card();
			send("\r");
			expect(draft()).toBe("");
		});
	});

	describe("correcting a mistake typed at the card", () => {
		it("takes back the last character", () => {
			const { draft } = card();
			send("hello");
			send("\x7f");
			expect(draft()).toBe("hell");
		});

		it("applies a backspace that shares a chunk with the text around it", () => {
			const { draft } = card();
			send("hellp\x7fo");
			expect(draft()).toBe("hello");
		});

		it("does not underflow on an empty draft", () => {
			const { draft } = card();
			send("\x7f\x7f\x7f");
			expect(draft()).toBe("");
		});
	});

	describe("what the terminal sends that is not typing", () => {
		// Every one of these arrives on stdin during startup, and the composer
		// is focused for the whole window. The terminal layer consumes its own
		// probe replies; anything it does not consume reaches the editor, so
		// this sweep is the guard against escape bytes in the first prompt.
		const notTyping: ReadonlyArray<readonly [string, string]> = [
			["an OSC 11 background report", "\x1b]11;rgb:1e1e/1e1e/1e1e\x07"],
			["a primary device attributes reply", "\x1b[?62;1;6;9;15;22c"],
			["a sixel geometry reply", "\x1b[?2;1;0S"],
			["an SGR mouse report", "\x1b[<0;12;24M"],
		];

		for (const [name, data] of notTyping) {
			it(`keeps ${name} out of the draft`, () => {
				const { draft } = card();
				send(data);
				expect(draft()).toBe("");
			});
		}

		it("keeps ordinary text arriving between two probe replies", () => {
			const { draft } = card();
			send("\x1b]11;rgb:0000/0000/0000\x07");
			send("draft");
			send("\x1b[?62;c");
			expect(draft()).toBe("draft");
		});
	});

	describe("which launches may discard the kernel's tty queue", () => {
		it("keeps what was typed before the card painted, without discarding the queue", () => {
			// The reported defect. Startup runs for most of a second before the
			// card appears, and the paint used to `tcflush` unconditionally, so
			// every keystroke inside that window was destroyed rather than
			// delayed: measured at a live pty, text sent 0.05s, 0.30s and 0.50s
			// after exec never reached the composer, while 0.70s onward arrived
			// within 40ms.
			const { draft, flushCount } = card();
			send("fix the parser");
			expect(flushCount()).toBe(0);
			expect(draft()).toBe("fix the parser");
		});

		it("discards the queue a relaunch inherited", () => {
			// `/profile <name>` respawns the CLI, and nothing reads fd 0 between
			// the parent restoring the terminal and the child starting, so the
			// queue holds the dead session's backlog rather than typing.
			const { draft, flushCount } = card({ relaunched: true });
			expect(flushCount()).toBe(1);
			// Bytes arriving after the flush are this session's, so they land.
			send("typed at the new profile");
			expect(draft()).toBe("typed at the new profile");
		});

		it("discards everything when a relaunch could not flush the queue", () => {
			// Windows consoles have no termios. Without the flush the backlog is
			// still queued and cannot be told apart from typing, so the degrade
			// is to drop both rather than paste a dead session's keystrokes.
			const { draft } = card({ relaunched: true, flushed: false });
			send("this was queued before launch");
			expect(draft()).toBe("");
		});

		it("stops discarding once the mode has taken the screen", () => {
			// The degrade is bounded by the mount, not by a timer: a session that
			// came up must accept the next keystroke.
			const { frame, draft } = card({ relaunched: true, flushed: false });
			send("queued");
			frame.release();
			send("typed for real");
			expect(draft()).toBe("typed for real");
		});

		it("clears the marker, so a process this session spawns is not read as a relaunch", () => {
			card({ relaunched: true });
			expect(process.env[ttyInputFlush.RELAUNCH_MARKER]).toBeUndefined();
		});
	});

	/**
	 * The second half of the same class: input the screen accepted but did not
	 * SHOW. The card's bytes are composed inside `paintFirstFrame` and queued,
	 * so a key pressed during exec is still in the tty buffer when that frame
	 * is built, and the loop turn that flushes the frame is a check turn, which
	 * does not reach poll. Measured on a pty at 100x30: the card landed at
	 * 156ms and the character typed before it at 312ms, because the next thing
	 * the caller does is evaluate the main module and hold the loop.
	 *
	 * `settleQueuedInput` spends the turns that collect and draw it. The
	 * assertion that matters is the asynchronous one: a version that samples
	 * the buffer synchronously passes every other test in this file and
	 * reproduces the defect exactly.
	 */
	describe("the card repaints with what was typed before it appeared", () => {
		it("collects a keystroke the reader delivers after the card was composed", async () => {
			const { frame, draft } = card();
			setImmediate(() => send("Z"));
			expect(await frame.settleQueuedInput()).toBe(true);
			expect(draft()).toBe("Z");
		});

		it("collects every keystroke of one delivery, not the first", async () => {
			const { frame, draft } = card();
			setImmediate(() => {
				send("he");
				send("llo");
			});
			expect(await frame.settleQueuedInput()).toBe(true);
			expect(draft()).toBe("hello");
		});

		it("reports nothing to draw, and returns, when the operator typed nothing", async () => {
			const { frame } = card();
			expect(await frame.settleQueuedInput()).toBe(false);
		});

		it("ignores a terminal probe reply that arrives in the same window", async () => {
			const { frame, draft } = card();
			setImmediate(() => send("\x1b]11;rgb:1e1e/1e1e/1e1e\x07"));
			expect(await frame.settleQueuedInput()).toBe(false);
			expect(draft()).toBe("");
		});

		it("returns rather than waiting for input that will not come", async () => {
			const { frame } = card();
			expect(await frame.settleQueuedInput()).toBe(false);
			expect(await frame.settleQueuedInput()).toBe(false);
		});
	});
});
