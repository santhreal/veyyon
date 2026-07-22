import { describe, expect, it } from "bun:test";
import {
	formatKeyHint,
	formatKeyHints,
	getDefaultPasteImageKeys,
	KeybindingsManager,
} from "@veyyon/coding-agent/config/keybindings";
import type { KeyId } from "@veyyon/tui";

/**
 * formatKeyHint / formatKeyHints turn a stored key id into the human-readable hint
 * shown in help text and prompts. getDisplayString exercises them indirectly, but the
 * exported helpers had no direct test. They own the rendering rules: modifier and named
 * keys map to fixed labels (Ctrl/Shift/Alt, Esc/Enter/Up/PgUp), a single character is
 * upper-cased, a multi-character unlabeled token is capitalized, `+` joins a chord, and
 * `/` joins alternatives. A regression would render an inconsistent or lower-cased hint.
 */
describe("formatKeyHint / formatKeyHints", () => {
	it("renders a modifier chord with fixed labels and an upper-cased final key", () => {
		expect(formatKeyHint("ctrl+shift+a" as KeyId)).toBe("Ctrl+Shift+A");
		expect(formatKeyHint("alt+enter" as KeyId)).toBe("Alt+Enter");
	});

	it("maps named keys to their canonical labels", () => {
		expect(formatKeyHint("up" as KeyId)).toBe("Up");
		expect(formatKeyHint("pageup" as KeyId)).toBe("PgUp");
	});

	it("capitalizes an unlabeled multi-character token like a function key", () => {
		expect(formatKeyHint("f1" as KeyId)).toBe("F1");
	});

	it("joins a single binding and a list of alternatives, formatting each", () => {
		expect(formatKeyHints("ctrl+c" as KeyId)).toBe("Ctrl+C");
		expect(formatKeyHints(["esc" as KeyId, "enter" as KeyId])).toBe("Esc/Enter");
	});
});

describe("KeybindingsManager.getDisplayString", () => {
	it("formats a single binding as a human-readable key hint", () => {
		const keybindings = KeybindingsManager.inMemory({
			"app.message.dequeue": "alt+up",
		});

		expect(keybindings.getDisplayString("app.message.dequeue")).toBe("Alt+Up");
	});

	it("defaults retry to Alt+R", () => {
		const keybindings = KeybindingsManager.inMemory();

		expect(keybindings.getDisplayString("app.retry")).toBe("Alt+R");
	});

	it("formats multiple bindings with the existing separator", () => {
		const keybindings = KeybindingsManager.inMemory({
			"app.clipboard.copyPrompt": ["alt+shift+c", "ctrl+shift+c"],
		});

		expect(keybindings.getDisplayString("app.clipboard.copyPrompt")).toBe("Alt+Shift+C/Ctrl+Shift+C");
	});

	it("returns an empty string when the action has no binding", () => {
		const keybindings = KeybindingsManager.inMemory({
			"app.clipboard.copyPrompt": [],
		});

		expect(keybindings.getDisplayString("app.clipboard.copyPrompt")).toBe("");
	});
});

describe("getDefaultPasteImageKeys", () => {
	it("keeps Ctrl+V registered for image paste on Windows alongside the terminal-safe fallback", () => {
		expect(getDefaultPasteImageKeys("win32")).toEqual(["ctrl+v", "alt+v"]);
	});

	it("adds the macOS Command key event to Ctrl+V for image paste", () => {
		expect(getDefaultPasteImageKeys("linux")).toEqual(["ctrl+v"]);
		expect(getDefaultPasteImageKeys("darwin")).toEqual(["ctrl+v", "super+v"]);
	});
});
