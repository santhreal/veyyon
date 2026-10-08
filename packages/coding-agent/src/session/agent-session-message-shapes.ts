/**
 * Readers for the shapes a session message can take: the text, thinking,
 * tool-call and checkpoint values read back out of a stored entry. The
 * `customType` names the session writes are `./nudges`.
 */

import type { AgentMessage } from "@veyyon/agent-core";
import type { AssistantMessage, ImageContent, TextContent } from "@veyyon/ai";
import { getStringProperty, isRecord } from "@veyyon/utils";
import { contentText } from "@veyyon/utils/content-text";
import type { TitleConversationTurn } from "../tiny/message-preproc";

export function customMessageContentText(content: string | (TextContent | ImageContent)[]): string {
	if (typeof content === "string") return content;
	const parts: string[] = [];
	for (const part of content) {
		if (part.type === "text") parts.push(part.text);
	}
	return parts.join("\n");
}

export function stringProperty(value: object, key: string): string | undefined {
	const field = Object.getOwnPropertyDescriptor(value, key)?.value;
	return typeof field === "string" ? field : undefined;
}

export function reportFromRewindReportContent(content: string): string {
	const marker = "\nReport:\n";
	const index = content.lastIndexOf(marker);
	const report = index >= 0 ? content.slice(index + marker.length) : content;
	return report.trim();
}

export function sanitizeAssistantForReparentedHistory(message: AssistantMessage): AssistantMessage {
	const content: AssistantMessage["content"] = [];
	for (const block of message.content) {
		if (block.type === "redactedThinking") continue;
		if (block.type === "thinking") {
			content.push({ type: "thinking", thinking: block.thinking });
			continue;
		}
		content.push(block);
	}
	return { ...message, content, providerPayload: undefined };
}

const NON_WHITESPACE_RE = /\S/;

/**
 * Whether an assistant turn stopped with nothing a turn can use: no tool call and no text beyond
 * whitespace. A "stop" that only reasons does not answer the user and gives the agent loop no tool
 * call to run. An orphaned toolUse stop (no tool_use block) corrupts Anthropic history: a later
 * tool_result has nothing to anchor to, and thinking alone cannot anchor one.
 */
export function isEmptyAssistantStop(assistantMessage: AssistantMessage): boolean {
	const { stopReason } = assistantMessage;
	if (stopReason !== "stop" && stopReason !== "toolUse") return false;
	for (const content of assistantMessage.content) {
		if (content.type === "toolCall") return false;
		if (content.type === "text" && NON_WHITESPACE_RE.test(content.text)) return false;
	}
	return true;
}

/** Whether two assistant messages are the same turn: one object, or one timestamp, route and stop. */
export function isSameAssistantMessage(left: AssistantMessage, right: AssistantMessage): boolean {
	return (
		left === right ||
		(left.timestamp === right.timestamp &&
			left.provider === right.provider &&
			left.model === right.model &&
			left.stopReason === right.stopReason)
	);
}

export function textFromContent(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return contentText(content, { separator: "\n\n", trimBlocks: true });
}

export function thinkingFromContent(content: unknown): string {
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (!isRecord(block) || block.type !== "thinking" || typeof block.thinking !== "string") continue;
		const thinking = block.thinking.trim();
		if (thinking) parts.push(thinking);
	}
	return parts.join("\n\n");
}

export function toolCallOpFromMessage(message: AgentMessage, toolCallId: string): string | undefined {
	if (message.role !== "assistant" || !Array.isArray(message.content)) return undefined;
	for (const block of message.content) {
		if (!isRecord(block) || block.type !== "toolCall" || block.id !== toolCallId) continue;
		return isRecord(block.arguments) ? getStringProperty(block.arguments, "op") : undefined;
	}
	return undefined;
}

export function titleConversationTurnFromMessage(message: AgentMessage): TitleConversationTurn | undefined {
	if (message.role !== "user" && message.role !== "assistant") return undefined;
	const text = textFromContent(message.content);
	const thinking = message.role === "assistant" ? thinkingFromContent(message.content) : undefined;
	if (!text && !thinking) return undefined;
	return { role: message.role, ...(text ? { text } : {}), ...(thinking ? { thinking } : {}) };
}
