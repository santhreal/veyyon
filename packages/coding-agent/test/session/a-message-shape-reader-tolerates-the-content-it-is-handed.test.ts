/**
 * WHY: these readers run over content the session did not author — a restored
 * session file, a provider's assistant block, a checkpoint tool result — so
 * every one of them receives `unknown` in practice. A reader that assumes an
 * array, or that returns a truthy empty string, turns a malformed stored entry
 * into a crash on resume or a blank turn in the title conversation.
 *
 * Closes the class: each reader is asserted against a string, an array, a
 * non-array and a wrong-shaped block, and the two shapes that MUST NOT survive
 * a reparented history (`redactedThinking` and `providerPayload`) are asserted
 * absent rather than merely different.
 *
 * Does NOT catch: whether the session calls the right reader at the right point
 * — the branch/rewind suites drive that through the session itself.
 */

import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@veyyon/agent-core";
import type { AssistantMessage } from "@veyyon/ai";
import {
	customMessageContentText,
	sanitizeAssistantForReparentedHistory,
	stringProperty,
	textFromContent,
	thinkingFromContent,
	titleConversationTurnFromMessage,
	toolCallOpFromMessage,
} from "../../src/session/agent-session-message-shapes";

function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return { role: "assistant", content, timestamp: 0 } as AssistantMessage;
}

describe("a message shape reader tolerates the content it is handed", () => {
	it("reads a custom message's text from a string and from a block list, dropping images", () => {
		expect(customMessageContentText("plain")).toBe("plain");
		expect(
			customMessageContentText([
				{ type: "text", text: "first" },
				{ type: "image", data: "AAAA", mimeType: "image/png" },
				{ type: "text", text: "second" },
			]),
		).toBe("first\nsecond");
		expect(customMessageContentText([])).toBe("");
	});

	it("reads only own string properties, so a prototype field is not a value", () => {
		expect(stringProperty({ path: "/repo/src/app.ts" }, "path")).toBe("/repo/src/app.ts");
		expect(stringProperty({ path: 7 }, "path")).toBeUndefined();
		expect(stringProperty({}, "path")).toBeUndefined();
		expect(stringProperty({}, "toString")).toBeUndefined();
	});

	it("trims a string body and joins blocks, and reports nothing for a non-array", () => {
		expect(textFromContent("  hello  ")).toBe("hello");
		expect(
			textFromContent([
				{ type: "text", text: " first " },
				{ type: "text", text: "second" },
			]),
		).toBe("first\n\nsecond");
		expect(textFromContent(undefined)).toBe("");
		expect(textFromContent(null)).toBe("");
		expect(textFromContent(42)).toBe("");
		expect(textFromContent({ type: "text", text: "not a list" })).toBe("");
	});

	it("reads thinking only from thinking blocks carrying a string", () => {
		expect(
			thinkingFromContent([
				{ type: "text", text: "visible" },
				{ type: "thinking", thinking: " reasoned " },
				{ type: "thinking", thinking: "   " },
				{ type: "thinking", thinking: 7 },
				{ type: "thinking" },
				{ type: "thinking", thinking: "more" },
			]),
		).toBe("reasoned\n\nmore");
		expect(thinkingFromContent("thinking as a string")).toBe("");
		expect(thinkingFromContent(undefined)).toBe("");
	});

	it("drops redacted thinking and the provider payload from a reparented assistant turn", () => {
		const message = assistant([
			{ type: "text", text: "answer" },
			{ type: "thinking", thinking: "why", signature: "sig" },
			{ type: "redactedThinking", data: "opaque" },
		] as AssistantMessage["content"]);
		message.providerPayload = { raw: "provider bytes" } as unknown as AssistantMessage["providerPayload"];

		const sanitized = sanitizeAssistantForReparentedHistory(message);

		expect(sanitized.providerPayload).toBeUndefined();
		expect(sanitized.content.map(block => block.type)).toEqual(["text", "thinking"]);
		expect(sanitized.content[1]).toEqual({ type: "thinking", thinking: "why" });
		expect(message.content.length).toBe(3);
	});

	it("finds the op of the named tool call and no other", () => {
		const message = assistant([
			{ type: "toolCall", id: "call-a", name: "todo", arguments: { op: "init" } },
			{ type: "toolCall", id: "call-b", name: "todo", arguments: { op: "done" } },
			{ type: "toolCall", id: "call-c", name: "read", arguments: { path: "a.ts" } },
			{ type: "toolCall", id: "call-d", name: "todo", arguments: "not an object" },
		] as unknown as AssistantMessage["content"]);

		expect(toolCallOpFromMessage(message, "call-a")).toBe("init");
		expect(toolCallOpFromMessage(message, "call-b")).toBe("done");
		expect(toolCallOpFromMessage(message, "call-c")).toBeUndefined();
		expect(toolCallOpFromMessage(message, "call-d")).toBeUndefined();
		expect(toolCallOpFromMessage(message, "call-missing")).toBeUndefined();
	});

	it("reads no tool call op out of a message that is not an assistant turn", () => {
		const user: AgentMessage = {
			role: "user",
			content: [{ type: "toolCall", id: "call-a", name: "todo", arguments: { op: "init" } }],
			timestamp: 0,
		} as unknown as AgentMessage;

		expect(toolCallOpFromMessage(user, "call-a")).toBeUndefined();
	});

	it("builds a title turn only for a user or assistant message that says something", () => {
		const user: AgentMessage = {
			role: "user",
			content: [{ type: "text", text: "rename the thing" }],
			timestamp: 0,
		} as unknown as AgentMessage;

		expect(titleConversationTurnFromMessage(user)).toEqual({ role: "user", text: "rename the thing" });
		expect(
			titleConversationTurnFromMessage(
				assistant([
					{ type: "text", text: "done" },
					{ type: "thinking", thinking: "considered" },
				] as AssistantMessage["content"]),
			),
		).toEqual({ role: "assistant", text: "done", thinking: "considered" });
	});

	it("omits a title turn's thinking on a user message and skips an empty turn entirely", () => {
		const userWithThinking: AgentMessage = {
			role: "user",
			content: [
				{ type: "text", text: "go" },
				{ type: "thinking", thinking: "users do not think here" },
			],
			timestamp: 0,
		} as unknown as AgentMessage;

		expect(titleConversationTurnFromMessage(userWithThinking)).toEqual({ role: "user", text: "go" });
		expect(titleConversationTurnFromMessage(assistant([]))).toBeUndefined();
		expect(
			titleConversationTurnFromMessage(assistant([{ type: "text", text: "   " }] as AssistantMessage["content"])),
		).toBeUndefined();
	});

	it("reads no title turn from a tool result, which carries no conversation", () => {
		const toolResult: AgentMessage = {
			role: "toolResult",
			toolName: "read",
			content: [{ type: "text", text: "file bytes" }],
			timestamp: 0,
		} as unknown as AgentMessage;

		expect(titleConversationTurnFromMessage(toolResult)).toBeUndefined();
	});
});
