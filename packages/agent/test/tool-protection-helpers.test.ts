import { describe, expect, it } from "bun:test";
import type { ToolResultMessage } from "@veyyon/ai";
import type { SessionEntry } from "../src/compaction/entries";
import {
	collectToolCallsById,
	getReadToolPath,
	isProtectedToolResult,
	isSkillReadToolResult,
	type ProtectedToolContext,
} from "../src/compaction/tool-protection";
import type { AgentMessage, AgentToolCall } from "../src/types";

function makeToolResult(toolName: string, overrides: Partial<ToolResultMessage> = {}): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "call1",
		toolName,
		content: [{ type: "text", text: "result" }],
		isError: false,
		timestamp: 0,
		...overrides,
	} as unknown as ToolResultMessage;
}

function makeToolCall(name: string, args: Record<string, unknown> = {}, id = "call1"): AgentToolCall {
	return {
		type: "toolCall",
		id,
		name,
		arguments: args,
	} as unknown as AgentToolCall;
}

function makeAssistantMessage(content: AgentToolCall[]): AgentMessage {
	return {
		role: "assistant",
		content,
	} as unknown as AgentMessage;
}

function makeMessageEntry(message: AgentMessage): SessionEntry {
	return {
		id: "entry1",
		type: "message",
		timestamp: 0,
		message,
	} as unknown as SessionEntry;
}

describe("collectToolCallsById", () => {
	it("returns empty map for empty entries", () => {
		expect(collectToolCallsById([]).size).toBe(0);
	});

	it("returns empty map when no assistant messages", () => {
		const entries: SessionEntry[] = [
			makeMessageEntry({ role: "user", content: "hello", timestamp: 0 } as unknown as AgentMessage),
		];
		expect(collectToolCallsById(entries).size).toBe(0);
	});

	it("collects tool calls from assistant messages", () => {
		const call = makeToolCall("read", { path: "foo.ts" });
		const entries: SessionEntry[] = [makeMessageEntry(makeAssistantMessage([call]))];
		const result = collectToolCallsById(entries);
		expect(result.size).toBe(1);
		expect(result.get("call1")).toBe(call);
	});

	it("collects multiple tool calls", () => {
		const call1 = makeToolCall("read", { path: "a.ts" }, "c1");
		const call2 = makeToolCall("write", { path: "b.ts" }, "c2");
		const entries: SessionEntry[] = [makeMessageEntry(makeAssistantMessage([call1, call2]))];
		const result = collectToolCallsById(entries);
		expect(result.size).toBe(2);
		expect(result.get("c1")).toBe(call1);
		expect(result.get("c2")).toBe(call2);
	});

	it("skips non-message entries", () => {
		const entry: SessionEntry = {
			id: "1",
			type: "compaction",
			timestamp: 0,
		} as unknown as SessionEntry;
		expect(collectToolCallsById([entry]).size).toBe(0);
	});

	it("skips non-toolCall blocks in assistant content", () => {
		const msg = {
			role: "assistant",
			content: [{ type: "text", text: "hello" }],
		} as unknown as AgentMessage;
		const entries: SessionEntry[] = [makeMessageEntry(msg)];
		expect(collectToolCallsById(entries).size).toBe(0);
	});

	it("collects from multiple assistant messages", () => {
		const call1 = makeToolCall("read", {}, "c1");
		const call2 = makeToolCall("write", {}, "c2");
		const entries: SessionEntry[] = [
			makeMessageEntry(makeAssistantMessage([call1])),
			makeMessageEntry(makeAssistantMessage([call2])),
		];
		expect(collectToolCallsById(entries).size).toBe(2);
	});
});

describe("getReadToolPath", () => {
	it("returns undefined when toolResult is not read", () => {
		const ctx: ProtectedToolContext = {
			toolResult: makeToolResult("write"),
			toolCall: makeToolCall("read", { path: "foo.ts" }),
		};
		expect(getReadToolPath(ctx)).toBeUndefined();
	});

	it("returns undefined when toolCall is not read", () => {
		const ctx: ProtectedToolContext = {
			toolResult: makeToolResult("read"),
			toolCall: makeToolCall("write", { path: "foo.ts" }),
		};
		expect(getReadToolPath(ctx)).toBeUndefined();
	});

	it("returns undefined when toolCall is undefined", () => {
		const ctx: ProtectedToolContext = {
			toolResult: makeToolResult("read"),
			toolCall: undefined,
		};
		expect(getReadToolPath(ctx)).toBeUndefined();
	});

	it("returns path when both are read and path is string", () => {
		const ctx: ProtectedToolContext = {
			toolResult: makeToolResult("read"),
			toolCall: makeToolCall("read", { path: "src/foo.ts" }),
		};
		expect(getReadToolPath(ctx)).toBe("src/foo.ts");
	});

	it("returns undefined when path is not a string", () => {
		const ctx: ProtectedToolContext = {
			toolResult: makeToolResult("read"),
			toolCall: makeToolCall("read", { path: 42 }),
		};
		expect(getReadToolPath(ctx)).toBeUndefined();
	});

	it("returns undefined when path is missing", () => {
		const ctx: ProtectedToolContext = {
			toolResult: makeToolResult("read"),
			toolCall: makeToolCall("read", {}),
		};
		expect(getReadToolPath(ctx)).toBeUndefined();
	});
});

describe("isSkillReadToolResult", () => {
	it("returns true when path starts with skill://", () => {
		const ctx: ProtectedToolContext = {
			toolResult: makeToolResult("read"),
			toolCall: makeToolCall("read", { path: "skill://my-skill" }),
		};
		expect(isSkillReadToolResult(ctx)).toBe(true);
	});

	it("returns false when path is a regular file path", () => {
		const ctx: ProtectedToolContext = {
			toolResult: makeToolResult("read"),
			toolCall: makeToolCall("read", { path: "src/foo.ts" }),
		};
		expect(isSkillReadToolResult(ctx)).toBe(false);
	});

	it("returns false when toolResult is not read", () => {
		const ctx: ProtectedToolContext = {
			toolResult: makeToolResult("write"),
			toolCall: makeToolCall("read", { path: "skill://my-skill" }),
		};
		expect(isSkillReadToolResult(ctx)).toBe(false);
	});

	it("returns false when toolCall is undefined", () => {
		const ctx: ProtectedToolContext = {
			toolResult: makeToolResult("read"),
			toolCall: undefined,
		};
		expect(isSkillReadToolResult(ctx)).toBe(false);
	});

	it("returns false when path is missing", () => {
		const ctx: ProtectedToolContext = {
			toolResult: makeToolResult("read"),
			toolCall: makeToolCall("read", {}),
		};
		expect(isSkillReadToolResult(ctx)).toBe(false);
	});
});

describe("isProtectedToolResult", () => {
	it("returns true when string matcher matches tool name", () => {
		expect(isProtectedToolResult(makeToolResult("skill"), undefined, ["skill"])).toBe(true);
	});

	it("returns false when string matcher does not match", () => {
		expect(isProtectedToolResult(makeToolResult("read"), undefined, ["skill"])).toBe(false);
	});

	it("returns true when function matcher returns true", () => {
		const matcher = () => true;
		expect(isProtectedToolResult(makeToolResult("read"), undefined, [matcher])).toBe(true);
	});

	it("returns false when function matcher returns false", () => {
		const matcher = () => false;
		expect(isProtectedToolResult(makeToolResult("read"), undefined, [matcher])).toBe(false);
	});

	it("returns true when any matcher matches (OR semantics)", () => {
		const matcher = () => false;
		expect(isProtectedToolResult(makeToolResult("skill"), undefined, ["skill", matcher])).toBe(true);
	});

	it("returns false when no matchers match", () => {
		const matcher = () => false;
		expect(isProtectedToolResult(makeToolResult("read"), undefined, ["skill", matcher])).toBe(false);
	});

	it("returns false for empty matchers array", () => {
		expect(isProtectedToolResult(makeToolResult("read"), undefined, [])).toBe(false);
	});

	it("passes context to function matcher", () => {
		const toolResult = makeToolResult("read");
		const toolCall = makeToolCall("read", { path: "foo.ts" });
		let received: ProtectedToolContext | undefined;
		const matcher = (ctx: ProtectedToolContext) => {
			received = ctx;
			return false;
		};
		isProtectedToolResult(toolResult, toolCall, [matcher]);
		expect(received?.toolResult).toBe(toolResult);
		expect(received?.toolCall).toBe(toolCall);
	});

	it("checks string matchers before function matchers", () => {
		let matcherCalled = false;
		const matcher = () => {
			matcherCalled = true;
			return false;
		};
		isProtectedToolResult(makeToolResult("skill"), undefined, ["skill", matcher]);
		expect(matcherCalled).toBe(false);
	});
});
