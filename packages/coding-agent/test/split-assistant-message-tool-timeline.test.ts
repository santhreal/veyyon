/**
 * WHY. `splitAssistantMessageToolTimeline` runs on every streaming
 * `message_update` event and every transcript rebuild. The fast path added a
 * pre-scan for `toolCall` blocks so text-only and thinking-only messages
 * (the common case during streaming) skip allocating the `beforeTools` array,
 * `afterToolCalls` Map, and `pendingAfterTool` array. These tests verify the
 * fast path returns identical results to the full walk: same `beforeTools`
 * reference, empty `afterToolCalls`, `hasToolCalls: false`, and that messages
 * with tool calls still split correctly.
 */
import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@veyyon/agent-core";
import type { AssistantMessage } from "@veyyon/ai";
import { splitAssistantMessageToolTimeline } from "@veyyon/coding-agent/modes/utils/transcript-render-helpers";

function assistant(content: AssistantMessage["content"]): Extract<AgentMessage, { role: "assistant" }> {
	return {
		role: "assistant",
		content,
		timestamp: 1000,
		provider: "mock",
		model: "mock",
		api: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
	};
}

describe("splitAssistantMessageToolTimeline — fast path (no tool calls)", () => {
	test("text-only message returns original reference and empty afterToolCalls", () => {
		const msg = assistant([{ type: "text", text: "Hello world" }]);
		const result = splitAssistantMessageToolTimeline(msg);

		expect(result.hasToolCalls).toBe(false);
		expect(result.beforeTools).toBe(msg);
		expect(result.afterToolCalls.size).toBe(0);
	});

	test("thinking-only message returns original reference and empty afterToolCalls", () => {
		const msg = assistant([{ type: "thinking", thinking: "Let me consider..." }]);
		const result = splitAssistantMessageToolTimeline(msg);

		expect(result.hasToolCalls).toBe(false);
		expect(result.beforeTools).toBe(msg);
		expect(result.afterToolCalls.size).toBe(0);
	});

	test("mixed text+thinking without tool calls returns original reference", () => {
		const msg = assistant([
			{ type: "thinking", thinking: "Reasoning..." },
			{ type: "text", text: "Answer" },
		]);
		const result = splitAssistantMessageToolTimeline(msg);

		expect(result.hasToolCalls).toBe(false);
		expect(result.beforeTools).toBe(msg);
		expect(result.afterToolCalls.size).toBe(0);
	});

	test("empty content array returns original reference", () => {
		const msg = assistant([]);
		const result = splitAssistantMessageToolTimeline(msg);

		expect(result.hasToolCalls).toBe(false);
		expect(result.beforeTools).toBe(msg);
		expect(result.afterToolCalls.size).toBe(0);
	});
});

describe("splitAssistantMessageToolTimeline — full walk (with tool calls)", () => {
	test("text before tool call is in beforeTools, afterToolCalls is empty when nothing follows", () => {
		const msg = assistant([
			{ type: "text", text: "Let me read that file" },
			{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "src/foo.ts" } },
		]);
		const result = splitAssistantMessageToolTimeline(msg);

		expect(result.hasToolCalls).toBe(true);
		expect(result.beforeTools).not.toBe(msg);
		expect(result.beforeTools.content).toHaveLength(1);
		expect(result.beforeTools.content[0]).toMatchObject({ type: "text", text: "Let me read that file" });
		expect(result.afterToolCalls.size).toBe(0);
	});

	test("content after a tool call goes into afterToolCalls map", () => {
		const msg = assistant([
			{ type: "text", text: "Reading..." },
			{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "src/foo.ts" } },
			{ type: "text", text: "Done reading" },
		]);
		const result = splitAssistantMessageToolTimeline(msg);

		expect(result.hasToolCalls).toBe(true);
		expect(result.beforeTools.content).toHaveLength(1);
		expect(result.beforeTools.content[0]).toMatchObject({ type: "text", text: "Reading..." });
		expect(result.afterToolCalls.size).toBe(1);
		const after = result.afterToolCalls.get("call-1");
		expect(after).toBeDefined();
		expect(after!.content).toHaveLength(1);
		expect(after!.content[0]).toMatchObject({ type: "text", text: "Done reading" });
	});

	test("multiple tool calls each get their own afterToolCalls entry", () => {
		const msg = assistant([
			{ type: "text", text: "Starting" },
			{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.ts" } },
			{ type: "text", text: "After first" },
			{ type: "toolCall", id: "call-2", name: "read", arguments: { path: "b.ts" } },
			{ type: "text", text: "After second" },
		]);
		const result = splitAssistantMessageToolTimeline(msg);

		expect(result.hasToolCalls).toBe(true);
		expect(result.beforeTools.content).toHaveLength(1);
		expect(result.beforeTools.content[0]).toMatchObject({ type: "text", text: "Starting" });
		expect(result.afterToolCalls.size).toBe(2);
		expect(result.afterToolCalls.get("call-1")!.content).toHaveLength(1);
		expect(result.afterToolCalls.get("call-1")!.content[0]).toMatchObject({ type: "text", text: "After first" });
		expect(result.afterToolCalls.get("call-2")!.content).toHaveLength(1);
		expect(result.afterToolCalls.get("call-2")!.content[0]).toMatchObject({ type: "text", text: "After second" });
	});

	test("displaySegment scrubs stopReason and errorMessage on after-tool segments", () => {
		const msg = assistant([
			{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.ts" } },
			{ type: "text", text: "After" },
		]);
		msg.stopReason = "error";
		msg.errorMessage = "Something went wrong";
		const result = splitAssistantMessageToolTimeline(msg);

		expect(result.hasToolCalls).toBe(true);
		const after = result.afterToolCalls.get("call-1")!;
		expect(after.stopReason).toBe("stop");
		expect(after.errorMessage).toBeUndefined();
	});

	test("beforeTools keeps the original stopReason on the leading segment", () => {
		const msg = assistant([
			{ type: "text", text: "Head" },
			{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.ts" } },
		]);
		msg.stopReason = "end_turn";
		const result = splitAssistantMessageToolTimeline(msg);

		expect(result.hasToolCalls).toBe(true);
		expect(result.beforeTools.stopReason).toBe("end_turn");
	});
});
