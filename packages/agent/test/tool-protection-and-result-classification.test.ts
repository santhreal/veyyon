/**
 * WHY: The compaction gatekeepers — `isProtectedToolResult`,
 * `isSkillReadToolResult`, `getReadToolPath`, `getToolResultMessage`,
 * `collectToolCallsById`, and `toolResultNeverRan` — decide which tool
 * results survive pruning, which are skill reads that must never be
 * elided, and which results are synthetic placeholders that never ran.
 * A bug in any of them silently inflates or starves context: a skill
 * read pruned as redundant drops the skill body from the conversation;
 * a protected result pruned as superseded loses the model's only view
 * of a file; a placeholder counted as answered skips a real call.
 *
 * None of these functions had direct tests. They were exercised only
 * indirectly through the pruning and shake suites, which assert the
 * aggregate behavior but cannot pin a misclassification to its source.
 * This suite closes the class by testing each gatekeeper in isolation
 * across every branch: string and function matchers, skill vs regular
 * read paths, all entry types, and every `toolResultNeverRan` path.
 *
 * What this does NOT catch: integration-level bugs where the
 * gatekeepers are called with wrong arguments by the pruning loop.
 * The pruning and shake suites cover that.
 */
import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@veyyon/agent-core";
import { toolResultNeverRan } from "@veyyon/agent-core";
import type { SessionEntry, SessionMessageEntry } from "@veyyon/agent-core/compaction";
import { getToolResultMessage } from "@veyyon/agent-core/compaction/entries";
import {
	collectToolCallsById,
	getReadToolPath,
	isProtectedToolResult,
	isSkillReadToolResult,
	type ProtectedToolMatcher,
} from "@veyyon/agent-core/compaction/tool-protection";
import type { AssistantMessage, ToolCall, ToolResultMessage } from "@veyyon/ai";

let idCounter = 0;
function nextId(): string {
	return `tp-entry-${idCounter++}`;
}

function messageEntry(message: AgentMessage): SessionMessageEntry {
	return { type: "message", id: nextId(), parentId: null, timestamp: new Date(0).toISOString(), message };
}

function toolResultMsg(toolName: string, toolCallId: string, content: string = "result"): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text: content }],
		isError: false,
		timestamp: Date.now(),
	};
}
function assistantMsg(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		timestamp: Date.now(),
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

function toolCallBlock(id: string, name: string, args: Record<string, unknown> = {}): ToolCall {
	return { type: "toolCall", id, name, arguments: args };
}

function userMsg(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

// ─── toolResultNeverRan ───────────────────────────────────────────

describe("toolResultNeverRan", () => {
	it("returns false for null and non-object details", () => {
		expect(toolResultNeverRan(null)).toBe(false);
		expect(toolResultNeverRan(undefined)).toBe(false);
		expect(toolResultNeverRan("string")).toBe(false);
		expect(toolResultNeverRan(42)).toBe(false);
		expect(toolResultNeverRan(true)).toBe(false);
	});

	it("returns false for an empty object with no discriminator fields", () => {
		expect(toolResultNeverRan({})).toBe(false);
	});

	it("returns true for __skipped === true and entered !== true", () => {
		expect(toolResultNeverRan({ __skipped: true })).toBe(true);
		expect(toolResultNeverRan({ __skipped: true, entered: false })).toBe(true);
	});

	it("returns false for __skipped === true and entered === true", () => {
		expect(toolResultNeverRan({ __skipped: true, entered: true })).toBe(false);
	});

	it("returns false for __skipped === false regardless of entered", () => {
		expect(toolResultNeverRan({ __skipped: false })).toBe(false);
		expect(toolResultNeverRan({ __skipped: false, entered: false })).toBe(false);
	});

	it("returns true for __synthetic === true and executed === false", () => {
		expect(toolResultNeverRan({ __synthetic: true, executed: false })).toBe(true);
	});

	it("returns false for __synthetic === true and executed === true", () => {
		expect(toolResultNeverRan({ __synthetic: true, executed: true })).toBe(false);
	});

	it("returns false for __synthetic === false regardless of executed", () => {
		expect(toolResultNeverRan({ __synthetic: false, executed: false })).toBe(false);
		expect(toolResultNeverRan({ __synthetic: false, executed: true })).toBe(false);
	});

	it("returns false when neither discriminator is present", () => {
		expect(toolResultNeverRan({ someOtherField: true })).toBe(false);
	});

	it("prioritizes __skipped over __synthetic when both are present", () => {
		// __skipped true + entered false → true, even if __synthetic says otherwise
		expect(toolResultNeverRan({ __skipped: true, entered: false, __synthetic: false, executed: false })).toBe(true);
		// __skipped true + entered true → false, even if __synthetic says true
		expect(toolResultNeverRan({ __skipped: true, entered: true, __synthetic: true, executed: false })).toBe(false);
	});
});

// ─── getReadToolPath ──────────────────────────────────────────────

describe("getReadToolPath", () => {
	it("extracts the path from a read tool call", () => {
		const result = toolResultMsg("read", "call-1");
		const call = toolCallBlock("call-1", "read", { path: "/repo/src/file.ts" });
		expect(getReadToolPath({ toolResult: result, toolCall: call })).toBe("/repo/src/file.ts");
	});

	it("returns undefined when toolResult is not a read", () => {
		const result = toolResultMsg("bash", "call-1");
		const call = toolCallBlock("call-1", "read", { path: "/repo/file.ts" });
		expect(getReadToolPath({ toolResult: result, toolCall: call })).toBeUndefined();
	});

	it("returns undefined when toolCall is not a read", () => {
		const result = toolResultMsg("read", "call-1");
		const call = toolCallBlock("call-1", "bash", { path: "/repo/file.ts" });
		expect(getReadToolPath({ toolResult: result, toolCall: call })).toBeUndefined();
	});

	it("returns undefined when toolCall is undefined", () => {
		const result = toolResultMsg("read", "call-1");
		expect(getReadToolPath({ toolResult: result, toolCall: undefined })).toBeUndefined();
	});

	it("returns undefined when path argument is missing", () => {
		const result = toolResultMsg("read", "call-1");
		const call = toolCallBlock("call-1", "read", {});
		expect(getReadToolPath({ toolResult: result, toolCall: call })).toBeUndefined();
	});

	it("returns undefined when path argument is not a string", () => {
		const result = toolResultMsg("read", "call-1");
		const call = toolCallBlock("call-1", "read", { path: 42 });
		expect(getReadToolPath({ toolResult: result, toolCall: call })).toBeUndefined();
		expect(
			getReadToolPath({ toolResult: result, toolCall: toolCallBlock("call-1", "read", { path: null }) }),
		).toBeUndefined();
		expect(
			getReadToolPath({ toolResult: result, toolCall: toolCallBlock("call-1", "read", { path: true }) }),
		).toBeUndefined();
	});

	it("returns the path when it is an empty string", () => {
		const result = toolResultMsg("read", "call-1");
		const call = toolCallBlock("call-1", "read", { path: "" });
		expect(getReadToolPath({ toolResult: result, toolCall: call })).toBe("");
	});
});

// ─── isSkillReadToolResult ────────────────────────────────────────

describe("isSkillReadToolResult", () => {
	it("returns true for a skill:// path", () => {
		const result = toolResultMsg("read", "call-1");
		const call = toolCallBlock("call-1", "read", { path: "skill://my-skill" });
		expect(isSkillReadToolResult({ toolResult: result, toolCall: call })).toBe(true);
	});

	it("returns true for a skill:// path with a sub-path", () => {
		const result = toolResultMsg("read", "call-1");
		const call = toolCallBlock("call-1", "read", { path: "skill://my-skill/sub/file.md" });
		expect(isSkillReadToolResult({ toolResult: result, toolCall: call })).toBe(true);
	});

	it("returns false for a regular filesystem path", () => {
		const result = toolResultMsg("read", "call-1");
		const call = toolCallBlock("call-1", "read", { path: "/repo/src/file.ts" });
		expect(isSkillReadToolResult({ toolResult: result, toolCall: call })).toBe(false);
	});

	it("returns false for a non-read tool", () => {
		const result = toolResultMsg("bash", "call-1");
		const call = toolCallBlock("call-1", "bash", { path: "skill://my-skill" });
		expect(isSkillReadToolResult({ toolResult: result, toolCall: call })).toBe(false);
	});

	it("returns false when toolCall is undefined", () => {
		const result = toolResultMsg("read", "call-1");
		expect(isSkillReadToolResult({ toolResult: result, toolCall: undefined })).toBe(false);
	});

	it("returns false when path is missing", () => {
		const result = toolResultMsg("read", "call-1");
		const call = toolCallBlock("call-1", "read", {});
		expect(isSkillReadToolResult({ toolResult: result, toolCall: call })).toBe(false);
	});

	it("returns false for a path that merely contains skill:// as a substring", () => {
		const result = toolResultMsg("read", "call-1");
		const call = toolCallBlock("call-1", "read", { path: "/repo/skill://not-a-skill" });
		expect(isSkillReadToolResult({ toolResult: result, toolCall: call })).toBe(false);
	});
});

// ─── isProtectedToolResult ────────────────────────────────────────

describe("isProtectedToolResult", () => {
	const result = toolResultMsg("read", "call-1");
	const call = toolCallBlock("call-1", "read", { path: "/repo/file.ts" });

	it("returns true when a string matcher matches the tool name", () => {
		expect(isProtectedToolResult(result, call, ["read"])).toBe(true);
	});

	it("returns false when a string matcher does not match", () => {
		expect(isProtectedToolResult(result, call, ["bash"])).toBe(false);
	});

	it("returns true when a function matcher returns true", () => {
		const matcher: ProtectedToolMatcher = ({ toolResult }) => toolResult.toolName === "read";
		expect(isProtectedToolResult(result, call, [matcher])).toBe(true);
	});

	it("returns false when a function matcher returns false", () => {
		const matcher: ProtectedToolMatcher = ({ toolResult }) => toolResult.toolName === "bash";
		expect(isProtectedToolResult(result, call, [matcher])).toBe(false);
	});

	it("returns true when any matcher in a mixed list matches", () => {
		const fnMatcher: ProtectedToolMatcher = ({ toolCall }) => toolCall?.name === "bash";
		expect(isProtectedToolResult(result, call, ["bash", fnMatcher])).toBe(false);
		expect(isProtectedToolResult(result, call, ["read", fnMatcher])).toBe(true);
		expect(isProtectedToolResult(result, call, [fnMatcher, "read"])).toBe(true);
	});

	it("returns false for an empty matchers list", () => {
		expect(isProtectedToolResult(result, call, [])).toBe(false);
	});

	it("passes the toolResult and toolCall to function matchers", () => {
		let receivedToolName = "";
		let receivedCallName = "";
		const matcher: ProtectedToolMatcher = ({ toolResult, toolCall }) => {
			receivedToolName = toolResult.toolName;
			receivedCallName = toolCall?.name ?? "";
			return false;
		};
		isProtectedToolResult(result, call, [matcher]);
		expect(receivedToolName).toBe("read");
		expect(receivedCallName).toBe("read");
	});

	it("handles undefined toolCall in function matchers", () => {
		const matcher: ProtectedToolMatcher = ({ toolCall }) => toolCall === undefined;
		expect(isProtectedToolResult(result, undefined, [matcher])).toBe(true);
	});

	it("short-circuits on the first matching string matcher", () => {
		let functionCalled = false;
		const fnMatcher: ProtectedToolMatcher = () => {
			functionCalled = true;
			return true;
		};
		isProtectedToolResult(result, call, ["read", fnMatcher]);
		expect(functionCalled).toBe(false);
	});

	it("short-circuits on the first matching function matcher", () => {
		let secondCalled = false;
		const first: ProtectedToolMatcher = () => true;
		const second: ProtectedToolMatcher = () => {
			secondCalled = true;
			return true;
		};
		isProtectedToolResult(result, call, [first, second]);
		expect(secondCalled).toBe(false);
	});
});

// ─── getToolResultMessage ─────────────────────────────────────────

describe("getToolResultMessage", () => {
	it("returns the message when entry is a tool result message", () => {
		const msg = toolResultMsg("read", "call-1");
		const entry = messageEntry(msg);
		expect(getToolResultMessage(entry)).toBe(msg);
	});

	it("returns undefined for a non-message entry", () => {
		const entry: SessionEntry = {
			type: "compaction",
			id: "c1",
			parentId: null,
			timestamp: new Date(0).toISOString(),
			summary: "summary",
			firstKeptEntryId: "x",
			tokensBefore: 0,
		};
		expect(getToolResultMessage(entry)).toBeUndefined();
	});

	it("returns undefined for a user message", () => {
		const entry = messageEntry(userMsg("hello"));
		expect(getToolResultMessage(entry)).toBeUndefined();
	});

	it("returns undefined for an assistant message", () => {
		const entry = messageEntry(assistantMsg([{ type: "text", text: "hi" }]));
		expect(getToolResultMessage(entry)).toBeUndefined();
	});

	it("returns the message for a tool result with isError true", () => {
		const msg: ToolResultMessage = { ...toolResultMsg("bash", "call-1"), isError: true };
		const entry = messageEntry(msg);
		expect(getToolResultMessage(entry)).toBe(msg);
	});

	it("returns the message for a tool result with useless flag", () => {
		const msg: ToolResultMessage = { ...toolResultMsg("grep", "call-1"), useless: true };
		const entry = messageEntry(msg);
		expect(getToolResultMessage(entry)).toBe(msg);
	});
});

// ─── collectToolCallsById ─────────────────────────────────────────

describe("collectToolCallsById", () => {
	it("collects tool calls from assistant messages", () => {
		const call1 = toolCallBlock("c1", "read", { path: "/a" });
		const call2 = toolCallBlock("c2", "bash", { command: "ls" });
		const entries: SessionEntry[] = [messageEntry(userMsg("go")), messageEntry(assistantMsg([call1, call2]))];
		const map = collectToolCallsById(entries);
		expect(map.size).toBe(2);
		expect(map.get("c1")).toBe(call1);
		expect(map.get("c2")).toBe(call2);
	});

	it("skips non-message entries", () => {
		const call = toolCallBlock("c1", "read");
		const entries: SessionEntry[] = [
			{
				type: "compaction",
				id: "comp1",
				parentId: null,
				timestamp: new Date(0).toISOString(),
				summary: "s",
				firstKeptEntryId: "x",
				tokensBefore: 0,
			},
			messageEntry(assistantMsg([call])),
		];
		const map = collectToolCallsById(entries);
		expect(map.size).toBe(1);
		expect(map.get("c1")).toBe(call);
	});

	it("skips non-assistant messages", () => {
		const call = toolCallBlock("c1", "read");
		const entries: SessionEntry[] = [
			messageEntry(userMsg("go")),
			messageEntry(toolResultMsg("read", "c1")),
			messageEntry(assistantMsg([call])),
		];
		const map = collectToolCallsById(entries);
		expect(map.size).toBe(1);
		expect(map.get("c1")).toBe(call);
	});

	it("skips text content blocks in assistant messages", () => {
		const call = toolCallBlock("c1", "read");
		const entries: SessionEntry[] = [messageEntry(assistantMsg([{ type: "text", text: "thinking..." }, call]))];
		const map = collectToolCallsById(entries);
		expect(map.size).toBe(1);
		expect(map.get("c1")).toBe(call);
	});

	it("returns an empty map for empty entries", () => {
		expect(collectToolCallsById([]).size).toBe(0);
	});

	it("returns an empty map when no assistant messages exist", () => {
		const entries: SessionEntry[] = [messageEntry(userMsg("hello"))];
		expect(collectToolCallsById(entries).size).toBe(0);
	});

	it("handles multiple assistant messages with tool calls", () => {
		const call1 = toolCallBlock("c1", "read");
		const call2 = toolCallBlock("c2", "bash");
		const call3 = toolCallBlock("c3", "write");
		const entries: SessionEntry[] = [
			messageEntry(assistantMsg([call1])),
			messageEntry(toolResultMsg("read", "c1")),
			messageEntry(assistantMsg([call2, call3])),
		];
		const map = collectToolCallsById(entries);
		expect(map.size).toBe(3);
		expect(map.get("c1")).toBe(call1);
		expect(map.get("c2")).toBe(call2);
		expect(map.get("c3")).toBe(call3);
	});

	it("last tool call with a duplicate id wins", () => {
		const call1 = toolCallBlock("dup", "read", { path: "/first" });
		const call2 = toolCallBlock("dup", "read", { path: "/second" });
		const entries: SessionEntry[] = [messageEntry(assistantMsg([call1])), messageEntry(assistantMsg([call2]))];
		const map = collectToolCallsById(entries);
		expect(map.size).toBe(1);
		expect(map.get("dup")).toBe(call2);
	});
});
