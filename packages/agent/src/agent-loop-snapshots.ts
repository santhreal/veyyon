import type { AssistantMessage, AssistantMessageEvent } from "@veyyon/ai";
import { EMPTY_ERROR_TOOL_RESULT_TEXT } from "@veyyon/ai/types";
import { formatCount, isRecord, sanitizeText, structuredCloneJSON } from "@veyyon/utils";
import type { AgentToolResult } from "./types";

export type AssistantContentBlock = AssistantMessage["content"][number];
export type AssistantToolCallBlock = Extract<AssistantContentBlock, { type: "toolCall" }>;
export type SnapshotMode = "full" | "delta";

export function snapshotAssistantContentBlock(block: AssistantContentBlock, mode: SnapshotMode): AssistantContentBlock {
	switch (block.type) {
		case "text":
		case "thinking":
		case "redactedThinking":
			return { ...block };
		case "fallback":
			return { ...block, from: { ...block.from }, to: { ...block.to } };
		case "toolCall":
			return mode === "delta" ? { ...block } : { ...block, arguments: structuredCloneJSON(block.arguments) };
	}
}

export function snapshotAssistantMessage(message: AssistantMessage, mode: SnapshotMode = "full"): AssistantMessage {
	const content = new Array<AssistantContentBlock>(message.content.length);
	for (let i = 0; i < message.content.length; i++) {
		content[i] = snapshotAssistantContentBlock(message.content[i]!, mode);
	}
	return {
		...message,
		content,
		usage: {
			...message.usage,
			cost: { ...message.usage.cost },
		},
		disabledFeatures: message.disabledFeatures ? message.disabledFeatures.slice() : undefined,
		toolCallAbortMessages: message.toolCallAbortMessages ? { ...message.toolCallAbortMessages } : undefined,
	};
}

export function snapshotAssistantMessageEvent(
	event: AssistantMessageEvent,
	partialSnapshot?: AssistantMessage,
): AssistantMessageEvent {
	switch (event.type) {
		case "start":
		case "text_start":
		case "text_delta":
		case "text_end":
		case "thinking_start":
		case "thinking_delta":
		case "thinking_end":
		case "toolcall_start":
		case "toolcall_delta":
			return { ...event, partial: partialSnapshot ?? snapshotAssistantMessage(event.partial, "delta") };
		case "toolcall_end":
			return {
				...event,
				toolCall: snapshotAssistantContentBlock(event.toolCall, "full") as AssistantToolCallBlock,
				partial: partialSnapshot ?? snapshotAssistantMessage(event.partial, "delta"),
			};
		case "done":
			return { ...event, message: snapshotAssistantMessage(event.message) };
		case "error":
			return { ...event, error: snapshotAssistantMessage(event.error) };
	}
}

export function hasSubstantiveToolResultContent(content: AgentToolResult["content"]): boolean {
	for (const block of content) {
		if (block.type === "image") return true;
		if (block.type === "text" && block.text.trim().length > 0) return true;
	}
	return false;
}

export function coerceToolResult(raw: unknown): { result: AgentToolResult<unknown>; malformed: boolean } {
	const rawObj = isRecord(raw) ? raw : null;
	const rawContent = rawObj ? rawObj.content : undefined;
	const details = rawObj && "details" in rawObj ? rawObj.details : {};
	const explicitError = Boolean(rawObj?.isError);
	const useless = Boolean(rawObj?.useless);

	if (!Array.isArray(rawContent)) {
		return {
			result: {
				content: [{ type: "text", text: "Tool returned an invalid result: missing content array." }],
				details,
				isError: true,
			},
			malformed: true,
		};
	}

	const content: AgentToolResult["content"] = [];
	let invalidBlocks = 0;
	for (const block of rawContent) {
		if (!isRecord(block) || typeof block.type !== "string") {
			invalidBlocks++;
			continue;
		}
		if (block.type === "text" && typeof block.text === "string") {
			content.push({ type: "text", text: sanitizeText(block.text) });
		} else if (block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string") {
			content.push({ type: "image", data: block.data, mimeType: block.mimeType });
		} else {
			invalidBlocks++;
		}
	}
	if (invalidBlocks > 0) {
		content.push({
			type: "text",
			text: `Tool returned an invalid result: ${formatCount("content block", invalidBlocks)} had an unsupported shape.`,
		});
	}
	const isError = explicitError || invalidBlocks > 0;
	// Anthropic rejects tool_result blocks with is_error: true and empty content.
	if (isError && !hasSubstantiveToolResultContent(content)) {
		content.length = 0;
		content.push({ type: "text", text: EMPTY_ERROR_TOOL_RESULT_TEXT });
	}
	return {
		result: {
			content,
			details,
			...(isError ? { isError: true } : {}),
			...(useless && !isError ? { useless: true } : {}),
		},
		malformed: invalidBlocks > 0,
	};
}
