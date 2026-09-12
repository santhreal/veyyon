/**
 * WHY: projection state must preserve argument precedence and retry summaries,
 * and transcript updates must preserve block identity and grouped-read siblings.
 * This suite exercises the shared projector, bridge and terminal transcript port.
 * It does not prove production InteractiveMode adoption or physical terminal output.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "bun:test";
import type { AgentMessage } from "@veyyon/agent-core";
import type { AssistantMessage } from "@veyyon/ai";
import { TUI } from "@veyyon/tui";
import type {
	BlockId,
	ComposerState,
	DialogResult,
	DialogViewModel,
	OverlayHandle,
	OverlayViewModel,
	PresentationCapabilities,
	PresentationContext,
	PresentationTheme,
	StatusLineState,
	TranscriptBlock,
	UIEvent,
} from "@veyyon/wire/presentation";
import { VirtualTerminal } from "../../../../hosts/terminal/engine/test/virtual-terminal";
import { Settings } from "../../src/config/settings";
import { ChatTranscriptBuilder } from "../../src/modes/terminal/components/transcript/chat-transcript-builder";
import { TranscriptContainer } from "../../src/modes/terminal/components/transcript/transcript-container";
import { PresentationEventBridge, type PresentationEventSource } from "../../src/presentation/event-bridge";
import { SessionProjectionEngine } from "../../src/presentation/session-projection-engine";
import { toTranscriptBlocks } from "../../src/presentation/transcript-builder";
import type { AgentSessionEvent } from "../../src/session/agent-session-types";
import { initTheme } from "../../src/theme/theme";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

let settingsState: SettingsTestState | undefined;
beforeEach(async () => {
	settingsState = beginSettingsTest();
	await Settings.init({ inMemory: true });
});
afterEach(() => {
	vi.restoreAllMocks();
	restoreSettingsTestState(settingsState);
	settingsState = undefined;
});

beforeAll(async () => {
	await initTheme(false);
});

class RecordingPresentationContext implements PresentationContext {
	blocks: TranscriptBlock[] = [];
	running = false;
	scrollPosition = 0;
	scrollable = false;
	width = 80;
	height = 24;
	capabilities: PresentationCapabilities = {
		images: false,
		trueColor: true,
		mouse: true,
		hyperlinks: true,
		nativeScrollback: false,
		textStyles: true,
	};

	start(): void {
		this.running = true;
	}
	stop(): void {
		this.running = false;
	}
	setTranscriptBlocks(blocks: readonly TranscriptBlock[]): void {
		this.blocks = [...blocks];
	}
	appendTranscriptBlock(block: TranscriptBlock): void {
		this.blocks.push(block);
	}
	updateTranscriptBlock(id: BlockId, patch: Partial<TranscriptBlock>): void {
		const index = this.blocks.findIndex(b => b.id === id);
		if (index >= 0) this.blocks[index] = { ...this.blocks[index], ...patch } as TranscriptBlock;
	}
	removeTranscriptBlock(id: BlockId): void {
		this.blocks = this.blocks.filter(b => b.id !== id);
	}
	clearTranscript(): void {
		this.blocks = [];
	}
	setComposerState(_state: ComposerState): void {}
	setStatusLine(_state: StatusLineState): void {}
	focusComposer(): void {}
	closeOverlay(_id: string): void {}
	scrollToLive(): void {
		this.scrollPosition = 0;
	}
	scrollBy(rows: number): void {
		this.scrollPosition = Math.max(0, this.scrollPosition + rows);
	}
	showOverlay(_view: OverlayViewModel): OverlayHandle {
		return { id: _view.id, update: () => {}, close: () => {} };
	}
	showDialog(_view: DialogViewModel): Promise<DialogResult> {
		return Promise.resolve({ outcome: "cancelled" });
	}
	setTheme(_theme: PresentationTheme): void {}
	onInput(_handler: (event: UIEvent) => void): () => void {
		return () => {};
	}
}

class TestEventSource implements PresentationEventSource {
	messages: AgentMessage[];
	#listeners = new Set<(event: AgentSessionEvent) => void>();

	constructor(messages: AgentMessage[] = []) {
		this.messages = messages;
	}

	subscribe(listener: (event: AgentSessionEvent) => void): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	emit(event: AgentSessionEvent): void {
		for (const listener of this.#listeners) {
			listener(event);
		}
	}
}

describe("SessionProjectionEngine pure projection & correlation contracts", () => {
	test("assigns monotonic stable block IDs across message lifecycle events", () => {
		const engine = new SessionProjectionEngine();
		const userMsg: AgentMessage = { role: "user", content: "hello", timestamp: 1000 } as AgentMessage;
		const assistantMsg = assistantFixture([{ type: "text", text: "hi" }], 2000);

		expect(engine.blockId(userMsg)).toBe("user:0");
		expect(engine.blockId(assistantMsg)).toBe("assistant:1");

		// Same object reference gets same index
		expect(engine.indexOf(userMsg)).toBe(0);
		expect(engine.indexOf(assistantMsg)).toBe(1);

		const userBlock = engine.projectMessageBlock(userMsg);
		expect(userBlock.id).toBe("user:0");
		expect(userBlock.kind).toBe("user-message");

		const assistantBlock = engine.projectMessageBlock(assistantMsg, { streaming: true });
		expect(assistantBlock.id).toBe("assistant:1");
		expect(assistantBlock.kind).toBe("assistant-message");
		if (assistantBlock.kind === "assistant-message") {
			expect(assistantBlock.streaming).toBe(true);
		}

		engine.reset();
		expect(engine.projectMessageBlock(assistantMsg).id).toBe("assistant:0");
		expect(engine.projectMessageBlock({ role: "user", content: "new branch", timestamp: 3000 }).id).toBe("user:1");
	});

	test("correlates tool call arguments from assistant messages and execution events", () => {
		const engine = new SessionProjectionEngine();
		const toolCallId = "call_edit_42";
		const editArgs = { path: "src/main.ts", input: "const x = 1;" };

		const assistantMsg = assistantFixture(
			[{ type: "toolCall", id: toolCallId, name: "edit", arguments: editArgs }],
			1000,
			"toolUse",
		);

		engine.recordAssistantMessageToolCalls(assistantMsg);
		expect(engine.findToolCallArgs(toolCallId)).toEqual(editArgs);

		// Execution start updates ledger and running status
		engine.recordToolCall(toolCallId, "edit", editArgs, 1100);
		engine.markToolCallRunning(toolCallId, true);
		expect(engine.runningToolCalls.has(toolCallId)).toBe(true);

		const runningBlock = engine.projectToolExecutionBlock(toolCallId, {
			toolName: "edit",
			args: editArgs,
			isPartial: true,
			timestamp: 1100,
		});
		expect(runningBlock.id).toBe(`tool:${toolCallId}`);
		expect(runningBlock.kind).toBe("tool-execution");
		if (runningBlock.kind === "tool-execution") {
			expect(runningBlock.status).toBe("running");
			expect(runningBlock.input).toBe(JSON.stringify(editArgs, null, 2));
		}

		// Tool completion marks settled and updates result
		engine.markToolCallRunning(toolCallId, false);
		engine.markToolCallSettled(toolCallId);
		expect(engine.isToolCallSettled(toolCallId)).toBe(true);
		expect(engine.runningToolCalls.has(toolCallId)).toBe(false);

		const completedBlock = engine.projectToolExecutionBlock(toolCallId, {
			toolName: "edit",
			args: editArgs,
			result: { content: [{ type: "text", text: "Applied 1 edit." }], isError: false },
			isError: false,
			isPartial: false,
			sealed: true,
		});
		if (completedBlock.kind === "tool-execution") {
			expect(completedBlock.status).toBe("succeeded");
			expect(completedBlock.output).toBe("Applied 1 edit.");
		}
	});

	test("marks a background task in and out of its own set without touching the running set", () => {
		const engine = new SessionProjectionEngine();
		engine.markToolCallRunning("call_bg", true);
		engine.markBackgroundTask("call_bg", true);
		expect([engine.isBackgroundTask("call_bg"), engine.runningToolCalls.has("call_bg")]).toEqual([true, true]);

		engine.markBackgroundTask("call_bg", false);
		expect([engine.isBackgroundTask("call_bg"), engine.runningToolCalls.has("call_bg")]).toEqual([false, true]);

		engine.markToolCallRunning("call_bg", false);
		expect([...engine.backgroundTaskCallIds, ...engine.runningToolCalls]).toEqual([]);
	});

	test("tracks retry traces and produces formatted summary upon resolution", () => {
		const engine = new SessionProjectionEngine();
		engine.recordAutoRetryStart({
			attempt: 1,
			delayMs: 2000,
			errorMessage: "Rate limited",
			mode: "retry",
		});

		const trace = engine.retryTrace;
		expect(trace).toBeDefined();
		expect(trace?.attempts).toBe(1);
		expect(trace?.totalDelayMs).toBe(2000);

		// End of successful retry formats summary and clears trace
		const { summary, error } = engine.recordAutoRetryEnd({ success: true, attempt: 1, mode: "retry" });
		expect(summary).toBeDefined();
		expect(error).toBeUndefined();
		expect(engine.retryTrace).toBeUndefined();
	});
});

describe("PresentationEventBridge & ChatTranscriptBuilder convergence parity", () => {
	test("bridge dispatches events through SessionProjectionEngine to PresentationContext", () => {
		const source = new TestEventSource();
		const presentation = new RecordingPresentationContext();
		const bridge = new PresentationEventBridge(source, presentation);
		bridge.connect();

		const assistantMsg = assistantFixture([{ type: "text", text: "Starting..." }], 1000);

		source.emit({ type: "message_start", message: assistantMsg });
		expect(presentation.blocks).toHaveLength(1);
		expect(presentation.blocks[0]?.id).toBe("assistant:0");

		source.emit({
			type: "tool_execution_start",
			toolCallId: "tool_1",
			toolName: "bash",
			args: { command: "echo hello" },
		});
		expect(bridge.runningToolCalls.has("tool_1")).toBe(true);
		expect(presentation.blocks).toHaveLength(2);
		expect(presentation.blocks[1]?.id).toBe("tool:tool_1");

		source.emit({
			type: "tool_execution_end",
			toolCallId: "tool_1",
			toolName: "bash",
			result: { content: [{ type: "text", text: "hello\n" }] },
			isError: false,
		});
		expect(bridge.runningToolCalls.has("tool_1")).toBe(false);

		bridge.disconnect();
		expect(bridge.connected).toBe(false);
	});

	test("produces identical TranscriptBlock projections between initial seed, replay, and live events", () => {
		const userMsg: AgentMessage = { role: "user", content: "test user input", timestamp: 1000 } as AgentMessage;
		const assistantMsg = assistantFixture([{ type: "text", text: "test assistant output" }], 2000);
		const messages = [userMsg, assistantMsg];

		const engine = new SessionProjectionEngine();
		const seededBlocks = engine.projectInitialBlocks(messages);
		const staticBlocks = toTranscriptBlocks(messages);

		expect(seededBlocks).toHaveLength(2);
		expect(staticBlocks).toHaveLength(2);
		expect(seededBlocks[0]?.id).toBe(staticBlocks[0]?.id);
		expect(seededBlocks[0]?.kind).toBe("user-message");
		expect(seededBlocks[1]?.id).toBe(staticBlocks[1]?.id);
		expect(seededBlocks[1]?.kind).toBe("assistant-message");

		// Live event bridge projection matches the seeded blocks
		const source = new TestEventSource();
		const presentation = new RecordingPresentationContext();
		const bridge = new PresentationEventBridge(source, presentation);
		bridge.connect();

		source.emit({ type: "message_start", message: userMsg });
		source.emit({ type: "message_end", message: userMsg });
		source.emit({ type: "message_start", message: assistantMsg });
		source.emit({ type: "message_end", message: assistantMsg });

		expect(presentation.blocks).toHaveLength(2);
		expect(presentation.blocks[0]?.id).toBe(seededBlocks[0]?.id);
		expect(presentation.blocks[1]?.id).toBe(seededBlocks[1]?.id);
	});

	test("ChatTranscriptBuilder hosts TranscriptBlock models and groups readEntry blocks", () => {
		const container = new TranscriptContainer();
		const ui = new TUI(new VirtualTerminal(80, 24));
		const builder = new ChatTranscriptBuilder({
			ui,
			container,
			cwd: "/test",
			requestRender: () => ui.requestRender(),
		});

		const userBlock: TranscriptBlock = {
			kind: "user-message",
			id: "user:0",
			text: "hello world",
			timestamp: 1000,
			attachments: [],
		};
		builder.appendTranscriptBlock(userBlock);
		expect(container.children).toHaveLength(1);
		builder.appendTranscriptBlock({ ...userBlock, text: "updated greeting" });
		expect(container.children).toHaveLength(1);
		expect(container.render(80).join("\n")).toContain("updated greeting");
		builder.updateTranscriptBlock("missing", { ...userBlock, id: "missing" });
		expect(container.render(80).join("\n")).toContain("updated greeting");
		expect(container.children).toHaveLength(1);
		builder.updateTranscriptBlock(userBlock.id, { text: "patched greeting" });
		builder.updateTranscriptBlock(userBlock.id, { timestamp: 1500 });
		expect(container.render(80).join("\n")).toContain("patched greeting");
		expect(container.children).toHaveLength(1);

		const readBlock1: TranscriptBlock = {
			kind: "tool-execution",
			id: "tool:read_1",
			toolCallId: "read_1",
			toolName: "read",
			input: JSON.stringify({ path: "src/a.ts" }),
			status: "running",
			timestamp: 1001,
			display: {
				readEntry: {
					toolCallId: "read_1",
					path: "src/a.ts",
					displayPaths: ["src/a.ts"],
					linkPath: "src/a.ts",
					status: "pending",
				},
			},
		};
		builder.appendTranscriptBlock(readBlock1);
		expect(container.children).toHaveLength(2);

		const readBlock2: TranscriptBlock = {
			kind: "tool-execution",
			id: "tool:read_2",
			toolCallId: "read_2",
			toolName: "read",
			input: JSON.stringify({ path: "src/b.ts" }),
			status: "running",
			timestamp: 1002,
			display: {
				readEntry: {
					toolCallId: "read_2",
					path: "src/b.ts",
					displayPaths: ["src/b.ts"],
					linkPath: "src/b.ts",
					status: "pending",
				},
			},
		};
		// Consecutive reads group into the same ReadToolGroupComponent
		builder.appendTranscriptBlock(readBlock2);
		expect(container.children).toHaveLength(2);

		// Updating readEntry status in place
		const completedRead1: TranscriptBlock = {
			...readBlock1,
			status: "succeeded",
			display: {
				readEntry: {
					toolCallId: "read_1",
					path: "src/a.ts",
					displayPaths: ["src/a.ts"],
					linkPath: "src/a.ts",
					status: "success",
					contentText: "export const a = 1;",
				},
			},
		};
		builder.updateTranscriptBlock("tool:read_1", {
			status: completedRead1.status,
			display: completedRead1.display,
		});
		builder.updateTranscriptBlock("tool:read_1", { timestamp: 1600 });
		expect(container.render(120).join("\n")).toContain("src/a.ts");
		expect(container.children).toHaveLength(2);

		expect(builder.removeTranscriptBlock(readBlock1.id)).toBe(true);
		const remainingRead = container.render(120).join("\n");
		expect(remainingRead).not.toContain("src/a.ts");
		expect(remainingRead).toContain("src/b.ts");
		expect(container.children).toHaveLength(2);

		const committed = vi.spyOn(container, "isBlockUncommitted").mockReturnValue(false);
		try {
			expect(builder.removeTranscriptBlock(readBlock2.id)).toBe(false);
			builder.updateTranscriptBlock(readBlock2.id, {
				display: { readEntry: { toolCallId: "read_2", path: "src/retained.ts", status: "success" } },
			});
			expect(container.render(120).join("\n")).toContain("src/retained.ts");
		} finally {
			committed.mockRestore();
		}

		expect(builder.removeTranscriptBlock(readBlock2.id)).toBe(true);
		expect(container.children).toHaveLength(1);
		builder.appendTranscriptBlock(readBlock2);
		expect(container.render(120).join("\n")).toContain("src/b.ts");
		expect(container.children).toHaveLength(2);

		// Removing a block
		const assistantBlock: TranscriptBlock = {
			kind: "assistant-message",
			id: "assistant:1",
			segments: [{ kind: "text", text: "done" }],
			model: "test-model",
			stopReason: "complete",
			streaming: false,
			timestamp: 2000,
		};
		builder.appendTranscriptBlock(assistantBlock);
		expect(container.children).toHaveLength(3);

		const removed = builder.removeTranscriptBlock("assistant:1");
		expect(removed).toBe(true);
		expect(container.children).toHaveLength(2);

		builder.clearTranscript();
		expect(container.children).toHaveLength(0);
	});
});

function assistantFixture(
	content: AssistantMessage["content"],
	timestamp: number,
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test-model",
		stopReason,
		timestamp,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}
