import { describe, expect, it, vi } from "bun:test";
import type { InteractiveModeContext } from "@veyyon/coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@veyyon/coding-agent/slash-commands/builtin-registry";

function createRuntimeHarness() {
	const setText = vi.fn();
	const showStatus = vi.fn();
	const showSettingsSelector = vi.fn();
	return {
		setText,
		showStatus,
		showSettingsSelector,
		runtime: {
			ctx: {
				editor: { setText } as unknown as InteractiveModeContext["editor"],
				showStatus,
				showSettingsSelector,
			} as unknown as InteractiveModeContext,
		},
	};
}

describe("/statusline slash command", () => {
	it("opens Settings pre-selected on the composer footline toggle", async () => {
		const harness = createRuntimeHarness();

		expect(await executeBuiltinSlashCommand("/statusline", harness.runtime)).toBe(true);

		expect(harness.showSettingsSelector).toHaveBeenCalledTimes(1);
		// The toggle, not the preset: the preset row is hidden while the footline is off, and a
		// jump to a hidden row falls back to the tab's default (Dark Theme).
		expect(harness.showSettingsSelector).toHaveBeenCalledWith("statusLine.enabled");
		expect(harness.showStatus).not.toHaveBeenCalled();
		expect(harness.setText).toHaveBeenCalledWith("");
	});
});
