/**
 * WHY:
 * input-controller.ts onChange fast-path previously bypassed trimStart() whenever
 * charCodeAt(0) > 32. That caused a regression where leading Unicode whitespace (such as
 * NBSP U+00A0, BOM U+FEFF, Zs space separators, or line/paragraph separators) before '!' or '$'
 * failed to switch into bash or python mode.
 *
 * The real editor emits changes after normalizing loaded text. This suite covers
 * BMP whitespace, non-whitespace Unicode, ASCII control normalization, and mode
 * transitions through that path. It does not exercise terminal key decoding.
 */

import { describe, expect, it, vi } from "bun:test";
import { KEYBINDINGS } from "@veyyon/coding-agent/config/keybinding-defs";
import { CustomEditor } from "@veyyon/coding-agent/modes/terminal/components/composer/custom-editor";
import { InputController } from "@veyyon/coding-agent/modes/terminal/controllers/input-controller";
import type { InteractiveModeContext } from "@veyyon/coding-agent/modes/terminal/types";
import { getEditorTheme } from "@veyyon/coding-agent/theme/theme";
import { KeybindingsManager } from "@veyyon/utils/keybindings";

// Dynamically derive all BMP whitespace characters per ECMAScript trimStart() specification
const DERIVED_WHITESPACE_CHARS: string[] = [];
const DERIVED_NON_WHITESPACE_CONTROLS: string[] = [];

for (let cp = 0; cp <= 0xffff; cp++) {
	const ch = String.fromCharCode(cp);
	if (ch.trimStart() === "") {
		DERIVED_WHITESPACE_CHARS.push(ch);
	} else if (cp <= 31 || cp === 127) {
		DERIVED_NON_WHITESPACE_CONTROLS.push(ch);
	}
}

function createRealEditorControllerContext() {
	const editor = new CustomEditor(getEditorTheme());
	/** The mode flags as the border refresh observes them, one entry per refresh. */
	const borderRefreshes: { bash: boolean; python: boolean }[] = [];
	let welcomeDismissals = 0;
	const requestRender = vi.fn();
	const addInputListener = vi.fn();
	const addStartListener = vi.fn();

	const ctx = {
		editor,
		ui: {
			requestRender,
			addInputListener,
			addStartListener,
		},
		keybindings: new KeybindingsManager(KEYBINDINGS),
		session: {
			isStreaming: false,
			isCompacting: false,
			isBashRunning: false,
			isEvalRunning: false,
		},
		isBashMode: false,
		isPythonMode: false,
		updateEditorBorderColor: () => {
			borderRefreshes.push({ bash: ctx.isBashMode, python: ctx.isPythonMode });
		},
		refreshComposerShortcuts: () => {},
		dismissWelcome: () => {
			welcomeDismissals += 1;
		},
	} as unknown as InteractiveModeContext;

	return {
		ctx,
		editor,
		borderRefreshes,
		welcomeDismissals: () => welcomeDismissals,
	};
}

describe("InputController onChange whitespace and mode classification", () => {
	it("classifies bash and python modes across all runtime-derived ECMAScript leading whitespace characters", () => {
		const { ctx, editor } = createRealEditorControllerContext();
		const controller = new InputController(ctx);
		controller.setupKeyHandlers();

		for (const ws of DERIVED_WHITESPACE_CHARS) {
			// Bash mode with leading whitespace
			editor.setText(`${ws}!echo hello`);
			expect(ctx.isBashMode).toBe(true);
			expect(ctx.isPythonMode).toBe(false);

			// Reset to plain text
			editor.setText(`${ws}plain text`);
			expect(ctx.isBashMode).toBe(false);
			expect(ctx.isPythonMode).toBe(false);

			// Python mode with leading whitespace
			editor.setText(`${ws}$ print(1)`);
			expect(ctx.isBashMode).toBe(false);
			expect(ctx.isPythonMode).toBe(true);

			// Reset to empty
			editor.setText("");
			expect(ctx.isBashMode).toBe(false);
			expect(ctx.isPythonMode).toBe(false);
		}
	});

	it.each([
		["$", true],
		["$$", true],
		["$ print(1)", true],
		["$$ print(1)", true],
		["$ git status", false],
		["$$ git status", true],
		["$HOME", false],
		// biome-ignore lint/suspicious/noTemplateCurlyInString: Shell-variable syntax is literal editor input.
		["${name}", false],
		["$print(1)", false],
		["$\u{1f600}", false],
		["$\u00a0print(1)", false],
	] as const)("classifies the loaded Python prefix %j", (text, expected) => {
		const { ctx, editor } = createRealEditorControllerContext();
		new InputController(ctx).setupKeyHandlers();
		editor.setText(text);
		expect(ctx.isBashMode).toBe(false);
		expect(ctx.isPythonMode).toBe(expected);
	});

	it("does not classify non-whitespace Unicode characters as leading whitespace", () => {
		const { ctx, editor } = createRealEditorControllerContext();
		const controller = new InputController(ctx);
		controller.setupKeyHandlers();

		const nonWhitespaceUnicode = [
			"\u00A1", // Inverted exclamation mark ¡
			"\u200B", // Zero-width space (Category Cf, not trimmed by trimStart)
			"\u3042", // Japanese Hiragana あ
			"\u{1f680}", // Astral non-whitespace
		];

		for (const nws of nonWhitespaceUnicode) {
			expect(nws.trimStart()).toBe(nws);

			editor.setText(`${nws}!echo test`);
			expect(ctx.isBashMode).toBe(false);
			expect(ctx.isPythonMode).toBe(false);

			editor.setText(`${nws}$ print(1)`);
			expect(ctx.isBashMode).toBe(false);
			expect(ctx.isPythonMode).toBe(false);
		}
	});

	it("classifies control-prefixed commands after loaded-text normalization", () => {
		const { ctx, editor } = createRealEditorControllerContext();
		const controller = new InputController(ctx);
		controller.setupKeyHandlers();

		for (const ctrl of DERIVED_NON_WHITESPACE_CONTROLS) {
			expect(ctrl.trimStart()).toBe(ctrl);

			editor.setText(`${ctrl}!echo test`);
			expect(ctx.isBashMode).toBe(ctrl !== "\x7f");
			expect(ctx.isPythonMode).toBe(false);

			editor.setText(`${ctrl}$ print(1)`);
			expect(ctx.isBashMode).toBe(false);
			expect(ctx.isPythonMode).toBe(ctrl !== "\x7f");
		}
	});

	it("updates editor border color only on mode transitions, after the mode flags have moved", () => {
		const { ctx, editor, borderRefreshes } = createRealEditorControllerContext();
		const controller = new InputController(ctx);
		controller.setupKeyHandlers();

		expect(borderRefreshes).toEqual([]);

		// Transition normal -> bash
		editor.setText("\u00A0!echo test");
		expect(ctx.isBashMode).toBe(true);
		expect(borderRefreshes).toEqual([{ bash: true, python: false }]);

		// Same mode (bash -> bash)
		editor.setText("\u00A0!echo test 2");
		expect(ctx.isBashMode).toBe(true);
		expect(borderRefreshes).toEqual([{ bash: true, python: false }]);

		// Transition bash -> python
		editor.setText("\u2003$ print(42)");
		expect(ctx.isPythonMode).toBe(true);
		expect(ctx.isBashMode).toBe(false);
		expect(borderRefreshes).toEqual([
			{ bash: true, python: false },
			{ bash: false, python: true },
		]);

		// Transition python -> normal
		editor.setText("just text");
		expect(ctx.isPythonMode).toBe(false);
		expect(ctx.isBashMode).toBe(false);
		expect(borderRefreshes).toEqual([
			{ bash: true, python: false },
			{ bash: false, python: true },
			{ bash: false, python: false },
		]);
	});

	it("dismisses welcome card on non-empty input change", () => {
		const { ctx, editor, welcomeDismissals } = createRealEditorControllerContext();
		const controller = new InputController(ctx);
		controller.setupKeyHandlers();

		editor.setText("");
		expect(welcomeDismissals()).toBe(0);

		editor.setText("x");
		expect(welcomeDismissals()).toBe(1);
	});
});
