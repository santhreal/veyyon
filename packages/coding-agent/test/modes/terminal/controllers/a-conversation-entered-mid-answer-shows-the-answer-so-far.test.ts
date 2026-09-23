/**
 * WHY: a screen that attaches to a conversation mid-answer (entering a room
 * member, `/resume` of a running hand-off, viewing an agent) rebuilds the
 * transcript from the finished messages, and the message being written is not
 * one of them. Before `EventController.resumeTurn`, the answer so far appeared
 * only when the next delta arrived; a conversation whose provider was slow to
 * send one showed its prompt and nothing under it, although the room view had
 * drawn the answer a moment earlier.
 *
 * The class: every attach path rebuilds, then resumes. This suite is the
 * contract of the one method those paths share: the answer so far is on screen
 * at once (not re-typed by the smooth reveal), the turn is armed, the next delta
 * extends the same block rather than opening a second, and a session that is
 * not mid-answer gets nothing.
 *
 * What it does NOT catch: a caller that forgets to call `resumeTurn` after its
 * rebuild. The room controller and live `/resume` paths call it; their own
 * suites drive them.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage, Usage } from "@veyyon/ai";
import { Settings, settings } from "@veyyon/coding-agent/config/settings";
import { AssistantMessageComponent } from "@veyyon/coding-agent/modes/terminal/components/transcript/assistant-message";
import { TranscriptContainer } from "@veyyon/coding-agent/modes/terminal/components/transcript/transcript-container";
import { EventController } from "@veyyon/coding-agent/modes/terminal/controllers/event-controller";
import type { InteractiveModeContext } from "@veyyon/coding-agent/modes/terminal/types";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import type { AgentSessionEvent } from "@veyyon/coding-agent/session/agent-session-types";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
import type { TUI } from "@veyyon/tui";
import {
	beginSettingsTest,
	restoreSettingsTestState,
	type SettingsTestState,
} from "../../../helpers/settings-test-state";

const SO_FAR = "Here is the list so far: one, two, three";
const NEXT = " and four";

function zeroUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function answer(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "cursor",
		provider: "cursor",
		model: "cursor-model",
		stopReason: "stop",
		usage: zeroUsage(),
		timestamp: 1,
	};
}

interface Fixture {
	controller: EventController;
	chatContainer: TranscriptContainer;
	/** The turn events the controller armed itself with. */
	armed: string[];
	emit(event: AgentSessionEvent): Promise<void>;
}

/**
 * A real EventController over a real transcript container, attached to a
 * session that is `streaming` and has `partial` in flight. `agent_start` is
 * recorded rather than run: arming the loader is the working-loader suites'
 * contract, and here only whether the turn was armed matters.
 */
function attached(options: { streaming: boolean; partial: AssistantMessage | null }): Fixture {
	const chatContainer = new TranscriptContainer();
	let listener: ((event: AgentSessionEvent) => Promise<void>) | undefined;
	const session = {
		isStreaming: options.streaming,
		agent: { state: { streamMessage: options.partial } },
		messages: [],
		subscribe: (next: (event: AgentSessionEvent) => Promise<void>) => {
			listener = next;
			return () => {};
		},
		getToolByName: () => undefined,
		extensionRunner: undefined,
		isTtsrAbortPending: false,
		retryAttempt: 0,
	};
	const ctx = {
		isInitialized: true,
		init: vi.fn(async () => {}),
		ui: { requestRender: vi.fn(), requestComponentRender: vi.fn(), imageBudget: undefined } as unknown as TUI,
		settings,
		chatContainer,
		pendingTools: new Map(),
		settledToolCalls: new Set<string>(),
		toolOutputExpanded: false,
		effectiveHideThinkingBlock: false,
		proseOnlyThinking: true,
		statusLine: { invalidate: vi.fn() },
		noteDisplayableThinkingContent: vi.fn(() => false),
		ensureLoadingAnimation: vi.fn(),
		session,
		viewSession: session,
		sessionManager: { getCwd: () => process.cwd() },
		showWarning: vi.fn(),
		showPinnedError: vi.fn(),
		clearTransientSessionUi: vi.fn(),
		lastAssistantUsage: zeroUsage(),
		refreshComposerShortcuts: vi.fn(),
		dismissWelcome: vi.fn(),
	} as unknown as InteractiveModeContext;
	const controller = new EventController(ctx);
	const armed: string[] = [];
	const handle = controller.handleEvent.bind(controller);
	controller.handleEvent = async (event: AgentSessionEvent) => {
		if (event.type === "agent_start") {
			armed.push(event.type);
			return;
		}
		await handle(event);
	};
	controller.attachTo(session as unknown as AgentSession);
	return {
		controller,
		chatContainer,
		armed,
		emit: async event => {
			await listener?.(event);
		},
	};
}

function assistantBlocks(chatContainer: TranscriptContainer): number {
	return chatContainer.children.filter(child => child instanceof AssistantMessageComponent).length;
}

function screen(chatContainer: TranscriptContainer): string {
	return chatContainer.render(100).join("\n");
}

describe("a conversation entered mid-answer", () => {
	let settingsState: SettingsTestState | undefined;
	let fixture: Fixture | undefined;

	beforeAll(async () => {
		await initTheme(false);
	});

	beforeEach(async () => {
		settingsState = beginSettingsTest();
		// Smooth streaming on: a resumed answer that re-typed itself from nothing
		// would show an empty block on the first frame.
		await Settings.init({ inMemory: true, overrides: { "display.smoothStreaming": true } });
	});

	afterEach(() => {
		fixture?.controller.resetTranscriptAnchors();
		fixture = undefined;
		vi.restoreAllMocks();
		restoreSettingsTestState(settingsState);
		settingsState = undefined;
	});

	it("shows the answer so far at once and arms the turn", async () => {
		fixture = attached({ streaming: true, partial: answer(SO_FAR) });

		await fixture.controller.resumeTurn();

		expect(fixture.armed).toEqual(["agent_start"]);
		expect(assistantBlocks(fixture.chatContainer)).toBe(1);
		expect(screen(fixture.chatContainer)).toContain(SO_FAR);
	});

	it("extends that answer with the next delta instead of opening a second one", async () => {
		fixture = attached({ streaming: true, partial: answer(SO_FAR) });
		await fixture.controller.resumeTurn();

		await fixture.emit({
			type: "message_update",
			message: answer(SO_FAR + NEXT),
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: NEXT, partial: answer(SO_FAR + NEXT) },
		} as AgentSessionEvent);

		expect(assistantBlocks(fixture.chatContainer)).toBe(1);
	});

	it("arms the turn and opens nothing while the first token has not arrived", async () => {
		fixture = attached({ streaming: true, partial: null });

		await fixture.controller.resumeTurn();

		expect(fixture.armed).toEqual(["agent_start"]);
		expect(assistantBlocks(fixture.chatContainer)).toBe(0);
	});

	it("leaves a conversation that is not answering as the rebuild drew it", async () => {
		fixture = attached({ streaming: false, partial: answer(SO_FAR) });

		await fixture.controller.resumeTurn();

		expect(fixture.armed).toEqual([]);
		expect(assistantBlocks(fixture.chatContainer)).toBe(0);
	});
});
