/**
 * The vocabulary a compaction pass is decided against: what a check concluded,
 * the bar the pass is measured against, the token and idle bounds the reducing
 * tiers work within, the window a model declares, the recovery band, and the
 * notice shown when a context is too full to compact its way out.
 */

import { stripLegacyArchive } from "@veyyon/agent-core/compaction";
import type { CodexCompactionContext, Model } from "@veyyon/ai";

export type CompactionCheckResult = Readonly<{
	continuationScheduled: boolean;
	automaticContinuationBlocked?: boolean;
	historyRewritten?: boolean;
}>;

export const COMPACTION_CHECK_NONE: CompactionCheckResult = {
	continuationScheduled: false,
};

export const COMPACTION_CHECK_CONTINUATION: CompactionCheckResult = {
	continuationScheduled: true,
};

export const COMPACTION_CHECK_BLOCK_AUTOMATIC_CONTINUATION: CompactionCheckResult = {
	continuationScheduled: false,
	automaticContinuationBlocked: true,
};

/**
 * The bar a compaction pass is measured against. `"fit"` is the overflow/
 * incomplete retry, which only has to fit the window; `"recovery-band"` is the
 * threshold pass, which needs hysteresis under the trigger.
 */
export type CompactionBar = "fit" | "recovery-band";

/** Where the live context sits relative to a {@link CompactionBar}. */
export type CompactionBudget = Readonly<{ residualTokens: number; budgetTokens: number }>;

/**
 * Tokens preserved at the start and at the end of every text the truncation
 * tier cuts. A tool result states what it read in its first lines and what it
 * concluded in its last, and a model that keeps both can still tell what the
 * call was; the bulk between them is what a context window is spent on.
 */
export const TRUNCATION_KEEP_EDGE_TOKENS = 512;

/**
 * Smallest text the truncation tier will cut. Below `2 ×` the kept edges plus
 * a margin there is no middle worth removing, and the marker would cost more
 * than the cut frees.
 */
export const TRUNCATION_MIN_TEXT_TOKENS = TRUNCATION_KEEP_EDGE_TOKENS * 2 + 256;

/**
 * Per-turn prune cache window. A tool result whose all-message suffix exceeds
 * this is in the warm, already-sent prompt-cache prefix: re-writing it costs the
 * cacheWrite premium on the whole suffix. Per-turn passes only reclaim inside
 * this tail (matches the supersede pass's default `suffixTokenLimit`); deeper
 * stale/age victims are left to compaction/shake, which rebuild the cache anyway.
 */
export const PRUNE_CACHE_WARM_SUFFIX_TOKENS = 8_000;

/**
 * Idle gap after which the supersede pass may flush the whole sent region (the
 * provider cache is cold, so re-writing it is free). MUST exceed the maximum
 * Anthropic prompt-cache TTL: "long" retention (the OAuth default) is 1h, or a
 * still-warm prefix is busted by the flush. 90 min leaves margin over the 1h TTL.
 */
export const PRUNE_IDLE_FLUSH_MS = 90 * 60_000;

/**
 * Hysteresis band for the post-maintenance "did we actually create headroom?"
 * check shared by the shake tail and the context-full tail. A
 * pass counts as having resolved threshold pressure only when residual context
 * lands at or below `COMPACTION_RECOVERY_BAND × threshold`. Re-checking against
 * the raw threshold lets a pass keep reclaiming a trickle of the previous
 * turn's output and land just under the line every turn, sustaining the
 * auto-continue dead loop reported in #2275; the same band stops the
 * context-full tail from re-firing on a history whose single
 * most-recent kept turn already exceeds the threshold (the compaction thrash).
 */
export const COMPACTION_RECOVERY_BAND = 0.8;

/**
 * User-facing notice for a compaction dead end: every automatic reducer ran and
 * the context is still over the bar. By the time this fires the tiered rescue
 * has already elided heavy blocks to an artifact, dropped attached images and
 * truncated the largest remaining texts, so what is left is many small messages
 * that only a summarizer or the operator can reduce.
 */
export function compactionDeadEndWarning(): string {
	return (
		"Compaction freed too little context to make progress — pausing automatic maintenance to avoid a compaction loop. " +
		"Eliding, image-dropping and truncating the largest messages all ran and the context is still over budget: " +
		"start a fresh session with /new, or switch to a larger-context model."
	);
}

/**
 * Context window compaction may price itself against, or undefined when the
 * model declares none.
 *
 * `Model.contextWindow` is nullable, and null there is a statement: this model
 * never told us how much it holds. Compaction caps its recent-history budget
 * against that window so it cannot ask to keep more conversation than the
 * prompt is allowed to carry, and there is nothing to cap against here.
 * Substituting a default would clamp against a number nobody stated, so the
 * cap is skipped and the configured budget stands, which is the behaviour
 * every session had before the cap existed.
 */
export function declaredContextWindow(model: Model | undefined): number | undefined {
	const contextWindow = model?.contextWindow;
	return typeof contextWindow === "number" && contextWindow > 0 ? contextWindow : undefined;
}

/**
 * The lifecycle fields a caller states. The operation identity is minted per
 * call and the strategy is fixed, so neither is a caller's to supply.
 */
export type CodexCompactionContextOptions = Pick<CodexCompactionContext, "trigger" | "reason" | "phase">;

export function createCodexCompactionContext(options: CodexCompactionContextOptions): CodexCompactionContext {
	return {
		operationId: crypto.randomUUID(),
		trigger: options.trigger,
		reason: options.reason,
		phase: options.phase,
		strategy: "memento",
	};
}

export function mergeLlmCompactionPreserveData(
	hookPreserveData: Record<string, unknown> | undefined,
	resultPreserveData: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
	const preserveData = { ...(hookPreserveData ?? {}), ...(resultPreserveData ?? {}) };
	return stripLegacyArchive(Object.keys(preserveData).length > 0 ? preserveData : undefined);
}
