import type { AgentMessage } from "@veyyon/agent-core";
import type { SessionEntry, SessionHeader } from "../session/session-entries";
import type { SessionInfo } from "../session/session-listing";
import {
	ALL_CAPABILITIES,
	type Capability,
	type CapabilityStatus,
	type ContentBlock,
	type EntryMeta,
	type ErrorScope,
	type MessageRole,
	type SessionHeaderView,
	type SessionStatus,
	type SessionSummary,
	type TranscriptEntry,
	type UsageTotals,
} from "./wire";

/** Capabilities supported by this host server implementation. */
export const SUPPORTED_CAPABILITIES: Partial<Record<Capability, true>> = {
	Sessions: true,
	Transcript: true,
	TurnControl: true,
	Lifecycle: true,
};

/** Specific, truthful reasons why each unsupported capability is unavailable. */
export const UNAVAILABLE_CAPABILITY_REASONS: Record<
	Exclude<Capability, "Sessions" | "Transcript" | "TurnControl" | "Lifecycle">,
	string
> = {
	SessionDeletion: "Session deletion is not supported by the host server",
	SessionTreeNavigation: "Session tree branching and navigation are not supported by the host server",
	BackgroundSubmission: "Background queueing and submission are not supported by the host server",
	Tools: "Interactive tool cancellation and progress tracking are not supported by the host server",
	Approvals: "Tool approval interception is not supported by the host server",
	Questions: "Interactive user question prompts are not supported by the host server",
	Plans: "Plan mode inspection and approvals are not supported by the host server",
	Files: "File tree browsing and file search are not supported by the host server",
	Changes: "Git and workspace diff inspection are not supported by the host server",
	PendingEdits: "Pending edit inspection is not supported by the host server",
	Terminals: "Embedded terminal sessions are not supported by the host server",
	ProcessSupervisor: "Process supervision and inspection are not supported by the host server",
	Models: "Dynamic model catalog queries and selection are not supported by the host server",
	Providers: "Provider discovery and management are not supported by the host server",
	Authentication: "Interactive authentication flows are not supported by the host server",
	Mcp: "MCP server configuration and management are not supported by the host server",
	Extensions: "Extension management and introspection are not supported by the host server",
	Agents: "Multi-agent roster inspection is not supported by the host server",
	AgentCommands: "Agent command discovery is not supported by the host server",
	Tasks: "Background task spawning and management are not supported by the host server",
	Settings: "Settings inspection and modification are not supported by the host server",
	Themes: "Theme selection and management are not supported by the host server",
	Keybindings: "Keybinding configuration is not supported by the host server",
	Diagnostics: "Engine diagnostic collection is not supported by the host server",
	Usage: "Usage telemetry querying is not supported by the host server",
	ContextBreakdown: "Context window token breakdown queries are not supported by the host server",
};

/**
 * Construct the capabilities list covering every member of ALL_CAPABILITIES.
 */
export function buildCapabilitiesSnapshot(): [Capability, CapabilityStatus][] {
	return ALL_CAPABILITIES.map(capability => {
		if (SUPPORTED_CAPABILITIES[capability]) {
			return [capability, "Available"];
		}
		const reason =
			capability in UNAVAILABLE_CAPABILITY_REASONS
				? UNAVAILABLE_CAPABILITY_REASONS[capability as keyof typeof UNAVAILABLE_CAPABILITY_REASONS]
				: `${capability} capability is not supported by this engine host`;
		return [capability, { Unavailable: { reason } }];
	});
}

/**
 * Map an action tag to its corresponding ErrorScope.
 */
export function mapActionToErrorScope(actionTag: string): ErrorScope {
	switch (actionTag) {
		case "Attach":
		case "Detach":
		case "RetryConnection":
			return "Connection";
		case "Shutdown":
			return "Lifecycle";
		case "ListSessions":
		case "OpenSession":
		case "CreateSession":
		case "RenameSession":
		case "DeleteSession":
		case "BranchSession":
		case "ExportSession":
		case "CompactSession":
		case "HandoffSession":
		case "GetContextBreakdown":
			return "Session";
		case "LoadTranscript":
			return "Transcript";
		case "SubmitPrompt":
		case "Steer":
		case "FollowUp":
		case "AbortTurn":
		case "SetQueueMode":
			return "Session";
		case "CancelTool":
			return "Tool";
		case "RespondToInteraction":
			return "Interaction";
		case "LoadFileTree":
		case "ReadFile":
		case "SearchFiles":
		case "OpenExternal":
			return "File";
		case "RefreshChanges":
		case "SelectChangeScope":
			return "Change";
		case "CreateTerminal":
		case "AttachTerminal":
		case "WriteTerminal":
		case "ResizeTerminal":
		case "RestartTerminal":
		case "ClearTerminal":
		case "CloseTerminal":
		case "RefreshProcesses":
		case "ProcessLogs":
		case "ProcessSend":
		case "ProcessSignal":
		case "ProcessStop":
		case "ProcessRestart":
		case "ProcessStart":
		case "ProcessWait":
		case "ProcessDescribe":
			return "Terminal";
		case "RefreshModels":
		case "SelectModel":
		case "SetThinkingLevel":
		case "RefreshProviders":
			return "Provider";
		case "StartProviderAuth":
		case "RefreshAuth":
		case "SubmitAuthSecret":
		case "OpenAuthUrl":
		case "CancelAuthFlow":
		case "RetryAuthFlow":
			return "Authentication";
		case "RefreshMcp":
		case "ConnectMcp":
		case "DisconnectMcp":
		case "SetMcpEnabled":
		case "CallMcpTool":
			return "Mcp";
		case "ReviveAgent":
			return "Agent";
		case "SpawnTask":
		case "CancelTask":
			return "Task";
		case "LoadSettings":
		case "SetSetting":
		case "ResetSetting":
		case "LoadThemes":
		case "SetTheme":
		case "LoadKeybindings":
		case "SetKeybinding":
			return "Settings";
		case "RefreshDiagnostics":
		case "RetryDiagnosticSource":
			return "Diagnostic";
		case "ClearOutput":
			return "Session";
		case "GetUsage":
			return "Usage";
		default:
			return "Session";
	}
}
/**
 * Map internal SessionInfo status to wire SessionStatus.
 */
export function mapSessionStatus(status: SessionInfo["status"]): SessionStatus {
	switch (status) {
		case "complete":
			return "Complete";
		case "interrupted":
			return "Interrupted";
		case "aborted":
			return "Aborted";
		case "error":
			return "Error";
		case "pending":
			return "Pending";
		default:
			return "Unknown";
	}
}
/**
 * Convert SessionInfo to wire SessionSummary.
 */
export function sessionInfoToSummary(info: SessionInfo): SessionSummary {
	return {
		id: info.id,
		workspace: info.cwd ? "ws-default" : "ws-global",
		path: info.path,
		cwd: info.cwd || process.cwd(),
		title: info.title ?? null,
		parent_path: info.parentSessionPath ?? null,
		created_at_ms: info.created ? info.created.getTime() : 0,
		modified_at_ms: info.modified ? info.modified.getTime() : 0,
		message_count: info.messageCount ?? 0,
		size_bytes: info.size ?? 0,
		first_message: info.firstMessage ?? null,
		searchable_messages: info.allMessagesText ?? null,
		status: mapSessionStatus(info.status),
	};
}

/**
 * Convert SessionHeader to wire SessionHeaderView.
 */
export function sessionHeaderToView(header: SessionHeader | null | undefined): SessionHeaderView {
	if (!header) {
		return {
			id: "unknown",
			schema_version: 3,
			title: null,
			title_source: null,
			parent: null,
			created_at_ms: Date.now(),
			cwd: process.cwd(),
		};
	}
	return {
		id: header.id,
		schema_version: header.version ?? 3,
		title: header.title ?? null,
		title_source: header.titleSource ?? null,
		parent: header.parentSession ?? null,
		created_at_ms: header.timestamp ? new Date(header.timestamp).getTime() : Date.now(),
		cwd: header.cwd,
	};
}

function mapContentBlocks(content: unknown): ContentBlock[] {
	if (typeof content === "string") {
		return [{ Text: { text: content } }];
	}
	if (Array.isArray(content)) {
		const blocks: ContentBlock[] = [];
		for (const item of content) {
			if (item && typeof item === "object") {
				if ("type" in item) {
					if (item.type === "text" && "text" in item && typeof item.text === "string") {
						blocks.push({ Text: { text: item.text } });
					} else if (item.type === "thinking" && "thinking" in item && typeof item.thinking === "string") {
						blocks.push({ Thinking: { text: item.thinking } });
					} else if (item.type === "image" && "data" in item && typeof item.data === "string") {
						const mediaType =
							"mimeType" in item && typeof item.mimeType === "string" ? item.mimeType : "image/png";
						blocks.push({
							Image: {
								media_type: mediaType,
								data: Array.from(Buffer.from(item.data, "base64")),
								alt: null,
							},
						});
					} else if (
						(item.type === "tool_call" || item.type === "toolCall") &&
						"id" in item &&
						typeof item.id === "string" &&
						"name" in item &&
						typeof item.name === "string"
					) {
						const args = "arguments" in item ? item.arguments : {};
						blocks.push({ ToolCall: { id: item.id, name: item.name, arguments: args } });
					} else if (item.type === "tool_result" || item.type === "toolResult") {
						const toolId =
							"toolCallId" in item && typeof item.toolCallId === "string"
								? item.toolCallId
								: "id" in item && typeof item.id === "string"
									? item.id
									: "tool";
						const blockContent = "content" in item ? item.content : null;
						const isError = "isError" in item && typeof item.isError === "boolean" ? item.isError : false;
						blocks.push({ ToolResult: { tool: toolId, content: blockContent, is_error: isError } });
					} else {
						blocks.push({ Unknown: { tag: String(item.type), value: item } });
					}
				} else {
					blocks.push({ Unknown: { tag: "object", value: item } });
				}
			}
		}
		return blocks;
	}
	return [{ Fallback: { producer: "unknown", value: content } }];
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
	if (!usage || typeof usage !== "object") {
		return null;
	}
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

/**
 * Convert an AgentMessage to a wire TranscriptEntry.
 */
export function agentMessageToTranscriptEntry(message: AgentMessage, revision: number): TranscriptEntry {
	let role: MessageRole = "Custom";
	let meta: EntryMeta | null = null;
	let content: ContentBlock[] = [];

	if (message.role) {
		role = mapMessageRole(message.role);
	}

	if (message.role === "assistant") {
		meta = {
			provider: "provider" in message && typeof message.provider === "string" ? message.provider : null,
			model: "model" in message && typeof message.model === "string" ? message.model : null,
			stop_reason: "stopReason" in message && typeof message.stopReason === "string" ? message.stopReason : null,
			error: "error" in message && typeof message.error === "string" ? message.error : null,
			usage: "usage" in message ? mapUsage(message.usage) : null,
		};
	}

	if ("content" in message) {
		content = mapContentBlocks(message.content);
	}

	return {
		id: "id" in message && typeof message.id === "string" ? message.id : `msg-${Date.now()}`,
		parent: null,
		revision,
		timestamp_ms: "timestamp" in message && typeof message.timestamp === "number" ? message.timestamp : Date.now(),
		role,
		content,
		meta,
		raw_discriminator: "message",
		raw: message,
	};
}

/**
 * Convert a SessionEntry to a wire TranscriptEntry.
 */
export function sessionEntryToTranscriptEntry(entry: SessionEntry, revision: number): TranscriptEntry {
	const timestampMs = entry.timestamp ? new Date(entry.timestamp).getTime() : Date.now();

	if (entry.type === "message" && "message" in entry) {
		const messageEntry = agentMessageToTranscriptEntry(entry.message as AgentMessage, revision);
		return {
			...messageEntry,
			id: entry.id,
			parent: entry.parentId ?? null,
			timestamp_ms: timestampMs,
			raw_discriminator: entry.type,
			raw: entry,
		};
	}

	if (entry.type === "compaction" && "summary" in entry) {
		const summaryText = typeof entry.summary === "string" ? entry.summary : "";
		return {
			id: entry.id,
			parent: entry.parentId ?? null,
			revision,
			timestamp_ms: timestampMs,
			role: "CompactionSummary",
			content: [{ Summary: { kind: "compaction", text: summaryText } }],
			meta: null,
			raw_discriminator: entry.type,
			raw: entry,
		};
	}

	if (entry.type === "branch_summary" && "summary" in entry) {
		const summaryText = typeof entry.summary === "string" ? entry.summary : "";
		return {
			id: entry.id,
			parent: entry.parentId ?? null,
			revision,
			timestamp_ms: timestampMs,
			role: "BranchSummary",
			content: [{ Summary: { kind: "branch", text: summaryText } }],
			meta: null,
			raw_discriminator: entry.type,
			raw: entry,
		};
	}

	if (entry.type === "session_lifecycle") {
		const phase = "phase" in entry && typeof entry.phase === "string" ? entry.phase : "lifecycle";
		const reason = "reason" in entry && typeof entry.reason === "string" ? entry.reason : null;
		return {
			id: entry.id,
			parent: entry.parentId ?? null,
			revision,
			timestamp_ms: timestampMs,
			role: "Lifecycle",
			content: [{ Lifecycle: { phase, reason } }],
			meta: null,
			raw_discriminator: entry.type,
			raw: entry,
		};
	}

	return {
		id: entry.id,
		parent: entry.parentId ?? null,
		revision,
		timestamp_ms: timestampMs,
		role: "Custom",
		content: [{ Fallback: { producer: entry.type, value: entry } }],
		meta: null,
		raw_discriminator: entry.type,
		raw: entry,
	};
}
