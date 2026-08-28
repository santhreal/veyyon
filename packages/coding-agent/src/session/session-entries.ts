import type { SessionEntry, SessionEntryBase } from "@veyyon/agent-core/compaction/entries";
import type { Usage } from "@veyyon/ai";
import type { InstrumentationLevel } from "@veyyon/ai/instrumentation";

export type {
	BranchSummaryEntry,
	CompactionEntry,
	CustomEntry,
	CustomMessageEntry,
	LabelEntry,
	MCPToolSelectionEntry,
	ModeChangeEntry,
	ModelChangeEntry,
	ServiceTierChangeEntry,
	SessionEntry,
	SessionEntryBase,
	SessionInitEntry,
	SessionMessageEntry,
	ThinkingLevelChangeEntry,
	TitleChangeEntry,
	TtsrInjectionEntry,
} from "@veyyon/agent-core/compaction/entries";

declare module "@veyyon/agent-core/compaction/entries" {
	interface CustomCompactionSessionEntries {
		subagentSpawn: SubagentSpawnEntry;
		settingsSnapshot: SettingsSnapshotEntry;
		sessionLifecycle: SessionLifecycleEntry;
		sessionCheckpoint: SessionCheckpointEntry;
	}
}

export const CURRENT_SESSION_VERSION = 3;

export const SESSION_TITLE_SLOT_BYTES = 256;

export const SESSION_TITLE_SLOT_ENTRY_TYPE = "title";

export const TITLE_CHANGE_ENTRY_TYPE = "title_change";

export type SessionTitleSource = "auto" | "user";

export interface SessionTitleSlotEntry {
	type: typeof SESSION_TITLE_SLOT_ENTRY_TYPE;
	v: 1;
	title: string;
	source?: SessionTitleSource;
	updatedAt: string;
	pad: string;
}

export const EPHEMERAL_MODEL_CHANGE_ROLE = "fallback";

export interface SessionHeader {
	type: "session";
	version?: number; // v1 sessions don't have this
	id: string;
	title?: string; // Auto-generated title from first message
	titleSource?: SessionTitleSource;
	timestamp: string;
	cwd: string;
	parentSession?: string;
	providerPromptCacheKey?: string;
}

export interface NewSessionOptions {
	parentSession?: string;
	providerPromptCacheKey?: string;
	drop?: boolean;
}

export interface SubagentSpawnRecord {
	agentId: string;
	agentName: string;
	task: string;
	sessionFile: string;
	isolation: string;
	status: "completed" | "failed" | "cancelled";
	exitCode: number;
	durationMs: number;
	usage?: Usage;
	error?: string;
}

export interface SubagentSpawnEntry extends SessionEntryBase, SubagentSpawnRecord {
	type: "subagent_spawn";
}

export interface SettingsSnapshotEntry extends SessionEntryBase {
	type: "settings_snapshot";
	kind: "full" | "diff";
	values: Record<string, unknown>;
}

export type SessionLifecycleState = "running" | "ended";

export type SessionLifecycleReason =
	| "created"
	| "resumed"
	| "closed"
	| "new_session"
	| "session_switched"
	| "instrumentation_disabled"
	| "instrumentation_changed";

export interface SessionLifecycleEntry extends SessionEntryBase {
	type: "session_lifecycle";
	state: SessionLifecycleState;
	reason: SessionLifecycleReason;
	instrumentationLevel?: Exclude<InstrumentationLevel, "off">;
}

export interface SessionCheckpointEntry extends SessionEntryBase {
	type: "session_checkpoint";
	prefixSequence: number;
}

export interface SessionCheckpoint {
	id: string;
	prefixSequence: number;
}

export type FileEntry = SessionHeader | SessionEntry;

export type RawFileEntry = SessionTitleSlotEntry | FileEntry;

export interface SessionTreeNode {
	entry: SessionEntry;
	children: SessionTreeNode[];
	label?: string;
}

export interface UsageStatistics {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	orchestrationInput: number;
	orchestrationOutput: number;
	orchestrationCacheRead: number;
	premiumRequests: number;
	cost: number;
}
