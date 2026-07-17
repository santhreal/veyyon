/**
 * Advisor runtime coordinator: owns the live advisor roster (one agent/runtime/
 * recorder per configured advisor), the enable/rebuild lifecycle, advice routing
 * into the primary (aside / preserve / interrupting steer), the post-interrupt
 * immune-turn window and auto-resume suppression latches, advisor-side context
 * maintenance (promotion + compaction), and the stats/status/dump surfaces.
 * Primary-loop mechanics the advisor rides on (queued-card extraction, card
 * preservation, custom-message delivery) stay on the session and are reached
 * through {@link AdvisorCoordinatorDeps} closures.
 */
import {
	Agent,
	type AgentMessage,
	type AgentTool,
	AppendOnlyContextManager,
	type CompactionSummaryMessage,
	resolveTelemetry,
	type StreamFn,
	ThinkingLevel,
} from "@veyyon/pi-agent-core";
import {
	type CompactionResult,
	calculatePromptTokens,
	compact,
	createCompactionSummaryMessage,
	estimateTokens,
	prepareCompaction,
	type SessionMessageEntry,
	shouldCompact,
} from "@veyyon/pi-agent-core/compaction";
import {
	type AssistantMessage,
	type Context,
	isUsageLimitOutcome,
	type Message,
	type Model,
	type ProviderSessionState,
	resolveModelServiceTier,
	type ServiceTier,
	type SimpleStreamOptions,
} from "@veyyon/pi-ai";
import { extractHttpStatusFromError, extractRetryHint, logger } from "@veyyon/pi-utils";
import {
	ADVISOR_DEFAULT_TOOL_NAMES,
	AdviseTool,
	type AdvisorAgent,
	type AdvisorConfig,
	AdvisorEmissionGuard,
	type AdvisorMessageDetails,
	type AdvisorNote,
	AdvisorOutputQuarantinedError,
	AdvisorRuntime,
	type AdvisorSeverity,
	AdvisorTranscriptRecorder,
	advisorTranscriptFilename,
	annotateForStaleness,
	buildAdvisorQuarantineSourceText,
	formatAdvisorBatchContent,
	getOrCreateAdvisorProviderSessionId,
	isAdvisorInterruptImmuneTurnActive,
	isAdvisorProductEnabled,
	isInterruptingSeverity,
	quarantineAdvisorUnsafeOutput,
	resolveAdvisorDeliveryChannel,
	slugifyAdvisorName,
} from "../advisor";
import { isCompactionStrategyOff, toAgentCompactionSettings } from "../config/compaction-strategy";
import type { ModelRegistry } from "../config/model-registry";
import {
	formatModelString,
	formatModelStringWithRouting,
	resolveAdvisorRoleSelection,
	resolveModelOverride,
} from "../config/model-resolver";
import { MODEL_ROLES } from "../config/model-roles";
import { serviceTierForAllFamilies, serviceTierSettingToTier } from "../config/service-tier";
import type { Settings } from "../config/settings";
import advisorSystemPrompt from "../prompts/advisor/system.md" with { type: "text" };
import type { SecretObfuscator } from "../secrets/obfuscator";
import {
	concreteThinkingLevel,
	resolveThinkingLevelForModel,
	shouldDisableReasoning,
	toReasoningEffort,
} from "../thinking";
import { createCodexCompactionContext } from "./compact-modes";
import type { CustomMessage, CustomMessagePayload } from "./messages";
import { isAdvisorCard, isTerminalTextAssistantAnswer } from "./queued-messages";
import { formatSessionDumpText } from "./session-dump-format";
import type { CompactionEntry, SessionEntry } from "./session-entries";
import { formatSessionHistoryMarkdown } from "./session-history-format";
import type { SessionManager } from "./session-manager";
import type { YieldQueue } from "./yield-queue";

/** Advisor statistics for /advisor status command. */
export interface AdvisorStats {
	configured: boolean;
	active: boolean;
	model?: Model;
	contextWindow: number;
	contextTokens: number;
	tokens: {
		input: number;
		output: number;
		reasoning: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
	cost: number;
	messages: {
		user: number;
		assistant: number;
		total: number;
	};
	/** Per-advisor breakdown; one entry per active advisor (single-advisor sessions have one). */
	advisors: PerAdvisorStat[];
}

/** One advisor's slice of {@link AdvisorStats}, surfaced for the multi-advisor status panel. */
export interface PerAdvisorStat {
	name: string;
	model: Model;
	contextWindow: number;
	contextTokens: number;
	tokens: AdvisorStats["tokens"];
	cost: number;
	messages: AdvisorStats["messages"];
}

/**
 * One live advisor instance: its own agent/runtime/tools/recorder plus a
 * per-advisor emission guard and identity. The coordinator holds an array of
 * these; primary-scoped state (turn counters, interrupt latches, the shared
 * yield channel) also lives here, session-lifetime.
 */
interface ActiveAdvisor {
	/** Display name from config ("default" for the legacy no-YAML advisor). */
	name: string;
	/** Slug for the transcript filename/session id; "" → `__advisor.jsonl`. */
	slug: string;
	agent: Agent;
	runtime: AdvisorRuntime;
	adviseTool: AdviseTool;
	emissionGuard: AdvisorEmissionGuard;
	recorder: AdvisorTranscriptRecorder;
	/** Latest recorder close, awaited by dispose() so the final turn lands on disk. */
	recorderClosed: Promise<void>;
	/** Unsubscribe for the advisor agent's event stream feeding the recorder. */
	agentUnsubscribe?: () => void;
	model: Model;
	thinkingLevel: ThinkingLevel;
	/** Stable key for the resolved runtime inputs that require a rebuild to change. */
	signature: string;
}

/** Resolved advisor config ready to instantiate as an {@link ActiveAdvisor}. */
interface AdvisorRuntimeDescriptor {
	config: AdvisorConfig;
	name: string;
	slug: string;
	model: Model;
	thinkingLevel: ThinkingLevel;
	signature: string;
}

/** Static advisor inputs handed over from `AgentSessionConfig` at construction. */
export interface AdvisorCoordinatorConfig {
	tools?: AgentTool[];
	watchdogPrompt?: string;
	sharedInstructions?: string;
	contextPrompt?: string;
	configs?: AdvisorConfig[];
	streamFn?: StreamFn;
}

/** Session facilities the coordinator drives; closures over AgentSession privates. */
export interface AdvisorCoordinatorDeps {
	agent: Agent;
	settings: Settings;
	sessionManager: SessionManager;
	modelRegistry: ModelRegistry;
	yieldQueue: YieldQueue;
	getSessionId(): string;
	getAgentKind(): "main" | "sub";
	isDisposed(): boolean;
	isAbortInProgress(): boolean;
	isPlanModeEnabled(): boolean;
	hasPendingNextTurnMessages(): boolean;
	/** Drop advisor cards parked for the next turn (conversation-boundary reset). */
	prunePendingNextTurnAdvisorCards(): void;
	/** Pull advisor cards out of the agent-core steer/follow-up queues. */
	extractQueuedAdvisorCards(): CustomMessage[];
	/** Record a suppressed advisor concern as visible advice without waking a turn. */
	preserveAdvisorCard(card: CustomMessage): void;
	emitNotice(level: "info" | "warning" | "error", message: string, source?: string): void;
	sendCustomMessage(
		message: CustomMessagePayload,
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): Promise<boolean>;
	effectiveServiceTier(model: Model): ServiceTier | undefined;
	getProviderSessionState(): Map<string, ProviderSessionState>;
	getPreferWebsockets(): boolean | undefined;
	getOnPayload(): SimpleStreamOptions["onPayload"] | undefined;
	getOnResponse(): SimpleStreamOptions["onResponse"] | undefined;
	getOnSseEvent(): SimpleStreamOptions["onSseEvent"] | undefined;
	getTransformProviderContext(): ((context: Context, model: Model) => Context | Promise<Context>) | undefined;
	getObfuscator(): SecretObfuscator | undefined;
	resolveContextPromotionTarget(currentModel: Model, contextWindow: number): Promise<Model | undefined>;
	resolveCompactionModelCandidates(preferredModel: Model, availableModels: Model[]): Model[];
	runnableCompactionCandidates(candidates: readonly Model[], sessionId: string | undefined): Promise<Model[]>;
	convertToLlmForSideRequest(messages: AgentMessage[]): Message[];
}

export class AdvisorCoordinator {
	readonly #deps: AdvisorCoordinatorDeps;
	#enabled = false;
	#tools?: AgentTool[];
	#watchdogPrompt?: string;
	#sharedInstructions?: string;
	#contextPrompt?: string;
	#configs?: AdvisorConfig[];
	#streamFn: StreamFn | undefined;
	#advisors: ActiveAdvisor[] = [];
	#yieldQueueUnsubscribe?: () => void;
	/** Stable per-slug UUIDv7 provider session ids (survive runtime rebuilds). */
	#providerSessionIds = new Map<string, string>();
	/** Latest stop's aggregated recorder close; dispose awaits the final turn flush. */
	#recorderClosed: Promise<void> = Promise.resolve();
	#autoResumeSuppressed = false;
	#primaryTurnsCompleted = 0;
	#interruptImmuneTurnStart: number | undefined;

	constructor(config: AdvisorCoordinatorConfig, deps: AdvisorCoordinatorDeps) {
		this.#tools = config.tools;
		this.#watchdogPrompt = config.watchdogPrompt;
		this.#sharedInstructions = config.sharedInstructions;
		this.#contextPrompt = config.contextPrompt;
		this.#configs = config.configs;
		this.#streamFn = config.streamFn;
		this.#deps = deps;
	}

	/** After a deliberate user interrupt, suppress advisor auto-resume while idle. */
	get autoResumeSuppressed(): boolean {
		return this.#autoResumeSuppressed;
	}

	set autoResumeSuppressed(value: boolean) {
		this.#autoResumeSuppressed = value;
	}

	/** Awaited by dispose() so the final advisor turn is flushed before process exit. */
	get recorderClosed(): Promise<void> {
		return this.#recorderClosed;
	}

	/** Read `advisor.enabled` (gated by the product flag) and start the runtime. */
	initializeFromSettings(): void {
		this.#enabled = isAdvisorProductEnabled() && (this.#deps.settings.get("advisor.enabled") as boolean);
		if (this.#enabled) this.#buildRuntime();
	}

	/** Model-roles change hook: rebuild the runtime when its resolved config drifted. */
	rebuildIfConfigChanged(): void {
		if (!isAdvisorProductEnabled() || !this.#enabled || this.#deps.isDisposed()) return;
		if (this.#advisors.length > 0 && !this.#runtimeMatchesCurrentConfig()) this.stopRuntime();
		this.#buildRuntime(true);
	}

	/**
	 * Primary turn-end hook: advances the immune-turn counter, feeds each advisor
	 * runtime the finished turn, and (per `advisor.syncBacklog`) awaits catch-up.
	 */
	async onPrimaryTurnEnd(
		messages: AgentMessage[],
		willContinue: boolean | undefined,
		signal: AbortSignal | undefined,
	): Promise<void> {
		this.#primaryTurnsCompleted++;
		if (this.#advisors.length === 0) return;
		for (const a of this.#advisors) {
			if (!a.runtime.disposed) a.runtime.onTurnEnd(messages, { willContinue });
		}
		const syncBacklog = this.#deps.settings.get("advisor.syncBacklog");
		if (syncBacklog !== "off") {
			const threshold = parseInt(syncBacklog, 10);
			// Parallel so the 30s catch-up budget is shared across advisors, not summed.
			await Promise.all(this.#advisors.map(a => a.runtime.waitForCatchup(30000, threshold, signal)));
		}
	}

	#immuneTurnLimit(): number {
		const immuneTurns = this.#deps.settings.get("advisor.immuneTurns") as number;
		if (!Number.isFinite(immuneTurns) || immuneTurns <= 0) return 0;
		return Math.trunc(immuneTurns);
	}

	#isInterruptImmuneTurnActive(): boolean {
		return isAdvisorInterruptImmuneTurnActive({
			completedTurns: this.#primaryTurnsCompleted,
			immuneTurnStart: this.#interruptImmuneTurnStart,
			immuneTurns: this.#immuneTurnLimit(),
		});
	}

	// The next primary turn number starts the immune-turn window. While the
	// interrupting steer is still in flight, completedTurns is lower than this
	// start, so duplicate concern/blocker advice is also downgraded.
	#recordInterruptDelivered(): void {
		this.#interruptImmuneTurnStart = this.#primaryTurnsCompleted + 1;
	}

	/**
	 * Re-prime the advisor across a conversation boundary: `/new`, `/branch`,
	 * `/btw`, `/tree`, and session switch/resume. Beyond {@link AdvisorRuntime.reset}
	 * (which only re-primes the advisor's transcript view and is also fired by
	 * within-conversation rewrites like compaction/shake/rewind), this clears the
	 * session-level interrupt latches so the prior conversation's cooldown cannot
	 * leak into the new one: the post-interrupt immune-turn window
	 * (`#primaryTurnsCompleted`, `#interruptImmuneTurnStart`) and the
	 * user-interrupt auto-resume suppression flag. It also drops advisor deliveries
	 * still queued against the prior conversation — pending asides in the yield
	 * queue (advisor entries use `skipIdleFlush`, so they linger until the next
	 * `drainLazy` rather than self-flushing), interrupting cards parked in the
	 * agent steer/follow-up queues, and preserved cards deferred to the next turn —
	 * so none of them inject into the new conversation.
	 */
	resetSessionState(): void {
		// Mute the recorder across the re-prime: AdvisorRuntime.reset() aborts the advisor
		// loop, and that abort can emit an `aborted` message_end we must not attribute to
		// either session's transcript. Detach, reset, then re-attach the live agent's feed.
		for (const a of this.#advisors) {
			a.agentUnsubscribe?.();
			a.agentUnsubscribe = undefined;
			a.runtime.reset();
			a.adviseTool.resetDeliveredNotes();
			a.emissionGuard.reset();
			this.#attachRecorderFeed(a);
		}
		this.#primaryTurnsCompleted = 0;
		this.#interruptImmuneTurnStart = undefined;
		this.#autoResumeSuppressed = false;
		this.#deps.yieldQueue.clear("advisor");
		this.#deps.extractQueuedAdvisorCards();
		this.#deps.prunePendingNextTurnAdvisorCards();
	}

	#resolveRuntimeDescriptors(emitWarnings: boolean): AdvisorRuntimeDescriptor[] {
		const legacy = !this.#configs?.length;
		const roster: AdvisorConfig[] = legacy ? [{ name: "default" }] : this.#configs!;
		const descriptors: AdvisorRuntimeDescriptor[] = [];
		const usedSlugs = new Set<string>();
		for (const config of roster) {
			let slug = legacy ? "" : slugifyAdvisorName(config.name);
			if (slug) {
				let candidate = slug;
				let n = 2;
				while (usedSlugs.has(candidate)) candidate = `${slug}-${n++}`;
				slug = candidate;
				usedSlugs.add(slug);
			}

			// Resolve the advisor's model: an explicit `model` override wins; else the
			// `advisor` role chain. A model that fails to resolve skips just this advisor.
			let model: Model | undefined;
			let thinkingLevel: ThinkingLevel | undefined;
			if (config.model) {
				const resolved = resolveModelOverride([config.model], this.#deps.modelRegistry, this.#deps.settings);
				model = resolved.model;
				thinkingLevel = concreteThinkingLevel(resolved.thinkingLevel);
				if (!model) {
					if (emitWarnings) {
						this.#deps.emitNotice(
							"warning",
							`Advisor "${config.name}": no model matched "${config.model}"`,
							"advisor",
						);
					}
					continue;
				}
			} else {
				const sel = resolveAdvisorRoleSelection(this.#deps.settings, this.#deps.modelRegistry.getAvailable());
				if (!sel) {
					// An enabled advisor silently doing nothing is a silent fallback —
					// surface it like the explicit-override miss above.
					if (emitWarnings) {
						this.#deps.emitNotice(
							"warning",
							`Advisor "${config.name}": no advisor-role model available (set modelRoles.advisor); advisor inactive`,
							"advisor",
						);
					}
					continue;
				}
				model = sel.model;
				thinkingLevel = concreteThinkingLevel(sel.thinkingLevel);
			}
			// Clamp the effort against the resolved model. Historically we defaulted
			// to `ThinkingLevel.Medium` unconditionally, which threw at first stream
			// on reasoning models that expose no controllable effort surface
			// (e.g. `devin-agent`: Cascade routes by sibling model id, not a wire
			// param; `getSupportedEfforts` returns `[]`). `resolveThinkingLevelForModel`
			// preserves an explicit `off`, clamps a concrete effort into the model's
			// supported range, and returns `undefined` for reasoning models without
			// controllable efforts — for that case we forward `Inherit` so no effort
			// is sent and reasoning stays enabled (matching the `auto`-path fix for
			// Devin models via `clampAutoThinkingEffort`). See #4579.
			const requestedLevel = thinkingLevel ?? ThinkingLevel.Medium;
			const resolvedLevel = resolveThinkingLevelForModel(model, requestedLevel);
			const advisorThinkingLevel: ThinkingLevel = resolvedLevel ?? ThinkingLevel.Inherit;
			descriptors.push({
				config,
				name: config.name,
				slug,
				model,
				thinkingLevel: advisorThinkingLevel,
				signature: this.#runtimeSignature(config, slug, model, advisorThinkingLevel),
			});
		}
		return descriptors;
	}

	#runtimeSignature(config: AdvisorConfig, slug: string, model: Model, thinkingLevel: ThinkingLevel): string {
		const tools = config.tools?.length ? config.tools.join("\u001e") : "";
		const instructions = config.instructions?.trim() ?? "";
		return [config.name, slug, formatModelStringWithRouting(model), thinkingLevel, tools, instructions].join(
			"\u001f",
		);
	}

	#runtimeMatchesCurrentConfig(): boolean {
		const descriptors = this.#resolveRuntimeDescriptors(false);
		if (descriptors.length !== this.#advisors.length) return false;
		for (let i = 0; i < descriptors.length; i++) {
			if (descriptors[i].signature !== this.#advisors[i].signature) return false;
		}
		return true;
	}

	#buildRuntime(seedToCurrent = false): boolean {
		if (this.#deps.isDisposed()) return false;
		if (this.#advisors.length > 0) return true;
		if (!this.#enabled) return false;
		if (this.#deps.getAgentKind() !== "main" && !this.#deps.settings.get("advisor.subagents")) return false;

		const descriptors = this.#resolveRuntimeDescriptors(true);

		// Advisor service tier (`tier.advisor`): "none" (default) runs the advisor
		// on standard processing; "inherit" tracks the session's live per-family
		// tiers per request (like the main agent, including /fast toggles); a
		// concrete value is broadcast across families and applied to the advisor
		// model's family. One value for all advisors.
		const advisorTierSetting = this.#deps.settings.get("tier.advisor");
		const advisorTierMap =
			advisorTierSetting === "inherit"
				? undefined
				: serviceTierForAllFamilies(serviceTierSettingToTier(advisorTierSetting));
		const advisorServiceTierResolver = (model: Model): ServiceTier | undefined =>
			advisorTierSetting === "inherit"
				? this.#deps.effectiveServiceTier(model)
				: resolveModelServiceTier(advisorTierMap, model);

		for (const descriptor of descriptors) {
			const {
				config,
				slug,
				model: advisorModel,
				name: advisorName,
				thinkingLevel: advisorThinkingLevel,
				signature,
			} = descriptor;

			const emissionGuard = new AdvisorEmissionGuard();
			const adviseTool = new AdviseTool((note, severity) => this.#routeAdvice(advisorRef, note, severity));

			// `#watchdogPrompt` already carries WATCHDOG.md + YAML shared
			// instructions; `config.instructions` adds this advisor's specialization.
			const systemPrompt = [advisorSystemPrompt];
			if (this.#contextPrompt) systemPrompt.push(this.#contextPrompt);
			if (this.#watchdogPrompt) systemPrompt.push(this.#watchdogPrompt);
			if (this.#sharedInstructions) systemPrompt.push(this.#sharedInstructions);
			if (config.instructions?.trim()) systemPrompt.push(config.instructions.trim());

			const names = config.tools === undefined ? ADVISOR_DEFAULT_TOOL_NAMES : new Set(config.tools);
			const tools = (this.#tools ?? []).filter(t => names.has(t.name));
			const availableAdvisorToolNames = new Set<string>();
			availableAdvisorToolNames.add(adviseTool.name);
			for (const tool of tools) {
				availableAdvisorToolNames.add(tool.name);
				if (tool.customWireName !== undefined) availableAdvisorToolNames.add(tool.customWireName);
			}
			let quarantinedAdvisorOutput: string | undefined;
			let currentAdvisorInput = "";

			const primaryProviderSessionId = this.#deps.getSessionId();
			const advisorSessionLabel = slug
				? `${primaryProviderSessionId}-advisor-${slug}`
				: `${primaryProviderSessionId}-advisor`;
			const advisorProviderSessionId = getOrCreateAdvisorProviderSessionId(
				this.#providerSessionIds,
				primaryProviderSessionId,
				slug,
			);
			const appendOnlyContext = new AppendOnlyContextManager();

			// Thread the primary's telemetry into the advisor loop so the advisor
			// model's GenAI spans + usage/cost hooks fire stamped with the local advisor
			// identity. `conversationId` is cleared so provider telemetry falls back to
			// the UUIDv7 provider session id, not the local `-advisor` label.
			const advisorTelemetry = this.#deps.agent.telemetry
				? {
						...this.#deps.agent.telemetry,
						agent: {
							id: advisorSessionLabel,
							name: slug ? `${MODEL_ROLES.advisor.name}: ${advisorName}` : MODEL_ROLES.advisor.name,
							description: formatModelString(advisorModel),
						},
						conversationId: undefined,
					}
				: undefined;
			// Mirror the SDK's provider-shaping options (streamFn/onPayload/...,
			// providerSessionState, promptCacheKey, transformProviderContext) so each
			// advisor's requests cache, route, and obfuscate like the main turn.
			// `promptCacheKey` preserves an explicitly pinned provider cache key
			// unchanged so tan/shared-session advisor calls read the exact shard the
			// parent turn populated. Otherwise the advisor uses its provider UUIDv7 so
			// Codex request identity remains UUID-shaped while local labels keep the
			// `-advisor` suffix.
			const advisorPromptCacheKey = this.#deps.agent.promptCacheKey ?? advisorProviderSessionId;
			const advisorAgent = new Agent({
				initialState: {
					systemPrompt,
					model: advisorModel,
					thinkingLevel: toReasoningEffort(advisorThinkingLevel),
					tools: [adviseTool, ...tools],
				},
				appendOnlyContext,
				sessionId: advisorProviderSessionId,
				promptCacheKey: advisorPromptCacheKey,
				providerSessionState: this.#deps.getProviderSessionState(),
				preferWebsockets: this.#deps.getPreferWebsockets(),
				getApiKey: requestModel => this.#deps.modelRegistry.resolver(requestModel, advisorProviderSessionId),
				streamFn: this.#streamFn,
				onPayload: this.#deps.getOnPayload(),
				onResponse: this.#deps.getOnResponse(),
				onSseEvent: this.#deps.getOnSseEvent(),
				transformProviderContext: this.#deps.getTransformProviderContext(),
				intentTracing: false,
				transformAssistantMessage: message => {
					quarantinedAdvisorOutput = quarantineAdvisorUnsafeOutput(
						message,
						availableAdvisorToolNames,
						buildAdvisorQuarantineSourceText(currentAdvisorInput, advisorAgent.state.messages),
					);
				},
				telemetry: advisorTelemetry,
				serviceTier: undefined,
				serviceTierResolver: advisorServiceTierResolver,
			});
			advisorAgent.setDisableReasoning(shouldDisableReasoning(advisorThinkingLevel));

			const advisorAgentFacade: AdvisorAgent = {
				prompt: async input => {
					let quarantined: string | undefined;
					try {
						quarantinedAdvisorOutput = undefined;
						currentAdvisorInput = input;
						await advisorAgent.prompt(input);
						quarantined = quarantinedAdvisorOutput;
					} finally {
						quarantinedAdvisorOutput = undefined;
						currentAdvisorInput = "";
					}
					if (quarantined) throw new AdvisorOutputQuarantinedError(quarantined);
				},
				abort: reason => advisorAgent.abort(reason),
				reset: () => {
					advisorAgent.reset();
					appendOnlyContext.log.clear();
				},
				rollbackTo: count => {
					// Drop the failed user batch + synthetic assistant-error turn
					// `Agent.#runLoop` appended for a turn ending in `stopReason: "error"`.
					const messages = advisorAgent.state.messages;
					if (count < messages.length) {
						messages.length = count;
					}
					appendOnlyContext.resetSyncCursor();
					advisorAgent.state.error = undefined;
				},
				state: advisorAgent.state,
			};

			// Persist this advisor's turns to `<session>/__advisor[.<slug>].jsonl`
			// (resolved lazily so it follows session switches) for stats attribution
			// and Agent Hub observability, without registering it as a peer.
			const recorder = new AdvisorTranscriptRecorder(
				() => this.#deps.sessionManager.getSessionFile(),
				() => this.#deps.sessionManager.getCwd(),
				advisorTranscriptFilename(slug),
				// On the advisor on→off→on toggle, wait for the prior recorders' closes
				// so two SessionManagers never hold the same file at once.
				this.#recorderClosed,
			);
			const runtime = new AdvisorRuntime(advisorAgentFacade, {
				snapshotMessages: () => this.#deps.agent.state.messages,
				enqueueAdvice: (note, severity) => this.#routeAdvice(advisorRef, note, severity),
				maintainContext: incomingTokens => this.#maintainContext(advisorRef, incomingTokens),
				obfuscator: this.#deps.getObfuscator(),
				beginAdvisorUpdate: () => advisorRef.emissionGuard.beginUpdate(),
				onTurnError: async error => {
					// Mirror the auth-gateway's usage-limit remedy: the in-stream a/b/c
					// auth retry rotates through siblings within one request but never
					// blocks the LAST failing credential, so without this the advisor
					// re-picks the same exhausted account every retry. Usage limits
					// only — other failures keep the plain retry/notify path (never
					// suspect-mark a credential on a transient advisor error).
					const message = error instanceof Error ? error.message : String(error);
					if (!isUsageLimitOutcome(extractHttpStatusFromError(error), message)) return;
					await this.#deps.modelRegistry.authStorage.markUsageLimitReached(
						advisorModel.provider,
						advisorProviderSessionId,
						{
							retryAfterMs: extractRetryHint(undefined, message),
							baseUrl: advisorModel.baseUrl,
							modelId: advisorModel.id,
						},
					);
				},
				notifyFailure: error => {
					const message = error instanceof Error ? error.message : String(error);
					this.#deps.emitNotice(
						"warning",
						`Advisor${slug ? ` "${advisorName}"` : ""} unavailable for ${formatModelString(advisorModel)}: ${message}`,
						"advisor",
					);
				},
			});

			const advisorRef: ActiveAdvisor = {
				name: advisorName,
				slug,
				agent: advisorAgent,
				runtime,
				adviseTool,
				emissionGuard,
				recorder,
				recorderClosed: Promise.resolve(),
				model: advisorModel,
				thinkingLevel: advisorThinkingLevel,
				signature,
			};
			this.#attachRecorderFeed(advisorRef);
			if (seedToCurrent) runtime.seedTo(this.#deps.agent.state.messages.length);
			this.#advisors.push(advisorRef);
		}

		// One shared non-blocking aside channel for all advisors; the build callback
		// aggregates every advisor's queued nits into one card (each entry already
		// carries its own `advisor` name).
		if (this.#advisors.length > 0 && !this.#yieldQueueUnsubscribe) {
			this.#yieldQueueUnsubscribe = this.#deps.yieldQueue.register<AdvisorNote>("advisor", {
				build: entries =>
					entries.length === 0
						? null
						: ({
								role: "custom",
								customType: "advisor",
								display: true,
								attribution: "agent",
								timestamp: Date.now(),
								content: formatAdvisorBatchContent(entries),
								details: { notes: entries } satisfies AdvisorMessageDetails,
							} satisfies CustomMessage),
				skipIdleFlush: true,
			});
		}

		return this.#advisors.length > 0;
	}

	#hasTerminalTextAnswerWithoutQueuedWork(): boolean {
		if (this.#deps.agent.hasQueuedMessages() || this.#deps.hasPendingNextTurnMessages()) return false;
		const messages = this.#deps.agent.state.messages;
		let tail = messages.length - 1;
		while (tail >= 0 && isAdvisorCard(messages[tail])) tail--;
		return isTerminalTextAssistantAnswer(messages[tail]);
	}

	/**
	 * Route one accepted advice note from `advisor` to the primary. Concern and
	 * blocker interrupt the running agent through the steering channel; once the
	 * loop has yielded, `triggerTurn` resumes it. If the loop already ended with a
	 * terminal text answer and no queued work remains, the note is preserved as an
	 * advisor card instead of waking a duplicate completion turn. After a deliberate
	 * user interrupt auto-resume is suppressed while idle/unwinding (the note
	 * becomes a preserved card re-entering on resume); a live-streaming turn is
	 * steered in directly. A plain nit always rides the non-interrupting YieldQueue
	 * aside. Suppression by the per-advisor emission guard drops the note silently —
	 * the model still saw `Recorded.`, so it isn't tempted to rephrase the same note
	 * past the dedupe.
	 */
	#routeAdvice(advisor: ActiveAdvisor, note: string, severity?: AdvisorSeverity): void {
		if (!advisor.emissionGuard.accept(note)) {
			logger.debug("advisor advice suppressed by emission guard", { severity, advisor: advisor.name });
			return;
		}
		// When newer primary turns already arrived while the advisor model was
		// processing this batch, the advice was generated without seeing them.
		// Append a lightweight staleness caveat so the primary can weigh recency.
		const deliveredNote = annotateForStaleness(note, advisor.runtime.hasFreshBacklog);
		// The implicit single ("default") advisor stamps no source name, so its
		// agent-facing `<advisory>` bytes stay identical to the pre-multi-advisor path.
		const source = advisor.slug ? advisor.name : undefined;
		const interrupting = isInterruptingSeverity(severity);
		const channel = resolveAdvisorDeliveryChannel({
			severity,
			autoResumeSuppressed: this.#autoResumeSuppressed,
			// Key on the live agent-core loop, not session `isStreaming` (which also
			// counts `#promptInFlightCount` during post-turn unwind). Only a running
			// loop consumes a steer at its next boundary.
			streaming: this.#deps.agent.state.isStreaming,
			aborting: this.#deps.isAbortInProgress(),
			terminalAnswerNoQueuedWork: this.#hasTerminalTextAnswerWithoutQueuedWork(),
			interruptImmuneTurnActive: interrupting && this.#isInterruptImmuneTurnActive(),
		});
		if (channel === "aside") {
			this.#deps.yieldQueue.enqueue("advisor", { note: deliveredNote, severity, advisor: source });
			return;
		}
		const notes: AdvisorNote[] = [{ note: deliveredNote, severity, advisor: source }];
		const content = formatAdvisorBatchContent(notes);
		const details = { notes } satisfies AdvisorMessageDetails;
		if (channel === "preserve") {
			this.#deps.preserveAdvisorCard({
				role: "custom",
				customType: "advisor",
				content,
				display: true,
				attribution: "agent",
				details,
				timestamp: Date.now(),
			});
			return;
		}
		this.#recordInterruptDelivered();
		if (this.#deps.isPlanModeEnabled()) {
			// Plan mode: record advice visibly in context but never wake an
			// autonomous turn — only user-driven turns converge on ask/resolve.
			this.#deps.preserveAdvisorCard({
				role: "custom",
				customType: "advisor",
				content,
				display: true,
				attribution: "agent",
				details,
				timestamp: Date.now(),
			});
			return;
		}
		void this.#deps
			.sendCustomMessage(
				{ customType: "advisor", content, display: true, attribution: "agent", details },
				{ deliverAs: "steer", triggerTurn: true },
			)
			.catch(err => logger.debug("advisor delivery failed", { err: String(err) }));
	}

	/** Re-prime every advisor's transcript view (compaction/shake/rewind) without the
	 *  session-level latch reset {@link resetSessionState} performs. */
	resetAllRuntimes(): void {
		for (const a of this.#advisors) a.runtime.reset();
	}

	stopRuntime(): void {
		// Detach each recorder feed BEFORE aborting its advisor agent: dispose() aborts
		// the loop, and an abort emits a final `message_end` we must not enqueue against
		// a closing recorder (it would reopen and resurrect an already-released file).
		const closes: Promise<void>[] = [];
		for (const a of this.#advisors) {
			a.agentUnsubscribe?.();
			a.agentUnsubscribe = undefined;
			a.runtime.dispose();
			// Capture each close so dispose()/`/drop` can await the queued open+append+close —
			// the last advisor turn would otherwise be lost on a fast process exit.
			a.recorderClosed = a.recorder.close();
			closes.push(a.recorderClosed);
		}
		this.#recorderClosed = Promise.all(closes).then(() => {});
		this.#advisors = [];
		this.#yieldQueueUnsubscribe?.();
		this.#yieldQueueUnsubscribe = undefined;
	}

	/**
	 * Detach every advisor recorder feed and drain its writer. `/new --drop` calls
	 * this BEFORE deleting the old artifacts dir: a still-running advisor turn could
	 * otherwise finish, emit `message_end`, and recreate `<old>/__advisor.jsonl`.
	 * {@link resetSessionState} (after newSession) re-primes the advisor and
	 * re-attaches the feed at the new session's path.
	 */
	async detachRecorderFeedsAndClose(): Promise<void> {
		for (const a of this.#advisors) {
			a.agentUnsubscribe?.();
			a.agentUnsubscribe = undefined;
			await a.recorder.close();
		}
	}

	/** Subscribe the advisor agent's finalized messages into the transcript recorder.
	 *  Idempotent-by-replacement: callers detach the prior feed first. Kept separate
	 *  so the re-prime path can mute the feed across an abort-driven reset. */
	#attachRecorderFeed(advisor: ActiveAdvisor): void {
		advisor.agentUnsubscribe = advisor.agent.subscribe(event => {
			if (event.type === "message_end") advisor.recorder.record(event.message);
		});
	}

	async #promoteContextModel(advisor: ActiveAdvisor, currentModel: Model): Promise<boolean> {
		const promotionSettings = this.#deps.settings.getGroup("contextPromotion");
		if (!promotionSettings.enabled) return false;
		const contextWindow = currentModel.contextWindow ?? 0;
		if (contextWindow <= 0) return false;
		const targetModel = await this.#deps.resolveContextPromotionTarget(currentModel, contextWindow);
		if (!targetModel) return false;

		// Preserve this advisor's own thinking level (a configured `model:...:high`
		// keeps its suffix across a promotion); only the model changes.
		const advisorThinkingLevel = advisor.thinkingLevel;
		try {
			advisor.agent.setModel(targetModel);
			advisor.agent.setThinkingLevel(toReasoningEffort(advisorThinkingLevel));
			advisor.agent.setDisableReasoning(shouldDisableReasoning(advisorThinkingLevel));
			advisor.agent.appendOnlyContext?.invalidateForModelChange();
			logger.debug("Advisor context promotion switched model on overflow", {
				advisor: advisor.name,
				from: `${currentModel.provider}/${currentModel.id}`,
				to: `${targetModel.provider}/${targetModel.id}`,
			});
			return true;
		} catch (error) {
			logger.warn("Advisor context promotion failed", {
				advisor: advisor.name,
				from: `${currentModel.provider}/${currentModel.id}`,
				to: `${targetModel.provider}/${targetModel.id}`,
				error: String(error),
			});
			return false;
		}
	}

	async #maintainContext(advisor: ActiveAdvisor, incomingTokens: number): Promise<boolean> {
		const agent = advisor.agent;

		const compactionSettings = this.#deps.settings.getGroup("compaction");
		if (isCompactionStrategyOff(compactionSettings.strategy as string)) return false;
		if (!compactionSettings.enabled) return false;

		const advisorModel = agent.state.model;
		const contextWindow = advisorModel.contextWindow ?? 0;
		if (contextWindow <= 0) return false;

		const messages = agent.state.messages;
		let contextTokens = incomingTokens;
		for (const message of messages) {
			contextTokens += estimateTokens(message);
		}

		if (!shouldCompact(contextTokens, contextWindow, compactionSettings)) {
			return false;
		}

		// 1. Try promotion first
		if (await this.#promoteContextModel(advisor, advisorModel)) {
			// Promotion succeeded, check if new model has enough space
			const newModel = agent.state.model;
			const newWindow = newModel.contextWindow ?? 0;
			if (newWindow > 0) {
				const stillNeedsCompaction = shouldCompact(contextTokens, newWindow, compactionSettings);
				if (!stillNeedsCompaction) return false;
			}
		}

		// 2. Run compaction on advisor messages
		const pathEntries: SessionEntry[] = messages.map((message, i) => {
			const id = `msg-${i}`;
			const parentId = i > 0 ? `msg-${i - 1}` : null;
			const timestamp = String(message.timestamp || Date.now());

			if (message.role === "compactionSummary") {
				return {
					type: "compaction",
					id,
					parentId,
					timestamp,
					summary: message.summary,
					shortSummary: message.shortSummary,
					firstKeptEntryId:
						(message as CompactionSummaryMessage & { firstKeptEntryId?: string }).firstKeptEntryId ||
						`msg-${i + 1}`,
					tokensBefore: message.tokensBefore,
				} satisfies CompactionEntry;
			}

			return {
				type: "message",
				id,
				parentId,
				timestamp,
				message,
			} satisfies SessionMessageEntry;
		});

		const availableModels = this.#deps.modelRegistry.getAvailable();
		const candidates = this.#deps.resolveCompactionModelCandidates(advisorModel, availableModels);
		if (candidates.length === 0) {
			// No compaction candidates, fallback to re-prime
			return true;
		}
		const advisorProviderSessionId = getOrCreateAdvisorProviderSessionId(
			this.#providerSessionIds,
			this.#deps.getSessionId(),
			advisor.slug,
		);
		const preparation = prepareCompaction(
			pathEntries,
			toAgentCompactionSettings(compactionSettings),
			await this.#deps.runnableCompactionCandidates(candidates, advisorProviderSessionId),
		);
		if (!preparation) {
			// Cannot prepare compaction, fallback to re-prime
			return true;
		}

		const advisorCompactionThinkingLevel: ThinkingLevel | undefined = agent.state.disableReasoning
			? ThinkingLevel.Off
			: agent.state.thinkingLevel;

		// Advisor state is in-memory-only, so snapcompact's frame archive has no
		// stable SessionEntry preserveData slot to carry across future advisor
		// maintenance runs. Use an LLM summary even when the primary session is
		// configured for snapcompact.

		let compactResult: CompactionResult | undefined;
		let lastError: unknown;
		// Instrument the advisor's overflow-compaction one-shot like the primary
		// compaction path so the advisor model's maintenance call also emits spans.
		const telemetry = resolveTelemetry(agent.telemetry, advisorProviderSessionId);

		const codexCompaction = createCodexCompactionContext({
			trigger: "auto",
			reason: "context_limit",
			phase: "pre_turn",
		});

		for (const candidate of candidates) {
			const apiKey = await this.#deps.modelRegistry.getApiKey(candidate, advisorProviderSessionId);
			if (!apiKey) continue;

			try {
				compactResult = await compact(
					preparation,
					candidate,
					this.#deps.modelRegistry.resolver(candidate, advisorProviderSessionId),
					undefined,
					undefined,
					{
						thinkingLevel: advisorCompactionThinkingLevel,
						convertToLlm: messages => this.#deps.convertToLlmForSideRequest(messages),
						telemetry,
						tools: agent.state.tools,
						sessionId: advisorProviderSessionId,
						promptCacheKey: advisorProviderSessionId,
						providerSessionState: this.#deps.getProviderSessionState(),
						codexCompaction,
					},
				);
				break;
			} catch (error) {
				lastError = error;
			}
		}

		if (!compactResult) {
			logger.warn("Advisor compaction failed, falling back to re-prime", { error: String(lastError) });
			return true;
		}

		const summary = compactResult.summary;
		const shortSummary = compactResult.shortSummary;
		const firstKeptEntryId = compactResult.firstKeptEntryId;
		const tokensBefore = compactResult.tokensBefore;

		// Rebuild messages with the compaction summary
		const summaryMessage = {
			...createCompactionSummaryMessage(summary, tokensBefore, new Date().toISOString(), shortSummary),
			firstKeptEntryId,
		} as CompactionSummaryMessage & { firstKeptEntryId?: string };

		agent.replaceMessages([summaryMessage, ...preparation.recentMessages]);
		return false;
	}

	/**
	 * Set the advisor enabled state and start/stop the runtime accordingly.
	 *
	 * @returns true when the advisor is actively running after the call.
	 */
	setEnabled(enabled: boolean): boolean {
		this.#enabled = enabled;
		if (enabled) {
			if (this.#advisors.length > 0 && !this.#runtimeMatchesCurrentConfig()) this.stopRuntime();
			return this.#buildRuntime(true);
		}
		this.stopRuntime();
		return false;
	}

	/**
	 * Toggle the advisor setting and start/stop the runtime accordingly.
	 *
	 * @returns true when the advisor is actively running after the call.
	 */
	toggleEnabled(): boolean {
		return this.setEnabled(!this.#enabled);
	}

	/**
	 * Replace the live advisor roster from an edited `WATCHDOG.yml` (the `/advisor
	 * configure` save path). Swaps the configs + shared baseline, then rebuilds the
	 * runtimes in place so the change applies without a restart. When the advisor is
	 * disabled the new configs are simply stored for the next enable.
	 *
	 * @returns the number of advisors active after the rebuild.
	 */
	applyConfigs(advisors: AdvisorConfig[], sharedInstructions: string | undefined): number {
		this.#configs = advisors;
		this.#sharedInstructions = sharedInstructions;
		if (!this.#enabled) return 0;
		this.stopRuntime();
		this.#buildRuntime(true);
		return this.#advisors.length;
	}

	/** Whether the advisor setting is enabled for this session. */
	isEnabled(): boolean {
		return this.#enabled;
	}

	/**
	 * Whether a live advisor agent is attached to this session. True only when
	 * `advisor.enabled` is set AND a model resolved for the `advisor` role AND
	 * the advisor applies to this agent kind — i.e. the actual runtime exists,
	 * not merely the setting. Drives the status-line badge and `/dump advisor`.
	 */
	isActive(): boolean {
		return this.#advisors.length > 0;
	}

	/**
	 * The names of the tools available to advisors this session (the pool a
	 * `/advisor configure` editor lists). The advisor is a full agent, so this is the
	 * full built tool set; a tool whose optional factory returns null (e.g. lsp with
	 * no servers) is absent.
	 */
	availableToolNames(): string[] {
		return (this.#tools ?? []).map(tool => tool.name);
	}

	/**
	 * The live advisor `Agent`, or `undefined` when no advisor runtime is
	 * attached. Surfaced for diagnostics (`/dump advisor` already serializes
	 * its transcript via {@link formatHistoryAsText}) and so callers can
	 * verify the advisor inherits the session's provider-shaping options
	 * (`streamFn`, `promptCacheKey`, `providerSessionState`, ...).
	 */
	firstAgent(): Agent | undefined {
		return this.#advisors[0]?.agent;
	}

	/**
	 * Return structured advisor stats for the status command and TUI panel.
	 */
	getStats(): AdvisorStats {
		const configured = this.#enabled;
		const advisors = this.#advisors.map(a => this.#computeStat(a));
		if (advisors.length === 0) {
			return {
				configured,
				active: false,
				contextWindow: 0,
				contextTokens: 0,
				tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				cost: 0,
				messages: { user: 0, assistant: 0, total: 0 },
				advisors: [],
			};
		}
		const tokens = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
		const messages = { user: 0, assistant: 0, total: 0 };
		let cost = 0;
		let contextTokens = 0;
		for (const a of advisors) {
			tokens.input += a.tokens.input;
			tokens.output += a.tokens.output;
			tokens.reasoning += a.tokens.reasoning;
			tokens.cacheRead += a.tokens.cacheRead;
			tokens.cacheWrite += a.tokens.cacheWrite;
			tokens.total += a.tokens.total;
			messages.user += a.messages.user;
			messages.assistant += a.messages.assistant;
			messages.total += a.messages.total;
			cost += a.cost;
			contextTokens += a.contextTokens;
		}
		// Single-advisor displays read the top-level model/window directly; surface the
		// first advisor's so the legacy status line stays byte-identical.
		return {
			configured,
			active: true,
			model: advisors[0].model,
			contextWindow: advisors[0].contextWindow,
			contextTokens,
			tokens,
			cost,
			messages,
			advisors,
		};
	}

	/** Compute one advisor's stats slice (tokens, cost, context, message counts). */
	#computeStat(advisor: ActiveAdvisor): PerAdvisorStat {
		const model = advisor.agent.state.model;
		const messages = advisor.agent.state.messages;
		const contextTokens = this.#estimateContextTokens(messages);
		let input = 0;
		let output = 0;
		let reasoning = 0;
		let cacheRead = 0;
		let cacheWrite = 0;
		let totalTokens = 0;
		let cost = 0;
		let user = 0;
		let assistant = 0;
		for (const message of messages) {
			if (message.role === "user") user++;
			if (message.role === "assistant") {
				assistant++;
				const assistantMsg = message as AssistantMessage;
				input += assistantMsg.usage.input;
				output += assistantMsg.usage.output;
				reasoning += assistantMsg.usage.reasoningTokens ?? 0;
				cacheRead += assistantMsg.usage.cacheRead;
				cacheWrite += assistantMsg.usage.cacheWrite;
				totalTokens += assistantMsg.usage.totalTokens;
				cost += assistantMsg.usage.cost.total;
			}
		}
		return {
			name: advisor.name,
			model,
			contextWindow: model.contextWindow ?? 0,
			contextTokens,
			tokens: { input, output, reasoning, cacheRead, cacheWrite, total: totalTokens },
			cost,
			messages: { user, assistant, total: messages.length },
		};
	}

	/**
	 * Format a concise advisor status line for ACP/text output.
	 */
	formatStatus(): string {
		const stats = this.getStats();
		if (!stats.active) {
			return stats.configured
				? "Advisor setting is enabled, but no model is assigned to the 'advisor' role."
				: "Advisor is disabled.";
		}
		if (stats.advisors.length <= 1) {
			const s = stats.advisors[0];
			const contextLine =
				s.contextWindow > 0
					? `Context: ${s.contextTokens.toLocaleString()} / ${s.contextWindow.toLocaleString()} tokens (${Math.round((s.contextTokens / s.contextWindow) * 100)}%)`
					: `Context: ${s.contextTokens.toLocaleString()} tokens`;
			const spendParts = [`${s.tokens.input.toLocaleString()} input`, `${s.tokens.output.toLocaleString()} output`];
			if (s.tokens.cacheRead > 0) spendParts.push(`${s.tokens.cacheRead.toLocaleString()} cache read`);
			if (s.tokens.cacheWrite > 0) spendParts.push(`${s.tokens.cacheWrite.toLocaleString()} cache write`);
			const spendLine = `Spend: ${spendParts.join(", ")}, $${s.cost.toFixed(4)}`;
			return `Advisor is enabled (${s.model.provider}/${s.model.id}). ${contextLine}. ${spendLine}.`;
		}
		const lines = [`Advisors enabled (${stats.advisors.length}):`];
		for (const s of stats.advisors) {
			const ctx =
				s.contextWindow > 0
					? `${s.contextTokens.toLocaleString()} / ${s.contextWindow.toLocaleString()} (${Math.round((s.contextTokens / s.contextWindow) * 100)}%)`
					: `${s.contextTokens.toLocaleString()}`;
			lines.push(`  • ${s.name} (${s.model.provider}/${s.model.id}) — context ${ctx} tokens, $${s.cost.toFixed(4)}`);
		}
		lines.push(
			`Totals: ${stats.tokens.input.toLocaleString()} input, ${stats.tokens.output.toLocaleString()} output, $${stats.cost.toFixed(4)}.`,
		);
		return lines.join("\n");
	}

	/**
	 * Estimate the advisor's current context tokens. When the advisor has a
	 * recent non-aborted assistant message with usage, use that prompt's token
	 * count and add a trailing estimate for messages after it. Otherwise estimate
	 * every message.
	 */
	#estimateContextTokens(messages: AgentMessage[]): number {
		let lastUsageIndex: number | null = null;
		let lastUsage: AssistantMessage["usage"] | undefined;
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i];
			if (msg.role === "assistant") {
				const assistantMsg = msg as AssistantMessage;
				if (assistantMsg.stopReason !== "aborted" && assistantMsg.stopReason !== "error" && assistantMsg.usage) {
					lastUsage = assistantMsg.usage;
					lastUsageIndex = i;
					break;
				}
			}
		}
		if (!lastUsage || lastUsageIndex === null) {
			let estimated = 0;
			for (const message of messages) {
				estimated += estimateTokens(message);
			}
			return estimated;
		}
		let trailingTokens = 0;
		for (let i = lastUsageIndex + 1; i < messages.length; i++) {
			trailingTokens += estimateTokens(messages[i]);
		}
		return calculatePromptTokens(lastUsage) + trailingTokens;
	}

	/**
	 * Format the advisor agent's own transcript (its system prompt, config,
	 * tools, and the markdown deltas it received plus its thinking/advise/read
	 * calls) as plain text — the advisor-side equivalent of the session dump.
	 * Returns null when no advisor is active.
	 */
	formatHistoryAsText(options?: { compact?: boolean }): string | null {
		if (this.#advisors.length === 0) return null;
		const dump = (a: ActiveAdvisor): string =>
			options?.compact
				? formatSessionHistoryMarkdown(a.agent.state.messages)
				: formatSessionDumpText({
						messages: a.agent.state.messages,
						systemPrompt: a.agent.state.systemPrompt,
						model: a.agent.state.model,
						thinkingLevel: a.agent.state.thinkingLevel,
						tools: a.agent.state.tools,
					});
		if (this.#advisors.length === 1) return dump(this.#advisors[0]);
		return this.#advisors
			.map(a => `### Advisor: ${a.name} (${a.agent.state.model.provider}/${a.agent.state.model.id})\n\n${dump(a)}`)
			.join("\n\n");
	}
}
