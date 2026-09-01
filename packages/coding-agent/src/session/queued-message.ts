/**
 * Classification and chip text for messages sitting in the steer and follow-up queues.
 *
 * The queues carry both user turns and agent-authored cards, and the two are treated differently on
 * every surface that reads them: only a user-authored message is restorable to the editor, only a
 * displayable one reaches the queue chips. These predicates are the single spelling of those
 * distinctions, and none of them reads session state.
 */

import type { AgentMessage } from "@veyyon/agent-core";
import type { AssistantMessage, ImageContent, TextContent } from "@veyyon/ai";
import { type CustomMessage, readQueueChipText } from "./messages";

/** Entry returned by `AgentSession.clearQueue` / `AgentSession.popLastQueuedMessage`. */
export type RestoredQueuedMessage = { text: string; images?: ImageContent[] };

export function queuedTextContent(message: AgentMessage): string | undefined {
	if (!("content" in message)) return undefined;
	const content = message.content;
	if (typeof content === "string") return content;
	return content.find((part): part is TextContent => part.type === "text")?.text;
}

export function queuedImageContent(message: AgentMessage): ImageContent[] | undefined {
	if (!("content" in message) || typeof message.content === "string") return undefined;
	const images = message.content.filter(
		(part): part is ImageContent =>
			part.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string",
	);
	return images.length > 0 ? images : undefined;
}

export function isDisplayableQueuedMessage(message: AgentMessage): boolean {
	return !(message.role === "custom" && message.display === false);
}

export function isAdvisorCard(message: AgentMessage): message is CustomMessage {
	return message.role === "custom" && message.customType === "advisor";
}

export function isTerminalTextAssistantAnswer(message: AgentMessage | undefined): message is AssistantMessage {
	if (message?.role !== "assistant" || message.stopReason !== "stop") return false;
	let hasText = false;
	for (const part of message.content) {
		if (part.type === "toolCall") return false;
		if (part.type === "text") {
			if (part.text.trim().length > 0) hasText = true;
			continue;
		}
		if (part.type === "thinking" || part.type === "redactedThinking" || part.type === "fallback") continue;
		return false;
	}
	return hasText;
}

/**
 * A queued message the user can restore to the editor as a draft: a plain user turn, or a custom
 * message explicitly attributed to the user such as a `/skill` invocation. Agent-authored cards —
 * advisor notes, IRC asides, extension notices, hidden goal and plan steers — ride the same queues
 * and are never dumped into the editor on Esc or Alt+Up.
 */
export function isUserQueuedMessage(message: AgentMessage): boolean {
	if (message.role === "user") return true;
	return message.role === "custom" && message.attribution === "user" && message.display !== false;
}

/** Custom-message types of the hidden magic-keyword notices `#createMagicKeywordNotices` enqueues
 *  alongside a user prompt. Keep in sync with that method. */
const MAGIC_KEYWORD_NOTICE_TYPES: ReadonlySet<string> = new Set([
	"ultrathink-notice",
	"orchestrate-notice",
	"workflow-notice",
]);
/** Custom-message type of the hidden companion carrying vision descriptions of image attachments
 *  sent to a text-only model (see `#buildImageDescriptionNotice`). */
export const IMAGE_ATTACHMENT_DESCRIPTION_TYPE = "image-attachment-description";

/**
 * A hidden, user-attributed companion of a queued user prompt: the magic-keyword notices enqueued
 * alongside the user message, which are `attribution: "user"` but `display: false`. They are not
 * editor-restorable, and when the user pulls their prompt back out of the queue these leave with it
 * rather than linger as companion-less steering. Scoped to the known notice types, so an unrelated
 * hidden user custom is not dropped.
 */
export function isHiddenUserCompanion(message: AgentMessage): boolean {
	return (
		message.role === "custom" &&
		message.attribution === "user" &&
		message.display === false &&
		(MAGIC_KEYWORD_NOTICE_TYPES.has(message.customType) || message.customType === IMAGE_ATTACHMENT_DESCRIPTION_TYPE)
	);
}

export function queueChipText(message: AgentMessage): string {
	if (message.role === "custom") {
		return readQueueChipText(message.details) ?? queuedTextContent(message) ?? "";
	}
	const text = queuedTextContent(message) ?? "";
	if (text) return text;
	return queuedImageContent(message) ? "[Image]" : "";
}

export function toRestoredQueuedMessage(message: AgentMessage): RestoredQueuedMessage {
	return { text: queueChipText(message), images: queuedImageContent(message) };
}
