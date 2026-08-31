/**
 * Readers for the shapes a session message can take: the custom-message types
 * the session writes, and the text, thinking, tool-call and checkpoint values
 * read back out of a stored entry.
 */

import type { AgentMessage } from "@veyyon/agent-core";
import type { SessionMessageEntry } from "@veyyon/agent-core/compaction";
import type { AssistantMessage, ImageContent, TextContent } from "@veyyon/ai";
import { type ContentBlockLike, contentText } from "@veyyon/kernel/session/content-text";
import type { SessionEntry } from "@veyyon/kernel/session/session-entries";
import { isRecord } from "@veyyon/utils";
import type { TitleConversationTurn } from "../tiny/message-preproc";
import { TOOL } from "../tools/core/builtin-names";
import type { CompletedRewindState } from "../tools/fs/checkpoint";
import { getStringProperty } from "./agent-session-permissions";

/** `customType` for the hidden mid-run todo nudge; `display: false`, so it reaches
 *  the model but never renders in the TUI or transcript. */
export const MID_RUN_TODO_NUDGE_MESSAGE_TYPE = "mid-run-todo-nudge";

/**
 * Custom-message type carrying the memory backend's volatile context (recalled
 * memories, mental models) at the TAIL of the conversation.
 *
 * It used to ride in the system prompt, which is the provider's cache prefix, so
 * every recall and every mental-model reload made the next request re-read the
 * whole conversation as uncached input. Same information, same place in the
 * model's reading order, no prefix invalidation.
 */
export const MEMORY_CONTEXT_MESSAGE_TYPE = "memory-context";

/**
 * Custom-message type carrying the two facts that describe NOW rather than the
 * project: the calendar date and the working directory.
 *
 * They used to be one sentence inside the project block of the system prompt,
 * which is the provider's cache prefix, and the working directory is the one
 * thing in that prefix a session routinely changes. Measured on this repository,
 * a re-root from the root to `packages/utils` altered exactly one line of a
 * 92,921-character prompt — that sentence — and threw away the cached prefix for
 * the entire conversation behind it. Across 19 local log files, 210 of 232
 * recorded prefix invalidations were a `cwd-change`, averaging about 85,000
 * characters re-read each time for a path that had moved a directory down.
 *
 * The rebuild on re-root stays: the rules, skills and workspace tree really are
 * cwd-derived and a cross-project move must change them. What changes is that a
 * move which alters nothing but the path now rebuilds to BYTE-IDENTICAL bytes, so
 * there is no invalidation to record.
 */
export const SESSION_STATE_MESSAGE_TYPE = "session-state";

/** Hidden plan nudge injected by prewalk; scrubbed from the LLM context
 *  when the switch happens. */
export const PREWALK_PLAN_MESSAGE_TYPE = "prewalk-plan";

/** Hidden safety-net nudge forcing one more turn after a text-only reply to
 *  the plan nudge, which would otherwise end the run with no code written. */
export const PREWALK_CONTINUE_MESSAGE_TYPE = "prewalk-continue";

/** Hidden "verify before finishing" checklist steered into the run at the
 *  switch, aimed at the fast model's specific failure patterns: partial
 *  multi-site fixes, unnecessarily broad rewrites, and reported-test-only
 *  verification. */
export const PREWALK_CHECKLIST_MESSAGE_TYPE = "prewalk-checklist";

/** `customType` for the hidden hand-off message steered to the target model
 *  once PlanYolo auto-approves the plan. Unlike prewalk's plan nudge this
 *  is never scrubbed — it IS the instruction the target model acts on. */
export const PLAN_YOLO_HANDOFF_MESSAGE_TYPE = "plan-yolo-handoff";

/** `customType` for the hidden tool-call reminder injected after the interrupt. */
export const GEMINI_TOOL_REMINDER_TYPE = "gemini-tool-call-reminder";

/** `customType` for the hidden redirect notice injected into a turn retried after a
 *  thinking/response loop. Steers the model off the repeated content; never displayed. */
export const THINKING_LOOP_REDIRECT_TYPE = "thinking-loop-redirect";

export const TOOL_CALL_LOOP_REDIRECT_TYPE = "tool-call-loop-redirect";

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

export function completedRewindFromEntry(entry: SessionEntry): CompletedRewindState | undefined {
	if (entry.type !== "custom_message" || entry.customType !== "rewind-report") return undefined;
	const details = entry.details;
	if (!details || typeof details !== "object") return undefined;
	const startedAt = stringProperty(details, "startedAt");
	const rewoundAt = stringProperty(details, "rewoundAt");
	if (!startedAt || !rewoundAt) return undefined;
	const report =
		stringProperty(details, "report")?.trim() ||
		reportFromRewindReportContent(customMessageContentText(entry.content));
	return report.length > 0 ? { report, startedAt, rewoundAt } : undefined;
}

export function isSuccessfulCheckpointEntry(entry: SessionEntry): entry is SessionMessageEntry & {
	message: { role: "toolResult"; toolName: "checkpoint"; isError?: false };
} {
	return (
		entry.type === "message" &&
		entry.message.role === "toolResult" &&
		entry.message.toolName === TOOL.checkpoint &&
		entry.message.isError !== true
	);
}

export function checkpointStartedAtFromEntry(entry: SessionEntry): string | undefined {
	if (!isSuccessfulCheckpointEntry(entry)) return undefined;
	const details = entry.message.details;
	if (details && typeof details === "object") {
		const startedAt = stringProperty(details, "startedAt");
		if (startedAt) return startedAt;
	}
	return entry.timestamp;
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

export function textFromContent(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return contentText(content as readonly ContentBlockLike[], { separator: "\n\n", trimBlocks: true });
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
