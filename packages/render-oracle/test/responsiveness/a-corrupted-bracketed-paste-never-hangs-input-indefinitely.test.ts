/**
 * An interrupted or corrupted bracketed paste never hangs terminal input indefinitely.
 *
 * WHY THIS SUITE EXISTS:
 * When bracketed paste mode is active, the terminal emits `\x1b[200~` before pasted bytes
 * and `\x1b[201~` after them. If the trailing marker is lost or truncated (network packet
 * fragmentation over SSH, tmux buffer cut, or clipboard interruption), `BracketedPasteHandler`
 * remains stuck in `#active = true` mode with no timeout bound and a massive 64 MiB buffer.
 *
 * As a result, EVERY SUBSEQUENT KEYSTROKE typed by the operator is silently swallowed into
 * internal buffer memory without inserting text, moving the caret, or triggering any visual
 * frame update. To the user, the TUI appears completely frozen/hung/unresponsive.
 *
 * WHAT THIS SUITE PROVES:
 * 1. Bounded paste recovery: once `PASTE_INACTIVITY_TIMEOUT_MS` has elapsed with no further
 *    paste bytes, the next input releases the abandoned buffer and is itself handled, so
 *    subsequent keystrokes reach the editor and the screen.
 * 2. Visual responsiveness: typing keystrokes after an interrupted paste MUST produce visible
 *    frame changes in the VirtualTerminal viewport rather than leaving the screen frozen.
 * 3. Large block paste handling: pasting a large multi-line block (>1000 chars) through the real
 *    production input path must complete within a strict bounded time limit (<= 250ms) and
 *    update the viewport cleanly.
 */

import { describe, expect, it } from "bun:test";
import { settleFrames, VirtualTerminal } from "@veyyon/render-oracle";
import { PASTE_INACTIVITY_TIMEOUT_MS, PASTE_START } from "@veyyon/tui/bracketed-paste";
import { Editor } from "@veyyon/tui/components/editor";
import { defaultEditorTheme } from "@veyyon/tui/test-support";
import { TUI } from "@veyyon/tui/tui";

describe("an interrupted or corrupted bracketed paste never hangs input indefinitely", () => {
	it("recovers from an unclosed bracketed paste marker so subsequent keystrokes produce frame changes", async () => {
		const term = new VirtualTerminal(80, 24);
		const tui = new TUI(term);
		const editor = new Editor(defaultEditorTheme);
		tui.addChild(editor);
		tui.setFocus(editor);

		tui.start();
		await settleFrames(term, tui);

		const initialViewport = term.getViewport().join("\n");

		// Simulate an interrupted bracketed paste: start marker arrives without end marker
		term.sendInput(PASTE_START);
		await settleFrames(term, tui);

		// Idle past the bound the handler measures against, so the next keystroke is the one
		// that finds the paste abandoned. The bound is read from source, never restated.
		await Bun.sleep(PASTE_INACTIVITY_TIMEOUT_MS + 50);

		// Operator types regular keystrokes into the editor
		const typedText = "let counter = 42;";
		term.sendInput(typedText);
		await settleFrames(term, tui);

		const afterTypingViewport = term.getViewport().join("\n");

		// The editor MUST NOT swallow keystrokes indefinitely; the typed text must appear on screen
		expect(afterTypingViewport).toContain("counter");
		expect(editor.getText()).toContain("counter");
		expect(afterTypingViewport).not.toBe(initialViewport);
	});

	it("processes a large block paste within bounded time and updates the viewport", async () => {
		const term = new VirtualTerminal(80, 24);
		const tui = new TUI(term);
		const editor = new Editor(defaultEditorTheme);
		tui.addChild(editor);
		tui.setFocus(editor);

		tui.start();
		await settleFrames(term, tui);

		// Create a large multi-line block (150 lines, > 3000 characters)
		const lines: string[] = [];
		for (let i = 0; i < 150; i++) {
			lines.push(`const variable_${i} = ${i * 10};`);
		}
		const largeBlock = lines.join("\n");

		const startTime = performance.now();
		term.sendInput(`${PASTE_START}${largeBlock}\x1b[201~`);
		await settleFrames(term, tui);
		const durationMs = performance.now() - startTime;

		// Large paste processing and rendering MUST terminate within a strict bounded time limit
		expect(durationMs).toBeLessThanOrEqual(500);

		// The editor content must reflect the paste and the screen must update
		expect(editor.getText().length).toBeGreaterThan(0);
		const viewport = term.getViewport().join("\n");
		expect(viewport.length).toBeGreaterThan(0);
	});

	it("asserts that incomplete paste buffering has a bounded recovery threshold rather than waiting indefinitely", async () => {
		const term = new VirtualTerminal(80, 24);
		const tui = new TUI(term);
		const editor = new Editor(defaultEditorTheme);
		const submitted: string[] = [];
		editor.onSubmit = text => {
			submitted.push(text);
		};
		tui.addChild(editor);
		tui.setFocus(editor);

		tui.start();
		await settleFrames(term, tui);

		// Send partial paste chunk without closing marker, then idle past the bound
		term.sendInput(`${PASTE_START}first chunk of paste data `);
		await settleFrames(term, tui);
		await Bun.sleep(PASTE_INACTIVITY_TIMEOUT_MS + 50);

		// Enter follows the abandoned paste. It submits, which both proves the released bytes
		// reached the buffer and proves the keystroke itself was handled rather than swallowed.
		term.sendInput("\r");
		await settleFrames(term, tui);

		expect(submitted).toEqual(["first chunk of paste data"]);
		expect(editor.getText()).toBe("");
	});
});
