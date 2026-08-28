import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { isPromise } from "node:util/types";
import {
	type AfterToolCallContext,
	type AfterToolCallResult,
	Agent,
	AgentBusyError,
	type AgentEvent,
	type AgentMessage,
	type AgentState,
	type AgentTool,
	type AgentToolResult,
	type AgentTurnEndContext,
	AppendOnlyContextManager,
	type AsideMessage,
	type CompactionSummaryMessage,
	countTokens,
	createToolScopedAbortReason,
	resolveTelemetry,
	type StreamFn,
	TERMINAL_TOOL_RESULT_ABORT_REASON,
	ThinkingLevel,
	type ToolChoiceDirective,
	toolResultNeverRan,
} from "@veyyon/agent-core";
import {
	AGGRESSIVE_SHAKE_CONFIG,
	applyShakeRegions,
	assertValidCompactionResult,
	CompactionCancelledError,
	type CompactionPreparation,
	type CompactionResult,
	type CompactionSettings,
	calculateContextTokens,
	calculatePromptTokens,
	collectEntriesForBranchSummary,
	collectRedundantToolResultRegions,
	collectShakeRegions,
	compact,
	compactionContextTokens,
	compactWithProvider,
	computeFileLists,
	createCompactionSummaryMessage,
	createFileOps,
	estimateCompactionRequestTokens,
	estimateTokens,
	extractFileOpsFromMessages,
	formatCompactionThreshold,
	generateBranchSummary,
	generateHandoffFromContext,
	hasLegacyArchive,
	prepareCompaction,
	redactLegacyArchiveText,
	renderHandoffPrompt,
	renderTailElisionArtifact,
	renderTailElisionMarker,
	resolveBudgetReserveTokens,
	resolveCompactionBoundaryIndex,
	resolveServerCompactionTransport,
	resolveThresholdTokens,
	resolveThresholdWithOrigin,
	rollbackTailElisions,
	type SessionMessageEntry,
	type ShakeConfig,
	type ShakeRegion,
	type SummaryOptions,
	shouldCompact,
	upsertFileOperations,
} from "@veyyon/agent-core/compaction";
import { modelServesPrefixCacheHits } from "@veyyon/agent-core/compaction/cache-aligned-context";
import {
	DEFAULT_PRUNE_CONFIG,
	pruneSupersededToolResults,
	pruneToolOutputs,
	readToolSupersedeKey,
} from "@veyyon/agent-core/compaction/pruning";
import type { ProtectedToolMatcher } from "@veyyon/agent-core/compaction/tool-protection";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	AssistantRetryRecovery,
	AssistantRetryRecoveryKind,
	CodexCompactionContext,
	Context,
	ImageContent,
	InstrumentationLevel,
	Message,
	MessageAttribution,
	Model,
	ProviderResponseMetadata,
	ProviderSessionState,
	ResetCreditAccountStatus,
	ResetCreditRedeemOutcome,
	ResetCreditTarget,
	ServiceTier,
	ServiceTierByFamily,
	ServiceTierFamily,
	SimpleStreamOptions,
	TextContent,
	ToolCall,
	ToolChoice,
	ToolResultMessage,
	Usage,
	UsageReport,
} from "@veyyon/ai";
import {
	calculateRateLimitBackoffMs,
	clearAnthropicFastModeFallback,
	parseRateLimitReason,
	realizesPriorityServiceTier,
	resolveModelServiceTier,
	serviceTierFamily,
	streamSimple,
} from "@veyyon/ai";
import * as AIError from "@veyyon/ai/error";
import {
	assistantTurnMetricsForPersistence,
	assistantTurnRequestForPersistence,
	instrumentationRank,
	type SessionTelemetryDetail,
	sessionTelemetryDetail,
	toolCallMetricsForPersistence,
} from "@veyyon/ai/instrumentation";
import { elidedSignatureBytes, signaturePolicy } from "@veyyon/ai/providers/google-shared";
import { resetOpenAICodexHistoryAfterCompaction } from "@veyyon/ai/providers/openai-codex-responses";
import { type CursorExecResolvedCarrier, kCursorExecResolved } from "@veyyon/ai/utils/block-symbols";
import { assistantText } from "@veyyon/ai/utils/message-text";
import { toolWireSchema } from "@veyyon/ai/utils/schema";
import { GeminiHeaderRunDetector, isGeminiThinkingModel } from "@veyyon/ai/utils/thinking-loop";
import { type RepeatedToolCallDetection, ToolCallLoopGuard } from "@veyyon/ai/utils/tool-call-loop-guard";
import { Effort } from "@veyyon/catalog/effort";
import { isFireworksFastModelId, toFireworksBaseModelId } from "@veyyon/catalog/fireworks-model-id";
import { getSupportedEfforts } from "@veyyon/catalog/model-thinking";
import { modelsAreEqual } from "@veyyon/catalog/models";
import { ANTIGRAVITY_PRIMARY_ENDPOINT, ANTIGRAVITY_SANDBOX_ENDPOINT } from "@veyyon/catalog/provider-endpoints";
import type { InMemorySnapshotStore } from "@veyyon/hashline";
import { MacOSPowerAssertion } from "@veyyon/natives";
import {
	errorMessage,
	escapeXmlText,
	extractRetryHint,
	formatCount,
	formatDuration,
	getActiveAuthDbPath,
	isAbortError,
	isBunTestRuntime,
	isEnoent,
	isRecord,
	logger,
	postmortem,
	prompt,
	relativePathWithinRoot,
	Snowflake,
	setProjectDir,
	withScopedTimeoutSignal,
	withTimeout,
} from "@veyyon/utils";
import { startupMarker } from "@veyyon/utils/startup-marker";
import type { ArgotSession } from "argot";
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
import {
	ArgotStreamDisplayDecoder,
	expandAssistantContent,
	expandSessionContext,
	expandSessionMessageEntries,
} from "../argot-wire";
import { type AsyncJob, type AsyncJobDeliveryState, AsyncJobManager } from "../async";
import { classifyDifficulty } from "../auto-thinking/classifier";
import { reset as resetCapabilities } from "../capability";
import type { Rule } from "../capability/rule";
import { shouldEnableAppendOnlyContext } from "../config/append-only-context-mode";
import type { CompactionEngineAction } from "../config/compaction-strategy";
import {
	isCompactionStrategyOff,
	isThresholdCompactionDisabled,
	resolveCompactionEngineAction,
	toAgentCompactionSettings,
} from "../config/compaction-strategy";
import {
	type EffortSource,
	resolveEffort,
	withLegacyDefaultEffort,
	withPersistedEffort,
} from "../config/effort-resolver";
import { credentialRemedySentence, missingCredentialsMessage } from "../config/missing-credentials";
import type { ModelRegistry } from "../config/model-registry";
import {
	extractExplicitThinkingSelector,
	filterAvailableModelsByEnabledPatterns,
	formatModelSelectorValue,
	formatModelString,
	formatModelStringWithRouting,
	getModelMatchPreferences,
	parseModelString,
	type ResolvedModelRoleValue,
	resolveAdvisorRoleSelection,
	resolveCompactionModelPatterns,
	resolveModelOverride,
	resolveModelRoleValue,
} from "../config/model-resolver";
import {
	DEFAULT_MODEL_SLOT,
	getKnownRoleIds,
	MODEL_ROLES,
	resolveModelSlot,
	SELECTABLE_MODEL_ROLE_IDS,
} from "../config/model-roles";
import { expandPromptTemplate, type PromptTemplate } from "../config/prompt-templates";
import { applyProviderGlobalsFromSettings } from "../config/provider-globals";
import {
	buildServiceTierByFamily,
	PRIORITY_TIER_COMMAND_LABEL,
	serviceTierForAllFamilies,
	serviceTierSettingToTier,
} from "../config/service-tier";
import type { Settings, SkillsSettings } from "../config/settings";
import {
	getDefault,
	onAppendOnlyModeChanged,
	onModelRolesChanged,
	validateProviderMaxInFlightRequests,
} from "../config/settings";
import { usesCursorRuleDelivery } from "../cursor";
import { RawSseDebugBuffer } from "../debug/raw-sse-buffer";
import { loadCapability } from "../discovery";
import { clearClaudePluginRootsCache } from "../discovery/helpers";
import { normalizeDiff, ParseError } from "../edit/diff";
import { getFileSnapshotStore } from "../edit/file-snapshot-store";
import { previewPatch } from "../edit/modes/patch";
import { normalizeToLF, stripBom } from "../edit/normalize";
import { executePython as executePythonCommand, type PythonResult } from "../eval/py/executor";
import { namespaceSessionId as namespacePythonSessionId } from "../eval/py/session-namespace";
import { defaultEvalSessionId } from "../eval/session-id";
import { type BashResult, executeBash as executeBashCommand } from "../exec/bash-executor";
import type { TtsrManager, TtsrMatchContext } from "../export/ttsr";
import type { LoadedCustomCommand } from "../extensibility/custom-commands";
import type { CustomTool, CustomToolContext } from "../extensibility/custom-tools/types";
import { CustomToolAdapter } from "../extensibility/custom-tools/wrapper";
import type {
	ExtensionCommandContext,
	ExtensionRunner,
	ExtensionUIContext,
	MessageEndEvent,
	MessageStartEvent,
	MessageUpdateEvent,
	SessionBeforeBranchResult,
	SessionBeforeCompactResult,
	SessionBeforeSwitchResult,
	SessionBeforeTreeResult,
	SessionStopEventResult,
	ToolExecutionEndEvent,
	ToolExecutionStartEvent,
	ToolExecutionUpdateEvent,
	TreePreparation,
	TurnEndEvent,
	TurnStartEvent,
} from "../extensibility/extensions";
import { createExtensionModelQuery } from "../extensibility/extensions/model-api";
import type { CompactOptions, ContextUsage } from "../extensibility/extensions/types";
import { ExtensionToolWrapper } from "../extensibility/extensions/wrapper";
import type { HookCommandContext } from "../extensibility/hooks/types";
import type { RecoveredRetryError } from "../extensibility/shared-events";
import type { Skill } from "../extensibility/skills";
import { expandSlashCommand, type FileSlashCommand } from "../extensibility/slash-commands";
import { GoalRuntime } from "../goals/runtime";
import type { Goal, GoalAbortReason, GoalModeState } from "../goals/state";
import type { HindsightSessionState } from "../hindsight/state";
import {
	type LocalProtocolOptions,
	listLocalPlanFileUrls,
	resolveLocalUrlToPath,
} from "../internal-urls/local-protocol";
import {
	IrcBus,
	type IrcMessage,
	type IrcPersistedDeliveryFacts,
	type IrcPersistedDeliveryTelemetry,
	projectIrcDeliveryTelemetry,
} from "../irc/bus";
import { resolveMemoryBackend } from "../memory-backend";
import { shutdownMnemopiEmbedClient } from "../mnemopi/embed-client";
import { getMnemopiSessionState, type MnemopiSessionState, setMnemopiSessionState } from "../mnemopi/state";
import { containsOrchestrate, ORCHESTRATE_NOTICE } from "../modes/orchestrate-keyword";
import type { RetryRecoveryMode } from "../modes/retry-display";
import { theme } from "../modes/theme/theme-binding";
import { containsUltrathink, ULTRATHINK_NOTICE } from "../modes/ultrathink-keyword";
import { containsWorkflow, renderWorkflowNotice } from "../modes/workflow-keyword";
import { resolveApprovedPlan } from "../plan-mode/approved-plan";
import { DEFAULT_PLAN_FILE_URL } from "../plan-mode/plan-file-url";
import { resolvePlanFilePath } from "../plan-mode/plan-path";
import { createPlanReadMatcher } from "../plan-mode/plan-protection";
import type { PlanModeState } from "../plan-mode/state";
import { advisorPrompts } from "../prompts/advisor/rows";
import { goalsPrompts } from "../prompts/goals/rows";
import { planModePrompts } from "../prompts/plan-mode/rows";
import { rulesPrompts } from "../prompts/rules/rows";
import { sessionPrompts } from "../prompts/session/rows";
import { sideChannelPrompts } from "../prompts/side-channel/rows";
import { steeringPrompts } from "../prompts/steering/rows";
import { turnControlPrompts } from "../prompts/turn-control/rows";
import { AgentLifecycleManager } from "../registry/agent-lifecycle";
import { AgentRegistry } from "../registry/agent-registry";
import { noteSecretsCondition } from "../secrets/notices";
import {
	mapAgentMessageStrings,
	mapAssistantContentStrings,
	obfuscateMessages,
	obfuscateProviderContext,
	type SecretObfuscator,
} from "../secrets/obfuscator";
import { PENDING_PLACEHOLDER_RE } from "../secrets/placeholder";
import {
	parseSlashCommand,
	unknownSlashCommandMessage,
	unresolvedSlashCommandName,
} from "../slash-commands/helpers/parse";
import { invalidateHostMetadata } from "../ssh/connection-manager";
import { usesCodexTaskPrompt } from "../task/prompt-policy";
import { enabledSubagentNames, preferredSubagentName, resolveDelegation } from "../task/subagent-settings";
import {
	AUTO_THINKING,
	type ConfiguredThinkingLevel,
	clampAutoThinkingEffort,
	concreteThinkingLevel,
	configuredThinkingLevelsForModel,
	parseConfiguredThinkingLevel,
	resolveProvisionalAutoLevel,
	resolveThinkingLevelForModel,
	shouldDisableReasoning,
	toReasoningEffort,
} from "../thinking";
import { formatTitleConversationContext, type TitleConversationTurn } from "../tiny/message-preproc";
import { shutdownTinyTitleClient } from "../tiny/title-client";
import { countToolsForAutoDiscovery, resolveEffectiveToolDiscoveryMode } from "../tool-discovery/mode";
import {
	buildDiscoverableToolSearchIndex,
	collectDiscoverableTools,
	type DiscoverableTool,
	type DiscoverableToolSearchIndex,
	filterBySource,
	isMCPToolName,
	selectDiscoverableToolNamesByServer,
} from "../tool-discovery/tool-index";
import {
	resolveEffectiveApprovalMode,
	validateApprovalModeSetting,
	validateApprovalPolicySettings,
} from "../tools/approval";
import type { ApprovalMode, SessionToolApprovals } from "../tools/approval-modes";
import { assertEditableFile } from "../tools/auto-generated-guard";
import { normalizeToolNames, TOOL } from "../tools/builtin-names";
import type { CheckpointState, CompletedRewindState } from "../tools/checkpoint";
import { reportLostOutputArtifact } from "../tools/output-artifact";
import { outputMeta, wrapToolWithMetaNotice } from "../tools/output-meta";
import { normalizeLocalScheme, resolveToCwd } from "../tools/path-utils";
import { shortenPath } from "../tools/render-utils";
import { isAutoQaEnabled } from "../tools/report-tool-issue";
import { buildResolveReminderMessage, type ResolveToolDetails, runResolveInvocation } from "../tools/resolve";
import {
	boundedTodoPreviewText,
	getLatestTodoPhasesFromEntries,
	prioritizeTodoItems,
	TODO_ITEM_PREVIEW_WIDTH,
	type TodoItem,
	type TodoPhase,
	USER_TODO_EDIT_CUSTOM_TYPE,
} from "../tools/todo";
import { ToolAbortError, ToolError } from "../tools/tool-errors";
import { clampTimeout } from "../tools/tool-timeouts";
import { parseCommandArgs } from "../utils/command-args";
import { type EditMode, resolveEditMode } from "../utils/edit-mode";
import { resolveFileDisplayMode } from "../utils/file-display-mode";
import { extractFileMentions, generateFileMentionMessages } from "../utils/file-mentions";
import { normalizeModelContextImages } from "../utils/image-loading";
import { describeAttachedImagesForTextModel } from "../utils/image-vision-fallback";
import { formatLocalCalendarDate } from "../utils/local-date";
import { normalizePromptPath } from "../utils/prompt-path";
import { generateSessionTitle } from "../utils/title-generator";
import { buildNamedToolChoice, isToolChoiceActive } from "../utils/tool-choice";
import type { VibeModeState } from "../vibe/state";
import {
	buildSessionMetadata,
	checkpointStartedAtFromEntry,
	compactionDeadEndWarning,
	completedRewindFromEntry,
	createCodexCompactionContext,
	createHandoffContext,
	createHandoffFileName,
	declaredContextWindow,
	dedupeEphemeralReply,
	extractPermissionLocations,
	formatRetryFallbackBaseSelector,
	formatRetryFallbackSelector,
	getPermissionIntent,
	getStringProperty,
	hasNonWhitespace,
	IMAGE_ATTACHMENT_DESCRIPTION_TYPE,
	isAdvisorCard,
	isDisplayableQueuedMessage,
	isHiddenUserCompanion,
	isRetryFallbackModelKey,
	isRetryFallbackWildcardKey,
	isSuccessfulCheckpointEntry,
	isTerminalTextAssistantAnswer,
	isToolOrderPermutation,
	isUserQueuedMessage,
	mergeLlmCompactionPreserveData,
	obfuscateProviderPayload,
	parseRetryFallbackSelector,
	queueChipText,
	type RestoredQueuedMessage,
	type RetryFallbackSelector,
	rebuildsThePrompt,
	sanitizeAssistantForReparentedHistory,
	titleConversationTurnFromMessage,
	toolCallOpFromMessage,
	toRestoredQueuedMessage,
} from "./agent-session-helpers";
import type { ClientBridge, ClientBridgePermissionOption, ClientBridgePermissionOutcome } from "./client-bridge";
import {
	type CodexAutoRedeemRedeemDecision,
	defaultCodexAutoRedeemCoordinator,
	evaluateCodexAutoRedeem,
	shouldEvaluateCodexAutoRedeem,
	shouldPromptCodexAutoRedeem,
} from "./codex-auto-reset";
import { findCompactMode } from "./compact-modes";
import { contentText } from "./content-text";
import {
	buildContextSnapshot,
	computeNonMessageBreakdown,
	computeNonMessageTokens,
	computeStoredMessagesTokens,
	estimateContextSnapshotAttribution,
} from "./context-usage";
import { initSessionCpuLimit, rekeySessionCpuLimit, sessionCpuLimit } from "./cpu-limit";
import { abortDetached } from "./detached-abort";
import {
	collectPendingToolCalls,
	createInterruptedTurnAbortMessage,
	SESSION_EXIT_CUSTOM_TYPE,
	type SessionExitData,
	sessionExitLogLevel,
	summarizeToolArguments,
	TOOL_EXECUTION_START_CUSTOM_TYPE,
	type ToolExecutionStartData,
} from "./exit-diagnostics";
import {
	type BashExecutionMessage,
	type CustomMessage,
	type CustomMessagePayload,
	convertToLlm,
	demoteInterruptedThinking,
	type FileMentionMessage,
	type HookMessage,
	INTERRUPTED_THINKING_MESSAGE_TYPE,
	type InterruptedThinkingDetails,
	isEmptyErrorTurn,
	isUserInterruptAbort,
	normalizeCustomMessagePayload,
	type PythonExecutionMessage,
	replaceLostBlobPayloads,
	SILENT_ABORT_MARKER,
	SKILL_PROMPT_MESSAGE_TYPE,
	stripImagesFromMessage,
	USER_INTERRUPT_LABEL,
} from "./messages";
import { OperatorNotices, stderrNoticeSink } from "./operator-notices";
import { disposeOwnedResources } from "./owned-resources";
import { ProviderContextCanonicalizer } from "./provider-context-canonicalizer";
import { applyProviderImagePolicy } from "./provider-image-budget";
import { normalizeRoots } from "./relativize-paths";
import {
	calculateRetryBackoffDelayMs,
	describeRetryPolicySource,
	type ResolvedRetryPolicy,
	resolveRetryPolicy,
	unreplayableContinueDelayMs,
} from "./retry-policy";
import type { BuildSessionContextOptions, SessionContext } from "./session-context";
import { getLatestCompactionEntry, getRestorableSessionModels } from "./session-context";
import { formatSessionDumpText } from "./session-dump-format";
import type {
	BranchSummaryEntry,
	CompactionEntry,
	NewSessionOptions,
	SessionEntry,
	SessionTitleSource,
} from "./session-entries";
import { EPHEMERAL_MODEL_CHANGE_ROLE } from "./session-entries";
import { formatSessionHistoryMarkdown } from "./session-history-format";
import { cleanupEmptyMoveSession, type SessionManager } from "./session-manager";
import { isAwaitingUserAnswer, mayContinueAtSettle, type SettleContinuationState } from "./settle-continuation";
import type { ShakeMode, ShakeResult } from "./shake-types";
import type { SideCompleteImpl } from "./side-complete";
import { incompleteTodoItems, renderTodoContinuationReminder, todoReminderFingerprint } from "./todo-reminder";
import { ToolChoiceQueue } from "./tool-choice-queue";
import { parseTurnBudgetDirective } from "./turn-budget";
import { planTurnPersistence, sameMessageContent, sessionMessagePersistenceKey } from "./turn-persistence";
import { classifyUnexpectedStop, isUnexpectedStopCandidate } from "./unexpected-stop-classifier";
import {
	CODE_REVIEW_REMINDER_TYPE,
	VERIFICATION_EVIDENCE_REMINDER_TYPE,
	VerificationEvidenceLedger,
} from "./verification-evidence-ledger";
import { YieldQueue } from "./yield-queue";

export type { RestoredQueuedMessage } from "./agent-session-helpers";
export { obfuscateProviderPayload, TOOL_SHAPE_SETTING_PATHS } from "./agent-session-helpers";

const SESSION_STOP_CONTINUATION_CAP = 8;
const PLAN_MODE_REMINDER_MAX = 3;
const PLAN_DECISION_TOOLS = new Set<string>([TOOL.ask, TOOL.resolve]);

const MID_RUN_TODO_NUDGE_MUTATION_THRESHOLD = 12;

const MID_RUN_TODO_NUDGE_MAX_PER_CYCLE = 2;

const MID_RUN_TODO_NUDGE_MUTATING_TOOLS: Record<string, true> = {
	bash: true,
	eval: true,
	edit: true,
	write: true,
	ast_edit: true,
};

interface PendingContextSnapshot {
	promptTokens: number;
	nonMessageTokens: number;

	cutoffCount: number;

	submitted: ReadonlySet<AgentMessage>;
	detail: SessionTelemetryDetail;
	storedMessagesTokens?: number;
	tailTokens?: number;
	compactionEntryId?: string;
}

const MID_RUN_TODO_NUDGE_MESSAGE_TYPE = "mid-run-todo-nudge";

const MEMORY_CONTEXT_MESSAGE_TYPE = "memory-context";

const SESSION_STATE_MESSAGE_TYPE = "session-state";

const PREWALK_PLAN_MESSAGE_TYPE = "prewalk-plan";

const PREWALK_CONTINUE_MESSAGE_TYPE = "prewalk-continue";

const PREWALK_CHECKLIST_MESSAGE_TYPE = "prewalk-checklist";

const PREWALK_ACTION_TOOLS: Record<string, true> = {
	edit: true,
	write: true,
};

const PLAN_YOLO_HANDOFF_MESSAGE_TYPE = "plan-yolo-handoff";

const GEMINI_HEADER_INTERRUPT_REASON = "Interrupted: emit a tool call instead of more planning";

const GEMINI_TOOL_REMINDER_TYPE = "gemini-tool-call-reminder";

const THINKING_LOOP_REDIRECT_TYPE = "thinking-loop-redirect";
const TOOL_CALL_LOOP_REDIRECT_TYPE = "tool-call-loop-redirect";

export type AgentSessionEvent =
	| AgentEvent
	| {
			type: "auto_compaction_start";
			reason: "threshold" | "overflow" | "idle" | "incomplete";
			action: CompactionEngineAction;
	  }
	| {
			type: "auto_compaction_end";
			action: CompactionEngineAction;
			result: CompactionResult | undefined;
			aborted: boolean;
			willRetry: boolean;
			errorMessage?: string;

			skipped?: boolean;
	  }
	| {
			type: "auto_retry_start";
			attempt: number;
			maxAttempts: number;
			delayMs: number;
			errorMessage: string;
			errorId?: number;

			policySource?: string;

			mode?: RetryRecoveryMode;
	  }
	| {
			type: "auto_retry_end";
			success: boolean;
			attempt: number;
			finalError?: string;
			mode?: RetryRecoveryMode;
			recoveredErrors?: RecoveredRetryError[];
	  }
	| { type: "retry_fallback_applied"; from: string; to: string; role: string }
	| { type: "retry_fallback_succeeded"; model: string; role: string }
	| { type: "ttsr_triggered"; rules: Rule[] }
	| { type: "todo_reminder"; todos: TodoItem[]; attempt: number; maxAttempts: number }
	| { type: "todo_auto_clear" }
	| { type: "irc_message"; message: CustomMessage }
	| { type: "notice"; level: "info" | "warning" | "error"; message: string; source?: string }
	| {
			type: "thinking_level_changed";
			thinkingLevel: ThinkingLevel | undefined;

			configured?: ConfiguredThinkingLevel;

			resolved?: Effort;
	  }
	| { type: "goal_updated"; goal: Goal | null; state?: GoalModeState }
	| { type: "cwd_changed"; previous: string; cwd: string };
export type AgentSessionEventListener = (event: AgentSessionEvent) => void;

const UNEXPECTED_STOP_MAX_RETRIES = 3;
const UNEXPECTED_STOP_TIMEOUT_MS = 4000;
const EMPTY_STOP_MAX_RETRIES = 3;
export const SHUTDOWN_CONSOLIDATE_BUDGET_MS = 1_500;

export interface AgentSessionDisposeOptions {
	mnemopiConsolidateTimeoutMs?: number;

	reason?: postmortem.Reason;
}

type CompactionCheckResult = Readonly<{
	continuationScheduled: boolean;
	automaticContinuationBlocked?: boolean;
	historyRewritten?: boolean;
}>;

const COMPACTION_CHECK_NONE: CompactionCheckResult = {
	continuationScheduled: false,
};
const COMPACTION_CHECK_CONTINUATION: CompactionCheckResult = {
	continuationScheduled: true,
};
const COMPACTION_CHECK_BLOCK_AUTOMATIC_CONTINUATION: CompactionCheckResult = {
	continuationScheduled: false,
	automaticContinuationBlocked: true,
};

const PRUNE_CACHE_WARM_SUFFIX_TOKENS = 8_000;

const PRUNE_IDLE_FLUSH_MS = 90 * 60_000;

const SHUTDOWN_DISPOSE_TIMEOUT_MS = 5_000;
export type CommandMetadataChangedListener = () => void | Promise<void>;
export type AsyncJobSnapshotItem = Pick<AsyncJob, "id" | "type" | "status" | "label" | "startTime">;

const COMPACTION_RECOVERY_BAND = 0.8;

const SIBLING_UNBLOCK_BUFFER_MS = 1_000;

export interface AsyncJobSnapshot {
	running: AsyncJobSnapshotItem[];
	recent: AsyncJobSnapshotItem[];
	delivery: AsyncJobDeliveryState;
}

export interface AsyncResultEntry {
	jobId: string;
	result: string;
	job: AsyncJob | undefined;
	durationMs: number | undefined;
}

export type { ShakeMode, ShakeResult };
export interface Prewalk {
	target: Model;
	thinkingLevel?: ConfiguredThinkingLevel;
}

export interface PlanYolo {
	target: Model;
	thinkingLevel?: ConfiguredThinkingLevel;
}

export interface SecretRuntimeLease {
	readonly revision: number;
	readonly cwd: string;

	readonly expansionObfuscator: SecretObfuscator | undefined;

	readonly redactionObfuscator: SecretObfuscator | undefined;

	readonly hasRedactions: boolean;
	obfuscateText(text: string): string;
	obfuscateMessages(messages: Message[]): Message[];
	obfuscateContext(context: Context): Context;
	obfuscatePayload(payload: unknown): unknown;

	isFreshForExpansion(text?: string): boolean;

	ensureFreshForExpansion(text?: string): Promise<void>;

	assertFreshForExpansion(text?: string): void;
}

export interface ProjectAdvisorScope {
	advisorWatchdogPrompt?: string;
	advisorContextPrompt?: string;
	advisorSharedInstructions?: string;
	advisorConfigs?: AdvisorConfig[];
}

export interface AgentSessionConfig {
	agent: Agent;
	sessionManager: SessionManager;
	settings: Settings;

	autoApprove?: boolean;

	bypassAllApprovals?: boolean;

	parentApprovalBypassed?: () => boolean;

	scopedModels?: Array<{
		model: Model;
		thinkingLevel?: ConfiguredThinkingLevel;

		explicitThinkingLevel?: boolean;
	}>;

	thinkingLevel?: ConfiguredThinkingLevel;

	thinkingSource?: EffortSource;

	prewalk?: Prewalk;

	planYolo?: PlanYolo;

	serviceTierByFamily?: ServiceTierByFamily;

	promptTemplates?: PromptTemplate[];

	slashCommands?: FileSlashCommand[];

	extensionRunner?: ExtensionRunner;

	skills?: Skill[];

	operatorNotices?: OperatorNotices;

	customCommands?: LoadedCustomCommand[];
	skillsSettings?: SkillsSettings;

	modelRegistry: ModelRegistry;

	toolRegistry?: Map<string, AgentTool>;

	createVibeTools?: () => AgentTool[];

	builtInToolNames?: Iterable<string>;

	setActiveToolNames?: (names: Iterable<string>) => void;

	transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => AgentMessage[] | Promise<AgentMessage[]>;

	transformProviderContext?: (
		context: Context,
		model: Model,
		runtime?: SecretRuntimeLease,
	) => Context | Promise<Context>;

	sideStreamFn?: StreamFn;

	advisorStreamFn?: StreamFn;

	preferWebsockets?: boolean;

	onPayload?: SimpleStreamOptions["onPayload"];

	onResponse?: SimpleStreamOptions["onResponse"];

	onSseEvent?: SimpleStreamOptions["onSseEvent"];

	rawSseDebugBuffer?: RawSseDebugBuffer;

	convertToLlm?: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;

	rebuildSystemPrompt?: (toolNames: string[], tools: Map<string, AgentTool>) => Promise<{ systemPrompt: string[] }>;

	getLocalCalendarDate?: () => string;

	reloadSshTool?: () => Promise<AgentTool | null>;
	requestedToolNames?: ReadonlySet<string>;

	getMcpServerInstructions?: () => Map<string, string> | undefined;

	mcpDiscoveryEnabled?: boolean;

	initialSelectedMCPToolNames?: string[];

	persistInitialMCPToolSelection?: boolean;

	defaultSelectedMCPServerNames?: string[];

	defaultSelectedMCPToolNames?: string[];

	ttsrManager?: TtsrManager;

	obfuscator?: SecretObfuscator;

	secretRuntime?: SecretRuntimeLease;

	leaseSecretRuntime?: () => Promise<SecretRuntimeLease>;

	resolveSecretRuntimeLeaseForContext?: (context: Context) => SecretRuntimeLease | undefined;

	refreshSecretRuntime?: (cwd: string) => Promise<SecretRuntimeLease | SecretObfuscator | undefined>;

	argot?: ArgotSession;

	parentEvalSessionId?: string;

	evalKernelOwnerId?: string;

	ownedAsyncJobManager?: AsyncJobManager;

	isSubagent?: boolean;

	asyncJobManager?: AsyncJobManager;

	agentId?: string;

	agentKind?: "main" | "sub";

	providerSessionId?: string;

	providerPromptCacheKeySource?: "explicit" | "fork";

	advisorTools?: AgentTool[];

	advisorWatchdogPrompt?: string;

	advisorSharedInstructions?: string;

	advisorContextPrompt?: string;

	advisorConfigs?: AdvisorConfig[];

	pruneToolDescriptions?: boolean | ((model: Model) => boolean);

	disconnectOwnedMcpManager?: () => Promise<void>;

	titleSystemPrompt?: string;
}

export interface PromptOptions {
	expandPromptTemplates?: boolean;

	images?: ImageContent[];

	streamingBehavior?: "steer" | "followUp";

	toolChoice?: ToolChoice;

	synthetic?: boolean;

	userInitiated?: boolean;

	attribution?: MessageAttribution;

	skipCompactionCheck?: boolean;
}

export interface FollowUpOptions {
	synthetic?: boolean;

	expandPromptTemplates?: boolean;

	attribution?: MessageAttribution;
}

export interface HandoffResult {
	document: string;
	savedPath?: string;
}

export interface SessionHandoffOptions {
	autoTriggered?: boolean;
	signal?: AbortSignal;
	onSwitchCancelled?: () => void;
}

export interface ModelCycleResult {
	model: Model;
	thinkingLevel: ThinkingLevel | undefined;

	isScoped: boolean;
}

export interface RoleModelCycleResult {
	model: Model;
	thinkingLevel: ThinkingLevel | undefined;
	role: string;
}

export interface ResolvedRoleModel {
	role: string;
	model: Model;
	thinkingLevel?: ConfiguredThinkingLevel;
	explicitThinkingLevel: boolean;
}

export interface RoleModelCycle {
	models: ResolvedRoleModel[];
	currentIndex: number;
}

export interface ContextUsageBreakdown {
	contextWindow: number;
	anchored: boolean;
	usedTokens: number;
	systemPromptTokens: number;
	systemToolsTokens: number;
	systemContextTokens: number;
	skillsTokens: number;
	messagesTokens: number;
	pendingMessagesTokens: number;
}

export interface SessionStats {
	sessionFile: string | undefined;
	sessionId: string;
	userMessages: number;
	assistantMessages: number;
	toolCalls: number;
	toolResults: number;
	totalMessages: number;
	tokens: {
		input: number;
		output: number;
		reasoning: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
	premiumRequests: number;
	cost: number;
	contextUsage?: ContextUsage;
}

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

	advisors: PerAdvisorStat[];
}

export interface PerAdvisorStat {
	name: string;
	model: Model;
	contextWindow: number;
	contextTokens: number;
	tokens: AdvisorStats["tokens"];
	cost: number;
	messages: AdvisorStats["messages"];
}

interface ActiveAdvisor {
	name: string;

	slug: string;
	agent: Agent;
	runtime: AdvisorRuntime;
	adviseTool: AdviseTool;
	emissionGuard: AdvisorEmissionGuard;
	recorder: AdvisorTranscriptRecorder;

	recorderClosed: Promise<void>;

	agentUnsubscribe?: () => void;
	model: Model;
	thinkingLevel: ThinkingLevel;

	signature: string;
}

interface AdvisorRuntimeDescriptor {
	config: AdvisorConfig;
	name: string;
	slug: string;
	model: Model;
	thinkingLevel: ThinkingLevel;
	signature: string;
}

export interface FreshSessionResult {
	previousSessionId: string;
	sessionId: string;
	closedProviderSessions: number;
}

type RetryFallbackChains = Record<string, string[]>;

type RetryFallbackRevertPolicy = "never" | "cooldown-expiry";

interface ActiveRetryFallbackState {
	role: string;
	originalSelector: string;
	originalThinkingLevel: ConfiguredThinkingLevel | undefined;
	lastAppliedFallbackThinkingLevel: ConfiguredThinkingLevel | undefined;
	pinned: boolean;
}

const noOpUIContext: ExtensionUIContext = {
	select: async (_title, _options, _dialogOptions) => undefined,
	confirm: async (_title, _message, _dialogOptions) => false,
	input: async (_title, _placeholder, _dialogOptions) => undefined,
	notify: () => {},
	onTerminalInput: () => () => {},
	setStatus: () => {},
	setWorkingMessage: () => {},
	setWidget: () => {},
	setTitle: () => {},
	custom: async () => undefined as never,
	setEditorText: () => {},
	pasteToEditor: () => {},
	getEditorText: () => "",
	editor: async () => undefined,
	addAutocompleteProvider: () => {},
	get theme() {
		return theme;
	},
	getAllThemes: () => Promise.resolve([]),
	getTheme: () => Promise.resolve(undefined),
	setTheme: _theme => Promise.resolve({ success: false, error: "UI not available" }),
	setFooter: () => {},
	setHeader: () => {},
	setEditorComponent: () => {},
	getToolsExpanded: () => false,
	setToolsExpanded: () => {},
};

const PERMISSION_REQUIRED_TOOLS = new Set([TOOL.bash, TOOL.edit, "delete", "move"]);

const PERMISSION_OPTIONS: ClientBridgePermissionOption[] = [
	{ optionId: "allow_once", name: "Allow once", kind: "allow_once" },
	{ optionId: "allow_always", name: "Always allow", kind: "allow_always" },
	{ optionId: "reject_once", name: "Reject", kind: "reject_once" },
	{ optionId: "reject_always", name: "Always reject", kind: "reject_always" },
];

const PERMISSION_OPTIONS_BY_ID = new Map(PERMISSION_OPTIONS.map(option => [option.optionId, option]));

type MessageEndPersistenceSlot = {
	readonly promise: Promise<void>;
	persist: (persistMessage: () => void) => Promise<void>;
	release: () => void;
};
type PendingRecoveredRetryError = {
	entryId: string;
	persistenceKey: string;
	recovery: AssistantRetryRecoveryKind;
	attempt: number;
	note: string;
};

type PostPromptSkipReason = "aborted" | "stale-generation";

type AgentContinueSkipReason =
	| PostPromptSkipReason
	| "session-unavailable"
	| "should-continue-false"
	| "post-restore-unavailable";

type ScheduledAgentContinueOptions = {
	delayMs?: number;
	generation?: number;
	shouldContinue?: () => boolean;
	onSkip?: (reason: AgentContinueSkipReason) => void;
	onError?: () => void;
};

const REPLAN_TITLE_CONTEXT_TURN_LIMIT = 6;

type SessionNameTrigger = "replan";
type SetSessionNameWithTrigger = (
	name: string,
	source?: SessionTitleSource,
	trigger?: SessionNameTrigger,
) => Promise<boolean>;

export class AgentSession {
	readonly agent: Agent;
	readonly sessionManager: SessionManager;
	readonly settings: Settings;
	readonly yieldQueue: YieldQueue;
	fileSnapshotStore?: InMemorySnapshotStore;
	#autoApprove: boolean;

	#approvalBypassActive = false;

	readonly #parentApprovalBypassed?: () => boolean;

	readonly #sessionToolApprovals = new Map<string, "allow" | "deny">();

	#compactionClampNoticeWindow: number | undefined = undefined;

	#powerAssertion: MacOSPowerAssertion | undefined;

	readonly configWarnings: string[] = [];

	#scopedModels: Array<{
		model: Model;
		thinkingLevel?: ConfiguredThinkingLevel;
		explicitThinkingLevel?: boolean;
	}>;

	#thinkingLevel: ThinkingLevel | undefined;

	#sessionThinkingOverride: ConfiguredThinkingLevel | undefined;

	#activeSelectorThinkingLevel: ConfiguredThinkingLevel | undefined;

	#autoThinking: boolean = false;

	#autoResolvedLevel: Effort | undefined;
	#prewalk: Prewalk | undefined;

	#prewalkPlanInjected = false;

	#prewalkTodoSeen = false;
	#planYolo: PlanYolo | undefined;
	#planYoloPreviousTools: string[] | undefined;
	#planYoloArmed = false;

	#promptTemplates: PromptTemplate[];
	#slashCommands: FileSlashCommand[];
	#unsubscribeAgent?: () => void;
	#cancelExitRecorder?: () => void;
	#exitRecorded = false;
	#unsubscribeAppendOnly?: () => void;
	#unsubscribeModelRoles?: () => void;
	#unsubscribePromptSettings?: () => void;
	#promptRefresh: Promise<void> = Promise.resolve();

	#startupHydration: Promise<void> = Promise.resolve();

	#lastAppendOnlyResolution?: { enable: boolean; providerId: string | undefined };
	#eventListeners: AgentSessionEventListener[] = [];
	#commandMetadataChangedListeners: CommandMetadataChangedListener[] = [];

	#pendingNextTurnMessages: CustomMessage[] = [];
	#scheduledHiddenNextTurnGeneration: number | undefined = undefined;
	#queuedMessageDrainScheduled = false;

	#advisorAutoResumeSuppressed = false;
	#advisorPrimaryTurnsCompleted = 0;
	#advisorInterruptImmuneTurnStart: number | undefined;
	#planModeState: PlanModeState | undefined;
	#vibeModeState: VibeModeState | undefined;
	#goalModeState: GoalModeState | undefined;
	#goalRuntime: GoalRuntime;
	#advisorEnabled = false;
	#advisorTools?: AgentTool[];
	#advisorWatchdogPrompt?: string;
	#advisorSharedInstructions?: string;
	#advisorContextPrompt?: string;
	#advisorYieldQueueUnsubscribe?: () => void;

	#advisors: ActiveAdvisor[] = [];

	#advisorConfigs?: AdvisorConfig[];

	#advisorProviderSessionIds = new Map<string, string>();

	#advisorRecorderClosed: Promise<void> = Promise.resolve();
	#goalTurnCounter = 0;
	#planReferenceSent = false;
	#planReferencePath: string = DEFAULT_PLAN_FILE_URL;
	#clientBridge: ClientBridge | undefined;
	#allowAcpAgentInitiatedTurns = false;

	#acpPermissionDecisions: Map<string, "allow_always" | "reject_always"> = new Map();

	#movedFromEmptySessionFile?: string;
	#compactionAbortController: AbortController | undefined = undefined;
	#autoCompactionAbortController: AbortController | undefined = undefined;
	#branchSummaryAbortController: AbortController | undefined = undefined;
	#handoffAbortController: AbortController | undefined = undefined;
	#skipPostTurnMaintenanceAssistantTimestamp: number | undefined = undefined;
	#retryAbortController: AbortController | undefined = undefined;
	#retryAttempt = 0;

	#unreplayableBatchContinues = 0;
	#retryPromise: Promise<void> | undefined = undefined;
	#retryResolve: (() => void) | undefined = undefined;
	#activeRetryFallback: ActiveRetryFallbackState | undefined = undefined;
	#pendingRecoveredRetryErrors: PendingRecoveredRetryError[] = [];
	#todoReminderCount = 0;

	#todoReminderAwaitingProgress = false;

	#lastTodoReminderFingerprint: string | undefined = undefined;

	#lastTodoFailureText: string | undefined = undefined;

	#todoReminderEchoCompactionId: string | null | undefined = undefined;

	#mutationsSinceLastTodoTouch = 0;

	#midRunNudgeCount = 0;
	#planModeReminderCount = 0;
	#planModeReminderAwaitingProgress = false;
	#todoPhases: TodoPhase[] = [];
	#replanTitleRefreshInFlight: Promise<void> | undefined = undefined;

	#titleSystemPrompt: string | undefined;
	#toolChoiceQueue = new ToolChoiceQueue();
	readonly #verificationEvidence = new VerificationEvidenceLedger();
	#bashAbortControllers = new Set<AbortController>();
	#pendingBashMessages: BashExecutionMessage[] = [];
	#evalAbortControllers = new Set<AbortController>();
	#evalKernelOwnerId: string;
	#parentEvalSessionId: string | undefined;

	readonly #ownedAsyncJobManager: AsyncJobManager | undefined;

	readonly #isSubagent: boolean;

	readonly #asyncJobManager: AsyncJobManager | undefined;
	#pendingPythonMessages: PythonExecutionMessage[] = [];
	#activeEvalExecutions = new Set<Promise<unknown>>();
	#evalExecutionDisposing = false;

	#pendingIrcInterrupts: CustomMessage[] = [];
	#pendingIrcAsides: CustomMessage[] = [];

	#agentId: string | undefined;
	#agentKind: "main" | "sub" = "main";
	#providerSessionId: string | undefined;
	#freshProviderSessionId: string | undefined;
	#inheritedProviderPromptCacheKey: string | undefined;
	#isDisposed = false;
	#extensionRunner: ExtensionRunner | undefined = undefined;
	#turnIndex = 0;
	#messageEndPersistenceTail: Promise<void> = Promise.resolve();
	#pendingMessageEndPersistence = new Map<string, Promise<void>>();
	#persistedMessageKeys: { anchor: string; keys: Set<string> } | undefined;

	#skills: Skill[];
	readonly #operatorNotices: OperatorNotices;
	#customCommands: LoadedCustomCommand[] = [];

	#mcpPromptCommands: LoadedCustomCommand[] = [];

	#skillsSettings: SkillsSettings | undefined;
	#modelRegistry: ModelRegistry;
	#toolRegistry: Map<string, AgentTool>;
	#createVibeTools: (() => AgentTool[]) | undefined;
	#installedVibeToolNames = new Set<string>();
	#transformContext: (messages: AgentMessage[], signal?: AbortSignal) => AgentMessage[] | Promise<AgentMessage[]>;
	#onPayload: SimpleStreamOptions["onPayload"] | undefined;
	#onResponse: SimpleStreamOptions["onResponse"] | undefined;
	#onSseEvent: SimpleStreamOptions["onSseEvent"] | undefined;
	#transformProviderContext:
		| ((context: Context, model: Model, runtime?: SecretRuntimeLease) => Context | Promise<Context>)
		| undefined;

	#toolCallIdMap = new Map<string, string>();
	#toolCallIdCounter = 0;

	#wirePathRoots: string[] = [];

	#lastRescopedCwd: string | undefined;

	#scopeTransitionTail: Promise<void> = Promise.resolve();
	#scopeTransitionRevision = 0;

	#wirePathBytesSaved = 0;
	#thoughtSignatureBytesSaved = 0;
	#sideStreamFn: StreamFn;

	#sideCompleteImpl = async <TApi extends Api>(
		model: Model<TApi>,
		ctx: Context,
		options: SimpleStreamOptions,
	): Promise<AssistantMessage> => {
		const stream = await this.#sideStreamFn(model, ctx, options);
		return stream.result();
	};

	get sideComplete(): SideCompleteImpl {
		return this.#sideCompleteImpl;
	}
	#advisorStreamFn: StreamFn | undefined;
	#preferWebsockets: boolean | undefined;
	#convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
	#rebuildSystemPrompt:
		| ((toolNames: string[], tools: Map<string, AgentTool>) => Promise<{ systemPrompt: string[] }>)
		| undefined;
	#getLocalCalendarDate: () => string;
	#getMcpServerInstructions: (() => Map<string, string> | undefined) | undefined;
	#reloadSshTool: (() => Promise<AgentTool | null>) | undefined;
	#setActiveToolNames: ((names: Iterable<string>) => void) | undefined;
	#disconnectOwnedMcpManager: (() => Promise<void>) | undefined;
	#requestedToolNames: ReadonlySet<string> | undefined;
	#baseSystemPrompt: string[];

	readonly #baseSystemPromptInvalidations: string[] = [];

	readonly #providerCacheKeyDiscards: string[] = [];

	#lastAppliedToolSignature: string | undefined;

	#promptModelKey: string | undefined;
	#mcpDiscoveryEnabled = false;
	#discoverableMCPTools = new Map<string, DiscoverableTool>();
	#selectedMCPToolNames = new Set<string>();

	#discoverableToolSearchIndex: DiscoverableToolSearchIndex | null = null;
	#selectedDiscoveredToolNames = new Set<string>();
	#builtInToolNames = new Set<string>();
	#rpcHostToolNames = new Set<string>();
	#defaultSelectedMCPServerNames = new Set<string>();
	#defaultSelectedMCPToolNames = new Set<string>();
	#sessionDefaultSelectedMCPToolNames = new Map<string, string[]>();

	#ttsrManager: TtsrManager | undefined = undefined;
	#pendingTtsrInjections: Rule[] = [];

	#perToolTtsrInjections = new Map<string, Rule[]>();

	#pendingTtsrToolReminders: { content: string; rules: string[] }[] = [];
	#ttsrAbortPending = false;
	#ttsrRetryToken = 0;
	#ttsrResumePromise: Promise<void> | undefined = undefined;
	#ttsrResumeResolve: (() => void) | undefined = undefined;

	#planInternalAbortPending = false;
	#pendingAbortErrorId?: number;

	#postPromptTasks = new Set<Promise<unknown>>();
	#postPromptTasksPromise: Promise<void> | undefined = undefined;
	#postPromptTasksResolve: (() => void) | undefined = undefined;
	#postPromptTasksAbortController = new AbortController();

	#streamingEditAbortTriggered = false;
	#streamingEditCheckedLineCounts = new Map<string, number>();

	#streamingEditPrecheckedToolCallIds = new Set<string>();

	#streamingEditFileCache = new Map<string, string>();

	#geminiHeaderDetector: GeminiHeaderRunDetector | undefined;
	#toolCallLoopGuard: ToolCallLoopGuard | undefined;
	#toolCallLoopGuardSettingsKey: string | undefined;
	#promptInFlightCount = 0;
	#abortInProgress = false;

	#emptyStopRetryCount = 0;

	#turnRetryReminders: AgentMessage[] = [];
	#unexpectedStopRetryCount = 0;
	#acceptTerminalEmptyStopForPrompt = false;
	#promptGeneration = 0;
	#pendingAgentEndEmit: AgentSessionEvent | undefined;
	#pendingContextSnapshot: PendingContextSnapshot | undefined = undefined;

	#historyRewriteAnchorBoundaryEntryId: string | undefined = undefined;
	#sessionStopContinuationCount = 0;
	#sessionStopHookActive = false;

	#contextUsageRevision = 0;
	#obfuscator: SecretObfuscator | undefined;
	#secretRuntime: SecretRuntimeLease | undefined;
	#leaseSecretRuntime: (() => Promise<SecretRuntimeLease>) | undefined;
	#resolveSecretRuntimeLeaseForContext: ((context: Context) => SecretRuntimeLease | undefined) | undefined;
	#refreshSecretRuntime: ((cwd: string) => Promise<SecretRuntimeLease | SecretObfuscator | undefined>) | undefined;

	#staleSecretRuntimeRefreshInFlight = false;
	#argot: ArgotSession | undefined;

	#argotStreamDisplay: ArgotStreamDisplayDecoder | undefined;

	#resolvePruneToolDescriptions: (model: Model) => boolean = () => false;
	#checkpointState: CheckpointState | undefined = undefined;
	#pendingRewindReport: string | undefined = undefined;
	#lastCompletedRewind: CompletedRewindState | undefined = undefined;
	#rewoundToolResultIds = new Set<string>();
	#lastSuccessfulYieldToolCallId: string | undefined = undefined;

	#yieldTerminationPending = false;
	#synchronouslyTerminatedYieldToolCallIds = new Set<string>();
	#providerSessionState = new Map<string, ProviderSessionState>();

	#announcedCompactionFallbacks = new Set<string>();

	#announcedServerCompactionFailures = new Set<string>();
	#hindsightSessionState: HindsightSessionState | undefined = undefined;
	readonly rawSseDebugBuffer: RawSseDebugBuffer;

	#resetPromptMaintenanceState(): void {
		this.#emptyStopRetryCount = 0;
		this.#dropTurnRetryReminders();
		this.#unexpectedStopRetryCount = 0;
		this.#yieldTerminationPending = false;
		this.#acceptTerminalEmptyStopForPrompt = false;

		this.#unreplayableBatchContinues = 0;
	}

	#acquirePowerAssertion(): void {
		if (process.platform !== "darwin") return;
		if (isBunTestRuntime()) return;
		if (this.#powerAssertion) return;
		const mode = this.settings.get("power.sleepPrevention");
		if (mode === "off") return;
		try {
			this.#powerAssertion = MacOSPowerAssertion.start({
				reason: "Veyyon agent session",
				idle: true,
				display: mode === "display" || mode === "system",
				system: mode === "system",
				user: mode === "system",
			});
		} catch (error) {
			logger.warn("Failed to acquire macOS power assertion", { error: errorMessage(error) });
		}
	}

	#releasePowerAssertion(): void {
		const assertion = this.#powerAssertion;
		this.#powerAssertion = undefined;
		if (!assertion) return;
		try {
			assertion.stop();
		} catch (error) {
			logger.warn("Failed to release macOS power assertion", { error: errorMessage(error) });
		}
	}

	#beginInFlight(): void {
		this.#promptInFlightCount++;
		if (this.#promptInFlightCount === 1) {
			this.#acquirePowerAssertion();
		}
	}

	#endInFlight(): void {
		this.#promptInFlightCount = Math.max(0, this.#promptInFlightCount - 1);
		if (this.#promptInFlightCount === 0) {
			this.#releasePowerAssertion();
			this.#flushPendingAgentEnd();
			this.#drainStrandedQueuedMessages();
			this.#clearAgentGrants();
		}
	}

	#drainStrandedQueuedMessages(): void {
		if (this.#abortInProgress) return;

		if (this.#advisorAutoResumeSuppressed && !this.isStreaming) {
			for (const card of this.#extractQueuedAdvisorCards()) {
				this.#preserveAdvisorCard(card);
			}
		}
		this.#scheduleQueuedMessageDrain();
		this.#resumeStrandedIrcAsides();
	}

	#resumeStrandedIrcAsides(): void {
		if (this.#isDisposed || this.isStreaming) return;
		if (this.#pendingIrcInterrupts.length === 0 && this.#pendingIrcAsides.length === 0) return;
		if (this.#canAutoContinueForFollowUp() && this.agent.hasQueuedMessages()) return;
		const records = this.#pendingIrcInterrupts.concat(this.#pendingIrcAsides);
		this.#pendingIrcInterrupts = [];
		this.#pendingIrcAsides = [];
		if (this.#planModeState?.enabled) {
			for (const record of records) {
				this.agent.appendMessage(record);
				this.sessionManager.appendCustomMessageEntry(
					record.customType,
					record.content,
					record.display,
					record.details,
					record.attribution ?? "agent",
				);
			}
			return;
		}
		this.#wakeForIrc(records);
	}

	#wakeForIrc(records: CustomMessage[]): void {
		const parkedFollowUps =
			this.agent.peekSteeringQueue().length === 0 &&
			this.agent.peekFollowUpQueue().length > 0 &&
			!this.#canAutoContinueForFollowUp()
				? this.agent.peekFollowUpQueue().slice()
				: [];
		if (parkedFollowUps.length > 0) {
			this.agent.replaceQueues(this.agent.peekSteeringQueue().slice(), []);
		}
		this.#resetPromptMaintenanceState();
		this.#beginInFlight();
		void this.agent
			.prompt(records)
			.catch(error => {
				logger.warn("IRC wake turn failed", { error: errorMessage(error) });
			})
			.finally(() => {
				if (parkedFollowUps.length > 0) {
					this.agent.replaceQueues(
						this.agent.peekSteeringQueue().slice(),
						parkedFollowUps.concat(this.agent.peekFollowUpQueue()),
					);
				}
				this.#endInFlight();
			});
	}

	#extractQueuedAdvisorCards(): CustomMessage[] {
		const steering = this.agent.peekSteeringQueue();
		const followUp = this.agent.peekFollowUpQueue();
		const cards = steering.concat(followUp).filter(isAdvisorCard);
		if (cards.length === 0) return [];
		this.agent.replaceQueues(
			steering.filter(m => !isAdvisorCard(m)),
			followUp.filter(m => !isAdvisorCard(m)),
		);
		return cards;
	}

	#preserveAdvisorCard(card: CustomMessage): void {
		if (this.#abortInProgress && this.isStreaming) {
			this.#pendingNextTurnMessages.push(card);
			return;
		}
		this.agent.emitExternalEvent({ type: "message_start", message: card });
		this.agent.emitExternalEvent({ type: "message_end", message: card });
	}

	#resetInFlight(): void {
		this.#promptInFlightCount = 0;
		this.#releasePowerAssertion();
		this.#flushPendingAgentEnd();
		this.#drainStrandedQueuedMessages();
		this.#clearAgentGrants();
	}

	#grantedAgents = new Set<string>();

	#grantAgentsForTurn(agents: readonly string[] | undefined): void {
		if (!agents?.length) return;
		for (const agent of agents) this.#grantedAgents.add(agent);
	}

	#clearAgentGrants(): void {
		this.#grantedAgents.clear();
	}

	agentGrantedThisTurn(agentName: string): boolean {
		return this.#grantedAgents.has(agentName);
	}

	#flushPendingAgentEnd(): void {
		const pending = this.#pendingAgentEndEmit;
		if (!pending) return;
		this.#pendingAgentEndEmit = undefined;
		this.#emit(pending);
	}

	async #advancePrewalk(liveMessages: AgentMessage[], context: AgentTurnEndContext | undefined): Promise<void> {
		const prewalk = this.#prewalk;
		if (!prewalk || context?.message.role !== "assistant") return;

		if (this.#prewalkPlanInjected && context.toolResults.length === 0) {
			this.agent.steer({
				role: "custom",
				customType: PREWALK_CONTINUE_MESSAGE_TYPE,
				content: turnControlPrompts["turn-control/prewalk-continue"].text,
				attribution: "agent",
				display: false,
				timestamp: Date.now(),
			});
		}

		if (context.toolResults.some(result => result.toolName === TOOL.todo)) {
			this.#prewalkTodoSeen = true;
		}
		const todoGateOpen = this.#prewalkTodoSeen || !this.#toolRegistry.has(TOOL.todo);
		const action = todoGateOpen
			? context.toolResults.find(result => PREWALK_ACTION_TOOLS[result.toolName])
			: undefined;
		if (!action) {
			if (!this.#prewalkPlanInjected) {
				this.#prewalkPlanInjected = true;
				this.agent.steer({
					role: "custom",
					customType: PREWALK_PLAN_MESSAGE_TYPE,
					content: turnControlPrompts["turn-control/prewalk-plan"].text,
					display: false,
					attribution: "agent",
					timestamp: Date.now(),
				});
				this.emitNotice("info", "Prewalk: injected deep-plan nudge.", "prewalk");
			}
			return;
		}

		await this.#waitForSessionMessagePersistence(context.message);
		for (const toolResult of context.toolResults) {
			await this.#waitForSessionMessagePersistence(toolResult);
		}

		this.#scrubPrewalkPlanNudge(liveMessages);
		const target = prewalk.target;
		if (this.model && modelsAreEqual(this.model, target)) {
			this.#prewalk = undefined;
			return;
		}

		await this.setModelTemporary(target, prewalk.thinkingLevel, { ephemeral: true });
		this.#prewalk = undefined;
		this.emitNotice(
			"info",
			`Prewalk: switched to ${target.provider}/${target.id} after first ${action.toolName} call.`,
			"prewalk",
		);
		this.agent.steer({
			role: "custom",
			customType: PREWALK_CHECKLIST_MESSAGE_TYPE,
			content: turnControlPrompts["turn-control/prewalk-checklist"].text,
			attribution: "agent",
			display: false,
			timestamp: Date.now(),
		});
	}

	armPrewalk(target: Model, thinkingLevel?: ConfiguredThinkingLevel): void {
		if (this.#prewalk) {
			this.emitNotice(
				"info",
				`Prewalk: already armed for ${this.#prewalk.target.provider}/${this.#prewalk.target.id}, waiting for the first edit/write.`,
				"prewalk",
			);
			return;
		}
		this.#prewalk = { target, thinkingLevel };
		this.#prewalkPlanInjected = true;
		this.agent.steer({
			role: "custom",
			customType: PREWALK_PLAN_MESSAGE_TYPE,
			content: turnControlPrompts["turn-control/prewalk-plan"].text,
			display: false,
			attribution: "agent",
			timestamp: Date.now(),
		});
		this.emitNotice(
			"info",
			`Prewalk: armed for ${target.provider}/${target.id} — will switch at the first edit/write once the todo list exists.`,
			"prewalk",
		);
	}

	#scrubPrewalkPlanNudge(liveMessages: AgentMessage[]): void {
		if (!this.#prewalkPlanInjected) return;
		const isPlanNudge = (m: AgentMessage): boolean =>
			m.role === "custom" && m.customType === PREWALK_PLAN_MESSAGE_TYPE;
		for (let i = liveMessages.length - 1; i >= 0; i--) {
			if (isPlanNudge(liveMessages[i])) liveMessages.splice(i, 1);
		}
		const stateMessages = this.agent.state.messages;
		const filtered = stateMessages.filter(m => !isPlanNudge(m));
		if (filtered.length !== stateMessages.length) this.agent.replaceMessages(filtered);
	}

	async #armPlanYoloIfNeeded(): Promise<void> {
		if (!this.#planYolo || this.#planYoloArmed) return;
		this.#planYoloArmed = true;
		const previousTools = this.getActiveToolNames();
		const augmentations: string[] = [TOOL.resolve];
		if (this.hasBuiltInTool(TOOL.write)) augmentations.push(TOOL.write);
		await this.setActiveToolsByName(Array.from(new Set(previousTools.concat(augmentations))));
		this.#planYoloPreviousTools = previousTools;
		this.setPlanModeState({
			enabled: true,
			planFilePath: this.getPlanReferencePath() || DEFAULT_PLAN_FILE_URL,
			workflow: "parallel",
		});
		this.setStandingResolveHandler(input => this.#runPlanYoloApprovalResolve(input));
	}

	#runPlanYoloApprovalResolve(input: unknown): Promise<AgentToolResult<ResolveToolDetails>> {
		return runResolveInvocation(input as Parameters<typeof runResolveInvocation>[0], {
			sourceToolName: "plan_approval",
			label: "Plan ready for approval",
			apply: async (_reason, extra) => {
				const planYolo = this.#planYolo;
				const state = this.getPlanModeState();
				if (!planYolo || !state?.enabled) {
					throw new ToolError("Plan mode is not active.");
				}
				const { planFilePath, title } = await resolveApprovedPlan({
					suppliedTitle: extra?.title,
					statePlanFilePath: state.planFilePath,
					readPlan: url => this.#readPlanYoloFile(url),
					listPlanFiles: () => this.#listPlanYoloFiles(),
				});
				const previousTools = this.#planYoloPreviousTools;
				if (previousTools) {
					await this.setActiveToolsByName(previousTools);
				}
				this.setStandingResolveHandler(null);
				this.setPlanModeState(undefined);
				this.#planYolo = undefined;
				this.#planYoloPreviousTools = undefined;
				await this.setModelTemporary(planYolo.target, planYolo.thinkingLevel, { ephemeral: true });
				this.emitNotice(
					"info",
					`Plan-yolo: plan approved, switched to ${planYolo.target.provider}/${planYolo.target.id} to implement "${title}".`,
					"plan-yolo",
				);
				this.agent.steer({
					role: "custom",
					customType: PLAN_YOLO_HANDOFF_MESSAGE_TYPE,
					content: prompt.render(planModePrompts["plan-mode/yolo-handoff"].text, { planFilePath, title }),
					attribution: "agent",
					display: false,
					timestamp: Date.now(),
				});
				return {
					content: [
						{ type: "text" as const, text: `Plan approved. Implementing now with ${planYolo.target.id}.` },
					],
					details: { planFilePath, title, planExists: true },
				};
			},
		});
	}

	async #readPlanYoloFile(planFilePath: string): Promise<string | null> {
		const resolvedPath = this.#resolvePlanPath(planFilePath);
		try {
			return await Bun.file(resolvedPath).text();
		} catch (error) {
			if (isEnoent(error)) return null;
			throw error;
		}
	}

	async #listPlanYoloFiles(): Promise<string[]> {
		return listLocalPlanFileUrls(resolveLocalUrlToPath("local://", this.#localProtocolOptions()));
	}

	constructor(config: AgentSessionConfig) {
		this.agent = config.agent;
		this.sessionManager = config.sessionManager;
		this.settings = config.settings;
		this.#lastRescopedCwd = path.resolve(config.sessionManager.getCwd());
		this.#autoApprove = config.autoApprove === true;
		this.#approvalBypassActive = config.bypassAllApprovals === true;
		this.#parentApprovalBypassed = config.parentApprovalBypassed;

		this.#evalKernelOwnerId = config.evalKernelOwnerId ?? `agent-session:${Snowflake.next()}`;
		this.#parentEvalSessionId = config.parentEvalSessionId;
		this.#ownedAsyncJobManager = config.ownedAsyncJobManager;
		this.#isSubagent = config.isSubagent === true;
		this.#asyncJobManager = config.asyncJobManager ?? config.ownedAsyncJobManager;
		this.#scopedModels = config.scopedModels ?? [];
		this.#sessionThinkingOverride = config.thinkingSource === "session" ? config.thinkingLevel : undefined;
		this.#activeSelectorThinkingLevel = config.thinkingSource === "selector" ? config.thinkingLevel : undefined;
		if (config.thinkingLevel === AUTO_THINKING) {
			this.#autoThinking = true;
			this.#thinkingLevel = resolveProvisionalAutoLevel(this.model);
		} else {
			this.#thinkingLevel = resolveThinkingLevelForModel(this.model, config.thinkingLevel);
		}
		if (config.prewalk) {
			this.#prewalk = config.prewalk;
		}
		if (config.planYolo) {
			this.#planYolo = config.planYolo;
		}
		this.#applyThinkingLevelToAgent(this.#thinkingLevel);

		this.#promptTemplates = config.promptTemplates ?? [];
		this.#slashCommands = config.slashCommands ?? [];
		this.#extensionRunner = config.extensionRunner;
		this.#skills = config.skills ?? [];
		this.#operatorNotices = config.operatorNotices ?? new OperatorNotices(stderrNoticeSink);

		let cpuLimitSessionId = this.sessionManager.getSessionId();
		if (cpuLimitSessionId) {
			void initSessionCpuLimit({
				sessionId: cpuLimitSessionId,
				cores: this.settings.get("session.cpuLimitCores"),
				kill: this.settings.get("session.cpuLimitKill"),
				onNotice: text => this.#operatorNotices.warn("cpu", text),
			}).catch(error => logger.warn("CPU limit init failed", { error: errorMessage(error) }));
		}

		this.sessionManager.onSessionIdChanged(nextSessionId => {
			if (!nextSessionId) return;
			const previous = cpuLimitSessionId;
			cpuLimitSessionId = nextSessionId;
			if (previous && rekeySessionCpuLimit(previous, nextSessionId)) return;
			void initSessionCpuLimit({
				sessionId: nextSessionId,
				cores: this.settings.get("session.cpuLimitCores"),
				kill: this.settings.get("session.cpuLimitKill"),
				onNotice: text => this.#operatorNotices.warn("cpu", text),
			}).catch(error => logger.warn("CPU limit re-init failed", { error: errorMessage(error) }));
		});
		this.#customCommands = config.customCommands ?? [];
		this.#skillsSettings = config.skillsSettings;
		this.#modelRegistry = config.modelRegistry;

		this.agent.serviceTierResolver = model => this.#effectiveServiceTier(model);

		this.agent.cacheEnforcement =
			this.settings.get("cache.reportRejection") === true
				? this.settings.get("cache.blockOnRejection") === true
					? "error"
					: "warn"
				: "off";
		this.#serviceTierByFamily = config.serviceTierByFamily ?? {};
		this.#advisorTools = config.advisorTools;
		this.#advisorWatchdogPrompt = config.advisorWatchdogPrompt;
		this.#advisorSharedInstructions = config.advisorSharedInstructions;
		this.#advisorContextPrompt = config.advisorContextPrompt;
		this.#advisorConfigs = config.advisorConfigs;
		this.#titleSystemPrompt = config.titleSystemPrompt;
		this.#resolvePruneToolDescriptions =
			typeof config.pruneToolDescriptions === "function"
				? config.pruneToolDescriptions
				: () => config.pruneToolDescriptions === true;
		this.#validateRetryFallbackChains();
		this.#validateApprovalModeSetting();
		this.#validateApprovalPolicySettings();
		this.#toolRegistry = config.toolRegistry ?? new Map();
		this.#createVibeTools = config.createVibeTools;
		this.#builtInToolNames = new Set(config.builtInToolNames ?? []);
		this.#requestedToolNames = config.requestedToolNames;
		this.#transformContext = config.transformContext ?? (messages => messages);

		const upstreamTransformProviderContext = config.transformProviderContext;

		this.#wirePathRoots = normalizeRoots(this.sessionManager.getCwd());
		const providerContextCanonicalizer = new ProviderContextCanonicalizer(this.#toolCallIdMap, () => {
			this.#toolCallIdCounter += 1;
			return `tc_${this.#toolCallIdCounter}`;
		});
		const canonicalizeProviderContext = (
			context: Context,
			model: Model,
			runtime?: SecretRuntimeLease,
		): Context | Promise<Context> => {
			const canonicalized = providerContextCanonicalizer.transform(context.messages, this.#wirePathRoots);
			this.#wirePathBytesSaved += canonicalized.bytesSaved;
			const messages = canonicalized.messages;

			const thoughtSignatureRetention = this.settings.get("context.thoughtSignatureRetention");
			const thoughtSignatureMaxLength = this.settings.get("context.thoughtSignatureMaxLength");
			const thinkingRetention = this.settings.get("context.thinkingRetention");

			this.#thoughtSignatureBytesSaved += elidedSignatureBytes(
				messages,
				signaturePolicy(messages, { thoughtSignatureRetention, thoughtSignatureMaxLength }),
				message => message.provider === model.provider && message.model === model.id,
			);
			const next =
				messages === context.messages &&
				thoughtSignatureRetention === context.thoughtSignatureRetention &&
				thoughtSignatureMaxLength === context.thoughtSignatureMaxLength &&
				thinkingRetention === context.thinkingRetention
					? context
					: {
							...context,
							messages,
							thoughtSignatureRetention,
							thoughtSignatureMaxLength,
							thinkingRetention,
						};

			const recovered = replaceLostBlobPayloads(next.messages);
			const carried = recovered === next.messages ? next : { ...next, messages: recovered };

			const shaped = applyProviderImagePolicy(carried, model, {
				blockImages: Boolean(this.settings.get("images.blockImages")),
			});
			if (upstreamTransformProviderContext) return upstreamTransformProviderContext(shaped, model, runtime);
			const fallbackRuntime = runtime ?? this.#secretRuntime;
			return fallbackRuntime
				? fallbackRuntime.obfuscateContext(shaped)
				: obfuscateProviderContext(this.#obfuscator, shaped);
		};
		this.#transformProviderContext = canonicalizeProviderContext;

		this.agent.setTransformProviderContext(canonicalizeProviderContext);
		this.#sideStreamFn = config.sideStreamFn ?? streamSimple;
		this.#advisorStreamFn = config.advisorStreamFn;
		this.#preferWebsockets = config.preferWebsockets;
		this.#onPayload = config.onPayload;
		this.rawSseDebugBuffer = config.rawSseDebugBuffer ?? new RawSseDebugBuffer();

		const configuredOnResponse = config.onResponse;
		this.#onResponse = configuredOnResponse
			? async (response, model) => {
					this.rawSseDebugBuffer.recordResponse(response, model);
					this.#ingestProviderUsageHeaders(response, model);
					await configuredOnResponse(response, model);
				}
			: (response, model) => {
					this.rawSseDebugBuffer.recordResponse(response, model);
					this.#ingestProviderUsageHeaders(response, model);
				};
		const configuredOnSseEvent = config.onSseEvent;
		this.#onSseEvent = configuredOnSseEvent
			? (event, model) => {
					this.rawSseDebugBuffer.recordEvent(event, model);
					configuredOnSseEvent(event, model);
				}
			: (event, model) => {
					this.rawSseDebugBuffer.recordEvent(event, model);
				};
		this.agent.setProviderResponseInterceptor(this.#onResponse);
		this.agent.setRawSseEventInterceptor(this.#onSseEvent);
		this.agent.setOnTurnEnd(async (messages, signal, context) => {
			if (signal?.aborted) return;
			const rewindReport = this.#extractRewindReport(messages);
			if (rewindReport) {
				this.#pendingRewindReport = undefined;
				await this.#applyRewind(rewindReport, messages);
			}
			if (context?.message.role === "assistant") {
				const detection = this.#activeToolCallLoopGuard()?.recordTurn({
					message: context.message,
					toolResults: context.toolResults,
				});
				if (detection) this.#maybeInjectToolCallLoopRedirect(messages, detection);
			}
			await this.#advancePrewalk(messages, context);
			this.#advisorPrimaryTurnsCompleted++;
			if (this.#advisors.length > 0) {
				for (const a of this.#advisors) {
					if (!a.runtime.disposed) a.runtime.onTurnEnd(messages, { willContinue: context?.willContinue });
				}
				const syncBacklog = this.settings.get("advisor.syncBacklog");
				if (syncBacklog !== "off") {
					const threshold = parseInt(syncBacklog, 10);

					await Promise.all(this.#advisors.map(a => a.runtime.waitForCatchup(30000, threshold, signal)));
				}
			}
			await this.#maintainContextMidRun(messages, signal, context);
		});
		this.yieldQueue = new YieldQueue({
			isStreaming: () => this.isStreaming,
			injectIdle: async messages => {
				const first = messages[0];
				if (!first) return;
				await this.agent.prompt(messages.length === 1 ? first : messages);
			},
			scheduleIdleFlush: run => {
				this.#schedulePostPromptTask(
					async () => {
						await run();
					},
					{ delayMs: 1 },
				);
			},
		});

		this.agent.hasIrcInterrupts = () => this.#pendingIrcInterrupts.length > 0;
		this.agent.setAsideMessageProvider(() => {
			const pendingIrc = this.#pendingIrcInterrupts.concat(this.#pendingIrcAsides);
			this.#pendingIrcInterrupts = [];
			this.#pendingIrcAsides = [];
			const thunks: AsideMessage[] = pendingIrc.map(record => () => record);
			thunks.push(...this.yieldQueue.drainLazy());

			thunks.push(() => this.#takeMidRunTodoNudge());

			thunks.push(() => this.#takePendingVolatileMemoryContext());

			thunks.push(() => this.#takePendingTtsrToolReminders());
			return thunks;
		});
		this.#convertToLlm = config.convertToLlm ?? convertToLlm;
		this.#rebuildSystemPrompt = config.rebuildSystemPrompt;
		this.#getLocalCalendarDate = config.getLocalCalendarDate ?? formatLocalCalendarDate;
		this.#getMcpServerInstructions = config.getMcpServerInstructions;
		this.#reloadSshTool = config.reloadSshTool;
		this.#setActiveToolNames = config.setActiveToolNames;
		this.#disconnectOwnedMcpManager = config.disconnectOwnedMcpManager;
		this.#baseSystemPrompt = this.agent.state.systemPrompt;
		this.#promptModelKey = this.#currentPromptModelKey();
		this.#mcpDiscoveryEnabled = config.mcpDiscoveryEnabled ?? false;
		this.#setDiscoverableMCPTools(this.#collectDiscoverableMCPToolsFromRegistry());
		this.#selectedMCPToolNames = new Set(config.initialSelectedMCPToolNames ?? []);
		this.#defaultSelectedMCPServerNames = new Set(config.defaultSelectedMCPServerNames ?? []);
		this.#defaultSelectedMCPToolNames = new Set(config.defaultSelectedMCPToolNames ?? []);
		this.#pruneSelectedMCPToolNames();
		const persistedSelectedMCPToolNames = this.buildDisplaySessionContext().selectedMCPToolNames;
		const currentSelectedMCPToolNames = this.getSelectedMCPToolNames();
		const persistInitialMCPToolSelection =
			config.persistInitialMCPToolSelection ?? this.sessionManager.getBranch().length === 0;
		if (
			this.#mcpDiscoveryEnabled &&
			persistInitialMCPToolSelection &&
			!this.#selectedMCPToolNamesMatch(persistedSelectedMCPToolNames, currentSelectedMCPToolNames)
		) {
			this.sessionManager.appendMCPToolSelection(currentSelectedMCPToolNames);
		}
		this.#rememberSessionDefaultSelectedMCPToolNames(
			this.sessionManager.getSessionFile(),
			this.#getConfiguredDefaultSelectedMCPToolNames(),
		);
		this.#ttsrManager = config.ttsrManager;
		this.#secretRuntime = config.secretRuntime;
		this.#obfuscator = config.secretRuntime?.expansionObfuscator ?? config.obfuscator;
		this.#leaseSecretRuntime = config.leaseSecretRuntime;
		this.#resolveSecretRuntimeLeaseForContext = config.resolveSecretRuntimeLeaseForContext;
		this.#refreshSecretRuntime = config.refreshSecretRuntime;
		this.#argot = config.argot;
		this.#agentId = config.agentId;
		this.#agentKind = config.agentKind ?? "main";
		this.#providerSessionId = config.providerSessionId;
		this.#inheritedProviderPromptCacheKey =
			config.providerPromptCacheKeySource === "fork" ? this.agent.promptCacheKey : undefined;
		this.agent.setAssistantMessageEventInterceptor((message, assistantMessageEvent) => {
			const event: AgentEvent = {
				type: "message_update",
				message,
				assistantMessageEvent,
			};
			this.#preCacheStreamingEditFile(event);
			this.#maybeAbortStreamingEdit(event);
			this.#maybeInterruptGeminiHeaderRunaway(message, assistantMessageEvent);
		});

		this.agent.afterToolCall = ctx => this.#afterToolCall(ctx);
		this.agent.providerSessionState = this.#providerSessionState;
		this.#syncAgentSessionId();
		this.#syncTodoPhasesFromBranch();
		this.#goalRuntime = new GoalRuntime({
			getState: () => this.#goalModeState,
			setState: state => {
				this.#goalModeState = state;
			},
			budgetsEnabled: () => this.settings.get("goal.modelBudgetsEnabled"),
			getCurrentUsage: () => {
				const usage = this.getSessionStats().tokens;
				return {
					input: usage.input,
					output: usage.output,
					cacheRead: usage.cacheRead,
					cacheWrite: usage.cacheWrite,
				};
			},
			emit: event => {
				if (event.type === "goal_updated") {
					return this.#emitSessionEvent({ type: "goal_updated", goal: event.goal, state: event.state });
				}
			},
			persist: (mode, state) => {
				if (mode === "none") {
					this.sessionManager.appendModeChange("none");
				} else if (state) {
					this.sessionManager.appendModeChange(mode, { goal: state.goal });
				}
			},
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
		this.#cancelExitRecorder = postmortem.register(`agent-session:${this.sessionManager.getSessionId()}`, reason => {
			this.#recordSessionExit(reason);
		});

		this.#advisorEnabled = isAdvisorProductEnabled() && (this.settings.get("advisor.enabled") as boolean);
		if (this.#advisorEnabled) this.#buildAdvisorRuntime();

		this.#rehydrateCheckpointRewindState();

		this.#unsubscribeAgent = this.agent.subscribe(this.#handleAgentEvent);

		this.#unsubscribeAppendOnly = onAppendOnlyModeChanged(_value => this.#syncAppendOnlyContext(this.model));
		this.#unsubscribeModelRoles = onModelRolesChanged(() => {
			if (!isAdvisorProductEnabled() || !this.#advisorEnabled || this.#isDisposed) return;
			if (this.#advisors.length > 0 && !this.#advisorRuntimeMatchesCurrentConfig()) this.#stopAdvisorRuntime();
			this.#buildAdvisorRuntime(true);
		});
		this.#unsubscribePromptSettings = this.settings.onEffectiveSettingChanged((path, value) => {
			if (this.#isDisposed) return;

			if ((path === "todo.reminders" || path === "todo.enabled") && value === false) {
				this.#todoReminderCount = 0;
				this.#todoReminderAwaitingProgress = false;
				this.#lastTodoReminderFingerprint = undefined;
				this.#todoReminderEchoCompactionId = undefined;
			}

			if (path === "session.cpuLimitCores" || path === "session.cpuLimitKill") {
				const limiter = sessionCpuLimit(this.sessionManager.getSessionId());
				void limiter
					?.update(this.settings.get("session.cpuLimitCores"), this.settings.get("session.cpuLimitKill"))
					.catch(error => logger.warn("CPU limit update failed", { error: errorMessage(error) }));
			}
			if (!rebuildsThePrompt(path)) return;
			this.#promptRefresh = this.#promptRefresh
				.then(async () => {
					if (!this.#isDisposed) await this.refreshBaseSystemPrompt(`setting:${path}`);
				})
				.catch(error => {
					logger.warn("System prompt refresh after setting change failed", {
						path,
						error: errorMessage(error),
					});
				});
		});
	}
	#advisorImmuneTurnLimit(): number {
		const immuneTurns = this.settings.get("advisor.immuneTurns") as number;
		if (!Number.isFinite(immuneTurns) || immuneTurns <= 0) return 0;
		return Math.trunc(immuneTurns);
	}

	#isAdvisorInterruptImmuneTurnActive(): boolean {
		return isAdvisorInterruptImmuneTurnActive({
			completedTurns: this.#advisorPrimaryTurnsCompleted,
			immuneTurnStart: this.#advisorInterruptImmuneTurnStart,
			immuneTurns: this.#advisorImmuneTurnLimit(),
		});
	}

	#recordAdvisorInterruptDelivered(): void {
		this.#advisorInterruptImmuneTurnStart = this.#advisorPrimaryTurnsCompleted + 1;
	}

	#resetAdvisorSessionState(): void {
		for (const a of this.#advisors) {
			a.agentUnsubscribe?.();
			a.agentUnsubscribe = undefined;
			a.runtime.reset();
			a.adviseTool.resetDeliveredNotes();
			a.emissionGuard.reset();
			this.#attachAdvisorRecorderFeed(a);
		}
		this.#advisorPrimaryTurnsCompleted = 0;
		this.#advisorInterruptImmuneTurnStart = undefined;
		this.#advisorAutoResumeSuppressed = false;
		this.yieldQueue.clear("advisor");
		this.#extractQueuedAdvisorCards();
		if (this.#pendingNextTurnMessages.some(isAdvisorCard)) {
			this.#pendingNextTurnMessages = this.#pendingNextTurnMessages.filter(m => !isAdvisorCard(m));
		}
	}

	#resolveAdvisorRuntimeDescriptors(emitWarnings: boolean): AdvisorRuntimeDescriptor[] {
		const legacy = !this.#advisorConfigs?.length;
		const roster: AdvisorConfig[] = legacy ? [{ name: "default" }] : this.#advisorConfigs!;
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

			let model: Model | undefined;
			let thinkingLevel: ThinkingLevel | undefined;
			if (config.model) {
				const resolved = resolveModelOverride([config.model], this.#modelRegistry, this.settings);
				model = resolved.model;
				thinkingLevel = concreteThinkingLevel(resolved.thinkingLevel);
				if (!model) {
					if (emitWarnings) {
						this.emitNotice("warning", `Advisor "${config.name}": no model matched "${config.model}"`, "advisor");
					}
					continue;
				}
			} else {
				const sel = resolveAdvisorRoleSelection(
					this.settings,
					this.#modelRegistry.getAvailable(),
					this.agent.state.model,
				);
				if (!sel) {
					if (emitWarnings) {
						this.emitNotice(
							"warning",
							`Advisor "${config.name}": no advisor model available (set modelRoles.advisor, or sign in so the session model can be inherited); advisor inactive`,
							"advisor",
						);
					}
					continue;
				}
				model = sel.model;
				thinkingLevel = concreteThinkingLevel(sel.thinkingLevel);
			}

			const requestedLevel = thinkingLevel ?? ThinkingLevel.Medium;
			const resolvedLevel = resolveThinkingLevelForModel(model, requestedLevel);
			const advisorThinkingLevel: ThinkingLevel = resolvedLevel ?? ThinkingLevel.Inherit;
			descriptors.push({
				config,
				name: config.name,
				slug,
				model,
				thinkingLevel: advisorThinkingLevel,
				signature: this.#advisorRuntimeSignature(config, slug, model, advisorThinkingLevel),
			});
		}
		return descriptors;
	}

	#advisorRuntimeSignature(config: AdvisorConfig, slug: string, model: Model, thinkingLevel: ThinkingLevel): string {
		const tools = config.tools?.length ? config.tools.join("\u001e") : "";
		const instructions = config.instructions?.trim() ?? "";
		return [config.name, slug, formatModelStringWithRouting(model), thinkingLevel, tools, instructions].join(
			"\u001f",
		);
	}

	#advisorRuntimeMatchesCurrentConfig(): boolean {
		const descriptors = this.#resolveAdvisorRuntimeDescriptors(false);
		if (descriptors.length !== this.#advisors.length) return false;
		for (let i = 0; i < descriptors.length; i++) {
			if (descriptors[i].signature !== this.#advisors[i].signature) return false;
		}
		return true;
	}

	#buildAdvisorRuntime(seedToCurrent = false): boolean {
		if (this.#isDisposed) return false;
		if (this.#advisors.length > 0) return true;
		if (!this.#advisorEnabled) return false;
		if (this.#agentKind !== "main" && !this.settings.get("advisor.subagents")) return false;

		const descriptors = this.#resolveAdvisorRuntimeDescriptors(true);

		const advisorTierSetting = this.settings.get("tier.advisor");
		const advisorTierMap =
			advisorTierSetting === "inherit"
				? undefined
				: serviceTierForAllFamilies(serviceTierSettingToTier(advisorTierSetting));
		const advisorServiceTierResolver = (model: Model): ServiceTier | undefined =>
			advisorTierSetting === "inherit"
				? this.#effectiveServiceTier(model)
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

			const systemPrompt = [advisorPrompts["advisor/system"].text];
			if (this.#advisorContextPrompt) systemPrompt.push(this.#advisorContextPrompt);
			if (this.#advisorWatchdogPrompt) systemPrompt.push(this.#advisorWatchdogPrompt);
			if (this.#advisorSharedInstructions) systemPrompt.push(this.#advisorSharedInstructions);
			if (config.instructions?.trim()) systemPrompt.push(config.instructions.trim());

			const names = config.tools === undefined ? ADVISOR_DEFAULT_TOOL_NAMES : new Set(config.tools);
			const tools = (this.#advisorTools ?? []).filter(t => names.has(t.name));
			const availableAdvisorToolNames = new Set<string>();
			availableAdvisorToolNames.add(adviseTool.name);
			for (const tool of tools) {
				availableAdvisorToolNames.add(tool.name);
				if (tool.customWireName !== undefined) availableAdvisorToolNames.add(tool.customWireName);
			}
			let quarantinedAdvisorOutput: string | undefined;
			let currentAdvisorInput = "";

			const primaryProviderSessionId = this.sessionId;
			const advisorSessionLabel = slug
				? `${primaryProviderSessionId}-advisor-${slug}`
				: `${primaryProviderSessionId}-advisor`;
			const advisorProviderSessionId = getOrCreateAdvisorProviderSessionId(
				this.#advisorProviderSessionIds,
				primaryProviderSessionId,
				slug,
			);
			const appendOnlyContext = new AppendOnlyContextManager();

			const advisorTelemetry = this.agent.telemetry
				? {
						...this.agent.telemetry,
						agent: {
							id: advisorSessionLabel,
							name: slug ? `${MODEL_ROLES.advisor.name}: ${advisorName}` : MODEL_ROLES.advisor.name,
							description: formatModelString(advisorModel),
						},
						conversationId: undefined,
					}
				: undefined;

			const advisorPromptCacheKey = this.agent.promptCacheKey ?? advisorProviderSessionId;
			let advisorSecretRuntime: SecretRuntimeLease | undefined;
			const leasedAdvisorStreamFn: StreamFn = async (requestModel, requestContext, requestOptions) => {
				const runtime =
					advisorSecretRuntime ??
					this.#resolveSecretRuntimeLeaseForContext?.(requestContext) ??
					(await this.leaseSecretRuntime());
				const sessionOnPayload = this.#onPayload;
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
				return (this.#advisorStreamFn ?? streamSimple)(requestModel, requestContext, {
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
				providerSessionState: this.#providerSessionState,
				preferWebsockets: this.#preferWebsockets,
				getApiKey: requestModel => this.#modelRegistry.resolver(requestModel, advisorProviderSessionId),
				transformContext: async messages => {
					advisorSecretRuntime = await this.leaseSecretRuntime();
					return messages;
				},
				streamFn: leasedAdvisorStreamFn,
				onResponse: this.#onResponse,
				onSseEvent: this.#onSseEvent,
				transformProviderContext: (context, requestModel) =>
					this.#transformProviderContext
						? this.#transformProviderContext(context, requestModel, advisorSecretRuntime)
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
					const messages = advisorAgent.state.messages;
					if (count < messages.length) {
						messages.length = count;
					}
					appendOnlyContext.resetSyncCursor();
					advisorAgent.state.error = undefined;
				},
				state: advisorAgent.state,
			};

			const recorder = new AdvisorTranscriptRecorder(
				() => this.sessionManager.getSessionFile(),
				() => this.sessionManager.getCwd(),
				advisorTranscriptFilename(slug),

				this.#advisorRecorderClosed,
			);

			const liveRedactor = (): SecretObfuscator | undefined => this.providerRedactor;
			const runtime = new AdvisorRuntime(advisorAgentFacade, {
				snapshotMessages: () => this.agent.state.messages,
				enqueueAdvice: (note, severity) => this.#routeAdvice(advisorRef, note, severity),
				maintainContext: incomingTokens => this.#maintainAdvisorContext(advisorRef, incomingTokens),
				get obfuscator(): SecretObfuscator | undefined {
					return liveRedactor();
				},
				beginAdvisorUpdate: () => advisorRef.emissionGuard.beginUpdate(),
				onTurnError: async error => {
					const message = errorMessage(error);
					if (!AIError.isUsageLimit(error)) return;
					await this.#modelRegistry.authStorage.markUsageLimitReached(
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
					this.emitNotice(
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
			this.#attachAdvisorRecorderFeed(advisorRef);
			if (seedToCurrent) runtime.seedTo(this.agent.state.messages.length);
			this.#advisors.push(advisorRef);
		}

		if (this.#advisors.length > 0 && !this.#advisorYieldQueueUnsubscribe) {
			this.#advisorYieldQueueUnsubscribe = this.yieldQueue.register<AdvisorNote>("advisor", {
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
		if (this.agent.hasQueuedMessages() || this.#pendingNextTurnMessages.length > 0) return false;
		const messages = this.agent.state.messages;
		let tail = messages.length - 1;
		while (tail >= 0 && isAdvisorCard(messages[tail])) tail--;
		return isTerminalTextAssistantAnswer(messages[tail]);
	}

	#routeAdvice(advisor: ActiveAdvisor, note: string, severity?: AdvisorSeverity): void {
		if (!advisor.emissionGuard.accept(note)) {
			logger.debug("advisor advice suppressed by emission guard", { severity, advisor: advisor.name });
			return;
		}

		const deliveredNote = annotateForStaleness(note, advisor.runtime.hasFreshBacklog);

		const source = advisor.slug ? advisor.name : undefined;
		const interrupting = isInterruptingSeverity(severity);
		const channel = resolveAdvisorDeliveryChannel({
			severity,
			autoResumeSuppressed: this.#advisorAutoResumeSuppressed,

			streaming: this.agent.state.isStreaming,
			aborting: this.#abortInProgress,
			terminalAnswerNoQueuedWork: this.#hasTerminalTextAnswerWithoutQueuedWork(),
			interruptImmuneTurnActive: interrupting && this.#isAdvisorInterruptImmuneTurnActive(),
		});
		if (channel === "aside") {
			this.yieldQueue.enqueue("advisor", { note: deliveredNote, severity, advisor: source });
			return;
		}
		const notes: AdvisorNote[] = [{ note: deliveredNote, severity, advisor: source }];
		const content = formatAdvisorBatchContent(notes);
		const details = { notes } satisfies AdvisorMessageDetails;
		if (channel === "preserve") {
			this.#preserveAdvisorCard({
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
		this.#recordAdvisorInterruptDelivered();
		if (this.#planModeState?.enabled) {
			this.#preserveAdvisorCard({
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
		void this.sendCustomMessage(
			{ customType: "advisor", content, display: true, attribution: "agent", details },
			{ deliverAs: "steer", triggerTurn: true },
		).catch(err => logger.debug("advisor delivery failed", { err: errorMessage(err) }));
	}

	#resetAllAdvisorRuntimes(): void {
		for (const a of this.#advisors) a.runtime.reset();
		this.#ttsrManager?.resetForCompaction();
	}

	#stopAdvisorRuntime(): void {
		const closes: Promise<void>[] = [];
		for (const a of this.#advisors) {
			a.agentUnsubscribe?.();
			a.agentUnsubscribe = undefined;
			a.runtime.dispose();

			a.recorderClosed = a.recorder.close();
			closes.push(a.recorderClosed);
		}
		this.#advisorRecorderClosed = Promise.all(closes).then(() => {});
		this.#advisors = [];
		this.#advisorYieldQueueUnsubscribe?.();
		this.#advisorYieldQueueUnsubscribe = undefined;
	}

	#attachAdvisorRecorderFeed(advisor: ActiveAdvisor): void {
		advisor.agentUnsubscribe = advisor.agent.subscribe(event => {
			if (event.type === "message_end") advisor.recorder.record(event.message);
		});
	}

	async #promoteAdvisorContextModel(advisor: ActiveAdvisor, currentModel: Model): Promise<boolean> {
		const promotionSettings = this.settings.getGroup("contextPromotion");
		if (!promotionSettings.enabled) return false;
		const contextWindow = currentModel.contextWindow ?? 0;
		if (contextWindow <= 0) return false;
		const targetModel = await this.#resolveContextPromotionTarget(currentModel, contextWindow);
		if (!targetModel) return false;

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
				error: errorMessage(error),
			});
			return false;
		}
	}

	async #maintainAdvisorContext(advisor: ActiveAdvisor, incomingTokens: number): Promise<boolean> {
		const agent = advisor.agent;

		const compactionSettings = this.settings.getGroup("compaction");
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

		if (await this.#promoteAdvisorContextModel(advisor, advisorModel)) {
			const newModel = agent.state.model;
			const newWindow = newModel.contextWindow ?? 0;
			if (newWindow > 0) {
				const stillNeedsCompaction = shouldCompact(contextTokens, newWindow, compactionSettings);
				if (!stillNeedsCompaction) return false;
			}
		}

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

		const availableModels = this.#modelRegistry.getAvailable();
		const candidates = this.#resolveCompactionModelCandidates(advisorModel, availableModels);
		if (candidates.length === 0) {
			return true;
		}
		const advisorProviderSessionId = getOrCreateAdvisorProviderSessionId(
			this.#advisorProviderSessionIds,
			this.sessionId,
			advisor.slug,
		);
		const preparation = prepareCompaction(pathEntries, toAgentCompactionSettings(compactionSettings), {
			nonMessageTokens: computeNonMessageTokens(this),
			contextWindow: declaredContextWindow(this.model),
		});
		if (!preparation) {
			return true;
		}

		const advisorCompactionThinkingLevel: ThinkingLevel | undefined = agent.state.disableReasoning
			? ThinkingLevel.Off
			: agent.state.thinkingLevel;

		let compactResult: CompactionResult | undefined;
		let lastError: unknown;

		const telemetry = resolveTelemetry(agent.telemetry, advisorProviderSessionId);

		const codexCompaction = createCodexCompactionContext({
			trigger: "auto",
			reason: "context_limit",
			phase: "pre_turn",
		});

		for (const candidate of candidates) {
			const apiKey = await this.#modelRegistry.getApiKey(candidate, advisorProviderSessionId);
			if (!apiKey) continue;

			try {
				compactResult = await compact(
					preparation,
					candidate,
					this.#modelRegistry.resolver(candidate, advisorProviderSessionId),
					undefined,
					undefined,
					{
						thinkingLevel: advisorCompactionThinkingLevel,
						convertToLlm: messages => this.#convertToLlmForSideRequest(messages),
						telemetry,
						tools: agent.state.tools,
						sessionId: advisorProviderSessionId,

						promptCacheKey: this.agent.promptCacheKey ?? advisorProviderSessionId,
						providerSessionState: this.#providerSessionState,
						codexCompaction,
						completeImpl: this.#sideCompleteImpl,

						serviceTier: agent.serviceTierResolver?.(candidate),
					},
				);
				break;
			} catch (error) {
				lastError = error;
			}
		}

		if (!compactResult) {
			logger.warn("Advisor compaction failed, falling back to re-prime", { error: errorMessage(lastError) });
			return true;
		}

		const summary = compactResult.summary;
		const shortSummary = compactResult.shortSummary;
		const firstKeptEntryId = compactResult.firstKeptEntryId;
		const tokensBefore = compactResult.tokensBefore;

		const summaryMessage = {
			...createCompactionSummaryMessage(summary, tokensBefore, new Date().toISOString(), shortSummary),
			firstKeptEntryId,
		} as CompactionSummaryMessage & { firstKeptEntryId?: string };

		const recentMessages = await this.#resolveAdvisorTailElisions(preparation);
		agent.replaceMessages([summaryMessage, ...recentMessages]);
		return false;
	}

	async #resolveAdvisorTailElisions(preparation: CompactionPreparation): Promise<AgentMessage[]> {
		const elisions = preparation.tailElisions ?? [];
		if (elisions.length === 0) return preparation.recentMessages;
		let artifactId: string | undefined;
		try {
			artifactId = await this.sessionManager.saveArtifact(renderTailElisionArtifact(elisions), "compaction-tail");
		} catch (error) {
			logger.warn("Failed to persist compaction tail elision artifact", {
				error: errorMessage(error),
				elisionCount: elisions.length,
			});
			artifactId = undefined;
		}
		const resolved = new Map<AgentMessage, AgentMessage>();
		for (const elision of elisions) {
			resolved.set(
				elision.message,
				artifactId
					? {
							...elision.message,
							content: [
								{ type: "text", text: renderTailElisionMarker(elision.toolName, elision.tokens, artifactId) },
							],
						}
					: elision.originalMessage,
			);
		}
		return preparation.recentMessages.map(message => resolved.get(message) ?? message);
	}

	get modelRegistry(): ModelRegistry {
		return this.#modelRegistry;
	}

	get asyncJobManager(): AsyncJobManager | undefined {
		return this.#asyncJobManager;
	}

	getAgentId(): string | undefined {
		return this.#agentId;
	}

	#nextHardToolChoice(): ToolChoice | undefined {
		const choice = this.#toolChoiceQueue.nextToolChoice();
		if (isToolChoiceActive(choice, this.agent.state.tools)) {
			return choice;
		}
		this.#toolChoiceQueue.reject("unavailable");
		return undefined;
	}

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

	peekPendingInvoker(): ((input: unknown) => Promise<unknown> | unknown) | undefined {
		return this.#toolChoiceQueue.peekPendingInvoker();
	}

	clearPendingInvokers(): void {
		this.#toolChoiceQueue.clearPendingInvokers();
	}

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

	get toolChoiceQueue(): ToolChoiceQueue {
		return this.#toolChoiceQueue;
	}

	peekQueueInvoker(): ((input: unknown) => Promise<unknown> | unknown) | undefined {
		return this.#toolChoiceQueue.peekInFlightInvoker();
	}

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

	get providerSessionState(): Map<string, ProviderSessionState> {
		return this.#providerSessionState;
	}

	get preferWebsockets(): boolean | undefined {
		return this.#preferWebsockets;
	}

	getHindsightSessionState(): HindsightSessionState | undefined {
		return this.#hindsightSessionState;
	}

	getArgotSession(): ArgotSession | undefined {
		return this.#argot;
	}

	setHindsightSessionState(state: HindsightSessionState | undefined): HindsightSessionState | undefined {
		const previous = this.#hindsightSessionState;
		this.#hindsightSessionState = state;
		return previous;
	}

	getMnemopiSessionState(): MnemopiSessionState | undefined {
		return getMnemopiSessionState(this);
	}

	get ttsrManager(): TtsrManager | undefined {
		return this.#ttsrManager;
	}

	get obfuscator(): SecretObfuscator | undefined {
		return this.#obfuscator;
	}

	get secretsEnabled(): boolean {
		return this.#obfuscator !== undefined;
	}

	obfuscateProviderText(text: string): string {
		return this.#secretRuntime?.obfuscateText(text) ?? this.#obfuscator?.obfuscate(text) ?? text;
	}

	get #hasProviderRedactions(): boolean {
		return this.#secretRuntime?.hasRedactions ?? this.#obfuscator?.hasSecrets() ?? false;
	}

	get providerRedactor(): SecretObfuscator | undefined {
		return this.#secretRuntime?.redactionObfuscator ?? this.#obfuscator;
	}

	#obfuscateContextForProvider(context: Context): Context {
		const runtime = this.#secretRuntime;
		return runtime ? runtime.obfuscateContext(context) : obfuscateProviderContext(this.#obfuscator, context);
	}

	#obfuscateMessagesForProvider(messages: Message[]): Message[] {
		const runtime = this.#secretRuntime;
		if (runtime) return runtime.obfuscateMessages(messages);
		return this.#obfuscator ? obfuscateMessages(this.#obfuscator, messages) : messages;
	}

	installSecretRuntime(runtime: SecretRuntimeLease): void {
		if (this.#secretRuntime && runtime.revision < this.#secretRuntime.revision) return;
		this.#secretRuntime = runtime;
		this.#obfuscator = runtime.expansionObfuscator;
	}

	async awaitScopeTransitionReady(): Promise<void> {
		await this.#scopeTransitionTail;
	}

	async leaseSecretRuntime(): Promise<SecretRuntimeLease> {
		await this.awaitScopeTransitionReady();
		if (this.#leaseSecretRuntime) {
			const runtime = await this.#leaseSecretRuntime();
			this.installSecretRuntime(runtime);
			return runtime;
		}
		if (this.#secretRuntime) return this.#secretRuntime;

		const obfuscator = this.#obfuscator;
		return {
			revision: 0,
			cwd: this.sessionManager.getCwd(),
			expansionObfuscator: obfuscator,
			redactionObfuscator: obfuscator,
			hasRedactions: obfuscator?.hasSecrets() ?? false,
			obfuscateText: text => obfuscator?.obfuscate(text) ?? text,
			obfuscateMessages: messages => (obfuscator ? obfuscateMessages(obfuscator, messages) : messages),
			obfuscateContext: context => (obfuscator ? obfuscateProviderContext(obfuscator, context) : context),
			obfuscatePayload: payload => obfuscateProviderPayload(payload, obfuscator),

			isFreshForExpansion: () => true,
			ensureFreshForExpansion: async () => undefined,
			assertFreshForExpansion: () => undefined,
		};
	}

	#runScopeTransition<T>(work: (revision: number) => Promise<T>): Promise<T> {
		const revision = ++this.#scopeTransitionRevision;
		const run = this.#scopeTransitionTail.then(() => work(revision));
		this.#scopeTransitionTail = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	async #refreshSecrets(options?: { refreshPrompt?: boolean }): Promise<void> {
		if (!this.#refreshSecretRuntime) return;
		const refreshed = await this.#refreshSecretRuntime(this.sessionManager.getCwd());
		if (refreshed && "revision" in refreshed) {
			this.installSecretRuntime(refreshed);
		} else {
			this.#secretRuntime = undefined;
			this.#obfuscator = refreshed;
		}
		if (options?.refreshPrompt !== false) await this.refreshBaseSystemPrompt("secrets-refresh");
	}

	refreshSecrets(options?: { refreshPrompt?: boolean }): Promise<void> {
		return this.#runScopeTransition(() => this.#refreshSecrets(options));
	}

	get isTtsrAbortPending(): boolean {
		return this.#ttsrAbortPending;
	}

	get isPlanInternalAbortPending(): boolean {
		return this.#planInternalAbortPending;
	}

	markPlanInternalAbortPending(): void {
		this.#planInternalAbortPending = true;
	}

	clearPlanInternalAbortPending(): void {
		this.#planInternalAbortPending = false;
	}

	deliverAsyncJobResult(jobId: string, text: string, job?: AsyncJob): "attached" | "queued" {
		const toolCallId = job?.toolCallId;
		if (toolCallId && this.#attachLateToolResult(toolCallId, text, job)) {
			return "attached";
		}
		this.yieldQueue.enqueue<AsyncResultEntry>("async-result", {
			jobId,
			result: text,
			job,
			durationMs: job ? Math.max(0, Date.now() - job.startTime) : undefined,
		});
		return "queued";
	}

	#attachLateToolResult(toolCallId: string, text: string, job: AsyncJob | undefined): boolean {
		const messages = this.agent.state.messages;
		let callIndex = -1;
		let toolName: string | undefined;
		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i];
			if (message.role !== "assistant") continue;
			const block = message.content.find(part => part.type === "toolCall" && part.id === toolCallId);
			if (block && block.type === "toolCall") {
				callIndex = i;
				toolName = block.name;
				break;
			}
		}
		if (callIndex < 0) return false;
		for (let i = callIndex + 1; i < messages.length; i++) {
			const message = messages[i];
			if (message.role === "toolResult" && message.toolCallId === toolCallId) return false;
		}
		const toolResultMessage: ToolResultMessage = {
			role: "toolResult",
			toolCallId,
			toolName: toolName ?? job?.type ?? "tool",
			content: [{ type: "text", text }],
			details: job
				? { async: { state: job.status === "failed" ? "failed" : "completed", jobId: job.id } }
				: undefined,
			isError: job?.status === "failed",
			timestamp: Date.now(),
		};
		this.agent.appendMessage(toolResultMessage);
		this.#persistSessionMessageIfMissing(toolResultMessage);
		this.#emitSessionEventDetached({ type: "message_start", message: toolResultMessage }, "late tool result");
		this.#emitSessionEventDetached({ type: "message_end", message: toolResultMessage }, "late tool result");
		return true;
	}

	getAsyncJobSnapshot(options?: { recentLimit?: number }): AsyncJobSnapshot | null {
		const manager = this.#asyncJobManager;
		if (!manager) return null;
		const ownerFilter = this.#agentId ? { ownerId: this.#agentId } : undefined;
		const running = manager.getRunningJobs(ownerFilter).map(job => ({
			id: job.id,
			type: job.type,
			status: job.status,
			label: job.label,
			startTime: job.startTime,
		}));
		const recent = manager.getRecentJobs(options?.recentLimit ?? 5, ownerFilter).map(job => ({
			id: job.id,
			type: job.type,
			status: job.status,
			label: job.label,
			startTime: job.startTime,
		}));
		const delivery = manager.getDeliveryState(ownerFilter);
		return { running, recent, delivery };
	}

	getRunningNonTaskJobCount(): number {
		const manager = this.#asyncJobManager;
		if (!manager) return 0;
		return manager.countRunningJobsExcludingType("task", this.#agentId);
	}

	#cancelOwnAsyncJobs(): void {
		if (!this.#agentId) return;
		const manager = this.#asyncJobManager;
		if (!manager) return;
		manager.cancelAll({ ownerId: this.#agentId });
		for (const descendant of AgentRegistry.global().descendantsOf(this.#agentId)) {
			manager.cancelAll({ ownerId: descendant });
		}
	}

	async #rescopeAgentRegistry(): Promise<void> {
		const id = this.#agentId;
		if (!id) return;
		const registry = AgentRegistry.global();
		const self = registry.get(id);
		if (!self) return;
		const endingScope = self.scope;
		const descendants = registry.descendantsOf(id);
		if (descendants.length > 0) {
			const lifecycle = AgentLifecycleManager.global();
			await Promise.all(
				descendants.map(async child => {
					try {
						await lifecycle.release(child);
					} catch (error) {
						logger.warn("Failed to release a subagent of the previous conversation", {
							agentId: child,
							error: errorMessage(error),
						});
					}
				}),
			);
		}

		IrcBus.global().forgetAgents(descendants.concat([id]), endingScope);

		this.#sessionToolApprovals.clear();
		registry.rescope(id, this.sessionManager.getSessionId?.() ?? undefined);
		logger.debug("Re-rooted the agent registry for a new conversation", {
			agentId: id,
			from: endingScope,
			to: registry.get(id)?.scope,
			released: descendants.length,
		});
	}

	#hasPendingAsyncWake(): boolean {
		const manager = this.#asyncJobManager;
		if (!manager) return false;
		const ownerFilter = this.#agentId ? { ownerId: this.#agentId } : undefined;
		return (
			manager.getRunningJobs(ownerFilter).some(job => !manager.isDeliverySuppressed(job.id)) ||
			manager.hasPendingDeliveries(ownerFilter)
		);
	}

	#emit(event: AgentSessionEvent): void {
		const listeners = this.#eventListeners.slice();
		for (const l of listeners) {
			try {
				const result = l(event) as unknown;

				if (isPromise(result)) {
					result.catch(err => {
						logger.warn("AgentSession listener rejected", {
							error: errorMessage(err),
						});
					});
				}
			} catch (err) {
				logger.warn("AgentSession listener threw", {
					error: errorMessage(err),
				});
			}
		}
	}

	emitNotice(level: "info" | "warning" | "error", message: string, source?: string): void {
		this.#emit({ type: "notice", level, message, source });
	}

	#recordToolExecutionStart(event: Extract<AgentEvent, { type: "tool_execution_start" }>): void {
		const data: ToolExecutionStartData = {
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			startedAt: new Date().toISOString(),
		};

		const redact = (text: string): string => this.obfuscateProviderText(text);
		const args = summarizeToolArguments(event.args, redact);
		if (args) data.args = args;
		if (event.intent) data.intent = redact(event.intent);
		this.sessionManager.appendCustomEntry(TOOL_EXECUTION_START_CUSTOM_TYPE, data);
	}

	#recordSessionExit(reason: postmortem.Reason | "dispose"): void {
		if (this.#exitRecorded) return;
		this.#exitRecorded = true;
		const pendingToolCalls = collectPendingToolCalls(this.sessionManager.getBranch());
		if (
			pendingToolCalls.length === 0 &&
			!this.sessionManager.getEntries().some(entry => entry.type === "message" && entry.message.role === "assistant")
		) {
			return;
		}
		const kind: SessionExitData["kind"] =
			reason === "dispose" || reason === postmortem.Reason.MANUAL
				? "normal"
				: reason === postmortem.Reason.UNCAUGHT_EXCEPTION || reason === postmortem.Reason.UNHANDLED_REJECTION
					? "fatal"
					: reason === postmortem.Reason.EXIT
						? "process_exit"
						: "signal";
		const data: SessionExitData = {
			reason,
			kind,
			recordedAt: new Date().toISOString(),
		};
		if (pendingToolCalls.length > 0) data.pendingToolCalls = pendingToolCalls;
		try {
			this.sessionManager.appendCustomEntry(SESSION_EXIT_CUSTOM_TYPE, data);
			this.sessionManager.flushSync();

			logger[sessionExitLogLevel(kind, pendingToolCalls.length)]("Session exit recorded", {
				sessionId: this.sessionManager.getSessionId(),
				sessionFile: this.sessionManager.getSessionFile(),
				reason,
				kind,
				pendingToolCalls: pendingToolCalls.length,
			});
		} catch (error) {
			logger.error("Failed to record session exit", {
				sessionId: this.sessionManager.getSessionId(),
				sessionFile: this.sessionManager.getSessionFile(),
				reason,
				error: errorMessage(error),
			});
		}
	}

	#queuedExtensionEvents: Promise<void> = Promise.resolve();

	#queueExtensionEvent(event: AgentSessionEvent): Promise<void> {
		const emit = async () => {
			await this.#emitExtensionEvent(event);
		};
		const queued = this.#queuedExtensionEvents.then(emit, emit);

		this.#queuedExtensionEvents = queued.catch(() => {});
		return queued;
	}

	#emitSessionEventDetached(event: AgentSessionEvent, context: string): void {
		void this.#emitSessionEvent(event).catch((error: unknown) => {
			logger.warn("session event emit failed", { context, event: event.type, error: errorMessage(error) });
		});
	}

	async #emitSessionEvent(event: AgentSessionEvent): Promise<void> {
		if (event.type === "message_update") {
			this.#emit(event);
			void this.#queueExtensionEvent(event);
			return;
		}
		await this.#emitExtensionEvent(event);

		if (event.type === "agent_end" && this.#promptInFlightCount > 0) {
			this.#pendingAgentEndEmit = event;
			return;
		}
		this.#emit(event);
	}

	#lastAssistantMessage: AssistantMessage | undefined = undefined;

	#handleAgentEvent = async (event: AgentEvent): Promise<void> => {
		if (event.type !== "agent_end") {
			return this.#processAgentEvent(event);
		}
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#trackPostPromptTask(promise);
		try {
			await this.#processAgentEvent(event);
		} finally {
			resolve();
		}
	};

	#createMessageEndPersistenceSlot(message: AgentMessage): MessageEndPersistenceSlot | undefined {
		const key = sessionMessagePersistenceKey(message);
		if (!key) return undefined;
		const previous = this.#messageEndPersistenceTail;
		const { promise, resolve } = Promise.withResolvers<void>();
		const clear = () => {
			if (this.#pendingMessageEndPersistence.get(key) === promise) {
				this.#pendingMessageEndPersistence.delete(key);
			}
		};
		this.#pendingMessageEndPersistence.set(key, promise);

		this.#messageEndPersistenceTail = promise.catch(() => {});
		return {
			promise,
			persist: async persistMessage => {
				await previous;
				try {
					persistMessage();
				} finally {
					resolve();
					clear();
				}
			},
			release: () => {
				resolve();
				clear();
			},
		};
	}

	async #waitForSessionMessagePersistence(message: AgentMessage): Promise<void> {
		const key = sessionMessagePersistenceKey(message);
		if (!key) return;
		await this.#pendingMessageEndPersistence.get(key);
	}

	#indexPersistedMessageKeys(): Set<string> {
		return this.#ensurePersistedMessageKeys();
	}

	#persistedMessageKeysAnchor(): string {
		return `${this.sessionManager.getSessionFile() ?? ""}\u0000${this.sessionManager.getLeafId() ?? ""}`;
	}

	#ensurePersistedMessageKeys(): Set<string> {
		const anchor = this.#persistedMessageKeysAnchor();
		let cache = this.#persistedMessageKeys;
		if (cache === undefined || cache.anchor !== anchor) {
			cache = { anchor, keys: this.#buildPersistedMessageKeySet() };
			this.#persistedMessageKeys = cache;
		}
		return cache.keys;
	}

	#buildPersistedMessageKeySet(): Set<string> {
		const keys = new Set<string>();
		for (const entry of this.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const key = sessionMessagePersistenceKey(entry.message);
			if (key !== undefined) keys.add(key);
		}
		return keys;
	}

	#sessionMessageAlreadyPersisted(message: AgentMessage): boolean {
		const key = sessionMessagePersistenceKey(message);
		if (key === undefined) return false;
		const keys = this.#ensurePersistedMessageKeys();
		if (!keys.has(key)) return false;
		const branch = this.sessionManager.getBranch();
		for (let index = branch.length - 1; index >= 0; index--) {
			const entry = branch[index];
			if (entry.type !== "message") continue;
			if (sessionMessagePersistenceKey(entry.message) !== key) continue;
			if (sameMessageContent(entry.message, message)) return true;
		}
		return false;
	}

	#appendSessionMessage(
		message:
			| Message
			| CustomMessage
			| HookMessage
			| BashExecutionMessage
			| PythonExecutionMessage
			| FileMentionMessage,
	): string {
		const cache = this.#persistedMessageKeys;
		const wasFresh = cache !== undefined && cache.anchor === this.#persistedMessageKeysAnchor();
		const entryId = this.sessionManager.appendMessage(message);
		const key = sessionMessagePersistenceKey(message);
		if (wasFresh && cache && key) {
			cache.keys.add(key);
			cache.anchor = this.#persistedMessageKeysAnchor();
		}
		return entryId;
	}

	#persistSessionMessageIfMissing(message: AgentMessage): void {
		if (
			message.role !== "user" &&
			message.role !== "developer" &&
			message.role !== "assistant" &&
			message.role !== "toolResult" &&
			message.role !== "fileMention"
		) {
			return;
		}
		let persistenceMessage = message;
		if (message.role === "toolResult" && message.metrics !== undefined) {
			const metrics = toolCallMetricsForPersistence(message.metrics, this.settings.get("session.instrumentation"));
			if (metrics === undefined) {
				const { metrics: _discardedMetrics, ...withoutMetrics } = message;
				persistenceMessage = withoutMetrics;
			} else {
				persistenceMessage = { ...message, metrics };
			}
		}
		if (message.role === "assistant") {
			const level = this.settings.get("session.instrumentation");
			const turnMetrics = assistantTurnMetricsForPersistence(message.turnMetrics, level);
			const request = assistantTurnRequestForPersistence(message.request, level);
			const { turnMetrics: _discardedTurnMetrics, request: _discardedRequest, ...withoutStudyTelemetry } = message;
			persistenceMessage = {
				...withoutStudyTelemetry,
				...(turnMetrics === undefined ? {} : { turnMetrics }),
				...(request === undefined ? {} : { request }),
			};
		}
		if (this.#sessionMessageAlreadyPersisted(persistenceMessage)) return;
		if (message.role === "assistant") {
			const assistantMsg = persistenceMessage as AssistantMessage;
			if (this.#isClassifierRefusal(assistantMsg)) return;
			if (isEmptyErrorTurn(assistantMsg)) return;
			if (assistantMsg.stopReason !== "aborted" && assistantMsg.stopReason !== "error" && assistantMsg.usage) {
				const pending = this.#pendingContextSnapshot;
				const nonMessageTokens = pending?.nonMessageTokens ?? computeNonMessageTokens(this);
				const currentDetail = sessionTelemetryDetail(
					this.settings.get("session.instrumentation"),
					"context-breakdown",
				);
				const detail =
					!pending || pending.detail === "none" || currentDetail === "none"
						? "none"
						: instrumentationRank(pending.detail) < instrumentationRank(currentDetail)
							? pending.detail
							: currentDetail;
				if (detail === "rich" || detail === "ultra") {
					const providerPromptTokens =
						assistantMsg.usage.input + assistantMsg.usage.cacheRead + assistantMsg.usage.cacheWrite;
					const promptTokens =
						providerPromptTokens > 0 ? calculatePromptTokens(assistantMsg.usage) : pending?.promptTokens;
					if (promptTokens !== undefined) {
						const compactionEntryId =
							pending?.compactionEntryId ??
							(detail === "ultra" ? getLatestCompactionEntry(this.sessionManager.getBranch())?.id : undefined);
						assistantMsg.contextSnapshot = buildContextSnapshot(
							promptTokens,
							nonMessageTokens,
							detail,
							estimateContextSnapshotAttribution(
								promptTokens,
								nonMessageTokens,
								pending?.tailTokens ?? 0,
								providerPromptTokens > 0 ? "provider" : "estimate",
								compactionEntryId,
							),
						);
					}
				} else {
					assistantMsg.contextSnapshot = {
						promptTokens: calculatePromptTokens(assistantMsg.usage),
						nonMessageTokens,
					};
				}
			}
		}
		const skipPersistedRewindResult =
			message.role === "toolResult" &&
			message.toolName === TOOL.rewind &&
			this.#rewoundToolResultIds.delete(message.toolCallId);
		if (!skipPersistedRewindResult) {
			this.#appendSessionMessage(persistenceMessage);
		}
	}

	#demoteInterruptedThinkingOnUserInterrupt(
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

	async #persistTurnMessagesForMidRunCompaction(context: AgentTurnEndContext | undefined): Promise<boolean> {
		if (!context) return true;
		const turnMessages = [context.message, ...context.toolResults];
		for (const message of turnMessages) {
			await this.#waitForSessionMessagePersistence(message);
		}

		const branchKeys = this.#indexPersistedMessageKeys();
		const turnKeys = turnMessages.map(sessionMessagePersistenceKey);
		const persistedKeys = new Set<string>();
		for (let index = 0; index < turnMessages.length; index++) {
			const key = turnKeys[index];
			if (key === undefined) continue;

			if (branchKeys.has(key)) {
				persistedKeys.add(key);
			}
		}
		const plan = planTurnPersistence(turnKeys, persistedKeys);
		if (plan.kind === "out-of-order") {
			const message = turnMessages[plan.messageIndex];
			logger.debug("Skipping mid-run compaction because turn persistence is out of order", {
				role: message.role,
				timestamp: message.timestamp,
			});
			return false;
		}
		for (const index of plan.toPersist) {
			this.#persistSessionMessageIfMissing(turnMessages[index]);
		}
		return true;
	}

	#tryExpandSecretsForDisplay(text: string): string | undefined {
		const obfuscator = this.#obfuscator;
		if (obfuscator === undefined || !obfuscator.containsDisplayRestorablePlaceholder(text)) return text;
		if (!this.#secretExpansionFreshForDisplay()) return undefined;
		return this.#expandLivePlaceholdersForDisplay(obfuscator, text);
	}

	#displaySecretExpander(): ((text: string) => string) | undefined {
		const obfuscator = this.#obfuscator;
		if (obfuscator === undefined || !obfuscator.hasSecrets()) return undefined;
		let fresh: boolean | undefined;
		return (text: string): string => {
			if (!obfuscator.containsDisplayRestorablePlaceholder(text)) return text;
			fresh ??= this.#secretExpansionFreshForDisplay();
			if (!fresh) return text;
			return this.#expandLivePlaceholdersForDisplay(obfuscator, text) ?? text;
		};
	}

	#expandLivePlaceholdersForDisplay(obfuscator: SecretObfuscator, text: string): string | undefined {
		try {
			const expanded = obfuscator.deobfuscateForDisplay(text);
			if (expanded !== text) return expanded;
			this.#noteDegradedSecretDisplay(
				"A secret placeholder is shown unexpanded because the expansion was refused.",
				"A display expansion returned unchanged text for a restorable placeholder; rendering it literally",
			);
			return undefined;
		} catch (error) {
			this.#noteDegradedSecretDisplay(
				"A secret placeholder is shown unexpanded because the expansion was refused.",
				"Refused a secret expansion on a display path; rendering the placeholder literally",
				error,
			);
			return undefined;
		}
	}

	#tryExpandSecretsForDiskComparison(text: string): string | undefined {
		const obfuscator = this.#obfuscator;
		if (obfuscator === undefined || !obfuscator.containsLivePlaceholder(text)) return text;
		if (!this.#secretExpansionFreshForDisplay()) return undefined;
		try {
			return obfuscator.deobfuscate(text);
		} catch (error) {
			logger.warn("Refused a secret expansion for a streaming-edit disk comparison; skipping the check", {
				sessionId: this.sessionManager.getSessionId(),
				error: errorMessage(error),
			});
			return undefined;
		}
	}

	#redactForLog(text: string): string {
		const obfuscator = this.#obfuscator;
		if (obfuscator === undefined || !obfuscator.hasSecrets()) return text;
		try {
			return obfuscator.obfuscate(text);
		} catch {
			return "<redacted: could not be safely rendered>";
		}
	}

	#secretExpansionFreshForDisplay(): boolean {
		const runtime = this.#secretRuntime;
		if (runtime === undefined) return true;
		let fresh: boolean;
		try {
			fresh = runtime.isFreshForExpansion();
		} catch (error) {
			this.#noteDegradedSecretDisplay(
				"Secret placeholders are shown unexpanded because the vault revision could not be read.",
				"Could not read the vault revision while rendering; showing placeholders literally",
				error,
			);
			return false;
		}
		if (fresh) return true;
		this.#scheduleStaleSecretRuntimeRefresh();
		this.#noteDegradedSecretDisplay(
			"The secret vault changed in another session or process, so secret placeholders are shown unexpanded until the refresh lands.",
			"Rendering secret placeholders literally because the captured vault revision is stale",
		);
		return false;
	}

	async #awaitSecretExpansionRefreshForRender(carriesLivePlaceholder: boolean): Promise<void> {
		const runtime = this.#secretRuntime;
		if (!carriesLivePlaceholder || runtime === undefined) return;
		try {
			await runtime.ensureFreshForExpansion();
		} catch (error) {
			this.#noteDegradedSecretDisplay(
				"The secret vault changed in another session or process and could not be re-read, so secret placeholders are shown unexpanded.",
				"Failed to refresh a stale secret runtime before a render expansion",
				error,
			);
		}
	}

	#scheduleStaleSecretRuntimeRefresh(): void {
		if (this.#staleSecretRuntimeRefreshInFlight || this.#refreshSecretRuntime === undefined) return;
		this.#staleSecretRuntimeRefreshInFlight = true;
		void this.refreshSecrets({ refreshPrompt: false })
			.catch(error => {
				logger.warn("Failed to refresh a stale secret runtime for display", { error: errorMessage(error) });
			})
			.finally(() => {
				this.#staleSecretRuntimeRefreshInFlight = false;
			});
	}

	#noteDegradedSecretDisplay(notice: string, logMessage: string, error?: unknown): void {
		logger.warn(logMessage, {
			sessionId: this.sessionManager.getSessionId(),
			...(error === undefined ? {} : { error: errorMessage(error) }),
		});
		noteSecretsCondition(notice);
	}

	#contentCarriesLivePlaceholder(content: AssistantMessage["content"]): boolean {
		const obfuscator = this.#obfuscator;
		if (obfuscator === undefined || !obfuscator.hasSecrets()) return false;
		let found = false;
		mapAssistantContentStrings(
			content,
			text => {
				found ||= obfuscator.containsDisplayRestorablePlaceholder(text);
				return text;
			},
			{ includeToolMetadata: true },
		);
		return found;
	}

	#messagesCarryLivePlaceholder(messages: AgentMessage[]): boolean {
		const obfuscator = this.#obfuscator;
		if (obfuscator === undefined || !obfuscator.hasSecrets()) return false;
		let found = false;
		mapAgentMessageStrings(messages, text => {
			found ||= obfuscator.containsDisplayRestorablePlaceholder(text);
			return text;
		});
		return found;
	}

	#deobfuscateSessionContextForDisplay(context: SessionContext): SessionContext {
		const expand = this.#displaySecretExpander();
		if (expand === undefined) return context;
		const messages = mapAgentMessageStrings(context.messages, expand);
		return messages === context.messages ? context : { ...context, messages };
	}

	displayAssistantContent(content: AssistantMessage["content"]): AssistantMessage["content"] {
		const expand = this.#displaySecretExpander();
		let out =
			expand === undefined ? content : mapAssistantContentStrings(content, expand, { includeToolMetadata: true });
		if (this.#argot?.loaded) {
			out = expandAssistantContent(this.#argot, out);
		}
		return out;
	}

	displayToolIntent(intent: string | undefined): string | undefined {
		if (intent === undefined || intent === "") return intent;

		let out = this.#tryExpandSecretsForDisplay(intent) ?? intent;
		if (this.#argot?.loaded) {
			out = this.#argot.expand(out);
		}
		return out;
	}

	#processAgentEvent = async (event: AgentEvent): Promise<void> => {
		this.#handlePreEmission(event);
		const interruptedThinking = this.#handleInterruptedThinking(event);
		const persistenceSlot =
			event.type === "message_end" ? this.#createMessageEndPersistenceSlot(event.message) : undefined;
		const displayEvent = this.#prepareDisplayEvent(event);

		try {
			await this.#emitSessionEvent(displayEvent);
		} catch (error) {
			persistenceSlot?.release();
			throw error;
		}

		switch (event.type) {
			case "turn_start":
				this.#handleTurnStart();
				break;
			case "turn_end":
				this.#handleTurnEnd(event);
				break;
			case "tool_execution_end":
				await this.#handleToolExecutionEnd(event);
				break;
			case "message_update":
				await this.#handleMessageUpdate(event);
				break;
			case "message_end":
				await this.#handleMessageEnd(event, persistenceSlot, interruptedThinking);
				break;
			case "agent_end":
				await this.#handleAgentEnd();
				break;
		}
	};

	#handlePreEmission(event: AgentEvent): void {
		if (event.type === "tool_execution_start") {
			this.#verificationEvidence.recordToolStart(event);
			this.#recordToolExecutionStart(event);
		} else if (event.type === "tool_execution_end") {
			this.#verificationEvidence.recordToolEnd(event);
		} else if (event.type === "turn_start") {
			const usage = this.getSessionStats().tokens;
			this.#goalRuntime.onTurnStart(`turn-${++this.#goalTurnCounter}`, {
				input: usage.input,
				output: usage.output,
				cacheRead: usage.cacheRead,
				cacheWrite: usage.cacheWrite,
			});
		} else if (event.type === "message_end") {
			if (event.message.role === "toolResult") {
				const { toolName, toolCallId, details, isError } = event.message as {
					toolCallId?: string;
					toolName?: string;
					details?: { op?: string; path?: string; phases?: TodoPhase[] };
					isError?: boolean;
				};
				if (toolName === TOOL.todo) {
					this.#mutationsSinceLastTodoTouch = 0;
				} else if (!isError && toolName !== undefined && MID_RUN_TODO_NUDGE_MUTATING_TOOLS[toolName]) {
					this.#mutationsSinceLastTodoTouch++;
				}
				this.#todoReminderAwaitingProgress = false;
				if (toolName === TOOL.edit && details?.path) {
					this.#invalidateFileCacheForPath(details.path);
				}
				if (toolName === TOOL.todo && !isError && Array.isArray(details?.phases)) {
					this.setTodoPhases(details.phases);
					if (this.#isTodoInitResult(details, toolCallId)) {
						this.#scheduleReplanTitleRefresh();
					}
				}
			} else if (event.message.role === "assistant" && event.message.stopReason === "aborted") {
				const message = event.message as AssistantMessage;
				if (this.#planInternalAbortPending) {
					message.errorMessage = SILENT_ABORT_MARKER;
					message.errorId = AIError.create(AIError.Flag.SilentAbort);
					this.#planInternalAbortPending = false;
				} else if (this.#pendingAbortErrorId) {
					message.errorId = this.#pendingAbortErrorId;
					this.#pendingAbortErrorId = undefined;
				}
			}
		}
	}

	#handleInterruptedThinking(event: AgentEvent): CustomMessage<InterruptedThinkingDetails> | undefined {
		const interruptedThinkingMessage =
			event.type === "message_end" && event.message.role === "assistant"
				? this.#demoteInterruptedThinkingOnUserInterrupt(event.message as AssistantMessage)
				: undefined;
		if (interruptedThinkingMessage) {
			this.agent.appendMessage(interruptedThinkingMessage);
		}
		return interruptedThinkingMessage;
	}

	#prepareDisplayEvent(event: AgentEvent): AgentEvent {
		let displayEvent: AgentEvent = event;
		if (event.type === "message_start" && event.message.role === "assistant") {
			this.#argotStreamDisplay = new ArgotStreamDisplayDecoder(this.#argot);
		}
		if (
			event.type === "message_update" &&
			event.message.role === "assistant" &&
			this.#argotStreamDisplay !== undefined
		) {
			const streamEvent = event.assistantMessageEvent;
			const assistantMessageEvent = this.#argotStreamDisplay.decodeStreamEvent(streamEvent);
			const streamedContent = this.#argotStreamDisplay.decodeContent(event.message.content);
			const contentChanged = streamedContent !== event.message.content;
			const deltaChanged = assistantMessageEvent !== streamEvent;
			if (contentChanged || deltaChanged) {
				displayEvent = {
					...event,
					message: contentChanged ? { ...event.message, content: streamedContent } : event.message,
					assistantMessageEvent,
				};
			}
		}
		if (event.type === "message_end") {
			this.#argotStreamDisplay?.flush();
			this.#argotStreamDisplay = undefined;
		}
		if (event.type === "message_end" && event.message.role === "assistant") {
			this.#applyProviderReportedContextWindow(event.message as AssistantMessage);
		}
		if (
			(event.type === "message_end" || event.type === "message_start" || event.type === "turn_end") &&
			event.message?.role === "assistant"
		) {
			const message = event.message;
			const content = this.displayAssistantContent(message.content);
			if (content !== message.content) {
				displayEvent = { ...(displayEvent as typeof event), message: { ...message, content } };
			}
		}
		if (event.type === "agent_end") {
			const messages = event.messages.map(message =>
				message.role === "assistant"
					? (() => {
							const content = this.displayAssistantContent(message.content);
							return content === message.content ? message : { ...message, content };
						})()
					: message,
			);
			if (messages.some((message, index) => message !== event.messages[index])) {
				displayEvent = { ...(displayEvent as typeof event), messages };
			}
		}
		if (event.type === "tool_execution_start") {
			const intent = this.displayToolIntent(event.intent);
			if (intent !== event.intent) {
				displayEvent = { ...(displayEvent as typeof event), intent };
			}
		}
		return displayEvent;
	}

	#handleTurnStart(): void {
		this.#resetStreamingEditState();
		this.#ttsrManager?.resetBuffer();
	}

	#handleTurnEnd(event: Extract<AgentEvent, { type: "turn_end" }>): void {
		this.#ttsrManager?.incrementMessageCount();
		if (this.#toolChoiceQueue.hasInFlight) {
			const msg = event.message as AssistantMessage;
			if (msg.stopReason === "aborted" || msg.stopReason === "error") {
				this.#toolChoiceQueue.reject(msg.stopReason === "error" ? "error" : "aborted");
			} else {
				this.#toolChoiceQueue.resolve();
			}
		}
	}

	async #handleToolExecutionEnd(event: Extract<AgentEvent, { type: "tool_execution_end" }>): Promise<void> {
		if (event.toolName === TOOL.goal) {
			await this.#goalRuntime.onGoalToolCompleted();
		} else {
			await this.#goalRuntime.onToolCompleted(event.toolName);
		}
		this.#planModeReminderAwaitingProgress = false;
		if (this.#isPlanDecisionTool(event.toolName)) {
			this.#planModeReminderCount = 0;
			this.#planModeReminderAwaitingProgress = false;
		}
		if (this.#isTerminalYieldToolResult(event)) {
			const alreadyTerminated = this.#synchronouslyTerminatedYieldToolCallIds.delete(event.toolCallId);
			if (!alreadyTerminated) {
				this.#markTerminalYieldToolCall(event.toolCallId);
				this.agent.abort(TERMINAL_TOOL_RESULT_ABORT_REASON);
			}
		}
	}

	async #handleMessageUpdate(event: Extract<AgentEvent, { type: "message_update" }>): Promise<void> {
		if (this.#ttsrManager?.hasRules()) {
			const assistantEvent = event.assistantMessageEvent;
			let matchContext: TtsrMatchContext | undefined;
			let streamingToolCall: ToolCall | undefined;

			if (assistantEvent.type === "text_delta") {
				matchContext = { source: "text" };
			} else if (assistantEvent.type === "thinking_delta") {
				matchContext = { source: "thinking" };
			} else if (assistantEvent.type === "toolcall_delta") {
				streamingToolCall = this.#getStreamingToolCallBlock(event.message, assistantEvent.contentIndex);
				matchContext = this.#getTtsrToolMatchContext(streamingToolCall, assistantEvent.contentIndex);
			}

			if (matchContext && "delta" in assistantEvent) {
				const targetMessageTimestamp = event.message.role === "assistant" ? event.message.timestamp : undefined;
				const matches = this.#checkTtsrStream(assistantEvent.delta, matchContext, streamingToolCall);
				if (matches.length > 0 && this.#handleTtsrMatches(matches, matchContext, targetMessageTimestamp)) {
					return;
				}
				if (matchContext.source === "tool" && this.#ttsrManager?.hasAstRules()) {
					const astMatches = await this.#checkTtsrAstStream(matchContext, streamingToolCall);
					if (astMatches.length > 0 && this.#handleTtsrMatches(astMatches, matchContext, targetMessageTimestamp)) {
						return;
					}
				}
			}
		}

		if (
			event.assistantMessageEvent.type === "toolcall_start" ||
			event.assistantMessageEvent.type === "toolcall_delta" ||
			event.assistantMessageEvent.type === "toolcall_end"
		) {
			void this.#preCacheStreamingEditFile(event);
		}

		if (
			event.assistantMessageEvent.type === "toolcall_end" ||
			event.assistantMessageEvent.type === "toolcall_delta"
		) {
			this.#maybeAbortStreamingEdit(event);
		}
	}

	async #handleMessageEnd(
		event: Extract<AgentEvent, { type: "message_end" }>,
		persistenceSlot?: MessageEndPersistenceSlot,
		interruptedThinking?: CustomMessage<InterruptedThinkingDetails>,
	): Promise<void> {
		const persistMessageEnd = () => {
			if (event.message.role === "hookMessage" || event.message.role === "custom") {
				this.sessionManager.appendCustomMessageEntry(
					event.message.customType,
					event.message.content,
					event.message.display,
					event.message.details,
					event.message.attribution ?? "agent",
				);
				if (event.message.role === "custom" && event.message.customType === "ttsr-injection") {
					this.#markTtsrInjected(this.#extractTtsrRuleNames(event.message.details));
				}
			} else {
				this.#persistSessionMessageIfMissing(event.message);
			}
		};
		if (persistenceSlot) {
			await persistenceSlot.persist(persistMessageEnd);
		} else {
			persistMessageEnd();
		}
		if (interruptedThinking) {
			this.sessionManager.appendCustomMessageEntry(
				interruptedThinking.customType,
				interruptedThinking.content,
				interruptedThinking.display,
				interruptedThinking.details,
				interruptedThinking.attribution,
			);
		}

		if (event.message.role === "assistant") {
			await this.#handleAssistantMessageEnd(event.message as AssistantMessage);
		} else if (event.message.role === "toolResult") {
			await this.#handleToolResultMessageEnd(event.message);
		}
	}

	async #handleAssistantMessageEnd(assistantMsg: AssistantMessage): Promise<void> {
		this.#lastAssistantMessage = assistantMsg;
		if (assistantMsg.stopReason !== "error" && assistantMsg.duration !== undefined) {
			this.settings.getStorage()?.recordModelPerf(`${assistantMsg.provider}/${assistantMsg.model}`, {
				outputTokens: assistantMsg.usage.output,
				durationMs: assistantMsg.duration,
				ttftMs: assistantMsg.ttft,
			});
		}
		if (assistantMsg.disabledFeatures?.includes("priority") && this.#serviceTierByFamily.anthropic === "priority") {
			this.setServiceTierFamily("anthropic", undefined);
			this.emitNotice(
				"warning",
				`${PRIORITY_TIER_COMMAND_LABEL} rejected for this model; retried without it. It is now off.`,
				"priority",
			);
		}
		if (!this.#ttsrAbortPending) {
			this.#resolveTtsrResume();
		}
		this.#queueDeferredTtsrInjectionIfNeeded(assistantMsg);
		if (this.#handoffAbortController) {
			this.#skipPostTurnMaintenanceAssistantTimestamp = assistantMsg.timestamp;
		}
		const batchContinues = this.#unreplayableBatchContinues;
		if (assistantMsg.stopReason !== "error" && !this.#isEmptyAssistantStop(assistantMsg)) {
			this.#unreplayableBatchContinues = 0;
		}
		if (
			assistantMsg.stopReason !== "error" &&
			assistantMsg.stopReason !== "aborted" &&
			!this.#isEmptyAssistantStop(assistantMsg) &&
			(this.#retryAttempt > 0 || batchContinues > 0)
		) {
			if (this.#activeRetryFallback && this.model) {
				await this.#emitSessionEvent({
					type: "retry_fallback_succeeded",
					model: formatRetryFallbackSelector(this.model, this.thinkingLevel),
					role: this.#activeRetryFallback.role,
				});
			}
			const recoveredErrors = await this.#markPendingRecoveredRetryErrors(assistantMsg);
			await this.#emitSessionEvent({
				type: "auto_retry_end",
				success: true,
				attempt: this.#retryAttempt > 0 ? this.#retryAttempt : batchContinues,
				mode: this.#retryAttempt > 0 ? "retry" : "continue",
				recoveredErrors,
			});
			this.#clearPendingRecoveredRetryErrors();
			this.#retryAttempt = 0;
		}
		if (assistantMsg.provider === "opencode-go") {
			this.#modelRegistry.authStorage.recordUsageCost(assistantMsg.provider, assistantMsg.usage.cost.total, {
				sessionId: this.#activeProviderSessionId(),
				recordedAt: assistantMsg.timestamp,
				baseUrl: this.#modelRegistry.getProviderBaseUrl?.(assistantMsg.provider),
			});
		}
	}

	async #handleToolResultMessageEnd(message: ToolResultMessage): Promise<void> {
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
		const todoCallDidNotFail = details?.__synthetic === true || details?.__skipped === true;
		if (toolName === TOOL.todo && !todoCallDidNotFail) {
			const errorText = isError ? (content?.find(part => part.type === "text")?.text ?? "") : undefined;
			if (errorText === undefined) {
				this.#lastTodoFailureText = undefined;
			} else {
				const repeated = errorText === this.#lastTodoFailureText;
				this.#lastTodoFailureText = errorText;
				const reminderText = [
					"<system-reminder>",
					"todo failed, so todo progress is not visible to the user and the recorded board may be stale.",
					errorText ? `Failure: ${errorText}` : "Failure: todo returned an error.",
					repeated
						? "This is the same failure as the previous todo call, so retrying that payload cannot succeed. Treat todo as unusable for the rest of this turn and continue the work without it."
						: "Fix the todo payload and call todo again before continuing.",
					"</system-reminder>",
				].join("\n");
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
			const checkpointEntryId = this.sessionManager.getEntries().at(-1)?.id ?? null;
			this.#checkpointState = {
				checkpointMessageCount: this.agent.state.messages.length,
				checkpointEntryId,
				startedAt: details?.startedAt ?? new Date().toISOString(),
			};
			this.#pendingRewindReport = undefined;
			this.#lastCompletedRewind = undefined;
		}
		if (toolName === TOOL.rewind && !isError && this.#checkpointState) {
			const detailReport = typeof details?.report === "string" ? details.report.trim() : "";
			const textReport = content?.find(part => part.type === "text")?.text?.trim() ?? "";
			const report = detailReport || textReport;
			if (report.length > 0) {
				this.#pendingRewindReport = report;
			}
		}
	}

	async #handleAgentEnd(): Promise<void> {
		const settledMessages = this.agent.state.messages;
		const emitAgentEndNotification = async () => {
			await this.#emitAgentEndNotification(settledMessages);
		};
		const usage = this.getSessionStats().tokens;
		await this.#goalRuntime.onAgentEnd({
			currentUsage: {
				input: usage.input,
				output: usage.output,
				cacheRead: usage.cacheRead,
				cacheWrite: usage.cacheWrite,
			},
		});
		let fallbackAssistant: AssistantMessage | undefined;
		for (let i = settledMessages.length - 1; i >= 0; i--) {
			const message = settledMessages[i]!;
			if (message.role === "assistant") {
				fallbackAssistant = message;
				break;
			}
		}
		const msg = this.#lastAssistantMessage ?? fallbackAssistant;
		this.#lastAssistantMessage = undefined;
		if (!msg) {
			this.#lastSuccessfulYieldToolCallId = undefined;
			logger.debug("agent_end maintenance routing", {
				reason: "no-assistant-message",
				goalModeEnabled: this.#goalModeState?.enabled === true,
				goalStatus: this.#goalModeState?.goal.status,
			});
			await emitAgentEndNotification();
			return;
		}

		await this.#processAgentEndMaintenance(settledMessages, msg, emitAgentEndNotification);
	}

	async #processAgentEndMaintenance(
		settledMessages: AgentMessage[],
		msg: AssistantMessage,
		emitAgentEndNotification: () => Promise<void>,
	): Promise<void> {
		const successfulYieldMessage = this.#findSuccessfulYieldAssistantMessage(settledMessages);
		const yieldOnThisMessage = this.#assistantEndedWithSuccessfulYield(msg);

		const maintenanceRoute = (route: string, extra?: Record<string, unknown>) => {
			logger.debug("agent_end maintenance routing", {
				route,
				stopReason: msg.stopReason,
				provider: msg.provider,
				model: msg.model,
				contentBlocks: msg.content.length,
				hasToolCalls: msg.content.some(content => content.type === "toolCall"),
				hasText: msg.content.some(content => content.type === "text"),
				goalModeEnabled: this.#goalModeState?.enabled === true,
				goalStatus: this.#goalModeState?.goal.status,
				successfulYield: successfulYieldMessage !== undefined,
				...extra,
			});
		};
		maintenanceRoute("entered");

		if (
			msg.stopReason === "error" &&
			msg.provider === "github-copilot" &&
			AIError.is(AIError.classifyMessage(msg), AIError.Flag.AuthFailed)
		) {
			await this.#modelRegistry.authStorage.remove("github-copilot");
		}

		if (this.#skipPostTurnMaintenanceAssistantTimestamp === msg.timestamp) {
			this.#skipPostTurnMaintenanceAssistantTimestamp = undefined;
			this.#lastSuccessfulYieldToolCallId = undefined;
			maintenanceRoute("skip-post-turn-maintenance");
			await emitAgentEndNotification();
			return;
		}

		const activeGoal = this.#goalModeState?.enabled === true && this.#goalModeState.goal.status === "active";
		if (successfulYieldMessage || this.#yieldTerminationPending) {
			this.#lastSuccessfulYieldToolCallId = undefined;
			if (successfulYieldMessage && activeGoal) {
				maintenanceRoute(
					yieldOnThisMessage
						? "successful-yield-active-goal-checkCompaction"
						: "post-yield-trailing-stop-active-goal-checkCompaction",
				);
				const compactionTask = this.#checkCompaction(successfulYieldMessage);
				this.#trackPostPromptTask(compactionTask);
				await compactionTask;
			} else if (successfulYieldMessage) {
				maintenanceRoute("successful-yield-no-active-goal");
			} else {
				maintenanceRoute("post-yield-trailing-stop-suppressed");
			}
			await emitAgentEndNotification();
			return;
		}
		this.#lastSuccessfulYieldToolCallId = undefined;

		const settleState: SettleContinuationState = { awaitingUserAnswer: isAwaitingUserAnswer(msg) };
		if (await this.#handleEmptyAssistantStop(msg)) {
			maintenanceRoute("empty-stop-handled");
			await emitAgentEndNotification();
			return;
		}

		let compactionResult = COMPACTION_CHECK_NONE;
		let checkedCompaction = false;
		if (activeGoal) {
			maintenanceRoute("active-goal-pre-empt-checkCompaction");
			const compactionTask = this.#checkCompaction(msg);
			this.#trackPostPromptTask(compactionTask);
			compactionResult = await compactionTask;
			checkedCompaction = true;
			if (compactionResult.continuationScheduled || compactionResult.automaticContinuationBlocked) {
				maintenanceRoute("active-goal-pre-empt-compaction-handled", {
					continuationScheduled: compactionResult.continuationScheduled,
					automaticContinuationBlocked: compactionResult.automaticContinuationBlocked === true,
				});
				this.#resolveRetry();
				await emitAgentEndNotification();
				return;
			}
		}

		if (await this.#handleUnexpectedAssistantStop(msg, settleState)) {
			maintenanceRoute("unexpected-stop-handled");
			await emitAgentEndNotification();
			return;
		}

		if (this.#isRetryableReasonlessAbort(msg)) {
			const didRetry = await this.#handleRetryableError(msg, { allowModelFallback: false });
			if (didRetry) {
				await emitAgentEndNotification();
				return;
			}
		}

		if (msg.stopReason === "aborted") {
			this.#resolveRetry();
			this.#resetSessionStopContinuationState();
			await emitAgentEndNotification();
			return;
		}
		if (this.#isFireworksFastFallbackEligible(msg)) {
			const didRetry = await this.#handleRetryableError(msg, { fireworksFastFallback: true });
			if (didRetry) {
				await emitAgentEndNotification();
				return;
			}
		}
		if (this.#isRetryableError(msg)) {
			const didRetry = await this.#handleRetryableError(msg);
			if (didRetry) {
				await emitAgentEndNotification();
				return;
			}
		} else if (this.#isHardErrorFallbackEligible(msg)) {
			const didRetry = await this.#handleRetryableError(msg, { hardErrorFallback: true });
			if (didRetry) {
				await emitAgentEndNotification();
				return;
			}
		}
		if (await this.#continueAfterUnreplayableBatch(msg)) {
			await emitAgentEndNotification();
			return;
		}
		if (this.#isClassifierRefusal(msg)) {
			this.#removeAssistantMessageFromActiveContext(msg);
		}
		this.#resolveRetry();

		if (!checkedCompaction) {
			maintenanceRoute("bottom-checkCompaction");
			const compactionTask = this.#checkCompaction(msg);
			this.#trackPostPromptTask(compactionTask);
			compactionResult = await compactionTask;
		}
		const hasToolCalls = msg.content.some(content => content.type === "toolCall");
		if (hasToolCalls) {
			await emitAgentEndNotification();
			return;
		}
		if (compactionResult.continuationScheduled || compactionResult.automaticContinuationBlocked) {
			await emitAgentEndNotification();
			return;
		}
		if (msg.stopReason !== "error") {
			if (mayContinueAtSettle("rewind-checkpoint", settleState) && this.#enforceRewindBeforeYield()) {
				await emitAgentEndNotification();
				return;
			}
			const planModeContinuationScheduled =
				mayContinueAtSettle("plan-mode-decision", settleState) && (await this.#enforcePlanModeDecisionAtSettle());
			if (planModeContinuationScheduled) {
				await emitAgentEndNotification();
				return;
			}
			const todoContinuationScheduled = await this.#checkTodoCompletion(settleState);
			if (todoContinuationScheduled) {
				await emitAgentEndNotification();
				return;
			}
		}
		if (this.#hasPendingAsyncWake()) {
			await emitAgentEndNotification();
			return;
		}
		if (mayContinueAtSettle("verification-evidence", settleState) && this.#enforceVerificationBeforeFinalize()) {
			await emitAgentEndNotification();
			return;
		}
		if (mayContinueAtSettle("code-review", settleState) && this.#enforceCodeReviewBeforeFinalize()) {
			await emitAgentEndNotification();
			return;
		}
		await this.#emitSessionStopEvent(settledMessages, msg);
		await emitAgentEndNotification();
	}
	#ensureRetryPromise(): void {
		if (this.#retryPromise) return;
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#retryPromise = promise;
		this.#retryResolve = resolve;
	}

	#resolveRetry(): void {
		if (this.#retryResolve) {
			this.#retryResolve();
			this.#retryResolve = undefined;
			this.#retryPromise = undefined;
		}
	}

	async #endAnnouncedContinuationWait(finalError: string): Promise<void> {
		const attempt = this.#unreplayableBatchContinues;
		if (attempt === 0) return;
		this.#unreplayableBatchContinues = 0;
		await this.#emitSessionEvent({
			type: "auto_retry_end",
			success: false,
			attempt,
			mode: "continue",
			finalError,
		});
		this.#resolveRetry();
	}

	#ensureTtsrResumePromise(): void {
		if (this.#ttsrResumePromise) return;
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#ttsrResumePromise = promise;
		this.#ttsrResumeResolve = resolve;
	}

	#resolveTtsrResume(): void {
		if (!this.#ttsrResumeResolve) return;
		this.#ttsrResumeResolve();
		this.#ttsrResumeResolve = undefined;
		this.#ttsrResumePromise = undefined;
	}

	#ensurePostPromptTasksPromise(): void {
		if (this.#postPromptTasksPromise) return;
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#postPromptTasksPromise = promise;
		this.#postPromptTasksResolve = resolve;
	}

	#resolvePostPromptTasks(): void {
		if (!this.#postPromptTasksResolve) return;
		this.#postPromptTasksResolve();
		this.#postPromptTasksResolve = undefined;
		this.#postPromptTasksPromise = undefined;
	}

	#trackPostPromptTask(task: Promise<unknown>): void {
		this.#postPromptTasks.add(task);
		this.#ensurePostPromptTasksPromise();

		void task
			.catch(() => {})
			.finally(() => {
				this.#postPromptTasks.delete(task);
				if (this.#postPromptTasks.size === 0) {
					this.#resolvePostPromptTasks();
				}
			});
	}

	#schedulePostPromptTask(
		task: (signal: AbortSignal) => Promise<void>,
		options?: { delayMs?: number; generation?: number; onSkip?: (reason: PostPromptSkipReason) => void },
	): void {
		const delayMs = options?.delayMs ?? 0;
		const signal = this.#postPromptTasksAbortController.signal;
		const scheduled = (async () => {
			if (delayMs > 0) {
				try {
					await scheduler.wait(delayMs, { signal });
				} catch {
					return;
				}
			}
			if (signal.aborted) {
				options?.onSkip?.("aborted");
				return;
			}
			if (options?.generation !== undefined && this.#promptGeneration !== options.generation) {
				options.onSkip?.("stale-generation");
				return;
			}
			await task(signal);
		})();
		this.#trackPostPromptTask(scheduled);
	}

	#skipAgentContinue(reason: AgentContinueSkipReason, options: ScheduledAgentContinueOptions | undefined): void {
		logger.debug("agent.continue skipped after scheduling", { reason });
		options?.onSkip?.(reason);
	}

	#scheduleAgentContinue(options?: ScheduledAgentContinueOptions): void {
		this.#schedulePostPromptTask(
			async signal => {
				if (signal.aborted || this.#isDisposed || this.isCompacting || this.isGeneratingHandoff) {
					this.#skipAgentContinue("session-unavailable", options);
					return;
				}
				if (options?.shouldContinue && !options.shouldContinue()) {
					this.#skipAgentContinue("should-continue-false", options);
					return;
				}
				this.#beginInFlight();
				try {
					await this.#maybeRestoreRetryFallbackPrimary();
					if (signal.aborted || this.#isDisposed) {
						this.#skipAgentContinue("post-restore-unavailable", options);
						return;
					}
					await this.agent.continue();
				} catch (error) {
					logger.warn("agent.continue failed after scheduling", {
						error: errorMessage(error),
						stack: error instanceof Error ? error.stack : undefined,
					});
					options?.onError?.();
				} finally {
					this.#endInFlight();
				}
			},
			{
				delayMs: options?.delayMs,
				generation: options?.generation,
				onSkip: reason => this.#skipAgentContinue(reason, options),
			},
		);
	}

	#scheduleAutoContinuePrompt(generation: number): void {
		const continuePrompt = async () => {
			const eagerNudges = this.#buildPostCompactionEagerNudges();
			await this.#promptWithMessage(
				{
					role: "developer",
					content: [{ type: "text", text: turnControlPrompts["turn-control/auto-continue"].text }],
					attribution: "agent",
					timestamp: Date.now(),
				},
				turnControlPrompts["turn-control/auto-continue"].text,
				{
					skipPostPromptRecoveryWait: true,
					prependMessages: eagerNudges.length > 0 ? eagerNudges : undefined,
				},
			);
		};
		this.#schedulePostPromptTask(
			async signal => {
				await Promise.resolve();
				if (signal.aborted) return;
				await continuePrompt();
			},
			{ generation },
		);
	}

	async #cancelPostPromptTasks(): Promise<void> {
		this.#postPromptTasksAbortController.abort();
		this.#postPromptTasksAbortController = new AbortController();
		this.#resolveTtsrResume();

		const pendingTasks = Array.from(this.#postPromptTasks);
		if (pendingTasks.length === 0) {
			this.#resolvePostPromptTasks();
			return;
		}

		await Promise.allSettled(pendingTasks);
		if (this.#postPromptTasks.size === 0) {
			this.#resolvePostPromptTasks();
		}
	}

	async #waitForPostPromptRecovery(generation?: number): Promise<void> {
		while (true) {
			if (generation !== undefined && this.#promptGeneration !== generation) return;
			if (this.#retryPromise) {
				await this.#retryPromise;
				continue;
			}
			if (this.#ttsrResumePromise) {
				await this.#ttsrResumePromise;
				continue;
			}
			if (this.#postPromptTasksPromise) {
				await this.#postPromptTasksPromise;
				continue;
			}

			if (this.agent.state.isStreaming) {
				await this.agent.waitForIdle();
				continue;
			}
			break;
		}
	}

	#formatTtsrAbortReason(rules: Rule[]): string {
		const label = rules.length === 1 ? "rule" : "rules";
		const ruleNames = rules.map(rule => rule.name).join(", ");
		return `TTSR matched ${label}: ${ruleNames}`;
	}

	#renderRuleBody(rule: Rule): string {
		const argotEnabled = this.settings.get("argot.enabled") === true;
		return prompt.render(rule.content, {
			argot: argotEnabled,

			argotUnloaded: argotEnabled && this.#argot?.loaded !== true,
			cwd: this.sessionManager.getCwd(),
			matchedPath: this.#ttsrManager?.lastMatchedPath(rule.name),
		});
	}

	#deliverableTtsrMatches(matches: Rule[]): Rule[] {
		const deliverable: Rule[] = [];
		for (const rule of matches) {
			if (this.#renderRuleBody(rule).trim().length > 0) {
				deliverable.push(rule);
				continue;
			}

			const gated = rule.content.includes("{{#if");
			const message = "TTSR rule matched but its body renders empty, not delivering";
			const fields = { ruleName: rule.name, path: rule.path, gated };
			if (gated) logger.debug(message, fields);
			else logger.warn(message, fields);
		}
		return deliverable;
	}

	#getTtsrInjectionContent(): { content: string; rules: Rule[] } | undefined {
		if (this.#pendingTtsrInjections.length === 0) return undefined;
		const rules = this.#pendingTtsrInjections;
		const content = rules
			.map(r =>
				prompt.render(rulesPrompts["rules/ttsr-interrupt"].text, {
					name: r.name,
					path: this.#displayRulePath(r.path),
					content: this.#renderRuleBody(r),
				}),
			)
			.join("\n\n");
		this.#pendingTtsrInjections = [];
		return { content, rules };
	}

	#displayRulePath(rulePath: string): string {
		const cwdRel =
			relativePathWithinRoot(this.sessionManager.getCwd(), rulePath) ??
			this.#displayPathWithinRoot(this.sessionManager.getCwd(), rulePath);
		if (cwdRel) return cwdRel;
		const homeRel = relativePathWithinRoot(os.homedir(), rulePath);
		if (homeRel) return `~/${homeRel}`;
		return rulePath;
	}

	#displayPathWithinRoot(root: string, candidate: string): string | null {
		const relative = path.relative(path.resolve(root), path.resolve(candidate));
		return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : null;
	}

	#addPendingTtsrInjections(rules: Rule[]): void {
		const seen = new Set(this.#pendingTtsrInjections.map(rule => rule.name));
		for (const rule of rules) {
			if (seen.has(rule.name)) continue;
			this.#pendingTtsrInjections.push(rule);
			seen.add(rule.name);
		}
	}

	#extractTtsrToolCallId(matchContext: TtsrMatchContext): string | undefined {
		if (matchContext.source !== "tool") return undefined;
		const key = matchContext.streamKey;
		if (typeof key !== "string" || !key.startsWith("toolcall:")) return undefined;
		const id = key.slice("toolcall:".length);
		return id.length > 0 ? id : undefined;
	}

	#addPerToolTtsrInjections(toolCallId: string, rules: Rule[]): void {
		const bucket = this.#perToolTtsrInjections.get(toolCallId) ?? [];
		const seen = new Set(bucket.map(rule => rule.name));

		const claimedElsewhere = new Set<string>();
		for (const [otherId, otherBucket] of this.#perToolTtsrInjections) {
			if (otherId === toolCallId) continue;
			for (const rule of otherBucket) claimedElsewhere.add(rule.name);
		}
		const newlyAdded: string[] = [];
		for (const rule of rules) {
			if (seen.has(rule.name) || claimedElsewhere.has(rule.name)) continue;
			bucket.push(rule);
			seen.add(rule.name);
			newlyAdded.push(rule.name);
		}
		if (bucket.length === 0) return;
		this.#perToolTtsrInjections.set(toolCallId, bucket);

		if (newlyAdded.length > 0) {
			this.#ttsrManager?.markInjectedByNames(newlyAdded);
		}
	}

	#dropUndeliveredPerToolInjections(): void {
		if (this.#perToolTtsrInjections.size === 0 && this.#pendingTtsrToolReminders.length === 0) return;
		const undelivered = new Set<string>();
		for (const bucket of this.#perToolTtsrInjections.values()) {
			for (const rule of bucket) undelivered.add(rule.name);
		}

		for (const reminder of this.#pendingTtsrToolReminders) {
			for (const name of reminder.rules) undelivered.add(name);
		}
		this.#perToolTtsrInjections.clear();
		this.#pendingTtsrToolReminders = [];
		this.#ttsrManager?.releaseInjectedByNames(Array.from(undelivered));
	}

	#afterToolCall(ctx: AfterToolCallContext): AfterToolCallResult | undefined {
		if (
			this.#isTerminalYieldToolResult({
				toolName: ctx.toolCall.name,
				isError: ctx.isError,
				result: ctx.result,
			})
		) {
			this.#markTerminalYieldToolCall(ctx.toolCall.id);
			this.#synchronouslyTerminatedYieldToolCallIds.add(ctx.toolCall.id);
			this.agent.abort(TERMINAL_TOOL_RESULT_ABORT_REASON);
		}
		return this.#ttsrAfterToolCall(ctx);
	}

	#ttsrAfterToolCall(ctx: AfterToolCallContext): AfterToolCallResult | undefined {
		const rules = this.#perToolTtsrInjections.get(ctx.toolCall.id);
		if (!rules || rules.length === 0) return undefined;
		this.#perToolTtsrInjections.delete(ctx.toolCall.id);

		const details = ctx.result?.details;
		const skipped = isRecord(details) && details.__skipped === true;
		const ran = !ctx.isError && !skipped;
		const reminder = rules
			.map(r =>
				prompt.render(rulesPrompts["rules/ttsr-tool-reminder"].text, {
					name: r.name,
					path: this.#displayRulePath(r.path),
					content: this.#renderRuleBody(r),
					tool: ctx.toolCall.name,
					ran,
				}),
			)
			.join("\n\n");
		const ruleNames = rules.map(r => r.name.trim()).filter(n => n.length > 0);
		this.#pendingTtsrToolReminders.push({ content: reminder, rules: ruleNames });
		return undefined;
	}

	#takePendingTtsrToolReminders(): AgentMessage | null {
		if (this.#pendingTtsrToolReminders.length === 0) return null;
		const pending = this.#pendingTtsrToolReminders;
		this.#pendingTtsrToolReminders = [];
		return {
			role: "custom",
			customType: "ttsr-injection",
			content: pending.map(reminder => reminder.content).join("\n\n"),
			display: false,
			details: { rules: pending.flatMap(reminder => reminder.rules) },
			attribution: "agent",
			timestamp: Date.now(),
		};
	}

	#extractTtsrRuleNames(details: unknown): string[] {
		if (!isRecord(details)) {
			return [];
		}
		const rules = (details as { rules?: unknown }).rules;
		if (!Array.isArray(rules)) {
			return [];
		}
		return rules.filter((ruleName): ruleName is string => typeof ruleName === "string");
	}

	#markTtsrInjected(ruleNames: string[]): void {
		const uniqueRuleNames = Array.from(
			new Set(ruleNames.map(ruleName => ruleName.trim()).filter(ruleName => ruleName.length > 0)),
		);
		if (uniqueRuleNames.length === 0) {
			return;
		}
		this.#ttsrManager?.markInjectedByNames(uniqueRuleNames);
		this.sessionManager.appendTtsrInjection(uniqueRuleNames);
	}

	#findTtsrAssistantIndex(targetTimestamp: number | undefined): number {
		const messages = this.agent.state.messages;
		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i];
			if (message.role !== "assistant") {
				continue;
			}
			if (targetTimestamp === undefined || message.timestamp === targetTimestamp) {
				return i;
			}
		}
		return -1;
	}

	#shouldInterruptForTtsrMatch(matches: Rule[], matchContext: TtsrMatchContext): boolean {
		const globalMode = this.#ttsrManager?.getSettings().interruptMode ?? "always";
		for (const rule of matches) {
			const mode = rule.interruptMode ?? globalMode;
			if (mode === "never") continue;
			if (mode === "prose-only" && (matchContext.source === "text" || matchContext.source === "thinking"))
				return true;
			if (mode === "tool-only" && matchContext.source === "tool") return true;
			if (mode === "always") return true;
		}
		return false;
	}

	#queueDeferredTtsrInjectionIfNeeded(assistantMsg: AssistantMessage): void {
		if (assistantMsg.stopReason === "aborted" || assistantMsg.stopReason === "error") {
			this.#dropUndeliveredPerToolInjections();
		}
		if (this.#ttsrAbortPending || this.#pendingTtsrInjections.length === 0) {
			return;
		}
		if (assistantMsg.stopReason === "aborted" || assistantMsg.stopReason === "error") {
			this.#pendingTtsrInjections = [];
			return;
		}

		const injection = this.#getTtsrInjectionContent();
		if (!injection) {
			return;
		}
		this.agent.followUp({
			role: "custom",
			customType: "ttsr-injection",
			content: injection.content,
			display: false,
			details: { rules: injection.rules.map(rule => rule.name) },
			attribution: "agent",
			timestamp: Date.now(),
		});
		this.#ensureTtsrResumePromise();

		this.#scheduleAgentContinue({
			delayMs: 1,
			generation: this.#promptGeneration,
			onSkip: () => {
				this.#resolveTtsrResume();
			},
			shouldContinue: () => {
				if (this.agent.state.isStreaming || !this.agent.hasQueuedMessages()) {
					this.#resolveTtsrResume();
					return false;
				}
				return true;
			},
			onError: () => {
				this.#resolveTtsrResume();
			},
		});
	}

	#getStreamingToolCallBlock(message: AgentMessage, contentIndex: number): ToolCall | undefined {
		if (message.role !== "assistant") {
			return undefined;
		}

		const content = message.content;
		if (!Array.isArray(content) || contentIndex < 0 || contentIndex >= content.length) {
			return undefined;
		}

		const block = content[contentIndex];
		if (!block || typeof block !== "object" || block.type !== "toolCall") {
			return undefined;
		}

		return block as ToolCall;
	}

	#getTtsrToolMatchContext(toolCall: ToolCall | undefined, contentIndex: number): TtsrMatchContext {
		const context: TtsrMatchContext = { source: "tool" };
		if (!toolCall) {
			return context;
		}

		context.toolName = toolCall.name;
		context.streamKey = toolCall.id ? `toolcall:${toolCall.id}` : `tool:${toolCall.name}:${contentIndex}`;
		context.filePaths = this.#extractTtsrToolFilePaths(toolCall);
		return context;
	}

	#extractTtsrToolFilePaths(toolCall: ToolCall): string[] | undefined {
		const args = toolCall.arguments ?? {};
		const tools = this.agent.state.tools;
		const tool =
			tools.find(t => t.name === toolCall.name) ??
			tools.find(t => t.customWireName !== undefined && t.customWireName === toolCall.name);
		const toolPaths = tool?.matcherPaths?.(args);
		if (toolPaths && toolPaths.length > 0) {
			const normalized = toolPaths.flatMap(p => this.#normalizeTtsrPathCandidates(p));
			if (normalized.length > 0) return Array.from(new Set(normalized));
		}
		return this.#extractTtsrFilePathsFromArgs(args);
	}

	#checkTtsrStream(delta: string, matchContext: TtsrMatchContext, toolCall: ToolCall | undefined): Rule[] {
		const manager = this.#ttsrManager;
		if (!manager) {
			return [];
		}
		const entries = this.#resolveTtsrMatcherEntries(toolCall);
		if (entries) {
			const matches: Rule[] = [];
			for (const entry of entries) {
				matches.push(...manager.checkSnapshot(entry.digest, this.#perFileTtsrContext(matchContext, entry.path)));
			}
			return matches;
		}
		const digest = this.#resolveTtsrMatcherDigest(toolCall);
		if (digest !== undefined) {
			return manager.checkSnapshot(digest, matchContext);
		}
		return manager.checkDelta(delta, matchContext);
	}

	#resolveTtsrMatcherDigest(toolCall: ToolCall | undefined): string | undefined {
		const tool = this.#resolveTtsrTool(toolCall);
		return tool?.matcherDigest?.(toolCall?.arguments ?? {});
	}

	#resolveTtsrMatcherEntries(toolCall: ToolCall | undefined): readonly { path: string; digest: string }[] | undefined {
		const tool = this.#resolveTtsrTool(toolCall);
		const entries = tool?.matcherEntries?.(toolCall?.arguments ?? {});
		return entries && entries.length > 0 ? entries : undefined;
	}

	#resolveTtsrTool(toolCall: ToolCall | undefined) {
		if (!toolCall) return undefined;
		const tools = this.agent.state.tools;
		return (
			tools.find(t => t.name === toolCall.name) ??
			tools.find(t => t.customWireName !== undefined && t.customWireName === toolCall.name)
		);
	}

	#perFileTtsrContext(base: TtsrMatchContext, filePath: string): TtsrMatchContext {
		const filePaths = this.#normalizeTtsrPathCandidates(filePath);
		return {
			...base,
			filePaths: filePaths.length > 0 ? filePaths : [filePath],
			streamKey: base.streamKey ? `${base.streamKey}#${filePath}` : undefined,
		};
	}

	async #checkTtsrAstStream(matchContext: TtsrMatchContext, toolCall: ToolCall | undefined): Promise<Rule[]> {
		const manager = this.#ttsrManager;
		if (!manager) {
			return [];
		}
		const entries = this.#resolveTtsrMatcherEntries(toolCall);
		if (entries) {
			const matches: Rule[] = [];
			for (const entry of entries) {
				matches.push(
					...(await manager.checkAstSnapshot(entry.digest, this.#perFileTtsrContext(matchContext, entry.path))),
				);
			}
			return matches;
		}
		const digest = this.#resolveTtsrMatcherDigest(toolCall);
		if (digest === undefined) {
			return [];
		}
		return manager.checkAstSnapshot(digest, matchContext);
	}

	#handleTtsrMatches(
		rawMatches: Rule[],
		matchContext: TtsrMatchContext,
		targetMessageTimestamp: number | undefined,
	): boolean {
		const matches = this.#deliverableTtsrMatches(rawMatches);
		if (matches.length === 0) {
			return false;
		}

		const shouldInterrupt = this.#shouldInterruptForTtsrMatch(matches, matchContext);
		const matchedToolId = this.#extractTtsrToolCallId(matchContext);
		const perToolId = shouldInterrupt ? undefined : matchedToolId;
		if (perToolId) {
			this.#addPerToolTtsrInjections(perToolId, matches);
			this.#emitSessionEventDetached({ type: "ttsr_triggered", rules: matches }, "ttsr-per-tool");
			return false;
		}

		this.#addPendingTtsrInjections(matches);
		if (!shouldInterrupt) {
			return false;
		}

		this.#ttsrAbortPending = true;
		this.#ensureTtsrResumePromise();
		const abortReason = this.#formatTtsrAbortReason(matches);
		this.agent.abort(
			matchedToolId
				? createToolScopedAbortReason(
						abortReason,
						{ [matchedToolId]: abortReason },
						"TTSR interrupt on another tool call",
					)
				: abortReason,
		);

		this.#emitSessionEventDetached({ type: "ttsr_triggered", rules: matches }, "ttsr-interrupt");

		const retryToken = ++this.#ttsrRetryToken;
		const generation = this.#promptGeneration;
		this.#schedulePostPromptTask(
			async () => {
				if (this.#ttsrRetryToken !== retryToken) {
					this.#resolveTtsrResume();
					return;
				}

				const targetAssistantIndex = this.#findTtsrAssistantIndex(targetMessageTimestamp);
				if (!this.#ttsrAbortPending || this.#promptGeneration !== generation || targetAssistantIndex === -1) {
					this.#ttsrAbortPending = false;
					this.#pendingTtsrInjections = [];
					this.#dropUndeliveredPerToolInjections();
					this.#resolveTtsrResume();
					return;
				}
				this.#ttsrAbortPending = false;

				this.#dropUndeliveredPerToolInjections();
				const ttsrSettings = this.#ttsrManager?.getSettings();
				if (ttsrSettings?.contextMode === "discard") {
					this.agent.replaceMessages(this.agent.state.messages.slice(0, targetAssistantIndex));
				}

				const injection = this.#getTtsrInjectionContent();
				if (injection) {
					const details = { rules: injection.rules.map(rule => rule.name) };
					this.agent.appendMessage({
						role: "custom",
						customType: "ttsr-injection",
						content: injection.content,
						display: false,
						details,
						attribution: "agent",
						timestamp: Date.now(),
					});
					this.sessionManager.appendCustomMessageEntry(
						"ttsr-injection",
						injection.content,
						false,
						details,
						"agent",
					);
					this.#markTtsrInjected(details.rules);
				}
				try {
					await this.agent.continue();
				} catch {
					this.#resolveTtsrResume();
				}
			},
			{ delayMs: 50 },
		);
		return true;
	}

	#extractTtsrFilePathsFromArgs(args: unknown): string[] | undefined {
		if (!isRecord(args)) {
			return undefined;
		}

		const rawPaths: string[] = [];
		for (const [key, value] of Object.entries(args)) {
			const normalizedKey = key.toLowerCase();
			if (typeof value === "string" && (normalizedKey === "path" || normalizedKey.endsWith("path"))) {
				rawPaths.push(value);
				continue;
			}
			if (Array.isArray(value) && (normalizedKey === "paths" || normalizedKey.endsWith("paths"))) {
				for (const candidate of value) {
					if (typeof candidate === "string") {
						rawPaths.push(candidate);
					}
				}
			}
		}

		const normalizedPaths = rawPaths.flatMap(pathValue => this.#normalizeTtsrPathCandidates(pathValue));
		if (normalizedPaths.length === 0) {
			return undefined;
		}

		return Array.from(new Set(normalizedPaths));
	}

	#normalizeTtsrPathCandidates(rawPath: string): string[] {
		const trimmed = rawPath.trim();
		if (trimmed.length === 0) {
			return [];
		}

		const normalizedInput = trimmed.replaceAll("\\", "/");
		const candidates = new Set<string>([normalizedInput]);
		if (normalizedInput.startsWith("./")) {
			candidates.add(normalizedInput.slice(2));
		}

		const cwd = this.sessionManager.getCwd();
		const absolutePath = path.isAbsolute(trimmed) ? path.normalize(trimmed) : path.resolve(cwd, trimmed);
		candidates.add(absolutePath.replaceAll("\\", "/"));

		const relativePath = path.relative(cwd, absolutePath).replaceAll("\\", "/");
		if (relativePath && relativePath !== "." && !relativePath.startsWith("../") && relativePath !== "..") {
			candidates.add(relativePath);
		}

		return Array.from(candidates);
	}

	#findLastAssistantMessage(): AssistantMessage | undefined {
		const messages = this.agent.state.messages;
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i];
			if (msg.role === "assistant") {
				return msg as AssistantMessage;
			}
		}
		return undefined;
	}

	#resetStreamingEditState(): void {
		this.#streamingEditAbortTriggered = false;
		this.#streamingEditCheckedLineCounts.clear();
		this.#streamingEditPrecheckedToolCallIds.clear();
		this.#streamingEditFileCache.clear();
	}

	#activeToolCallLoopGuard(): ToolCallLoopGuard | undefined {
		if (this.settings.get("model.toolCallLoopGuard.enabled") !== true) {
			this.#toolCallLoopGuard = undefined;
			this.#toolCallLoopGuardSettingsKey = undefined;
			return undefined;
		}

		const threshold = this.settings.get("model.toolCallLoopGuard.threshold");
		const readSubsumptionThreshold = this.settings.get("model.toolCallLoopGuard.readSubsumptionThreshold");
		const exemptTools = this.settings
			.get("model.toolCallLoopGuard.exemptTools")
			.filter((tool): tool is string => typeof tool === "string" && tool.length > 0);
		const settingsKey = `${threshold}:${readSubsumptionThreshold}:${JSON.stringify(exemptTools)}`;
		if (!this.#toolCallLoopGuard || this.#toolCallLoopGuardSettingsKey !== settingsKey) {
			this.#toolCallLoopGuard = new ToolCallLoopGuard({ threshold, exemptTools, readSubsumptionThreshold });
			this.#toolCallLoopGuardSettingsKey = settingsKey;
		}
		return this.#toolCallLoopGuard;
	}

	#maybeInjectToolCallLoopRedirect(messages: AgentMessage[], detection: RepeatedToolCallDetection): void {
		const content = prompt.render(turnControlPrompts["turn-control/tool-call-loop-redirect"].text, {
			tool_name: detection.toolName,
			count: detection.count,
			arguments_summary: detection.argumentsSummary,
			result_summary: detection.resultSummary || "(no text result)",
		});
		const details = {
			toolName: detection.toolName,
			count: detection.count,
			argumentsSummary: detection.argumentsSummary,
			resultSummary: detection.resultSummary,
		};
		logger.warn("cross-turn tool-call loop detected", {
			toolName: detection.toolName,
			count: detection.count,
		});
		const redirectMessage: CustomMessage = {
			role: "custom",
			customType: TOOL_CALL_LOOP_REDIRECT_TYPE,
			content,
			display: false,
			details,
			attribution: "agent",
			timestamp: Date.now(),
		};
		messages.push(redirectMessage);
		if (this.agent.state.messages !== messages) {
			this.agent.appendMessage(redirectMessage);
		}
		this.sessionManager.appendCustomMessageEntry(TOOL_CALL_LOOP_REDIRECT_TYPE, content, false, details, "agent");
	}

	#geminiHeaderGuardActive(): boolean {
		const model = this.model;
		return (
			process.env.VEYYON_NO_THINKING_LOOP_GUARD !== "1" &&
			this.settings.get("model.loopGuard.enabled") === true &&
			this.settings.get("model.loopGuard.toolCallReminder") === true &&
			model !== undefined &&
			isGeminiThinkingModel(model)
		);
	}

	#maybeInterruptGeminiHeaderRunaway(message: AssistantMessage, event: AssistantMessageEvent): void {
		if (event.type === "thinking_start") {
			this.#geminiHeaderDetector = this.#geminiHeaderGuardActive() ? new GeminiHeaderRunDetector() : undefined;
			return;
		}
		const detector = this.#geminiHeaderDetector;
		if (!detector) return;
		if (event.type === "thinking_delta") {
			if (detector.push(event.delta)) this.#interruptGeminiHeaderRunaway(detector.count, message.timestamp);
			return;
		}

		if (event.type === "text_start" || event.type === "toolcall_start") {
			detector.reset();
		}
	}

	#interruptGeminiHeaderRunaway(headerCount: number, targetTimestamp: number): void {
		logger.warn("Gemini reasoning-header runaway; interrupting to require a tool call", {
			model: this.model?.id,
			provider: this.model?.provider,
			headers: headerCount,
		});
		this.emitNotice(
			"warning",
			`Interrupted ${headerCount} planning headers with no tool call; reminded the model to issue one.`,
			"loop-guard",
		);
		this.agent.abort(GEMINI_HEADER_INTERRUPT_REASON);
		const generation = this.#promptGeneration;
		this.#schedulePostPromptTask(async signal => {
			if (signal.aborted || this.#isDisposed || this.#promptGeneration !== generation) return;

			await this.agent.waitForIdle();
			if (signal.aborted || this.#isDisposed || this.#promptGeneration !== generation) return;
			const aborted = this.agent.state.messages.findLast(
				(m): m is AssistantMessage => m.role === "assistant" && m.timestamp === targetTimestamp,
			);
			if (aborted) this.#discardAssistantTurn(aborted);
			const content = prompt.render(turnControlPrompts["turn-control/gemini-tool-call-reminder"].text, {
				count: headerCount,
			});
			const details = { headers: headerCount };
			this.agent.appendMessage({
				role: "custom",
				customType: GEMINI_TOOL_REMINDER_TYPE,
				content,
				display: false,
				details,
				attribution: "agent",
				timestamp: Date.now(),
			});
			this.sessionManager.appendCustomMessageEntry(GEMINI_TOOL_REMINDER_TYPE, content, false, details, "agent");
			try {
				await this.agent.continue();
			} catch (err) {
				logger.warn("gemini tool-call reminder continue failed", { error: errorMessage(err) });
			}
		});
	}

	#getStreamingEditToolCall(event: AgentEvent):
		| {
				toolCall: ToolCall;
				path: string;
				resolvedPath: string;
				diff?: string;
				op?: string;
				rename?: string;
		  }
		| undefined {
		if (event.type !== "message_update") return undefined;
		if (event.message.role !== "assistant") return undefined;

		const contentIndex = event.assistantMessageEvent.contentIndex ?? 0;
		const messageContent = event.message.content;
		if (!Array.isArray(messageContent) || contentIndex < 0 || contentIndex >= messageContent.length) {
			return undefined;
		}

		const toolCall = messageContent[contentIndex] as ToolCall;
		if (toolCall.name !== TOOL.edit) return undefined;

		const args = toolCall.arguments;
		if (!isRecord(args)) return undefined;
		if ("old_text" in args || "new_text" in args) return undefined;

		const path = typeof args.path === "string" ? args.path : undefined;
		if (!path) return undefined;

		const resolvedPath = this.#resolveSessionFsPath(path);
		if (resolvedPath === undefined) return undefined;

		return {
			toolCall,
			path,
			resolvedPath,
			diff: typeof args.diff === "string" ? args.diff : undefined,
			op: typeof args.op === "string" ? args.op : undefined,
			rename: typeof args.rename === "string" ? args.rename : undefined,
		};
	}

	#lastStreamingEditToolCallId: string | undefined;
	#abortStreamingEditForAutoGeneratedPath(toolCall: ToolCall, path: string, resolvedPath: string): void {
		if (this.#lastStreamingEditToolCallId === toolCall.id) return;
		this.#lastStreamingEditToolCallId = toolCall.id;
		void assertEditableFile(resolvedPath, path).catch(err => {
			if (!(err instanceof ToolError)) return;
			if (this.#lastStreamingEditToolCallId !== toolCall.id) return;

			if (!this.#streamingEditAbortTriggered) {
				this.#streamingEditAbortTriggered = true;
				logger.warn("Streaming edit aborted due to auto-generated file guard", {
					toolCallId: toolCall.id,
					path,
				});
				this.agent.abort();
			}
		});
	}

	#preCacheStreamingEditFile(event: AgentEvent): void {
		if (this.#streamingEditAbortTriggered) return;
		if (event.type !== "message_update") return;

		const assistantEvent = event.assistantMessageEvent;
		if (
			assistantEvent.type !== "toolcall_start" &&
			assistantEvent.type !== "toolcall_delta" &&
			assistantEvent.type !== "toolcall_end"
		) {
			return;
		}

		const streamingEdit = this.#getStreamingEditToolCall(event);
		if (!streamingEdit) return;

		const shouldCheckAutoGenerated =
			!streamingEdit.toolCall.id || !this.#streamingEditPrecheckedToolCallIds.has(streamingEdit.toolCall.id);
		if (shouldCheckAutoGenerated) {
			if (streamingEdit.toolCall.id) {
				this.#streamingEditPrecheckedToolCallIds.add(streamingEdit.toolCall.id);
			}
			this.#abortStreamingEditForAutoGeneratedPath(
				streamingEdit.toolCall,
				streamingEdit.path,
				streamingEdit.resolvedPath,
			);
		}

		if (this.settings.get("edit.streamingAbort")) {
			this.#ensureFileCache(streamingEdit.resolvedPath);
		}
	}

	#ensureFileCache(resolvedPath: string): void {
		if (this.#streamingEditFileCache.has(resolvedPath)) return;

		try {
			const rawText = fs.readFileSync(resolvedPath, "utf-8");
			const { text } = stripBom(rawText);
			this.#streamingEditFileCache.set(resolvedPath, normalizeToLF(text));
		} catch {}
	}

	#invalidateFileCacheForPath(filePath: string): void {
		const resolvedPath = this.#resolveSessionFsPath(filePath);
		if (resolvedPath === undefined) return;
		this.#streamingEditFileCache.delete(resolvedPath);
	}

	#resolveSessionFsPath(filePath: string): string | undefined {
		const normalized = normalizeLocalScheme(filePath);
		if (normalized.startsWith("local:")) {
			return resolveLocalUrlToPath(normalized, this.#localProtocolOptions());
		}
		if (
			normalized.startsWith("agent://") ||
			normalized.startsWith("skill://") ||
			normalized.startsWith("rule://") ||
			normalized.startsWith("mcp://") ||
			normalized.startsWith("artifact://")
		) {
			return undefined;
		}
		return resolveToCwd(normalized, this.sessionManager.getCwd());
	}

	getTurnIndex(): number {
		let turns = 0;
		for (const message of this.agent.state.messages) {
			if (message.role === "assistant") turns++;
		}
		return turns;
	}

	#localProtocolOptions(): LocalProtocolOptions {
		return {
			getArtifactsDir: () => this.sessionManager.getArtifactsDir(),
			getSessionId: () => this.sessionManager.getSessionId(),
		};
	}

	#resolvePlanPath(planFilePath: string): string {
		return resolvePlanFilePath(planFilePath, {
			localProtocol: this.#localProtocolOptions(),
			cwd: this.sessionManager.getCwd(),
		});
	}

	#maybeAbortStreamingEdit(event: AgentEvent): void {
		if (!this.settings.get("edit.streamingAbort")) return;
		if (this.#streamingEditAbortTriggered) return;
		if (event.type !== "message_update") return;

		const assistantEvent = event.assistantMessageEvent;
		if (assistantEvent.type !== "toolcall_end" && assistantEvent.type !== "toolcall_delta") return;

		const streamingEdit = this.#getStreamingEditToolCall(event);
		if (!streamingEdit?.toolCall.id) return;

		const { toolCall, path, resolvedPath, diff, op, rename } = streamingEdit;
		if (!diff) return;
		if (op && op !== "update") return;

		if (!diff.includes("\n")) return;
		const lastNewlineIndex = diff.lastIndexOf("\n");
		if (lastNewlineIndex < 0) return;
		const diffForCheck = diff.endsWith("\n") ? diff : diff.slice(0, lastNewlineIndex + 1);
		if (diffForCheck.trim().length === 0) return;

		let normalizedDiff = normalizeDiff(diffForCheck.replace(/\r/g, ""));
		if (!normalizedDiff) return;

		if (this.#obfuscator?.containsLivePlaceholder(normalizedDiff)) {
			const expanded = this.#tryExpandSecretsForDiskComparison(normalizedDiff);
			if (expanded === undefined) return;
			normalizedDiff = expanded;
		}
		if (!normalizedDiff) return;
		const lines = normalizedDiff.split("\n");
		const hasChangeLine = lines.some(line => line.startsWith("+") || line.startsWith("-"));
		if (!hasChangeLine) return;

		const lineCount = lines.length;
		const lastChecked = this.#streamingEditCheckedLineCounts.get(toolCall.id);
		if (lastChecked !== undefined && lineCount <= lastChecked) return;
		this.#streamingEditCheckedLineCounts.set(toolCall.id, lineCount);

		const removedLines = lines
			.filter(line => line.startsWith("-") && !line.startsWith("--- "))
			.map(line => line.slice(1));
		if (removedLines.length > 0) {
			let cachedContent = this.#streamingEditFileCache.get(resolvedPath);
			if (cachedContent === undefined) {
				this.#ensureFileCache(resolvedPath);
				cachedContent = this.#streamingEditFileCache.get(resolvedPath);
			}
			if (cachedContent !== undefined) {
				const missing = removedLines.find(line => !cachedContent.includes(normalizeToLF(line)));
				if (missing) {
					this.#streamingEditAbortTriggered = true;
					logger.warn("Streaming edit aborted due to patch preview failure", {
						toolCallId: toolCall.id,
						path,
						error: `Failed to find expected lines in ${path}:\n${this.#redactForLog(missing)}`,
					});
					this.agent.abort();
				}
				return;
			}
			if (assistantEvent.type === "toolcall_delta") return;
			void this.#checkRemovedLinesAsync(toolCall.id, path, resolvedPath, removedLines);
			return;
		}

		if (assistantEvent.type === "toolcall_delta") return;
		void this.#checkPreviewPatchAsync(toolCall.id, path, rename, normalizedDiff);
	}

	async #checkRemovedLinesAsync(
		toolCallId: string,
		path: string,
		resolvedPath: string,
		removedLines: string[],
	): Promise<void> {
		if (this.#streamingEditAbortTriggered) return;
		try {
			const { text } = stripBom(await Bun.file(resolvedPath).text());
			const normalizedContent = normalizeToLF(text);
			const missing = removedLines.find(line => !normalizedContent.includes(normalizeToLF(line)));
			if (missing) {
				this.#streamingEditAbortTriggered = true;
				logger.warn("Streaming edit aborted due to patch preview failure", {
					toolCallId,
					path,
					error: `Failed to find expected lines in ${path}:\n${this.#redactForLog(missing)}`,
				});
				this.agent.abort();
			}
		} catch (err) {
			if (!isEnoent(err)) {
			}
		}
	}

	async #checkPreviewPatchAsync(
		toolCallId: string,
		path: string,
		rename: string | undefined,
		normalizedDiff: string,
	): Promise<void> {
		if (this.#streamingEditAbortTriggered) return;
		try {
			await previewPatch(
				{ path, op: "update", rename, diff: normalizedDiff },
				{
					cwd: this.sessionManager.getCwd(),
					allowFuzzy: this.settings.get("edit.fuzzyMatch"),
					fuzzyThreshold: this.settings.get("edit.fuzzyThreshold"),
				},
			);
		} catch (error) {
			if (error instanceof ParseError) return;
			this.#streamingEditAbortTriggered = true;
			logger.warn("Streaming edit aborted due to patch preview failure", {
				toolCallId,
				path,
				error: errorMessage(error),
			});
			this.agent.abort();
		}
	}

	#resetSessionStopContinuationState(): void {
		this.#sessionStopContinuationCount = 0;
		this.#sessionStopHookActive = false;
	}

	#clearPendingSessionStopContinuations(): void {
		if (!this.#pendingNextTurnMessages.some(message => message.customType === "session-stop-continuation")) {
			return;
		}
		this.#pendingNextTurnMessages = this.#pendingNextTurnMessages.filter(
			message => message.customType !== "session-stop-continuation",
		);
	}

	#sessionStopContinuationContext(result: SessionStopEventResult | undefined): string | undefined {
		if (!result) return undefined;
		const additionalContext =
			typeof result.additionalContext === "string" && result.additionalContext.length > 0
				? result.additionalContext
				: undefined;
		const reason = typeof result.reason === "string" && result.reason.length > 0 ? result.reason : undefined;
		if (result.continue === true) {
			return additionalContext ?? reason;
		}
		if (result.decision === "block") {
			return reason ?? additionalContext;
		}
		return undefined;
	}

	async #emitAgentEndNotification(messages: AgentMessage[]): Promise<void> {
		await this.#extensionRunner?.emit({ type: "agent_end", messages });
	}

	async #emitSessionStopEvent(
		messages: AgentMessage[],
		lastAssistantMessage = this.getLastAssistantMessage(),
	): Promise<void> {
		if (this.#abortInProgress || this.#isDisposed) {
			this.#resetSessionStopContinuationState();
			return;
		}
		if (this.#agentKind === "sub" || !this.#extensionRunner?.hasHandlers("session_stop")) return;
		const generation = this.#promptGeneration;
		const result = await this.#extensionRunner.emitSessionStop({
			messages,
			turn_id: Math.max(0, this.#turnIndex - 1),
			last_assistant_message: lastAssistantMessage,
			session_id: this.sessionId,
			session_file: this.sessionFile,
			stop_hook_active: this.#sessionStopHookActive,
		});
		if (this.#promptGeneration !== generation || this.#abortInProgress || this.#isDisposed) {
			this.#resetSessionStopContinuationState();
			return;
		}
		const additionalContext = this.#sessionStopContinuationContext(result);
		if (!additionalContext) {
			this.#resetSessionStopContinuationState();
			return;
		}
		if (this.#sessionStopContinuationCount >= SESSION_STOP_CONTINUATION_CAP) {
			logger.warn("session_stop continuation cap reached", {
				sessionId: this.sessionId,
				cap: SESSION_STOP_CONTINUATION_CAP,
			});
			this.#resetSessionStopContinuationState();
			return;
		}
		this.#sessionStopContinuationCount++;
		this.#sessionStopHookActive = true;
		this.#queueHiddenNextTurnMessage(
			{
				role: "custom",
				customType: "session-stop-continuation",
				content: additionalContext,
				display: false,
				attribution: "agent",
				timestamp: Date.now(),
			},
			true,
		);
	}

	async #emitExtensionEvent(event: AgentSessionEvent): Promise<void> {
		if (!this.#extensionRunner) return;
		if (event.type === "agent_start") {
			this.#turnIndex = 0;
			await this.#extensionRunner.emit({ type: "agent_start" });
			return;
		}

		if (!this.#extensionRunner.hasHandlers(event.type)) return;
		if (event.type === "agent_end") {
		} else if (event.type === "turn_start") {
			const hookEvent: TurnStartEvent = {
				type: "turn_start",
				turnIndex: this.#turnIndex,
				timestamp: Date.now(),
			};
			await this.#extensionRunner.emit(hookEvent);
		} else if (event.type === "turn_end") {
			const hookEvent: TurnEndEvent = {
				type: "turn_end",
				turnIndex: this.#turnIndex,
				message: event.message,
				toolResults: event.toolResults,
			};
			await this.#extensionRunner.emit(hookEvent);
			this.#turnIndex++;
		} else if (event.type === "message_start") {
			const extensionEvent: MessageStartEvent = {
				type: "message_start",
				message: event.message,
			};
			await this.#extensionRunner.emit(extensionEvent);
		} else if (event.type === "message_update") {
			const extensionEvent: MessageUpdateEvent = {
				type: "message_update",
				message: event.message,
				assistantMessageEvent: event.assistantMessageEvent,
			};
			await this.#extensionRunner.emit(extensionEvent);
		} else if (event.type === "message_end") {
			const extensionEvent: MessageEndEvent = {
				type: "message_end",
				message: event.message,
			};
			await this.#extensionRunner.emit(extensionEvent);
		} else if (event.type === "tool_execution_start") {
			const extensionEvent: ToolExecutionStartEvent = {
				type: "tool_execution_start",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
				intent: event.intent,
			};
			await this.#extensionRunner.emit(extensionEvent);
		} else if (event.type === "tool_execution_update") {
			const extensionEvent: ToolExecutionUpdateEvent = {
				type: "tool_execution_update",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
				partialResult: event.partialResult,
			};
			await this.#extensionRunner.emit(extensionEvent);
		} else if (event.type === "tool_execution_end") {
			const extensionEvent: ToolExecutionEndEvent = {
				type: "tool_execution_end",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				result: event.result,
				isError: event.isError ?? false,
			};
			await this.#extensionRunner.emit(extensionEvent);
		} else if (event.type === "auto_compaction_start") {
			await this.#extensionRunner.emit({
				type: "auto_compaction_start",
				reason: event.reason,
				action: event.action,
			});
		} else if (event.type === "auto_compaction_end") {
			await this.#extensionRunner.emit({
				type: "auto_compaction_end",
				action: event.action,
				result: event.result,
				aborted: event.aborted,
				willRetry: event.willRetry,
				errorMessage: event.errorMessage,
				skipped: event.skipped,
			});
		} else if (event.type === "auto_retry_start") {
			await this.#extensionRunner.emit({
				type: "auto_retry_start",
				attempt: event.attempt,
				maxAttempts: event.maxAttempts,
				delayMs: event.delayMs,
				errorMessage: event.errorMessage,
				errorId: event.errorId,
				mode: event.mode,
			});
		} else if (event.type === "auto_retry_end") {
			await this.#extensionRunner.emit({
				type: "auto_retry_end",
				success: event.success,
				attempt: event.attempt,
				finalError: event.finalError,
				mode: event.mode,
				recoveredErrors: event.recoveredErrors,
			});
		} else if (event.type === "ttsr_triggered") {
			await this.#extensionRunner.emit({ type: "ttsr_triggered", rules: event.rules });
		} else if (event.type === "todo_reminder") {
			await this.#extensionRunner.emit({
				type: "todo_reminder",
				todos: event.todos,
				attempt: event.attempt,
				maxAttempts: event.maxAttempts,
			});
		} else if (event.type === "goal_updated") {
			await this.#extensionRunner.emit({
				type: "goal_updated",
				goal: event.goal,
				state: event.state,
			});
		}
	}

	rescopeToCwd(cwd: string): Promise<void> {
		return this.#runScopeTransition(() => this.#rescopeToCwd(cwd));
	}

	async #rescopeToCwd(cwd: string): Promise<void> {
		const normalizedCwd = path.resolve(cwd);
		if (this.#lastRescopedCwd === normalizedCwd) return;

		await this.settings.reloadForCwd(normalizedCwd);

		if (!this.#isSubagent) await this.#rescopeProcessToCwd(normalizedCwd);
		await this.#refreshSecrets({ refreshPrompt: false });
		await this.refreshSshTool({ activateIfAvailable: true });
		await this.refreshBaseSystemPrompt("cwd-change");
		this.#lastRescopedCwd = normalizedCwd;
	}

	async #rescopeProcessToCwd(cwd: string): Promise<void> {
		setProjectDir(cwd);

		applyProviderGlobalsFromSettings(this.settings);
		clearClaudePluginRootsCache();
		resetCapabilities();
	}

	setCwd(newCwd: string, options?: { validate?: boolean }): Promise<string> {
		return this.#runScopeTransition(() => this.#setCwd(newCwd, options));
	}

	async #setCwd(newCwd: string, options?: { validate?: boolean }): Promise<string> {
		const previous = this.sessionManager.getCwd();
		const cwd = await this.sessionManager.setCwd(newCwd, options);
		if (cwd === previous) {
			await this.#rescopeToCwd(cwd);
			return cwd;
		}

		try {
			await this.#rescopeToCwd(cwd);
		} catch (error) {
			this.#lastRescopedCwd = undefined;
			try {
				await this.sessionManager.setCwd(previous, { validate: false });
				await this.#rescopeToCwd(previous);
			} catch (rollbackError) {
				throw new AggregateError([error, rollbackError], `Failed to change cwd to ${cwd} and restore ${previous}.`);
			}
			throw error;
		}
		this.#recordCwdChange(previous, cwd);
		return cwd;
	}

	moveToCwd(newCwd: string, targetSessionDir?: string): Promise<string> {
		return this.#runScopeTransition(async () => {
			const previousCwd = this.sessionManager.getCwd();
			const previousSessionDir = this.sessionManager.getSessionDir();
			await this.sessionManager.moveTo(newCwd, targetSessionDir);
			const cwd = this.sessionManager.getCwd();
			if (cwd === previousCwd && this.sessionManager.getSessionDir() === previousSessionDir) {
				await this.#rescopeToCwd(cwd);
				return cwd;
			}

			try {
				await this.#rescopeToCwd(cwd);
			} catch (error) {
				this.#lastRescopedCwd = undefined;
				try {
					await this.sessionManager.moveTo(previousCwd, previousSessionDir);
					await this.#rescopeToCwd(previousCwd);
				} catch (rollbackError) {
					throw new AggregateError(
						[error, rollbackError],
						`Failed to move the session to ${cwd} and restore ${previousCwd}.`,
					);
				}
				throw error;
			}
			this.#recordCwdChange(previousCwd, cwd);
			return cwd;
		});
	}

	#recordCwdChange(previous: string, cwd: string): void {
		this.#wirePathRoots = normalizeRoots(cwd);
		const note = `Session working directory changed: ${previous} → ${cwd}`;
		const details = { previous, cwd };
		this.agent.appendMessage({
			role: "custom",
			customType: "cwd_changed",
			content: note,
			display: true,
			details,
			attribution: "agent",
			timestamp: Date.now(),
		});
		this.sessionManager.appendCustomMessageEntry("cwd_changed", note, true, details, "agent");
		this.#emit({ type: "cwd_changed", previous, cwd });
	}

	get wirePathBytesSaved(): number {
		return this.#wirePathBytesSaved;
	}

	get thoughtSignatureBytesSaved(): number {
		return this.#thoughtSignatureBytesSaved;
	}

	subscribe(listener: AgentSessionEventListener): () => void {
		this.#eventListeners.push(listener);

		return () => {
			const index = this.#eventListeners.indexOf(listener);
			if (index !== -1) {
				this.#eventListeners.splice(index, 1);
			}
		};
	}

	subscribeCommandMetadataChanged(listener: CommandMetadataChangedListener): () => void {
		this.#commandMetadataChangedListeners.push(listener);
		return () => {
			const index = this.#commandMetadataChangedListeners.indexOf(listener);
			if (index !== -1) {
				this.#commandMetadataChangedListeners.splice(index, 1);
			}
		};
	}

	#notifyCommandMetadataChanged(): void {
		const listeners = this.#commandMetadataChangedListeners.slice();
		for (const listener of listeners) {
			try {
				const result: unknown = listener();
				if (result instanceof Promise) {
					result.catch((err: unknown) => {
						logger.error("Command metadata listener threw", { err });
					});
				}
			} catch (err) {
				logger.error("Command metadata listener threw", { err });
			}
		}
	}

	#disconnectFromAgent(): void {
		if (this.#unsubscribeAgent) {
			this.#unsubscribeAgent();
			this.#unsubscribeAgent = undefined;
		}
	}

	#reconnectToAgent(): void {
		if (this.#unsubscribeAgent) return;
		this.#unsubscribeAgent = this.agent.subscribe(this.#handleAgentEvent);
	}

	#activeProviderSessionId(sessionId?: string): string {
		return this.#freshProviderSessionId ?? this.#providerSessionId ?? sessionId ?? this.sessionManager.getSessionId();
	}

	#adoptInheritedProviderPromptCacheKey(): void {
		const key = this.sessionManager.getHeader()?.providerPromptCacheKey;
		if (!key) return;
		if (this.#inheritedProviderPromptCacheKey !== undefined || this.agent.promptCacheKey === undefined) {
			this.agent.promptCacheKey = key;
			this.#inheritedProviderPromptCacheKey = key;
		}
	}

	#clearInheritedProviderPromptCacheKey(reason: string): void {
		const key = this.#inheritedProviderPromptCacheKey;
		this.#inheritedProviderPromptCacheKey = undefined;
		if (key === undefined) return;
		this.#providerCacheKeyDiscards.push(reason);
		logger.warn("provider prompt cache key discarded; the next request re-reads the whole context", {
			reason,
			discardsThisSession: this.#providerCacheKeyDiscards.length,
		});
		if (this.agent.promptCacheKey === key) {
			this.agent.promptCacheKey = undefined;
		}
	}

	providerCacheKeyDiscards(): readonly string[] {
		return Object.freeze(this.#providerCacheKeyDiscards.slice());
	}

	#syncAgentSessionId(sessionId?: string): void {
		const sid = this.#activeProviderSessionId(sessionId);
		this.agent.sessionId = sid;
		this.agent.setMetadataResolver((provider: string) =>
			buildSessionMetadata(sid, provider, this.#modelRegistry.authStorage),
		);
	}

	#rekeyHindsightMemoryForCurrentSessionId(): void {
		if (this.settings.get("memory.backend") !== "hindsight") return;
		const sid = this.agent.sessionId;
		if (!sid) return;
		this.getHindsightSessionState()?.setSessionId(sid);
	}

	#rekeyMnemopiMemoryForCurrentSessionId(): void {
		if (this.settings.get("memory.backend") !== "mnemopi") return;
		const sid = this.agent.sessionId;
		if (!sid) return;
		this.getMnemopiSessionState()?.setSessionId(sid);
	}

	#resetHindsightConversationTrackingIfHindsight(): boolean {
		if (this.settings.get("memory.backend") !== "hindsight") return false;
		const state = this.getHindsightSessionState();
		if (!state || state.aliasOf) return false;
		state.resetConversationTracking();
		return true;
	}

	#resetMnemopiConversationTrackingIfMnemopi(): boolean {
		if (this.settings.get("memory.backend") !== "mnemopi") return false;
		const state = this.getMnemopiSessionState();
		if (!state || state.aliasOf) return false;
		state.resetConversationTracking();
		return true;
	}

	#resetMemoryContextForNewTranscript(): void {
		this.#resetHindsightConversationTrackingIfHindsight();
		this.#resetMnemopiConversationTrackingIfMnemopi();
		this.#pendingVolatileMemoryContext = undefined;
		this.#deliveredVolatileMemoryContext = this.#lastDeliveredBlock(MEMORY_CONTEXT_MESSAGE_TYPE);

		this.#deliveredSessionState = this.#lastDeliveredBlock(SESSION_STATE_MESSAGE_TYPE);
	}

	#lastDeliveredBlock(customType: string): string | undefined {
		const messages = this.agent.state.messages;
		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i]!;
			if (message.role !== "custom" || message.customType !== customType) continue;
			return typeof message.content === "string" ? message.content : undefined;
		}
		return undefined;
	}

	get isDisposed(): boolean {
		return this.#isDisposed;
	}

	markMovedFromEmptySessionFile(sessionFile: string): void {
		this.#movedFromEmptySessionFile = path.resolve(sessionFile);
	}

	beginDispose(): void {
		this.#isDisposed = true;
		this.#flushPendingIrcAsides();
		this.yieldQueue.clear();
		this.agent.setAsideMessageProvider(undefined);
		this.agent.hasIrcInterrupts = undefined;
		this.#stopAdvisorRuntime();
		this.#evalExecutionDisposing = true;
	}

	#disposeCall?: Promise<void>;
	dispose(options: AgentSessionDisposeOptions = {}): Promise<void> {
		if (!this.#disposeCall) this.#disposeCall = this.#doDispose(options);
		return this.#disposeCall;
	}

	async #doDispose(options: AgentSessionDisposeOptions = {}): Promise<void> {
		this.beginDispose();
		this.#recordSessionExit(options.reason ?? "dispose");
		this.#cancelExitRecorder?.();
		this.#cancelExitRecorder = undefined;
		try {
			if (this.#extensionRunner?.hasHandlers("session_shutdown")) {
				await this.#extensionRunner.emit({ type: "session_shutdown" });
			}
		} catch (error) {
			logger.warn("Failed to emit session_shutdown event", { error: errorMessage(error) });
		}

		this.abortRetry();
		this.abortCompaction();
		const postPromptDrain = this.#cancelPostPromptTasks();
		this.agent.abort();
		await postPromptDrain;

		this.#cancelOwnAsyncJobs();
		const ownedAsyncManager = this.#ownedAsyncJobManager;
		if (ownedAsyncManager) {
			const drained = await ownedAsyncManager.dispose({ timeoutMs: 3_000 });
			const deliveryState = ownedAsyncManager.getDeliveryState();
			if (drained === false && deliveryState) {
				logger.warn("Async job completion deliveries still pending during dispose", { ...deliveryState });
			}
			if (AsyncJobManager.instance() === ownedAsyncManager) {
				AsyncJobManager.setInstance(undefined);
			}
		}
		const evalExecutionsSettled = await this.#prepareEvalExecutionsForDispose();
		if (!evalExecutionsSettled) {
			logger.warn("Detaching retained eval-kernel ownership during dispose while eval execution is still active");
		}

		try {
			await disposeOwnedResources("eval-kernel-owner", this.#evalKernelOwnerId);
		} catch (error) {
			logger.warn("Some owner-scoped resources failed to release during dispose", { error: errorMessage(error) });
		}

		const browserOwnerId = this.sessionManager.getSessionId();
		if (browserOwnerId) {
			try {
				await disposeOwnedResources("session", browserOwnerId);
			} catch (error) {
				logger.warn("Some session-scoped resources failed to release during dispose", {
					error: errorMessage(error),
				});
			}
		}
		await shutdownTinyTitleClient();
		this.#releasePowerAssertion();

		await cleanupEmptyMoveSession(this.sessionManager, this.#movedFromEmptySessionFile);
		this.#movedFromEmptySessionFile = undefined;
		await this.sessionManager.close();

		await this.#advisorRecorderClosed;
		this.#closeAllProviderSessions("dispose");

		if (this.#disconnectOwnedMcpManager) {
			try {
				await withTimeout(
					this.#disconnectOwnedMcpManager(),
					3_000,
					"Timed out disconnecting owned MCP manager during dispose",
				);
			} catch (error) {
				logger.warn("Failed to disconnect owned MCP manager during dispose", { error: errorMessage(error) });
			}
		}

		const hindsightState = this.getHindsightSessionState();
		await hindsightState?.flushRetainQueue();
		this.setHindsightSessionState(undefined);
		hindsightState?.dispose();
		const mnemopiState = setMnemopiSessionState(this, undefined);
		await mnemopiState?.dispose({ timeoutMs: options.mnemopiConsolidateTimeoutMs });

		await shutdownMnemopiEmbedClient();
		this.#disconnectFromAgent();
		if (this.#unsubscribeAppendOnly) {
			this.#unsubscribeAppendOnly();
			this.#unsubscribeAppendOnly = undefined;
		}
		if (this.#unsubscribeModelRoles) {
			this.#unsubscribeModelRoles();
			this.#unsubscribeModelRoles = undefined;
		}
		if (this.#unsubscribePromptSettings) {
			this.#unsubscribePromptSettings();
			this.#unsubscribePromptSettings = undefined;
		}
		this.#eventListeners = [];
	}

	#closeAllProviderSessions(reason: string): void {
		for (const [providerKey, state] of this.#providerSessionState) {
			try {
				state.close();
			} catch (error) {
				logger.warn("Failed to close provider session state", {
					providerKey,
					reason,
					error: errorMessage(error),
				});
			}
		}

		this.#providerSessionState.clear();
	}

	freshSession(): FreshSessionResult | undefined {
		if (this.isStreaming) return undefined;
		const previousSessionId = this.sessionId;
		const closedProviderSessions = this.#providerSessionState.size;
		this.#closeAllProviderSessions("fresh session");
		this.#freshProviderSessionId = Bun.randomUUIDv7();
		this.#syncAgentSessionId();
		this.#rekeyHindsightMemoryForCurrentSessionId();
		this.#rekeyMnemopiMemoryForCurrentSessionId();
		this.agent.appendOnlyContext?.invalidateForModelChange();
		return {
			previousSessionId,
			sessionId: this.sessionId,
			closedProviderSessions,
		};
	}

	get state(): AgentState {
		return this.agent.state;
	}

	get model(): Model | undefined {
		return this.agent.state.model;
	}

	#applyProviderReportedContextWindow(message: AssistantMessage): void {
		const reported = message.providerContextWindow;
		if (reported === undefined || !Number.isFinite(reported) || reported <= 0) return;
		const model = this.agent.state.model;
		if (!model) return;
		const changed = this.modelRegistry.recordProviderReportedContextWindow(model.provider, model.id, reported);
		if (model.contextWindow === reported) return;
		logger.debug("Adopting provider-reported context window", {
			model: `${model.provider}/${model.id}`,
			was: model.contextWindow,
			now: reported,
			registryUpdated: changed,
		});
		this.agent.state.model = { ...model, contextWindow: reported };
	}

	get thinkingLevel(): ThinkingLevel | undefined {
		return this.#thinkingLevel;
	}

	configuredThinkingLevel(): ConfiguredThinkingLevel | undefined {
		return this.#autoThinking ? AUTO_THINKING : this.#thinkingLevel;
	}

	get sessionThinkingOverride(): ConfiguredThinkingLevel | undefined {
		return this.#sessionThinkingOverride;
	}

	get isAutoThinking(): boolean {
		return this.#autoThinking;
	}

	autoResolvedThinkingLevel(): Effort | undefined {
		return this.#autoResolvedLevel;
	}

	#serviceTierByFamily: ServiceTierByFamily = {};

	get serviceTierByFamily(): ServiceTierByFamily {
		return this.#serviceTierByFamily;
	}

	get isStreaming(): boolean {
		return this.agent.state.isStreaming || this.#promptInFlightCount > 0;
	}

	get isAborting(): boolean {
		return this.agent.isAborting;
	}

	async waitForIdle(): Promise<void> {
		await this.agent.waitForIdle();
		await this.#waitForPostPromptRecovery();
	}

	async drainAsyncJobDeliveriesForAcp(options?: { timeoutMs?: number }): Promise<boolean> {
		const manager = this.#asyncJobManager;
		if (!manager) return false;
		const ownerFilter = this.#agentId ? { ownerId: this.#agentId } : undefined;
		const before = manager.getDeliveryState(ownerFilter);
		if (before.queued === 0 && !before.delivering) return false;
		const previousAllowAcpAgentInitiatedTurns = this.#allowAcpAgentInitiatedTurns;
		this.#allowAcpAgentInitiatedTurns = true;
		try {
			const drained = await manager.drainDeliveries({ timeoutMs: options?.timeoutMs, filter: ownerFilter });
			const after = manager.getDeliveryState(ownerFilter);
			return drained && (before.queued !== after.queued || before.delivering !== after.delivering);
		} finally {
			this.#allowAcpAgentInitiatedTurns = previousAllowAcpAgentInitiatedTurns;
		}
	}

	getLastAssistantMessage(): AssistantMessage | undefined {
		return this.#findLastAssistantMessage();
	}

	get systemPrompt(): string[] {
		return this.agent.state.systemPrompt;
	}

	get retryAttempt(): number {
		return this.#retryAttempt;
	}

	#collectDiscoverableMCPToolsFromRegistry(): Map<string, DiscoverableTool> {
		const mcpTools = filterBySource(collectDiscoverableTools(this.#toolRegistry.values()), "mcp");
		return new Map(mcpTools.map(tool => [tool.name, tool] as const));
	}

	#setDiscoverableMCPTools(discoverableMCPTools: Map<string, DiscoverableTool>): void {
		this.#discoverableMCPTools = discoverableMCPTools;
		this.#invalidateDiscoveryCaches();
	}

	#invalidateDiscoveryCaches(): void {
		this.#discoverableToolSearchIndex = null;
	}

	#filterSelectableMCPToolNames(toolNames: Iterable<string>): string[] {
		return Array.from(toolNames).filter(name => this.#discoverableMCPTools.has(name) && this.#toolRegistry.has(name));
	}

	#getConfiguredDefaultSelectedMCPToolNames(): string[] {
		return this.#filterSelectableMCPToolNames([
			...this.#defaultSelectedMCPToolNames,
			...selectDiscoverableToolNamesByServer(
				this.#discoverableMCPTools.values(),
				this.#defaultSelectedMCPServerNames,
			),
		]);
	}

	#pruneSelectedMCPToolNames(): void {
		this.#selectedMCPToolNames = new Set(this.#filterSelectableMCPToolNames(this.#selectedMCPToolNames));
	}

	#selectedMCPToolNamesMatch(left: string[], right: string[]): boolean {
		return left.length === right.length && left.every((name, index) => name === right[index]);
	}

	#rememberSessionDefaultSelectedMCPToolNames(
		sessionFile: string | null | undefined,
		toolNames: Iterable<string>,
	): void {
		if (!sessionFile) return;
		this.#sessionDefaultSelectedMCPToolNames.set(
			path.resolve(sessionFile),
			this.#filterSelectableMCPToolNames(toolNames),
		);
	}

	#getSessionDefaultSelectedMCPToolNames(sessionFile: string | null | undefined): string[] {
		if (!sessionFile) return [];
		return this.#sessionDefaultSelectedMCPToolNames.get(path.resolve(sessionFile)) ?? [];
	}

	#persistSelectedMCPToolNamesIfChanged(previousSelectedMCPToolNames: string[]): void {
		if (!this.#mcpDiscoveryEnabled) return;
		const nextSelectedMCPToolNames = this.getSelectedMCPToolNames();
		if (this.#selectedMCPToolNamesMatch(previousSelectedMCPToolNames, nextSelectedMCPToolNames)) {
			return;
		}
		this.sessionManager.appendMCPToolSelection(nextSelectedMCPToolNames);
	}

	#getActiveNonMCPToolNames(): string[] {
		return this.getActiveToolNames().filter(name => !isMCPToolName(name) && this.#toolRegistry.has(name));
	}

	getActiveToolNames(): string[] {
		return this.agent.state.tools.map(t => t.name);
	}

	get hasEditTool(): boolean {
		return this.#toolRegistry.has(TOOL.edit);
	}

	getToolByName(name: string): AgentTool | undefined {
		return this.#toolRegistry.get(name);
	}

	hasBuiltInTool(name: string): boolean {
		return this.#builtInToolNames.has(name);
	}

	getAllToolNames(): string[] {
		return Array.from(this.#toolRegistry.keys());
	}

	#wrapRuntimeTool(tool: AgentTool): AgentTool {
		const wrapped = wrapToolWithMetaNotice(tool);
		return this.#extensionRunner ? new ExtensionToolWrapper(wrapped, this.#extensionRunner) : wrapped;
	}

	async activateVibeTools(baseToolNames: string[]): Promise<void> {
		const createVibeTools = this.#createVibeTools;
		if (!createVibeTools) {
			throw new Error("Vibe tools are unavailable in this session.");
		}

		const tools = createVibeTools();
		const vibeToolNames = tools.map(tool => tool.name);
		if (new Set(vibeToolNames).size !== vibeToolNames.length) {
			throw new Error("Vibe tool names must be unique.");
		}

		for (const tool of tools) {
			if (this.#toolRegistry.has(tool.name)) continue;
			this.#toolRegistry.set(tool.name, this.#wrapRuntimeTool(tool));
			this.#builtInToolNames.add(tool.name);
			this.#installedVibeToolNames.add(tool.name);
		}

		await this.#applyActiveToolsByName(Array.from(new Set(baseToolNames.concat(vibeToolNames))));
	}

	async deactivateVibeTools(nextToolNames: string[]): Promise<void> {
		for (const name of this.#installedVibeToolNames) {
			this.#toolRegistry.delete(name);
			this.#builtInToolNames.delete(name);
			this.#selectedDiscoveredToolNames.delete(name);
		}
		this.#installedVibeToolNames.clear();
		await this.#applyActiveToolsByName(nextToolNames);
	}

	#getEditModeSession() {
		return {
			settings: this.settings,
			getActiveModelString: () => (this.model ? formatModelString(this.model) : undefined),
		} as const;
	}

	#resolveActiveEditMode(): EditMode {
		return resolveEditMode(this.#getEditModeSession());
	}

	#currentPromptModelKey(): string | undefined {
		const model = this.model ? formatModelString(this.model) : undefined;
		if (!model || this.settings.get("includeModelInPrompt")) return model;
		const taskPolicy = usesCodexTaskPrompt(model) ? "task-policy:gpt-5.6" : "task-policy:default";

		return usesCursorRuleDelivery(this.model) ? `${taskPolicy}:cursor-rules` : taskPolicy;
	}

	async #syncAfterModelChange(previousEditMode: EditMode): Promise<void> {
		const currentEditMode = this.#resolveActiveEditMode();
		const editModeChanged = previousEditMode !== currentEditMode && this.getActiveToolNames().includes(TOOL.edit);

		const modelChanged = this.#currentPromptModelKey() !== this.#promptModelKey;
		if (!editModeChanged && !modelChanged) return;
		const moved = [modelChanged ? "prompt-model-key" : undefined, editModeChanged ? "edit-mode" : undefined]
			.filter(part => part !== undefined)
			.join("+");
		await this.refreshBaseSystemPrompt(`model-switch:${moved}`);
	}

	isMCPDiscoveryEnabled(): boolean {
		return this.#mcpDiscoveryEnabled;
	}

	enableMCPDiscovery(): void {
		this.#mcpDiscoveryEnabled = true;
	}

	getSelectedMCPToolNames(): string[] {
		if (!this.#mcpDiscoveryEnabled) {
			return this.getActiveToolNames().filter(name => isMCPToolName(name) && this.#toolRegistry.has(name));
		}
		return this.#filterSelectableMCPToolNames(this.#selectedMCPToolNames);
	}

	async activateDiscoveredMCPTools(toolNames: string[]): Promise<string[]> {
		const nextSelectedMCPToolNames = new Set(this.#selectedMCPToolNames);
		const activated: string[] = [];
		for (const name of toolNames) {
			if (!isMCPToolName(name) || !this.#discoverableMCPTools.has(name) || !this.#toolRegistry.has(name)) {
				continue;
			}
			nextSelectedMCPToolNames.add(name);
			activated.push(name);
		}
		if (activated.length === 0) {
			return [];
		}
		const nextActive = this.#getActiveNonMCPToolNames().concat(
			this.#filterSelectableMCPToolNames(nextSelectedMCPToolNames),
		);
		await this.setActiveToolsByName(nextActive);
		return Array.from(new Set(activated));
	}

	#resolveEffectiveDiscoveryMode(): "off" | "mcp-only" | "all" {
		const mode = resolveEffectiveToolDiscoveryMode(
			this.settings,
			countToolsForAutoDiscovery(this.#toolRegistry.keys()),
		);
		if (mode !== "off") return mode;
		return this.#mcpDiscoveryEnabled ? "mcp-only" : "off";
	}

	isToolDiscoveryEnabled(): boolean {
		return this.#resolveEffectiveDiscoveryMode() !== "off";
	}

	getDiscoverableTools(filter?: { source?: DiscoverableTool["source"] }): DiscoverableTool[] {
		const mode = this.#resolveEffectiveDiscoveryMode();
		const activeNames = new Set(this.getActiveToolNames());
		const mcpTools = Array.from(this.#discoverableMCPTools.values()).filter(t => !activeNames.has(t.name));
		const localTools: DiscoverableTool[] = mode === "all" ? this.#collectDiscoverableLocalTools() : [];
		const allTools = localTools.concat(mcpTools);
		return filter?.source ? allTools.filter(t => t.source === filter.source) : allTools;
	}

	#collectDiscoverableLocalTools(): DiscoverableTool[] {
		const activeNames = new Set(this.getActiveToolNames());
		const result: DiscoverableTool[] = [];
		for (const tool of this.#toolRegistry.values()) {
			if (tool.loadMode !== "discoverable") continue;
			if (activeNames.has(tool.name)) continue;
			const source = this.#builtInToolNames.has(tool.name) ? "builtin" : "custom";
			const collected = collectDiscoverableTools([tool], { source });
			result.push(...collected);
		}
		return result;
	}

	getDiscoverableToolSearchIndex(): DiscoverableToolSearchIndex {
		if (!this.#discoverableToolSearchIndex) {
			this.#discoverableToolSearchIndex = buildDiscoverableToolSearchIndex(this.getDiscoverableTools());
		}
		return this.#discoverableToolSearchIndex;
	}

	#invalidateDiscoverableToolSearchIndex(): void {
		this.#invalidateDiscoveryCaches();
	}

	getSelectedDiscoveredToolNames(): string[] {
		const activeNames = new Set(this.getActiveToolNames());
		const mcpSelected = this.getSelectedMCPToolNames();
		const nonMcpSelected = Array.from(this.#selectedDiscoveredToolNames).filter(
			name => activeNames.has(name) && this.#toolRegistry.has(name) && !isMCPToolName(name),
		);
		return Array.from(new Set(mcpSelected.concat(nonMcpSelected)));
	}

	async activateDiscoveredTools(toolNames: string[]): Promise<string[]> {
		const mcpNames = toolNames.filter(isMCPToolName);
		const nonMcpNames = toolNames.filter(name => !isMCPToolName(name));
		const activated: string[] = [];

		if (mcpNames.length > 0) {
			const activatedMcp = await this.activateDiscoveredMCPTools(mcpNames);
			activated.push(...activatedMcp);
		}

		if (nonMcpNames.length > 0) {
			const currentActiveNames = new Set(this.getActiveToolNames());
			const newlyAdded: string[] = [];
			for (const name of nonMcpNames) {
				if (this.#toolRegistry.has(name) && !currentActiveNames.has(name)) {
					newlyAdded.push(name);
					this.#selectedDiscoveredToolNames.add(name);
					activated.push(name);
				}
			}
			if (newlyAdded.length > 0) {
				const nextActive = this.getActiveToolNames().concat(newlyAdded);
				await this.setActiveToolsByName(nextActive);
				this.#invalidateDiscoverableToolSearchIndex();
			}
		}

		return [...new Set(activated)];
	}

	#wrapToolForAcpPermission<T extends AgentTool>(tool: T): T {
		const bridge = this.#clientBridge;

		if (!bridge?.capabilities.requestPermission || !bridge.requestPermission) return tool;
		if (!PERMISSION_REQUIRED_TOOLS.has(tool.name)) return tool;

		if (this.#isExplicitAutoApproveMode()) {
			const userPolicies = (this.settings.get("tools.approval") ?? {}) as Record<string, unknown>;
			const toolPolicy = userPolicies[tool.name];
			if (!toolPolicy || toolPolicy === "allow") return tool;
		}
		return new Proxy(tool, {
			get: (target, prop) => {
				if (prop !== "execute") return target[prop as keyof T];
				return async (
					toolCallId: string,
					args: unknown,
					signal: AbortSignal | undefined,
					onUpdate: never,
					ctx: never,
				) => {
					const permissionIntent = getPermissionIntent(target.name, args);
					if (!permissionIntent) {
						return await target.execute(toolCallId, args as never, signal, onUpdate, ctx);
					}
					const command =
						target.name === TOOL.bash && isRecord(args)
							? getStringProperty(args as Record<string, unknown>, "command")
							: undefined;
					const commandContent = command
						? [{ type: "content" as const, content: { type: "text" as const, text: `$ ${command}` } }]
						: undefined;

					const persisted = this.#acpPermissionDecisions.get(permissionIntent.cacheKey);
					if (persisted === "allow_always") {
						return await target.execute(toolCallId, args as never, signal, onUpdate, ctx);
					}
					if (persisted === "reject_always") {
						throw new ToolError(`Tool call rejected by user (preference)`);
					}
					if (signal?.aborted) {
						throw new ToolAbortError("Permission request cancelled");
					}
					type PermissionRaceResult =
						| { kind: "permission"; outcome: ClientBridgePermissionOutcome }
						| { kind: "aborted" };
					const { promise: abortPromise, resolve: resolveAbort } = Promise.withResolvers<PermissionRaceResult>();
					const onAbort = () => resolveAbort({ kind: "aborted" });
					signal?.addEventListener("abort", onAbort, { once: true });
					let raced: PermissionRaceResult;
					try {
						const permissionPromise = bridge.requestPermission!(
							{
								toolCallId,
								toolName: target.name,
								title: permissionIntent.title,
								...(target.name === TOOL.bash ? { kind: "execute" } : {}),
								status: "pending",
								rawInput: args,
								...(commandContent ? { content: commandContent } : {}),
								locations: extractPermissionLocations(
									args,
									this.sessionManager.getCwd(),
									permissionIntent.paths,
								),
							},
							PERMISSION_OPTIONS,
							signal,
						).then(outcome => ({ kind: "permission" as const, outcome }));
						raced = await Promise.race([permissionPromise, abortPromise]);
					} finally {
						signal?.removeEventListener("abort", onAbort);
					}
					if (raced.kind === "aborted" || signal?.aborted) {
						throw new ToolAbortError("Permission request cancelled");
					}
					const outcome = raced.outcome;
					if (outcome.outcome === "cancelled") {
						throw new ToolAbortError("Permission request cancelled");
					}
					const selectedOption = PERMISSION_OPTIONS_BY_ID.get(outcome.optionId);
					if (!selectedOption) {
						throw new ToolError(`Tool permission response used unknown option ID: ${outcome.optionId}`);
					}
					if (selectedOption.kind === "allow_always") {
						this.#acpPermissionDecisions.set(permissionIntent.cacheKey, "allow_always");
					} else if (selectedOption.kind === "reject_always") {
						this.#acpPermissionDecisions.set(permissionIntent.cacheKey, "reject_always");
					}
					if (selectedOption.kind === "reject_once" || selectedOption.kind === "reject_always") {
						throw new ToolError(`Tool call rejected by user (${target.name})`);
					}
					return await target.execute(toolCallId, args as never, signal, onUpdate, ctx);
				};
			},
		}) as T;
	}

	#isExplicitAutoApproveMode(): boolean {
		return (
			this.#autoApprove ||
			this.isApprovalBypassed() ||
			(this.settings.isConfigured("tools.approvalMode") && this.settings.get("tools.approvalMode") === "yolo")
		);
	}

	effectiveApprovalMode(): ApprovalMode {
		return resolveEffectiveApprovalMode(this.settings.get("tools.approvalMode"), {
			planModeActive: this.getPlanModeState()?.enabled === true,
			cliAutoApprove: this.#autoApprove,
		});
	}

	isApprovalBypassed(): boolean {
		if (!this.#approvalBypassActive) return false;
		return this.#parentApprovalBypassed?.() ?? true;
	}

	setApprovalBypass(enabled: boolean): boolean {
		this.#approvalBypassActive = enabled;
		return this.#approvalBypassActive;
	}

	sessionToolApprovals(): SessionToolApprovals {
		return {
			get: toolName => this.#sessionToolApprovals.get(toolName),
			set: (toolName, decision) => {
				this.#sessionToolApprovals.set(toolName, decision);
			},
		};
	}

	async #applyActiveToolsByName(
		toolNames: string[],
		options?: { persistMCPSelection?: boolean; previousSelectedMCPToolNames?: string[] },
	): Promise<void> {
		toolNames = normalizeToolNames(toolNames);
		const previousSelectedMCPToolNames = options?.previousSelectedMCPToolNames ?? this.getSelectedMCPToolNames();
		const tools: AgentTool[] = [];
		let validToolNames: string[] = [];

		const droppedToolNames: string[] = [];
		for (const name of toolNames) {
			const tool = this.#toolRegistry.get(name);
			if (tool) {
				tools.push(this.#wrapToolForAcpPermission(tool));
				validToolNames.push(name);
			} else {
				droppedToolNames.push(name);
			}
		}
		if (droppedToolNames.length > 0) {
			logger.warn("requested tools are not in the session registry and were dropped", {
				sessionId: this.sessionManager.getSessionId(),
				dropped: droppedToolNames,
				model: this.model ? `${this.model.provider}/${this.model.id}` : undefined,
			});
		}

		if (isAutoQaEnabled(this.settings) && !validToolNames.includes(TOOL.report_tool_issue)) {
			const qaTool = this.#toolRegistry.get(TOOL.report_tool_issue);
			if (qaTool) {
				tools.push(this.#wrapToolForAcpPermission(qaTool));
				validToolNames.push(TOOL.report_tool_issue);
			}
		}

		const currentToolNames = this.agent.state.tools.map(tool => tool.name);
		if (isToolOrderPermutation(currentToolNames, validToolNames)) {
			const byName = new Map(validToolNames.map((name, index) => [name, tools[index]]));
			validToolNames = [...currentToolNames];
			tools.length = 0;
			for (const name of currentToolNames) {
				const tool = byName.get(name);
				if (tool) tools.push(tool);
			}
		}
		if (this.#mcpDiscoveryEnabled) {
			this.#selectedMCPToolNames = new Set(
				validToolNames.filter(
					name => isMCPToolName(name) && this.#discoverableMCPTools.has(name) && this.#toolRegistry.has(name),
				),
			);
		}
		this.#setActiveToolNames?.(validToolNames);
		const activeNameSet = new Set(validToolNames);
		for (const name of Array.from(this.#selectedDiscoveredToolNames)) {
			if (!activeNameSet.has(name) || isMCPToolName(name) || !this.#toolRegistry.has(name)) {
				this.#selectedDiscoveredToolNames.delete(name);
			}
		}
		this.agent.setTools(tools);

		this.#invalidateDiscoveryCaches();

		if (this.#rebuildSystemPrompt) {
			const signature = this.#computeAppliedToolSignature(validToolNames, tools);
			if (signature !== this.#lastAppliedToolSignature) {
				if (this.#lastAppliedToolSignature !== undefined) {
					this.#clearInheritedProviderPromptCacheKey("tool-signature-change");
				}
				const built = await this.#rebuildSystemPrompt(validToolNames, this.#toolRegistry);
				this.#baseSystemPrompt = built.systemPrompt;
				this.agent.setSystemPrompt(this.#baseSystemPrompt);
				this.#lastAppliedToolSignature = signature;
				this.#promptModelKey = this.#currentPromptModelKey();
			}
		}
		if (options?.persistMCPSelection !== false) {
			this.#persistSelectedMCPToolNamesIfChanged(previousSelectedMCPToolNames);
		}
	}

	async refreshSshTool(options?: { activateIfAvailable?: boolean }): Promise<void> {
		resetCapabilities();
		if (!this.#reloadSshTool) return;
		const previousSshTool = this.#toolRegistry.get(TOOL.ssh);
		const previousActiveToolNames = this.getActiveToolNames();
		const hadSshTool = previousSshTool !== undefined;
		const wasActive = previousActiveToolNames.includes(TOOL.ssh);
		const previousHostNames =
			previousSshTool && "hostNames" in previousSshTool && Array.isArray(previousSshTool.hostNames)
				? [...previousSshTool.hostNames]
				: [];
		const candidateHostNames = new Set(previousHostNames);
		const capability = await loadCapability<{ name: string }>(TOOL.ssh, { cwd: this.sessionManager.getCwd() });
		for (const host of capability.items) {
			if (typeof host?.name === "string") {
				candidateHostNames.add(host.name);
			}
		}
		await invalidateHostMetadata(candidateHostNames);
		const sshAllowed = this.#requestedToolNames === undefined || this.#requestedToolNames.has(TOOL.ssh);
		const refreshedTool = await this.#reloadSshTool();
		if (refreshedTool) {
			this.#toolRegistry.set(refreshedTool.name, refreshedTool);
		} else {
			this.#toolRegistry.delete(TOOL.ssh);
			this.#selectedDiscoveredToolNames.delete(TOOL.ssh);
		}

		const nextActive = previousActiveToolNames.filter(name => name !== TOOL.ssh && this.#toolRegistry.has(name));
		if (refreshedTool && sshAllowed && (wasActive || (options?.activateIfAvailable && !hadSshTool))) {
			nextActive.push(refreshedTool.name);
		}
		await this.#applyActiveToolsByName(nextActive);
	}

	async setActiveToolsByName(toolNames: string[]): Promise<void> {
		await this.#applyActiveToolsByName(toolNames);
	}

	async #restoreMCPSelectionsForSessionContext(
		sessionContext: SessionContext,
		options?: { fallbackSelectedMCPToolNames?: Iterable<string> },
	): Promise<void> {
		if (!this.#mcpDiscoveryEnabled) return;
		const nextActiveNonMCPToolNames = this.#getActiveNonMCPToolNames();
		const fallbackSelectedMCPToolNames =
			options?.fallbackSelectedMCPToolNames ?? this.#getConfiguredDefaultSelectedMCPToolNames();
		const restoredMCPToolNames = sessionContext.hasPersistedMCPToolSelection
			? this.#filterSelectableMCPToolNames(sessionContext.selectedMCPToolNames)
			: this.#filterSelectableMCPToolNames(fallbackSelectedMCPToolNames);
		this.#rememberSessionDefaultSelectedMCPToolNames(
			this.sessionFile,
			this.#getConfiguredDefaultSelectedMCPToolNames(),
		);
		await this.#applyActiveToolsByName([...nextActiveNonMCPToolNames, ...restoredMCPToolNames], {
			persistMCPSelection: false,
		});
	}

	systemPromptInvalidations(): readonly string[] {
		return Object.freeze([...this.#baseSystemPromptInvalidations]);
	}

	async refreshBaseSystemPrompt(reason: string): Promise<string[]> {
		if (!this.#rebuildSystemPrompt) return this.#baseSystemPrompt;
		const activeToolNames = this.getActiveToolNames();
		this.#setActiveToolNames?.(activeToolNames);
		const previousBaseSystemPrompt = this.#baseSystemPrompt;
		const built = await this.#rebuildSystemPrompt(activeToolNames, this.#toolRegistry);
		this.#baseSystemPrompt = built.systemPrompt;
		if (
			previousBaseSystemPrompt.length !== this.#baseSystemPrompt.length ||
			previousBaseSystemPrompt.some((part, index) => part !== this.#baseSystemPrompt[index])
		) {
			this.#clearInheritedProviderPromptCacheKey("system-prompt-change");

			this.#baseSystemPromptInvalidations.push(reason);
			const previousChars = previousBaseSystemPrompt.join("\n\n").length;
			const nextChars = this.#baseSystemPrompt.join("\n\n").length;
			logger.warn("system prompt changed mid-session; provider prompt cache invalidated", {
				reason,
				invalidationsThisSession: this.#baseSystemPromptInvalidations.length,
				previousChars,
				nextChars,
			});

			this.sessionManager.appendCustomMessageEntry(
				"prompt_cache_invalidated",
				`system prompt changed (${reason}); provider prefix cache invalidated`,
				false,
				{ reason, index: this.#baseSystemPromptInvalidations.length, previousChars, nextChars },
				"agent",
			);
		}
		this.agent.setSystemPrompt(this.#baseSystemPrompt);
		this.#promptModelKey = this.#currentPromptModelKey();

		const activeTools = activeToolNames
			.map(name => this.#toolRegistry.get(name))
			.filter((tool): tool is AgentTool => tool != null);
		this.#lastAppliedToolSignature = this.#computeAppliedToolSignature(activeToolNames, activeTools);
		return this.#baseSystemPrompt;
	}

	#deliveredVolatileMemoryContext: string | undefined;

	#pendingVolatileMemoryContext: string | undefined;

	#deliveredSessionState: string | undefined;

	async #collectVolatileMemoryContext(promptText: string): Promise<AgentMessage | null> {
		const backend = await resolveMemoryBackend(this.settings);
		const parts: string[] = [];
		if (backend.beforeAgentStartPrompt) {
			try {
				const injected = await backend.beforeAgentStartPrompt(this, promptText);
				if (injected?.trim()) parts.push(injected.trim());
			} catch (err) {
				logger.debug("Memory backend beforeAgentStartPrompt failed", {
					backend: backend.id,
					error: errorMessage(err),
				});
			}
		}
		if (backend.buildVolatileContext) {
			try {
				const volatileContext = await backend.buildVolatileContext(this);

				if (volatileContext?.trim() && !parts.includes(volatileContext.trim())) {
					parts.push(volatileContext.trim());
				}
			} catch (err) {
				logger.debug("Memory backend buildVolatileContext failed", {
					backend: backend.id,
					error: errorMessage(err),
				});
			}
		}
		return this.#buildVolatileMemoryMessage(parts.join("\n\n"));
	}

	#buildVolatileMemoryMessage(text: string): AgentMessage | null {
		const trimmed = text.trim();
		if (!trimmed) return null;
		if (trimmed === this.#deliveredVolatileMemoryContext) return null;
		this.#deliveredVolatileMemoryContext = trimmed;
		this.#pendingVolatileMemoryContext = undefined;
		return {
			role: "custom",
			customType: MEMORY_CONTEXT_MESSAGE_TYPE,
			content: trimmed,
			display: false,
			attribution: "agent",
			timestamp: Date.now(),
		};
	}

	async publishVolatileMemoryContext(reason: string): Promise<boolean> {
		const backend = await resolveMemoryBackend(this.settings);
		if (!backend.buildVolatileContext) return false;
		let text: string | undefined;
		try {
			text = await backend.buildVolatileContext(this);
		} catch (err) {
			logger.debug("Memory backend buildVolatileContext failed", {
				backend: backend.id,
				reason,
				error: errorMessage(err),
			});
			return false;
		}
		const trimmed = text?.trim();
		if (!trimmed || trimmed === this.#deliveredVolatileMemoryContext) return false;
		this.#pendingVolatileMemoryContext = trimmed;
		logger.debug("memory context queued for the context tail", { reason, chars: trimmed.length });
		return true;
	}

	#takePendingVolatileMemoryContext(): AgentMessage | null {
		const pending = this.#pendingVolatileMemoryContext;
		if (pending === undefined) return null;
		this.#pendingVolatileMemoryContext = undefined;
		return this.#buildVolatileMemoryMessage(pending);
	}

	#computeAppliedToolSignature(toolNames: string[], tools: AgentTool[]): string {
		const nameSegment = toolNames.join("\u0001");
		const describeTool = (tool: AgentTool): string =>
			`${tool.name}=${tool.label ?? ""}|${tool.description ?? ""}|${tool.customWireName ?? ""}`;
		const descriptionSegment = tools.map(describeTool).join("\u0002");
		let registrySegment = "";
		if (this.#mcpDiscoveryEnabled) {
			const entries: string[] = [];
			for (const tool of this.#toolRegistry.values()) {
				entries.push(describeTool(tool));
			}
			entries.sort();
			registrySegment = entries.join("\u0004");
		}
		let instructionsSegment = "";
		const serverInstructions = this.#getMcpServerInstructions?.();
		if (serverInstructions && serverInstructions.size > 0) {
			const entries: string[] = [];
			for (const [server, instructions] of serverInstructions) {
				entries.push(`${server}=${instructions}`);
			}
			entries.sort();
			instructionsSegment = entries.join("\u0006");
		}
		const date = this.#getLocalCalendarDate();
		return `${nameSegment}\u0003${descriptionSegment}\u0005${registrySegment}\u0007${instructionsSegment}|${date}`;
	}

	async refreshMCPTools(mcpTools: CustomTool[], options?: { activateAll?: boolean }): Promise<void> {
		const previousSelectedMCPToolNames = this.getSelectedMCPToolNames();
		const existingNames = Array.from(this.#toolRegistry.keys());
		for (const name of existingNames) {
			if (isMCPToolName(name)) {
				this.#toolRegistry.delete(name);
			}
		}

		const getCustomToolContext = (): CustomToolContext => ({
			sessionManager: this.sessionManager,
			modelRegistry: this.#modelRegistry,
			model: this.model,
			isIdle: () => !this.isStreaming,
			obfuscateProviderText: text => this.obfuscateProviderText(text),
			hasQueuedMessages: () => this.queuedMessageCount > 0,
			abort: () => {
				this.agent.abort();
			},
			settings: this.settings,
			getTurnIndex: () => this.getTurnIndex(),
			localProtocolOptions: this.#localProtocolOptions(),
		});

		for (const customTool of mcpTools) {
			const wrapped = wrapToolWithMetaNotice(CustomToolAdapter.wrap(customTool, getCustomToolContext) as AgentTool);
			const finalTool = (
				this.#extensionRunner ? new ExtensionToolWrapper(wrapped, this.#extensionRunner) : wrapped
			) as AgentTool;
			this.#toolRegistry.set(finalTool.name, finalTool);
		}

		this.#setDiscoverableMCPTools(this.#collectDiscoverableMCPToolsFromRegistry());
		this.#pruneSelectedMCPToolNames();
		if (!this.buildDisplaySessionContext().hasPersistedMCPToolSelection) {
			this.#selectedMCPToolNames = new Set([
				...this.#selectedMCPToolNames,
				...this.#getConfiguredDefaultSelectedMCPToolNames(),
			]);
		}
		this.#rememberSessionDefaultSelectedMCPToolNames(
			this.sessionFile,
			this.#getConfiguredDefaultSelectedMCPToolNames(),
		);

		if (options?.activateAll) {
			const newMcpNames = mcpTools.map(t => t.name);
			const nextActive = [...new Set([...this.#getActiveNonMCPToolNames(), ...newMcpNames])];
			await this.#applyActiveToolsByName(nextActive, { previousSelectedMCPToolNames });
			return;
		}

		const nextActive = [...this.#getActiveNonMCPToolNames(), ...this.getSelectedMCPToolNames()];
		await this.#applyActiveToolsByName(nextActive, { previousSelectedMCPToolNames });
	}

	async refreshRpcHostTools(rpcTools: AgentTool[]): Promise<void> {
		const nextToolNames = rpcTools.map(tool => tool.name);
		const uniqueToolNames = new Set(nextToolNames);
		if (uniqueToolNames.size !== nextToolNames.length) {
			throw new Error("RPC host tool names must be unique");
		}

		for (const name of uniqueToolNames) {
			if (this.#toolRegistry.has(name) && !this.#rpcHostToolNames.has(name)) {
				throw new Error(`RPC host tool "${name}" conflicts with an existing tool`);
			}
		}

		const previousRpcHostToolNames = new Set(this.#rpcHostToolNames);
		const previousActiveToolNames = this.getActiveToolNames();
		for (const name of previousRpcHostToolNames) {
			this.#toolRegistry.delete(name);
		}
		this.#rpcHostToolNames.clear();

		for (const tool of rpcTools) {
			const metaWrapped = wrapToolWithMetaNotice(tool);
			const finalTool = (
				this.#extensionRunner ? new ExtensionToolWrapper(metaWrapped, this.#extensionRunner) : metaWrapped
			) as AgentTool;
			this.#toolRegistry.set(finalTool.name, finalTool);
			this.#rpcHostToolNames.add(finalTool.name);
		}

		this.#invalidateDiscoveryCaches();

		const activeNonRpcToolNames = previousActiveToolNames.filter(name => !previousRpcHostToolNames.has(name));
		const preservedRpcToolNames = previousActiveToolNames.filter(
			name => previousRpcHostToolNames.has(name) && this.#rpcHostToolNames.has(name),
		);
		const autoActivatedRpcToolNames = rpcTools
			.filter(tool => !tool.hidden && !previousRpcHostToolNames.has(tool.name))
			.map(tool => tool.name);
		await this.#applyActiveToolsByName(
			Array.from(new Set([...activeNonRpcToolNames, ...preservedRpcToolNames, ...autoActivatedRpcToolNames])),
		);
	}

	get isCompacting(): boolean {
		return this.#autoCompactionAbortController !== undefined || this.#compactionAbortController !== undefined;
	}

	get hasPostPromptWork(): boolean {
		return this.#postPromptTasks.size > 0;
	}

	get messages(): AgentMessage[] {
		return this.agent.state.messages;
	}

	getImageAttachments(): { label: string; uri: string; image: ImageContent }[] {
		for (let i = this.agent.state.messages.length - 1; i >= 0; i--) {
			const message = this.agent.state.messages[i];
			if (!message || (message.role !== "user" && message.role !== "developer") || !Array.isArray(message.content)) {
				continue;
			}
			const images = message.content.filter((part): part is ImageContent => part.type === "image");
			if (images.length === 0) continue;
			return images.map((image, index) => ({
				label: `Image #${index + 1}`,
				uri: `attachment://${index + 1}`,
				image,
			}));
		}
		return [];
	}

	buildDisplaySessionContext(): SessionContext {
		return this.#expandArgot(this.#deobfuscateSessionContextForDisplay(this.sessionManager.buildSessionContext()));
	}

	#expandArgot(context: SessionContext): SessionContext {
		return this.#argot?.loaded ? expandSessionContext(this.#argot, context) : context;
	}

	expandArgotEntries(entries: SessionMessageEntry[]): SessionMessageEntry[] {
		return this.#argot?.loaded ? expandSessionMessageEntries(this.#argot, entries) : entries;
	}

	buildTranscriptSessionContext(
		options?: Pick<BuildSessionContextOptions, "collapseCompactedHistory" | "keepDanglingToolCalls">,
	): SessionContext {
		return this.#expandArgot(
			this.#deobfuscateSessionContextForDisplay(
				this.sessionManager.buildSessionContext({
					transcript: true,
					collapseCompactedHistory: options?.collapseCompactedHistory,
					keepDanglingToolCalls: options?.keepDanglingToolCalls,
				}),
			),
		);
	}

	#obfuscateTextForProvider(text: string | undefined): string | undefined {
		if (!text || !this.#hasProviderRedactions) return text;
		return this.obfuscateProviderText(text);
	}

	#obfuscatePreparationForProvider(preparation: CompactionPreparation): CompactionPreparation {
		if (!this.#hasProviderRedactions) return preparation;
		const previousSummary = this.#obfuscateTextForProvider(preparation.previousSummary);

		const previousPreserveData = this.#obfuscatePreservedArchiveText(preparation.previousPreserveData);
		if (
			previousSummary === preparation.previousSummary &&
			previousPreserveData === preparation.previousPreserveData
		) {
			return preparation;
		}
		return { ...preparation, previousSummary, previousPreserveData };
	}

	#obfuscatePreservedArchiveText(
		preserveData: Record<string, unknown> | undefined,
	): Record<string, unknown> | undefined {
		if (!this.#hasProviderRedactions || !hasLegacyArchive(preserveData)) return preserveData;
		return redactLegacyArchiveText(preserveData, value => this.obfuscateProviderText(value));
	}

	#deobfuscateFromProvider(text: string): string {
		return this.#tryExpandSecretsForDisplay(text) ?? text;
	}

	#deobfuscatedProviderTextReadyForDelta(text: string): string {
		const deobfuscated = this.#deobfuscateFromProvider(text);
		if (!this.#obfuscator?.hasSecrets()) return deobfuscated;
		const pendingPlaceholderStart = deobfuscated.match(PENDING_PLACEHOLDER_RE);
		if (pendingPlaceholderStart?.index === undefined) return deobfuscated;
		return deobfuscated.slice(0, pendingPlaceholderStart.index);
	}

	#convertToLlmForSideRequest(messages: AgentMessage[]): Message[] {
		return this.#obfuscateMessagesForProvider(convertToLlm(messages));
	}

	async convertMessagesToLlm(messages: AgentMessage[], signal?: AbortSignal): Promise<Message[]> {
		const transformedMessages = await this.#transformContext(messages, signal);
		return await this.#convertToLlm(transformedMessages);
	}

	async #cacheAlignedCompactionPrefix(
		candidate: Model,
		signal?: AbortSignal,
	): Promise<Pick<SummaryOptions, "sessionSystemPrompt" | "sessionMessages" | "tools"> | undefined> {
		const sessionModel = this.model;
		if (!sessionModel || this.#getModelKey(sessionModel) !== this.#getModelKey(candidate)) return undefined;
		if (!modelServesPrefixCacheHits(candidate)) return undefined;
		const llmMessages = await this.convertMessagesToLlm(this.agent.state.messages.slice(), signal);
		const context = await this.agent.buildSideRequestContext(llmMessages);
		if (!context.systemPrompt?.length || context.messages.length === 0) return undefined;
		return { sessionSystemPrompt: context.systemPrompt, sessionMessages: context.messages, tools: context.tools };
	}

	async prepareSimpleStreamOptions(
		options: SimpleStreamOptions,
		provider = "anthropic",
	): Promise<SimpleStreamOptions> {
		const runtime = await this.leaseSecretRuntime();
		const sessionOnPayload = this.#onPayload;
		const sessionOnResponse = this.#onResponse;
		const sessionMetadata = this.agent.metadataForProvider(provider);
		const sessionOnSseEvent = this.#onSseEvent;
		const openrouterRoutingPreset =
			provider === "openrouter" ? this.settings.get("providers.openrouterVariant") : "default";
		const openrouterVariant =
			openrouterRoutingPreset !== "default" && options.openrouterVariant === undefined
				? openrouterRoutingPreset
				: undefined;
		const antigravityEndpointMode =
			provider === "google-antigravity" ? this.settings.get("providers.antigravityEndpoint") : undefined;

		const preparedOptions: SimpleStreamOptions = {
			...options,
			...(openrouterVariant !== undefined && { openrouterVariant }),
			...(antigravityEndpointMode !== undefined && { antigravityEndpointMode }),
			maxInFlightRequests: validateProviderMaxInFlightRequests(
				options.maxInFlightRequests ?? this.settings.get("providers.maxInFlightRequests"),
			),
			loopGuard: {
				enabled: this.settings.get("model.loopGuard.enabled"),
				checkAssistantContent: this.settings.get("model.loopGuard.checkAssistantContent"),
				...options.loopGuard,
			},
		};

		if (sessionMetadata && !options.metadata) {
			preparedOptions.metadata = sessionMetadata;
		}

		const requestOnPayload = options.onPayload;
		if (runtime.hasRedactions || sessionOnPayload || requestOnPayload) {
			preparedOptions.onPayload = async (payload, model) => {
				const sessionPayload = sessionOnPayload ? await sessionOnPayload(payload, model) : undefined;
				const sessionResolvedPayload = sessionPayload ?? payload;
				const requestPayload = requestOnPayload ? await requestOnPayload(sessionResolvedPayload, model) : undefined;
				return runtime.obfuscatePayload(requestPayload ?? sessionResolvedPayload);
			};
		}

		if (sessionOnResponse) {
			if (!options.onResponse) {
				preparedOptions.onResponse = sessionOnResponse;
			} else {
				const requestOnResponse = options.onResponse;
				preparedOptions.onResponse = async (response, model) => {
					await sessionOnResponse(response, model);
					await requestOnResponse(response, model);
				};
			}
		}

		if (sessionOnSseEvent) {
			if (!options.onSseEvent) {
				preparedOptions.onSseEvent = sessionOnSseEvent;
			} else {
				const requestOnSseEvent = options.onSseEvent;
				preparedOptions.onSseEvent = (event, model) => {
					sessionOnSseEvent(event, model);
					requestOnSseEvent(event, model);
				};
			}
		}

		return preparedOptions;
	}

	get steeringMode(): "all" | "one-at-a-time" {
		return this.agent.getSteeringMode();
	}

	get followUpMode(): "all" | "one-at-a-time" {
		return this.agent.getFollowUpMode();
	}

	get interruptMode(): "immediate" | "wait" {
		return this.agent.getInterruptMode();
	}

	get sessionFile(): string | undefined {
		return this.sessionManager.getSessionFile();
	}

	get sessionId(): string {
		return this.#activeProviderSessionId();
	}
	getEvalSessionId(): string | null {
		if (this.#parentEvalSessionId !== undefined) return this.#parentEvalSessionId;
		return defaultEvalSessionId({
			cwd: this.sessionManager.getCwd(),
			getSessionFile: () => this.sessionManager.getSessionFile() ?? null,
		});
	}

	get sessionName(): string | undefined {
		return this.sessionManager.getSessionName();
	}

	get scopedModels(): ReadonlyArray<{
		model: Model;
		thinkingLevel?: ConfiguredThinkingLevel;
		explicitThinkingLevel?: boolean;
	}> {
		return this.#scopedModels;
	}

	getPlanModeState(): PlanModeState | undefined {
		return this.#planModeState;
	}

	getPrewalkState(): Prewalk | undefined {
		return this.#prewalk;
	}

	setPlanModeState(state: PlanModeState | undefined): void {
		this.#planModeState = state;
		if (state?.enabled) {
			this.#planReferenceSent = false;
			this.#planReferencePath = state.planFilePath;
		} else {
			this.#planModeReminderCount = 0;
			this.#planModeReminderAwaitingProgress = false;

			this.#toolChoiceQueue.removeByLabel("plan-mode-decision");
		}
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
		this.#planReferenceSent = true;
	}

	setPlanReferencePath(path: string): void {
		this.#planReferencePath = path;
	}

	getPlanReferencePath(): string {
		return this.#planReferencePath;
	}

	get clientBridge(): ClientBridge | undefined {
		return this.#clientBridge;
	}

	setClientBridge(bridge: ClientBridge | undefined): void {
		this.#clientBridge = bridge;
		this.#acpPermissionDecisions.clear();
		const activeToolNames = this.getActiveToolNames();
		const activeTools = activeToolNames
			.map(name => this.#toolRegistry.get(name))
			.filter((tool): tool is AgentTool => tool !== undefined)
			.map(tool => this.#wrapToolForAcpPermission(tool));
		this.agent.setTools(activeTools);
	}

	#clearCheckpointRuntimeState(): void {
		this.#checkpointState = undefined;
		this.#pendingRewindReport = undefined;
		this.#lastCompletedRewind = undefined;
		this.#rewoundToolResultIds.clear();
	}

	#rehydrateCheckpointRewindState(): void {
		this.#clearCheckpointRuntimeState();
		let completed: CompletedRewindState | undefined;
		let pending: { entryId: string; startedAt: string; messageCount: number } | undefined;
		let messageCount = 0;
		for (const entry of this.sessionManager.getBranch()) {
			if (entry.type === "message") messageCount++;
			if (isSuccessfulCheckpointEntry(entry)) {
				completed = undefined;
				pending = {
					entryId: entry.id,
					startedAt: checkpointStartedAtFromEntry(entry) ?? entry.timestamp,
					messageCount,
				};
				continue;
			}
			const completedFromEntry = completedRewindFromEntry(entry);
			if (completedFromEntry) {
				completed = completedFromEntry;
				pending = undefined;
			}
		}
		if (pending) {
			this.#checkpointState = {
				checkpointEntryId: pending.entryId,
				startedAt: pending.startedAt,
				checkpointMessageCount: pending.messageCount,
			};
			return;
		}
		this.#lastCompletedRewind = completed;
	}

	getCheckpointState(): CheckpointState | undefined {
		return this.#checkpointState;
	}

	getLastCompletedRewind(): CompletedRewindState | undefined {
		return this.#lastCompletedRewind;
	}

	setCheckpointState(state: CheckpointState | undefined): void {
		this.#checkpointState = state;
		if (state) {
			this.#lastCompletedRewind = undefined;
		} else {
			this.#pendingRewindReport = undefined;
		}
	}

	async sendPlanModeContext(options?: { deliverAs?: "steer" | "followUp" | "nextTurn" }): Promise<void> {
		const message = await this.#buildPlanModeMessage();
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
		const message = this.#buildGoalModeMessage();
		if (!message) return;
		await this.sendCustomMessage(
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

	async sendVibeModeContext(options?: { deliverAs?: "steer" | "followUp" | "nextTurn" }): Promise<void> {
		const message = this.#buildVibeModeMessage();
		if (!message) return;
		await this.sendCustomMessage(
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

	resolveRoleModel(role: string): Model | undefined {
		return this.#resolveRoleModelFull(role, this.#modelRegistry.getAvailable(), this.model).model;
	}

	resolveRoleModelWithThinking(role: string): ResolvedModelRoleValue {
		return this.#resolveRoleModelFull(role, this.#modelRegistry.getAvailable(), this.model);
	}

	resolveTemporaryModelThinkingLevel(model: Model): ConfiguredThinkingLevel | undefined {
		const availableModels = this.#modelRegistry.getAvailable();
		if (availableModels.length === 0) return undefined;

		const matchPreferences = getModelMatchPreferences(this.settings);
		for (const role of getKnownRoleIds(this.settings)) {
			const roleValue = this.settings.getModelRole(role);
			if (!roleValue) continue;

			const resolved = resolveModelRoleValue(roleValue, availableModels, {
				settings: this.settings,
				matchPreferences,
			});
			if (!resolved.explicitThinkingLevel || resolved.thinkingLevel === undefined || !resolved.model) continue;
			if (modelsAreEqual(resolved.model, model)) return resolved.thinkingLevel;
		}

		return undefined;
	}

	get promptTemplates(): ReadonlyArray<PromptTemplate> {
		return this.#promptTemplates;
	}

	setSlashCommands(slashCommands: FileSlashCommand[]): void {
		this.#slashCommands = [...slashCommands];
	}

	get customCommands(): ReadonlyArray<LoadedCustomCommand> {
		if (this.#mcpPromptCommands.length === 0) return this.#customCommands;
		return [...this.#customCommands, ...this.#mcpPromptCommands];
	}

	get mcpPromptCommands(): ReadonlyArray<LoadedCustomCommand> {
		return this.#mcpPromptCommands;
	}

	setMCPPromptCommands(commands: LoadedCustomCommand[]): void {
		this.#mcpPromptCommands = commands;
		this.#notifyCommandMetadataChanged();
	}

	async #buildPlanReferenceMessage(): Promise<CustomMessage | null> {
		if (this.#planModeState?.enabled) return null;
		if (this.#planReferenceSent) return null;

		const planFilePath = this.#planReferencePath;
		const resolvedPlanPath = this.#resolvePlanPath(planFilePath);
		try {
			await fs.promises.access(resolvedPlanPath, fs.constants.R_OK);
		} catch (error) {
			if (isEnoent(error)) {
				return null;
			}
			throw error;
		}

		const content = prompt.render(planModePrompts["plan-mode/reference"].text, {
			planFilePath,
		});

		this.#planReferenceSent = true;

		return {
			role: "custom",
			customType: "plan-mode-reference",
			content,
			display: false,
			attribution: "agent",
			timestamp: Date.now(),
		};
	}

	async #buildPlanModeMessage(): Promise<CustomMessage | null> {
		const state = this.#planModeState;
		if (!state?.enabled) return null;
		const sessionPlanUrl = DEFAULT_PLAN_FILE_URL;
		const resolvedPlanPath = this.#resolvePlanPath(state.planFilePath);
		const resolvedSessionPlan = resolveLocalUrlToPath(sessionPlanUrl, this.#localProtocolOptions());
		const displayPlanPath =
			state.planFilePath.startsWith("local:") || resolvedPlanPath !== resolvedSessionPlan
				? state.planFilePath
				: sessionPlanUrl;

		const planExists = fs.existsSync(resolvedPlanPath);

		const subagentNames = enabledSubagentNames(this.#toolRegistry.get(TOOL.task));
		const researchAgent = preferredSubagentName(subagentNames, "scout");
		const content = prompt.render(planModePrompts["plan-mode/active"].text, {
			planFilePath: displayPlanPath,
			planExists,

			canDelegate: researchAgent !== undefined,
			researchAgent,
			askToolName: TOOL.ask,
			writeToolName: TOOL.write,
			editToolName: TOOL.edit,
			isHashlineEditMode: this.#resolveActiveEditMode() === "hashline",
			reentry: state.reentry ?? false,
			iterative: state.workflow === "iterative",
		});

		return {
			role: "custom",
			customType: "plan-mode-context",
			content,
			display: false,
			attribution: "agent",
			timestamp: Date.now(),
		};
	}

	#buildGoalModeMessage(): CustomMessage | null {
		const content = this.#goalRuntime.buildActivePrompt();
		if (!content) return null;
		const todoContext = this.#buildGoalTodoContext();
		return {
			role: "custom",
			customType: "goal-mode-context",
			content: prompt.render(goalsPrompts["goals/goal-mode-context"].text, { goalContext: content, todoContext }),
			display: false,
			attribution: "agent",
			timestamp: Date.now(),
		};
	}

	#buildSessionStateMessage(): CustomMessage | null {
		const content = prompt
			.render(sessionPrompts["session/session-state"].text, {
				date: formatLocalCalendarDate(),
				cwd: shortenPath(normalizePromptPath(this.sessionManager.getCwd())),
			})
			.trim();
		if (content === this.#deliveredSessionState) return null;
		this.#deliveredSessionState = content;
		return {
			role: "custom",
			customType: SESSION_STATE_MESSAGE_TYPE,
			content,
			display: false,
			attribution: "agent",
			timestamp: Date.now(),
		};
	}

	#buildVibeModeMessage(): CustomMessage | null {
		if (!this.#vibeModeState?.enabled) return null;
		return {
			role: "custom",
			customType: "vibe-mode-context",
			content: prompt.render(sessionPrompts["session/vibe-mode-active"].text),
			display: false,
			attribution: "agent",
			timestamp: Date.now(),
		};
	}

	#sanitizeGoalTodoText(text: string): string {
		return escapeXmlText(text)
			.replace(/\r\n/g, "\\n")
			.replace(/\r/g, "\\r")
			.replace(/\n/g, "\\n")
			.replace(/\t/g, "\\t")
			.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]/g, " ");
	}

	#buildGoalTodoContext(): string | undefined {
		if (!this.settings.get("todo.enabled")) return undefined;
		const activeToolNames = this.getActiveToolNames();
		const canCallTodoTool = activeToolNames.includes(TOOL.todo);
		const canDiscoverTodoTool =
			!canCallTodoTool && this.getDiscoverableTools({ source: "builtin" }).some(tool => tool.name === TOOL.todo);
		const canActivateTodoTool = canDiscoverTodoTool && activeToolNames.includes(TOOL.search_tool_bm25);
		if (!canCallTodoTool && !canDiscoverTodoTool) return undefined;
		const phases = this.getTodoPhases().filter(phase => phase.tasks.length > 0);
		if (phases.length === 0) return undefined;

		const tasks = phases.flatMap(phase => phase.tasks.map(task => ({ ...task, phase: phase.name })));
		const closed = tasks.filter(task => task.status === "completed" || task.status === "abandoned").length;
		const openItems = prioritizeTodoItems(
			tasks.filter(
				(task): task is typeof task & { status: "pending" | "in_progress" } =>
					task.status === "pending" || task.status === "in_progress",
			),
		);
		const next = openItems[0];
		const nextItem = next
			? {
					status: next.status,
					text: this.#sanitizeGoalTodoText(
						boundedTodoPreviewText(`${next.content} (${next.phase})`, TODO_ITEM_PREVIEW_WIDTH),
					),
				}
			: undefined;

		return prompt.render(goalsPrompts["goals/goal-todo-context"].text, {
			canCallTodoTool,
			canActivateTodoTool,
			closed: String(closed),
			nextItem,
			open: String(openItems.length),
			total: String(tasks.length),
		});
	}

	#normalizeImagesForModel(images: ImageContent[] | undefined): Promise<ImageContent[] | undefined> {
		return normalizeModelContextImages(images, { model: this.model });
	}

	async #buildImageDescriptionNotice(
		normalizedImages: ImageContent[],
		signal?: AbortSignal,
	): Promise<CustomMessage | undefined> {
		const model = this.model;
		const shouldDescribe =
			!!model &&
			!model.input.includes("image") &&
			!this.settings.get("images.blockImages") &&
			this.settings.get("images.describeForTextModels");
		if (!shouldDescribe || !model) {
			return undefined;
		}
		let blocks: TextContent[];
		try {
			blocks = await describeAttachedImagesForTextModel(
				normalizedImages,
				{
					activeModel: model,
					modelRegistry: this.#modelRegistry,
					settings: this.settings,
					localProtocolOptions: this.#localProtocolOptions(),
					activeModelString: formatModelString(model),
					telemetryConfig: this.agent.telemetry,
					sessionId: this.sessionId,
				},
				signal,
			);
		} catch (err) {
			logger.warn("image attachment vision fallback failed; image left undescribed", {
				error: errorMessage(err),
			});
			return undefined;
		}
		if (blocks.length === 0) {
			return undefined;
		}
		return {
			role: "custom",
			customType: IMAGE_ATTACHMENT_DESCRIPTION_TYPE,
			content: blocks,
			display: false,
			attribution: "user",
			timestamp: Date.now(),
		};
	}

	async #normalizeMessageContentImages(
		content: string | (TextContent | ImageContent)[],
	): Promise<string | (TextContent | ImageContent)[]> {
		if (typeof content === "string") return content;
		const images = content.filter((part): part is ImageContent => part.type === "image");
		if (images.length === 0) return content;
		const normalizedImages = await this.#normalizeImagesForModel(images);
		if (!normalizedImages) return content;
		let imageIndex = 0;
		return content.map(part => (part.type === "image" ? normalizedImages[imageIndex++]! : part));
	}

	async #normalizeAgentMessageImages<T extends AgentMessage>(message: T): Promise<T> {
		if (!("content" in message)) return message;
		const content = message.content;
		if (typeof content !== "string" && !Array.isArray(content)) return message;
		const normalized = await this.#normalizeMessageContentImages(content as string | (TextContent | ImageContent)[]);
		if (normalized === content) return message;
		return { ...message, content: normalized } as T;
	}

	#magicKeywordEnabled(keyword: "orchestrate" | "ultrathink" | "workflow"): boolean {
		return this.settings.get("magicKeywords.enabled") && this.settings.get(`magicKeywords.${keyword}`);
	}

	#createMagicKeywordNotices(text: string): CustomMessage[] {
		const timestamp = Date.now();
		const turnBudget = parseTurnBudgetDirective(this.settings, text);
		this.sessionManager.beginTurnBudget(turnBudget?.total ?? null, turnBudget?.hard ?? false);
		const keywordNotices: CustomMessage[] = [];
		if (this.#magicKeywordEnabled("ultrathink") && containsUltrathink(text)) {
			keywordNotices.push({
				role: "custom",
				customType: "ultrathink-notice",
				content: ULTRATHINK_NOTICE,
				display: false,
				attribution: "user",
				timestamp,
			});
		}
		if (this.#magicKeywordEnabled("orchestrate") && containsOrchestrate(text)) {
			keywordNotices.push({
				role: "custom",
				customType: "orchestrate-notice",
				content: ORCHESTRATE_NOTICE,
				display: false,
				attribution: "user",
				timestamp,
			});
		}
		if (
			this.#magicKeywordEnabled("workflow") &&
			containsWorkflow(text) &&
			this.getActiveToolNames().includes(TOOL.task)
		) {
			keywordNotices.push({
				role: "custom",
				customType: "workflow-notice",
				content: renderWorkflowNotice({ taskBatch: this.settings.get("subagent.batch") }),
				display: false,
				attribution: "user",
				timestamp,
			});
		}
		return keywordNotices;
	}

	deferStartupWork(work: Promise<void>): void {
		this.#startupHydration = this.#startupHydration.then(() => work).catch(() => {});
	}

	whenStartupHydrated(): Promise<void> {
		return this.#startupHydration;
	}

	async prompt(text: string, options?: PromptOptions): Promise<boolean> {
		await this.#promptRefresh;
		await this.#startupHydration;
		const expandPromptTemplates = options?.expandPromptTemplates ?? true;

		if (expandPromptTemplates && text.startsWith("/")) {
			const handled = await this.#tryExecuteExtensionCommand(text);
			if (handled) {
				return false;
			}

			const customResult = await this.#tryExecuteCustomCommand(text);
			if (customResult !== null) {
				if (customResult === "") {
					return false;
				}
				text = customResult;
			}

			if (text.startsWith("/")) {
				const parsed = parseSlashCommand(text);
				const canonicalInvocation =
					parsed === null ? text : `/${parsed.name}${parsed.args.length > 0 ? ` ${parsed.args}` : ""}`;
				text = expandSlashCommand(canonicalInvocation, this.#slashCommands);
			}
		}

		const expandedText = expandPromptTemplates ? expandPromptTemplate(text, [...this.#promptTemplates]) : text;

		if (expandPromptTemplates && !options?.synthetic && expandedText === text) {
			const unresolved = unresolvedSlashCommandName(text);

			if (unresolved !== undefined) throw new Error(unknownSlashCommandMessage(unresolved));
		}

		const keywordNotices = options?.synthetic ? [] : this.#createMagicKeywordNotices(expandedText);

		if (options?.userInitiated ?? !options?.synthetic) {
			this.#verificationEvidence.startUserTurn({
				preservePendingCodeReview: this.settings.get("edit.critiqueCodeMutations"),
			});
			this.#advisorAutoResumeSuppressed = false;
			this.#planModeReminderCount = 0;
			this.#planModeReminderAwaitingProgress = false;

			this.#toolChoiceQueue.removeByLabel("plan-mode-decision");
		}

		if (this.isStreaming) {
			if (!options?.streamingBehavior) {
				throw new AgentBusyError();
			}

			for (const notice of keywordNotices) {
				await this.sendCustomMessage(notice, { deliverAs: options.streamingBehavior });
			}
			if (options.streamingBehavior === "followUp") {
				await this.#queueUserMessage(expandedText, options?.images, "followUp");
			} else {
				await this.#queueUserMessage(expandedText, options?.images, "steer");
			}
			return true;
		}

		const hasPendingUserDirective = this.#toolChoiceQueue.inspect().includes("user-force");
		const eagerTodoPrelude =
			!options?.synthetic && !hasPendingUserDirective ? this.#createEagerTodoPrelude(expandedText) : undefined;
		const eagerTaskPrelude =
			!options?.synthetic && !hasPendingUserDirective ? this.#createEagerTaskPrelude(expandedText) : undefined;
		const normalizedImages = await this.#normalizeImagesForModel(options?.images);

		const userContent: (TextContent | ImageContent)[] = [{ type: "text", text: expandedText }];
		if (normalizedImages?.length) {
			userContent.push(...normalizedImages);
		}

		const imageDescriptionNotice = normalizedImages?.length
			? await this.#buildImageDescriptionNotice(normalizedImages)
			: undefined;

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
			});
		} finally {
			this.#toolChoiceQueue.removeByLabel("eager-todo");
		}
		return true;
	}

	async promptCustomMessage<T = unknown>(
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details" | "attribution">,
		options?: Pick<PromptOptions, "streamingBehavior" | "toolChoice"> & {
			queueChipText?: string;
			queueOnly?: boolean;
		},
	): Promise<void> {
		const textContent = contentText(message.content, { separator: "" });

		let keywordNotices: CustomMessage[] = [];
		if (message.customType === SKILL_PROMPT_MESSAGE_TYPE && message.attribution === "user") {
			const details = message.details;
			let skillArgs = "";
			if (details && typeof details === "object" && "args" in details && typeof details.args === "string") {
				skillArgs = details.args;
			}
			keywordNotices = this.#createMagicKeywordNotices(skillArgs);
		}

		if (options?.queueOnly) {
			if (!options.streamingBehavior) {
				throw new AgentBusyError();
			}
			for (const notice of keywordNotices) {
				await this.#queueCustomMessage(notice, options.streamingBehavior);
			}
			await this.#queueCustomMessage(message, options.streamingBehavior, options.queueChipText);
			return;
		}
		if (this.isStreaming) {
			if (!options?.streamingBehavior) {
				throw new AgentBusyError();
			}
			for (const notice of keywordNotices) {
				await this.sendCustomMessage(notice, { deliverAs: options.streamingBehavior });
			}
			await this.sendCustomMessage(message, {
				deliverAs: options.streamingBehavior,
				queueChipText: options.queueChipText,
			});
			return;
		}

		const customMessage: CustomMessage<T> = {
			role: "custom",
			customType: message.customType,
			content: message.content,
			display: message.display,
			details: message.details,
			attribution: message.attribution ?? "agent",
			timestamp: Date.now(),
		};

		await this.#promptWithMessage(customMessage, textContent, {
			...options,
			prependMessages: keywordNotices.length > 0 ? keywordNotices : undefined,
		});
	}

	async #promptWithMessage(
		message: AgentMessage,
		expandedText: string,
		options?: Pick<PromptOptions, "toolChoice" | "images" | "skipCompactionCheck"> & {
			prependMessages?: AgentMessage[];
			skipPostPromptRecoveryWait?: boolean;
			acceptTerminalEmptyStop?: boolean;
		},
	): Promise<void> {
		this.#beginInFlight();
		startupMarker("prompt:start");
		const generation = this.#promptGeneration;
		try {
			this.#flushPendingBashMessages();
			this.#flushPendingPythonMessages();
			this.#flushPendingIrcAsides();

			this.#mutationsSinceLastTodoTouch = 0;
			this.#midRunNudgeCount = 0;
			this.#resetPromptMaintenanceState();
			this.#acceptTerminalEmptyStopForPrompt = options?.acceptTerminalEmptyStop === true;

			await this.#maybeRestoreRetryFallbackPrimary();

			if (!this.model) {
				throw new Error(
					"No model selected, so there is nothing to send the prompt to.\n\n" +
						"Fix: in an interactive veyyon session, run /login to sign in and then /model to choose a model. " +
						"From a terminal, run `veyyon auth-broker login` to sign in and `veyyon models` to see what is available. " +
						"With no terminal at all, set the provider's API key environment variable and pass `--model <provider>/<id>`.",
				);
			}

			const apiKey = await this.#modelRegistry.getApiKey(this.model, this.sessionId);
			if (!apiKey) {
				const provider = this.model.provider;

				const signedIn = this.#modelRegistry.authStorage.hasAuth(provider);

				const disabledCause = signedIn
					? undefined
					: this.#modelRegistry.authStorage.disabledCredentialCause(provider);
				throw new Error(
					signedIn
						? `Signed in to ${provider}, but could not get a usable token right now.\n\n` +
								`The stored token may have expired and its refresh failed, or ${provider} rejected it ` +
								`(for example a lapsed subscription or unpaid balance). ` +
								`${credentialRemedySentence(provider)} ` +
								`If signing in again succeeds and the next call still fails the same way, the problem is on the ${provider} side: check that account's billing and plan status. ` +
								`Your credentials are still stored in ${getActiveAuthDbPath()}.`
						: disabledCause
							? `Your ${provider} login was disabled after a token refresh failed, so there is no usable credential right now.\n\n` +
								`The provider rejected the refresh with: ${disabledCause}\n\n` +
								`This usually means the refresh token was already spent or revoked, which a crash mid-refresh can cause. ` +
								`${credentialRemedySentence(provider)} ` +
								`The disabled credential is still recorded in ${getActiveAuthDbPath()} and signing in replaces it.`
							: `No API key found for ${provider}.\n\n` +
								`${credentialRemedySentence(provider)} ` +
								`Stored credentials live in ${getActiveAuthDbPath()}.`,
				);
			}

			startupMarker("prompt:compaction-check:start");

			const lastAssistant = this.#findLastAssistantMessage();
			if (lastAssistant && !options?.skipCompactionCheck) {
				await this.#checkCompaction(lastAssistant, false, false);
			}
			startupMarker("prompt:compaction-check:done");

			startupMarker("prompt:plan-arm:start");
			await this.#armPlanYoloIfNeeded();
			startupMarker("prompt:plan-arm:done");

			startupMarker("prompt:context-build:start");
			const messages: AgentMessage[] = [];
			const planReferenceMessage = await this.#buildPlanReferenceMessage?.();
			if (planReferenceMessage) {
				messages.push(planReferenceMessage);
			}
			const planModeMessage = await this.#buildPlanModeMessage();
			if (planModeMessage) {
				messages.push(planModeMessage);
			}
			const goalModeMessage = this.#buildGoalModeMessage();
			if (goalModeMessage) {
				messages.push(goalModeMessage);
			}
			const vibeModeMessage = this.#buildVibeModeMessage();
			if (vibeModeMessage) {
				messages.push(vibeModeMessage);
			}
			if (options?.prependMessages) {
				messages.push(...options.prependMessages);
			}

			messages.push(message);

			if (this.#promptGeneration !== generation) {
				return;
			}

			for (const msg of this.#pendingNextTurnMessages) {
				messages.push(msg);
			}
			this.#pendingNextTurnMessages = [];

			const fileMentions = extractFileMentions(expandedText);
			if (fileMentions.length > 0) {
				const fileMentionMessages = await generateFileMentionMessages(fileMentions, this.sessionManager.getCwd(), {
					autoResizeImages: this.settings.get("images.autoResize"),
					useHashLines: resolveFileDisplayMode(this).hashLines,
					snapshotStore: getFileSnapshotStore(this),
				});
				for (const fileMentionMessage of fileMentionMessages) {
					messages.push(await this.#normalizeAgentMessageImages(fileMentionMessage));
				}
			}

			startupMarker("prompt:memory-context:start");
			const memoryContextMessage = await this.#collectVolatileMemoryContext(expandedText);
			if (memoryContextMessage) messages.unshift(memoryContextMessage);
			startupMarker("prompt:memory-context:done");
			startupMarker("prompt:context-build:done");

			const sessionStateMessage = this.#buildSessionStateMessage();
			if (sessionStateMessage) messages.unshift(sessionStateMessage);
			const beforeAgentStartSystemPrompt = this.#baseSystemPrompt;
			startupMarker("prompt:before-agent-start:start");

			if (this.#extensionRunner) {
				const result = await this.#extensionRunner.emitBeforeAgentStart(
					expandedText,
					options?.images,
					beforeAgentStartSystemPrompt,
				);
				if (result?.messages) {
					const promptAttribution: "user" | "agent" | undefined =
						"attribution" in message ? message.attribution : undefined;
					for (const msg of result.messages) {
						const normalized = normalizeCustomMessagePayload(msg);
						const hasExplicitAttribution =
							msg !== null &&
							typeof msg === "object" &&
							!Array.isArray(msg) &&
							(msg.attribution === "user" || msg.attribution === "agent");
						messages.push(
							await this.#normalizeAgentMessageImages({
								role: "custom",
								customType: normalized.customType,
								content: normalized.content,
								display: normalized.display,
								details: normalized.details,
								attribution: hasExplicitAttribution
									? normalized.attribution
									: (promptAttribution ?? (message.role === "user" ? "user" : "agent")),
								timestamp: Date.now(),
							}),
						);
					}
				}

				if (result?.systemPrompt !== undefined) {
					this.agent.setSystemPrompt(result.systemPrompt);
				} else {
					this.agent.setSystemPrompt(beforeAgentStartSystemPrompt);
				}
			} else {
				this.agent.setSystemPrompt(beforeAgentStartSystemPrompt);
			}

			startupMarker("prompt:before-agent-start:done");

			if (this.#promptGeneration !== generation) {
				return;
			}

			if (this.#autoThinking && message.role === "user") {
				await this.#applyAutoThinkingLevel(expandedText, generation);
				if (this.#promptGeneration !== generation) {
					return;
				}
			}

			startupMarker("prompt:pre-prompt-compaction:start");
			await this.#runPrePromptCompactionIfNeeded(messages);
			startupMarker("prompt:pre-prompt-compaction:done");
			if (this.#promptGeneration !== generation) {
				return;
			}

			const agentPromptOptions = options?.toolChoice ? { toolChoice: options.toolChoice } : undefined;
			const nonMessageTokens = computeNonMessageTokens(this);
			const contextWindow = this.model?.contextWindow ?? 0;
			const breakdown = this.getContextBreakdown({ contextWindow, pendingMessages: messages });
			const promptTokens =
				breakdown?.usedTokens ??
				nonMessageTokens +
					this.messages.reduce((sum, msg) => sum + estimateTokens(msg), 0) +
					messages.reduce((sum, msg) => sum + estimateTokens(msg), 0);
			const contextDetail = sessionTelemetryDetail(
				this.settings.get("session.instrumentation"),
				"context-breakdown",
			);
			const pendingContextSnapshot: PendingContextSnapshot = {
				promptTokens,
				nonMessageTokens,
				cutoffCount: this.messages.length,
				submitted: new Set(messages),
				detail: contextDetail,
			};
			if (contextDetail === "rich" || contextDetail === "ultra") {
				const tailTokens =
					breakdown?.pendingMessagesTokens ?? messages.reduce((sum, msg) => sum + estimateTokens(msg), 0);
				const attribution = estimateContextSnapshotAttribution(
					promptTokens,
					nonMessageTokens,
					tailTokens,
					"estimate",
					contextDetail === "ultra" ? getLatestCompactionEntry(this.sessionManager.getBranch())?.id : undefined,
				);
				pendingContextSnapshot.storedMessagesTokens = attribution.storedMessagesTokens;
				pendingContextSnapshot.tailTokens = attribution.tailTokens;
				pendingContextSnapshot.compactionEntryId = attribution.compactionEntryId;
			}
			this.#setPendingContextSnapshot(pendingContextSnapshot);
			try {
				await this.#promptAgentWithIdleRetry(messages, agentPromptOptions);
			} finally {
				this.#setPendingContextSnapshot(undefined);
			}
			if (!options?.skipPostPromptRecoveryWait) {
				await this.#waitForPostPromptRecovery(generation);
			}
		} finally {
			this.#endInFlight();
		}
	}

	async #tryExecuteExtensionCommand(text: string): Promise<boolean> {
		if (!this.#extensionRunner) return false;

		const parsed = parseSlashCommand(text);
		if (!parsed) return false;
		const commandName = parsed.name;
		const args = parsed.args;

		const command = this.#extensionRunner.getCommand(commandName);
		if (!command) return false;

		const ctx = this.#extensionRunner.createCommandContext();

		try {
			await command.handler(args, ctx);
			return true;
		} catch (err) {
			this.#extensionRunner.emitError({
				extensionPath: `command:${commandName}`,
				event: "command",
				error: errorMessage(err),
			});
			return true;
		}
	}

	#createCommandContext(): ExtensionCommandContext {
		if (this.#extensionRunner) {
			return this.#extensionRunner.createCommandContext();
		}

		return {
			ui: noOpUIContext,
			hasUI: false,
			cwd: this.sessionManager.getCwd(),
			sessionManager: this.sessionManager,
			modelRegistry: this.#modelRegistry,
			model: this.model ?? undefined,
			models: createExtensionModelQuery(this.#modelRegistry, this.settings, () => this.model ?? undefined),
			isIdle: () => !this.isStreaming,

			abort: () => {
				abortDetached(this, "agent-session.commandContext.abort", USER_INTERRUPT_LABEL);
			},
			hasPendingMessages: () => this.queuedMessageCount > 0,
			shutdown: () => {
				void Promise.race([this.dispose(), Bun.sleep(SHUTDOWN_DISPOSE_TIMEOUT_MS)])
					.catch(error => {
						logger.error("Session dispose failed during shutdown", { error: errorMessage(error) });
					})
					.finally(() => process.exit(0));
			},
			getContextUsage: () => this.getContextUsage(),
			waitForIdle: () => this.waitForIdle(),
			newSession: async options => {
				const success = await this.newSession({ parentSession: options?.parentSession });
				if (!success) {
					return { cancelled: true };
				}
				if (options?.setup) {
					await options.setup(this.sessionManager);
				}
				return { cancelled: false };
			},
			branch: async entryId => {
				const result = await this.branch(entryId);
				return { cancelled: result.cancelled };
			},
			navigateTree: async (targetId, options) => {
				const result = await this.navigateTree(targetId, { summarize: options?.summarize });
				return { cancelled: result.cancelled };
			},
			compact: async instructionsOrOptions => {
				const instructions = typeof instructionsOrOptions === "string" ? instructionsOrOptions : undefined;
				const options =
					instructionsOrOptions && typeof instructionsOrOptions === "object" ? instructionsOrOptions : undefined;
				await this.compact(instructions, options);
			},
			switchSession: async sessionPath => {
				const success = await this.switchSession(sessionPath);
				return { cancelled: !success };
			},
			reload: async () => {
				await this.reload();
			},
			getSystemPrompt: () => this.systemPrompt,
		};
	}

	async #tryExecuteCustomCommand(text: string): Promise<string | null> {
		if (this.#customCommands.length === 0 && this.#mcpPromptCommands.length === 0) return null;

		const parsed = parseSlashCommand(text);
		if (!parsed) return null;
		const commandName = parsed.name;
		const argsString = parsed.args;

		const loaded =
			this.#customCommands.find(c => c.command.name === commandName) ??
			this.#mcpPromptCommands.find(c => c.command.name === commandName);
		if (!loaded) return null;

		const baseCtx = this.#createCommandContext();
		const ctx = {
			...baseCtx,
			hasQueuedMessages: baseCtx.hasPendingMessages,
		} as unknown as HookCommandContext;

		try {
			const args = parseCommandArgs(argsString);
			const result = await loaded.command.execute(args, ctx);

			if (typeof result === "string" && result.length > 0) {
				this.#grantAgentsForTurn(loaded.command.spawnsAgents);
			}
			return result ?? "";
		} catch (err) {
			if (this.#extensionRunner) {
				this.#extensionRunner.emitError({
					extensionPath: `custom-command:${commandName}`,
					event: "command",
					error: errorMessage(err),
				});
			} else {
				const message = errorMessage(err);
				logger.error("Custom command failed", { commandName, error: message });
			}
			return "";
		}
	}

	async steer(text: string, images?: ImageContent[]): Promise<void> {
		if (text.startsWith("/")) {
			this.#throwIfExtensionCommand(text);
		}

		const expandedText = expandPromptTemplate(text, [...this.#promptTemplates]);
		await this.#queueUserMessage(expandedText, images, "steer");
	}

	async followUp(text: string, images?: ImageContent[], options?: FollowUpOptions): Promise<void> {
		if (text.startsWith("/")) {
			this.#throwIfExtensionCommand(text);
		}

		const expandedText =
			options?.expandPromptTemplates === false ? text : expandPromptTemplate(text, [...this.#promptTemplates]);
		if (!options?.synthetic) {
			await this.#queueUserMessage(expandedText, images, "followUp");
			return;
		}

		const normalizedImages = await this.#normalizeImagesForModel(images);
		const content: (TextContent | ImageContent)[] = [{ type: "text", text: expandedText }];
		if (normalizedImages?.length) {
			content.push(...normalizedImages);
		}
		const imageDescriptionNotice = normalizedImages?.length
			? await this.#buildImageDescriptionNotice(normalizedImages)
			: undefined;
		if (imageDescriptionNotice) this.agent.followUp(imageDescriptionNotice);
		this.agent.followUp({
			role: "developer",
			content,
			attribution: options.attribution ?? "agent",
			timestamp: Date.now(),
		});
		this.#scheduleIdleQueueDrain();
	}

	async #queueUserMessage(
		text: string,
		images: ImageContent[] | undefined,
		mode: "steer" | "followUp",
	): Promise<void> {
		this.#advisorAutoResumeSuppressed = false;
		const normalizedImages = await this.#normalizeImagesForModel(images);
		const content: (TextContent | ImageContent)[] = [{ type: "text", text }];
		if (normalizedImages?.length) {
			content.push(...normalizedImages);
		}

		const imageDescriptionNotice = normalizedImages?.length
			? await this.#buildImageDescriptionNotice(normalizedImages)
			: undefined;
		if (mode === "followUp") {
			if (imageDescriptionNotice) this.agent.followUp(imageDescriptionNotice);
			this.agent.followUp({
				role: "user",
				content,
				attribution: "user",
				timestamp: Date.now(),
			});
		} else {
			if (imageDescriptionNotice) this.agent.steer(imageDescriptionNotice);
			this.agent.steer({
				role: "user",
				content,
				steering: true,
				attribution: "user",
				timestamp: Date.now(),
			});
		}
		this.#scheduleIdleQueueDrain();
	}

	#scheduleIdleQueueDrain(): void {
		this.#scheduleQueuedMessageDrain();
	}

	#scheduleQueuedMessageDrain(): void {
		if (this.#queuedMessageDrainScheduled || !this.#canAutoContinueForFollowUp() || !this.agent.hasQueuedMessages()) {
			return;
		}
		this.#queuedMessageDrainScheduled = true;
		this.#scheduleAgentContinue({
			shouldContinue: () => {
				this.#queuedMessageDrainScheduled = false;
				return this.#canAutoContinueForFollowUp() && this.agent.hasQueuedMessages();
			},
			onSkip: () => {
				this.#queuedMessageDrainScheduled = false;
			},
			onError: () => {
				this.#queuedMessageDrainScheduled = false;
			},
		});
	}

	#canAutoContinueForFollowUp(): boolean {
		if (this.isStreaming) return false;
		if (this.isRetrying) return false;

		if (this.agent.peekSteeringQueue().length > 0) return true;

		if (this.#advisorAutoResumeSuppressed) return false;

		const messages = this.agent.state.messages;
		const last = messages[messages.length - 1];
		return last?.role === "assistant" || last?.role === "toolResult";
	}

	queueDeferredMessage(message: CustomMessage): void {
		this.#queueHiddenNextTurnMessage(message, true);
	}

	#queueHiddenNextTurnMessage(message: CustomMessage, triggerTurn: boolean): void {
		this.#pendingNextTurnMessages.push(message);
		if (!triggerTurn) return;
		const generation = this.#promptGeneration;
		if (this.#scheduledHiddenNextTurnGeneration === generation) {
			return;
		}
		this.#scheduledHiddenNextTurnGeneration = generation;
		this.#schedulePostPromptTask(
			async () => {
				if (this.#scheduledHiddenNextTurnGeneration === generation) {
					this.#scheduledHiddenNextTurnGeneration = undefined;
				}
				if (this.#pendingNextTurnMessages.length === 0) {
					return;
				}
				try {
					await this.#promptQueuedHiddenNextTurnMessages();
				} catch {}
			},
			{
				generation,
				onSkip: () => {
					if (this.#scheduledHiddenNextTurnGeneration === generation) {
						this.#scheduledHiddenNextTurnGeneration = undefined;
					}
				},
			},
		);
	}

	async #promptQueuedHiddenNextTurnMessages(): Promise<void> {
		if (this.#pendingNextTurnMessages.length === 0) {
			return;
		}

		const queuedMessages = [...this.#pendingNextTurnMessages];
		this.#pendingNextTurnMessages = [];
		const message = queuedMessages[queuedMessages.length - 1];
		if (!message) {
			return;
		}

		const prependMessages = queuedMessages.slice(0, -1);
		const textContent = this.#getCustomMessageTextContent(message);
		try {
			await this.#promptWithMessage(message, textContent, {
				prependMessages,
				skipPostPromptRecoveryWait: true,
			});
		} catch (error) {
			this.#pendingNextTurnMessages = [...queuedMessages, ...this.#pendingNextTurnMessages];
			throw error;
		}
	}

	#getCustomMessageTextContent(message: Pick<CustomMessage, "content">): string {
		return contentText(message.content, { separator: "" });
	}

	#throwIfExtensionCommand(text: string): void {
		if (!this.#extensionRunner) return;

		const parsed = parseSlashCommand(text);
		if (!parsed) return;
		const commandName = parsed.name;
		const command = this.#extensionRunner.getCommand(commandName);

		if (command) {
			throw new Error(
				`Extension command "/${commandName}" cannot be queued. Use prompt() or execute the command when not streaming.`,
			);
		}
	}

	async #promptAgentInitiatedMessage(
		message: CustomMessage,
		options?: { acceptTerminalEmptyStop?: boolean },
	): Promise<void> {
		this.#beginInFlight();
		try {
			const acceptTerminalEmptyStop = options?.acceptTerminalEmptyStop === true;
			if (acceptTerminalEmptyStop) {
				this.#resetPromptMaintenanceState();
			}
			this.#acceptTerminalEmptyStopForPrompt = acceptTerminalEmptyStop;
			await this.agent.prompt(message);
			await this.#waitForPostPromptRecovery();
		} finally {
			this.#acceptTerminalEmptyStopForPrompt = false;
			this.#endInFlight();
		}
	}

	async #queueCustomMessage<T = unknown>(
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details" | "attribution">,
		deliverAs: "steer" | "followUp",
		queueChipText?: string,
	): Promise<void> {
		const details =
			queueChipText !== undefined
				? ({
						...((message.details && typeof message.details === "object" ? message.details : {}) as Record<
							string,
							unknown
						>),
						__queueChipText: queueChipText,
					} as T)
				: message.details;
		const appMessage: CustomMessage<T> = {
			role: "custom",
			customType: message.customType,
			content: message.content,
			display: message.display,
			details,
			attribution: message.attribution ?? "agent",
			timestamp: Date.now(),
		};
		const normalizedAppMessage = await this.#normalizeAgentMessageImages(appMessage);
		if (deliverAs === "followUp") {
			this.agent.followUp(normalizedAppMessage);
		} else {
			this.agent.steer(normalizedAppMessage);
		}
	}

	async sendCustomMessage<T = unknown>(
		message: CustomMessagePayload<T>,
		options?: {
			triggerTurn?: boolean;
			deliverAs?: "steer" | "followUp" | "nextTurn";
			queueChipText?: string;
			acceptTerminalEmptyStop?: boolean;
		},
	): Promise<boolean> {
		if (options?.triggerTurn) await this.#startupHydration;
		const normalizedPayload = normalizeCustomMessagePayload<T>(message);
		const details =
			options?.queueChipText && options.deliverAs !== "nextTurn"
				? ({
						...((normalizedPayload.details && typeof normalizedPayload.details === "object"
							? normalizedPayload.details
							: {}) as Record<string, unknown>),
						__queueChipText: options.queueChipText,
					} as T)
				: normalizedPayload.details;
		const appMessage: CustomMessage<T> = {
			role: "custom",
			customType: normalizedPayload.customType,
			content: normalizedPayload.content,
			display: normalizedPayload.display,
			details,
			attribution: normalizedPayload.attribution,
			timestamp: Date.now(),
		};
		const normalizedAppMessage = await this.#normalizeAgentMessageImages(appMessage);
		if (this.isStreaming) {
			if (options?.deliverAs === "nextTurn") {
				this.#queueHiddenNextTurnMessage(normalizedAppMessage, options?.triggerTurn ?? false);
				return false;
			}

			if (options?.deliverAs === "followUp") {
				this.agent.followUp(normalizedAppMessage);
			} else {
				this.agent.steer(normalizedAppMessage);
			}
			this.#scheduleIdleQueueDrain();
			return false;
		}

		if (options?.deliverAs === "nextTurn") {
			if (options?.triggerTurn) {
				if (this.#clientBridge?.deferAgentInitiatedTurns && !this.#allowAcpAgentInitiatedTurns) {
					this.#queueHiddenNextTurnMessage(normalizedAppMessage, false);
					return false;
				}
				await this.#promptAgentInitiatedMessage(normalizedAppMessage, {
					acceptTerminalEmptyStop: options.acceptTerminalEmptyStop === true,
				});
				return true;
			}
			this.agent.appendMessage(normalizedAppMessage);
			this.sessionManager.appendCustomMessageEntry(
				normalizedAppMessage.customType,
				normalizedAppMessage.content,
				normalizedAppMessage.display,
				normalizedAppMessage.details,
				normalizedAppMessage.attribution,
			);
			return false;
		}

		if (options?.triggerTurn) {
			if (this.#clientBridge?.deferAgentInitiatedTurns && !this.#allowAcpAgentInitiatedTurns) {
				this.#queueHiddenNextTurnMessage(normalizedAppMessage, false);
				return false;
			}
			await this.#promptAgentInitiatedMessage(normalizedAppMessage);
			return true;
		}

		this.agent.appendMessage(normalizedAppMessage);
		this.sessionManager.appendCustomMessageEntry(
			normalizedAppMessage.customType,
			normalizedAppMessage.content,
			normalizedAppMessage.display,
			normalizedAppMessage.details,
			normalizedAppMessage.attribution,
		);
		return false;
	}

	async sendUserMessage(
		content: string | (TextContent | ImageContent)[],
		options?: { deliverAs?: "steer" | "followUp" },
	): Promise<void> {
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

		if (options?.deliverAs === "followUp") {
			await this.#queueUserMessage(text, images, "followUp");
			return;
		}
		if (options?.deliverAs === "steer") {
			await this.#queueUserMessage(text, images, "steer");
			return;
		}

		await this.prompt(text, {
			expandPromptTemplates: false,
			images,
			streamingBehavior: "steer",
		});
	}

	clearQueue(options?: { forInterrupt?: boolean }): {
		steering: RestoredQueuedMessage[];
		followUp: RestoredQueuedMessage[];
	} {
		const steeringAll = this.agent.peekSteeringQueue();
		const followUpAll = this.agent.peekFollowUpQueue();
		const steering = steeringAll.filter(isUserQueuedMessage).map(toRestoredQueuedMessage);
		const followUp = followUpAll.filter(isUserQueuedMessage).map(toRestoredQueuedMessage);
		const keep: (m: AgentMessage) => boolean = options?.forInterrupt
			? isAdvisorCard
			: m => !isUserQueuedMessage(m) && !isHiddenUserCompanion(m);
		this.agent.replaceQueues(steeringAll.filter(keep), followUpAll.filter(keep));
		return { steering, followUp };
	}

	get queuedMessageCount(): number {
		return (
			this.agent.peekSteeringQueue().filter(isDisplayableQueuedMessage).length +
			this.agent.peekFollowUpQueue().filter(isDisplayableQueuedMessage).length +
			this.#pendingNextTurnMessages.length
		);
	}

	getQueuedMessages(): { steering: readonly string[]; followUp: readonly string[] } {
		return {
			steering: this.agent.peekSteeringQueue().filter(isUserQueuedMessage).map(queueChipText),
			followUp: this.agent.peekFollowUpQueue().filter(isUserQueuedMessage).map(queueChipText),
		};
	}

	popLastQueuedMessage(): RestoredQueuedMessage | undefined {
		const steering = this.agent.peekSteeringQueue();
		const followUp = this.agent.peekFollowUpQueue();
		const lastUserIndex = (queue: readonly AgentMessage[]): number => {
			for (let i = queue.length - 1; i >= 0; i--) {
				if (isUserQueuedMessage(queue[i])) return i;
			}
			return -1;
		};

		const removeWithCompanions = (queue: readonly AgentMessage[], userIndex: number): AgentMessage[] => {
			let start = userIndex;
			while (start > 0 && isHiddenUserCompanion(queue[start - 1])) start--;
			const next = queue.slice();
			next.splice(start, userIndex - start + 1);
			return next;
		};
		const fromSteer = lastUserIndex(steering);
		if (fromSteer >= 0) {
			const removed = steering[fromSteer];
			this.agent.replaceQueues(removeWithCompanions(steering, fromSteer), followUp.slice());
			return toRestoredQueuedMessage(removed);
		}
		const fromFollowUp = lastUserIndex(followUp);
		if (fromFollowUp >= 0) {
			const removed = followUp[fromFollowUp];
			this.agent.replaceQueues(steering.slice(), removeWithCompanions(followUp, fromFollowUp));
			return toRestoredQueuedMessage(removed);
		}
		return undefined;
	}

	get skillsSettings(): SkillsSettings | undefined {
		return this.#skillsSettings;
	}

	get skills(): readonly Skill[] {
		return this.#skills;
	}

	replaceSkills(skills: readonly Skill[]): void {
		this.#skills = [...skills];
	}

	replaceProjectAdvisorScope(scope: ProjectAdvisorScope): void {
		this.#stopAdvisorRuntime();
		this.#advisorWatchdogPrompt = scope.advisorWatchdogPrompt;
		this.#advisorContextPrompt = scope.advisorContextPrompt;
		this.#advisorSharedInstructions = scope.advisorSharedInstructions;
		this.#advisorConfigs = scope.advisorConfigs;
		this.#advisorEnabled = isAdvisorProductEnabled() && (this.settings.get("advisor.enabled") as boolean);
		if (this.#advisorEnabled) this.#buildAdvisorRuntime();
	}

	get operatorNotices(): OperatorNotices {
		return this.#operatorNotices;
	}

	getTodoPhases(): TodoPhase[] {
		return this.#cloneTodoPhases(this.#todoPhases);
	}

	setTodoPhases(phases: TodoPhase[]): void {
		const nextPhases = this.#cloneTodoPhases(phases);
		const previous = todoReminderFingerprint(incompleteTodoItems(this.#todoPhases));
		const next = todoReminderFingerprint(incompleteTodoItems(nextPhases));
		this.#todoPhases = nextPhases;
		if (previous !== next) {
			if (previous === "[]" || next === "[]") this.#todoReminderCount = 0;
			this.#todoReminderAwaitingProgress = false;
			this.#lastTodoReminderFingerprint = undefined;
		}
	}

	#resetTodoReminderStateForNewContext(): void {
		this.#todoReminderCount = 0;
		this.#todoReminderAwaitingProgress = false;
		this.#lastTodoReminderFingerprint = undefined;
		this.#todoReminderEchoCompactionId = undefined;
		this.#lastTodoFailureText = undefined;
		this.#mutationsSinceLastTodoTouch = 0;
		this.#midRunNudgeCount = 0;
	}

	#isTodoInitResult(details: Record<string, unknown>, toolCallId: string | undefined): boolean {
		const detailOp = getStringProperty(details, "op");
		if (detailOp) return detailOp === "init";
		if (!toolCallId) return false;
		for (let i = this.agent.state.messages.length - 1; i >= 0; i--) {
			const message = this.agent.state.messages[i];
			if (!message) continue;
			const op = toolCallOpFromMessage(message, toolCallId);
			if (op) return op === "init";
		}
		return false;
	}

	#buildReplanTitleContext(): string {
		const turns: TitleConversationTurn[] = [];
		for (
			let i = this.agent.state.messages.length - 1;
			i >= 0 && turns.length < REPLAN_TITLE_CONTEXT_TURN_LIMIT;
			i--
		) {
			const message = this.agent.state.messages[i];
			if (!message) continue;
			const turn = titleConversationTurnFromMessage(message);
			if (turn) turns.push(turn);
		}
		turns.reverse();
		return formatTitleConversationContext(turns);
	}

	#scheduleReplanTitleRefresh(): void {
		if (this.#replanTitleRefreshInFlight) return;
		if (!this.settings.get("title.refreshOnReplan")) return;
		if (this.sessionManager.titleSource === "user") return;
		const context = this.#buildReplanTitleContext();
		if (!context) return;
		const sessionId = this.sessionManager.getSessionId();
		const refresh = this.#refreshTitleAfterReplan(context, sessionId)
			.catch(err => {
				logger.warn("title-generator: replan refresh failed", {
					sessionId,
					error: errorMessage(err),
				});
			})
			.finally(() => {
				if (this.#replanTitleRefreshInFlight === refresh) {
					this.#replanTitleRefreshInFlight = undefined;
				}
			});
		this.#replanTitleRefreshInFlight = refresh;
	}

	async #refreshTitleAfterReplan(context: string, sessionId: string): Promise<void> {
		const title = await generateSessionTitle(
			context,
			this.#modelRegistry,
			this.settings,
			sessionId,
			this.model,
			provider => this.agent.metadataForProvider(provider),
			this.#titleSystemPrompt,
			text => this.obfuscateProviderText(text),
			this.#sideCompleteImpl,
		);
		if (!title) return;
		if (this.sessionManager.getSessionId() !== sessionId) return;
		if (!this.settings.get("title.refreshOnReplan")) return;
		if (this.sessionManager.titleSource === "user") return;
		const setSessionName = this.sessionManager.setSessionName as SetSessionNameWithTrigger;
		await setSessionName.call(this.sessionManager, title, "auto", "replan");
	}

	get titleSystemPrompt(): string | undefined {
		return this.#titleSystemPrompt;
	}

	setTitleSystemPrompt(prompt: string | undefined): void {
		this.#titleSystemPrompt = prompt;
	}

	#syncTodoPhasesFromBranch(): void {
		this.setTodoPhases(getLatestTodoPhasesFromEntries(this.sessionManager.getBranch()));
	}

	#cloneTodoPhases(phases: TodoPhase[]): TodoPhase[] {
		return phases.map(phase => ({
			name: phase.name,
			tasks: phase.tasks.map(task => ({ content: task.content, status: task.status })),
		}));
	}

	async abort(options?: {
		goalReason?: GoalAbortReason;
		reason?: string;

		preserveCompaction?: boolean;
	}): Promise<void> {
		const userInterrupt = options?.reason === USER_INTERRUPT_LABEL;
		this.#pendingAbortErrorId = userInterrupt ? AIError.create(AIError.Flag.UserInterrupt) : undefined;
		if (userInterrupt) this.#advisorAutoResumeSuppressed = true;

		const strandedAdvisorCards = userInterrupt ? this.#extractQueuedAdvisorCards() : [];

		this.#abortInProgress = true;
		try {
			this.abortRetry();
			this.#promptGeneration++;
			this.#scheduledHiddenNextTurnGeneration = undefined;
			if (options?.preserveCompaction) {
				this.#autoCompactionAbortController?.abort();
			} else {
				this.abortCompaction();
			}
			this.abortHandoff();
			this.abortBash();
			this.abortEval();

			for (const a of this.#advisors) a.runtime.cancelInFlight(options?.reason ?? "primary aborted");
			const postPromptDrain = this.#cancelPostPromptTasks();
			this.agent.abort(options?.reason);
			await postPromptDrain;
			await this.agent.waitForIdle();
			await this.#goalRuntime.onTaskAborted({ reason: options?.goalReason ?? "interrupted" });

			this.#resetInFlight();
			this.#resetSessionStopContinuationState();
			this.#clearPendingSessionStopContinuations();

			if (this.#toolChoiceQueue.hasInFlight) {
				this.#toolChoiceQueue.reject("aborted");
			}

			const parkedAdvisorCards = this.#pendingNextTurnMessages.filter(isAdvisorCard);
			if (parkedAdvisorCards.length > 0) {
				this.#pendingNextTurnMessages = this.#pendingNextTurnMessages.filter(m => !isAdvisorCard(m));
			}
			for (const card of [...strandedAdvisorCards, ...parkedAdvisorCards]) {
				this.#preserveAdvisorCard(card);
			}
		} finally {
			this.#abortInProgress = false;
			this.#drainStrandedQueuedMessages();
		}
	}

	async newSession(options?: NewSessionOptions): Promise<boolean> {
		const previousSessionFile = this.sessionFile;
		const nextDiscoverySessionToolNames = this.#mcpDiscoveryEnabled
			? [
					...this.#getActiveNonMCPToolNames(),
					...this.#filterSelectableMCPToolNames(this.#defaultSelectedMCPToolNames),
				]
			: undefined;

		if (this.#extensionRunner?.hasHandlers("session_before_switch")) {
			const result = (await this.#extensionRunner.emit({
				type: "session_before_switch",
				reason: "new",
			})) as SessionBeforeSwitchResult | undefined;

			if (result?.cancel) {
				return false;
			}
		}

		this.#disconnectFromAgent();
		await this.abort();
		this.#cancelOwnAsyncJobs();
		this.#closeAllProviderSessions("new session");
		this.agent.reset();
		if (options?.drop && previousSessionFile) {
			for (const a of this.#advisors) {
				a.agentUnsubscribe?.();
				a.agentUnsubscribe = undefined;
				await a.recorder.close();
			}
			try {
				await this.sessionManager.dropSession(previousSessionFile);
			} catch (err) {
				logger.error("Failed to delete session during /drop", { err });
			}
		} else {
			await this.sessionManager.flush();
		}
		await this.sessionManager.newSession(options);

		await this.#rescopeAgentRegistry();

		this.#clearCheckpointRuntimeState();
		this.setTodoPhases([]);
		this.#freshProviderSessionId = undefined;
		this.#clearInheritedProviderPromptCacheKey("new-session");
		this.#syncAgentSessionId();
		this.#rekeyHindsightMemoryForCurrentSessionId();
		this.#rekeyMnemopiMemoryForCurrentSessionId();
		this.#resetMemoryContextForNewTranscript();
		this.#pendingNextTurnMessages = [];
		this.#scheduledHiddenNextTurnGeneration = undefined;

		this.sessionManager.appendThinkingLevelChange(this.thinkingLevel, this.configuredThinkingLevel());
		this.sessionManager.appendServiceTierChange(this.#serviceTierEntry());
		if (nextDiscoverySessionToolNames) {
			await this.#applyActiveToolsByName(nextDiscoverySessionToolNames, { persistMCPSelection: false });
			if (this.getSelectedMCPToolNames().length > 0) {
				this.sessionManager.appendMCPToolSelection(this.getSelectedMCPToolNames());
			}
		}
		this.#rememberSessionDefaultSelectedMCPToolNames(
			this.sessionFile,
			this.#getConfiguredDefaultSelectedMCPToolNames(),
		);

		this.#resetTodoReminderStateForNewContext();
		this.#planReferenceSent = false;
		this.#planReferencePath = DEFAULT_PLAN_FILE_URL;
		this.#resetAdvisorSessionState();
		this.#reconnectToAgent();

		if (this.#extensionRunner) {
			await this.#extensionRunner.emit({
				type: "session_switch",
				reason: "new",
				previousSessionFile,
			});
		}

		return true;
	}

	setSessionName(name: string, source: "auto" | "user" = "auto", trigger?: SessionNameTrigger): Promise<boolean> {
		const setSessionName = this.sessionManager.setSessionName as SetSessionNameWithTrigger;
		return setSessionName.call(this.sessionManager, name, source, trigger);
	}

	async fork(): Promise<boolean> {
		const previousSessionFile = this.sessionFile;

		if (this.#extensionRunner?.hasHandlers("session_before_switch")) {
			const result = (await this.#extensionRunner.emit({
				type: "session_before_switch",
				reason: "fork",
			})) as SessionBeforeSwitchResult | undefined;

			if (result?.cancel) {
				return false;
			}
		}

		await this.sessionManager.flush();

		const forkResult = await this.sessionManager.fork();
		if (!forkResult) {
			return false;
		}

		const oldArtifactDir = forkResult.oldSessionFile.slice(0, -6);
		const newArtifactDir = forkResult.newSessionFile.slice(0, -6);

		try {
			const oldDirStat = await fs.promises.stat(oldArtifactDir);
			if (oldDirStat.isDirectory()) {
				await fs.promises.cp(oldArtifactDir, newArtifactDir, { recursive: true });
			}
		} catch (err) {
			if (!isEnoent(err)) {
				logger.warn("Failed to copy artifacts during fork", {
					oldArtifactDir,
					newArtifactDir,
					error: errorMessage(err),
				});
			}
		}

		this.#freshProviderSessionId = undefined;
		this.#adoptInheritedProviderPromptCacheKey();
		this.#syncAgentSessionId();
		this.#rekeyHindsightMemoryForCurrentSessionId();
		this.#rekeyMnemopiMemoryForCurrentSessionId();
		this.#resetMemoryContextForNewTranscript();

		if (this.#extensionRunner) {
			await this.#extensionRunner.emit({
				type: "session_switch",
				reason: "fork",
				previousSessionFile,
			});
		}

		return true;
	}

	async setModel(
		model: Model,
		role: string = DEFAULT_MODEL_SLOT,
		options?: {
			selector?: string;
			thinkingLevel?: ConfiguredThinkingLevel;
			persist?: boolean;
			currentContextTokens?: number;
		},
	): Promise<{ switched: boolean }> {
		const previousEditMode = this.#resolveActiveEditMode();
		if (!this.#modelRegistry.hasConfiguredAuth(model)) {
			throw new Error(missingCredentialsMessage(model.provider, model.id, "the requested model"));
		}

		const targetModel = await this.#modelRegistry.refreshSelectedModelMetadata(model);

		this.#modelRegistry.clearSuppressedSelector(formatModelStringWithRouting(targetModel));
		this.#clearActiveRetryFallback();
		this.#setModelWithProviderSessionReset(targetModel);

		const slot = resolveModelSlot(role);
		this.sessionManager.appendModelChange(`${targetModel.provider}/${targetModel.id}`, slot);
		if (options?.persist) {
			this.settings.setModelRole(
				slot,
				this.#formatRoleModelValue(slot, targetModel, options.selector, options.thinkingLevel),
			);
		}
		this.settings.getStorage()?.recordModelUsage(`${targetModel.provider}/${targetModel.id}`);

		this.#reapplyThinkingLevel(options?.thinkingLevel);
		await this.#syncAfterModelChange(previousEditMode);
		return { switched: true };
	}

	async setModelTemporary(
		model: Model,
		thinkingLevel?: ConfiguredThinkingLevel,
		options?: { ephemeral?: boolean },
	): Promise<void> {
		const previousEditMode = this.#resolveActiveEditMode();
		if (!this.#modelRegistry.hasConfiguredAuth(model)) {
			throw new Error(missingCredentialsMessage(model.provider, model.id, "the requested model"));
		}

		const targetModel = await this.#modelRegistry.refreshSelectedModelMetadata(model);

		this.#modelRegistry.clearSuppressedSelector(formatModelStringWithRouting(targetModel));
		this.#clearActiveRetryFallback();
		this.#setModelWithProviderSessionReset(targetModel);
		this.sessionManager.appendModelChange(
			`${targetModel.provider}/${targetModel.id}`,
			options?.ephemeral ? EPHEMERAL_MODEL_CHANGE_ROLE : "temporary",
		);
		this.settings.getStorage()?.recordModelUsage(`${targetModel.provider}/${targetModel.id}`);

		this.#reapplyThinkingLevel(thinkingLevel);
		await this.#syncAfterModelChange(previousEditMode);
	}

	async cycleModel(direction: "forward" | "backward" = "forward"): Promise<ModelCycleResult | undefined> {
		if (this.#scopedModels.length > 0) {
			return this.#cycleScopedModel(direction);
		}
		return this.#cycleAvailableModel(direction);
	}

	getRoleModelCycle(roleOrder: readonly string[]): RoleModelCycle | undefined {
		const availableModels = this.#modelRegistry.getAvailable();
		if (availableModels.length === 0) return undefined;

		const currentModel = this.model;
		if (!currentModel) return undefined;
		const matchPreferences = getModelMatchPreferences(this.settings);
		const models: ResolvedRoleModel[] = [];

		for (const role of roleOrder) {
			const roleModelStr =
				role === "default"
					? (this.settings.getModelRole(DEFAULT_MODEL_SLOT) ?? `${currentModel.provider}/${currentModel.id}`)
					: this.settings.getModelRole(role);
			if (!roleModelStr) continue;

			const resolved = resolveModelRoleValue(roleModelStr, availableModels, {
				settings: this.settings,
				matchPreferences,
			});
			if (!resolved.model) continue;

			models.push({
				role,
				model: resolved.model,
				thinkingLevel: resolved.thinkingLevel,
				explicitThinkingLevel: resolved.explicitThinkingLevel,
			});
		}

		if (models.length === 0) return undefined;

		const lastRole = this.sessionManager.getLastModelChangeRole();
		let currentIndex = lastRole ? models.findIndex(entry => entry.role === lastRole) : -1;
		if (currentIndex !== -1 && !modelsAreEqual(models[currentIndex].model, currentModel)) {
			currentIndex = -1;
		}
		if (currentIndex === -1) {
			currentIndex = models.findIndex(entry => modelsAreEqual(entry.model, currentModel));
		}
		if (currentIndex === -1) currentIndex = 0;

		return { models, currentIndex };
	}

	async applyRoleModel(entry: ResolvedRoleModel): Promise<void> {
		await this.setModel(entry.model, entry.role, {
			thinkingLevel: entry.explicitThinkingLevel ? entry.thinkingLevel : undefined,
		});
	}

	async cycleRoleModels(
		roleOrder: readonly string[],
		direction: "forward" | "backward" = "forward",
	): Promise<RoleModelCycleResult | undefined> {
		const cycle = this.getRoleModelCycle(roleOrder);
		if (!cycle || cycle.models.length <= 1) return undefined;

		const step = direction === "backward" ? -1 : 1;
		const next = cycle.models[(cycle.currentIndex + step + cycle.models.length) % cycle.models.length];

		await this.applyRoleModel(next);

		return { model: next.model, thinkingLevel: this.thinkingLevel, role: next.role };
	}

	async #getScopedModelsWithApiKey(): Promise<
		Array<{
			model: Model;
			thinkingLevel?: ConfiguredThinkingLevel;
			explicitThinkingLevel?: boolean;
		}>
	> {
		const apiKeysByProvider = new Map<string, string | undefined>();
		const result: Array<{
			model: Model;
			thinkingLevel?: ConfiguredThinkingLevel;
			explicitThinkingLevel?: boolean;
		}> = [];

		for (const scoped of this.#scopedModels) {
			const provider = scoped.model.provider;
			let apiKey: string | undefined;
			if (apiKeysByProvider.has(provider)) {
				apiKey = apiKeysByProvider.get(provider);
			} else {
				apiKey = await this.#modelRegistry.getApiKeyForProvider(provider, this.sessionId);
				apiKeysByProvider.set(provider, apiKey);
			}

			if (apiKey) {
				result.push(scoped);
			}
		}

		return result;
	}

	async #cycleScopedModel(direction: "forward" | "backward"): Promise<ModelCycleResult | undefined> {
		const previousEditMode = this.#resolveActiveEditMode();
		const scopedModels = await this.#getScopedModelsWithApiKey();
		if (scopedModels.length <= 1) return undefined;

		const currentModel = this.model;
		let currentIndex = scopedModels.findIndex(sm => modelsAreEqual(sm.model, currentModel));

		if (currentIndex === -1) currentIndex = 0;
		const len = scopedModels.length;
		const nextIndex = direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
		const next = scopedModels[nextIndex];

		this.#modelRegistry.clearSuppressedSelector(formatModelStringWithRouting(next.model));
		this.#clearActiveRetryFallback();
		this.#setModelWithProviderSessionReset(next.model);
		this.sessionManager.appendModelChange(`${next.model.provider}/${next.model.id}`);
		this.settings.getStorage()?.recordModelUsage(`${next.model.provider}/${next.model.id}`);

		this.#reapplyThinkingLevel(next.explicitThinkingLevel ? next.thinkingLevel : undefined);
		await this.#syncAfterModelChange(previousEditMode);

		return { model: next.model, thinkingLevel: this.thinkingLevel, isScoped: true };
	}

	async #cycleAvailableModel(direction: "forward" | "backward"): Promise<ModelCycleResult | undefined> {
		const previousEditMode = this.#resolveActiveEditMode();
		const availableModels = this.#modelRegistry.getAvailable();
		if (availableModels.length <= 1) return undefined;

		const currentModel = this.model;
		let currentIndex = availableModels.findIndex(m => modelsAreEqual(m, currentModel));

		if (currentIndex === -1) currentIndex = 0;
		const len = availableModels.length;
		const nextIndex = direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
		const nextModel = availableModels[nextIndex];

		const apiKey = await this.#modelRegistry.getApiKey(nextModel, this.sessionId);
		if (!apiKey) {
			throw new Error(missingCredentialsMessage(nextModel.provider, nextModel.id, "the next model in the cycle"));
		}

		this.#modelRegistry.clearSuppressedSelector(formatModelStringWithRouting(nextModel));
		this.#clearActiveRetryFallback();
		this.#setModelWithProviderSessionReset(nextModel);
		this.sessionManager.appendModelChange(`${nextModel.provider}/${nextModel.id}`);
		this.settings.getStorage()?.recordModelUsage(`${nextModel.provider}/${nextModel.id}`);

		this.#reapplyThinkingLevel();
		await this.#syncAfterModelChange(previousEditMode);

		return { model: nextModel, thinkingLevel: this.thinkingLevel, isScoped: false };
	}

	getAvailableModels(): Model[] {
		const all = this.#modelRegistry.getAvailable();
		const patterns = this.settings.get("enabledModels");
		if (!patterns || patterns.length === 0) return all;
		return filterAvailableModelsByEnabledPatterns(all, patterns, this.settings);
	}

	#resolvedEffortForModel(
		model: Model | undefined,
		selectorLevel?: ConfiguredThinkingLevel,
	): ConfiguredThinkingLevel | undefined {
		const resolved = resolveEffort({
			sessionOverride: this.#sessionThinkingOverride,
			selectorLevel,
			modelSelector: model ? `${model.provider}/${model.id}` : undefined,
			defaultEffort: withLegacyDefaultEffort(
				this.settings.isConfigured("defaultEffort") ? this.settings.get("defaultEffort") : undefined,
				this.settings.get("defaultThinkingLevel"),
			),
		});
		return resolved.level ?? model?.thinking?.defaultLevel;
	}

	#persistDefaultEffort(level: ConfiguredThinkingLevel): void {
		this.settings.set(
			"defaultEffort",
			withPersistedEffort(
				this.settings.isConfigured("defaultEffort") ? this.settings.get("defaultEffort") : undefined,
				this.settings.get("defaultThinkingLevel"),
				level,
				this.model ? `${this.model.provider}/${this.model.id}` : undefined,
			),
		);
	}

	#applyThinkingLevelToAgent(level: ThinkingLevel | undefined): void {
		this.agent.setThinkingLevel(toReasoningEffort(level));
		this.agent.setDisableReasoning(shouldDisableReasoning(level));
	}

	setThinkingLevel(
		level: ConfiguredThinkingLevel | undefined,
		persist: boolean = false,
		source: "session" | "resolved" = "session",
	): void {
		if (source === "session") {
			this.#sessionThinkingOverride = level;
			if (level === undefined) {
				level = this.#resolvedEffortForModel(this.model, this.#activeSelectorThinkingLevel);
			}
		}
		if (level === AUTO_THINKING) {
			const provisional = resolveProvisionalAutoLevel(this.model);
			const wasAuto = this.#autoThinking;
			this.#autoThinking = true;
			this.#autoResolvedLevel = undefined;
			this.#thinkingLevel = provisional;
			if (!wasAuto) {
				this.#clearInheritedProviderPromptCacheKey("auto-thinking-enter");
			}
			this.#applyThinkingLevelToAgent(provisional);
			if (persist) {
				this.#persistDefaultEffort(AUTO_THINKING);
			}
			if (!wasAuto || this.#thinkingLevel !== provisional) {
				this.#emit({ type: "thinking_level_changed", thinkingLevel: provisional, configured: AUTO_THINKING });
			}
			return;
		}

		const wasAuto = this.#autoThinking;
		this.#autoThinking = false;
		this.#autoResolvedLevel = undefined;
		const effectiveLevel = resolveThinkingLevelForModel(this.model, level);

		if (
			level !== undefined &&
			level !== ThinkingLevel.Inherit &&
			level !== ThinkingLevel.Off &&
			effectiveLevel !== level
		) {
			logger.warn(
				"Requested thinking level is not accepted by the active model; using the nearest supported level",
				{
					model: this.model ? `${this.model.provider}/${this.model.id}` : "none",
					requested: level,
					using: effectiveLevel ?? "provider default",
					accepted: this.model ? getSupportedEfforts(this.model).join(", ") : "",
				},
			);
		}

		const isChanging = wasAuto || effectiveLevel !== this.#thinkingLevel;

		this.#thinkingLevel = effectiveLevel;
		this.#applyThinkingLevelToAgent(effectiveLevel);

		if (persist && effectiveLevel !== undefined && effectiveLevel !== ThinkingLevel.Off) {
			this.#persistDefaultEffort(effectiveLevel);
		}
		if (isChanging) {
			this.#clearInheritedProviderPromptCacheKey("thinking-level-change");
			this.sessionManager.appendThinkingLevelChange(effectiveLevel, effectiveLevel);
			this.#emit({ type: "thinking_level_changed", thinkingLevel: effectiveLevel });
		}
	}

	#reapplyThinkingLevel(selectorLevel?: ConfiguredThinkingLevel): void {
		this.#activeSelectorThinkingLevel = selectorLevel;
		this.setThinkingLevel(this.#resolvedEffortForModel(this.model, selectorLevel), false, "resolved");
	}

	cycleThinkingLevel(): ConfiguredThinkingLevel | undefined {
		const levels = configuredThinkingLevelsForModel(this.model);
		if (levels.length === 0) return undefined;
		const configured = this.configuredThinkingLevel();
		const currentLevel = configured === ThinkingLevel.Inherit ? ThinkingLevel.Off : configured;
		const currentIndex = currentLevel ? levels.indexOf(currentLevel) : -1;
		const nextIndex = (currentIndex + 1) % levels.length;
		const nextLevel = levels[nextIndex];
		if (!nextLevel) return undefined;

		this.setThinkingLevel(nextLevel);
		return nextLevel;
	}

	static readonly #AUTO_THINKING_TIMEOUT_MS = 4000;

	async #applyAutoThinkingLevel(promptText: string, generation: number): Promise<void> {
		const model = this.model;
		if (!model?.reasoning) return;

		if (getSupportedEfforts(model).length === 0) return;

		let resolved: Effort | undefined;
		let classificationError: string | undefined;
		if (this.#magicKeywordEnabled("ultrathink") && containsUltrathink(promptText)) {
			resolved = clampAutoThinkingEffort(model, Effort.Max);
		} else {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), AgentSession.#AUTO_THINKING_TIMEOUT_MS);
			try {
				resolved = await classifyDifficulty(promptText, {
					settings: this.settings,
					registry: this.#modelRegistry,
					model,
					sessionId: this.sessionId,
					signal: controller.signal,
					metadataResolver: provider => this.agent.metadataForProvider(provider),
					obfuscateProviderText: text => this.obfuscateProviderText(text),
					completeImpl: this.#sideCompleteImpl,
				});
			} catch (error) {
				classificationError = errorMessage(error);
			} finally {
				clearTimeout(timer);
			}
		}

		if (this.#promptGeneration !== generation || !this.#autoThinking) return;

		const effort = resolved ?? resolveProvisionalAutoLevel(model);

		if (classificationError !== undefined) {
			logger.warn("auto-thinking: could not classify the prompt, using a fallback level", {
				error: classificationError,
				fallbackLevel: effort ?? "none",
				timeoutMs: AgentSession.#AUTO_THINKING_TIMEOUT_MS,
				fix: "If this repeats, the classifier model may be unreachable; set a fixed thinking level with /effort to stop relying on it.",
			});
		}
		if (effort === undefined) return;
		const shouldPersistResolution = this.#autoResolvedLevel !== effort;
		this.#autoResolvedLevel = effort;
		this.#thinkingLevel = effort;
		this.#applyThinkingLevelToAgent(effort);
		if (shouldPersistResolution) {
			this.sessionManager.appendThinkingLevelChange(effort, AUTO_THINKING);
		}
		this.#emit({
			type: "thinking_level_changed",
			thinkingLevel: effort,
			configured: AUTO_THINKING,
			resolved: effort,
		});
	}

	isFastModeEnabled(): boolean {
		const family = this.model ? serviceTierFamily(this.model) : undefined;
		return family ? this.#serviceTierByFamily[family] === "priority" : false;
	}

	isFastModeActive(): boolean {
		const model = this.model;
		return !!model && realizesPriorityServiceTier(this.#effectiveServiceTier(model), model);
	}

	#effectiveServiceTier(model: Model | undefined = this.model): ServiceTier | undefined {
		if (model?.provider === "fireworks") {
			return this.settings.get("providers.fireworksTier") === "priority" && !isFireworksFastModelId(model.id)
				? "priority"
				: undefined;
		}
		if (!model) return undefined;
		return resolveModelServiceTier(this.#serviceTierByFamily, model);
	}

	#serviceTierEntry(): ServiceTierByFamily | null {
		return Object.keys(this.#serviceTierByFamily).length > 0 ? this.#serviceTierByFamily : null;
	}

	setServiceTierFamily(family: ServiceTierFamily, tier: ServiceTier | undefined): void {
		if (this.#serviceTierByFamily[family] === tier) return;
		const next: ServiceTierByFamily = { ...this.#serviceTierByFamily };
		if (tier) next[family] = tier;
		else delete next[family];
		this.#applyServiceTierByFamily(next);
	}

	#applyServiceTierByFamily(next: ServiceTierByFamily): void {
		if (next.anthropic === "priority" && this.#serviceTierByFamily.anthropic !== "priority") {
			clearAnthropicFastModeFallback(this.#providerSessionState);
		}
		this.#serviceTierByFamily = next;
		this.sessionManager.appendServiceTierChange(this.#serviceTierEntry());
	}

	setFastMode(enabled: boolean): boolean {
		const family = this.model ? serviceTierFamily(this.model) : undefined;
		if (!family) {
			this.emitNotice("info", "The current model has no service-tier control for /fast to toggle.", "priority");
			return false;
		}
		if (!enabled) {
			if (this.#serviceTierByFamily[family] !== "priority") return true;

			const configured = buildServiceTierByFamily(
				this.settings.get("tier.openai"),
				this.settings.get("tier.anthropic"),
				this.settings.get("tier.google"),
			)[family];
			this.setServiceTierFamily(family, configured === "priority" ? undefined : configured);
			return true;
		}
		this.setServiceTierFamily(family, "priority");
		return true;
	}

	toggleFastMode(): boolean {
		if (!this.setFastMode(!this.isFastModeEnabled())) return false;
		return this.isFastModeEnabled();
	}

	getAvailableThinkingLevels(): ReadonlyArray<Effort> {
		if (!this.model) return [];
		return getSupportedEfforts(this.model);
	}

	setInstrumentationLevel(level: InstrumentationLevel): void {
		this.settings.set("session.instrumentation", level);
		this.agent.instrumentation = level;
		this.sessionManager.setInstrumentationLevel(level);
	}

	setSteeringMode(mode: "all" | "one-at-a-time"): void {
		this.agent.setSteeringMode(mode);
		this.settings.set("steeringMode", mode);
	}

	setFollowUpMode(mode: "all" | "one-at-a-time"): void {
		this.agent.setFollowUpMode(mode);
		this.settings.set("followUpMode", mode);
	}

	setInterruptMode(mode: "immediate" | "wait"): void {
		this.agent.setInterruptMode(mode);
		this.settings.set("interruptMode", mode);
	}

	#withPlanProtection<T extends { protectedTools: ProtectedToolMatcher[] }>(config: T): T {
		const planMatcher = createPlanReadMatcher(() => this.#planReferencePath);
		return { ...config, protectedTools: [...config.protectedTools, planMatcher] };
	}

	async #afterHistoryRewrite(): Promise<void> {
		await this.sessionManager.rewriteEntries();
		const sessionContext = this.buildDisplaySessionContext();
		this.agent.replaceMessages(sessionContext.messages);
		this.#resetAllAdvisorRuntimes();
		this.#closeCodexProviderSessionsForHistoryRewrite();
		this.#historyRewriteAnchorBoundaryEntryId = this.sessionManager.getBranch().at(-1)?.id;
		this.#rebasePendingContextSnapshotAfterHistoryRewrite();
	}

	async #pruneToolOutputs(): Promise<{ prunedCount: number; tokensSaved: number } | undefined> {
		const branchEntries = this.sessionManager.getBranch();
		const keepBoundaryId = getLatestCompactionEntry(branchEntries)?.firstKeptEntryId;
		const result = pruneToolOutputs(
			branchEntries,
			this.#withPlanProtection({
				...DEFAULT_PRUNE_CONFIG,
				pruneUseless: this.settings.getGroup("compaction").dropUseless,

				keepBoundaryId,
				cacheWarmSuffixTokens: PRUNE_CACHE_WARM_SUFFIX_TOKENS,
			}),
		);
		if (result.prunedCount === 0) {
			return undefined;
		}

		await this.#afterHistoryRewrite();
		this.#syncTodoPhasesFromBranch();
		return result;
	}

	async #pruneStaleToolResults(): Promise<{ prunedCount: number; tokensSaved: number } | undefined> {
		const { supersedeReads, dropUseless } = this.settings.getGroup("compaction");
		if (!supersedeReads && !dropUseless) return undefined;
		const branchEntries = this.sessionManager.getBranch();
		const keepBoundaryId = getLatestCompactionEntry(branchEntries)?.firstKeptEntryId;
		const result = pruneSupersededToolResults(
			branchEntries,
			this.#withPlanProtection({
				supersedeKey: supersedeReads ? readToolSupersedeKey : undefined,
				pruneUseless: dropUseless,
				protectedTools: [...DEFAULT_PRUNE_CONFIG.protectedTools],

				keepBoundaryId,
				idleFlushMs: PRUNE_IDLE_FLUSH_MS,
			}),
		);
		if (result.prunedCount === 0) {
			return undefined;
		}

		await this.#afterHistoryRewrite();
		this.#syncTodoPhasesFromBranch();
		return result;
	}

	async dropImages(): Promise<{ removed: number }> {
		const branchEntries = this.sessionManager.getBranch();
		let removed = 0;
		for (const entry of branchEntries) {
			if (entry.type === "message") {
				removed += stripImagesFromMessage(entry.message);
				continue;
			}
			if (entry.type === "custom_message" && typeof entry.content !== "string") {
				const kept: typeof entry.content = [];
				let dropped = 0;
				for (const part of entry.content) {
					if (part.type === "image") {
						dropped++;
					} else {
						kept.push(part);
					}
				}
				if (dropped > 0) {
					if (kept.length === 0) {
						kept.push({ type: "text", text: "[image removed]" });
					}
					entry.content = kept;
					removed += dropped;
				}
			}
		}
		if (removed === 0) {
			return { removed: 0 };
		}
		await this.#afterHistoryRewrite();
		return { removed };
	}

	async shake(mode: ShakeMode, opts: { config?: ShakeConfig; signal?: AbortSignal } = {}): Promise<ShakeResult> {
		if (mode === "images") {
			const { removed } = await this.dropImages();
			return { mode, toolResultsDropped: 0, blocksDropped: 0, imagesDropped: removed, tokensFreed: 0 };
		}

		const branchEntries = this.sessionManager.getBranch();
		const config = this.#withPlanProtection({
			...(opts.config ?? AGGRESSIVE_SHAKE_CONFIG),

			keepBoundaryId: getLatestCompactionEntry(branchEntries)?.firstKeptEntryId,
		});

		const heavyRegions = collectShakeRegions(branchEntries, config);
		const redundantRegions = collectRedundantToolResultRegions(branchEntries, config);
		const heavyToolResultEntries = new Set<ShakeRegion["entry"]>(
			heavyRegions.filter(region => region.kind === "toolResult").map(region => region.entry),
		);
		const regions = [
			...heavyRegions,
			...redundantRegions.filter(region => !heavyToolResultEntries.has(region.entry)),
		];
		if (regions.length === 0) {
			return { mode, toolResultsDropped: 0, blocksDropped: 0, tokensFreed: 0 };
		}

		const applied = await this.#offloadAndApplyShakeRegions(regions);

		return {
			mode,
			toolResultsDropped: applied.toolResultsDropped,
			blocksDropped: applied.blocksDropped,
			tokensFreed: applied.tokensFreed,
			artifactId: applied.artifactId,
		};
	}

	async #offloadAndApplyShakeRegions(regions: ShakeRegion[]): Promise<{
		toolResultsDropped: number;
		blocksDropped: number;
		tokensFreed: number;
		artifactId: string | undefined;
	}> {
		const artifactId = await this.#saveShakeArtifact(regions);
		const replacements = regions.map((region, index) => this.#shakeElidePlaceholder(region, index, artifactId));

		let toolResultsDropped = 0;
		let blocksDropped = 0;
		let originalTokens = 0;
		let replacementTokens = 0;
		const items = regions.map((region, index) => {
			if (region.kind === "toolResult") toolResultsDropped++;
			else blocksDropped++;
			originalTokens += region.tokens;
			const replacement = replacements[index];
			if (replacement.length > 0) replacementTokens += countTokens(replacement);
			return { region, replacement };
		});

		applyShakeRegions(items);

		await this.#afterHistoryRewrite();

		return {
			toolResultsDropped,
			blocksDropped,
			tokensFreed: Math.max(0, originalTokens - replacementTokens),
			artifactId,
		};
	}

	async dedupeRedundantToolResults(): Promise<{
		toolResultsDropped: number;
		tokensFreed: number;
		artifactId?: string;
	}> {
		const branchEntries = this.sessionManager.getBranch();
		const config = this.#withPlanProtection({
			...AGGRESSIVE_SHAKE_CONFIG,
			keepBoundaryId: getLatestCompactionEntry(branchEntries)?.firstKeptEntryId,
		});
		const regions = collectRedundantToolResultRegions(branchEntries, config);
		if (regions.length === 0) return { toolResultsDropped: 0, tokensFreed: 0 };

		const applied = await this.#offloadAndApplyShakeRegions(regions);
		return {
			toolResultsDropped: applied.toolResultsDropped,
			tokensFreed: applied.tokensFreed,
			artifactId: applied.artifactId,
		};
	}

	#shakeElidePlaceholder(region: ShakeRegion, index: number, artifactId: string | undefined): string {
		if (artifactId) {
			return `[shaken ~${region.tokens} tokens; recover: artifact://${artifactId} (region ${index + 1})]`;
		}
		return `[shaken ~${region.tokens} tokens]`;
	}

	async #saveShakeArtifact(regions: ShakeRegion[]): Promise<string | undefined> {
		const parts: string[] = [];
		for (let i = 0; i < regions.length; i++) {
			const region = regions[i];
			parts.push(`### region ${i + 1} (${region.label}, ~${region.tokens} tok)`, "", region.originalText, "");
		}
		try {
			return await this.sessionManager.saveArtifact(parts.join("\n"), "shake");
		} catch {
			return undefined;
		}
	}

	async compact(customInstructions?: string, options?: CompactOptions): Promise<CompactionResult> {
		if (this.#compactionAbortController) {
			throw new Error("Compaction already in progress");
		}

		const compactMode = options?.mode ? findCompactMode(options.mode) : undefined;
		const compactionAbortController = new AbortController();
		this.#compactionAbortController = compactionAbortController;

		let preparation: CompactionPreparation | undefined;

		try {
			this.#disconnectFromAgent();
			await this.abort({ goalReason: "internal", preserveCompaction: true });
			if (!this.model) {
				throw new Error(
					"No model selected, so compaction has nothing to summarize with. Fix: in an interactive veyyon session run /model to choose one; from a terminal pass `--model <provider>/<id>`, or set `compaction.model` so compaction uses its own model regardless of the session's.",
				);
			}

			const compactionSettings = this.settings.getGroup("compaction");

			const effectiveSettings = compactMode
				? { ...compactionSettings, ...compactMode.overrides }
				: compactionSettings;
			const availableModels = this.#modelRegistry.getAvailable();
			const compactionCandidates = this.#getCompactionModelCandidates(availableModels);
			const pathEntries = this.sessionManager.getBranch();
			preparation = prepareCompaction(pathEntries, toAgentCompactionSettings(effectiveSettings), {
				nonMessageTokens: computeNonMessageTokens(this),
				contextWindow: declaredContextWindow(this.model),
			});
			if (!preparation) {
				const lastEntry = pathEntries[pathEntries.length - 1];
				if (lastEntry?.type === "compaction") {
					throw new Error("Already compacted");
				}

				throw new Error("Nothing to compact (session too small)");
			}

			let hookCompaction: CompactionResult | undefined;
			let fromExtension = false;
			let preserveData: Record<string, unknown> | undefined;

			if (this.#extensionRunner?.hasHandlers("session_before_compact")) {
				const result = (await this.#extensionRunner.emit({
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

			let summary: string;
			let shortSummary: string | undefined;
			let firstKeptEntryId: string;
			let tokensBefore: number;
			let details: unknown;
			let codexCompaction: CodexCompactionContext | undefined;

			if (compactionPrep.kind === "fromHook") {
				summary = compactionPrep.summary;
				shortSummary = compactionPrep.shortSummary;
				firstKeptEntryId = compactionPrep.firstKeptEntryId;
				tokensBefore = compactionPrep.tokensBefore;
				details = compactionPrep.details;
				preserveData = compactionPrep.preserveData;
			} else {
				codexCompaction = createCodexCompactionContext({
					trigger: "manual",
					reason: "user_requested",
					phase: "standalone_turn",
				});

				try {
					const remoteResult = await this.#tryServerSideCompaction(
						preparation,
						options?.internalGuidance ?? customInstructions,
						compactionAbortController.signal,
						{
							promptOverride: this.#obfuscateTextForProvider(compactionPrep.hookPrompt),
							extraContext: compactionPrep.hookContext,
							remoteInstructions: this.#baseSystemPrompt.join("\n\n"),
							codexCompaction,
						},
					);
					const result =
						remoteResult ??
						(await this.#compactWithFallbackModel(
							preparation,
							options?.internalGuidance ?? customInstructions,
							compactionAbortController.signal,
							{
								promptOverride: this.#obfuscateTextForProvider(compactionPrep.hookPrompt),
								extraContext: compactionPrep.hookContext,
								remoteInstructions: this.#baseSystemPrompt.join("\n\n"),
								convertToLlm: messages => this.#convertToLlmForSideRequest(messages),
								obfuscateProviderText: text => this.obfuscateProviderText(text),
								codexCompaction,
							},
							compactionCandidates,
						));
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
					if (compactionAbortController.signal.aborted && isAbortError(err)) {
						throw new CompactionCancelledError();
					}
					throw err;
				}
			}

			if (compactionAbortController.signal.aborted) {
				throw new CompactionCancelledError();
			}

			assertValidCompactionResult(preparation, {
				summary,
				shortSummary,
				firstKeptEntryId,
				tokensBefore,
				details,
				preserveData,
			});
			this.sessionManager.appendCompaction(
				summary,
				shortSummary,
				firstKeptEntryId,
				tokensBefore,
				details,
				fromExtension,
				preserveData,
			);
			await this.#persistCompactionTailElisions(preparation);
			const newEntries = this.sessionManager.getEntries();
			const sessionContext = this.buildDisplaySessionContext();
			this.agent.replaceMessages(sessionContext.messages);
			this.#rebasePendingContextSnapshotAfterHistoryRewrite();

			this.#planReferenceSent = false;
			this.#resetAllAdvisorRuntimes();
			this.#syncTodoPhasesFromBranch();
			if (codexCompaction) {
				this.#resetCodexProviderAfterCompaction(codexCompaction);
			} else {
				this.#closeCodexProviderSessionsForHistoryRewrite();
			}

			const savedCompactionEntry = newEntries.find(e => e.type === "compaction" && e.summary === summary) as
				| CompactionEntry
				| undefined;

			if (this.#extensionRunner && savedCompactionEntry) {
				await this.#extensionRunner.emit({
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
			this.#rollbackCompactionTailElisions(preparation);
			const err = error instanceof Error ? error : new Error(errorMessage(error));
			options?.onError?.(err);
			throw error;
		} finally {
			if (this.#compactionAbortController === compactionAbortController) {
				this.#compactionAbortController = undefined;
			}
			this.#reconnectToAgent();
		}
	}

	async #collectMemoryBackendContext(preparation: {
		messagesToSummarize: AgentMessage[];
		turnPrefixMessages: AgentMessage[];
	}): Promise<string | undefined> {
		const backend = await resolveMemoryBackend(this.settings);
		if (!backend.preCompactionContext) return undefined;
		const messages = preparation.messagesToSummarize.concat(preparation.turnPrefixMessages);
		try {
			return await backend.preCompactionContext(messages, this.settings, this);
		} catch (err) {
			logger.debug("Memory backend preCompactionContext failed", {
				backend: backend.id,
				error: errorMessage(err),
			});
			return undefined;
		}
	}

	abortCompaction(): void {
		this.#compactionAbortController?.abort();
		this.#autoCompactionAbortController?.abort();
		this.#handoffAbortController?.abort();
	}

	async runIdleCompaction(): Promise<void> {
		if (this.isStreaming || this.isCompacting) return;
		await this.#runAutoCompaction("idle", false);
	}

	abortBranchSummary(): void {
		this.#branchSummaryAbortController?.abort();
	}

	abortHandoff(): void {
		this.#handoffAbortController?.abort();
	}

	get isGeneratingHandoff(): boolean {
		return this.#handoffAbortController !== undefined;
	}

	async handoff(customInstructions?: string, options?: SessionHandoffOptions): Promise<HandoffResult | undefined> {
		const entries = this.sessionManager.getBranch();
		const messageCount = entries.filter(e => e.type === "message").length;

		if (messageCount < 2) {
			throw new Error("Nothing to hand off (no messages yet)");
		}

		this.#skipPostTurnMaintenanceAssistantTimestamp = undefined;

		this.#handoffAbortController = new AbortController();
		const handoffAbortController = this.#handoffAbortController;
		const handoffSignal = handoffAbortController.signal;
		const sourceSignal = options?.signal;
		const onSourceAbort = () => {
			if (!handoffSignal.aborted) {
				handoffAbortController.abort();
			}
		};
		if (sourceSignal) {
			sourceSignal.addEventListener("abort", onSourceAbort, { once: true });
			if (sourceSignal.aborted) {
				onSourceAbort();
			}
		}

		try {
			if (handoffSignal.aborted) {
				throw new Error("Handoff cancelled");
			}

			const model = this.model;
			if (!model) {
				throw new Error(
					"No model selected, so the handoff summary cannot be written. Fix: in an interactive veyyon session run /model to choose one; from a terminal pass `--model <provider>/<id>`. `veyyon models` lists what this profile can reach.",
				);
			}
			const apiKey = await this.#modelRegistry.getApiKey(model, this.sessionId);
			if (!apiKey) {
				throw new Error(missingCredentialsMessage(model.provider, model.id, "the handoff summary model"));
			}

			const cacheSessionId = this.sessionId;

			const handoffPromptCacheKey = this.agent.promptCacheKey ?? this.agent.sessionId;
			const handoffPromptText = renderHandoffPrompt(this.#obfuscateTextForProvider(customInstructions));
			const handoffSnapshot: AgentMessage[] = [
				...this.agent.state.messages,
				{
					role: "user",
					content: [{ type: "text", text: handoffPromptText }],
					attribution: "agent",
					timestamp: Date.now(),
				},
			];
			const handoffLlmMessages = await this.convertMessagesToLlm(handoffSnapshot, handoffSignal);

			const handoffContext = await this.agent.buildSideRequestContext(handoffLlmMessages, this.#baseSystemPrompt);
			const handoffStreamOptions = await this.prepareSimpleStreamOptions(
				{
					apiKey: this.#modelRegistry.resolver(model, cacheSessionId),
					sessionId: `${cacheSessionId}:side:${Snowflake.next()}`,
					promptCacheKey: handoffPromptCacheKey,
					preferWebsockets: false,
					serviceTier: this.#effectiveServiceTier(model),
					hideThinkingSummary: this.agent.hideThinkingSummary,
					initiatorOverride: "agent",
					signal: handoffSignal,
				},
				model.provider,
			);
			const rawHandoffText = await generateHandoffFromContext(
				this.#obfuscateContextForProvider(handoffContext),
				model,
				{
					streamOptions: handoffStreamOptions,
					completeImpl: this.#sideCompleteImpl,
					telemetry: resolveTelemetry(this.agent.telemetry, this.sessionId),

					thinkingLevel: this.thinkingLevel,
				},
			);

			const handoffFileOps = createFileOps();
			extractFileOpsFromMessages(this.agent.state.messages, handoffFileOps);
			const handoffFileLists = computeFileLists(handoffFileOps);
			const handoffText = upsertFileOperations(
				this.#deobfuscateFromProvider(rawHandoffText),
				handoffFileLists.readFiles,
				handoffFileLists.modifiedFiles,
				handoffFileOps.read,
			);
			const carriedTodoPhases = this.#cloneTodoPhases(this.#todoPhases);

			if (handoffSignal.aborted) {
				throw new Error("Handoff cancelled");
			}
			if (!handoffText) {
				return undefined;
			}

			const previousSessionFile = this.sessionFile;
			if (this.#extensionRunner?.hasHandlers("session_before_switch")) {
				const result = (await this.#extensionRunner.emit({
					type: "session_before_switch",
					reason: "handoff",
				})) as SessionBeforeSwitchResult | undefined;

				if (result?.cancel) {
					options?.onSwitchCancelled?.();
					return undefined;
				}
			}
			await this.sessionManager.flush();
			this.#cancelOwnAsyncJobs();
			await this.sessionManager.newSession(previousSessionFile ? { parentSession: previousSessionFile } : undefined);

			await this.#rescopeAgentRegistry();

			this.#clearCheckpointRuntimeState();

			const preservedSteering = this.agent.peekSteeringQueue().slice();
			const preservedFollowUp = this.agent.peekFollowUpQueue().slice();
			this.agent.reset();
			this.agent.replaceQueues(preservedSteering, preservedFollowUp);
			this.#freshProviderSessionId = undefined;
			this.#syncAgentSessionId();
			this.#rekeyHindsightMemoryForCurrentSessionId();
			this.#rekeyMnemopiMemoryForCurrentSessionId();
			this.#resetMemoryContextForNewTranscript();
			this.#pendingNextTurnMessages = [];
			this.#scheduledHiddenNextTurnGeneration = undefined;
			this.#resetTodoReminderStateForNewContext();

			const handoffContent = createHandoffContext(handoffText);
			this.sessionManager.appendCustomMessageEntry("handoff", handoffContent, true, undefined, "agent");
			if (carriedTodoPhases.length > 0) {
				this.sessionManager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases: carriedTodoPhases });
			}
			await this.sessionManager.ensureOnDisk();
			let savedPath: string | undefined;
			if (options?.autoTriggered && this.settings.get("compaction.handoffSaveToDisk")) {
				const artifactsDir = this.sessionManager.getArtifactsDir();
				if (artifactsDir) {
					const handoffFilePath = path.join(artifactsDir, createHandoffFileName());
					try {
						await Bun.write(handoffFilePath, `${handoffText}\n`);
						savedPath = handoffFilePath;
					} catch (error) {
						logger.warn("Failed to save handoff document to disk", {
							path: handoffFilePath,
							error: errorMessage(error),
						});
					}
				} else {
					logger.debug("Skipping handoff document save because session is not persisted");
				}
			}

			const sessionContext = this.buildDisplaySessionContext();
			this.agent.replaceMessages(sessionContext.messages);
			this.#resetAllAdvisorRuntimes();
			this.#syncTodoPhasesFromBranch();
			if (this.#extensionRunner) {
				await this.#extensionRunner.emit({
					type: "session_switch",
					reason: "handoff",
					previousSessionFile,
				});
			}

			return { document: handoffText, savedPath };
		} catch (error) {
			if (handoffSignal.aborted || isAbortError(error)) {
				throw new Error("Handoff cancelled");
			}
			throw error;
		} finally {
			sourceSignal?.removeEventListener("abort", onSourceAbort);
			this.#handoffAbortController = undefined;
		}
	}

	#estimateStoredContextTokens(pendingMessages: AgentMessage[] = []): number {
		const opts = { excludeEncryptedReasoning: true } as const;
		return (
			computeNonMessageTokens(this) +
			computeStoredMessagesTokens(this, opts) +
			pendingMessages.reduce((sum, msg) => sum + estimateTokens(msg, opts), 0)
		);
	}

	#estimatePrePromptContextTokens(messages: AgentMessage[], contextWindow: number): number {
		return this.getContextBreakdown({ contextWindow, pendingMessages: messages })?.usedTokens ?? 0;
	}

	async #runPrePromptCompactionIfNeeded(messages: AgentMessage[]): Promise<void> {
		const model = this.model;
		if (!model) return;
		const contextWindow = model.contextWindow ?? 0;
		if (contextWindow <= 0) return;
		const compactionSettings = this.settings.getGroup("compaction");
		const contextTokens = this.#estimatePrePromptContextTokens(messages, contextWindow);
		if (!shouldCompact(contextTokens, contextWindow, compactionSettings)) return;

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
		await this.#runAutoCompaction("threshold", false, {
			autoContinue: false,
			triggerContextTokens: contextTokens,
			phase: "pre_turn",
		});
	}

	async #maintainContextMidRun(
		activeMessages: AgentMessage[],
		signal: AbortSignal | undefined,
		context: AgentTurnEndContext | undefined,
	): Promise<void> {
		if (
			signal?.aborted ||
			this.#isDisposed ||
			this.isCompacting ||
			this.isGeneratingHandoff ||
			!context?.willContinue
		)
			return;

		const model = this.model;
		const contextWindow = model?.contextWindow ?? 0;
		if (contextWindow <= 0) return;

		const compactionSettings = this.settings.getGroup("compaction");
		if (
			!compactionSettings.enabled ||
			isCompactionStrategyOff(compactionSettings.strategy as string) ||
			compactionSettings.midTurnEnabled === false
		) {
			return;
		}

		let lastAssistant: AssistantMessage | undefined;
		for (let i = activeMessages.length - 1; i >= 0; i--) {
			const message = activeMessages[i]!;
			if (message.role === "assistant") {
				lastAssistant = message;
				break;
			}
		}
		if (!lastAssistant || lastAssistant.stopReason === "aborted" || lastAssistant.stopReason === "error") return;

		if (!(await this.#persistTurnMessagesForMidRunCompaction(context))) return;

		const billedContextTokens = calculateContextTokens(lastAssistant.usage);
		const storedContextTokens = this.#estimateStoredContextTokens();
		const contextTokens = compactionContextTokens(billedContextTokens, storedContextTokens);
		if (!shouldCompact(contextTokens, contextWindow, compactionSettings)) return;

		if (await this.#promoteContextModel()) {
			logger.debug("Mid-run context promotion avoided compaction", {
				contextTokens,
				contextWindow,
				from: `${model?.provider}/${model?.id}`,
			});
			return;
		}

		const messagesBefore = activeMessages.length;
		await this.#runAutoCompaction("threshold", false, {
			autoContinue: false,
			suppressContinuation: true,
			triggerContextTokens: contextTokens,
			phase: "mid_turn",
		});

		if (signal?.aborted) return;
		const compactedMessages = this.agent.state.messages;
		if (compactedMessages !== activeMessages) {
			activeMessages.splice(0, activeMessages.length, ...compactedMessages);
		}
		logger.debug("Mid-run compaction ran between provider calls", {
			contextTokens,
			contextWindow,
			strategy: compactionSettings.strategy,
			goalActive: this.#goalModeState?.enabled === true && this.#goalModeState.goal.status === "active",
			messagesBefore,
			messagesAfter: activeMessages.length,
		});
	}

	async #checkCompaction(
		assistantMessage: AssistantMessage,
		skipAbortedCheck = true,
		autoContinue = true,
	): Promise<CompactionCheckResult> {
		if (skipAbortedCheck && assistantMessage.stopReason === "aborted") return COMPACTION_CHECK_NONE;
		const contextWindow = this.model?.contextWindow ?? 0;
		const generation = this.#promptGeneration;

		const sameModel =
			this.model && assistantMessage.provider === this.model.provider && assistantMessage.model === this.model.id;

		const compactionEntry = getLatestCompactionEntry(this.sessionManager.getBranch());
		const errorIsFromBeforeCompaction =
			compactionEntry !== null && assistantMessage.timestamp < new Date(compactionEntry.timestamp).getTime();
		if (sameModel && !errorIsFromBeforeCompaction && AIError.isContextOverflow(assistantMessage, contextWindow)) {
			this.#removeAssistantMessageFromActiveContext(assistantMessage);

			const promoted = await this.#tryContextPromotion(assistantMessage);
			if (promoted) {
				await this.#dropPersistedAssistantTurn(assistantMessage);

				this.#scheduleAgentContinue({ delayMs: 100, generation });
				return COMPACTION_CHECK_CONTINUATION;
			}

			const compactionSettings = this.settings.getGroup("compaction");
			if (!isThresholdCompactionDisabled(compactionSettings.enabled, compactionSettings.strategy as string)) {
				return await this.#runRecoveryCompactionWithRollback("overflow", assistantMessage, {
					autoContinue,
				});
			}

			this.#restoreFailedAssistantTurnToActiveContext(assistantMessage);
			return COMPACTION_CHECK_NONE;
		}

		if (
			!sameModel &&
			autoContinue &&
			!errorIsFromBeforeCompaction &&
			assistantMessage.stopReason === "error" &&
			this.model &&
			contextWindow > 0 &&
			this.settings.getGroup("contextPromotion").enabled
		) {
			const failedModel = this.#modelRegistry.find(assistantMessage.provider, assistantMessage.model);
			const failedWindow = failedModel?.contextWindow ?? 0;
			const promotionTarget = failedModel
				? this.#resolveContextPromotionConfiguredTarget(failedModel, this.#modelRegistry.getAvailable())
				: undefined;
			if (
				failedModel &&
				failedWindow > 0 &&
				contextWindow > failedWindow &&
				promotionTarget &&
				modelsAreEqual(promotionTarget, this.model) &&
				AIError.isContextOverflow(assistantMessage, failedWindow)
			) {
				this.#removeAssistantMessageFromActiveContext(assistantMessage);
				await this.#dropPersistedAssistantTurn(assistantMessage);
				logger.debug("Overflow on pre-promotion model; retrying on promoted model", {
					failed: `${assistantMessage.provider}/${assistantMessage.model}`,
					current: `${this.model.provider}/${this.model.id}`,
				});
				this.#scheduleAgentContinue({ delayMs: 100, generation });
				return COMPACTION_CHECK_CONTINUATION;
			}
		}

		if (sameModel && !errorIsFromBeforeCompaction && assistantMessage.stopReason === "length") {
			this.#removeAssistantMessageFromActiveContext(assistantMessage);

			const promoted = await this.#tryContextPromotion(assistantMessage);
			if (promoted) {
				await this.#dropPersistedAssistantTurn(assistantMessage);
				logger.debug("Context promotion triggered by response.incomplete (length stop)", {
					from: `${assistantMessage.provider}/${assistantMessage.model}`,
				});
				this.#scheduleAgentContinue({ delayMs: 100, generation });
				return COMPACTION_CHECK_CONTINUATION;
			}

			const incompleteCompactionSettings = this.settings.getGroup("compaction");
			if (
				incompleteCompactionSettings.enabled &&
				!isCompactionStrategyOff(incompleteCompactionSettings.strategy as string)
			) {
				logger.debug("Compaction triggered by response.incomplete (length stop, no promotion target)", {
					model: `${assistantMessage.provider}/${assistantMessage.model}`,
					strategy: incompleteCompactionSettings.strategy,
				});
				return await this.#runRecoveryCompactionWithRollback("incomplete", assistantMessage, {
					autoContinue,
					triggerContextTokens: calculateContextTokens(assistantMessage.usage),
				});
			}

			this.#restoreFailedAssistantTurnToActiveContext(assistantMessage);
			logger.warn("response.incomplete with no recovery path (promotion + compaction both unavailable)", {
				model: `${assistantMessage.provider}/${assistantMessage.model}`,
			});
			return COMPACTION_CHECK_NONE;
		}

		const supersedeResult = await this.#pruneStaleToolResults();

		const compactionSettings = this.settings.getGroup("compaction");
		if (isThresholdCompactionDisabled(compactionSettings.enabled, compactionSettings.strategy as string))
			return COMPACTION_CHECK_NONE;

		if (assistantMessage.stopReason === "error") return COMPACTION_CHECK_NONE;
		const pruneResult = await this.#pruneToolOutputs();
		const maintenanceTokensFreed = (supersedeResult?.tokensSaved ?? 0) + (pruneResult?.tokensSaved ?? 0);

		const assistantPredatesCompaction = errorIsFromBeforeCompaction;

		const assistantUsageContextTokens = assistantPredatesCompaction
			? 0
			: calculateContextTokens(assistantMessage.usage);
		const storedContextTokens = this.#estimateStoredContextTokens();

		const contextTokens = compactionContextTokens(assistantUsageContextTokens, storedContextTokens);
		const postMaintenanceContextTokens = compactionContextTokens(
			Math.max(0, assistantUsageContextTokens - maintenanceTokensFreed),
			storedContextTokens,
		);
		const thresholdTokens = resolveThresholdTokens(contextWindow, compactionSettings);
		this.#noticeCompactionThresholdClamp(contextWindow, compactionSettings);
		const shouldThresholdCompact = shouldCompact(contextTokens, contextWindow, compactionSettings);
		logger.debug("Auto-compaction threshold decision", {
			phase: "post-agent-end",
			goalModeEnabled: this.#goalModeState?.enabled === true,
			goalStatus: this.#goalModeState?.goal.status,
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
			contextPromotionEnabled: this.settings.get("contextPromotion.enabled") === true,
		});
		if (shouldThresholdCompact) {
			const promoted = await this.#tryContextPromotion(assistantMessage);
			if (!promoted) {
				return await this.#runAutoCompaction("threshold", false, {
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
	#isTerminalYieldToolResult(event: { toolName: string; isError?: boolean; result?: { details?: unknown } }): boolean {
		if (event.toolName !== TOOL.yield || event.isError) return false;
		const details = event.result?.details;
		if (!details || typeof details !== "object") return true;
		const record = details as Record<string, unknown>;
		return !(
			record.status === "success" &&
			Array.isArray(record.type) &&
			record.type.length > 0 &&
			record.type.every(item => typeof item === "string")
		);
	}

	#noticeCompactionThresholdClamp(contextWindow: number, compactionSettings: CompactionSettings): void {
		const resolved = resolveThresholdWithOrigin(contextWindow, compactionSettings);
		const surprising = resolved.clamped || resolved.legacyKey !== undefined || resolved.invalidRaw !== undefined;
		if (!surprising) return;
		if (this.#compactionClampNoticeWindow === contextWindow) return;
		this.#compactionClampNoticeWindow = contextWindow;

		if (resolved.invalidRaw !== undefined) {
			this.emitNotice(
				"warning",
				`compaction.threshold is set to "${resolved.invalidRaw}", which is not auto, a percent (85%), or a token amount (170000); compacting at ${formatCompactionThreshold(resolved, contextWindow)} instead. Set a valid value in /settings -> Model -> Auto-Compaction Threshold.`,
				"compaction",
			);
			return;
		}

		if (resolved.origin === "tokens" && resolved.clamped) {
			this.emitNotice(
				"info",
				`The compaction threshold (${resolved.configured} tokens) is more than a ${contextWindow}-token model can reach, so this session compacts at ${formatCompactionThreshold(resolved, contextWindow)}. A model with a larger window uses the full amount.`,
				"compaction",
			);
			return;
		}

		if (resolved.legacyKey !== undefined) {
			this.emitNotice(
				"info",
				`Compaction is triggering at ${formatCompactionThreshold(resolved, contextWindow)}, taken from the retired compaction.${resolved.legacyKey} setting. Re-pick it in /settings -> Model -> Auto-Compaction Threshold to move it to compaction.threshold.`,
				"compaction",
			);
		}
	}

	#markTerminalYieldToolCall(toolCallId: string): void {
		this.#lastSuccessfulYieldToolCallId = toolCallId;
		this.#yieldTerminationPending = true;
	}

	#assistantMessageHasSuccessfulYieldToolCall(assistantMessage: AssistantMessage, toolCallId: string): boolean {
		const content = assistantMessage.content;
		for (let i = content.length - 1; i >= 0; i--) {
			const block = content[i]!;
			if (block.type === "toolCall") {
				return block.name === TOOL.yield && block.id === toolCallId;
			}
		}
		return false;
	}

	#assistantEndedWithSuccessfulYield(assistantMessage: AssistantMessage): boolean {
		const toolCallId = this.#lastSuccessfulYieldToolCallId;
		return toolCallId ? this.#assistantMessageHasSuccessfulYieldToolCall(assistantMessage, toolCallId) : false;
	}

	#findSuccessfulYieldAssistantMessage(messages: readonly AgentMessage[]): AssistantMessage | undefined {
		const toolCallId = this.#lastSuccessfulYieldToolCallId;
		if (!toolCallId) return undefined;
		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i];
			if (message.role !== "assistant") continue;
			if (this.#assistantMessageHasSuccessfulYieldToolCall(message, toolCallId)) return message;
		}
		return undefined;
	}

	#clearPendingRecoveredRetryErrors(): void {
		this.#pendingRecoveredRetryErrors = [];
	}

	async #persistRetryLifecycleErrorMessage(message: AssistantMessage): Promise<void> {
		await this.#waitForSessionMessagePersistence(message);
		if (!isEmptyErrorTurn(message)) return;
		if (this.#sessionMessageAlreadyPersisted(message)) return;
		this.#appendSessionMessage(message);
	}

	#retryRecoveryKind(
		id: number,
		switchedCredential: boolean,
		switchedModel: boolean,
		delayMs: number,
	): AssistantRetryRecoveryKind {
		if (switchedCredential) return "credential";
		if (switchedModel) return "model";
		if (AIError.is(id, AIError.Flag.UsageLimit) && delayMs > 0) return "wait";
		return "plain";
	}

	#retryRecoveryNote(recovery: AssistantRetryRecoveryKind, rateLimited: boolean): string {
		const parts: string[] = [];
		if (rateLimited) {
			parts.push("rate-limited");
		} else if (recovery === "plain") {
			parts.push("error");
		}
		if (recovery === "credential") {
			parts.push("switched account");
		} else if (recovery === "model") {
			parts.push("switched model");
		} else if (recovery === "wait") {
			parts.push("waited");
		}
		parts.push("retried");
		return parts.join("; ");
	}

	async #recordPendingRecoveredRetryError(
		message: AssistantMessage,
		id: number,
		options: { switchedCredential: boolean; switchedModel: boolean; delayMs: number },
	): Promise<void> {
		await this.#persistRetryLifecycleErrorMessage(message);
		const persistenceKey = sessionMessagePersistenceKey(message);
		if (!persistenceKey) return;
		let branchEntry: SessionEntry | undefined;
		const branch = this.sessionManager.getBranch();
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i]!;
			if (entry.type !== "message" || entry.message.role !== "assistant") continue;
			if (sessionMessagePersistenceKey(entry.message) !== persistenceKey) continue;
			if (!sameMessageContent(entry.message, message) && !this.#isSameAssistantMessage(entry.message, message)) {
				continue;
			}
			branchEntry = entry;
			break;
		}
		if (!branchEntry) return;
		if (this.#pendingRecoveredRetryErrors.some(error => error.entryId === branchEntry.id)) return;
		const rateLimited = AIError.is(id, AIError.Flag.UsageLimit);
		const recovery = this.#retryRecoveryKind(id, options.switchedCredential, options.switchedModel, options.delayMs);
		const note = this.#retryRecoveryNote(recovery, rateLimited);
		this.#pendingRecoveredRetryErrors.push({
			entryId: branchEntry.id,
			persistenceKey,
			recovery,
			attempt: this.#retryAttempt,
			note,
		});
	}

	async #markPendingRecoveredRetryErrors(supersedingMessage: AssistantMessage): Promise<RecoveredRetryError[]> {
		if (this.#pendingRecoveredRetryErrors.length === 0) return [];
		const branch = this.sessionManager.getBranch();
		const branchById = new Map<string, SessionEntry>();
		for (const entry of branch) {
			branchById.set(entry.id, entry);
		}
		const recoveredAt = new Date().toISOString();
		const supersededBy: AssistantRetryRecovery["supersededBy"] = {
			timestamp: supersedingMessage.timestamp,
			provider: supersedingMessage.provider,
			model: supersedingMessage.model,
		};
		if (supersedingMessage.responseId) {
			supersededBy.responseId = supersedingMessage.responseId;
		}
		const recoveredErrors: RecoveredRetryError[] = [];
		for (const pending of this.#pendingRecoveredRetryErrors) {
			let entry = branchById.get(pending.entryId);
			if (entry?.type !== "message" || entry.message.role !== "assistant") {
				for (let i = branch.length - 1; i >= 0; i--) {
					const candidate = branch[i]!;
					if (
						candidate.type === "message" &&
						candidate.message.role === "assistant" &&
						sessionMessagePersistenceKey(candidate.message) === pending.persistenceKey
					) {
						entry = candidate;
						break;
					}
				}
			}
			if (entry?.type !== "message" || entry.message.role !== "assistant") continue;
			const retryRecovery: AssistantRetryRecovery = {
				kind: "auto-retry",
				status: "recovered",
				attempt: pending.attempt,
				recoveredAt,
				recovery: pending.recovery,
				note: pending.note,
				supersededBy,
			};
			entry.message.retryRecovery = retryRecovery;
			recoveredErrors.push({
				entryId: entry.id,
				persistenceKey: pending.persistenceKey,
				note: retryRecovery.note,
				retryRecovery,
			});
		}
		if (recoveredErrors.length > 0) {
			await this.sessionManager.rewriteEntries();
		}
		return recoveredErrors;
	}

	async #handleEmptyAssistantStop(assistantMessage: AssistantMessage): Promise<boolean> {
		if (!this.#isEmptyAssistantStop(assistantMessage)) {
			this.#emptyStopRetryCount = 0;
			return false;
		}

		if (this.#acceptTerminalEmptyStopForPrompt && assistantMessage.stopReason === "stop") {
			this.#acceptTerminalEmptyStopForPrompt = false;
			this.#discardAcceptedTerminalEmptyStop(assistantMessage);
			this.#emptyStopRetryCount = 0;

			await this.#endAnnouncedContinuationWait("Continued turn returned an empty completion");
			return false;
		}

		this.#emptyStopRetryCount++;
		if (this.#emptyStopRetryCount > EMPTY_STOP_MAX_RETRIES) {
			const attempts = this.#emptyStopRetryCount - 1;
			const failure = "Assistant returned empty stop after retry cap";
			logger.warn(failure, {
				attempts,
				model: assistantMessage.model,
				provider: assistantMessage.provider,
			});
			await this.#emitSessionEvent({
				type: "auto_retry_end",
				success: false,
				attempt: this.#retryAttempt > 0 ? this.#retryAttempt : attempts,

				finalError: `${failure} (${assistantMessage.provider}/${assistantMessage.model})`,
			});
			this.#clearPendingRecoveredRetryErrors();
			this.#retryAttempt = 0;

			this.#unreplayableBatchContinues = 0;
			this.#resolveRetry();

			this.#emptyStopRetryCount = 0;

			this.#discardAssistantTurn(assistantMessage);
			this.#dropTurnRetryReminders();
			return false;
		}
		this.#discardAssistantTurn(assistantMessage);
		const reminder: AgentMessage = {
			role: "developer",
			content: [{ type: "text", text: this.#emptyStopRetryReminder() }],
			attribution: "agent",
			timestamp: Date.now(),
		};
		this.#turnRetryReminders.push(reminder);
		this.agent.appendMessage(reminder);
		this.#scheduleAgentContinue({ generation: this.#promptGeneration });
		return true;
	}

	#isEmptyAssistantStop(assistantMessage: AssistantMessage): boolean {
		switch (assistantMessage.stopReason) {
			case "stop":
				for (const content of assistantMessage.content) {
					if (content.type === "toolCall") return false;
					if (content.type === "text" && hasNonWhitespace(content.text)) return false;
				}
				return true;
			case "toolUse":
				for (const content of assistantMessage.content) {
					if (content.type === "toolCall") return false;
					if (content.type === "text" && hasNonWhitespace(content.text)) return false;
				}
				return true;
			default:
				return false;
		}
	}

	#emptyStopRetryReminder(): string {
		return prompt.render(turnControlPrompts["turn-control/empty-stop-retry"].text, {
			retryCount: this.#emptyStopRetryCount,
			maxRetries: EMPTY_STOP_MAX_RETRIES,
		});
	}

	#dropTurnRetryReminders(): void {
		if (this.#turnRetryReminders.length === 0) return;
		const scaffolding = new Set<AgentMessage>(this.#turnRetryReminders);
		this.#turnRetryReminders = [];
		const messages = this.agent.state.messages;
		const kept = messages.filter(message => !scaffolding.has(message));
		if (kept.length !== messages.length) this.agent.replaceMessages(kept);
	}

	async #handleUnexpectedAssistantStop(
		assistantMessage: AssistantMessage,
		settleState: SettleContinuationState,
	): Promise<boolean> {
		if (!this.settings.get("features.unexpectedStopDetection")) {
			return false;
		}

		if (!mayContinueAtSettle("unexpected-stop-retry", settleState)) {
			this.#unexpectedStopRetryCount = 0;
			return false;
		}
		if (!isUnexpectedStopCandidate(assistantMessage)) {
			this.#unexpectedStopRetryCount = 0;
			return false;
		}

		const text = assistantText(assistantMessage);
		if (!/\S/.test(text)) {
			this.#unexpectedStopRetryCount = 0;
			return false;
		}

		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), UNEXPECTED_STOP_TIMEOUT_MS);
		let classification: boolean | undefined;
		try {
			classification = await classifyUnexpectedStop(text, {
				settings: this.settings,
				registry: this.#modelRegistry,
				model: this.model ?? undefined,
				sessionId: this.sessionId,
				metadataResolver: (provider: string) => this.agent.metadataForProvider(provider),
				signal: controller.signal,
				obfuscateProviderText: text => this.obfuscateProviderText(text),
				completeImpl: this.#sideCompleteImpl,
			});
		} finally {
			clearTimeout(timeout);
		}

		if (classification !== true) {
			this.#unexpectedStopRetryCount = 0;
			return false;
		}

		this.#unexpectedStopRetryCount++;
		if (this.#unexpectedStopRetryCount > UNEXPECTED_STOP_MAX_RETRIES) {
			logger.warn("Assistant returned unexpected stop after retry cap", {
				attempts: this.#unexpectedStopRetryCount - 1,
				model: assistantMessage.model,
				provider: assistantMessage.provider,
			});
			this.#unexpectedStopRetryCount = 0;

			this.#dropTurnRetryReminders();
			return false;
		}

		const reminder: AgentMessage = {
			role: "developer",
			content: [{ type: "text", text: this.#unexpectedStopRetryReminder() }],
			attribution: "agent",
			timestamp: Date.now(),
		};
		this.#turnRetryReminders.push(reminder);
		this.agent.appendMessage(reminder);
		this.#scheduleAgentContinue({ generation: this.#promptGeneration });
		return true;
	}

	#unexpectedStopRetryReminder(): string {
		return prompt.render(turnControlPrompts["turn-control/unexpected-stop-retry"].text, {
			retryCount: this.#unexpectedStopRetryCount,
			maxRetries: UNEXPECTED_STOP_MAX_RETRIES,
		});
	}

	#removeAssistantMessageFromActiveContext(
		assistantMessage: AssistantMessage,
		reason = "assistant-context-cleanup",
	): void {
		const messages = this.agent.state.messages;
		let end = messages.length;
		while (end > 0) {
			const candidate = messages[end - 1];
			if (candidate?.role !== "toolResult" || !toolResultNeverRan(candidate.details)) break;
			end -= 1;
		}
		const lastMessage = messages[end - 1];
		const lastAssistant: AssistantMessage | undefined = lastMessage?.role === "assistant" ? lastMessage : undefined;
		if (lastAssistant !== undefined && this.#isSameAssistantMessage(lastAssistant, assistantMessage)) {
			this.agent.replaceMessages(messages.slice(0, end - 1));
			return;
		}

		logger.debug("agent active context assistant removal missed", {
			reason,
			lastRole: lastMessage?.role,
			trailingPlaceholders: messages.length - end,
			candidateTimestamp: assistantMessage.timestamp,
			lastTimestamp: lastAssistant?.timestamp,
			candidateStopReason: assistantMessage.stopReason,
			lastStopReason: lastAssistant?.stopReason,
		});
	}

	async #dropPersistedAssistantTurn(assistantMessage: AssistantMessage): Promise<void> {
		await this.#waitForSessionMessagePersistence(assistantMessage);
		this.#discardAssistantTurn(assistantMessage);
	}

	async #runRecoveryCompactionWithRollback(
		reason: "overflow" | "incomplete",
		assistantMessage: AssistantMessage,
		options: { autoContinue: boolean; triggerContextTokens?: number },
	): Promise<CompactionCheckResult> {
		const compactionEntryBefore = getLatestCompactionEntry(this.sessionManager.getBranch());
		await this.#dropPersistedAssistantTurn(assistantMessage);
		const result = await this.#runAutoCompaction(reason, true, {
			autoContinue: options.autoContinue,
			triggerContextTokens: options.triggerContextTokens,
			phase: "mid_turn",
		});
		const compactionEntryAfter = getLatestCompactionEntry(this.sessionManager.getBranch());
		if (result.historyRewritten !== true && compactionEntryAfter === compactionEntryBefore) {
			this.#restoreFailedAssistantTurn(assistantMessage);
		}
		return result;
	}

	#restoreFailedAssistantTurn(assistantMessage: AssistantMessage): void {
		if (!isEmptyErrorTurn(assistantMessage)) this.sessionManager.appendMessage(assistantMessage);
		this.#restoreFailedAssistantTurnToActiveContext(assistantMessage);
	}

	#restoreFailedAssistantTurnToActiveContext(assistantMessage: AssistantMessage): void {
		const lastMessage = this.agent.state.messages.at(-1);
		if (
			lastMessage?.role === "assistant" &&
			this.#isSameAssistantMessage(lastMessage as AssistantMessage, assistantMessage)
		) {
			return;
		}
		this.agent.appendMessage(assistantMessage);
	}

	#discardAcceptedTerminalEmptyStop(assistantMessage: AssistantMessage): void {
		const branch = this.sessionManager.getBranch();
		let branchEntry: SessionEntry | undefined;
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i]!;
			if (
				entry.type === "message" &&
				entry.message.role === "assistant" &&
				this.#isSameAssistantMessage(entry.message, assistantMessage)
			) {
				branchEntry = entry;
				break;
			}
		}
		const parentEntry =
			branchEntry?.parentId === null || branchEntry?.parentId === undefined
				? undefined
				: branch.find(entry => entry.id === branchEntry.parentId);
		const prunePrompt = parentEntry?.type === "custom_message";

		this.#removeAssistantMessageFromActiveContext(assistantMessage, "accepted-terminal-empty-stop");
		if (prunePrompt && this.agent.state.messages.at(-1)?.role === "custom") {
			this.agent.replaceMessages(this.agent.state.messages.slice(0, -1));
		}

		if (!branchEntry) return;
		const targetParentId = prunePrompt ? parentEntry.parentId : branchEntry.parentId;
		if (targetParentId === null) {
			this.sessionManager.resetLeaf();
		} else {
			this.sessionManager.branch(targetParentId);
		}
		this.sessionManager.appendCustomEntry("accepted-terminal-empty-stop");
	}

	#discardAssistantTurn(assistantMessage: AssistantMessage): void {
		this.#removeAssistantMessageFromActiveContext(assistantMessage);

		const branch = this.sessionManager.getBranch();
		let branchEntry: SessionEntry | undefined;
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i]!;
			if (
				entry.type === "message" &&
				entry.message.role === "assistant" &&
				this.#isSameAssistantMessage(entry.message as AssistantMessage, assistantMessage)
			) {
				branchEntry = entry;
				break;
			}
		}
		if (!branchEntry) {
			return;
		}
		if (branchEntry.parentId === null) {
			this.sessionManager.resetLeaf();
		} else {
			this.sessionManager.branch(branchEntry.parentId);
		}
	}

	#isSameAssistantMessage(left: AssistantMessage, right: AssistantMessage): boolean {
		return (
			left === right ||
			(left.timestamp === right.timestamp &&
				left.provider === right.provider &&
				left.model === right.model &&
				left.stopReason === right.stopReason)
		);
	}

	#enforceRewindBeforeYield(): boolean {
		if (!this.#checkpointState || this.#pendingRewindReport) {
			return false;
		}
		const reminder = [
			"<system-warning>",
			"You are in an active checkpoint. You MUST call rewind with your investigation findings before yielding. Do NOT yield without completing the checkpoint.",
			"</system-warning>",
		].join("\n");
		this.agent.appendMessage({
			role: "developer",
			content: [{ type: "text", text: reminder }],
			attribution: "agent",
			timestamp: Date.now(),
		});
		this.#scheduleAgentContinue({ generation: this.#promptGeneration });
		return true;
	}

	#enforceVerificationBeforeFinalize(): boolean {
		if (this.#isSubagent) return false;
		const reminder = this.#verificationEvidence.takeFinalizationReminder();
		if (!reminder) return false;
		const reminderMessage: CustomMessage = {
			role: "custom",
			customType: VERIFICATION_EVIDENCE_REMINDER_TYPE,
			content: reminder,
			display: false,
			attribution: "agent",
			timestamp: Date.now(),
		};
		this.agent.appendMessage(reminderMessage);
		this.sessionManager.appendCustomMessageEntry(
			reminderMessage.customType,
			reminderMessage.content,
			reminderMessage.display,
			undefined,
			reminderMessage.attribution,
		);
		this.#scheduleAgentContinue({ generation: this.#promptGeneration });
		return true;
	}

	#enforceCodeReviewBeforeFinalize(): boolean {
		if (this.#isSubagent) return false;
		if (!this.settings.get("edit.critiqueCodeMutations")) return false;
		const reminder = this.#verificationEvidence.takeCodeReviewReminder();
		if (!reminder) return false;
		const reminderMessage: CustomMessage = {
			role: "custom",
			customType: CODE_REVIEW_REMINDER_TYPE,
			content: reminder,
			display: false,
			attribution: "agent",
			timestamp: Date.now(),
		};
		this.agent.appendMessage(reminderMessage);
		this.sessionManager.appendCustomMessageEntry(
			reminderMessage.customType,
			reminderMessage.content,
			reminderMessage.display,
			undefined,
			reminderMessage.attribution,
		);
		this.#scheduleAgentContinue({ generation: this.#promptGeneration });
		return true;
	}

	#extractRewindReport(messages: AgentMessage[]): string | undefined {
		if (!this.#checkpointState) return undefined;
		if (this.#pendingRewindReport) return this.#pendingRewindReport;
		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i];
			if (message?.role !== "toolResult" || message.toolName !== TOOL.rewind || message.isError) continue;
			const details = message.details;
			const detailReport =
				details && typeof details === "object" && "report" in details && typeof details.report === "string"
					? details.report.trim()
					: "";
			const textReport = message.content.find(part => part.type === "text")?.text.trim() ?? "";
			const report = detailReport || textReport;
			return report.length > 0 ? report : undefined;
		}
		return undefined;
	}

	async #applyRewind(report: string, activeMessages?: AgentMessage[]): Promise<void> {
		const checkpointState = this.#checkpointState;
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
		this.#lastCompletedRewind = { report, startedAt: checkpointState.startedAt, rewoundAt };

		if (activeMessages) {
			for (const message of activeMessages) {
				if (message.role === "toolResult" && message.toolName === TOOL.rewind) {
					this.#rewoundToolResultIds.add(message.toolCallId);
				}
			}
		}
		const sessionContext = this.buildDisplaySessionContext();
		if (activeMessages) {
			activeMessages.splice(0, activeMessages.length, ...sessionContext.messages);
		}
		await this.#restoreMCPSelectionsForSessionContext(sessionContext);
		this.agent.replaceMessages(activeMessages ?? sessionContext.messages);
		this.#resetAdvisorSessionState();
		this.#syncTodoPhasesFromBranch();
		this.#closeCodexProviderSessionsForHistoryRewrite();
		this.#checkpointState = undefined;
		this.#pendingRewindReport = undefined;
	}
	#isPlanDecisionTool(name: string): boolean {
		return PLAN_DECISION_TOOLS.has(name);
	}

	async #enforcePlanModeDecisionAtSettle(): Promise<boolean> {
		if (!this.#planModeState?.enabled) {
			return false;
		}
		const assistantMessage = this.#findLastAssistantMessage();
		if (!assistantMessage) {
			return false;
		}
		if (assistantMessage.stopReason === "error" || assistantMessage.stopReason === "aborted") {
			return false;
		}

		const calledDecisionTool = assistantMessage.content.some(
			content => content.type === "toolCall" && this.#isPlanDecisionTool(content.name),
		);
		if (calledDecisionTool) {
			this.#planModeReminderCount = 0;
			this.#planModeReminderAwaitingProgress = false;
			return false;
		}

		const hasToolCall = assistantMessage.content.some(content => content.type === "toolCall");
		if (hasToolCall) {
			return false;
		}
		if (this.#planModeReminderAwaitingProgress) {
			return false;
		}
		if (this.#planModeReminderCount >= PLAN_MODE_REMINDER_MAX) {
			logger.debug("Plan mode convergence: reminder cap reached; yielding to user");
			return false;
		}
		const hasRequiredTools = this.#toolRegistry.has(TOOL.ask) && this.#toolRegistry.has(TOOL.resolve);
		if (!hasRequiredTools) {
			logger.warn("Plan mode enforcement skipped because ask/resolve tools are unavailable", {
				activeToolNames: this.agent.state.tools.map(tool => tool.name),
			});
			return false;
		}

		this.#planModeReminderCount++;
		this.#planModeReminderAwaitingProgress = true;
		this.#toolChoiceQueue.pushOnce("required", { label: "plan-mode-decision" });
		const reminder = prompt.render(planModePrompts["plan-mode/tool-decision-reminder"].text, {
			askToolName: TOOL.ask,
		});
		const reminderMessage: Message = {
			role: "developer",
			content: [{ type: "text", text: reminder }],
			attribution: "agent",
			timestamp: Date.now(),
		};

		this.agent.appendMessage(reminderMessage);
		this.sessionManager.appendMessage(reminderMessage);
		this.#scheduleAgentContinue({
			generation: this.#promptGeneration,

			onSkip: () => this.#toolChoiceQueue.removeByLabel("plan-mode-decision"),
		});
		return true;
	}

	#buildEagerPreludeContext(): { toolRefs: Record<string, string>; taskBatch: boolean } {
		const wireName = (name: string): string => {
			const tool = this.#toolRegistry.get(name);
			return typeof tool?.customWireName === "string" ? tool.customWireName : name;
		};
		return {
			toolRefs: { task: wireName(TOOL.task), todo: wireName(TOOL.todo) },
			taskBatch: this.settings.get("subagent.batch"),
		};
	}

	#createEagerTodoPrelude(
		promptText: string | undefined,
	): { message: AgentMessage; toolChoice?: ToolChoice } | undefined {
		const mode = this.settings.get("todo.eager");
		const todosEnabled = this.settings.get("todo.enabled");
		if (mode === "default" || !todosEnabled) {
			return undefined;
		}

		if (this.#planModeState?.enabled) {
			return undefined;
		}
		if (this.getTodoPhases().length > 0) {
			return undefined;
		}

		if (promptText !== undefined) {
			const hasPriorUserMessage = this.agent.state.messages.some(m => m.role === "user");
			if (hasPriorUserMessage) {
				return undefined;
			}

			const trimmedPromptText = promptText.trimEnd();
			if (trimmedPromptText.endsWith("?") || trimmedPromptText.endsWith("!")) {
				return undefined;
			}
		}

		if (!this.getActiveToolNames().includes(TOOL.todo)) {
			logger.warn("Eager todo enforcement skipped because todo is not active", {
				activeToolNames: this.getActiveToolNames(),
			});
			return undefined;
		}

		const message: AgentMessage = {
			role: "custom",
			customType: "eager-todo-prelude",
			content: prompt.render(turnControlPrompts["turn-control/eager-todo"].text, {
				...this.#buildEagerPreludeContext(),
				forced: mode === "always",
			}),
			display: false,
			attribution: "agent",
			timestamp: Date.now(),
		};

		if (promptText === undefined || mode === "preferred") {
			return { message };
		}
		const todoToolChoice = buildNamedToolChoice(TOOL.todo, this.model);
		if (!todoToolChoice) {
			logger.warn(
				"Eager todo proceeding with the reminder only because the current model does not support a forced todo tool_choice",
				{ modelApi: this.model?.api, modelId: this.model?.id },
			);
			return { message };
		}
		return { message, toolChoice: todoToolChoice };
	}

	#createEagerTaskPrelude(promptText: string | undefined): AgentMessage | undefined {
		if (!resolveDelegation(this.settings, enabledSubagentNames(this.#toolRegistry.get(TOOL.task))).required) {
			return undefined;
		}

		if (this.#agentKind === "sub") return undefined;
		if (this.#planModeState?.enabled) return undefined;

		if (promptText !== undefined) {
			if (this.agent.state.messages.some(m => m.role === "user")) return undefined;
			const trimmed = promptText.trimEnd();
			if (trimmed.endsWith("?") || trimmed.endsWith("!")) return undefined;
		}
		if (!this.getActiveToolNames().includes(TOOL.task)) return undefined;
		return {
			role: "custom",
			customType: "eager-task-prelude",
			content: prompt.render(turnControlPrompts["turn-control/eager-task"].text, this.#buildEagerPreludeContext()),
			display: false,
			attribution: "agent",
			timestamp: Date.now(),
		};
	}

	#buildPostCompactionEagerNudges(): AgentMessage[] {
		const nudges: AgentMessage[] = [];
		const todo = this.#createEagerTodoPrelude(undefined);
		if (todo) nudges.push(todo.message);
		const task = this.#createEagerTaskPrelude(undefined);
		if (task) nudges.push(task);
		return nudges;
	}

	async #checkTodoCompletion(settleState: SettleContinuationState): Promise<boolean> {
		const lastServedLabel = this.#toolChoiceQueue.consumeLastServedLabel();
		if (lastServedLabel === "user-force") {
			return false;
		}

		const remindersEnabled = this.settings.get("todo.reminders");
		const todosEnabled = this.settings.get("todo.enabled");
		if (!remindersEnabled || !todosEnabled) {
			this.#todoReminderCount = 0;
			this.#todoReminderAwaitingProgress = false;
			this.#lastTodoReminderFingerprint = undefined;
			this.#todoReminderEchoCompactionId = undefined;
			return false;
		}

		if (this.#planModeState?.enabled) {
			return false;
		}

		if (this.#goalModeState?.enabled === true && this.#goalModeState.goal.status === "active") {
			return false;
		}

		if (this.#todoReminderAwaitingProgress) {
			logger.debug("Todo completion: prior reminder still awaiting agent action; staying silent", {
				attempt: this.#todoReminderCount,
			});
			return false;
		}

		const remindersMax = this.settings.get("todo.reminders.max");
		if (this.#todoReminderCount >= remindersMax) {
			logger.debug("Todo completion: max reminders reached", { count: this.#todoReminderCount });
			return false;
		}

		if (this.#lastTodoFailureText !== undefined) {
			logger.debug("Todo completion: last todo write failed, board state unknown; staying silent");
			return false;
		}

		const incomplete = incompleteTodoItems(this.#todoPhases);
		if (incomplete.length === 0) {
			this.#todoReminderCount = 0;
			this.#todoReminderAwaitingProgress = false;
			this.#lastTodoReminderFingerprint = undefined;
			return false;
		}

		if (!mayContinueAtSettle("todo-reminder", settleState)) {
			logger.debug("Todo completion: assistant is waiting for user input; skipping reminder", {
				incomplete: incomplete.length,
			});
			return false;
		}

		if (this.#hasPendingAsyncWake()) {
			logger.debug("Todo completion: async jobs in flight will re-wake the loop; skipping reminder", {
				incomplete: incomplete.length,
			});
			return false;
		}

		const fingerprint = todoReminderFingerprint(incomplete);
		if (fingerprint === this.#lastTodoReminderFingerprint) {
			this.#todoReminderAwaitingProgress = true;
			logger.debug("Todo completion: unchanged todo state already reminded; staying silent", {
				incomplete: incomplete.length,
				attempt: this.#todoReminderCount,
			});
			return false;
		}

		this.#todoReminderCount++;

		const compactionBoundary = getLatestCompactionEntry(this.sessionManager.getBranch())?.id ?? null;
		const echoFullList = this.#todoReminderEchoCompactionId !== compactionBoundary;
		const reminder = renderTodoContinuationReminder({
			items: incomplete,
			attempt: this.#todoReminderCount,
			maxAttempts: remindersMax,
			echoFullList,
		});

		if (echoFullList) this.#todoReminderEchoCompactionId = compactionBoundary;

		this.#lastTodoReminderFingerprint = fingerprint;
		this.#todoReminderAwaitingProgress = true;

		logger.debug("Todo completion: sending reminder", {
			incomplete: incomplete.length,
			attempt: this.#todoReminderCount,
		});

		await this.#emitSessionEvent({
			type: "todo_reminder",
			todos: incomplete.map(({ content, status }) => ({ content, status })),
			attempt: this.#todoReminderCount,
			maxAttempts: remindersMax,
		});

		const reminderMessage: Message = {
			role: "developer",
			content: [{ type: "text", text: reminder }],
			attribution: "agent",
			timestamp: Date.now(),
		};

		this.#mutationsSinceLastTodoTouch = 0;

		this.agent.appendMessage(reminderMessage);
		this.sessionManager.appendMessage(reminderMessage);
		this.#scheduleAgentContinue({ generation: this.#promptGeneration });
		return true;
	}

	#takeMidRunTodoNudge(): AgentMessage | null {
		if (this.#mutationsSinceLastTodoTouch < MID_RUN_TODO_NUDGE_MUTATION_THRESHOLD) return null;
		if (this.#midRunNudgeCount >= MID_RUN_TODO_NUDGE_MAX_PER_CYCLE) return null;
		if (!this.settings.get("todo.enabled")) return null;
		if (!this.settings.get("todo.reminders")) return null;

		if (this.#planModeState?.enabled) return null;

		if (!this.getActiveToolNames().includes(TOOL.todo)) return null;

		if (this.#lastTodoFailureText !== undefined) return null;

		const incomplete = this.getTodoPhases()
			.flatMap(phase => phase.tasks)
			.filter(task => task.status === "pending" || task.status === "in_progress");
		if (incomplete.length === 0) return null;

		this.#mutationsSinceLastTodoTouch = 0;
		this.#midRunNudgeCount++;

		const { toolRefs } = this.#buildEagerPreludeContext();
		const reminder = prompt.render(turnControlPrompts["turn-control/mid-run-todo-nudge"].text, {
			toolRefs,
			incompleteCount: incomplete.length,
			plural: incomplete.length !== 1,
		});

		logger.debug("Mid-run todo nudge fired", {
			incomplete: incomplete.length,
			nudge: this.#midRunNudgeCount,
		});

		return {
			role: "custom",
			customType: MID_RUN_TODO_NUDGE_MESSAGE_TYPE,
			content: reminder,
			display: false,
			attribution: "agent",
			timestamp: Date.now(),
		};
	}

	async #tryContextPromotion(assistantMessage: AssistantMessage): Promise<boolean> {
		const currentModel = this.model;
		if (!currentModel) return false;

		if (assistantMessage.provider !== currentModel.provider || assistantMessage.model !== currentModel.id)
			return false;
		return this.#promoteContextModel();
	}

	async #promoteContextModel(): Promise<boolean> {
		const promotionSettings = this.settings.getGroup("contextPromotion");
		if (!promotionSettings.enabled) return false;
		const currentModel = this.model;
		if (!currentModel) return false;
		const contextWindow = currentModel.contextWindow ?? 0;
		if (contextWindow <= 0) return false;
		const targetModel = await this.#resolveContextPromotionTarget(currentModel, contextWindow);
		if (!targetModel) return false;

		try {
			await this.setModelTemporary(targetModel, undefined, { ephemeral: true });
			logger.debug("Context promotion switched model on overflow", {
				from: `${currentModel.provider}/${currentModel.id}`,
				to: `${targetModel.provider}/${targetModel.id}`,
			});
			return true;
		} catch (error) {
			logger.warn("Context promotion failed", {
				from: `${currentModel.provider}/${currentModel.id}`,
				to: `${targetModel.provider}/${targetModel.id}`,
				error: errorMessage(error),
			});
			return false;
		}
	}

	async #resolveContextPromotionTarget(currentModel: Model, contextWindow: number): Promise<Model | undefined> {
		const availableModels = this.#modelRegistry.getAvailable();
		if (availableModels.length === 0) return undefined;

		const candidate = this.#resolveContextPromotionConfiguredTarget(currentModel, availableModels);
		if (!candidate) return undefined;
		if (modelsAreEqual(candidate, currentModel)) return undefined;
		if (candidate.contextWindow == null || candidate.contextWindow <= contextWindow) return undefined;
		const apiKey = await this.#modelRegistry.getApiKey(candidate, this.sessionId);
		if (!apiKey) return undefined;
		return candidate;
	}

	#setModelWithProviderSessionReset(model: Model): void {
		const currentModel = this.model;
		if (currentModel) {
			this.#closeProviderSessionsForModelSwitch(currentModel, model);
			if (!modelsAreEqual(currentModel, model)) {
				this.#clearInheritedProviderPromptCacheKey("model-change");
			}
		}
		this.agent.setModel(model);

		this.#syncAppendOnlyContext(model);
	}

	#closeCodexProviderSessionsForHistoryRewrite(): void {
		const currentModel = this.model;
		if (currentModel?.api !== "openai-codex-responses") return;
		this.#closeProviderSessionsForModelSwitch(currentModel, currentModel);
	}

	#resetCodexProviderAfterCompaction(compaction: CodexCompactionContext): void {
		resetOpenAICodexHistoryAfterCompaction({
			providerSessionState: this.#providerSessionState,
			sessionId: this.sessionId,
			compaction,
		});
	}

	#resetCurrentResponsesProviderSession(reason: string): void {
		const currentModel = this.model;
		if (currentModel?.api !== "openai-responses" && currentModel?.api !== "openai-codex-responses") {
			return;
		}

		this.#closeProviderSessionsForModelSwitch(currentModel, currentModel);
		this.agent.appendOnlyContext?.invalidateForModelChange();
		logger.debug("Reset Responses provider session after stale replay error", {
			provider: currentModel.provider,
			model: currentModel.id,
			api: currentModel.api,
			reason,
		});
	}

	#syncAppendOnlyContext(model: Model | null | undefined): void {
		const setting = this.settings.get("provider.appendOnlyContext") ?? "auto";
		const enable = shouldEnableAppendOnlyContext(setting, model);
		const providerId = model?.provider;
		const prev = this.#lastAppendOnlyResolution;
		if (prev && prev.enable === enable && prev.providerId === providerId) return;
		this.#lastAppendOnlyResolution = { enable, providerId };

		if (enable && !this.agent.appendOnlyContext) {
			this.agent.setAppendOnlyContext(new AppendOnlyContextManager());
		} else if (enable && this.agent.appendOnlyContext) {
			this.agent.appendOnlyContext.invalidateForModelChange();
		} else if (!enable && this.agent.appendOnlyContext) {
			this.agent.setAppendOnlyContext(undefined);
		}
	}

	#closeProviderSessionsForModelSwitch(currentModel: Model, nextModel: Model): void {
		const providerKeys = new Set<string>();
		if (currentModel.api === "openai-codex-responses" || nextModel.api === "openai-codex-responses") {
			providerKeys.add("openai-codex-responses");
		}
		if (currentModel.api === "openai-responses") {
			providerKeys.add(`openai-responses:${currentModel.provider}`);
		}
		if (nextModel.api === "openai-responses") {
			providerKeys.add(`openai-responses:${nextModel.provider}`);
		}

		let completionsPrefixToEvict: string | undefined;
		if (currentModel.api === "openai-completions") {
			const currentScope = `${currentModel.provider}:${currentModel.baseUrl ?? ""}`;
			const nextScope =
				nextModel.api === "openai-completions" ? `${nextModel.provider}:${nextModel.baseUrl ?? ""}` : undefined;
			if (currentScope !== nextScope) {
				completionsPrefixToEvict = `openai-completions:${currentModel.provider}:`;
			}
		}

		for (const providerKey of providerKeys) {
			const state = this.#providerSessionState.get(providerKey);
			if (!state) continue;

			try {
				state.close();
			} catch (error) {
				logger.warn("Failed to close provider session state during model switch", {
					providerKey,
					error: errorMessage(error),
				});
			}

			this.#providerSessionState.delete(providerKey);
		}

		if (completionsPrefixToEvict !== undefined) {
			for (const [key, state] of this.#providerSessionState) {
				if (!key.startsWith(completionsPrefixToEvict)) continue;
				try {
					state.close();
				} catch (error) {
					logger.warn("Failed to close provider session state during model switch", {
						providerKey: key,
						error: errorMessage(error),
					});
				}
				this.#providerSessionState.delete(key);
			}
		}
	}

	#normalizeProviderReplayValue(value: unknown): unknown {
		if (Array.isArray(value)) {
			return value.map(item => this.#normalizeProviderReplayValue(item));
		}
		if (value && typeof value === "object") {
			return Object.fromEntries(
				Object.entries(value).map(([key, entryValue]) => [key, this.#normalizeProviderReplayValue(entryValue)]),
			);
		}
		return value;
	}

	#normalizeSessionMessageForProviderReplay(message: AgentMessage): unknown {
		switch (message.role) {
			case "user":
			case "developer":
				return {
					role: message.role,
					content: this.#normalizeProviderReplayValue(message.content),
					providerPayload: message.providerPayload,
				};
			case "assistant": {
				const isResponsesFamilyMessage =
					message.api === "openai-responses" || message.api === "openai-codex-responses";
				return {
					role: message.role,
					content:
						isResponsesFamilyMessage && Array.isArray(message.content)
							? message.content.flatMap(block => {
									if (block.type === "thinking") {
										return [];
									}
									if (block.type === "toolCall") {
										return [
											{
												type: block.type,
												id: block.id,
												name: block.name,
												arguments: block.arguments,
											},
										];
									}
									if (block.type === "text") {
										return [{ type: block.type, text: block.text, textSignature: block.textSignature }];
									}
									return [this.#normalizeProviderReplayValue(block)];
								})
							: this.#normalizeProviderReplayValue(message.content),
					api: message.api,
					provider: message.provider,
					model: message.model,
					stopReason: message.stopReason,
					errorMessage: message.errorMessage,
					providerPayload: isResponsesFamilyMessage ? undefined : message.providerPayload,
				};
			}
			case "toolResult":
				return {
					role: message.role,
					toolName: message.toolName,
					toolCallId: message.toolCallId,
					isError: message.isError,
					content: this.#normalizeProviderReplayValue(message.content),
				};
			case "bashExecution":
				return {
					role: message.role,
					command: message.command,
					output: message.output,
					exitCode: message.exitCode,
					cancelled: message.cancelled,
					meta: message.meta
						? {
								truncation: this.#normalizeProviderReplayValue(message.meta.truncation),
								limits: this.#normalizeProviderReplayValue(message.meta.limits),
								diagnostics: message.meta.diagnostics
									? this.#normalizeProviderReplayValue({
											summary: message.meta.diagnostics.summary,
											messages: message.meta.diagnostics.messages,
										})
									: undefined,
							}
						: undefined,
					excludeFromContext: message.excludeFromContext,
				};
			case "pythonExecution":
				return {
					role: message.role,
					code: message.code,
					output: message.output,
					exitCode: message.exitCode,
					cancelled: message.cancelled,
					meta: message.meta
						? {
								truncation: this.#normalizeProviderReplayValue(message.meta.truncation),
								limits: this.#normalizeProviderReplayValue(message.meta.limits),
								diagnostics: message.meta.diagnostics
									? this.#normalizeProviderReplayValue({
											summary: message.meta.diagnostics.summary,
											messages: message.meta.diagnostics.messages,
										})
									: undefined,
							}
						: undefined,
					excludeFromContext: message.excludeFromContext,
				};
			case "custom":
			case "hookMessage":
				return {
					role: message.role,
					customType: message.customType,
					content: this.#normalizeProviderReplayValue(message.content),
				};
			case "branchSummary":
				return { role: message.role, summary: message.summary };
			case "compactionSummary":
				return {
					role: message.role,
					summary: message.summary,
					providerPayload: message.providerPayload,
				};
			case "fileMention":
				return {
					role: message.role,
					files: message.files.map(file => ({
						path: file.path,
						content: file.content,
						image: file.image,
					})),
				};
			default:
				return this.#normalizeProviderReplayValue(message);
		}
	}

	#didSessionMessagesChange(previousMessages: AgentMessage[], nextMessages: AgentMessage[]): boolean {
		if (previousMessages.length !== nextMessages.length) return true;
		return previousMessages.some(
			(message, i) =>
				!Bun.deepEquals(
					this.#normalizeSessionMessageForProviderReplay(message),
					this.#normalizeSessionMessageForProviderReplay(nextMessages[i]),
				),
		);
	}

	#getModelKey(model: Model): string {
		return `${model.provider}/${model.id}`;
	}

	#formatRoleModelValue(
		role: string,
		model: Model,
		selectorOverride?: string,
		thinkingLevelOverride?: ConfiguredThinkingLevel,
	): string {
		const modelKey = selectorOverride ?? `${model.provider}/${model.id}`;
		if (thinkingLevelOverride !== undefined) {
			return formatModelSelectorValue(modelKey, thinkingLevelOverride);
		}
		const existingRoleValue = this.settings.getModelRole(role);
		if (!existingRoleValue) return modelKey;

		const thinkingLevel = extractExplicitThinkingSelector(existingRoleValue, this.settings, {
			isLiteralModelId: (provider, id) => this.#modelRegistry.find(provider, id) !== undefined,
		});
		return formatModelSelectorValue(modelKey, thinkingLevel);
	}
	#resolveConfiguredModelTarget(
		configuredTarget: string | undefined,
		currentModel: Model,
		availableModels: Model[],
	): Model | undefined {
		const trimmedTarget = configuredTarget?.trim();
		if (!trimmedTarget) return undefined;

		const parsed = parseModelString(trimmedTarget, {
			allowMaxSuffix: true,
			allowAutoAlias: true,
			isLiteralModelId: (provider, id) =>
				availableModels.some(model => model.provider === provider && model.id === id),
		});
		if (parsed) {
			const explicitModel = availableModels.find(m => m.provider === parsed.provider && m.id === parsed.id);
			if (explicitModel) return explicitModel;
		}

		return availableModels.find(m => m.provider === currentModel.provider && m.id === trimmedTarget);
	}

	#resolveContextPromotionConfiguredTarget(currentModel: Model, availableModels: Model[]): Model | undefined {
		return this.#resolveConfiguredModelTarget(currentModel.contextPromotionTarget, currentModel, availableModels);
	}

	#resolveCompactionConfiguredTarget(currentModel: Model, availableModels: Model[]): Model | undefined {
		return this.#resolveConfiguredModelTarget(currentModel.compactionModel, currentModel, availableModels);
	}

	#resolveRoleModelFull(
		role: string,
		availableModels: Model[],
		currentModel: Model | undefined,
	): ResolvedModelRoleValue {
		const roleModelStr =
			role === "default"
				? (this.settings.getModelRole(DEFAULT_MODEL_SLOT) ??
					(currentModel ? `${currentModel.provider}/${currentModel.id}` : undefined))
				: this.settings.getModelRole(role);

		if (!roleModelStr) {
			return { model: undefined, thinkingLevel: undefined, explicitThinkingLevel: false, warning: undefined };
		}

		return resolveModelRoleValue(roleModelStr, availableModels, {
			settings: this.settings,
			matchPreferences: getModelMatchPreferences(this.settings),
		});
	}

	#getCompactionModelCandidates(availableModels: Model[], filter?: (model: Model) => boolean): Model[] {
		return this.#resolveCompactionModelCandidates(this.model, availableModels, filter);
	}

	#resolveCompactionModelCandidates(
		preferredModel: Model | null | undefined,
		availableModels: Model[],
		filter?: (model: Model) => boolean,
	): Model[] {
		const candidates: Model[] = [];
		const seen = new Set<string>();

		const addCandidate = (model: Model | undefined): void => {
			if (!model) return;
			const key = this.#getModelKey(model);
			if (seen.has(key)) return;
			seen.add(key);
			if (filter && !filter(model)) return;
			candidates.push(model);
		};

		const configuredPatterns = resolveCompactionModelPatterns(this.settings);
		for (const pattern of configuredPatterns) {
			const resolved = resolveModelRoleValue(pattern, availableModels, {
				settings: this.settings,
				matchPreferences: getModelMatchPreferences(this.settings),
			});
			addCandidate(resolved.model);
		}

		const fallbackStrategy = this.settings.get("compaction.modelFallbackStrategy");
		if (fallbackStrategy === "configured-only") {
			if (configuredPatterns.length === 0) addCandidate(preferredModel ?? undefined);
			return candidates;
		}

		if (preferredModel) {
			const recommended = this.#resolveCompactionConfiguredTarget(preferredModel, availableModels);
			if (recommended && (fallbackStrategy === "any-model" || recommended.provider === preferredModel.provider)) {
				addCandidate(recommended);
			}
		}
		addCandidate(preferredModel ?? undefined);
		for (const role of SELECTABLE_MODEL_ROLE_IDS) {
			addCandidate(this.#resolveRoleModelFull(role, availableModels, preferredModel ?? undefined).model);
		}

		if (fallbackStrategy === "any-model") {
			const sortedByContext = [...availableModels].sort((a, b) => (b.contextWindow ?? 0) - (a.contextWindow ?? 0));
			for (const model of sortedByContext) {
				addCandidate(model);
			}
		}

		return candidates;
	}

	#resolveConfiguredCompactionEfforts(availableModels: Model[]): Map<string, ThinkingLevel> {
		const efforts = new Map<string, ThinkingLevel>();
		for (const pattern of resolveCompactionModelPatterns(this.settings)) {
			const resolved = resolveModelRoleValue(pattern, availableModels, {
				settings: this.settings,
				matchPreferences: getModelMatchPreferences(this.settings),
			});
			if (
				resolved.model &&
				resolved.explicitThinkingLevel &&
				resolved.thinkingLevel !== undefined &&
				resolved.thinkingLevel !== AUTO_THINKING
			) {
				const key = this.#getModelKey(resolved.model);
				if (!efforts.has(key)) efforts.set(key, resolved.thinkingLevel);
			}
		}
		return efforts;
	}

	#buildCompactionAuthError(): Error {
		const currentModel = this.model;
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

	#compactionCandidateError(candidate: Model, error: unknown): Error {
		return new Error(`${this.#getModelKey(candidate)}: ${errorMessage(error)}`, { cause: error });
	}

	#announceCompactionFallback(candidates: Model[], used: Model, skipReasons: Map<string, string>): void {
		const first = candidates[0];
		if (!first || this.#getModelKey(first) === this.#getModelKey(used)) return;
		const reason = skipReasons.get(this.#getModelKey(first)) ?? "it could not run the summary";
		const message = `Compacted with ${used.provider}/${used.id}. ${first.provider}/${first.id} was skipped: ${reason}.`;
		if (this.#announcedCompactionFallbacks.has(message)) return;
		this.#announcedCompactionFallbacks.add(message);
		this.emitNotice("warning", message, "compaction");
	}

	async #tryServerSideCompaction(
		preparation: CompactionPreparation,
		customInstructions: string | undefined,
		signal: AbortSignal,
		options: SummaryOptions,
	): Promise<CompactionResult | undefined> {
		if (this.settings.get("compaction.remote") !== true) return undefined;
		const model = this.model;
		if (!model || !resolveServerCompactionTransport(model)) return undefined;
		const apiKey = await this.#modelRegistry.getApiKey(model, this.sessionId);
		if (!apiKey) {
			const message = `no API key for ${model.provider}/${model.id}`;
			logger.warn("Server-side compaction unavailable, falling back to local compaction", { reason: message });
			if (!this.#announcedServerCompactionFailures.has(message)) {
				this.#announcedServerCompactionFailures.add(message);
				this.emitNotice(
					"warning",
					`Server-side compaction unavailable (${message}); falling back to local compaction.`,
					"compaction",
				);
			}
			return undefined;
		}
		try {
			return await compactWithProvider(
				this.#obfuscatePreparationForProvider(preparation),
				model,
				this.#modelRegistry.resolver(model, this.sessionId),
				this.#obfuscateTextForProvider(customInstructions),
				signal,
				{
					...options,
					metadata: this.agent.metadataForProvider(model.provider),
					convertToLlm: messages => this.#convertToLlmForSideRequest(messages),
					telemetry: resolveTelemetry(this.agent.telemetry, this.sessionId),
					thinkingLevel: this.thinkingLevel,
					tools: this.agent.state.tools,
					sessionId: this.sessionId,
					promptCacheKey: this.agent.promptCacheKey ?? this.sessionId,
					providerSessionState: this.#providerSessionState,
					obfuscateProviderText: text => this.obfuscateProviderText(text),
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

				this.emitNotice("warning", `${message}; falling back to local compaction.`, "compaction");
			}
			return undefined;
		}
	}

	async #compactWithFallbackModel(
		preparation: CompactionPreparation,
		customInstructions: string | undefined,
		signal: AbortSignal,
		options?: SummaryOptions,
		precomputedCandidates?: Model[],
	): Promise<CompactionResult> {
		const candidates =
			precomputedCandidates ?? this.#getCompactionModelCandidates(this.#modelRegistry.getAvailable());
		const telemetry = resolveTelemetry(this.agent.telemetry, this.sessionId);

		const configuredEffortByModel = this.#resolveConfiguredCompactionEfforts(this.#modelRegistry.getAvailable());

		const configuredCompactionWindow = this.settings.get("compaction.modelContextWindow");
		let summarizePayloadTokens = 0;
		let skippedForWindow = 0;

		const skipReasons = new Map<string, string>();

		for (const candidate of candidates) {
			const cachePrefix = await this.#cacheAlignedCompactionPrefix(candidate, signal);
			const candidateOptions: SummaryOptions = cachePrefix ? { ...options, ...cachePrefix } : (options ?? {});
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
					this.#getModelKey(candidate),
					`its context window holds ${candidateWindow} tokens and the summary needed ${summarizePayloadTokens}`,
				);
				logger.warn("compaction candidate skipped: summarization payload exceeds its context window", {
					candidate: `${candidate.provider}/${candidate.id}`,
					candidateWindow,
					summarizePayloadTokens,
				});
				continue;
			}
			const apiKey = await this.#modelRegistry.getApiKey(candidate, this.sessionId);
			if (!apiKey) {
				skipReasons.set(this.#getModelKey(candidate), "it is not authenticated");
				continue;
			}

			try {
				const compacted = await compact(
					this.#obfuscatePreparationForProvider(preparation),
					candidate,
					this.#modelRegistry.resolver(candidate, this.sessionId),
					this.#obfuscateTextForProvider(customInstructions),
					signal,
					{
						...candidateOptions,
						metadata: this.agent.metadataForProvider(candidate.provider),
						convertToLlm: messages => this.#convertToLlmForSideRequest(messages),
						telemetry,

						thinkingLevel: configuredEffortByModel.get(this.#getModelKey(candidate)) ?? this.thinkingLevel,
						tools: cachePrefix?.tools ?? this.agent.state.tools,
						sessionId: this.sessionId,

						promptCacheKey: this.agent.promptCacheKey ?? this.sessionId,
						providerSessionState: this.#providerSessionState,

						obfuscateProviderText: text => this.obfuscateProviderText(text),

						completeImpl: this.#sideCompleteImpl,

						serviceTier: this.#effectiveServiceTier(candidate),
					},
				);
				this.#announceCompactionFallback(candidates, candidate, skipReasons);
				return compacted;
			} catch (error) {
				if (!AIError.is(AIError.classify(error, candidate.api), AIError.Flag.AuthFailed)) {
					throw error;
				}
				skipReasons.set(this.#getModelKey(candidate), "its credentials were rejected");
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

		if (!hookCompaction && this.#extensionRunner?.hasHandlers("session_compacting")) {
			const compactMessages = preparation.messagesToSummarize.concat(preparation.turnPrefixMessages);
			const result = (await this.#extensionRunner.emit({
				type: "session_compacting",
				sessionId: this.sessionId,
				messages: compactMessages,
			})) as { context?: string[]; prompt?: string; preserveData?: Record<string, unknown> } | undefined;

			hookContext = result?.context?.map(context => this.#obfuscateTextForProvider(context) ?? context);
			hookPrompt = this.#obfuscateTextForProvider(result?.prompt);
			preserveData = result?.preserveData;
		}

		const memoryBackendContext = await this.#collectMemoryBackendContext(preparation);
		if (memoryBackendContext) {
			const providerContext = this.#obfuscateTextForProvider(memoryBackendContext) ?? memoryBackendContext;
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

	#compactionCreatedHeadroom(): boolean {
		const contextWindow = this.model?.contextWindow ?? 0;
		if (contextWindow <= 0) return true;
		const compactionSettings = this.settings.getGroup("compaction");
		const residualTokens = compactionContextTokens(
			this.getContextUsage({ contextWindow })?.tokens ?? 0,
			this.#estimateStoredContextTokens(),
		);
		const thresholdTokens = resolveThresholdTokens(contextWindow, compactionSettings);
		const recoveryBand = Math.floor(thresholdTokens * COMPACTION_RECOVERY_BAND);

		return residualTokens <= recoveryBand;
	}

	#thresholdStillTrips(compactionSettings: Parameters<typeof shouldCompact>[2]): boolean {
		const contextWindow = this.model?.contextWindow ?? 0;
		if (contextWindow <= 0) return true;
		const residualTokens = compactionContextTokens(
			this.getContextUsage({ contextWindow })?.tokens ?? 0,
			this.#estimateStoredContextTokens(),
		);
		return shouldCompact(residualTokens, contextWindow, compactionSettings);
	}

	#compactionCreatedRetryFit(): boolean {
		const contextWindow = this.model?.contextWindow ?? 0;
		if (contextWindow <= 0) return true;
		const compactionSettings = this.settings.getGroup("compaction");
		const residualTokens = compactionContextTokens(
			this.getContextUsage({ contextWindow })?.tokens ?? 0,
			this.#estimateStoredContextTokens(),
		);
		const fitBudget = Math.max(0, contextWindow - resolveBudgetReserveTokens(contextWindow, compactionSettings));
		return residualTokens <= fitBudget;
	}

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
				const result = await this.shake("elide", { signal });
				elided = result.toolResultsDropped + result.blocksDropped;
				elidedTokens = result.tokensFreed;
				if (result.artifactId) elideSink = "an artifact";
			} catch (error) {
				logger.warn("Dead-end shake rescue failed", {
					error: errorMessage(error),
				});
			}
			if (elided > 0 && options.hasProgress()) {
				this.emitNotice(
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
			imagesDropped = (await this.dropImages()).removed;
		} catch (error) {
			logger.warn("Dead-end image-drop rescue failed", {
				error: errorMessage(error),
			});
		}
		if (imagesDropped > 0 && options.hasProgress()) {
			const elidedPart = elided > 0 ? `${this.#describeElideRescue(elided, elidedTokens, elideSink)} and ` : "";
			this.emitNotice(
				"info",
				`Compaction dead-end recovery: ${elidedPart}dropped ${formatCount("attached image", imagesDropped)} so maintenance could make progress.`,
				"compaction",
			);
			return true;
		}
		return false;
	}

	async #persistCompactionTailElisions(preparation: CompactionPreparation): Promise<void> {
		const elisions = preparation.tailElisions ?? [];
		if (elisions.length === 0) return;
		let artifactId: string | undefined;
		try {
			artifactId = await this.sessionManager.saveArtifact(renderTailElisionArtifact(elisions), "compaction-tail");
		} catch (error) {
			logger.warn("Failed to persist compaction tail elision artifact", {
				error: errorMessage(error),
				elisionCount: elisions.length,
			});
			artifactId = undefined;
		}
		if (artifactId) {
			const branch = this.sessionManager.getBranch();
			for (const elision of elisions) {
				const pointed: ToolResultMessage = {
					...elision.message,
					content: [{ type: "text", text: renderTailElisionMarker(elision.toolName, elision.tokens, artifactId) }],
				};
				const entry = branch.find(e => e.id === elision.entryId);
				if (entry?.type !== "message" || entry.message !== elision.message) continue;
				entry.message = pointed;
				elision.message = pointed;
			}
		}
		await this.sessionManager.rewriteEntries();
	}

	#rollbackCompactionTailElisions(preparation: CompactionPreparation | undefined): void {
		const elisions = preparation?.tailElisions;
		if (!elisions || elisions.length === 0) return;
		rollbackTailElisions(this.sessionManager.getBranch(), elisions);
	}

	#describeElideRescue(elided: number, tokensFreed: number, sink: string): string {
		return `elided ${formatCount("heavy block", elided)} (~${tokensFreed.toLocaleString()} tokens) to ${sink}`;
	}

	async #runAutoCompaction(
		reason: "overflow" | "threshold" | "idle" | "incomplete",
		willRetry: boolean,
		options: {
			autoContinue?: boolean;
			triggerContextTokens?: number;
			suppressContinuation?: boolean;
			phase?: CodexCompactionContext["phase"];
		} = {},
	): Promise<CompactionCheckResult> {
		const compactionSettings = this.settings.getGroup("compaction");
		const rawStrategy = compactionSettings.strategy as string | undefined;
		if (reason === "idle") {
			if (isCompactionStrategyOff(rawStrategy)) return COMPACTION_CHECK_NONE;
		} else if (isThresholdCompactionDisabled(compactionSettings.enabled, rawStrategy)) {
			return COMPACTION_CHECK_NONE;
		}
		const generation = this.#promptGeneration;
		const suppressContinuation = options.suppressContinuation === true;
		const shouldAutoContinue =
			!suppressContinuation && options.autoContinue !== false && compactionSettings.autoContinue !== false;

		if (reason !== "idle") {
			const deduped = await this.dedupeRedundantToolResults();
			if (deduped.toolResultsDropped > 0) {
				if (this.#promptGeneration !== generation) return COMPACTION_CHECK_NONE;
				if (reason === "threshold" && !this.#thresholdStillTrips(compactionSettings)) {
					return COMPACTION_CHECK_NONE;
				}
			}
		}
		const action = resolveCompactionEngineAction(compactionSettings.strategy);

		this.#autoCompactionAbortController?.abort();
		const autoCompactionAbortController = new AbortController();
		this.#autoCompactionAbortController = autoCompactionAbortController;
		const autoCompactionSignal = autoCompactionAbortController.signal;

		let preparation: CompactionPreparation | undefined;

		try {
			await this.#emitSessionEvent({ type: "auto_compaction_start", reason, action });

			if (!this.model) {
				await this.#emitSessionEvent({
					type: "auto_compaction_end",
					action,
					result: undefined,
					aborted: false,
					willRetry: false,
					skipped: true,
				});
				return COMPACTION_CHECK_NONE;
			}

			const availableModels = this.#modelRegistry.getAvailable();
			if (availableModels.length === 0) {
				await this.#emitSessionEvent({
					type: "auto_compaction_end",
					action,
					result: undefined,
					aborted: false,
					willRetry: false,
					skipped: true,
				});
				return COMPACTION_CHECK_NONE;
			}

			const pathEntries = this.sessionManager.getBranch();

			preparation = prepareCompaction(pathEntries, toAgentCompactionSettings(compactionSettings), {
				nonMessageTokens: computeNonMessageTokens(this),
				contextWindow: declaredContextWindow(this.model),
			});
			if (!preparation) {
				await this.#emitSessionEvent({
					type: "auto_compaction_end",
					action,
					result: undefined,
					aborted: false,
					willRetry: false,
					skipped: true,
				});
				const noProgressDeadEnd = reason !== "idle";
				let continuationScheduled = false;
				if (!suppressContinuation && this.agent.hasQueuedMessages()) {
					this.#scheduleAgentContinue({
						delayMs: 100,
						generation,
						shouldContinue: () => this.agent.hasQueuedMessages(),
					});
					continuationScheduled = true;
				}
				if (noProgressDeadEnd) {
					this.emitNotice(
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

			if (this.#extensionRunner?.hasHandlers("session_before_compact")) {
				const hookResult = (await this.#extensionRunner.emit({
					type: "session_before_compact",
					preparation,
					branchEntries: pathEntries,
					customInstructions: undefined,
					signal: autoCompactionSignal,
				})) as SessionBeforeCompactResult | undefined;

				if (hookResult?.cancel) {
					this.#rollbackCompactionTailElisions(preparation);
					await this.#emitSessionEvent({
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

			if (compactionPrep.kind === "fromHook") {
				summary = compactionPrep.summary;
				shortSummary = compactionPrep.shortSummary;
				firstKeptEntryId = compactionPrep.firstKeptEntryId;
				tokensBefore = compactionPrep.tokensBefore;
				details = compactionPrep.details;
				preserveData = compactionPrep.preserveData;
			} else {
				const candidates = this.#getCompactionModelCandidates(availableModels);

				const configuredEffortByModel = this.#resolveConfiguredCompactionEfforts(availableModels);
				const retrySettings = this.settings.getGroup("retry");
				const telemetry = resolveTelemetry(this.agent.telemetry, this.sessionId);
				let compactResult: CompactionResult | undefined;
				let lastError: unknown;
				codexCompaction = createCodexCompactionContext({
					trigger: "auto",
					reason: "context_limit",
					phase:
						options.phase ??
						(reason === "threshold" ? "pre_turn" : reason === "idle" ? "standalone_turn" : "mid_turn"),
				});

				compactResult = await this.#tryServerSideCompaction(preparation, undefined, autoCompactionSignal, {
					promptOverride: this.#obfuscateTextForProvider(compactionPrep.hookPrompt),
					extraContext: compactionPrep.hookContext,
					remoteInstructions: this.#baseSystemPrompt.join("\n\n"),
					initiatorOverride: "agent",
					codexCompaction,
				});

				const configuredCompactionWindow = this.settings.get("compaction.modelContextWindow");

				const skipReasons = new Map<string, string>();

				for (let candidateIndex = 0; !compactResult && candidateIndex < candidates.length; candidateIndex++) {
					const candidate = candidates[candidateIndex];
					const hasMoreCandidates = candidateIndex < candidates.length - 1;
					const apiKey = await this.#modelRegistry.getApiKey(candidate, this.sessionId);
					if (!apiKey) {
						skipReasons.set(this.#getModelKey(candidate), "it is not authenticated");
						continue;
					}
					const cachePrefix = await this.#cacheAlignedCompactionPrefix(candidate, autoCompactionSignal);
					const candidateOptions: SummaryOptions = {
						promptOverride: this.#obfuscateTextForProvider(compactionPrep.hookPrompt),
						extraContext: compactionPrep.hookContext,
						remoteInstructions: this.#baseSystemPrompt.join("\n\n"),
						metadata: this.agent.metadataForProvider(candidate.provider),
						initiatorOverride: "agent",
						convertToLlm: messages => this.#convertToLlmForSideRequest(messages),
						telemetry,

						thinkingLevel: configuredEffortByModel.get(this.#getModelKey(candidate)) ?? this.thinkingLevel,
						sessionSystemPrompt: cachePrefix?.sessionSystemPrompt,
						sessionMessages: cachePrefix?.sessionMessages,
						tools: cachePrefix?.tools ?? this.agent.state.tools,
						sessionId: this.sessionId,

						promptCacheKey: this.agent.promptCacheKey ?? this.sessionId,
						providerSessionState: this.#providerSessionState,
						obfuscateProviderText: text => this.obfuscateProviderText(text),
						codexCompaction,
						completeImpl: this.#sideCompleteImpl,
						serviceTier: this.#effectiveServiceTier(candidate),
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
							this.#getModelKey(candidate),
							`its context window holds ${candidateWindow} tokens and the summary needed ${summarizePayloadTokens}`,
						);
						lastError ??= new Error(
							`Compaction failed: ${candidate.provider}/${candidate.id} holds ${candidateWindow} tokens and the summary needed ${summarizePayloadTokens}.`,
						);
						continue;
					}

					let attempt = 0;
					while (true) {
						try {
							compactResult = await compact(
								this.#obfuscatePreparationForProvider(preparation),
								candidate,
								this.#modelRegistry.resolver(candidate, this.sessionId),
								undefined,
								autoCompactionSignal,
								candidateOptions,
							);
							break;
						} catch (error) {
							if (autoCompactionSignal.aborted) {
								throw error;
							}

							const message = errorMessage(error);
							skipReasons.set(this.#getModelKey(candidate), `it failed: ${message}`);
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
								lastError = this.#compactionCandidateError(candidate, error);
								break;
							}

							const retryAfterMs = this.#parseRetryAfterMsFromError(message);
							const shouldRetry =
								retrySettings.enabled &&
								attempt < retrySettings.maxRetries &&
								(retryAfterMs !== undefined ||
									AIError.is(id, AIError.Flag.Transient) ||
									AIError.is(id, AIError.Flag.UsageLimit));
							if (!shouldRetry) {
								lastError = this.#compactionCandidateError(candidate, error);
								break;
							}

							const baseDelayMs = retrySettings.baseDelayMs * 2 ** attempt;
							const delayMs = retryAfterMs !== undefined ? Math.max(baseDelayMs, retryAfterMs) : baseDelayMs;

							const maxAcceptableDelayMs = 30_000;
							if (delayMs > maxAcceptableDelayMs && hasMoreCandidates) {
								logger.warn("Auto-compaction retry delay too long, trying next model", {
									delayMs,
									retryAfterMs,
									error: message,
									model: `${candidate.provider}/${candidate.id}`,
								});
								lastError = this.#compactionCandidateError(candidate, error);
								break;
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
						this.#announceCompactionFallback(candidates, candidate, skipReasons);
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
				this.#rollbackCompactionTailElisions(preparation);
				await this.#emitSessionEvent({
					type: "auto_compaction_end",
					action,
					result: undefined,
					aborted: true,
					willRetry: false,
				});
				return COMPACTION_CHECK_NONE;
			}

			assertValidCompactionResult(preparation, {
				summary,
				shortSummary,
				firstKeptEntryId,
				tokensBefore,
				details,
				preserveData,
			});
			this.sessionManager.appendCompaction(
				summary,
				shortSummary,
				firstKeptEntryId,
				tokensBefore,
				details,
				fromExtension,
				preserveData,
			);
			await this.#persistCompactionTailElisions(preparation);
			const newEntries = this.sessionManager.getEntries();
			const sessionContext = this.buildDisplaySessionContext();
			this.agent.replaceMessages(sessionContext.messages);
			this.#rebasePendingContextSnapshotAfterHistoryRewrite();

			this.#planReferenceSent = false;
			this.#resetAllAdvisorRuntimes();
			this.#syncTodoPhasesFromBranch();
			if (codexCompaction) {
				this.#resetCodexProviderAfterCompaction(codexCompaction);
			} else {
				this.#closeCodexProviderSessionsForHistoryRewrite();
			}

			const savedCompactionEntry = newEntries.find(e => e.type === "compaction" && e.summary === summary) as
				| CompactionEntry
				| undefined;

			if (this.#extensionRunner && savedCompactionEntry) {
				await this.#extensionRunner.emit({
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

			let continuationScheduled = false;

			let noProgressDeadEnd = false;
			let retryFits = false;
			let hasHeadroom = false;

			if (willRetry) {
				const messages = this.agent.state.messages;
				const lastMsg = messages[messages.length - 1];
				if (lastMsg?.role === "assistant") {
					const lastAssistant = lastMsg as AssistantMessage;

					const shouldDrop =
						lastAssistant.stopReason === "error" ||
						(reason === "incomplete" && lastAssistant.stopReason === "length");
					if (shouldDrop) {
						this.agent.replaceMessages(messages.slice(0, -1));
						this.#rebasePendingContextSnapshotAfterHistoryRewrite();
					}
				}

				retryFits = this.#compactionCreatedRetryFit();
				if (!retryFits) {
					retryFits = await this.#rescueCompactionDeadEnd(autoCompactionSignal, {
						skipElide: false,
						hasProgress: () => this.#compactionCreatedRetryFit(),
					});
				}
				if (!retryFits) {
					noProgressDeadEnd = true;
				}
			} else if (reason !== "idle") {
				hasHeadroom = this.#compactionCreatedHeadroom();
				if (!hasHeadroom) {
					hasHeadroom = await this.#rescueCompactionDeadEnd(autoCompactionSignal, {
						skipElide: false,
						hasProgress: () => this.#compactionCreatedHeadroom(),
					});
				}
				if (!hasHeadroom) {
					noProgressDeadEnd = true;
				}
			}

			const deadEndWarning = noProgressDeadEnd ? compactionDeadEndWarning("clear large tool output") : undefined;
			if (deadEndWarning && savedCompactionEntry) {
				savedCompactionEntry.warning = deadEndWarning;
				await this.sessionManager.rewriteEntries();
			}

			await this.#emitSessionEvent({ type: "auto_compaction_end", action, result, aborted: false, willRetry });

			if (retryFits) {
				this.#scheduleAgentContinue({ delayMs: 100, generation });
				continuationScheduled = true;
			} else if (hasHeadroom && shouldAutoContinue) {
				this.#scheduleAutoContinuePrompt(generation);
				continuationScheduled = true;
			}
			if (!continuationScheduled && !suppressContinuation && this.agent.hasQueuedMessages()) {
				this.#scheduleAgentContinue({
					delayMs: 100,
					generation,
					shouldContinue: () => this.agent.hasQueuedMessages(),
				});
				continuationScheduled = true;
			}

			if (deadEndWarning) {
				this.emitNotice("warning", deadEndWarning, "compaction");
			}
			if (continuationScheduled) return COMPACTION_CHECK_CONTINUATION;
			return noProgressDeadEnd ? COMPACTION_CHECK_BLOCK_AUTOMATIC_CONTINUATION : COMPACTION_CHECK_NONE;
		} catch (error) {
			this.#rollbackCompactionTailElisions(preparation);
			if (autoCompactionSignal.aborted) {
				await this.#emitSessionEvent({
					type: "auto_compaction_end",
					action,
					result: undefined,
					aborted: true,
					willRetry: false,
				});
				return COMPACTION_CHECK_NONE;
			}

			const failure = errorMessage(error);
			await this.#emitSessionEvent({
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
			return await this.#afterFailedCompaction(reason, willRetry, autoCompactionSignal, generation, {
				suppressContinuation,
				shouldAutoContinue,
			});
		} finally {
			if (this.#autoCompactionAbortController === autoCompactionAbortController) {
				this.#autoCompactionAbortController = undefined;
			}
		}
	}

	async #afterFailedCompaction(
		reason: "overflow" | "threshold" | "idle" | "incomplete",
		willRetry: boolean,
		signal: AbortSignal,
		generation: number,
		options: { suppressContinuation: boolean; shouldAutoContinue: boolean },
	): Promise<CompactionCheckResult> {
		if (reason === "idle" || signal.aborted) return COMPACTION_CHECK_NONE;

		const hasProgress = willRetry ? () => this.#compactionCreatedRetryFit() : () => this.#compactionCreatedHeadroom();
		const rescued = hasProgress() || (await this.#rescueCompactionDeadEnd(signal, { skipElide: false, hasProgress }));
		if (rescued) {
			let continuationScheduled = false;
			if (willRetry) {
				this.#scheduleAgentContinue({ delayMs: 100, generation });
				continuationScheduled = true;
			} else if (options.shouldAutoContinue) {
				this.#scheduleAutoContinuePrompt(generation);
				continuationScheduled = true;
			}
			if (!continuationScheduled && !options.suppressContinuation && this.agent.hasQueuedMessages()) {
				this.#scheduleAgentContinue({
					delayMs: 100,
					generation,
					shouldContinue: () => this.agent.hasQueuedMessages(),
				});
				continuationScheduled = true;
			}
			return {
				continuationScheduled,
				historyRewritten: true,
			};
		}
		let continuationScheduled = false;
		if (!options.suppressContinuation && this.agent.hasQueuedMessages()) {
			this.#scheduleAgentContinue({
				delayMs: 100,
				generation,
				shouldContinue: () => this.agent.hasQueuedMessages(),
			});
			continuationScheduled = true;
		}
		this.emitNotice("warning", compactionDeadEndWarning("clear large tool output"), "compaction");
		return continuationScheduled ? COMPACTION_CHECK_CONTINUATION : COMPACTION_CHECK_BLOCK_AUTOMATIC_CONTINUATION;
	}

	setAutoCompactionEnabled(enabled: boolean): void {
		this.settings.set("compaction.enabled", enabled);
		if (enabled && isCompactionStrategyOff(this.settings.get("compaction.strategy") as string)) {
			this.settings.override("compaction.strategy", getDefault("compaction.strategy"));
		}
	}

	get autoCompactionEnabled(): boolean {
		const compaction = this.settings.getGroup("compaction");
		return !isThresholdCompactionDisabled(compaction.enabled, compaction.strategy);
	}

	#classifyRetryMessage(message: AssistantMessage): number {
		const activeModel = this.model;
		const trace: string[] = [];
		const sameApi = !activeModel || message.api === activeModel.api;
		const id = sameApi
			? AIError.classifyMessage(message, trace)
			: AIError.classifyMessage(
					{
						api: activeModel.api,
						errorId: message.errorId,
						errorMessage: message.errorMessage,
						errorStatus: message.errorStatus,
					},
					trace,
				);

		logger.debug("retry classification", { errorId: id, kind: AIError.stringify(id), rules: [...new Set(trace)] });
		message.errorId = id;
		return id;
	}

	#isGenericAbortSentinel(message: AssistantMessage): boolean {
		return message.errorMessage === "Request was aborted" || message.errorMessage === "Request was aborted.";
	}

	#isRetryableReasonlessAbort(message: AssistantMessage): boolean {
		if (
			(message.stopReason !== "aborted" && message.stopReason !== "error") ||
			message.content.length !== 0 ||
			this.#abortInProgress ||
			this.#isDisposed ||
			this.#streamingEditAbortTriggered
		) {
			return false;
		}

		const id = this.#classifyRetryMessage(message);
		if (message.stopReason === "aborted" && AIError.is(id, AIError.Flag.Abort)) return true;
		if (!this.#isGenericAbortSentinel(message)) return false;

		message.errorId = AIError.create(AIError.Flag.Abort);
		return true;
	}

	#isRetryableError(message: AssistantMessage): boolean {
		if (message.stopReason !== "error") return false;

		const id = this.#classifyRetryMessage(message);

		const contextWindow = this.model?.contextWindow ?? 0;
		if (AIError.isContextOverflow(message, contextWindow)) return false;

		if (this.#isClassifierRefusal(message)) return true;
		return AIError.retriable(id, { replayUnsafe: this.#hasReplayUnsafeToolOutput(message) });
	}

	#hasReplayUnsafeToolOutput(message: AssistantMessage): boolean {
		const toolCallIds = new Set<string>();
		for (const block of message.content) {
			if (block.type !== "toolCall") continue;
			if ((block as CursorExecResolvedCarrier)[kCursorExecResolved] === true) return true;
			toolCallIds.add(block.id);
		}
		if (toolCallIds.size === 0) return false;
		for (const contextMessage of this.agent.state.messages) {
			if (contextMessage.role !== "toolResult") continue;
			if (!toolCallIds.has(contextMessage.toolCallId)) continue;
			if (!toolResultNeverRan(contextMessage.details)) return true;
		}
		return false;
	}

	async #continueAfterUnreplayableBatch(message: AssistantMessage): Promise<boolean> {
		if (message.stopReason !== "error") return false;
		if (this.#abortInProgress || this.#isDisposed || this.#streamingEditAbortTriggered) return false;
		const retrySettings = this.settings.getGroup("retry");
		if (!retrySettings.enabled) return false;
		const id = this.#classifyRetryMessage(message);

		if (!AIError.retriable(id, { replayUnsafe: false })) return false;
		if (AIError.retriable(id, { replayUnsafe: true })) return false;
		if (!this.#hasReplayUnsafeToolOutput(message)) return false;
		if (!this.#hasNeverRanToolResult(message)) return false;
		const policy = this.#resolveRetryPolicy(retrySettings);
		if (this.#unreplayableBatchContinues >= policy.maxRetries) return false;
		this.#unreplayableBatchContinues += 1;
		this.#operatorNotices.warn(
			"unreplayable-batch",
			"The provider stream failed partway through a tool batch that cannot be replayed. Continuing with the calls that never ran.",
		);

		const delayMs = unreplayableContinueDelayMs(policy, this.#unreplayableBatchContinues);

		this.#ensureRetryPromise();
		await this.#emitSessionEvent({
			type: "auto_retry_start",
			attempt: this.#unreplayableBatchContinues,
			mode: "continue",
			maxAttempts: policy.maxRetries,
			policySource: describeRetryPolicySource(policy),
			delayMs,
			errorMessage: message.errorMessage || "Unknown error",
			errorId: message.errorId,
		});
		const continueAbortController = new AbortController();
		this.#retryAbortController?.abort();
		this.#retryAbortController = continueAbortController;
		try {
			await scheduler.wait(delayMs, { signal: continueAbortController.signal });
		} catch {
			if (this.#retryAbortController !== continueAbortController) return false;
			this.#retryAbortController = undefined;
			await this.#emitSessionEvent({
				type: "auto_retry_end",
				success: false,
				attempt: this.#unreplayableBatchContinues,
				mode: "continue",
				finalError: "Continuation cancelled",
			});
			this.#resolveRetry();
			return false;
		}
		if (this.#retryAbortController === continueAbortController) {
			this.#retryAbortController = undefined;
		}

		this.#scheduleAgentContinue({
			generation: this.#promptGeneration,
			onSkip: () => this.#resolveRetry(),
		});
		return true;
	}

	#hasNeverRanToolResult(message: AssistantMessage): boolean {
		if ((message.incompleteToolCalls?.length ?? 0) > 0) return true;
		const toolCallIds = new Set<string>();
		for (const block of message.content) {
			if (block.type === "toolCall") toolCallIds.add(block.id);
		}
		if (toolCallIds.size === 0) return false;
		const answered = new Set<string>();
		const unanswered = new Set<string>();
		for (const contextMessage of this.agent.state.messages) {
			if (contextMessage.role !== "toolResult") continue;
			const id = contextMessage.toolCallId;
			if (!toolCallIds.has(id)) continue;
			if (toolResultNeverRan(contextMessage.details)) unanswered.add(id);
			else answered.add(id);
		}
		for (const id of unanswered) {
			if (!answered.has(id)) return true;
		}
		return false;
	}

	#isClassifierRefusal(message: AssistantMessage): boolean {
		if (message.stopReason !== "error") return false;
		const stopType = message.stopDetails?.type;
		return stopType === "refusal" || stopType === "sensitive";
	}

	#getRetryFallbackChains(): RetryFallbackChains {
		const configuredChains = this.settings.get("retry.fallbackChains");
		if (!configuredChains || typeof configuredChains !== "object") return {};
		const chains: RetryFallbackChains = { ...(configuredChains as RetryFallbackChains) };
		const defaultChain = chains.default;
		if (Array.isArray(defaultChain)) {
			for (const role of Object.keys(this.settings.getModelRoles())) {
				if (role !== "default" && chains[role] === undefined) {
					chains[role] = defaultChain;
				}
			}
		}
		return chains;
	}

	#validateApprovalModeSetting(): void {
		if (!this.settings.isConfigured("tools.approvalMode")) return;
		const warning = validateApprovalModeSetting(this.settings.get("tools.approvalMode"));
		if (warning) {
			logger.warn(warning);
			this.configWarnings.push(warning);
		}
	}

	#validateApprovalPolicySettings(): void {
		if (!this.settings.isConfigured("tools.approval")) return;
		for (const warning of validateApprovalPolicySettings(this.settings.get("tools.approval"))) {
			logger.warn(warning);
			this.configWarnings.push(warning);
		}
	}

	#validateRetryFallbackChains(): void {
		const configuredChains = this.settings.get("retry.fallbackChains");
		if (configuredChains === undefined) return;
		if (!isRecord(configuredChains)) {
			const msg = "retry.fallbackChains must be a mapping of role names or model selectors to selector arrays.";
			logger.warn(msg);
			this.configWarnings.push(msg);
			return;
		}

		for (const key in configuredChains) {
			const chain = (configuredChains as RetryFallbackChains)[key];
			const keyKind = isRetryFallbackModelKey(key) ? "model" : "role";
			if (keyKind === "model") {
				if (isRetryFallbackWildcardKey(key)) {
					const provider = key.slice(0, -2);
					if (!this.#modelRegistry.getAll().some(model => model.provider === provider)) {
						const msg = `retry.fallbackChains wildcard key references unknown provider: ${key}`;
						logger.warn(msg);
						this.configWarnings.push(msg);
					}
				} else {
					const parsedKey = parseRetryFallbackSelector(key, this.#modelRegistry);
					if (!parsedKey) {
						const msg = `Invalid model selector key in retry.fallbackChains: ${key}`;
						logger.warn(msg);
						this.configWarnings.push(msg);
					} else if (!this.#modelRegistry.find(parsedKey.provider, parsedKey.id)) {
						const msg = `retry.fallbackChains key references unknown model: ${key}`;
						logger.warn(msg);
						this.configWarnings.push(msg);
					}
				}
			}
			if (!Array.isArray(chain)) {
				const msg = `Fallback chain for ${keyKind} '${key}' must be an array of selector strings.`;
				logger.warn(msg);
				this.configWarnings.push(msg);
				continue;
			}
			for (const selectorStr of chain) {
				if (typeof selectorStr !== "string") {
					const msg = `Fallback chain for ${keyKind} '${key}' contains a non-string selector.`;
					logger.warn(msg);
					this.configWarnings.push(msg);
					continue;
				}
				if (isRetryFallbackWildcardKey(selectorStr)) {
					const provider = selectorStr.slice(0, -2);
					if (!this.#modelRegistry.getAll().some(model => model.provider === provider)) {
						const msg = `Fallback chain for ${keyKind} '${key}' references unknown provider: ${selectorStr}`;
						logger.warn(msg);
						this.configWarnings.push(msg);
					}
					continue;
				}
				const parsed = parseRetryFallbackSelector(selectorStr, this.#modelRegistry);
				if (!parsed) {
					const msg = `Invalid fallback selector format in ${keyKind} '${key}': ${selectorStr}`;
					logger.warn(msg);
					this.configWarnings.push(msg);
					continue;
				}
				const exists = this.#modelRegistry.find(parsed.provider, parsed.id);
				if (!exists) {
					const msg = `Fallback chain for ${keyKind} '${key}' references unknown model: ${selectorStr}`;
					logger.warn(msg);
					this.configWarnings.push(msg);
				}
			}
		}
	}

	#getRetryFallbackRevertPolicy(): RetryFallbackRevertPolicy {
		return this.settings.get("retry.fallbackRevertPolicy") === "never" ? "never" : "cooldown-expiry";
	}

	#getRetryFallbackPrimarySelector(role: string): RetryFallbackSelector | undefined {
		if (isRetryFallbackWildcardKey(role)) return undefined;
		if (isRetryFallbackModelKey(role)) return parseRetryFallbackSelector(role, this.#modelRegistry);
		const configuredSelector = this.settings.getModelRole(role);
		return configuredSelector ? parseRetryFallbackSelector(configuredSelector, this.#modelRegistry) : undefined;
	}

	#clearActiveRetryFallback(): void {
		this.#activeRetryFallback = undefined;
	}

	#isRetryFallbackSelectorSuppressed(selector: RetryFallbackSelector): boolean {
		return this.#modelRegistry.isSelectorSuppressed(selector.raw);
	}

	#noteRetryFallbackCooldown(currentSelector: string, retryAfterMs: number | undefined, errorMessage: string): void {
		let cooldownMs = retryAfterMs;
		if (!cooldownMs || cooldownMs <= 0) {
			const reason = parseRateLimitReason(errorMessage);
			cooldownMs = reason === "UNKNOWN" ? 5 * 60 * 1000 : calculateRateLimitBackoffMs(reason);
		}
		this.#modelRegistry.suppressSelector(currentSelector, Date.now() + cooldownMs);
	}

	#resolveRetryFallbackRole(currentSelector: string): string | undefined {
		const parsedCurrent = parseRetryFallbackSelector(currentSelector, this.#modelRegistry);
		if (!parsedCurrent) return undefined;
		const chains = this.#getRetryFallbackChains();
		const currentBaseSelector = formatRetryFallbackBaseSelector(parsedCurrent);
		const currentPlainSelector = this.model
			? formatModelSelectorValue(formatModelString(this.model), parsedCurrent.thinkingLevel)
			: undefined;
		const currentPlainBaseSelector =
			currentPlainSelector && currentPlainSelector !== currentSelector
				? formatRetryFallbackBaseSelector(parseRetryFallbackSelector(currentPlainSelector) ?? parsedCurrent)
				: undefined;

		const exactModelKeys: string[] = [];
		const roleKeys: string[] = [];
		for (const key in chains) {
			if (!isRetryFallbackModelKey(key)) roleKeys.push(key);
			else if (!isRetryFallbackWildcardKey(key)) exactModelKeys.push(key);
		}
		const matchesCurrent = (primary: RetryFallbackSelector | undefined): boolean => {
			if (!primary) return false;
			if (primary.raw === currentSelector || (currentPlainSelector && primary.raw === currentPlainSelector)) {
				return true;
			}
			const base = formatRetryFallbackBaseSelector(primary);
			return base === currentBaseSelector || (!!currentPlainBaseSelector && base === currentPlainBaseSelector);
		};

		for (const key of exactModelKeys) {
			if (matchesCurrent(this.#getRetryFallbackPrimarySelector(key))) return key;
		}

		const wildcardKey = `${parsedCurrent.provider}/*`;
		if (Array.isArray(chains[wildcardKey])) return wildcardKey;

		for (const key of roleKeys) {
			if (matchesCurrent(this.#getRetryFallbackPrimarySelector(key))) return key;
		}

		const defaultChain = chains.default;
		if (
			Array.isArray(defaultChain) &&
			defaultChain.length > 0 &&
			this.#getRetryFallbackPrimarySelector("default") === undefined
		) {
			return "default";
		}
		return undefined;
	}

	#parseRetryFallbackChainEntry(
		entry: string,
		current: RetryFallbackSelector | undefined,
	): RetryFallbackSelector | undefined {
		if (isRetryFallbackWildcardKey(entry)) {
			if (!current) return undefined;
			const provider = entry.slice(0, -2);
			return { raw: `${provider}/${current.id}`, provider, id: current.id, thinkingLevel: undefined };
		}
		return parseRetryFallbackSelector(entry, this.#modelRegistry);
	}

	#getRetryFallbackEffectiveChain(role: string, currentSelector?: string): RetryFallbackSelector[] {
		const parsedCurrent = currentSelector
			? parseRetryFallbackSelector(currentSelector, this.#modelRegistry)
			: undefined;
		const seen = new Set<string>();
		const chain: RetryFallbackSelector[] = [];
		if (isRetryFallbackWildcardKey(role)) {
			if (parsedCurrent) {
				chain.push(parsedCurrent);
				seen.add(parsedCurrent.raw);
			}
		} else {
			const primarySelector = this.#getRetryFallbackPrimarySelector(role);
			if (!primarySelector) return [];
			chain.push(primarySelector);
			seen.add(primarySelector.raw);
		}
		for (const selector of this.#getRetryFallbackChains()[role] ?? []) {
			const parsed = this.#parseRetryFallbackChainEntry(selector, parsedCurrent);
			if (!parsed || seen.has(parsed.raw)) continue;
			seen.add(parsed.raw);
			chain.push(parsed);
		}
		return chain;
	}

	#findRetryFallbackCandidates(role: string, currentSelector: string): RetryFallbackSelector[] {
		let chain = this.#getRetryFallbackEffectiveChain(role, currentSelector);
		const parsedCurrent = parseRetryFallbackSelector(currentSelector, this.#modelRegistry);
		if (chain.length === 0 && role === "default" && parsedCurrent) {
			const chains = this.#getRetryFallbackChains();
			const defaultChain = chains.default;
			if (
				Array.isArray(defaultChain) &&
				defaultChain.length > 0 &&
				this.#getRetryFallbackPrimarySelector("default") === undefined
			) {
				const seen = new Set<string>([parsedCurrent.raw]);
				chain = [parsedCurrent];
				for (const selector of defaultChain) {
					const parsed = this.#parseRetryFallbackChainEntry(selector, parsedCurrent);
					if (!parsed || seen.has(parsed.raw)) continue;
					seen.add(parsed.raw);
					chain.push(parsed);
				}
			}
		}
		if (chain.length <= 1) return [];
		const currentBaseSelector = parsedCurrent ? formatRetryFallbackBaseSelector(parsedCurrent) : undefined;
		const currentPlainSelector =
			this.model && parsedCurrent
				? formatModelSelectorValue(formatModelString(this.model), parsedCurrent.thinkingLevel)
				: undefined;
		const currentPlainBaseSelector =
			parsedCurrent && currentPlainSelector && currentPlainSelector !== currentSelector
				? formatRetryFallbackBaseSelector(parseRetryFallbackSelector(currentPlainSelector) ?? parsedCurrent)
				: undefined;
		const exactIndex = chain.findIndex(
			selector => selector.raw === currentSelector || selector.raw === currentPlainSelector,
		);
		if (exactIndex >= 0) return chain.slice(exactIndex + 1);
		const baseIndex = currentBaseSelector
			? chain.findIndex(selector => {
					const selectorBase = formatRetryFallbackBaseSelector(selector);
					return selectorBase === currentBaseSelector || selectorBase === currentPlainBaseSelector;
				})
			: -1;
		if (baseIndex >= 0) return chain.slice(baseIndex + 1);
		return chain.slice(1);
	}

	async #applyRetryFallbackCandidate(
		role: string,
		selector: RetryFallbackSelector,
		currentSelector: string,
		options?: { pinFallback?: boolean },
	): Promise<void> {
		const resolved = resolveModelOverride([selector.raw], this.#modelRegistry, this.settings);
		const candidate = resolved.model ?? this.#modelRegistry.find(selector.provider, selector.id);
		if (!candidate) {
			throw new Error(`Retry fallback model not found: ${selector.raw}`);
		}
		const apiKey = await this.#modelRegistry.getApiKey(candidate, this.sessionId);
		if (!apiKey) {
			throw new Error(missingCredentialsMessage(candidate.provider, candidate.id, `retry fallback ${selector.raw}`));
		}

		const currentThinkingLevel = this.configuredThinkingLevel();
		const nextThinkingLevel = selector.thinkingLevel ?? currentThinkingLevel;
		const candidateSelector = formatModelStringWithRouting(candidate);
		this.#setModelWithProviderSessionReset(candidate);
		this.sessionManager.appendModelChange(candidateSelector, EPHEMERAL_MODEL_CHANGE_ROLE);
		this.settings.getStorage()?.recordModelUsage(candidateSelector);
		this.setThinkingLevel(nextThinkingLevel, false, "resolved");
		if (!this.#activeRetryFallback) {
			this.#activeRetryFallback = {
				role,
				originalSelector: currentSelector,
				originalThinkingLevel: currentThinkingLevel,
				lastAppliedFallbackThinkingLevel: nextThinkingLevel,
				pinned: options?.pinFallback === true,
			};
		} else {
			this.#activeRetryFallback.lastAppliedFallbackThinkingLevel = nextThinkingLevel;
			this.#activeRetryFallback.pinned = this.#activeRetryFallback.pinned || options?.pinFallback === true;
		}
		await this.#emitSessionEvent({
			type: "retry_fallback_applied",
			from: currentSelector,
			to: selector.raw,
			role,
		});
	}

	async #tryRetryModelFallback(currentSelector: string, options?: { pinFallback?: boolean }): Promise<boolean> {
		const role = this.#activeRetryFallback?.role ?? this.#resolveRetryFallbackRole(currentSelector);
		if (!role) return false;

		for (const selector of this.#findRetryFallbackCandidates(role, currentSelector)) {
			if (this.#isRetryFallbackSelectorSuppressed(selector)) continue;
			const resolved = resolveModelOverride([selector.raw], this.#modelRegistry, this.settings);
			const candidate = resolved.model ?? this.#modelRegistry.find(selector.provider, selector.id);
			if (!candidate) continue;
			const apiKey = await this.#modelRegistry.getApiKey(candidate, this.sessionId);
			if (!apiKey) continue;
			await this.#applyRetryFallbackCandidate(role, selector, currentSelector, options);
			return true;
		}

		return false;
	}

	#activeFireworksFastModel(): Model | undefined {
		const model = this.model;
		return model?.provider === "fireworks" && isFireworksFastModelId(model.id) ? model : undefined;
	}

	#isFireworksFastFallbackEligible(message: AssistantMessage): boolean {
		const model = this.#activeFireworksFastModel();
		if (!model) return false;
		if (message.stopReason !== "error") return false;
		if (message.content.some(block => block.type === "toolCall")) return false;

		if (this.#isClassifierRefusal(message)) return false;
		const id = this.#classifyRetryMessage(message);
		if (AIError.isContextOverflow(message, model.contextWindow ?? 0)) return false;
		if (AIError.is(id, AIError.Flag.UsageLimit)) return false;
		if (AIError.is(id, AIError.Flag.AuthFailed)) return false;
		return this.#modelRegistry.find("fireworks", toFireworksBaseModelId(model.id)) !== undefined;
	}

	#isHardErrorFallbackEligible(message: AssistantMessage): boolean {
		if (message.stopReason !== "error") return false;
		const model = this.model;
		if (!model) return false;
		const retrySettings = this.settings.getGroup("retry");
		if (!retrySettings.enabled || !retrySettings.modelFallback) return false;
		if (this.#isClassifierRefusal(message)) return false;
		const id = this.#classifyRetryMessage(message);
		if (AIError.is(id, AIError.Flag.Abort) || AIError.is(id, AIError.Flag.UserInterrupt)) return false;
		if (AIError.isContextOverflow(message, model.contextWindow ?? 0)) return false;
		if (this.#hasReplayUnsafeToolOutput(message)) return false;
		const currentSelector = formatRetryFallbackSelector(model, this.thinkingLevel);
		const role = this.#activeRetryFallback?.role ?? this.#resolveRetryFallbackRole(currentSelector);
		if (!role) return false;
		return this.#findRetryFallbackCandidates(role, currentSelector).length > 0;
	}

	async #tryFireworksFastFallback(currentSelector: string): Promise<boolean> {
		const model = this.#activeFireworksFastModel();
		if (!model) return false;
		const baseModel = this.#modelRegistry.find("fireworks", toFireworksBaseModelId(model.id));
		if (!baseModel) return false;
		const apiKey = await this.#modelRegistry.getApiKey(baseModel, this.sessionId);
		if (!apiKey) return false;
		const baseSelector = formatModelStringWithRouting(baseModel);
		this.#setModelWithProviderSessionReset(baseModel);
		this.sessionManager.appendModelChange(baseSelector, EPHEMERAL_MODEL_CHANGE_ROLE);
		this.settings.getStorage()?.recordModelUsage(baseSelector);
		await this.#emitSessionEvent({
			type: "retry_fallback_applied",
			from: currentSelector,
			to: baseSelector,
			role: "fireworks-fast",
		});
		return true;
	}

	async #maybeRestoreRetryFallbackPrimary(): Promise<void> {
		if (!this.#activeRetryFallback) return;
		if (this.#retryAttempt > 0) return;

		if (this.#activeRetryFallback.pinned) return;
		if (this.#getRetryFallbackRevertPolicy() !== "cooldown-expiry") return;

		const {
			originalSelector: originalSelectorRaw,
			originalThinkingLevel,
			lastAppliedFallbackThinkingLevel,
		} = this.#activeRetryFallback;
		const originalSelector = parseRetryFallbackSelector(originalSelectorRaw, this.#modelRegistry);
		if (!originalSelector) {
			this.#clearActiveRetryFallback();
			return;
		}

		const currentModel = this.model;
		if (!currentModel) return;
		const currentSelector = formatRetryFallbackSelector(currentModel, this.thinkingLevel);
		if (currentSelector === originalSelector.raw) {
			if (!this.#isRetryFallbackSelectorSuppressed(originalSelector)) {
				this.#clearActiveRetryFallback();
			}
			return;
		}
		if (this.#isRetryFallbackSelectorSuppressed(originalSelector)) return;

		const resolvedPrimary = resolveModelOverride([originalSelector.raw], this.#modelRegistry, this.settings);
		const primaryModel =
			resolvedPrimary.model ?? this.#modelRegistry.find(originalSelector.provider, originalSelector.id);
		if (!primaryModel) return;
		const apiKey = await this.#modelRegistry.getApiKey(primaryModel, this.sessionId);
		if (!apiKey) return;

		const currentThinkingLevel = this.configuredThinkingLevel();
		const thinkingToApply =
			currentThinkingLevel === lastAppliedFallbackThinkingLevel ? originalThinkingLevel : currentThinkingLevel;
		const primarySelector = formatModelStringWithRouting(primaryModel);
		this.#setModelWithProviderSessionReset(primaryModel);
		this.sessionManager.appendModelChange(primarySelector, EPHEMERAL_MODEL_CHANGE_ROLE);
		this.settings.getStorage()?.recordModelUsage(primarySelector);
		this.setThinkingLevel(thinkingToApply, false, "resolved");
		this.#clearActiveRetryFallback();
	}

	#parseRetryAfterMsFromError(errorMessage: string): number | undefined {
		const now = Date.now();
		const retryAfterMsMatch = /retry-after-ms\s*[:=]\s*(\d+)/i.exec(errorMessage);
		if (retryAfterMsMatch) {
			return Math.max(0, Number(retryAfterMsMatch[1]));
		}

		const retryAfterMatch = /retry-after\s*[:=]\s*([^\s,;]+)/i.exec(errorMessage);
		if (retryAfterMatch) {
			const value = retryAfterMatch[1];
			const seconds = Number(value);
			if (!Number.isNaN(seconds)) {
				return Math.max(0, seconds * 1000);
			}
			const dateMs = Date.parse(value);
			if (!Number.isNaN(dateMs)) {
				return Math.max(0, dateMs - now);
			}
		}

		const retryHintMs = extractRetryHint(undefined, errorMessage);
		if (retryHintMs !== undefined) {
			return retryHintMs;
		}

		const resetMsMatch = /x-ratelimit-reset-ms\s*[:=]\s*(\d+)/i.exec(errorMessage);
		if (resetMsMatch) {
			const resetMs = Number(resetMsMatch[1]);
			if (!Number.isNaN(resetMs)) {
				if (resetMs > 1_000_000_000_000) {
					return Math.max(0, resetMs - now);
				}
				return Math.max(0, resetMs);
			}
		}

		const resetMatch = /x-ratelimit-reset\s*[:=]\s*(\d+)/i.exec(errorMessage);
		if (resetMatch) {
			const resetSeconds = Number(resetMatch[1]);
			if (!Number.isNaN(resetSeconds)) {
				if (resetSeconds > 1_000_000_000) {
					return Math.max(0, resetSeconds * 1000 - now);
				}
				return Math.max(0, resetSeconds * 1000);
			}
		}

		return undefined;
	}

	#resolveRetryPolicy(retrySettings: {
		maxRetries: number;
		baseDelayMs: number;
		maxDelayMs: number;
	}): ResolvedRetryPolicy {
		const global = {
			maxRetries: retrySettings.maxRetries,
			baseDelayMs: retrySettings.baseDelayMs,
			maxDelayMs: retrySettings.maxDelayMs,
		};
		const model = this.model;
		if (!model) return { ...global, source: "global" };
		return resolveRetryPolicy(global, this.settings.get("retry.perProvider"), model);
	}

	async #handleRetryableError(
		message: AssistantMessage,
		options?: { allowModelFallback?: boolean; fireworksFastFallback?: boolean; hardErrorFallback?: boolean },
	): Promise<boolean> {
		const retrySettings = this.settings.getGroup("retry");

		const retryPolicy = this.#resolveRetryPolicy(retrySettings);

		if (!retrySettings.enabled && !options?.fireworksFastFallback) return false;
		const classifierRefusal = this.#isClassifierRefusal(message);

		const generation = this.#promptGeneration;
		this.#retryAttempt++;

		this.#ensureRetryPromise();

		const retryBudgetExhausted = this.#retryAttempt > retryPolicy.maxRetries;

		const errorMessage = message.errorMessage || "Unknown error";
		const id = this.#classifyRetryMessage(message);
		const staleOpenAIResponsesReplayError = AIError.is(id, AIError.Flag.StaleResponsesItem);
		const parsedRetryAfterMs = this.#parseRetryAfterMsFromError(errorMessage);
		let delayMs = staleOpenAIResponsesReplayError
			? 0
			: calculateRetryBackoffDelayMs(retryPolicy.baseDelayMs, this.#retryAttempt);
		let switchedCredential = false;
		let switchedModel = false;

		let usageLimitWaitMs: number | undefined;

		if (staleOpenAIResponsesReplayError) {
			this.#resetCurrentResponsesProviderSession("stale replay error");
		}

		if (
			!retryBudgetExhausted &&
			this.model &&
			!staleOpenAIResponsesReplayError &&
			AIError.is(id, AIError.Flag.UsageLimit)
		) {
			const retryAfterMs = parsedRetryAfterMs ?? calculateRateLimitBackoffMs(parseRateLimitReason(errorMessage));
			const outcome = await this.#modelRegistry.authStorage.markUsageLimitReached(
				this.model.provider,
				this.sessionId,
				{
					retryAfterMs,
					baseUrl: this.model.baseUrl,
					modelId: this.model.id,
				},
			);
			if (outcome.switched) {
				switchedCredential = true;
				delayMs = 0;
			} else if (await this.#maybeAutoRedeemCodexReset()) {
				switchedCredential = true;
				delayMs = 0;
			} else {
				usageLimitWaitMs = retryAfterMs;
				if (outcome.retryAtMs !== undefined) {
					const siblingWaitMs = Math.max(0, outcome.retryAtMs - Date.now()) + SIBLING_UNBLOCK_BUFFER_MS;
					if (siblingWaitMs < usageLimitWaitMs) {
						usageLimitWaitMs = siblingWaitMs;
					}
				}
				if (usageLimitWaitMs > delayMs) {
					delayMs = usageLimitWaitMs;
				}
			}
		}

		const allowModelFallback = options?.allowModelFallback !== false;
		const currentSelector = this.model ? formatRetryFallbackSelector(this.model, this.thinkingLevel) : undefined;
		if (!staleOpenAIResponsesReplayError && !switchedCredential && currentSelector) {
			if (allowModelFallback && retrySettings.modelFallback && !(retryBudgetExhausted && classifierRefusal)) {
				if (!classifierRefusal) {
					this.#noteRetryFallbackCooldown(currentSelector, parsedRetryAfterMs, errorMessage);
				}
				switchedModel = await this.#tryRetryModelFallback(currentSelector, { pinFallback: classifierRefusal });
			}

			if (!switchedModel && allowModelFallback && options?.fireworksFastFallback) {
				switchedModel = await this.#tryFireworksFastFallback(currentSelector);
			}
			if (switchedModel) {
				delayMs = 0;
			} else if (usageLimitWaitMs === undefined && parsedRetryAfterMs && parsedRetryAfterMs > delayMs) {
				delayMs = parsedRetryAfterMs;
			}
		}
		if (retryBudgetExhausted) {
			if (!switchedModel) {
				await this.#persistRetryLifecycleErrorMessage(message);

				await this.#emitSessionEvent({
					type: "auto_retry_end",
					success: false,
					attempt: this.#retryAttempt - 1,
					finalError: message.errorMessage,
				});
				this.#clearPendingRecoveredRetryErrors();
				this.#retryAttempt = 0;
				this.#resolveRetry();
				return false;
			}

			this.#retryAttempt = 1;
		}
		if (classifierRefusal && !switchedModel) {
			this.#retryAttempt = 0;
			this.#resolveRetry();
			return false;
		}

		if (
			(options?.fireworksFastFallback || options?.hardErrorFallback) &&
			!switchedModel &&
			!this.#isRetryableError(message)
		) {
			this.#retryAttempt = 0;
			this.#resolveRetry();
			return false;
		}

		const maxDelayMs = retryPolicy.maxDelayMs;
		if (maxDelayMs > 0 && delayMs > maxDelayMs && !switchedCredential && !switchedModel) {
			await this.#persistRetryLifecycleErrorMessage(message);
			const attempt = this.#retryAttempt;
			this.#retryAttempt = 0;
			await this.#emitSessionEvent({
				type: "auto_retry_end",
				success: false,
				attempt,
				finalError: `Provider requested ${delayMs}ms wait, exceeds retry.maxDelayMs (${maxDelayMs}ms). Original error: ${errorMessage}`,
			});
			this.#clearPendingRecoveredRetryErrors();
			this.#resolveRetry();
			return false;
		}

		await this.#recordPendingRecoveredRetryError(message, id, { switchedCredential, switchedModel, delayMs });

		await this.#emitSessionEvent({
			type: "auto_retry_start",
			attempt: this.#retryAttempt,
			maxAttempts: retryPolicy.maxRetries,
			policySource: describeRetryPolicySource(retryPolicy),
			delayMs,
			errorMessage,
			errorId: message.errorId,
		});

		this.#removeAssistantMessageFromActiveContext(message, "auto-retry");

		this.#maybeInjectThinkingLoopRedirect(id);

		const retryAbortController = new AbortController();
		this.#retryAbortController?.abort();
		this.#retryAbortController = retryAbortController;

		if (!this.#retryPromise) {
			retryAbortController.abort();
		}
		try {
			await scheduler.wait(delayMs, { signal: retryAbortController.signal });
		} catch {
			if (this.#retryAbortController !== retryAbortController) {
				return false;
			}

			const attempt = this.#retryAttempt;
			this.#retryAttempt = 0;
			this.#retryAbortController = undefined;
			await this.#emitSessionEvent({
				type: "auto_retry_end",
				success: false,
				attempt,
				finalError: "Retry cancelled",
			});
			this.#clearPendingRecoveredRetryErrors();
			this.#resolveRetry();
			return false;
		}
		if (this.#retryAbortController === retryAbortController) {
			this.#retryAbortController = undefined;
		}

		this.#scheduleAgentContinue({ delayMs: 1, generation });

		return true;
	}

	#maybeInjectThinkingLoopRedirect(id: number): void {
		if (!AIError.is(id, AIError.Flag.ThinkingLoop)) return;
		if (this.settings.get("model.loopGuard.enabled") !== true) return;
		this.agent.appendMessage({
			role: "custom",
			customType: THINKING_LOOP_REDIRECT_TYPE,
			content: turnControlPrompts["turn-control/thinking-loop-redirect"].text,
			display: false,
			attribution: "agent",
			timestamp: Date.now(),
		});
		this.sessionManager.appendCustomMessageEntry(
			THINKING_LOOP_REDIRECT_TYPE,
			turnControlPrompts["turn-control/thinking-loop-redirect"].text,
			false,
			undefined,
			"agent",
		);
	}

	abortRetry(): void {
		this.#retryAbortController?.abort();

		this.#resolveRetry();
	}

	async #promptAgentWithIdleRetry(messages: AgentMessage[], options?: { toolChoice?: ToolChoice }): Promise<void> {
		const deadline = Date.now() + 30_000;
		for (;;) {
			try {
				await this.agent.prompt(messages, options);
				return;
			} catch (err) {
				if (!(err instanceof AgentBusyError)) {
					throw err;
				}
				if (Date.now() >= deadline) {
					throw new Error("Timed out waiting for prior agent run to finish before prompting.");
				}
				await this.agent.waitForIdle();
			}
		}
	}

	get isRetrying(): boolean {
		return this.#retryPromise !== undefined;
	}

	get autoRetryEnabled(): boolean {
		return this.settings.get("retry.enabled") ?? true;
	}

	setAutoRetryEnabled(enabled: boolean): void {
		this.settings.set("retry.enabled", enabled);
	}

	async retry(): Promise<boolean> {
		if (this.isStreaming || this.isCompacting || this.isRetrying) return false;

		const messages = this.agent.state.messages;
		const lastMsg = messages[messages.length - 1];
		if (lastMsg?.role !== "assistant") return false;

		const assistantMsg = lastMsg as AssistantMessage;
		if (assistantMsg.stopReason !== "error" && assistantMsg.stopReason !== "aborted") return false;

		this.agent.replaceMessages(messages.slice(0, -1));

		this.#retryAttempt = 0;

		this.#scheduleAgentContinue({ delayMs: 1 });

		return true;
	}

	async #saveBashOriginalArtifact(originalText: string): Promise<string | undefined> {
		try {
			return await this.sessionManager.saveArtifact(originalText, "bash-original");
		} catch (err) {
			reportLostOutputArtifact("bash-original", err);
			return undefined;
		}
	}

	async executeBash(
		command: string,
		onChunk?: (chunk: string) => void,
		options?: { excludeFromContext?: boolean; useUserShell?: boolean },
	): Promise<BashResult> {
		const excludeFromContext = options?.excludeFromContext === true;
		const cwd = this.sessionManager.getCwd();

		if (this.#extensionRunner?.hasHandlers("user_bash")) {
			const hookResult = await this.#extensionRunner.emitUserBash({
				type: "user_bash",
				command,
				excludeFromContext,
				cwd,
			});
			if (hookResult?.result) {
				this.recordBashResult(command, hookResult.result, options);
				return hookResult.result;
			}
		}

		const abortController = new AbortController();
		this.#bashAbortControllers.add(abortController);

		try {
			const result = await executeBashCommand(command, {
				onChunk,
				signal: abortController.signal,
				sessionKey: this.sessionId,
				cwd,
				timeout: clampTimeout(TOOL.bash, undefined, this.settings.get("tools.maxTimeout")) * 1000,
				onMinimizedSave: originalText => this.#saveBashOriginalArtifact(originalText),
				useUserShell: options?.useUserShell,
			});

			this.recordBashResult(command, result, options);
			return result;
		} finally {
			this.#bashAbortControllers.delete(abortController);
		}
	}

	recordBashResult(command: string, result: BashResult, options?: { excludeFromContext?: boolean }): void {
		const meta = outputMeta().truncationFromSummary(result, { direction: "tail" }).get();
		const bashMessage: BashExecutionMessage = {
			role: "bashExecution",
			command,
			output: result.output,
			exitCode: result.exitCode,
			signal: result.signal,
			cancelled: result.cancelled,
			truncated: result.truncated,
			meta,
			timestamp: Date.now(),
			excludeFromContext: options?.excludeFromContext,
		};

		if (this.isStreaming) {
			this.#pendingBashMessages.push(bashMessage);
		} else {
			this.agent.appendMessage(bashMessage);

			this.sessionManager.appendMessage(bashMessage);
		}
	}

	abortBash(): void {
		for (const abortController of this.#bashAbortControllers) {
			abortController.abort();
		}
	}

	get isBashRunning(): boolean {
		return this.#bashAbortControllers.size > 0;
	}

	get hasPendingBashMessages(): boolean {
		return this.#pendingBashMessages.length > 0;
	}

	#flushPendingBashMessages(): void {
		if (this.#pendingBashMessages.length === 0) return;

		for (const bashMessage of this.#pendingBashMessages) {
			this.agent.appendMessage(bashMessage);

			this.sessionManager.appendMessage(bashMessage);
		}

		this.#pendingBashMessages = [];
	}

	async executePython(
		code: string,
		onChunk?: (chunk: string) => void,
		options?: { excludeFromContext?: boolean },
	): Promise<PythonResult> {
		const excludeFromContext = options?.excludeFromContext === true;
		const cwd = this.sessionManager.getCwd();
		this.assertEvalExecutionAllowed();

		const abortController = new AbortController();
		const execution = (async (): Promise<PythonResult> => {
			if (this.#extensionRunner?.hasHandlers("user_python")) {
				const hookResult = await this.#extensionRunner.emitUserPython({
					type: "user_python",
					code,
					excludeFromContext,
					cwd,
				});
				this.assertEvalExecutionAllowed();
				if (hookResult?.result) {
					this.recordPythonResult(code, hookResult.result, options);
					return hookResult.result;
				}
			}

			const sessionId =
				this.getEvalSessionId() ??
				defaultEvalSessionId({
					cwd,
					getSessionFile: () => this.sessionManager.getSessionFile() ?? null,
				});
			const result = await executePythonCommand(code, {
				cwd,
				sessionId: namespacePythonSessionId(sessionId),
				kernelOwnerId: this.#evalKernelOwnerId,
				kernelMode: this.settings.get("python.kernelMode"),
				interpreter: this.settings.get("python.interpreter")?.trim() || undefined,
				onChunk,
				signal: abortController.signal,
			});
			this.recordPythonResult(code, result, options);
			return result;
		})();
		return await this.trackEvalExecution(execution, abortController);
	}

	assertEvalExecutionAllowed(): void {
		if (this.#evalExecutionDisposing) {
			throw new Error("Python execution is unavailable while session disposal is in progress");
		}
	}

	trackEvalExecution<T>(execution: Promise<T>, abortController: AbortController): Promise<T> {
		this.#evalAbortControllers.add(abortController);
		this.#activeEvalExecutions.add(execution);
		void execution.then(
			() => {
				this.#evalAbortControllers.delete(abortController);
				this.#activeEvalExecutions.delete(execution);
			},
			() => {
				this.#evalAbortControllers.delete(abortController);
				this.#activeEvalExecutions.delete(execution);
			},
		);
		return execution;
	}

	recordPythonResult(code: string, result: PythonResult, options?: { excludeFromContext?: boolean }): void {
		const meta = outputMeta().truncationFromSummary(result, { direction: "tail" }).get();
		const pythonMessage: PythonExecutionMessage = {
			role: "pythonExecution",
			code,
			output: result.output,
			exitCode: result.exitCode,
			cancelled: result.cancelled,
			truncated: result.truncated,
			meta,
			timestamp: Date.now(),
			excludeFromContext: options?.excludeFromContext,
		};

		if (this.isStreaming) {
			this.#pendingPythonMessages.push(pythonMessage);
		} else {
			this.agent.appendMessage(pythonMessage);
			this.sessionManager.appendMessage(pythonMessage);
		}
	}

	abortEval(): void {
		for (const abortController of this.#evalAbortControllers) {
			abortController.abort();
		}
	}

	async #waitForEvalExecutionsToSettle(timeoutMs: number): Promise<boolean> {
		const deadline = Date.now() + timeoutMs;
		while (this.#activeEvalExecutions.size > 0) {
			const remainingMs = deadline - Date.now();
			if (remainingMs <= 0) {
				return false;
			}
			const settled = await Promise.race([
				Promise.allSettled(Array.from(this.#activeEvalExecutions)).then(() => true),
				Bun.sleep(remainingMs).then(() => false),
			]);
			if (!settled && this.#activeEvalExecutions.size > 0) {
				return false;
			}
		}
		return true;
	}

	async #prepareEvalExecutionsForDispose(): Promise<boolean> {
		if (!(await this.#waitForEvalExecutionsToSettle(3_000))) {
			logger.warn("Aborting active Python execution during dispose before retained kernel cleanup");
			this.abortEval();
			if (!(await this.#waitForEvalExecutionsToSettle(1_000))) {
				logger.warn(
					"Python execution is still active after dispose aborted all active runs; retained kernel ownership will still be detached",
				);
				return false;
			}
		}
		return true;
	}

	get isEvalRunning(): boolean {
		return this.#evalAbortControllers.size > 0;
	}

	get hasPendingPythonMessages(): boolean {
		return this.#pendingPythonMessages.length > 0;
	}

	#flushPendingPythonMessages(): void {
		if (this.#pendingPythonMessages.length === 0) return;

		for (const pythonMessage of this.#pendingPythonMessages) {
			this.agent.appendMessage(pythonMessage);
			this.sessionManager.appendMessage(pythonMessage);
		}

		this.#pendingPythonMessages = [];
	}

	drainPendingIrcInboxMessages(agentId: string, opts?: { from?: string; limit?: number }): IrcMessage[] {
		const messages: IrcMessage[] = [];
		const remainingInterrupts: CustomMessage[] = [];
		const remainingAsides: CustomMessage[] = [];
		const queues = [
			{ records: this.#pendingIrcInterrupts, remaining: remainingInterrupts },
			{ records: this.#pendingIrcAsides, remaining: remainingAsides },
		];
		for (const queue of queues) {
			for (const record of queue.records) {
				if (record.customType !== "irc:incoming") {
					queue.remaining.push(record);
					continue;
				}
				const details = record.details;
				if (!details || typeof details !== "object") {
					queue.remaining.push(record);
					continue;
				}
				const id = Reflect.get(details, "id");
				const from = Reflect.get(details, "from");
				const body = Reflect.get(details, "message");
				const replyTo = Reflect.get(details, "replyTo");
				if (typeof id !== "string" || typeof from !== "string" || typeof body !== "string") {
					queue.remaining.push(record);
					continue;
				}
				if (opts?.from !== undefined && from !== opts.from) {
					queue.remaining.push(record);
					continue;
				}
				if (opts?.limit !== undefined && messages.length >= opts.limit) {
					queue.remaining.push(record);
					continue;
				}
				messages.push({
					id,
					from,
					to: agentId,
					body,
					ts: record.timestamp,
					...(typeof replyTo === "string" ? { replyTo } : {}),
				});
			}
		}
		this.#pendingIrcInterrupts = remainingInterrupts;
		this.#pendingIrcAsides = remainingAsides;
		return messages;
	}

	async deliverIrcMessage(msg: IrcMessage, opts?: { expectsReply?: boolean }): Promise<"injected" | "woken"> {
		if (this.#isDisposed) {
			throw new Error("Recipient session is disposed.");
		}

		const planModeIdle = !this.isStreaming && this.#planModeState?.enabled === true;
		const autoReply =
			(opts?.expectsReply ?? false) && ((this.isStreaming && !this.settings.get("async.enabled")) || planModeIdle);
		const record: CustomMessage = {
			role: "custom",
			customType: "irc:incoming",
			content: prompt.render(sideChannelPrompts["side-channel/irc-incoming"].text, {
				from: msg.from,
				message: msg.body,
				replyTo: msg.replyTo ?? "",
				autoReplied: autoReply,
				interrupting: this.isStreaming,
			}),
			display: true,
			details: { id: msg.id, from: msg.from, message: msg.body, ...(msg.replyTo ? { replyTo: msg.replyTo } : {}) },
			attribution: "agent",
			timestamp: msg.ts,
		};
		void this.#emitSessionEvent({ type: "irc_message", message: record });
		if (this.isStreaming) {
			const recipientParentId = AgentRegistry.global().get(msg.to)?.parentId;
			if (recipientParentId === msg.from) {
				this.agent.steer({
					role: "user",
					content: prompt.render(steeringPrompts["steering/parent-irc"].text, {
						from: msg.from,
						message: msg.body,
					}),
					attribution: "agent",
					timestamp: msg.ts,
					steering: true,
				});
			} else {
				this.#pendingIrcInterrupts.push(record);
			}
			if (autoReply) void this.#runIrcAutoReply(msg);
			return "injected";
		}

		if (this.#planModeState?.enabled) {
			this.agent.appendMessage(record);
			this.sessionManager.appendCustomMessageEntry(
				record.customType,
				record.content,
				record.display,
				record.details,
				record.attribution ?? "agent",
			);
			if (autoReply) void this.#runIrcAutoReply(msg);
			return "injected";
		}

		this.#wakeForIrc([record]);
		return "woken";
	}

	async #runIrcAutoReply(msg: IrcMessage): Promise<void> {
		try {
			const { replyText } = await this.runEphemeralTurn({
				promptText: prompt.render(sideChannelPrompts["side-channel/irc-autoreply"].text, {
					from: msg.from,
					message: msg.body,
					replyTo: msg.replyTo ?? "",
				}),
			});
			const body = replyText.trim();
			if (!body || this.#isDisposed) return;
			const record: CustomMessage = {
				role: "custom",
				customType: "irc:autoreply",
				content: `[IRC you → \`${msg.from}\` (auto)]\n\n${body}`,
				display: true,
				details: { to: msg.from, body, replyTo: msg.id },
				attribution: "agent",
				timestamp: Date.now(),
			};
			void this.#emitSessionEvent({ type: "irc_message", message: record });

			this.#pendingIrcAsides.push(record);

			const receipt = await IrcBus.global().send({ from: msg.to, to: msg.from, body, replyTo: msg.id });
			if (receipt.outcome === "failed") {
				logger.warn("IRC auto-reply delivery failed", { to: msg.from, error: receipt.error });
			}
		} catch (error) {
			logger.warn("IRC auto-reply turn failed", { from: msg.from, error: errorMessage(error) });
		}
	}

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

	emitIrcRelayObservation(record: CustomMessage): void {
		void this.#emitSessionEvent({ type: "irc_message", message: record });
	}

	async runEphemeralTurn(args: {
		promptText: string;
		onTextDelta?: (delta: string) => void;
		signal?: AbortSignal;
		dedupeReply?: boolean;
	}): Promise<{ replyText: string; assistantMessage: AssistantMessage }> {
		const model = this.model;
		if (!model) {
			throw new Error("No active model on session");
		}
		const cacheSessionId = this.sessionId;

		const ephemeralPromptCacheKey = this.agent.promptCacheKey ?? cacheSessionId;
		const snapshot = this.#buildEphemeralSnapshot(args.promptText);
		const llmMessages = await this.convertMessagesToLlm(snapshot, args.signal);
		const context = await this.agent.buildSideRequestContext(llmMessages);
		const options = await this.prepareSimpleStreamOptions(
			{
				apiKey: this.#modelRegistry.resolver(model, cacheSessionId),

				sessionId: `${cacheSessionId}:side:${Snowflake.next()}`,
				promptCacheKey: ephemeralPromptCacheKey,
				preferWebsockets: this.#preferWebsockets,
				providerSessionState: this.#providerSessionState,
				reasoning: toReasoningEffort(this.thinkingLevel),
				disableReasoning: shouldDisableReasoning(this.thinkingLevel),
				hideThinkingSummary: this.agent.hideThinkingSummary,
				serviceTier: this.#effectiveServiceTier(model),
				signal: args.signal,
			},
			model.provider,
		);

		let providerReplyText = "";
		let emittedReplyText = "";
		let assistantMessage: AssistantMessage | undefined;
		const stream = await this.#sideStreamFn(model, this.#obfuscateContextForProvider(context), options);
		for await (const event of stream) {
			if (event.type === "text_delta") {
				providerReplyText += event.delta;
				if (args.onTextDelta) {
					const readyText = this.#deobfuscatedProviderTextReadyForDelta(providerReplyText);
					if (readyText.length > emittedReplyText.length) {
						const delta = readyText.slice(emittedReplyText.length);
						emittedReplyText = readyText;
						args.onTextDelta(delta);
					}
				}
				continue;
			}
			if (event.type === "done") {
				const rawContent = Array.isArray(event.message.content) ? event.message.content : [];

				await this.#awaitSecretExpansionRefreshForRender(this.#contentCarriesLivePlaceholder(rawContent));
				const expandReply = this.#displaySecretExpander();
				assistantMessage = {
					...event.message,
					content:
						expandReply === undefined
							? rawContent
							: mapAssistantContentStrings(rawContent, expandReply, { includeToolMetadata: true }),
				};
				break;
			}
			if (event.type === "error") {
				throw new Error(event.error.errorMessage || "Ephemeral turn failed");
			}
		}

		if (!assistantMessage) {
			throw new Error("Ephemeral turn ended without a final message");
		}
		const replyText = this.#deobfuscateFromProvider(providerReplyText);
		if (args.onTextDelta && replyText.length > emittedReplyText.length) {
			args.onTextDelta(replyText.slice(emittedReplyText.length));
		}
		const sanitizedMessage: AssistantMessage = {
			...assistantMessage,
			content: assistantMessage.content.filter(block => block.type !== "toolCall"),
		};
		return {
			replyText: args.dedupeReply === false ? replyText.trim() : dedupeEphemeralReply(replyText.trim()),
			assistantMessage: sanitizedMessage,
		};
	}

	#buildEphemeralSnapshot(promptText: string): AgentMessage[] {
		const messages = [...this.messages];
		const streaming = this.agent.state.streamMessage;
		if (streaming && streaming.role === "assistant" && Array.isArray(streaming.content)) {
			const preservedBlocks: AssistantMessage["content"] = [];

			for (const c of streaming.content) {
				if (c.type === "thinking") preservedBlocks.push(c);
			}
			const streamingText = assistantText(streaming, "");
			if (streamingText) {
				preservedBlocks.push({ type: "text", text: streamingText });
			}
			if (preservedBlocks.length > 0) {
				const normalized: AssistantMessage = {
					...streaming,
					content: preservedBlocks,
				};
				const lastMessage = messages.at(-1);
				if (lastMessage?.role === "assistant") {
					messages[messages.length - 1] = normalized;
				} else {
					messages.push(normalized);
				}
			}
		}
		messages.push({
			role: "developer",
			content: [{ type: "text", text: sideChannelPrompts["side-channel/side-channel-no-tools"].text }],
			attribution: "agent",
			timestamp: Date.now(),
		});
		messages.push({
			role: "user",
			content: [{ type: "text", text: promptText }],
			attribution: "agent",
			timestamp: Date.now(),
		});
		return messages;
	}

	#flushPendingIrcAsides(): void {
		if (this.#pendingIrcInterrupts.length === 0 && this.#pendingIrcAsides.length === 0) return;
		const records = [...this.#pendingIrcInterrupts, ...this.#pendingIrcAsides];
		this.#pendingIrcInterrupts = [];
		this.#pendingIrcAsides = [];
		for (const record of records) {
			this.agent.emitExternalEvent({ type: "message_start", message: record });
			this.agent.emitExternalEvent({ type: "message_end", message: record });
		}
	}

	async reload(): Promise<void> {
		const sessionFile = this.sessionFile;
		if (!sessionFile) return;
		await this.switchSession(sessionFile);
	}

	switchSession(sessionPath: string): Promise<boolean> {
		return this.#runScopeTransition(() => this.#switchSession(sessionPath));
	}

	async #switchSession(sessionPath: string): Promise<boolean> {
		const previousSessionFile = this.sessionManager.getSessionFile();
		const switchingToDifferentSession = previousSessionFile
			? path.resolve(previousSessionFile) !== path.resolve(sessionPath)
			: true;

		if (this.#extensionRunner?.hasHandlers("session_before_switch")) {
			const result = (await this.#extensionRunner.emit({
				type: "session_before_switch",
				reason: "resume",
				targetSessionFile: sessionPath,
			})) as SessionBeforeSwitchResult | undefined;

			if (result?.cancel) {
				return false;
			}
		}

		this.#disconnectFromAgent();
		await this.abort({ goalReason: "internal" });

		await this.sessionManager.flush();
		const previousSessionState = this.sessionManager.captureState();

		const previousSessionContext = switchingToDifferentSession ? undefined : this.buildDisplaySessionContext();

		const previousAgentMessages = [...this.agent.state.messages];
		const previousSteeringMessages = [...this.agent.peekSteeringQueue()];
		const previousFollowUpMessages = [...this.agent.peekFollowUpQueue()];
		const previousPendingNextTurnMessages = [...this.#pendingNextTurnMessages];
		const previousScheduledHiddenNextTurnGeneration = this.#scheduledHiddenNextTurnGeneration;
		const previousModel = this.model;
		const previousThinkingLevel = this.#thinkingLevel;
		const previousAutoThinking = this.#autoThinking;
		const previousAutoResolvedLevel = this.#autoResolvedLevel;
		const previousServiceTierByFamily = this.#serviceTierByFamily;
		const previousSelectedMCPToolNames = new Set(this.#selectedMCPToolNames);
		const previousTools = [...this.agent.state.tools];
		const previousBaseSystemPrompt = this.#baseSystemPrompt;
		const previousSystemPrompt = this.agent.state.systemPrompt;
		const previousFreshProviderSessionId = this.#freshProviderSessionId;
		const previousInheritedProviderPromptCacheKey = this.#inheritedProviderPromptCacheKey;

		const previousAgentPromptCacheKey = this.agent.promptCacheKey;
		const previousFallbackSelectedMCPToolNames = previousSessionFile
			? this.#getSessionDefaultSelectedMCPToolNames(previousSessionFile)
			: undefined;

		const previousCheckpointState = this.#checkpointState;
		const previousPendingRewindReport = this.#pendingRewindReport;
		const previousLastCompletedRewind = this.#lastCompletedRewind;
		const previousRewoundToolResultIds = new Set(this.#rewoundToolResultIds);
		const previousWirePathRoots = this.#wirePathRoots;

		let scopeTransitionAttempted = false;

		this.agent.clearAllQueues();
		this.#pendingNextTurnMessages = [];
		this.#scheduledHiddenNextTurnGeneration = undefined;

		try {
			await this.sessionManager.setSessionFile(sessionPath);

			const recordedTargetCwd = this.sessionManager.getHeader()?.cwd;
			if (recordedTargetCwd && path.resolve(recordedTargetCwd) !== path.resolve(this.sessionManager.getCwd())) {
				let recordedTargetCwdReachable = false;
				try {
					recordedTargetCwdReachable = (await fs.promises.stat(recordedTargetCwd)).isDirectory();
				} catch {}
				if (recordedTargetCwdReachable) {
					await this.sessionManager.setCwd(recordedTargetCwd, { validate: false });
				}
			}
			const targetCwd = this.sessionManager.getCwd();
			if (path.resolve(targetCwd) !== path.resolve(previousSessionState.cwd)) {
				scopeTransitionAttempted = true;
				await this.#rescopeToCwd(targetCwd);
				this.#wirePathRoots = normalizeRoots(targetCwd);
			}

			if (switchingToDifferentSession) {
				this.#freshProviderSessionId = undefined;
				this.#clearInheritedProviderPromptCacheKey("session-switch");
				this.#adoptInheritedProviderPromptCacheKey();
			}
			this.#syncAgentSessionId();
			this.#rekeyHindsightMemoryForCurrentSessionId();
			this.#rekeyMnemopiMemoryForCurrentSessionId();

			let sessionContext = this.buildDisplaySessionContext();
			const didReloadConversationChange =
				previousSessionContext !== undefined &&
				this.#didSessionMessagesChange(previousSessionContext.messages, sessionContext.messages);
			const fallbackSelectedMCPToolNames = this.#getSessionDefaultSelectedMCPToolNames(sessionPath);
			await this.#restoreMCPSelectionsForSessionContext(sessionContext, { fallbackSelectedMCPToolNames });
			this.#rehydrateCheckpointRewindState();

			if (this.#extensionRunner) {
				await this.#extensionRunner.emit({
					type: "session_switch",
					reason: "resume",
					previousSessionFile,
				});
			}

			this.agent.replaceMessages(sessionContext.messages);
			this.#resetAdvisorSessionState();
			this.#syncTodoPhasesFromBranch();

			this.#resetTodoReminderStateForNewContext();
			if (switchingToDifferentSession) {
				this.#closeAllProviderSessions("session switch");
			} else if (didReloadConversationChange) {
				this.#closeAllProviderSessions("session reload");
			}
			const targetModelStrings = getRestorableSessionModels(
				sessionContext.models,
				this.sessionManager.getLastModelChangeRole(),
			);
			if (targetModelStrings.length > 0) {
				const availableModels = this.#modelRegistry.getAvailable();
				let match: Model | undefined;
				for (const targetModelStr of targetModelStrings) {
					const slashIdx = targetModelStr.indexOf("/");
					if (slashIdx <= 0) continue;
					const provider = targetModelStr.slice(0, slashIdx);
					const modelId = targetModelStr.slice(slashIdx + 1);
					match = availableModels.find(m => m.provider === provider && m.id === modelId);
					if (match) break;
				}
				if (match) {
					const currentModel = this.model;
					const shouldResetProviderState =
						switchingToDifferentSession ||
						(currentModel !== undefined &&
							(currentModel.provider !== match.provider ||
								currentModel.id !== match.id ||
								currentModel.api !== match.api));
					if (shouldResetProviderState) {
						this.#setModelWithProviderSessionReset(match);
					} else {
						this.agent.setModel(match);
					}
				}
			}

			const model = this.model;
			if (model) {
				const interruptedTurnAbort = createInterruptedTurnAbortMessage(this.sessionManager.getBranch(), {
					api: model.api,
					provider: model.provider,
					model: model.id,
				});
				if (interruptedTurnAbort) {
					this.sessionManager.appendMessage(interruptedTurnAbort);
					sessionContext = this.buildDisplaySessionContext();
					this.agent.replaceMessages(sessionContext.messages);
				}
			}

			const hasThinkingEntry = this.sessionManager.getBranch().some(entry => entry.type === "thinking_level_change");
			const hasServiceTierEntry = this.sessionManager
				.getBranch()
				.some(entry => entry.type === "service_tier_change");
			const defaultThinkingLevel = parseConfiguredThinkingLevel(this.settings.get("defaultThinkingLevel"));
			const configuredServiceTierByFamily = buildServiceTierByFamily(
				this.settings.get("tier.openai"),
				this.settings.get("tier.anthropic"),
				this.settings.get("tier.google"),
			);

			const restoredConfigured = sessionContext.configuredThinkingLevel;
			const restoredThinkingLevel: ConfiguredThinkingLevel | undefined =
				hasThinkingEntry || (defaultThinkingLevel === AUTO_THINKING && sessionContext.thinkingLevel !== "off")
					? restoredConfigured === AUTO_THINKING
						? AUTO_THINKING
						: (sessionContext.thinkingLevel as ThinkingLevel | undefined)
					: defaultThinkingLevel;
			if (restoredThinkingLevel === AUTO_THINKING) {
				this.#autoThinking = true;

				this.#autoResolvedLevel = undefined;
				this.#thinkingLevel = resolveProvisionalAutoLevel(this.model);
			} else {
				this.#autoThinking = false;
				this.#autoResolvedLevel = undefined;
				this.#thinkingLevel = resolveThinkingLevelForModel(this.model, restoredThinkingLevel);
			}
			this.#applyThinkingLevelToAgent(this.#thinkingLevel);
			this.#serviceTierByFamily = hasServiceTierEntry
				? (sessionContext.serviceTier ?? {})
				: configuredServiceTierByFamily;

			if (switchingToDifferentSession) {
				this.#resetMemoryContextForNewTranscript();
				await this.#rescopeAgentRegistry();
			}
			this.#reconnectToAgent();
			try {
				await this.#sessionSwitchReconciler?.();
			} catch (error) {
				logger.warn("Failed to reconcile session mode after switch", {
					targetSessionFile: sessionPath,
					error: errorMessage(error),
				});
			}
			return true;
		} catch (error) {
			this.sessionManager.restoreState(previousSessionState);
			this.#wirePathRoots = previousWirePathRoots;
			let restoreScopeError: unknown;
			if (scopeTransitionAttempted) {
				this.#lastRescopedCwd = undefined;
				try {
					await this.#rescopeToCwd(previousSessionState.cwd);
				} catch (scopeError) {
					restoreScopeError = scopeError;
					logger.warn("Failed to restore cwd-scoped runtime after switch error", {
						previousSessionFile,
						targetSessionFile: sessionPath,
						error: String(scopeError),
					});
				}
			}

			this.#freshProviderSessionId = previousFreshProviderSessionId;
			this.#syncAgentSessionId(previousSessionState.sessionId);
			this.#rekeyHindsightMemoryForCurrentSessionId();
			this.#rekeyMnemopiMemoryForCurrentSessionId();
			let restoreMcpError: unknown;
			try {
				const mcpRestoreContext = previousSessionContext ?? this.buildDisplaySessionContext();
				await this.#restoreMCPSelectionsForSessionContext(mcpRestoreContext, {
					fallbackSelectedMCPToolNames: previousFallbackSelectedMCPToolNames,
				});
			} catch (mcpError) {
				restoreMcpError = mcpError;
				logger.warn("Failed to restore MCP selections after switch error", {
					previousSessionFile,
					targetSessionFile: sessionPath,
					error: String(mcpError),
				});
				this.#selectedMCPToolNames = new Set(previousSelectedMCPToolNames);
				this.agent.setTools(previousTools);
				this.#baseSystemPrompt = previousBaseSystemPrompt;
				this.agent.setSystemPrompt(previousSystemPrompt);
			}
			this.#baseSystemPrompt = previousBaseSystemPrompt;
			this.agent.setSystemPrompt(previousSystemPrompt);
			this.agent.replaceMessages(previousAgentMessages);
			this.agent.replaceQueues(previousSteeringMessages, previousFollowUpMessages);
			this.#pendingNextTurnMessages = previousPendingNextTurnMessages;
			this.#scheduledHiddenNextTurnGeneration = previousScheduledHiddenNextTurnGeneration;
			this.#inheritedProviderPromptCacheKey = previousInheritedProviderPromptCacheKey;
			this.agent.promptCacheKey = previousAgentPromptCacheKey;
			this.#checkpointState = previousCheckpointState;
			this.#pendingRewindReport = previousPendingRewindReport;
			this.#lastCompletedRewind = previousLastCompletedRewind;
			this.#rewoundToolResultIds = previousRewoundToolResultIds;
			if (previousModel) {
				this.agent.setModel(previousModel);
			}
			this.#thinkingLevel = previousThinkingLevel;
			this.#autoThinking = previousAutoThinking;
			this.#autoResolvedLevel = previousAutoResolvedLevel;
			this.#applyThinkingLevelToAgent(previousThinkingLevel);
			this.#serviceTierByFamily = previousServiceTierByFamily;
			this.#syncTodoPhasesFromBranch();
			this.#resetAllAdvisorRuntimes();
			this.#reconnectToAgent();
			if (restoreScopeError || restoreMcpError) {
				throw new AggregateError(
					[error, restoreScopeError, restoreMcpError].filter(candidate => candidate !== undefined),
					"Failed to switch sessions and fully restore the previous runtime.",
				);
			}
			throw error;
		}
	}

	async branch(entryId: string): Promise<{
		selectedText: string;
		cancelled: boolean;
	}> {
		const previousSessionFile = this.sessionFile;
		const selectedEntry = this.sessionManager.getEntry(entryId);

		if (selectedEntry?.type !== "message" || selectedEntry.message.role !== "user") {
			throw new Error("Invalid entry ID for branching");
		}

		const selectedText = this.#extractUserMessageText(selectedEntry.message.content);

		let skipConversationRestore = false;

		if (this.#extensionRunner?.hasHandlers("session_before_branch")) {
			const result = (await this.#extensionRunner.emit({
				type: "session_before_branch",
				entryId,
			})) as SessionBeforeBranchResult | undefined;

			if (result?.cancel) {
				return { selectedText, cancelled: true };
			}
			skipConversationRestore = result?.skipConversationRestore ?? false;
		}
		this.#pendingNextTurnMessages = [];
		this.#scheduledHiddenNextTurnGeneration = undefined;
		await this.sessionManager.flush();
		this.#cancelOwnAsyncJobs();

		if (!selectedEntry.parentId) {
			await this.sessionManager.newSession({
				parentSession: previousSessionFile,

				providerPromptCacheKey:
					this.sessionManager.getHeader()?.providerPromptCacheKey ?? this.sessionManager.getSessionId(),
			});
		} else {
			this.sessionManager.createBranchedSession(selectedEntry.parentId);
		}
		this.#rehydrateCheckpointRewindState();
		this.#syncTodoPhasesFromBranch();
		this.#freshProviderSessionId = undefined;

		this.#adoptInheritedProviderPromptCacheKey();
		this.#syncAgentSessionId();
		this.#rekeyHindsightMemoryForCurrentSessionId();
		this.#rekeyMnemopiMemoryForCurrentSessionId();
		this.#resetMemoryContextForNewTranscript();

		const sessionContext = this.buildDisplaySessionContext();

		await this.#restoreMCPSelectionsForSessionContext(sessionContext);

		if (this.#extensionRunner) {
			await this.#extensionRunner.emit({
				type: "session_branch",
				previousSessionFile,
			});
		}

		if (!skipConversationRestore) {
			this.agent.replaceMessages(sessionContext.messages);
			this.#resetAdvisorSessionState();
			this.#closeCodexProviderSessionsForHistoryRewrite();
		}

		return { selectedText, cancelled: false };
	}

	async branchFromBtw(
		question: string,
		assistantMessage: AssistantMessage,
	): Promise<{ cancelled: boolean; sessionFile: string | undefined }> {
		const previousSessionFile = this.sessionFile;
		if (!this.sessionManager.getSessionFile()) {
			throw new Error("Cannot branch /btw: session is not persisted");
		}

		const leafId = this.sessionManager.getLeafId();
		if (!leafId) {
			throw new Error("Cannot branch /btw: current session has no leaf");
		}

		if (
			this.isBashRunning ||
			this.isEvalRunning ||
			this.isCompacting ||
			this.isGeneratingHandoff ||
			this.isRetrying
		) {
			throw new Error("Cannot branch /btw while session maintenance or user work is still running");
		}

		if (this.#extensionRunner?.hasHandlers("session_before_branch")) {
			const result = (await this.#extensionRunner.emit({
				type: "session_before_branch",
				entryId: leafId,
			})) as SessionBeforeBranchResult | undefined;

			if (result?.cancel) {
				return { cancelled: true, sessionFile: previousSessionFile };
			}
		}

		await this.#cancelPostPromptTasks();
		if (
			this.isBashRunning ||
			this.isEvalRunning ||
			this.isCompacting ||
			this.isGeneratingHandoff ||
			this.isRetrying
		) {
			throw new Error("Cannot branch /btw while session maintenance or user work is still running");
		}

		this.#pendingNextTurnMessages = [];
		this.#scheduledHiddenNextTurnGeneration = undefined;
		this.agent.replaceQueues([], []);
		if (this.isStreaming) {
			await this.abort({ goalReason: "internal", reason: "branching /btw" });
			this.agent.replaceQueues([], []);
		}
		await this.sessionManager.flush();
		this.#cancelOwnAsyncJobs();

		this.sessionManager.createBranchedSession(leafId);

		this.#rehydrateCheckpointRewindState();
		this.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: question }],
			timestamp: Date.now(),
		});
		this.sessionManager.appendMessage(sanitizeAssistantForReparentedHistory(assistantMessage));
		this.#syncTodoPhasesFromBranch();
		this.#freshProviderSessionId = undefined;

		this.#adoptInheritedProviderPromptCacheKey();
		this.#syncAgentSessionId();
		this.#rekeyHindsightMemoryForCurrentSessionId();
		this.#rekeyMnemopiMemoryForCurrentSessionId();
		this.#resetMemoryContextForNewTranscript();

		const sessionContext = this.buildDisplaySessionContext();
		await this.#restoreMCPSelectionsForSessionContext(sessionContext);

		if (this.#extensionRunner) {
			await this.#extensionRunner.emit({
				type: "session_branch",
				previousSessionFile,
			});
		}

		this.agent.replaceMessages(sessionContext.messages);
		this.#resetAdvisorSessionState();
		this.#closeCodexProviderSessionsForHistoryRewrite();

		return { cancelled: false, sessionFile: this.sessionFile };
	}

	async navigateTree(
		targetId: string,
		options: { summarize?: boolean; customInstructions?: string } = {},
	): Promise<{
		editorText?: string;
		cancelled: boolean;
		aborted?: boolean;
		summaryEntry?: BranchSummaryEntry;

		sessionContext?: SessionContext;
	}> {
		const oldLeafId = this.sessionManager.getLeafId();
		if (targetId === oldLeafId) {
			return { cancelled: false };
		}

		if (options.summarize && !this.model) {
			throw new Error("No model available for summarization");
		}

		const targetEntry = this.sessionManager.getEntry(targetId);
		if (!targetEntry) {
			throw new Error(`Entry ${targetId} not found`);
		}

		const { entries: entriesToSummarize, commonAncestorId } = collectEntriesForBranchSummary(
			this.sessionManager,
			oldLeafId,
			targetId,
		);
		const preparation: TreePreparation = {
			targetId,
			oldLeafId,
			commonAncestorId,
			entriesToSummarize,
			userWantsSummary: options.summarize ?? false,
		};
		this.#branchSummaryAbortController = new AbortController();
		let hookSummary: { summary: string; details?: unknown } | undefined;
		let fromExtension = false;

		if (this.#extensionRunner?.hasHandlers("session_before_tree")) {
			const result = (await this.#extensionRunner.emit({
				type: "session_before_tree",
				preparation,
				signal: this.#branchSummaryAbortController.signal,
			})) as SessionBeforeTreeResult | undefined;

			if (result?.cancel) {
				this.#branchSummaryAbortController = undefined;
				return { cancelled: true };
			}

			if (result?.summary && options.summarize) {
				hookSummary = result.summary;
				fromExtension = true;
			}
		}
		let summaryText: string | undefined;
		let summaryDetails: unknown;
		if (options.summarize && entriesToSummarize.length > 0 && !hookSummary) {
			const model = this.model!;
			const apiKey = await this.#modelRegistry.getApiKey(model, this.sessionId);
			if (!apiKey) {
				throw new Error(missingCredentialsMessage(model.provider, model.id, "the branch summary model"));
			}
			await this.leaseSecretRuntime();
			const result = await generateBranchSummary(entriesToSummarize, {
				model,
				apiKey: this.#modelRegistry.resolver(model, this.sessionId),
				signal: this.#branchSummaryAbortController.signal,
				sessionId: this.sessionId,
				promptCacheKey: this.agent.promptCacheKey ?? this.sessionId,
				customInstructions: options.customInstructions,
				reserveTokens: this.settings.get("branchSummary.reserveTokens"),
				metadata: this.agent.metadataForProvider(model.provider),
				convertToLlm,
				resolveObfuscateProviderText: () => {
					const runtime = this.#secretRuntime;
					const fallback = this.#obfuscator;
					return text => runtime?.obfuscateText(text) ?? fallback?.obfuscate(text) ?? text;
				},
				onPayload: this.#onPayload,
				telemetry: resolveTelemetry(this.agent.telemetry, this.sessionId),

				completeImpl: this.#sideCompleteImpl,
				serviceTier: this.#effectiveServiceTier(model),
			});
			this.#branchSummaryAbortController = undefined;
			if (result.aborted) {
				return { cancelled: true, aborted: true };
			}
			if (result.error) {
				throw new Error(result.error);
			}
			summaryText = result.summary;
			summaryDetails = {
				readFiles: result.readFiles || [],
				modifiedFiles: result.modifiedFiles || [],
			};
		} else if (hookSummary) {
			summaryText = hookSummary.summary;
			summaryDetails = hookSummary.details;
			this.#branchSummaryAbortController = undefined;
		} else {
			this.#branchSummaryAbortController = undefined;
		}

		let newLeafId: string | null;
		let editorText: string | undefined;

		if (targetEntry.type === "message" && targetEntry.message.role === "user") {
			newLeafId = targetEntry.parentId;
			editorText = this.#extractUserMessageText(targetEntry.message.content);
		} else if (targetEntry.type === "custom_message" && targetEntry.customType !== SKILL_PROMPT_MESSAGE_TYPE) {
			newLeafId = targetEntry.parentId;
			editorText = contentText(targetEntry.content, { separator: "" });
		} else {
			newLeafId = targetId;
		}

		let summaryEntry: BranchSummaryEntry | undefined;
		if (summaryText) {
			const summaryId = this.sessionManager.branchWithSummary(newLeafId, summaryText, summaryDetails, fromExtension);

			summaryEntry = this.sessionManager.getEntry(summaryId) as BranchSummaryEntry;
		} else if (newLeafId === null) {
			this.sessionManager.resetLeaf();
		} else {
			this.sessionManager.branch(newLeafId);
		}

		const stateContext = this.sessionManager.buildSessionContext();

		await this.#awaitSecretExpansionRefreshForRender(this.#messagesCarryLivePlaceholder(stateContext.messages));
		const displayContext = this.#deobfuscateSessionContextForDisplay(stateContext);
		await this.#restoreMCPSelectionsForSessionContext(displayContext);
		this.agent.replaceMessages(displayContext.messages);
		this.#rehydrateCheckpointRewindState();
		this.#resetAdvisorSessionState();
		this.#syncTodoPhasesFromBranch();
		this.#closeCodexProviderSessionsForHistoryRewrite();

		this.#branchSummaryAbortController = undefined;

		if (this.#extensionRunner?.hasHandlers("session_tree")) {
			await this.#extensionRunner.emit({
				type: "session_tree",
				newLeafId: this.sessionManager.getLeafId(),
				oldLeafId,
				summaryEntry,
				fromExtension: summaryText ? fromExtension : undefined,
			});
			const rawContext = this.sessionManager.buildSessionContext();
			return { editorText, cancelled: false, summaryEntry, sessionContext: rawContext };
		}
		return { editorText, cancelled: false, summaryEntry, sessionContext: stateContext };
	}

	getUserMessagesForBranching(): Array<{ entryId: string; text: string }> {
		const entries = this.sessionManager.getEntries();
		const result: Array<{ entryId: string; text: string }> = [];

		for (const entry of entries) {
			if (entry.type !== "message") continue;
			if (entry.message.role !== "user") continue;

			const text = this.#extractUserMessageText(entry.message.content);
			if (text) {
				result.push({ entryId: entry.id, text });
			}
		}

		return result;
	}

	#extractUserMessageText(content: string | Array<{ type: string; text?: string }>): string {
		if (typeof content !== "string" && !Array.isArray(content)) return "";
		return contentText(content, { separator: "" });
	}

	getSessionStats(): SessionStats {
		const state = this.state;
		const summarizedAway = this.#messagesSummarizedAway();
		const messages = summarizedAway.length > 0 ? [...summarizedAway, ...state.messages] : state.messages;
		const userMessages = messages.filter(m => m.role === "user").length;
		const assistantMessages = messages.filter(m => m.role === "assistant").length;
		const toolResults = messages.filter(m => m.role === "toolResult").length;

		let toolCalls = 0;
		let totalInput = 0;
		let totalOutput = 0;
		let totalCacheRead = 0;
		let totalReasoning = 0;
		let totalCacheWrite = 0;
		let totalTokens = 0;
		let totalCost = 0;
		let totalPremiumRequests = 0;

		const getTaskToolUsage = (details: unknown): Usage | undefined => {
			if (!details || typeof details !== "object") return undefined;
			const record = details as Record<string, unknown>;
			const usage = record.usage;
			if (!usage || typeof usage !== "object") return undefined;
			return usage as Usage;
		};

		for (const message of messages) {
			if (message.role === "assistant") {
				const assistantMsg = message as AssistantMessage;
				toolCalls += assistantMsg.content.filter(c => c.type === "toolCall").length;
				totalInput += assistantMsg.usage.input;
				totalOutput += assistantMsg.usage.output;
				totalReasoning += assistantMsg.usage.reasoningTokens ?? 0;
				totalCacheRead += assistantMsg.usage.cacheRead;
				totalCacheWrite += assistantMsg.usage.cacheWrite;
				totalTokens += assistantMsg.usage.totalTokens;
				totalPremiumRequests += assistantMsg.usage.premiumRequests ?? 0;
				totalCost += assistantMsg.usage.cost.total;
			}

			if (message.role === "toolResult" && message.toolName === TOOL.task) {
				const usage = getTaskToolUsage(message.details);
				if (usage) {
					totalInput += usage.input;
					totalOutput += usage.output;
					totalReasoning += usage.reasoningTokens ?? 0;
					totalCacheRead += usage.cacheRead;
					totalCacheWrite += usage.cacheWrite;
					totalTokens += usage.totalTokens;
					totalPremiumRequests += usage.premiumRequests ?? 0;
					totalCost += usage.cost.total;
				}
			}
		}

		return {
			sessionFile: this.sessionFile,
			sessionId: this.sessionId,
			userMessages,
			assistantMessages,
			toolCalls,
			toolResults,
			totalMessages: messages.length,
			tokens: {
				input: totalInput,
				output: totalOutput,
				reasoning: totalReasoning,
				cacheRead: totalCacheRead,
				cacheWrite: totalCacheWrite,
				total: totalTokens,
			},
			cost: totalCost,
			premiumRequests: totalPremiumRequests,
			contextUsage: this.getContextUsage(),
		};
	}

	#messagesSummarizedAway(): AgentMessage[] {
		const branch = this.sessionManager.getBranch();
		const boundary = resolveCompactionBoundaryIndex(branch, getLatestCompactionEntry(branch)?.firstKeptEntryId);
		if (boundary <= 0) return [];
		const summarized: AgentMessage[] = [];
		for (let index = 0; index < boundary; index++) {
			const entry = branch[index];
			if (entry.type === "message") summarized.push(entry.message);
		}
		return summarized;
	}

	getContextBreakdown(options?: {
		contextWindow?: number;
		pendingMessages?: AgentMessage[];
	}): ContextUsageBreakdown | undefined {
		const model = this.model;
		const rawContextWindow = options?.contextWindow ?? model?.contextWindow ?? 0;
		const contextWindow = Number.isFinite(rawContextWindow) && rawContextWindow > 0 ? rawContextWindow : 0;

		const { skillsTokens, toolsTokens, systemContextTokens, systemPromptTokens } = computeNonMessageBreakdown(this);
		const categoryNonMessageTokens = skillsTokens + toolsTokens + systemContextTokens + systemPromptTokens;
		const currentNonMessageTokens = computeNonMessageTokens(this);

		const branchEntries = this.sessionManager.getBranch();
		const latestCompaction = getLatestCompactionEntry(branchEntries);
		const compactionIndex = latestCompaction ? branchEntries.lastIndexOf(latestCompaction) : -1;

		let usedTokens = 0;
		let anchored = false;

		const pendingMessages = options?.pendingMessages ?? [];
		let pendingMessagesTokens = 0;
		for (const message of pendingMessages) pendingMessagesTokens += estimateTokens(message);

		const pending = this.#pendingContextSnapshot;

		const rewriteBoundaryId = this.#historyRewriteAnchorBoundaryEntryId;
		const rewriteIndex = rewriteBoundaryId ? branchEntries.findIndex(entry => entry.id === rewriteBoundaryId) : -1;
		const anchorFloorIndex = Math.max(compactionIndex, rewriteIndex);
		let anchorEntry: SessionMessageEntry | undefined;
		for (let i = branchEntries.length - 1; i > anchorFloorIndex; i--) {
			const entry = branchEntries[i];
			if (entry.type === "message" && entry.message.role === "assistant") {
				const assistant = entry.message;
				if (assistant.stopReason !== "aborted" && assistant.stopReason !== "error" && assistant.usage) {
					anchorEntry = entry;
					break;
				}
			}
		}

		const resolvedActiveMessages = this.messages;
		let resolvedAnchorIndex = -1;
		let anchorAssistant: AssistantMessage | undefined;
		if (anchorEntry) {
			const a = anchorEntry.message as AssistantMessage;
			anchorAssistant = a;
			resolvedAnchorIndex = resolvedActiveMessages.indexOf(a);
			if (resolvedAnchorIndex === -1) {
				resolvedAnchorIndex = resolvedActiveMessages.findIndex(
					msg => msg.role === "assistant" && msg.timestamp === a.timestamp,
				);
			}
		}

		const useAnchor =
			anchorAssistant !== undefined &&
			resolvedAnchorIndex !== -1 &&
			(!pending || resolvedAnchorIndex >= pending.cutoffCount);

		if (useAnchor && anchorAssistant) {
			const promptTokens =
				anchorAssistant.contextSnapshot?.promptTokens ?? calculatePromptTokens(anchorAssistant.usage);
			const nonMessageTokens = anchorAssistant.contextSnapshot?.nonMessageTokens ?? computeNonMessageTokens(this);
			anchored = true;
			let tailTokens = 0;
			for (let i = resolvedAnchorIndex + 1; i < resolvedActiveMessages.length; i++) {
				tailTokens += estimateTokens(resolvedActiveMessages[i]);
			}
			usedTokens =
				promptTokens + Math.max(0, currentNonMessageTokens - nonMessageTokens) + tailTokens + pendingMessagesTokens;
		} else if (pending) {
			anchored = true;
			let tailTokens = 0;
			for (let i = pending.cutoffCount; i < resolvedActiveMessages.length; i++) {
				const message = resolvedActiveMessages[i];

				if (pending.submitted.has(message)) continue;
				tailTokens += estimateTokens(message);
			}
			usedTokens =
				pending.promptTokens +
				Math.max(0, currentNonMessageTokens - pending.nonMessageTokens) +
				tailTokens +
				pendingMessagesTokens;
		}

		if (!anchored && !pending && branchEntries.length === 0) {
			for (let i = resolvedActiveMessages.length - 1; i >= 0; i--) {
				const msg = resolvedActiveMessages[i];
				if (msg.role === "assistant" && msg.stopReason !== "aborted" && msg.stopReason !== "error" && msg.usage) {
					const promptTokens = msg.contextSnapshot?.promptTokens ?? calculatePromptTokens(msg.usage);
					const nonMessageTokens = msg.contextSnapshot?.nonMessageTokens ?? computeNonMessageTokens(this);

					let tailTokens = 0;
					for (let j = i + 1; j < resolvedActiveMessages.length; j++) {
						tailTokens += estimateTokens(resolvedActiveMessages[j]);
					}

					usedTokens =
						promptTokens +
						Math.max(0, currentNonMessageTokens - nonMessageTokens) +
						tailTokens +
						pendingMessagesTokens;
					anchored = true;
					break;
				}
			}
		}
		if (!anchored) {
			let messagesTokens = 0;
			for (const msg of resolvedActiveMessages) {
				messagesTokens += estimateTokens(msg);
			}
			usedTokens = currentNonMessageTokens + messagesTokens + pendingMessagesTokens;
		}

		usedTokens = compactionContextTokens(usedTokens, this.#estimateStoredContextTokens(pendingMessages));

		const messagesTokens = Math.max(0, usedTokens - categoryNonMessageTokens);

		return {
			contextWindow,
			anchored,
			usedTokens,
			systemPromptTokens,
			systemToolsTokens: toolsTokens,
			systemContextTokens,
			skillsTokens,
			messagesTokens,
			pendingMessagesTokens,
		};
	}

	getContextUsage(options?: { contextWindow?: number }): ContextUsage | undefined {
		const breakdown = this.getContextBreakdown(options);
		if (!breakdown) return undefined;
		return {
			tokens: breakdown.usedTokens,
			contextWindow: breakdown.contextWindow,
			percent: breakdown.contextWindow > 0 ? (breakdown.usedTokens / breakdown.contextWindow) * 100 : 0,
		};
	}

	get contextUsageRevision(): number {
		return this.#contextUsageRevision;
	}

	#setPendingContextSnapshot(snapshot: PendingContextSnapshot | undefined): void {
		this.#pendingContextSnapshot = snapshot;
		this.#contextUsageRevision++;
	}

	#rebasePendingContextSnapshotAfterHistoryRewrite(): void {
		if (!this.#pendingContextSnapshot) return;
		const nonMessageTokens = computeNonMessageTokens(this);
		const promptTokens = nonMessageTokens + this.messages.reduce((sum, msg) => sum + estimateTokens(msg), 0);
		const rebased: PendingContextSnapshot = {
			promptTokens,
			nonMessageTokens,
			cutoffCount: this.messages.length,

			submitted: new Set<AgentMessage>(),
			detail: this.#pendingContextSnapshot.detail,
		};
		if (this.#pendingContextSnapshot.detail === "rich" || this.#pendingContextSnapshot.detail === "ultra") {
			const attribution = estimateContextSnapshotAttribution(
				promptTokens,
				nonMessageTokens,
				0,
				"estimate",
				this.#pendingContextSnapshot.detail === "ultra"
					? getLatestCompactionEntry(this.sessionManager.getBranch())?.id
					: undefined,
			);
			rebased.storedMessagesTokens = attribution.storedMessagesTokens;
			rebased.tailTokens = attribution.tailTokens;
			rebased.compactionEntryId = attribution.compactionEntryId;
		}
		this.#setPendingContextSnapshot(rebased);
	}

	#ingestProviderUsageHeaders(response: ProviderResponseMetadata, model?: Model): void {
		const provider = model?.provider;
		if (!provider) return;

		this.#modelRegistry.authStorage.ingestUsageHeaders(provider, response.headers, {
			sessionId: this.agent.sessionId,
			baseUrl: this.#modelRegistry.getProviderBaseUrl?.(provider),
		});
	}

	async fetchUsageReports(signal?: AbortSignal): Promise<UsageReport[] | null> {
		const authStorage = this.#modelRegistry.authStorage;
		if (!authStorage.fetchUsageReports) return null;
		return authStorage.fetchUsageReports({
			baseUrlResolver: provider => {
				if (provider === "google-antigravity") {
					const mode = this.settings.get("providers.antigravityEndpoint");
					if (mode === "sandbox") {
						return ANTIGRAVITY_SANDBOX_ENDPOINT;
					} else if (mode === "production") {
						return ANTIGRAVITY_PRIMARY_ENDPOINT;
					}
				}
				return this.#modelRegistry.getProviderBaseUrl?.(provider);
			},
			signal,
		});
	}

	async redeemResetCredit(target: ResetCreditTarget, signal?: AbortSignal): Promise<ResetCreditRedeemOutcome> {
		return this.#modelRegistry.authStorage.redeemResetCredit({
			target,
			baseUrlResolver: provider => this.#modelRegistry.getProviderBaseUrl?.(provider),
			signal,
		});
	}

	async listResetCredits(signal?: AbortSignal): Promise<ResetCreditAccountStatus[]> {
		return this.#modelRegistry.authStorage.listResetCredits({
			sessionId: this.sessionId,
			baseUrlResolver: provider => this.#modelRegistry.getProviderBaseUrl?.(provider),
			signal,
		});
	}
	async #confirmCodexAutoRedeem(decision: CodexAutoRedeemRedeemDecision): Promise<boolean> {
		const runner = this.#extensionRunner;
		if (!runner?.hasUI()) {
			this.emitNotice(
				"warning",
				"Codex saved reset is eligible, but auto-redeem is unset and no prompt UI is available. Run `/usage reset` or set codexResets.autoRedeem.",
				"codex-auto-reset",
			);
			return false;
		}

		const who = decision.target.email ?? decision.target.accountId ?? "the active account";
		const resetLabel = decision.availableCount === 1 ? "reset" : "resets";
		try {
			const choice = await runner
				.getUIContext()
				.select(
					`Do you wanna redeem your reset?\n${who} is blocked by the weekly Codex limit for about ${formatDuration(decision.remainingMs)}. Spend 1 of ${decision.availableCount} saved ${resetLabel}?`,
					[
						{
							label: "Yes",
							description: "Redeem now and remember yes for future eligible Codex weekly blocks.",
						},
						{
							label: "No",
							description: "Do not auto-redeem saved Codex resets.",
						},
					],
				);
			if (choice === "Yes") {
				this.settings.set("codexResets.autoRedeem", "yes");
				return true;
			}
			if (choice === "No") {
				this.settings.set("codexResets.autoRedeem", "no");
			}
		} catch (error) {
			logger.warn("codex-auto-reset prompt failed", { error: errorMessage(error) });
		}
		return false;
	}

	async #maybeAutoRedeemCodexReset(coordinator = defaultCodexAutoRedeemCoordinator): Promise<boolean> {
		const cfg = this.settings.getGroup("codexResets");
		const model = this.model;

		if (!shouldEvaluateCodexAutoRedeem(cfg.autoRedeem) || !model || model.provider !== "openai-codex") return false;
		const authStorage = this.#modelRegistry.authStorage;

		const identity = authStorage.getOAuthAccountIdentity("openai-codex", this.sessionId);
		const accountKey = (identity?.accountId ?? identity?.email)?.trim().toLowerCase();
		if (!accountKey) return false;
		const existing = coordinator.inFlightByAccount.get(accountKey);
		if (existing) return existing;

		const run = (async (): Promise<boolean> => {
			const reports = await this.fetchUsageReports();
			const decision = evaluateCodexAutoRedeem({
				nowMs: Date.now(),
				provider: model.provider,
				modelId: model.id,
				settings: {
					autoRedeem: true,
					minBlockedMinutes: Math.max(0, cfg.minBlockedMinutes),
					keepCredits: Math.max(0, Math.trunc(cfg.keepCredits)),
				},
				identity,
				reports,
				attemptedBlockKeys: coordinator.attemptedBlockKeys,
				lastAttemptAtByAccount: coordinator.lastAttemptAtByAccount,
			});
			if (!decision.redeem) {
				logger.debug("codex-auto-reset: skipped", { reason: decision.reason, account: accountKey });
				return false;
			}
			if (shouldPromptCodexAutoRedeem(cfg.autoRedeem) && !(await this.#confirmCodexAutoRedeem(decision))) {
				return false;
			}

			coordinator.attemptedBlockKeys.add(decision.blockKey);
			coordinator.lastAttemptAtByAccount.set(decision.accountKey, Date.now());
			const who = decision.target.email ?? decision.target.accountId ?? "the active account";

			const outcome = await withScopedTimeoutSignal(15_000, redeemSignal =>
				authStorage.redeemResetCredit({
					target: decision.target,
					baseUrlResolver: provider => this.#modelRegistry.getProviderBaseUrl?.(provider),
					signal: redeemSignal,
				}),
			);
			switch (outcome.code) {
				case "reset": {
					const left = Math.max(0, decision.availableCount - 1);
					this.emitNotice(
						"info",
						`Auto-redeemed a saved Codex rate-limit reset for ${who} (${left} left); retrying now.`,
						"codex-auto-reset",
					);

					this.fetchUsageReports().catch(error => {
						logger.debug("codex-auto-reset: usage refresh after redeem failed", {
							error: errorMessage(error),
						});
					});
					return true;
				}
				case "already_redeemed":
					this.emitNotice(
						"warning",
						"A saved Codex reset was already redeemed elsewhere; waiting for the window.",
						"codex-auto-reset",
					);
					return false;
				case "no_credit":
					logger.debug("codex-auto-reset: no_credit (snapshot/live mismatch)", { account: accountKey });
					return false;
				case "nothing_to_reset":
					this.emitNotice(
						"warning",
						"Codex reset reported nothing to reset; auto-redeem suppressed for this window.",
						"codex-auto-reset",
					);
					return false;
				default:
					this.emitNotice("warning", `Codex auto-redeem failed (${outcome.code}).`, "codex-auto-reset");
					return false;
			}
		})().finally(() => coordinator.inFlightByAccount.delete(accountKey));
		coordinator.inFlightByAccount.set(accountKey, run);
		return run;
	}

	async exportToHtml(outputPath?: string): Promise<string> {
		const { exportSessionToHtml } = await import("../export/html");
		return exportSessionToHtml(this.sessionManager, this.state, {
			outputPath,
			palette: "web",
			obfuscator: this.settings.get("share.redactSecrets") ? this.providerRedactor : undefined,
		});
	}

	getLastAssistantText(): string | undefined {
		const lastAssistant = this.#getLastCopyCandidateAssistantMessage();
		if (!lastAssistant) return undefined;

		let text = "";
		for (const content of lastAssistant.content) {
			if (content.type === "text") {
				text += content.text;
			}
		}

		return text.trim() || undefined;
	}

	hasCopyCandidateAssistantMessage(): boolean {
		return this.#getLastCopyCandidateAssistantMessage() !== undefined;
	}

	#getLastCopyCandidateAssistantMessage(): AssistantMessage | undefined {
		for (let i = this.messages.length - 1; i >= 0; i--) {
			const message = this.messages[i];
			if (message.role !== "assistant") continue;

			const assistantMessage = message as AssistantMessage;
			if (assistantMessage.stopReason === "aborted" && assistantMessage.content.length === 0) continue;

			return assistantMessage;
		}

		return undefined;
	}

	getLastVisibleHandoffText(): string | undefined {
		for (let i = this.messages.length - 1; i >= 0; i--) {
			const message = this.messages[i];
			if (message.role !== "custom") continue;

			const customMessage = message as CustomMessage;
			if (customMessage.customType !== "handoff" || !customMessage.display) continue;

			if (typeof customMessage.content === "string") {
				return customMessage.content.trim() || undefined;
			}

			let text = "";
			for (const content of customMessage.content) {
				if (content.type === "text") {
					text += content.text;
				}
			}
			return text.trim() || undefined;
		}

		return undefined;
	}

	formatSessionAsText(): string {
		const activeModel = this.model;
		return formatSessionDumpText({
			messages: this.messages,
			systemPrompt: this.agent.state.systemPrompt,
			model: this.agent.state.model,
			thinkingLevel: this.#thinkingLevel,
			tools: this.agent.state.tools,
			inlineToolDescriptors: activeModel ? this.#resolvePruneToolDescriptions(activeModel) : false,
		});
	}

	async dumpLlmRequestToTmpDir(): Promise<string | undefined> {
		const messages = this.messages;
		if (messages.length === 0) return undefined;
		const llmMessages = await this.convertMessagesToLlm(messages);
		const payload = {
			model: this.agent.state.model ?? null,
			thinkingLevel: this.#thinkingLevel ?? null,
			serviceTier: this.#serviceTierEntry(),
			systemPrompt: this.agent.state.systemPrompt,
			tools: this.agent.state.tools.map(tool => ({
				name: tool.name,
				description: tool.description,
				parameters: toolWireSchema(tool),
				...(tool.strict !== undefined ? { strict: tool.strict } : {}),
				...(tool.customWireName ? { customWireName: tool.customWireName } : {}),
			})),
			messages: llmMessages,
		};
		const filePath = path.join(os.tmpdir(), `veyyon-llm-request-${Snowflake.next()}.json`);
		await Bun.write(filePath, `${JSON.stringify(payload, null, 2)}\n`);
		return filePath;
	}

	setAdvisorEnabled(enabled: boolean): boolean {
		this.#advisorEnabled = enabled;
		if (enabled) {
			if (this.#advisors.length > 0 && !this.#advisorRuntimeMatchesCurrentConfig()) this.#stopAdvisorRuntime();
			return this.#buildAdvisorRuntime(true);
		}
		this.#stopAdvisorRuntime();
		return false;
	}

	toggleAdvisorEnabled(): boolean {
		return this.setAdvisorEnabled(!this.#advisorEnabled);
	}

	applyAdvisorConfigs(advisors: AdvisorConfig[], sharedInstructions: string | undefined): number {
		this.#advisorConfigs = advisors;
		this.#advisorSharedInstructions = sharedInstructions;
		if (!this.#advisorEnabled) return 0;
		this.#stopAdvisorRuntime();
		this.#buildAdvisorRuntime(true);
		return this.#advisors.length;
	}

	isAdvisorEnabled(): boolean {
		return this.#advisorEnabled;
	}

	isAdvisorActive(): boolean {
		return this.#advisors.length > 0;
	}

	getAdvisorAvailableToolNames(): string[] {
		return (this.#advisorTools ?? []).map(tool => tool.name);
	}

	getAdvisorAgent(): Agent | undefined {
		return this.#advisors[0]?.agent;
	}

	getAdvisorStats(): AdvisorStats {
		const configured = this.#advisorEnabled;
		const advisors = this.#advisors.map(a => this.#computeAdvisorStat(a));
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

	#computeAdvisorStat(advisor: ActiveAdvisor): PerAdvisorStat {
		const model = advisor.agent.state.model;
		const messages = advisor.agent.state.messages;
		const contextTokens = this.#estimateAdvisorContextTokens(messages);
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

	formatAdvisorStatus(): string {
		const stats = this.getAdvisorStats();
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

	#estimateAdvisorContextTokens(messages: AgentMessage[]): number {
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

	formatAdvisorHistoryAsText(options?: { compact?: boolean }): string | null {
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

	hasExtensionHandlers(eventType: string): boolean {
		return this.#extensionRunner?.hasHandlers(eventType) ?? false;
	}

	get extensionRunner(): ExtensionRunner | undefined {
		return this.#extensionRunner;
	}
}
