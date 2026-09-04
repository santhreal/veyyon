/**
 * `AgentMessage` to `TranscriptBlock`.
 *
 * This is the only place a renderer's view of the transcript is derived from
 * the session's own messages. It reduces a message to text, flags and counts:
 * no provider payloads, no tool argument objects, no content blocks. What
 * comes out crosses a serialization boundary unchanged, which is what lets a
 * browser client draw the same transcript a terminal draws.
 */

import type { AgentMessage } from "@veyyon/agent-core";
import type { AssistantMessage, ToolResultMessage } from "@veyyon/ai";
import { isRecord } from "@veyyon/utils/type-guards";
import type {
	AssistantSegment,
	Attachment,
	BlockId,
	ToolStatus,
	TranscriptBlock,
	TurnStopReason,
	TurnUsage,
} from "@veyyon/wire/presentation";

/** Everything the builder needs that a message does not carry. */
export interface TranscriptBuildOptions {
	/**
	 * Position of the message in the session. Part of the block id, so two
	 * messages with the same timestamp still get distinct ids and a rebuild of
	 * the same session produces the same ids.
	 */
	index: number;
	/**
	 * Tool calls whose result has not arrived. A `toolCall` block in an
	 * assistant turn renders as a running tool execution while its id is here.
	 */
	pendingToolCallIds?: ReadonlySet<string>;
	/** True while this message is the one currently streaming. */
	streaming?: boolean;
	/** Renders arguments and results for display, with secrets already redacted. */
	renderToolText?: (value: unknown) => string;
}

/** How a tool call's arguments are rendered when the caller supplies nothing better. */
function defaultToolText(value: unknown): string {
	if (typeof value === "string") return value;
	if (value === undefined) return "";
	try {
		return JSON.stringify(value, null, 2) ?? "";
	} catch {
		// A tool argument holding a cycle or a BigInt is a display problem, not a
		// session failure: say so in the block instead of throwing into the render.
		return "[unserializable]";
	}
}

/**
 * Stable block id. Derived from the message's own position and role rather than
 * a counter, so rebuilding a transcript from persisted messages reproduces the
 * ids a live session assigned and an `updateTranscriptBlock` still lands.
 */
export function blockIdFor(message: AgentMessage, index: number): BlockId {
	const role = messageRole(message);
	if (role === "toolResult") {
		const id = readString(message, "toolCallId");
		if (id !== undefined) return `tool:${id}`;
	}
	return `${role}:${index}`;
}

function messageRole(message: AgentMessage): string {
	const role = readString(message, "role");
	return role ?? "unknown";
}

function readString(value: unknown, key: string): string | undefined {
	if (!isRecord(value)) return undefined;
	const field = value[key];
	return typeof field === "string" ? field : undefined;
}

function readNumber(value: unknown, key: string): number | undefined {
	if (!isRecord(value)) return undefined;
	const field = value[key];
	return typeof field === "number" ? field : undefined;
}

function readBoolean(value: unknown, key: string): boolean {
	if (!isRecord(value)) return false;
	return value[key] === true;
}

function timestampOf(message: AgentMessage): number {
	return readNumber(message, "timestamp") ?? 0;
}

/** Flatten the `string | (TextContent | ImageContent)[]` content shape to display text. */
function contentToText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	let text = "";
	for (const block of content) {
		if (!isRecord(block)) continue;
		if (block.type === "text" && typeof block.text === "string") {
			text += text.length > 0 ? `\n${block.text}` : block.text;
		}
	}
	return text;
}

/** Image blocks in a content array, as attachments. */
function contentImages(content: unknown): Attachment[] {
	if (!Array.isArray(content)) return [];
	const images: Attachment[] = [];
	for (const block of content) {
		if (!isRecord(block) || block.type !== "image") continue;
		const mimeType = typeof block.mimeType === "string" ? block.mimeType : "image";
		images.push({ kind: "image", name: mimeType });
	}
	return images;
}

const STOP_REASONS: Record<string, TurnStopReason> = {
	stop: "complete",
	length: "max-tokens",
	toolUse: "tool-call",
	aborted: "aborted",
	error: "error",
};

function stopReasonOf(message: AssistantMessage): TurnStopReason {
	return STOP_REASONS[message.stopReason] ?? "complete";
}

function usageOf(message: AssistantMessage): TurnUsage | undefined {
	const usage = message.usage;
	if (usage === undefined) return undefined;
	const turn: TurnUsage = {
		input: usage.input ?? 0,
		output: usage.output ?? 0,
		cacheRead: usage.cacheRead ?? 0,
		cacheWrite: usage.cacheWrite ?? 0,
	};
	if (usage.cost?.total !== undefined) turn.costUsd = usage.cost.total;
	return turn;
}

function assistantSegments(message: AssistantMessage, renderToolText: (value: unknown) => string): AssistantSegment[] {
	const segments: AssistantSegment[] = [];
	for (const block of message.content) {
		switch (block.type) {
			case "text":
				if (block.text.length > 0) segments.push({ kind: "text", text: block.text });
				break;
			case "thinking":
				if (block.thinking.length > 0) segments.push({ kind: "thinking", text: block.thinking, redacted: false });
				break;
			case "redactedThinking":
				segments.push({ kind: "thinking", text: "", redacted: true });
				break;
			case "toolCall":
				segments.push({
					kind: "tool-call",
					toolCallId: block.id,
					toolName: block.name,
					input: renderToolText(block.arguments),
				});
				break;
			case "fallback":
				// A provider-internal fallback marker. `transformMessages` strips it on
				// every hop that matters; nothing about it is for a reader.
				break;
		}
	}
	return segments;
}

function toolStatusOf(message: ToolResultMessage, pending: ReadonlySet<string>): ToolStatus {
	if (pending.has(message.toolCallId)) return "running";
	return message.isError ? "failed" : "succeeded";
}

function mentionAttachments(files: unknown): Attachment[] {
	if (!Array.isArray(files)) return [];
	const attachments: Attachment[] = [];
	for (const file of files) {
		if (!isRecord(file)) continue;
		const path = typeof file.path === "string" ? file.path : "";
		const attachment: Attachment = { kind: file.image === undefined ? "file" : "image", name: path };
		const lineCount = readNumber(file, "lineCount");
		if (lineCount !== undefined) attachment.lineCount = lineCount;
		const byteSize = readNumber(file, "byteSize");
		if (byteSize !== undefined) attachment.byteSize = byteSize;
		const skipped = readString(file, "skippedReason");
		if (skipped === "tooLarge") attachment.omittedReason = "too-large";
		else if (skipped === "binary") attachment.omittedReason = "binary";
		else if (readBoolean(file, "contentNotReplicated")) attachment.omittedReason = "not-replicated";
		attachments.push(attachment);
	}
	return attachments;
}

/**
 * Reduce one message to the block a renderer draws.
 *
 * Every `AgentMessage` variant maps: the four `Message` roles and the seven the
 * coding agent registers through `CustomAgentMessages`. A role this function
 * does not know becomes an `error` block naming it, because a message the
 * renderer silently drops is a message the operator never learns arrived.
 */
export function toTranscriptBlock(message: AgentMessage, options: TranscriptBuildOptions): TranscriptBlock {
	const id = blockIdFor(message, options.index);
	const timestamp = timestampOf(message);
	const renderToolText = options.renderToolText ?? defaultToolText;
	const pending = options.pendingToolCallIds ?? new Set<string>();
	const role = messageRole(message);

	switch (role) {
		case "user": {
			if (!isRecord(message)) break;
			return {
				kind: "user-message",
				id,
				text: contentToText(message.content),
				attachments: contentImages(message.content),
				timestamp,
			};
		}
		case "developer": {
			if (!isRecord(message)) break;
			return { kind: "developer-message", id, text: contentToText(message.content), timestamp };
		}
		case "assistant": {
			const assistant = message as AssistantMessage;
			const block: TranscriptBlock = {
				kind: "assistant-message",
				id,
				segments: assistantSegments(assistant, renderToolText),
				model: assistant.model ?? "",
				stopReason: stopReasonOf(assistant),
				streaming: options.streaming === true,
				timestamp,
			};
			const usage = usageOf(assistant);
			if (usage !== undefined) block.usage = usage;
			if (assistant.errorMessage !== undefined) block.errorMessage = assistant.errorMessage;
			return block;
		}
		case "toolResult": {
			const result = message as ToolResultMessage;
			const status = toolStatusOf(result, pending);
			const text = contentToText(result.content);
			const block: TranscriptBlock = {
				kind: "tool-execution",
				id,
				toolCallId: result.toolCallId,
				toolName: result.toolName,
				status,
				input: "",
				timestamp,
			};
			if (status === "failed") block.error = text;
			else block.output = text;
			if (result.metrics?.durationMs !== undefined) block.durationMs = result.metrics.durationMs;
			return block;
		}
		case "bashExecution": {
			if (!isRecord(message)) break;
			const block: TranscriptBlock = {
				kind: "bash-execution",
				id,
				command: readString(message, "command") ?? "",
				output: readString(message, "output") ?? "",
				exitCode: readNumber(message, "exitCode") ?? null,
				cancelled: readBoolean(message, "cancelled"),
				timestamp,
			};
			const signal = readNumber(message, "signal");
			if (signal !== undefined) block.signal = String(signal);
			return block;
		}
		case "pythonExecution": {
			if (!isRecord(message)) break;
			return {
				kind: "python-execution",
				id,
				code: readString(message, "code") ?? "",
				output: readString(message, "output") ?? "",
				exitCode: readNumber(message, "exitCode") ?? null,
				cancelled: readBoolean(message, "cancelled"),
				timestamp,
			};
		}
		case "custom": {
			if (!isRecord(message)) break;
			return {
				kind: "custom",
				id,
				customKind: readString(message, "customType") ?? "custom-message",
				text: contentToText(message.content),
				level: "info",
				timestamp,
			};
		}
		case "hookMessage": {
			if (!isRecord(message)) break;
			return {
				kind: "hook",
				id,
				hookName: readString(message, "customType") ?? "hook",
				text: contentToText(message.content),
				timestamp,
			};
		}
		case "branchSummary": {
			return {
				kind: "branch-summary",
				id,
				summary: readString(message, "summary") ?? "",
				replacedCount: 0,
				timestamp,
			};
		}
		case "compactionSummary": {
			const block: TranscriptBlock = {
				kind: "compaction-summary",
				id,
				summary: readString(message, "shortSummary") ?? readString(message, "summary") ?? "",
				replacedCount: 0,
				timestamp,
			};
			const before = readNumber(message, "tokensBefore");
			if (before !== undefined) block.reclaimedTokens = before;
			return block;
		}
		case "fileMention": {
			if (!isRecord(message)) break;
			return { kind: "file-mention", id, files: mentionAttachments(message.files), timestamp };
		}
	}

	return {
		kind: "error",
		id,
		message: `Unrenderable message role: ${role}`,
		recoverable: true,
		timestamp,
	};
}

/**
 * Build the whole transcript. Messages the session hides from the operator
 * (`display: false` on a custom or hook message, a steering injection) are
 * dropped here rather than in the renderer, so every renderer agrees on what
 * is visible.
 */
export function toTranscriptBlocks(
	messages: readonly AgentMessage[],
	options?: Omit<TranscriptBuildOptions, "index">,
): TranscriptBlock[] {
	const blocks: TranscriptBlock[] = [];
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index]!;
		if (!isDisplayed(message)) continue;
		blocks.push(toTranscriptBlock(message, { ...options, index }));
	}
	return blocks;
}

/** Whether the operator is meant to see this message at all. */
export function isDisplayed(message: AgentMessage): boolean {
	const role = messageRole(message);
	if (role === "custom" || role === "hookMessage") {
		return isRecord(message) && message.display !== false;
	}
	if (role === "user") {
		// A steer is folded into the next turn's prompt; drawing it would show the
		// operator a message the model never received as its own turn.
		return !readBoolean(message, "steering");
	}
	return true;
}
