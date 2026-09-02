import type { AgentMessage } from "@veyyon/agent-core";
import type { SessionEntry, SessionHeader } from "../session/session-entries";
import type { SessionInfo } from "../session/session-listing";
import { base64DecodedBytes } from "../utils/video-loading";
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
	SessionDeletion: true,
	SessionTreeNavigation: true,
	Transcript: true,
	TurnControl: true,
	BackgroundSubmission: true,
	Tools: true,
	Approvals: true,
	Questions: true,
	Plans: true,
	Files: true,
	Changes: true,
	Terminals: true,
	ProcessSupervisor: true,
	Models: true,
	Providers: true,
	Authentication: true,
	Mcp: true,
	Agents: true,
	Tasks: true,
	Settings: true,
	Themes: true,
	Keybindings: true,
	Diagnostics: true,
	Usage: true,
	ContextBreakdown: true,
	Lifecycle: true,
};

/** Specific, truthful reasons why each unsupported capability is unavailable. */
export const UNAVAILABLE_CAPABILITY_REASONS: Record<"PendingEdits" | "Extensions" | "AgentCommands", string> = {
	PendingEdits: "Pending edit inspection is not supported by this host version",
	Extensions: "Extension management is handled directly through the extension host",
	AgentCommands: "Agent command discovery is managed through the slash-command registry",
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

const ACTION_ERROR_SCOPES: Record<string, ErrorScope> = {
	Attach: "Connection",
	Detach: "Connection",
	RetryConnection: "Connection",
	Shutdown: "Lifecycle",
	ListSessions: "Session",
	OpenSession: "Session",
	CreateSession: "Session",
	RenameSession: "Session",
	DeleteSession: "Session",
	BranchSession: "Session",
	ExportSession: "Session",
	CompactSession: "Session",
	HandoffSession: "Session",
	ClearOutput: "Session",
	GetContextBreakdown: "Session",
	LoadTranscript: "Transcript",
	SubmitPrompt: "Session",
	Steer: "Session",
	FollowUp: "Session",
	AbortTurn: "Session",
	SetQueueMode: "Session",
	CancelTool: "Tool",
	RespondToInteraction: "Interaction",
	LoadFileTree: "File",
	ReadFile: "File",
	SearchFiles: "File",
	OpenExternal: "File",
	RefreshChanges: "Change",
	SelectChangeScope: "Change",
	CreateTerminal: "Terminal",
	AttachTerminal: "Terminal",
	WriteTerminal: "Terminal",
	ResizeTerminal: "Terminal",
	RestartTerminal: "Terminal",
	ClearTerminal: "Terminal",
	CloseTerminal: "Terminal",
	RefreshProcesses: "Terminal",
	ProcessLogs: "Terminal",
	ProcessSend: "Terminal",
	ProcessSignal: "Terminal",
	ProcessStop: "Terminal",
	ProcessRestart: "Terminal",
	ProcessStart: "Terminal",
	ProcessWait: "Terminal",
	ProcessDescribe: "Terminal",
	RefreshModels: "Provider",
	SelectModel: "Provider",
	SetThinkingLevel: "Provider",
	RefreshProviders: "Provider",
	StartProviderAuth: "Authentication",
	RefreshAuth: "Authentication",
	SubmitAuthSecret: "Authentication",
	OpenAuthUrl: "Authentication",
	CancelAuthFlow: "Authentication",
	RetryAuthFlow: "Authentication",
	RefreshMcp: "Mcp",
	ConnectMcp: "Mcp",
	DisconnectMcp: "Mcp",
	SetMcpEnabled: "Mcp",
	CallMcpTool: "Mcp",
	ReviveAgent: "Agent",
	SpawnTask: "Task",
	CancelTask: "Task",
	LoadSettings: "Settings",
	SetSetting: "Settings",
	ResetSetting: "Settings",
	LoadThemes: "Settings",
	LoadKeybindings: "Settings",
	SetKeybinding: "Settings",
	RefreshDiagnostics: "Diagnostic",
	RetryDiagnosticSource: "Diagnostic",
	GetUsage: "Usage",
};

export function mapActionToErrorScope(actionTag: string): ErrorScope {
	return ACTION_ERROR_SCOPES[actionTag] ?? "Session";
}

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
	if (typeof content === "string") return [{ Text: { text: content } }];
	if (!Array.isArray(content)) return [{ Fallback: { producer: "unknown", value: content } }];

	const blocks: ContentBlock[] = [];
	for (const item of content) {
		if (!item || typeof item !== "object") continue;
		if (!("type" in item)) {
			blocks.push({ Unknown: { tag: "object", value: item } });
			continue;
		}
		if (item.type === "text" && typeof item.text === "string") {
			blocks.push({ Text: { text: item.text } });
		} else if (item.type === "thinking" && typeof item.thinking === "string") {
			blocks.push({ Thinking: { text: item.thinking } });
		} else if (item.type === "image" && typeof item.data === "string") {
			const mediaType = typeof item.mimeType === "string" ? item.mimeType : "image/png";
			blocks.push({
				Image: { media_type: mediaType, data: Array.from(Buffer.from(item.data, "base64")), alt: null },
			});
		} else if (item.type === "video" && typeof item.data === "string") {
			const mediaType = typeof item.mimeType === "string" ? item.mimeType : "video/mp4";
			const bytes = base64DecodedBytes(item.data);
			blocks.push({
				Video: { media_type: mediaType, bytes },
			});
		} else if (
			(item.type === "tool_call" || item.type === "toolCall") &&
			typeof item.id === "string" &&
			typeof item.name === "string"
		) {
			blocks.push({
				ToolCall: { id: item.id, name: item.name, arguments: "arguments" in item ? item.arguments : {} },
			});
		} else if (item.type === "tool_result" || item.type === "toolResult") {
			const toolId =
				typeof item.toolCallId === "string" ? item.toolCallId : typeof item.id === "string" ? item.id : "tool";
			blocks.push({ ToolResult: { tool: toolId, content: item.content ?? null, is_error: item.isError === true } });
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
	const u = usage as Record<string, unknown>;
	return {
		input_tokens: typeof u.input === "number" ? u.input : 0,
		output_tokens: typeof u.output === "number" ? u.output : 0,
		cache_read_tokens: typeof u.cacheRead === "number" ? u.cacheRead : 0,
		cache_write_tokens: typeof u.cacheWrite === "number" ? u.cacheWrite : 0,
		orchestration_tokens: 0,
		premium_requests: 0,
		cost_microusd: null,
	};
}

export function agentMessageToTranscriptEntry(message: AgentMessage, revision: number, id: string): TranscriptEntry {
	const role = message.role ? mapMessageRole(message.role) : "Custom";
	const meta: EntryMeta | null =
		message.role === "assistant"
			? {
					provider: typeof message.provider === "string" ? message.provider : null,
					model: typeof message.model === "string" ? message.model : null,
					stop_reason: typeof message.stopReason === "string" ? message.stopReason : null,
					error: typeof message.errorMessage === "string" ? message.errorMessage : null,
					usage: "usage" in message ? mapUsage(message.usage) : null,
				}
			: null;

	const content = "content" in message ? mapContentBlocks(message.content) : [];
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

	if (entry.type === "message" && "message" in entry) {
		return {
			...agentMessageToTranscriptEntry(entry.message as AgentMessage, revision, entry.id),
			parent: entry.parentId ?? null,
			timestamp_ms: timestampMs,
			raw_discriminator: entry.type,
			raw: entry,
		};
	}

	if (entry.type === "compaction" && "summary" in entry) {
		return {
			id: entry.id,
			parent: entry.parentId ?? null,
			revision,
			timestamp_ms: timestampMs,
			role: "CompactionSummary",
			content: [{ Summary: { kind: "compaction", text: typeof entry.summary === "string" ? entry.summary : "" } }],
			meta: null,
			raw_discriminator: entry.type,
			raw: entry,
		};
	}

	if (entry.type === "branch_summary" && "summary" in entry) {
		return {
			id: entry.id,
			parent: entry.parentId ?? null,
			revision,
			timestamp_ms: timestampMs,
			role: "BranchSummary",
			content: [{ Summary: { kind: "branch", text: typeof entry.summary === "string" ? entry.summary : "" } }],
			meta: null,
			raw_discriminator: entry.type,
			raw: entry,
		};
	}

	if (entry.type === "session_lifecycle") {
		return {
			id: entry.id,
			parent: entry.parentId ?? null,
			revision,
			timestamp_ms: timestampMs,
			role: "Lifecycle",
			content: [
				{
					Lifecycle: {
						phase: typeof entry.state === "string" ? entry.state : "lifecycle",
						reason: typeof entry.reason === "string" ? entry.reason : null,
					},
				},
			],
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
