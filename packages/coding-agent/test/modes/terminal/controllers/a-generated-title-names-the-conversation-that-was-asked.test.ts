/**
 * WHY: the first substantial prompt of a conversation asks a title model for a
 * name, and the name arrives seconds later. The controller wrote it to whatever
 * conversation `ctx` pointed at by then, and `ctx` follows the screen: a prompt
 * sent in a room member and followed by a switch named the conversation the
 * screen had moved to (a greeting-only conversation came out as "Run ls -la
 * command"). A `/new` hand-off moves the screen the same way.
 *
 * The contract: the title lands on the conversation the prompt was sent to,
 * whatever is on screen when it arrives, and never on the one on screen.
 *
 * What it does NOT catch: the title text itself (the title-generator suites own
 * it), or a title requested by a path other than the composer (the replan
 * refresh names its own session inside `AgentSession`).
 */

import { afterEach, describe, expect, it, vi } from "bun:test";
import type { ImageContent } from "@veyyon/ai";
import { InputController } from "@veyyon/coding-agent/modes/terminal/controllers/input-controller";
import type { InteractiveModeContext } from "@veyyon/coding-agent/modes/terminal/types";
import * as titleGenerator from "@veyyon/coding-agent/utils/title-generator";

interface Conversation {
	readonly session: InteractiveModeContext["session"];
	readonly sessionManager: InteractiveModeContext["sessionManager"];
	readonly named: Array<[string, string]>;
}

function conversation(id: string): Conversation {
	const named: Array<[string, string]> = [];
	let name: string | undefined;
	const session = {
		sessionId: id,
		isStreaming: false,
		isCompacting: false,
		isBashRunning: false,
		isEvalRunning: false,
		extensionRunner: undefined,
		modelRegistry: {},
		model: undefined,
		agent: { metadataForProvider: () => undefined },
		titleSystemPrompt: undefined,
		obfuscateProviderText: (text: string) => text,
		sideComplete: undefined,
		prompt: vi.fn(async () => {}),
		steer: vi.fn(async () => {}),
		queuedMessageCount: 0,
		getQueuedMessages: () => ({ steering: [], followUp: [] }),
	} as unknown as InteractiveModeContext["session"];
	const sessionManager = {
		getSessionName: () => name,
		setSessionName: async (title: string, source: string) => {
			name = title;
			named.push([title, source]);
		},
	} as unknown as InteractiveModeContext["sessionManager"];
	return { session, sessionManager, named };
}

function harness(onScreen: Conversation) {
	let editorText = "";
	const editor = {
		onSubmit: undefined as ((text: string) => Promise<void>) | undefined,
		pendingImages: [] as ImageContent[],
		pendingImageLinks: [] as (string | undefined)[],
		setText(text: string) {
			editorText = text;
		},
		getText() {
			return editorText;
		},
		addToHistory: vi.fn(),
		setActionKeys: vi.fn(),
		setCustomKeyHandler: vi.fn(),
		clearCustomKeyHandlers: vi.fn(),
	};
	const ctx = {
		editor,
		ui: { requestRender: vi.fn(), scrollToLiveTail: vi.fn() },
		session: onScreen.session,
		sessionManager: onScreen.sessionManager,
		settings: { get: () => "online" },
		compactionQueuedMessages: [],
		fileSlashCommands: new Set<string>(),
		locallySubmittedUserSignatures: new Set<string>(),
		isKnownSlashCommand: () => false,
		recordLocalSubmission: () => () => {},
		withLocalSubmission: async <T>(_text: string, fn: () => Promise<T>) => fn(),
		onInputCallback: undefined,
		updatePendingMessagesDisplay: vi.fn(),
		flushPendingBashComponents: vi.fn(),
		showError: vi.fn(),
		isBashMode: false,
		isPythonMode: false,
		refreshComposerShortcuts: vi.fn(),
		dismissWelcome: vi.fn(),
	} as unknown as InteractiveModeContext;
	const controller = new InputController(ctx);
	controller.setupEditorSubmitHandler();
	return { ctx, editor };
}

async function settle(): Promise<void> {
	for (let i = 0; i < 8; i++) await Promise.resolve();
}

describe("a generated title", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("names the conversation the prompt was sent to, after the screen moved to another", async () => {
		vi.spyOn(titleGenerator, "autoTitleDisabled").mockReturnValue(false);
		const title = Promise.withResolvers<string | null>();
		const asked = vi.spyOn(titleGenerator, "generateSessionTitle").mockReturnValue(title.promise);
		const sent = conversation("sent");
		const other = conversation("other");
		const { ctx, editor } = harness(sent);

		await editor.onSubmit?.("split the tokenizer out of the parser");
		expect(asked).toHaveBeenCalledTimes(1);

		// The screen moves before the title model answers.
		ctx.session = other.session;
		ctx.sessionManager = other.sessionManager;
		title.resolve("Tokenizer split");
		await settle();

		expect({ sent: sent.named, other: other.named }).toEqual({
			sent: [["Tokenizer split", "auto"]],
			other: [],
		});
	});
});
