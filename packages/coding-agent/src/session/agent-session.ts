/**
 * AgentSession - Core abstraction for agent lifecycle and session management.
 *
 * This class is shared between all run modes (interactive, print, rpc).
 * It encapsulates:
 * - Agent state access
 * - Event subscription with automatic session persistence
 * - Model and thinking level management
 * - Compaction (manual and auto)
 * - Bash execution
 * - Session switching and branching
 *
 * Modes use this class and add their own I/O layer on top.
 */

import {
	type AfterToolCallContext,
	type AfterToolCallResult,
	type Agent,
	AgentBusyError,
	type AgentEvent,
	type AgentMessage,
	type AgentState,
	type AgentTool,
	AppendOnlyContextManager,
	type AsideMessage,
	TERMINAL_TOOL_RESULT_ABORT_REASON,
	type ThinkingLevel,
	type ToolChoiceDirective,
} from "@veyyon/agent-core";
import type { CompactionResult, SessionMessageEntry, ShakeConfig } from "@veyyon/agent-core/compaction";
import type {
	AssistantMessage,
	ImageContent,
	InstrumentationLevel,
	Message,
	Model,
	ProviderSessionState,
	ResetCreditAccountStatus,
	ResetCreditRedeemOutcome,
	ResetCreditTarget,
	ServiceTier,
	ServiceTierByFamily,
	ServiceTierFamily,
	SimpleStreamOptions,
	TextContent,
	ToolChoice,
	UsageReport,
} from "@veyyon/ai";
import * as AIError from "@veyyon/ai/error";
import { sessionTelemetryDetail } from "@veyyon/ai/instrumentation";
// Session initialization registers usage backends without loading the AI package barrel.
import "@veyyon/ai/usage/defaults";
import type { Effort } from "@veyyon/catalog/effort";
import { modelsAreEqual } from "@veyyon/catalog/models";
import type { InMemorySnapshotStore } from "@veyyon/hashline";
import { declaredContextWindow } from "@veyyon/kernel/session/agent-session-compaction-policy";
import { AgentStorage } from "@veyyon/kernel/session/agent-storage";
import type { ClientBridge } from "@veyyon/kernel/session/client-bridge";
import { OperatorNotices, stderrNoticeSink } from "@veyyon/kernel/session/operator-notices";
import {
	type BuildSessionContextOptions,
	compactedHistoryEnd,
	contextCompaction,
	type SessionContext,
} from "@veyyon/kernel/session/session-context";
import type { NewSessionOptions } from "@veyyon/kernel/session/session-entries";
import type { SessionManager } from "@veyyon/kernel/session/session-manager";
import type { ShakeMode, ShakeResult } from "@veyyon/kernel/session/shake-types";
import type { SideCompleteImpl } from "@veyyon/kernel/session/side-complete";
import { ToolChoiceQueue } from "@veyyon/kernel/session/tool-choice-queue";
import { YieldQueue } from "@veyyon/kernel/session/yield-queue";
import { errorMessage, logger, prompt, Snowflake, withTimeout } from "@veyyon/utils";
import { contentText } from "@veyyon/utils/content-text";
import { startupMarker } from "@veyyon/utils/startup-marker";
import type { ArgotSession } from "argot";
import type { AdvisorConfig } from "../advisor";
import type { AsyncJob, AsyncJobManager } from "../async";
import { shouldEnableAppendOnlyContext } from "../config/append-only-context-mode";
import { unusableCredentialMessage } from "../config/missing-credentials";
import type { ModelRegistry } from "../config/model-registry";
import { noModelSelectedMessage } from "../config/model-resolution-failure";
import { formatModelString, getModelMatchPreferences, resolveModelSelectorValue } from "../config/model-resolver";
import type { PromptTemplate } from "../config/prompt-templates";
import { buildServiceTierByFamily } from "../config/service-tier";
import type { Settings, SkillsSettings } from "../config/settings";
import { onAppendOnlyModeChanged, onHelperModelsChanged } from "../config/settings-signals";
import type { RawSseDebugBuffer } from "../debug/raw-sse-buffer";
import { resolveEffectiveToolDiscoveryMode } from "../discovery/mode";
import { type DiscoverableTool, type DiscoverableToolSearchIndex, isMCPToolName } from "../discovery/tool-index";
import type { PythonResult } from "../eval/py/executor";
import { defaultEvalSessionId } from "../eval/session-id";
import type { BashResult } from "../exec/bash-executor";
import type { TtsrManager } from "../export/ttsr";
import type { LoadedCustomCommand } from "../extensibility/custom-commands/types";
import type { CustomTool, CustomToolContext } from "../extensibility/custom-tools/types";
import type { ExtensionRunner } from "../extensibility/extensions";
import type { CompactOptions, ContextUsage } from "../extensibility/extensions/types";
import type { Skill } from "../extensibility/skills";
import type { FileSlashCommand } from "../extensibility/slash-commands";
import { recordGoal } from "../goals/goal-record";
import { GoalRuntime } from "../goals/runtime";
import type { GoalAbortReason, GoalModeState, GoalTokenUsage } from "../goals/state";
// The owning module, not the `../internal-urls` barrel: the barrel re-exports every protocol
// handler and reaches several hundred modules, and both of these are declared in
// `local-protocol`, which reaches seven.
import { type LocalProtocolOptions, resolveLocalUrlToPath } from "../internal-urls/local-protocol";
import { resolveMemoryBackend } from "../memory/backend";
import type { HindsightSessionState } from "../memory/hindsight/state";
import { getMnemopiSessionState, type MnemopiSessionState, setMnemopiSessionState } from "../memory/mnemopi/state";
import { resolvePlanFilePath } from "../plan-mode/plan-path";
import type { PlanModeState } from "../plan-mode/state";
import { turnControlPrompts } from "../prompts/turn-control/rows";
import type { SecretObfuscator } from "../secrets/obfuscator";
import { isLivePromptGate } from "../system-prompt-builder/gate-registry";
import {
	HELPER_IDS,
	type HelperId,
	type HelperModelSelection,
	helperModelPatterns,
	resolveHelperModel,
} from "../task/helper-settings";
import {
	type IrcMessage,
	type IrcPersistedDeliveryFacts,
	type IrcPersistedDeliveryTelemetry,
	projectIrcDeliveryTelemetry,
} from "../task/irc-bus";
import type { ConfiguredThinkingLevel } from "../thinking";
import { buildResolveReminderMessage } from "../tools/agent/resolve";
import type { TodoPhase } from "../tools/agent/todo";
import { validateApprovalPolicySettings } from "../tools/core/approval";
import type { ApprovalMode, SessionToolApprovals } from "../tools/core/approval-modes";
import { TOOL } from "../tools/core/builtin-names";
import { shortenPath } from "../tools/core/render-utils";
import type { CheckpointState, CompletedRewindState } from "../tools/fs/checkpoint";
import { type EditMode, resolveEditMode } from "../utils/edit-mode";
import { buildNamedToolChoice, isToolChoiceActive } from "../utils/tool-choice";
import { formatAdvisorStatus } from "./advisor-stats";
import { type EphemeralTurnArgs, type EphemeralTurnResult, runEphemeralTurn } from "./agent-session-ephemeral-turn";
import { findLastAssistantMessage } from "./agent-session-message-shapes";
import { isAdvisorCard, isTerminalTextAssistantAnswer, type RestoredQueuedMessage } from "./agent-session-queue";
import { retryFallbackChainWarnings } from "./agent-session-retry-fallback";
import { buildGoalTodoContext, createMagicKeywordNotices, magicKeywordEnabled } from "./agent-session-turn-notices";
import {
	type AdvisorStats,
	type AgentSessionConfig,
	type AgentSessionDisposeOptions,
	type AgentSessionEventListener,
	type AsyncJobSnapshot,
	type AsyncResultEntry,
	type CommandMetadataChangedListener,
	type ContextUsageBreakdown,
	DISPOSE_AGENT_LOOP_SETTLE_MS,
	type FollowUpOptions,
	type FreshSessionResult,
	type HandoffResult,
	type ModelCycleResult,
	type Prewalk,
	type ProjectAdvisorScope,
	type PromptOptions,
	type SecretRuntimeLease,
	type SessionHandoffOptions,
	type SessionNameTrigger,
	type SessionScopedModel,
	type SessionSpend,
	type SessionStats,
	type SetSessionNameWithTrigger,
	TOOL_SHAPE_SETTING_PATHS,
} from "./agent-session-types";
// The accounting, not the drawing. It used to be imported from `modes/`, which put the terminal UI
// on the session engine's graph and cost the layering gate a standing exception.
import { computeStoredMessagesTokens } from "./context-usage";
import { bindSessionBudget } from "./cpu-limit";
import {
	type CustomMessage,
	type CustomMessagePayload,
	convertToLlm,
	demoteInterruptedThinking,
	INTERRUPTED_THINKING_MESSAGE_TYPE,
	type InterruptedThinkingDetails,
	isEmptyErrorTurn,
	isUserInterruptAbort,
	SILENT_ABORT_MARKER,
	USER_INTERRUPT_LABEL,
} from "./messages";
import { computeNonMessageBreakdown, computeNonMessageTokens, takeHeldAtRestReading } from "./non-message-tokens";
import { AdvisorRoster, type AdvisorRosterHost } from "./runtime/advisor-roster";
import { CheckpointRuntime } from "./runtime/checkpoint-runtime";
import { CompactionRuntime } from "./runtime/compaction-runtime";
import { readCompactionSpanBack } from "./runtime/compaction-summarizer";
import { ContextAccounting } from "./runtime/context-accounting";
import { ConversationRelease } from "./runtime/conversation-release";
import {
	type CustomMessageFields,
	CustomMessages,
	type PromptCustomMessageOptions,
	type SendCustomMessageOptions,
} from "./runtime/custom-messages";
import { DisplayCopy } from "./runtime/display-copy";
import { ExitRecord } from "./runtime/exit-record";
import { FinalizeReminders } from "./runtime/finalize-reminders";
import { HistoryRewrites } from "./runtime/history-rewrites";
import { type ImageAttachment, ImageAttachments } from "./runtime/image-attachments";
import { IrcDelivery } from "./runtime/irc-delivery";
import { LoopGuards } from "./runtime/loop-guards";
import { MemoryContext } from "./runtime/memory-context";
import { MessagePersistence } from "./runtime/message-persistence";
import { ModelHandoff } from "./runtime/model-handoff";
import { ModelSelection, type SetModelOptions } from "./runtime/model-selection";
import { type NextTurnLease, NextTurnMessages } from "./runtime/next-turn-messages";
import { OwnedAsyncJobs } from "./runtime/owned-async-jobs";
import { PlanModeRuntime } from "./runtime/plan-mode-runtime";
import { PostPromptTasks } from "./runtime/post-prompt-tasks";
import { PromptCommands } from "./runtime/prompt-commands";
import { ProviderSessions } from "./runtime/provider-sessions";
import { ProviderTransport } from "./runtime/provider-transport";
import { ProviderUsage } from "./runtime/provider-usage";
import { ProviderWire } from "./runtime/provider-wire";
import { QueuedMessages } from "./runtime/queued-messages";
import { ReplanTitleRefresh } from "./runtime/replan-title-refresh";
import { RetryRuntime } from "./runtime/retry-runtime";
import { ServiceTiers } from "./runtime/service-tiers";
import { SessionApprovals } from "./runtime/session-approvals";
import { SessionBranch, type TreeNavigationResult } from "./runtime/session-branch";
import { SessionEvents } from "./runtime/session-events";
import { SessionHandoff } from "./runtime/session-handoff";
import { SessionRelease } from "./runtime/session-release";
import { SessionScope } from "./runtime/session-scope";
import { type SecretsRefreshOptions, SessionSecrets } from "./runtime/session-secrets";
import { SessionStopHook } from "./runtime/session-stop-hook";
import { SessionSwitch } from "./runtime/session-switch";
import { StopRetries } from "./runtime/stop-retries";
import { StopSettlement } from "./runtime/stop-settlement";
import { StreamingEditGuard } from "./runtime/streaming-edit-guard";
import { ThinkingRuntime } from "./runtime/thinking-runtime";
import { TodoRuntime } from "./runtime/todo-runtime";
import { ToolActivation } from "./runtime/tool-activation";
import { sameToolNames, ToolDiscovery } from "./runtime/tool-discovery";
import { TranscriptExports } from "./runtime/transcript-exports";
import { TtsrRuntime } from "./runtime/ttsr-runtime";
import { removeAssistantMessageFromActiveContext, TurnContextCheck } from "./runtime/turn-context-check";
import { TurnContinuations } from "./runtime/turn-continuations";
import { TurnInput } from "./runtime/turn-input";
import { TurnPreludes } from "./runtime/turn-preludes";
import { TurnsInFlight } from "./runtime/turns-in-flight";
import { UserExecutions } from "./runtime/user-executions";
import { YieldTracker } from "./runtime/yield-tracker";
import { SessionSpendLedger } from "./session-spend";
import { classifyUnexpectedStop } from "./unexpected-stop-classifier";
import type { VibeModeState } from "./vibe-runtime";

/** Whether writing `path` must rebuild the prompt the model is holding. */
function rebuildsThePrompt(path: string): boolean {
	return isLivePromptGate(path) || TOOL_SHAPE_SETTING_PATHS[path] === true;
}

export type { ShakeMode, ShakeResult };

/**
 * Ask the active memory backend for an extra-context block to splice into
 * the compaction summary prompt. Both the manual and auto compaction paths
 * funnel through this helper so the behaviour stays identical.
 *
 * Failures are swallowed: a memory backend going sideways MUST NOT block
 * compaction (which is itself the recovery path for context overflow).
 */
async function collectMemoryBackendContext(
	session: AgentSession,
	preparation: { messagesToSummarize: AgentMessage[]; turnPrefixMessages: AgentMessage[] },
): Promise<string | undefined> {
	const backend = await resolveMemoryBackend(session.settings);
	if (!backend.preCompactionContext) return undefined;
	await readCompactionSpanBack(preparation);
	const messages = preparation.messagesToSummarize.concat(preparation.turnPrefixMessages);
	try {
		return await backend.preCompactionContext(messages, session.settings, session);
	} catch (err) {
		logger.debug("Memory backend preCompactionContext failed", {
			backend: backend.id,
			error: errorMessage(err),
		});
		return undefined;
	}
}

/**
 * On a user-interrupted (`Esc`) abort, copy the trailing thinking run into a
 * hidden `display: false` continuity message for the next turn WITHOUT
 * mutating the assistant message. The original thinking stays on the message
 * so live render, reload, and Ctrl+L rebuilds keep showing it; `convertToLlm`
 * strips the run from the provider request (incomplete/unsigned thinking is
 * rejected on resend) when this continuity message follows the assistant turn.
 */
function demoteInterruptedThinkingOnUserInterrupt(
	message: AssistantMessage,
): CustomMessage<InterruptedThinkingDetails> | undefined {
	if (message.stopReason !== "aborted" || !isUserInterruptAbort(message)) return undefined;
	const demoted = demoteInterruptedThinking(message);
	if (!demoted) return undefined;
	const interruptedAt = Date.now();
	return {
		role: "custom",
		customType: INTERRUPTED_THINKING_MESSAGE_TYPE,
		content: prompt.render(turnControlPrompts["turn-control/interrupted-thinking"].text, {
			reasoning: demoted.reasoning,
		}),
		display: false,
		details: {
			interruptedAt,
			provider: message.provider,
			model: message.model,
			blockCount: demoted.blockCount,
		},
		attribution: "agent",
		timestamp: interruptedAt,
	};
}

function getCustomMessageTextContent(message: Pick<CustomMessage, "content">): string {
	return contentText(message.content, { separator: "" });
}

/**
 * Warnings for hand-edited settings that resolve to a value other than the one written.
 *
 * Every configured value that does not match its declared type is reported with the file to edit,
 * and one the read path replaces also states what it reads as instead: a value of the wrong kind
 * reads as its default, and a misspelled `tools.approvalMode` reads as `ask`, its declared
 * fail-closed member. A malformed `tools.approval.<tool>` policy DENIES the tool (see
 * `normalizePolicy`), so its warning states which entry did it and the accepted values. Nothing
 * fires for a value that is not configured.
 */
function configWarningsFor(settings: Settings, modelRegistry: ModelRegistry): string[] {
	const warnings = retryFallbackChainWarnings(settings.get("retry.fallbackChains"), modelRegistry);
	for (const { path, file, reason, replaced } of settings.invalidValues) {
		const readsAs = replaced ? `; it reads as ${JSON.stringify(settings.get(path))}` : "";
		warnings.push(`${reason} in ${shortenPath(file)}${readsAs}`);
	}
	warnings.push(...validateApprovalPolicySettings(settings.get("tools.approval")));
	return warnings;
}

/**
 * The display copy of an event carrying a whole assistant message: secrets deobfuscated and
 * argot handles expanded. The LLM echoes back obfuscated placeholders and cheap handles, but
 * listeners (TUI, extensions, exporters) must see real values. The original message keeps both,
 * so the persistence path writes `#HASH#` tokens and handles to the session file and the next
 * turn's context stays cheap. `message_start`, `message_end` and `turn_end` all carry a whole
 * assistant message and a front end may render from any of them, so all three expand alike and
 * the same text never changes under the reader between two adjacent events.
 */
function expandAssistantEvent<E extends { message: AgentMessage }>(session: AgentSession, event: E): E {
	const message: AgentMessage = event.message;
	if (message.role !== "assistant") return event;
	const content = session.displayAssistantContent(message.content);
	return content === message.content ? event : { ...event, message: { ...message, content } };
}

/**
 * The closing event repeats the turn's messages, so it repeats every handle in them unless it is
 * expanded like the events it summarises. The array is copied only when a message changes.
 */
function expandAgentEndEvent(
	session: AgentSession,
	event: Extract<AgentEvent, { type: "agent_end" }>,
): Extract<AgentEvent, { type: "agent_end" }> {
	let messages: AgentMessage[] | undefined;
	for (let index = 0; index < event.messages.length; index++) {
		const message = event.messages[index]!;
		if (message.role !== "assistant") continue;
		const content = session.displayAssistantContent(message.content);
		if (content === message.content) continue;
		messages ??= event.messages.slice();
		messages[index] = { ...message, content };
	}
	return messages ? { ...event, messages } : event;
}

function localProtocolOptions(sessionManager: SessionManager): LocalProtocolOptions {
	return {
		getArtifactsDir: () => sessionManager.getArtifactsDir(),
		getSessionId: () => sessionManager.getSessionId(),
	};
}

/**
 * Filesystem path of a plan reference, whichever spelling it carries. One
 * delegate to {@link resolvePlanFilePath} rather than a branch per reader:
 * a reference with no URL scheme used to throw `Invalid URL` out of the
 * prompt path while a sibling reader thirty lines away handled it.
 */
function resolvePlanPath(sessionManager: SessionManager, planFilePath: string): string {
	return resolvePlanFilePath(planFilePath, {
		localProtocol: localProtocolOptions(sessionManager),
		cwd: sessionManager.getCwd(),
	});
}

/**
 * Adopt a context window the provider reported on the wire.
 *
 * The catalog's window is static metadata, and for an agent gateway that
 * adds models continuously it is a guess: discovery has no window field to
 * read and substitutes a default. That guess is the denominator of both the
 * context gauge and the compaction threshold, so when it is far below the
 * real window the gauge pins at "0% left" and auto-compaction fires every
 * turn on a conversation the provider considers barely used.
 *
 * Both the live model object and the registry are corrected: the session
 * holds its model by reference, so fixing only the registry would leave this
 * turn's math wrong, and fixing only the reference would let the next
 * discovery reload restore the guess.
 */
function applyProviderReportedContextWindow(
	agent: Agent,
	modelRegistry: ModelRegistry,
	message: AssistantMessage,
): void {
	const reported = message.providerContextWindow;
	if (reported === undefined || !Number.isFinite(reported) || reported <= 0) return;
	const model = agent.state.model;
	if (!model) return;
	const changed = modelRegistry.recordProviderReportedContextWindow(model.provider, model.id, reported);
	if (model.contextWindow === reported) return;
	logger.debug("Adopting provider-reported context window", {
		model: `${model.provider}/${model.id}`,
		was: model.contextWindow,
		now: reported,
		registryUpdated: changed,
	});
	agent.state.model = { ...model, contextWindow: reported };
}

function resolveActiveEditMode(settings: Settings, model: Model | undefined): EditMode {
	return resolveEditMode({
		settings,
		getActiveModelString: () => (model ? formatModelString(model) : undefined),
	});
}

/** Deliver a built mode-context message with its attribution; a `null` message (mode off) sends nothing. */
async function sendModeContext(
	session: AgentSession,
	message: CustomMessage | null,
	options: { deliverAs?: "steer" | "followUp" | "nextTurn" } | undefined,
): Promise<void> {
	if (!message) return;
	await session.sendCustomMessage(
		{
			customType: message.customType,
			content: message.content,
			display: message.display,
			details: message.details,
			attribution: message.attribution,
		},
		options ? { deliverAs: options.deliverAs } : undefined,
	);
}

export class AgentSession {
	readonly agent: Agent;
	readonly sessionManager: SessionManager;
	readonly settings: Settings;
	readonly yieldQueue: YieldQueue;
	fileSnapshotStore?: InMemorySnapshotStore;
	readonly #approvals: SessionApprovals;
	/**
	 * What the caller configured this session with. A host callback or flag the session only reads is
	 * read from here rather than copied into a field of its own.
	 */
	readonly #config: AgentSessionConfig;

	readonly configWarnings: string[] = [];

	#handoff: ModelHandoff;

	// Event subscription state
	#unsubscribeAgent?: () => void;
	/** Unsubscribers for the process-wide and settings listeners, released at the end of dispose. */
	readonly #listenerReleases: Array<() => void> = [];
	#promptRefresh: Promise<void> = Promise.resolve();
	/**
	 * Startup work that finishes behind the first frame and gates the first turn.
	 *
	 * A session's own construction is on the boot path, so anything it awaits there is time before the
	 * user sees anything. Work whose result no frame reads — a memory backend opening its database and
	 * installing this session's state — is handed to {@link deferStartupWork} instead and awaited at
	 * the one place that needs it, the start of a turn. Every tool call and every agent spawn
	 * happens inside a turn, so one await covers all of them.
	 */
	#startupHydration: Promise<void> = Promise.resolve();
	/** Last (enable, providerId) tuple resolved by `#syncAppendOnlyContext` — used to skip no-op invalidations. */
	#lastAppendOnlyResolution?: { enable: boolean; providerId: string | undefined };

	/** Plan mode state, the approved-plan reference, and the decision ladder. */
	readonly #planMode: PlanModeRuntime;
	#vibeModeState: VibeModeState | undefined;
	#goalModeState: GoalModeState | undefined;
	#goalRuntime: GoalRuntime;
	/** The advisors watching this session's turns; see {@link AdvisorRoster}. */
	readonly #advisorRoster: AdvisorRoster;
	#goalTurnCounter = 0;
	/** Spend over the summarized prefix, tallied once per compaction boundary. */
	readonly #spendLedger = new SessionSpendLedger();
	#clientBridge: ClientBridge | undefined;
	#allowAcpAgentInitiatedTurns = false;

	readonly #compaction = new CompactionRuntime(this, {
		emitSessionEvent: event => this.#events.send(event),
		promptGeneration: () => this.#promptGeneration,
		scheduleAgentContinue: options => this.#continuations.scheduleContinue(options),
		scheduleAutoContinuePrompt: generation => this.#continuations.scheduleAutoContinuePrompt(generation),
		secrets: () => this.#secrets,
		convertToLlmForSideRequest: messages => this.#convertToLlmForSideRequest(messages),
		providerSessionState: () => this.#providerSessions.states,
		effectiveServiceTier: model => this.#tiers.effective(model),
		baseSystemPrompt: () => this.#toolActivation.baseSystemPrompt,
		nonMessageTokens: () => computeNonMessageTokens(this),
		estimateStoredContextTokens: () => this.#context.estimateStoredTokens(),
		memoryBackendContext: preparation => collectMemoryBackendContext(this, preparation),
		withPlanProtection: config => this.#planMode.withProtection(config),
		offloadAndApplyShakeRegions: regions => this.#rewrites.offloadAndApply(regions),
		rebasePendingContextSnapshotAfterHistoryRewrite: () => this.#context.rebaseAfterHistoryRewrite(),
		resetAllAdvisorRuntimes: () => this.#resetAllAdvisorRuntimes(),
		afterHistoryCompacted: () => {
			// Compaction discarded the conversation history that carried the approved
			// plan reference; the next turn re-reads the plan from disk (issue #1246).
			this.#planMode.invalidateReference();
			this.#resetAllAdvisorRuntimes();
			this.#todo.syncFromBranch();
			this.#preludes.restateSessionState();
		},
		closeCodexProviderSessionsForHistoryRewrite: () => this.#providerSessions.closeCodexForHistoryRewrite(this.model),
		whileDisconnectedFromAgent: run => this.#whileDisconnectedFromAgent(run),
	});

	/** The end-of-turn context check and the recovery each of its cases runs. */
	readonly #contextCheck = new TurnContextCheck(this, {
		promptGeneration: () => this.#promptGeneration,
		goalMode: () => this.#goalModeState,
		predatesLatestCompaction: message => this.#persistence.assistantPredatesLatestCompaction(message),
		waitForPersisted: message => this.#persistence.waitFor(message),
		discardAssistantTurn: message => this.#discardAssistantTurn(message),
		removeAssistantFromActiveContext: message => removeAssistantMessageFromActiveContext(this.agent, message),
		isDisposed: () => this.#isDisposed,
		persistTurnForMidRunCompaction: context => this.#persistence.persistTurnForMidRunCompaction(context),
		scheduleAgentContinue: options => this.#continuations.scheduleContinue(options),
		runAutoCompaction: (reason, willRetry, options) => this.#compaction.runAutoCompaction(reason, willRetry, options),
		noticeCompactionThresholdClamp: (contextWindow, settings) =>
			this.#compaction.noticeCompactionThresholdClamp(contextWindow, settings),
		pruneStale: () => this.#rewrites.pruneStale(),
		pruneOverflow: () => this.#rewrites.pruneOverflow(),
		estimateStoredContextTokens: () => this.#context.estimateStoredTokens(),
	});

	readonly #retry = new RetryRuntime(this, {
		emitSessionEvent: event => this.#events.send(event),
		promptGeneration: () => this.#promptGeneration,
		scheduleAgentContinue: options => this.#continuations.scheduleContinue(options),
		abortIsDeliberate: message =>
			this.#deliberateAborts.has(message) ||
			this.#abortInProgress ||
			this.#isDisposed ||
			this.#streamingEdit.abortTriggered,
		setModelWithProviderSessionReset: model => this.#setModelWithProviderSessionReset(model),
		resetCurrentResponsesProviderSession: reason => this.#providerSessions.resetResponses(this.model, reason),
		maybeAutoRedeemCodexReset: () => this.#usage.maybeAutoRedeemCodexReset(),
		removeAssistantMessageFromActiveContext: (message, reason) =>
			removeAssistantMessageFromActiveContext(this.agent, message, reason),
		persistLifecycleErrorMessage: async message => {
			await this.#persistence.waitFor(message);
			if (!isEmptyErrorTurn(message) || this.#persistence.alreadyPersisted(message)) return;
			this.#persistence.append(message);
		},
		resetSessionStopContinuationState: () => this.#stopHook.reset(),
	});
	/**
	 * The title refresh a re-plan starts, and the TITLE_SYSTEM.md override every automatic title
	 * request uses. Refresh the override via {@link AgentSession.setTitleSystemPrompt} when the
	 * session cwd changes.
	 */
	readonly #replanTitle: ReplanTitleRefresh;
	#toolChoiceQueue = new ToolChoiceQueue();
	/** The evidence ledger and the rewind, verification and review reminders a settling turn is sent. */
	readonly #finalize: FinalizeReminders;
	/** The routing a run that ended goes through before extensions see its `agent_end`; see {@link StopSettlement}. */
	readonly #stopSettlement: StopSettlement;

	/** Running user shell commands and eval runs, and the results recorded while a turn streamed. */
	readonly #executions = new UserExecutions({
		isStreaming: () => this.isStreaming,
		append: message => {
			this.agent.appendMessage(message);
			this.sessionManager.appendMessage(message);
		},
		cwd: () => this.sessionManager.getCwd(),
		sessionId: () => this.sessionId,
		evalSessionId: () => this.getEvalSessionId(),
		evalKernelOwnerId: () => this.#evalKernelOwnerId,
		extensions: () => this.#config.extensionRunner,
		settings: () => this.settings,
		saveArtifact: (content, type) => this.sessionManager.saveArtifact(content, type),
	});

	// Python execution state
	#evalKernelOwnerId: string;
	/** The background jobs this session owns: delivery, snapshot, cancellation and the wake they hold; see {@link OwnedAsyncJobs}. */
	readonly #ownedJobs: OwnedAsyncJobs;
	/** The spawned agents, registry scope, IRC traffic, grants and kernels a conversation ends with; see {@link ConversationRelease}. */
	readonly #conversation: ConversationRelease;
	/** The jobs, job manager, eval kernels, session resources and MCP hold the session ends with; see {@link SessionRelease}. */
	readonly #release: SessionRelease;

	/** IRC records reaching this session, the wake turns and auto-replies they start; see {@link IrcDelivery}. */
	readonly #irc: IrcDelivery;
	/** Provider session ids, the inherited prompt cache key, and the transport state they route. */
	readonly #providerSessions: ProviderSessions;
	/** The per-family service tiers `/fast` and `tier.*` set, and the tier each request resolves to. */
	readonly #tiers: ServiceTiers;
	#isDisposed = false;
	/** Subscribers, the extension forwarding every session event passes through, and the held `agent_end`. */
	readonly #events: SessionEvents;
	readonly #persistence: MessagePersistence;
	/** The tool start markers and the exit entry a later reader learns how the session ended from. */
	readonly #exitRecord: ExitRecord;

	#skills: Skill[];
	readonly #operatorNotices: OperatorNotices;

	// Tool registry and prompt builder for extensions
	#toolRegistry: Map<string, AgentTool>;
	/** Per-request provider shaping every request of this session goes out through. */
	readonly #wire: ProviderWire;
	/**
	 * The cwd/rescope/switch transaction queue and the directory last re-scoped. Work is appended
	 * synchronously, so commits and rollbacks occur in monotonic initiation order.
	 */
	readonly #scope: SessionScope;
	/** Loads another transcript into this session, and rolls back a load that fails part way. */
	readonly #sessionSwitch: SessionSwitch;
	readonly #sessionBranch: SessionBranch;
	readonly #sessionHandoff: SessionHandoff;
	/** The response and raw SSE interceptors every request runs with, and the side-request transport. */
	readonly #transport: ProviderTransport;
	/**
	 * The side transport, for a subsystem outside this class that makes a request
	 * on the session's behalf: the first-input title, a spawned agent's label.
	 * Handing this over is what gives such a request the same watchdogs, in-flight
	 * cap and provider-concurrency bracket every summarization already has.
	 */
	get sideComplete(): SideCompleteImpl {
		return this.#transport.sideComplete;
	}
	/** The active tool set and the base system prompt rendered for it. */
	readonly #toolActivation: ToolActivation;
	/** Which registered tools the model can discover and which it selected. Owns all discovery state. */
	readonly #discovery: ToolDiscovery;

	/** Time-Traveling Stream Rules: match rules against a streaming turn and
	 *  deliver matched bodies back to the model. Owns all TTSR state. */
	#ttsr: TtsrRuntime;
	/** The todo board plus the eager prelude, mid-run nudge and stop-time
	 *  reminder that keep it honest. Owns all todo state. */
	#todo: TodoRuntime;
	/** The session-state block and the eager delegate reminders a turn carries ahead of its message. */
	readonly #preludes: TurnPreludes;
	/** The mode blocks, file mentions and extension input a prompt carries beside its own message. */
	readonly #turnInput: TurnInput;
	/** How hard the model thinks and who decided: the session override, the
	 *  selector pin, the saved default, and `auto`. Owns all thinking state. */
	#thinking: ThinkingRuntime;
	/** The model switches a caller makes and the scoped models Ctrl+P cycles through. */
	readonly #models: ModelSelection;
	/** Stops a turn while an `edit` call streams into an auto-generated file or a
	 *  patch that cannot apply. Owns all streaming-edit check state. */
	readonly #streamingEdit: StreamingEditGuard;
	/** One-shot flag for expected internal plan-mode aborts. Approval actions may
	 *  abort the post-`resolve` continuation before compaction, execution, or
	 *  manual refinement. Consumed inside `#handleAgentEvent` for the matching
	 *  `message_end` + `stopReason: "aborted"`; callers clear it in `finally` so
	 *  it cannot leak into later unrelated aborts. */
	#planInternalAbortPending = false;
	#pendingAbortErrorId?: number;

	/** Work a turn left behind after `prompt()` returned; see {@link PostPromptTasks}. */
	readonly #postPrompt = new PostPromptTasks({ promptGeneration: () => this.#promptGeneration });
	/** The turns the session starts on its own after a prompt, and the wait for them; see {@link TurnContinuations}. */
	readonly #continuations: TurnContinuations;
	/** What a reader copies, dumps or exports out of the transcript; see {@link TranscriptExports}. */
	readonly #exports: TranscriptExports;
	/** Hidden messages queued for the next turn and the turn scheduled on them; see {@link NextTurnMessages}. */
	readonly #nextTurn = new NextTurnMessages({
		promptGeneration: () => this.#promptGeneration,
		postPrompt: this.#postPrompt,
		promptWith: (message, prepended) =>
			this.#promptWithMessage(message, getCustomMessageTextContent(message), {
				prepended,
				skipPostPromptRecoveryWait: true,
			}),
	});
	/** Steers and follow-ups waiting on the agent's queues and the drain that starts a turn on them; see {@link QueuedMessages}. */
	readonly #queue: QueuedMessages;
	/** How a custom message reaches the conversation, by whether a turn is streaming; see {@link CustomMessages}. */
	readonly #custom: CustomMessages;

	/** Prompts in flight and the power assertion held while any runs. */
	readonly #inFlight: TurnsInFlight;
	#abortInProgress = false;
	/**
	 * Turns that ended while `abort()` was running. `abort()` clears `#abortInProgress` once the agent
	 * loop is idle, which is before the turn's settle reads it, so the settle reads this instead.
	 */
	readonly #deliberateAborts = new WeakSet<AssistantMessage>();
	/** The empty-stop and unexpected-stop retry cycles, their reminders and the terminal empty-stop flag. */
	readonly #stopRetries: StopRetries;
	/** Usage headers and turn cost recording, usage reports, saved-reset redeems and Codex auto-redeem. */
	readonly #usage: ProviderUsage;
	/** Stale-result and overflow prunes, image drops, shake and dedup of the recorded history. */
	readonly #rewrites: HistoryRewrites;
	#promptGeneration = 0;
	/** Context usage: the prompt snapshot of the run in flight and the usage anchors it reads. */
	readonly #context: ContextAccounting;
	/** The memory backend's session state, and the recalled block delivered or waiting at the tail. */
	readonly #memory: MemoryContext<AgentSession>;
	/** The `session_stop` hook pass and the continuation chain it queues. */
	readonly #stopHook: SessionStopHook;
	/** Secret obfuscator, runtime lease, provider redaction and display expansion. */
	readonly #secrets: SessionSecrets;
	/** Display copy: secrets deobfuscated and argot handles expanded, with the stream decoder (seam 3). */
	readonly #display: DisplayCopy;
	/** The images a message carries, normalized for the model, and the description a text-only model reads. */
	readonly #images: ImageAttachments;
	/** Resolves the active model's inline-descriptor policy for session dumps. */
	#resolvePruneToolDescriptions: (model: Model) => boolean = () => false;
	/** The open checkpoint, its pending rewind report and the last completed rewind. */
	readonly #checkpoint = new CheckpointRuntime();
	/** The `yield` call that ended the run and whether the run is terminal. */
	readonly #yields = new YieldTracker();
	/** Recent raw SSE traffic for the debug viewer and the report bundle; see {@link ProviderTransport.rawSse}. */
	get rawSseDebugBuffer(): RawSseDebugBuffer | undefined {
		return this.#transport.rawSse;
	}

	#resetPromptMaintenanceState(): void {
		this.#stopRetries.resetForPrompt();
		this.#yields.resetForPrompt();
		this.#retry.resetForPrompt();
	}

	/**
	 * End one in-flight prompt, or every one when `all` is set (the abort path). Once none is left,
	 * emit the deferred `agent_end`, drain what stranded, and drop the turn's agent grants.
	 */
	#endInFlight(all = false): void {
		if (!this.#inFlight.end(all)) return;
		this.#events.releaseHeldAgentEnd();
		this.#drainStrandedQueuedMessages();
		this.#commands.clearGrantedAgents();
	}

	/** A steer/follow-up can land after the agent loop's final queue poll, or
	 *  after an abort stops an auto-continued queued turn. In both cases the
	 *  agent-core queue still holds the message, but no loop is left to poll it.
	 *  Runs whenever the session settles; the guard makes it a no-op when the
	 *  queue was consumed normally or a new turn already started. */
	#drainStrandedQueuedMessages(): void {
		if (this.#abortInProgress) return;
		// A concern steered into a resumed streaming run after a user interrupt can
		// strand at the turn tail (steered past the loop's final boundary poll). While
		// that interrupt's suppression is still in effect, reclaim such advisor steers
		// as visible advice once idle — mirroring abort's advisor-card extraction —
		// so they neither auto-resume the run the user stopped (a non-empty steer queue
		// otherwise bypasses the latch in QueuedMessages.canAutoContinueForFollowUp) nor linger to
		// flush at the next prompt. Real user steers/follow-ups are left untouched.
		if (this.#advisorRoster.autoResumeSuppressed && !this.isStreaming) {
			for (const card of this.#advisorRoster.extractQueuedCards()) {
				this.#advisorRoster.preserveCard(card);
			}
		}
		this.#queue.scheduleDrain();
		this.#irc.resumeStranded();
	}

	/** Command registries, prompt resolution and the agents a `/` command grants for its turn. */
	readonly #commands: PromptCommands;

	/**
	 * Whether a `/` command has granted this agent type for the turn in flight.
	 *
	 * `agent.agents.<name>.enabled` governs what the MODEL may choose. It does
	 * not govern the person typing: `/review` names `reviewer` outright, and someone
	 * running `/review` is asking for a review rather than asking the model whether
	 * to review. The command declares the agents its prompt names, that declaration
	 * is granted for exactly that turn, and the task tool and the eval `agent()`
	 * bridge both consult it.
	 */
	agentGrantedThisTurn(agentName: string): boolean {
		return this.#commands.agentGranted(agentName);
	}

	/**
	 * Arm prewalk outside the normal startup path (the `/prewalk` slash command). See
	 * {@link ModelHandoff.armPrewalk}.
	 */
	armPrewalk(target: Model, thinkingLevel?: ConfiguredThinkingLevel): void {
		this.#handoff.armPrewalk(target, thinkingLevel);
	}

	constructor(config: AgentSessionConfig) {
		this.agent = config.agent;
		this.sessionManager = config.sessionManager;
		this.settings = config.settings;
		this.#config = config;
		// Power assertions are taken per turn; nothing acquired here.
		this.#inFlight = new TurnsInFlight(this.settings);
		this.#events = new SessionEvents(config.extensionRunner, { promptInFlight: () => this.#inFlight.active });
		this.#continuations = new TurnContinuations(this.#postPrompt, {
			agent: this.agent,
			promptGeneration: () => this.#promptGeneration,
			unavailable: () => this.#isDisposed || this.isCompacting || this.isGeneratingHandoff,
			disposed: () => this.#isDisposed,
			beginTurn: () => this.#inFlight.begin(),
			endTurn: () => this.#endInFlight(),
			restoreFallbackPrimary: () => this.#retry.maybeRestoreFallbackPrimary(),
			retryGate: () => this.#retry.gate,
			ttsrResume: () => this.#ttsr.resumePromise,
			releaseTtsrResume: () => this.#ttsr.resolveResume(),
			postCompactionNudges: () => this.#preludes.postCompactionNudges(),
			promptWith: (message, text, prependMessages) =>
				this.#promptWithMessage(message, text, { prependMessages, skipPostPromptRecoveryWait: true }),
		});
		this.#exports = new TranscriptExports({
			agent: this.agent,
			sessionStore: this.sessionManager,
			thinkingLevel: () => this.#thinking.level,
			serviceTierEntry: () => this.#tiers.entry(),
			pruneToolDescriptions: model => this.#resolvePruneToolDescriptions(model),
			convertMessagesToLlm: messages => this.convertMessagesToLlm(messages),
			shareRedactor: () => (this.settings.get("share.redactSecrets") ? this.providerRedactor : undefined),
		});
		this.#irc = new IrcDelivery({
			agent: this.agent,
			isDisposed: () => this.#isDisposed,
			isStreaming: () => this.isStreaming,
			planModeEnabled: () => this.#planMode.enabled,
			asyncEnabled: () => this.settings.get("async.enabled"),
			emitIrcMessage: record => void this.#events.send({ type: "irc_message", message: record }),
			appendToContext: record => this.#custom.append(record),
			canAutoContinueForFollowUp: () => this.#queue.canAutoContinueForFollowUp(),
			beginWakeTurn: () => {
				this.#resetPromptMaintenanceState();
				this.#inFlight.begin();
			},
			endWakeTurn: () => this.#endInFlight(),
			runEphemeralTurn: args => this.runEphemeralTurn(args),
		});
		this.#stopHook = new SessionStopHook({
			isHalted: () => this.#abortInProgress || this.#isDisposed,
			stopHookRunner: () =>
				this.#config.agentKind !== "sub" && this.#config.extensionRunner?.hasHandlers("session_stop")
					? this.#config.extensionRunner
					: undefined,
			promptGeneration: () => this.#promptGeneration,
			turnId: () => Math.max(0, this.#events.extensions.turnIndex - 1),
			sessionId: () => this.sessionId,
			sessionFile: () => this.sessionFile,
			queueContinuation: message => this.#nextTurn.queue(message, true),
		});
		this.#scope = new SessionScope({
			sessionStore: this.sessionManager,
			settings: this.settings,
			agent: this.agent,
			isSpawned: config.isSpawned === true,
			refreshSecrets: () => this.#secrets.refresh({ refreshPrompt: false }),
			refreshSshTool: () => this.refreshSshTool({ activateIfAvailable: true }),
			refreshBaseSystemPrompt: async () => {
				await this.refreshBaseSystemPrompt("cwd-change");
			},
			rootWireAt: cwd => this.#wire.rootAt(cwd),
			emitCwdChanged: (previous, cwd) => this.#events.emit({ type: "cwd_changed", previous, cwd }),
		});
		this.#context = new ContextAccounting({
			sessionStore: this.sessionManager,
			model: () => this.model,
			messages: () => this.messages,
			instrumentationLevel: () => this.settings.get("session.instrumentation"),
			nonMessageTokens: () => computeNonMessageTokens(this),
			nonMessageBreakdown: () => computeNonMessageBreakdown(this),
			storedMessagesTokens: () => computeStoredMessagesTokens(this, { excludeEncryptedReasoning: true }),
		});
		this.#memory = new MemoryContext<AgentSession>({
			session: this,
			backend: () => resolveMemoryBackend(this.settings),
			backendId: () => this.settings.get("memory.backend"),
			sessionId: () => this.agent.sessionId,
			mnemopiState: () => getMnemopiSessionState(this),
			detachMnemopiState: () => setMnemopiSessionState(this, undefined),
			messages: () => this.agent.state.messages,
		});
		this.#providerSessions = new ProviderSessions(
			{
				agent: this.agent,
				sessionStore: this.sessionManager,
				authStorage: () => this.#config.modelRegistry.authStorage,
			},
			{
				configuredId: config.providerSessionId,
				inheritedCacheKey: config.providerPromptCacheKeySource === "fork" ? this.agent.promptCacheKey : undefined,
			},
		);
		this.#tiers = new ServiceTiers(
			{
				model: () => this.model,
				fireworksPriority: () => this.settings.get("providers.fireworksTier") === "priority",
				configuredTiers: () =>
					buildServiceTierByFamily(
						this.settings.get("tier.openai"),
						this.settings.get("tier.anthropic"),
						this.settings.get("tier.google"),
					),
				providerSessionStates: this.#providerSessions.states,
				sessionStore: this.sessionManager,
				emitNotice: (level, message, source) => this.emitNotice(level, message, source),
			},
			config.serviceTierByFamily ?? {},
		);
		this.#persistence = new MessagePersistence({
			sessionStore: this.sessionManager,
			instrumentationLevel: () => this.settings.get("session.instrumentation"),
			pendingContextSnapshot: () => this.#context.pending,
			nonMessageTokens: () => computeNonMessageTokens(this),
			consumeRewoundResult: toolCallId => this.#checkpoint.consumeRewoundResult(toolCallId),
			onTtsrInjectionPersisted: details => this.#ttsr.onInjectionPersisted(details),
		});
		this.#secrets = new SessionSecrets(config, {
			sessionId: () => this.sessionManager.getSessionId(),
			cwd: () => this.sessionManager.getCwd(),
			awaitScopeTransitionReady: () => this.awaitScopeTransitionReady(),
			queueRefresh: options => this.refreshSecrets(options),
			refreshSystemPrompt: async () => {
				await this.refreshBaseSystemPrompt("secrets-refresh");
			},
		});
		this.#transport = new ProviderTransport(
			{
				agent: this.agent,
				ingestUsageHeaders: (response, model) => this.#usage.ingestHeaders(response, model),
				leaseSecretRuntime: () => this.leaseSecretRuntime(),
				payloadHook: () => this.#config.payloadHook?.(),
				sideRequestSettings: () => ({
					openrouterVariant: this.settings.get("providers.openrouterVariant"),
					antigravityEndpoint: this.settings.get("providers.antigravityEndpoint"),
					maxInFlightRequests: this.settings.get("providers.maxInFlightRequests"),
					loopGuardEnabled: this.settings.get("model.loopGuard.enabled"),
					loopGuardChecksAssistantContent: this.settings.get("model.loopGuard.checkAssistantContent"),
				}),
			},
			config,
		);
		this.#display = new DisplayCopy({
			argot: config.argot,
			secrets: this.#secrets,
			sessionStore: this.sessionManager,
		});
		this.#images = new ImageAttachments({
			model: () => this.model,
			messages: () => this.agent.state.messages,
			settings: this.settings,
			modelRegistry: config.modelRegistry,
			localProtocol: localProtocolOptions(this.sessionManager),
			telemetry: () => this.agent.telemetry,
			sessionId: () => this.sessionId,
			thinkingLevel: () => this.thinkingLevel,
		});
		this.#approvals = new SessionApprovals(
			{
				settings: this.settings,
				clientBridge: () => this.#clientBridge,
				cwd: () => this.sessionManager.getCwd(),
				planModeActive: () => this.getPlanModeState()?.enabled === true,
			},
			config,
		);
		this.#evalKernelOwnerId = config.evalKernelOwnerId ?? `agent-session:${Snowflake.next()}`;
		this.#conversation = new ConversationRelease(
			{
				sessionId: () => this.sessionManager.getSessionId?.() ?? undefined,
				forgetToolDecisions: () => this.#approvals.forgetToolDecisions(),
			},
			config.agentId,
			this.#evalKernelOwnerId,
		);
		this.#ownedJobs = new OwnedAsyncJobs(
			{
				messages: () => this.agent.state.messages,
				appendLateToolResult: message => {
					this.agent.appendMessage(message);
					this.#persistence.persistIfMissing(message);
					this.#events.sendDetached({ type: "message_start", message }, "late tool result");
					this.#events.sendDetached({ type: "message_end", message }, "late tool result");
				},
				enqueueAsyncResult: entry => this.yieldQueue.enqueue<AsyncResultEntry>("async-result", entry),
				subscribe: listener => this.subscribe(listener),
				allowingAgentInitiatedTurns: async <T>(run: () => Promise<T>): Promise<T> => {
					const previous = this.#allowAcpAgentInitiatedTurns;
					this.#allowAcpAgentInitiatedTurns = true;
					try {
						return await run();
					} finally {
						this.#allowAcpAgentInitiatedTurns = previous;
					}
				},
			},
			config.asyncJobManager ?? config.ownedAsyncJobManager,
			config.agentId,
		);
		this.#release = new SessionRelease(
			{
				ownedJobs: this.#ownedJobs,
				executions: this.#executions,
				config,
				sessionId: () => this.sessionManager.getSessionId(),
			},
			this.#evalKernelOwnerId,
		);
		this.#thinking = new ThinkingRuntime({
			agent: this.agent,
			sessionStore: this.sessionManager,
			settings: this.settings,
			model: () => this.model,
			modelRegistry: () => this.#config.modelRegistry,
			sessionId: () => this.sessionId,
			obfuscateProviderText: text => this.obfuscateProviderText(text),
			sideComplete: () => this.#transport.sideComplete,
			promptGeneration: () => this.#promptGeneration,
			magicKeywordEnabled: keyword => magicKeywordEnabled(this.settings, keyword),
			clearInheritedProviderPromptCacheKey: reason => this.#providerSessions.clearInheritedCacheKey(reason),
			emitSessionEvent: event => this.#events.emit(event),
		});
		this.#thinking.seedFromConfig(config.thinkingLevel, config.thinkingSource);
		this.#models = new ModelSelection(
			{
				settings: this.settings,
				sessionManager: this.sessionManager,
				thinking: this.#thinking,
				modelRegistry: () => this.#config.modelRegistry,
				model: () => this.model,
				sessionId: () => this.sessionId,
				activeEditMode: () => resolveActiveEditMode(this.settings, this.model),
				installModel: model => {
					this.#retry.clearActiveFallback();
					this.#setModelWithProviderSessionReset(model);
				},
				syncAfterModelChange: previousEditMode => this.#syncAfterModelChange(previousEditMode),
			},
			config.scopedModels ?? [],
		);
		this.#handoff = new ModelHandoff(
			{
				agent: this.agent,
				model: () => this.model,
				setModelTemporary: (model, thinkingLevel) =>
					this.setModelTemporary(model, thinkingLevel, { ephemeral: true }),
				emitNotice: (level, message, source) => this.emitNotice(level, message, source),
				waitForPersistence: message => this.#persistence.waitFor(message),
				todoGateOpen: toolResults => {
					if (toolResults.some(result => result.toolName === TOOL.todo)) this.#todo.noteTodoToolResult();
					return this.#todo.sawTodoTool || !this.#toolRegistry.has(TOOL.todo);
				},
				getActiveToolNames: () => this.getActiveToolNames(),
				hasBuiltInTool: name => this.hasBuiltInTool(name),
				setActiveToolsByName: toolNames => this.setActiveToolsByName(toolNames),
				getPlanModeState: () => this.getPlanModeState(),
				setPlanModeState: state => this.setPlanModeState(state),
				getPlanReferencePath: () => this.getPlanReferencePath(),
				setStandingResolveHandler: handler => this.setStandingResolveHandler(handler),
				resolvePlanPath: planFilePath => resolvePlanPath(this.sessionManager, planFilePath),
				localRootPath: () => resolveLocalUrlToPath("local://", localProtocolOptions(this.sessionManager)),
			},
			{ prewalk: config.prewalk, planYolo: config.planYolo },
		);
		this.#planMode = new PlanModeRuntime({
			agent: this.agent,
			sessionStore: this.sessionManager,
			toolChoices: this.#toolChoiceQueue,
			lastAssistantMessage: () => findLastAssistantMessage(this.agent.state.messages),
			hasTool: name => this.#toolRegistry.has(name),
			taskTool: () => this.#toolRegistry.get(TOOL.task),
			resolvePlanPath: planFilePath => resolvePlanPath(this.sessionManager, planFilePath),
			localProtocolOptions: () => localProtocolOptions(this.sessionManager),
			activeEditMode: () => resolveActiveEditMode(this.settings, this.model),
			scheduleAgentContinue: options => this.#continuations.scheduleContinue(options),
			promptGeneration: () => this.#promptGeneration,
		});

		this.#commands = new PromptCommands(this, {
			promptTemplates: config.promptTemplates,
			slashCommands: config.slashCommands,
			customCommands: config.customCommands,
		});
		this.#skills = config.skills ?? [];
		this.#operatorNotices = config.operatorNotices ?? new OperatorNotices(stderrNoticeSink);
		// The session budget: registered under the current id with every
		// Resources limit, following id changes and live setting changes.
		// Cleanup of the limiter rides the "session"-scoped owned-resource
		// disposers in dispose().
		this.#listenerReleases.push(
			bindSessionBudget({
				sessionStore: this.sessionManager,
				settings: this.settings,
				onNotice: text => this.#operatorNotices.warn("cpu", text),
			}),
		);
		// Resolve the wire service-tier per request so the Fireworks Priority
		// toggle scopes priority to Fireworks alone, without mutating the shared
		// session `serviceTier` that drives `/fast` and OpenAI/Anthropic priority.
		this.agent.serviceTierResolver = model => this.#tiers.effective(model);
		// Prompt-cache enforcement, from the two operator settings. Reporting is on
		// by default and blocking is opt-in, so the common case warns; a `false`
		// report setting silences the check entirely, which is what `off` means to
		// the provider. Read once here because both settings are session-level; a
		// change takes effect on the next session, matching the other agent-level
		// wiring in this constructor.
		//
		// Compared against `true` rather than used for truthiness, because a config
		// file is not type-checked: a hand-edited `blockOnRejection: "false"`
		// arrives as the STRING "false", which is truthy, and would have turned
		// hard blocking on for an operator whose config says it is off. The
		// settings conditions in `settings-defs.ts` read booleans the same way.
		this.agent.cacheEnforcement =
			this.settings.get("cache.reportRejection") === true
				? this.settings.get("cache.blockOnRejection") === true
					? "error"
					: "warn"
				: "off";
		this.#replanTitle = new ReplanTitleRefresh(
			{
				agent: this.agent,
				sessionStore: this.sessionManager,
				settings: this.settings,
				modelRegistry: config.modelRegistry,
				model: () => this.model,
				obfuscateProviderText: text => this.obfuscateProviderText(text),
				sideComplete: this.#transport.sideComplete,
			},
			config.titleSystemPrompt,
		);
		this.#resolvePruneToolDescriptions =
			typeof config.pruneToolDescriptions === "function"
				? config.pruneToolDescriptions
				: () => config.pruneToolDescriptions === true;
		for (const warning of configWarningsFor(this.settings, config.modelRegistry)) {
			logger.warn(warning);
			this.configWarnings.push(warning);
		}
		this.#toolRegistry = config.toolRegistry ?? new Map();
		this.#wire = new ProviderWire({
			settings: this.settings,
			cwd: this.sessionManager.getCwd(),
			upstream: config.transformProviderContext,
			secrets: this.#secrets,
		});
		// Agent was constructed before AgentSession; install the wire so the main loop, side
		// requests and advisors share one session-local tool-call id map.
		this.agent.setTransformProviderContext(this.#wire.transform);
		const loopGuards = new LoopGuards({
			agent: this.agent,
			sessionStore: this.sessionManager,
			settings: this.settings,
			model: () => this.model,
			promptGeneration: () => this.#promptGeneration,
			isDisposed: () => this.#isDisposed,
			emitNotice: (level, message, source) => this.emitNotice(level, message, source),
			schedulePostPromptTask: task => this.#postPrompt.schedule(task),
			discardAssistantTurn: message => this.#discardAssistantTurn(message),
		});
		this.agent.setOnTurnEnd(async (messages, signal, context) => {
			if (signal?.aborted) return;
			const rewindReport = this.#checkpoint.takeReport(messages);
			if (rewindReport) {
				await this.#applyRewind(rewindReport, messages);
			}
			if (context?.message.role === "assistant") {
				loopGuards.onTurnEnd(messages, { message: context.message, toolResults: context.toolResults });
			}
			await this.#handoff.advancePrewalk(messages, context);
			await this.#advisorRoster.onPrimaryTurnEnd(messages, context?.willContinue, signal);
			await this.#contextCheck.betweenProviderCalls(messages, signal, context);
		});
		this.yieldQueue = new YieldQueue({
			isStreaming: () => this.isStreaming,
			injectIdle: async messages => {
				const first = messages[0];
				if (!first) return;
				await this.agent.prompt(messages.length === 1 ? first : messages);
			},
			scheduleIdleFlush: run => {
				this.#postPrompt.schedule(
					async () => {
						await run();
					},
					{ delayMs: 1 },
				);
			},
		});
		// Background-job completions / late diagnostics are pulled into the run at
		// each step boundary as non-interrupting asides. Peer IRCs share the aside
		// injection boundary, but also expose a non-consuming interrupt peek so
		// `job poll` / `irc wait` can return early before the boundary drains them.
		this.agent.hasIrcInterrupts = () => this.#irc.inbox.hasInterrupts;
		this.agent.setAsideMessageProvider(() => {
			const pendingIrc = this.#irc.inbox.takeAll();
			const thunks: AsideMessage[] = pendingIrc.map(record => () => record);
			thunks.push(...this.yieldQueue.drainLazy());
			// Mid-run todo reconciliation — evaluated at injection time so a turn
			// that flips a todo just before this poll suppresses the nudge.
			thunks.push(() => this.#todo.takeMidRunNudge());
			// Memory context published mid-run (a recall on `agent_start`, a
			// mental-model reload) rides in here instead of rewriting the system
			// prompt, which would cost a full uncached re-read of the conversation.
			thunks.push(() => this.#memory.takePending());
			// Tool-scoped TTSR reminders. An aside rather than a steer: a steer
			// aborts the tool batch still in flight, and a reminder about a call
			// that already finished has no business cutting its siblings short.
			thunks.push(() => this.#ttsr.takePendingToolReminders());
			return thunks;
		});
		this.#discovery = new ToolDiscovery(
			{
				registry: this.#toolRegistry,
				activeToolNames: () => this.getActiveToolNames(),
				discoveryModeFor: toolCount => resolveEffectiveToolDiscoveryMode(this.settings, toolCount),
			},
			config,
		);
		this.#toolActivation = new ToolActivation(this, {
			registry: this.#toolRegistry,
			discovery: this.#discovery,
			approvals: this.#approvals,
			providerSessions: this.#providerSessions,
			config,
			customToolContext: () => this.#customToolContext(),
		});
		const persistInitialMCPToolSelection =
			config.persistInitialMCPToolSelection ?? this.sessionManager.getBranch().length === 0;
		if (this.#discovery.mcpEnabled && persistInitialMCPToolSelection) {
			const currentSelectedMCPToolNames = this.getSelectedMCPToolNames();
			if (!sameToolNames(this.sessionManager.getMCPToolSelection() ?? [], currentSelectedMCPToolNames)) {
				this.sessionManager.appendMCPToolSelection(currentSelectedMCPToolNames);
			}
		}
		this.#discovery.rememberSessionDefaults(this.sessionManager.getSessionFile());
		this.#streamingEdit = new StreamingEditGuard({
			abortTurn: () => this.agent.abort(),
			streamingAbortEnabled: () => this.settings.get("edit.streamingAbort"),
			fuzzyMatch: () => ({
				allowFuzzy: this.settings.get("edit.fuzzyMatch"),
				fuzzyThreshold: this.settings.get("edit.fuzzyThreshold"),
			}),
			cwd: () => this.sessionManager.getCwd(),
			localProtocol: () => localProtocolOptions(this.sessionManager),
			expandSecretsForDiskComparison: text => this.#secrets.expandForDiskComparison(text),
			redactForLog: text => this.#secrets.redactForLog(text),
		});
		this.#stopRetries = new StopRetries({
			agent: this.agent,
			sessionStore: this.sessionManager,
			unexpectedStopDetection: () => this.settings.get("features.unexpectedStopDetection") === true,
			classifyUnexpectedStop: (text, signal) =>
				classifyUnexpectedStop(text, {
					settings: this.settings,
					registry: this.#config.modelRegistry,
					model: this.model ?? undefined,
					sessionId: this.sessionId,
					metadataResolver: provider => this.agent.metadataForProvider(provider),
					signal,
					obfuscateProviderText: providerText => this.obfuscateProviderText(providerText),
					completeImpl: this.#transport.sideComplete,
				}),
			promptGeneration: () => this.#promptGeneration,
			scheduleAgentContinue: options => this.#continuations.scheduleContinue(options),
			discardAssistantTurn: message => this.#discardAssistantTurn(message),
			removeAssistantFromActiveContext: (message, reason) =>
				removeAssistantMessageFromActiveContext(this.agent, message, reason),
			endAnnouncedContinuationWait: finalError => this.#retry.endAnnouncedContinuationWait(finalError),
			failAtEmptyStopCap: (attempts, finalError) => this.#retry.failAtEmptyStopCap(attempts, finalError),
		});
		this.#usage = new ProviderUsage({
			authStorage: () => this.#config.modelRegistry.authStorage,
			providerBaseUrl: provider => this.#config.modelRegistry.getProviderBaseUrl?.(provider),
			settings: this.settings,
			sessionId: () => this.#providerSessions.activeId(),
			agentSessionId: () => this.agent.sessionId,
			model: () => this.model ?? undefined,
			emitNotice: (level, message, source) => this.emitNotice(level, message, source),
			ui: () => (this.#config.extensionRunner?.hasUI() ? this.#config.extensionRunner.getUIContext() : undefined),
		});
		this.#rewrites = new HistoryRewrites({
			sessionStore: this.sessionManager,
			agent: this.agent,
			settings: this.settings,
			withPlanProtection: config => this.#planMode.withProtection(config),
			model: () => this.model,
			keepBoundaryId: branch => contextCompaction(branch)?.firstKeptEntryId,
			rebuiltMessages: () => this.buildDisplaySessionContext().messages,
			resetAdvisorRuntimes: () => this.#resetAllAdvisorRuntimes(),
			closeCodexSessions: () => this.#providerSessions.closeCodexForHistoryRewrite(this.model),
			markHistoryRewritten: () => this.#context.markHistoryRewritten(),
			syncTodos: () => this.#todo.syncFromBranch(),
		});
		this.#finalize = new FinalizeReminders({
			agent: this.agent,
			sessionStore: this.sessionManager,
			settings: this.settings,
			isSpawned: () => config.isSpawned === true,
			awaitingRewind: () => this.#checkpoint.awaitingRewind,
			scheduleContinue: () => this.#continuations.scheduleContinue({ generation: this.#promptGeneration }),
			activeToolNames: () => this.getActiveToolNames(),
		});
		this.#ttsr = new TtsrRuntime(
			{
				agent: this.agent,
				sessionStore: this.sessionManager,
				argotEnabled: () => this.settings.get("argot.enabled") === true,
				argotLoaded: () => this.#config.argot?.loaded === true,
				promptGeneration: () => this.#promptGeneration,
				emitSessionEventDetached: (event, context) => this.#events.sendDetached(event, context),
				scheduleAgentContinue: options => this.#continuations.scheduleContinue(options),
				schedulePostPromptTask: (task, options) => this.#postPrompt.schedule(task, options),
			},
			config.ttsrManager,
		);
		this.#todo = new TodoRuntime({
			agent: this.agent,
			sessionStore: this.sessionManager,
			todoSettings: () => ({
				enabled: this.settings.get("todo.enabled"),
				reminders: this.settings.get("todo.reminders"),
				remindersMax: this.settings.get("todo.reminderLimit"),
				eager: this.settings.get("todo.eager"),
			}),
			model: () => this.model,
			planModeEnabled: () => this.#planMode.enabled,
			goalModeActive: () => this.#goalModeState?.enabled === true && this.#goalModeState.goal.status === "active",
			activeToolNames: () => this.getActiveToolNames(),
			eagerPreludeContext: () => this.#preludes.eagerContext(),
			consumeLastServedToolChoiceLabel: () => this.#toolChoiceQueue.consumeLastServedLabel(),
			hasPendingAsyncWake: () => this.#ownedJobs.hasPendingWake(),
			emitSessionEvent: event => this.#events.send(event),
			scheduleAgentContinue: options => this.#continuations.scheduleContinue(options),
			promptGeneration: () => this.#promptGeneration,
		});
		this.#preludes = new TurnPreludes({
			settings: this.settings,
			sessionStore: this.sessionManager,
			todo: this.#todo,
			isSubagent: this.#config.agentKind === "sub",
			messages: () => this.agent.state.messages,
			appendMessage: message => this.agent.appendMessage(message),
			tool: name => this.#toolRegistry.get(name),
			activeToolNames: () => this.getActiveToolNames(),
			planModeEnabled: () => this.#planMode.enabled,
		});
		this.#turnInput = new TurnInput({
			planMode: this.#planMode,
			images: this.#images,
			config: this.#config,
			agent: this.agent,
			mentionSource: this,
			activeGoalPrompt: () => this.#goalRuntime.buildActivePrompt(),
			goalTodoContext: () => buildGoalTodoContext(this),
			vibeModeEnabled: () => this.#vibeModeState?.enabled === true,
			cwd: () => this.sessionManager.getCwd(),
			model: () => this.model,
			autoResizeImages: () => this.settings.get("images.autoResize"),
			baseSystemPrompt: () => this.#toolActivation.baseSystemPrompt,
		});
		// Runs synchronously on the stream, ahead of the queued `message_update`, so a guard abort
		// lands on the delta that earned it.
		this.agent.setAssistantMessageEventInterceptor((message, assistantMessageEvent) => {
			this.#streamingEdit.observe(message, assistantMessageEvent);
			loopGuards.observe(message, assistantMessageEvent);
		});
		// The tool-result hook is the single site for synchronous post-tool actions that must affect the current loop.
		this.agent.afterToolCall = ctx => this.#afterToolCall(ctx);
		this.agent.providerSessionState = this.#providerSessions.states;
		this.#providerSessions.sync();
		this.#todo.syncFromBranch();
		this.#goalRuntime = new GoalRuntime({
			getState: () => this.#goalModeState,
			setState: state => {
				this.#goalModeState = state;
			},
			budgetsEnabled: () => this.settings.get("goal.modelBudgetsEnabled"),
			getCurrentUsage: () => this.#goalUsage(),
			emit: event => {
				if (event.type === "goal_updated") {
					return this.#events.send({ type: "goal_updated", goal: event.goal, state: event.state });
				}
			},
			persist: (mode, state) => recordGoal(this.sessionManager, mode, state),
			sendHiddenMessage: async message => {
				await this.sendCustomMessage(
					{
						customType: message.customType,
						content: message.content,
						display: false,
						attribution: "agent",
					},
					{ deliverAs: message.deliverAs },
				);
			},
		});
		this.#exitRecord = new ExitRecord({
			sessionStore: this.sessionManager,
			redact: text => this.obfuscateProviderText(text),
		});

		this.#advisorRoster = this.#createAdvisorRoster(config);
		this.#advisorRoster.enableFromSettings();
		this.#queue = new QueuedMessages({
			agent: this.agent,
			isStreaming: () => this.isStreaming,
			isRetrying: () => this.isRetrying,
			advisors: this.#advisorRoster,
			textWithImages: (text, images) => this.#images.textWithImages(text, images),
			scheduleContinue: () => this.#continuations.scheduleContinue(),
			nextTurnCount: () => this.#nextTurn.count,
		});
		this.#custom = new CustomMessages({
			images: this.#images,
			nextTurn: this.#nextTurn,
			queue: this.#queue,
			agent: this.agent,
			sessionStore: this.sessionManager,
			startupHydration: () => this.#startupHydration,
			isStreaming: () => this.isStreaming,
			defersAgentInitiatedTurns: () =>
				this.#clientBridge?.deferAgentInitiatedTurns === true && !this.#allowAcpAgentInitiatedTurns,
			promptAgentInitiated: (message, options) => this.#promptAgentInitiatedMessage(message, options),
			promptWithMessage: (message, text, options) => this.#promptWithMessage(message, text, options),
			keywordNotices: text => createMagicKeywordNotices(this, text),
		});
		this.#sessionSwitch = this.#createSessionSwitch();
		this.#sessionBranch = this.#createSessionBranch();
		this.#sessionHandoff = this.#createSessionHandoff();
		this.#stopSettlement = new StopSettlement({
			yields: this.#yields,
			persistence: this.#persistence,
			handoff: this.#sessionHandoff,
			contextCheck: this.#contextCheck,
			stopRetries: this.#stopRetries,
			retry: this.#retry,
			finalize: this.#finalize,
			planMode: this.#planMode,
			todo: this.#todo,
			ownedJobs: this.#ownedJobs,
			stopHook: this.#stopHook,
			goalMode: () => this.#goalModeState,
			forgetCredentials: provider => this.#config.modelRegistry.authStorage.remove(provider),
			dropFromActiveContext: message => removeAssistantMessageFromActiveContext(this.agent, message),
		});

		this.#checkpoint.rehydrate(this.sessionManager.getBranch());

		// Always subscribe to agent events for internal handling
		// (session persistence, hooks, auto-compaction, retry logic)
		this.#unsubscribeAgent = this.agent.subscribe(this.#handleAgentEvent);
		// Re-evaluate append-only context mode when the setting changes at runtime.
		this.#listenerReleases.push(
			onAppendOnlyModeChanged(_value => this.#syncAppendOnlyContext(this.model)),
			onHelperModelsChanged(() => this.#advisorRoster.onHelperModelsChanged()),
		);
		const unsubscribePromptSettings = this.settings.onEffectiveSettingChanged((path, value) => {
			if (this.#isDisposed) return;
			// Disabling either half of the todo-reminder feature is an explicit
			// lifecycle boundary. Reset synchronously with the effective setting
			// write rather than waiting for a later agent_end: there may be no stop
			// while disabled, and a stale self-continuation latch would otherwise
			// survive disable/re-enable and silence the fresh runway.
			if ((path === "todo.reminders" || path === "todo.enabled") && value === false) {
				this.#todo.onRemindersDisabled();
			}
			if (!rebuildsThePrompt(path)) return;
			this.#promptRefresh = this.#promptRefresh
				.then(async () => {
					if (!this.#isDisposed) await this.refreshBaseSystemPrompt(`setting:${path}`);
				})
				.catch(error => {
					// `warn`, not `debug`: this is the only report a failed rebuild gets
					// now that the trigger lives here rather than in the settings UI, and
					// the session it leaves behind is describing a configuration the
					// operator has already changed.
					logger.warn("System prompt refresh after setting change failed", {
						path,
						error: errorMessage(error),
					});
				});
		});
		this.#listenerReleases.push(unsubscribePromptSettings);
	}

	/** The advisor roster, reaching this session only through the host it declares. */
	#createAdvisorRoster(config: AgentSessionConfig): AdvisorRoster {
		const host: AdvisorRosterHost = {
			agent: this.agent,
			yieldQueue: this.yieldQueue,
			settings: this.settings,
			modelRegistry: this.#config.modelRegistry,
			providerSessionState: this.#providerSessions.states,
			sideComplete: this.#transport.sideComplete,
			agentKind: config.agentKind ?? "main",
			provider: {
				streamFn: config.advisorStreamFn,
				preferWebsockets: config.preferWebsockets,
				payloadHook: config.payloadHook,
				onResponse: this.#transport.onResponse,
				onSseEvent: this.#transport.onSseEvent,
				transformProviderContext: this.#wire.transform,
				resolveSecretRuntimeLeaseForContext: this.#secrets.resolveLeaseForContext,
			},
			sessionFile: () => this.sessionManager.getSessionFile(),
			cwd: () => this.sessionManager.getCwd(),
			sessionId: () => this.sessionId,
			isDisposed: () => this.#isDisposed,
			abortInProgress: () => this.#abortInProgress,
			isStreaming: () => this.isStreaming,
			planModeEnabled: () => this.#planMode.enabled,
			hasTerminalTextAnswerWithoutQueuedWork: () => this.hasTerminalTextAnswerWithoutQueuedWork(),
			emitNotice: (level, message, source) => this.emitNotice(level, message, source),
			steerAdvice: async (content, details) => {
				await this.sendCustomMessage(
					{ customType: "advisor", content, display: true, attribution: "agent", details },
					{ deliverAs: "steer", triggerTurn: true },
				);
			},
			parkForNextTurn: card => this.#nextTurn.queue(card, false),
			dropParkedAdvisorCards: () => {
				this.#nextTurn.remove(isAdvisorCard);
			},
			leaseSecretRuntime: () => this.leaseSecretRuntime(),
			providerRedactor: () => this.providerRedactor,
			effectiveServiceTier: model => this.#tiers.effective(model),
			primaryPromptCacheKey: () => this.agent.promptCacheKey,
			resolveContextPromotionTarget: (model, contextWindow) =>
				this.#contextCheck.promotionTarget(model, contextWindow),
			convertToLlmForSideRequest: messages => this.#convertToLlmForSideRequest(messages),
			primaryContextBudget: () => ({
				nonMessageTokens: computeNonMessageTokens(this),
				contextWindow: declaredContextWindow(this.model),
			}),
			saveArtifact: (content, toolType) => this.sessionManager.saveArtifact(content, toolType),
		};
		return new AdvisorRoster(host, config.loadAdvisorTools, config);
	}

	/** Branching and tree navigation, reaching this session only through the host it declares. */
	#createSessionBranch(): SessionBranch {
		return new SessionBranch(this, {
			checkpoint: this.#checkpoint,
			todo: this.#todo,
			providerSessions: this.#providerSessions,
			memory: this.#memory,
			advisorRoster: this.#advisorRoster,
			secrets: this.#secrets,
			extensionRunner: () => this.#config.extensionRunner,
			modelRegistry: () => this.#config.modelRegistry,
			payloadHook: () => this.#config.payloadHook?.(),
			sideComplete: this.#transport.sideComplete,
			effectiveServiceTier: model => this.#tiers.effective(model),
			clearNextTurnMessages: () => this.#nextTurn.clear(),
			cancelOwnAsyncJobs: () => this.#ownedJobs.cancelOwn(),
			cancelPostPromptTasks: () => this.#continuations.cancel(),
			resetMemoryContextForNewTranscript: () => this.#resetMemoryContextForNewTranscript(),
			restoreMCPSelectionsForSessionContext: sessionContext =>
				this.#toolActivation.restoreMCPSelections(sessionContext),
		});
	}

	/** The handoff, reaching this session only through the host it declares. */
	#createSessionHandoff(): SessionHandoff {
		return new SessionHandoff(this, {
			checkpoint: this.#checkpoint,
			todo: this.#todo,
			providerSessions: this.#providerSessions,
			memory: this.#memory,
			secrets: this.#secrets,
			sideComplete: this.#transport.sideComplete,
			extensionRunner: () => this.#config.extensionRunner,
			modelRegistry: () => this.#config.modelRegistry,
			baseSystemPrompt: () => this.#toolActivation.baseSystemPrompt,
			effectiveServiceTier: model => this.#tiers.effective(model),
			clearNextTurnMessages: () => this.#nextTurn.clear(),
			cancelOwnAsyncJobs: () => this.#ownedJobs.cancelOwn(),
			endConversation: () => this.#conversation.release(),
			resetMemoryContextForNewTranscript: () => this.#resetMemoryContextForNewTranscript(),
			resetAllAdvisorRuntimes: () => this.#resetAllAdvisorRuntimes(),
		});
	}

	/** The session switch, reaching this session only through the host it declares. */
	#createSessionSwitch(): SessionSwitch {
		return new SessionSwitch(this, {
			scope: this.#scope,
			wire: this.#wire,
			providerSessions: this.#providerSessions,
			memory: this.#memory,
			planMode: this.#planMode,
			discovery: this.#discovery,
			checkpoint: this.#checkpoint,
			thinking: this.#thinking,
			todo: this.#todo,
			advisorRoster: this.#advisorRoster,
			extensionRunner: () => this.#config.extensionRunner,
			modelRegistry: () => this.#config.modelRegistry,
			whileDisconnectedFromAgent: run => this.#whileDisconnectedFromAgent(run),
			reconcileAfterSwitch: () => this.#sessionSwitchReconciler?.(),
			captureFields: () => ({
				nextTurn: this.#nextTurn.snapshot(),
				baseSystemPrompt: this.#toolActivation.baseSystemPrompt,
				serviceTierByFamily: this.#tiers.byFamily,
			}),
			restoreFields: fields => {
				this.#nextTurn.restore(fields.nextTurn);
				this.#toolActivation.baseSystemPrompt = fields.baseSystemPrompt;
				this.#tiers.replace(fields.serviceTierByFamily);
			},
			clearNextTurnMessages: () => this.#nextTurn.clear(),
			setServiceTierByFamily: byFamily => this.#tiers.replace(byFamily),
			serviceTierEntry: () => this.#tiers.entry(),
			applyToolNames: async toolNames => {
				await this.#toolActivation.apply(toolNames, { persistMCPSelection: false });
			},
			cancelOwnAsyncJobs: () => this.#ownedJobs.cancelOwn(),
			restoreMCPSelectionsForSessionContext: (sessionContext, options) =>
				this.#toolActivation.restoreMCPSelections(sessionContext, options),
			setModelWithProviderSessionReset: model => this.#setModelWithProviderSessionReset(model),
			resetMemoryContextForNewTranscript: () => this.#resetMemoryContextForNewTranscript(),
			endConversation: () => this.#conversation.release(),
			resetAllAdvisorRuntimes: () => this.#resetAllAdvisorRuntimes(),
		});
	}

	/**
	 * Whether the conversation is resting on an answer: the last turn ended on its own with text
	 * for the user, and nothing is queued behind it. Advisor routing asks so a note can be kept as
	 * a card rather than waking a duplicate completion turn, and `/rephrase` asks so it only
	 * submits when there is something to rephrase — mid-turn the reply is still arriving, a turn
	 * that ended in tool calls or an error said nothing, and a queued message means the answer on
	 * screen is already superseded. Trailing advisor cards are not answers and do not count.
	 */
	hasTerminalTextAnswerWithoutQueuedWork(): boolean {
		if (this.agent.hasQueuedMessages() || this.#nextTurn.count > 0) return false;
		const messages = this.agent.state.messages;
		let tail = messages.length - 1;
		while (tail >= 0 && isAdvisorCard(messages[tail])) tail--;
		return isTerminalTextAssistantAnswer(messages[tail]);
	}

	/** Re-prime every advisor's transcript view and TTSR's after a transcript rewrite
	 *  (compaction/shake/rewind), without the session-level latch reset
	 *  {@link AdvisorRoster.resetSessionState} performs. */
	#resetAllAdvisorRuntimes(): void {
		this.#advisorRoster.resetRuntimes();
		this.#ttsr.onCompaction();
	}

	/** Model registry for API key resolution and model discovery */
	get modelRegistry(): ModelRegistry {
		return this.#config.modelRegistry;
	}

	get asyncJobManager(): AsyncJobManager | undefined {
		return this.#ownedJobs.manager;
	}

	getAgentId(): string | undefined {
		return this.#config.agentId;
	}

	/** Dequeue the next HARD forced tool choice for the upcoming LLM call, dropping
	 *  (and rejecting) one whose named tool is no longer active. */
	#nextHardToolChoice(): ToolChoice | undefined {
		const choice = this.#toolChoiceQueue.nextToolChoice();
		if (isToolChoiceActive(choice, this.agent.state.tools)) {
			return choice;
		}
		this.#toolChoiceQueue.reject("unavailable");
		return undefined;
	}

	/**
	 * The per-turn tool-choice directive for the agent loop's `getToolChoice`. Priority:
	 *   1. a HARD forced choice from the queue (genuine forces: user-force, eager-todo, …) —
	 *      consuming (advances the queue generator);
	 *   2. else, when a non-forcing preview is pending, a {@link SoftToolRequirement} — a
	 *      PEEK (advances/pops nothing), so the agent-loop injects the reminder once per head
	 *      and escalates to a forced `resolve` only if the model declines. A compliant turn
	 *      pays ZERO tool_choice change (no prompt-cache messages-cache invalidation);
	 *   3. else undefined.
	 */
	nextToolChoiceDirective(): ToolChoiceDirective | undefined {
		const hard = this.#nextHardToolChoice();
		if (hard !== undefined) return hard;
		const head = this.#toolChoiceQueue.peekPendingHead();
		if (head !== undefined) {
			return {
				soft: true,
				id: head.id,
				toolName: "resolve",
				reminder: [buildResolveReminderMessage(head.sourceToolName)],
			};
		}
		return undefined;
	}

	/** Peek the head non-forcing pending preview invoker, for the `resolve` tool's dispatch. */
	peekPendingInvoker(): ((input: unknown) => Promise<unknown> | unknown) | undefined {
		return this.#toolChoiceQueue.peekPendingInvoker();
	}

	/** Clear stale non-forcing pending preview invokers after `resolve` proves none can run. */
	clearPendingInvokers(): void {
		this.#toolChoiceQueue.clearPendingInvokers();
	}

	/**
	 * Force the next model call to target a specific active tool, then terminate
	 * the agent loop. Pushes a two-step sequence [forced, "none"] so the model
	 * calls exactly the forced tool once and then cannot call another.
	 */
	setForcedToolChoice(toolName: string): void {
		if (!this.getActiveToolNames().includes(toolName)) {
			throw new Error(`Tool "${toolName}" is not currently active.`);
		}

		const forced = buildNamedToolChoice(toolName, this.model);
		if (!forced || typeof forced === "string") {
			throw new Error("Current model does not support forcing a specific tool.");
		}

		this.#toolChoiceQueue.pushSequence([forced, "none"], {
			label: "user-force",
			onRejected: () => "requeue",
		});
	}

	/** The tool-choice queue: forces forthcoming tool invocations and carries handlers. */
	get toolChoiceQueue(): ToolChoiceQueue {
		return this.#toolChoiceQueue;
	}

	/** Peek the in-flight directive's invocation handler for use by the resolve tool. */
	peekQueueInvoker(): ((input: unknown) => Promise<unknown> | unknown) | undefined {
		return this.#toolChoiceQueue.peekInFlightInvoker();
	}

	/** Standing (long-lived) handler the `resolve` tool falls back to when no
	 *  queue invoker is in flight. Used by plan mode so the agent can submit
	 *  approval via `resolve` without forcing the tool choice every turn. */
	#standingResolveHandler: ((input: unknown) => Promise<unknown> | unknown) | undefined;

	peekStandingResolveHandler(): ((input: unknown) => Promise<unknown> | unknown) | undefined {
		return this.#standingResolveHandler;
	}

	setStandingResolveHandler(handler: ((input: unknown) => Promise<unknown> | unknown) | null): void {
		this.#standingResolveHandler = handler ?? undefined;
	}

	#sessionSwitchReconciler: (() => Promise<void>) | undefined;

	setSessionSwitchReconciler(reconciler: (() => Promise<void>) | null): void {
		this.#sessionSwitchReconciler = reconciler ?? undefined;
	}

	/** Provider-scoped mutable state store for transport/session caches. */
	get providerSessionState(): Map<string, ProviderSessionState> {
		return this.#providerSessions.states;
	}

	/** Hint forwarded to provider calls that support websocket transport. */
	get preferWebsockets(): boolean | undefined {
		return this.#config.preferWebsockets;
	}

	getHindsightSessionState(): HindsightSessionState | undefined {
		return this.#memory.hindsight;
	}

	/**
	 * This session's Argot codec, or `undefined` when the feature is off. Exposed
	 * so a spawning parent can hand a spawned agent a fork of it (the `inherit`
	 * agent mode); the fork is detached, so the child never mutates the parent.
	 */
	getArgotSession(): ArgotSession | undefined {
		return this.#config.argot;
	}

	setHindsightSessionState(state: HindsightSessionState | undefined): HindsightSessionState | undefined {
		return this.#memory.swapHindsight(state);
	}

	getMnemopiSessionState(): MnemopiSessionState | undefined {
		return getMnemopiSessionState(this);
	}

	/** TTSR manager for time-traveling stream rules */
	get ttsrManager(): TtsrManager | undefined {
		return this.#ttsr.manager;
	}

	/** Secret obfuscator, when secrets are configured; /share redaction reuses it. */
	get obfuscator(): SecretObfuscator | undefined {
		return this.#secrets.expansionObfuscator;
	}

	/** Whether the authoritative live runtime currently has secret protection enabled. */
	get secretsEnabled(): boolean {
		return this.#secrets.expansionObfuscator !== undefined;
	}

	/** Live session-lifetime provider redactor, including disable/move tombstones. */
	obfuscateProviderText(text: string): string {
		return this.#secrets.obfuscateProviderText(text);
	}

	/**
	 * The live redaction authority, for a consumer that must hold the object.
	 * Read this, not `obfuscator`, on any path that hides a value; see
	 * {@link SessionSecrets.providerRedactor}.
	 */
	get providerRedactor(): SecretObfuscator | undefined {
		return this.#secrets.providerRedactor;
	}

	/**
	 * Install the SDK coordinator's winning snapshot in the session view.
	 *
	 * This method is synchronous on purpose: the coordinator updates its closure
	 * authority and this view in the same commit turn.
	 */
	installSecretRuntime(runtime: SecretRuntimeLease): void {
		this.#secrets.install(runtime);
	}

	/** Wait until every scope transition initiated before this call has settled. */
	async awaitScopeTransitionReady(): Promise<void> {
		await this.#scope.ready();
	}

	/** Admit one immutable request runtime after the winning scope is ready. */
	leaseSecretRuntime(): Promise<SecretRuntimeLease> {
		return this.#secrets.lease();
	}

	/** Reload config/env/vault state in monotonic lifecycle initiation order. */
	refreshSecrets(options?: SecretsRefreshOptions): Promise<void> {
		return this.#scope.run(() => this.#secrets.refresh(options));
	}

	/** Whether a TTSR abort is pending (stream was aborted to inject rules) */
	get isTtsrAbortPending(): boolean {
		return this.#ttsr.isAbortPending;
	}

	/** Whether an expected internal plan-mode abort is pending. Consumed by
	 *  `#handleAgentEvent` to stamp `SILENT_ABORT_MARKER` on the next aborted
	 *  assistant message_end; callers clear it in `finally`. */
	get isPlanInternalAbortPending(): boolean {
		return this.#planInternalAbortPending;
	}

	/** Arm the silent-abort marker for the next aborted assistant message_end.
	 *  Caller MUST clear via `clearPlanInternalAbortPending()` in a `finally`
	 *  to guarantee no leak. */
	markPlanInternalAbortPending(): void {
		this.#planInternalAbortPending = true;
	}

	/** Unconditionally clear the silent-abort flag. Idempotent: safe when the
	 *  flag was never set OR was already consumed by `#handleAgentEvent`. */
	clearPlanInternalAbortPending(): void {
		this.#planInternalAbortPending = false;
	}

	/** Deliver a finished async job's result to the conversation; see {@link OwnedAsyncJobs.deliver}. */
	deliverAsyncJobResult(jobId: string, text: string, job?: AsyncJob): "attached" | "queued" {
		return this.#ownedJobs.deliver(jobId, text, job);
	}

	getAsyncJobSnapshot(options?: { recentLimit?: number }): AsyncJobSnapshot | null {
		return this.#ownedJobs.snapshot(options?.recentLimit);
	}

	/** Terminate every agent this session spawned; see {@link ConversationRelease.terminateSpawnedAgents}. */
	terminateSpawnedAgents(reason: string): Promise<void> {
		return this.#conversation.terminateSpawnedAgents(reason);
	}

	// =========================================================================
	// Event Subscription
	// =========================================================================

	/**
	 * Subscribe to session events. Persistence runs inside the session and needs no subscriber.
	 * Returns the function that removes this listener.
	 */
	subscribe(listener: AgentSessionEventListener): () => void {
		return this.#events.subscribe(listener);
	}

	/**
	 * Emit a UI-only notice to the session. Surfaces in interactive mode as a
	 * `showWarning` / `showError` / `showStatus` line; non-interactive modes
	 * receive the event through the normal subscribe stream.
	 *
	 * Notices are NOT added to agent state and never reach the LLM — use this
	 * for out-of-band conditions the user should see but the model shouldn't
	 * react to (e.g. background queue flush failures).
	 */
	emitNotice(level: "info" | "warning" | "error", message: string, source?: string): void {
		this.#events.emit({ type: "notice", level, message, source });
	}

	/** Internal handler for agent events - shared by subscribe and reconnect.
	 *
	 * `agent_end` handling schedules post-prompt recovery work such as context
	 * promotion continuations. It is invoked fire-and-forget by the agent's
	 * synchronous `#emit`, and only reaches the context check after several
	 * internal awaits. `prompt()` runs `TurnContinuations.waitForRecovery()` the instant
	 * `agent.prompt()` resolves, which can land before the handler registers its
	 * tasks. Tracking the `agent_end` handler as a post-prompt task synchronously
	 * closes that window, so the recovery wait always sees the in-flight handler
	 * and blocks until it and everything it schedules settles.
	 */
	#handleAgentEvent = async (event: AgentEvent): Promise<void> => {
		if (event.type !== "agent_end") {
			return this.#processAgentEvent(event);
		}
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#postPrompt.track(promise);
		try {
			await this.#processAgentEvent(event);
		} finally {
			resolve();
		}
	};

	/**
	 * Assistant message content in display form, which every surface showing content to a person
	 * reads; see {@link DisplayCopy.assistantContent}.
	 */
	displayAssistantContent(content: AssistantMessage["content"]): AssistantMessage["content"] {
		return this.#display.assistantContent(content);
	}

	/** A tool call's intent in display form; see {@link DisplayCopy.toolIntent}. */
	displayToolIntent(intent: string | undefined): string | undefined {
		return this.#display.toolIntent(intent);
	}

	/**
	 * Every agent event, one route per type. The state a later event reads (the mid-run todo
	 * counter, the streaming-edit reset) is applied before the first await: agent-core dispatches
	 * these handlers fire-and-forget, so `agent_end` can run before its `message_end` handler
	 * resumes.
	 */
	#processAgentEvent = async (event: AgentEvent): Promise<void> => {
		switch (event.type) {
			case "message_start":
				if (event.message.role === "assistant") this.#display.startStream();
				await this.#events.send(expandAssistantEvent(this, event));
				return;
			case "message_update":
				await this.#events.send(this.#display.streamUpdate(event));
				// A TTSR rule matching a stream delta may abort the turn to inject its body;
				// the retry it scheduled carries the rest.
				await this.#ttsr.observeStreamDelta(event.message, event.assistantMessageEvent);
				return;
			case "message_end":
				await this.#processMessageEnd(event);
				return;
			case "turn_start":
				// The streaming-edit guard's checks run in the stream interceptor, ahead of this
				// handler, so a reset parked behind an await could clear a verdict the new turn has
				// already reached.
				this.#streamingEdit.resetForTurn();
				this.#goalRuntime.onTurnStart(`turn-${++this.#goalTurnCounter}`);
				await this.#events.send(event);
				this.#ttsr.onTurnStart();
				return;
			case "turn_end":
				await this.#events.send(expandAssistantEvent(this, event));
				this.#ttsr.onTurnEnd();
				this.#settleInFlightToolChoice(event.message);
				return;
			case "tool_execution_start": {
				this.#finalize.evidence.recordToolStart(event);
				// The intent rides on the execution events rather than in the message
				// content, so the content-level expansion never reaches it. Without
				// this the working line announces a call in raw handle form while the
				// transcript right beneath it shows the same call expanded.
				const intent = this.displayToolIntent(event.intent);
				this.#exitRecord.recordToolStart(event);
				await this.#events.send(intent === event.intent ? event : { ...event, intent });
				return;
			}
			case "tool_execution_end":
				this.#finalize.evidence.recordToolEnd(event);
				await this.#events.send(event);
				await this.#onToolExecutionEnd(event);
				return;
			case "agent_end": {
				await this.#events.send(expandAgentEndEvent(this, event));
				const settledMessages = this.agent.state.messages;
				await this.#goalRuntime.onAgentEnd();
				await this.#stopSettlement.run(settledMessages);
				await this.#events.extensions.agentEnd(settledMessages);
				return;
			}
			default:
				await this.#events.send(event);
		}
	};

	/**
	 * A finished message: the state later events read is applied, the display copy is emitted, and
	 * the message is persisted before its settle-time effects run.
	 */
	async #processMessageEnd(event: Extract<AgentEvent, { type: "message_end" }>): Promise<void> {
		const { message } = event;
		let interruptedThinkingMessage: CustomMessage<InterruptedThinkingDetails> | undefined;
		if (message.role === "toolResult") {
			// Step the mid-run todo counter before any await: the agent loop's next-turn
			// `getAsideMessages` poll can run before queued microtasks drain, so
			// `TodoRuntime.takeMidRunNudge` MUST see the freshest counter (issue #3651). Keyed on
			// toolResult (not the assistant toolCall turn) so planned-but-aborted or
			// permission-denied calls never count, and only successful mutating tools tick.
			this.#todo.onToolResultLanded(message.toolName, message.isError);
		} else if (message.role === "assistant") {
			if (message.stopReason === "aborted") this.#stampAbortedAssistant(message);
			if (this.#abortInProgress) this.#deliberateAborts.add(message);
			interruptedThinkingMessage = demoteInterruptedThinkingOnUserInterrupt(message);
			// Make the hidden continuity turn visible to the next prompt before any awaited
			// extension delivery or persistence can stall this handler.
			if (interruptedThinkingMessage) this.agent.appendMessage(interruptedThinkingMessage);
		}
		const persistence = this.#persistence.openSlot(message);
		// The finished message expands wholesale; drop the stream state.
		this.#display.endStream();
		let displayEvent = event;
		if (message.role === "assistant") {
			applyProviderReportedContextWindow(this.agent, this.modelRegistry, message);
			displayEvent = expandAssistantEvent(this, event);
		} else if (message.role === "toolResult") {
			this.#applyToolResultState(message);
		}
		try {
			await this.#events.send(displayEvent);
		} catch (error) {
			persistence?.release();
			throw error;
		}
		await this.#persistence.persistMessageEnd(message, persistence, interruptedThinkingMessage);
		if (message.role === "assistant") {
			await this.#onAssistantMessageEnd(message);
		} else if (message.role === "toolResult") {
			await this.#onToolResultMessageEnd(message);
		}
	}

	/**
	 * Plan-mode internal transition: stamp `SILENT_ABORT_MARKER` on the persisted message before the
	 * display copy is made, so the copy (a spread) and the persisted message (mutated in place) both
	 * carry the marker and streaming render and history replay branch identically. The one-shot flag
	 * is consumed here, scoped to this aborted `message_end`; callers still clear it in `finally` so a
	 * leaked flag cannot silence a later unrelated abort.
	 */
	#stampAbortedAssistant(message: AssistantMessage): void {
		if (this.#planInternalAbortPending) {
			message.errorMessage = SILENT_ABORT_MARKER;
			message.errorId = AIError.create(AIError.Flag.SilentAbort);
			this.#planInternalAbortPending = false;
		} else if (this.#pendingAbortErrorId) {
			message.errorId = this.#pendingAbortErrorId;
			this.#pendingAbortErrorId = undefined;
		}
	}

	/**
	 * Apply state-bearing tool results before the first awaited subscriber. Agent events are
	 * delivered independently, so a later `agent_end` may otherwise evaluate stale todo state while a
	 * slow `message_end` extension is still running.
	 */
	#applyToolResultState(message: AgentMessage): void {
		const { toolName, toolCallId, details, isError } = message as {
			toolCallId?: string;
			toolName?: string;
			details?: { op?: string; path?: string; phases?: TodoPhase[] };
			isError?: boolean;
		};
		this.#todo.noteToolProgress();
		if (toolName === TOOL.edit && details?.path) {
			this.#streamingEdit.invalidate(details.path);
		}
		if (toolName === TOOL.todo && !isError && Array.isArray(details?.phases)) {
			this.setTodoPhases(details.phases);
			if (this.#todo.isInitResult(details, toolCallId)) {
				this.#replanTitle.schedule();
			}
		}
	}

	/** Settle-time effects of a persisted assistant message. */
	async #onAssistantMessageEnd(message: AssistantMessage): Promise<void> {
		// Fold this turn's timing into per-model perf aggregates (drives the /models TPS/TTFT
		// display). Errored turns measure nothing; aborted turns with reported usage are still valid
		// throughput samples.
		if (message.stopReason !== "error" && message.duration !== undefined) {
			AgentStorage.forAgentDir(this.settings.getAgentDir())?.recordModelPerf(
				`${message.provider}/${message.model}`,
				{
					outputTokens: message.usage.output,
					durationMs: message.duration,
					ttftMs: message.ttft,
				},
			);
		}
		this.#tiers.onAssistantSettled(message);
		this.#ttsr.onAssistantSettled(message);
		this.#sessionHandoff.noteAssistantSettled(message);
		await this.#retry.closeRecovered(message);
		this.#usage.recordTurnCost(message);
	}

	/** Settle-time effects of a persisted tool result: todo write outcome and checkpoint/rewind state. */
	async #onToolResultMessageEnd(message: AgentMessage): Promise<void> {
		const { toolName, details, isError, content } = message as {
			toolName?: string;
			details?: {
				op?: string;
				path?: string;
				phases?: TodoPhase[];
				report?: string;
				startedAt?: string;
				__synthetic?: true;
				__skipped?: true;
			};
			isError?: boolean;
			content?: Array<TextContent | ImageContent>;
		};
		// A call the batch never dispatched, and a call an interrupt cut short, both arrive here
		// carrying isError. Neither is a verdict on the payload: the board is stale because the write
		// never landed, not because it was refused, and two interrupts in a row would read as one
		// failure repeating and retire todo for the rest of the turn. Leave the failure memory
		// untouched rather than clearing it: a skip is not a landed write either.
		const todoCallDidNotFail = details?.__synthetic === true || details?.__skipped === true;
		if (toolName === TOOL.todo && !todoCallDidNotFail) {
			const errorText = isError ? (content?.find(part => part.type === "text")?.text ?? "") : undefined;
			const reminderText = this.#todo.recordWriteOutcome(errorText);
			if (reminderText !== undefined) {
				await this.sendCustomMessage(
					{
						customType: "todo-error-reminder",
						content: reminderText,
						display: false,
						details: { toolName, errorText },
					},
					{ deliverAs: "nextTurn" },
				);
			}
		}
		if (toolName === TOOL.checkpoint && !isError) {
			this.#checkpoint.begin({
				checkpointMessageCount: this.agent.state.messages.length,
				checkpointEntryId: this.sessionManager.getEntries().at(-1)?.id ?? null,
				startedAt: details?.startedAt ?? new Date().toISOString(),
			});
		}
		if (toolName === TOOL.rewind && !isError) {
			this.#checkpoint.recordRewindResult(details, content);
		}
	}

	/**
	 * Finalize the tool-choice queue's in-flight yield after tools have executed. This runs at
	 * `turn_end`, not `message_end`, because onInvoked handlers run during tool execution, which
	 * happens between the two.
	 */
	#settleInFlightToolChoice(message: AgentMessage): void {
		if (!this.#toolChoiceQueue.hasInFlight) return;
		const { stopReason } = message as AssistantMessage;
		if (stopReason === "aborted" || stopReason === "error") {
			this.#toolChoiceQueue.reject(stopReason);
		} else {
			this.#toolChoiceQueue.resolve();
		}
	}

	async #onToolExecutionEnd(event: Extract<AgentEvent, { type: "tool_execution_end" }>): Promise<void> {
		if (event.toolName === TOOL.goal) {
			await this.#goalRuntime.onGoalToolCompleted();
		} else {
			await this.#goalRuntime.onToolCompleted(event.toolName);
		}
		this.#planMode.noteToolCompleted(event.toolName);
		if (this.#yields.noteExecutionEnd(event)) this.agent.abort(TERMINAL_TOOL_RESULT_ABORT_REASON);
	}

	#afterToolCall(
		ctx: AfterToolCallContext,
	): Promise<AfterToolCallResult | undefined> | AfterToolCallResult | undefined {
		if (
			this.#yields.noteAfterToolCall(ctx.toolCall.id, {
				toolName: ctx.toolCall.name,
				isError: ctx.isError,
				result: ctx.result,
			})
		) {
			this.agent.abort(TERMINAL_TOOL_RESULT_ABORT_REASON);
		}
		return this.#ttsr.afterToolCall(ctx);
	}

	/**
	 * How many assistant turns this session has produced.
	 *
	 * The count of assistant messages is the turn index: each one is a request
	 * that re-read the whole context. Used to price how long a tool result
	 * arriving now will be re-read for. See `inlineCapForTurn`.
	 */
	getTurnIndex(): number {
		let turns = 0;
		for (const message of this.agent.state.messages) {
			if (message.role === "assistant") turns++;
		}
		return turns;
	}

	/**
	 * Re-read everything that depends on the session's working directory: settings, process-global
	 * provider and capability state, secrets, the SSH tool and the base system prompt, in that order.
	 * Every mode reaches this, not only the TUI's `cwd_changed` handler. A spawned agent re-roots
	 * itself and leaves the process-global state of its parent and siblings where it is. Repeating
	 * the last directory re-scoped is a no-op. See {@link SessionScope.rescope}.
	 */
	rescopeToCwd(cwd: string): Promise<void> {
		return this.#scope.run(() => this.#scope.rescope(cwd));
	}

	/**
	 * Re-root the live session working directory for this session only.
	 * Updates SessionManager cwd + header, aligns process project dir, re-scopes
	 * settings/capabilities/plugins/prompt via {@link AgentSession.rescopeToCwd},
	 * emits `cwd_changed`, and injects a visible/context system note. Never writes
	 * profile `session.workdir` or other persisted settings.
	 */
	setCwd(newCwd: string, options?: { validate?: boolean }): Promise<string> {
		return this.#scope.setCwd(newCwd, options);
	}

	/**
	 * Atomically relocate session storage/artifacts and the complete cwd-derived
	 * runtime. A failed re-scope moves storage back before exposing the error.
	 */
	moveToCwd(newCwd: string, targetSessionDir?: string): Promise<string> {
		return this.#scope.moveTo(newCwd, targetSessionDir);
	}

	/** Cumulative outbound bytes elided by wire path relativization (TW-10). */
	get wirePathBytesSaved(): number {
		return this.#wire.pathBytesSaved;
	}

	/**
	 * Cumulative outbound characters elided by the Gemini thought-signature
	 * retention window, across every request this session has made.
	 *
	 * Zero when the window is Keep All, which is the default. A large number here
	 * is the setting working: signatures are re-sent on every turn, so what a
	 * single trimmed turn saves is paid again on the next one and the next.
	 */
	get thoughtSignatureBytesSaved(): number {
		return this.#wire.thoughtSignatureBytesSaved;
	}

	subscribeCommandMetadataChanged(listener: CommandMetadataChangedListener): () => void {
		return this.#commands.subscribeMetadataChanged(listener);
	}

	/** Detach from agent events for good. Dispose is the only caller; a transition uses {@link #whileDisconnectedFromAgent}. */
	#disconnectFromAgent(): void {
		if (this.#unsubscribeAgent) {
			this.#unsubscribeAgent();
			this.#unsubscribeAgent = undefined;
		}
	}

	/**
	 * Runs `run` with agent events detached and reattaches them when it settles, resolved or
	 * rejected. The handler is the only path that persists a turn and forwards its events to
	 * listeners, so a transition that fails part-way must not leave every later turn unwritten and
	 * unseen. Listeners are preserved throughout.
	 */
	async #whileDisconnectedFromAgent<T>(run: () => Promise<T>): Promise<T> {
		this.#disconnectFromAgent();
		try {
			return await run();
		} finally {
			if (!this.#unsubscribeAgent) {
				this.#unsubscribeAgent = this.agent.subscribe(this.#handleAgentEvent);
			}
		}
	}

	/** Every provider cache-key discard this session paid for, in order, by reason. */
	providerCacheKeyDiscards(): readonly string[] {
		return this.#providerSessions.cacheKeyDiscards();
	}

	/**
	 * Forget what the previous conversation was told, on every path that starts a new one
	 * (`/new`, `/clear`, a session switch, a resume onto a different transcript): the memory
	 * backend's tracking and queued block (see {@link MemoryContext.resetForNewTranscript}).
	 */
	#resetMemoryContextForNewTranscript(): void {
		this.#memory.resetForNewTranscript();
	}

	/** True once dispose() has begun; deferred background work (e.g. the deferred
	 *  MCP discovery task in sdk.ts) must not touch the session past this point. */
	get isDisposed(): boolean {
		return this.#isDisposed;
	}

	/**
	 * Synchronously mark the session as disposing so new work is rejected
	 * immediately: eval starts throw, queued asides are dropped, and the
	 * aside provider is detached. Idempotent; `dispose()` runs it first.
	 *
	 * Wrappers that await other teardown before delegating to `dispose()` MUST
	 * call this before their first await — otherwise work started in that async
	 * gap slips past the disposal guards.
	 */
	beginDispose(): void {
		this.#isDisposed = true;
		this.#irc.flushPending();
		this.yieldQueue.clear();
		this.agent.setAsideMessageProvider(undefined);
		this.agent.hasIrcInterrupts = undefined;
		this.#advisorRoster.stop();
		this.#executions.stopEval();
	}

	/**
	 * Remove all listeners, flush pending writes, and disconnect from agent.
	 * Call this when completely done with the session.
	 *
	 * Idempotent: concurrent or repeated calls share one settled promise. The
	 * keypress `InteractiveMode.shutdown()` path and the postmortem
	 * `SIGTERM`/`SIGHUP`/`uncaughtException` callback can both target this
	 * method, so a second invocation must never re-emit `session_shutdown` or
	 * double-drain the owned `AsyncJobManager` (issue #4080).
	 */
	#disposeCall?: Promise<void>;
	dispose(options: AgentSessionDisposeOptions = {}): Promise<void> {
		if (!this.#disposeCall) this.#disposeCall = this.#doDispose(options);
		return this.#disposeCall;
	}

	async #doDispose(options: AgentSessionDisposeOptions = {}): Promise<void> {
		this.beginDispose();
		this.#exitRecord.close(options.reason ?? "dispose");
		try {
			if (this.#config.extensionRunner?.hasHandlers("session_shutdown")) {
				await this.#config.extensionRunner.emit({ type: "session_shutdown" });
			}
		} catch (error) {
			logger.warn("Failed to emit session_shutdown event", { error: errorMessage(error) });
		}
		// Abort maintenance controllers before draining post-prompt work. Otherwise
		// an in-flight compaction, explicit handoff, or scheduled continuation can
		// keep awaiting a live model stream while `TurnContinuations.cancel` waits for
		// its wrappers to settle. The post-prompt task's AbortSignal does not
		// propagate into the inner controllers, so abort them explicitly. Abort the
		// agent as well in case a scheduled continuation already started streaming.
		//
		// Tool work (bash/eval/python) is NOT aborted here — those have their own
		// dispose paths and shared kernels are contractually allowed to survive a
		// session's dispose.
		this.abortRetry();
		this.abortCompaction();
		const postPromptDrain = this.#continuations.cancel();
		this.agent.abort();
		await postPromptDrain;
		// The aborted loop is still unwinding: a tool that ignores its signal keeps it
		// running, and the teardown below releases the kernels, tabs and transcript it
		// may still be using. Wait for it, bounded so such a tool cannot hang shutdown.
		const loopSettleMs = options.agentLoopSettleTimeoutMs ?? DISPOSE_AGENT_LOOP_SETTLE_MS;
		try {
			await withTimeout(this.agent.waitForIdle(), loopSettleMs, "Agent loop did not settle after abort");
		} catch (error) {
			logger.warn("Disposing while the aborted agent loop is still running", {
				timeoutMs: loopSettleMs,
				error: errorMessage(error),
			});
		}
		await this.#release.releaseWork();
		this.#inFlight.releasePowerAssertion();
		await this.sessionManager.close();
		// beginDispose() stopped the advisor and captured its recorder close; await
		// it so the final advisor turn is flushed before the process may exit.
		await this.#advisorRoster.whenRecordersClosed();
		this.#providerSessions.closeAll("dispose");
		await this.#release.releaseMcpHold();
		await this.#memory.release(options.mnemopiConsolidateTimeoutMs);
		this.#disconnectFromAgent();
		for (const release of this.#listenerReleases.splice(0)) release();
		this.#events.clear();
	}

	freshSession(): FreshSessionResult | undefined {
		if (this.isStreaming) return undefined;
		const previousSessionId = this.sessionId;
		const closedProviderSessions = this.#providerSessions.states.size;
		this.#providerSessions.closeAll("fresh session");
		this.#providerSessions.freshId = Bun.randomUUIDv7();
		this.#providerSessions.sync();
		this.#memory.rekey();
		this.agent.appendOnlyContext?.invalidateForModelChange();
		return {
			previousSessionId,
			sessionId: this.sessionId,
			closedProviderSessions,
		};
	}

	// =========================================================================
	// Read-only State Access
	// =========================================================================

	/** Full agent state */
	get state(): AgentState {
		return this.agent.state;
	}

	/** Current model (may be undefined if not yet selected) */
	get model(): Model | undefined {
		return this.agent.state.model;
	}

	/** Live per-family service tiers (OpenAI / Anthropic / Google). */
	get serviceTierByFamily(): ServiceTierByFamily {
		return this.#tiers.byFamily;
	}

	/**
	 * The thinking surface, delegated to {@link ThinkingRuntime}. These eight
	 * members are the session's public effort API — the facade, rpc mode, the SDK
	 * and `/effort` all reach them here — so they stay on the class while the
	 * state and the resolution rules live with the collaborator.
	 */

	/** Effective thinking level applied to the agent (the resolved level when `auto`). */
	get thinkingLevel(): ThinkingLevel | undefined {
		return this.#thinking.level;
	}

	/** The selector the user configured: `auto` when auto mode is active, else the effective level. */
	configuredThinkingLevel(): ConfiguredThinkingLevel | undefined {
		return this.#thinking.configuredLevel();
	}

	/** Session-only effort choice, excluding selector and saved per-model defaults. */
	get sessionThinkingOverride(): ConfiguredThinkingLevel | undefined {
		return this.#thinking.sessionOverride;
	}

	/** True when `auto` thinking mode is active. */
	get isAutoThinking(): boolean {
		return this.#thinking.isAuto;
	}

	/** The level `auto` resolved to for the current turn (undefined until classified). */
	autoResolvedThinkingLevel(): Effort | undefined {
		return this.#thinking.autoResolvedLevel();
	}

	/**
	 * Set the thinking level. Public calls create a session override; internal
	 * model routing passes `resolved` so per-model defaults remain eligible on
	 * the next switch. `auto` resolves to a concrete effort for each turn.
	 */
	setThinkingLevel(
		level: ConfiguredThinkingLevel | undefined,
		persist: boolean = false,
		source: "session" | "resolved" = "session",
	): void {
		this.#thinking.set(level, persist, source);
	}

	/** Cycle through the active model's named effort variants. */
	cycleThinkingLevel(): ConfiguredThinkingLevel | undefined {
		return this.#thinking.cycle();
	}

	/** Effort variants the active model accepts. */
	getAvailableThinkingLevels(): ReadonlyArray<Effort> {
		return this.#thinking.availableLevels();
	}

	/** Whether agent is currently streaming a response */
	get isStreaming(): boolean {
		return this.agent.state.isStreaming || this.#inFlight.active;
	}

	get isAborting(): boolean {
		return this.agent.isAborting;
	}

	/** Wait until streaming and deferred recovery work are fully settled. */
	async waitForIdle(): Promise<void> {
		await this.agent.waitForIdle();
		await this.#continuations.waitForRecovery();
	}

	/**
	 * Wait until this conversation has nothing left to run: the loop and its post-prompt recovery
	 * are idle, and no background job this agent owns will wake the loop again. A job completion
	 * that starts another turn is waited out in turn. Returns once `signal` aborts. `endingJobsOnly`
	 * leaves out jobs that run until stopped, such as the exit watch on a launched process.
	 */
	async waitForQuiescence(signal?: AbortSignal, options?: { endingJobsOnly?: boolean }): Promise<void> {
		while (!signal?.aborted) {
			await this.waitForIdle();
			if (signal?.aborted || !this.#ownedJobs.hasPendingWake(options?.endingJobsOnly)) return;
			await this.#ownedJobs.nextWakeChange(signal);
		}
	}

	drainAsyncJobDeliveriesForAcp(options?: { timeoutMs?: number }): Promise<boolean> {
		return this.#ownedJobs.drainDeliveries(options?.timeoutMs);
	}

	/** Most recent assistant message in agent state. */
	getLastAssistantMessage(): AssistantMessage | undefined {
		return findLastAssistantMessage(this.agent.state.messages);
	}
	/** Current effective system prompt blocks (includes any per-turn extension modifications) */
	get systemPrompt(): string[] {
		return this.agent.state.systemPrompt;
	}

	/** Current retry attempt (0 if not retrying) */
	get retryAttempt(): number {
		return this.#retry.attempt;
	}

	/**
	 * Get the names of currently active tools.
	 * Returns the names of tools currently set on the agent.
	 */
	getActiveToolNames(): string[] {
		return this.agent.state.tools.map(t => t.name);
	}

	/** Whether the edit tool is registered in this session. */
	get hasEditTool(): boolean {
		return this.#toolRegistry.has(TOOL.edit);
	}

	/**
	 * Get a tool by name from the registry.
	 */
	getToolByName(name: string): AgentTool | undefined {
		return this.#toolRegistry.get(name);
	}

	/** True when the current registry entry for `name` came from a built-in factory. */
	hasBuiltInTool(name: string): boolean {
		return this.#discovery.isBuiltIn(name);
	}

	/**
	 * Get all configured tool names (built-in via --tools or default, plus custom tools).
	 */
	getAllToolNames(): string[] {
		return Array.from(this.#toolRegistry.keys());
	}

	/**
	 * Registers the ephemeral vibe tools and activates them alongside `baseToolNames`.
	 *
	 * @throws When this session cannot create vibe tools or the factory returns duplicate names.
	 */
	async activateVibeTools(baseToolNames: string[]): Promise<void> {
		await this.#toolActivation.activateVibeTools(baseToolNames);
	}

	/** Removes tools installed by {@link activateVibeTools} and activates `nextToolNames`. */
	async deactivateVibeTools(nextToolNames: string[]): Promise<void> {
		await this.#toolActivation.deactivateVibeTools(nextToolNames);
	}

	/**
	 * Rebuild the prompt for a model switch, when the switch actually moved a
	 * prompt input.
	 *
	 * EVERY caller of this method has just switched models, so every reason it
	 * records names that switch. It used to record a bare `edit-mode-change`
	 * whenever the edit variant differed, which describes a trigger no session can
	 * produce: nothing re-resolves the edit mode except a model switch, because
	 * `edit.mode` is not a prompt gate (see `system-prompt-builder/gate-registry`)
	 * and the only reads of `resolveActiveEditMode` for this purpose are the four
	 * `setModel`/`cycleModel` paths. So a reader triaging `cacheRead: 0` turns off
	 * the invalidation record chased a phantom settings flip, when the entry
	 * actually describes the ONE invalidation that is unavoidable: a different
	 * model is a different provider cache namespace, so the prefix was already
	 * dead and the rebuild cost nothing extra.
	 *
	 * Which inputs moved is still recorded, because that is the actionable half:
	 * `edit-mode` means the two models share a prompt cohort and only the edit
	 * variant forced the rebuild.
	 */
	async #syncAfterModelChange(previousEditMode: EditMode): Promise<void> {
		const currentEditMode = resolveActiveEditMode(this.settings, this.model);
		const editModeChanged = previousEditMode !== currentEditMode && this.getActiveToolNames().includes(TOOL.edit);
		// The system prompt selects model-specific policy even when it does not display the model id.
		const modelChanged = this.#toolActivation.promptModelMoved();
		if (!editModeChanged && !modelChanged) return;
		const moved = [modelChanged ? "prompt-model-key" : undefined, editModeChanged ? "edit-mode" : undefined]
			.filter(part => part !== undefined)
			.join("+");
		await this.refreshBaseSystemPrompt(`model-switch:${moved}`);
	}

	isMCPDiscoveryEnabled(): boolean {
		return this.#discovery.mcpEnabled;
	}

	/**
	 * Flip MCP discovery on after deferred discovery learns the real tool count.
	 * UI sessions resolve `tools.discoveryMode: "auto"` before MCP servers
	 * connect, so a large MCP toolset discovered later must be able to upgrade
	 * the session from the force-activate path to the discovery path. One-way:
	 * discovery is never downgraded mid-session.
	 */
	enableMCPDiscovery(): void {
		this.#discovery.enableMCP();
	}

	getSelectedMCPToolNames(): string[] {
		return this.#discovery.selectedMCP();
	}

	async activateDiscoveredMCPTools(toolNames: string[]): Promise<string[]> {
		const activation = this.#discovery.planMCPActivation(toolNames);
		if (!activation) return [];
		await this.setActiveToolsByName(activation.nextActive);
		return activation.activated;
	}

	// ── Generic tool discovery (covers built-in + MCP + extension) ────────────

	isToolDiscoveryEnabled(): boolean {
		return this.#discovery.effectiveMode() !== "off";
	}

	getDiscoverableTools(filter?: { source?: DiscoverableTool["source"] }): DiscoverableTool[] {
		return this.#discovery.discoverableTools(filter);
	}

	getDiscoverableToolSearchIndex(): DiscoverableToolSearchIndex {
		return this.#discovery.searchIndex();
	}

	getSelectedDiscoveredToolNames(): string[] {
		return this.#discovery.selectedDiscovered();
	}

	async activateDiscoveredTools(toolNames: string[]): Promise<string[]> {
		const mcpNames = toolNames.filter(isMCPToolName);
		const nonMcpNames = toolNames.filter(name => !isMCPToolName(name));
		const activated: string[] = [];

		if (mcpNames.length > 0) {
			const activatedMcp = await this.activateDiscoveredMCPTools(mcpNames);
			activated.push(...activatedMcp);
		}

		// Built-ins and custom tools that are in the registry but not currently active.
		if (nonMcpNames.length > 0) {
			const newlyAdded = this.#discovery.selectLocal(nonMcpNames);
			activated.push(...newlyAdded);
			if (newlyAdded.length > 0) {
				await this.setActiveToolsByName(this.getActiveToolNames().concat(newlyAdded));
				this.#discovery.invalidate();
			}
		}

		return [...new Set(activated)];
	}

	/** The approval rung this session enforces; see {@link SessionApprovals.effectiveMode}. */
	effectiveApprovalMode(): ApprovalMode {
		return this.#approvals.effectiveMode();
	}

	/** Whether the `/yolo` bypass is active; see {@link SessionApprovals.isBypassed}. */
	isApprovalBypassed(): boolean {
		return this.#approvals.isBypassed();
	}

	/**
	 * Turn the `/yolo` bypass on or off. Returns the new state. Session-scoped: never written to
	 * settings, so a fresh session starts with it off. The next tool call reads it through the tool
	 * context (`bypassAllApprovals`).
	 */
	setApprovalBypass(enabled: boolean): boolean {
		return this.#approvals.setBypass(enabled);
	}

	/** The standing per-tool approval decisions the tool wrapper reads and writes. */
	sessionToolApprovals(): SessionToolApprovals {
		return this.#approvals.toolDecisions();
	}

	/**
	 * Reload the SSH tool from disk-backed capability discovery and make the
	 * refreshed definition visible to the next model call without restarting.
	 */
	async refreshSshTool(options?: { activateIfAvailable?: boolean }): Promise<void> {
		await this.#toolActivation.refreshSshTool(options);
	}

	/**
	 * Set active tools by name.
	 * Only tools in the registry can be enabled. Unknown tool names are ignored.
	 * Also rebuilds the system prompt to reflect the new tool set.
	 * Changes take effect before the next model call.
	 */
	async setActiveToolsByName(toolNames: string[]): Promise<void> {
		await this.#toolActivation.apply(toolNames);
	}

	/** Every prefix-cache invalidation this session caused, by reason; see {@link ToolActivation.systemPromptInvalidations}. */
	systemPromptInvalidations(): readonly string[] {
		return this.#toolActivation.systemPromptInvalidations();
	}

	/**
	 * Rebuild the base system prompt for the active tool set and return the prompt now in force,
	 * recording `reason` when the bytes change; see {@link ToolActivation.refreshBaseSystemPrompt}.
	 */
	async refreshBaseSystemPrompt(reason: string): Promise<string[]> {
		return this.#toolActivation.refreshBaseSystemPrompt(reason);
	}

	/**
	 * Publish the backend's current volatile context for delivery at the next step
	 * boundary, and report whether anything new is queued.
	 *
	 * This is what a recall or a mental-model reload calls instead of
	 * `refreshBaseSystemPrompt`. It happens while a turn is already running (recall
	 * fires on `agent_start`) or between turns (the mental-model TTL reload fires
	 * on `agent_end`); either way the block reaches the model as a message after
	 * everything already cached, so the prefix survives.
	 */
	async publishVolatileMemoryContext(reason: string): Promise<boolean> {
		return this.#memory.publish(reason);
	}

	/**
	 * Replace MCP tools in the registry and recompute the visible MCP tool set immediately.
	 * This allows /mcp add/remove/reauth to take effect without restarting the session.
	 *
	 * @param mcpTools The new MCP tools to register.
	 * @param options.activateAll When true, force-activates every newly registered MCP tool
	 *   regardless of prior selection state. Used when MCP discovery is disabled and tools
	 *   arrive after initial session activation.
	 */
	async refreshMCPTools(mcpTools: CustomTool[], options?: { activateAll?: boolean }): Promise<void> {
		await this.#toolActivation.refreshMCPTools(mcpTools, options);
	}

	/** The context an MCP custom tool runs against, read live on every call. */
	#customToolContext(): CustomToolContext {
		return {
			sessionManager: this.sessionManager,
			modelRegistry: this.#config.modelRegistry,
			model: this.model,
			isIdle: () => !this.isStreaming,
			obfuscateProviderText: text => this.obfuscateProviderText(text),
			hasQueuedMessages: () => this.queuedMessageCount > 0,
			abort: () => {
				this.agent.abort();
			},
			settings: this.settings,
			getTurnIndex: () => this.getTurnIndex(),
			localProtocolOptions: localProtocolOptions(this.sessionManager),
		};
	}

	/**
	 * Replace RPC host-owned tools and refresh the active tool set before the next model call.
	 */
	async refreshRpcHostTools(rpcTools: AgentTool[]): Promise<void> {
		await this.#toolActivation.refreshRpcHostTools(rpcTools);
	}

	/** Whether auto-compaction is currently running */
	get isCompacting(): boolean {
		return this.#compaction.isCompacting;
	}

	/**
	 * Whether idle-flush tasks, auto-continuations, or other short-lived
	 * post-prompt work are pending.  True in the brief window after
	 * `session.prompt()` returns but before a scheduled background delivery
	 * (e.g. an async-job result) has finished its own streaming turn.
	 * Loop-mode and similar auto-submit paths should treat this as a block
	 * to avoid racing against the delivery turn.
	 */
	get hasPostPromptWork(): boolean {
		return this.#postPrompt.pending;
	}

	/** All messages including custom types like BashExecutionMessage */
	get messages(): AgentMessage[] {
		return this.agent.state.messages;
	}

	/** Latest image attachments addressable by tools as `Image #N` or `attachment://N`. */
	getImageAttachments(): ImageAttachment[] {
		return this.#images.latest();
	}

	buildDisplaySessionContext(): SessionContext {
		return this.#display.sessionContext();
	}

	/**
	 * Expand argot handles across transcript entries a viewer parsed off disk.
	 *
	 * The agent dashboard reads a spawned agent's or advisor's session file
	 * directly, so it never passes through `buildDisplaySessionContext`. It gets
	 * the same codec through this accessor rather than reaching for `#argot`.
	 */
	expandArgotEntries(entries: SessionMessageEntry[]): SessionMessageEntry[] {
		return this.#display.expandEntries(entries);
	}

	/**
	 * Transcript for TUI display; see {@link DisplayCopy.transcriptContext}. Full history is kept for
	 * export/resume-style callers; live chat can collapse compacted history to keep the hot render
	 * surface bounded.
	 */
	buildTranscriptSessionContext(
		options?: Pick<BuildSessionContextOptions, "collapseCompactedHistory" | "keepDanglingToolCalls">,
	): SessionContext {
		return this.#display.transcriptContext(options);
	}

	#convertToLlmForSideRequest(messages: AgentMessage[]): Message[] {
		return this.#secrets.obfuscateMessages(convertToLlm(messages));
	}

	/** Convert session messages using the same pre-LLM pipeline as the active session. */
	async convertMessagesToLlm(messages: AgentMessage[], signal?: AbortSignal): Promise<Message[]> {
		const transformContext = this.#config.transformContext;
		const transformedMessages = await (transformContext ? transformContext(messages, signal) : messages);
		return await (this.#config.convertToLlm ?? convertToLlm)(transformedMessages);
	}

	/** Apply the session's stream hooks to a direct side request; see {@link ProviderTransport.prepare}. */
	prepareSimpleStreamOptions(options: SimpleStreamOptions, provider?: string): Promise<SimpleStreamOptions> {
		return this.#transport.prepare(options, provider);
	}

	/** Current steering mode */
	get steeringMode(): "all" | "one-at-a-time" {
		return this.agent.getSteeringMode();
	}

	/** Current follow-up mode */
	get followUpMode(): "all" | "one-at-a-time" {
		return this.agent.getFollowUpMode();
	}

	/** Current interrupt mode */
	get interruptMode(): "immediate" | "wait" {
		return this.agent.getInterruptMode();
	}

	/** Current session file path, or undefined if sessions are disabled */
	get sessionFile(): string | undefined {
		return this.sessionManager.getSessionFile();
	}

	/** Current session ID */
	get sessionId(): string {
		return this.#providerSessions.activeId();
	}
	getEvalSessionId(): string {
		const parentEvalSessionId = this.#config.parentEvalSessionId;
		if (parentEvalSessionId !== undefined) return parentEvalSessionId;
		return defaultEvalSessionId({
			cwd: this.sessionManager.getCwd(),
			getSessionFile: () => this.sessionManager.getSessionFile() ?? null,
		});
	}

	/** Current session display name, if set */
	get sessionName(): string | undefined {
		return this.sessionManager.getSessionName();
	}

	/** Scoped models for cycling (from --models flags). */
	get scopedModels(): readonly SessionScopedModel[] {
		return this.#models.scoped;
	}

	/** Prompt templates */
	getPlanModeState(): PlanModeState | undefined {
		return this.#planMode.state;
	}

	/** Prewalk state, if armed and active */
	getPrewalkState(): Prewalk | undefined {
		return this.#handoff.prewalk;
	}

	setPlanModeState(state: PlanModeState | undefined): void {
		this.#planMode.setState(state);
	}

	getGoalModeState(): GoalModeState | undefined {
		return this.#goalModeState;
	}

	setGoalModeState(state: GoalModeState | undefined): void {
		this.#goalModeState = state;
	}

	getVibeModeState(): VibeModeState | undefined {
		return this.#vibeModeState;
	}

	setVibeModeState(state: VibeModeState | undefined): void {
		this.#vibeModeState = state;
	}

	get goalRuntime(): GoalRuntime {
		return this.#goalRuntime;
	}

	markPlanReferenceSent(): void {
		this.#planMode.markReferenceSent();
	}

	setPlanReferencePath(path: string): void {
		this.#planMode.setReferencePath(path);
	}

	getPlanReferencePath(): string {
		return this.#planMode.referencePath;
	}

	get clientBridge(): ClientBridge | undefined {
		return this.#clientBridge;
	}

	setClientBridge(bridge: ClientBridge | undefined): void {
		this.#clientBridge = bridge;
		this.#approvals.forgetClientDecisions();
		const activeToolNames = this.getActiveToolNames();
		const activeTools = activeToolNames
			.map(name => this.#toolRegistry.get(name))
			.filter((tool): tool is AgentTool => tool !== undefined)
			.map(tool => this.#approvals.wrapForClient(tool));
		this.agent.setTools(activeTools);
	}

	getCheckpointState(): CheckpointState | undefined {
		return this.#checkpoint.state;
	}

	getLastCompletedRewind(): CompletedRewindState | undefined {
		return this.#checkpoint.lastCompleted;
	}

	setCheckpointState(state: CheckpointState | undefined): void {
		this.#checkpoint.set(state);
	}

	/**
	 * Inject the plan mode context message into the conversation history.
	 */
	async sendPlanModeContext(options?: { deliverAs?: "steer" | "followUp" | "nextTurn" }): Promise<void> {
		const message = await this.#planMode.buildContextMessage();
		if (!message) return;
		await this.sendCustomMessage(
			{
				customType: message.customType,
				content: message.content,
				display: message.display,
				details: message.details,
			},
			options ? { deliverAs: options.deliverAs } : undefined,
		);
	}

	async sendGoalModeContext(options?: { deliverAs?: "steer" | "followUp" | "nextTurn" }): Promise<void> {
		await sendModeContext(this, this.#turnInput.goalBlock(), options);
	}

	async sendVibeModeContext(options?: { deliverAs?: "steer" | "followUp" | "nextTurn" }): Promise<void> {
		await sendModeContext(this, this.#turnInput.vibeBlock(), options);
	}

	/**
	 * Resolve a helper to its model and thinking level.
	 */
	resolveHelperModel(id: HelperId): HelperModelSelection | undefined {
		return resolveHelperModel(this.settings, id, this.#config.modelRegistry.getAvailable(), this.model);
	}

	/**
	 * Resolve the configured `defaultModel` chain to its first available model,
	 * with the effort its `:level` suffix names. Undefined when the setting is
	 * unset or matches nothing available.
	 */
	resolveDefaultModel(): { model: Model; thinkingLevel?: ConfiguredThinkingLevel } | undefined {
		const resolved = resolveModelSelectorValue(
			this.settings.get("defaultModel"),
			this.#config.modelRegistry.getAvailable(),
			{ settings: this.settings, matchPreferences: getModelMatchPreferences(this.settings) },
		);
		if (!resolved.model) return undefined;
		return {
			model: resolved.model,
			thinkingLevel: resolved.explicitThinkingLevel ? resolved.thinkingLevel : undefined,
		};
	}

	/**
	 * Resolve the explicit thinking suffix that should apply when a temporary
	 * picker selects a model already assigned to defaultModel or a helper chain.
	 */
	resolveTemporaryModelThinkingLevel(model: Model): ConfiguredThinkingLevel | undefined {
		const availableModels = this.#config.modelRegistry.getAvailable();
		if (availableModels.length === 0) return undefined;

		const matchPreferences = getModelMatchPreferences(this.settings);
		const defaultPattern = this.settings.get("defaultModel");
		if (defaultPattern) {
			const resolved = resolveModelSelectorValue(defaultPattern, availableModels, {
				settings: this.settings,
				matchPreferences,
			});
			if (resolved.explicitThinkingLevel && resolved.thinkingLevel !== undefined && resolved.model) {
				if (modelsAreEqual(resolved.model, model)) return resolved.thinkingLevel;
			}
		}

		for (const id of HELPER_IDS) {
			const patterns = helperModelPatterns(this.settings, id);
			if (patterns.length === 0) continue;
			const resolved = resolveModelSelectorValue(patterns, availableModels, {
				settings: this.settings,
				matchPreferences,
			});
			if (resolved.explicitThinkingLevel && resolved.thinkingLevel !== undefined && resolved.model) {
				if (modelsAreEqual(resolved.model, model)) return resolved.thinkingLevel;
			}
		}

		return undefined;
	}

	get promptTemplates(): ReadonlyArray<PromptTemplate> {
		return this.#commands.promptTemplates;
	}

	/** Replace file-based slash commands used for prompt expansion. */
	setSlashCommands(slashCommands: FileSlashCommand[]): void {
		this.#commands.setSlashCommands(slashCommands);
	}

	/** Custom commands (TypeScript slash commands and MCP prompts) */
	get customCommands(): ReadonlyArray<LoadedCustomCommand> {
		return this.#commands.customCommands;
	}

	/** MCP prompt commands only, for command-list metadata. */
	get mcpPromptCommands(): ReadonlyArray<LoadedCustomCommand> {
		return this.#commands.mcpPromptCommands;
	}

	/** Update the MCP prompt commands list. Called when server prompts are (re)loaded. */
	setMCPPromptCommands(commands: LoadedCustomCommand[]): void {
		this.#commands.setMCPPromptCommands(commands);
	}

	// =========================================================================
	// Prompting
	// =========================================================================

	/**
	 * Hand startup work to the session instead of awaiting it on the boot path.
	 *
	 * Chained, so several deferrals order the way they were handed over, and swallowed, so a failure
	 * cannot reach the process as an unhandled rejection or refuse the first turn — the work logs its
	 * own failure.
	 */
	deferStartupWork(work: Promise<void>): void {
		this.#startupHydration = this.#startupHydration.then(() => work).catch(() => {});
	}

	/** Resolves once every deferred startup task has finished. A turn awaits this before it runs. */
	whenStartupHydrated(): Promise<void> {
		return this.#startupHydration;
	}

	/**
	 * Send a prompt to the agent.
	 * - Handles extension commands (registered via pi.registerCommand) immediately, even during streaming
	 * - Expands file-based prompt templates by default
	 * - During streaming, queues via steer() or followUp() based on streamingBehavior option
	 * - Validates model and API key before sending (when not streaming)
	 *
	 * Returns `false` when the command was fully handled locally (extension or
	 * custom-TS command consumed without calling the LLM). Returns `true` when
	 * the prompt was forwarded to the agent — either directly or queued as a
	 * steer/follow-up. Callers that render a UI or manage turn lifecycle (e.g.
	 * the ACP agent) use this to know whether to expect an `agent_end` event.
	 *
	 * @throws Error if streaming and no streamingBehavior specified
	 * @throws Error if no model selected or no API key available (when not streaming)
	 */
	async prompt(text: string, options?: PromptOptions): Promise<boolean> {
		await this.#promptRefresh;
		await this.#startupHydration;
		const expandedText = await this.#commands.resolve(text, {
			expandPromptTemplates: options?.expandPromptTemplates ?? true,
			synthetic: options?.synthetic === true,
		});
		// A command handled the text without the model.
		if (expandedText === undefined) return false;

		// Magic keywords ("ultrathink", "orchestratez"): append hidden system notices after the
		// user's message that steer this turn. User-authored prompts only — synthetic /
		// agent-initiated turns never trigger them.
		const keywordNotices = options?.synthetic ? [] : createMagicKeywordNotices(this, expandedText);

		// A user-initiated prompt (typed message or the `.`/`c` continue shortcut)
		// re-enables advisor auto-resume that a prior user interrupt suppressed.
		// Agent-initiated synthetic prompts (auto-continue, plan, reminders) do not.
		if (options?.userInitiated ?? !options?.synthetic) {
			this.#finalize.evidence.startUserTurn();
			this.#advisorRoster.allowAutoResume();
			this.#planMode.noteUserTurn();
		}

		// If streaming, queue via steer() or followUp() based on option
		if (this.isStreaming) {
			if (!options?.streamingBehavior) {
				throw new AgentBusyError();
			}
			// Steer/follow-up the keyword notices BEFORE the queued user message so the
			// model reads the steering notice ahead of the prompt it modifies.
			for (const notice of keywordNotices) {
				await this.sendCustomMessage(notice, { deliverAs: options.streamingBehavior });
			}
			await this.#queue.queueUser(expandedText, options?.images, options.streamingBehavior);
			return true;
		}

		// Skip eager preludes when the user has already queued a directive
		const hasPendingUserDirective = this.#toolChoiceQueue.inspect().includes("user-force");
		const eagerTodoPrelude =
			!options?.synthetic && !hasPendingUserDirective ? this.#todo.eagerPrelude(expandedText) : undefined;
		const eagerTaskPrelude =
			!options?.synthetic && !hasPendingUserDirective ? this.#preludes.eagerTask(expandedText) : undefined;

		// Claim the turn before the first await. Nothing since the busy check above awaits, so a prompt
		// called while this one normalizes its images reads the session busy and queues behind it.
		// Unclaimed, that later prompt passed the check, started its turn first and reached the model
		// ahead of this one.
		this.#inFlight.begin();
		const generation = this.#promptGeneration;
		const {
			content: userContent,
			images: normalizedImages,
			imageDescriptionNotice,
		} = await this.#images.textWithImages(expandedText, options?.images).catch((error: unknown) => {
			this.#endInFlight();
			throw error;
		});

		const promptAttribution = options?.attribution ?? (options?.synthetic ? "agent" : "user");
		const message = options?.synthetic
			? { role: "developer" as const, content: userContent, attribution: promptAttribution, timestamp: Date.now() }
			: { role: "user" as const, content: userContent, attribution: promptAttribution, timestamp: Date.now() };

		const preludeMessages: AgentMessage[] = [];
		if (eagerTodoPrelude) {
			if (eagerTodoPrelude.toolChoice) {
				this.#toolChoiceQueue.pushOnce(eagerTodoPrelude.toolChoice, {
					label: "eager-todo",
				});
			}
			preludeMessages.push(eagerTodoPrelude.message);
		}
		if (eagerTaskPrelude) {
			preludeMessages.push(eagerTaskPrelude);
		}

		try {
			await this.#promptWithMessage(message, expandedText, {
				...options,
				images: normalizedImages,
				prependMessages:
					preludeMessages.length > 0 || keywordNotices.length > 0 || imageDescriptionNotice
						? [...preludeMessages, ...keywordNotices, ...(imageDescriptionNotice ? [imageDescriptionNotice] : [])]
						: undefined,
				claimedGeneration: generation,
			});
		} finally {
			// Clean up residual eager-todo directive if the prompt never consumed it
			// (e.g., compaction aborted, validation failed).
			this.#toolChoiceQueue.removeByLabel("eager-todo");
		}
		return true;
	}

	/** Run a custom message as the prompt of a turn; see {@link CustomMessages.prompt}. */
	async promptCustomMessage<T = unknown>(
		message: CustomMessageFields<T>,
		options?: PromptCustomMessageOptions,
	): Promise<void> {
		return this.#custom.prompt(message, options);
	}

	async #promptWithMessage(
		message: AgentMessage,
		expandedText: string,
		options?: Pick<PromptOptions, "toolChoice" | "images" | "skipCompactionCheck"> & {
			prependMessages?: AgentMessage[];
			/** Queued context a requested turn leased ahead of `message`; settled when the agent takes the input. */
			prepended?: NextTurnLease;
			skipPostPromptRecoveryWait?: boolean;
			acceptTerminalEmptyStop?: boolean;
			/** The prompt generation of a turn the caller claimed with `#inFlight.begin()`; this call ends that turn. */
			claimedGeneration?: number;
		},
	): Promise<void> {
		const claimedGeneration = options?.claimedGeneration;
		if (claimedGeneration === undefined) this.#inFlight.begin();
		startupMarker("prompt:start");
		const generation = claimedGeneration ?? this.#promptGeneration;
		// Queued context leaves its queue only when the agent takes this prompt's input; a prompt that
		// ends before that (an interrupt, a throw) puts it back for the next one.
		let queued: NextTurnLease | undefined;
		try {
			// An abort while the caller prepared a claimed turn ends it here, before it touches the session.
			if (this.#promptGeneration !== generation) return;
			// The turn leaves rest: take the held at-rest reading before the flush below or the prompt
			// appends a message, since the reading is at rest only while the session holds none.
			takeHeldAtRestReading(this);
			// Flush any pending bash and Python results before the new prompt
			this.#executions.flush();
			this.#irc.flushPending();

			// A new user prompt does not reset stop-time reminder suppression. Replaying
			// the same unfinished list after each "continue" correction floods context.
			this.#todo.onNewPrompt();
			this.#resetPromptMaintenanceState();
			this.#stopRetries.acceptTerminalEmptyStop = options?.acceptTerminalEmptyStop === true;

			await this.#retry.maybeRestoreFallbackPrimary();

			// Validate model
			if (!this.model) throw new Error(noModelSelectedMessage(this.#config.modelRegistry.getError()?.message));

			// Validate API key. `hasAuth` reads the stored credential without refreshing it, and
			// `getApiKey` refreshed it and produced nothing; the message tells those apart.
			const registry = this.#config.modelRegistry;
			const apiKey = await registry.getApiKey(this.model, this.sessionId);
			if (!apiKey) {
				const provider = this.model.provider;
				const signedIn = registry.authStorage.hasAuth(provider);
				const disabledCause = signedIn ? undefined : registry.authStorage.disabledCredentialCause(provider);
				throw new Error(unusableCredentialMessage(provider, { signedIn, disabledCause }));
			}

			// Phase markers for the submit path: VEYYON_DEBUG_STARTUP=1 writes one
			// synchronous stderr line per phase, so a "submit feels slow" report
			// names the phase that spent the time instead of offering a guess.
			startupMarker("prompt:compaction-check:start");
			// Port first: until an unreadable server-side window is ported, the
			// rebuilt context re-expands every message the window stood in for, and
			// any check below would measure (and compact) that expanded span.
			await this.#compaction.portUnreadableRemoteCompaction();
			if (this.#promptGeneration !== generation) {
				return;
			}
			// Check whether an aborted response left enough context pressure to require
			// in-place compaction before this prompt starts its agent loop.
			const lastAssistant = findLastAssistantMessage(this.agent.state.messages);
			if (lastAssistant && !options?.skipCompactionCheck) {
				await this.#contextCheck.check(lastAssistant, false, false);
			}
			startupMarker("prompt:compaction-check:done");

			startupMarker("prompt:plan-arm:start");
			await this.#handoff.armPlanYoloIfNeeded();
			startupMarker("prompt:plan-arm:done");

			// Build the turn's input: the mode blocks, the messages prepended to this prompt, then the prompt itself
			startupMarker("prompt:context-build:start");
			const messages = await this.#turnInput.modeBlocks();
			if (options?.prependMessages) {
				messages.push(...options.prependMessages);
			}
			if (options?.prepended) {
				messages.push(...options.prepended.messages);
			}

			messages.push(message);

			// Early bail-out: if a newer abort/prompt cycle started during setup,
			// return before mutating shared state (nextTurn messages, system prompt).
			if (this.#promptGeneration !== generation) {
				return;
			}

			// Inject any pending "nextTurn" messages as context alongside the user message
			queued = this.#nextTurn.lease();
			messages.push(...queued.messages);

			// Auto-read @filepath mentions
			messages.push(...(await this.#turnInput.fileMentions(expandedText)));

			// Ahead of the user's message, not after it: the memories are what the model
			// should already know when it reads the question, which is how the eager-task
			// prelude is placed too. Position within the turn is free either way — the
			// cache prefix ends before all of it.
			startupMarker("prompt:memory-context:start");
			const memoryContextMessage = await this.#memory.collect(expandedText);
			if (memoryContextMessage) messages.unshift(memoryContextMessage);
			startupMarker("prompt:memory-context:done");
			startupMarker("prompt:context-build:done");

			startupMarker("prompt:before-agent-start:start");
			messages.push(...(await this.#turnInput.beforeAgentStart(expandedText, options?.images, message)));
			startupMarker("prompt:before-agent-start:done");

			// Bail out if a newer abort/prompt cycle has started since we began setup
			if (this.#promptGeneration !== generation) {
				return;
			}

			// Auto thinking: classify this real user turn and set the effective level
			// before the model request. Synthetic/tool-continuation turns (developer/
			// custom roles) and non-auto sessions are skipped. Never blocks the turn —
			// failures fall back to a concrete level inside the helper.
			if (this.#thinking.isAuto && message.role === "user") {
				await this.#thinking.applyAuto(expandedText, generation);
				if (this.#promptGeneration !== generation) {
					return;
				}
			}

			startupMarker("prompt:pre-prompt-compaction:start");
			await this.#contextCheck.beforePrompt(messages);
			startupMarker("prompt:pre-prompt-compaction:done");
			if (this.#promptGeneration !== generation) {
				return;
			}

			// Built after the pre-prompt compaction, which restates a block it summarized
			// away, so the two never both send one. Ahead of the memories for the same reason
			// the memories are ahead of the question: the date and the working directory are
			// what the model should already know when it reads either.
			const sessionStateMessage = this.#preludes.sessionState();
			if (sessionStateMessage) messages.unshift(sessionStateMessage);

			const agentPromptOptions = options?.toolChoice ? { toolChoice: options.toolChoice } : undefined;
			this.#context.beginPrompt(messages);
			try {
				await this.#promptAgentWithIdleRetry(messages, agentPromptOptions, generation, () => {
					queued?.settle();
					options?.prepended?.settle();
				});
			} finally {
				this.#context.endPrompt();
			}
			if (!options?.skipPostPromptRecoveryWait) {
				await this.#continuations.waitForRecovery(generation);
			}
		} finally {
			queued?.release();
			this.#endInFlight();
		}
	}

	/**
	 * Queue a steering message to interrupt the agent mid-run.
	 */
	async steer(text: string, images?: ImageContent[]): Promise<void> {
		await this.#queue.queueUser(this.#commands.expandQueued(text), images, "steer");
	}

	/**
	 * Queue a follow-up message to process after the agent would otherwise stop.
	 * Set `options.synthetic` to enqueue a hidden developer message (agent-attributed
	 * by default) instead of a user-attributed follow-up; the plan-approval flow
	 * uses this to land its execution directive behind a queued user turn without
	 * flipping advisor auto-resume.
	 */
	async followUp(text: string, images?: ImageContent[], options?: FollowUpOptions): Promise<void> {
		const expandedText = this.#commands.expandQueued(text, options?.expandPromptTemplates !== false);
		if (options?.synthetic) {
			await this.#queue.queueDeveloperFollowUp(expandedText, images, options.attribution ?? "agent");
		} else {
			await this.#queue.queueUser(expandedText, images, "followUp");
		}
	}

	queueDeferredMessage(message: CustomMessage): void {
		this.#nextTurn.queue(message, true);
	}

	async #promptAgentInitiatedMessage(
		message: CustomMessage,
		options?: { acceptTerminalEmptyStop?: boolean },
	): Promise<void> {
		this.#inFlight.begin();
		try {
			const acceptTerminalEmptyStop = options?.acceptTerminalEmptyStop === true;
			if (acceptTerminalEmptyStop) {
				this.#resetPromptMaintenanceState();
			}
			this.#stopRetries.acceptTerminalEmptyStop = acceptTerminalEmptyStop;
			await this.agent.prompt(message);
			await this.#continuations.waitForRecovery();
		} finally {
			this.#stopRetries.acceptTerminalEmptyStop = false;
			this.#endInFlight();
		}
	}

	/**
	 * Send a custom message to the session, recorded as a custom message entry; see
	 * {@link CustomMessages.send}.
	 *
	 * @returns true iff this call started a turn and waited for it; false when the message was queued,
	 * held or appended without one, including a `triggerTurn` the client defers.
	 */
	async sendCustomMessage<T = unknown>(
		message: CustomMessagePayload<T>,
		options?: SendCustomMessageOptions,
	): Promise<boolean> {
		return this.#custom.send(message, options);
	}

	/**
	 * Send a user message through the prompt flow.
	 *
	 * Omitted `deliverAs` starts a turn when idle and queues as a steer while streaming.
	 * Explicit `deliverAs` queues without starting a turn in either state.
	 */
	async sendUserMessage(
		content: string | (TextContent | ImageContent)[],
		options?: { deliverAs?: "steer" | "followUp" },
	): Promise<void> {
		// Normalize content to text string + optional images
		let text: string;
		let images: ImageContent[] | undefined;

		if (typeof content === "string") {
			text = content;
		} else {
			const textParts: string[] = [];
			images = [];
			for (const part of content) {
				if (part.type === "text") {
					textParts.push(part.text);
				} else {
					images.push(part);
				}
			}
			text = textParts.join("\n");
			if (images.length === 0) images = undefined;
		}

		if (options?.deliverAs) {
			await this.#queue.queueUser(text, images, options.deliverAs);
			return;
		}

		// Use prompt() with expandPromptTemplates: false to skip command handling and template expansion.
		// `streamingBehavior: "steer"` preserves prompt-flow side effects during streaming while
		// covering the narrow race where a stream starts before prompt() acquires the turn.
		await this.prompt(text, {
			expandPromptTemplates: false,
			images,
			streamingBehavior: "steer",
		});
	}

	/** Clear the queues and return the user-restorable messages; see {@link QueuedMessages.clear}. */
	clearQueue(options?: { forInterrupt?: boolean }): {
		steering: RestoredQueuedMessage[];
		followUp: RestoredQueuedMessage[];
	} {
		return this.#queue.clear(options);
	}

	/** Number of pending displayable messages; see {@link QueuedMessages.count}. Feeds
	 *  hasPendingMessages()/RPC and the empty-submit abort gate. */
	get queuedMessageCount(): number {
		return this.#queue.count;
	}

	getQueuedMessages(): { steering: readonly string[]; followUp: readonly string[] } {
		return this.#queue.chips();
	}

	/**
	 * Pop the last user-restorable queued message, steering first, then follow-up. Used by the
	 * dequeue keybinding to restore messages to the editor one at a time.
	 */
	popLastQueuedMessage(): RestoredQueuedMessage | undefined {
		return this.#queue.popLast();
	}

	get skillsSettings(): SkillsSettings | undefined {
		return this.#config.skillsSettings;
	}

	/** Skills loaded by SDK (empty if --no-skills or skills: [] was passed) */
	get skills(): readonly Skill[] {
		return this.#skills;
	}

	/** Atomically replace the skills visible to this live session after a cwd re-scope. */
	replaceSkills(skills: readonly Skill[]): void {
		this.#skills = [...skills];
	}

	/** Replace every cwd-derived advisor input and rebuild advisor agents in that scope. */
	replaceProjectAdvisorScope(scope: ProjectAdvisorScope): void {
		this.#advisorRoster.replaceProjectScope(scope);
	}

	/**
	 * Non-fatal problems the operator must see, from every subsystem that raises one.
	 *
	 * A live channel, not a record: whatever surface the session is running under attaches to
	 * this and renders what arrives. It replaced `skillWarnings`, which was the same idea with no
	 * consumer, so a skill that failed to load produced a field nobody read.
	 */
	get operatorNotices(): OperatorNotices {
		return this.#operatorNotices;
	}

	/** The recorded todo board. Public: the RPC mode, the SDK, the todo slash
	 *  command and the interactive HUD all read and write it through here. */
	getTodoPhases(): TodoPhase[] {
		return this.#todo.phases();
	}

	setTodoPhases(phases: TodoPhase[]): void {
		this.#todo.setPhases(phases);
	}

	/** Currently-applied {@link TITLE_SYSTEM.md} override, or undefined when the
	 *  bundled prompt is in effect. Consumed by {@link InteractiveMode} so the
	 *  first-input title path and the replan refresh share one source. */
	get titleSystemPrompt(): string | undefined {
		return this.#replanTitle.systemPrompt;
	}

	/** Replace the title-generation system prompt override. Called by
	 *  {@link InteractiveMode.refreshTitleSystemPrompt} after the session cwd
	 *  changes (e.g. `/move` relocation) so the next replan refresh resolves
	 *  against the destination project's override. */
	setTitleSystemPrompt(prompt: string | undefined): void {
		this.#replanTitle.systemPrompt = prompt;
	}

	/**
	 * Abort current operation and wait for agent to become idle.
	 *
	 * `reason` (e.g. `USER_INTERRUPT_LABEL`) rides the agent's `AbortController`
	 * and surfaces verbatim on the aborted assistant message's `errorMessage`, so
	 * the transcript can distinguish a deliberate user interrupt from an opaque
	 * abort. Omit it for internal/lifecycle aborts.
	 */
	async abort(options?: {
		goalReason?: GoalAbortReason;
		reason?: string;
		/** Internal `/compact` startup keeps the manual-compaction marker alive while aborting the active turn. */
		preserveCompaction?: boolean;
	}): Promise<void> {
		const userInterrupt = options?.reason === USER_INTERRUPT_LABEL;
		this.#pendingAbortErrorId = userInterrupt ? AIError.create(AIError.Flag.UserInterrupt) : undefined;
		if (userInterrupt) this.#advisorRoster.suppressAutoResume();
		// Pull advisor concerns out of the steer/follow-up queues before any await so
		// the post-abort stranded-message drain can't auto-resume the run on them.
		// They are re-recorded as visible advice once the agent settles (below).
		const strandedAdvisorCards = userInterrupt ? this.#advisorRoster.extractQueuedCards() : [];
		// Session switch/compact paths disconnect first; explicit aborts should
		// leave any queued steer/follow-up visible for the user rather than
		// auto-starting a fresh turn during cleanup.
		this.#abortInProgress = true;
		try {
			this.abortRetry();
			this.#promptGeneration++;
			this.#nextTurn.forgetRequestedTurn();
			if (options?.preserveCompaction) {
				// Manual `/compact` installed its own abort controller before
				// this internal abort and must keep it alive (that marker is what makes
				// isCompacting report true during startup). Any in-flight
				// auto-compaction MUST still be cancelled, though: otherwise a
				// background maintenance pass races the manual run and both
				// appendCompaction/replaceMessages, double-rewriting session history.
				this.#compaction.abortAutomatic();
			} else {
				this.abortCompaction();
			}
			this.abortHandoff();
			this.abortBash();
			this.abortEval();
			// The advisors are reviewing the turn being stopped. Without this they keep
			// streaming after the interrupt, one model call per configured advisor, and
			// bill for a review of work that no longer exists.
			this.#advisorRoster.cancelInFlight(options?.reason ?? "primary aborted");
			const postPromptDrain = this.#continuations.cancel();
			this.agent.abort(options?.reason);
			await postPromptDrain;
			await this.agent.waitForIdle();
			await this.#goalRuntime.onTaskAborted({ reason: options?.goalReason ?? "interrupted" });
			// Clear prompt-in-flight state: waitForIdle resolves when the agent loop's finally
			// block runs, but nested prompt setup/finalizers may still be unwinding. Without this,
			// a subsequent prompt() can incorrectly observe the session as busy after an abort.
			this.#endInFlight(true);
			this.#stopHook.reset();
			this.#nextTurn.remove(message => message.customType === "session-stop-continuation");
			// Safety net: if the agent loop aborted without producing an assistant
			// message (e.g. failed before the first stream), the in-flight yield was
			// never resolved or rejected by the normal message_end path. Reject it now
			// so any requeue callback still fires and the queue stays consistent.
			if (this.#toolChoiceQueue.hasInFlight) {
				this.#toolChoiceQueue.reject("aborted");
			}
			// Re-record advisor concerns the interrupt would otherwise strand, as
			// visible/persisted advice without triggering a turn (the agent is idle
			// now): cards steered into the queue before the user stopped, plus any
			// that arrived via enqueueAdvice mid-abort and were parked hidden in
			// the next-turn queue while the turn was still tearing down. Other
			// deferred next-turn context (non-advisor) stays queued, in order.
			const parkedAdvisorCards = this.#nextTurn.remove(isAdvisorCard);
			for (const card of [...strandedAdvisorCards, ...parkedAdvisorCards]) {
				this.#advisorRoster.preserveCard(card);
			}
		} finally {
			this.#abortInProgress = false;
			this.#drainStrandedQueuedMessages();
		}
	}

	/**
	 * Start a new session, optionally with initial messages and parent tracking.
	 * Clears all messages and starts a new session.
	 * Listeners are preserved and will continue receiving events.
	 * @param options - Optional initial messages and parent session path
	 * @returns true if completed, false if cancelled by hook
	 */
	newSession(options?: NewSessionOptions): Promise<boolean> {
		return this.#sessionSwitch.startNew(options);
	}

	/**
	 * Set a display name for the current session.
	 */
	setSessionName(name: string, source: "auto" | "user" = "auto", trigger?: SessionNameTrigger): Promise<boolean> {
		const setSessionName = this.sessionManager.setSessionName as SetSessionNameWithTrigger;
		return setSessionName.call(this.sessionManager, name, source, trigger);
	}

	/**
	 * Fork the current session, creating a new session file with the exact same state.
	 * Copies all entries and artifacts to the new session.
	 * Unlike newSession(), this preserves all messages in the agent state.
	 * @returns true if completed, false if cancelled by hook or not persisting
	 */
	fork(): Promise<boolean> {
		return this.#sessionSwitch.fork();
	}

	// =========================================================================
	// Model Management
	// =========================================================================

	/**
	 * Set model directly, recorded under `slot` and saved as `defaultModel` with `options.persist`.
	 * See {@link ModelSelection.setModel}.
	 * @throws Error if no credential source is configured for the model
	 */
	setModel(model: Model, slot = "default", options?: SetModelOptions): Promise<{ switched: boolean }> {
		return this.#models.setModel(model, slot, options);
	}

	/**
	 * Set model for this session only: the session file records it, settings do not.
	 * @throws Error if no credential source is configured for the model
	 */
	setModelTemporary(
		model: Model,
		thinkingLevel?: ConfiguredThinkingLevel,
		options?: { ephemeral?: boolean },
	): Promise<void> {
		return this.#models.setModelTemporary(model, thinkingLevel, options);
	}

	/**
	 * Cycle to the next or previous model: the scoped models (from `--models`) when there are any,
	 * otherwise every available model. Undefined when there is at most one to cycle through.
	 */
	cycleModel(direction: "forward" | "backward" = "forward"): Promise<ModelCycleResult | undefined> {
		return this.#models.cycle(direction);
	}

	/** Every available model with a valid API key, narrowed by the `enabledModels` patterns when set. */
	getAvailableModels(): Model[] {
		return this.#models.available();
	}

	/** Whether the active model's family is set to `priority`; see {@link ServiceTiers.fastModeEnabled}. */
	isFastModeEnabled(): boolean {
		return this.#tiers.fastModeEnabled();
	}

	/** Whether `priority` reaches the wire for the active model; see {@link ServiceTiers.fastModeActive}. */
	isFastModeActive(): boolean {
		return this.#tiers.fastModeActive();
	}

	/** Set one family's tier (or clear it with `undefined`); persists the change. */
	setServiceTierFamily(family: ServiceTierFamily, tier: ServiceTier | undefined): void {
		this.#tiers.setFamily(family, tier);
	}

	/** `/fast on|off` for the active model's family; false when it has none. See {@link ServiceTiers.setFastMode}. */
	setFastMode(enabled: boolean): boolean {
		return this.#tiers.setFastMode(enabled);
	}

	toggleFastMode(): boolean {
		return this.#tiers.toggleFastMode();
	}

	// =========================================================================
	// Message Queue Mode Management
	// =========================================================================

	/**
	 * Apply a live instrumentation change to settings, future model loops, and
	 * the session journal's lifecycle interval as one transition.
	 */
	setInstrumentationLevel(level: InstrumentationLevel): void {
		this.settings.set("session.instrumentation", level);
		this.agent.instrumentation = level;
		this.sessionManager.setInstrumentationLevel(level);
	}

	/**
	 * Set steering mode.
	 * Saves to settings.
	 */
	setSteeringMode(mode: "all" | "one-at-a-time"): void {
		this.agent.setSteeringMode(mode);
		this.settings.set("steeringMode", mode);
	}

	/**
	 * Set follow-up mode.
	 * Saves to settings.
	 */
	setFollowUpMode(mode: "all" | "one-at-a-time"): void {
		this.agent.setFollowUpMode(mode);
		this.settings.set("followUpMode", mode);
	}

	/**
	 * Set interrupt mode.
	 * Saves to settings.
	 */
	setInterruptMode(mode: "immediate" | "wait"): void {
		this.agent.setInterruptMode(mode);
		this.settings.set("interruptMode", mode);
	}

	// =========================================================================
	// Compaction
	// =========================================================================

	/**
	 * Strip image blocks from every message on the current branch and persist the rewrite. Returns
	 * `{ removed: 0 }` without a rewrite when the branch holds no image.
	 */
	dropImages(): Promise<{ removed: number }> {
		return this.#rewrites.dropImages();
	}

	/**
	 * Reduce context by dropping heavy content. `images` delegates to {@link dropImages}; `elide`
	 * replaces large tool results, large fenced or XML blocks, and duplicated tool results with
	 * placeholders that link an `artifact://` copy of the original. Zero counts when nothing is
	 * eligible.
	 */
	shake(mode: ShakeMode, opts: { config?: ShakeConfig; signal?: AbortSignal } = {}): Promise<ShakeResult> {
		return this.#rewrites.shake(mode, opts);
	}

	/**
	 * Elide earlier tool results byte-identical to a newer one. Lossless and model-free, so any
	 * compaction strategy may run it. Zero counts when nothing is redundant.
	 */
	dedupeRedundantToolResults(): Promise<{ toolResultsDropped: number; tokensFreed: number; artifactId?: string }> {
		return this.#rewrites.dedupeRedundantToolResults();
	}

	/**
	 * Manually compact the session context.
	 * Aborts current agent operation first.
	 * @param customInstructions Optional instructions for the compaction summary
	 * @param options Optional callbacks for completion/error handling
	 */
	compact(customInstructions?: string, options?: CompactOptions): Promise<CompactionResult> {
		return this.#compaction.compact(customInstructions, options);
	}

	/**
	 * Cancel in-progress manual or automatic context maintenance.
	 */
	abortCompaction(): void {
		this.#compaction.abort();
		this.#sessionHandoff.abort();
	}

	/** Trigger idle compaction through the auto-compaction flow (with UI events). */
	async runIdleCompaction(): Promise<void> {
		if (this.isStreaming || this.isCompacting) return;
		// A port replaces the expanded span with a summary, which is the reduction
		// the idle pass exists for; compacting again on top of it would pay twice.
		if (await this.#compaction.portUnreadableRemoteCompaction()) return;
		await this.#compaction.runAutoCompaction("idle", false);
	}

	/**
	 * Cancel in-progress branch summarization.
	 */
	abortBranchSummary(): void {
		this.#sessionBranch.abortSummary();
	}

	/**
	 * Cancel in-progress handoff generation.
	 */
	abortHandoff(): void {
		this.#sessionHandoff.abort();
	}

	/**
	 * Check if handoff generation is in progress.
	 */
	get isGeneratingHandoff(): boolean {
		return this.#sessionHandoff.active;
	}

	/**
	 * Generate a handoff document with a oneshot LLM call, then start a new session with it.
	 *
	 * @param customInstructions Optional focus for the handoff document
	 * @param options Handoff execution options
	 * @returns The handoff document text, or undefined if cancelled/failed
	 */
	handoff(customInstructions?: string, options?: SessionHandoffOptions): Promise<HandoffResult | undefined> {
		return this.#sessionHandoff.run(customInstructions, options);
	}

	/**
	 * Drop an assistant turn from BOTH the live agent context and the persisted
	 * session branch (reparenting the leaf to the turn's parent), so a discarded
	 * turn does not resurface on reload. Used for empty/reasoning-only stops and
	 * the Gemini header-runaway interrupt, which must not replay a partial,
	 * loop-fueling thinking block.
	 */
	#discardAssistantTurn(assistantMessage: AssistantMessage): void {
		removeAssistantMessageFromActiveContext(this.agent, assistantMessage);
		this.#persistence.dropAssistantFromBranch(assistantMessage);
	}

	async #applyRewind(report: string, activeMessages?: AgentMessage[]): Promise<void> {
		const checkpointState = this.#checkpoint.state;
		if (!checkpointState) {
			return;
		}
		try {
			this.sessionManager.branchWithSummary(checkpointState.checkpointEntryId, report, {
				startedAt: checkpointState.startedAt,
			});
		} catch (error) {
			logger.warn("Rewind branch checkpoint missing, falling back to root", {
				error: errorMessage(error),
			});
			this.sessionManager.branchWithSummary(null, report, { startedAt: checkpointState.startedAt });
		}

		const rewoundAt = new Date().toISOString();
		const details = { report, startedAt: checkpointState.startedAt, rewoundAt };
		this.sessionManager.appendCustomMessageEntry(
			"rewind-report",
			prompt.render(turnControlPrompts["turn-control/rewind-report"].text, { report }),
			false,
			details,
			"agent",
		);
		this.#checkpoint.markRewound({ report, startedAt: checkpointState.startedAt, rewoundAt }, activeMessages);
		const sessionContext = this.buildDisplaySessionContext();
		if (activeMessages) {
			activeMessages.splice(0, activeMessages.length, ...sessionContext.messages);
		}
		await this.#toolActivation.restoreMCPSelections(sessionContext);
		this.agent.replaceMessages(activeMessages ?? sessionContext.messages);
		this.#advisorRoster.resetSessionState();
		this.#todo.syncFromBranch();
		this.#providerSessions.closeCodexForHistoryRewrite(this.model);
		this.#checkpoint.finish();
	}

	#setModelWithProviderSessionReset(model: Model): void {
		const currentModel = this.model;
		if (currentModel) {
			this.#providerSessions.closeForModelSwitch(currentModel, model);
			if (!modelsAreEqual(currentModel, model)) {
				this.#providerSessions.clearInheritedCacheKey("model-change");
			}
		}
		this.agent.setModel(model);

		// Re-evaluate append-only context mode — provider or setting may have changed
		this.#syncAppendOnlyContext(model);
	}

	/**
	 * Re-evaluate append-only context mode, creating or destroying the
	 * manager as needed. Called on model switch AND setting change.
	 */
	#syncAppendOnlyContext(model: Model | null | undefined): void {
		const setting = this.settings.get("provider.appendOnlyContext");
		const enable = shouldEnableAppendOnlyContext(setting, model);
		const providerId = model?.provider;
		const prev = this.#lastAppendOnlyResolution;
		if (prev && prev.enable === enable && prev.providerId === providerId) return;
		this.#lastAppendOnlyResolution = { enable, providerId };

		if (enable && !this.agent.appendOnlyContext) {
			this.agent.setAppendOnlyContext(new AppendOnlyContextManager());
		} else if (enable && this.agent.appendOnlyContext) {
			// Already active — invalidate prefix + log so the next turn
			// rebuilds for the current model's normalization.
			this.agent.appendOnlyContext.invalidateForModelChange();
		} else if (!enable && this.agent.appendOnlyContext) {
			this.agent.setAppendOnlyContext(undefined);
		}
	}

	/**
	 * Toggle auto-compaction setting.
	 */
	setAutoCompactionEnabled(enabled: boolean): void {
		this.settings.set("compaction.enabled", enabled);
	}

	/** Whether auto-compaction is enabled */
	get autoCompactionEnabled(): boolean {
		return this.settings.get("compaction.enabled");
	}

	// =========================================================================
	// Auto-Retry
	// =========================================================================

	/**
	 * Cancel in-progress retry.
	 */
	abortRetry(): void {
		this.#retry.abort();
	}

	/**
	 * Prompt the agent, waiting out a run that is still in flight. A hidden
	 * continuation queued from an `agent_end` handler lands here while the turn
	 * it reacts to is still unwinding, so the agent is still busy with it.
	 *
	 * `generation` is the prompt cycle the caller started in. The wait ends when
	 * the agent is idle, and a user interrupt is one way it gets there: `abort()`
	 * bumps the generation before the loop settles, and a prompt that woke on
	 * that settle would start the very turn the user stopped. The autoresearch
	 * stall nudge did exactly that -- Escape ended the run and the nudge queued a
	 * turn earlier restarted it three milliseconds later. A stale generation
	 * returns without prompting; the prompt's own messages are dropped like every
	 * other setup-time bail-out in `#promptWithMessage`, and the queued context
	 * it leased goes back to its queue.
	 *
	 * `accepted` runs the moment the agent takes `messages`. `Agent.prompt`
	 * refuses a busy agent before it takes anything, so the busy agent is waited
	 * out here rather than prompted and refused.
	 */
	async #promptAgentWithIdleRetry(
		messages: AgentMessage[],
		options: { toolChoice?: ToolChoice } | undefined,
		generation: number,
		accepted: () => void,
	): Promise<void> {
		const deadline = Date.now() + 30_000;
		while (this.agent.state.isStreaming) {
			if (Date.now() >= deadline) {
				throw new Error("Timed out waiting for prior agent run to finish before prompting.");
			}
			await this.#queue.whileWaitingOnIdle(() => this.agent.waitForIdle());
			if (this.#promptGeneration !== generation) {
				return;
			}
		}
		accepted();
		await this.agent.prompt(messages, options);
	}

	/** Whether auto-retry is currently in progress */
	get isRetrying(): boolean {
		return this.#retry.isRetrying;
	}

	/** Whether auto-retry is enabled */
	get autoRetryEnabled(): boolean {
		return this.settings.get("retry.enabled");
	}

	/**
	 * Toggle auto-retry setting.
	 */
	setAutoRetryEnabled(enabled: boolean): void {
		this.settings.set("retry.enabled", enabled);
	}
	/**
	 * Manually retry the last failed assistant turn.
	 * Removes the error message from agent state and re-attempts with a fresh retry budget.
	 * @returns true if retry was initiated, false if no failed turn to retry or agent is busy
	 */
	async retry(): Promise<boolean> {
		if (this.isStreaming || this.isCompacting || this.isRetrying) return false;
		return this.#retry.retryLastFailedTurn();
	}

	// =========================================================================
	// Bash Execution
	// =========================================================================

	/**
	 * Execute a bash command.
	 * Adds result to agent context and session.
	 * @param command The bash command to execute
	 * @param onChunk Optional streaming callback for output
	 * @param options.excludeFromContext If true, command output won't be sent to LLM (!! prefix)
	 * @param options.useUserShell If true, allow caller to request configured user-shell routing
	 */
	async executeBash(
		command: string,
		onChunk?: (chunk: string) => void,
		options?: { excludeFromContext?: boolean; useUserShell?: boolean },
	): Promise<BashResult> {
		return this.#executions.executeBash(command, onChunk, options);
	}

	/**
	 * Record a bash execution result in session history.
	 * Used by executeBash and by extensions that handle bash execution themselves.
	 */
	recordBashResult(command: string, result: BashResult, options?: { excludeFromContext?: boolean }): void {
		this.#executions.recordBash(command, result, options);
	}

	/**
	 * Cancel running bash command.
	 */
	abortBash(): void {
		this.#executions.abortBash();
	}

	/** Whether a bash command is currently running */
	get isBashRunning(): boolean {
		return this.#executions.bashRunning;
	}

	/** Whether there are pending bash messages waiting to be flushed */
	get hasPendingBashMessages(): boolean {
		return this.#executions.hasDeferredBash;
	}

	// =========================================================================
	// User-Initiated Python Execution
	// =========================================================================

	/**
	 * Execute Python code in the shared kernel.
	 * Uses the same kernel session as eval's Python backend, allowing collaborative editing.
	 * @param code The Python code to execute
	 * @param onChunk Optional streaming callback for output
	 * @param options.excludeFromContext If true, execution won't be sent to LLM ($$ prefix)
	 */
	async executePython(
		code: string,
		onChunk?: (chunk: string) => void,
		options?: { excludeFromContext?: boolean },
	): Promise<PythonResult> {
		return this.#executions.executePython(code, onChunk, options);
	}

	assertEvalExecutionAllowed(): void {
		this.#executions.assertEvalAllowed();
	}

	/**
	 * Track Python work started outside AgentSession.executePython so dispose can await and abort it too.
	 */
	trackEvalExecution<T>(execution: Promise<T>, abortController: AbortController): Promise<T> {
		return this.#executions.trackEval(execution, abortController);
	}

	/**
	 * Record a Python execution result in session history.
	 */
	recordPythonResult(code: string, result: PythonResult, options?: { excludeFromContext?: boolean }): void {
		this.#executions.recordPython(code, result, options);
	}

	/**
	 * Cancel running Python execution.
	 */
	abortEval(): void {
		this.#executions.abortEval();
	}

	/** Whether a Python execution is currently running */
	get isEvalRunning(): boolean {
		return this.#executions.evalRunning;
	}

	/** Whether there are pending Python messages waiting to be flushed */
	get hasPendingPythonMessages(): boolean {
		return this.#executions.hasDeferredPython;
	}

	// =========================================================================
	// IRC Delivery
	// =========================================================================

	/**
	 * Surfaces and consumes pending IRC incoming records before the next model
	 * step can inject them automatically.
	 *
	 * Tool results already expose the formatted body to the model. Leaving the
	 * same record in either pending IRC queue would deliver it a second time at
	 * the next step boundary — including on `peek`, which is why inbox peeks
	 * also drain here.
	 */
	drainPendingIrcInboxMessages(agentId: string, opts?: { from?: string; limit?: number }): IrcMessage[] {
		return this.#irc.inbox.takeIncoming(agentId, opts);
	}

	/**
	 * Deliver an IRC message into this session (recipient side; called by the IrcBus); see
	 * {@link IrcDelivery.deliver}.
	 */
	async deliverIrcMessage(msg: IrcMessage, opts?: { expectsReply?: boolean }): Promise<"injected" | "woken"> {
		return this.#irc.deliver(msg, opts);
	}

	/**
	 * Persist one directional, content-free IRC delivery event as session
	 * metadata. Custom metadata survives JSONL reload but never enters context.
	 * Called only by the bus's exactly-once record boundary.
	 */
	recordIrcDeliveryTelemetry(facts: IrcPersistedDeliveryFacts): void {
		const detail = sessionTelemetryDetail(this.settings.get("session.instrumentation"), "agent-communication");
		if (detail !== "rich" && detail !== "ultra") return;
		const telemetry: IrcPersistedDeliveryTelemetry = {
			...projectIrcDeliveryTelemetry(detail, facts),
			messageId: facts.messageId,
			direction: facts.direction,
		};
		this.sessionManager.appendCustomEntry("irc:delivery-telemetry", telemetry);
	}

	/**
	 * Emit an IRC relay observation event on this session for UI rendering only.
	 * Does not persist the record to history. Called by the IrcBus to surface
	 * agent↔agent traffic on the main session.
	 */
	emitIrcRelayObservation(record: CustomMessage): void {
		void this.#events.send({ type: "irc_message", message: record });
	}

	/**
	 * Run a single ephemeral side-channel turn against this session's current model, system prompt
	 * and history, without modifying either; see {@link runEphemeralTurn}. Used by `/btw`, `/omfg`,
	 * the idle recap, the IRC auto-reply and the composer prediction.
	 */
	runEphemeralTurn(args: EphemeralTurnArgs): Promise<EphemeralTurnResult> {
		return runEphemeralTurn(
			{
				model: this.model,
				thinkingLevel: this.thinkingLevel,
				sessionId: this.sessionId,
				messages: this.messages,
				agent: this.agent,
				preferWebsockets: this.#config.preferWebsockets,
				providerSessionStates: this.#providerSessions.states,
				secrets: this.#secrets,
				sideStreamFn: this.#transport.sideStreamFn,
				convertMessagesToLlm: (messages, signal) => this.convertMessagesToLlm(messages, signal),
				prepareSimpleStreamOptions: (options, provider) => this.#transport.prepare(options, provider),
				resolveApiKey: (model, sessionId) => this.#config.modelRegistry.resolver(model, sessionId),
				effectiveServiceTier: model => this.#tiers.effective(model),
			},
			args,
		);
	}

	// =========================================================================
	// Session Management
	// =========================================================================

	/**
	 * Reload the current session from disk.
	 *
	 * Intended for extension commands and headless modes to re-read the current session
	 * file and re-emit session_switch hooks.
	 */
	async reload(): Promise<void> {
		const sessionFile = this.sessionFile;
		if (!sessionFile) return;
		await this.switchSession(sessionFile);
	}

	/**
	 * Switch to a different session file; see {@link SessionSwitch.switchTo}.
	 * @returns true if switch completed, false if cancelled by hook
	 */
	switchSession(sessionPath: string): Promise<boolean> {
		return this.#sessionSwitch.switchTo(sessionPath);
	}

	/**
	 * Create a branch from a user message entry; see {@link SessionBranch.branch}.
	 *
	 * @returns the selected message's text for editor pre-fill, and whether a hook cancelled
	 */
	branch(entryId: string): Promise<{ selectedText: string; cancelled: boolean }> {
		return this.#sessionBranch.branch(entryId);
	}

	/** Branch at the live leaf with a `/btw` exchange appended; see {@link SessionBranch.branchFromBtw}. */
	branchFromBtw(
		question: string,
		assistantMessage: AssistantMessage,
	): Promise<{ cancelled: boolean; sessionFile: string | undefined }> {
		return this.#sessionBranch.branchFromBtw(question, assistantMessage);
	}

	/**
	 * Navigate to a different node in the session tree, in the same session file; see
	 * {@link SessionBranch.navigateTree}.
	 */
	navigateTree(
		targetId: string,
		options: { summarize?: boolean; customInstructions?: string } = {},
	): Promise<TreeNavigationResult> {
		return this.#sessionBranch.navigateTree(targetId, options);
	}

	/**
	 * Get all user messages from session for branch selector.
	 */
	getUserMessagesForBranching(): Array<{ entryId: string; text: string }> {
		return this.#sessionBranch.userMessages();
	}

	/**
	 * Get session statistics.
	 *
	 * Spend covers the messages the latest compaction summarized away as well as
	 * the live context. Summing the context alone silently un-spends every turn
	 * behind the boundary: after one compaction `/session` reported half the cost
	 * the session had actually paid, and goal mode reads the same total as its
	 * token budget, so a long run bought itself budget back every time it
	 * compacted. `contextUsage` below still reports the LIVE context: what sits in
	 * the window and what has been spent are two different questions with one
	 * owner each.
	 */
	getSessionStats(): SessionStats {
		return {
			sessionFile: this.sessionFile,
			sessionId: this.sessionId,
			...this.#sessionSpend(),
			contextUsage: this.getContextUsage(),
		};
	}

	/**
	 * Spend over the messages the compaction in effect summarized away, oldest first, followed by
	 * the live context.
	 *
	 * The summarized messages are gone from the live context by design and they are still what this
	 * session paid for. Everything from the boundary forward is already in the context, so nothing
	 * is counted twice, and an earlier compaction's own summary is an ENTRY rather than a message,
	 * so a session that compacted several times counts each range once. The stored branch is also
	 * what a resume reads, so the total survives a restart.
	 */
	#sessionSpend(): SessionSpend {
		const branch = this.sessionManager.getBranch();
		const boundary = compactedHistoryEnd(branch);
		return this.#spendLedger.total(branch, boundary, this.state.messages);
	}

	/** The token totals goal accounting charges against a budget. */
	#goalUsage(): GoalTokenUsage {
		const { input, output, cacheRead, cacheWrite } = this.#sessionSpend().tokens;
		return { input, output, cacheRead, cacheWrite };
	}

	/**
	 * Get current context usage statistics.
	 * Uses the last assistant message's usage data when available,
	 * otherwise estimates tokens for all messages.
	 */
	getContextBreakdown(options?: {
		contextWindow?: number;
		pendingMessages?: AgentMessage[];
	}): ContextUsageBreakdown | undefined {
		return this.#context.breakdown(options);
	}

	getContextUsage(options?: { contextWindow?: number }): ContextUsage | undefined {
		return this.#context.usage(options);
	}

	/**
	 * Context usage with the non-message size the newest usage anchor recorded standing in for a
	 * measurement, so reading it builds no tool schema. Undefined when no anchor recorded that size or
	 * a prompt is in flight. See `ContextAccounting.restingUsage`.
	 */
	getRestingContextUsage(): ContextUsage | undefined {
		return this.#context.restingUsage();
	}

	/**
	 * Monotonic counter that changes whenever the in-flight pending context
	 * snapshot is set or cleared. Status-line context memoization keys on this so
	 * a value computed mid-turn cannot persist after the turn ends/aborts.
	 */
	get contextUsageRevision(): number {
		return this.#context.revision;
	}

	/** Usage reports for every stored credential, each provider's base URL resolved as requests resolve it. */
	async fetchUsageReports(signal?: AbortSignal): Promise<UsageReport[] | null> {
		return this.#usage.fetchReports(signal);
	}

	/**
	 * Redeem one saved rate-limit reset (OpenAI Codex or Anthropic) for a specific account. Powers the
	 * `/usage reset` command. Never throws for business outcomes; inspect the returned `code`.
	 */
	async redeemResetCredit(target: ResetCreditTarget, signal?: AbortSignal): Promise<ResetCreditRedeemOutcome> {
		return this.#usage.redeem(target, signal);
	}

	/**
	 * List saved rate-limit resets per stored OpenAI Codex and Anthropic account, fetched live from
	 * each provider's reset route (bypasses the usage cache). Powers the `/usage reset` account selector.
	 */
	async listResetCredits(signal?: AbortSignal): Promise<ResetCreditAccountStatus[]> {
		return this.#usage.listResetCredits(signal);
	}

	/**
	 * Export session to HTML. `outputPath` and the generated default name resolve against the
	 * session's working directory, never the process's: an ACP server holds several sessions.
	 * @returns Absolute path to the exported file
	 */
	exportToHtml(outputPath?: string): Promise<string> {
		return this.#exports.toHtml(outputPath);
	}

	// =========================================================================
	// Utilities
	// =========================================================================

	/** The text of the last assistant message `/copy` picks up; see {@link TranscriptExports.lastAssistantText}. */
	getLastAssistantText(): string | undefined {
		return this.#exports.lastAssistantText();
	}

	hasCopyCandidateAssistantMessage(): boolean {
		return this.#exports.hasCopyCandidateAssistantMessage();
	}

	/** The text of the newest visible handoff; see {@link TranscriptExports.lastVisibleHandoffText}. */
	getLastVisibleHandoffText(): string | undefined {
		return this.#exports.lastVisibleHandoffText();
	}

	/** The whole session as plain text for the clipboard; see {@link TranscriptExports.asText}. */
	formatSessionAsText(): string {
		return this.#exports.asText();
	}

	/**
	 * Write the request the session would send next to a JSON file in the user's private temp directory; see
	 * {@link TranscriptExports.writeRequestSnapshot}. The file may hold the same raw context and
	 * secrets as `/dump`.
	 *
	 * @returns the written file path, or `undefined` when there are no messages.
	 */
	dumpLlmRequestToTmpDir(): Promise<string | undefined> {
		return this.#exports.writeRequestSnapshot();
	}

	/**
	 * Enable or disable the advisor for this session. The setting is overridden for the session,
	 * and the runtime is started or stopped to match.
	 *
	 * @returns true when the advisor is actively running after the call.
	 */
	setAdvisorEnabled(enabled: boolean): boolean {
		return this.#advisorRoster.setEnabled(enabled);
	}

	/**
	 * Toggle the advisor setting and start/stop the runtime accordingly.
	 *
	 * @returns true when the advisor is actively running after the call.
	 */
	toggleAdvisorEnabled(): boolean {
		return this.setAdvisorEnabled(!this.#advisorRoster.enabled);
	}

	/**
	 * Replace the live advisor roster from an edited `WATCHDOG.yml` (the `/advisor
	 * configure` save path). Swaps the configs + shared baseline, then rebuilds the
	 * runtimes in place so the change applies without a restart. When the advisor is
	 * disabled the new configs are simply stored for the next enable.
	 *
	 * @returns the number of advisors active after the rebuild.
	 */
	applyAdvisorConfigs(advisors: AdvisorConfig[], sharedInstructions: string | undefined): number {
		return this.#advisorRoster.applyConfigs(advisors, sharedInstructions);
	}

	/**
	 * Whether the advisor setting is enabled for this session.
	 */
	isAdvisorEnabled(): boolean {
		return this.#advisorRoster.enabled;
	}

	/**
	 * Whether a live advisor agent is attached to this session. True only when
	 * `advisor.enabled` is set AND a model resolved for the `advisor` role AND
	 * the advisor applies to this agent kind — i.e. the actual runtime exists,
	 * not merely the setting. Drives the status-line badge and `/dump advisor`.
	 */
	isAdvisorActive(): boolean {
		return this.#advisorRoster.active;
	}

	/**
	 * The names of the tools available to advisors this session (the pool a
	 * `/advisor configure` editor lists). The advisor is a full agent, so this is the
	 * full built tool set, built here if no advisor has reviewed a turn yet; a tool
	 * whose optional factory returns null (e.g. lsp with no servers) is absent.
	 */
	getAdvisorAvailableToolNames(): Promise<string[]> {
		return this.#advisorRoster.availableToolNames();
	}

	/**
	 * The live advisor `Agent`, or `undefined` when no advisor runtime is
	 * attached. Surfaced for diagnostics (`/dump advisor` already serializes
	 * its transcript via {@link formatAdvisorHistoryAsText}) and so callers can
	 * verify the advisor inherits the session's provider-shaping options
	 * (`streamFn`, `promptCacheKey`, `providerSessionState`, ...).
	 */
	getAdvisorAgent(): Agent | undefined {
		return this.#advisorRoster.firstAgent();
	}

	/**
	 * Return structured advisor stats for the status command and TUI panel.
	 */
	getAdvisorStats(): AdvisorStats {
		return this.#advisorRoster.stats();
	}

	/**
	 * Format a concise advisor status line for ACP/text output.
	 */
	formatAdvisorStatus(): string {
		return formatAdvisorStatus(this.getAdvisorStats());
	}

	/**
	 * Format the advisor agent's own transcript (its system prompt, config,
	 * tools, and the markdown deltas it received plus its thinking/advise/read
	 * calls) as plain text — the advisor-side equivalent of
	 * {@link formatSessionAsText}. Returns null when no advisor is active.
	 */
	formatAdvisorHistoryAsText(options?: { compact?: boolean }): string | null {
		return this.#advisorRoster.formatHistoryAsText(options);
	}

	// =========================================================================
	// Extension System
	// =========================================================================

	/**
	 * Check if extensions have handlers for a specific event type.
	 */
	hasExtensionHandlers(eventType: string): boolean {
		return this.#config.extensionRunner?.hasHandlers(eventType) ?? false;
	}

	/**
	 * Get the extension runner (for setting UI context and error handlers).
	 */
	get extensionRunner(): ExtensionRunner | undefined {
		return this.#config.extensionRunner;
	}
}
