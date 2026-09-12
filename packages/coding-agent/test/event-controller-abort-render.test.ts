/**
 * WHY: abort classification must preserve persisted reasons while suppressing
 * silent and TTSR abort notices in the rendered assistant card. Drive the real
 * EventController and AssistantMessageComponent rather than asserting the shape
 * of an internal updateContent argument. Provider transport is not exercised.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@veyyon/ai";
import * as AIError from "@veyyon/ai/error";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AssistantMessageComponent } from "@veyyon/coding-agent/modes/terminal/components/transcript/assistant-message";
import { EventController } from "@veyyon/coding-agent/modes/terminal/controllers/event-controller";
import type { InteractiveModeContext } from "@veyyon/coding-agent/modes/terminal/types";
import type { AgentSessionEvent } from "@veyyon/coding-agent/session/agent-session-types";
import { SILENT_ABORT_MARKER, USER_INTERRUPT_LABEL } from "@veyyon/coding-agent/session/messages";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
import { stripAnsi } from "@veyyon/utils";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

function makeAssistantMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "draft" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "aborted",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
		...overrides,
	};
}

const fixtures: Array<{ controller: EventController; streamingComponent: AssistantMessageComponent }> = [];

function createFixture(opts: {
	streamingMessage: AssistantMessage;
	isTtsrAbortPending?: boolean;
	retryAttempt?: number;
}) {
	const streamingComponent = new AssistantMessageComponent(undefined, true, undefined, [], undefined, true);
	const requestRender = vi.fn();

	const ctxBase = {
		isInitialized: true,
		init: vi.fn(async () => {}),
		ui: { requestRender },
		statusLine: { invalidate: vi.fn() },
		streamingComponent,
		streamingMessage: opts.streamingMessage,
		pendingTools: new Map(),
		settledToolCalls: new Set<string>(),
		noteDisplayableThinkingContent: vi.fn(() => false),
	};
	const sessionMock = {
		isTtsrAbortPending: opts.isTtsrAbortPending ?? false,
		retryAttempt: opts.retryAttempt ?? 0,
	};
	const ctx = {
		...ctxBase,
		session: sessionMock,
		viewSession: sessionMock,
		clearTransientSessionUi: () => {},
		// Required members of the context. Omitting them used to be tolerated by
		// `?.()` calls in the controller, which meant production silently skipped
		// the composer refresh and the welcome dismissal whenever either was
		// missing. The calls are unconditional now, so the stub supplies them.
		refreshComposerShortcuts: vi.fn(),
		dismissWelcome: vi.fn(),
	} as unknown as InteractiveModeContext;

	const controller = new EventController(ctx);
	fixtures.push({ controller, streamingComponent });
	return { controller, ctx, streamingComponent, requestRender };
}

function renderedText(component: AssistantMessageComponent): string {
	return component.render(120).map(stripAnsi).join("\n");
}

describe("EventController #handleMessageEnd abort labeling", () => {
	let settingsState: SettingsTestState | undefined;
	beforeEach(async () => {
		settingsState = beginSettingsTest();
		await Settings.init({ inMemory: true, cwd: process.cwd() });
		await initTheme(false);
	});
	afterEach(() => {
		for (const fixture of fixtures) {
			fixture.controller.dispose();
			fixture.streamingComponent.dispose?.();
		}
		fixtures.length = 0;
		vi.restoreAllMocks();
		restoreSettingsTestState(settingsState);
		settingsState = undefined;
	});

	it("suppresses a silent marker without overwriting the persisted reason", async () => {
		const message = makeAssistantMessage({
			stopReason: "aborted",
			errorMessage: SILENT_ABORT_MARKER,
		});
		const { controller, ctx, streamingComponent } = createFixture({ streamingMessage: message });

		const event: Extract<AgentSessionEvent, { type: "message_end" }> = {
			type: "message_end",
			message,
		};
		await controller.handleEvent(event);

		const rendered = renderedText(streamingComponent);
		expect(rendered).toContain("draft");
		expect(rendered).not.toContain("Operation aborted");
		expect(rendered).not.toContain(SILENT_ABORT_MARKER);

		// Per the silent-abort contract: the controller must NOT overwrite errorMessage
		// with the operator-facing string. The marker is what drives replay-side
		// suppression, so it has to survive on the persisted message.
		expect(message.errorMessage).toBe(SILENT_ABORT_MARKER);
		// And the streamingMessage on ctx was cleared after the handler ran (lifecycle
		// guard — kept for completeness).
		expect(ctx.streamingMessage).toBeUndefined();
	});

	it("suppresses a silent-abort error ID without requiring a text marker", async () => {
		const message = makeAssistantMessage({
			stopReason: "aborted",
			errorMessage: undefined,
			errorId: AIError.create(AIError.Flag.SilentAbort),
		});
		const { controller, streamingComponent } = createFixture({ streamingMessage: message });

		await controller.handleEvent({ type: "message_end", message });

		expect(message.errorMessage).toBeUndefined();
		const rendered = renderedText(streamingComponent);
		expect(rendered).toContain("draft");
		expect(rendered).not.toContain("Operation aborted");
	});

	it("renders the generic abort reason when no reason was supplied", async () => {
		const message = makeAssistantMessage({ stopReason: "aborted", errorMessage: undefined });
		const { controller, streamingComponent } = createFixture({
			streamingMessage: message,
			isTtsrAbortPending: false,
		});

		await controller.handleEvent({ type: "message_end", message });

		// No threaded reason -> generic operator-facing label stamped in-place.
		expect(message.errorMessage).toBe("Operation aborted");

		const rendered = renderedText(streamingComponent);
		expect(rendered).toContain("draft");
		expect(rendered.split("Operation aborted").length - 1).toBe(1);
	});

	it("preserves the threaded user-interrupt reason without a redundant transcript notice", async () => {
		const message = makeAssistantMessage({ stopReason: "aborted", errorMessage: USER_INTERRUPT_LABEL });
		const { controller, streamingComponent } = createFixture({
			streamingMessage: message,
			isTtsrAbortPending: false,
		});

		await controller.handleEvent({ type: "message_end", message });

		// The persisted reason distinguishes an intentional interrupt; the
		// canonical abort policy suppresses its redundant transcript notice.
		expect(message.errorMessage).toBe(USER_INTERRUPT_LABEL);
		const rendered = renderedText(streamingComponent);
		expect(rendered).toContain("draft");
		expect(rendered).not.toContain(USER_INTERRUPT_LABEL);
		expect(rendered).not.toContain("Operation aborted");
	});

	it("suppresses a TTSR abort without persisting a generic abort reason", async () => {
		const message = makeAssistantMessage({ stopReason: "aborted", errorMessage: undefined });
		const { controller, streamingComponent } = createFixture({
			streamingMessage: message,
			isTtsrAbortPending: true,
		});

		await controller.handleEvent({ type: "message_end", message });

		// TTSR remains silent in both the persisted message and rendered card.
		expect(message.errorMessage).toBeUndefined();
		const rendered = renderedText(streamingComponent);
		expect(rendered).toContain("draft");
		expect(rendered).not.toContain("Operation aborted");
	});
});
