import { beforeAll, describe, expect, it, vi } from "bun:test";
import { KEYBINDINGS } from "@veyyon/coding-agent/config/keybinding-defs";
import {
	CONFIGURABLE_EDITOR_ACTIONS,
	type ConfigurableEditorAction,
	CustomEditor,
} from "@veyyon/coding-agent/modes/terminal/components/composer/custom-editor";
import { getEditorTheme, initTheme } from "@veyyon/coding-agent/theme/theme";
import type { KeyId } from "@veyyon/utils/keys";

const actionHandlers = {
	"app.interrupt": "onEscape",
	"app.clear": "onClear",
	"app.exit": "onExit",
	"app.suspend": "onSuspend",
	"app.display.reset": "onDisplayReset",
	"app.thinking.cycle": "onCycleThinkingLevel",
	"app.model.cycleForward": "onCycleModelForward",
	"app.model.cycleBackward": "onCycleModelBackward",
	"app.model.select": "onSelectModel",
	"app.model.selectTemporary": "onSelectModelTemporary",
	"app.tools.expand": "onExpandTools",
	"app.thinking.toggle": "onToggleThinking",
	"app.editor.external": "onExternalEditor",
	"app.history.search": "onHistorySearch",
	"app.message.dequeue": "onDequeue",
	"app.retry": "onRetry",
	"app.clipboard.pasteImage": "onPasteImage",
	"app.clipboard.pasteTextRaw": "onPasteTextRaw",
	"app.clipboard.copyPrompt": "onCopyPrompt",
	"app.bash.background": "onBashBackground",
} as const satisfies Record<ConfigurableEditorAction, keyof CustomEditor>;

function recordAction(editor: CustomEditor, action: ConfigurableEditorAction, calls: string[], label: string): void {
	const handler = actionHandlers[action];
	if (handler === "onPasteImage") {
		editor.onPasteImage = async () => {
			calls.push(label);
			return true;
		};
	} else if (handler === "onBashBackground") {
		editor.onBashBackground = () => {
			calls.push(label);
			return true;
		};
	} else {
		editor[handler] = () => {
			calls.push(label);
		};
	}
}

const modifierMasks: Readonly<Record<string, number>> = { shift: 1, alt: 2, ctrl: 4, super: 8 };

function keySequence(key: KeyId): string {
	const parts = key.split("+");
	const base = parts.pop();
	let modifiers = 1;
	for (const part of parts) {
		const mask = modifierMasks[part];
		if (mask === undefined) throw new Error(`Unsupported key modifier: ${part}`);
		modifiers += mask;
	}
	if (base === "up") return `\x1b[1;${modifiers}A`;
	const codepoint = base === "escape" ? 27 : base === "tab" ? 9 : base?.length === 1 ? base.codePointAt(0) : undefined;
	if (codepoint === undefined) throw new Error(`Unsupported key: ${key}`);
	return `\x1b[${codepoint};${modifiers}u`;
}

describe("CustomEditor keybindings", () => {
	beforeAll(async () => {
		await initTheme();
	});

	/**
	 * Shared default match sets must not share later remaps between editors or
	 * retain caller-owned key arrays. This sweeps every configurable action;
	 * shortcut precedence and early-startup deferral have separate suites.
	 */
	for (const action of CONFIGURABLE_EDITOR_ACTIONS) {
		it(`${action} retains every declared fallback chord before rebinding`, () => {
			const editor = new CustomEditor(getEditorTheme());
			const calls: string[] = [];
			recordAction(editor, action, calls, action);
			const declared = KEYBINDINGS[action].defaultKeys;
			const keys = typeof declared === "string" ? [declared] : declared;
			for (const key of keys) {
				editor.handleInput(keySequence(key));
				expect(calls).toEqual([action]);
				calls.length = 0;
			}
		});

		it(`${action} snapshots remaps without changing another editor`, () => {
			const first = new CustomEditor(getEditorTheme());
			const second = new CustomEditor(getEditorTheme());
			const calls: string[] = [];
			recordAction(first, action, calls, "first");
			recordAction(second, action, calls, "second");
			const keys: KeyId[] = ["f12"];
			first.setActionKeys(action, keys);
			keys[0] = "f11";

			first.handleInput("\x1b[24~");
			expect(calls).toEqual(["first"]);
			second.handleInput("\x1b[24~");
			first.handleInput("\x1b[23~");
			expect(calls).toEqual(["first"]);

			first.setActionKeys(action, ["f11"]);
			first.handleInput("\x1b[24~");
			first.handleInput("\x1b[23~");
			expect(calls).toEqual(["first", "first"]);

			first.setActionKeys(action, []);
			first.handleInput("\x1b[23~");
			const third = new CustomEditor(getEditorTheme());
			recordAction(third, action, calls, "third");
			third.handleInput("\x1b[24~");
			third.handleInput("\x1b[23~");
			expect(calls).toEqual(["first", "first"]);
		});
	}

	it("routes the configured retry chord through handleInput", () => {
		const editor = new CustomEditor(getEditorTheme());
		const onRetry = vi.fn();

		editor.setActionKeys("app.retry", ["alt+shift+r"]);
		editor.onRetry = onRetry;
		editor.handleInput("\x1bR");

		expect(onRetry).toHaveBeenCalledTimes(1);
	});

	it("lets custom handlers keep precedence over the default retry chord", () => {
		const editor = new CustomEditor(getEditorTheme());
		const onRetry = vi.fn();
		const customHandler = vi.fn();

		editor.onRetry = onRetry;
		editor.setCustomKeyHandler("alt+r", customHandler);
		editor.handleInput("\x1br");

		expect(customHandler).toHaveBeenCalledTimes(1);
		expect(onRetry).not.toHaveBeenCalled();
	});

	it("lets copy-prompt remaps keep precedence over the default retry chord", () => {
		const editor = new CustomEditor(getEditorTheme());
		const onRetry = vi.fn();
		const onCopyPrompt = vi.fn();

		editor.onRetry = onRetry;
		editor.onCopyPrompt = onCopyPrompt;
		editor.setActionKeys("app.clipboard.copyPrompt", ["alt+r"]);
		editor.handleInput("\x1br");

		expect(onCopyPrompt).toHaveBeenCalledTimes(1);
		expect(onRetry).not.toHaveBeenCalled();
	});
});
