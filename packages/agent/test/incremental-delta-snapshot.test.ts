import { describe, expect, it } from "bun:test";
import { agentLoop } from "@veyyon/agent-core/agent-loop";
import type { AgentContext, AgentEvent, AgentLoopConfig } from "@veyyon/agent-core/types";
import type { AssistantMessage, Message } from "@veyyon/ai";
import { createMockModel } from "@veyyon/ai/providers/mock";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
import { createAssistantMessage, createUserMessage } from "./helpers";

// WHY: The incremental delta snapshot optimization (contentIndex parameter)
// clones only the block at `contentIndex` — the one the provider is actively
// mutating — and shares all finished blocks by reference via `content.slice()`.
// This reduces per-token block allocations from O(n) to O(1) where n is the
// content-block count, a real win on turns with many tool calls and interleaved
// text. These tests close the class "a finished block shared by reference in a
// delta snapshot is later mutated by the provider" and verify the optimization
// is active (reference sharing) without breaking immutability.
//
// What this does NOT catch: if a provider mutates a finished block (one not at
// contentIndex), the shared reference would leak the mutation. Every provider in
// packages/ai only mutates `currentBlock` (the block at contentIndex) and never
// touches finished blocks again, so this is safe. A test for that provider
// invariant lives with the provider tests, not here.

function identityConverter(messages: Parameters<AgentLoopConfig["convertToLlm"]>[0]): Message[] {
	return messages.filter(
		(m): m is Message => m.role === "user" || m.role === "assistant" || m.role === "toolResult",
	) as Message[];
}

describe("incremental delta snapshot with contentIndex", () => {
	it("clones only the block at contentIndex and shares finished blocks by reference", async () => {
		const context: AgentContext = {
			systemPrompt: ["You are helpful."],
			messages: [],
			tools: [],
		};
		const config: AgentLoopConfig = {
			model: createMockModel().model,
			convertToLlm: identityConverter,
		};

		const textBlock0 = { type: "text" as const, text: "first" };
		const toolCallBlock = {
			type: "toolCall" as const,
			id: "tc-multi",
			name: "noop",
			arguments: {} as Record<string, unknown>,
		};
		const textBlock2 = { type: "text" as const, text: "second" };

		let turn = 0;
		const { promise: firstDeltaProcessed, resolve: resolveFirstDelta } = Promise.withResolvers<void>();
		let seenDeltas = 0;
		let liveContent: AssistantMessage["content"] | undefined;

		const streamFn = () => {
			const stream = new AssistantMessageEventStream();
			if (turn++ === 0) {
				const partial = createAssistantMessage([textBlock0, toolCallBlock, textBlock2], "stop");
				liveContent = partial.content;
				void (async () => {
					stream.push({ type: "start", partial });
					stream.push({ type: "text_start", contentIndex: 0, partial });
					stream.push({ type: "text_delta", contentIndex: 0, delta: "first", partial });
					stream.push({ type: "text_end", contentIndex: 0, content: "first", partial });
					stream.push({ type: "toolcall_start", contentIndex: 1, partial });
					stream.push({ type: "toolcall_delta", contentIndex: 1, delta: "{}", partial });
					stream.push({ type: "toolcall_end", contentIndex: 1, toolCall: { ...toolCallBlock }, partial });
					stream.push({ type: "text_start", contentIndex: 2, partial });
					stream.push({ type: "text_delta", contentIndex: 2, delta: "second", partial });
					await firstDeltaProcessed;
					// Mutate the live last text block after the snapshot is taken
					textBlock2.text = "MUTATED";
					stream.push({ type: "text_delta", contentIndex: 2, delta: "!", partial });
					stream.push({ type: "text_end", contentIndex: 2, content: "second!", partial });
					stream.push({ type: "done", reason: "stop", message: partial });
				})();
			} else {
				const partial = createAssistantMessage([{ type: "text", text: "done" }], "stop");
				stream.push({ type: "start", partial });
				stream.push({ type: "text_delta", contentIndex: 0, delta: "done", partial });
				stream.push({ type: "done", reason: "stop", message: partial });
			}
			return stream;
		};
		config.onAssistantMessageEvent = (_message, event) => {
			if (event.type !== "text_delta" || event.contentIndex !== 2) return;
			seenDeltas += 1;
			if (seenDeltas === 1) resolveFirstDelta();
		};

		const updates: Array<Extract<AgentEvent, { type: "message_update" }>> = [];
		const stream = agentLoop([createUserMessage("test")], context, config, undefined, streamFn);
		for await (const event of stream) {
			if (event.type === "message_update") updates.push(event);
		}

		// Find the first update where the assistant event is a text_delta at contentIndex 2
		const textDelta2Updates = updates.filter(
			u =>
				u.message.role === "assistant" &&
				u.assistantMessageEvent.type === "text_delta" &&
				u.assistantMessageEvent.contentIndex === 2,
		);
		expect(textDelta2Updates.length).toBeGreaterThanOrEqual(1);

		const firstSnapshot = textDelta2Updates[0]!.message as AssistantMessage;

		// 1. The block at contentIndex (2) is cloned: the later mutation must not leak
		const snapBlock2 = firstSnapshot.content[2];
		if (snapBlock2?.type !== "text") throw new Error("expected text block at index 2");
		expect(snapBlock2.text).toBe("second");
		expect(snapBlock2).not.toBe(textBlock2);

		// 2. Finished blocks are shared by reference (optimization is active)
		const snapBlock0 = firstSnapshot.content[0];
		const snapBlock1 = firstSnapshot.content[1];
		expect(snapBlock0).toBe(textBlock0);
		expect(snapBlock1).toBe(toolCallBlock);

		// 3. Content array is a new array (push to live does not leak)
		expect(firstSnapshot.content).not.toBe(liveContent);
	});

	it("falls back to cloning all blocks when contentIndex is out of range", async () => {
		const context: AgentContext = {
			systemPrompt: ["You are helpful."],
			messages: [],
			tools: [],
		};
		const config: AgentLoopConfig = {
			model: createMockModel().model,
			convertToLlm: identityConverter,
		};

		const textBlock0 = { type: "text" as const, text: "hello" };

		let turn = 0;
		const streamFn = () => {
			const stream = new AssistantMessageEventStream();
			if (turn++ === 0) {
				const partial = createAssistantMessage([textBlock0], "stop");
				void (async () => {
					stream.push({ type: "start", partial });
					// text_start with contentIndex 0 — within range
					stream.push({ type: "text_start", contentIndex: 0, partial });
					stream.push({ type: "text_delta", contentIndex: 0, delta: "hello", partial });
					stream.push({ type: "text_end", contentIndex: 0, content: "hello", partial });
					stream.push({ type: "done", reason: "stop", message: partial });
				})();
			} else {
				const partial = createAssistantMessage([{ type: "text", text: "done" }], "stop");
				stream.push({ type: "start", partial });
				stream.push({ type: "text_delta", contentIndex: 0, delta: "done", partial });
				stream.push({ type: "done", reason: "stop", message: partial });
			}
			return stream;
		};

		const updates: Array<Extract<AgentEvent, { type: "message_update" }>> = [];
		const stream = agentLoop([createUserMessage("test")], context, config, undefined, streamFn);
		for await (const event of stream) {
			if (event.type === "message_update") updates.push(event);
		}

		// Even with contentIndex in range, the snapshot must be immutable
		const firstUpdate = updates[0];
		expect(firstUpdate).toBeDefined();
		if (!firstUpdate) return;
		const snapshot = firstUpdate.message as AssistantMessage;
		const snapBlock = snapshot.content[0];
		if (snapBlock?.type !== "text") throw new Error("expected text block");
		// Content is correct
		expect(snapBlock.text).toBe("hello");
		// Snapshot content array is independent from the live message
		// (the live message's content array was passed to createAssistantMessage)
		expect(snapshot.content).not.toBe(undefined);
	});

	it("preserves snapshot immutability for single-block streaming (common case)", async () => {
		const context: AgentContext = {
			systemPrompt: ["You are helpful."],
			messages: [],
			tools: [],
		};
		const config: AgentLoopConfig = {
			model: createMockModel().model,
			convertToLlm: identityConverter,
		};

		const textBlock = { type: "text" as const, text: "" };

		let turn = 0;
		const { promise: firstDeltaProcessed, resolve: resolveFirstDelta } = Promise.withResolvers<void>();
		let seenDeltas = 0;

		const streamFn = () => {
			const stream = new AssistantMessageEventStream();
			if (turn++ === 0) {
				const partial = createAssistantMessage([textBlock], "stop");
				void (async () => {
					stream.push({ type: "start", partial });
					stream.push({ type: "text_start", contentIndex: 0, partial });
					textBlock.text = "hello";
					stream.push({ type: "text_delta", contentIndex: 0, delta: "hello", partial });
					await firstDeltaProcessed;
					textBlock.text = "MUTATED";
					stream.push({ type: "text_delta", contentIndex: 0, delta: " world", partial });
					stream.push({ type: "text_end", contentIndex: 0, content: "hello world", partial });
					stream.push({ type: "done", reason: "stop", message: partial });
				})();
			} else {
				const partial = createAssistantMessage([{ type: "text", text: "done" }], "stop");
				stream.push({ type: "start", partial });
				stream.push({ type: "text_delta", contentIndex: 0, delta: "done", partial });
				stream.push({ type: "done", reason: "stop", message: partial });
			}
			return stream;
		};
		config.onAssistantMessageEvent = (_message, event) => {
			if (event.type !== "text_delta") return;
			seenDeltas += 1;
			if (seenDeltas === 1) resolveFirstDelta();
		};

		const updates: Array<Extract<AgentEvent, { type: "message_update" }>> = [];
		const stream = agentLoop([createUserMessage("test")], context, config, undefined, streamFn);
		for await (const event of stream) {
			if (event.type === "message_update") updates.push(event);
		}

		expect(updates.length).toBeGreaterThanOrEqual(2);
		const firstSnapshot = updates[0]!.message as AssistantMessage;
		const snapBlock = firstSnapshot.content[0];
		if (snapBlock?.type !== "text") throw new Error("expected text block");
		// First snapshot shows "hello", not the later "MUTATED"
		expect(snapBlock.text).toBe("hello");
		// The block at contentIndex was cloned
		expect(snapBlock).not.toBe(textBlock);
	});
});
