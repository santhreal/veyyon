/**
 * Contract: message_update must not schedule full-tree repaints on every provider
 * delta when smooth streaming already paces assistant-text paints at 30fps.
 *
 * WHY (visible blocks). Under smooth streaming the streaming block repaints on a delta only when a
 * block after the first turns visible, since that changes the transcript layout. The controller
 * remembers which blocks it already counted so a delta does not re-read every growing block; a
 * memo that outlives its message, skips a block kind, or counts a placeholder block misses or adds
 * a layout repaint.
 *
 * THE CLASS. Each prose block kind (text, thinking) in each position, starting as each placeholder
 * the transcript treats as empty, across two assistant messages in a row: a block repaints once on
 * the delta it turns visible, never while it grows, and never while it is a placeholder.
 *
 * WHAT THIS DOES NOT CATCH. A memo that re-reads blocks it already counted repaints the same way
 * and passes; that cost is CPU, not layout. A new content block kind that carries prose is not in
 * the sweep until it is added to PROSE_BLOCKS.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@veyyon/ai";
import { resetSettingsForTest, Settings, settings } from "@veyyon/coding-agent/config/settings";
import { EventController } from "@veyyon/coding-agent/modes/terminal/controllers/event-controller";
import type { InteractiveModeContext } from "@veyyon/coding-agent/modes/terminal/types";
import type { AgentSessionEvent } from "@veyyon/coding-agent/session/agent-session-types";
import { initTheme } from "@veyyon/coding-agent/theme/theme";

beforeAll(async () => {
	await initTheme();
});

function makeStreamingMessage(content: string | AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content: typeof content === "string" ? [{ type: "text", text: content }] : content,
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
		streamingComponent,
		streamingMessage: makeStreamingMessage(""),
		pendingTools: new Map(),
		settledToolCalls: new Set<string>(),
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
		// Required members of the context. Omitting them used to be tolerated by
		// `?.()` calls in the controller, which meant production silently skipped
		// the composer refresh and the welcome dismissal whenever either was
		// missing. The calls are unconditional now, so the stub supplies them.
		refreshComposerShortcuts: vi.fn(),
		dismissWelcome: vi.fn(),
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

async function startAssistant(controller: EventController) {
	await controller.handleEvent({
		type: "message_start",
		message: makeStreamingMessage([]),
	} as Extract<AgentSessionEvent, { type: "message_start" }>);
}

type ProseBlock = AssistantMessage["content"][number];

/** Every content block kind the transcript reveals as prose. */
const PROSE_BLOCKS: Record<string, (value: string) => ProseBlock> = {
	text: value => ({ type: "text", text: value }),
	thinking: value => ({ type: "thinking", thinking: value }),
};

/** Block text the transcript treats as empty: nothing but dots, ellipses and whitespace. */
const PLACEHOLDERS = ["", ".", "...", "\u2026", " \t\r\n", ". \u2026 ."];

/**
 * One streamed message whose blocks each start as `placeholder`, turn visible, then grow. Each step
 * states whether that delta repaints the streaming block: only a block after the first turning
 * visible changes the layout; the first block's growth is paced by the reveal frame.
 */
function stream(kinds: string[], placeholder: string): { content: ProseBlock[]; repaints: boolean }[] {
	const steps: { content: ProseBlock[]; repaints: boolean }[] = [];
	const settled: ProseBlock[] = [];
	kinds.forEach((kind, index) => {
		const block = PROSE_BLOCKS[kind]!;
		const words = `block ${index} of ${kind}`;
		steps.push({ content: [...settled, block(placeholder)], repaints: false });
		steps.push({ content: [...settled, block(placeholder)], repaints: false });
		steps.push({ content: [...settled, block(words)], repaints: index > 0 });
		steps.push({ content: [...settled, block(`${words} grows`)], repaints: false });
		steps.push({ content: [...settled, block(`${words} grows further`)], repaints: false });
		settled.push(block(`${words} grows further`));
	});
	return steps;
}

describe("EventController repaints a streamed block once when it turns visible", () => {
	afterEach(() => {
		vi.useRealTimers();
		resetSettingsForTest();
		vi.restoreAllMocks();
	});

	const kinds = Object.keys(PROSE_BLOCKS);
	const orders = kinds.flatMap(first => kinds.flatMap(second => kinds.map(third => [first, second, third])));
	for (const order of orders) {
		for (const placeholder of PLACEHOLDERS) {
			it(`for blocks ${order.join(", ")} starting as ${JSON.stringify(placeholder)}`, async () => {
				// The reveal frame never fires: every repaint observed comes from a delta.
				vi.useFakeTimers();
				await Settings.init({ inMemory: true, cwd: process.cwd() });
				settings.set("display.smoothStreaming", true);
				const { controller, requestComponentRender } = createFixture();
				const steps = stream(order, placeholder);

				for (let message = 0; message < 2; message++) {
					await startAssistant(controller);
					const observed: number[] = [];
					for (const step of steps) {
						const before = requestComponentRender.mock.calls.length;
						await dispatch(controller, makeStreamingMessage(step.content));
						observed.push(requestComponentRender.mock.calls.length - before);
					}
					expect(observed).toEqual(steps.map(step => (step.repaints ? 1 : 0)));
				}
			});
		}
	}
});

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
