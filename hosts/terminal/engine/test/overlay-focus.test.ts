import { describe, expect, it } from "bun:test";
import { type Component, Container, type Focusable, type OverlayFocusOwner, TUI } from "@veyyon/tui";
import type { Terminal, TerminalAppearance } from "@veyyon/tui/terminal";

class MinimalTerminal implements Terminal {
	columns = 80;
	rows = 24;
	kittyProtocolActive = false;
	kittyEnableSequence: string | null = null;
	keyboardEnhancementEnterSequence: string | null = null;
	keyboardEnhancementExitSequence: string | null = null;
	appearance: TerminalAppearance | undefined;
	#onInput: ((data: string) => void) | undefined;
	#onResize: (() => void) | undefined;
	output = "";
	cursorHidden = false;
	cursorTransitions = 0;

	start(onInput: (data: string) => void, onResize: () => void): void {
		this.#onInput = onInput;
		this.#onResize = onResize;
	}

	stop(): void {
		this.#onInput = undefined;
		this.#onResize = undefined;
	}

	async drainInput(_maxMs?: number, _idleMs?: number): Promise<void> {}

	write(data: string): void {
		this.output += data;
		if (data.length === 0) this.output += "";
	}

	moveBy(_lines: number): void {}

	hideCursor(): void {
		this.cursorHidden = true;
		this.cursorTransitions += 1;
	}

	showCursor(): void {
		this.cursorHidden = false;
		this.cursorTransitions += 1;
	}

	clearLine(): void {}

	clearFromCursor(): void {}

	clearScreen(): void {}

	setTitle(_title: string): void {}

	setProgress(_active: boolean): void {}

	onAppearanceChange(_callback: (appearance: TerminalAppearance) => void): void {}

	sendInput(data: string): void {
		const onInput = this.#onInput;
		if (onInput) onInput(data);
	}

	emitResize(): void {
		const onResize = this.#onResize;
		if (onResize) onResize();
	}
}

class FocusRecorder implements Component, Focusable {
	focused = false;
	inputs: string[] = [];
	lastInput = "";

	constructor(readonly label: string) {}

	handleInput(data: string): void {
		this.inputs.push(data);
		this.lastInput = data;
	}

	render(_width: number): string[] {
		const suffix = this.focused ? "-focused" : "";
		return [`${this.label}${suffix}`];
	}
}

class OwningOverlay extends FocusRecorder implements OverlayFocusOwner {
	focusTarget: Component | undefined;

	ownsOverlayFocusTarget(component: Component): boolean {
		if (component !== this.focusTarget) return false;
		return true;
	}
}

describe("TUI overlay focus", () => {
	it("keeps keyboard focus on the visible overlay when a hidden surface requests focus", () => {
		const terminal = new MinimalTerminal();
		const tui = new TUI(terminal);
		const editor = new FocusRecorder("editor");
		const settingsOverlay = new FocusRecorder("settings");
		const approvalPrompt = new FocusRecorder("approval");

		tui.addChild(editor);
		tui.setFocus(editor);

		try {
			tui.start();
			tui.showOverlay(settingsOverlay, { fullscreen: true });

			tui.setFocus(approvalPrompt);
			terminal.sendInput("x");

			expect(tui.getFocused()).toBe(settingsOverlay);
			expect(settingsOverlay.inputs).toEqual(["x"]);
			expect(approvalPrompt.inputs).toEqual([]);
		} finally {
			tui.stop();
		}
	});

	it("allows a visible overlay to delegate focus to an owned prompt", () => {
		const terminal = new MinimalTerminal();
		const tui = new TUI(terminal);
		const editor = new FocusRecorder("editor");
		const wizardOverlay = new OwningOverlay("wizard");
		const authorizationCodeInput = new FocusRecorder("code");
		const approvalPrompt = new FocusRecorder("approval");

		tui.addChild(editor);
		tui.setFocus(editor);

		try {
			tui.start();
			tui.showOverlay(wizardOverlay, { fullscreen: true });

			wizardOverlay.focusTarget = authorizationCodeInput;
			tui.setFocus(authorizationCodeInput);
			terminal.sendInput("code");

			expect(tui.getFocused()).toBe(authorizationCodeInput);
			expect(authorizationCodeInput.inputs).toEqual(["code"]);
			expect(wizardOverlay.inputs).toEqual([]);

			tui.setFocus(approvalPrompt);
			terminal.sendInput("still-code");

			expect(tui.getFocused()).toBe(authorizationCodeInput);
			expect(authorizationCodeInput.inputs).toEqual(["code", "still-code"]);
			expect(approvalPrompt.inputs).toEqual([]);
		} finally {
			tui.stop();
		}
	});

	it("hands focus to the live editor-slot owner after a fullscreen overlay closes (issue #3349)", () => {
		// Repro for issue #3349: opening /settings (a fullscreen overlay) while
		// a tool approval prompt fires lands the prompt component in the editor
		// slot. `hide()` used to restore focus to the preFocus captured at open
		// time, the editor, which by then had been swapped out of the slot and
		// was reachable from nothing. The visible prompt received no keystrokes
		// and the TUI looked frozen.
		//
		// This was compensated at the call site: every close handler followed
		// hide() with a setFocus onto whatever owned the slot. That fixed the
		// surfaces someone remembered to patch. hide() now declines to restore
		// a captured component that has left the tree, so the compensation is
		// no longer load-bearing and this asserts hide() on its own.
		const terminal = new MinimalTerminal();
		const tui = new TUI(terminal);

		const editor = new FocusRecorder("editor");
		const editorContainer = new Container();
		editorContainer.addChild(editor);
		tui.addChild(editorContainer);
		tui.setFocus(editor);

		try {
			tui.start();

			// /settings opens a fullscreen overlay. preFocus captured = editor.
			const settingsOverlay = new FocusRecorder("settings");
			const handle = tui.showOverlay(settingsOverlay, { fullscreen: true });
			expect(tui.getFocused()).toBe(settingsOverlay);

			// While settings is open, a tool approval prompt swaps the editor
			// slot to a hook-selector component. Focus snaps back to the
			// settings overlay because it owns the top of the overlay stack.
			const approvalPrompt = new FocusRecorder("approval");
			editorContainer.clear();
			editorContainer.addChild(approvalPrompt);
			tui.setFocus(approvalPrompt);
			expect(tui.getFocused()).toBe(settingsOverlay);

			// User Esc's out of settings. No follow-up setFocus: the captured
			// editor is gone from the slot, so the restore must find the live
			// occupant instead of handing the keyboard to a detached component.
			handle.hide();

			terminal.sendInput("\x1b[B");
			terminal.sendInput("\r");
			expect(tui.getFocused()).toBe(approvalPrompt);
			expect(approvalPrompt.inputs).toEqual(["\x1b[B", "\r"]);
			expect(editor.inputs).toEqual([]);
		} finally {
			tui.stop();
		}
	});
});
