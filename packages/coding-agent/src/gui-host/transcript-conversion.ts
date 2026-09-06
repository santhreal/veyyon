import type { AgentMessage } from "@veyyon/agent-core";
import type { SessionEntry } from "../session/session-entries";
import { base64DecodedBytes } from "../utils/video-loading";
import type { ContentBlock, EntryMeta, MessageRole, TranscriptEntry, UsageTotals } from "./wire";

function mapContentBlocks(content: unknown): ContentBlock[] {
	if (typeof content === "string") return [{ Text: { text: content } }];
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
			const args = "arguments" in item ? item.arguments : {};
			blocks.push({
				ToolCall: { id: item.id, name: item.name, arguments: args },
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
			blocks.push({ ToolResult: { tool: toolId, content: resultContent, is_error: isError } });
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
		default:
			return "Custom";
	}
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

export function agentMessageToTranscriptEntry(message: AgentMessage, revision: number, id: string): TranscriptEntry {
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

	let content = "content" in message ? mapContentBlocks(message.content) : [];
	if (message.role === "toolResult") {
		const text: string[] = [];
		const media: ContentBlock[] = [];
		for (const block of content) {
			if ("Text" in block) text.push(block.Text.text);
			else media.push(block);
		}
		content = [
			{
				ToolResult: {
					tool: message.toolCallId,
					content: text.join("\n"),
					is_error: message.isError,
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

export function sessionEntryToTranscriptEntry(entry: SessionEntry, revision: number): TranscriptEntry {
	const timestampMs = entry.timestamp ? new Date(entry.timestamp).getTime() : Date.now();
	if (entry.type === "message") {
		const result = agentMessageToTranscriptEntry(entry.message as AgentMessage, revision, entry.id);
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
			content = configured
				? [
						{
							ThinkingChange: {
								level: effective && effective !== configured ? `${configured} (${effective})` : configured,
							},
						},
					]
				: [{ Text: { text: "thinking level not recorded" } }];
			break;
		}
		case "service_tier_change": {
			const tiers = Object.entries(entry.serviceTier ?? {})
				.filter(([, value]) => value != null)
				.map(([family, value]) => `${family}:${value}`);
			content = [{ Text: { text: `service tier: ${tiers.length ? tiers.join(", ") : "unset"}` } }];
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
			content = [{ Text: { text: `mode: ${entry.mode}` } }];
			break;
		case "title_change":
			content = [{ Text: { text: `title: ${entry.title}` } }];
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
		case "custom":
			content = [{ Fallback: { producer: entry.customType || entry.type, value: entry } }];
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
