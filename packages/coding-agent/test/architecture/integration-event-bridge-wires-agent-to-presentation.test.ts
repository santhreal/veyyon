/**
 * WHY: `PresentationEventBridge` is the only module that sees both the session's
 * events and the renderer's contract, so it is the only place a wiring defect
 * can hide. The class this closes is a streamed update that lands on the wrong
 * block, or on no block: an assistant turn that appends a second block per
 * delta, a tool result that appends instead of patching the running call, a
 * seeded transcript whose ids disagree with the ones the live path assigns.
 *
 * The bridge is driven through its real public surface with a recording
 * `PresentationContext`. The context is the boundary, not the subject, so
 * recording it is observation rather than mocking the thing under test.
 * `AgentSession` satisfying `PresentationEventSource` is pinned by a type-level
 * assignment, which is what keeps the narrow source interface honest without
 * booting a session.
 *
 * What it does NOT catch: whether a real session emits these events in this
 * order (that is the session's own suite), and it does not cover status-line or
 * composer pushes, which no session event drives.
 */

import { describe, expect, test } from "bun:test";
import type { AgentEvent, AgentMessage } from "@veyyon/agent-core";
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
import type { AgentSession, AgentSessionEvent } from "../../src/session/agent-session";

/**
 * A session is a valid event source without the bridge knowing anything else
 * about it. If `subscribe` or `messages` changes shape, this fails to compile.
 */
type SessionIsAnEventSource = AgentSession extends PresentationEventSource ? true : never;
const SESSION_IS_AN_EVENT_SOURCE: SessionIsAnEventSource = true;

/** Records every call the bridge makes, in order. */
class RecordingPresentation implements PresentationContext {
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
		const index = this.blocks.findIndex(block => block.id === id);
		if (index < 0) return;
		this.blocks[index] = { ...this.blocks[index]!, ...patch } as TranscriptBlock;
	}

	removeTranscriptBlock(id: BlockId): void {
		this.calls.push(`remove:${id}`);
		this.blocks = this.blocks.filter(block => block.id !== id);
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
		return Promise.resolve({ id: "unused", outcome: "cancelled" });
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

/** A session stand-in that emits exactly the events a test asks for. */
class FakeSource implements PresentationEventSource {
	messages: AgentMessage[];
	#listeners = new Set<(event: AgentSessionEvent) => void>();
	unsubscribeCount = 0;

	constructor(messages: AgentMessage[] = []) {
		this.messages = messages;
	}

	subscribe(listener: (event: AgentSessionEvent) => void): () => void {
		this.#listeners.add(listener);
		return () => {
			this.unsubscribeCount++;
			this.#listeners.delete(listener);
		};
	}

	emit(event: AgentEvent | AgentSessionEvent): void {
		for (const listener of [...this.#listeners]) listener(event as AgentSessionEvent);
	}

	get listenerCount(): number {
		return this.#listeners.size;
	}
}

function assistant(text: string, streaming: boolean): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		model: "test-model",
		stopReason: streaming ? "stop" : "stop",
		timestamp: 1_700_000_000_000,
	} as AgentMessage;
}

function connect(messages: AgentMessage[] = []): {
	source: FakeSource;
	presentation: RecordingPresentation;
	bridge: PresentationEventBridge;
} {
	const source = new FakeSource(messages);
	const presentation = new RecordingPresentation();
	const bridge = new PresentationEventBridge(source, presentation);
	bridge.connect();
	return { source, presentation, bridge };
}

describe("connecting seeds before it follows", () => {
	test("the renderer gets the existing transcript in one replace", () => {
		const { presentation } = connect([
			{ role: "user", content: "hi", timestamp: 1 } as AgentMessage,
			assistant("hello", false),
		]);
		// One replace, then nothing: an incremental append for a message the
		// renderer has not seen is the defect.
		expect(presentation.calls).toEqual(["set:2"]);
		expect(presentation.blocks.map(block => block.kind)).toEqual(["user-message", "assistant-message"]);
	});

	test("connecting twice does not subscribe twice", () => {
		const source = new FakeSource();
		const bridge = new PresentationEventBridge(source, new RecordingPresentation());
		bridge.connect();
		bridge.connect();
		expect(source.listenerCount).toBe(1);
		expect(bridge.connected).toBe(true);
	});

	test("disconnect unsubscribes and stops delivering", () => {
		const { source, presentation, bridge } = connect();
		bridge.disconnect();
		expect(bridge.connected).toBe(false);
		expect(source.unsubscribeCount).toBe(1);
		source.emit({ type: "message_start", message: assistant("late", true) });
		expect(presentation.calls).toEqual(["set:0"]);
	});

	test("disconnect twice is not an error and unsubscribes once", () => {
		const { source, bridge } = connect();
		bridge.disconnect();
		bridge.disconnect();
		expect(source.unsubscribeCount).toBe(1);
	});
});

describe("a streamed assistant turn stays one block", () => {
	test("start appends once and updates patch that same id", () => {
		const { source, presentation } = connect();
		const message = assistant("", true);
		source.emit({ type: "message_start", message });
		const id = presentation.blocks[0]!.id;
		// The provider re-emits the same message object with more content, so the
		// bridge has to recognise it rather than treat each delta as a new turn.
		source.emit({
			type: "message_update",
			message,
			assistantMessageEvent: { type: "text_start", contentIndex: 0 },
		} as AgentEvent);
		source.emit({ type: "message_end", message });
		expect(presentation.calls).toEqual(["set:0", `append:${id}`, `update:${id}`, `update:${id}`]);
		expect(presentation.blocks).toHaveLength(1);
	});

	test("streaming is true until message_end", () => {
		const { source, presentation } = connect();
		const message = assistant("partial", true);
		source.emit({ type: "message_start", message });
		const streamingBlock = presentation.blocks[0]!;
		if (streamingBlock.kind !== "assistant-message") throw new Error("expected an assistant block");
		expect(streamingBlock.streaming).toBe(true);
		source.emit({ type: "message_end", message });
		const finalBlock = presentation.blocks[0]!;
		if (finalBlock.kind !== "assistant-message") throw new Error("expected an assistant block");
		expect(finalBlock.streaming).toBe(false);
	});

	test("two separate turns get two blocks", () => {
		const { source, presentation } = connect();
		const first = assistant("one", true);
		const second = assistant("two", true);
		source.emit({ type: "message_start", message: first });
		source.emit({ type: "message_end", message: first });
		source.emit({ type: "message_start", message: second });
		source.emit({ type: "message_end", message: second });
		expect(presentation.blocks).toHaveLength(2);
		expect(presentation.blocks[0]!.id).not.toBe(presentation.blocks[1]!.id);
	});

	test("a seeded message keeps the id it was seeded with", () => {
		const message = assistant("resumed", false);
		const { source, presentation } = connect([message]);
		const seededId = presentation.blocks[0]!.id;
		// A resumed session re-emits its last message; the bridge must patch the
		// seeded block instead of appending a duplicate below it.
		source.emit({ type: "message_end", message });
		expect(presentation.calls).toEqual(["set:1", `update:${seededId}`]);
		expect(presentation.blocks).toHaveLength(1);
	});

	test("a hidden message never reaches the renderer", () => {
		const { source, presentation } = connect();
		const steering = { role: "user", content: "stop", steering: true, timestamp: 1 } as unknown as AgentMessage;
		source.emit({ type: "message_start", message: steering });
		source.emit({ type: "message_end", message: steering });
		expect(presentation.calls).toEqual(["set:0"]);
	});
});

describe("a tool execution is keyed by its call id", () => {
	test("start appends a running block and end patches it", () => {
		const { source, presentation, bridge } = connect();
		source.emit({ type: "tool_execution_start", toolCallId: "c1", toolName: "read", args: { path: "a.ts" } });
		expect(bridge.runningToolCalls.has("c1")).toBe(true);
		const block = presentation.blocks[0]!;
		expect(block.id).toBe("tool:c1");
		if (block.kind !== "tool-execution") throw new Error("expected a tool block");
		expect(block.status).toBe("running");
		expect(block.input).toContain("a.ts");

		source.emit({
			type: "tool_execution_end",
			toolCallId: "c1",
			toolName: "read",
			result: { content: [{ type: "text", text: "body" }] },
		} as AgentEvent);
		expect(bridge.runningToolCalls.has("c1")).toBe(false);
		const done = presentation.blocks[0]!;
		if (done.kind !== "tool-execution") throw new Error("expected a tool block");
		expect(done.status).toBe("succeeded");
		expect(done.output).toBe("body");
		expect(presentation.blocks).toHaveLength(1);
	});

	test("a partial result patches output without a second block", () => {
		const { source, presentation } = connect();
		source.emit({ type: "tool_execution_start", toolCallId: "c2", toolName: "bash", args: {} });
		source.emit({
			type: "tool_execution_update",
			toolCallId: "c2",
			toolName: "bash",
			args: {},
			partialResult: { content: [{ type: "text", text: "line 1" }] },
		} as AgentEvent);
		expect(presentation.calls).toEqual(["set:0", "append:tool:c2", "update:tool:c2"]);
		const block = presentation.blocks[0]!;
		if (block.kind !== "tool-execution") throw new Error("expected a tool block");
		expect(block.output).toBe("line 1");
		expect(block.status).toBe("running");
	});

	test("isError on the event marks the call failed and routes text to error", () => {
		const { source, presentation } = connect();
		source.emit({ type: "tool_execution_start", toolCallId: "c3", toolName: "edit", args: {} });
		source.emit({
			type: "tool_execution_end",
			toolCallId: "c3",
			toolName: "edit",
			result: { content: [{ type: "text", text: "stale tag" }] },
			isError: true,
		} as AgentEvent);
		const block = presentation.blocks[0]!;
		if (block.kind !== "tool-execution") throw new Error("expected a tool block");
		expect(block.status).toBe("failed");
		expect(block.error).toBe("stale tag");
		expect(block.output).toBeUndefined();
	});

	test("isError on the result alone still marks the call failed", () => {
		// Providers report a tool failure on the result, not the event. Reading only
		// the event silently renders a failed call as succeeded.
		const { source, presentation } = connect();
		source.emit({ type: "tool_execution_start", toolCallId: "c4", toolName: "edit", args: {} });
		source.emit({
			type: "tool_execution_end",
			toolCallId: "c4",
			toolName: "edit",
			result: { isError: true, content: [{ type: "text", text: "no such file" }] },
		} as AgentEvent);
		const block = presentation.blocks[0]!;
		if (block.kind !== "tool-execution") throw new Error("expected a tool block");
		expect(block.status).toBe("failed");
		expect(block.error).toBe("no such file");
	});

	test("concurrent calls each keep their own block", () => {
		const { source, presentation, bridge } = connect();
		source.emit({ type: "tool_execution_start", toolCallId: "a", toolName: "read", args: {} });
		source.emit({ type: "tool_execution_start", toolCallId: "b", toolName: "grep", args: {} });
		expect([...bridge.runningToolCalls].sort()).toEqual(["a", "b"]);
		source.emit({
			type: "tool_execution_end",
			toolCallId: "b",
			toolName: "grep",
			result: { content: [] },
		} as AgentEvent);
		expect([...bridge.runningToolCalls]).toEqual(["a"]);
		expect(presentation.blocks.map(block => block.id)).toEqual(["tool:a", "tool:b"]);
		const stillRunning = presentation.blocks[0]!;
		if (stillRunning.kind !== "tool-execution") throw new Error("expected a tool block");
		expect(stillRunning.status).toBe("running");
	});

	test("disconnect drops the running set so a reconnect does not report stale calls", () => {
		const { source, bridge } = connect();
		source.emit({ type: "tool_execution_start", toolCallId: "c5", toolName: "read", args: {} });
		bridge.disconnect();
		expect(bridge.runningToolCalls.size).toBe(0);
	});
});

describe("notices", () => {
	test("an error notice enters the transcript", () => {
		const { source, presentation } = connect();
		source.emit({ type: "notice", level: "error", message: "provider refused" });
		const block = presentation.blocks[0]!;
		expect(block.kind).toBe("error");
		if (block.kind !== "error") throw new Error("unreachable");
		expect(block.message).toBe("provider refused");
		expect(block.recoverable).toBe(true);
	});

	test("info and warning notices do not", () => {
		// They are session state; the status line owns session state. Appending them
		// as blocks buries the transcript under retry chatter.
		const { source, presentation } = connect();
		source.emit({ type: "notice", level: "info", message: "compacting" });
		source.emit({ type: "notice", level: "warning", message: "rate limited" });
		expect(presentation.calls).toEqual(["set:0"]);
	});

	test("two error notices get distinct ids", () => {
		const { source, presentation } = connect();
		source.emit({ type: "notice", level: "error", message: "one" });
		source.emit({ type: "notice", level: "error", message: "two" });
		expect(presentation.blocks[0]!.id).not.toBe(presentation.blocks[1]!.id);
	});
});

describe("events that draw nothing draw nothing", () => {
	test.each([
		{ type: "agent_start" },
		{ type: "turn_start" },
		{ type: "auto_compaction_start", reason: "threshold", action: "compact" },
		{ type: "thinking_level_changed", thinkingLevel: undefined },
		{ type: "cwd_changed", previous: "/a", cwd: "/b" },
		{ type: "todo_auto_clear" },
	])("$type touches no transcript block", event => {
		// The default arm must stay silent rather than appending a block per event:
		// a session emits hundreds of these per turn.
		const { source, presentation } = connect();
		source.emit(event as AgentSessionEvent);
		expect(presentation.calls).toEqual(["set:0"]);
	});
});

test("the session-is-an-event-source lock is evaluated", () => {
	expect(SESSION_IS_AN_EVENT_SOURCE).toBe(true);
});
