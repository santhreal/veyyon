/**
 * `AgentMessage` to `TranscriptBlock`.
 *
 * Projection of session messages into display data. The live terminal prompt
 * component and the serialized transcript use the same prompt-text extraction.
 * The serialized projection excludes provider payloads and tool argument objects.
 */

import type { AgentMessage } from "@veyyon/agent-core";
import type { AssistantMessage, Message, ToolResultMessage } from "@veyyon/ai";
import { collapseWhitespace } from "@veyyon/utils/collapse-whitespace";
import { formatBytes } from "@veyyon/utils/format";
import { replaceTabs } from "@veyyon/utils/tab-width";
import { isRecord } from "@veyyon/utils/type-guards";
import { truncateToWidth } from "@veyyon/utils/width";
import type {
	AssistantErrorPresentation,
	AssistantMessageView,
	AssistantSegment,
	Attachment,
	BlockId,
	CustomBlock,
	HookBlock,
	TranscriptBlock,
	TurnStopReason,
	TurnUsage,
	UserMessageView,
} from "@veyyon/wire/presentation";
import { resolveAbortLabel, shouldRenderAbortReason } from "../session/messages";
import { TRUNCATE_LENGTHS } from "../tools/core/render-limits";
import { base64DecodedBytes } from "../utils/video-loading";
import { contentToText } from "./content-text";
import { projectCustomDisplay, readCustomLevel } from "./custom-display";
import { toBranchSummaryView, toCompactionSummaryView } from "./summary-builder";
import { buildToolExecutionBlock } from "./tool-execution";

export { contentToText } from "./content-text";

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
	/** Retry attempt index for abort label presentation. */
	retryAttempt?: number;
	/**
	 * Correlated tool call arguments by toolCallId. When present, toolResult blocks
	 * receive these arguments to render full card views and inputs.
	 */
	toolCallArgs?: ReadonlyMap<string, unknown> | ((toolCallId: string) => unknown);
}

/**
 * Collect tool call arguments from an array of messages, keyed by tool call id.
 * Pure helper shared across replay, rebuild and bridge correlation.
 */
export function collectToolCallArgs(messages: readonly AgentMessage[]): Map<string, unknown> {
	const toolCallArgs = new Map<string, unknown>();
	for (const message of messages) {
		if (!isRecord(message) || message.role !== "assistant") continue;
		const content = (message as AssistantMessage).content;
		if (!Array.isArray(content)) continue;
		for (const block of content) {
			if (isRecord(block) && block.type === "toolCall" && typeof block.id === "string") {
				toolCallArgs.set(block.id, block.arguments);
			}
		}
	}
	return toolCallArgs;
}

/** Text chunks concatenate; video chunks include their media type and decoded size. */
export function userMessageText(message: Extract<AgentMessage, { role: "developer" | "user" }> | Message): string {
	if (typeof message.content === "string") return message.content;
	let text = "";
	for (const block of message.content) {
		if (block.type === "text") {
			text += block.text;
		} else if (block.type === "video") {
			if (text.length > 0 && !text.endsWith("\n")) text += "\n";
			text += `[${block.mimeType} · ${formatBytes(base64DecodedBytes(block.data))}]`;
		}
	}
	return text;
}

export function toUserMessageView(message: Extract<AgentMessage, { role: "developer" | "user" }>): UserMessageView {
	return {
		text: userMessageText(message),
		synthetic: message.role === "developer" || (message.synthetic ?? false),
	};
}

/** How a tool call's arguments are rendered when the caller supplies nothing better. */
export function defaultToolText(value: unknown): string {
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

function sanitizeRecoveredRetryNote(note: string): string {
	const normalized = collapseWhitespace(replaceTabs(note));
	return truncateToWidth(normalized || "retried", TRUNCATE_LENGTHS.CONTENT);
}

export function resolveAssistantErrorPresentation(
	message: {
		stopReason?: string;
		errorMessage?: string;
		errorId?: number;
		retryRecovery?: { status?: string; note?: string };
	},
	retryAttempt = 0,
): AssistantErrorPresentation {
	if (message.retryRecovery?.status === "recovered") {
		return {
			kind: "compact-recovered",
			text: sanitizeRecoveredRetryNote(message.retryRecovery.note ?? ""),
			isError: false,
		};
	}
	if (message.stopReason === "aborted") {
		if (!shouldRenderAbortReason(message)) return { kind: "none" };
		return { kind: "full", text: resolveAbortLabel(message, retryAttempt), isError: true };
	}
	if (message.stopReason === "error") {
		return { kind: "full", text: message.errorMessage || "Error", isError: true };
	}
	if (message.errorMessage && shouldRenderAbortReason(message)) {
		return { kind: "full", text: message.errorMessage, isError: true };
	}
	return { kind: "none" };
}

export function assistantSegments(
	message: Pick<AssistantMessage, "content">,
	renderToolText?: (value: unknown) => string,
): AssistantSegment[] {
	const segments: AssistantSegment[] = [];
	for (const block of message.content) {
		switch (block.type) {
			case "text":
				segments.push({ kind: "text", text: block.text });
				break;
			case "thinking": {
				const rawThinking =
					"rawThinking" in block && typeof block.rawThinking === "string" ? block.rawThinking : undefined;
				segments.push({
					kind: "thinking",
					text: block.thinking,
					redacted: false,
					...(rawThinking !== undefined ? { rawThinking } : {}),
				});
				break;
			}
			case "redactedThinking":
				segments.push({ kind: "thinking", text: "", redacted: true });
				break;
			case "toolCall":
				segments.push({
					kind: "tool-call",
					toolCallId: block.id,
					toolName: block.name,
					...(renderToolText !== undefined ? { input: renderToolText(block.arguments) } : {}),
				});
				break;
			case "fallback":
				segments.push({ kind: "fallback" });
				break;
			default: {
				const exhaustive: never = block;
				throw new Error(`Unhandled assistant content type: ${(exhaustive as { type: string }).type}`);
			}
		}
	}
	return segments;
}

export function toAssistantMessageView(
	message: AssistantMessage,
	options?: {
		renderToolText?: (value: unknown) => string;
		retryAttempt?: number;
	},
): AssistantMessageView {
	const retryAttempt = options?.retryAttempt ?? 0;
	const segments = assistantSegments(message, options?.renderToolText);
	const errorPresentation = resolveAssistantErrorPresentation(message, retryAttempt);
	const view: AssistantMessageView = {
		segments,
		model: message.model ?? "",
		stopReason: stopReasonOf(message),
		errorPresentation,
	};
	const usage = usageOf(message);
	if (usage !== undefined) {
		view.usage = usage;
	}
	const reasoningTokens = message.usage?.reasoningTokens;
	const outputTokens = message.usage?.output;
	const thinkingTokens = reasoningTokens ?? outputTokens;
	if (thinkingTokens !== undefined) {
		view.reportedThinkingTokens = thinkingTokens;
	}
	if (message.timestamp !== undefined) {
		view.timestamp = message.timestamp;
	}
	if (message.provider !== undefined) {
		view.provider = message.provider;
	}
	if (message.responseId !== undefined) {
		view.responseId = message.responseId;
	}
	return view;
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
				text: userMessageText(message as Extract<AgentMessage, { role: "user" }>),
				synthetic: readBoolean(message, "synthetic"),
				attachments: contentImages(message.content),
				timestamp,
			};
		}
		case "developer": {
			if (!isRecord(message)) break;
			return {
				kind: "developer-message",
				id,
				text: userMessageText(message as Extract<AgentMessage, { role: "developer" }>),
				synthetic: true,
				timestamp,
			};
		}
		case "assistant": {
			const assistant = message as AssistantMessage;
			const view = toAssistantMessageView(assistant, {
				renderToolText,
				retryAttempt: options.retryAttempt,
			});
			const block: TranscriptBlock = {
				kind: "assistant-message",
				id,
				...view,
				model: view.model ?? "",
				stopReason: view.stopReason ?? "complete",
				streaming: options.streaming === true,
				timestamp,
			};
			return block;
		}
		case "toolResult": {
			const result = message as ToolResultMessage;
			const isPending = pending.has(result.toolCallId);
			const durationMs = result.metrics?.durationMs;
			let args: unknown;
			if (options.toolCallArgs !== undefined) {
				if (typeof options.toolCallArgs === "function") {
					args = options.toolCallArgs(result.toolCallId);
				} else if (typeof (options.toolCallArgs as ReadonlyMap<string, unknown>).get === "function") {
					args = (options.toolCallArgs as ReadonlyMap<string, unknown>).get(result.toolCallId);
				}
			}
			return buildToolExecutionBlock({
				id,
				toolCallId: result.toolCallId,
				toolName: result.toolName,
				args,
				result: {
					content: Array.isArray(result.content)
						? result.content.map(c => (typeof c === "string" ? { type: "text", text: c } : c))
						: typeof result.content === "string"
							? [{ type: "text", text: result.content }]
							: [],
					details: result.details,
					isError: result.isError,
				},
				isError: result.isError,
				isPartial: isPending,
				durationMs,
				timestamp,
				sealed: !isPending,
			});
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
			const customType = readString(message, "customType") ?? "custom-message";
			const level = readCustomLevel(message);
			const display = projectCustomDisplay(customType, message.details, message.content, timestamp, message);

			const block: CustomBlock = {
				kind: "custom",
				id,
				customKind: customType,
				text: contentToText(message.content, "\n", true),
				level,
				timestamp,
			};
			if (display !== undefined) {
				block.display = display;
			}
			return block;
		}
		case "hookMessage": {
			if (!isRecord(message)) break;
			const hookName = readString(message, "customType") ?? "hook";
			const level = readCustomLevel(message);
			const display = projectCustomDisplay(hookName, message.details, message.content, timestamp, message);
			const block: HookBlock = {
				kind: "hook",
				id,
				hookName,
				text: contentToText(message.content, "\n", true),
				timestamp,
			};
			if (display !== undefined) {
				block.display = display;
			}
			if (level !== "info") {
				block.level = level;
			}
			return block;
		}
		case "branchSummary":
			return {
				...toBranchSummaryView(message as Extract<AgentMessage, { role: "branchSummary" }>),
				id,
				timestamp,
			};
		case "compactionSummary":
			return {
				...toCompactionSummaryView(message as Extract<AgentMessage, { role: "compactionSummary" }>),
				id,
				timestamp,
			};
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
	const extracted = collectToolCallArgs(messages);
	let toolCallArgs: ReadonlyMap<string, unknown> | ((toolCallId: string) => unknown);
	if (options?.toolCallArgs !== undefined) {
		if (typeof options.toolCallArgs === "function") {
			const fn = options.toolCallArgs;
			toolCallArgs = (id: string) => {
				const fromFn = fn(id);
				return fromFn !== undefined ? fromFn : extracted.get(id);
			};
		} else if (typeof (options.toolCallArgs as ReadonlyMap<string, unknown>).get === "function") {
			const merged = new Map<string, unknown>(extracted);
			for (const [k, v] of (options.toolCallArgs as ReadonlyMap<string, unknown>).entries()) {
				merged.set(k, v);
			}
			toolCallArgs = merged;
		} else {
			toolCallArgs = extracted;
		}
	} else {
		toolCallArgs = extracted;
	}

	const blocks: TranscriptBlock[] = [];
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index]!;
		if (!isDisplayed(message)) continue;
		blocks.push(toTranscriptBlock(message, { ...options, toolCallArgs, index }));
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
