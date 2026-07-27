import type { SessionEntry, SessionEntryBase } from "@veyyon/agent-core/compaction/entries";
import type { Usage } from "@veyyon/ai";

/**
 * The session-entry vocabulary this package uses, and the two kinds it adds.
 *
 * Every shared shape is DECLARED in `@veyyon/agent-core/compaction/entries` and re-exported
 * here, so `import type { CompactionEntry } from "./session-entries"` keeps working exactly as
 * it did while there is one definition to read and one place to add a field. This file used to
 * declare all fifteen of them a second time, plus its own copy of the `SessionEntry` union over
 * them: twelve were byte-identical and three had drifted, so compaction in the other package
 * saw `SessionInitEntry` without the `spawns`/`readSummarize` the coding agent actually writes,
 * and `ThinkingLevelChangeEntry` without `configured`.
 *
 * The two entry kinds only this package persists reach the shared union through the
 * `CustomCompactionSessionEntries` declaration-merging hook below, which is what that hook is
 * for, so `SessionEntry` stays one union over one vocabulary rather than two lists somebody has
 * to keep level by hand.
 */
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
	}
}

export const CURRENT_SESSION_VERSION = 3;

export const SESSION_TITLE_SLOT_BYTES = 256;

export const SESSION_TITLE_SLOT_ENTRY_TYPE = "title";

export const TITLE_CHANGE_ENTRY_TYPE = "title_change";

export type SessionTitleSource = "auto" | "user";

/** Fixed-width first-line slot carrying the mutable current session title. */
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
	/** Provider prompt-cache identity inherited by exact-route full forks. */
	providerPromptCacheKey?: string;
}

export interface NewSessionOptions {
	parentSession?: string;
	/** Provider prompt-cache identity to seed on the new session header. */
	providerPromptCacheKey?: string;
	/** Skip flushing the current session and delete it instead of saving. */
	drop?: boolean;
}

/**
 * The payload a parent records for one subagent it spawned. Separated from the
 * entry so the task tool can hand a plain record to the session without knowing
 * the SessionEntryBase id/parentId/timestamp bookkeeping.
 */
export interface SubagentSpawnRecord {
	/** The subagent's id — matches its transcript filename stem and `history://<agentId>`. */
	agentId: string;
	/** Agent definition name (e.g. "task", "reviewer"). */
	agentName: string;
	/** The exact task text handed to the subagent. */
	task: string;
	/** Absolute path to the subagent's durable transcript (`<artifactsDir>/<agentId>.jsonl`). */
	sessionFile: string;
	/** Isolation mode the subagent ran under ("none", "worktree", "branch", ...). */
	isolation: string;
	/** Terminal status: "completed" | "failed" | "cancelled". */
	status: "completed" | "failed" | "cancelled";
	/** Process exit code (0 = success). */
	exitCode: number;
	/** Wall-clock duration of the subagent run, in milliseconds. */
	durationMs: number;
	/** Aggregated token/cost usage, when known. */
	usage?: Usage;
	/** Terminal error message, when the run failed. */
	error?: string;
}

/**
 * Structured parent->child index entry: one per subagent a session spawned.
 *
 * Purpose: make a session's subagent tree navigable without scraping tool-result
 * prose or scanning a sibling directory. Each entry points at the child's durable
 * transcript (`sessionFile`) and records its task, isolation, outcome, timing, and
 * usage — enough to enumerate and study every subagent of a run ("including
 * subagents, everything"). The authoritative per-subagent record remains the child
 * transcript this entry points to; this entry is the navigable index over them.
 */
export interface SubagentSpawnEntry extends SessionEntryBase, SubagentSpawnRecord {
	type: "subagent_spawn";
}

/**
 * Effective-settings snapshot: the complete resolved config that governed the run.
 *
 * Purpose: make a session backtest-reproducible. The record captures every Tier-A
 * setting AS RESOLVED at session start (compaction strategy, reserve tokens,
 * advisor/subagent config, tool config, sampling knobs, ...) keyed by dotted path,
 * so a later study can reproduce the exact configuration the run used rather than
 * guessing from current defaults. Interactive changes to the few settings that
 * change mid-run (model, thinking level, service tier, mode, MCP selection) are
 * already captured by their own dedicated change entries; this snapshot fills the
 * gap for the static governing config. `kind` distinguishes the full start-of-run
 * snapshot from any later partial diff carrying only changed keys.
 */
export interface SettingsSnapshotEntry extends SessionEntryBase {
	type: "settings_snapshot";
	/** "full" = complete effective config at start; "diff" = only keys changed since the prior snapshot. */
	kind: "full" | "diff";
	/** Resolved setting values keyed by dotted setting path (for "diff", only the changed keys). */
	values: Record<string, unknown>;
}

/** Raw logical file entry after loaders strip any fixed-width title slot. */
export type FileEntry = SessionHeader | SessionEntry;

/** Physical JSONL entry before slot-aware loaders fold the title slot. */
export type RawFileEntry = SessionTitleSlotEntry | FileEntry;

/** Tree node for getTree() - defensive copy of session structure */
export interface SessionTreeNode {
	entry: SessionEntry;
	children: SessionTreeNode[];
	/** Resolved label for this entry, if any */
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
