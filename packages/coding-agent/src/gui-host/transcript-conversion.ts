import type { AgentMessage } from "@veyyon/agent-core";
import { getStreamingPartialJson } from "@veyyon/ai/utils/block-symbols";
import type { SessionEntry } from "@veyyon/kernel/session/session-entries";
import type { ToolViewContext } from "@veyyon/view";
import type { AgentSession } from "../session/agent-session";
import type { FileMentionMessage } from "../session/messages";
import { decodeStreamedToolArgs, streamingStringKeysForTool } from "../tools/core/streamed-tool-args";
import { base64DecodedBytes } from "../utils/video-loading";
import { buildToolCallPresentation, buildToolResultPresentation, type PresentationLedger } from "./presentation";
import type { ContentBlock, EntryMeta, MessageRole, TranscriptEntry, UsageTotals } from "./wire";

export interface TranscriptConversionOptions {
	ledger?: PresentationLedger;
	session?: AgentSession;
	isStreaming?: boolean;
	/**
	 * The entry sits ahead of the session's first message, so it records the
	 * state the session opens in rather than a change made inside a
	 * conversation. Only a setting some other control states permanently reads
	 * differently there: the model, which the composer footer draws at every
	 * width. The thinking level and the mode are reached through the command
	 * surface and drawn nowhere at rest, so their entries draw either way.
	 */
	beforeFirstMessage?: boolean;
}

function mapContentBlocks(content: unknown, options?: TranscriptConversionOptions): ContentBlock[] {
	if (typeof content === "string") return [{ Text: { text: content } }];
	// A message that recorded no content has nothing to draw. The lossless
	// fallback is for a shape nobody expected, not for an absent one, and it
	// drew a block captioned "unknown" under every turn whose content was null.
	if (content === null || content === undefined) return [];
	if (!Array.isArray(content)) return [{ Fallback: { producer: "unknown", value: content } }];

	const blocks: ContentBlock[] = [];
	for (const item of content) {
		if (!item || typeof item !== "object") continue;
		if (!("type" in item)) {
			blocks.push({ Unknown: { tag: "object", value: item } });
			continue;
		}
		if (item.type === "text" && "text" in item && typeof item.text === "string") {
			blocks.push({ Text: { text: item.text } });
		} else if (item.type === "thinking" && "thinking" in item && typeof item.thinking === "string") {
			blocks.push({ Thinking: { text: item.thinking } });
		} else if (item.type === "image" && "data" in item && typeof item.data === "string") {
			const mediaType = "mimeType" in item && typeof item.mimeType === "string" ? item.mimeType : "image/png";
			blocks.push({
				Image: { media_type: mediaType, data: Array.from(Buffer.from(item.data, "base64")), alt: null },
			});
		} else if (item.type === "video" && "data" in item && typeof item.data === "string") {
			const mediaType = "mimeType" in item && typeof item.mimeType === "string" ? item.mimeType : "video/mp4";
			const bytes = base64DecodedBytes(item.data);
			blocks.push({
				Video: { media_type: mediaType, bytes },
			});
		} else if (
			(item.type === "tool_call" || item.type === "toolCall") &&
			"id" in item &&
			typeof item.id === "string" &&
			"name" in item &&
			typeof item.name === "string"
		) {
			const toolName = item.name;
			const toolCallId = item.id;
			const partialJson = getStreamingPartialJson(item);
			const rawInput = "customWireName" in item && item.customWireName !== undefined;
			let displayArgs: unknown;
			if (options?.isStreaming && partialJson !== undefined) {
				displayArgs = decodeStreamedToolArgs(partialJson, {
					rawInput,
					fullArgs:
						"arguments" in item && item.arguments && typeof item.arguments === "object"
							? (item.arguments as Record<string, unknown>)
							: undefined,
					streamingStringKeys: streamingStringKeysForTool(toolName, rawInput),
					argot: options.session?.getArgotSession?.(),
				});
			} else {
				displayArgs = "arguments" in item ? item.arguments : {};
			}

			const tool = options?.session?.getToolByName(toolName);
			const expanded = options?.ledger?.getDisclosure(toolCallId) ?? false;
			const hasResult = options?.ledger?.hasResult(toolCallId) ?? false;
			const context: ToolViewContext = {
				expanded,
				...(options?.isStreaming ? { partial: true } : {}),
				hasResult,
			};
			const presentation = buildToolCallPresentation(toolName, displayArgs, tool, context);

			blocks.push({
				ToolCall: {
					id: toolCallId,
					name: toolName,
					arguments: displayArgs,
					presentation,
				},
			});
		} else if (item.type === "tool_result" || item.type === "toolResult") {
			const toolId =
				"toolCallId" in item && typeof item.toolCallId === "string"
					? item.toolCallId
					: "id" in item && typeof item.id === "string"
						? item.id
						: "tool";
			const resultContent = "content" in item ? (item.content ?? null) : null;
			const isError = "isError" in item && item.isError === true;
			const tracked = options?.ledger?.getCall(toolId);
			const toolName =
				"toolName" in item && typeof item.toolName === "string" ? item.toolName : (tracked?.toolName ?? "tool");
			const callArgs = tracked?.args;
			const tool = options?.session?.getToolByName(toolName);
			const expanded = options?.ledger?.getDisclosure(toolId) ?? false;
			const context: ToolViewContext = {
				expanded,
				hasResult: true,
			};
			// The recorded block carries text and an error flag; the tool's own
			// `details` live only on the result the ledger holds, and a resumed
			// session has none, so a renderer sees whichever is richer.
			const presentation = buildToolResultPresentation(
				toolName,
				tracked?.hasResult ? tracked.result : item,
				callArgs,
				tool,
				context,
			);
			blocks.push({
				ToolResult: {
					tool: toolId,
					content: resultContent,
					is_error: isError,
					presentation,
				},
			});
		} else {
			blocks.push({ Unknown: { tag: String(item.type), value: item } });
		}
	}
	return blocks;
}

function mapMessageRole(role: string): MessageRole {
	switch (role) {
		case "user":
			return "User";
		case "assistant":
			return "Assistant";
		case "toolResult":
		case "tool":
			return "ToolResult";
		case "developer":
		case "system":
			return "Developer";
		case "fileMention":
			return "FileMention";
		default:
			return "Custom";
	}
}

type MentionFile = FileMentionMessage["files"][number];

/**
 * Why a mentioned file arrived without its body, in the words the transcript
 * shows. Keyed by the union, so a new skip reason fails the type check here
 * rather than reaching the desktop as a file that looks readable.
 */
const MENTION_UNAVAILABLE: Record<NonNullable<MentionFile["skippedReason"]>, string> = {
	tooLarge: "too large to read",
	binary: "binary file",
};

function mentionUnavailableReason(file: MentionFile): string | null {
	if (file.skippedReason) return MENTION_UNAVAILABLE[file.skippedReason];
	// A collab replica is sent `hasContent` and no body, so an empty string
	// here means the body was withheld rather than that the file was empty.
	return file.contentNotReplicated === true ? "content not replicated" : null;
}

/**
 * The files an `@path` mention read, as one block each.
 *
 * A mention is recorded as its own message carrying `files` rather than
 * `content`, so a client reading `content` alone states nothing about a file
 * the model was handed: the prompt names a path, the answer describes what is
 * in it, and the transcript shows neither. `has_content` is true only when a
 * body was read, which is what separates an empty file from one skipped for
 * size, one refused as binary, and one whose body a replica never received.
 */
function mapFileMentions(message: AgentMessage): ContentBlock[] {
	const files: readonly MentionFile[] = "files" in message && Array.isArray(message.files) ? message.files : [];
	const blocks: ContentBlock[] = [];
	for (const file of files) {
		if (typeof file?.path !== "string") continue;
		const unavailable = mentionUnavailableReason(file);
		const image = file.image?.data;
		blocks.push({
			FileMention: {
				path: file.path,
				has_content: unavailable === null && typeof file.content === "string" && file.content.length > 0,
				lines: typeof file.lineCount === "number" ? file.lineCount : null,
				bytes: typeof file.byteSize === "number" ? file.byteSize : null,
				unavailable_reason: unavailable,
				image: typeof image === "string" ? Array.from(Buffer.from(image, "base64")) : null,
			},
		});
	}
	return blocks;
}

function mapUsage(usage: unknown): UsageTotals | null {
	if (!usage || typeof usage !== "object") return null;
	const input = "input" in usage && typeof usage.input === "number" ? usage.input : 0;
	const output = "output" in usage && typeof usage.output === "number" ? usage.output : 0;
	const cacheRead = "cacheRead" in usage && typeof usage.cacheRead === "number" ? usage.cacheRead : 0;
	const cacheWrite = "cacheWrite" in usage && typeof usage.cacheWrite === "number" ? usage.cacheWrite : 0;
	return {
		input_tokens: input,
		output_tokens: output,
		cache_read_tokens: cacheRead,
		cache_write_tokens: cacheWrite,
		orchestration_tokens: 0,
		premium_requests: 0,
		cost_microusd: null,
	};
}

export function agentMessageToTranscriptEntry(
	message: AgentMessage,
	revision: number,
	id: string,
	options?: TranscriptConversionOptions,
): TranscriptEntry {
	const role = message.role ? mapMessageRole(message.role) : "Custom";
	const provider = "provider" in message && typeof message.provider === "string" ? message.provider : null;
	const model = "model" in message && typeof message.model === "string" ? message.model : null;
	const stopReason = "stopReason" in message && typeof message.stopReason === "string" ? message.stopReason : null;
	const errorMessage =
		"errorMessage" in message && typeof message.errorMessage === "string" ? message.errorMessage : null;
	const usage = "usage" in message ? mapUsage(message.usage) : null;

	const meta: EntryMeta | null =
		message.role === "assistant"
			? {
					provider,
					model,
					stop_reason: stopReason,
					error: errorMessage,
					usage,
				}
			: null;

	let content =
		message.role === "fileMention"
			? mapFileMentions(message)
			: "content" in message
				? mapContentBlocks(message.content, options)
				: [];
	if (message.role === "toolResult") {
		const text: string[] = [];
		const media: ContentBlock[] = [];
		for (const block of content) {
			if ("Text" in block) text.push(block.Text.text);
			else media.push(block);
		}
		const toolCallId = message.toolCallId;
		const tracked = options?.ledger?.getCall(toolCallId);
		const toolName =
			"toolName" in message && typeof message.toolName === "string"
				? message.toolName
				: (tracked?.toolName ?? "tool");
		const callArgs = tracked?.args;
		const tool = options?.session?.getToolByName(toolName);
		const expanded = options?.ledger?.getDisclosure(toolCallId) ?? false;
		const context: ToolViewContext = {
			expanded,
			hasResult: true,
		};
		const presentation = buildToolResultPresentation(
			toolName,
			tracked?.hasResult ? tracked.result : message,
			callArgs,
			tool,
			context,
		);
		content = [
			{
				ToolResult: {
					tool: toolCallId,
					content: text.join("\n"),
					is_error: message.isError,
					presentation,
				},
			},
			...media,
		];
	}
	return {
		id,
		parent: null,
		revision,
		timestamp_ms: typeof message.timestamp === "number" ? message.timestamp : Date.now(),
		role,
		content,
		meta,
		raw_discriminator: "message",
		raw: message,
	};
}

export function sessionEntryToTranscriptEntry(
	entry: SessionEntry,
	revision: number,
	options?: TranscriptConversionOptions,
): TranscriptEntry {
	const timestampMs = entry.timestamp ? new Date(entry.timestamp).getTime() : Date.now();
	if (entry.type === "message") {
		const result = agentMessageToTranscriptEntry(entry.message as AgentMessage, revision, entry.id, options);
		result.parent = entry.parentId ?? null;
		result.timestamp_ms = timestampMs;
		result.raw_discriminator = entry.type;
		result.raw = entry;
		return result;
	}

	let role: MessageRole = "Custom";
	let content: ContentBlock[];
	switch (entry.type) {
		case "model_change": {
			// The model a session opens on is the one the composer's picker
			// states, so a row for it above the first prompt states it twice. A
			// change made inside the conversation states which model produced
			// the turns after it, and draws.
			if (options?.beforeFirstMessage) {
				content = [];
				break;
			}
			const slash = entry.model.indexOf("/");
			content =
				entry.role && entry.role !== "default"
					? [{ Text: { text: `${entry.role} model: ${entry.model}` } }]
					: slash > 0 && slash < entry.model.length - 1
						? [{ ModelChange: { provider: entry.model.slice(0, slash), model: entry.model.slice(slash + 1) } }]
						: [{ Text: { text: `model: ${entry.model}` } }];
			break;
		}
		case "thinking_level_change": {
			const configured = entry.configured || entry.thinkingLevel;
			const effective = entry.thinkingLevel;
			// A change entry that recorded no level states nothing, so it draws
			// no row rather than a note about its own absence.
			content = configured
				? [
						{
							ThinkingChange: {
								level: effective && effective !== configured ? `${configured} (${effective})` : configured,
							},
						},
					]
				: [];
			break;
		}
		case "service_tier_change": {
			const tiers = Object.entries(entry.serviceTier ?? {})
				.filter(([, value]) => value != null)
				.map(([family, value]) => `${family}:${value}`);
			content = tiers.length ? [{ Text: { text: `service tier: ${tiers.join(", ")}` } }] : [];
			break;
		}
		case "custom_message":
			content = entry.display === false ? [] : mapContentBlocks(entry.content);
			break;
		case "compaction":
			role = "CompactionSummary";
			content = [{ Summary: { kind: "compaction", text: entry.summary } }];
			break;
		case "branch_summary":
			role = "BranchSummary";
			content = [{ Summary: { kind: "branch", text: entry.summary } }];
			break;
		case "session_lifecycle":
			role = "Lifecycle";
			content = [{ Lifecycle: { phase: entry.state, reason: entry.reason ?? null } }];
			break;
		case "mode_change":
			// A block of its own rather than a line of text, so the transcript
			// states the mode the way it states a model or a thinking level
			// instead of drawing it as a custom message.
			content = [{ ModeChange: { mode: entry.mode } }];
			break;
		// A title is chrome, not conversation: the titlebar and the rail row
		// state the name, and a session is named from its own first prompt, so a
		// row for it landed in every transcript between the prompt and the reply
		// that answered it.
		case "title_change":
			content = [];
			break;
		case "ttsr_injection":
			content = [{ Text: { text: `injected rules: ${entry.injectedRules.join(", ")}` } }];
			break;
		case "mcp_tool_selection":
			content = [{ Text: { text: `mcp tools: ${entry.selectedToolNames.join(", ")}` } }];
			break;
		case "subagent_spawn":
			content = [{ Text: { text: `subagent ${entry.agentName}: ${entry.task} (${entry.status})` } }];
			break;
		case "label":
			content = entry.label ? [{ Text: { text: `label: ${entry.label}` } }] : [];
			break;
		case "session_init":
		case "settings_snapshot":
		case "session_checkpoint":
			content = [];
			break;
		// A `custom` entry is the runtime's or an extension's own record, keyed by
		// `customType` and carrying `data` rather than content: the pending-tool
		// warning's `tool_execution_start`, the crash diagnostic's `session_exit`,
		// a todo edit, an extension's state. None of it is anything the session
		// said, and rendered as a fallback block it put rows like
		// "Fallback: tool_execution_start" in the transcript between a tool card
		// and the prose that followed it. `custom_message` is the entry that
		// carries something to show. `raw` still holds the whole entry.
		case "custom":
			content = [];
			break;
		default:
			content = [{ Fallback: { producer: (entry as SessionEntry).type, value: entry satisfies never } }];
	}
	return {
		id: entry.id,
		parent: entry.parentId ?? null,
		revision,
		timestamp_ms: timestampMs,
		role,
		content,
		meta: null,
		raw_discriminator: entry.type,
		raw: entry,
	};
}

/**
 * Convert a stored session's entries with the presentation ledger filled in
 * first.
 *
 * A tool call card states whether its result has arrived, and a card the
 * operator expands later is regenerated from the entry it belongs to, so the
 * ledger has to know every call and result in the transcript before the first
 * entry is converted, and each converted entry has to be linked back to its
 * call afterwards. Without the ledger this is `entries.map(...)`.
 */
export function sessionEntriesToTranscript(
	entries: readonly SessionEntry[],
	revision: number,
	options?: TranscriptConversionOptions,
): TranscriptEntry[] {
	const ledger = options?.ledger;
	// The first message in the list is where the session stops recording the
	// state it opened in and starts recording changes made inside a
	// conversation, so each entry is converted knowing which side of it it sits
	// on.
	const firstMessage = entries.findIndex(entry => entry.type === "message");
	const convert = (entry: SessionEntry, index: number): TranscriptEntry =>
		sessionEntryToTranscriptEntry(entry, revision, {
			...options,
			beforeFirstMessage: firstMessage < 0 || index < firstMessage,
		});
	if (!ledger) return entries.map(convert);
	for (const entry of entries) recordEntryCalls(ledger, entry);
	const converted = entries.map(convert);
	for (const [index, entry] of entries.entries()) linkEntryCalls(ledger, entry, converted[index]);
	return converted;
}

/**
 * Where a live entry sits relative to the session's first message.
 *
 * A stored transcript converts as a list, which states the position of every
 * entry in it. A live entry arrives one at a time, so the connection carries
 * one flag instead, seeded from the session's entries when it is attached.
 */
export interface FirstMessagePosition {
	hasMessageEntry?: boolean;
}

/** Read the flag off a session already holding entries. */
export function seedFirstMessagePosition(position: FirstMessagePosition, entries: readonly SessionEntry[]): void {
	position.hasMessageEntry = entries.some(entry => entry.type === "message");
}

/** Convert one appended entry, advancing the position the first message sets. */
export function appendedEntryToTranscriptEntry(
	position: FirstMessagePosition,
	entry: SessionEntry,
	revision: number,
	options?: TranscriptConversionOptions,
): TranscriptEntry {
	if (entry.type === "message") position.hasMessageEntry = true;
	return sessionEntryToTranscriptEntry(entry, revision, {
		...options,
		beforeFirstMessage: !position.hasMessageEntry,
	});
}

/** Index the tool call, or the tool result, a stored entry carries. */
function recordEntryCalls(ledger: PresentationLedger, entry: SessionEntry): void {
	if (entry.type !== "message") return;
	const message = entry.message as AgentMessage;
	if (message.role === "assistant") {
		for (const block of message.content) {
			if (block.type === "toolCall") ledger.recordCall(block.id, block.name, block.arguments, entry.id);
		}
		return;
	}
	if (message.role === "toolResult") {
		ledger.recordResult(message.toolCallId, message, message.isError, entry.id);
	}
}

/** Point each indexed call at the converted entry that renders it. */
function linkEntryCalls(ledger: PresentationLedger, entry: SessionEntry, converted: TranscriptEntry): void {
	if (entry.type !== "message") return;
	const message = entry.message as AgentMessage;
	if (message.role === "assistant") {
		for (const block of converted.content) {
			if ("ToolCall" in block) {
				const call = ledger.getCall(block.ToolCall.id);
				if (call) call.assistantEntry = converted;
			}
		}
		return;
	}
	if (message.role === "toolResult") {
		const call = ledger.getCall(message.toolCallId);
		if (call) call.resultEntry = converted;
	}
}
