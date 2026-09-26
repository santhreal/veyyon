/**
 * The session's advisors: the agents that watch the primary's turns and send it advice.
 *
 * This is a session collaborator. It owns the live advisor instances, the configuration they are
 * built from, their provider identities and transcript recorders, and the primary-scoped latches
 * that decide how advice reaches the primary: the post-interrupt immune-turn window and the
 * user-interrupt auto-resume suppression. It reaches the session only through
 * {@link AdvisorRosterHost}.
 *
 * Advice travels one of four ways, chosen per note by `resolveAdvisorDeliveryChannel`:
 *
 * - **aside**: a nit, batched into one non-interrupting card on the yield queue;
 * - **preserve**: a card recorded visibly without waking a turn, when the conversation already
 *   rests on an answer or a user interrupt suppressed auto-resume;
 * - **steer**: a concern or blocker steered into the running loop, which it wakes when idle;
 * - plan mode turns every steer into a preserved card, since only user-driven turns converge there.
 */

import {
	Agent,
	type AgentEvent,
	type AgentMessage,
	type AgentTelemetryConfig,
	type AgentTool,
	AppendOnlyContextManager,
	type StreamFn,
	ThinkingLevel,
} from "@veyyon/agent-core";
import type { Context, Model, ServiceTier, SimpleStreamOptions } from "@veyyon/ai";
import * as AIError from "@veyyon/ai/error";
import { streamSimple } from "@veyyon/ai/stream";
import { resolveModelServiceTier } from "@veyyon/catalog/provider-models/service-tier";
import type { YieldQueue } from "@veyyon/kernel/session/yield-queue";
import { errorMessage, extractRetryHint, logger } from "@veyyon/utils";
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
	deriveAdvisorTelemetry,
	formatAdvisorBatchContent,
	getOrCreateAdvisorProviderSessionId,
	isAdvisorInterruptImmuneTurnActive,
	isAdvisorProductEnabled,
	isInterruptingSeverity,
	quarantineAdvisorUnsafeOutput,
	resolveAdvisorDeliveryChannel,
	slugifyAdvisorName,
} from "../../advisor";
import {
	formatModelString,
	formatModelStringWithRouting,
	resolveAdvisorRoleSelection,
	resolveModelOverride,
} from "../../config/model-resolver";
import { MODEL_ROLES } from "../../config/model-roles";
import { serviceTierForAllFamilies, serviceTierSettingToTier } from "../../config/service-tier";
import { advisorPrompts } from "../../prompts/advisor/rows";
import type { SecretObfuscator } from "../../secrets/obfuscator";
import {
	concreteThinkingLevel,
	resolveThinkingLevelForModel,
	shouldDisableReasoning,
	toReasoningEffort,
} from "../../thinking";
import { type AdvisorContextEnv, maintainAdvisorContext } from "../advisor-context";
import { collectAdvisorStats } from "../advisor-stats";
import { isAdvisorCard } from "../agent-session-queue";
import type { AdvisorStats, ProjectAdvisorScope, SecretRuntimeLease } from "../agent-session-types";
import type { CustomMessage } from "../messages";
import { formatSessionDumpText } from "../session-dump-format";
import { formatSessionHistoryMarkdown } from "../session-history-format";

/**
 * One live advisor instance: its own agent, runtime, tools and recorder plus a per-advisor
 * emission guard and identity.
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

/**
 * The session's provider-shaping options, mirrored into every advisor's requests so they cache,
 * route and obfuscate like the main turn. Fixed when the session is constructed.
 */
export interface AdvisorProviderShaping {
	/** The advisor stream override; `streamSimple` when unset. */
	readonly streamFn: StreamFn | undefined;
	readonly preferWebsockets: boolean | undefined;
	readonly onPayload: SimpleStreamOptions["onPayload"] | undefined;
	readonly onResponse: SimpleStreamOptions["onResponse"] | undefined;
	readonly onSseEvent: SimpleStreamOptions["onSseEvent"] | undefined;
	readonly transformProviderContext:
		| ((context: Context, model: Model, runtime?: SecretRuntimeLease) => Context | Promise<Context>)
		| undefined;
	readonly resolveSecretRuntimeLeaseForContext: ((context: Context) => SecretRuntimeLease | undefined) | undefined;
}

/**
 * The slice of the primary loop the advisors watch and steer. `Agent` satisfies this structurally.
 *
 * Advisors read the primary's transcript, model and streaming flag, inherit its telemetry, emit a
 * preserved card as an external event, and pull their own cards out of its queues on a user
 * interrupt. Nothing else of the loop is reached.
 */
export interface AdvisorPrimaryAgent {
	readonly state: {
		readonly messages: AgentMessage[];
		readonly model: Model;
		readonly isStreaming: boolean;
	};
	readonly telemetry: AgentTelemetryConfig | undefined;
	emitExternalEvent(event: AgentEvent): void;
	peekSteeringQueue(): readonly AgentMessage[];
	peekFollowUpQueue(): readonly AgentMessage[];
	replaceQueues(steering: AgentMessage[], followUp: AgentMessage[]): void;
}

/** What {@link AdvisorRoster} needs from the session that owns it. */
export interface AdvisorRosterHost extends AdvisorContextEnv {
	/** The primary loop the advisors review and steer. */
	readonly agent: AdvisorPrimaryAgent;
	readonly yieldQueue: YieldQueue;
	readonly provider: AdvisorProviderShaping;
	/** A spawned agent runs advisors only when `advisor.agents` is set. */
	readonly agentKind: "main" | "sub";
	/** The session file each advisor transcript is recorded beside; read per write, so it follows switches. */
	sessionFile(): string | undefined;
	cwd(): string;
	sessionId(): string;
	isDisposed(): boolean;
	abortInProgress(): boolean;
	/** Session streaming: the loop running or a prompt still unwinding. */
	isStreaming(): boolean;
	planModeEnabled(): boolean;
	/** Whether the conversation rests on an answer with nothing queued behind it. */
	hasTerminalTextAnswerWithoutQueuedWork(): boolean;
	emitNotice(level: "info" | "warning" | "error", message: string, source?: string): void;
	/** Steer an advice card into the primary and wake it when idle. */
	steerAdvice(content: string, details: AdvisorMessageDetails): Promise<void>;
	/** Hold a card for the next turn. */
	parkForNextTurn(card: CustomMessage): void;
	/** Drop every advisor card held for the next turn. */
	dropParkedAdvisorCards(): void;
	leaseSecretRuntime(): Promise<SecretRuntimeLease>;
	/** The session's redactor as of now: an advisor outlives every secret refresh. */
	providerRedactor(): SecretObfuscator | undefined;
	/** The service tier the primary would request for `model`. */
	effectiveServiceTier(model: Model): ServiceTier | undefined;
}

export class AdvisorRoster {
	readonly #host: AdvisorRosterHost;
	#enabled = false;
	/** Latched true when the user deliberately interrupts (USER_INTERRUPT_LABEL);
	 *  suppresses advisor concern/blocker auto-resume until the user next resumes.
	 *  Advisor advice is still recorded into the transcript, just not auto-run. */
	#autoResumeSuppressed = false;
	#primaryTurnsCompleted = 0;
	#interruptImmuneTurnStart: number | undefined;
	readonly #tools: AgentTool[] | undefined;
	#watchdogPrompt: string | undefined;
	#sharedInstructions: string | undefined;
	#contextPrompt: string | undefined;
	/** Configured advisor roster from WATCHDOG.yml; undefined/empty → single legacy advisor. */
	#configs: AdvisorConfig[] | undefined;
	#yieldQueueUnsubscribe: (() => void) | undefined;
	/** Live advisors. Empty when no advisor is active. */
	#advisors: ActiveAdvisor[] = [];
	/** Provider-facing UUIDv7 identities keyed by primary provider session and advisor slug. */
	readonly #providerSessionIds = new Map<string, string>();
	/** Aggregate of the most recent stop's recorder closes; awaited by dispose() and
	 *  used as the open barrier for the next build so two writers never share a file. */
	#recorderClosed: Promise<void> = Promise.resolve();

	constructor(host: AdvisorRosterHost, tools: AgentTool[] | undefined, scope: ProjectAdvisorScope) {
		this.#host = host;
		this.#tools = tools;
		this.#watchdogPrompt = scope.advisorWatchdogPrompt;
		this.#contextPrompt = scope.advisorContextPrompt;
		this.#sharedInstructions = scope.advisorSharedInstructions;
		this.#configs = scope.advisorConfigs;
	}

	// ------------------------------------------------------------ the setting

	/** Whether the advisor setting is enabled for this session. */
	get enabled(): boolean {
		return this.#enabled;
	}

	/** Whether a live advisor agent is attached, not merely the setting. */
	get active(): boolean {
		return this.#advisors.length > 0;
	}

	/** Read `advisor.enabled` and start the advisors when it is on. */
	enableFromSettings(): void {
		this.#enabled = isAdvisorProductEnabled() && (this.#host.settings.get("advisor.enabled") as boolean);
		if (this.#enabled) this.#build();
	}

	/** @returns true when an advisor is running after the call. */
	setEnabled(enabled: boolean): boolean {
		this.#enabled = enabled;
		if (enabled) {
			if (this.#advisors.length > 0 && !this.#matchesCurrentConfig()) this.stop();
			return this.#build(true);
		}
		this.stop();
		return false;
	}

	/** A model role changed: rebuild any advisor whose resolved model no longer matches. */
	onModelRolesChanged(): void {
		if (!isAdvisorProductEnabled() || !this.#enabled || this.#host.isDisposed()) return;
		if (this.#advisors.length > 0 && !this.#matchesCurrentConfig()) this.stop();
		this.#build(true);
	}

	/** @returns the number of advisors active after the rebuild. */
	applyConfigs(advisors: AdvisorConfig[], sharedInstructions: string | undefined): number {
		this.#configs = advisors;
		this.#sharedInstructions = sharedInstructions;
		if (!this.#enabled) return 0;
		this.stop();
		this.#build(true);
		return this.#advisors.length;
	}

	/** Replace every cwd-derived advisor input and rebuild the advisors in that scope. */
	replaceProjectScope(scope: ProjectAdvisorScope): void {
		this.stop();
		this.#watchdogPrompt = scope.advisorWatchdogPrompt;
		this.#contextPrompt = scope.advisorContextPrompt;
		this.#sharedInstructions = scope.advisorSharedInstructions;
		this.#configs = scope.advisorConfigs;
		this.enableFromSettings();
	}

	availableToolNames(): string[] {
		return (this.#tools ?? []).map(tool => tool.name);
	}

	firstAgent(): Agent | undefined {
		return this.#advisors[0]?.agent;
	}

	stats(): AdvisorStats {
		return collectAdvisorStats(this.#enabled, this.#advisors);
	}

	/** Every advisor's transcript as plain text, or `null` when no advisor is active. */
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

	// ------------------------------------------------------- the primary loop

	/** Feed a finished primary turn to every advisor and, per `advisor.syncBacklog`, wait for them to catch up. */
	async onPrimaryTurnEnd(
		messages: AgentMessage[],
		willContinue: boolean | undefined,
		signal?: AbortSignal,
	): Promise<void> {
		this.#primaryTurnsCompleted++;
		if (this.#advisors.length === 0) return;
		for (const a of this.#advisors) {
			if (!a.runtime.disposed) a.runtime.onTurnEnd(messages, { willContinue });
		}
		const syncBacklog = this.#host.settings.get("advisor.syncBacklog");
		if (syncBacklog !== "off") {
			const threshold = parseInt(syncBacklog, 10);
			// Parallel so the 30s catch-up budget is shared across advisors, not summed.
			await Promise.all(this.#advisors.map(a => a.runtime.waitForCatchup(30000, threshold, signal)));
		}
	}

	/** Stop every advisor's in-flight review: the turn it reviews is being stopped. */
	cancelInFlight(reason: string): void {
		for (const a of this.#advisors) a.runtime.cancelInFlight(reason);
	}

	get autoResumeSuppressed(): boolean {
		return this.#autoResumeSuppressed;
	}

	/** A deliberate user interrupt: advice is recorded but no longer wakes the primary. */
	suppressAutoResume(): void {
		this.#autoResumeSuppressed = true;
	}

	/** A user-initiated prompt or queued message resumes, so advice may wake the primary again. */
	allowAutoResume(): void {
		this.#autoResumeSuppressed = false;
	}

	/** Remove advisor concern/blocker cards from the agent-core steer/follow-up
	 *  queues and return them. Used on a deliberate user interrupt so the post-abort
	 *  stranded-message drain cannot auto-resume the run on an advisor card that was
	 *  steered in just before the user stopped; real user follow-ups stay queued.
	 *  Synchronous and await-free so it runs before the abort path polls the queue. */
	extractQueuedCards(): CustomMessage[] {
		const agent = this.#host.agent;
		const steering = agent.peekSteeringQueue();
		const followUp = agent.peekFollowUpQueue();
		const cards = steering.concat(followUp).filter(isAdvisorCard);
		if (cards.length === 0) return [];
		agent.replaceQueues(
			steering.filter(m => !isAdvisorCard(m)),
			followUp.filter(m => !isAdvisorCard(m)),
		);
		return cards;
	}

	/** Record a suppressed advisor concern as visible, persisted advice without
	 *  triggering a turn. When the agent is idle (the normal post-interrupt case,
	 *  including the post-prompt unwind window where the core loop has ended), emit
	 *  message_start/message_end like the IRC aside flush so the session's agent
	 *  event handler renders it live (TUI/ACP) and persists it as a CustomMessageEntry.
	 *  Only while an abort is still tearing a live turn down do we park it hidden, so
	 *  abort's settle step replays it once idle — never appended into a live streamMessage. */
	preserveCard(card: CustomMessage): void {
		if (this.#host.abortInProgress() && this.#host.isStreaming()) {
			this.#host.parkForNextTurn(card);
			return;
		}
		this.#host.agent.emitExternalEvent({ type: "message_start", message: card });
		this.#host.agent.emitExternalEvent({ type: "message_end", message: card });
	}

	// -------------------------------------------------------------- lifecycle

	/** Re-prime every advisor's transcript view (compaction/shake/rewind) without the
	 *  session-level latch reset {@link resetSessionState} performs. */
	resetRuntimes(): void {
		for (const a of this.#advisors) a.runtime.reset();
	}

	/**
	 * Re-prime the advisor across a conversation boundary: `/new`, `/branch`,
	 * `/btw`, `/tree`, and session switch/resume. Beyond {@link AdvisorRuntime.reset}
	 * (which only re-primes the advisor's transcript view and is also fired by
	 * within-conversation rewrites like compaction/shake/rewind), this clears the
	 * session-level interrupt latches so the prior conversation's cooldown cannot
	 * leak into the new one: the post-interrupt immune-turn window and the
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
		this.#host.yieldQueue.clear("advisor");
		this.extractQueuedCards();
		this.#host.dropParkedAdvisorCards();
	}

	stop(): void {
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

	/** Settles when the recorders the last {@link stop} closed have flushed. */
	whenRecordersClosed(): Promise<void> {
		return this.#recorderClosed;
	}

	/**
	 * Detach every recorder feed and drain its writer, leaving the advisors running. Done before a
	 * session's artifacts directory is deleted, so a still-running advisor turn cannot finish,
	 * emit `message_end`, and recreate its transcript there. {@link resetSessionState} re-attaches
	 * the feeds at the new session's path.
	 */
	async closeRecorders(): Promise<void> {
		for (const a of this.#advisors) {
			a.agentUnsubscribe?.();
			a.agentUnsubscribe = undefined;
			await a.recorder.close();
		}
	}

	// ------------------------------------------------------------ building

	#immuneTurnLimit(): number {
		const immuneTurns = this.#host.settings.get("advisor.immuneTurns") as number;
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

	#resolveDescriptors(emitWarnings: boolean): AdvisorRuntimeDescriptor[] {
		const host = this.#host;
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
			// `advisor` role, which inherits this session's live model when unset.
			// A model that fails to resolve skips just this advisor.
			let model: Model | undefined;
			let thinkingLevel: ThinkingLevel | undefined;
			if (config.model) {
				const resolved = resolveModelOverride([config.model], host.modelRegistry, host.settings);
				model = resolved.model;
				thinkingLevel = concreteThinkingLevel(resolved.thinkingLevel);
				if (!model) {
					if (emitWarnings) {
						host.emitNotice("warning", `Advisor "${config.name}": no model matched "${config.model}"`, "advisor");
					}
					continue;
				}
			} else {
				const sel = resolveAdvisorRoleSelection(
					host.settings,
					host.modelRegistry.getAvailable(),
					host.agent.state.model,
				);
				if (!sel) {
					// An enabled advisor silently doing nothing is a silent fallback —
					// surface it like the explicit-override miss above.
					if (emitWarnings) {
						host.emitNotice(
							"warning",
							`Advisor "${config.name}": no advisor model available (set Advisor Model in /settings → Model → Advisor, or sign in so the session model can be inherited); advisor inactive`,
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
				signature: advisorSignature(config, slug, model, advisorThinkingLevel),
			});
		}
		return descriptors;
	}

	#matchesCurrentConfig(): boolean {
		const descriptors = this.#resolveDescriptors(false);
		if (descriptors.length !== this.#advisors.length) return false;
		for (let i = 0; i < descriptors.length; i++) {
			if (descriptors[i].signature !== this.#advisors[i].signature) return false;
		}
		return true;
	}

	#build(seedToCurrent = false): boolean {
		const host = this.#host;
		if (host.isDisposed()) return false;
		if (this.#advisors.length > 0) return true;
		if (!this.#enabled) return false;
		if (host.agentKind !== "main" && !host.settings.get("advisor.agents")) return false;

		const descriptors = this.#resolveDescriptors(true);

		// Advisor service tier (`tier.advisor`): "none" (default) runs the advisor
		// on standard processing; "inherit" tracks the session's live per-family
		// tiers per request (like the main agent, including /fast toggles); a
		// concrete value is broadcast across families and applied to the advisor
		// model's family. One value for all advisors.
		const advisorTierSetting = host.settings.get("tier.advisor");
		const advisorTierMap =
			advisorTierSetting === "inherit"
				? undefined
				: serviceTierForAllFamilies(serviceTierSettingToTier(advisorTierSetting));
		const advisorServiceTierResolver = (model: Model): ServiceTier | undefined =>
			advisorTierSetting === "inherit"
				? host.effectiveServiceTier(model)
				: resolveModelServiceTier(advisorTierMap, model);

		for (const descriptor of descriptors) {
			const advisor = this.#instantiate(descriptor, advisorServiceTierResolver);
			this.#attachRecorderFeed(advisor);
			if (seedToCurrent) advisor.runtime.seedTo(host.agent.state.messages.length);
			this.#advisors.push(advisor);
		}

		// One shared non-blocking aside channel for all advisors; the build callback
		// aggregates every advisor's queued nits into one card (each entry already
		// carries its own `advisor` name).
		if (this.#advisors.length > 0 && !this.#yieldQueueUnsubscribe) {
			this.#yieldQueueUnsubscribe = host.yieldQueue.register<AdvisorNote>("advisor", {
				build: entries => (entries.length === 0 ? null : advisorCard(entries)),
				skipIdleFlush: true,
			});
		}

		return this.#advisors.length > 0;
	}

	/** Construct one advisor's agent, runtime, tools and recorder from its resolved descriptor. */
	#instantiate(
		descriptor: AdvisorRuntimeDescriptor,
		serviceTierResolver: (model: Model) => ServiceTier | undefined,
	): ActiveAdvisor {
		const host = this.#host;
		const provider = host.provider;
		const { config, slug, model: advisorModel, name: advisorName, thinkingLevel: advisorThinkingLevel } = descriptor;

		const emissionGuard = new AdvisorEmissionGuard();
		const adviseTool = new AdviseTool((note, severity) => this.#routeAdvice(advisorRef, note, severity));

		// `#watchdogPrompt` already carries WATCHDOG.md + YAML shared
		// instructions; `config.instructions` adds this advisor's specialization.
		const systemPrompt = [advisorPrompts["advisor/system"].text];
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

		const primaryProviderSessionId = host.sessionId();
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
		// identity; the helper clears `conversationId` so provider telemetry falls
		// back to the UUIDv7 provider session id, not the local `-advisor` label.
		const advisorTelemetry = deriveAdvisorTelemetry(host.agent.telemetry, {
			id: advisorSessionLabel,
			name: slug ? `${MODEL_ROLES.advisor.name}: ${advisorName}` : MODEL_ROLES.advisor.name,
			description: formatModelString(advisorModel),
		});
		// Mirror the SDK's provider-shaping options (streamFn/onPayload/...,
		// providerSessionState, promptCacheKey, transformProviderContext) so each
		// advisor's requests cache, route, and obfuscate like the main turn.
		// `promptCacheKey` preserves an explicitly pinned provider cache key
		// unchanged so tan/shared-session advisor calls read the exact shard the
		// parent turn populated. Otherwise the advisor uses its provider UUIDv7 so
		// Codex request identity remains UUID-shaped while local labels keep the
		// `-advisor` suffix.
		const advisorPromptCacheKey = host.primaryPromptCacheKey() ?? advisorProviderSessionId;
		let advisorSecretRuntime: SecretRuntimeLease | undefined;
		const leasedAdvisorStreamFn: StreamFn = async (requestModel, requestContext, requestOptions) => {
			const runtime =
				advisorSecretRuntime ??
				provider.resolveSecretRuntimeLeaseForContext?.(requestContext) ??
				(await host.leaseSecretRuntime());
			const sessionOnPayload = provider.onPayload;
			const requestOnPayload = requestOptions?.onPayload;
			const onPayload =
				runtime.hasRedactions || sessionOnPayload || requestOnPayload
					? async (payload: unknown, payloadModel?: Model) => {
							const sessionPayload = sessionOnPayload
								? await sessionOnPayload(payload, payloadModel)
								: undefined;
							const sessionResolvedPayload = sessionPayload ?? payload;
							const requestPayload = requestOnPayload
								? await requestOnPayload(sessionResolvedPayload, payloadModel)
								: undefined;
							return runtime.obfuscatePayload(requestPayload ?? sessionResolvedPayload);
						}
					: undefined;
			return (provider.streamFn ?? streamSimple)(requestModel, requestContext, {
				...requestOptions,
				onPayload,
			});
		};
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
			providerSessionState: host.providerSessionState,
			preferWebsockets: provider.preferWebsockets,
			getApiKey: requestModel => host.modelRegistry.resolver(requestModel, advisorProviderSessionId),
			transformContext: async messages => {
				advisorSecretRuntime = await host.leaseSecretRuntime();
				return messages;
			},
			streamFn: leasedAdvisorStreamFn,
			onResponse: provider.onResponse,
			onSseEvent: provider.onSseEvent,
			transformProviderContext: (context, requestModel) =>
				provider.transformProviderContext
					? provider.transformProviderContext(context, requestModel, advisorSecretRuntime)
					: (advisorSecretRuntime?.obfuscateContext(context) ?? context),
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
			serviceTierResolver,
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
		// and Control Center observability, without registering it as a peer.
		const recorder = new AdvisorTranscriptRecorder(
			() => host.sessionFile(),
			() => host.cwd(),
			advisorTranscriptFilename(slug),
			// On the advisor on→off→on toggle, wait for the prior recorders' closes
			// so two SessionManagers never hold the same file at once.
			this.#recorderClosed,
		);
		const runtime = new AdvisorRuntime(advisorAgentFacade, {
			snapshotMessages: () => host.agent.state.messages,
			enqueueAdvice: (note, severity) => this.#routeAdvice(advisorRef, note, severity),
			maintainContext: incomingTokens =>
				maintainAdvisorContext(
					advisorRef,
					() => getOrCreateAdvisorProviderSessionId(this.#providerSessionIds, host.sessionId(), advisorRef.slug),
					incomingTokens,
					host,
				),
			// Resolved per advisor delta, not captured here: the advisor outlives every
			// secret refresh, so a snapshot would redact only what was configured when
			// the advisor started and would send a `/secret add`ed value in plaintext.
			get obfuscator(): SecretObfuscator | undefined {
				return host.providerRedactor();
			},
			beginAdvisorUpdate: () => advisorRef.emissionGuard.beginUpdate(),
			onTurnError: async error => {
				// Mirror the auth-gateway's usage-limit remedy: the in-stream a/b/c
				// auth retry rotates through siblings within one request but never
				// blocks the LAST failing credential, so without this the advisor
				// re-picks the same exhausted account every retry. Usage limits
				// only — other failures keep the plain retry/notify path (never
				// suspect-mark a credential on a transient advisor error).
				const message = errorMessage(error);
				if (!AIError.isUsageLimit(error)) return;
				await host.modelRegistry.authStorage.markUsageLimitReached(
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
				const message = errorMessage(error);
				host.emitNotice(
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
			signature: descriptor.signature,
		};
		return advisorRef;
	}

	/** Subscribe the advisor agent's finalized messages into the transcript recorder.
	 *  Idempotent-by-replacement: callers detach the prior feed first. Kept separate
	 *  so the re-prime path can mute the feed across an abort-driven reset. */
	#attachRecorderFeed(advisor: ActiveAdvisor): void {
		advisor.agentUnsubscribe = advisor.agent.subscribe(event => {
			if (event.type === "message_end") advisor.recorder.record(event.message);
		});
	}

	// ------------------------------------------------------------ delivery

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
		const host = this.#host;
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
			// counts in-flight prompts during post-turn unwind). Only a running
			// loop consumes a steer at its next boundary.
			streaming: host.agent.state.isStreaming,
			aborting: host.abortInProgress(),
			terminalAnswerNoQueuedWork: host.hasTerminalTextAnswerWithoutQueuedWork(),
			interruptImmuneTurnActive: interrupting && this.#isInterruptImmuneTurnActive(),
		});
		if (channel === "aside") {
			host.yieldQueue.enqueue("advisor", { note: deliveredNote, severity, advisor: source });
			return;
		}
		const notes: AdvisorNote[] = [{ note: deliveredNote, severity, advisor: source }];
		if (channel === "preserve") {
			this.preserveCard(advisorCard(notes));
			return;
		}
		this.#recordInterruptDelivered();
		if (host.planModeEnabled()) {
			// Plan mode: record advice visibly in context but never wake an
			// autonomous turn — only user-driven turns converge on ask/resolve.
			this.preserveCard(advisorCard(notes));
			return;
		}
		const details = { notes } satisfies AdvisorMessageDetails;
		void host
			.steerAdvice(formatAdvisorBatchContent(notes), details)
			.catch(err => logger.debug("advisor delivery failed", { err: errorMessage(err) }));
	}
}

/** A visible advisor card carrying `notes`, as the aside batch and a preserved note both record it. */
function advisorCard(notes: AdvisorNote[]): CustomMessage {
	return {
		role: "custom",
		customType: "advisor",
		content: formatAdvisorBatchContent(notes),
		display: true,
		attribution: "agent",
		details: { notes } satisfies AdvisorMessageDetails,
		timestamp: Date.now(),
	};
}

function advisorSignature(config: AdvisorConfig, slug: string, model: Model, thinkingLevel: ThinkingLevel): string {
	const tools = config.tools?.length ? config.tools.join("\u001e") : "";
	const instructions = config.instructions?.trim() ?? "";
	return [config.name, slug, formatModelStringWithRouting(model), thinkingLevel, tools, instructions].join("\u001f");
}
