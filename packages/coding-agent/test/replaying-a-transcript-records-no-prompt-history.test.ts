/**
 * WHY. Replaying a session transcript put each user prompt back on the composer's up-arrow ring
 * through the call a submission uses, and that call also writes the prompt to the prompt-history
 * database. Every resume and every rebuild of the transcript (a focus switch, a compaction, a closed
 * overlay) appended the session's prompts to the database again: a profile's database held each
 * prompt dozens of times, Ctrl+R listed the copies, and resuming a 600-prompt session spent about
 * 80ms inserting and indexing rows nobody typed.
 *
 * The class is a transcript replay that writes to the history database. Every replay reaches the
 * editor through the UiHelpers populate-history path, so the suite drives each UiHelpers entry point
 * that replays with history population on, against a real CustomEditor and a real HistoryStorage,
 * and asserts the database holds only what was submitted while the up-arrow still recalls the
 * replayed prompts. A submission through the same editor still writes, so the suite cannot pass by
 * silencing the database.
 *
 * Gap: a replay path that bypasses UiHelpers and calls `editor.addToHistory` itself is not swept.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import type { AgentMessage } from "@veyyon/agent-core";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { CustomEditor } from "@veyyon/coding-agent/modes/terminal/components/composer/custom-editor";
import type { InteractiveModeContext } from "@veyyon/coding-agent/modes/terminal/types";
import { UiHelpers } from "@veyyon/coding-agent/modes/terminal/utils/ui-helpers";
import { getEditorTheme, initTheme } from "@veyyon/coding-agent/theme/theme";
import { HistoryStorage } from "@veyyon/kernel/session/history-storage";
import type { SessionContext } from "@veyyon/kernel/session/session-context";
import { Container } from "@veyyon/tui";
import { TempDir } from "@veyyon/utils";

const UP = "\x1b[A";
const REPLAYED = ["first prompt", "second prompt", "third prompt"];

function transcript(): SessionContext {
	const messages: AgentMessage[] = REPLAYED.map((text, index) => ({ role: "user", content: text, timestamp: index }));
	return {
		messages,
		thinkingLevel: "off",
		serviceTier: undefined,
		models: {},
		injectedTtsrRules: [],
		selectedMCPToolNames: [],
		hasPersistedMCPToolSelection: false,
		mode: "none",
	};
}

function fixture(editor: CustomEditor): { ctx: InteractiveModeContext; helpers: UiHelpers } {
	const chatContainer = new Container();
	const context = transcript();
	let helpers: UiHelpers;
	const ctx = {
		chatContainer,
		pendingMessagesContainer: new Container(),
		pendingBashComponents: [],
		pendingPythonComponents: [],
		pendingTools: new Map(),
		settledToolCalls: new Set<string>(),
		statusLine: { invalidate: vi.fn() },
		updateEditorBorderColor: vi.fn(),
		ui: { requestRender: vi.fn(), imageBudget: undefined },
		resetTranscript: () => chatContainer.clear(),
		settings: { get: () => false },
		toolOutputExpanded: false,
		hideThinkingBlock: false,
		focusedAgentId: undefined,
		editor,
		viewSession: {
			buildTranscriptSessionContext: () => context,
			getToolByName: () => undefined,
			extensionRunner: undefined,
			sessionManager: { getEntries: () => [], getCwd: () => "/repo", putBlobSync: vi.fn() },
		},
		renderSessionContext: (value: SessionContext, options?: { updateFooter?: boolean; populateHistory?: boolean }) =>
			helpers.renderSessionContext(value, options),
		showStatus: vi.fn(),
		refreshComposerShortcuts: vi.fn(),
		dismissWelcome: vi.fn(),
	} as unknown as InteractiveModeContext;
	helpers = new UiHelpers(ctx);
	return { ctx, helpers };
}

/** Every UiHelpers entry point that replays a transcript with history population on. */
const REPLAYS: Record<string, (helpers: UiHelpers) => void> = {
	renderInitialMessages: helpers => helpers.renderInitialMessages(),
	renderSessionContext: helpers => helpers.renderSessionContext(transcript(), { populateHistory: true }),
	addMessageToChat: helpers => {
		for (const message of transcript().messages) helpers.addMessageToChat(message, { populateHistory: true });
	},
};

let tempDir: TempDir | undefined;

beforeAll(() => {
	initTheme();
});

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	HistoryStorage.resetInstance();
	tempDir = TempDir.createSync("@veyyon-replay-history-");
});

afterEach(() => {
	HistoryStorage.resetInstance();
	tempDir?.removeSync();
	tempDir = undefined;
	resetSettingsForTest();
	vi.restoreAllMocks();
});

describe("a transcript replay records no prompt history", () => {
	it.each(Object.keys(REPLAYS))(
		"%s puts the replayed prompts on the up-arrow and none in the database",
		async name => {
			const storage = HistoryStorage.open(path.join(tempDir!.path(), "history.db"));
			const editor = new CustomEditor(getEditorTheme());
			editor.setHistoryStorage(storage);
			const { helpers } = fixture(editor);

			REPLAYS[name]!(helpers);
			editor.addToHistory("typed prompt");
			// The drain writes in submission order, so this write lands after every earlier add.
			await storage.add("flush marker");

			expect(storage.getRecent(100).map(entry => entry.prompt)).toEqual(["flush marker", "typed prompt"]);
			const recalled: string[] = [];
			for (let i = 0; i < 4; i++) {
				editor.handleInput(UP);
				recalled.push(editor.getText());
			}
			expect(recalled).toEqual(["typed prompt", "third prompt", "second prompt", "first prompt"]);
		},
	);
});
