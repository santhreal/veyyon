import { describe, expect, test } from "bun:test";
import {
	serializeConversation,
	serializeConversationForSummary,
	truncateToolResultForSummary,
} from "@veyyon/agent-core/compaction";
import type { AssistantMessage, Message, ToolResultMessage, Usage } from "@veyyon/ai";

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistantMessage(content: AssistantMessage["content"]): Message {
	return {
		role: "assistant",
		content,
		api: "mock",
		provider: "mock",
		model: "mock",
		usage: ZERO_USAGE,
		stopReason: "stop",
		timestamp: 0,
	};
}

function toolResultMessage(toolCallId: string, text: string, extra: Partial<ToolResultMessage> = {}): Message {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "search",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 0,
		...extra,
	};
}

describe("serializeConversation — useless pairs", () => {
	test("skips a useless-flagged tool call/result pair but keeps its sibling", () => {
		const out = serializeConversation([
			assistantMessage([
				{ type: "toolCall", id: "c-keep", name: "search", arguments: { pattern: "alpha" } },
				{ type: "toolCall", id: "c-drop", name: "search", arguments: { pattern: "zzz_nothing" } },
			]),
			toolResultMessage("c-keep", "alpha match found in src/alpha.ts"),
			toolResultMessage("c-drop", "No matches found", { useless: true }),
		]);

		expect(out).toContain('search(pattern="alpha")');
		expect(out).toContain("alpha match found in src/alpha.ts");
		expect(out).not.toContain("zzz_nothing");
		expect(out).not.toContain("No matches found");
	});

	test("error results stay serialized even when flagged useless", () => {
		const out = serializeConversation([
			assistantMessage([{ type: "toolCall", id: "c-err", name: "search", arguments: { pattern: "beta" } }]),
			toolResultMessage("c-err", "grep crashed", { useless: true, isError: true }),
		]);

		expect(out).toContain('search(pattern="beta")');
		expect(out).toContain("[Tool Result]: grep crashed");
	});

	test("legacy serializer renders user (string + array), thinking, text, and tool calls with role tags", () => {
		const out = serializeConversation([
			{ role: "user", content: "plain string prompt", timestamp: 0 },
			{ role: "user", content: [{ type: "text", text: "array prompt" }], timestamp: 0 },
			assistantMessage([
				{ type: "thinking", thinking: "let me consider" },
				{ type: "text", text: "here is the answer" },
				{ type: "toolCall", id: "c1", name: "search", arguments: { pattern: "delta" } },
			]),
			toolResultMessage("c1", "delta hit"),
		]);

		expect(out).toContain("[User]: plain string prompt");
		expect(out).toContain("[User]: array prompt");
		expect(out).toContain("[Think]: let me consider");
		expect(out).toContain("[Assistant]: here is the answer");
		expect(out).toContain('[Tool Call]: search(pattern="delta")');
		expect(out).toContain("[Tool Result]: delta hit");
	});

	test("legacy serializer skips an empty-content user message", () => {
		const out = serializeConversation([
			{ role: "user", content: [{ type: "image", data: "AAAA", mimeType: "image/png" }], timestamp: 0 },
			assistantMessage([{ type: "text", text: "reply" }]),
		]);
		expect(out).not.toContain("[User]:");
		expect(out).toContain("[Assistant]: reply");
	});

	test("renders native dialect transcripts when a dialect is provided", () => {
		const out = serializeConversation(
			[
				assistantMessage([
					{ type: "text", text: "Searching." },
					{ type: "toolCall", id: "c-native", name: "search", arguments: { pattern: "gamma" } },
				]),
				toolResultMessage("c-native", "gamma match found"),
			],
			"anthropic",
		);

		expect(out).toContain("\n\nAssistant:");
		expect(out).toContain("<function_calls>");
		expect(out).toContain("<function_results>");
		expect(out).not.toContain("[Tool Call]:");
		expect(out).not.toContain("[Assistant tool calls]:");
	});

	test("summary serialization escapes Harmony control tokens while preserving assistant thinking", () => {
		const messages = [
			assistantMessage([
				{ type: "thinking", thinking: "Need to inspect the failing compaction path." },
				{ type: "text", text: "The final answer stays visible." },
			]),
		];

		const out = serializeConversationForSummary(messages, "harmony");

		expect(out).not.toContain("<|channel|>analysis");
		expect(out).not.toContain("<|message|>");
		expect(out).toContain("<\\|channel\\|>analysis");
		expect(out).toContain("<\\|channel\\|>final");
		expect(out).toContain("Need to inspect the failing compaction path.");
		expect(out).toContain("The final answer stays visible.");
	});

	test("native Harmony serialization keeps raw transcript markers", () => {
		const out = serializeConversation(
			[
				assistantMessage([
					{ type: "thinking", thinking: "Native transcript includes analysis." },
					{ type: "text", text: "Native final text." },
				]),
			],
			"harmony",
		);

		expect(out).toContain("<|channel|>analysis");
		expect(out).toContain("<|message|>Native transcript includes analysis.");
		expect(out).toContain("<|channel|>final");
		expect(out).toContain("Native final text.");
	});

	test("dialect path renders user turns alongside assistant and tool messages", () => {
		const out = serializeConversation(
			[
				{ role: "user", content: "walk the login flow", timestamp: 0 },
				assistantMessage([
					{ type: "text", text: "Reading." },
					{ type: "toolCall", id: "c-u", name: "search", arguments: { pattern: "login" } },
				]),
				toolResultMessage("c-u", "login match in src/auth.ts"),
			],
			"anthropic",
		);
		expect(out).toContain("walk the login flow");
		expect(out).toContain("login match in src/auth.ts");
	});

	test("dialect path truncates an oversized tool result to 2000 chars plus a marker", () => {
		const big = "x".repeat(2500);
		const out = serializeConversation(
			[
				assistantMessage([{ type: "toolCall", id: "c-big", name: "search", arguments: { pattern: "big" } }]),
				toolResultMessage("c-big", big),
			],
			"anthropic",
		);
		expect(out).toContain("[... 500 more characters truncated]");
		expect(out).not.toContain("x".repeat(2001));
	});

	test("native dialect serialization drops empty assistants left by useless calls", () => {
		const out = serializeConversation(
			[
				assistantMessage([
					{ type: "toolCall", id: "c-drop", name: "search", arguments: { pattern: "zzz_nothing" } },
				]),
				toolResultMessage("c-drop", "No matches found", { useless: true }),
			],
			"harmony",
		);

		expect(out).toBe("");
	});
});

describe("truncateToolResultForSummary", () => {
	test("returns text at or below the 2000-char limit unchanged", () => {
		const exact = "y".repeat(2000);
		expect(truncateToolResultForSummary(exact)).toBe(exact);
		expect(truncateToolResultForSummary("short")).toBe("short");
	});

	test("truncates longer text and reports the exact dropped-character count", () => {
		const out = truncateToolResultForSummary("z".repeat(2000) + "q".repeat(123));
		expect(out).toBe(`${"z".repeat(2000)}\n\n[... 123 more characters truncated]`);
		expect(out).not.toContain("q");
	});
});
