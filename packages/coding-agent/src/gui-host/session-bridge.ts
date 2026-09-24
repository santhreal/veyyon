import type { SessionEntry, SessionHeader } from "@veyyon/kernel/session/session-entries";
import type { SessionInfo } from "@veyyon/kernel/session/session-listing";
import type { Settings } from "../config/settings";
import { settingsOrNull } from "../config/settings-instance";
import { SETTINGS_SCHEMA } from "../config/settings-schema";
import {
	ALL_CAPABILITIES,
	type Capability,
	type CapabilityStatus,
	type ErrorScope,
	type SessionHeaderView,
	type SessionStatus,
	type SessionSummary,
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
	AgentCommands: true,
	Tasks: true,
	Settings: true,
	Themes: true,
	Keybindings: true,
	Diagnostics: true,
	Usage: true,
	ContextBreakdown: true,
	Lifecycle: true,
	Goals: true,
	Share: true,
	Profiles: true,
	Dictation: true,
};

/** Specific, truthful reasons why each unsupported capability is unavailable. */
export const UNAVAILABLE_CAPABILITY_REASONS: Record<"PendingEdits" | "Extensions", string> = {
	PendingEdits: "Pending edit inspection is not supported by this host version",
	Extensions: "Extension management is handled directly through the extension host",
};

/**
 * A capability this host implements that a setting withholds, with the setting
 * that governs it and the sentence the window draws on the gate.
 *
 * The state each one falls back to is read from the declaration rather than
 * written here. A window can connect before this process has loaded settings,
 * because the greeting frames are written from the connection listener while
 * the store is filled by the first session, and a restated fallback answers
 * for whichever setting it was written against: a literal `true` reported the
 * microphone as reachable on every fresh connection, since `stt.enabled` is
 * declared off. `Attach` re-states the list from the session's own store.
 */
const SETTING_GATED_CAPABILITIES: readonly {
	capability: Capability;
	path: "goal.enabled" | "stt.enabled";
	reason: string;
}[] = [
	{
		capability: "Goals",
		path: "goal.enabled",
		reason: "Goal mode is disabled in settings (goal.enabled)",
	},
	{
		capability: "Dictation",
		path: "stt.enabled",
		reason: "Speech to text is disabled in settings (stt.enabled)",
	},
];

/**
 * Construct the capabilities list covering every member of ALL_CAPABILITIES.
 *
 * `SUPPORTED_CAPABILITIES` states what this host implements. A capability the host implements can
 * still be withheld by the state it runs under, which is what `goal.enabled` does to `Goals`: the
 * window then draws the gate and its reason rather than a control that refuses.
 */
export function buildCapabilitiesSnapshot(settings?: Settings): [Capability, CapabilityStatus][] {
	const effectiveSettings = settings ?? settingsOrNull();
	const withheld = new Map<Capability, string>();
	for (const gate of SETTING_GATED_CAPABILITIES) {
		const enabled = effectiveSettings ? effectiveSettings.get(gate.path) : SETTINGS_SCHEMA[gate.path].default;
		if (!enabled) withheld.set(gate.capability, gate.reason);
	}
	return ALL_CAPABILITIES.map(capability => {
		const withheldReason = withheld.get(capability);
		if (withheldReason) {
			return [capability, { Unavailable: { reason: withheldReason } }];
		}
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
	PreviewSessionTranscript: "Transcript",
	SearchSessions: "Session",
	SubmitPrompt: "Session",
	Steer: "Session",
	FollowUp: "Session",
	AbortTurn: "Session",
	RetryTurn: "Session",
	RephraseReply: "Session",
	ReviewPlan: "Session",
	SetQueueMode: "Session",
	SetSessionMode: "Session",
	DequeueQueuedPrompt: "Session",
	CancelTool: "Tool",
	SetToolViewExpanded: "Tool",
	RespondToInteraction: "Interaction",
	LoadFileTree: "File",
	ReadFile: "File",
	SearchFiles: "File",
	SearchContent: "File",
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
	RefreshModels: "Provider",
	SelectModel: "Provider",
	SetThinkingLevel: "Provider",
	RefreshProviders: "Provider",
	StartProviderAuth: "Authentication",
	SubmitAuthSecret: "Authentication",
	OpenAuthUrl: "Authentication",
	CancelAuthFlow: "Authentication",
	RetryAuthFlow: "Authentication",
	RefreshMcp: "Mcp",
	SetMcpEnabled: "Mcp",
	ReviveAgent: "Agent",
	RefreshAgents: "Agent",
	SpawnTask: "Task",
	CancelTask: "Task",
	ListCommands: "Session",
	RunCommand: "Session",
	LoadSettings: "Settings",
	SetSetting: "Settings",
	ResetSetting: "Settings",
	LoadThemes: "Settings",
	LoadKeybindings: "Settings",
	SetKeybinding: "Settings",
	RefreshDiagnostics: "Diagnostic",
	RetryDiagnosticSource: "Diagnostic",
	GetUsage: "Usage",
	SetGoal: "Session",
	ControlGoal: "Session",
	StartShare: "Session",
	StopShare: "Session",
	RefreshShare: "Session",
	JoinShare: "Session",
	LeaveShare: "Session",
	RefreshProfiles: "Settings",
	CreateProfile: "Settings",
	RenameProfile: "Settings",
	DeleteProfile: "Settings",
	ToggleDictation: "Session",
	CancelDictation: "Session",
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

/**
 * The mode a session is in, read from the last mode change it recorded.
 *
 * A mode is not part of the header on disk: it is a session entry, appended
 * whenever a mode is entered or left, so the current one is the last such
 * entry and a session that never entered one is in `none`.
 */
export function sessionMode(entries: readonly SessionEntry[]): string {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry?.type === "mode_change") return entry.mode;
	}
	return "none";
}

export function sessionHeaderToView(
	header: SessionHeader | null | undefined,
	entries: readonly SessionEntry[] = [],
): SessionHeaderView {
	const mode = sessionMode(entries);
	if (!header) {
		return {
			id: "unknown",
			schema_version: 3,
			title: null,
			title_source: null,
			parent: null,
			created_at_ms: Date.now(),
			cwd: process.cwd(),
			mode,
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
		mode,
	};
}
