import type { ImageContent, MessageAttribution, ServiceTierByFamily, TextContent, ToolResultMessage } from "@veyyon/ai";
import type { AgentMessage } from "../types";

export interface SessionEntryBase {
	type: string;
	id: string;
	parentId: string | null;
	timestamp: string;
	sequence?: number;
}

export interface SessionMessageEntry extends SessionEntryBase {
	type: "message";
	message: AgentMessage;
}

export interface ThinkingLevelChangeEntry extends SessionEntryBase {
	type: "thinking_level_change";
	thinkingLevel?: string | null;
	configured?: string | null;
}

export interface ModelChangeEntry extends SessionEntryBase {
	type: "model_change";
	model: string;
	role?: string;
}

export interface ServiceTierChangeEntry extends SessionEntryBase {
	type: "service_tier_change";
	serviceTier: ServiceTierByFamily | null;
}

export interface CompactionEntry<T = unknown> extends SessionEntryBase {
	type: "compaction";
	summary: string;
	shortSummary?: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	details?: T;
	preserveData?: Record<string, unknown>;
	fromExtension?: boolean;
	warning?: string;
}

export interface BranchSummaryEntry<T = unknown> extends SessionEntryBase {
	type: "branch_summary";
	fromId: string;
	summary: string;
	details?: T;
	fromExtension?: boolean;
}

export interface CustomMessageEntry<T = unknown> extends SessionEntryBase {
	type: "custom_message";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	details?: T;
	display: boolean;
	attribution?: MessageAttribution;
}

export interface CustomEntry<T = unknown> extends SessionEntryBase {
	type: "custom";
	customType: string;
	data?: T;
}

export interface LabelEntry extends SessionEntryBase {
	type: "label";
	targetId: string;
	label: string | undefined;
}

export interface TitleChangeEntry extends SessionEntryBase {
	type: "title_change";
	title: string;
	previousTitle?: string;
	source: "auto" | "user";
	trigger?: string;
}

export interface TtsrInjectionEntry extends SessionEntryBase {
	type: "ttsr_injection";
	injectedRules: string[];
}

export interface MCPToolSelectionEntry extends SessionEntryBase {
	type: "mcp_tool_selection";
	selectedToolNames: string[];
}

export interface SessionInitEntry extends SessionEntryBase {
	type: "session_init";
	systemPrompt: string;
	task: string;
	tools: string[];
	outputSchema?: unknown;
	spawns?: string;
	readSummarize?: boolean;
	maxNestedSpawnDepth?: number;
}

export interface ModeChangeEntry extends SessionEntryBase {
	type: "mode_change";
	mode: string;
	data?: Record<string, unknown>;
}

export interface CustomCompactionSessionEntries {}

export type SessionEntry =
	| SessionMessageEntry
	| ThinkingLevelChangeEntry
	| ModelChangeEntry
	| ServiceTierChangeEntry
	| CompactionEntry
	| BranchSummaryEntry
	| CustomEntry
	| CustomMessageEntry
	| LabelEntry
	| TitleChangeEntry
	| TtsrInjectionEntry
	| MCPToolSelectionEntry
	| SessionInitEntry
	| ModeChangeEntry
	| CustomCompactionSessionEntries[keyof CustomCompactionSessionEntries];

export interface ReadonlySessionManager {
	getBranch(leafId?: string | null): SessionEntry[];
	getEntry(id: string): SessionEntry | undefined;
}

export function getToolResultMessage(entry: SessionEntry): ToolResultMessage | undefined {
	if (entry.type !== "message") return undefined;
	const message = entry.message as AgentMessage;
	if (message.role !== "toolResult") return undefined;
	return message as ToolResultMessage;
}

export const KEEP_NOTHING_ENTRY_ID = "compaction:keep-nothing";

export function resolveCompactionBoundaryIndex(
	entries: readonly SessionEntry[],
	keepBoundaryId: string | undefined,
): number {
	if (keepBoundaryId === undefined) return 0;
	if (keepBoundaryId === KEEP_NOTHING_ENTRY_ID) {
		for (let i = entries.length - 1; i >= 0; i--) {
			if (entries[i].type === "compaction") return i + 1;
		}
		return 0;
	}
	const index = entries.findIndex(entry => entry.id === keepBoundaryId);
	return index < 0 ? 0 : index;
}
