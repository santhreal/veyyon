/**
 * A builtin slash command submitted as a follow-up is run before anything is queued, and the
 * line as typed is what Up Arrow recalls. A command that hands back a remainder (`/loop 10 fix
 * bug` hands back `fix bug`) sends only that remainder as the prompt, and the draft it clears
 * records that remainder after the typed line; a command that consumes the whole line sends
 * nothing.
 *
 * WHY THIS SUITE EXISTS. Enter and Ctrl+Enter used to carry two copies of this rule, and a fix
 * to one was a fix to half of the keybindings. Both handlers now share one method, and this
 * suite pins its contract from the follow-up side, where no other suite drove a slash command.
 *
 * WHAT IT DOES NOT CATCH: a builtin whose handler is wrong. `/loop` is driven for real through
 * the dispatcher, but its `handleLoopCommand` is the context's, stubbed here to return the
 * inline prompt the way the terminal's does.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { InputController } from "@veyyon/coding-agent/modes/terminal/controllers/input-controller";
import type { InteractiveModeContext } from "@veyyon/coding-agent/modes/terminal/types";

interface PromptOptionsLike {
	streamingBehavior?: "steer" | "followUp";
}

function streamingContext(editorText: string, loopPrompt: string | undefined) {
	const history: string[] = [];
	const prompts: Array<{ text: string; behavior: string | undefined }> = [];
	let text = editorText;
	const ctx = {
		editor: {
			setText(value: string) {
				text = value;
			},
			getText: () => text,
			getExpandedText: () => text,
			addToHistory: (line: string) => {
				history.push(line);
			},
			pendingImages: [],
			pendingImageLinks: [],
			clearDraft(line?: string) {
				if (line !== undefined) this.addToHistory(line);
				this.setText("");
			},
		},
		ui: { requestRender: vi.fn(), scrollToLiveTail: vi.fn() },
		skillCommands: new Map<string, string>(),
		session: {
			isStreaming: true,
			isCompacting: false,
			isBashRunning: false,
			isEvalRunning: false,
			extensionRunner: undefined,
			prompt: async (value: string, options?: PromptOptionsLike) => {
				prompts.push({ text: value, behavior: options?.streamingBehavior });
			},
		},
		handleLoopCommand: async (_args: string) => loopPrompt,
		loopModeEnabled: false,
		compactionQueuedMessages: [],
		locallySubmittedUserSignatures: new Set<string>(),
		updatePendingMessagesDisplay: vi.fn(),
		showError: vi.fn(),
		withLocalSubmission: async (_text: string, fn: () => unknown) => fn(),
		refreshComposerShortcuts: vi.fn(),
		dismissWelcome: vi.fn(),
	} as unknown as InteractiveModeContext;
	return { ctx, history, prompts };
}

describe("a follow-up slash command", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("sends only the remainder the command hands back, and recalls the line as typed before it", async () => {
		const { ctx, history, prompts } = streamingContext("/loop 10 fix bug", "fix bug");

		await new InputController(ctx).handleFollowUp();

		expect(prompts).toEqual([{ text: "fix bug", behavior: "followUp" }]);
		expect(history).toEqual(["/loop 10 fix bug", "fix bug"]);
	});

	it("sends nothing when the command consumed the whole line, and still recalls it", async () => {
		const { ctx, history, prompts } = streamingContext("/loop", undefined);

		await new InputController(ctx).handleFollowUp();

		expect(prompts).toEqual([]);
		expect(history).toEqual(["/loop"]);
	});
});
