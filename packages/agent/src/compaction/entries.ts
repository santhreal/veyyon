import type { ToolResultMessage } from "@veyyon/ai";
import type {
	AgentMessage,
	BranchSummaryEntry,
	CompactionEntry,
	CustomCompactionSessionEntries,
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
} from "@veyyon/session";

/**
 * The session-entry vocabulary is DECLARED in `@veyyon/session` and re-exported here, so
 * `import type { CompactionEntry } from "@veyyon/agent-core/compaction/entries"` keeps working
 * while there is one definition to read and one place to add a field. This file used to own it,
 * and the coding agent a second copy: twelve of fifteen shapes were byte-identical and three had
 * drifted, so compaction read a `SessionInitEntry` without the `spawns` the coding agent wrote.
 * Its own additions arrive through `CustomCompactionSessionEntries`, the declaration-merging hook
 * on the contract. Add a field THERE, not in a second copy.
 *
 * What stays here is behaviour over that vocabulary: the compaction boundary and the tool-result
 * narrowing every compaction pass shares.
 */
export type {
	BranchSummaryEntry,
	CompactionEntry,
	CustomCompactionSessionEntries,
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
};

export interface ReadonlySessionManager {
	getBranch(leafId?: string | null): SessionEntry[];
	getEntry(id: string): SessionEntry | undefined;
}

/**
 * The tool result an entry carries, or undefined when it carries something else.
 *
 * Compaction walks a whole branch looking for tool output to prune or shake, so nearly every
 * entry it sees is NOT a tool result and answering undefined is the ordinary case rather than a
 * failure. The narrowing lives with the {@link SessionEntry} union it narrows: both compaction
 * passes had their own copy, and a pass that recognised one message shape while its sibling
 * recognised another would prune output the other still counted.
 */
export function getToolResultMessage(entry: SessionEntry): ToolResultMessage | undefined {
	if (entry.type !== "message") return undefined;
	const message = entry.message as AgentMessage;
	if (message.role !== "toolResult") return undefined;
	return message as ToolResultMessage;
}

/**
 * `firstKeptEntryId` for a compaction that keeps no pre-compaction entry at all.
 *
 * A range can be one unbreakable oversized turn: a tool result is never a valid
 * cut point, because cutting there would separate it from the call it answers,
 * so a single enormous result leaves the assistant message in front of it as the
 * newest usable boundary, and keeping from there keeps everything. Summarizing
 * the whole range and keeping nothing is then the only way to free anything.
 *
 * Readers resolve the id against the entries in the path and there is
 * deliberately no entry with this one, so every reader that walks until it finds
 * the first kept entry keeps nothing, which is what this means.
 */
export const KEEP_NOTHING_ENTRY_ID = "compaction:keep-nothing";

/**
 * Array index of the compaction boundary named by a `firstKeptEntryId`. Entries
 * BEFORE it were summarized away by the latest compaction and are never sent, so
 * prune and shake passes skip them: rewriting them churns persisted history
 * without shrinking a single prompt.
 *
 * Three cases, and the third is why this is shared rather than inlined at each
 * call site. No boundary means no compaction, so the whole branch is live and
 * the index is 0. An ordinary id resolves to its entry. {@link
 * KEEP_NOTHING_ENTRY_ID} deliberately matches no entry, and a plain `findIndex`
 * answers -1 for it, which every caller clamped to 0 — the exact opposite of
 * what it means. It resolves to just past the compaction entry, because a
 * compaction that kept nothing left everything before itself summarized away.
 */
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
