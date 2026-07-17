import { scheduler } from "node:timers/promises";
import {
	type Agent,
	type AgentMessage,
	type AgentTurnEndContext,
	resolveTelemetry,
	type StreamFn,
	type ThinkingLevel,
} from "@veyyon/pi-agent-core";
import {
	AUTO_HANDOFF_THRESHOLD_FOCUS,
	CompactionCancelledError,
	type CompactionPreparation,
	type CompactionResult,
	type CompactionSettings,
	calculateContextTokens,
	compact,
	compactionContextTokens,
	createCompactionSummaryMessage,
	DEFAULT_SHAKE_CONFIG,
	effectiveReserveTokens,
	estimateTokens,
	prepareCompaction,
	resolveBudgetReserveTokens,
	resolveThresholdTokens,
	type ShakeConfig,
	type SummaryOptions,
	shouldCompact,
	shouldUseOpenAiRemoteCompaction,
} from "@veyyon/pi-agent-core/compaction";
import {
	DEFAULT_PRUNE_CONFIG,
	pruneSupersededToolResults,
	pruneToolOutputs,
	readToolSupersedeKey,
} from "@veyyon/pi-agent-core/compaction/pruning";
import type { ProtectedToolMatcher } from "@veyyon/pi-agent-core/compaction/tool-protection";
import type { AssistantMessage, CodexCompactionContext, Message, Model, ProviderSessionState } from "@veyyon/pi-ai";
import * as AIError from "@veyyon/pi-ai/error";
import { resetOpenAICodexHistoryAfterCompaction } from "@veyyon/pi-ai/providers/openai-codex-responses";
import { modelsAreEqual } from "@veyyon/pi-catalog/models";
import { logger } from "@veyyon/pi-utils";
import * as snapcompact from "@veyyon/snapcompact";
import {
	isCompactionStrategyOff,
	isThresholdCompactionDisabled,
	normalizeCompactionStrategy,
	resolveCompactionEngineAction,
	toAgentCompactionSettings,
} from "../config/compaction-strategy";
import type { ModelRegistry } from "../config/model-registry";
import {
	getModelMatchPreferences,
	type ResolvedModelRoleValue,
	resolveCompactionModelPatterns,
	resolveModelRoleValue,
} from "../config/model-resolver";
import { SELECTABLE_MODEL_ROLE_IDS } from "../config/model-roles";
import { getDefault, type Settings } from "../config/settings";
import type { ExtensionRunner, SessionBeforeCompactResult } from "../extensibility/extensions";
import type { CompactOptions, ContextUsage } from "../extensibility/extensions/types";
import type { GoalModeState } from "../goals/state";
import type { SecretObfuscator } from "../secrets/obfuscator";
import type { ConfiguredThinkingLevel } from "../thinking";
import type {
	AgentSessionEvent,
	HandoffResult,
	ScheduledAgentContinueOptions,
	SessionHandoffOptions,
} from "./agent-session";
import { createCodexCompactionContext, findCompactMode } from "./compact-modes";
import { convertToLlm, isEmptyErrorTurn } from "./messages";
import { getLatestCompactionEntry, type SessionContext } from "./session-context";
import type { CompactionEntry } from "./session-entries";
import type { SessionManager } from "./session-manager";
import type { ContextUsageBreakdown } from "./session-stats";
import type { ShakeMode, ShakeResult } from "./shake-types";

export type CompactionCheckResult = Readonly<{
	deferredHandoff: boolean;
	continuationScheduled: boolean;
	automaticContinuationBlocked?: boolean;
	historyRewritten?: boolean;
}>;

export const COMPACTION_CHECK_NONE: CompactionCheckResult = {
	deferredHandoff: false,
	continuationScheduled: false,
};

const COMPACTION_CHECK_DEFERRED_HANDOFF: CompactionCheckResult = {
	deferredHandoff: true,
	continuationScheduled: true,
};

const COMPACTION_CHECK_CONTINUATION: CompactionCheckResult = {
	deferredHandoff: false,
	continuationScheduled: true,
};

const COMPACTION_CHECK_BLOCK_AUTOMATIC_CONTINUATION: CompactionCheckResult = {
	deferredHandoff: false,
	continuationScheduled: false,
	automaticContinuationBlocked: true,
};

/**
 * User-facing notice for a compaction dead end: maintenance freed too little
 * to retry safely. `remedies` names the recovery actions left on the emitting
 * path — by the time the post-pass dead end fires, the tiered rescue has
 * already attempted both elide and image-drop automatically.
 */
function compactionDeadEndWarning(remedies: string): string {
	return (
		"Compaction freed too little context to make progress — pausing automatic maintenance to avoid a compaction loop. " +
		`The most recent turn alone is too large to reduce further; ${remedies} or switch to a larger-context model.`
	);
}

/**
 * Per-turn prune cache window. A tool result whose all-message suffix exceeds
 * this is in the warm, already-sent prompt-cache prefix: re-writing it costs the
 * cacheWrite premium on the whole suffix. Per-turn passes only reclaim inside
 * this tail (matches the supersede pass's default `suffixTokenLimit`); deeper
 * stale/age victims are left to compaction/shake, which rebuild the cache anyway.
 */
const PRUNE_CACHE_WARM_SUFFIX_TOKENS = 8_000;

/**
 * Idle gap after which the supersede pass may flush the whole sent region (the
 * provider cache is cold, so re-writing it is free). MUST exceed the maximum
 * Anthropic prompt-cache TTL — "long" retention (the OAuth default) is 1h — or a
 * still-warm prefix is busted by the flush. 90 min leaves margin over the 1h TTL.
 */
const PRUNE_IDLE_FLUSH_MS = 90 * 60_000;

/**
 * Hysteresis band for the post-maintenance "did we actually create headroom?"
 * check shared by the shake tail and the context-full / snapcompact tail. A
 * pass counts as having resolved threshold pressure only when residual context
 * lands at or below `COMPACTION_RECOVERY_BAND × threshold`. Re-checking against
 * the raw threshold lets a pass keep reclaiming a trickle of the previous
 * turn's output and land just under the line every turn, sustaining the
 * auto-continue dead loop reported in #2275; the same band stops the
 * context-full / snapcompact tail from re-firing on a history whose single
 * most-recent kept turn already exceeds the threshold (the snapcompact thrash).
 */
const COMPACTION_RECOVERY_BAND = 0.8;

function mergeLlmCompactionPreserveData(
	hookPreserveData: Record<string, unknown> | undefined,
	resultPreserveData: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
	const preserveData = { ...(hookPreserveData ?? {}), ...(resultPreserveData ?? {}) };
	return snapcompact.stripPreservedArchive(Object.keys(preserveData).length > 0 ? preserveData : undefined);
}

/**
 * Everything the compaction engine reaches on its owning AgentSession. State
 * reads are accessor properties (implemented as getters on the deps literal)
 * so TypeScript control-flow narrowing keeps working across statements;
 * actions are closures over session privates. Turn scheduling, history
 * persistence, obfuscation, and provider-session plumbing stay on the session.
 */
export interface CompactionEngineDeps {
	readonly agent: Agent;
	readonly settings: Settings;
	readonly sessionManager: SessionManager;
	readonly modelRegistry: ModelRegistry;
	readonly providerSessionState: Map<string, ProviderSessionState>;
	readonly model: Model | undefined;
	readonly sessionId: string;
	readonly thinkingLevel: ThinkingLevel | undefined;
	readonly promptGeneration: number;
	readonly isDisposed: boolean;
	readonly isStreaming: boolean;
	readonly isGeneratingHandoff: boolean;
	readonly extensionRunner: ExtensionRunner | undefined;
	readonly obfuscator: SecretObfuscator | undefined;
	readonly baseSystemPrompt: string[];
	readonly goalModeState: GoalModeState | undefined;
	obfuscateText(text: string | undefined): string | undefined;
	sideStream: StreamFn;
	convertToLlmForSideRequest(messages: AgentMessage[]): Message[];
	emitNotice(level: "info" | "warning" | "error", message: string, source?: string): void;
	emitSessionEvent(event: AgentSessionEvent): Promise<void>;
	buildDisplaySessionContext(): SessionContext;
	resetAdvisorRuntimes(): void;
	syncTodoPhasesFromBranch(): void;
	closeCodexProviderSessionsForHistoryRewrite(): void;
	clearPlanReferenceSent(): void;
	rebasePendingContextSnapshot(): void;
	disconnectFromAgent(): void;
	reconnectToAgent(): void;
	abortSession(options?: {
		goalReason?: "interrupted" | "internal";
		reason?: string;
		preserveCompaction?: boolean;
	}): Promise<void>;
	schedulePostPromptTask(
		task: (signal: AbortSignal) => Promise<void>,
		options?: { delayMs?: number; generation?: number },
	): void;
	scheduleAgentContinue(options?: ScheduledAgentContinueOptions): void;
	scheduleAutoContinuePrompt(generation: number): void;
	removeAssistantMessageFromActiveContext(assistantMessage: AssistantMessage): void;
	dropPersistedAssistantTurn(assistantMessage: AssistantMessage): Promise<void>;
	isSameAssistantMessage(left: AssistantMessage, right: AssistantMessage): boolean;
	setModelTemporary(
		model: Model,
		thinkingLevel?: ConfiguredThinkingLevel,
		options?: { ephemeral?: boolean },
	): Promise<void>;
	resolveConfiguredModelTarget(
		configuredTarget: string | undefined,
		currentModel: Model,
		availableModels: Model[],
	): Model | undefined;
	resolveRoleModelFull(
		role: string,
		availableModels: Model[],
		currentModel: Model | undefined,
	): ResolvedModelRoleValue;
	getModelKey(model: Model): string;
	getContextUsage(options?: { contextWindow?: number }): ContextUsage | undefined;
	getContextBreakdown(options?: {
		contextWindow?: number;
		pendingMessages?: AgentMessage[];
	}): ContextUsageBreakdown | undefined;
	computeNonMessageTokens(): number;
	computeStoredMessagesTokens(opts?: { excludeEncryptedReasoning?: boolean }): number;
	withPlanProtection<T extends { protectedTools: ProtectedToolMatcher[] }>(config: T): T;
	parseRetryAfterMsFromError(errorMessage: string): number | undefined;
	shake(mode: ShakeMode, opts?: { config?: ShakeConfig; signal?: AbortSignal }): Promise<ShakeResult>;
	dropImages(): Promise<{ removed: number }>;
	handoff(customInstructions?: string, options?: SessionHandoffOptions): Promise<HandoffResult | undefined>;
	persistTurnMessagesForMidRunCompaction(context: AgentTurnEndContext | undefined): Promise<boolean>;
	collectMemoryBackendContext(preparation: {
		messagesToSummarize: AgentMessage[];
		turnPrefixMessages: AgentMessage[];
	}): Promise<string | undefined>;
}

/**
 * Context maintenance for a session: manual `/compact`, threshold/overflow/idle
 * auto-compaction (LLM summary, snapcompact, shake, and handoff strategies),
 * per-turn stale-result and tool-output pruning, dead-end rescue tiers,
 * headroom/retry-fit progress guards, and context promotion to a larger-window
 * sibling model.
 */
export class CompactionEngine {
	readonly #deps: CompactionEngineDeps;
	#compactionAbortController: AbortController | undefined = undefined;
	#autoCompactionAbortController: AbortController | undefined = undefined;

	constructor(deps: CompactionEngineDeps) {
		this.#deps = deps;
	}

	get isCompacting(): boolean {
		return this.#autoCompactionAbortController !== undefined || this.#compactionAbortController !== undefined;
	}

	/** Cancel any in-progress manual and auto compaction runs. */
	abortAll(): void {
		this.#compactionAbortController?.abort();
		this.#autoCompactionAbortController?.abort();
	}

	/** Cancel only an in-progress auto-compaction run (turn-abort path). */
	abortAutoCompaction(): void {
		this.#autoCompactionAbortController?.abort();
	}

	#obfuscatePreparationForProvider(preparation: CompactionPreparation): CompactionPreparation {
		if (!this.#deps.obfuscator?.hasSecrets()) return preparation;
		const previousSummary = this.#deps.obfuscateText(preparation.previousSummary);
		// `compact()` folds the prior snapcompact archive's plaintext into the
		// summarization prompt on the snapcompact→context-full transition, so the
		// archive's text regions must be redacted alongside the summary. Only the
		// `snapcompact` slot's text is rewritten; every other preserveData key —
		// notably the OpenAI remote-compaction `encrypted_content` replay state — is
		// opaque provider-replay data and stays byte-identical.
		const previousPreserveData = this.#obfuscatePreservedArchiveText(preparation.previousPreserveData);
		if (
			previousSummary === preparation.previousSummary &&
			previousPreserveData === preparation.previousPreserveData
		) {
			return preparation;
		}
		return { ...preparation, previousSummary, previousPreserveData };
	}

	/** Redact secrets in the persisted snapcompact archive's plaintext regions
	 *  ({@link snapcompact.archiveSourceText}'s `text`/`textHead`/`textTail`) so the
	 *  snapcompact→context-full migration in `compact()` cannot ship raw archived
	 *  user/tool text to the provider. Frames and every non-`snapcompact` key pass
	 *  through byte-identical; the same reference is returned when nothing changes. */
	#obfuscatePreservedArchiveText(
		preserveData: Record<string, unknown> | undefined,
	): Record<string, unknown> | undefined {
		const obfuscator = this.#deps.obfuscator;
		if (!obfuscator?.hasSecrets() || !preserveData || !snapcompact.getPreservedArchive(preserveData)) {
			return preserveData;
		}
		const slot = preserveData[snapcompact.PRESERVE_KEY] as Record<string, unknown>;
		const obfuscated: Record<string, unknown> = { ...slot };
		let changed = false;
		for (const key of ["text", "textHead", "textTail"] as const) {
			const value = slot[key];
			if (typeof value !== "string" || value.length === 0) continue;
			const next = obfuscator.obfuscate(value);
			if (next === value) continue;
			obfuscated[key] = next;
			changed = true;
		}
		return changed ? { ...preserveData, [snapcompact.PRESERVE_KEY]: obfuscated } : preserveData;
	}

	async #pruneToolOutputs(): Promise<{ prunedCount: number; tokensSaved: number } | undefined> {
		const branchEntries = this.#deps.sessionManager.getBranch();
		const keepBoundaryId = getLatestCompactionEntry(branchEntries)?.firstKeptEntryId;
		const result = pruneToolOutputs(
			branchEntries,
			this.#deps.withPlanProtection({
				...DEFAULT_PRUNE_CONFIG,
				pruneUseless: this.#deps.settings.getGroup("compaction").dropUseless,
				// Cache-stable boundary: never re-write the warm, already-sent prefix
				// (deep stale/age victims) or summarized-away entries every turn.
				keepBoundaryId,
				cacheWarmSuffixTokens: PRUNE_CACHE_WARM_SUFFIX_TOKENS,
			}),
		);
		if (result.prunedCount === 0) {
			return undefined;
		}

		await this.#deps.sessionManager.rewriteEntries();
		const sessionContext = this.#deps.buildDisplaySessionContext();
		this.#deps.agent.replaceMessages(sessionContext.messages);
		this.#deps.resetAdvisorRuntimes();
		this.#deps.syncTodoPhasesFromBranch();
		this.#deps.closeCodexProviderSessionsForHistoryRewrite();
		return result;
	}

	/**
	 * Per-turn stale-result pass: prune older `read` results that a newer read
	 * of the same file has made stale, plus results their tool flagged
	 * contextually useless. Cache-aware (only fires when the suffix after a
	 * candidate is small or the session has been idle long enough that the
	 * provider prompt cache is cold), so it is cheap to run every turn. Gated
	 * on the `compaction.supersedeReads` and `compaction.dropUseless` settings.
	 *
	 * Persists via `rewriteEntries` like every other history rewrite — the
	 * session file must match the live (pruned) context or file-based forks
	 * (`/fork`, `/tan`) and resume rebuild a divergent prefix and cold-miss the
	 * provider prompt cache.
	 */
	async #pruneStaleToolResults(): Promise<{ prunedCount: number; tokensSaved: number } | undefined> {
		const { supersedeReads, dropUseless } = this.#deps.settings.getGroup("compaction");
		if (!supersedeReads && !dropUseless) return undefined;
		const branchEntries = this.#deps.sessionManager.getBranch();
		const keepBoundaryId = getLatestCompactionEntry(branchEntries)?.firstKeptEntryId;
		const result = pruneSupersededToolResults(
			branchEntries,
			this.#deps.withPlanProtection({
				supersedeKey: supersedeReads ? readToolSupersedeKey : undefined,
				pruneUseless: dropUseless,
				protectedTools: [...DEFAULT_PRUNE_CONFIG.protectedTools],
				// Never re-write summarized-away entries; only flush the whole sent
				// region once the cache is genuinely cold (idle exceeds the 1h TTL).
				keepBoundaryId,
				idleFlushMs: PRUNE_IDLE_FLUSH_MS,
			}),
		);
		if (result.prunedCount === 0) {
			return undefined;
		}

		await this.#deps.sessionManager.rewriteEntries();
		const sessionContext = this.#deps.buildDisplaySessionContext();
		this.#deps.agent.replaceMessages(sessionContext.messages);
		this.#deps.resetAdvisorRuntimes();
		this.#deps.syncTodoPhasesFromBranch();
		this.#deps.closeCodexProviderSessionsForHistoryRewrite();
		return result;
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
		// Modes that produce no LLM summary (snapcompact) have nothing to focus.
		// Reject focus text loudly so programmatic callers don't silently lose
		// instructions (the slash path pre-validates via parseCompactArgs).
		// `internalGuidance` counts the same way — plan-mode approval never
		// combines with a rejects-focus mode, but reject early if a caller ever
		// wires it up so we don't silently drop the directive on the snapcompact
		// fallback (issue #4359).
		if (compactMode?.rejectsFocus && (customInstructions || options?.internalGuidance)) {
			throw new Error(`/compact ${compactMode.name} does not take focus instructions.`);
		}
		const compactionAbortController = new AbortController();
		this.#compactionAbortController = compactionAbortController;

		try {
			this.#deps.disconnectFromAgent();
			await this.#deps.abortSession({ goalReason: "internal", preserveCompaction: true });
			if (!this.#deps.model) {
				throw new Error("No model selected");
			}

			const compactionSettings = this.#deps.settings.getGroup("compaction");
			// The `/compact <mode>` override (resolved above) replaces the configured
			// strategy/remote flags for this one invocation. Merged before
			// prepareCompaction so the remote gating (preparation.settings.
			// remoteEnabled/endpoint) and the snapcompact decision below both see it.
			const effectiveSettings = compactMode
				? { ...compactionSettings, ...compactMode.overrides }
				: compactionSettings;
			// /compact remote demands provider-native compaction. When no remote
			// endpoint is configured (one would override per-model gating in
			// compact()), drop fallback candidates that aren't remote-capable so the
			// engine never silently runs a local summary on a configured-but-non-
			// remote compactionModel. If filtering empties the chain, warn and fall
			// back to the full chain so the operation still completes.
			const availableModels = this.#deps.modelRegistry.getAvailable();
			const requireProviderRemote = Boolean(compactMode?.requiresRemote && !effectiveSettings.remoteEndpoint);
			let compactionCandidates = this.#getCompactionModelCandidates(
				availableModels,
				requireProviderRemote ? shouldUseOpenAiRemoteCompaction : undefined,
			);
			if (requireProviderRemote && compactionCandidates.length === 0) {
				this.#deps.emitNotice(
					"warning",
					`remote compaction is unavailable for ${this.#deps.model.id} (no remote endpoint configured and no provider-native remote-capable model in the fallback chain) — using a local summary instead`,
					"compaction",
				);
				compactionCandidates = this.#getCompactionModelCandidates(availableModels);
			}
			const pathEntries = this.#deps.sessionManager.getBranch();
			const preparation = prepareCompaction(
				pathEntries,
				toAgentCompactionSettings(effectiveSettings),
				await this.runnableCompactionCandidates(compactionCandidates, this.#deps.sessionId),
			);
			if (!preparation) {
				// Check why we can't compact
				const lastEntry = pathEntries[pathEntries.length - 1];
				if (lastEntry?.type === "compaction") {
					throw new Error("Already compacted");
				}
				throw new Error("Nothing to compact (session too small)");
			}

			let hookCompaction: CompactionResult | undefined;
			let fromExtension = false;
			let preserveData: Record<string, unknown> | undefined;

			if (this.#deps.extensionRunner?.hasHandlers("session_before_compact")) {
				const result = (await this.#deps.extensionRunner.emit({
					type: "session_before_compact",
					preparation,
					branchEntries: pathEntries,
					customInstructions,
					signal: compactionAbortController.signal,
				})) as SessionBeforeCompactResult | undefined;

				if (result?.cancel) {
					throw new CompactionCancelledError();
				}

				if (result?.compaction) {
					hookCompaction = result.compaction;
					fromExtension = true;
				}
			}

			const compactionPrep = await this.#prepareCompactionFromHooks(preparation, hookCompaction);

			// Strategy honored on manual /compact too. Custom instructions (public
			// user focus OR internal plan-mode guidance) imply a directed LLM
			// summary; a text-only model cannot read snapcompact frames.
			const wantsSnapcompact =
				compactionPrep.kind !== "fromHook" &&
				(normalizeCompactionStrategy(effectiveSettings.strategy) === "snap" ||
					effectiveSettings.strategy === "snapcompact") &&
				!customInstructions &&
				!options?.internalGuidance;
			// `/compact snapcompact` is an explicit no-LLM archive request: honor
			// its contract by failing locally rather than silently shipping the
			// transcript to a provider. The default-configured snapcompact
			// strategy, in contrast, falls back to LLM compaction (mirroring the
			// auto-compaction path) so a routine /compact still completes on a
			// text-only model (issue #5064).
			const explicitSnapcompact = compactMode?.name === "snapcompact";
			let snapcompactReady = wantsSnapcompact;
			const snapcompactShapeSetting = this.#deps.settings.get("snapcompact.shape");
			let snapcompactShape: snapcompact.Shape | undefined;
			if (wantsSnapcompact && !this.#deps.model.input.includes("image")) {
				if (explicitSnapcompact) {
					this.#deps.emitNotice(
						"warning",
						`snapcompact needs a vision-capable model (${this.#deps.model.id} is text-only)`,
						"compaction",
					);
					throw new Error(`snapcompact cannot run locally: ${this.#deps.model.id} is text-only.`);
				}
				this.#deps.emitNotice(
					"warning",
					`snapcompact needs a vision-capable model (${this.#deps.model.id} is text-only); falling back to LLM compaction`,
					"compaction",
				);
				snapcompactReady = false;
			} else if (snapcompactReady) {
				const text = snapcompact.serializeConversation(
					convertToLlm(preparation.messagesToSummarize.concat(preparation.turnPrefixMessages)),
				);
				const probeText = snapcompact.renderabilityProbeText(
					text,
					preparation.previousPreserveData,
					preparation.previousSummary,
				);
				snapcompactShape = snapcompact.resolveShapeForText(probeText, this.#deps.model, snapcompactShapeSetting);
				const renderScan = snapcompact.scanRenderability(probeText, { shape: snapcompactShape });
				if (!renderScan.isSafe) {
					const percent = (renderScan.unrenderableRatio * 100).toFixed(1);
					this.#deps.emitNotice(
						"warning",
						`snapcompact disabled: unsupported characters for selected snapcompact font (${percent}%). No LLM fallback was attempted.`,
						"compaction",
					);
					throw new Error(
						`snapcompact cannot render this conversation locally: unsupported characters for selected snapcompact font (${percent}%).`,
					);
				}
			}

			let summary: string;
			let shortSummary: string | undefined;
			let firstKeptEntryId: string;
			let tokensBefore: number;
			let details: unknown;
			let codexCompaction: CodexCompactionContext | undefined;

			// Snapcompact runs locally first. The frame cap is sized from the live
			// model window via #computeSnapcompactMaxFrames so the post-render context
			// fits without the warning loop (issue #3247). Zero-frame budget now fails
			// the snapcompact request locally rather than falling back to an LLM call.
			let snapcompactResult: snapcompact.CompactionResult | undefined;
			if (snapcompactReady) {
				const maxFrames = this.#computeSnapcompactMaxFrames(preparation, effectiveSettings);
				if (maxFrames < 1) {
					logger.warn("Snapcompact skipped: kept history alone exceeds the context budget", {
						model: this.#deps.model?.id,
					});
					this.#deps.emitNotice(
						"warning",
						"snapcompact: kept history alone exceeds the context budget. No LLM fallback was attempted.",
						"compaction",
					);
					throw new Error("snapcompact cannot run locally: kept history alone exceeds the context budget.");
				} else {
					const shape = snapcompactShape;
					if (!shape) {
						throw new Error("snapcompact shape was not resolved before rendering.");
					}
					snapcompactResult = await snapcompact.compact(preparation, {
						convertToLlm,
						model: this.#deps.model,
						...(snapcompactShapeSetting === "auto" ? {} : { shape }),
						maxFrames,
					});
					const framePayloadBytes = this.#snapcompactFramePayloadBytes(snapcompactResult);
					if (framePayloadBytes > snapcompact.FRAME_DATA_BYTES_BUDGET) {
						logger.warn("Snapcompact exceeded the per-request frame payload budget", {
							model: this.#deps.model?.id,
							framePayloadBytes,
							budget: snapcompact.FRAME_DATA_BYTES_BUDGET,
						});
						this.#deps.emitNotice(
							"warning",
							"snapcompact produced too much standing image payload. No LLM fallback was attempted.",
							"compaction",
						);
						throw new Error(
							"snapcompact cannot run locally: standing image payload exceeds the per-request budget.",
						);
					}
					const ctxWindow = this.#deps.model?.contextWindow ?? 0;
					const budget =
						ctxWindow > 0
							? ctxWindow - effectiveReserveTokens(ctxWindow, effectiveSettings)
							: Number.POSITIVE_INFINITY;
					if (this.#projectSnapcompactContextTokens(preparation, snapcompactResult) > budget) {
						logger.warn("Snapcompact still overflows the window after frame-budget sizing", {
							model: this.#deps.model?.id,
						});
						this.#deps.emitNotice(
							"warning",
							"snapcompact could not bring the context under the limit. No LLM fallback was attempted.",
							"compaction",
						);
						throw new Error("snapcompact could not bring the context under the limit locally.");
					}
				}
			}

			if (compactionPrep.kind === "fromHook") {
				summary = compactionPrep.summary;
				shortSummary = compactionPrep.shortSummary;
				firstKeptEntryId = compactionPrep.firstKeptEntryId;
				tokensBefore = compactionPrep.tokensBefore;
				details = compactionPrep.details;
				preserveData = compactionPrep.preserveData;
			} else if (snapcompactResult) {
				summary = snapcompactResult.summary;
				shortSummary = snapcompactResult.shortSummary;
				firstKeptEntryId = snapcompactResult.firstKeptEntryId;
				tokensBefore = snapcompactResult.tokensBefore;
				details = snapcompactResult.details;
				preserveData = { ...(compactionPrep.preserveData ?? {}), ...(snapcompactResult.preserveData ?? {}) };
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
				// for an unrelated reason. Assignments live inside the try
				// block because every catch path throws — the post-try reads
				// of the result-derived locals are reachable only on success.
				try {
					const result = await this.#compactWithFallbackModel(
						preparation,
						options?.internalGuidance ?? customInstructions,
						compactionAbortController.signal,
						{
							promptOverride: this.#deps.obfuscateText(compactionPrep.hookPrompt),
							extraContext: compactionPrep.hookContext,
							remoteInstructions: this.#deps.baseSystemPrompt.join("\n\n"),
							convertToLlm: messages => this.#deps.convertToLlmForSideRequest(messages),
							codexCompaction,
						},
						compactionCandidates,
					);
					summary = result.summary;
					shortSummary = result.shortSummary;
					firstKeptEntryId = result.firstKeptEntryId;
					tokensBefore = result.tokensBefore;
					details = result.details;
					preserveData = mergeLlmCompactionPreserveData(compactionPrep.preserveData, result.preserveData);
				} catch (err) {
					if (err instanceof CompactionCancelledError) {
						throw err;
					}
					if (compactionAbortController.signal.aborted && err instanceof Error && err.name === "AbortError") {
						throw new CompactionCancelledError();
					}
					throw err;
				}
			}

			if (compactionAbortController.signal.aborted) {
				throw new CompactionCancelledError();
			}

			this.#deps.sessionManager.appendCompaction(
				summary,
				shortSummary,
				firstKeptEntryId,
				tokensBefore,
				details,
				fromExtension,
				preserveData,
			);
			const newEntries = this.#deps.sessionManager.getEntries();
			const sessionContext = this.#deps.buildDisplaySessionContext();
			this.#deps.agent.replaceMessages(sessionContext.messages);
			this.#deps.rebasePendingContextSnapshot();
			// Compaction discarded the conversation history that carried the approved
			// plan reference. Clear the sent-flag so #buildPlanReferenceMessage re-reads
			// the plan from disk and re-injects it on the next turn (issue #1246).
			this.#deps.clearPlanReferenceSent();
			this.#deps.resetAdvisorRuntimes();
			this.#deps.syncTodoPhasesFromBranch();
			if (codexCompaction) {
				this.#resetCodexProviderAfterCompaction(codexCompaction);
			} else {
				this.#deps.closeCodexProviderSessionsForHistoryRewrite();
			}

			// Get the saved compaction entry for the hook
			const savedCompactionEntry = newEntries.find(e => e.type === "compaction" && e.summary === summary) as
				| CompactionEntry
				| undefined;

			if (this.#deps.extensionRunner && savedCompactionEntry) {
				await this.#deps.extensionRunner.emit({
					type: "session_compact",
					compactionEntry: savedCompactionEntry,
					fromExtension,
				});
			}

			const compactionResult: CompactionResult = {
				summary,
				shortSummary,
				firstKeptEntryId,
				tokensBefore,
				details,
				preserveData,
			};
			options?.onComplete?.(compactionResult);
			return compactionResult;
		} catch (error) {
			const err = error instanceof Error ? error : new Error(String(error));
			options?.onError?.(err);
			throw error;
		} finally {
			if (this.#compactionAbortController === compactionAbortController) {
				this.#compactionAbortController = undefined;
			}
			this.#deps.reconnectToAgent();
		}
	}

	/** Trigger idle compaction through the auto-compaction flow (with UI events). */
	async runIdleCompaction(): Promise<void> {
		if (this.#deps.isStreaming || this.isCompacting) return;
		await this.#runAutoCompaction("idle", false, true);
	}

	/**
	 * Local token estimate of the stored conversation (plus any pending messages),
	 * independent of provider-reported usage. A `before_provider_request` hook
	 * (e.g. a compression extension such as Headroom) or other on-wire payload
	 * transform can shrink the request below the real stored conversation; the
	 * provider then reports deflated prompt tokens, so anchoring the compaction
	 * decision purely on that usage lets the real history grow unbounded until it
	 * overflows and native compaction can no longer run. This estimate is the
	 * floor the compaction decision respects so on-wire compression can never
	 * suppress it.
	 */
	#estimateStoredContextTokens(pendingMessages: AgentMessage[] = []): number {
		// Exclude encrypted reasoning (thinkingSignature / redactedThinking): its
		// local byte size diverges from what the provider bills, so counting it here
		// would let a thinking-heavy turn falsely trip the floor. The provider usage
		// (the other arm of compactionContextTokens) already accounts for it.
		const opts = { excludeEncryptedReasoning: true } as const;
		return (
			this.#deps.computeNonMessageTokens() +
			this.#deps.computeStoredMessagesTokens(opts) +
			pendingMessages.reduce((sum, msg) => sum + estimateTokens(msg, opts), 0)
		);
	}

	#estimatePrePromptContextTokens(messages: AgentMessage[], contextWindow: number): number {
		const breakdown = this.#deps.getContextBreakdown({ contextWindow, pendingMessages: messages });
		const localEstimate = this.#estimateStoredContextTokens(messages);
		// Floor by the local estimate: a payload-shrinking before_provider_request
		// hook deflates the provider-anchored breakdown, which must not suppress
		// pre-prompt compaction (see #estimateStoredContextTokens).
		return compactionContextTokens(breakdown?.usedTokens ?? 0, localEstimate);
	}

	async runPrePromptCompactionIfNeeded(messages: AgentMessage[]): Promise<void> {
		const model = this.#deps.model;
		if (!model) return;
		const contextWindow = model.contextWindow ?? 0;
		if (contextWindow <= 0) return;
		const compactionSettings = this.#deps.settings.getGroup("compaction");
		const contextTokens = this.#estimatePrePromptContextTokens(messages, contextWindow);
		if (!shouldCompact(contextTokens, contextWindow, compactionSettings)) return;

		// Auto-promote first: switching to a larger-context model avoids compacting
		// the history at all. The post-turn threshold path already promotes before
		// compacting; without this, the pre-prompt path would pre-empt promotion and
		// compact (snapcompact/summary) a session that should have just been promoted.
		if (await this.#promoteContextModel()) {
			logger.debug("Pre-prompt context promotion avoided compaction", {
				contextTokens,
				contextWindow,
				model: `${model.provider}/${model.id}`,
			});
			return;
		}

		logger.debug("Pre-prompt context maintenance triggered by pending prompt size", {
			contextTokens,
			contextWindow,
			model: `${model.provider}/${model.id}`,
		});
		await this.#runAutoCompaction("threshold", false, false, false, {
			autoContinue: false,
			triggerContextTokens: contextTokens,
			phase: "pre_turn",
		});
	}

	/**
	 * Compact continuing tool-loop runs before the next provider request.
	 *
	 * `onTurnEnd` is the safe boundary: tool results for the just-finished turn
	 * are already paired in `activeMessages`, the live array the agent loop reads
	 * before its next model call. Before compacting, the just-finished turn is
	 * synchronously persisted if async message hooks have not reached the normal
	 * append path yet. Mid-run handoff is suppressed because resetting the session
	 * while the loop owns `activeMessages` would race the next request; handoff
	 * strategy falls back to in-place context-full compaction here.
	 */
	async maintainContextMidRun(
		activeMessages: AgentMessage[],
		signal: AbortSignal | undefined,
		context: AgentTurnEndContext | undefined,
	): Promise<void> {
		if (
			signal?.aborted ||
			this.#deps.isDisposed ||
			this.isCompacting ||
			this.#deps.isGeneratingHandoff ||
			!context?.willContinue
		)
			return;

		const model = this.#deps.model;
		const contextWindow = model?.contextWindow ?? 0;
		if (contextWindow <= 0) return;

		const compactionSettings = this.#deps.settings.getGroup("compaction");
		if (
			!compactionSettings.enabled ||
			isCompactionStrategyOff(compactionSettings.strategy as string) ||
			compactionSettings.midTurnEnabled === false
		) {
			return;
		}

		const lastAssistant = [...activeMessages]
			.reverse()
			.find((message): message is AssistantMessage => message.role === "assistant");
		if (!lastAssistant || lastAssistant.stopReason === "aborted" || lastAssistant.stopReason === "error") return;

		if (!(await this.#deps.persistTurnMessagesForMidRunCompaction(context))) return;

		const billedContextTokens = calculateContextTokens(lastAssistant.usage);
		const storedContextTokens = this.#estimateStoredContextTokens();
		const contextTokens = compactionContextTokens(billedContextTokens, storedContextTokens);
		if (!shouldCompact(contextTokens, contextWindow, compactionSettings)) return;

		// Promote to a larger-context sibling before compacting, mirroring the
		// pre-prompt (#runPrePromptCompactionIfNeeded) and post-turn threshold
		// (#checkCompaction) paths. Without this, a long mid-turn tool loop that
		// crosses the threshold compacts the history (and can hit the no-progress
		// dead-end on a single oversized turn) on a model that should have just
		// been promoted to a larger window instead.
		if (await this.#promoteContextModel()) {
			logger.debug("Mid-run context promotion avoided compaction", {
				contextTokens,
				contextWindow,
				from: `${model?.provider}/${model?.id}`,
			});
			return;
		}

		const messagesBefore = activeMessages.length;
		await this.#runAutoCompaction("threshold", false, false, false, {
			autoContinue: false,
			suppressContinuation: true,
			suppressHandoff: true,
			triggerContextTokens: contextTokens,
			phase: "mid_turn",
		});

		if (signal?.aborted) return;
		const compactedMessages = this.#deps.agent.state.messages;
		if (compactedMessages !== activeMessages) {
			activeMessages.splice(0, activeMessages.length, ...compactedMessages);
		}
		logger.debug("Mid-run compaction ran between provider calls", {
			contextTokens,
			contextWindow,
			strategy: compactionSettings.strategy,
			goalActive: this.#deps.goalModeState?.enabled === true && this.#deps.goalModeState.goal.status === "active",
			messagesBefore,
			messagesAfter: activeMessages.length,
		});
	}

	/**
	 * Check if context maintenance or promotion is needed and run it.
	 * Called after agent_end and before prompt submission.
	 *
	 * Four cases (in order):
	 * 1. Input overflow + promotion: promote to larger model, retry without maintenance.
	 * 2. Input overflow + no promotion target: run context maintenance, auto-retry on same model.
	 * 3. Output incomplete (stopReason === "length", e.g. `response.incomplete`): the
	 *    model burned its output budget without producing an actionable deliverable
	 *    (reasoning-only or truncated). Drop the dead turn, try promotion, otherwise
	 *    run compaction/handoff and retry.
	 * 4. Threshold: context over threshold, run context maintenance (no auto-retry).
	 *
	 * @param assistantMessage The assistant message to check
	 * @param skipAbortedCheck If false, include aborted messages (for pre-prompt check). Default: true
	 * @param allowDefer If true, threshold-driven handoff strategy may schedule itself as a
	 *   deferred post-prompt task instead of running inline. Callers running inside the
	 *   `agent_end` handler set this to true so `session.prompt()` resolves cleanly; callers
	 *   on the pre-prompt path (where the next agent turn is about to start) set it to false
	 *   to avoid racing the deferred handoff against the new turn.
	 * @param autoContinue Whether maintenance may schedule the agent-authored continuation prompt.
	 * @returns whether compaction/recovery scheduled a handoff, retry, auto-continue, or
	 *   queued-message drain that already owns the next turn. Callers MUST skip
	 *   `session_stop` and other agent continuations when `continuationScheduled`
	 *   is true.
	 */
	async checkCompaction(
		assistantMessage: AssistantMessage,
		skipAbortedCheck = true,
		allowDefer = true,
		autoContinue = true,
	): Promise<CompactionCheckResult> {
		// Skip if message was aborted (user cancelled) - unless skipAbortedCheck is false
		if (skipAbortedCheck && assistantMessage.stopReason === "aborted") return COMPACTION_CHECK_NONE;
		const contextWindow = this.#deps.model?.contextWindow ?? 0;
		const generation = this.#deps.promptGeneration;
		// Skip overflow check if the message came from a different model.
		// This handles the case where user switched from a smaller-context model (e.g. opus)
		// to a larger-context model (e.g. codex) - the overflow error from the old model
		// shouldn't trigger compaction for the new model.
		const sameModel =
			this.#deps.model &&
			assistantMessage.provider === this.#deps.model.provider &&
			assistantMessage.model === this.#deps.model.id;
		// This handles the case where an error was kept after compaction (in the "kept" region).
		// The error shouldn't trigger another compaction since we already compacted.
		// Example: opus fails -> switch to codex -> compact -> switch back to opus -> opus error
		// is still in context but shouldn't trigger compaction again.
		const compactionEntry = getLatestCompactionEntry(this.#deps.sessionManager.getBranch());
		const errorIsFromBeforeCompaction =
			compactionEntry !== null && assistantMessage.timestamp < new Date(compactionEntry.timestamp).getTime();
		if (sameModel && !errorIsFromBeforeCompaction && AIError.isContextOverflow(assistantMessage, contextWindow)) {
			// Clear the failed turn from active context so the retry (or the next
			// user prompt) does not replay it. The persisted branch entry stays
			// for now: when no recovery path runs, the user-facing transcript
			// MUST keep the only assistant message explaining why the turn
			// stopped. The branch entry is dropped further down, but only on the
			// paths that actually schedule a retry/compaction.
			this.#deps.removeAssistantMessageFromActiveContext(assistantMessage);

			// Try context promotion first - switch to a larger model and retry without compacting
			const promoted = await this.#tryContextPromotion(assistantMessage);
			if (promoted) {
				await this.#deps.dropPersistedAssistantTurn(assistantMessage);
				// Retry on the promoted (larger) model without compacting
				this.#deps.scheduleAgentContinue({ delayMs: 100, generation });
				return COMPACTION_CHECK_CONTINUATION;
			}

			// No promotion target available fall through to compaction
			const compactionSettings = this.#deps.settings.getGroup("compaction");
			if (compactionSettings.enabled && !isCompactionStrategyOff(compactionSettings.strategy as string)) {
				return await this.#runRecoveryCompactionWithRollback("overflow", assistantMessage, allowDefer, {
					autoContinue,
				});
			}
			return COMPACTION_CHECK_NONE;
		}
		// A context promotion can land while the failing call is already in
		// flight (or on a run whose loop predates the switch): the overflow
		// error then arrives stamped with the pre-promotion model while
		// `this.#deps.model` is already the promoted target. The sameModel guard
		// above deliberately ignores stale foreign-model errors, but this
		// state is not stale — recover exactly like the promotion path:
		// drop the dead turn and retry on the already-promoted model. Gated
		// narrowly on "current model IS the failed model's promotion target
		// with a strictly larger window" so genuinely stale errors from
		// old user-switched models keep surfacing untouched.
		if (
			!sameModel &&
			autoContinue &&
			!errorIsFromBeforeCompaction &&
			assistantMessage.stopReason === "error" &&
			this.#deps.model &&
			contextWindow > 0 &&
			this.#deps.settings.getGroup("contextPromotion").enabled
		) {
			const failedModel = this.#deps.modelRegistry.find(assistantMessage.provider, assistantMessage.model);
			const failedWindow = failedModel?.contextWindow ?? 0;
			const promotionTarget = failedModel
				? this.#resolveContextPromotionConfiguredTarget(failedModel, this.#deps.modelRegistry.getAvailable())
				: undefined;
			if (
				failedModel &&
				failedWindow > 0 &&
				contextWindow > failedWindow &&
				promotionTarget &&
				modelsAreEqual(promotionTarget, this.#deps.model) &&
				AIError.isContextOverflow(assistantMessage, failedWindow)
			) {
				this.#deps.removeAssistantMessageFromActiveContext(assistantMessage);
				await this.#deps.dropPersistedAssistantTurn(assistantMessage);
				logger.debug("Overflow on pre-promotion model; retrying on promoted model", {
					failed: `${assistantMessage.provider}/${assistantMessage.model}`,
					current: `${this.#deps.model.provider}/${this.#deps.model.id}`,
				});
				this.#deps.scheduleAgentContinue({ delayMs: 100, generation });
				return COMPACTION_CHECK_CONTINUATION;
			}
		}

		// Case 3: Output-side incomplete — `response.incomplete` from OpenAI Responses
		// (and Codex) maps to stopReason === "length". The model burned its
		// `max_output_tokens` budget on reasoning/text and emitted no actionable
		// deliverable. Same recovery class as overflow: promotion if available,
		// otherwise compaction/handoff. Unlike overflow, the *input* is fine, so we
		// allow the handoff strategy to actually run.
		if (sameModel && !errorIsFromBeforeCompaction && assistantMessage.stopReason === "length") {
			// Same active-context vs persisted-history split as the overflow path
			// above: clear the dead turn from agent state so it cannot be replayed,
			// but keep it on the branch unless promotion or compaction actually runs.
			this.#deps.removeAssistantMessageFromActiveContext(assistantMessage);

			const promoted = await this.#tryContextPromotion(assistantMessage);
			if (promoted) {
				await this.#deps.dropPersistedAssistantTurn(assistantMessage);
				logger.debug("Context promotion triggered by response.incomplete (length stop)", {
					from: `${assistantMessage.provider}/${assistantMessage.model}`,
				});
				this.#deps.scheduleAgentContinue({ delayMs: 100, generation });
				return COMPACTION_CHECK_CONTINUATION;
			}

			const incompleteCompactionSettings = this.#deps.settings.getGroup("compaction");
			if (
				incompleteCompactionSettings.enabled &&
				!isCompactionStrategyOff(incompleteCompactionSettings.strategy as string)
			) {
				logger.debug("Compaction triggered by response.incomplete (length stop, no promotion target)", {
					model: `${assistantMessage.provider}/${assistantMessage.model}`,
					strategy: incompleteCompactionSettings.strategy,
				});
				return await this.#runRecoveryCompactionWithRollback("incomplete", assistantMessage, allowDefer, {
					autoContinue,
					triggerContextTokens: calculateContextTokens(assistantMessage.usage),
				});
			}
			// Neither promotion nor compaction is available — surface the dead-end so
			// the user understands why the turn yielded with nothing.
			logger.warn("response.incomplete with no recovery path (promotion + compaction both unavailable)", {
				model: `${assistantMessage.provider}/${assistantMessage.model}`,
			});
			return COMPACTION_CHECK_NONE;
		}

		// Stale-result pass runs every turn, before any threshold gating: it is
		// cheap (bails when no candidate) and independent of the compaction
		// setting.
		const supersedeResult = await this.#pruneStaleToolResults();

		const compactionSettings = this.#deps.settings.getGroup("compaction");
		if (!compactionSettings.enabled || isCompactionStrategyOff(compactionSettings.strategy as string))
			return COMPACTION_CHECK_NONE;

		// Case 4: Threshold - turn succeeded but context is getting large
		// Skip if this was an error (non-overflow errors don't have usage data)
		if (assistantMessage.stopReason === "error") return COMPACTION_CHECK_NONE;
		const pruneResult = await this.#pruneToolOutputs();
		const maintenanceTokensFreed = (supersedeResult?.tokensSaved ?? 0) + (pruneResult?.tokensSaved ?? 0);
		// `errorIsFromBeforeCompaction` (computed above) is the general
		// "this assistant message predates the latest compaction" predicate here,
		// not just an error-specific one; alias it locally so the threshold intent
		// reads clearly (#3412 review).
		const assistantPredatesCompaction = errorIsFromBeforeCompaction;
		// An assistant that predates the latest compaction carries stale, pre-rewrite
		// `usage`: the scheduled auto-continue re-enters this check with the kept
		// assistant (#promptWithMessage → #checkCompaction), and its old high prompt
		// count would re-trip the threshold on a freshly compacted history. Drop the
		// stale provider number for those messages and let the live stored estimate
		// (the floor applied below) drive the decision instead.
		const assistantUsageContextTokens = assistantPredatesCompaction
			? 0
			: calculateContextTokens(assistantMessage.usage);
		const storedContextTokens = this.#estimateStoredContextTokens();
		// Pruning frees bytes for the NEXT prompt; it does not change the size of
		// the prompt the LLM just billed for. Earlier revisions subtracted the
		// per-turn supersede/prune `tokensSaved` from the threshold input, which
		// let a long-running `/goal` session sit above `compaction.thresholdTokens`
		// indefinitely whenever per-turn pruning saved enough to drop the
		// post-prune estimate below the user-configured trigger — the visible
		// context (anchored to the same provider billing) still showed >threshold,
		// but `shouldCompact` no-op'd (#3174). Anchor the initial trigger on the
		// last turn's billed context tokens, floored by the post-prune
		// stored-conversation estimate so a payload-compression hook still can't
		// deflate the trigger.
		const contextTokens = compactionContextTokens(assistantUsageContextTokens, storedContextTokens);
		const postMaintenanceContextTokens = compactionContextTokens(
			Math.max(0, assistantUsageContextTokens - maintenanceTokensFreed),
			storedContextTokens,
		);
		const thresholdTokens = resolveThresholdTokens(contextWindow, compactionSettings);
		const shouldThresholdCompact = shouldCompact(contextTokens, contextWindow, compactionSettings);
		logger.debug("Auto-compaction threshold decision", {
			phase: "post-agent-end",
			goalModeEnabled: this.#deps.goalModeState?.enabled === true,
			goalStatus: this.#deps.goalModeState?.goal.status,
			stopReason: assistantMessage.stopReason,
			sameModel: sameModel === true,
			contextWindow,
			strategy: compactionSettings.strategy,
			thresholdTokens,
			assistantUsageContextTokens,
			storedContextTokens,
			resolvedContextTokens: contextTokens,
			postMaintenanceContextTokens,
			maintenanceTokensFreed,
			shouldCompact: shouldThresholdCompact,
			contextPromotionEnabled: this.#deps.settings.get("contextPromotion.enabled") === true,
		});
		if (shouldThresholdCompact) {
			// Try promotion first — if a larger model is available, switch instead of compacting
			const promoted = await this.#tryContextPromotion(assistantMessage);
			if (!promoted) {
				return await this.#runAutoCompaction("threshold", false, false, allowDefer, {
					autoContinue,
					triggerContextTokens: postMaintenanceContextTokens,
					phase: "pre_turn",
				});
			}
			logger.debug("Auto-compaction threshold satisfied but context promotion took over", {
				contextTokens,
				contextWindow,
				model: `${assistantMessage.provider}/${assistantMessage.model}`,
			});
		}
		return COMPACTION_CHECK_NONE;
	}

	/**
	 * Drop the failed assistant turn from persisted history, run
	 * {@link #runAutoCompaction} for an `overflow` / `incomplete` recovery, and
	 * restore the assistant entry if compaction did not actually commit
	 * anything (no usable model/preparation, hook cancel, compaction error,
	 * or a no-progress automatic-continuation block before any summary was
	 * written).
	 *
	 * Compaction has to see a clean branch — otherwise its `prepareCompaction`
	 * pass would keep the failed turn in the kept region and the retry would
	 * replay it. But a return that was not paired with a fresh compaction
	 * summary or a successful history rewrite means no recovery is in progress,
	 * even if queued user input gets drained next. Restoring the failed turn
	 * before that continuation preserves the visible stop reason and rebuilds the
	 * active assistant tail that `Agent.continue()` needs to dequeue follow-ups.
	 */
	async #runRecoveryCompactionWithRollback(
		reason: "overflow" | "incomplete",
		assistantMessage: AssistantMessage,
		allowDefer: boolean,
		options: { autoContinue: boolean; triggerContextTokens?: number },
	): Promise<CompactionCheckResult> {
		const compactionEntryBefore = getLatestCompactionEntry(this.#deps.sessionManager.getBranch());
		await this.#deps.dropPersistedAssistantTurn(assistantMessage);
		const result = await this.#runAutoCompaction(reason, true, false, allowDefer, {
			autoContinue: options.autoContinue,
			triggerContextTokens: options.triggerContextTokens,
			phase: "mid_turn",
		});
		const compactionEntryAfter = getLatestCompactionEntry(this.#deps.sessionManager.getBranch());
		if (result.historyRewritten !== true && compactionEntryAfter === compactionEntryBefore) {
			this.#restoreFailedAssistantTurn(assistantMessage);
		}
		return result;
	}

	#restoreFailedAssistantTurn(assistantMessage: AssistantMessage): void {
		if (!isEmptyErrorTurn(assistantMessage)) this.#deps.sessionManager.appendMessage(assistantMessage);
		const lastMessage = this.#deps.agent.state.messages.at(-1);
		if (
			lastMessage?.role === "assistant" &&
			this.#deps.isSameAssistantMessage(lastMessage as AssistantMessage, assistantMessage)
		) {
			return;
		}
		this.#deps.agent.appendMessage(assistantMessage);
	}

	/**
	 * Attempt context promotion to a larger model.
	 * Returns true if promotion succeeded (caller should retry without compacting).
	 */
	async #tryContextPromotion(assistantMessage: AssistantMessage): Promise<boolean> {
		const currentModel = this.#deps.model;
		if (!currentModel) return false;
		// The overflow/length error may have come from a model the user already
		// switched away from; only promote when the failing turn was this model.
		if (assistantMessage.provider !== currentModel.provider || assistantMessage.model !== currentModel.id)
			return false;
		return this.#promoteContextModel();
	}

	/**
	 * Switch to a larger-context sibling when context promotion is enabled and a
	 * target with a strictly larger window (and a usable key) exists. Returns true
	 * when the model was switched, so the caller can retry without compacting.
	 * Message-independent core shared by the post-turn overflow path
	 * ({@link #tryContextPromotion}) and the pre-prompt threshold path
	 * ({@link #runPrePromptCompactionIfNeeded}).
	 */
	async #promoteContextModel(): Promise<boolean> {
		const promotionSettings = this.#deps.settings.getGroup("contextPromotion");
		if (!promotionSettings.enabled) return false;
		const currentModel = this.#deps.model;
		if (!currentModel) return false;
		const contextWindow = currentModel.contextWindow ?? 0;
		if (contextWindow <= 0) return false;
		const targetModel = await this.resolveContextPromotionTarget(currentModel, contextWindow);
		if (!targetModel) return false;

		try {
			await this.#deps.setModelTemporary(targetModel, undefined, { ephemeral: true });
			logger.debug("Context promotion switched model on overflow", {
				from: `${currentModel.provider}/${currentModel.id}`,
				to: `${targetModel.provider}/${targetModel.id}`,
			});
			return true;
		} catch (error) {
			logger.warn("Context promotion failed", {
				from: `${currentModel.provider}/${currentModel.id}`,
				to: `${targetModel.provider}/${targetModel.id}`,
				error: String(error),
			});
			return false;
		}
	}

	async resolveContextPromotionTarget(currentModel: Model, contextWindow: number): Promise<Model | undefined> {
		const availableModels = this.#deps.modelRegistry.getAvailable();
		if (availableModels.length === 0) return undefined;

		const candidate = this.#resolveContextPromotionConfiguredTarget(currentModel, availableModels);
		if (!candidate) return undefined;
		if (modelsAreEqual(candidate, currentModel)) return undefined;
		if (candidate.contextWindow == null || candidate.contextWindow <= contextWindow) return undefined;
		const apiKey = await this.#deps.modelRegistry.getApiKey(candidate, this.#deps.sessionId);
		if (!apiKey) return undefined;
		return candidate;
	}

	#resetCodexProviderAfterCompaction(compaction: CodexCompactionContext): void {
		resetOpenAICodexHistoryAfterCompaction({
			providerSessionState: this.#deps.providerSessionState,
			sessionId: this.#deps.sessionId,
			compaction,
		});
	}

	#resolveContextPromotionConfiguredTarget(currentModel: Model, availableModels: Model[]): Model | undefined {
		return this.#deps.resolveConfiguredModelTarget(
			currentModel.contextPromotionTarget,
			currentModel,
			availableModels,
		);
	}

	#resolveCompactionConfiguredTarget(currentModel: Model, availableModels: Model[]): Model | undefined {
		return this.#deps.resolveConfiguredModelTarget(currentModel.compactionModel, currentModel, availableModels);
	}

	#getCompactionModelCandidates(availableModels: Model[], filter?: (model: Model) => boolean): Model[] {
		return this.resolveCompactionModelCandidates(this.#deps.model, availableModels, filter);
	}

	/**
	 * Compaction candidates that can actually run — those with a resolvable API
	 * key, matching the per-candidate getApiKey gate the execution loop applies.
	 * Re-expansion reusability (prepareCompaction) must judge remote-preserve
	 * reuse against these, not against candidates the loop would skip at runtime.
	 */
	async runnableCompactionCandidates(candidates: readonly Model[], sessionId: string | undefined): Promise<Model[]> {
		const keys = await Promise.all(candidates.map(model => this.#deps.modelRegistry.getApiKey(model, sessionId)));
		return candidates.filter((_, index) => keys[index] !== undefined);
	}

	resolveCompactionModelCandidates(
		preferredModel: Model | null | undefined,
		availableModels: Model[],
		filter?: (model: Model) => boolean,
	): Model[] {
		const candidates: Model[] = [];
		const seen = new Set<string>();

		const addCandidate = (model: Model | undefined): void => {
			if (!model) return;
			const key = this.#deps.getModelKey(model);
			if (seen.has(key)) return;
			seen.add(key);
			if (filter && !filter(model)) return;
			candidates.push(model);
		};

		for (const pattern of resolveCompactionModelPatterns(this.#deps.settings)) {
			const resolved = resolveModelRoleValue(pattern, availableModels, {
				settings: this.#deps.settings,
				matchPreferences: getModelMatchPreferences(this.#deps.settings),
			});
			addCandidate(resolved.model);
		}

		if (preferredModel) {
			addCandidate(this.#resolveCompactionConfiguredTarget(preferredModel, availableModels));
		}
		addCandidate(preferredModel ?? undefined);
		for (const role of SELECTABLE_MODEL_ROLE_IDS) {
			addCandidate(this.#deps.resolveRoleModelFull(role, availableModels, preferredModel ?? undefined).model);
		}

		const sortedByContext = [...availableModels].sort((a, b) => (b.contextWindow ?? 0) - (a.contextWindow ?? 0));
		for (const model of sortedByContext) {
			if (!seen.has(this.#deps.getModelKey(model))) {
				addCandidate(model);
				break;
			}
		}

		return candidates;
	}

	#buildCompactionAuthError(): Error {
		const currentModel = this.#deps.model;
		if (!currentModel) {
			return new Error(
				"Compaction requires a model with usable credentials, but no authenticated compaction model is available.",
			);
		}
		return new Error(
			`Compaction requires usable credentials for ${currentModel.provider}/${currentModel.id}. ` +
				`Configure ${currentModel.provider} credentials or assign an authenticated fallback role such as modelRoles.smol.`,
		);
	}

	async #compactWithFallbackModel(
		preparation: CompactionPreparation,
		customInstructions: string | undefined,
		signal: AbortSignal,
		options?: SummaryOptions,
		precomputedCandidates?: Model[],
	): Promise<CompactionResult> {
		const candidates =
			precomputedCandidates ?? this.#getCompactionModelCandidates(this.#deps.modelRegistry.getAvailable());
		const telemetry = resolveTelemetry(this.#deps.agent.telemetry, this.#deps.sessionId);

		// Effective window of the model RUNNING the compaction. The payload was
		// sized against the MAIN model's threshold, so a compaction model with a
		// smaller window would overflow mid-compact; skip those candidates loudly
		// instead. compaction.modelContextWindow (-1 = candidate's own metadata)
		// overrides for proxies that serve a different window than advertised.
		const configuredCompactionWindow = this.#deps.settings.get("compaction.modelContextWindow");
		const summarizePayloadTokens = preparation.messagesToSummarize
			.concat(preparation.turnPrefixMessages)
			.reduce((sum, msg) => sum + estimateTokens(msg), 0);
		let skippedForWindow = 0;

		for (const candidate of candidates) {
			const candidateWindow =
				typeof configuredCompactionWindow === "number" && configuredCompactionWindow > 0
					? configuredCompactionWindow
					: (candidate.contextWindow ?? 0);
			if (candidateWindow > 0 && summarizePayloadTokens > candidateWindow) {
				skippedForWindow++;
				logger.warn("compaction candidate skipped: summarization payload exceeds its context window", {
					candidate: `${candidate.provider}/${candidate.id}`,
					candidateWindow,
					summarizePayloadTokens,
				});
				continue;
			}
			const apiKey = await this.#deps.modelRegistry.getApiKey(candidate, this.#deps.sessionId);
			if (!apiKey) continue;

			try {
				return await compact(
					this.#obfuscatePreparationForProvider(preparation),
					candidate,
					this.#deps.modelRegistry.resolver(candidate, this.#deps.sessionId),
					this.#deps.obfuscateText(customInstructions),
					signal,
					{
						...options,
						metadata: this.#deps.agent.metadataForProvider(candidate.provider),
						convertToLlm: messages => this.#deps.convertToLlmForSideRequest(messages),
						telemetry,
						// Honor the user's /model thinking selection (incl. `off`) on
						// the manual `/compact` path. Clamped per-model inside compact()
						// via resolveCompactionEffort so unsupported-effort models
						// (xai-oauth/grok-build) don't trip requireSupportedEffort.
						thinkingLevel: this.#deps.thinkingLevel,
						tools: this.#deps.agent.state.tools,
						sessionId: this.#deps.sessionId,
						promptCacheKey: this.#deps.sessionId,
						providerSessionState: this.#deps.providerSessionState,
						// Route every summarization HTTP request through the
						// session's side-stream transport so the provider
						// concurrency cap (e.g. providers.ollama-cloud.maxConcurrency)
						// brackets compaction the same way it brackets the live
						// agent turn — without this, multiple ollama-cloud
						// subagents auto/manually compacting issued uncapped
						// summary requests in parallel (chatgpt-codex review on
						// #3751).
						completeImpl: async (requestModel, requestContext, requestOptions) => {
							const stream = await this.#deps.sideStream(requestModel, requestContext, requestOptions);
							return stream.result();
						},
					},
				);
			} catch (error) {
				if (!AIError.is(AIError.classify(error, candidate.api), AIError.Flag.AuthFailed)) {
					throw error;
				}
			}
		}

		if (skippedForWindow > 0 && skippedForWindow === candidates.length) {
			throw new Error(
				`Compaction failed: the summarization payload (~${summarizePayloadTokens} tokens) exceeds the context window of every compaction candidate. ` +
					`Raise compaction.modelContextWindow only if your provider really serves a larger window, pick a larger compaction.model, or lower compaction.thresholdPercent so compaction runs earlier.`,
			);
		}
		throw this.#buildCompactionAuthError();
	}

	async #prepareCompactionFromHooks(
		preparation: CompactionPreparation,
		hookCompaction: CompactionResult | undefined,
	): Promise<
		| {
				kind: "fromHook";
				summary: string;
				shortSummary: string | undefined;
				firstKeptEntryId: string;
				tokensBefore: number;
				details: unknown;
				preserveData: Record<string, unknown> | undefined;
		  }
		| {
				kind: "needsLlm";
				hookContext: string[] | undefined;
				hookPrompt: string | undefined;
				preserveData: Record<string, unknown> | undefined;
		  }
	> {
		let hookContext: string[] | undefined;
		let hookPrompt: string | undefined;
		let preserveData: Record<string, unknown> | undefined;

		if (!hookCompaction && this.#deps.extensionRunner?.hasHandlers("session.compacting")) {
			const compactMessages = preparation.messagesToSummarize.concat(preparation.turnPrefixMessages);
			const result = (await this.#deps.extensionRunner.emit({
				type: "session.compacting",
				sessionId: this.#deps.sessionId,
				messages: compactMessages,
			})) as { context?: string[]; prompt?: string; preserveData?: Record<string, unknown> } | undefined;

			hookContext = result?.context;
			hookPrompt = result?.prompt;
			preserveData = result?.preserveData;
		}

		const memoryBackendContext = await this.#deps.collectMemoryBackendContext(preparation);
		if (memoryBackendContext) {
			hookContext = hookContext ? [...hookContext, memoryBackendContext] : [memoryBackendContext];
		}

		if (hookCompaction) {
			preserveData ??= hookCompaction.preserveData;
			return {
				kind: "fromHook",
				summary: hookCompaction.summary,
				shortSummary: hookCompaction.shortSummary,
				firstKeptEntryId: hookCompaction.firstKeptEntryId,
				tokensBefore: hookCompaction.tokensBefore,
				details: hookCompaction.details,
				preserveData,
			};
		}

		return { kind: "needsLlm", hookContext, hookPrompt, preserveData };
	}

	/**
	 * Cap on snapcompact frames the post-compaction context can carry without
	 * busting the model window. Mirrors the per-frame token charge used by the
	 * projection ({@link snapcompact.FRAME_TOKEN_ESTIMATE}, the conservative
	 * high-res Anthropic ceiling), so picking `maxFrames` from this helper makes
	 * {@link #projectSnapcompactContextTokens} succeed by construction.
	 *
	 * Skip vs. cap use different reserves on purpose. The **skip** decision
	 * (return `0`) trips only when kept-recent plus non-message tokens already
	 * eat the entire `ctxWindow − reserve` envelope: at that point no archive
	 * shape — frame-bearing or text-only — can fit, and the caller MUST
	 * shortcut to the LLM summarizer instead of re-running snapcompact to
	 * re-emit the "could not bring the context under the limit" warning every
	 * threshold tick. The **cap** calculation subtracts a shape-aware reserve
	 * (`2 × geometry(shape).capacity` chars worth of text edges, billed at the
	 * tiktoken cl100k baseline, plus a 2k summary-template allowance) sized
	 * from the same `shape` snapcompact will use, so the projection still
	 * passes once frames land — but it MUST NOT gate the skip decision, since
	 * a frame-less archive (`text.length <= 2 * edgeCap` short-circuit in
	 * `planArchive`) typically costs only a few hundred tokens of summary
	 * lead and would fit under residual headroom far smaller than the cap
	 * reserve (chatgpt-codex reviews on #3249).
	 *
	 * Returns `1` when the frame charge would overflow but the text-only path
	 * still has room: snapcompact's planner picks the frame-less layout
	 * automatically when the discarded text fits in the edges, so giving it
	 * the minimum cap lets it succeed instead of being skipped outright.
	 *
	 * Without this cap, the bundled `MAX_FRAMES_DEFAULT = 80` × 5024 tokens =
	 * ~402k frame-token projection always overflows any sub-1M-token window
	 * (issue #3247).
	 */
	#computeSnapcompactMaxFrames(preparation: CompactionPreparation, settings: CompactionSettings): number {
		const ctxWindow = this.#deps.model?.contextWindow ?? 0;
		if (ctxWindow <= 0) return Math.min(snapcompact.MAX_FRAMES_DEFAULT, snapcompact.maxFramesForDataBudget());
		const reserve = effectiveReserveTokens(ctxWindow, settings);
		let baseTokens = this.#deps.computeNonMessageTokens();
		for (const message of preparation.recentMessages) {
			baseTokens += estimateTokens(message);
		}
		const totalBudget = ctxWindow - reserve;
		// Skip iff there is no headroom whatsoever; a text-only archive costs
		// far less than the cap reserve below, so any positive residual is
		// worth attempting and the projection guard catches actual overflow.
		if (baseTokens >= totalBudget) return 0;
		// Cap reserve mirrors what `estimateTokens(summaryMessage)` will charge
		// when frames > 0: `countTokens(summaryTemplate ‖ textHead ‖ textTail)`
		// plus `numFrames × FRAME_TOKEN_ESTIMATE`. Resolve the shape this
		// snapcompact pass will actually use (matches the `shape` argument
		// passed to `snapcompact.compact` in the auto and manual paths) so the
		// text-edge cost reflects the live frame geometry rather than a fixed
		// approximation. Reviewer (chatgpt-codex on #3249): a 4k reserve
		// undersized the ~7k text-edge cost on the default Anthropic
		// 11on16-bw shape, so the projection then rejected the `maxFrames`
		// the cap had picked and the warning loop reappeared.
		//
		// - `textHead` and `textTail` each consume up to `geometry.capacity`
		//   chars when frames > 0 (one HQ-capacity page per edge: see
		//   `TEXT_EDGE_PAGES = 1` in `planArchive`), so 2 × capacity chars
		//   total. Per-shape capacity: Anthropic 11on16-bw ~13.9k, Opus
		//   1932px ~21k, Gemini 8on22-bw 2048px ~23.8k, OpenAI 1568px ~13.9k.
		// - tiktoken cl100k ≈ 4 chars/token on ASCII (verified empirically
		//   for prose, code, and JSON); a 1.15 multiplier absorbs tokenizer
		//   drift on denser content (e.g. dense JSON / tool-result blobs).
		// - Summary template (intro + FILES section + grid notes) bills
		//   ~2k tokens for typical sessions.
		const shape = snapcompact.resolveShape(this.#deps.model, this.#deps.settings.get("snapcompact.shape"));
		const edgeCap = snapcompact.geometry(shape).capacity;
		const textEdgeTokens = Math.ceil((2 * edgeCap * 1.15) / 4);
		const SUMMARY_TEMPLATE_TOKENS = 2000;
		const capReserve = textEdgeTokens + SUMMARY_TEMPLATE_TOKENS;
		const frameBudget = totalBudget - baseTokens - capReserve;
		if (frameBudget < snapcompact.FRAME_TOKEN_ESTIMATE) return 1;
		return Math.min(
			Math.floor(frameBudget / snapcompact.FRAME_TOKEN_ESTIMATE),
			snapcompact.MAX_FRAMES_DEFAULT,
			snapcompact.maxFramesForDataBudget(),
		);
	}

	#snapcompactFramePayloadBytes(result: snapcompact.CompactionResult): number {
		const archive = snapcompact.getPreservedArchive(result.preserveData);
		return archive ? snapcompact.frameDataBytes(archive.frames) : 0;
	}

	/**
	 * Project the post-compaction context size of a snapcompact result: kept
	 * recent messages + the summary message with its re-attached frames + the
	 * fixed non-message overhead (system prompt + tools). Mirrors how the
	 * compacted context is rebuilt, so the estimate matches the wire shape, and
	 * lets the caller decide whether snapcompact brought the context under the
	 * window or should fall back to an LLM summary.
	 */
	#projectSnapcompactContextTokens(preparation: CompactionPreparation, result: snapcompact.CompactionResult): number {
		const archive = snapcompact.getPreservedArchive(result.preserveData);
		const blocks = archive
			? snapcompact.historyBlocks(archive, { maxFrameDataBytes: snapcompact.FRAME_DATA_BYTES_BUDGET })
			: undefined;
		const summaryMessage = createCompactionSummaryMessage(
			result.summary,
			result.tokensBefore,
			new Date().toISOString(),
			result.shortSummary,
			undefined,
			undefined,
			blocks,
		);
		let tokens = this.#deps.computeNonMessageTokens() + estimateTokens(summaryMessage);
		for (const message of preparation.recentMessages) {
			tokens += estimateTokens(message);
		}
		return tokens;
	}

	/**
	 * Post-maintenance progress check for the context-full / snapcompact tail.
	 *
	 * After `appendCompaction` rewrote history and `replaceMessages` swapped in the
	 * compacted context, measure the residual context off the live message set and
	 * decide whether maintenance actually created headroom. Mirrors the shake
	 * recovery-band logic (#2275): a session whose single most-recent turn already
	 * blows the threshold cannot be reduced by compaction (findCutPoint keeps that
	 * turn verbatim), so re-firing on the next agent_end just thrashes. We only
	 * report progress when residual context lands at or below
	 * `COMPACTION_RECOVERY_BAND × threshold` — a band that sits strictly under the
	 * compaction threshold, so reaching it guarantees the next turn cannot
	 * re-trip threshold compaction.
	 *
	 * When the model/window is unknown we cannot evaluate the band, so we
	 * optimistically allow the continuation (preserving prior behavior).
	 */
	#compactionCreatedHeadroom(): boolean {
		const contextWindow = this.#deps.model?.contextWindow ?? 0;
		if (contextWindow <= 0) return true;
		const compactionSettings = this.#deps.settings.getGroup("compaction");
		const residualTokens = compactionContextTokens(
			this.#deps.getContextUsage({ contextWindow })?.tokens ?? 0,
			this.#estimateStoredContextTokens(),
		);
		const thresholdTokens = resolveThresholdTokens(contextWindow, compactionSettings);
		const recoveryBand = Math.floor(thresholdTokens * COMPACTION_RECOVERY_BAND);
		// Residual at/below the band is authoritative headroom: the band sits
		// strictly under the compaction threshold, so the next turn cannot
		// re-trip threshold compaction regardless of how little this pass shaved.
		// Don't add a secondary "smaller than the trigger" guard — when stale/
		// tool-output pruning already dropped context under the band before this
		// pass, the trigger is itself sub-band, and requiring a strict reduction
		// would suppress a valid continuation and emit a false no-progress warning
		// even though compaction left the session safe.
		return residualTokens <= recoveryBand;
	}

	/**
	 * Retry-side counterpart to {@link #compactionCreatedHeadroom}. An
	 * overflow/incomplete recovery only needs the rebuilt prompt to *fit* the
	 * window again — it does not have to land under the compaction threshold, let
	 * alone the stricter `COMPACTION_RECOVERY_BAND × threshold` hysteresis the
	 * auto-continue thrash guard uses. Reusing the band here turned recoverable
	 * overflows into manual dead-ends: a 200k-window prompt compacted from
	 * overflow down to ~150k is comfortably retryable, but sits above
	 * `0.8 × 170k = 136k` and was wrongly refused (PR #3412 review).
	 *
	 * Measures residual context against the usable budget (`contextWindow - reserve`).
	 * The default absolute reserve can exceed bundled small-context windows, or
	 * nearly consume a 16k-class window; those known-impossible defaults fall
	 * back to the proportional 15% reserve. Explicit valid reserves still define
	 * the usable prompt budget so retries do not enter headroom the user
	 * intentionally reserved. Callers MUST
	 * invoke this AFTER dropping the failed assistant from the active context, so
	 * the just-failed turn (which the retry prompt will not include) is excluded
	 * from the estimate.
	 *
	 * When the model/window is unknown we cannot evaluate the budget, so we
	 * optimistically allow the retry (preserving prior behavior).
	 */
	#compactionCreatedRetryFit(): boolean {
		const contextWindow = this.#deps.model?.contextWindow ?? 0;
		if (contextWindow <= 0) return true;
		const compactionSettings = this.#deps.settings.getGroup("compaction");
		const residualTokens = compactionContextTokens(
			this.#deps.getContextUsage({ contextWindow })?.tokens ?? 0,
			this.#estimateStoredContextTokens(),
		);
		const fitBudget = Math.max(0, contextWindow - resolveBudgetReserveTokens(contextWindow, compactionSettings));
		return residualTokens <= fitBudget;
	}

	/**
	 * Last-resort tiered reducer when {@link #runAutoCompaction} would otherwise
	 * dead-end. The summarizer cut at the only available turn boundary, but the
	 * kept tail is still over the recovery band because a single recent turn (a
	 * large tool-result, a heavy fenced/XML block, attached images) is itself
	 * bigger than the band and `findCutPoint` cannot cut inside one message.
	 *
	 * Tier 1 — `shake("elide")` reaches INSIDE that tail: heavy tool-result /
	 * block content is offloaded to one `artifact://` blob behind a recoverable
	 * placeholder. Skipped when this pass already ran a shake (`skipElide`).
	 * Tier 2 — `dropImages()`: the manual `/shake images` remedy, automated.
	 * Image blocks are stripped from the branch; unlike elided text they are NOT
	 * artifact-recoverable, so this tier only runs once elide has failed the
	 * progress re-test.
	 *
	 * Each tier that rewrote history re-anchors the in-flight context snapshot,
	 * then the caller's progress predicate is re-tested; the first tier that
	 * restores progress emits one info notice describing everything freed and
	 * stops. Returns whether progress was restored — `false` falls through to
	 * the dead-end warning.
	 */
	async #rescueCompactionDeadEnd(
		signal: AbortSignal,
		options: { skipElide: boolean; hasProgress: () => boolean },
	): Promise<boolean> {
		if (signal.aborted) return false;
		let elided = 0;
		let elidedTokens = 0;
		let elideSink = "placeholders";
		if (!options.skipElide) {
			try {
				const result = await this.#deps.shake("elide", { signal });
				elided = result.toolResultsDropped + result.blocksDropped;
				elidedTokens = result.tokensFreed;
				if (result.artifactId) elideSink = "an artifact";
				if (elided > 0) {
					// The elide pass rewrote history; re-anchor the in-flight snapshot
					// so the caller's headroom/retry-fit re-test measures the shaken
					// context.
					this.#deps.rebasePendingContextSnapshot();
				}
			} catch (error) {
				logger.warn("Dead-end shake rescue failed", {
					error: error instanceof Error ? error.message : String(error),
				});
			}
			if (elided > 0 && options.hasProgress()) {
				this.#deps.emitNotice(
					"info",
					`Compaction dead-end recovery: ${this.#describeElideRescue(elided, elidedTokens, elideSink)} so maintenance could make progress.`,
					"compaction",
				);
				return true;
			}
		}
		if (signal.aborted) return false;
		let imagesDropped = 0;
		try {
			imagesDropped = (await this.#deps.dropImages()).removed;
			if (imagesDropped > 0) this.#deps.rebasePendingContextSnapshot();
		} catch (error) {
			logger.warn("Dead-end image-drop rescue failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
		if (imagesDropped > 0 && options.hasProgress()) {
			const elidedPart = elided > 0 ? `${this.#describeElideRescue(elided, elidedTokens, elideSink)} and ` : "";
			this.#deps.emitNotice(
				"info",
				`Compaction dead-end recovery: ${elidedPart}dropped ${imagesDropped} attached image${imagesDropped === 1 ? "" : "s"} so maintenance could make progress.`,
				"compaction",
			);
			return true;
		}
		return false;
	}

	/** Notice fragment for a dead-end elide tier: what was freed and where it went. */
	#describeElideRescue(elided: number, tokensFreed: number, sink: string): string {
		return `elided ${elided} heavy block${elided === 1 ? "" : "s"} (~${tokensFreed.toLocaleString()} tokens) to ${sink}`;
	}

	/**
	 * Internal: Run auto-compaction with events.
	 *
	 * @param allowDefer If true (default), threshold-driven handoff strategy is allowed to
	 *   schedule itself as a deferred post-prompt task and return a deferred-handoff result
	 *   immediately. The caller MUST treat that as "compaction will happen async — do not
	 *   also schedule `agent.continue()` for this turn", otherwise the deferred handoff
	 *   races a fresh streaming turn (the symptom: "Auto-handoff" loader + assistant
	 *   message still streaming). Callers on a path that is about to start a new agent
	 *   turn (e.g. the pre-prompt check in `#promptWithMessage`) pass `false` to force
	 *   inline execution so the handoff completes before the new turn begins.
	 * @returns whether auto-compaction scheduled a follow-up turn.
	 */
	async #runAutoCompaction(
		reason: "overflow" | "threshold" | "idle" | "incomplete",
		willRetry: boolean,
		deferred = false,
		allowDefer = true,
		options: {
			autoContinue?: boolean;
			triggerContextTokens?: number;
			suppressContinuation?: boolean;
			suppressHandoff?: boolean;
			phase?: CodexCompactionContext["phase"];
		} = {},
	): Promise<CompactionCheckResult> {
		const compactionSettings = this.#deps.settings.getGroup("compaction");
		const rawStrategy = compactionSettings.strategy as string | undefined;
		if (reason === "idle") {
			if (isCompactionStrategyOff(rawStrategy)) return COMPACTION_CHECK_NONE;
		} else if (isThresholdCompactionDisabled(compactionSettings.enabled, rawStrategy)) {
			return COMPACTION_CHECK_NONE;
		}
		const generation = this.#deps.promptGeneration;
		const suppressContinuation = options.suppressContinuation === true;
		const shouldAutoContinue =
			!suppressContinuation && options.autoContinue !== false && compactionSettings.autoContinue !== false;
		const suppressHandoff = options.suppressHandoff === true;
		let fallbackFromShake = false;
		// Shake runs inline (cheap, no remote LLM). On overflow recovery, if shake
		// reclaims nothing we fall through to the summary-compaction body below so
		// the oversized input still gets resolved.
		if ((compactionSettings.strategy as string) === "shake") {
			const outcome = await this.#runAutoShake(
				reason,
				willRetry,
				generation,
				shouldAutoContinue,
				options.triggerContextTokens,
				suppressContinuation,
			);
			if (outcome !== "fallback") return outcome;
			fallbackFromShake = true;
		}
		// "overflow" and "incomplete" force inline execution because they are recovery
		// paths the caller wants resolved before scheduling the next turn. "idle" is
		// triggered by the idle loop and does its own scheduling.
		if (
			!suppressHandoff &&
			!deferred &&
			allowDefer &&
			reason !== "overflow" &&
			reason !== "incomplete" &&
			reason !== "idle" &&
			compactionSettings.strategy === "handoff"
		) {
			this.#deps.schedulePostPromptTask(
				async signal => {
					await Promise.resolve();
					if (signal.aborted) return;
					await this.#runAutoCompaction(reason, willRetry, true, true, { phase: options.phase });
				},
				{ generation },
			);
			return COMPACTION_CHECK_DEFERRED_HANDOFF;
		}

		// "overflow" forces context-full because the input itself is broken — a handoff
		// LLM call would hit the same overflow. "incomplete" is an output-side problem,
		// so a handoff request on the existing context is still viable.
		let action: "context-full" | "handoff" | "snapcompact" = resolveCompactionEngineAction(
			compactionSettings.strategy,
			{ reason, suppressHandoff },
		);
		if (action === "snapcompact" && this.#deps.model && !this.#deps.model.input.includes("image")) {
			this.#deps.emitNotice(
				"warning",
				`snapcompact needs a vision-capable active model (${this.#deps.model.id} is text-only); using context-full auto-compaction instead.`,
				"compaction",
			);
			action = "context-full";
		}
		// Abort any older auto-compaction before installing this run's controller.
		this.#autoCompactionAbortController?.abort();
		const autoCompactionAbortController = new AbortController();
		this.#autoCompactionAbortController = autoCompactionAbortController;
		const autoCompactionSignal = autoCompactionAbortController.signal;

		try {
			// Emit start AFTER the controller is installed so isCompacting is already true
			// for any listener — and for input routed during this emit's event-loop yield:
			// a message typed as the compaction loader appears must land in the compaction
			// queue, not the core steering queue (which handoff's agent.reset() would wipe).
			await this.#deps.emitSessionEvent({ type: "auto_compaction_start", reason, action });
			if (action === "handoff") {
				let handoffSwitchCancelled = false;
				const handoffFocus = AUTO_HANDOFF_THRESHOLD_FOCUS;
				const handoffResult = await this.#deps.handoff(handoffFocus, {
					autoTriggered: true,
					signal: autoCompactionSignal,
					onSwitchCancelled: () => {
						handoffSwitchCancelled = true;
					},
				});
				if (!handoffResult) {
					const aborted = autoCompactionSignal.aborted || handoffSwitchCancelled;
					if (aborted) {
						await this.#deps.emitSessionEvent({
							type: "auto_compaction_end",
							action,
							result: undefined,
							aborted: true,
							willRetry: false,
						});
						return COMPACTION_CHECK_NONE;
					}
					logger.warn("Auto-handoff returned no document; falling back to context-full maintenance", {
						reason,
					});
					action = "context-full";
				}
				if (handoffResult) {
					await this.#deps.emitSessionEvent({
						type: "auto_compaction_end",
						action,
						result: undefined,
						aborted: false,
						willRetry: false,
					});
					const continuationScheduled = !autoCompactionSignal.aborted && reason !== "idle" && shouldAutoContinue;
					if (continuationScheduled) {
						this.#deps.scheduleAutoContinuePrompt(generation);
					}
					return {
						...(continuationScheduled ? COMPACTION_CHECK_CONTINUATION : COMPACTION_CHECK_NONE),
						historyRewritten: true,
					};
				}
			}

			if (!this.#deps.model) {
				await this.#deps.emitSessionEvent({
					type: "auto_compaction_end",
					action,
					result: undefined,
					aborted: false,
					willRetry: false,
					skipped: true,
				});
				return COMPACTION_CHECK_NONE;
			}

			const availableModels = this.#deps.modelRegistry.getAvailable();
			if (availableModels.length === 0) {
				await this.#deps.emitSessionEvent({
					type: "auto_compaction_end",
					action,
					result: undefined,
					aborted: false,
					willRetry: false,
					skipped: true,
				});
				return COMPACTION_CHECK_NONE;
			}

			const pathEntries = this.#deps.sessionManager.getBranch();

			const autoCompactionCandidates = await this.runnableCompactionCandidates(
				this.#getCompactionModelCandidates(availableModels),
				this.#deps.sessionId,
			);
			const preparation = prepareCompaction(
				pathEntries,
				toAgentCompactionSettings(compactionSettings),
				autoCompactionCandidates,
			);
			if (!preparation) {
				await this.#deps.emitSessionEvent({
					type: "auto_compaction_end",
					action,
					result: undefined,
					aborted: false,
					willRetry: false,
					skipped: true,
				});
				const noProgressDeadEnd = reason !== "idle";
				let continuationScheduled = false;
				if (!suppressContinuation && this.#deps.agent.hasQueuedMessages()) {
					this.#deps.scheduleAgentContinue({
						delayMs: 100,
						generation,
						shouldContinue: () => this.#deps.agent.hasQueuedMessages(),
					});
					continuationScheduled = true;
				}
				if (noProgressDeadEnd) {
					this.#deps.emitNotice(
						"warning",
						compactionDeadEndWarning("shrink it (e.g. clear large tool output)"),
						"compaction",
					);
				}
				if (continuationScheduled) return COMPACTION_CHECK_CONTINUATION;
				return noProgressDeadEnd ? COMPACTION_CHECK_BLOCK_AUTOMATIC_CONTINUATION : COMPACTION_CHECK_NONE;
			}

			let hookCompaction: CompactionResult | undefined;
			let fromExtension = false;
			let preserveData: Record<string, unknown> | undefined;
			let codexCompaction: CodexCompactionContext | undefined;

			if (this.#deps.extensionRunner?.hasHandlers("session_before_compact")) {
				const hookResult = (await this.#deps.extensionRunner.emit({
					type: "session_before_compact",
					preparation,
					branchEntries: pathEntries,
					customInstructions: undefined,
					signal: autoCompactionSignal,
				})) as SessionBeforeCompactResult | undefined;

				if (hookResult?.cancel) {
					await this.#deps.emitSessionEvent({
						type: "auto_compaction_end",
						action,
						result: undefined,
						aborted: true,
						willRetry: false,
					});
					return COMPACTION_CHECK_NONE;
				}

				if (hookResult?.compaction) {
					hookCompaction = hookResult.compaction;
					fromExtension = true;
				}
			}

			const compactionPrep = await this.#prepareCompactionFromHooks(preparation, hookCompaction);

			let summary: string;
			let shortSummary: string | undefined;
			let firstKeptEntryId: string;
			let tokensBefore: number;
			let details: unknown;

			// Snapcompact runs locally first. The post-compaction context = kept-recent
			// + a summary message carrying the imaged archive at FRAME_TOKEN_ESTIMATE
			// per frame; #computeSnapcompactMaxFrames sizes the frame cap from the
			// live window so we don't run snapcompact just to overflow every threshold
			// tick. Any local blocker (unsupported snapcompact glyphs, kept-history too large,
			// post-render overflow) downgrades auto maintenance to a context-full LLM
			// summary instead of wedging the session (#3659) — auto runs the default
			// strategy on the user's behalf, so a fallback that lets the session keep
			// running is the right behavior. Manual `/compact snapcompact` keeps the
			// local-only contract (#3599): the user explicitly picked it.
			let snapcompactResult: snapcompact.CompactionResult | undefined;
			let snapcompactBlocker: string | undefined;
			if (action === "snapcompact" && compactionPrep.kind !== "fromHook") {
				const text = snapcompact.serializeConversation(
					convertToLlm(preparation.messagesToSummarize.concat(preparation.turnPrefixMessages)),
				);
				const probeText = snapcompact.renderabilityProbeText(
					text,
					preparation.previousPreserveData,
					preparation.previousSummary,
				);
				const shapeSetting = this.#deps.settings.get("snapcompact.shape");
				const shape = snapcompact.resolveShapeForText(probeText, this.#deps.model, shapeSetting);
				const renderScan = snapcompact.scanRenderability(probeText, { shape });
				if (!renderScan.isSafe) {
					const percent = (renderScan.unrenderableRatio * 100).toFixed(1);
					logger.warn("Snapcompact disabled: unsupported characters for selected snapcompact font", {
						model: this.#deps.model?.id,
						unrenderableRatio: renderScan.unrenderableRatio,
					});
					snapcompactBlocker = `snapcompact disabled: unsupported characters for selected snapcompact font (${percent}%); using context-full auto-compaction instead.`;
				} else {
					const maxFrames = this.#computeSnapcompactMaxFrames(preparation, compactionSettings);
					if (maxFrames < 1) {
						logger.warn("Snapcompact skipped: kept history alone exceeds the context budget", {
							model: this.#deps.model?.id,
						});
						snapcompactBlocker =
							"snapcompact: kept history alone exceeds the context budget; using context-full auto-compaction instead.";
					} else {
						snapcompactResult = await snapcompact.compact(preparation, {
							convertToLlm,
							model: this.#deps.model,
							...(shapeSetting === "auto" ? {} : { shape }),
							maxFrames,
						});
						const framePayloadBytes = this.#snapcompactFramePayloadBytes(snapcompactResult);
						if (framePayloadBytes > snapcompact.FRAME_DATA_BYTES_BUDGET) {
							logger.warn("Snapcompact exceeded the per-request frame payload budget", {
								model: this.#deps.model?.id,
								framePayloadBytes,
								budget: snapcompact.FRAME_DATA_BYTES_BUDGET,
							});
							snapcompactBlocker =
								"snapcompact produced too much standing image payload; using context-full auto-compaction instead.";
							snapcompactResult = undefined;
						}
						if (snapcompactResult) {
							const ctxWindow = this.#deps.model?.contextWindow ?? 0;
							const budget =
								ctxWindow > 0
									? ctxWindow - effectiveReserveTokens(ctxWindow, compactionSettings)
									: Number.POSITIVE_INFINITY;
							const projected = this.#projectSnapcompactContextTokens(preparation, snapcompactResult);
							if (projected > budget) {
								logger.warn("Snapcompact still overflows the window after frame-budget sizing", {
									model: this.#deps.model?.id,
									projected,
									budget,
								});
								snapcompactBlocker =
									"snapcompact could not bring the context under the limit; using context-full auto-compaction instead.";
								snapcompactResult = undefined;
							}
						}
					}
				}
				if (snapcompactBlocker) {
					this.#deps.emitNotice("warning", snapcompactBlocker, "compaction");
					action = "context-full";
				}
			}

			if (compactionPrep.kind === "fromHook") {
				summary = compactionPrep.summary;
				shortSummary = compactionPrep.shortSummary;
				firstKeptEntryId = compactionPrep.firstKeptEntryId;
				tokensBefore = compactionPrep.tokensBefore;
				details = compactionPrep.details;
				preserveData = compactionPrep.preserveData;
			} else if (snapcompactResult) {
				summary = snapcompactResult.summary;
				shortSummary = snapcompactResult.shortSummary;
				firstKeptEntryId = snapcompactResult.firstKeptEntryId;
				tokensBefore = snapcompactResult.tokensBefore;
				details = snapcompactResult.details;
				preserveData = { ...(compactionPrep.preserveData ?? {}), ...(snapcompactResult.preserveData ?? {}) };
			} else {
				const candidates = this.#getCompactionModelCandidates(availableModels);
				const retrySettings = this.#deps.settings.getGroup("retry");
				const telemetry = resolveTelemetry(this.#deps.agent.telemetry, this.#deps.sessionId);
				let compactResult: CompactionResult | undefined;
				let lastError: unknown;
				codexCompaction = createCodexCompactionContext({
					trigger: "auto",
					reason: "context_limit",
					phase:
						options.phase ??
						(reason === "threshold" ? "pre_turn" : reason === "idle" ? "standalone_turn" : "mid_turn"),
				});

				for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex++) {
					const candidate = candidates[candidateIndex];
					const hasMoreCandidates = candidateIndex < candidates.length - 1;
					const apiKey = await this.#deps.modelRegistry.getApiKey(candidate, this.#deps.sessionId);
					if (!apiKey) continue;

					let attempt = 0;
					while (true) {
						try {
							compactResult = await compact(
								this.#obfuscatePreparationForProvider(preparation),
								candidate,
								this.#deps.modelRegistry.resolver(candidate, this.#deps.sessionId),
								undefined,
								autoCompactionSignal,
								{
									promptOverride: this.#deps.obfuscateText(compactionPrep.hookPrompt),
									extraContext: compactionPrep.hookContext,
									remoteInstructions: this.#deps.baseSystemPrompt.join("\n\n"),
									metadata: this.#deps.agent.metadataForProvider(candidate.provider),
									initiatorOverride: "agent",
									convertToLlm: messages => this.#deps.convertToLlmForSideRequest(messages),
									telemetry,
									// Honor the user's /model thinking selection on the
									// auto-compaction path — the most-fired compaction
									// site. Clamped per-model inside compact() via
									// resolveCompactionEffort.
									thinkingLevel: this.#deps.thinkingLevel,
									tools: this.#deps.agent.state.tools,
									sessionId: this.#deps.sessionId,
									promptCacheKey: this.#deps.sessionId,
									providerSessionState: this.#deps.providerSessionState,
									codexCompaction,
								},
							);
							break;
						} catch (error) {
							if (autoCompactionSignal.aborted) {
								throw error;
							}

							const message = error instanceof Error ? error.message : String(error);
							const id = AIError.classify(error, candidate.api);
							if (AIError.is(id, AIError.Flag.AuthFailed)) {
								lastError = this.#buildCompactionAuthError();
								break;
							}
							if (AIError.is(id, AIError.Flag.Timeout)) {
								logger.warn(
									hasMoreCandidates
										? "Auto-compaction summarization timed out, trying next model"
										: "Auto-compaction summarization timed out, not retrying same model",
									{
										error: message,
										model: `${candidate.provider}/${candidate.id}`,
									},
								);
								lastError = error;
								break;
							}

							const retryAfterMs = this.#deps.parseRetryAfterMsFromError(message);
							const shouldRetry =
								retrySettings.enabled &&
								attempt < retrySettings.maxRetries &&
								(retryAfterMs !== undefined ||
									AIError.is(id, AIError.Flag.Transient) ||
									AIError.is(id, AIError.Flag.UsageLimit));
							if (!shouldRetry) {
								lastError = error;
								break;
							}

							const baseDelayMs = retrySettings.baseDelayMs * 2 ** attempt;
							const delayMs = retryAfterMs !== undefined ? Math.max(baseDelayMs, retryAfterMs) : baseDelayMs;

							// If retry delay is too long (>30s), try next candidate instead of waiting
							const maxAcceptableDelayMs = 30_000;
							if (delayMs > maxAcceptableDelayMs && hasMoreCandidates) {
								logger.warn("Auto-compaction retry delay too long, trying next model", {
									delayMs,
									retryAfterMs,
									error: message,
									model: `${candidate.provider}/${candidate.id}`,
								});
								lastError = error;
								break; // Exit retry loop, continue to next candidate
							}

							attempt++;
							logger.warn("Auto-compaction failed, retrying", {
								attempt,
								maxRetries: retrySettings.maxRetries,
								delayMs,
								retryAfterMs,
								error: message,
								model: `${candidate.provider}/${candidate.id}`,
							});
							await scheduler.wait(delayMs, { signal: autoCompactionSignal });
						}
					}

					if (compactResult) {
						break;
					}
				}

				if (!compactResult) {
					if (lastError) {
						throw lastError;
					}
					throw new Error("Compaction failed: no available model");
				}

				summary = compactResult.summary;
				shortSummary = compactResult.shortSummary;
				firstKeptEntryId = compactResult.firstKeptEntryId;
				tokensBefore = compactResult.tokensBefore;
				details = compactResult.details;
				preserveData = mergeLlmCompactionPreserveData(compactionPrep.preserveData, compactResult.preserveData);
			}

			if (autoCompactionSignal.aborted) {
				await this.#deps.emitSessionEvent({
					type: "auto_compaction_end",
					action,
					result: undefined,
					aborted: true,
					willRetry: false,
				});
				return COMPACTION_CHECK_NONE;
			}

			this.#deps.sessionManager.appendCompaction(
				summary,
				shortSummary,
				firstKeptEntryId,
				tokensBefore,
				details,
				fromExtension,
				preserveData,
			);
			const newEntries = this.#deps.sessionManager.getEntries();
			const sessionContext = this.#deps.buildDisplaySessionContext();
			this.#deps.agent.replaceMessages(sessionContext.messages);
			this.#deps.rebasePendingContextSnapshot();
			// Compaction discarded the conversation history that carried the approved
			// plan reference. Clear the sent-flag so #buildPlanReferenceMessage re-reads
			// the plan from disk and re-injects it on the next turn (issue #1246).
			this.#deps.clearPlanReferenceSent();
			this.#deps.resetAdvisorRuntimes();
			this.#deps.syncTodoPhasesFromBranch();
			if (codexCompaction) {
				this.#resetCodexProviderAfterCompaction(codexCompaction);
			} else {
				this.#deps.closeCodexProviderSessionsForHistoryRewrite();
			}

			// Get the saved compaction entry for the hook
			const savedCompactionEntry = newEntries.find(e => e.type === "compaction" && e.summary === summary) as
				| CompactionEntry
				| undefined;

			if (this.#deps.extensionRunner && savedCompactionEntry) {
				await this.#deps.extensionRunner.emit({
					type: "session_compact",
					compactionEntry: savedCompactionEntry,
					fromExtension,
				});
			}

			const result: CompactionResult = {
				summary,
				shortSummary,
				firstKeptEntryId,
				tokensBefore,
				details,
				preserveData,
			};
			// Post-maintenance progress guard — evaluated BEFORE emitting
			// auto_compaction_end so the TUI rebuild triggered by that event
			// already reflects any rescue rewrite (elide / image-drop) and the
			// dead-end warning stamped on the compaction entry. Snapcompact can
			// project over budget and fall back to a context-full summary; the
			// summarizer keeps `keepRecentTokens` of recent history verbatim and
			// findCutPoint can only cut at turn boundaries (never tool results),
			// so a single oversized recent turn (e.g. a huge tool result) leaves
			// the rewritten context still above threshold. Scheduling the
			// continuation regardless means the next agent_end re-enters
			// #checkCompaction over the same oversized tail and re-fires forever.
			// The retry and the threshold auto-continue use different progress
			// tests (a recoverable overflow only has to fit; the auto-continue
			// thrash needs the stricter recovery band), so each branch evaluates
			// its own below.
			let continuationScheduled = false;
			// A non-idle pass that wanted to continue (retry or auto-continue) but freed
			// too little for that path to proceed is a dead-end: warn once so the user
			// understands why maintenance paused instead of silently looping.
			let noProgressDeadEnd = false;
			let retryFits = false;
			let hasHeadroom = false;

			if (willRetry) {
				const messages = this.#deps.agent.state.messages;
				const lastMsg = messages[messages.length - 1];
				if (lastMsg?.role === "assistant") {
					const lastAssistant = lastMsg as AssistantMessage;
					// Drop the prior turn before retry when it carries no actionable deliverable:
					// - "error": failure was kept in history but must not re-enter the next turn's prompt.
					// - reason === "incomplete" && stopReason === "length": truncated output (typically
					//   reasoning-only) — re-running it produces the same dead-end.
					const shouldDrop =
						lastAssistant.stopReason === "error" ||
						(reason === "incomplete" && lastAssistant.stopReason === "length");
					if (shouldDrop) {
						this.#deps.agent.replaceMessages(messages.slice(0, -1));
						this.#deps.rebasePendingContextSnapshot();
					}
				}

				// Retry only needs the rebuilt prompt to fit the window again — measured
				// AFTER the drop above so the just-failed turn (which the retry prompt
				// won't include) is excluded. Reusing the auto-continue recovery band
				// here turned recoverable overflows into manual dead-ends (#3412 review),
				// so use the looser fit budget.
				retryFits = this.#compactionCreatedRetryFit();
				if (!retryFits) {
					retryFits = await this.#rescueCompactionDeadEnd(autoCompactionSignal, {
						skipElide: fallbackFromShake,
						hasProgress: () => this.#compactionCreatedRetryFit(),
					});
				}
				if (!retryFits) {
					noProgressDeadEnd = true;
				}
			} else if (reason !== "idle") {
				// Mirror the shake recovery-band check: only auto-continue when compaction
				// landed residual context under `COMPACTION_RECOVERY_BAND × threshold`.
				// Re-firing on a history that still sits just over the line is the
				// snapcompact thrash, so require genuine headroom, not a bare fit. Even
				// when auto-continue is disabled, a no-headroom threshold pass must still
				// block later automatic continuations (todo reminders/session_stop hooks)
				// from re-entering the same oversized context.
				hasHeadroom = this.#compactionCreatedHeadroom();
				if (!hasHeadroom) {
					hasHeadroom = await this.#rescueCompactionDeadEnd(autoCompactionSignal, {
						skipElide: fallbackFromShake,
						hasProgress: () => this.#compactionCreatedHeadroom(),
					});
				}
				if (!hasHeadroom) {
					noProgressDeadEnd = true;
				}
			}

			const deadEndWarning = noProgressDeadEnd ? compactionDeadEndWarning("clear large tool output") : undefined;
			if (deadEndWarning && savedCompactionEntry) {
				// Stamp the divider: the compaction bar badges the dead-end and
				// carries the full warning in its ctrl+o detail, so the pause
				// stays explained even after the notice row scrolls away.
				savedCompactionEntry.warning = deadEndWarning;
				await this.#deps.sessionManager.rewriteEntries();
			}

			await this.#deps.emitSessionEvent({ type: "auto_compaction_end", action, result, aborted: false, willRetry });

			if (retryFits) {
				this.#deps.scheduleAgentContinue({ delayMs: 100, generation });
				continuationScheduled = true;
			} else if (hasHeadroom && shouldAutoContinue) {
				this.#deps.scheduleAutoContinuePrompt(generation);
				continuationScheduled = true;
			}
			if (!continuationScheduled && !suppressContinuation && this.#deps.agent.hasQueuedMessages()) {
				// Auto-compaction can complete while follow-up/steering/custom messages are waiting.
				// Kick the loop so queued messages are actually delivered. This remains separate
				// from the no-progress warning: pausing maintenance must not strand user input.
				this.#deps.scheduleAgentContinue({
					delayMs: 100,
					generation,
					shouldContinue: () => this.#deps.agent.hasQueuedMessages(),
				});
				continuationScheduled = true;
			}

			if (deadEndWarning) {
				this.#deps.emitNotice("warning", deadEndWarning, "compaction");
			}
			if (continuationScheduled) return COMPACTION_CHECK_CONTINUATION;
			return noProgressDeadEnd ? COMPACTION_CHECK_BLOCK_AUTOMATIC_CONTINUATION : COMPACTION_CHECK_NONE;
		} catch (error) {
			if (autoCompactionSignal.aborted) {
				await this.#deps.emitSessionEvent({
					type: "auto_compaction_end",
					action,
					result: undefined,
					aborted: true,
					willRetry: false,
				});
				return COMPACTION_CHECK_NONE;
			}
			const errorMessage = error instanceof Error ? error.message : "compaction failed";
			await this.#deps.emitSessionEvent({
				type: "auto_compaction_end",
				action,
				result: undefined,
				aborted: false,
				willRetry: false,
				errorMessage:
					reason === "overflow"
						? `Context overflow recovery failed: ${errorMessage}`
						: reason === "incomplete"
							? `Incomplete response recovery failed: ${errorMessage}`
							: `Auto-compaction failed: ${errorMessage}`,
			});
		} finally {
			if (this.#autoCompactionAbortController === autoCompactionAbortController) {
				this.#autoCompactionAbortController = undefined;
			}
		}
		return COMPACTION_CHECK_NONE;
	}

	/**
	 * Run a shake-strategy auto-maintenance pass. Emits the
	 * `auto_compaction_start`/`auto_compaction_end` pair with a shake `action`,
	 * runs {@link shake} inline against the protect-window config, and schedules
	 * continuation exactly like the context-full tail.
	 *
	 * Returns `"fallback"` only for an overflow recovery where shake reclaimed
	 * nothing (or threw) — the caller then runs the summary-compaction body so
	 * the oversized input still gets resolved. Returns `"handled"` otherwise.
	 */
	async #runAutoShake(
		reason: "overflow" | "threshold" | "idle" | "incomplete",
		willRetry: boolean,
		generation: number,
		autoContinue: boolean,
		triggerContextTokens?: number,
		suppressContinuation = false,
	): Promise<CompactionCheckResult | "fallback"> {
		const action = "shake";
		this.#autoCompactionAbortController?.abort();
		const controller = new AbortController();
		this.#autoCompactionAbortController = controller;
		const signal = controller.signal;
		try {
			await this.#deps.emitSessionEvent({ type: "auto_compaction_start", reason, action });
			const result = await this.#deps.shake("elide", { config: DEFAULT_SHAKE_CONFIG, signal });
			if (signal.aborted) {
				await this.#deps.emitSessionEvent({
					type: "auto_compaction_end",
					action,
					result: undefined,
					aborted: true,
					willRetry: false,
				});
				return COMPACTION_CHECK_NONE;
			}
			const reclaimed = result.toolResultsDropped + result.blocksDropped > 0;
			// Detect the dead-loop reported in issues #2119/#2275: the threshold check
			// fires, shake runs, but residual context is still above the configured
			// threshold. The next agent_end would re-trigger shake, which has nothing
			// new to drop on the second pass, so the loop spins until the user kills it.
			// Same hazard for "incomplete" (the retry would re-hit the length cap) and
			// for the existing "overflow + nothing reclaimed" case. In every recovery
			// reason we hand off to the summarization-driven context-full path so the
			// situation actually resolves; "idle" is exempt because its 60s+ timer
			// re-checks usage before re-firing and cannot dead-loop on its own.
			//
			// #2275: the post-shake check MUST stay provider-anchored when caller
			// usage and local estimates diverge. The local estimator undercounts
			// thinking-signature payloads, so thinking-heavy sessions can read well
			// below the provider usage that fired the threshold. Prefer the caller's
			// context figure when supplied, then subtract shake's own savings and add
			// hysteresis (80% recovery band) so we don't oscillate at the boundary.
			// Threshold callers pass the provider-billed trigger after accounting for
			// any supersede/drop-useless pruning that already rewrote the next prompt;
			// without that pre-shake savings, shake can fall through to context-full
			// even though the post-prune history is already inside the recovery band.
			const contextWindow = this.#deps.model?.contextWindow ?? 0;
			const compactionSettings = this.#deps.settings.getGroup("compaction");
			let stillOverThreshold = false;
			if (contextWindow > 0) {
				if (typeof triggerContextTokens === "number" && Number.isFinite(triggerContextTokens)) {
					const correctedTokens = Math.max(0, triggerContextTokens - result.tokensFreed);
					const thresholdTokens = resolveThresholdTokens(contextWindow, compactionSettings);
					const recoveryBand = Math.floor(thresholdTokens * COMPACTION_RECOVERY_BAND);
					stillOverThreshold = correctedTokens > recoveryBand;
				} else {
					const postShakeTokens = this.#deps.getContextUsage({ contextWindow })?.tokens ?? 0;
					stillOverThreshold = shouldCompact(postShakeTokens, contextWindow, compactionSettings);
				}
			}
			const shouldFallBack = reason !== "idle" && ((reason === "overflow" && !reclaimed) || stillOverThreshold);
			if (shouldFallBack) {
				const errorMessage = reclaimed
					? `Auto-shake reclaimed ~${result.tokensFreed} tokens but context is still above the threshold; falling back to context-full compaction.`
					: "Auto-shake found nothing eligible to drop; falling back to context-full compaction.";
				await this.#deps.emitSessionEvent({
					type: "auto_compaction_end",
					action,
					result: undefined,
					aborted: false,
					willRetry: false,
					skipped: !reclaimed,
					errorMessage,
				});
				return "fallback";
			}
			await this.#deps.emitSessionEvent({
				type: "auto_compaction_end",
				action,
				result: undefined,
				aborted: false,
				willRetry,
				skipped: !reclaimed,
			});

			let continuationScheduled = false;
			if (!willRetry && reason !== "idle" && autoContinue) {
				this.#deps.scheduleAutoContinuePrompt(generation);
				continuationScheduled = true;
			}
			if (willRetry) {
				// The shake rebuild replays every entry, so a trailing error/length
				// assistant from the failed turn re-enters agent state — drop it before
				// retrying, same as the context-full tail.
				const messages = this.#deps.agent.state.messages;
				const lastMsg = messages[messages.length - 1];
				if (lastMsg?.role === "assistant") {
					const lastAssistant = lastMsg as AssistantMessage;
					const shouldDrop =
						lastAssistant.stopReason === "error" ||
						(reason === "incomplete" && lastAssistant.stopReason === "length");
					if (shouldDrop) this.#deps.agent.replaceMessages(messages.slice(0, -1));
				}
				this.#deps.scheduleAgentContinue({ delayMs: 100, generation });
				continuationScheduled = true;
			} else if (!suppressContinuation && this.#deps.agent.hasQueuedMessages()) {
				this.#deps.scheduleAgentContinue({
					delayMs: 100,
					generation,
					shouldContinue: () => this.#deps.agent.hasQueuedMessages(),
				});
				continuationScheduled = true;
			}
			if (!reclaimed) {
				return willRetry && continuationScheduled
					? { ...COMPACTION_CHECK_CONTINUATION, historyRewritten: true }
					: continuationScheduled
						? COMPACTION_CHECK_CONTINUATION
						: COMPACTION_CHECK_NONE;
			}
			return {
				...(continuationScheduled ? COMPACTION_CHECK_CONTINUATION : COMPACTION_CHECK_NONE),
				historyRewritten: true,
			};
		} catch (error) {
			if (signal.aborted) {
				await this.#deps.emitSessionEvent({
					type: "auto_compaction_end",
					action,
					result: undefined,
					aborted: true,
					willRetry: false,
				});
				return COMPACTION_CHECK_NONE;
			}
			const message = error instanceof Error ? error.message : "shake failed";
			await this.#deps.emitSessionEvent({
				type: "auto_compaction_end",
				action,
				result: undefined,
				aborted: false,
				willRetry: false,
				errorMessage: message,
				skipped: false,
			});
			// Overflow still needs recovery even if shake threw.
			return reason === "overflow" ? "fallback" : COMPACTION_CHECK_NONE;
		} finally {
			if (this.#autoCompactionAbortController === controller) {
				this.#autoCompactionAbortController = undefined;
			}
		}
	}

	/**
	 * Toggle auto-compaction setting.
	 */
	setAutoCompactionEnabled(enabled: boolean): void {
		this.#deps.settings.set("compaction.enabled", enabled);
		if (enabled && isCompactionStrategyOff(this.#deps.settings.get("compaction.strategy") as string)) {
			this.#deps.settings.override("compaction.strategy", getDefault("compaction.strategy"));
		}
	}

	/** Whether auto-compaction is enabled */
	get autoCompactionEnabled(): boolean {
		const compaction = this.#deps.settings.getGroup("compaction");
		return !isThresholdCompactionDisabled(compaction.enabled, compaction.strategy);
	}
}
