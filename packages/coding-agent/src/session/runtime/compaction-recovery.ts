/**
 * What follows a compaction pass: the bar the live context has to land under, the provider-free
 * dead-end rescue tiers (elide heavy blocks, drop attached images, truncate the largest texts), and
 * the turn scheduled after the pass.
 *
 * This is a compaction collaborator. `CompactionRuntime` runs the pass and asks this whether it freed
 * enough; the rescue tiers and the scheduling reach the session through
 * {@link CompactionRecoverySession} and {@link CompactionRecoveryHost}. It holds no state of its own.
 */
import type { Agent } from "@veyyon/agent-core";
import {
	AGGRESSIVE_SHAKE_CONFIG,
	collectOversizedTextRegions,
	compactionContextTokens,
	resolveBudgetReserveTokens,
	resolveThresholdTokens,
	type ShakeConfig,
	type ShakeRegion,
	shouldCompact,
} from "@veyyon/agent-core/compaction";
import type { AssistantMessage, Model } from "@veyyon/ai";
import {
	COMPACTION_CHECK_BLOCK_AUTOMATIC_CONTINUATION,
	COMPACTION_CHECK_CONTINUATION,
	COMPACTION_CHECK_NONE,
	COMPACTION_RECOVERY_BAND,
	type CompactionBar,
	type CompactionBudget,
	type CompactionCheckResult,
	compactionDeadEndWarning,
	TRUNCATION_KEEP_EDGE_TOKENS,
	TRUNCATION_MIN_TEXT_TOKENS,
} from "@veyyon/kernel/session/agent-session-compaction-policy";
import type { CompactionEntry, SessionEntry } from "@veyyon/kernel/session/session-entries";
import type { SessionManager } from "@veyyon/kernel/session/session-manager";
import type { ShakeMode, ShakeResult } from "@veyyon/kernel/session/shake-types";
import { errorMessage, formatCount, logger } from "@veyyon/utils";
import type { Settings } from "../../config/settings";
import type { ContextUsage } from "../../extensibility/extensions/types";
import type { ScheduledAgentContinueOptions } from "../agent-session-types";
import type { ElisionOutcome } from "./history-rewrites";

/** What {@link CompactionRecovery} reads from the session's public surface. */
export interface CompactionRecoverySession {
	readonly agent: Agent;
	readonly sessionManager: SessionManager;
	readonly settings: Settings;
	readonly model: Model | undefined;
	emitNotice(level: "info" | "warning" | "error", message: string, source?: string): void;
	getContextUsage(options?: { contextWindow?: number }): ContextUsage | undefined;
	shake(mode: ShakeMode, opts?: { config?: ShakeConfig; signal?: AbortSignal }): Promise<ShakeResult>;
	dropImages(): Promise<{ removed: number }>;
}

/** What {@link CompactionRecovery} needs from the session beyond its public surface. */
export interface CompactionRecoveryHost {
	scheduleAgentContinue(options?: ScheduledAgentContinueOptions): void;
	/** Schedule the agent-authored prompt that resumes work after a threshold pass. */
	scheduleAutoContinuePrompt(generation: number): void;
	/** Tokens the stored conversation holds, estimated locally. */
	estimateStoredContextTokens(): number;
	/** `config` with the approved plan file added to its protected tools. */
	withPlanProtection(config: ShakeConfig): ShakeConfig;
	/** The compaction the next prompt is built from on `branch`. */
	promptCompaction(branch: readonly SessionEntry[]): CompactionEntry | null;
	/** Offload `regions` to one recovery artifact and replace each with a placeholder. */
	offloadAndApplyShakeRegions(regions: ShakeRegion[]): Promise<ElisionOutcome>;
	rebasePendingContextSnapshotAfterHistoryRewrite(): void;
}

/** What triggered an automatic compaction pass. */
export type AutoCompactionReason = "overflow" | "threshold" | "idle" | "incomplete";

/** A pass that scheduled a turn reports it; one that did not blocks automatic continuation at a dead end. */
export function compactionCheckOutcome(continuationScheduled: boolean, deadEnd: boolean): CompactionCheckResult {
	if (continuationScheduled) return COMPACTION_CHECK_CONTINUATION;
	return deadEnd ? COMPACTION_CHECK_BLOCK_AUTOMATIC_CONTINUATION : COMPACTION_CHECK_NONE;
}

/** Notice fragment for a dead-end elide tier: what was freed and where it went. */
function describeElideRescue(elided: number, tokensFreed: number, sink: string): string {
	return `elided ${formatCount("heavy block", elided)} (~${tokensFreed.toLocaleString()} tokens) to ${sink}`;
}

export class CompactionRecovery {
	readonly #session: CompactionRecoverySession;
	readonly #host: CompactionRecoveryHost;

	constructor(session: CompactionRecoverySession, host: CompactionRecoveryHost) {
		this.#session = session;
		this.#host = host;
	}

	/**
	 * Live residual context in tokens: usage for the active window minus the
	 * stored-snapshot allowance. Every post-maintenance measurement in this
	 * class uses this convention, so it is stated once.
	 */
	#residualContextTokens(contextWindow: number): number {
		return compactionContextTokens(
			this.#session.getContextUsage({ contextWindow })?.tokens ?? 0,
			this.#host.estimateStoredContextTokens(),
		);
	}

	/**
	 * The bar a compaction pass has to land under, and where the live context
	 * sits relative to it.
	 *
	 * Two bars exist because the callers recover from different things.
	 * `"fit"` is the overflow/incomplete retry: the rebuilt prompt only has to
	 * fit the window again. Reusing the band there turned recoverable overflows
	 * into manual dead ends — a 200k-window prompt compacted from overflow down
	 * to ~150k is comfortably retryable, but sits above `0.8 × 170k = 136k` and
	 * was refused (PR #3412 review). `"recovery-band"` is the threshold pass,
	 * which needs hysteresis: a residual just over the line re-trips threshold
	 * compaction on the next agent_end, which is the compaction thrash, so it
	 * has to reach `COMPACTION_RECOVERY_BAND × threshold`. Reaching the band
	 * settles it either way — no secondary "smaller than the trigger" guard,
	 * because when stale/tool-output pruning already dropped context under the
	 * band before this pass the trigger is itself sub-band, and demanding a
	 * strict reduction suppressed a valid continuation and warned about no
	 * progress over a session compaction had left safe.
	 *
	 * Both bars are answered here rather than at each caller because the
	 * dead-end rescue sizes its cut from the excess this reports and is then
	 * judged by a predicate over the same numbers. Sized against one bar and
	 * judged by another, the rescue either under-cuts and dead-ends anyway or
	 * removes far more context than the pause required.
	 *
	 * `undefined` when the model declares no context window: there is nothing
	 * to measure against, and every reader treats that as progress rather than
	 * pausing a session over a budget nobody stated.
	 *
	 * The `"fit"` reserve carries one wrinkle of its own. The default absolute
	 * reserve can exceed a bundled small-context window, or nearly consume a
	 * 16k-class one, so those known-impossible defaults fall back to the
	 * proportional 15% reserve; an explicit valid reserve still defines the
	 * usable prompt budget, so a retry does not enter headroom the user
	 * reserved on purpose.
	 */
	#compactionBudget(bar: CompactionBar): CompactionBudget | undefined {
		const contextWindow = this.#session.model?.contextWindow ?? 0;
		if (contextWindow <= 0) return undefined;
		const compactionSettings = this.#session.settings.getGroup("compaction");
		const residualTokens = this.#residualContextTokens(contextWindow);
		if (bar === "fit") {
			const reserve = resolveBudgetReserveTokens(contextWindow, compactionSettings);
			return { residualTokens, budgetTokens: Math.max(0, contextWindow - reserve) };
		}
		const thresholdTokens = resolveThresholdTokens(contextWindow, compactionSettings);
		return { residualTokens, budgetTokens: Math.floor(thresholdTokens * COMPACTION_RECOVERY_BAND) };
	}

	/**
	 * Does the live context meet `bar`? Callers on the retry path MUST ask this
	 * only AFTER dropping the failed assistant from the session's messages, so the
	 * just-failed turn — which the retry prompt will not include — is out of the
	 * estimate.
	 */
	#compactionMeets(bar: CompactionBar): boolean {
		const budget = this.#compactionBudget(bar);
		return !budget || budget.residualTokens <= budget.budgetTokens;
	}

	/** Tokens the live context is over `bar` by; zero once it meets the bar. */
	#compactionExcessTokens(bar: CompactionBar): number {
		const budget = this.#compactionBudget(bar);
		return budget ? Math.max(0, budget.residualTokens - budget.budgetTokens) : 0;
	}

	/**
	 * Does the live context still trip threshold compaction? Measured with the
	 * same residual convention as {@link #compactionBudget} and the exact
	 * `shouldCompact` predicate the caller used to trigger this run. Used by the
	 * Tier-0 lossless dedup pass to decide whether an LLM/snap compaction is
	 * still warranted after redundant tool-results were elided. When the window
	 * is unknown we cannot evaluate the bar, so we assume it still trips and let
	 * compaction proceed: never suppress a compaction we cannot prove is
	 * unnecessary.
	 */
	thresholdStillTrips(compactionSettings: Parameters<typeof shouldCompact>[2]): boolean {
		const contextWindow = this.#session.model?.contextWindow ?? 0;
		if (contextWindow <= 0) return true;
		return shouldCompact(this.#residualContextTokens(contextWindow), contextWindow, compactionSettings);
	}

	/**
	 * Last-resort tiered reducer when `CompactionRuntime.runAutoCompaction` would otherwise
	 * dead-end. The summarizer cut at the only available turn boundary, but the
	 * kept tail is still over `bar` because a single recent turn (a large
	 * tool-result, a heavy fenced/XML block, attached images) is itself bigger
	 * than the bar and `findCutPoint` cannot cut inside one message.
	 *
	 * Tier 1 — `shake("elide")` reaches INSIDE that tail: heavy tool-result /
	 * block content is offloaded to one `artifact://` blob behind a recoverable
	 * placeholder. Skipped when this pass already ran a shake (`skipElide`).
	 * Tier 2 — `dropImages()`: the manual `/shake images` remedy, automated.
	 * Image blocks are stripped from the branch; unlike elided text they are NOT
	 * artifact-recoverable, so this tier only runs once elide has failed the
	 * progress re-test.
	 * Tier 3 — {@link #truncateOversizedTail}: cut the middle out of the largest
	 * remaining texts. The first two tiers are shape-driven — a whole tool
	 * result, a fenced or XML block, an image — and a session wedged by a single
	 * message of megabyte-scale prose with no fence in it matches none of them,
	 * so both report nothing eligible and the session parks while unable to send
	 * another request. This tier asks only how big a text is.
	 *
	 * Each tier's rewrite re-anchors the in-flight context snapshot on its way
	 * out ({@link #afterHistoryRewrite}), so the progress predicate measures the
	 * reduced context rather than the run-start figure. The predicate is
	 * re-tested after each tier; the first tier that restores progress emits one
	 * info notice describing everything freed and stops. Returns whether
	 * progress was restored — `false` falls through to the dead-end warning.
	 */
	async #rescueCompactionDeadEnd(
		signal: AbortSignal,
		options: { skipElide: boolean; bar: CompactionBar; minTokensToFree?: number },
	): Promise<boolean> {
		if (signal.aborted) return false;
		// Two different budgets can be unmet, and the caller states which.
		// `bar` is the live context against THIS model's threshold. `minTokensToFree`
		// is the summarization payload against the widest window any compaction
		// candidate declares: when the payload does not fit, no candidate ever
		// runs, so cutting only to the bar frees too little and the run parks with
		// a summary that was never attempted. Both must be met before the rescue
		// reports progress.
		const target = options.minTokensToFree ?? 0;
		// The reducers rewrite the session branch, so freed bytes are read from
		// the context the session reports — the same number the bar is judged on —
		// not from the agent's in-memory message array, which a branch rewrite
		// does not shrink.
		const liveTokens = (): number => this.#session.getContextUsage()?.tokens ?? 0;
		const startTokens = target > 0 ? liveTokens() : 0;
		// Measured from the history itself rather than summed per tier: dropping
		// images reports a count, not tokens, and a tier that rewrites in place
		// frees bytes no tier return value states.
		const hasProgress = (): boolean =>
			this.#compactionMeets(options.bar) && (target === 0 || startTokens - liveTokens() >= target);
		let elided = 0;
		let elidedTokens = 0;
		let elideSink = "placeholders";
		if (!options.skipElide) {
			try {
				const result = await this.#session.shake("elide", { signal });
				elided = result.toolResultsDropped + result.blocksDropped;
				elidedTokens = result.tokensFreed;
				if (result.artifactId) elideSink = "an artifact";
			} catch (error) {
				logger.warn("Dead-end shake rescue failed", {
					error: errorMessage(error),
				});
			}
			if (elided > 0 && hasProgress()) {
				this.#session.emitNotice(
					"info",
					`Compaction dead-end recovery: ${describeElideRescue(elided, elidedTokens, elideSink)} so maintenance could make progress.`,
					"compaction",
				);
				return true;
			}
		}
		const elidedPart = elided > 0 ? `${describeElideRescue(elided, elidedTokens, elideSink)} and ` : "";
		if (signal.aborted) return false;
		let imagesDropped = 0;
		try {
			imagesDropped = (await this.#session.dropImages()).removed;
		} catch (error) {
			logger.warn("Dead-end image-drop rescue failed", {
				error: errorMessage(error),
			});
		}
		if (imagesDropped > 0 && hasProgress()) {
			this.#session.emitNotice(
				"info",
				`Compaction dead-end recovery: ${elidedPart}dropped ${formatCount("attached image", imagesDropped)} so maintenance could make progress.`,
				"compaction",
			);
			return true;
		}
		if (signal.aborted) return false;
		const truncated = await this.#truncateOversizedTail(options.bar, target);
		if (truncated.texts > 0 && hasProgress()) {
			const imagePart = imagesDropped > 0 ? `dropped ${formatCount("attached image", imagesDropped)} and ` : "";
			this.#session.emitNotice(
				"info",
				`Compaction dead-end recovery: ${elidedPart}${imagePart}truncated the middle of ${formatCount("oversized message", truncated.texts)} (~${truncated.tokensFreed.toLocaleString()} tokens) to ${truncated.sink} so maintenance could make progress.`,
				"compaction",
			);
			return true;
		}
		return false;
	}

	/**
	 * Cut the middle out of the largest texts in the live tail until the context
	 * is no longer over `bar`, keeping each text's head and tail.
	 *
	 * This is the reducer that cannot be defeated by the shape of what is too
	 * large, and it is deliberately the last one tried: it removes bytes the
	 * model was still reading, which the earlier tiers do not. It removes only
	 * what the bar is exceeded by, largest text first, so a session that is
	 * barely over loses one middle rather than its whole tail.
	 *
	 * The removed bytes go to the same recovery artifact every other shake
	 * region uses, so `artifact://` still holds them, and the placeholder that
	 * replaces each middle says so. Returns zero counts when no single text is
	 * large enough to cut, which is the honest dead end.
	 */
	async #truncateOversizedTail(
		bar: CompactionBar,
		minTokensToFree = 0,
	): Promise<{ texts: number; tokensFreed: number; sink: string }> {
		// The larger of the two budgets: the live context over `bar`, and what the
		// summarization payload is over the widest candidate window. Cutting only
		// to the bar leaves a payload no candidate can summarize.
		const excessTokens = Math.max(this.#compactionExcessTokens(bar), minTokensToFree);
		if (excessTokens <= 0) return { texts: 0, tokensFreed: 0, sink: "placeholders" };
		const branchEntries = this.#session.sessionManager.getBranch();
		const config = this.#host.withPlanProtection({
			...AGGRESSIVE_SHAKE_CONFIG,
			keepBoundaryId: this.#host.promptCompaction(branchEntries)?.firstKeptEntryId,
		});
		const regions = collectOversizedTextRegions(branchEntries, {
			excessTokens,
			keepEdgeTokens: TRUNCATION_KEEP_EDGE_TOKENS,
			minTextTokens: TRUNCATION_MIN_TEXT_TOKENS,
			protectedTools: config.protectedTools,
			keepBoundaryId: config.keepBoundaryId,
		});
		if (regions.length === 0) return { texts: 0, tokensFreed: 0, sink: "placeholders" };
		try {
			const applied = await this.#host.offloadAndApplyShakeRegions(regions);
			return {
				texts: applied.blocksDropped,
				tokensFreed: applied.tokensFreed,
				sink: applied.artifactId ? "an artifact" : "placeholders",
			};
		} catch (error) {
			logger.warn("Dead-end truncation rescue failed", { error: errorMessage(error) });
			return { texts: 0, tokensFreed: 0, sink: "placeholders" };
		}
	}

	/**
	 * Settle an automatic pass that found nothing to summarize.
	 *
	 * That is a dead end only while the context is still over the bar. Once an
	 * earlier pass in this turn created headroom — a rescue tier, a prune, a
	 * dedup — the next threshold check finds nothing left to cut, and warning
	 * there tells the operator to start a fresh session moments after
	 * maintenance succeeded.
	 */
	afterNothingToSummarize(
		reason: AutoCompactionReason,
		generation: number,
		suppressContinuation: boolean,
	): CompactionCheckResult {
		const deadEnd = reason !== "idle" && !this.#compactionMeets("recovery-band");
		const continuationScheduled = this.scheduleAfterCompaction(generation, {
			retry: false,
			autoContinue: false,
			deliverQueued: !suppressContinuation,
		});
		if (deadEnd) {
			this.#session.emitNotice("warning", compactionDeadEndWarning(), "compaction");
		}
		return compactionCheckOutcome(continuationScheduled, deadEnd);
	}

	/**
	 * Whether an automatic pass freed enough for what follows it, running the
	 * provider-free rescue tiers when it did not.
	 *
	 * The summary strategy keeps `keepRecentTokens` of recent history verbatim
	 * and findCutPoint can only cut at turn boundaries (never tool results), so
	 * a single oversized recent turn (e.g. a huge tool result) leaves the
	 * rewritten context still above threshold. Scheduling the continuation
	 * regardless means the next agent_end re-enters #checkCompaction over the
	 * same oversized tail and re-fires forever.
	 *
	 * The retry only needs the rebuilt prompt to fit the window again, measured
	 * AFTER the failed turn is dropped, since the retry prompt will not include
	 * it; reusing the recovery band there turned recoverable overflows into
	 * manual dead-ends (#3412 review). The threshold pass needs the recovery
	 * band, `COMPACTION_RECOVERY_BAND × threshold`: re-firing on a history that
	 * still sits just over the line is the compaction thrash. Even when
	 * auto-continue is disabled, a no-headroom threshold pass must still block
	 * later automatic continuations (todo reminders, session_stop hooks) from
	 * re-entering the same oversized context. A non-idle pass that frees too
	 * little for its path is a dead end, warned once so the pause is explained
	 * instead of looping silently. An idle pass wants neither.
	 */
	async autoCompactionProgress(
		reason: AutoCompactionReason,
		willRetry: boolean,
		signal: AbortSignal,
	): Promise<{ retryFits: boolean; hasHeadroom: boolean; deadEnd: boolean }> {
		if (!willRetry && reason === "idle") return { retryFits: false, hasHeadroom: false, deadEnd: false };
		if (willRetry) this.#dropUnretryableLastTurn(reason);
		const bar: CompactionBar = willRetry ? "fit" : "recovery-band";
		const met =
			this.#compactionMeets(bar) || (await this.#rescueCompactionDeadEnd(signal, { skipElide: false, bar }));
		return { retryFits: willRetry && met, hasHeadroom: !willRetry && met, deadEnd: !met };
	}

	/**
	 * Drop the failed turn before retrying it when it carries no actionable
	 * deliverable: an `error` turn was kept in history but must not re-enter the
	 * next prompt, and an `incomplete` pass's `length` turn is truncated output
	 * (typically reasoning-only) that re-running reproduces.
	 */
	#dropUnretryableLastTurn(reason: AutoCompactionReason): void {
		const messages = this.#session.agent.state.messages;
		const last = messages[messages.length - 1];
		if (last?.role !== "assistant") return;
		const { stopReason } = last as AssistantMessage;
		if (stopReason !== "error" && !(reason === "incomplete" && stopReason === "length")) return;
		this.#session.agent.replaceMessages(messages.slice(0, -1));
		this.#host.rebasePendingContextSnapshotAfterHistoryRewrite();
	}

	/**
	 * Schedule the turn that follows a compaction pass and report whether one was
	 * scheduled: the retry of the turn that overflowed, else the threshold
	 * auto-continue prompt, else delivery of messages queued meanwhile, since
	 * pausing maintenance must not strand what the operator already typed.
	 */
	scheduleAfterCompaction(
		generation: number,
		next: { retry: boolean; autoContinue: boolean; deliverQueued: boolean },
	): boolean {
		if (next.retry) {
			this.#host.scheduleAgentContinue({ delayMs: 100, generation });
			return true;
		}
		if (next.autoContinue) {
			this.#host.scheduleAutoContinuePrompt(generation);
			return true;
		}
		if (!next.deliverQueued || !this.#session.agent.hasQueuedMessages()) return false;
		this.#host.scheduleAgentContinue({
			delayMs: 100,
			generation,
			shouldContinue: () => this.#session.agent.hasQueuedMessages(),
		});
		return true;
	}

	/**
	 * What happens after every candidate model refused to summarize.
	 *
	 * A compaction that threw wrote no summary, so the context is exactly as
	 * large as it was when the pass started. Reporting that as "nothing
	 * happened" is what wedged a session: goal mode, a todo reminder and a
	 * `session_stop` continuation all read the same
	 * {@link CompactionCheckResult}, so a run at zero headroom started another
	 * turn, the provider refused the oversized request, recovery compaction
	 * failed the same way, and the cycle repeated with the elapsed clock
	 * restarting at 0:00 on every pass while the whole history was
	 * re-serialized for each refused summary.
	 *
	 * Two things happen here instead. The provider-free reduction tiers run
	 * first — eliding heavy tool output to an artifact, then dropping attached
	 * images — because they need no model at all and are exactly what a stuck
	 * operator would reach for by hand. When they create room the pass returns
	 * to the ordinary flow, since the next request now fits. When they cannot,
	 * automatic continuation is blocked and the pause is named once, so the
	 * session waits for the operator rather than spinning.
	 *
	 * An `idle` pass keeps returning "nothing happened": it runs on a session
	 * that is not mid-run, has no continuation to block, and a maintenance
	 * failure there costs the operator nothing.
	 */
	async afterFailedCompaction(
		reason: AutoCompactionReason,
		willRetry: boolean,
		signal: AbortSignal,
		generation: number,
		options: { suppressContinuation: boolean; shouldAutoContinue: boolean; payloadGapTokens: number | undefined },
	): Promise<CompactionCheckResult> {
		if (reason === "idle" || signal.aborted) return COMPACTION_CHECK_NONE;
		// The retry side only needs the rebuilt prompt to fit the window; the
		// threshold side needs the recovery band, exactly as the success tail
		// measures them.
		//
		// A payload larger than every candidate window is a third condition
		// neither bar states: no candidate ran, so the live context can already
		// meet its bar while no summary is possible. Meeting the bar is therefore
		// not enough to call this rescued — the rescue must also free the gap, or
		// the scheduled retry rebuilds the same oversized payload and parks again.
		const bar: CompactionBar = willRetry ? "fit" : "recovery-band";
		const gap = options.payloadGapTokens;
		const minTokensToFree = gap !== undefined && Number.isFinite(gap) && gap > 0 ? gap : undefined;
		const rescued =
			(minTokensToFree === undefined && this.#compactionMeets(bar)) ||
			(await this.#rescueCompactionDeadEnd(signal, { skipElide: false, bar, minTokensToFree }));
		if (rescued) {
			return {
				continuationScheduled: this.scheduleAfterCompaction(generation, {
					retry: willRetry,
					autoContinue: options.shouldAutoContinue,
					deliverQueued: !options.suppressContinuation,
				}),
				historyRewritten: true,
			};
		}
		const continuationScheduled = this.scheduleAfterCompaction(generation, {
			retry: false,
			autoContinue: false,
			deliverQueued: !options.suppressContinuation,
		});
		this.#session.emitNotice("warning", compactionDeadEndWarning(), "compaction");
		return compactionCheckOutcome(continuationScheduled, true);
	}
}
