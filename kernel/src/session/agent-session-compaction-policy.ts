/**
 * The compaction decision as data: what a check can conclude, the window a model
 * declares, the recovery band, and the notice shown when a context is too full to
 * compact its way out.
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

export function createCodexCompactionContext(options: {
	trigger: CodexCompactionContext["trigger"];
	reason: CodexCompactionContext["reason"];
	phase: CodexCompactionContext["phase"];
}): CodexCompactionContext {
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
