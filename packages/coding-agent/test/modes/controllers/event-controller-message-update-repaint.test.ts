/**
 * Contract: message_update must not schedule full-tree repaints on every provider
 * delta when smooth streaming already paces assistant-text paints at 30fps.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@veyyon/ai";
import { resetSettingsForTest, Settings, settings } from "@veyyon/coding-agent/config/settings";
import { EventController } from "@veyyon/coding-agent/modes/controllers/event-controller";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@veyyon/coding-agent/modes/types";
import type { AgentSessionEvent } from "@veyyon/coding-agent/session/agent-session";

beforeAll(async () => {
	await initTheme();
});

function makeStreamingMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "stop",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
	};
}

function createFixture() {
	const requestRender = vi.fn();
	const requestComponentRender = vi.fn();
	const streamingComponent = {
		updateContent: vi.fn(),
		markTranscriptBlockFinalized: vi.fn(),
		setHideThinkingBlock: vi.fn(),
	};
	const ctx = {
		isInitialized: true,
		init: vi.fn(async () => {}),
		ui: { requestRender, requestComponentRender },
		settings,
		statusLine: { invalidate: vi.fn() },
		updateEditorTopBorder: vi.fn(),
		streamingComponent,
		streamingMessage: makeStreamingMessage(""),
		pendingTools: new Map(),
		noteDisplayableThinkingContent: vi.fn(() => false),
		chatContainer: { addChild: vi.fn() },
		toolOutputExpanded: false,
		effectiveHideThinkingBlock: false,
		proseOnlyThinking: true,
		session: { getToolByName: () => undefined, isAborting: false },
		viewSession: { getToolByName: () => undefined, isStreaming: true },
		sessionManager: { getCwd: () => process.cwd() },
		ensureLoadingAnimation: vi.fn(),
		setWorkingMessage: vi.fn(),
	} as unknown as InteractiveModeContext;

	return { controller: new EventController(ctx), requestRender, requestComponentRender, streamingComponent };
}

async function dispatch(controller: EventController, message: AssistantMessage) {
	await controller.handleEvent({
		type: "message_update",
		message,
		assistantMessageEvent: undefined as never,
	} as Extract<AgentSessionEvent, { type: "message_update" }>);
}

describe("EventController message_update repaint scope", () => {
	afterEach(() => {
		resetSettingsForTest();
		vi.restoreAllMocks();
	});

	it("skips repaint scheduling for smooth text-only deltas", async () => {
		await Settings.init({ inMemory: true, cwd: process.cwd() });
		settings.set("display.smoothStreaming", true);
		const { controller, requestRender, requestComponentRender } = createFixture();

		for (let i = 1; i <= 24; i++) {
			await dispatch(controller, makeStreamingMessage("x".repeat(i * 40)));
		}

		expect(requestRender).not.toHaveBeenCalled();
		expect(requestComponentRender).not.toHaveBeenCalled();
	});

	it("component-repaints the streaming block on each delta when smooth streaming is off", async () => {
		await Settings.init({ inMemory: true, cwd: process.cwd() });
		settings.set("display.smoothStreaming", false);
		const { controller, requestRender, requestComponentRender, streamingComponent } = createFixture();

		await dispatch(controller, makeStreamingMessage("hello"));
		await dispatch(controller, makeStreamingMessage("hello world"));

		expect(requestRender).not.toHaveBeenCalled();
		expect(requestComponentRender).toHaveBeenCalledTimes(2);
		for (const call of requestComponentRender.mock.calls) {
			expect(call[0]).toBe(streamingComponent);
		}
	});
});
