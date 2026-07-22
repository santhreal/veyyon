import { beforeAll, describe, expect, it, vi } from "bun:test";
import { CommandController } from "@veyyon/coding-agent/modes/controllers/command-controller";
import { getThemeByName, setThemeInstance } from "@veyyon/coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@veyyon/coding-agent/modes/types";

function createContainer() {
	return {
		children: [] as unknown[],
		addChild(child: unknown) {
			this.children.push(child);
		},
	};
}

describe("bash shortcut command", () => {
	beforeAll(async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("Expected dark theme");
		setThemeInstance(theme);
	});

	it("runs interactive ! commands through the configured user shell", async () => {
		const executeBash = vi.fn().mockResolvedValue({
			output: "ok",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			totalLines: 1,
			totalBytes: 2,
			outputLines: 1,
			outputBytes: 2,
		});
		const ctx = {
			session: {
				isStreaming: false,
				executeBash,
			},
			chatContainer: createContainer(),
			pendingMessagesContainer: createContainer(),
			pendingBashComponents: [],
			ui: { requestRender: vi.fn(), requestComponentRender: vi.fn() },
			present: vi.fn(),
			showError: vi.fn(),
			// Required members of the context. Omitting them used to be tolerated by
			// `?.()` calls in the controller, which meant production silently skipped
			// the composer refresh and the welcome dismissal whenever either was
			// missing. The calls are unconditional now, so the stub supplies them.
			refreshComposerShortcuts: vi.fn(),
			dismissWelcome: vi.fn(),
		} as unknown as InteractiveModeContext;
		const controller = new CommandController(ctx);

		await controller.handleBashCommand("echo hi");

		expect(executeBash).toHaveBeenCalledWith("echo hi", expect.any(Function), {
			excludeFromContext: false,
			useUserShell: true,
		});
	});
});
