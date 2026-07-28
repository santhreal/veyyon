import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";

import { HookInputComponent } from "@veyyon/coding-agent/modes/components/hook-input";
import { getThemeByName, setThemeInstance } from "@veyyon/coding-agent/modes/theme/theme";
import { DEFAULT_MASK_CHAR, type TUI } from "@veyyon/tui";
import { PASTE_END, PASTE_START } from "@veyyon/tui/bracketed-paste";

beforeAll(async () => {
	const theme = await getThemeByName("dark");
	if (!theme) {
		throw new Error("Failed to load dark theme for tests");
	}
	setThemeInstance(theme);
});
describe("HookInputComponent timeout", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("resets timeout on user activity and still expires when idle", () => {
		vi.useFakeTimers();

		const onSubmit = vi.fn();
		const onCancel = vi.fn();
		const onTimeout = vi.fn();
		const tui = { requestRender: vi.fn(), requestComponentRender: vi.fn() } as unknown as TUI;

		const component = new HookInputComponent("Prompt", undefined, onSubmit, onCancel, {
			timeout: 1_000,
			tui,
			onTimeout,
		});

		vi.advanceTimersByTime(900);
		component.handleInput("a");

		vi.advanceTimersByTime(900);
		component.handleInput("\x7f");

		vi.advanceTimersByTime(900);
		expect(onTimeout).not.toHaveBeenCalled();
		expect(onCancel).not.toHaveBeenCalled();

		vi.advanceTimersByTime(200);
		expect(onTimeout).toHaveBeenCalledTimes(1);
		expect(onCancel).toHaveBeenCalledTimes(1);

		component.dispose();
	});

	it("preserves submit behavior", () => {
		vi.useFakeTimers();

		const onSubmit = vi.fn();
		const onCancel = vi.fn();
		const onTimeout = vi.fn();
		const tui = { requestRender: vi.fn(), requestComponentRender: vi.fn() } as unknown as TUI;

		const component = new HookInputComponent("Prompt", undefined, onSubmit, onCancel, {
			timeout: 1_000,
			tui,
			onTimeout,
		});

		component.handleInput("h");
		component.handleInput("i");
		component.handleInput("\n");

		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit).toHaveBeenCalledWith("hi");
		expect(onCancel).not.toHaveBeenCalled();
		expect(onTimeout).not.toHaveBeenCalled();

		component.dispose();
	});

	it("absorbs enhanced-paste payloads via pasteText and resets the timeout", () => {
		// Regression: enhanced-paste (kitty OSC 5522) focus routing only targets
		// components exposing a `pasteText` hook; without one the payload landed
		// in the hidden main prompt behind the dialog (#2127 contract).
		vi.useFakeTimers();

		const onSubmit = vi.fn();
		const onCancel = vi.fn();
		const onTimeout = vi.fn();
		const tui = { requestRender: vi.fn(), requestComponentRender: vi.fn() } as unknown as TUI;

		const component = new HookInputComponent("Prompt", undefined, onSubmit, onCancel, {
			timeout: 1_000,
			tui,
			onTimeout,
		});

		vi.advanceTimersByTime(900);
		component.pasteText("sk-line1\nsk-line2");

		vi.advanceTimersByTime(900);
		expect(onTimeout).not.toHaveBeenCalled();
		expect(onCancel).not.toHaveBeenCalled();

		component.handleInput("\n");

		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit).toHaveBeenCalledWith("sk-line1sk-line2");

		component.dispose();
	});

	/**
	 * HookInput used to inspect Enter/Escape before its inner Input saw paste
	 * framing. When terminal chunks split the payload, a pasted newline or
	 * interrupt closed the dialog. The inner Input must buffer both and submit
	 * only after the end marker plus a real physical Enter.
	 */
	it("keeps split credential paste bytes inside the masked input until physical Enter", () => {
		const onSubmit = vi.fn();
		const onCancel = vi.fn();
		const credential = "api\tline1\nline2\r\x03\x1b e\u0301\x7f  ";
		const component = new HookInputComponent("Credential", undefined, onSubmit, onCancel, {
			mask: DEFAULT_MASK_CHAR,
		});

		component.handleInput(PASTE_START);
		component.handleInput(credential.slice(0, 9));
		component.handleInput(credential.slice(9, 16));
		component.handleInput(credential.slice(16));

		expect(onSubmit).not.toHaveBeenCalled();
		expect(onCancel).not.toHaveBeenCalled();

		component.handleInput(PASTE_END);
		expect(onSubmit).not.toHaveBeenCalled();
		expect(onCancel).not.toHaveBeenCalled();

		component.handleInput("\r");
		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit).toHaveBeenCalledWith(credential);
		expect(onCancel).not.toHaveBeenCalled();
	});
});
