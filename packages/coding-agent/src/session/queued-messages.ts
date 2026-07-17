/**
 * Queued-message classification and restoration: which queued steer/follow-up
 * messages are user-authored (and thus editor-restorable), their hidden
 * companions, and the chip text shown for a queued entry.
 */
import type { AgentMessage } from "@veyyon/pi-agent-core";
import type { AssistantMessage, ImageContent, TextContent } from "@veyyon/pi-ai";
import { type CustomMessage, readQueueChipText } from "./messages";

/** Entry returned by {@link AgentSession.clearQueue} / {@link AgentSession.popLastQueuedMessage}. */
export type RestoredQueuedMessage = { text: string; images?: ImageContent[] };

function queuedTextContent(message: AgentMessage): string | undefined {
	if (!("content" in message)) return undefined;
	const content = message.content;
	if (typeof content === "string") return content;
	return content.find((part): part is TextContent => part.type === "text")?.text;
}

function queuedImageContent(message: AgentMessage): ImageContent[] | undefined {
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
 * A queued message the user can restore to the editor / pull back as a draft.
 * Only genuinely user-authored messages qualify: plain user turns, or custom
 * messages explicitly attributed to the user (e.g. `/skill` invocations).
 * Agent-authored queued cards — advisor concern/blocker notes, IRC asides,
 * extension notices, hidden goal/plan/budget steers — ride the same
 * steer/follow-up queues but must never be dumped into the editor on Esc/Alt+Up.
 */
export function isUserQueuedMessage(message: AgentMessage): boolean {
	if (message.role === "user") return true;
	return message.role === "custom" && message.attribution === "user" && message.display !== false;
}

/** Custom-message types of the hidden magic-keyword notices that `#createMagicKeywordNotices`
 *  enqueues alongside a user prompt. Keep in sync with that method. */
const MAGIC_KEYWORD_NOTICE_TYPES: ReadonlySet<string> = new Set([
	"ultrathink-notice",
	"orchestrate-notice",
	"workflow-notice",
]);

/** Custom-message type of the hidden companion carrying vision descriptions of image
 *  attachments sent to a text-only model (see `#buildImageDescriptionNotice`). */
export const IMAGE_ATTACHMENT_DESCRIPTION_TYPE = "image-attachment-description";

/**
 * A hidden, user-attributed companion of a queued user prompt: the magic-keyword
 * notices (`ultrathink`/`orchestrate`/`workflow`) enqueued alongside the user
 * message. They are `attribution: "user"` but `display: false`, so they are not
 * editor-restorable; when the user pulls their prompt back out of the queue these
 * must leave with it rather than linger as stale, companion-less steering. Scoped to
 * the known notice types so an unrelated hidden user custom is never silently dropped.
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
