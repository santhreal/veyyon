/**
 * Every prompt the agent core sends a model, owned in ONE place.
 *
 * The compaction prompts used to be imported by ad-hoc relative path from the
 * three modules that assemble them, so the set had no name and no list. This
 * file is the same contract `@veyyon/coding-agent`'s prompt registry states, at
 * this package's boundary: the import IS the registration, the id is the path
 * under `src/prompts/` without its extension, and nothing outside this file
 * imports a `.md` from that tree.
 *
 * A package owns its own prompts. Reaching across a package boundary for
 * another one's assets would put the file's location back in two places, which
 * is the duplication the registry exists to remove. The row SHAPE is shared, from
 * `@veyyon/utils`, for the opposite reason: it is one concept, and this file used to
 * declare its own `PromptEntry` that had no `sections` field, so a prompt registered
 * here could not describe how it divides even when it did.
 */
import { definePromptRegistry, type PromptEntry } from "@veyyon/utils/prompt-registry";
import compactionAutoHandoffThresholdFocus from "./compaction/auto-handoff-threshold-focus.md" with { type: "text" };
import compactionBranchSummary from "./compaction/branch-summary.md" with { type: "text" };
import compactionBranchSummaryContext from "./compaction/branch-summary-context.md" with { type: "text" };
import compactionBranchSummaryPreamble from "./compaction/branch-summary-preamble.md" with { type: "text" };
import compactionCompactionShortSummary from "./compaction/compaction-short-summary.md" with { type: "text" };
import compactionCompactionSummary from "./compaction/compaction-summary.md" with { type: "text" };
import compactionCompactionSummaryContext from "./compaction/compaction-summary-context.md" with { type: "text" };
import compactionCompactionTurnPrefix from "./compaction/compaction-turn-prefix.md" with { type: "text" };
import compactionCompactionUpdateSummary from "./compaction/compaction-update-summary.md" with { type: "text" };
import compactionFileOperations from "./compaction/file-operations.md" with { type: "text" };
import compactionHandoffDocument from "./compaction/handoff-document.md" with { type: "text" };
import compactionLegacyArchiveContext from "./compaction/legacy-archive-context.md" with { type: "text" };
import compactionSummarizationSystem from "./compaction/summarization-system.md" with { type: "text" };

export type { PromptEntry };

export const agentCorePrompts = definePromptRegistry("packages/agent/src/prompts", {
	"compaction/auto-handoff-threshold-focus": {
		text: compactionAutoHandoffThresholdFocus,
		purpose: "the extra focus a threshold-triggered handoff gets",
	},
	"compaction/branch-summary": {
		text: compactionBranchSummary,
		purpose: "summarizes a conversation branch before returning from it",
	},
	"compaction/branch-summary-context": {
		text: compactionBranchSummaryContext,
		purpose: "hands a returning session the summary of the branch it explored",
	},
	"compaction/branch-summary-preamble": {
		text: compactionBranchSummaryPreamble,
		purpose: "introduces a branch summary in the resumed conversation",
	},
	"compaction/compaction-short-summary": {
		text: compactionCompactionShortSummary,
		purpose: "the pull-request-style short summary of a compacted session",
	},
	"compaction/compaction-summary": {
		text: compactionCompactionSummary,
		purpose: "the structured summary that replaces a compacted conversation",
	},
	"compaction/compaction-summary-context": {
		text: compactionCompactionSummaryContext,
		purpose: "hands a fresh model the previous model's summary and tool state",
	},
	"compaction/compaction-turn-prefix": {
		text: compactionCompactionTurnPrefix,
		purpose: "marks the dropped prefix of a turn too large to keep whole",
	},
	"compaction/compaction-update-summary": {
		text: compactionCompactionUpdateSummary,
		purpose: "folds new messages into an existing handoff summary",
	},
	"compaction/file-operations": {
		text: compactionFileOperations,
		purpose: "the file-state block carried through a compaction",
	},
	"compaction/handoff-document": {
		text: compactionHandoffDocument,
		purpose: "writes the handoff document that starts a new session",
	},
	"compaction/legacy-archive-context": {
		text: compactionLegacyArchiveContext,
		purpose: "reintroduces text recovered from an older compaction archive",
	},
	"compaction/summarization-system": {
		text: compactionSummarizationSystem,
		purpose: "the summarizer's brief when a session is compacted",
	},
});

/** Every prompt this package sends, by id. */
export const AGENT_PROMPTS = agentCorePrompts.prompts;

/** The id of a registered agent-core prompt. A value outside this union is a compile error. */
export type AgentPromptId = keyof typeof AGENT_PROMPTS;

/** Every registered id, for enumeration. */
export const AGENT_PROMPT_IDS = agentCorePrompts.ids;

/**
 * The lookups live on `agentCorePrompts`, not under package-specific names.
 *
 * `agentCorePrompts.require(id)` is the one to reach for when an id comes from a variable.
 * It throws rather than returning undefined, and this package had no such lookup at all,
 * which is worse than the wrong one: a caller indexed `AGENT_PROMPTS` directly, and an id
 * that had drifted from its filename yielded `undefined` whose `.text` reached the
 * summarizer as no brief. A compaction that runs with an empty system prompt still returns
 * a summary, so nothing failed loudly; the session simply came back worse.
 */
