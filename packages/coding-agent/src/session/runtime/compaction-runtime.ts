/**
 * The compaction engine of a session: manual `/compact`, the automatic pass that the threshold,
 * overflow, incomplete and idle triggers run, the port of a server-side compaction another provider
 * minted, and the record a pass writes.
 *
 * This is a session collaborator. It holds the abort controllers `isCompacting` reads and the
 * threshold notice already announced, and reaches the session through {@link CompactionSession} and
 * {@link CompactionHost}. The summary request is `CompactionSummarizer`'s and what follows a pass
 * (the bar, the dead-end rescue tiers, the next turn) is `CompactionRecovery`'s. What triggers a pass
 * (the post-turn check, the pre-prompt and mid-run checks, context promotion) stays with the session.
 */
import { resolveTelemetry } from "@veyyon/agent-core";
import {
	assertValidCompactionResult,
	CompactionCancelledError,
	type CompactionPreparation,
	type CompactionResult,
	type CompactionSettings,
	DEFAULT_RESERVE_TOKENS,
	formatCompactionThreshold,
	getRemoteCompactionPreserveData,
	prepareCompaction,
	remoteCompactionReplayableBy,
	renderTailElisionArtifact,
	renderTailElisionMarker,
	resolveThresholdWithOrigin,
	rollbackTailElisions,
	stripRemoteCompactionPreserveData,
	summarizeRemoteCompactionWindow,
} from "@veyyon/agent-core/compaction";
import type { CodexCompactionContext, ToolResultMessage } from "@veyyon/ai";
import { resetOpenAICodexHistoryAfterCompaction } from "@veyyon/ai/providers/openai-codex/session-state";
import {
	COMPACTION_CHECK_NONE,
	type CompactionCheckResult,
	compactionDeadEndWarning,
	createCodexCompactionContext,
	declaredContextWindow,
	mergeLlmCompactionPreserveData,
} from "@veyyon/kernel/session/agent-session-compaction-policy";
import { findCompactMode } from "@veyyon/kernel/session/compact-modes";
import { getLatestCompactionEntry, type SessionContext } from "@veyyon/kernel/session/session-context";
import type { CompactionEntry, SessionEntry } from "@veyyon/kernel/session/session-entries";
import { errorMessage, isAbortError, logger } from "@veyyon/utils";
import {
	type CompactionEngineAction,
	resolveCompactionEngineAction,
	toAgentCompactionSettings,
} from "../../config/compaction-strategy";
import type { SessionBeforeCompactResult } from "../../extensibility/extensions";
import type { CompactOptions } from "../../extensibility/extensions/types";
import type { GoalAbortReason } from "../../goals/state";
import { compactionModelCandidates } from "../agent-session-model-targets";
import type { AgentSessionEvent } from "../agent-session-types";
import {
	type AutoCompactionReason,
	CompactionRecovery,
	type CompactionRecoveryHost,
	type CompactionRecoverySession,
	compactionCheckOutcome,
} from "./compaction-recovery";
import {
	CompactionSummarizer,
	type CompactionSummarizerHost,
	type CompactionSummarizerSession,
} from "./compaction-summarizer";

/** What {@link CompactionRuntime} reads from the session's public surface. */
export interface CompactionSession extends CompactionSummarizerSession, CompactionRecoverySession {
	dedupeRedundantToolResults(): Promise<{ toolResultsDropped: number; tokensFreed: number; artifactId?: string }>;
	buildDisplaySessionContext(): SessionContext;
	abort(options?: { goalReason?: GoalAbortReason; reason?: string; preserveCompaction?: boolean }): Promise<void>;
}

/** What {@link CompactionRuntime} needs from the session beyond its public surface. */
export interface CompactionHost extends CompactionSummarizerHost, CompactionRecoveryHost {
	emitSessionEvent(event: AgentSessionEvent): Promise<void>;
	/** The prompt cycle now running; an abort advances it. */
	promptGeneration(): number;
	/** Tokens the system prompt and the tool catalog add to every request. */
	nonMessageTokens(): number;
	resetAllAdvisorRuntimes(): void;
	/** Rebuild what was read from the replaced history: the plan reference, the advisors and the todo list. */
	afterHistoryCompacted(): void;
	closeCodexProviderSessionsForHistoryRewrite(): void;
	/** Stop routing agent events to the session for the length of a manual compaction. */
	disconnectFromAgent(): void;
	reconnectToAgent(): void;
}

/** The fields a compaction entry records, taken from a hook's or a summarizer's result. */
function compactionRecord(
	source: Pick<CompactionResult, "summary" | "shortSummary" | "firstKeptEntryId" | "tokensBefore" | "details">,
	preserveData: Record<string, unknown> | undefined,
): CompactionResult {
	return {
		summary: source.summary,
		shortSummary: source.shortSummary,
		firstKeptEntryId: source.firstKeptEntryId,
		tokensBefore: source.tokensBefore,
		details: source.details,
		preserveData,
	};
}

export class CompactionRuntime {
	readonly #session: CompactionSession;
	readonly #host: CompactionHost;
	/** The manual `/compact` in flight; `isCompacting` reads it. */
	#compactionAbortController: AbortController | undefined = undefined;
	/** The automatic pass in flight, including a provider-switch port. */
	#autoCompactionAbortController: AbortController | undefined = undefined;

	// Context window we last reported a surprising compaction threshold for — a
	// capped absolute amount, a value still coming from a retired key, or an
	// unparseable value. Warned once per distinct window (re-warns after a model
	// switch to a smaller window), so the operator's configured amount is never
	// silently reinterpreted. See #noticeCompactionThresholdClamp.
	#compactionClampNoticeWindow: number | undefined = undefined;
	readonly #summarizer: CompactionSummarizer;
	readonly #recovery: CompactionRecovery;

	constructor(session: CompactionSession, host: CompactionHost) {
		this.#session = session;
		this.#host = host;
		this.#summarizer = new CompactionSummarizer(session, host);
		this.#recovery = new CompactionRecovery(session, host);
	}

	/** Whether a manual or automatic compaction is running. */
	get isCompacting(): boolean {
		return this.#autoCompactionAbortController !== undefined || this.#compactionAbortController !== undefined;
	}

	/** Cancel the manual and the automatic compaction in flight. */
	abort(): void {
		this.#compactionAbortController?.abort();
		this.#autoCompactionAbortController?.abort();
	}

	/** Cancel only the automatic compaction in flight, leaving a starting manual one running. */
	abortAutomatic(): void {
		this.#autoCompactionAbortController?.abort();
	}

	/**
	 * Manually compact the session context.
	 * Aborts current agent operation first.
	 * @param customInstructions Optional instructions for the compaction summary
	 * @param options Optional callbacks for completion/error handling
	 */
	async compact(customInstructions?: string, options?: CompactOptions): Promise<CompactionResult> {
		if (this.#compactionAbortController) {
			throw new Error("Compaction already in progress");
		}
		// Resolve the `/compact <mode>` subcommand up front so input validation
		// runs before we disconnect/abort the active agent operation below.
		const compactMode = options?.mode ? findCompactMode(options.mode) : undefined;
		const compactionAbortController = new AbortController();
		this.#compactionAbortController = compactionAbortController;

		// Hoisted so the catch can roll the preparation's tail elisions back:
		// prepareCompaction applies them to the live branch as a side effect.
		let preparation: CompactionPreparation | undefined;

		try {
			this.#host.disconnectFromAgent();
			await this.#session.abort({ goalReason: "internal", preserveCompaction: true });
			if (!this.#session.model) {
				throw new Error(
					"No model selected, so compaction has nothing to summarize with. Fix: in an interactive veyyon session run /model to choose one; from a terminal pass `--model <provider>/<id>`, or set `compaction.model` so compaction uses its own model regardless of the session's.",
				);
			}

			const compactionSettings = this.#session.settings.getGroup("compaction");
			// The optional `/compact summary` token resolves before this point and
			// pins the sole strategy for this invocation.
			const effectiveSettings = compactMode
				? { ...compactionSettings, ...compactMode.overrides }
				: compactionSettings;
			const availableModels = this.#session.modelRegistry.getAvailable();
			const compactionCandidates = compactionModelCandidates(
				this.#session.settings,
				this.#session.model,
				availableModels,
			);
			const pathEntries = this.#session.sessionManager.getBranch();
			preparation = prepareCompaction(pathEntries, toAgentCompactionSettings(effectiveSettings), {
				nonMessageTokens: this.#host.nonMessageTokens(),
				contextWindow: declaredContextWindow(this.#session.model),
			});
			if (!preparation) {
				// Check why we can't compact
				const lastEntry = pathEntries[pathEntries.length - 1];
				if (lastEntry?.type === "compaction") {
					throw new Error("Already compacted");
				}
				// The window being full and this returning nothing were once the
				// same state, and the sentence below was a lie in it. The cut-point
				// budget is now capped by what the window can hold, so a full
				// window always produces a cut and only a genuinely small session
				// reaches here. Do not restore a second message for the other case
				// without first restoring a way to get into it.
				throw new Error("Nothing to compact (session too small)");
			}

			const beforeCompact = await this.#emitBeforeCompact(
				preparation,
				pathEntries,
				customInstructions,
				compactionAbortController.signal,
			);
			if (beforeCompact?.cancel) {
				throw new CompactionCancelledError();
			}
			const hookCompaction = beforeCompact?.compaction || undefined;
			const compactionPrep = await this.#summarizer.prepareCompactionFromHooks(preparation, hookCompaction);

			let compactionResult: CompactionResult;
			let codexCompaction: CodexCompactionContext | undefined;

			if (compactionPrep.kind === "fromHook") {
				compactionResult = compactionRecord(compactionPrep, compactionPrep.preserveData);
			} else {
				codexCompaction = createCodexCompactionContext({
					trigger: "manual",
					reason: "user_requested",
					phase: "standalone_turn",
				});
				// Generate compaction result. Only convert known abort-shaped
				// rejections (AbortError raised while the abort signal is set,
				// or an already-typed sentinel) into `CompactionCancelledError`
				// so downstream callers can discriminate cancel from generic
				// failure via `instanceof` without inspecting message strings.
				// Real compaction bugs (network, server, parsing, etc.) keep
				// their original shape — they must not be silently relabeled
				// as cancellations even if the signal happens to be aborted
				// for an unrelated reason. The assignment lives inside the try
				// block because every catch path throws — the post-try read
				// of the result is reachable only on success.
				try {
					const result = await this.#summarizer.summarizeManual(
						preparation,
						options?.internalGuidance ?? customInstructions,
						compactionPrep,
						codexCompaction,
						compactionCandidates,
						compactionAbortController.signal,
					);
					compactionResult = compactionRecord(
						result,
						mergeLlmCompactionPreserveData(compactionPrep.preserveData, result.preserveData),
					);
				} catch (err) {
					if (err instanceof CompactionCancelledError) {
						throw err;
					}
					if (compactionAbortController.signal.aborted && isAbortError(err)) {
						throw new CompactionCancelledError();
					}
					throw err;
				}
			}

			if (compactionAbortController.signal.aborted) {
				throw new CompactionCancelledError();
			}

			await this.#applyCompaction(preparation, compactionResult, hookCompaction !== undefined, codexCompaction);
			options?.onComplete?.(compactionResult);
			return compactionResult;
		} catch (error) {
			this.#rollbackCompactionTailElisions(preparation);
			const err = error instanceof Error ? error : new Error(errorMessage(error));
			options?.onError?.(err);
			throw error;
		} finally {
			if (this.#compactionAbortController === compactionAbortController) {
				this.#compactionAbortController = undefined;
			}
			this.#host.reconnectToAgent();
		}
	}

	/**
	 * Replace a server-side compaction the active provider cannot read with a
	 * summary it can, before the next prompt is built on it.
	 *
	 * The newest compaction on the branch can hold a window only another provider
	 * can decrypt: the session switched providers, resumed onto a different one, or
	 * a compaction started on the old model landed after the switch. The rebuild
	 * then falls back to the newest readable compaction and re-expands everything
	 * since it, which on a long session is more than any context window holds. The
	 * provider that minted the window can still read it, so one request to that
	 * provider turns the window into summary text, appended as a local compaction
	 * with the same keep marker. When that provider is unavailable the fallback
	 * stands, and the next compaction on the active provider summarizes the span.
	 */
	async portUnreadableRemoteCompaction(): Promise<boolean> {
		const model = this.#session.model;
		if (!model || this.isCompacting) return false;
		const entry = getLatestCompactionEntry(this.#session.sessionManager.getBranch());
		const remote = entry ? getRemoteCompactionPreserveData(entry.preserveData) : undefined;
		if (!entry || !remote || remoteCompactionReplayableBy(entry.preserveData, model.provider)) return false;
		const source = this.#session.modelRegistry.find(remote.provider, remote.model);
		const apiKey = source ? await this.#session.modelRegistry.getApiKey(source, this.#session.sessionId) : undefined;
		if (!source || !apiKey) {
			logger.warn("Server-side compaction cannot be ported: the model that minted it is unavailable", {
				compactionId: entry.id,
				mintedBy: `${remote.provider}/${remote.model}`,
				activeProvider: model.provider,
			});
			return false;
		}

		const compactionSettings = this.#session.settings.getGroup("compaction");
		const action = resolveCompactionEngineAction(compactionSettings.strategy);
		const controller = new AbortController();
		this.#autoCompactionAbortController = controller;
		try {
			await this.#host.emitSessionEvent({ type: "auto_compaction_start", reason: "provider_switch", action });
			const summary = await summarizeRemoteCompactionWindow(
				entry,
				source,
				compactionSettings.reserveTokens ?? DEFAULT_RESERVE_TOKENS,
				apiKey,
				controller.signal,
				{
					sessionSystemPrompt: this.#host.baseSystemPrompt(),
					metadata: this.#session.agent.metadataForProvider(source.provider),
					initiatorOverride: "agent",
					telemetry: resolveTelemetry(this.#session.agent.telemetry, this.#session.sessionId),
					thinkingLevel: this.#session.thinkingLevel,
					sessionId: this.#session.sessionId,
					obfuscateProviderText: text => this.#session.obfuscateProviderText(text),
					completeImpl: this.#session.sideComplete,
					serviceTier: this.#host.effectiveServiceTier(source),
				},
			);
			if (controller.signal.aborted) throw new CompactionCancelledError();
			const preserveData = stripRemoteCompactionPreserveData(entry.preserveData);
			this.#session.sessionManager.appendCompaction(
				summary,
				undefined,
				entry.firstKeptEntryId,
				entry.tokensBefore,
				entry.details,
				false,
				preserveData,
			);
			this.#session.sessionManager.coolCompactedHistory();
			this.#session.agent.replaceMessages(this.#session.buildDisplaySessionContext().messages);
			this.#host.resetAllAdvisorRuntimes();
			this.#host.rebasePendingContextSnapshotAfterHistoryRewrite();
			await this.#host.emitSessionEvent({
				type: "auto_compaction_end",
				action,
				result: {
					summary,
					firstKeptEntryId: entry.firstKeptEntryId,
					tokensBefore: entry.tokensBefore,
					details: entry.details,
					preserveData,
				},
				aborted: false,
				willRetry: false,
			});
			return true;
		} catch (error) {
			const aborted = controller.signal.aborted || error instanceof CompactionCancelledError;
			logger.warn("Porting a server-side compaction to the active provider failed", {
				compactionId: entry.id,
				mintedBy: `${remote.provider}/${remote.model}`,
				activeProvider: model.provider,
				aborted,
				error: errorMessage(error),
			});
			await this.#host.emitSessionEvent({
				type: "auto_compaction_end",
				action,
				result: undefined,
				aborted,
				willRetry: false,
				errorMessage: aborted
					? undefined
					: `Could not summarize the ${remote.provider} compaction for ${model.provider}: ${errorMessage(error)}`,
			});
			return false;
		} finally {
			if (this.#autoCompactionAbortController === controller) this.#autoCompactionAbortController = undefined;
		}
	}

	/**
	 * Report anything surprising about the resolved compaction threshold, once per
	 * distinct context window (so a switch to a smaller-window model re-warns).
	 *
	 * Three surprises are worth an operator's attention, and all three used to be
	 * invisible: an absolute amount capped for this model's window, a value still
	 * coming from one of the two retired keys rather than `compaction.threshold`,
	 * and a value that parsed as nothing and therefore fell back to auto.
	 */
	noticeCompactionThresholdClamp(contextWindow: number, compactionSettings: CompactionSettings): void {
		const resolved = resolveThresholdWithOrigin(contextWindow, compactionSettings);
		const surprising = resolved.clamped || resolved.legacyKey !== undefined || resolved.invalidRaw !== undefined;
		if (!surprising) return;
		if (this.#compactionClampNoticeWindow === contextWindow) return;
		this.#compactionClampNoticeWindow = contextWindow;

		if (resolved.invalidRaw !== undefined) {
			this.#session.emitNotice(
				"warning",
				`compaction.threshold is set to "${resolved.invalidRaw}", which is not auto, a percent (85%), or a token amount (170000); compacting at ${formatCompactionThreshold(resolved, contextWindow)} instead. Set a valid value in /settings -> Model -> Auto-Compaction Threshold.`,
				"compaction",
			);
			return;
		}

		if (resolved.origin === "tokens" && resolved.clamped) {
			// Informational, not a warning: the amount is a legal model-independent
			// choice, and this model simply cannot reach it. Telling the operator to
			// "lower the amount" would be advice against a setting that is doing
			// exactly what its picker promises on every larger model.
			this.#session.emitNotice(
				"info",
				`The compaction threshold (${resolved.configured} tokens) is more than a ${contextWindow}-token model can reach, so this session compacts at ${formatCompactionThreshold(resolved, contextWindow)}. A model with a larger window uses the full amount.`,
				"compaction",
			);
			return;
		}

		if (resolved.legacyKey !== undefined) {
			this.#session.emitNotice(
				"info",
				`Compaction is triggering at ${formatCompactionThreshold(resolved, contextWindow)}, taken from the retired compaction.${resolved.legacyKey} setting. Re-pick it in /settings -> Model -> Auto-Compaction Threshold to move it to compaction.threshold.`,
				"compaction",
			);
		}
	}

	/**
	 * Persist a compaction's tail elisions. `prepareCompaction` replaces
	 * over-budget tool-result bulk in the kept tail with markers on the live
	 * branch; this offloads the originals to one recovery artifact, points the
	 * markers at it, and rewrites the session file so the bounded tail — not
	 * the pre-elision bulk — is what a resume rebuilds. A failed offload still
	 * rewrites: the elision is the bound, the artifact is only the pointer.
	 */
	async #persistCompactionTailElisions(preparation: CompactionPreparation): Promise<void> {
		const elisions = preparation.tailElisions ?? [];
		if (elisions.length === 0) return;
		let artifactId: string | undefined;
		try {
			artifactId = await this.#session.sessionManager.saveArtifact(
				renderTailElisionArtifact(elisions),
				"compaction-tail",
			);
		} catch (error) {
			logger.warn("Failed to persist compaction tail elision artifact", {
				error: errorMessage(error),
				elisionCount: elisions.length,
			});
			artifactId = undefined;
		}
		const updated: SessionEntry[] = [];
		for (const elision of elisions) {
			// `prepareCompaction` already replaced this entry's message, so it is
			// updated whether or not the pointer below lands.
			const entry = this.#session.sessionManager.getEntry(elision.entryId);
			if (!entry) continue;
			updated.push(entry);
			if (!artifactId || entry.type !== "message" || entry.message !== elision.message) continue;
			// A NEW message object, never an in-place content patch:
			// estimateTokens caches by message identity, so mutating the
			// marker would leave every later estimate at the pre-pointer
			// size (same replace-not-mutate rule the elision producer
			// follows).
			const pointed: ToolResultMessage = {
				...elision.message,
				content: [{ type: "text", text: renderTailElisionMarker(elision.toolName, elision.tokens, artifactId) }],
			};
			entry.message = pointed;
			elision.message = pointed;
		}
		await this.#session.sessionManager.rewriteEntries(updated);
	}

	/**
	 * Restore the originals a failed compaction elided from the kept tail.
	 * `prepareCompaction` swaps them for pointerless markers as a side effect
	 * of preparing, and until `#persistCompactionTailElisions` runs the
	 * preparation holds the only copy of the bytes — so every failure path
	 * between the two must put them back, or the branch keeps a dead marker
	 * (`prunedAt` blocks re-elision, the next summarizer sees marker text)
	 * and the next rewriteEntries persists it over the last copy of the
	 * output.
	 */
	#rollbackCompactionTailElisions(preparation: CompactionPreparation | undefined): void {
		const elisions = preparation?.tailElisions;
		if (!elisions || elisions.length === 0) return;
		rollbackTailElisions(this.#session.sessionManager.getBranch(), elisions);
	}

	/**
	 * Internal: run automatic in-place compaction with lifecycle events.
	 *
	 * @returns whether auto-compaction scheduled a follow-up turn.
	 */
	async runAutoCompaction(
		reason: AutoCompactionReason,
		willRetry: boolean,
		options: {
			autoContinue?: boolean;
			triggerContextTokens?: number;
			suppressContinuation?: boolean;
			phase?: CodexCompactionContext["phase"];
		} = {},
	): Promise<CompactionCheckResult> {
		const compactionSettings = this.#session.settings.getGroup("compaction");
		// Idle compaction has its own gate; `compaction.enabled` governs the rest.
		if (reason !== "idle" && !compactionSettings.enabled) return COMPACTION_CHECK_NONE;
		const generation = this.#host.promptGeneration();
		this.#summarizer.forgetPayloadGap();
		const suppressContinuation = options.suppressContinuation === true;
		const shouldAutoContinue =
			!suppressContinuation && options.autoContinue !== false && compactionSettings.autoContinue !== false;
		// Tier-0 lossless pass, ahead of every strategy. Before an LLM compaction
		// ever touches history under pressure, drop
		// tool-results that are byte-identical to a newer copy (a re-read of an
		// unchanged file, a re-run of the same command). This is recall-preserving
		// (the newest copy stays live; elided copies recover via the offload
		// artifact) and LLM-free, so it costs nothing to run first and shrinks
		// whatever the strategy dispatch below has to process. Skipped for `idle`,
		// which runs its own scheduling and is not a pressure trigger. When the
		// dedup alone brings a `threshold` trigger back under the bar, the whole
		// compaction is unnecessary — return early and keep the un-compacted
		// (merely deduped) history. `overflow`/`incomplete` are recovery paths the
		// caller needs fully resolved, so they always fall through to the body.
		if (reason !== "idle") {
			const deduped = await this.#session.dedupeRedundantToolResults();
			if (deduped.toolResultsDropped > 0) {
				if (this.#host.promptGeneration() !== generation) return COMPACTION_CHECK_NONE;
				if (reason === "threshold" && !this.#recovery.thresholdStillTrips(compactionSettings)) {
					return COMPACTION_CHECK_NONE;
				}
			}
		}
		const action = resolveCompactionEngineAction(compactionSettings.strategy);
		// Abort any older auto-compaction before installing this run's controller.
		this.#autoCompactionAbortController?.abort();
		const autoCompactionAbortController = new AbortController();
		this.#autoCompactionAbortController = autoCompactionAbortController;
		const autoCompactionSignal = autoCompactionAbortController.signal;

		// Hoisted so failure paths can roll the preparation's tail elisions
		// back: prepareCompaction applies them to the live branch as a side
		// effect.
		let preparation: CompactionPreparation | undefined;

		try {
			// Emit start after the controller is installed so isCompacting is already true
			// for any listener and for input routed during this emit's event-loop yield.
			// A message typed as the compaction loader appears must land in the compaction
			// queue, not the core steering queue.
			await this.#host.emitSessionEvent({ type: "auto_compaction_start", reason, action });

			const availableModels = this.#session.model ? this.#session.modelRegistry.getAvailable() : [];
			if (!this.#session.model || availableModels.length === 0) {
				await this.#emitEmptyAutoCompactionEnd(action, "skipped");
				return COMPACTION_CHECK_NONE;
			}

			const pathEntries = this.#session.sessionManager.getBranch();

			preparation = prepareCompaction(pathEntries, toAgentCompactionSettings(compactionSettings), {
				nonMessageTokens: this.#host.nonMessageTokens(),
				contextWindow: declaredContextWindow(this.#session.model),
			});
			if (!preparation) {
				await this.#emitEmptyAutoCompactionEnd(action, "skipped");
				return this.#recovery.afterNothingToSummarize(reason, generation, suppressContinuation);
			}

			const beforeCompact = await this.#emitBeforeCompact(preparation, pathEntries, undefined, autoCompactionSignal);
			if (beforeCompact?.cancel) {
				this.#rollbackCompactionTailElisions(preparation);
				await this.#emitEmptyAutoCompactionEnd(action, "aborted");
				return COMPACTION_CHECK_NONE;
			}
			const hookCompaction = beforeCompact?.compaction || undefined;
			const compactionPrep = await this.#summarizer.prepareCompactionFromHooks(preparation, hookCompaction);

			let result: CompactionResult;
			let codexCompaction: CodexCompactionContext | undefined;
			if (compactionPrep.kind === "fromHook") {
				result = compactionRecord(compactionPrep, compactionPrep.preserveData);
			} else {
				codexCompaction = createCodexCompactionContext({
					trigger: "auto",
					reason: "context_limit",
					phase:
						options.phase ??
						(reason === "threshold" ? "pre_turn" : reason === "idle" ? "standalone_turn" : "mid_turn"),
				});
				const compacted = await this.#summarizer.summarizeForAutoCompaction(
					preparation,
					compactionPrep,
					codexCompaction,
					availableModels,
					autoCompactionSignal,
				);
				result = compactionRecord(
					compacted,
					mergeLlmCompactionPreserveData(compactionPrep.preserveData, compacted.preserveData),
				);
			}

			if (autoCompactionSignal.aborted) {
				this.#rollbackCompactionTailElisions(preparation);
				await this.#emitEmptyAutoCompactionEnd(action, "aborted");
				return COMPACTION_CHECK_NONE;
			}

			const savedCompactionEntry = await this.#applyCompaction(
				preparation,
				result,
				hookCompaction !== undefined,
				codexCompaction,
			);
			// Evaluated BEFORE emitting auto_compaction_end so the TUI rebuild
			// triggered by that event already reflects any rescue rewrite (elide /
			// image-drop) and the dead-end warning stamped on the compaction entry.
			const progress = await this.#recovery.autoCompactionProgress(reason, willRetry, autoCompactionSignal);
			const deadEndWarning = progress.deadEnd ? compactionDeadEndWarning() : undefined;
			if (deadEndWarning && savedCompactionEntry) {
				// Stamp the divider: the compaction bar badges the dead-end and
				// carries the full warning in its ctrl+o detail, so the pause
				// stays explained even after the notice row scrolls away.
				savedCompactionEntry.warning = deadEndWarning;
				await this.#session.sessionManager.rewriteEntries([savedCompactionEntry]);
			}

			await this.#host.emitSessionEvent({ type: "auto_compaction_end", action, result, aborted: false, willRetry });

			const continuationScheduled = this.#recovery.scheduleAfterCompaction(generation, {
				retry: progress.retryFits,
				autoContinue: progress.hasHeadroom && shouldAutoContinue,
				deliverQueued: !suppressContinuation,
			});
			if (deadEndWarning) {
				this.#session.emitNotice("warning", deadEndWarning, "compaction");
			}
			return compactionCheckOutcome(continuationScheduled, progress.deadEnd);
		} catch (error) {
			this.#rollbackCompactionTailElisions(preparation);
			if (autoCompactionSignal.aborted) {
				await this.#emitEmptyAutoCompactionEnd(action, "aborted");
				return COMPACTION_CHECK_NONE;
			}
			// Shadowing the `errorMessage` helper with a local also discarded what it
			// is for: a rejection that is not an `Error` (a string, a provider payload)
			// reported the literal "compaction failed" and stated no cause at all.
			const failure = errorMessage(error);
			await this.#host.emitSessionEvent({
				type: "auto_compaction_end",
				action,
				result: undefined,
				aborted: false,
				willRetry: false,
				errorMessage:
					reason === "overflow"
						? `Context overflow recovery failed: ${failure}`
						: reason === "incomplete"
							? `Incomplete response recovery failed: ${failure}`
							: `Auto-compaction failed: ${failure}`,
			});
			return await this.#recovery.afterFailedCompaction(reason, willRetry, autoCompactionSignal, generation, {
				suppressContinuation,
				shouldAutoContinue,
				payloadGapTokens: this.#summarizer.payloadGapTokens,
			});
		} finally {
			if (this.#autoCompactionAbortController === autoCompactionAbortController) {
				this.#autoCompactionAbortController = undefined;
			}
		}
	}

	/** End an automatic pass that wrote nothing: skipped before it began, or aborted. */
	#emitEmptyAutoCompactionEnd(action: CompactionEngineAction, outcome: "skipped" | "aborted"): Promise<void> {
		return this.#host.emitSessionEvent(
			outcome === "skipped"
				? {
						type: "auto_compaction_end",
						action,
						result: undefined,
						aborted: false,
						willRetry: false,
						skipped: true,
					}
				: { type: "auto_compaction_end", action, result: undefined, aborted: true, willRetry: false },
		);
	}

	/** Offer a compaction to `session_before_compact` handlers, which may cancel it or supply its summary. */
	async #emitBeforeCompact(
		preparation: CompactionPreparation,
		branchEntries: SessionEntry[],
		customInstructions: string | undefined,
		signal: AbortSignal,
	): Promise<SessionBeforeCompactResult | undefined> {
		if (!this.#session.extensionRunner?.hasHandlers("session_before_compact")) return undefined;
		return (await this.#session.extensionRunner.emit({
			type: "session_before_compact",
			preparation,
			branchEntries,
			customInstructions,
			signal,
		})) as SessionBeforeCompactResult | undefined;
	}

	/**
	 * Record a compaction and rebuild everything that read the history it replaced.
	 *
	 * Returns the written entry, which `session_compact` handlers receive and a dead-end warning is
	 * stamped on. It is looked up by the id the append returned: a server-side compaction records an
	 * empty summary, so matching on summary text found the session's first such entry instead.
	 */
	async #applyCompaction(
		preparation: CompactionPreparation,
		result: CompactionResult,
		fromExtension: boolean,
		codexCompaction: CodexCompactionContext | undefined,
	): Promise<CompactionEntry | undefined> {
		assertValidCompactionResult(preparation, result);
		const entryId = this.#session.sessionManager.appendCompaction(
			result.summary,
			result.shortSummary,
			result.firstKeptEntryId,
			result.tokensBefore,
			result.details,
			fromExtension,
			result.preserveData,
		);
		await this.#persistCompactionTailElisions(preparation);
		this.#session.sessionManager.coolCompactedHistory();
		this.#session.agent.replaceMessages(this.#session.buildDisplaySessionContext().messages);
		this.#host.rebasePendingContextSnapshotAfterHistoryRewrite();
		this.#host.afterHistoryCompacted();
		if (codexCompaction) {
			this.#resetCodexProviderAfterCompaction(codexCompaction);
		} else {
			this.#host.closeCodexProviderSessionsForHistoryRewrite();
		}

		const entry = this.#session.sessionManager.getEntry(entryId);
		const savedCompactionEntry = entry?.type === "compaction" ? entry : undefined;
		if (this.#session.extensionRunner && savedCompactionEntry) {
			await this.#session.extensionRunner.emit({
				type: "session_compact",
				compactionEntry: savedCompactionEntry,
				fromExtension,
			});
		}
		return savedCompactionEntry;
	}

	#resetCodexProviderAfterCompaction(compaction: CodexCompactionContext): void {
		resetOpenAICodexHistoryAfterCompaction({
			providerSessionState: this.#host.providerSessionState(),
			sessionId: this.#session.sessionId,
			compaction,
		});
	}
}
