// Regression: transformMessages previously ran two separate O(n) passes over
// the full message array — one to build realToolResultsById (for
// takeRealToolResult) and another to build validToolUseIds (for orphan
// detection). Merging them into a single pass must preserve identical
// behavior: tool results are still pulled into the right slots, orphans are
// still dropped, and the output array is byte-identical to the two-pass version.
import { describe, expect, it } from "bun:test";
import { transformMessages } from "@veyyon/ai/providers/transform-messages";
import type { AssistantMessage, Message, Model, ToolResultMessage } from "@veyyon/ai/types";
import { buildModel } from "@veyyon/catalog/build";

const model: Model<"anthropic-messages"> = buildModel({
	api: "anthropic-messages",
	provider: "anthropic",
	id: "claude-sonnet-4-5",
	name: "Claude Sonnet 4.5",
	baseUrl: "https://api.anthropic.com",
	input: ["text"],
	cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	maxTokens: 8192,
	contextWindow: 200000,
	reasoning: true,
});

function assistantWithToolCall(id: string, name = "read"): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name, arguments: { path: "a" } }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

function toolResultFor(toolCallId: string, text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: Date.now(),
	} as ToolResultMessage;
}

describe("transformMessages merged pre-pass (realToolResultsById + validToolUseIds)", () => {
	it("pulls real tool results into the correct slot after the assistant turn", () => {
		const messages: Message[] = [
			{ role: "user", content: "do it", timestamp: 1 },
			assistantWithToolCall("call_1"),
			toolResultFor("call_1", "result-1"),
			{ role: "user", content: "next", timestamp: 4 },
		];

		const transformed = transformMessages(messages, model);

		// The tool result must appear after the assistant turn.
		const assistantIdx = transformed.findIndex(m => m.role === "assistant");
		const resultIdx = transformed.findIndex(m => m.role === "toolResult");
		expect(assistantIdx).toBeGreaterThanOrEqual(0);
		expect(resultIdx).toBeGreaterThan(assistantIdx);
	});

	it("drops orphan tool results whose tool_use was removed by compaction", () => {
		const messages: Message[] = [
			{ role: "user", content: "do it", timestamp: 1 },
			// No assistant tool_use — the toolResult is an orphan.
			toolResultFor("orphan_call", "orphan-result"),
			{ role: "user", content: "next", timestamp: 3 },
		];

		const transformed = transformMessages(messages, model);

		// Orphan must be dropped (Anthropic 400s on tool_result without tool_use).
		const orphan = transformed.find(m => m.role === "toolResult" && m.toolCallId === "orphan_call");
		expect(orphan).toBeUndefined();
	});

	it("preserves orphan tool result text as a user message when no pending window is open", () => {
		const messages: Message[] = [
			{ role: "user", content: "do it", timestamp: 1 },
			toolResultFor("orphan_call", "orphan-result"),
			{ role: "user", content: "next", timestamp: 3 },
		];

		const transformed = transformMessages(messages, model);

		// The orphan's text must survive as a user message (stale-tool-result).
		const staleUserMsg = transformed.find(
			m => m.role === "user" && typeof m.content === "string" && m.content.includes("orphan-result"),
		);
		expect(staleUserMsg).toBeDefined();
	});

	it("handles duplicate tool call ids with multiple results correctly", () => {
		const messages: Message[] = [
			{ role: "user", content: "do it", timestamp: 1 },
			assistantWithToolCall("call_dup"),
			toolResultFor("call_dup", "result-1"),
			{ role: "user", content: "again", timestamp: 4 },
			assistantWithToolCall("call_dup"),
			toolResultFor("call_dup", "result-2"),
			{ role: "user", content: "done", timestamp: 7 },
		];

		const transformed = transformMessages(messages, model);

		// Both assistant turns must survive with distinct tool call ids.
		const toolCalls = transformed.flatMap(m =>
			m.role === "assistant" ? m.content.filter(b => b.type === "toolCall") : [],
		);
		expect(toolCalls.length).toBe(2);
		expect(toolCalls[0]!.id).not.toBe(toolCalls[1]!.id);

		// Both tool results must survive, each after its respective assistant turn.
		const results = transformed.filter(m => m.role === "toolResult");
		expect(results.length).toBe(2);
	});

	it("synthesizes 'No result provided' for tool calls without a matching result", () => {
		const messages: Message[] = [
			{ role: "user", content: "do it", timestamp: 1 },
			assistantWithToolCall("call_no_result"),
			{ role: "user", content: "next", timestamp: 3 },
		];

		const transformed = transformMessages(messages, model);

		// A synthetic tool result must be injected.
		const synthetic = transformed.find(m => m.role === "toolResult" && m.toolCallId === "call_no_result");
		expect(synthetic).toBeDefined();
		const content = (synthetic as ToolResultMessage).content;
		expect(content.some(b => b.type === "text" && b.text.includes("No result provided"))).toBe(true);
	});

	it("handles a large conversation with interleaved assistant/toolResult/user messages", () => {
		const messages: Message[] = [{ role: "user", content: "start", timestamp: 0 }];
		for (let i = 0; i < 100; i++) {
			messages.push(assistantWithToolCall(`call_${i}`));
			messages.push(toolResultFor(`call_${i}`, `result-${i}`));
			messages.push({ role: "user", content: `turn-${i}`, timestamp: i * 3 + 3 });
		}

		const transformed = transformMessages(messages, model);

		// Every tool call must be followed by its tool result.
		for (let i = 0; i < transformed.length - 1; i++) {
			const msg = transformed[i]!;
			if (msg.role === "assistant") {
				const toolCalls = msg.content.filter(b => b.type === "toolCall");
				for (const tc of toolCalls) {
					const resultIdx = transformed.findIndex(
						m => m.role === "toolResult" && m.toolCallId === (tc as { id: string }).id,
					);
					expect(resultIdx).toBeGreaterThan(i);
				}
			}
		}
	});

	it("does not emit a second result for a tool call that already has one", () => {
		const messages: Message[] = [
			{ role: "user", content: "do it", timestamp: 1 },
			assistantWithToolCall("call_1"),
			toolResultFor("call_1", "result-1"),
			// Duplicate result — must be dropped.
			toolResultFor("call_1", "result-2"),
			{ role: "user", content: "next", timestamp: 5 },
		];

		const transformed = transformMessages(messages, model);

		const results = transformed.filter(m => m.role === "toolResult" && m.toolCallId === "call_1");
		expect(results.length).toBe(1);
	});
});
