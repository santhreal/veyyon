import { beforeAll, describe, expect, it, vi } from "bun:test";
import { CommandController } from "@veyyon/coding-agent/modes/terminal/controllers/command-controller";
import type { InteractiveModeContext } from "@veyyon/coding-agent/modes/terminal/types";
import { getThemeByName, setThemeInstance } from "@veyyon/coding-agent/theme/theme";
import { useIsolatedGlobalSettings } from "../../../helpers/isolated-global-settings";

// `executeBash` initializes the GLOBAL Settings singleton itself, so a session
// stub alone leaves it loading the developer's real ~/.veyyon agent.db.
useIsolatedGlobalSettings();

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

interface ShortcutBlock {
	appendOutput(chunk: string): void;
	isTranscriptBlockFinalized(): boolean;
}

const RESULT = {
	output: "ok",
	exitCode: 0,
	cancelled: false,
	truncated: false,
	totalLines: 1,
	totalBytes: 2,
	outputLines: 1,
	outputBytes: 2,
};

/** A context stub whose session runs `execute`; `pending` names the deferred-block list each handler feeds. */
function shortcutContext(
	isStreaming: boolean,
	execute: (chunk: (piece: string) => void) => Promise<typeof RESULT>,
): { ctx: InteractiveModeContext; presented: ShortcutBlock[]; errors: string[] } {
	const presented: ShortcutBlock[] = [];
	const errors: string[] = [];
	const run = async (_input: string, onChunk: (piece: string) => void) => execute(onChunk);
	const ctx = {
		session: { isStreaming, executeBash: run, executePython: run },
		chatContainer: createContainer(),
		pendingMessagesContainer: createContainer(),
		pendingBashComponents: [],
		pendingPythonComponents: [],
		ui: { requestRender: vi.fn(), requestComponentRender: vi.fn() },
		present: (block: ShortcutBlock) => presented.push(block),
		showError: (message: string) => errors.push(message),
		refreshComposerShortcuts: vi.fn(),
		dismissWelcome: vi.fn(),
	} as unknown as InteractiveModeContext;
	return { ctx, presented, errors };
}

describe.each([
	["!", "handleBashCommand", "bashComponent", "pendingBashComponents", "Bash command failed"],
	["%", "handlePythonCommand", "pythonComponent", "pendingPythonComponents", "Python execution failed"],
] as const)("the %s shortcut", (_prefix, handler, slot, pendingList, failure) => {
	beforeAll(async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("Expected dark theme");
		setThemeInstance(theme);
	});

	it("presents its block at once, settles it with the result and releases the slot", async () => {
		const { ctx, presented, errors } = shortcutContext(false, async onChunk => {
			onChunk("o");
			return RESULT;
		});
		await new CommandController(ctx)[handler]("run", false);

		expect(presented).toHaveLength(1);
		expect(presented[0]?.isTranscriptBlockFinalized()).toBe(true);
		expect(ctx[slot]).toBeUndefined();
		expect(ctx[pendingList]).toEqual([]);
		expect(errors).toEqual([]);
	});

	it("defers its block behind a streaming turn into its own pending list", async () => {
		const { ctx, presented } = shortcutContext(true, async () => RESULT);
		await new CommandController(ctx)[handler]("run", false);

		expect(presented).toEqual([]);
		expect(ctx.pendingMessagesContainer.children).toHaveLength(1);
		expect(ctx[pendingList]).toHaveLength(1);
		expect(ctx.pendingMessagesContainer.children[0]).toBe(ctx[pendingList][0]);
		expect(ctx[pendingList][0]?.isTranscriptBlockFinalized()).toBe(true);
	});

	it("settles its block and reports a thrown failure under its own label", async () => {
		const { ctx, presented, errors } = shortcutContext(false, async () => {
			throw new Error("kernel gone");
		});
		await new CommandController(ctx)[handler]("run", false);

		expect(presented[0]?.isTranscriptBlockFinalized()).toBe(true);
		expect(errors).toEqual([`${failure}: kernel gone`]);
		expect(ctx[slot]).toBeUndefined();
	});
});
