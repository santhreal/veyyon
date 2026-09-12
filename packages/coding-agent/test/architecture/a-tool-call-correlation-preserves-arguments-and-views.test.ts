/**
 * WHY: tool execution cards must display their input arguments, formatted call views,
 * and result previews consistently across the live turn stream, replay, resume,
 * and transcript rebuilds.
 *
 * The defect class this closes is cross-event and cross-turn state loss in tool execution:
 * 1. `toTranscriptBlocks` converting messages independently so `toolResult` blocks lose
 *    the arguments provided by prior `AssistantMessage` tool calls on replay/rebuild.
 * 2. `PresentationEventBridge` deleting live tool arguments on `tool_execution_end` before
 *    subsequent `toolResult` message delivery, causing `message_end` to overwrite the live
 *    block with an empty-args block.
 * 3. Duplicate block appending on `message_start` for tool results that already have a live block.
 *
 * What it does NOT catch: whether the backend tool execution itself produces correct results
 * (covered by tool unit tests), or terminal ANSI rendering geometry (covered by driver tests).
 */

import { describe, expect, test } from "bun:test";
import type { AgentEvent, AgentMessage } from "@veyyon/agent-core";
import type { AssistantMessage, ToolResultMessage } from "@veyyon/ai";
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
import { PresentationEventBridge, type PresentationEventSource } from "../../src/presentation/event-bridge";
import { collectToolCallArgs, toTranscriptBlock, toTranscriptBlocks } from "../../src/presentation/transcript-builder";
import type { AgentSessionEvent } from "../../src/session/agent-session-types";

class RecordingPresentationContext implements PresentationContext {
	blocks: TranscriptBlock[] = [];
	calls: string[] = [];
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
		this.calls.push(`set:${blocks.length}`);
		this.blocks = [...blocks];
	}

	appendTranscriptBlock(block: TranscriptBlock): void {
		this.calls.push(`append:${block.id}`);
		this.blocks.push(block);
	}

	updateTranscriptBlock(id: BlockId, patch: Partial<TranscriptBlock>): void {
		this.calls.push(`update:${id}`);
		const index = this.blocks.findIndex(b => b.id === id);
		if (index < 0) return;
		this.blocks[index] = { ...this.blocks[index]!, ...patch } as TranscriptBlock;
	}

	removeTranscriptBlock(id: BlockId): void {
		this.calls.push(`remove:${id}`);
		this.blocks = this.blocks.filter(b => b.id !== id);
	}

	clearTranscript(): void {
		this.calls.push("clear");
		this.blocks = [];
	}

	setStatusLine(_state: StatusLineState): void {
		this.calls.push("status");
	}
	setComposerState(_state: ComposerState): void {
		this.calls.push("composer");
	}
	focusComposer(): void {
		this.calls.push("focus");
	}

	showDialog(_dialog: DialogViewModel): Promise<DialogResult> {
		return Promise.resolve({ id: "dialog", outcome: "cancelled" });
	}
	showOverlay(overlay: OverlayViewModel): OverlayHandle {
		return { id: overlay.id, close: () => {}, update: () => {} };
	}
	closeOverlay(_id: string): void {}
	scrollToLive(): void {}
	scrollBy(_rows: number): void {}
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

	emit(event: AgentEvent | AgentSessionEvent): void {
		for (const listener of [...this.#listeners]) {
			listener(event as AgentSessionEvent);
		}
	}
}

function createBridge(messages: AgentMessage[] = []): {
	source: TestEventSource;
	presentation: RecordingPresentationContext;
	bridge: PresentationEventBridge;
} {
	const source = new TestEventSource(messages);
	const presentation = new RecordingPresentationContext();
	const bridge = new PresentationEventBridge(source, presentation);
	bridge.connect();
	return { source, presentation, bridge };
}

describe("pure tool call correlation helper", () => {
	test("collectToolCallArgs extracts tool call arguments from assistant messages", () => {
		const messages: AgentMessage[] = [
			{
				role: "user",
				content: "read a file",
				timestamp: 1000,
			} as AgentMessage,
			{
				role: "assistant",
				content: [
					{ type: "text", text: "I will read the file." },
					{
						type: "toolCall",
						id: "call_read_1",
						name: "read",
						arguments: { path: "src/index.ts", lines: [1, 50] },
					},
					{
						type: "toolCall",
						id: "call_bash_1",
						name: "bash",
						arguments: { command: "git status" },
					},
				],
				model: "test-model",
				stopReason: "toolUse",
				timestamp: 2000,
			} as unknown as AssistantMessage,
		];

		const map = collectToolCallArgs(messages);
		expect(map.get("call_read_1")).toEqual({ path: "src/index.ts", lines: [1, 50] });
		expect(map.get("call_bash_1")).toEqual({ command: "git status" });
		expect(map.get("non_existent")).toBeUndefined();
	});

	test("collectToolCallArgs handles messages without tool calls gracefully", () => {
		const messages: AgentMessage[] = [
			{ role: "user", content: "hello", timestamp: 100 } as AgentMessage,
			{ role: "assistant", content: [{ type: "text", text: "hi" }], timestamp: 200 } as unknown as AssistantMessage,
		];
		const map = collectToolCallArgs(messages);
		expect(map.size).toBe(0);
	});
});

describe("transcript rebuild and replay correlation parity", () => {
	test("toTranscriptBlocks correlates tool results with prior assistant tool calls for configured view renderers", () => {
		const assistantMsg: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "read_1",
					name: "read",
					arguments: { path: "src/app.ts" },
				},
				{
					type: "toolCall",
					id: "edit_1",
					name: "edit",
					arguments: { path: "src/app.ts", input: "line 1\nline 2" },
				},
				{
					type: "toolCall",
					id: "web_1",
					name: "web_search",
					arguments: { query: "typescript presentation" },
				},
			],
			model: "test-model",
			stopReason: "toolUse",
			timestamp: 1000,
		} as unknown as AssistantMessage;

		const readResultMsg: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "read_1",
			toolName: "read",
			content: [{ type: "text", text: "const app = 1;" }],
			isError: false,
			timestamp: 1100,
		};

		const editResultMsg: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "edit_1",
			toolName: "edit",
			content: [{ type: "text", text: "Applied 1 edit." }],
			isError: false,
			timestamp: 1200,
		};

		const webResultMsg: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "web_1",
			toolName: "web_search",
			content: [{ type: "text", text: "Search results found." }],
			isError: false,
			timestamp: 1300,
		};

		const blocks = toTranscriptBlocks([assistantMsg, readResultMsg, editResultMsg, webResultMsg]);
		expect(blocks).toHaveLength(4);

		const readBlock = blocks.find(b => b.id === "tool:read_1");
		const editBlock = blocks.find(b => b.id === "tool:edit_1");
		const webBlock = blocks.find(b => b.id === "tool:web_1");

		if (
			readBlock?.kind !== "tool-execution" ||
			editBlock?.kind !== "tool-execution" ||
			webBlock?.kind !== "tool-execution"
		) {
			throw new Error("expected tool-execution blocks");
		}

		// Input preservation
		expect(readBlock.input).toBe(JSON.stringify({ path: "src/app.ts" }, null, 2));
		expect(editBlock.input).toBe(JSON.stringify({ path: "src/app.ts", input: "line 1\nline 2" }, null, 2));
		expect(webBlock.input).toBe(JSON.stringify({ query: "typescript presentation" }, null, 2));

		// Views preservation (configured renderers produce resultView with callArgs incorporated)
		expect(readBlock.display?.resultView).toBeDefined();
		expect(editBlock.display?.resultView).toBeDefined();
		expect(webBlock.display?.resultView).toBeDefined();

		// Status and output
		expect(readBlock.status).toBe("succeeded");
		expect(readBlock.output).toBe("const app = 1;");
		expect(editBlock.status).toBe("succeeded");
		expect(webBlock.status).toBe("succeeded");
	});

	test("standalone toolResult projection without available call data retains fallback", () => {
		const orphanResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "orphan_1",
			toolName: "read",
			content: [{ type: "text", text: "standalone content" }],
			isError: false,
			timestamp: 5000,
		};

		// Standalone projection with no toolCallArgs in options
		const block = toTranscriptBlock(orphanResult, { index: 0 });
		if (block.kind !== "tool-execution") throw new Error("expected tool-execution block");

		expect(block.input).toBe("");
		expect(block.status).toBe("succeeded");
		expect(block.output).toBe("standalone content");
		expect(block.display?.callView).toBeUndefined();
	});
});

describe("live event stream complete semantic block parity", () => {
	test("uses completed assistant arguments when no execution-start event is available", () => {
		const { source, presentation } = createBridge();
		const call = {
			type: "toolCall" as const,
			id: "message_only",
			name: "read",
			arguments: { path: "partial.ts" },
		};
		const message = {
			role: "assistant",
			content: [call],
			timestamp: 0,
		} as unknown as AssistantMessage;
		source.emit({ type: "message_start", message });
		call.arguments = { path: "completed.ts" };
		source.emit({ type: "message_end", message });
		const result: ToolResultMessage = {
			role: "toolResult",
			toolCallId: call.id,
			toolName: call.name,
			content: [{ type: "text", text: "file contents" }],
			isError: false,
			timestamp: 1,
		};
		source.emit({ type: "message_start", message: result });
		source.emit({ type: "message_end", message: result });
		const block = presentation.blocks.find(block => block.id === `tool:${call.id}`);
		if (block?.kind !== "tool-execution") throw new Error("Expected a tool result");
		expect(block.input).toBe(JSON.stringify({ path: "completed.ts" }, null, 2));
	});

	test("tool execution retains args, input, and display across start, update, end, and subsequent toolResult message events", () => {
		const { source, presentation } = createBridge();

		const readArgs = { path: "src/server.ts" };
		const resultContent: ToolResultMessage["content"] = [{ type: "text", text: "export const server = 8080;" }];

		// 1. Assistant message with tool call
		const assistantMsg: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "live_call_1",
					name: "read",
					arguments: readArgs,
				},
			],
			model: "test-model",
			stopReason: "toolUse",
			timestamp: 1000,
		} as unknown as AssistantMessage;

		source.emit({ type: "message_start", message: assistantMsg });
		source.emit({ type: "message_end", message: assistantMsg });

		// 2. tool_execution_start
		source.emit({
			type: "tool_execution_start",
			toolCallId: "live_call_1",
			toolName: "read",
			args: readArgs,
		});

		let liveBlock = presentation.blocks.find(b => b.id === "tool:live_call_1");
		if (liveBlock?.kind !== "tool-execution") throw new Error("expected tool block");
		expect(liveBlock.status).toBe("running");
		expect(liveBlock.input).toBe(JSON.stringify(readArgs, null, 2));
		expect(liveBlock.display?.callView).toBeDefined();

		// 3. tool_execution_update
		source.emit({
			type: "tool_execution_update",
			toolCallId: "live_call_1",
			toolName: "read",
			partialResult: { content: [{ type: "text", text: "export const server" }] },
		} as AgentEvent);

		liveBlock = presentation.blocks.find(b => b.id === "tool:live_call_1");
		if (liveBlock?.kind !== "tool-execution") throw new Error("expected tool block");
		expect(liveBlock.status).toBe("running");
		expect(liveBlock.input).toBe(JSON.stringify(readArgs, null, 2));
		expect(liveBlock.output).toBe("export const server");

		// 4. tool_execution_end
		source.emit({
			type: "tool_execution_end",
			toolCallId: "live_call_1",
			toolName: "read",
			result: { content: resultContent },
			isError: false,
		} as AgentEvent);

		liveBlock = presentation.blocks.find(b => b.id === "tool:live_call_1");
		if (liveBlock?.kind !== "tool-execution") throw new Error("expected tool block");
		expect(liveBlock.status).toBe("succeeded");
		expect(liveBlock.input).toBe(JSON.stringify(readArgs, null, 2));
		expect(liveBlock.output).toBe("export const server = 8080;");
		expect(liveBlock.display?.resultView).toBeDefined();

		// 5. Subsequent toolResult message events (as emitted by real agent loop)
		const toolResultMsg: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "live_call_1",
			toolName: "read",
			content: resultContent,
			isError: false,
			timestamp: 1200,
		};
		source.messages.push(assistantMsg, toolResultMsg);

		source.emit({ type: "message_start", message: toolResultMsg });
		source.emit({ type: "message_end", message: toolResultMsg });

		// Verify no duplicate block appended
		const matchingBlocks = presentation.blocks.filter(b => b.id === "tool:live_call_1");
		expect(matchingBlocks).toHaveLength(1);

		// Verify block STILL retains args, input, display after message_end
		liveBlock = matchingBlocks[0]!;
		if (liveBlock?.kind !== "tool-execution") throw new Error("expected tool block");
		expect(liveBlock.status).toBe("succeeded");
		expect(liveBlock.input).toBe(JSON.stringify(readArgs, null, 2));
		expect(liveBlock.output).toBe("export const server = 8080;");
		expect(liveBlock.display?.resultView).toBeDefined();

		// Verify complete parity with static rebuild
		const rebuiltBlocks = toTranscriptBlocks([assistantMsg, toolResultMsg]);
		const rebuiltBlock = rebuiltBlocks.find(b => b.id === "tool:live_call_1");
		if (rebuiltBlock?.kind !== "tool-execution") throw new Error("expected rebuilt tool block");

		expect(liveBlock.id).toBe(rebuiltBlock.id);
		expect(liveBlock.status).toBe(rebuiltBlock.status);
		expect(liveBlock.input).toBe(rebuiltBlock.input);
		expect(liveBlock.output).toBe(rebuiltBlock.output);
		expect(liveBlock.error).toBe(rebuiltBlock.error);
		expect(liveBlock.display?.callView).toEqual(rebuiltBlock.display?.callView);
		expect(liveBlock.display?.resultView).toEqual(rebuiltBlock.display?.resultView);
		expect(liveBlock.display?.generic?.argsPreview).toBe(rebuiltBlock.display?.generic?.argsPreview);
	});

	test("retains tool arguments across tool_execution_end and message_end when arguments exist only on live event stream", () => {
		const { source, presentation } = createBridge();
		const liveArgs = { path: "streamed-only.ts" };
		const resultContent: ToolResultMessage["content"] = [{ type: "text", text: "file content from stream" }];

		source.emit({
			type: "tool_execution_start",
			toolCallId: "stream_only_1",
			toolName: "read",
			args: liveArgs,
		});

		source.emit({
			type: "tool_execution_end",
			toolCallId: "stream_only_1",
			toolName: "read",
			result: { content: resultContent },
			isError: false,
		} as AgentEvent);

		const toolResultMsg: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "stream_only_1",
			toolName: "read",
			content: resultContent,
			isError: false,
			timestamp: 2000,
		};

		source.emit({ type: "message_start", message: toolResultMsg });
		source.emit({ type: "message_end", message: toolResultMsg });

		const liveBlock = presentation.blocks.find(b => b.id === "tool:stream_only_1");
		if (liveBlock?.kind !== "tool-execution") throw new Error("expected tool block");

		expect(liveBlock.status).toBe("succeeded");
		expect(liveBlock.input).toBe(JSON.stringify(liveArgs, null, 2));
		expect(liveBlock.output).toBe("file content from stream");
		expect(liveBlock.display?.resultView).toBeDefined();
	});

	test("preserves generic tool arguments and argsPreview across live message events", () => {
		const { source, presentation } = createBridge();
		const customArgs = { paramA: "value1", paramB: 42 };
		const resultContent: ToolResultMessage["content"] = [{ type: "text", text: '{"status":"ok"}' }];

		const assistantMsg: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "gen_call_1",
					name: "custom_generic_tool",
					arguments: customArgs,
				},
			],
			model: "test-model",
			stopReason: "toolUse",
			timestamp: 1000,
		} as unknown as AssistantMessage;

		source.emit({ type: "message_start", message: assistantMsg });
		source.emit({ type: "message_end", message: assistantMsg });

		source.emit({
			type: "tool_execution_start",
			toolCallId: "gen_call_1",
			toolName: "custom_generic_tool",
			args: customArgs,
		});

		source.emit({
			type: "tool_execution_end",
			toolCallId: "gen_call_1",
			toolName: "custom_generic_tool",
			result: { content: resultContent },
			isError: false,
		} as AgentEvent);

		const toolResultMsg: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "gen_call_1",
			toolName: "custom_generic_tool",
			content: resultContent,
			isError: false,
			timestamp: 1200,
		};
		source.messages.push(assistantMsg, toolResultMsg);

		source.emit({ type: "message_start", message: toolResultMsg });
		source.emit({ type: "message_end", message: toolResultMsg });

		const liveBlock = presentation.blocks.find(b => b.id === "tool:gen_call_1");
		if (liveBlock?.kind !== "tool-execution") throw new Error("expected tool block");

		expect(liveBlock.input).toBe(JSON.stringify(customArgs, null, 2));
		expect(liveBlock.display?.generic?.argsPreview).toContain("paramA");
		expect(liveBlock.display?.generic?.argsPreview).toContain("value1");

		const rebuilt = toTranscriptBlocks([assistantMsg, toolResultMsg]).find(b => b.id === "tool:gen_call_1");
		if (rebuilt?.kind !== "tool-execution") throw new Error("expected rebuilt block");
		expect(liveBlock.input).toBe(rebuilt.input);
		expect(liveBlock.display?.generic?.argsPreview).toBe(rebuilt.display?.generic?.argsPreview);
	});

	test("preserves both callView and resultView for tools that do not merge call and result", () => {
		const { source, presentation } = createBridge();
		const cwdArgs = { path: "/new/project/root" };
		const resultContent: ToolResultMessage["content"] = [
			{ type: "text", text: "Working directory changed to /new/project/root" },
		];

		const assistantMsg: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "cwd_call_1",
					name: "set_cwd",
					arguments: cwdArgs,
				},
			],
			model: "test-model",
			stopReason: "toolUse",
			timestamp: 1000,
		} as unknown as AssistantMessage;

		source.emit({ type: "message_start", message: assistantMsg });
		source.emit({ type: "message_end", message: assistantMsg });

		source.emit({
			type: "tool_execution_start",
			toolCallId: "cwd_call_1",
			toolName: "set_cwd",
			args: cwdArgs,
		});

		source.emit({
			type: "tool_execution_end",
			toolCallId: "cwd_call_1",
			toolName: "set_cwd",
			result: { content: resultContent },
			isError: false,
		} as AgentEvent);

		const toolResultMsg: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "cwd_call_1",
			toolName: "set_cwd",
			content: resultContent,
			isError: false,
			timestamp: 1200,
		};
		source.messages.push(assistantMsg, toolResultMsg);

		source.emit({ type: "message_start", message: toolResultMsg });
		source.emit({ type: "message_end", message: toolResultMsg });

		const liveBlock = presentation.blocks.find(b => b.id === "tool:cwd_call_1");
		if (liveBlock?.kind !== "tool-execution") throw new Error("expected tool block");

		expect(liveBlock.status).toBe("succeeded");
		expect(liveBlock.input).toBe(JSON.stringify(cwdArgs, null, 2));
		expect(liveBlock.display?.callView).toBeDefined();
		expect(liveBlock.display?.resultView).toBeDefined();

		const rebuilt = toTranscriptBlocks([assistantMsg, toolResultMsg]).find(b => b.id === "tool:cwd_call_1");
		if (rebuilt?.kind !== "tool-execution") throw new Error("expected rebuilt tool block");
		expect(liveBlock.display?.callView).toEqual(rebuilt.display?.callView);
		expect(liveBlock.display?.resultView).toEqual(rebuilt.display?.resultView);
	});
});

describe("multiple calls, concurrency, and duplicate delivery", () => {
	test("concurrent and multiple sequential tool calls maintain isolated arguments", () => {
		const { source, presentation } = createBridge();

		source.emit({
			type: "tool_execution_start",
			toolCallId: "multi_1",
			toolName: "bash",
			args: { command: "echo first" },
		});
		source.emit({
			type: "tool_execution_start",
			toolCallId: "multi_2",
			toolName: "bash",
			args: { command: "echo second" },
		});

		source.emit({
			type: "tool_execution_end",
			toolCallId: "multi_1",
			toolName: "bash",
			result: { content: [{ type: "text", text: "first\n" }] },
		} as AgentEvent);
		source.emit({
			type: "tool_execution_end",
			toolCallId: "multi_2",
			toolName: "bash",
			result: { content: [{ type: "text", text: "second\n" }] },
		} as AgentEvent);

		const b1 = presentation.blocks.find(b => b.id === "tool:multi_1");
		const b2 = presentation.blocks.find(b => b.id === "tool:multi_2");
		if (b1?.kind !== "tool-execution" || b2?.kind !== "tool-execution") {
			throw new Error("expected tool blocks");
		}

		expect(b1.input).toBe(JSON.stringify({ command: "echo first" }, null, 2));
		expect(b2.input).toBe(JSON.stringify({ command: "echo second" }, null, 2));
		expect(b1.output).toBe("first\n");
		expect(b2.output).toBe("second\n");
	});

	test("duplicate delivery of tool_execution_start or message_start does not duplicate blocks", () => {
		const { source, presentation } = createBridge();

		source.emit({
			type: "tool_execution_start",
			toolCallId: "dup_1",
			toolName: "read",
			args: { path: "dup.ts" },
		});
		// Duplicate start
		source.emit({
			type: "tool_execution_start",
			toolCallId: "dup_1",
			toolName: "read",
			args: { path: "dup.ts" },
		});

		expect(presentation.blocks.filter(b => b.id === "tool:dup_1")).toHaveLength(1);

		source.emit({
			type: "tool_execution_end",
			toolCallId: "dup_1",
			toolName: "read",
			result: { content: [{ type: "text", text: "done" }] },
		} as AgentEvent);

		const msg: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "dup_1",
			toolName: "read",
			content: [{ type: "text", text: "done" }],
			isError: false,
			timestamp: 100,
		};
		// Duplicate message starts
		source.emit({ type: "message_start", message: msg });
		source.emit({ type: "message_start", message: msg });
		source.emit({ type: "message_end", message: msg });

		expect(presentation.blocks.filter(b => b.id === "tool:dup_1")).toHaveLength(1);
	});
});

describe("interrupted completion, errors, and bounded state cleanup", () => {
	for (const transition of ["turn_end", "agent_end", "disconnect"] as const) {
		test(`${transition} performs bounded state cleanup`, () => {
			const { source, presentation, bridge } = createBridge();
			source.emit({
				type: "tool_execution_start",
				toolCallId: "interrupted_1",
				toolName: "bash",
				args: { command: "printf previous" },
			});
			expect(bridge.runningToolCalls.has("interrupted_1")).toBe(true);
			if (transition === "disconnect") {
				bridge.disconnect();
				expect(bridge.connected).toBe(false);
				bridge.connect();
			} else {
				source.emit({ type: transition } as AgentSessionEvent);
			}
			expect(bridge.runningToolCalls.size).toBe(0);
			const message: ToolResultMessage = {
				role: "toolResult",
				toolCallId: "interrupted_1",
				toolName: "bash",
				content: [{ type: "text", text: "completed" }],
				isError: false,
				timestamp: 1,
			};
			source.emit({ type: "message_start", message });
			source.emit({ type: "message_end", message });
			const block = presentation.blocks.find(block => block.id === "tool:interrupted_1");
			if (block?.kind !== "tool-execution") throw new Error("Expected a tool result");
			expect(block.input).toBe("");
			expect(block.status).toBe("succeeded");
			bridge.disconnect();
		});
	}

	test("error preservation routes error text and preserves input arguments", () => {
		const { source, presentation } = createBridge();

		source.emit({
			type: "tool_execution_start",
			toolCallId: "err_1",
			toolName: "edit",
			args: { path: "missing.ts", edits: [] },
		});
		source.emit({
			type: "tool_execution_end",
			toolCallId: "err_1",
			toolName: "edit",
			result: { content: [{ type: "text", text: "ENOENT: file not found" }] },
			isError: true,
		} as AgentEvent);

		const errBlock = presentation.blocks.find(b => b.id === "tool:err_1");
		if (errBlock?.kind !== "tool-execution") throw new Error("expected tool block");

		expect(errBlock.status).toBe("failed");
		expect(errBlock.error).toBe("ENOENT: file not found");
		expect(errBlock.output).toBeUndefined();
		expect(errBlock.input).toBe(JSON.stringify({ path: "missing.ts", edits: [] }, null, 2));
	});
});
