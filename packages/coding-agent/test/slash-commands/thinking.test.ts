import { describe, expect, it, vi } from "bun:test";
import type { InteractiveModeContext } from "@veyyon/coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@veyyon/coding-agent/slash-commands/builtin-registry";

function createRuntime() {
	const setThinkingLevel = vi.fn();
	const getAvailableThinkingLevels = vi.fn(() => ["minimal", "low", "medium", "high", "xhigh"]);
	const configuredThinkingLevel = vi.fn(() => "medium");
	const showThinkingSelector = vi.fn();
	const showStatus = vi.fn();
	const setText = vi.fn();
	const updateEditorBorderColor = vi.fn();
	const invalidate = vi.fn();
	const requestRender = vi.fn();
	return {
		setThinkingLevel,
		showThinkingSelector,
		showStatus,
		setText,
		updateEditorBorderColor,
		runtime: {
			ctx: {
				session: {
					setThinkingLevel,
					getAvailableThinkingLevels,
					configuredThinkingLevel,
				} as unknown as InteractiveModeContext["session"],
				editor: { setText } as unknown as InteractiveModeContext["editor"],
				statusLine: { invalidate } as unknown as InteractiveModeContext["statusLine"],
				ui: { requestRender } as unknown as InteractiveModeContext["ui"],
				showThinkingSelector,
				showStatus,
				updateEditorBorderColor,
			} as unknown as InteractiveModeContext,
		},
	};
}

describe("/thinking slash command", () => {
	it("opens the thinking-effort picker with no argument", async () => {
		const h = createRuntime();

		const handled = await executeBuiltinSlashCommand("/thinking", h.runtime);

		expect(handled).toBe(true);
		expect(h.showThinkingSelector).toHaveBeenCalledTimes(1);
		expect(h.setThinkingLevel).not.toHaveBeenCalled();
		expect(h.setText).toHaveBeenCalledWith("");
	});

	it("sets and persists a named level, repainting the border and status line", async () => {
		const h = createRuntime();

		const handled = await executeBuiltinSlashCommand("/thinking high", h.runtime);

		expect(handled).toBe(true);
		expect(h.setThinkingLevel).toHaveBeenCalledWith("high", true);
		expect(h.updateEditorBorderColor).toHaveBeenCalledTimes(1);
		expect(h.showStatus).toHaveBeenCalledWith("Thinking effort set to high.");
		expect(h.showThinkingSelector).not.toHaveBeenCalled();
		expect(h.setText).toHaveBeenCalledWith("");
	});

	it("accepts auto and maps it to the auto level", async () => {
		const h = createRuntime();

		await executeBuiltinSlashCommand("/thinking auto", h.runtime);

		expect(h.setThinkingLevel).toHaveBeenCalledWith("auto", true);
	});

	it("rejects an unknown level and lists the valid choices instead of setting it", async () => {
		const h = createRuntime();

		const handled = await executeBuiltinSlashCommand("/thinking bogus", h.runtime);

		expect(handled).toBe(true);
		expect(h.setThinkingLevel).not.toHaveBeenCalled();
		expect(h.showStatus).toHaveBeenCalledWith(
			"Unknown thinking level: bogus. Choose one of: minimal, low, medium, high, xhigh, auto.",
		);
	});

	it("routes the /effort alias to the same handler", async () => {
		const h = createRuntime();

		const handled = await executeBuiltinSlashCommand("/effort high", h.runtime);

		expect(handled).toBe(true);
		expect(h.setThinkingLevel).toHaveBeenCalledWith("high", true);
		expect(h.showStatus).toHaveBeenCalledWith("Thinking effort set to high.");
	});
});
