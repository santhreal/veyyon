import { describe, expect, it } from "bun:test";
import type { AssistantMessage, ToolResultMessage } from "@veyyon/ai";
import type { SessionEntry } from "../src/compaction/entries";
import {
	collectToolCallsById,
	getReadToolPath,
	isProtectedToolResult,
	isSkillReadToolResult,
	type ProtectedToolContext,
	type ProtectedToolMatcher,
} from "../src/compaction/tool-protection";
import type { AgentToolCall } from "../src/types";

function makeToolCall(id: string, name: string, args: Record<string, unknown> = {}): AgentToolCall {
	return { id, name, arguments: args } as unknown as AgentToolCall;
}

function makeAssistantMessage(content: AgentToolCall[]): AssistantMessage {
	return {
		role: "assistant",
		content: content.map(c => ({ type: "toolCall", id: c.id, name: c.name, arguments: c.arguments })),
		stopReason: "tool_use",
	} as unknown as AssistantMessage;
}

function makeToolResultMessage(toolName: string, toolCallId: string): ToolResultMessage {
	return {
		role: "tool",
		toolName,
		toolCallId,
		content: [],
	} as unknown as ToolResultMessage;
}

function makeMessageEntry(message: AssistantMessage): SessionEntry {
	return { type: "message", message } as SessionEntry;
}

describe("collectToolCallsById", () => {
	it("collects tool calls from assistant messages", () => {
		const entries: SessionEntry[] = [
			makeMessageEntry(makeAssistantMessage([makeToolCall("call-1", "read"), makeToolCall("call-2", "write")])),
		];
		const map = collectToolCallsById(entries);
		expect(map.size).toBe(2);
		expect(map.get("call-1")?.name).toBe("read");
		expect(map.get("call-2")?.name).toBe("write");
	});
	it("skips non-message entries", () => {
		const entries: SessionEntry[] = [
			{ type: "summary", summary: "test" } as unknown as SessionEntry,
			makeMessageEntry(makeAssistantMessage([makeToolCall("call-1", "read")])),
		];
		expect(collectToolCallsById(entries).size).toBe(1);
	});
	it("skips user messages", () => {
		const entries: SessionEntry[] = [
			makeMessageEntry({ role: "user", content: [] } as unknown as AssistantMessage),
			makeMessageEntry(makeAssistantMessage([makeToolCall("call-1", "read")])),
		];
		expect(collectToolCallsById(entries).size).toBe(1);
	});
	it("skips text blocks in assistant messages", () => {
		const entries: SessionEntry[] = [
			makeMessageEntry({
				role: "assistant",
				content: [
					{ type: "text", text: "hello" },
					{ type: "toolCall", id: "c1", name: "read" },
				],
				stopReason: "tool_use",
			} as unknown as AssistantMessage),
		];
		expect(collectToolCallsById(entries).size).toBe(1);
	});
	it("returns empty map for empty entries", () => {
		expect(collectToolCallsById([]).size).toBe(0);
	});
	it("last tool call with same id wins", () => {
		const entries: SessionEntry[] = [
			makeMessageEntry(makeAssistantMessage([makeToolCall("call-1", "read")])),
			makeMessageEntry(makeAssistantMessage([makeToolCall("call-1", "write")])),
		];
		const map = collectToolCallsById(entries);
		expect(map.get("call-1")?.name).toBe("write");
	});
});

describe("getReadToolPath", () => {
	it("returns path for read tool", () => {
		const ctx: ProtectedToolContext = {
			toolResult: makeToolResultMessage("read", "c1"),
			toolCall: makeToolCall("c1", "read", { path: "/some/path" }),
		};
		expect(getReadToolPath(ctx)).toBe("/some/path");
	});
	it("returns undefined when toolResult is not read", () => {
		const ctx: ProtectedToolContext = {
			toolResult: makeToolResultMessage("write", "c1"),
			toolCall: makeToolCall("c1", "read", { path: "/some/path" }),
		};
		expect(getReadToolPath(ctx)).toBeUndefined();
	});
	it("returns undefined when toolCall is not read", () => {
		const ctx: ProtectedToolContext = {
			toolResult: makeToolResultMessage("read", "c1"),
			toolCall: makeToolCall("c1", "write", { path: "/some/path" }),
		};
		expect(getReadToolPath(ctx)).toBeUndefined();
	});
	it("returns undefined when toolCall is undefined", () => {
		const ctx: ProtectedToolContext = {
			toolResult: makeToolResultMessage("read", "c1"),
			toolCall: undefined,
		};
		expect(getReadToolPath(ctx)).toBeUndefined();
	});
	it("returns undefined when path is not a string", () => {
		const ctx: ProtectedToolContext = {
			toolResult: makeToolResultMessage("read", "c1"),
			toolCall: makeToolCall("c1", "read", { path: 123 }),
		};
		expect(getReadToolPath(ctx)).toBeUndefined();
	});
	it("returns undefined when path is missing", () => {
		const ctx: ProtectedToolContext = {
			toolResult: makeToolResultMessage("read", "c1"),
			toolCall: makeToolCall("c1", "read", {}),
		};
		expect(getReadToolPath(ctx)).toBeUndefined();
	});
});

describe("isSkillReadToolResult", () => {
	it("returns true for skill:// path", () => {
		const ctx: ProtectedToolContext = {
			toolResult: makeToolResultMessage("read", "c1"),
			toolCall: makeToolCall("c1", "read", { path: "skill://my-skill" }),
		};
		expect(isSkillReadToolResult(ctx)).toBe(true);
	});
	it("returns true for skill:// path with subpath", () => {
		const ctx: ProtectedToolContext = {
			toolResult: makeToolResultMessage("read", "c1"),
			toolCall: makeToolCall("c1", "read", { path: "skill://my-skill/notes.md" }),
		};
		expect(isSkillReadToolResult(ctx)).toBe(true);
	});
	it("returns false for regular path", () => {
		const ctx: ProtectedToolContext = {
			toolResult: makeToolResultMessage("read", "c1"),
			toolCall: makeToolCall("c1", "read", { path: "/regular/path" }),
		};
		expect(isSkillReadToolResult(ctx)).toBe(false);
	});
	it("returns false when no path", () => {
		const ctx: ProtectedToolContext = {
			toolResult: makeToolResultMessage("read", "c1"),
			toolCall: makeToolCall("c1", "read", {}),
		};
		expect(isSkillReadToolResult(ctx)).toBe(false);
	});
	it("returns false when not read tool", () => {
		const ctx: ProtectedToolContext = {
			toolResult: makeToolResultMessage("write", "c1"),
			toolCall: makeToolCall("c1", "write", { path: "skill://my-skill" }),
		};
		expect(isSkillReadToolResult(ctx)).toBe(false);
	});
});

describe("isProtectedToolResult", () => {
	it("matches by string tool name", () => {
		expect(isProtectedToolResult(makeToolResultMessage("read", "c1"), undefined, ["read"])).toBe(true);
	});
	it("does not match wrong string tool name", () => {
		expect(isProtectedToolResult(makeToolResultMessage("write", "c1"), undefined, ["read"])).toBe(false);
	});
	it("matches by function matcher", () => {
		const matcher: ProtectedToolMatcher = ctx => ctx.toolResult.toolName === "read";
		expect(isProtectedToolResult(makeToolResultMessage("read", "c1"), undefined, [matcher])).toBe(true);
	});
	it("returns false when no matchers", () => {
		expect(isProtectedToolResult(makeToolResultMessage("read", "c1"), undefined, [])).toBe(false);
	});
	it("matches first of multiple matchers", () => {
		expect(isProtectedToolResult(makeToolResultMessage("write", "c1"), undefined, ["read", "write"])).toBe(true);
	});
	it("matches function matcher with toolCall context", () => {
		const matcher: ProtectedToolMatcher = ctx => ctx.toolCall?.name === "read";
		expect(isProtectedToolResult(makeToolResultMessage("read", "c1"), makeToolCall("c1", "read"), [matcher])).toBe(
			true,
		);
	});
	it("function matcher returning false does not match", () => {
		const matcher: ProtectedToolMatcher = () => false;
		expect(isProtectedToolResult(makeToolResultMessage("read", "c1"), undefined, [matcher])).toBe(false);
	});
	it("mix of string and function matchers", () => {
		const fnMatcher: ProtectedToolMatcher = ctx => ctx.toolResult.toolName === "special";
		expect(isProtectedToolResult(makeToolResultMessage("special", "c1"), undefined, ["read", fnMatcher])).toBe(true);
	});
});
