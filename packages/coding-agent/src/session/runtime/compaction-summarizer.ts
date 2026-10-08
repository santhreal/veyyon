/**
 * The summary request of a compaction: the server-side attempt, the candidate chain with its
 * per-candidate retries, the inputs extension hooks and the memory backend add to the request, and
 * the memos a session keeps between passes: the candidates whose summary ran in stages, the staged
 * requests a failed pass completed, the fallback and server-side notices already emitted, and the
 * payload gap the dead-end rescue sizes its cut from.
 *
 * This is a compaction collaborator. `CompactionRuntime` runs the pass and records its result; this
 * produces the summary, and reaches the session through {@link CompactionSummarizerSession} and
 * {@link CompactionSummarizerHost}.
 */
import { scheduler } from "node:timers/promises";
import { type Agent, type AgentMessage, resolveTelemetry, type ThinkingLevel } from "@veyyon/agent-core";
import {
	type CompactionPreparation,
	type CompactionResult,
	compact,
	compactWithProvider,
	estimateCompactionRequestTokens,
	resolveServerCompactionTransport,
	type SummaryOptions,
	serverCompactionRouteAbsent,
} from "@veyyon/agent-core/compaction";
import { modelServesPrefixCacheHits } from "@veyyon/agent-core/compaction/cache-aligned-context";
import type { CodexCompactionContext, Message, Model, ProviderSessionState, ServiceTier } from "@veyyon/ai";
import * as AIError from "@veyyon/ai/error";
import type { SideCompleteImpl } from "@veyyon/kernel/session/side-complete";
import { errorMessage, exponentialBackoffDelay, extractRetryHint, logger } from "@veyyon/utils";
import type { ModelRegistry } from "../../config/model-registry";
import type { Settings } from "../../config/settings";
import type { ExtensionRunner } from "../../extensibility/extensions";
import { compactionModelCandidates, configuredCompactionEfforts, modelKey } from "../agent-session-model-targets";
import type { SessionSecrets } from "./session-secrets";

/** What {@link CompactionSummarizer} reads from the session's public surface. */
export interface CompactionSummarizerSession {
	readonly agent: Agent;
	readonly settings: Settings;
	readonly modelRegistry: ModelRegistry;
	readonly model: Model | undefined;
	readonly thinkingLevel: ThinkingLevel | undefined;
	readonly sessionId: string;
	readonly extensionRunner: ExtensionRunner | undefined;
	readonly sideComplete: SideCompleteImpl;
	emitNotice(level: "info" | "warning" | "error", message: string, source?: string): void;
	obfuscateProviderText(text: string): string;
	convertMessagesToLlm(messages: AgentMessage[], signal?: AbortSignal): Promise<Message[]>;
}

/** What {@link CompactionSummarizer} needs from the session beyond its public surface. */
export interface CompactionSummarizerHost {
	secrets(): SessionSecrets;
	/** Convert messages for a side request and redact them for the provider. */
	convertToLlmForSideRequest(messages: AgentMessage[]): Message[];
	providerSessionState(): Map<string, ProviderSessionState>;
	/** The service tier selected for the model's family. */
	effectiveServiceTier(model: Model): ServiceTier | undefined;
	/** The session's system prompt before per-turn extension changes. */
	baseSystemPrompt(): string[];
	/** The active memory backend's extra summary context, or undefined. */
	memoryBackendContext(preparation: CompactionPreparation): Promise<string | undefined>;
}

/** What `session_compacting` handlers and the memory backend add to a summary request. */
export interface CompactionHookInputs {
	hookPrompt: string | undefined;
	hookContext: string[] | undefined;
}

/** A compaction a `session_before_compact` handler supplied, or the inputs a summary request carries. */
export type CompactionHookPreparation =
	| {
			kind: "fromHook";
			summary: string;
			shortSummary: string | undefined;
			firstKeptEntryId: string;
			tokensBefore: number;
			details: unknown;
			preserveData: Record<string, unknown> | undefined;
	  }
	| ({ kind: "needsLlm"; preserveData: Record<string, unknown> | undefined } & CompactionHookInputs);

/**
 * A candidate's failure, attributed to the candidate that produced it.
 *
 * The auto path tries several models and surfaces only the last error, so a
 * provider-specific fault ("402 You have depleted your monthly included
 * credits") reached the operator with nothing naming WHICH provider billed
 * them. On a session running a different provider that reads as a lie. The
 * provider's own text stays verbatim after the name so every classifier and
 * matcher still sees it, and the original is kept as `cause`.
 */
function compactionCandidateError(candidate: Model, error: unknown): Error {
	return new Error(`${modelKey(candidate)}: ${errorMessage(error)}`, { cause: error });
}

export class CompactionSummarizer {
	readonly #session: CompactionSummarizerSession;
	readonly #host: CompactionSummarizerHost;
	/** Compaction-fallback notices already emitted this session, keyed by their text. */
	#announcedCompactionFallbacks = new Set<string>();
	/** Server-side compaction failure notices already emitted, keyed by error text. */
	#announcedServerCompactionFailures = new Set<string>();
	/**
	 * Compaction candidates whose single-request summary was superseded by a
	 * staged one this session. The next compaction on such a model starts staged
	 * instead of paying the single request's timeout again.
	 */
	#stagedSummaryModels = new Set<string>();
	/**
	 * Staged-summary requests that completed during a compaction that then failed,
	 * so the retry resumes where it stopped instead of re-sending every segment.
	 * Cleared whenever a summary is produced.
	 */
	#stagedSummaryCheckpoints = new Map<string, string>();
	/**
	 * Tokens the last compaction's summarization payload exceeded the widest
	 * candidate window by, or `undefined` when no candidate was skipped for size.
	 * The dead-end rescue reduces to this, because a payload no candidate can
	 * accept means no summary is ever attempted and cutting to the model's own
	 * threshold bar frees too little to change that.
	 */
	#compactionPayloadGapTokens: number | undefined;

	constructor(session: CompactionSummarizerSession, host: CompactionSummarizerHost) {
		this.#session = session;
		this.#host = host;
	}

	/**
	 * Tokens the last automatic pass's summarization payload exceeded the widest candidate window
	 * by, or `undefined` when no candidate was skipped for size.
	 */
	get payloadGapTokens(): number | undefined {
		return this.#compactionPayloadGapTokens;
	}

	/**
	 * Forget the payload gap at the start of an automatic pass: a gap an earlier compaction recorded
	 * says nothing about this history, and carrying it forward would over-cut a session that fits.
	 */
	forgetPayloadGap(): void {
		this.#compactionPayloadGapTokens = undefined;
	}

	/**
	 * Summarize for `/compact`: server-side compaction when the session model supports it and the
	 * setting is on, otherwise the first candidate that is authenticated and whose window holds the
	 * payload.
	 */
	async summarizeManual(
		preparation: CompactionPreparation,
		customInstructions: string | undefined,
		hooks: CompactionHookInputs,
		codexCompaction: CodexCompactionContext,
		candidates: Model[],
		signal: AbortSignal,
	): Promise<CompactionResult> {
		const remote = await this.#tryServerSideCompaction(preparation, customInstructions, signal, {
			promptOverride: this.#host.secrets().obfuscateTextForProvider(hooks.hookPrompt),
			extraContext: hooks.hookContext,
			remoteInstructions: this.#host.baseSystemPrompt().join("\n\n"),
			codexCompaction,
		});
		if (remote) return remote;
		return this.#compactWithFallbackModel(
			preparation,
			customInstructions,
			signal,
			{
				// Resolved again after the server-side await: a secret-runtime refresh may have landed.
				promptOverride: this.#host.secrets().obfuscateTextForProvider(hooks.hookPrompt),
				extraContext: hooks.hookContext,
				remoteInstructions: this.#host.baseSystemPrompt().join("\n\n"),
				convertToLlm: messages => this.#host.convertToLlmForSideRequest(messages),
				obfuscateProviderText: text => this.#session.obfuscateProviderText(text),
				codexCompaction,
			},
			candidates,
		);
	}

	/**
	 * The live provider prefix a cache-aligned compaction request replays, or
	 * `undefined` when replaying it would not hit the provider's cache.
	 *
	 * WHY IT REBUILDS THE PREFIX RATHER THAN READING `agent.state`. The hit is a
	 * byte comparison the provider performs, so the replayed blocks have to be the
	 * ones the live turn actually sent. `state.messages` are agent messages, before
	 * the pre-LLM transform, the obfuscation seam and provider normalization, and
	 * `state.tools` is the unnormalized catalog. `convertMessagesToLlm` +
	 * `buildSideRequestContext` produce the bytes the loop produces, the same pair
	 * the handoff and `/btw` side requests already use to share this cache.
	 *
	 * WHY THE MODEL MUST MATCH. Prompt caches are per model. A compaction candidate
	 * that is not the live session model has no populated prefix to read, so
	 * replaying the whole window there is pure fresh input, strictly worse than
	 * the truncated request it would have replaced.
	 */
	async #cacheAlignedCompactionPrefix(
		candidate: Model,
		signal?: AbortSignal,
	): Promise<Pick<SummaryOptions, "sessionSystemPrompt" | "sessionMessages" | "tools"> | undefined> {
		const sessionModel = this.#session.model;
		if (!sessionModel || modelKey(sessionModel) !== modelKey(candidate)) return undefined;
		if (!modelServesPrefixCacheHits(candidate)) return undefined;
		const llmMessages = await this.#session.convertMessagesToLlm(this.#session.agent.state.messages.slice(), signal);
		const context = await this.#session.agent.buildSideRequestContext(llmMessages);
		if (!context.systemPrompt?.length || context.messages.length === 0) return undefined;
		return { sessionSystemPrompt: context.systemPrompt, sessionMessages: context.messages, tools: context.tools };
	}

	#buildCompactionAuthError(): Error {
		const currentModel = this.#session.model;
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

	/**
	 * Remember a candidate whose summary was produced in stages, so the next
	 * compaction on it does not first wait out the single request that never
	 * answers. A single-stage result clears the memo: the model answered as one
	 * request again, so staging is no longer forced.
	 */
	#recordSummaryStaging(candidate: Model, result: CompactionResult): void {
		this.#stagedSummaryCheckpoints.clear();
		if (result.summaryStages === undefined) return;
		const key = modelKey(candidate);
		if (result.summaryStages > 1) this.#stagedSummaryModels.add(key);
		else this.#stagedSummaryModels.delete(key);
	}

	/**
	 * Say so when compaction ran on anything other than the first candidate.
	 *
	 * A chain that quietly lands three models down is worse than no chain: the
	 * summary that shapes the rest of the session was written by a model the user
	 * did not expect, at a quality they did not choose, and the only trace of it
	 * used to be a `debug` line nobody reads. Reported once per (from, to, reason)
	 * so a session that fails over on every compaction says it once rather than
	 * on every compaction.
	 */
	#announceCompactionFallback(candidates: Model[], used: Model, skipReasons: Map<string, string>): void {
		const first = candidates[0];
		if (!first || modelKey(first) === modelKey(used)) return;
		const reason = skipReasons.get(modelKey(first)) ?? "it could not run the summary";
		const message = `Compacted with ${used.provider}/${used.id}. ${first.provider}/${first.id} was skipped: ${reason}.`;
		if (this.#announcedCompactionFallbacks.has(message)) return;
		this.#announcedCompactionFallbacks.add(message);
		this.#session.emitNotice("warning", message, "compaction");
	}

	/**
	 * OpenAI server-side (remote) compaction attempt, or undefined when the
	 * ordinary local path should run. Applies when `compaction.remote` is on and
	 * the SESSION model resolves a transport from its capability data: the
	 * OpenAI Responses api family (Azure Responses deployments included) plus
	 * `compat.supportsServerCompaction` on the row. Never a provider-name check,
	 * and never a configured compaction model, because the provider compacts
	 * server-side and `compaction.model` cannot apply to that.
	 * The result is single-window. The window the provider returns IS the
	 * compacted artifact, so the result carries an empty `summary` and the
	 * window under `REMOTE_COMPACTION_PRESERVE_KEY` (see
	 * remote-compaction-entry.ts). That
	 * empty summary is correct, not a placeholder and not a half-built
	 * dual-write: writing a local summary beside the window was rejected,
	 * because it would pay a model to re-summarize a span OpenAI already
	 * compacted and leave two versions of one range that can disagree. Rebuild,
	 * fork, and resume stay correct with one artifact because the entries the
	 * window stands in for are still on disk, and a context that cannot replay
	 * the window re-expands them (see session-context.ts).
	 * A failed attempt warns once per distinct failure and returns
	 * undefined so the caller falls through to the local candidate loop:
	 * compaction is the recovery path for context overflow and must not fail
	 * closed on a transport error.
	 */
	async #tryServerSideCompaction(
		preparation: CompactionPreparation,
		customInstructions: string | undefined,
		signal: AbortSignal,
		options: SummaryOptions,
	): Promise<CompactionResult | undefined> {
		if (this.#session.settings.get("compaction.remote") !== true) return undefined;
		const model = this.#session.model;
		if (!model) return undefined;
		// One fact, one announcement. The 404 arrives as a thrown transport
		// error on the compaction that sees it and as a resolved-nothing on
		// every compaction after, and the two used to be keyed by their own
		// wording, so the operator was told the route was gone twice.
		const routeAbsentKey = `no-compaction-route:${model.provider}/${model.id}`;
		if (!resolveServerCompactionTransport(model)) {
			// A model that never supported this is inert and stays quiet. One
			// whose route answered 404 is a downgrade away from what the operator
			// configured, so it is said once — here when the stand-down was
			// learned before this session, and from the catch below when this
			// session is the one that saw the 404.
			if (serverCompactionRouteAbsent(model) && !this.#announcedServerCompactionFailures.has(routeAbsentKey)) {
				this.#announcedServerCompactionFailures.add(routeAbsentKey);
				logger.warn("Server-side compaction unavailable, falling back to local compaction", {
					reason: `${model.provider}/${model.id} has no compaction route (404)`,
				});
				this.#session.emitNotice(
					"warning",
					`Server-side compaction unavailable (${model.provider}/${model.id} has no compaction route (404)); compacting locally for the rest of this session.`,
					"compaction",
				);
			}
			return undefined;
		}
		const apiKey = await this.#session.modelRegistry.getApiKey(model, this.#session.sessionId);
		if (!apiKey) {
			// The loader announced a remote pass from the sync half of this gate;
			// a missing credential must not downgrade to a local pass silently.
			const message = `no API key for ${model.provider}/${model.id}`;
			logger.warn("Server-side compaction unavailable, falling back to local compaction", { reason: message });
			if (!this.#announcedServerCompactionFailures.has(message)) {
				this.#announcedServerCompactionFailures.add(message);
				this.#session.emitNotice(
					"warning",
					`Server-side compaction unavailable (${message}); falling back to local compaction.`,
					"compaction",
				);
			}
			return undefined;
		}
		try {
			return await compactWithProvider(
				this.#host.secrets().obfuscatePreparationForProvider(preparation),
				model,
				this.#session.modelRegistry.resolver(model, this.#session.sessionId),
				this.#host.secrets().obfuscateTextForProvider(customInstructions),
				signal,
				{
					...options,
					metadata: this.#session.agent.metadataForProvider(model.provider),
					convertToLlm: messages => this.#host.convertToLlmForSideRequest(messages),
					telemetry: resolveTelemetry(this.#session.agent.telemetry, this.#session.sessionId),
					thinkingLevel: this.#session.thinkingLevel,
					tools: this.#session.agent.state.tools,
					sessionId: this.#session.sessionId,
					promptCacheKey: this.#session.agent.promptCacheKey ?? this.#session.sessionId,
					providerSessionState: this.#host.providerSessionState(),
					obfuscateProviderText: text => this.#session.obfuscateProviderText(text),
				},
			);
		} catch (error) {
			if (signal.aborted) throw error;
			const message = errorMessage(error);
			logger.warn("Server-side compaction failed, falling back to local compaction", {
				error: message,
				model: `${model.provider}/${model.id}`,
			});
			if (!this.#announcedServerCompactionFailures.has(message)) {
				this.#announcedServerCompactionFailures.add(message);
				// A 404 is the same fact the stand-down branch reports on every
				// later compaction; claim its key here so it is not said twice.
				if (serverCompactionRouteAbsent(model)) this.#announcedServerCompactionFailures.add(routeAbsentKey);
				// The thrown message already states what failed, so prefixing it
				// here produced "Server-side compaction failed (Server-side
				// compaction failed (404 Not Found))".
				this.#session.emitNotice("warning", `${message}; falling back to local compaction.`, "compaction");
			}
			return undefined;
		}
	}

	async #compactWithFallbackModel(
		preparation: CompactionPreparation,
		customInstructions: string | undefined,
		signal: AbortSignal,
		options: SummaryOptions,
		candidates: Model[],
	): Promise<CompactionResult> {
		const telemetry = resolveTelemetry(this.#session.agent.telemetry, this.#session.sessionId);
		// Per-candidate effort configured on `compaction.model` (its `:level`
		// suffix). A candidate without an explicit level uses the session effort.
		const configuredEffortByModel = configuredCompactionEfforts(
			this.#session.settings,
			this.#session.modelRegistry.getAvailable(),
		);

		// Effective window of the model RUNNING the compaction. The payload was
		// sized against the MAIN model's threshold, so a compaction model with a
		// smaller window would overflow mid-compact; skip those candidates loudly
		// instead. compaction.modelContextWindow (unset = candidate's own metadata)
		// overrides for proxies that serve a different window than advertised.
		const configuredCompactionWindow = this.#session.settings.get("compaction.modelContextWindow");
		let summarizePayloadTokens = 0;
		let skippedForWindow = 0;
		// Why each earlier candidate was passed over, so landing further down the
		// chain can be reported with the reason rather than as a silent swap.
		const skipReasons = new Map<string, string>();

		for (const candidate of candidates) {
			const cachePrefix = await this.#cacheAlignedCompactionPrefix(candidate, signal);
			const candidateOptions: SummaryOptions = cachePrefix ? { ...options, ...cachePrefix } : options;
			summarizePayloadTokens = estimateCompactionRequestTokens(
				preparation,
				candidate,
				customInstructions,
				candidateOptions,
			);
			const candidateWindow =
				typeof configuredCompactionWindow === "number" && configuredCompactionWindow > 0
					? configuredCompactionWindow
					: (candidate.contextWindow ?? 0);
			if (candidateWindow > 0 && summarizePayloadTokens > candidateWindow) {
				skippedForWindow++;
				skipReasons.set(
					modelKey(candidate),
					`its context window holds ${candidateWindow} tokens and the summary needed ${summarizePayloadTokens}`,
				);
				logger.warn("compaction candidate skipped: summarization payload exceeds its context window", {
					candidate: `${candidate.provider}/${candidate.id}`,
					candidateWindow,
					summarizePayloadTokens,
				});
				continue;
			}
			const apiKey = await this.#session.modelRegistry.getApiKey(candidate, this.#session.sessionId);
			if (!apiKey) {
				skipReasons.set(modelKey(candidate), "it is not authenticated");
				continue;
			}

			try {
				const compacted = await compact(
					this.#host.secrets().obfuscatePreparationForProvider(preparation),
					candidate,
					this.#session.modelRegistry.resolver(candidate, this.#session.sessionId),
					this.#host.secrets().obfuscateTextForProvider(customInstructions),
					signal,
					{
						...candidateOptions,
						metadata: this.#session.agent.metadataForProvider(candidate.provider),
						convertToLlm: messages => this.#host.convertToLlmForSideRequest(messages),
						telemetry,
						// Effort configured on this compaction candidate wins; otherwise
						// honor the user's /model thinking selection (incl. `off`).
						// Clamped per-model inside compact() via resolveCompactionEffort
						// so unsupported-effort models (xai-oauth/grok-4.20-0309-reasoning) do not trip
						// requireSupportedEffort.
						thinkingLevel: configuredEffortByModel.get(modelKey(candidate)) ?? this.#session.thinkingLevel,
						tools: cachePrefix?.tools ?? this.#session.agent.state.tools,
						sessionId: this.#session.sessionId,
						// Providers route on `promptCacheKey ?? sessionId`, and the live
						// loop sends the agent's pinned key when it has one (fork, tan,
						// shared session). Mirror it so the summarization request reads
						// the prefix the turns populated instead of cold-missing it.
						promptCacheKey: this.#session.agent.promptCacheKey ?? this.#session.sessionId,
						providerSessionState: this.#host.providerSessionState(),
						// Resolve the current runtime inside the callback. compact()
						// invokes it after each credential await and immediately
						// before every local or remote physical attempt.
						obfuscateProviderText: text => this.#session.obfuscateProviderText(text),
						// Route every summarization HTTP request through the
						// session's side-stream transport so the provider
						// concurrency cap (e.g. providers.ollama-cloud.maxConcurrency)
						// brackets compaction the same way it brackets the live
						// agent turn — without this, multiple ollama-cloud
						// agents auto/manually compacting issued uncapped
						// summary requests in parallel (chatgpt-codex review on
						// #3751).
						completeImpl: this.#session.sideComplete,
						// Compaction sends the largest payload of the session. Without
						// the tier the operator selected for this candidate's family,
						// that request is billed and paced on a tier they never chose.
						serviceTier: this.#host.effectiveServiceTier(candidate),
						summaryStaging: this.#stagedSummaryModels.has(modelKey(candidate)) ? "staged" : undefined,
						stagedSummaryCheckpoints: this.#stagedSummaryCheckpoints,
					},
				);
				this.#recordSummaryStaging(candidate, compacted);
				this.#announceCompactionFallback(candidates, candidate, skipReasons);
				return compacted;
			} catch (error) {
				if (!AIError.is(AIError.classify(error, candidate.api), AIError.Flag.AuthFailed)) {
					throw error;
				}
				skipReasons.set(modelKey(candidate), "its credentials were rejected");
			}
		}

		if (skippedForWindow > 0 && skippedForWindow === candidates.length) {
			throw new Error(
				`Compaction failed: the summarization payload (~${summarizePayloadTokens} tokens) exceeds the context window of every compaction candidate. ` +
					`Raise compaction.modelContextWindow only if your provider really serves a larger window, pick a larger compaction.model, or lower compaction.threshold so compaction runs earlier.`,
			);
		}
		throw this.#buildCompactionAuthError();
	}

	/**
	 * What `session_compacting` handlers and the memory backend add to the summary request, or the
	 * compaction a `session_before_compact` handler supplied in its place.
	 */
	async prepareCompactionFromHooks(
		preparation: CompactionPreparation,
		hookCompaction: CompactionResult | undefined,
	): Promise<CompactionHookPreparation> {
		let hookContext: string[] | undefined;
		let hookPrompt: string | undefined;
		let preserveData: Record<string, unknown> | undefined;

		if (!hookCompaction && this.#session.extensionRunner?.hasHandlers("session_compacting")) {
			const compactMessages = preparation.messagesToSummarize.concat(preparation.turnPrefixMessages);
			const result = (await this.#session.extensionRunner.emit({
				type: "session_compacting",
				sessionId: this.#session.sessionId,
				messages: compactMessages,
			})) as { context?: string[]; prompt?: string; preserveData?: Record<string, unknown> } | undefined;

			// The hook may have awaited arbitrary extension work. Sanitize its
			// raw text as soon as control returns, before any later formatting.
			hookContext = result?.context?.map(
				context => this.#host.secrets().obfuscateTextForProvider(context) ?? context,
			);
			hookPrompt = this.#host.secrets().obfuscateTextForProvider(result?.prompt);
			preserveData = result?.preserveData;
		}

		const memoryBackendContext = await this.#host.memoryBackendContext(preparation);
		if (memoryBackendContext) {
			// Memory backends are async and can race a secret-runtime refresh.
			// Resolve the authoritative runtime only after their await completes.
			const providerContext =
				this.#host.secrets().obfuscateTextForProvider(memoryBackendContext) ?? memoryBackendContext;
			hookContext = hookContext ? [...hookContext, providerContext] : [providerContext];
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
	 * Summarize for an automatic pass: server-side compaction when the session
	 * model supports it and the setting is on, otherwise each compaction
	 * candidate in turn.
	 *
	 * The payload was sized against the MAIN model's threshold, so a candidate
	 * whose window cannot hold it overflows mid-compact. The manual path has
	 * always skipped those candidates loudly (see #compactWithFallbackModel);
	 * this one did not, and it is the path that fires unattended on every
	 * threshold crossing and every overflow recovery. Sending a request the
	 * window provably cannot hold buys a guaranteed failure, and then the next
	 * candidate pays for the same span again. `compaction.modelContextWindow`
	 * (unset = the candidate's own metadata) overrides for proxies serving a
	 * window they do not advertise.
	 */
	async summarizeForAutoCompaction(
		preparation: CompactionPreparation,
		hooks: CompactionHookInputs,
		codexCompaction: CodexCompactionContext,
		availableModels: Model[],
		signal: AbortSignal,
	): Promise<CompactionResult> {
		const candidates = compactionModelCandidates(this.#session.settings, this.#session.model, availableModels);
		// Per-candidate effort configured on `compaction.model` (its `:level`
		// suffix). A candidate without an explicit level uses the session effort.
		const configuredEffortByModel = configuredCompactionEfforts(this.#session.settings, availableModels);
		const telemetry = resolveTelemetry(this.#session.agent.telemetry, this.#session.sessionId);

		const remote = await this.#tryServerSideCompaction(preparation, undefined, signal, {
			promptOverride: this.#host.secrets().obfuscateTextForProvider(hooks.hookPrompt),
			extraContext: hooks.hookContext,
			remoteInstructions: this.#host.baseSystemPrompt().join("\n\n"),
			initiatorOverride: "agent",
			codexCompaction,
		});
		if (remote) return remote;

		const configuredCompactionWindow = this.#session.settings.get("compaction.modelContextWindow");
		// Why each candidate before the one that ran was passed over, so the
		// unattended path can name the swap the way the manual path does.
		const skipReasons = new Map<string, string>();
		let lastError: unknown;
		for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex++) {
			const candidate = candidates[candidateIndex];
			const apiKey = await this.#session.modelRegistry.getApiKey(candidate, this.#session.sessionId);
			if (!apiKey) {
				skipReasons.set(modelKey(candidate), "it is not authenticated");
				continue;
			}
			const cachePrefix = await this.#cacheAlignedCompactionPrefix(candidate, signal);
			const candidateOptions: SummaryOptions = {
				promptOverride: this.#host.secrets().obfuscateTextForProvider(hooks.hookPrompt),
				extraContext: hooks.hookContext,
				remoteInstructions: this.#host.baseSystemPrompt().join("\n\n"),
				metadata: this.#session.agent.metadataForProvider(candidate.provider),
				initiatorOverride: "agent",
				convertToLlm: messages => this.#host.convertToLlmForSideRequest(messages),
				telemetry,
				// Effort configured on this compaction candidate wins;
				// otherwise honor the user's /model thinking selection.
				// The most-fired compaction site. Clamped per-model
				// inside compact() via resolveCompactionEffort.
				thinkingLevel: configuredEffortByModel.get(modelKey(candidate)) ?? this.#session.thinkingLevel,
				sessionSystemPrompt: cachePrefix?.sessionSystemPrompt,
				sessionMessages: cachePrefix?.sessionMessages,
				tools: cachePrefix?.tools ?? this.#session.agent.state.tools,
				sessionId: this.#session.sessionId,
				// Same routing rule as the manual-compaction call site:
				// mirror the pinned key the live turns cached under.
				promptCacheKey: this.#session.agent.promptCacheKey ?? this.#session.sessionId,
				providerSessionState: this.#host.providerSessionState(),
				obfuscateProviderText: text => this.#session.obfuscateProviderText(text),
				codexCompaction,
				completeImpl: this.#session.sideComplete,
				serviceTier: this.#host.effectiveServiceTier(candidate),
				summaryStaging: this.#stagedSummaryModels.has(modelKey(candidate)) ? "staged" : undefined,
				stagedSummaryCheckpoints: this.#stagedSummaryCheckpoints,
			};
			const candidateWindow =
				typeof configuredCompactionWindow === "number" && configuredCompactionWindow > 0
					? configuredCompactionWindow
					: (candidate.contextWindow ?? 0);
			const summarizePayloadTokens = estimateCompactionRequestTokens(
				preparation,
				candidate,
				undefined,
				candidateOptions,
			);
			if (candidateWindow > 0 && summarizePayloadTokens > candidateWindow) {
				logger.warn("compaction candidate skipped: summarization payload exceeds its context window", {
					candidate: `${candidate.provider}/${candidate.id}`,
					candidateWindow,
					summarizePayloadTokens,
				});
				skipReasons.set(
					modelKey(candidate),
					`its context window holds ${candidateWindow} tokens and the summary needed ${summarizePayloadTokens}`,
				);
				// Keep a real reason for the failure when every candidate is
				// skipped this way. A provider error from a later candidate
				// still overwrites it.
				lastError ??= new Error(
					`Compaction failed: ${candidate.provider}/${candidate.id} holds ${candidateWindow} tokens and the summary needed ${summarizePayloadTokens}.`,
				);
				// What the rescue has to free for ANY candidate to summarize at
				// all. The smallest gap across skipped candidates is the widest
				// window on offer, so cutting to it reopens the cheapest
				// candidate rather than the largest one.
				this.#compactionPayloadGapTokens = Math.min(
					this.#compactionPayloadGapTokens ?? Number.POSITIVE_INFINITY,
					summarizePayloadTokens - candidateWindow,
				);
				continue;
			}

			const attempt = await this.#compactCandidateWithRetries(
				preparation,
				candidate,
				candidateOptions,
				signal,
				candidateIndex < candidates.length - 1,
			);
			if ("result" in attempt) {
				this.#recordSummaryStaging(candidate, attempt.result);
				this.#announceCompactionFallback(candidates, candidate, skipReasons);
				return attempt.result;
			}
			skipReasons.set(modelKey(candidate), attempt.skipReason);
			lastError = attempt.error;
		}

		if (lastError) {
			throw lastError;
		}
		throw new Error("Compaction failed: no available model");
	}

	/**
	 * Run one compaction candidate, retrying a transient or rate-limited failure
	 * with backoff.
	 *
	 * A failure is returned rather than thrown so the caller moves on to the
	 * next candidate; only an abort is thrown. A retry wait over 30s moves on
	 * too while another candidate is left.
	 */
	async #compactCandidateWithRetries(
		preparation: CompactionPreparation,
		candidate: Model,
		candidateOptions: SummaryOptions,
		signal: AbortSignal,
		hasMoreCandidates: boolean,
	): Promise<{ result: CompactionResult } | { error: Error; skipReason: string }> {
		const retrySettings = this.#session.settings.getGroup("retry");
		const maxAcceptableDelayMs = 30_000;
		let attempt = 0;
		while (true) {
			try {
				return {
					result: await compact(
						this.#host.secrets().obfuscatePreparationForProvider(preparation),
						candidate,
						this.#session.modelRegistry.resolver(candidate, this.#session.sessionId),
						undefined,
						signal,
						candidateOptions,
					),
				};
			} catch (error) {
				if (signal.aborted) {
					throw error;
				}

				const message = errorMessage(error);
				const skipReason = `it failed: ${message}`;
				const id = AIError.classify(error, candidate.api);
				if (AIError.is(id, AIError.Flag.AuthFailed)) {
					return { error: this.#buildCompactionAuthError(), skipReason };
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
					return { error: compactionCandidateError(candidate, error), skipReason };
				}

				const retryAfterMs = extractRetryHint(undefined, message);
				const shouldRetry =
					retrySettings.enabled &&
					attempt < retrySettings.maxRetries &&
					(retryAfterMs !== undefined ||
						AIError.is(id, AIError.Flag.Transient) ||
						AIError.is(id, AIError.Flag.UsageLimit));
				if (!shouldRetry) {
					return { error: compactionCandidateError(candidate, error), skipReason };
				}

				// Bounded by `retry.maxRetries`; the schedule is uncapped so a configured base keeps its full ladder.
				const baseDelayMs = exponentialBackoffDelay(attempt, {
					baseMs: retrySettings.baseDelayMs,
					maxMs: Number.POSITIVE_INFINITY,
					jitter: 0,
				});
				const delayMs = retryAfterMs !== undefined ? Math.max(baseDelayMs, retryAfterMs) : baseDelayMs;
				if (delayMs > maxAcceptableDelayMs && hasMoreCandidates) {
					logger.warn("Auto-compaction retry delay too long, trying next model", {
						delayMs,
						retryAfterMs,
						error: message,
						model: `${candidate.provider}/${candidate.id}`,
					});
					return { error: compactionCandidateError(candidate, error), skipReason };
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
				await scheduler.wait(delayMs, { signal });
			}
		}
	}
}
