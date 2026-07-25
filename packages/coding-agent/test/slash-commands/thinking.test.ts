import { describe, expect, it, vi } from "bun:test";
import { DEFAULT_EFFORT_POINTER } from "@veyyon/coding-agent/config/effort-resolver";
import type { InteractiveModeContext } from "@veyyon/coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@veyyon/coding-agent/slash-commands/builtin-registry";

/**
 * `/thinking` (and its `/effort` alias) changes THIS SESSION and says where the
 * saved default lives.
 *
 * It used to call `setThinkingLevel(level, /* persist *\/ true)`, which rewrote the
 * profile-wide default, while the cycle keybinding did not persist at all. The
 * same change therefore stuck or evaporated depending on how you made it, and
 * there was no way to try an effort without keeping it — the core of the
 * operator's "effort level is very muddled" report (2026-07-24). The durable
 * value now lives in one place, the Default Effort list in settings, which is
 * why every message here names it.
 */

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

	it("sets a named level for this session only, without touching the saved default", async () => {
		const h = createRuntime();

		const handled = await executeBuiltinSlashCommand("/thinking high", h.runtime);

		expect(handled).toBe(true);
		// `false` is the contract, not an incidental argument: `true` here is the
		// old behaviour that silently rewrote the profile default.
		expect(h.setThinkingLevel).toHaveBeenCalledWith("high", false);
		expect(h.updateEditorBorderColor).toHaveBeenCalledTimes(1);
		expect(h.showStatus).toHaveBeenCalledWith(`Effort set to high for this session. ${DEFAULT_EFFORT_POINTER}`);
		expect(h.showThinkingSelector).not.toHaveBeenCalled();
		expect(h.setText).toHaveBeenCalledWith("");
	});

	it("points at the settings list rather than leaving the default a mystery", async () => {
		// A session-only command has to say where the durable value is, or the user
		// simply cannot find it: the answer used to be "type the command", which
		// was also the answer for the temporary change.
		const h = createRuntime();

		await executeBuiltinSlashCommand("/thinking high", h.runtime);

		const message = h.showStatus.mock.calls[0]?.[0] as string;
		expect(message).toContain("this session");
		expect(message).toContain("/settings");
		expect(message).toContain("Default Effort");
	});

	it("accepts auto and maps it to the auto level", async () => {
		const h = createRuntime();

		await executeBuiltinSlashCommand("/thinking auto", h.runtime);

		expect(h.setThinkingLevel).toHaveBeenCalledWith("auto", false);
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
		expect(h.setThinkingLevel).toHaveBeenCalledWith("high", false);
		expect(h.showStatus).toHaveBeenCalledWith(`Effort set to high for this session. ${DEFAULT_EFFORT_POINTER}`);
	});
});
