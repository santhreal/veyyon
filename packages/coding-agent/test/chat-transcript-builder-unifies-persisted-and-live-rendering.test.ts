/**
 * Shared replay must preserve live dispatch, session replacement and detached
 * in-flight cards. Existing transcript suites cover batching, failed turns,
 * background jobs, Argot, usage placement and initial-history preservation.
 * This suite does not exercise the terminal driver or provider transport.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import type { AgentMessage } from "@veyyon/agent-core";
import type { AssistantMessage } from "@veyyon/ai";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { ToolExecutionComponent } from "@veyyon/coding-agent/modes/terminal/components/transcript/tool-execution";
import { TranscriptContainer } from "@veyyon/coding-agent/modes/terminal/components/transcript/transcript-container";
import { TranscriptComposer } from "@veyyon/coding-agent/modes/terminal/controllers/transcript-composer";
import { UiHelpers, type UiHelpersContext } from "@veyyon/coding-agent/modes/terminal/utils/ui-helpers";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
import type { SessionContext } from "@veyyon/kernel/session/session-context";
import { stripAnsi } from "@veyyon/utils";

const containers: TranscriptContainer[] = [];
function container(): TranscriptContainer {
	const value = new TranscriptContainer();
	containers.push(value);
	return value;
}
function text(value: TranscriptContainer): string {
	return stripAnsi(value.render(120).join("\n"));
}
function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "toolUse",
		timestamp: 0,
		usage: {
			input: 713,
			output: 127,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 840,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}
function context(messages: AgentMessage[]): SessionContext {
	return { messages } as SessionContext;
}
function fixture() {
	const ctx = {
		chatContainer: container(),
		pendingTools: new Map<string, ToolExecutionComponent>(),
		settledToolCalls: new Set<string>(),
		ui: { requestRender: vi.fn(), requestComponentRender: vi.fn() },
		settings: Settings.isolated({ "display.showTokenUsage": false }),
		toolOutputExpanded: false,
		effectiveHideThinkingBlock: false,
		proseOnlyThinking: false,
		lastAssistantUsage: undefined,
		editor: { addToHistory: vi.fn() },
		viewSession: {
			sessionManager: { getCwd: () => "/repo", putBlobSync: () => "fixture-blob" },
			getToolByName: () => undefined,
			extensionRunner: undefined,
			isStreaming: true,
			retryAttempt: 0,
		},
	};
	return { ctx, helpers: new UiHelpers(ctx as unknown as UiHelpersContext) };
}

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme();
});
afterEach(() => {
	for (const value of containers.splice(0)) value.dispose();
	vi.restoreAllMocks();
});

describe("shared transcript replay preserves live state", () => {
	it("extracts submitted user text without treating assistant text as a submission", () => {
		const { helpers } = fixture();
		expect(helpers.getUserMessageText({ role: "user", content: "plain prompt", timestamp: 0 })).toBe("plain prompt");
		expect(
			helpers.getUserMessageText({
				role: "user",
				content: [
					{ type: "text", text: "first " },
					{ type: "text", text: "second" },
				],
				timestamp: 0,
			}),
		).toBe("first second");
		expect(helpers.getUserMessageText(assistant([{ type: "text", text: "not a submission" }]))).toBe("");
	});

	it("appends only pre-tool prose live and replays the complete persisted timeline", () => {
		const { ctx, helpers } = fixture();
		const message = assistant([
			{ type: "text", text: "before the command" },
			{ type: "toolCall", id: "command", name: "bash", arguments: { command: "uname" } },
			{ type: "text", text: "after the command" },
		]);
		const result: AgentMessage = {
			role: "toolResult",
			toolCallId: "command",
			toolName: "bash",
			content: [{ type: "text", text: "command finished" }],
			timestamp: 1,
			isError: false,
		};
		helpers.addMessageToChat(message);
		const live = text(ctx.chatContainer);
		expect(live).toContain("before the command");
		expect(live).not.toContain("after the command");
		expect(ctx.pendingTools.size).toBe(0);
		helpers.addMessageToChat(result);
		expect(text(ctx.chatContainer)).toBe(live);

		helpers.renderSessionContext(context([message, result]));
		const replay = text(ctx.chatContainer);
		expect(replay).toContain("before the command");
		expect(replay).toContain("after the command");
		expect(replay).toContain("command finished");
		expect(ctx.pendingTools.size).toBe(0);
	});

	it("reads the current container, tool ledger and settings after session replacement", () => {
		const { ctx, helpers } = fixture();
		const firstContainer = ctx.chatContainer;
		const firstPending = ctx.pendingTools;
		const firstSettled = ctx.settledToolCalls;
		helpers.renderSessionContext(
			context([
				assistant([
					{ type: "text", text: "first conversation" },
					{ type: "toolCall", id: "first", name: "bash", arguments: { command: "first-command" } },
				]),
			]),
		);
		expect(firstPending.has("first")).toBe(true);
		expect(text(firstContainer)).not.toMatch(/\b713\b/);

		ctx.chatContainer = container();
		ctx.pendingTools = new Map();
		ctx.settledToolCalls = new Set();
		ctx.settings = Settings.isolated({ "display.showTokenUsage": true });
		helpers.renderSessionContext(
			context([
				assistant([
					{ type: "text", text: "second conversation" },
					{ type: "toolCall", id: "second", name: "bash", arguments: { command: "second-command" } },
				]),
			]),
		);
		expect(text(firstContainer)).toContain("first conversation");
		expect(text(firstContainer)).not.toContain("second conversation");
		expect(firstPending.has("first")).toBe(true);
		expect(firstPending.has("second")).toBe(false);
		expect(ctx.pendingTools.has("second")).toBe(true);
		expect(ctx.pendingTools.has("first")).toBe(false);
		const replay = text(ctx.chatContainer);
		expect(replay).toContain("second conversation");
		expect(replay).not.toContain("first conversation");
		expect(replay).toMatch(/\b713\b/);
		expect(replay).toMatch(/\b127\b/);
		ctx.viewSession.isStreaming = false;
		helpers.renderSessionContext(
			context([
				assistant([{ type: "toolCall", id: "settled", name: "bash", arguments: { command: "finished-command" } }]),
			]),
		);
		expect(ctx.pendingTools.size).toBe(0);
		expect(ctx.settledToolCalls.has("settled")).toBe(true);
		expect(firstSettled.has("settled")).toBe(false);
	});

	it("keeps a detached live tool writable when the composer replays committed messages", () => {
		const { ctx, helpers } = fixture();
		const liveTool = new ToolExecutionComponent(
			"bash",
			{ command: "live-command" },
			{},
			undefined,
			ctx.ui as unknown as UiHelpersContext["ui"],
			"/repo",
			"live",
		);
		ctx.chatContainer.addChild(liveTool);
		ctx.pendingTools.set("live", liveTool);
		const composer = new TranscriptComposer({
			chatContainer: ctx.chatContainer,
			pendingTools: ctx.pendingTools,
			addMessageToChat: message => {
				helpers.addMessageToChat(message);
			},
			renderSessionContext: value => helpers.renderSessionContext(value),
			buildTranscriptContext: () => context([{ role: "user", content: "committed prompt", timestamp: 0 }]),
			isViewStreaming: () => true,
			streamingComponent: () => undefined,
			isKnownSlashCommand: () => false,
			pendingSubmission: () => undefined,
		});
		composer.rebuild();
		expect(ctx.pendingTools.get("live")).toBe(liveTool);
		expect(liveTool.isTranscriptBlockFinalized()).toBe(false);
		liveTool.updateResult({ content: [{ type: "text", text: "live result after rebuild" }] }, false, "live");
		liveTool.seal();
		expect(liveTool.isTranscriptBlockFinalized()).toBe(true);
		const replay = text(ctx.chatContainer);
		expect(replay).toContain("committed prompt");
		expect(replay).toContain("live result after rebuild");
	});
});
