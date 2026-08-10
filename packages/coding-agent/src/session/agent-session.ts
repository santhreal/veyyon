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
	stripLegacyArchive,
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
	deriveClaudeDeviceId,
	isUsageLimitOutcome,
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
import { Patch } from "@veyyon/hashline";
import { MacOSPowerAssertion } from "@veyyon/natives";
import {
	errorMessage,
	escapeXmlText,
	extractHttpStatusFromError,
	extractRetryHint,
	formatCount,
	formatDuration,
	getActiveAuthDbPath,
	getInstallId,
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
import { ArgotStreamDisplayDecoder, expandAssistantContent, expandSessionContext } from "../argot-wire";
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
// The owning modules, not the `../edit` barrel. The barrel `export *`s the streaming applier, the
// hashline engine and the EditTool, and owns 44 modules nothing else here reaches; these six
// symbols live in four leaves that reach a handful between them.
import { normalizeDiff, ParseError } from "../edit/diff";
import { getFileSnapshotStore } from "../edit/file-snapshot-store";
import { expandApplyPatchToEntries } from "../edit/modes/apply-patch";
import { previewPatch } from "../edit/modes/patch";
import { normalizeToLF, stripBom } from "../edit/normalize";
import { executePython as executePythonCommand, type PythonResult } from "../eval/py/executor";
// The leaf, not `../eval/py`: that module declares the Python backend descriptor and reaches
// hundreds of modules, and all this needs is the id prefix.
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
import type { Goal, GoalModeState } from "../goals/state";
import type { HindsightSessionState } from "../hindsight/state";
// The owning module, not the `../internal-urls` barrel: the barrel re-exports every protocol
// handler and reaches several hundred modules, and all three of these live in `local-protocol`,
// which reaches seven.
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
import { theme } from "../modes/theme/theme-binding";
import { containsUltrathink, ULTRATHINK_NOTICE } from "../modes/ultrathink-keyword";
import { containsWorkflow, renderWorkflowNotice } from "../modes/workflow-keyword";
import { resolveApprovedPlan } from "../plan-mode/approved-plan";
import { DEFAULT_PLAN_FILE_URL } from "../plan-mode/plan-file-url";
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
import { transformProviderPayload } from "../provider-boundary";
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
import { resolveEffectiveApprovalMode, validateApprovalModeSetting } from "../tools/approval";
import type { ApprovalMode, SessionToolApprovals } from "../tools/approval-modes";
import { assertEditableFile } from "../tools/auto-generated-guard";
import { normalizeToolNames, TOOL } from "../tools/builtin-names";
import type { CheckpointState, CompletedRewindState } from "../tools/checkpoint";
import { reportLostOutputArtifact } from "../tools/output-artifact";
import { outputMeta, wrapToolWithMetaNotice } from "../tools/output-meta";
import { normalizeLocalScheme, resolveToCwd } from "../tools/path-utils";
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
import { generateSessionTitle } from "../utils/title-generator";
import { buildNamedToolChoice, isToolChoiceActive } from "../utils/tool-choice";
import type { VibeModeState } from "../vibe/state";
import type { AuthStorage } from "./auth-storage";
import type { ClientBridge, ClientBridgePermissionOption, ClientBridgePermissionOutcome } from "./client-bridge";
import {
	type CodexAutoRedeemRedeemDecision,
	defaultCodexAutoRedeemCoordinator,
	evaluateCodexAutoRedeem,
	shouldEvaluateCodexAutoRedeem,
	shouldPromptCodexAutoRedeem,
} from "./codex-auto-reset";
import { CommitDriftTracker } from "./commit-drift";
import { findCompactMode } from "./compact-modes";
import { type ContentBlockLike, contentText } from "./content-text";
// The accounting, not the drawing. Both of these used to be imported from `modes/`, which put the
// terminal UI on the session engine's graph and cost the layering gate a standing exception each.
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
	readQueueChipText,
	SILENT_ABORT_MARKER,
	SKILL_PROMPT_MESSAGE_TYPE,
	stripImagesFromMessage,
	USER_INTERRUPT_LABEL,
} from "./messages";
import { OperatorNotices, stderrNoticeSink } from "./operator-notices";
import { disposeOwnedResources } from "./owned-resources";
import { ProviderContextCanonicalizer } from "./provider-context-canonicalizer";
import { normalizeRoots } from "./relativize-paths";
import { describeRetryPolicySource, type ResolvedRetryPolicy, resolveRetryPolicy } from "./retry-policy";
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
import { incompleteTodoItems, renderTodoContinuationReminder, todoReminderFingerprint } from "./todo-reminder";
import { ToolChoiceQueue } from "./tool-choice-queue";
import { parseTurnBudgetDirective } from "./turn-budget";
import { planTurnPersistence, sameMessageContent, sessionMessagePersistenceKey } from "./turn-persistence";
import { classifyUnexpectedStop, isUnexpectedStopCandidate } from "./unexpected-stop-classifier";
import { VERIFICATION_EVIDENCE_REMINDER_TYPE, VerificationEvidenceLedger } from "./verification-evidence-ledger";
import { YieldQueue } from "./yield-queue";

const SESSION_STOP_CONTINUATION_CAP = 8;
const PLAN_MODE_REMINDER_MAX = 3;
const PLAN_DECISION_TOOLS = new Set<string>([TOOL.ask, TOOL.resolve]);

/**
 * Mutating tool results (`bash`/`eval`/`edit`/`write`/`ast_edit`) without the
 * agent touching the `todo` tool that trip the mid-run reconciliation nudge.
 * Read-only exploration (grep/read/glob/lsp) never ticks this: an agent
 * researching for a long stretch has nothing to flip. Picked so a normal
 * fix-verify loop (~3-6 mutations) never sees the nudge, but a sustained run
 * of landed work without flipping any todos does. Without this nudge, long
 * runs drive the live todo HUD to `0/N` until the final stop, then batch-flip
 * to `N/N` (issue #3651).
 */
const MID_RUN_TODO_NUDGE_MUTATION_THRESHOLD = 12;
/** Mid-run nudges per prompt cycle. Deliberately tighter than
 *  `todo.reminders.max` (the stop-time budget): this is a gentle hidden hint,
 *  not an escalation ladder. */
const MID_RUN_TODO_NUDGE_MAX_PER_CYCLE = 2;
/** Tool results that count as landed work for the mid-run todo nudge. */
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
	detail: SessionTelemetryDetail;
	storedMessagesTokens?: number;
	tailTokens?: number;
	compactionEntryId?: string;
}

/** `customType` for the hidden mid-run todo nudge; `display: false`, so it reaches
 *  the model but never renders in the TUI or transcript. */
const MID_RUN_TODO_NUDGE_MESSAGE_TYPE = "mid-run-todo-nudge";
/**
 * Custom-message type carrying the memory backend's volatile context (recalled
 * memories, mental models) at the TAIL of the conversation.
 *
 * It used to ride in the system prompt, which is the provider's cache prefix, so
 * every recall and every mental-model reload made the next request re-read the
 * whole conversation as uncached input. Same information, same place in the
 * model's reading order, no prefix invalidation.
 */
const MEMORY_CONTEXT_MESSAGE_TYPE = "memory-context";
/** Hidden plan nudge injected by prewalk; scrubbed from the LLM context
 *  when the switch happens. */
const PREWALK_PLAN_MESSAGE_TYPE = "prewalk-plan";
/** Hidden safety-net nudge forcing one more turn after a text-only reply to
 *  the plan nudge, which would otherwise end the run with no code written. */
const PREWALK_CONTINUE_MESSAGE_TYPE = "prewalk-continue";
/** Hidden "verify before finishing" checklist steered into the run at the
 *  switch, aimed at the fast model's specific failure patterns: partial
 *  multi-site fixes, unnecessarily broad rewrites, and reported-test-only
 *  verification. */
const PREWALK_CHECKLIST_MESSAGE_TYPE = "prewalk-checklist";
/** Tools whose first successful call triggers the switch — once the todo
 *  gate is open (see {@link AgentSession.#prewalkTodoSeen}). Bash is
 *  deliberately excluded: it doubles as exploration (ls/cat) and fired
 *  turn-1 switches in practice. `todo` is deliberately NOT a trigger: firing
 *  at the todo init handed the fast model 100% of the implementation with
 *  zero started work and measurably regressed pass rates. */
const PREWALK_ACTION_TOOLS: Record<string, true> = {
	edit: true,
	write: true,
};
/** `customType` for the hidden hand-off message steered to the target model
 *  once PlanYolo auto-approves the plan. Unlike prewalk's plan nudge this
 *  is never scrubbed — it IS the instruction the target model acts on. */
const PLAN_YOLO_HANDOFF_MESSAGE_TYPE = "plan-yolo-handoff";
/** Abort reason for the Gemini reasoning-header runaway interrupt. Surfaced on the
 *  discarded assistant turn only; never reaches the model. */
const GEMINI_HEADER_INTERRUPT_REASON = "Interrupted: emit a tool call instead of more planning";
/** `customType` for the hidden tool-call reminder injected after the interrupt. */
const GEMINI_TOOL_REMINDER_TYPE = "gemini-tool-call-reminder";
/** `customType` for the hidden redirect notice injected into a turn retried after a
 *  thinking/response loop. Steers the model off the repeated content; never displayed. */
const THINKING_LOOP_REDIRECT_TYPE = "thinking-loop-redirect";
const TOOL_CALL_LOOP_REDIRECT_TYPE = "tool-call-loop-redirect";

function customMessageContentText(content: string | (TextContent | ImageContent)[]): string {
	if (typeof content === "string") return content;
	const parts: string[] = [];
	for (const part of content) {
		if (part.type === "text") parts.push(part.text);
	}
	return parts.join("\n");
}

function stringProperty(value: object, key: string): string | undefined {
	const field = Object.getOwnPropertyDescriptor(value, key)?.value;
	return typeof field === "string" ? field : undefined;
}

function reportFromRewindReportContent(content: string): string {
	const marker = "\nReport:\n";
	const index = content.lastIndexOf(marker);
	const report = index >= 0 ? content.slice(index + marker.length) : content;
	return report.trim();
}

function completedRewindFromEntry(entry: SessionEntry): CompletedRewindState | undefined {
	if (entry.type !== "custom_message" || entry.customType !== "rewind-report") return undefined;
	const details = entry.details;
	if (!details || typeof details !== "object") return undefined;
	const startedAt = stringProperty(details, "startedAt");
	const rewoundAt = stringProperty(details, "rewoundAt");
	if (!startedAt || !rewoundAt) return undefined;
	const report =
		stringProperty(details, "report")?.trim() ||
		reportFromRewindReportContent(customMessageContentText(entry.content));
	return report.length > 0 ? { report, startedAt, rewoundAt } : undefined;
}

function isSuccessfulCheckpointEntry(entry: SessionEntry): entry is SessionMessageEntry & {
	message: { role: "toolResult"; toolName: "checkpoint"; isError?: false };
} {
	return (
		entry.type === "message" &&
		entry.message.role === "toolResult" &&
		entry.message.toolName === TOOL.checkpoint &&
		entry.message.isError !== true
	);
}

function checkpointStartedAtFromEntry(entry: SessionEntry): string | undefined {
	if (!isSuccessfulCheckpointEntry(entry)) return undefined;
	const details = entry.message.details;
	if (details && typeof details === "object") {
		const startedAt = stringProperty(details, "startedAt");
		if (startedAt) return startedAt;
	}
	return entry.timestamp;
}

// A side-channel assistant response is signed for the hidden prompt/history that
// produced it. If we persist that response under a different user turn, native
// replay anchors become invalid; keep only visible, non-cryptographic content.
function sanitizeAssistantForReparentedHistory(message: AssistantMessage): AssistantMessage {
	const content: AssistantMessage["content"] = [];
	for (const block of message.content) {
		if (block.type === "redactedThinking") continue;
		if (block.type === "thinking") {
			content.push({ type: "thinking", thinking: block.thinking });
			continue;
		}
		content.push(block);
	}
	return { ...message, content, providerPayload: undefined };
}

/** Session-specific events that extend the core AgentEvent */
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
			/** True when compaction was skipped for a benign reason (no model, no candidates, nothing to compact). */
			skipped?: boolean;
	  }
	| {
			type: "auto_retry_start";
			attempt: number;
			maxAttempts: number;
			delayMs: number;
			errorMessage: string;
			errorId?: number;
			/**
			 * Why this attempt budget applies, when it is not simply the global
			 * setting (e.g. `cursor provider default`). Shown to the user so a
			 * limit they never configured is explainable rather than mysterious.
			 */
			policySource?: string;
	  }
	| {
			type: "auto_retry_end";
			success: boolean;
			attempt: number;
			finalError?: string;
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
			/** The user-configured selector when it differs from the effective level (e.g. `auto`). */
			configured?: ConfiguredThinkingLevel;
			/** The level `auto` resolved to this turn, once classified. */
			resolved?: Effort;
	  }
	| { type: "goal_updated"; goal: Goal | null; state?: GoalModeState }
	| { type: "cwd_changed"; previous: string; cwd: string };
/** Listener function for agent session events */
export type AgentSessionEventListener = (event: AgentSessionEvent) => void;

const UNEXPECTED_STOP_MAX_RETRIES = 3;
const UNEXPECTED_STOP_TIMEOUT_MS = 4000;
const EMPTY_STOP_MAX_RETRIES = 3;
const RETRY_BACKOFF_MAX_DELAY_MS = 8_000;
/**
 * Budget for callers on the user-visible `/quit` / `/exit` shutdown path that
 * want to cap how long they wait for `MnemopiSessionState.dispose()` to finish
 * its consolidate pass. Consolidate fires fresh LLM fact extractions, each a
 * 1–3 s round-trip, so interactive shutdown passes this budget to keep the
 * UI responsive. Callers that keep the process/session host alive must omit it
 * so dispose still awaits the full consolidate-then-close pipeline.
 */
export const SHUTDOWN_CONSOLIDATE_BUDGET_MS = 1_500;

export interface AgentSessionDisposeOptions {
	mnemopiConsolidateTimeoutMs?: number;
	/**
	 * Postmortem reason that triggered this dispose (signal/fatal teardown
	 * paths). When set, the persisted `session_exit` diagnostic records it
	 * instead of the generic `"dispose"` used for normal programmatic disposal
	 * (`/quit`, test teardown, subagent completion).
	 */
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
function declaredContextWindow(model: Model | undefined): number | undefined {
	const contextWindow = model?.contextWindow;
	return typeof contextWindow === "number" && contextWindow > 0 ? contextWindow : undefined;
}

function createCodexCompactionContext(options: {
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

const PROMPT_AFFECTING_SETTING_PATHS: Readonly<Record<string, true>> = {
	"async.enabled": true,
	"subagent.enabled": true,
	"subagent.batch": true,
	"subagent.agents": true,
	"subagent.delegation": true,
	"subagent.isolation.mode": true,
	"subagent.maxConcurrency": true,
	"subagent.maxNestedSpawnDepth": true,
};

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
 * Anthropic prompt-cache TTL: "long" retention (the OAuth default) is 1h, or a
 * still-warm prefix is busted by the flush. 90 min leaves margin over the 1h TTL.
 */
const PRUNE_IDLE_FLUSH_MS = 90 * 60_000;
/**
 * How long a headless `shutdown()` waits for `dispose()` to flush before it
 * exits anyway. Long enough for a session-log write, short enough that a wedged
 * teardown cannot strand the caller.
 */
const SHUTDOWN_DISPOSE_TIMEOUT_MS = 5_000;
export type CommandMetadataChangedListener = () => void | Promise<void>;
export type AsyncJobSnapshotItem = Pick<AsyncJob, "id" | "type" | "status" | "label" | "startTime">;

const RETRY_BACKOFF_JITTER_RATIO = 0.25;
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
const COMPACTION_RECOVERY_BAND = 0.8;

function calculateRetryBackoffDelayMs(baseDelayMs: number, attempt: number): number {
	const cappedDelayMs = Math.min(Math.max(0, baseDelayMs) * 2 ** Math.max(0, attempt - 1), RETRY_BACKOFF_MAX_DELAY_MS);
	const jitter = 1 - Math.random() * RETRY_BACKOFF_JITTER_RATIO;
	return cappedDelayMs * jitter;
}

/**
 * Slack added past a sibling credential's block expiry before retrying, so
 * the next getApiKey lands after the block has actually lapsed.
 */
const SIBLING_UNBLOCK_BUFFER_MS = 1_000;
const NON_WHITESPACE_RE = /\S/;

function hasNonWhitespace(value: string): boolean {
	return NON_WHITESPACE_RE.test(value);
}

export interface AsyncJobSnapshot {
	running: AsyncJobSnapshotItem[];
	recent: AsyncJobSnapshotItem[];
	delivery: AsyncJobDeliveryState;
}

export type { ShakeMode, ShakeResult };
/**
 * Prewalk: switches an active session one-way from its starting model to
 * a fast/cheap `target` at the first completed turn that runs an edit/write
 * tool once the todo list exists. A hidden plan nudge asks the starting
 * model to write a plan, initialize its todo list from it, and start; the
 * todo call opens the trigger gate (it never fires the switch itself), so
 * the starting model always begins the implementation. A hidden
 * checklist nudge asks the target model to verify its work before
 * finishing. Both are always on — this is the one mechanism that won out
 * over turn-count and ungated variants in testing.
 */
export interface Prewalk {
	target: Model;
	thinkingLevel?: ConfiguredThinkingLevel;
}

/**
 * PlanYolo: forces the session into read-only plan mode at start, then
 * auto-approves the plan the instant the model calls `resolve({ action:
 * "apply" })` for it — no interactive review — and switches to a fast/cheap
 * `target` model to implement it. The headless counterpart to interactive
 * plan mode's "Approve and execute", for print/non-interactive runs where
 * there is no one to click Approve.
 */
export interface PlanYolo {
	target: Model;
	thinkingLevel?: ConfiguredThinkingLevel;
}

// ============================================================================
// Types
// ============================================================================

/**
 * Immutable authority admitted for one provider request.
 *
 * Expansion and redaction intentionally travel together in one snapshot: a
 * later disable/re-scope may replace the session's live runtime, but it cannot
 * change what an already-admitted request uses after an async hook resumes.
 */
export interface SecretRuntimeLease {
	readonly revision: number;
	readonly cwd: string;
	/** Live expansion authority. Undefined when expansion is disabled. */
	readonly expansionObfuscator: SecretObfuscator | undefined;
	/**
	 * Redaction-only authority, which outlives expansion.
	 *
	 * This is a different object from `expansionObfuscator` and outlives it on
	 * purpose: a disable or a cwd move off the vault ends expansion while the
	 * redaction tombstones stay, so a value the model has already seen as a
	 * placeholder can never travel back to a provider as plaintext. Prefer the
	 * `obfuscate*` closures below; this object is exposed for the few consumers
	 * that hold a redactor themselves rather than calling through the lease.
	 */
	readonly redactionObfuscator: SecretObfuscator | undefined;
	/** True when the redaction-only authority still carries live values or tombstones. */
	readonly hasRedactions: boolean;
	obfuscateText(text: string): string;
	obfuscateMessages(messages: Message[]): Message[];
	obfuscateContext(context: Context): Context;
	obfuscatePayload(payload: unknown): unknown;
	/**
	 * Whether expansion may proceed against the captured vault revision, without
	 * side effects. True when nothing needs expanding, or when the captured
	 * revision is still current. Pass the payload for the payload-aware answer:
	 * text with no live placeholder is always fresh, because expanding it could
	 * not change a byte. NEVER throws and NEVER schedules work, so a render path
	 * can consult it and degrade.
	 */
	isFreshForExpansion(text?: string): boolean;
	/**
	 * Refresh a stale runtime and resolve once expansion may proceed.
	 *
	 * A stale captured revision is a cache miss, not a security event: the
	 * recovery is to re-read the vault, which is what this awaits. Resolves
	 * immediately when `text` carries no live placeholder or the revision is
	 * current. Rejects ONLY when a refresh was attempted, genuinely failed, and
	 * `text` carries a live placeholder.
	 */
	ensureFreshForExpansion(text?: string): Promise<void>;
	/**
	 * Synchronously assert that named expansion is still backed by the captured
	 * vault revision, for a SPEND: text about to be expanded and handed to a
	 * tool, a command, or the provider. Silent for any payload without a live
	 * placeholder. Prefer {@link SecretRuntimeLease.ensureFreshForExpansion}
	 * wherever an await is possible, and NEVER call this from a display or render
	 * path: an exception there unwinds the renderer instead of failing one
	 * operation.
	 */
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
	/** Whether the caller explicitly requested yolo/auto-approve behavior for this session. */
	autoApprove?: boolean;
	/**
	 * Start the session with the full permission bypass on (the
	 * `--dangerously-skip-permissions` launch flag). Stronger than `autoApprove`:
	 * removes every prompt including per-tool `prompt` overrides, but explicit
	 * `deny` and plan mode still block. Toggle at runtime with `/yolo`.
	 */
	bypassAllApprovals?: boolean;
	/**
	 * A subagent's live view of its parent's bypass. The child's own
	 * `bypassAllApprovals` is a snapshot taken at spawn, so without this a parent
	 * that revokes `/yolo` leaves an already-running child bypassing approvals to
	 * the end of its run. Consulted on every check and can only narrow.
	 */
	parentApprovalBypassed?: () => boolean;
	/** Models to cycle through with Ctrl+P (from --models flags). */
	scopedModels?: Array<{
		model: Model;
		thinkingLevel?: ConfiguredThinkingLevel;
		/** True only when this entry carried an explicit `:effort` suffix. */
		explicitThinkingLevel?: boolean;
	}>;
	/** Initial session thinking selector. */
	thinkingLevel?: ConfiguredThinkingLevel;
	/** Origin of the initial selector, used to distinguish a session override from a saved default. */
	thinkingSource?: EffortSource;
	/** Prewalk from the starting model to a fast/cheap target at the first edit/write once the todo list exists. */
	prewalk?: Prewalk;
	/** Force read-only plan mode at start, auto-approve on the model's first
	 *  `resolve` call, then switch to the target to implement. */
	planYolo?: PlanYolo;

	/** Initial per-family service tiers (OpenAI / Anthropic / Google) for the live session. */
	serviceTierByFamily?: ServiceTierByFamily;
	/** Prompt templates for expansion */
	promptTemplates?: PromptTemplate[];
	/** File-based slash commands for expansion */
	slashCommands?: FileSlashCommand[];
	/** Extension runner (created in main.ts with wrapped tools) */
	extensionRunner?: ExtensionRunner;
	/** Loaded skills (already discovered by SDK) */
	skills?: Skill[];
	/**
	 * Channel for non-fatal problems the operator must see.
	 *
	 * Replaces the old `skillWarnings` array, which was collected, threaded through here, and
	 * exposed as a getter that no production code read: skill-loading problems were discarded in
	 * silence while the field made it look as though somebody was showing them. Skill warnings now
	 * arrive here as notices with `source: "skills"`, alongside everything else that needs saying.
	 */
	operatorNotices?: OperatorNotices;
	/** Custom commands (TypeScript slash commands) */
	customCommands?: LoadedCustomCommand[];
	skillsSettings?: SkillsSettings;
	/** Model registry for API key resolution and model discovery */
	modelRegistry: ModelRegistry;
	/** Tool registry for LSP and settings */
	toolRegistry?: Map<string, AgentTool>;
	/** Creates the tools registered only while `/vibe` mode is active. */
	createVibeTools?: () => AgentTool[];
	/** Tool names whose current registry entry is still the built-in implementation. */
	builtInToolNames?: Iterable<string>;
	/** Update tool-session predicates that render guidance from the live active tool set. */
	setActiveToolNames?: (names: Iterable<string>) => void;
	/** Current session pre-LLM message transform pipeline */
	transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => AgentMessage[] | Promise<AgentMessage[]>;
	/**
	 * Per-request transform applied after `convertToLlm` and before the
	 * provider call. Used for secret obfuscation and image
	 * clamping. When supplied via {@link createAgentSession}, the advisor agent
	 * inherits this so its requests undergo the same shaping as the main turn.
	 */
	transformProviderContext?: (
		context: Context,
		model: Model,
		runtime?: SecretRuntimeLease,
	) => Context | Promise<Context>;
	/**
	 * Stream wrapper passed to side-channel requests (`/btw`, `/omfg`, IRC
	 * auto-replies, and handoff generation) so they apply the same provider
	 * shaping and host-level request wrappers as normal agent turns. Defaults
	 * to plain `streamSimple` when omitted.
	 */
	sideStreamFn?: StreamFn;
	/**
	 * Stream wrapper passed to the advisor agent so its requests apply the
	 * session's `providers.openrouterVariant`, `providers.antigravityEndpoint`,
	 * `providers.maxInFlightRequests`, and `model.loopGuard.*` settings —
	 * keeping OpenRouter sticky-routing / response caching consistent with the
	 * main agent. Defaults to plain `streamSimple` when omitted.
	 */
	advisorStreamFn?: StreamFn;
	/** Hint that OpenAI Codex requests should prefer websocket transport when supported. */
	preferWebsockets?: boolean;
	/** Provider payload hook used by the active session request path */
	onPayload?: SimpleStreamOptions["onPayload"];
	/** Provider response hook used by the active session request path */
	onResponse?: SimpleStreamOptions["onResponse"];
	/** Raw SSE hook used by the active session request path */
	onSseEvent?: SimpleStreamOptions["onSseEvent"];
	/** Per-session raw SSE diagnostic buffer */
	rawSseDebugBuffer?: RawSseDebugBuffer;
	/** Current session message-to-LLM conversion pipeline */
	convertToLlm?: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
	/** System prompt builder that can consider tool availability. Returns ordered provider-facing blocks. */
	rebuildSystemPrompt?: (toolNames: string[], tools: Map<string, AgentTool>) => Promise<{ systemPrompt: string[] }>;
	/** Local calendar date provider used by prompt-cache invalidation. Defaults to the host local date. */
	getLocalCalendarDate?: () => string;
	/** Rebuild the SSH tool from current capability discovery results. */
	reloadSshTool?: () => Promise<AgentTool | null>;
	requestedToolNames?: ReadonlySet<string>;
	/**
	 * Optional accessor for live MCP server instructions. Read by the session's
	 * `rebuildSystemPrompt`-skip optimization to detect server-side instruction
	 * changes (e.g. an MCP server upgrade) that would otherwise pass the tool-set
	 * signature comparison and silently keep a stale prompt cached.
	 */
	getMcpServerInstructions?: () => Map<string, string> | undefined;
	/** Enable hidden-by-default MCP tool discovery for this session. */
	mcpDiscoveryEnabled?: boolean;
	/** MCP tool names to activate for the current session when discovery mode is enabled. */
	initialSelectedMCPToolNames?: string[];
	/** Whether constructor-provided MCP defaults should be persisted immediately. */
	persistInitialMCPToolSelection?: boolean;
	/** MCP server names whose tools should seed discovery-mode sessions whenever those servers are connected. */
	defaultSelectedMCPServerNames?: string[];
	/** MCP tool names that should seed brand-new sessions created from this AgentSession. */
	defaultSelectedMCPToolNames?: string[];
	/** TTSR manager for time-traveling stream rules */
	ttsrManager?: TtsrManager;
	/** Secret obfuscator for deobfuscating streaming edit content */
	obfuscator?: SecretObfuscator;
	/** Initial immutable SDK runtime snapshot. Supersedes `obfuscator` when present. */
	secretRuntime?: SecretRuntimeLease;
	/** Await the latest winning runtime before admitting one provider request. */
	leaseSecretRuntime?: () => Promise<SecretRuntimeLease>;
	/** Recover the lease attached by the SDK to a provider context. */
	resolveSecretRuntimeLeaseForContext?: (context: Context) => SecretRuntimeLease | undefined;
	/**
	 * Reload and atomically replace the complete secret runtime for a cwd.
	 * The SDK owns config/env/vault loading; the session owns when lifecycle changes require it.
	 */
	refreshSecretRuntime?: (cwd: string) => Promise<SecretRuntimeLease | SecretObfuscator | undefined>;
	/** Argot shorthand codec (experimental); expands handles before display/tools. */
	argot?: ArgotSession;
	/** Inherited eval executor session id from a parent agent. */
	parentEvalSessionId?: string;
	/** Logical owner for retained eval kernels created by this session. */
	evalKernelOwnerId?: string;
	/**
	 * AsyncJobManager that this session installed as the process-global instance.
	 * Only set for top-level sessions; subagents inherit the parent's manager and
	 * **MUST NOT** dispose it on their own teardown.
	 */
	ownedAsyncJobManager?: AsyncJobManager;
	/**
	 * Whether this session was spawned by another session in the SAME process.
	 *
	 * Set from `isSubagentSession` in `sdk.ts`, which is the one owner of that
	 * question. It governs re-rooting: a subagent shares the process with its
	 * parent and its siblings, so moving its working directory must not move
	 * theirs. See {@link AgentSession.rescopeToCwd}. Default false, which is the
	 * safe reading for an embedder that builds a session directly: a session with
	 * nobody above it owns the process.
	 */
	isSubagent?: boolean;
	/**
	 * AsyncJobManager reachable by this session for scoped job actions.
	 *
	 * Top-level owners receive their own manager, subagents receive the inherited
	 * parent manager, and secondary in-process top-level sessions receive
	 * `undefined` so job snapshots and ACP drains cannot observe the primary's
	 * state.
	 */
	asyncJobManager?: AsyncJobManager;
	/** Agent identity (registry id like "Main" or "Alice") used for IRC routing. */
	agentId?: string;
	/** Whether this session is the top-level agent or a subagent. Drives eager-task
	 *  prelude gating so a top-level session created with a custom `agentId` still
	 *  receives the always-mode reminder. Defaults to "main". */
	agentKind?: "main" | "sub";
	/**
	 * Override the provider-facing session ID for all API requests from this session.
	 * When absent, `sessionManager.getSessionId()` is used. Needed when benchmark or
	 * SDK callers issue probes / prewarming with an explicit `--provider-session-id`
	 * so that credential sticky selection is consistent with the session's streaming calls.
	 */
	providerSessionId?: string;
	/** Marks `agent.promptCacheKey` as fork-inherited so incompatible route changes can clear it. */
	providerPromptCacheKeySource?: "explicit" | "fork";
	/**
	 * Full advisor toolset, pre-built in `createAgentSession` against a distinct,
	 * advisor-scoped `ToolSession` (its own `-advisor` session/agent id) so the
	 * advisor's tool state stays isolated from the primary. The advisor is a full
	 * agent; its config `tools` selects a subset (default read/grep/glob). Undefined
	 * when the advisor is disabled.
	 */
	advisorTools?: AgentTool[];
	/** Preloaded watchdog prompt content for the advisor. */
	advisorWatchdogPrompt?: string;
	/** Preloaded YAML top-level `instructions` shared baseline, kept separate from
	 *  `advisorWatchdogPrompt` so `/advisor configure` can swap it live. */
	advisorSharedInstructions?: string;
	/**
	 * Preloaded project context files (AGENTS.md, etc.) rendered as a system-prompt
	 * block for the advisor — the same standing instructions the primary agent
	 * receives, so the reviewer holds the agent to them.
	 */
	advisorContextPrompt?: string;
	/**
	 * Advisors discovered from `WATCHDOG.yml`. Empty/undefined runs a single
	 * legacy advisor on the `advisor` role (byte-for-byte the pre-config path).
	 */
	advisorConfigs?: AdvisorConfig[];
	/**
	 * Strip tool descriptions from provider-bound tool specs on side requests
	 * (handoff). A resolver follows the active model so session dumps and side
	 * requests use the same descriptor placement as the rebuilt system prompt.
	 */
	pruneToolDescriptions?: boolean | ((model: Model) => boolean);
	/**
	 * Disconnect this session's OWNED MCP manager on dispose. Provided only when
	 * the session created the manager (top-level sessions); subagents reuse a
	 * parent's manager via `options.mcpManager` and omit this so a child's
	 * teardown never tears down the shared servers.
	 */
	disconnectOwnedMcpManager?: () => Promise<void>;
	/**
	 * Override the bundled system prompt used by automatic session-title
	 * generation paths (initial title + replan refresh). Source-of-truth is
	 * `TITLE_SYSTEM.md` discovered via {@link discoverTitleSystemPromptFile} and
	 * resolved through {@link resolvePromptInput}; refresh after a `/move`-style
	 * cwd change via {@link AgentSession.setTitleSystemPrompt}.
	 */
	titleSystemPrompt?: string;
}

/** Options for AgentSession.prompt() */
export interface PromptOptions {
	/** Whether to expand file-based prompt templates (default: true) */
	expandPromptTemplates?: boolean;
	/** Image attachments */
	images?: ImageContent[];
	/** When streaming, how to queue the message: "steer" (interrupt) or "followUp" (wait). */
	streamingBehavior?: "steer" | "followUp";
	/** Optional tool choice override for the next LLM call. */
	toolChoice?: ToolChoice;
	/** Send as developer/system message instead of user. Providers that support it use the developer role; others fall back to user. */
	synthetic?: boolean;
	/** Marks this prompt as a deliberate user action (typed message, `.`/`c`
	 *  continue). Clears advisor auto-resume suppression that a user interrupt set.
	 *  Defaults to `!synthetic`; manual-continue is synthetic yet user-initiated, so
	 *  it sets this explicitly. Agent-initiated synthetic prompts (auto-continue,
	 *  plan re-prime, reminders) leave it unset and keep suppression latched. */
	userInitiated?: boolean;
	/** Explicit billing/initiator attribution for the prompt. Defaults to user prompts as `user` and synthetic prompts as `agent`. */
	attribution?: MessageAttribution;
	/** Skip pre-send compaction checks for this prompt (internal use for maintenance flows). */
	skipCompactionCheck?: boolean;
}

/** Options for AgentSession.followUp() */
export interface FollowUpOptions {
	/** Enqueue as a hidden developer message (agent-attributed by default) instead of a user follow-up. */
	synthetic?: boolean;
	/** Whether to expand file-based prompt templates (default: true). */
	expandPromptTemplates?: boolean;
	/** Explicit billing/initiator attribution. Defaults to `agent` for synthetic follow-ups. */
	attribution?: MessageAttribution;
}

/** Result from a handoff operation. */
export interface HandoffResult {
	document: string;
	savedPath?: string;
}

export interface SessionHandoffOptions {
	autoTriggered?: boolean;
	signal?: AbortSignal;
	onSwitchCancelled?: () => void;
}

/** Result from cycleModel() */
export interface ModelCycleResult {
	model: Model;
	thinkingLevel: ThinkingLevel | undefined;
	/** Whether cycling through scoped models (--models flag) or all available */
	isScoped: boolean;
}

/** Result from cycleRoleModels() */
export interface RoleModelCycleResult {
	model: Model;
	thinkingLevel: ThinkingLevel | undefined;
	role: string;
}

/** A configured role resolved to a concrete model, used by role cycling and
 *  the plan-approval model slider. */
export interface ResolvedRoleModel {
	role: string;
	model: Model;
	thinkingLevel?: ConfiguredThinkingLevel;
	explicitThinkingLevel: boolean;
}

/** The set of resolvable role models plus the index of the currently active
 *  one within {@link ResolvedRoleModel.role} order. */
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

/** Session statistics for /session command */
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
 * per-advisor emission guard and identity. The session holds an array of these;
 * primary-scoped state (turn counters, interrupt latches, the shared yield
 * channel) stays on the session.
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

export interface FreshSessionResult {
	previousSessionId: string;
	sessionId: string;
	closedProviderSessions: number;
}

/** Internal marker for hook messages queued through the agent loop */
// ============================================================================
// Constants
// ============================================================================

/** Standard thinking levels */

/** `retry.fallbackChains` config: chain key (role name or model selector) → ordered fallback selectors. */
type RetryFallbackChains = Record<string, string[]>;

type RetryFallbackRevertPolicy = "never" | "cooldown-expiry";

interface RetryFallbackSelector {
	raw: string;
	provider: string;
	id: string;
	thinkingLevel: ThinkingLevel | undefined;
}

interface ActiveRetryFallbackState {
	/** Chain key that produced this fallback: a model-role name or a model-selector key. */
	role: string;
	originalSelector: string;
	originalThinkingLevel: ConfiguredThinkingLevel | undefined;
	lastAppliedFallbackThinkingLevel: ConfiguredThinkingLevel | undefined;
	pinned: boolean;
}

function parseRetryFallbackSelector(
	selector: string,
	modelLookup?: { find(provider: string, id: string): Model | undefined },
): RetryFallbackSelector | undefined {
	const trimmed = selector.trim();
	if (!trimmed) return undefined;
	const parsed = parseModelString(trimmed, {
		allowMaxSuffix: true,
		allowAutoAlias: true,
		isLiteralModelId: (provider, id) => modelLookup?.find(provider, id) !== undefined,
	});
	if (!parsed) return undefined;
	return {
		raw: trimmed,
		provider: parsed.provider,
		id: parsed.id,
		thinkingLevel: concreteThinkingLevel(parsed.thinkingLevel),
	};
}

/**
 * `retry.fallbackChains` keys are either model-role names (`smol`, `default`)
 * or model selectors (`provider/model-id[:thinking]`). Role names never
 * contain a slash, so its presence marks a model-keyed chain whose primary is
 * the key itself — the chain follows the model across role reassignments.
 */
function isRetryFallbackModelKey(key: string): boolean {
	return key.includes("/");
}

/**
 * A `provider/*` fallback-chain key: matches any active model of that provider,
 * so one entry covers every current and future model behind the provider.
 */
function isRetryFallbackWildcardKey(key: string): boolean {
	return key.endsWith("/*");
}

function formatRetryFallbackSelector(model: Model, thinkingLevel: ThinkingLevel | undefined): string {
	return formatModelSelectorValue(formatModelStringWithRouting(model), thinkingLevel);
}

function formatRetryFallbackBaseSelector(selector: RetryFallbackSelector): string {
	return `${selector.provider}/${selector.id}`;
}

const EPHEMERAL_REPLY_MAX_BYTES = 4096;

/**
 * Collapse degenerate ephemeral replies (/btw, /omfg side-channel turns).
 * Models occasionally loop on a single line (~16 reports of N-times-repeated
 * replies); compress runs longer than 3 down to one instance + `[…N×]`, then
 * cap at 4 KiB so a runaway reply can't flood the channel.
 */
function dedupeEphemeralReply(text: string): string {
	if (!text) return text;
	const lines = text.split("\n");
	const out: string[] = [];
	let i = 0;
	while (i < lines.length) {
		let j = i + 1;
		while (j < lines.length && lines[j] === lines[i]) j++;
		const runLen = j - i;
		if (runLen > 3) {
			out.push(lines[i], `[…${runLen}×]`);
		} else {
			for (let k = 0; k < runLen; k++) out.push(lines[i]);
		}
		i = j;
	}
	let result = out.join("\n");
	if (Buffer.byteLength(result, "utf8") > EPHEMERAL_REPLY_MAX_BYTES) {
		// Trim by characters until we're under the byte budget — handles multi-byte
		// glyphs at the boundary without splitting them.
		const suffix = "\n[…truncated]";
		const budget = EPHEMERAL_REPLY_MAX_BYTES - Buffer.byteLength(suffix, "utf8");
		while (Buffer.byteLength(result, "utf8") > budget) {
			result = result.slice(0, -1);
		}
		result += suffix;
	}
	return result;
}

/**
 * Build the per-request `metadata` payload for the Anthropic provider, shaped
 * like real Claude Code's `getAPIMetadata` output (`{ session_id, account_uuid,
 * device_id }`) so the backend buckets requests under one session and attributes
 * them to the authenticated OAuth account when available. Resolved at request
 * time so token refreshes and login/logout transitions don't strand a stale
 * account UUID in memory. `account_uuid` and `device_id` are omitted for
 * non-Anthropic providers to avoid leaking the user's Claude identity to
 * third-party APIs (including Anthropic-format-compatible proxies such as
 * cloudflare-ai-gateway or gitlab-duo).
 *
 * `provider` is the target provider string (e.g. `"anthropic"`) and gates the
 * `account_uuid` and `device_id` lookups — only `"anthropic"` requests carry them.
 *
 * `sessionId` is forwarded to the auth-storage session-sticky lookup so that
 * multi-credential setups attribute to the same OAuth account used for the
 * actual API request rather than always picking the first credential.
 *
 * `authStorage` is treated as optional so test fixtures that stub `modelRegistry`
 * without a real storage layer still work; the resolver simply skips the lookup
 * and emits `{ session_id }` alone, matching the no-OAuth-credential path.
 */
/**
 * Whether `next` is the same tool set as `current` in a different order.
 *
 * Order-only differences are the case worth catching: they cost a full prefix
 * re-encode and buy nothing, because the model selects a tool by name. A genuine
 * set change (a tool added, removed, or swapped) is NOT a permutation and must
 * reach the provider in the order the caller asked for.
 */
function isToolOrderPermutation(current: readonly string[], next: readonly string[]): boolean {
	if (current.length !== next.length || current.length === 0) return false;
	let sameOrder = true;
	for (let index = 0; index < current.length; index++) {
		if (current[index] !== next[index]) {
			sameOrder = false;
			break;
		}
	}
	if (sameOrder) return false;
	const currentSet = new Set(current);
	if (currentSet.size !== current.length) return false;
	for (const name of next) {
		if (!currentSet.delete(name)) return false;
	}
	return currentSet.size === 0;
}

function buildSessionMetadata(
	sessionId: string,
	provider: string,
	authStorage: AuthStorage | undefined,
): Record<string, unknown> {
	const userId: Record<string, string> = { session_id: sessionId };
	// Only look up account_uuid when the request is going to Anthropic. Injecting
	// a Claude OAuth account_uuid into requests bound for other providers (including
	// Anthropic-format-compatible proxies like cloudflare-ai-gateway or gitlab-duo)
	// would leak the user's Anthropic identity to unrelated third-party APIs.
	if (provider === "anthropic") {
		const accountUuid = authStorage?.getOAuthAccountId("anthropic", sessionId);
		if (typeof accountUuid === "string" && accountUuid.length > 0) {
			userId.account_uuid = accountUuid;
			// Claude Code's `device_id` is a stable 64-hex account-scoped install
			// identifier. Include both veyyon's persistent install id and the Claude
			// account UUID so two accounts on the same install do not share a device.
			userId.device_id = deriveClaudeDeviceId(getInstallId(), accountUuid);
		}
	}
	return { user_id: JSON.stringify(userId) };
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

function createHandoffContext(document: string): string {
	return `<handoff-context>\n${document}\n</handoff-context>\n\nThe above is a handoff document from a previous session. Use this context to continue the work seamlessly.`;
}

function createHandoffFileName(date = new Date()): string {
	const fileTimestamp = date.toISOString().replace(/[:.]/g, "-");
	return `handoff-${fileTimestamp}.md`;
}

// ============================================================================
// ACP Permission Gate
// ============================================================================

/** Tools that require user permission before execution when an ACP client is connected. */
const PERMISSION_REQUIRED_TOOLS = new Set([TOOL.bash, TOOL.edit, "delete", "move"]);

/** Permission options presented to the client on each gated tool call. */
const PERMISSION_OPTIONS: ClientBridgePermissionOption[] = [
	{ optionId: "allow_once", name: "Allow once", kind: "allow_once" },
	{ optionId: "allow_always", name: "Always allow", kind: "allow_always" },
	{ optionId: "reject_once", name: "Reject", kind: "reject_once" },
	{ optionId: "reject_always", name: "Always reject", kind: "reject_always" },
];

const PERMISSION_OPTIONS_BY_ID = new Map(PERMISSION_OPTIONS.map(option => [option.optionId, option]));

function getStringProperty(value: Record<string, unknown>, key: string): string | undefined {
	const candidate = value[key];
	return typeof candidate === "string" ? candidate : undefined;
}

function collectStringPaths(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function getEditDestructiveIntent(args: unknown): { kind: "delete" | "move"; paths: string[] } | undefined {
	if (!isRecord(args)) return undefined;
	const a = args as Record<string, unknown>;

	const edits = Array.isArray(a.edits) ? a.edits : undefined;
	if (edits) {
		const path = getStringProperty(a, "path");
		if (path) {
			for (const edit of edits) {
				if (!isRecord(edit)) continue;
				const op = getStringProperty(edit as Record<string, unknown>, "op");
				if (op === "delete") return { kind: "delete", paths: [path] };
			}
		}
		for (const edit of edits) {
			if (!isRecord(edit)) continue;
			const entry = edit as Record<string, unknown>;
			const op = getStringProperty(entry, "op");
			const rename = getStringProperty(entry, "rename");
			if (op !== "create" && rename) return { kind: "move", paths: path ? [path, rename] : [rename] };
		}
	}

	const input = getStringProperty(a, "input");
	if (input) {
		try {
			const patch = Patch.parse(input);
			for (const section of patch.sections) {
				if (section.fileOp?.kind === "rem") return { kind: "delete", paths: [section.path] };
				if (section.fileOp?.kind === "move") return { kind: "move", paths: [section.path, section.fileOp.dest] };
			}
		} catch {
			// Not a hashline patch — fall through to apply_patch parsing.
		}
		try {
			const entries = expandApplyPatchToEntries({ input });
			const deleteEntry = entries.find(entry => entry.op === "delete");
			if (deleteEntry) return { kind: "delete", paths: [deleteEntry.path] };
			const moveEntry = entries.find(entry => entry.rename);
			if (moveEntry?.rename) return { kind: "move", paths: [moveEntry.path, moveEntry.rename] };
		} catch {
			// If the edit input is not an apply_patch envelope, it is not a delete/move operation.
		}
	}

	return undefined;
}

function getPermissionIntent(
	toolName: string,
	args: unknown,
): { toolName: string; title: string; paths?: string[]; cacheKey: string } | undefined {
	const a = isRecord(args) ? (args as Record<string, unknown>) : {};
	if (toolName === TOOL.bash) {
		const cmd = getStringProperty(a, "command")?.slice(0, 80);
		return { toolName, title: cmd || toolName, cacheKey: toolName };
	}
	if (toolName === "delete") {
		const p = getStringProperty(a, "path");
		return { toolName, title: p ? `Delete ${p}` : toolName, paths: p ? [p] : undefined, cacheKey: toolName };
	}
	if (toolName === "move") {
		const from = getStringProperty(a, "oldPath") ?? getStringProperty(a, "path") ?? getStringProperty(a, "from");
		const to = getStringProperty(a, "newPath") ?? getStringProperty(a, "to") ?? getStringProperty(a, "destination");
		if (from && to) return { toolName, title: `Move ${from} to ${to}`, paths: [from, to], cacheKey: toolName };
		return {
			toolName,
			title: from ? `Move ${from}` : toolName,
			paths: from ? [from] : undefined,
			cacheKey: toolName,
		};
	}
	if (toolName === TOOL.edit) {
		const intent = getEditDestructiveIntent(args);
		if (!intent) return undefined;
		if (intent.kind === "delete") {
			return {
				toolName,
				title: `Delete ${intent.paths[0] ?? "edit target"}`,
				paths: intent.paths,
				cacheKey: "edit:delete",
			};
		}
		const from = intent.paths[0];
		const to = intent.paths[1];
		return {
			toolName,
			title: from && to ? `Move ${from} to ${to}` : `Move ${from ?? to ?? "edit target"}`,
			paths: intent.paths,
			cacheKey: "edit:move",
		};
	}
	return undefined;
}

function extractPermissionLocations(
	args: unknown,
	cwd: string,
	explicitPaths?: string[],
): { path: string; line?: number }[] {
	if (!args || typeof args !== "object") return [];
	const a = args as Record<string, unknown>;
	const out: { path: string; line?: number }[] = [];
	const pushPath = (value: unknown) => {
		if (typeof value !== "string" || value.length === 0) return;
		// ACP locations carry file paths that the editor host will open or focus;
		// they must be absolute or the client cannot resolve them. Resolve raw
		// tool args (often cwd-relative) against the session cwd before sending.
		let resolved: string;
		try {
			resolved = resolveToCwd(value, cwd);
		} catch {
			return;
		}
		if (out.some(location => location.path === resolved)) return;
		out.push({ path: resolved });
	};
	if (explicitPaths) {
		for (const p of explicitPaths) {
			pushPath(p);
		}
		return out;
	}
	pushPath(a.path);
	pushPath(a.file);
	for (const p of collectStringPaths(a.paths)) {
		pushPath(p);
	}
	pushPath(a.oldPath);
	pushPath(a.newPath);
	pushPath(a.from);
	pushPath(a.to);
	pushPath(a.source);
	pushPath(a.destination);
	return out;
}

// ============================================================================
// AgentSession Class
// ============================================================================

/** Entry returned by {@link AgentSession.clearQueue} / {@link AgentSession.popLastQueuedMessage}. */
export type RestoredQueuedMessage = { text: string; images?: ImageContent[] };

function queuedTextContent(message: AgentMessage): string | undefined {
	if (!("content" in message)) return undefined;
	const content = message.content;
	if (typeof content === "string") return content;
	return content.find((part): part is TextContent => part.type === "text")?.text;
}

function queuedImageContent(message: AgentMessage): ImageContent[] | undefined {
	if (!("content" in message) || typeof message.content === "string") return undefined;
	const images = message.content.filter(
		(part): part is ImageContent =>
			part.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string",
	);
	return images.length > 0 ? images : undefined;
}

function isDisplayableQueuedMessage(message: AgentMessage): boolean {
	return !(message.role === "custom" && message.display === false);
}

function isAdvisorCard(message: AgentMessage): message is CustomMessage {
	return message.role === "custom" && message.customType === "advisor";
}

function isTerminalTextAssistantAnswer(message: AgentMessage | undefined): message is AssistantMessage {
	if (message?.role !== "assistant" || message.stopReason !== "stop") return false;
	let hasText = false;
	for (const part of message.content) {
		if (part.type === "toolCall") return false;
		if (part.type === "text") {
			if (part.text.trim().length > 0) hasText = true;
			continue;
		}
		if (part.type === "thinking" || part.type === "redactedThinking" || part.type === "fallback") continue;
		return false;
	}
	return hasText;
}

/**
 * A queued message the user can restore to the editor / pull back as a draft.
 * Only genuinely user-authored messages qualify: plain user turns, or custom
 * messages explicitly attributed to the user (e.g. `/skill` invocations).
 * Agent-authored queued cards — advisor concern/blocker notes, IRC asides,
 * extension notices, hidden goal/plan/budget steers — ride the same
 * steer/follow-up queues but must never be dumped into the editor on Esc/Alt+Up.
 */
function isUserQueuedMessage(message: AgentMessage): boolean {
	if (message.role === "user") return true;
	return message.role === "custom" && message.attribution === "user" && message.display !== false;
}

/** Custom-message types of the hidden magic-keyword notices that `#createMagicKeywordNotices`
 *  enqueues alongside a user prompt. Keep in sync with that method. */
const MAGIC_KEYWORD_NOTICE_TYPES: ReadonlySet<string> = new Set([
	"ultrathink-notice",
	"orchestrate-notice",
	"workflow-notice",
]);

/** Custom-message type of the hidden companion carrying vision descriptions of image
 *  attachments sent to a text-only model (see `#buildImageDescriptionNotice`). */
const IMAGE_ATTACHMENT_DESCRIPTION_TYPE = "image-attachment-description";

/**
 * A hidden, user-attributed companion of a queued user prompt: the magic-keyword
 * notices (`ultrathink`/`orchestrate`/`workflow`) enqueued alongside the user
 * message. They are `attribution: "user"` but `display: false`, so they are not
 * editor-restorable; when the user pulls their prompt back out of the queue these
 * must leave with it rather than linger as stale, companion-less steering. Scoped to
 * the known notice types so an unrelated hidden user custom is never silently dropped.
 */
function isHiddenUserCompanion(message: AgentMessage): boolean {
	return (
		message.role === "custom" &&
		message.attribution === "user" &&
		message.display === false &&
		(MAGIC_KEYWORD_NOTICE_TYPES.has(message.customType) || message.customType === IMAGE_ATTACHMENT_DESCRIPTION_TYPE)
	);
}

function queueChipText(message: AgentMessage): string {
	if (message.role === "custom") {
		return readQueueChipText(message.details) ?? queuedTextContent(message) ?? "";
	}
	const text = queuedTextContent(message) ?? "";
	if (text) return text;
	return queuedImageContent(message) ? "[Image]" : "";
}

function toRestoredQueuedMessage(message: AgentMessage): RestoredQueuedMessage {
	return { text: queueChipText(message), images: queuedImageContent(message) };
}

function mergeLlmCompactionPreserveData(
	hookPreserveData: Record<string, unknown> | undefined,
	resultPreserveData: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
	const preserveData = { ...(hookPreserveData ?? {}), ...(resultPreserveData ?? {}) };
	return stripLegacyArchive(Object.keys(preserveData).length > 0 ? preserveData : undefined);
}

/**
 * Redact every string in a provider payload, object keys included, after
 * mutable request hooks. The bounded shared walker rejects transformed-key
 * collisions and unsupported/cyclic payloads; the boundary converts every
 * walker failure into a fail-closed confidentiality error.
 */
export function obfuscateProviderPayload(value: unknown, obfuscator: SecretObfuscator | undefined): unknown {
	if (!obfuscator?.hasSecrets()) return value;
	return transformProviderPayload(value, text => obfuscator.obfuscate(text), "AgentSession provider payload", {
		safeFailureDetails: true,
	});
}

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

// A thin adapter over the `contentText` owner for the `unknown` agent-message
// boundary: content here may be a plain string, an array of blocks (a wider
// union that also carries thinking and tool-call blocks), or malformed. The
// string/non-array guards live here; the block flattening (skip non-text, trim,
// join with a blank line) is the owner's job. `contentText` skips non-record and
// non-string-text blocks the same way the old hand-rolled loop did.
function textFromContent(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return contentText(content as readonly ContentBlockLike[], { separator: "\n\n", trimBlocks: true });
}

function thinkingFromContent(content: unknown): string {
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (!isRecord(block) || block.type !== "thinking" || typeof block.thinking !== "string") continue;
		const thinking = block.thinking.trim();
		if (thinking) parts.push(thinking);
	}
	return parts.join("\n\n");
}

function toolCallOpFromMessage(message: AgentMessage, toolCallId: string): string | undefined {
	if (message.role !== "assistant" || !Array.isArray(message.content)) return undefined;
	for (const block of message.content) {
		if (!isRecord(block) || block.type !== "toolCall" || block.id !== toolCallId) continue;
		return isRecord(block.arguments) ? getStringProperty(block.arguments, "op") : undefined;
	}
	return undefined;
}

function titleConversationTurnFromMessage(message: AgentMessage): TitleConversationTurn | undefined {
	if (message.role !== "user" && message.role !== "assistant") return undefined;
	const text = textFromContent(message.content);
	const thinking = message.role === "assistant" ? thinkingFromContent(message.content) : undefined;
	if (!text && !thinking) return undefined;
	return { role: message.role, ...(text ? { text } : {}), ...(thinking ? { thinking } : {}) };
}

export class AgentSession {
	readonly agent: Agent;
	readonly sessionManager: SessionManager;
	readonly settings: Settings;
	readonly yieldQueue: YieldQueue;
	fileSnapshotStore?: InMemorySnapshotStore;
	#autoApprove: boolean;
	/**
	 * Full permission bypass (the `/yolo` command). Session-scoped, defaults off,
	 * never auto-persisted: every approval that would prompt is allowed while set,
	 * but explicit user `deny` and plan-mode blocks still stop the call. Read live
	 * into each tool-execution context so a mid-session toggle takes effect on the
	 * next tool call.
	 */
	#approvalBypassActive = false;
	/**
	 * The parent session's live bypass state, for a subagent. Undefined in a root
	 * session. Read on every {@link isApprovalBypassed} call so `/yolo off` in the
	 * parent reaches a subagent that is already running.
	 */
	readonly #parentApprovalBypassed?: () => boolean;
	/**
	 * Per-tool decisions the operator made at an interactive approval prompt and
	 * asked to keep ("Always allow" / "Always deny").
	 *
	 * Session-scoped and never persisted, which is the whole point: a standing
	 * grant written to `tools.approval` outlives the task it was granted for and
	 * is invisible next week. This one dies with the session, so the next launch
	 * asks again.
	 *
	 * Without it the `ask` ladder is unusable rather than safe: a run that edits
	 * twenty files asks twenty times, and an operator who has to answer that many
	 * prompts turns the whole thing off, which is how a default that "asks"
	 * becomes a default that yolos.
	 */
	readonly #sessionToolApprovals = new Map<string, "allow" | "deny">();

	// Context window we last reported a surprising compaction threshold for — a
	// capped absolute amount, a value still coming from a retired key, or an
	// unparseable value. Warned once per distinct window (re-warns after a model
	// switch to a smaller window), so the operator's configured amount is never
	// silently reinterpreted. See #noticeCompactionThresholdClamp.
	#compactionClampNoticeWindow: number | undefined = undefined;

	#powerAssertion: MacOSPowerAssertion | undefined;

	readonly configWarnings: string[] = [];

	#scopedModels: Array<{
		model: Model;
		thinkingLevel?: ConfiguredThinkingLevel;
		explicitThinkingLevel?: boolean;
	}>;
	/** Effective, metadata-clamped thinking level applied to the agent (never `auto`). */
	#thinkingLevel: ThinkingLevel | undefined;
	/** Explicit session-only choice. Undefined lets selector and saved per-model defaults apply. */
	#sessionThinkingOverride: ConfiguredThinkingLevel | undefined;
	/** Explicit effort suffix on the selector that activated the current model. */
	#activeSelectorThinkingLevel: ConfiguredThinkingLevel | undefined;
	/** True when the user configured `auto`; the effective level is resolved per turn. */
	#autoThinking: boolean = false;
	/** The level `auto` last resolved to (for UI); undefined until a turn is classified. */
	#autoResolvedLevel: Effort | undefined;
	#prewalk: Prewalk | undefined;
	/** True once the plan nudge has been queued; scrubbed from context at the switch. */
	#prewalkPlanInjected = false;
	/** True once any successful `todo` call landed — opens the prewalk
	 *  trigger gate: the switch fires at the first edit/write AFTER the todo
	 *  list exists (sessions without a todo tool skip the gate). */
	#prewalkTodoSeen = false;
	#planYolo: PlanYolo | undefined;
	#planYoloPreviousTools: string[] | undefined;
	#planYoloArmed = false;

	#promptTemplates: PromptTemplate[];
	#slashCommands: FileSlashCommand[];

	// Event subscription state
	#unsubscribeAgent?: () => void;
	#cancelExitRecorder?: () => void;
	#exitRecorded = false;
	#unsubscribeAppendOnly?: () => void;
	#unsubscribeModelRoles?: () => void;
	#unsubscribePromptSettings?: () => void;
	#promptRefresh: Promise<void> = Promise.resolve();
	/** Last (enable, providerId) tuple resolved by `#syncAppendOnlyContext` — used to skip no-op invalidations. */
	#lastAppendOnlyResolution?: { enable: boolean; providerId: string | undefined };
	#eventListeners: AgentSessionEventListener[] = [];
	#commandMetadataChangedListeners: CommandMetadataChangedListener[] = [];

	/** Messages queued to be included with the next user prompt as context ("asides"). */
	#pendingNextTurnMessages: CustomMessage[] = [];
	#scheduledHiddenNextTurnGeneration: number | undefined = undefined;
	#queuedMessageDrainScheduled = false;
	/** Latched true when the user deliberately interrupts (USER_INTERRUPT_LABEL);
	 *  suppresses advisor concern/blocker auto-resume until the user next resumes.
	 *  Advisor advice is still recorded into the transcript, just not auto-run. */
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
	/** Live advisors. Empty when no advisor is active. */
	#advisors: ActiveAdvisor[] = [];
	/** Configured advisor roster from WATCHDOG.yml; undefined/empty → single legacy advisor. */
	#advisorConfigs?: AdvisorConfig[];
	/** Provider-facing UUIDv7 identities keyed by primary provider session and advisor slug. */
	#advisorProviderSessionIds = new Map<string, string>();
	/** Aggregate of the most recent stop's recorder closes; awaited by dispose() and
	 *  used as the open barrier for the next build so two writers never share a file. */
	#advisorRecorderClosed: Promise<void> = Promise.resolve();
	#goalTurnCounter = 0;
	#planReferenceSent = false;
	#planReferencePath: string = DEFAULT_PLAN_FILE_URL;
	#clientBridge: ClientBridge | undefined;
	#allowAcpAgentInitiatedTurns = false;
	/** Per-session memory of allow_always / reject_always decisions for gated tools. */
	#acpPermissionDecisions: Map<string, "allow_always" | "reject_always"> = new Map();
	/** Session file created by this session's `/move`; removed on dispose if it stayed empty. */
	#movedFromEmptySessionFile?: string;

	// Compaction state
	#compactionAbortController: AbortController | undefined = undefined;
	#autoCompactionAbortController: AbortController | undefined = undefined;

	// Branch summarization state
	#branchSummaryAbortController: AbortController | undefined = undefined;

	// Handoff state
	#handoffAbortController: AbortController | undefined = undefined;
	#skipPostTurnMaintenanceAssistantTimestamp: number | undefined = undefined;

	// Retry state
	#retryAbortController: AbortController | undefined = undefined;
	#retryAttempt = 0;
	#retryPromise: Promise<void> | undefined = undefined;
	#retryResolve: (() => void) | undefined = undefined;
	#activeRetryFallback: ActiveRetryFallbackState | undefined = undefined;
	#pendingRecoveredRetryErrors: PendingRecoveredRetryError[] = [];
	// Todo completion reminder state
	#todoReminderCount = 0;
	/**
	 * Set after a reminder is appended and cleared only by tool-level progress or
	 * a changed todo snapshot. A user correction does not clear it: otherwise
	 * repeated "continue" prompts replay the same reminder payload.
	 */
	#todoReminderAwaitingProgress = false;
	/** Fingerprint of the last rendered incomplete state; unchanged retries omit the list. */
	#lastTodoReminderFingerprint: string | undefined = undefined;
	/**
	 * Error text of the most recent `todo` result that failed, cleared by the
	 * next one that succeeds. While it is set the board write never landed, so
	 * the recorded phases describe a state the session cannot vouch for and no
	 * reminder may assert a count from them.
	 *
	 * Cleared with the reminder counters at every lifecycle boundary that starts
	 * a new context (new session, `/clear`, resume, handoff): the latch names one
	 * specific write against one specific board, and those boundaries replace the
	 * board, so carrying it across is a claim about a transcript that is gone.
	 * Without that reset one failure disabled todo continuation pressure for the
	 * rest of the process, and the repeated-failure instruction tells the model to
	 * stop calling `todo`, so no later success would ever clear it.
	 *
	 * Deliberately NOT expired on a turn count or a timer. The latch is not a
	 * cooldown; it records that the board is unverified, and nothing but a landed
	 * write or a discarded board makes it verified again. Ageing it out would just
	 * resume asserting "you stopped with N incomplete items" from the same stale
	 * phases, which is the false statement the suppression exists to prevent.
	 */
	#lastTodoFailureText: string | undefined = undefined;
	/**
	 * Id of the newest `compaction` entry ON THE ACTIVE BRANCH at the moment a
	 * stop-time reminder last echoed the full todo list, `null` when the branch
	 * held none, and `undefined` before the first echo of this session.
	 *
	 * The compaction entry is the boundary of the model's current context
	 * window, and every path that compacts (manual `/compact`, and idle,
	 * threshold, overflow and incomplete auto-compaction, which all funnel
	 * through one `appendCompaction` call) persists one, so this is the signal a
	 * per-window latch should key off rather than a turn count. A differing id
	 * means the previous echo scrolled out of context and the next reminder may
	 * spend a fresh echo. Cleared with the reminder counters at every lifecycle
	 * boundary that starts a new window (new session, handoff, reminders
	 * re-enabled), since the latch describes one window only.
	 */
	#todoReminderEchoCompactionId: string | null | undefined = undefined;
	/**
	 * Successful mutating tool results (bash/eval/edit/write/ast_edit) since the
	 * agent last touched the `todo` tool. Drives {@link #takeMidRunTodoNudge} so
	 * the live HUD stays in sync with actual progress instead of flipping
	 * `0/N -> N/N` only at the very end of a long run (issue #3651). Read-only
	 * tools and errored results never tick it. Reset to 0 on any `todo` tool
	 * result, on a nudge fire (cooldown), on a stop-time reminder, and at every
	 * new-prompt / clear / handoff lifecycle boundary.
	 */
	#mutationsSinceLastTodoTouch = 0;
	/** Mid-run nudges fired this prompt cycle; capped by
	 *  {@link MID_RUN_TODO_NUDGE_MAX_PER_CYCLE}, reset with the counter above. */
	#midRunNudgeCount = 0;
	#planModeReminderCount = 0;
	#planModeReminderAwaitingProgress = false;
	#todoPhases: TodoPhase[] = [];
	#replanTitleRefreshInFlight: Promise<void> | undefined = undefined;
	/** Resolved TITLE_SYSTEM.md override applied to every automatic session-title
	 *  generation path. Refresh via {@link AgentSession.setTitleSystemPrompt} when
	 *  the session cwd changes. */
	#titleSystemPrompt: string | undefined;
	#toolChoiceQueue = new ToolChoiceQueue();
	readonly #verificationEvidence = new VerificationEvidenceLedger();

	// Bash execution state
	#bashAbortControllers = new Set<AbortController>();
	#pendingBashMessages: BashExecutionMessage[] = [];

	// Python execution state
	#evalAbortControllers = new Set<AbortController>();
	#evalKernelOwnerId: string;
	#parentEvalSessionId: string | undefined;
	/**
	 * AsyncJobManager owned by this session (top-level only). Subagents leave
	 * this undefined and **MUST NOT** dispose the global instance on teardown.
	 */
	readonly #ownedAsyncJobManager: AsyncJobManager | undefined;
	/** Whether another session in this process spawned this one. */
	readonly #isSubagent: boolean;
	/**
	 * AsyncJobManager scoped to this session for introspection/cancellation.
	 *
	 * This differs from `#ownedAsyncJobManager`: subagents can inherit a parent
	 * manager for their own owner id, while secondary top-level sessions are left
	 * undefined to avoid reading the primary's jobs.
	 */
	readonly #asyncJobManager: AsyncJobManager | undefined;
	#pendingPythonMessages: PythonExecutionMessage[] = [];
	#activeEvalExecutions = new Set<Promise<unknown>>();
	#evalExecutionDisposing = false;

	// Incoming IRC messages received while a turn was streaming. Parent IRCs
	// enter the steering queue; peer IRCs enter the interrupt queue and drain as
	// asides at the next boundary; passive IRC records stay in the aside queue.
	#pendingIrcInterrupts: CustomMessage[] = [];
	#pendingIrcAsides: CustomMessage[] = [];
	// Agent identity (registry id) used for IRC routing and job ownership.
	#agentId: string | undefined;
	#agentKind: "main" | "sub" = "main";
	#providerSessionId: string | undefined;
	#freshProviderSessionId: string | undefined;
	#inheritedProviderPromptCacheKey: string | undefined;
	#isDisposed = false;
	// Extension system
	#extensionRunner: ExtensionRunner | undefined = undefined;
	#turnIndex = 0;
	#messageEndPersistenceTail: Promise<void> = Promise.resolve();
	#pendingMessageEndPersistence = new Map<string, Promise<void>>();
	#persistedMessageKeys: { anchor: string; keys: Set<string> } | undefined;

	#skills: Skill[];
	readonly #operatorNotices: OperatorNotices;

	// Custom commands (TypeScript slash commands)
	#customCommands: LoadedCustomCommand[] = [];
	/** MCP prompt commands (updated dynamically when prompts are loaded) */
	#mcpPromptCommands: LoadedCustomCommand[] = [];

	#skillsSettings: SkillsSettings | undefined;

	// Model registry for API key resolution
	#modelRegistry: ModelRegistry;

	// Tool registry and prompt builder for extensions
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
	/** Session-local provider-ID → `tc_<n>` map; rebuilt from history on resume. */
	#toolCallIdMap = new Map<string, string>();
	#toolCallIdCounter = 0;
	/** Session cwd roots accumulated over setCwd calls; rebuilt from history on resume. */
	#wirePathRoots: string[] = [];
	/**
	 * Directory {@link AgentSession.rescopeToCwd} last re-scoped to, so the two
	 * callers of one move (this session, then the TUI's `cwd_changed` handler) do
	 * the work once between them.
	 */
	#lastRescopedCwd: string | undefined;
	/**
	 * Whole cwd/rescope/switch transaction queue. Work is appended synchronously,
	 * so commits and rollbacks occur in monotonic initiation order.
	 */
	#scopeTransitionTail: Promise<void> = Promise.resolve();
	#scopeTransitionRevision = 0;
	/** Cumulative outbound bytes elided by path relativization this session. */
	#wirePathBytesSaved = 0;
	#thoughtSignatureBytesSaved = 0;
	#sideStreamFn: StreamFn;
	/**
	 * The transport every SIDE request shares, in the `completeImpl` shape
	 * `compact()`, the handoff and the branch summary all take. A side request is
	 * one the session makes for itself rather than for the conversation: a
	 * summarization, a handoff, a tree navigation summary.
	 *
	 * Routing through {@link #sideStreamFn} is what puts the operator's provider
	 * settings on such a request (the stream idle and first-event watchdogs, the
	 * in-flight cap, `providers.openrouterVariant`, the loop guard) and what
	 * brackets it with the provider-concurrency limiter. The default inside
	 * `compact()` is a bare `completeSimple`, which reads no settings at all, so a
	 * site that builds its own options and omits this runs unwatched: a
	 * summarization whose provider goes silent has no deadline to end it. Every
	 * site names this field instead of writing the adapter again, so a new one
	 * cannot forget it by construction.
	 */
	#sideCompleteImpl = async <TApi extends Api>(
		model: Model<TApi>,
		ctx: Context,
		options: SimpleStreamOptions,
	): Promise<AssistantMessage> => {
		const stream = await this.#sideStreamFn(model, ctx, options);
		return stream.result();
	};
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
	/**
	 * Every mid-session system-prompt change, in order, by the reason its caller
	 * gave. Each entry is one full prefix-cache invalidation, so this doubles as
	 * the running count of "turns that had to re-read the whole context as fresh
	 * input". Exposed through {@link systemPromptInvalidations} so a bench or a
	 * cost report can attribute cache misses to the subsystem that caused them.
	 */
	readonly #baseSystemPromptInvalidations: string[] = [];
	/**
	 * Every mid-session discard of the inherited provider prompt cache key, in
	 * order, by reason. A discard is the OTHER way a session pays for a full
	 * re-prefill, and it was the invisible one: only system-prompt changes were
	 * recorded, so a session whose most expensive miss came from a thinking-level
	 * switch showed nothing at all. One measured session read 0 cached tokens and
	 * rewrote 67,528 immediately after an auto-thinking reclassification, 18
	 * seconds after the previous turn, while its invalidation record listed only
	 * unrelated cwd changes. Exposed through {@link providerCacheKeyDiscards}.
	 */
	readonly #providerCacheKeyDiscards: string[] = [];
	/**
	 * Signature of the (toolNames, tool descriptions) tuple passed to the most
	 * recent successful `rebuildSystemPrompt` call. Used to skip redundant rebuilds
	 * when MCP servers reconnect without changing their tool definitions, which is
	 * the dominant cause of prompt-cache invalidation in long sessions.
	 */
	#lastAppliedToolSignature: string | undefined;
	/**
	 * Model identifier (`provider/id`) currently rendered into `#baseSystemPrompt`.
	 * The prompt surfaces the active model to the agent, so a model switch must
	 * trigger a rebuild. Compared against the live model after every model change
	 * to decide whether the cached prompt is stale.
	 */
	#promptModelKey: string | undefined;
	#mcpDiscoveryEnabled = false;
	#discoverableMCPTools = new Map<string, DiscoverableTool>();
	#selectedMCPToolNames = new Set<string>();
	// Generic tool discovery (covers built-in + MCP + extension when tools.discoveryMode === "all")
	#discoverableToolSearchIndex: DiscoverableToolSearchIndex | null = null;
	#selectedDiscoveredToolNames = new Set<string>();
	#builtInToolNames = new Set<string>();
	#rpcHostToolNames = new Set<string>();
	#defaultSelectedMCPServerNames = new Set<string>();
	#defaultSelectedMCPToolNames = new Set<string>();
	#sessionDefaultSelectedMCPToolNames = new Map<string, string[]>();

	// TTSR manager for time-traveling stream rules
	#ttsrManager: TtsrManager | undefined = undefined;
	#pendingTtsrInjections: Rule[] = [];
	/** Per-tool TTSR rules whose `interruptMode` opted out of aborting the stream.
	 *  Bucketed while the tool call's arguments stream, then rendered in
	 *  `#ttsrAfterToolCall` into `#pendingTtsrToolReminders`. */
	#perToolTtsrInjections = new Map<string, Rule[]>();
	/** Rendered tool-scoped TTSR reminders waiting for the next aside boundary.
	 *  Model-only: they never enter a tool result, so nothing the user reads
	 *  carries `<system-reminder>` markup. See {@link #ttsrAfterToolCall}. */
	#pendingTtsrToolReminders: { content: string; rules: string[] }[] = [];
	/** Drives the `commit-drift` rule: this session's edits that are not committed yet. */
	readonly #commitDrift = new CommitDriftTracker();
	#ttsrAbortPending = false;
	#ttsrRetryToken = 0;
	#ttsrResumePromise: Promise<void> | undefined = undefined;
	#ttsrResumeResolve: (() => void) | undefined = undefined;

	/** One-shot flag for expected internal plan-mode aborts. Approval actions may
	 *  abort the post-`resolve` continuation before compaction, execution, or
	 *  manual refinement. Consumed inside `#handleAgentEvent` for the matching
	 *  `message_end` + `stopReason: "aborted"`; callers clear it in `finally` so
	 *  it cannot leak into later unrelated aborts. */
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

	/** Active Gemini reasoning-header runaway detector for the current block.
	 *  (Re)created on each `thinking_start` when the guard applies (see
	 *  `#geminiHeaderGuardActive`); undefined for non-Gemini models or when the
	 *  guard is off. Fed thinking deltas in the assistant-message interceptor. */
	#geminiHeaderDetector: GeminiHeaderRunDetector | undefined;
	#toolCallLoopGuard: ToolCallLoopGuard | undefined;
	#toolCallLoopGuardSettingsKey: string | undefined;
	#promptInFlightCount = 0;
	#abortInProgress = false;
	// Wire-level agent_end emission deferred until #promptInFlightCount drops to 0.
	// Internal extension hooks and post-emit work (auto-retry, auto-compaction, todo
	// checks in #handleAgentEvent) still fire on the original schedule — only the
	// `#emit(event)` that reaches external subscribers (rpc-mode stdout, ACP bridge,
	// Cursor exec, TUI listeners) is held back. Without this, a client that resumes
	// on `agent_end` can fire its next `prompt` before #promptWithMessage's finally
	#emptyStopRetryCount = 0;
	/**
	 * Developer reminders appended by a turn-retry cycle (empty stop, unexpected
	 * stop), in append order. They are scaffolding: their only job is to nudge a
	 * stalled turn back into producing something, and they speak about a turn that
	 * either was discarded or has already given up. Removed from active context
	 * when the cycle ends, so a later turn is not carrying instructions about a
	 * turn that no longer exists.
	 */
	#turnRetryReminders: AgentMessage[] = [];
	#unexpectedStopRetryCount = 0;
	#acceptTerminalEmptyStopForPrompt = false;
	#promptGeneration = 0;
	#pendingAgentEndEmit: AgentSessionEvent | undefined;
	#pendingContextSnapshot: PendingContextSnapshot | undefined = undefined;
	#sessionStopContinuationCount = 0;
	#sessionStopHookActive = false;
	// Bumped whenever the pending in-flight snapshot is set/cleared. The
	// status-line context memo includes this so clearing the snapshot on
	// turn-end/abort invalidates the cache even though the message list is
	// unchanged — otherwise a mid-turn estimate would survive into idle.
	#contextUsageRevision = 0;
	#obfuscator: SecretObfuscator | undefined;
	#secretRuntime: SecretRuntimeLease | undefined;
	#leaseSecretRuntime: (() => Promise<SecretRuntimeLease>) | undefined;
	#resolveSecretRuntimeLeaseForContext: ((context: Context) => SecretRuntimeLease | undefined) | undefined;
	#refreshSecretRuntime: ((cwd: string) => Promise<SecretRuntimeLease | SecretObfuscator | undefined>) | undefined;
	/** Single-flight guard for the out-of-band refresh a stale render schedules. */
	#staleSecretRuntimeRefreshInFlight = false;
	#argot: ArgotSession | undefined;
	/** Per-streaming-message argot display decoder (seam 3); reset on each assistant message_start. */
	#argotStreamDisplay: ArgotStreamDisplayDecoder | undefined;
	/** Resolves the active model's inline-descriptor policy for session dumps. */
	#resolvePruneToolDescriptions: (model: Model) => boolean = () => false;
	#checkpointState: CheckpointState | undefined = undefined;
	#pendingRewindReport: string | undefined = undefined;
	#lastCompletedRewind: CompletedRewindState | undefined = undefined;
	#rewoundToolResultIds = new Set<string>();
	#lastSuccessfulYieldToolCallId: string | undefined = undefined;
	/**
	 * Sticky across an in-flight prompt run: a successful `yield` makes the run
	 * terminal for execution purposes, so any trailing empty/aborted assistant
	 * stop must NOT trigger empty-stop/unexpected-stop/compaction continuations.
	 * Cleared before every new prompt turn so the next turn evaluates cleanly.
	 */
	#yieldTerminationPending = false;
	#synchronouslyTerminatedYieldToolCallIds = new Set<string>();
	#providerSessionState = new Map<string, ProviderSessionState>();
	/** Compaction-fallback notices already emitted this session, keyed by their text. */
	#announcedCompactionFallbacks = new Set<string>();
	/** Server-side compaction failure notices already emitted, keyed by error text. */
	#announcedServerCompactionFailures = new Set<string>();
	#hindsightSessionState: HindsightSessionState | undefined = undefined;
	readonly rawSseDebugBuffer: RawSseDebugBuffer;

	#resetPromptMaintenanceState(): void {
		this.#emptyStopRetryCount = 0;
		this.#dropTurnRetryReminders();
		this.#unexpectedStopRetryCount = 0;
		this.#yieldTerminationPending = false;
		this.#acceptTerminalEmptyStopForPrompt = false;
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
			logger.warn("Failed to acquire macOS power assertion", { error: String(error) });
		}
	}

	#releasePowerAssertion(): void {
		const assertion = this.#powerAssertion;
		this.#powerAssertion = undefined;
		if (!assertion) return;
		try {
			assertion.stop();
		} catch (error) {
			logger.warn("Failed to release macOS power assertion", { error: String(error) });
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

	/** A steer/follow-up can land after the agent loop's final queue poll, or
	 *  after an abort stops an auto-continued queued turn. In both cases the
	 *  agent-core queue still owns the message, but no loop is left to poll it.
	 *  Runs whenever the session settles; the guard makes it a no-op when the
	 *  queue was consumed normally or a new turn already started. */
	#drainStrandedQueuedMessages(): void {
		if (this.#abortInProgress) return;
		// A concern steered into a resumed streaming run after a user interrupt can
		// strand at the turn tail (steered past the loop's final boundary poll). While
		// that interrupt's suppression is still in effect, reclaim such advisor steers
		// as visible advice once idle — mirroring abort's #extractQueuedAdvisorCards —
		// so they neither auto-resume the run the user stopped (a non-empty steer queue
		// otherwise bypasses the latch in #canAutoContinueForFollowUp) nor linger to
		// flush at the next prompt. Real user steers/follow-ups are left untouched.
		if (this.#advisorAutoResumeSuppressed && !this.isStreaming) {
			for (const card of this.#extractQueuedAdvisorCards()) {
				this.#preserveAdvisorCard(card);
			}
		}
		this.#scheduleQueuedMessageDrain();
		this.#resumeStrandedIrcAsides();
	}

	/** IRC records that arrive after the loop's final aside poll — or while an abort skipped that
	 *  poll — land in pending IRC queues with no loop left to drain them; the queued-message drain's
	 *  gate (agent.hasQueuedMessages()) does not count peer IRC interrupts. Once idle, wake a turn so
	 *  the agent responds to the peer. Skip only when a queued steer/follow-up will itself drive a
	 *  resume turn whose aside poll already consumes these (no double-wake). */
	#resumeStrandedIrcAsides(): void {
		if (this.#isDisposed || this.isStreaming) return;
		if (this.#pendingIrcInterrupts.length === 0 && this.#pendingIrcAsides.length === 0) return;
		if (this.#canAutoContinueForFollowUp() && this.agent.hasQueuedMessages()) return;
		const records = [...this.#pendingIrcInterrupts, ...this.#pendingIrcAsides];
		this.#pendingIrcInterrupts = [];
		this.#pendingIrcAsides = [];
		if (this.#planModeState?.enabled) {
			// Plan mode: fold stranded IRC asides into context without waking an
			// autonomous turn. Convergence to ask/resolve stays user-driven.
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

	/** Fire-and-forget wake turn for incoming IRC — idle delivery and stranded-aside resume both
	 *  route here. Wrapped in #beginInFlight/#endInFlight so the turn is tracked and its settle
	 *  re-drains anything that stranded during it. A user interrupt may have intentionally left a
	 *  follow-up queued behind an invalid tail (seam #5); the wake turn's loop would otherwise drain
	 *  it, so park the follow-up queue across the wake and restore it after. It stays queued post-wake
	 *  because #canAutoContinueForFollowUp suppresses follow-up auto-resume while a user interrupt is
	 *  in effect, even though the wake left a provider-valid tail. */
	#wakeForIrc(records: CustomMessage[]): void {
		// Park only a *blocked* follow-up (one a user interrupt is intentionally holding); an
		// already-resumable follow-up can ride the wake turn normally without reordering.
		const parkedFollowUps =
			this.agent.peekSteeringQueue().length === 0 &&
			this.agent.peekFollowUpQueue().length > 0 &&
			!this.#canAutoContinueForFollowUp()
				? [...this.agent.peekFollowUpQueue()]
				: [];
		if (parkedFollowUps.length > 0) {
			this.agent.replaceQueues([...this.agent.peekSteeringQueue()], []);
		}
		this.#resetPromptMaintenanceState();
		this.#beginInFlight();
		void this.agent
			.prompt(records)
			.catch(error => {
				logger.warn("IRC wake turn failed", { error: String(error) });
			})
			.finally(() => {
				if (parkedFollowUps.length > 0) {
					this.agent.replaceQueues(
						[...this.agent.peekSteeringQueue()],
						[...parkedFollowUps, ...this.agent.peekFollowUpQueue()],
					);
				}
				this.#endInFlight();
			});
	}

	/** Remove advisor concern/blocker cards from the agent-core steer/follow-up
	 *  queues and return them. Used on a deliberate user interrupt so the post-abort
	 *  stranded-message drain cannot auto-resume the run on an advisor card that was
	 *  steered in just before the user stopped; real user follow-ups stay queued.
	 *  Synchronous and await-free so it runs before the abort path polls the queue. */
	#extractQueuedAdvisorCards(): CustomMessage[] {
		const steering = this.agent.peekSteeringQueue();
		const followUp = this.agent.peekFollowUpQueue();
		const cards = [...steering, ...followUp].filter(isAdvisorCard);
		if (cards.length === 0) return [];
		this.agent.replaceQueues(
			steering.filter(m => !isAdvisorCard(m)),
			followUp.filter(m => !isAdvisorCard(m)),
		);
		return cards;
	}

	/** Record a suppressed advisor concern as visible, persisted advice without
	 *  triggering a turn. When the agent is idle (the normal post-interrupt case,
	 *  including the post-prompt unwind window where the core loop has ended), emit
	 *  message_start/message_end like #flushPendingIrcAsides so #handleAgentEvent
	 *  renders it live (TUI/ACP) and persists it as a CustomMessageEntry. Only while
	 *  an abort is still tearing a live turn down do we park it hidden, so abort's
	 *  settle step replays it once idle — never appended into a live streamMessage. */
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

	/**
	 * Subagent types a `/` command declared for the turn it just started.
	 *
	 * Empty except between a command returning a prompt and that prompt's run
	 * settling. See {@link agentGrantedThisTurn}.
	 */
	#grantedAgents = new Set<string>();

	/**
	 * Grant the agents a command declared, for the turn its prompt is about to start.
	 *
	 * Called with the command's static `spawnsAgents` list, never with anything a
	 * handler computed while running: the point of the grant is that "which commands
	 * can reach a disabled agent" is answerable by reading the command definitions.
	 */
	#grantAgentsForTurn(agents: readonly string[] | undefined): void {
		if (!agents?.length) return;
		for (const agent of agents) this.#grantedAgents.add(agent);
	}

	/**
	 * Drop every grant once the session settles.
	 *
	 * Cleared on BOTH settle paths — the normal one and the reset an abort takes —
	 * because a grant that survived an aborted turn would sit there until the next
	 * command, and the model's next unrelated spawn would find a disabled agent open.
	 * That is precisely the "disabled but still runs" behaviour this replaced, so
	 * leaking it back through the abort path would undo the whole change quietly.
	 */
	#clearAgentGrants(): void {
		this.#grantedAgents.clear();
	}

	/**
	 * Whether a `/` command has granted this agent type for the turn in flight.
	 *
	 * `subagent.agents.<name>.enabled` governs what the MODEL may choose. It does
	 * not govern the person typing: `/review` names `reviewer` outright, and someone
	 * running `/review` is asking for a review rather than asking the model whether
	 * to review. The command declares the agents its prompt names, that declaration
	 * is granted for exactly that turn, and the task tool and the eval `agent()`
	 * bridge both consult it.
	 */
	agentGrantedThisTurn(agentName: string): boolean {
		return this.#grantedAgents.has(agentName);
	}

	#flushPendingAgentEnd(): void {
		const pending = this.#pendingAgentEndEmit;
		if (!pending) return;
		this.#pendingAgentEndEmit = undefined;
		this.#emit(pending);
	}

	/** Advance the one-way prewalk switch at a completed assistant-turn boundary. */
	async #advancePrewalk(liveMessages: AgentMessage[], context: AgentTurnEndContext | undefined): Promise<void> {
		const prewalk = this.#prewalk;
		if (!prewalk || context?.message.role !== "assistant") return;

		// Structural safety net: every branch below assumes the agent loop will
		// run another turn. It won't if THIS turn had no tool calls — the loop
		// treats a text-only turn as "the agent is done" and ends the session
		// with no further prompting. The plan nudge explicitly asks for a prose
		// reply, which makes a text-only turn common right after it — observed
		// silently killing production SWE-bench runs before any code was ever
		// written. Force one more turn only in that specific, self-created
		// hazard window.
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

		// Todo gate: the plan nudge instructs "finish the plan, then init the
		// todo list from it and start" — so the switch waits until a todo list
		// exists AND the model has actually started implementing (first
		// edit/write). The todo call itself never triggers: firing there handed
		// the fast model the whole implementation cold. Sessions without a todo
		// tool skip the gate.
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

	/**
	 * Arm prewalk outside the normal startup path (the `/prewalk` slash
	 * command): sets the target and immediately steers the plan nudge rather
	 * than waiting for the next turn boundary, since an explicit manual
	 * invocation means "start this now." A no-op with a notice if a prewalk
	 * is already armed and waiting.
	 */
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

	/**
	 * Remove the plan nudge from the LLM context before the model switch: the
	 * fast model inherits the plan the nudge produced, not the nudge itself.
	 * Splices the loop's live context array in place (the run streams from
	 * it) and mirrors the removal into agent state. The persisted transcript
	 * keeps the message for audit; a session reload re-materializes it,
	 * which is acceptable for prewalk's single-run lifecycle.
	 */
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

	/**
	 * Lazily arm PlanYolo before the first prompt is built: restricts tools to
	 * the plan-mode read-only set (plus `resolve`/`write`, both normally
	 * discovery-hidden), marks plan-mode state so `#buildPlanModeMessage`
	 * injects the standard plan-mode-active instructions on this and every
	 * following prompt, and registers the auto-approve resolve handler.
	 * Idempotent — a no-op once armed or when PlanYolo is not configured.
	 */
	async #armPlanYoloIfNeeded(): Promise<void> {
		if (!this.#planYolo || this.#planYoloArmed) return;
		this.#planYoloArmed = true;
		const previousTools = this.getActiveToolNames();
		const augmentations: string[] = [TOOL.resolve];
		if (this.hasBuiltInTool(TOOL.write)) augmentations.push(TOOL.write);
		await this.setActiveToolsByName([...new Set([...previousTools, ...augmentations])]);
		this.#planYoloPreviousTools = previousTools;
		this.setPlanModeState({
			enabled: true,
			planFilePath: this.getPlanReferencePath() || DEFAULT_PLAN_FILE_URL,
			workflow: "parallel",
		});
		this.setStandingResolveHandler(input => this.#runPlanYoloApprovalResolve(input));
	}

	/**
	 * Standing resolve handler while PlanYolo's plan phase is active. Auto-
	 * approves the instant the model calls `resolve { action: "apply" }` for
	 * the plan — no interactive review, the headless counterpart to plan
	 * mode's "Approve and execute" — then restores tools, exits plan-mode
	 * state, switches to the configured `target`, and hands off the approved
	 * plan for it to implement.
	 */
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
		const resolvedPath = planFilePath.startsWith("local:")
			? resolveLocalUrlToPath(normalizeLocalScheme(planFilePath), this.#localProtocolOptions())
			: resolveToCwd(planFilePath, this.sessionManager.getCwd());
		try {
			return await Bun.file(resolvedPath).text();
		} catch (error) {
			if (isEnoent(error)) return null;
			throw error;
		}
	}

	/** `local://` URLs of plan files in the session-local root, newest first —
	 *  a fallback for `resolveApprovedPlan` when the agent dropped `extra.title`. */
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
		// Power assertions are taken per turn (see #beginInFlight); nothing acquired here.
		this.#evalKernelOwnerId = config.evalKernelOwnerId ?? `agent-session:${Snowflake.next()}`;
		this.#parentEvalSessionId = config.parentEvalSessionId;
		this.#ownedAsyncJobManager = config.ownedAsyncJobManager;
		this.#isSubagent = config.isSubagent === true;
		this.#asyncJobManager = config.asyncJobManager ?? config.ownedAsyncJobManager;
		this.#scopedModels = config.scopedModels ?? [];
		this.#sessionThinkingOverride = config.thinkingSource === "session" ? config.thinkingLevel : undefined;
		this.#activeSelectorThinkingLevel = config.thinkingSource === "selector" ? config.thinkingLevel : undefined;
		if (config.thinkingLevel === AUTO_THINKING) {
			// `auto` is session-level: keep the flag and show a provisional concrete
			// level (the agent's initial effort was already set by the caller) until
			// the first user turn is classified.
			this.#autoThinking = true;
			this.#thinkingLevel = resolveProvisionalAutoLevel(this.model);
		} else {
			// Clamp the configured level against the session's model, mirroring the
			// restore path below. A persisted `high` (set while on another model)
			// forwarded unclamped to a reasoning model with no controllable effort
			// surface (e.g. devin/swe-1-6: `thinking: undefined`) threw
			// "Thinking effort high is not supported ... Supported efforts:" (empty
			// list) at the FIRST stream of every turn — the session was unusable.
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
		// Per-session CPU budget. Probed once per process, registered always
		// (even at 0 cores) so a mid-session change to session.cpuLimitCores
		// activates enforcement, and warned about here when a configured limit
		// cannot be enforced on this host. Cleanup rides the "session"-scoped
		// owned-resource disposers in dispose().
		let cpuLimitSessionId = this.sessionManager.getSessionId();
		if (cpuLimitSessionId) {
			void initSessionCpuLimit({
				sessionId: cpuLimitSessionId,
				cores: this.settings.get("session.cpuLimitCores"),
				kill: this.settings.get("session.cpuLimitKill"),
				onNotice: text => this.#operatorNotices.warn("cpu", text),
			}).catch(error => logger.warn("CPU limit init failed", { error: errorMessage(error) }));
		}
		// `/new`, `/resume`, a fork and a branch mint a fresh id on this same live
		// process. Spawn sites resolve the limiter by the current id, so without
		// this the budget stays registered under the conversation the operator
		// just left and the one they are in now spawns unlimited.
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
		// Resolve the wire service-tier per request so the Fireworks Priority
		// toggle scopes priority to Fireworks alone, without mutating the shared
		// session `serviceTier` that drives `/fast` and OpenAI/Anthropic priority.
		this.agent.serviceTierResolver = model => this.#effectiveServiceTier(model);
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
		this.#toolRegistry = config.toolRegistry ?? new Map();
		this.#createVibeTools = config.createVibeTools;
		this.#builtInToolNames = new Set(config.builtInToolNames ?? []);
		this.#requestedToolNames = config.requestedToolNames;
		this.#transformContext = config.transformContext ?? (messages => messages);
		// Canonicalize provider tool-call IDs to short session-local handles before
		// obfuscation / provider serialization. Runs once per request
		// after convertToLlm; map is session-stable so prior history serializes
		// byte-identically (prompt cache preserved). On resume the map rebuilds from
		// stored history by walking messages in order (no schema change).
		const upstreamTransformProviderContext = config.transformProviderContext;
		// Roots accumulate: initial cwd plus every cwd_changed target replayed from
		// stored history, so a resumed session renders old bytes identically and a
		// mid-session setCwd never rewrites them (prompt-cache prefix survives).
		this.#wirePathRoots = normalizeRoots([
			this.sessionManager.getCwd(),
			...this.sessionManager.getEntries().flatMap(entry => {
				if (entry.type !== "custom_message" || entry.customType !== "cwd_changed") return [];
				if (!isRecord(entry.details) || typeof entry.details.cwd !== "string") return [];
				return [entry.details.cwd];
			}),
		]);
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
			// Read per request: the retention window is a live setting, and a session
			// that changes it must take effect on the next turn, not on restart.
			const thoughtSignatureRetention = this.settings.get("context.thoughtSignatureRetention");
			const thoughtSignatureMaxLength = this.settings.get("context.thoughtSignatureMaxLength");
			const thinkingRetention = this.settings.get("context.thinkingRetention");
			// Both signature rules resolve through one owner, so the bytes reported here
			// are the bytes the request actually leaves out. Accounting that knew about
			// only one rule would report a saving the request did not make.
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
			if (upstreamTransformProviderContext) return upstreamTransformProviderContext(next, model, runtime);
			const fallbackRuntime = runtime ?? this.#secretRuntime;
			return fallbackRuntime
				? fallbackRuntime.obfuscateContext(next)
				: obfuscateProviderContext(this.#obfuscator, next);
		};
		this.#transformProviderContext = canonicalizeProviderContext;
		// Agent was constructed before AgentSession; install the wrapped hook so the
		// main loop / side requests / advisors share the same session-local map.
		this.agent.setTransformProviderContext(canonicalizeProviderContext);
		this.#sideStreamFn = config.sideStreamFn ?? streamSimple;
		this.#advisorStreamFn = config.advisorStreamFn;
		this.#preferWebsockets = config.preferWebsockets;
		this.#onPayload = config.onPayload;
		this.rawSseDebugBuffer = config.rawSseDebugBuffer ?? new RawSseDebugBuffer();
		// Avoid wrapping in an `async` closure when no user callback is configured: the
		// outer await on `#onResponse` (provider-response.ts) tolerates a sync void return,
		// and skipping the wrapper drops a per-event `newPromiseCapability` allocation that
		// shows up as ~3.5% self time in streaming profiles.
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
					// Parallel so the 30s catch-up budget is shared across advisors, not summed.
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
		// Background-job completions / late diagnostics are pulled into the run at
		// each step boundary as non-interrupting asides. Peer IRCs share the aside
		// injection boundary, but also expose a non-consuming interrupt peek so
		// `job poll` / `irc wait` can return early before the boundary drains them.
		this.agent.hasIrcInterrupts = () => this.#pendingIrcInterrupts.length > 0;
		this.agent.setAsideMessageProvider(() => {
			const pendingIrc = [...this.#pendingIrcInterrupts, ...this.#pendingIrcAsides];
			this.#pendingIrcInterrupts = [];
			this.#pendingIrcAsides = [];
			const thunks: AsideMessage[] = pendingIrc.map(record => () => record);
			thunks.push(...this.yieldQueue.drainLazy());
			// Mid-run todo reconciliation — evaluated at injection time so a turn
			// that flips a todo just before this poll suppresses the nudge.
			thunks.push(() => this.#takeMidRunTodoNudge());
			// Memory context published mid-run (a recall on `agent_start`, a
			// mental-model reload) rides in here instead of rewriting the system
			// prompt, which would cost a full uncached re-read of the conversation.
			thunks.push(() => this.#takePendingVolatileMemoryContext());
			// Tool-scoped TTSR reminders. An aside rather than a steer: a steer
			// aborts the tool batch still in flight, and a reminder about a call
			// that already finished has no business cutting its siblings short.
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
		// Tool-result hook owns synchronous post-tool actions that must affect the current loop.
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

		// Always subscribe to agent events for internal handling
		// (session persistence, hooks, auto-compaction, retry logic)
		this.#unsubscribeAgent = this.agent.subscribe(this.#handleAgentEvent);
		// Re-evaluate append-only context mode when the setting changes at runtime.
		this.#unsubscribeAppendOnly = onAppendOnlyModeChanged(_value => this.#syncAppendOnlyContext(this.model));
		this.#unsubscribeModelRoles = onModelRolesChanged(() => {
			if (!isAdvisorProductEnabled() || !this.#advisorEnabled || this.#isDisposed) return;
			if (this.#advisors.length > 0 && !this.#advisorRuntimeMatchesCurrentConfig()) this.#stopAdvisorRuntime();
			this.#buildAdvisorRuntime(true);
		});
		this.#unsubscribePromptSettings = this.settings.onEffectiveSettingChanged?.((path, value) => {
			if (this.#isDisposed) return;
			// Disabling either half of the todo-reminder feature is an explicit
			// lifecycle boundary. Reset synchronously with the effective setting
			// write rather than waiting for a later agent_end: there may be no stop
			// while disabled, and a stale self-continuation latch would otherwise
			// survive disable/re-enable and silence the fresh runway.
			if ((path === "todo.reminders" || path === "todo.enabled") && value === false) {
				this.#todoReminderCount = 0;
				this.#todoReminderAwaitingProgress = false;
				this.#lastTodoReminderFingerprint = undefined;
				this.#todoReminderEchoCompactionId = undefined;
			}
			// The limiter used to learn about a changed budget only when the bash
			// or launch tool next ran, because those two are the only spawn paths
			// that call `update()` themselves. Everything else (eval kernels, MCP
			// servers, hook and custom-tool `exec`) adopts into the group without
			// touching the quota, so lowering the limit did nothing to work
			// already running and `/cpu-limit remove` did not lift a live cap
			// until the operator happened to run a command.
			if (path === "session.cpuLimitCores" || path === "session.cpuLimitKill") {
				const limiter = sessionCpuLimit(this.sessionManager.getSessionId());
				void limiter
					?.update(this.settings.get("session.cpuLimitCores"), this.settings.get("session.cpuLimitKill"))
					.catch(error => logger.warn("CPU limit update failed", { error: errorMessage(error) }));
			}
			if (PROMPT_AFFECTING_SETTING_PATHS[path] !== true) return;
			this.#promptRefresh = this.#promptRefresh
				.then(async () => {
					if (!this.#isDisposed) await this.refreshBaseSystemPrompt(`setting:${path}`);
				})
				.catch(error => {
					logger.debug("System prompt refresh after setting change failed", {
						path,
						error: errorMessage(error),
					});
				});
		});
	}
	// -------------------------------------------------------------------------
	// Advisor runtime lifecycle
	// -------------------------------------------------------------------------
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

	// The next primary turn number starts the immune-turn window. While the
	// interrupting steer is still in flight, completedTurns is lower than this
	// start, so duplicate concern/blocker advice is also downgraded.
	#recordAdvisorInterruptDelivered(): void {
		this.#advisorInterruptImmuneTurnStart = this.#advisorPrimaryTurnsCompleted + 1;
	}

	/**
	 * Re-prime the advisor across a conversation boundary: `/new`, `/branch`,
	 * `/btw`, `/tree`, and session switch/resume. Beyond {@link AdvisorRuntime.reset}
	 * (which only re-primes the advisor's transcript view and is also fired by
	 * within-conversation rewrites like compaction/shake/rewind), this clears the
	 * session-level interrupt latches so the prior conversation's cooldown cannot
	 * leak into the new one: the post-interrupt immune-turn window
	 * (`#advisorPrimaryTurnsCompleted`, `#advisorInterruptImmuneTurnStart`) and the
	 * user-interrupt auto-resume suppression flag. It also drops advisor deliveries
	 * still queued against the prior conversation — pending asides in the yield
	 * queue (advisor entries use `skipIdleFlush`, so they linger until the next
	 * `drainLazy` rather than self-flushing), interrupting cards parked in the
	 * agent steer/follow-up queues, and preserved cards deferred to the next turn —
	 * so none of them inject into the new conversation.
	 */
	#resetAdvisorSessionState(): void {
		// Mute the recorder across the re-prime: AdvisorRuntime.reset() aborts the advisor
		// loop, and that abort can emit an `aborted` message_end we must not attribute to
		// either session's transcript. Detach, reset, then re-attach the live agent's feed.
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

			// Resolve the advisor's model: an explicit `model` override wins; else the
			// `advisor` role, which inherits this session's live model when unset.
			// A model that fails to resolve skips just this advisor.
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
					// An enabled advisor silently doing nothing is a silent fallback —
					// surface it like the explicit-override miss above.
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

		// Advisor service tier (`tier.advisor`): "none" (default) runs the advisor
		// on standard processing; "inherit" tracks the session's live per-family
		// tiers per request (like the main agent, including /fast toggles); a
		// concrete value is broadcast across families and applied to the advisor
		// model's family. One value for all advisors.
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

			// `#advisorWatchdogPrompt` already carries WATCHDOG.md + YAML shared
			// instructions; `config.instructions` adds this advisor's specialization.
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

			// Thread the primary's telemetry into the advisor loop so the advisor
			// model's GenAI spans + usage/cost hooks fire stamped with the local advisor
			// identity. `conversationId` is cleared so provider telemetry falls back to
			// the UUIDv7 provider session id, not the local `-advisor` label.
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
			// Mirror the SDK's provider-shaping options (streamFn/onPayload/...,
			// providerSessionState, promptCacheKey, transformProviderContext) so each
			// advisor's requests cache, route, and obfuscate like the main turn.
			// `promptCacheKey` preserves an explicitly pinned provider cache key
			// unchanged so tan/shared-session advisor calls read the exact shard the
			// parent turn populated. Otherwise the advisor uses its provider UUIDv7 so
			// Codex request identity remains UUID-shaped while local labels keep the
			// `-advisor` suffix.
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
				() => this.sessionManager.getSessionFile(),
				() => this.sessionManager.getCwd(),
				advisorTranscriptFilename(slug),
				// On the advisor on→off→on toggle, wait for the prior recorders' closes
				// so two SessionManagers never hold the same file at once.
				this.#advisorRecorderClosed,
			);
			// Resolved per advisor delta, not captured here: the advisor outlives every
			// secret refresh, so a snapshot would redact only what was configured when
			// the advisor started and would send a `/secret add`ed value in plaintext.
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
					// Mirror the auth-gateway's usage-limit remedy: the in-stream a/b/c
					// auth retry rotates through siblings within one request but never
					// blocks the LAST failing credential, so without this the advisor
					// re-picks the same exhausted account every retry. Usage limits
					// only — other failures keep the plain retry/notify path (never
					// suspect-mark a credential on a transient advisor error).
					const message = errorMessage(error);
					if (!isUsageLimitOutcome(extractHttpStatusFromError(error), message)) return;
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

		// One shared non-blocking aside channel for all advisors; the build callback
		// aggregates every advisor's queued nits into one card (each entry already
		// carries its own `advisor` name).
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
			autoResumeSuppressed: this.#advisorAutoResumeSuppressed,
			// Key on the live agent-core loop, not session `isStreaming` (which also
			// counts `#promptInFlightCount` during post-turn unwind). Only a running
			// loop consumes a steer at its next boundary.
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
			// Plan mode: record advice visibly in context but never wake an
			// autonomous turn — only user-driven turns converge on ask/resolve.
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
		).catch(err => logger.debug("advisor delivery failed", { err: String(err) }));
	}

	/** Re-prime every advisor's transcript view (compaction/shake/rewind) without the
	 *  session-level latch reset {@link #resetAdvisorSessionState} performs. */
	#resetAllAdvisorRuntimes(): void {
		for (const a of this.#advisors) a.runtime.reset();
		this.#ttsrManager?.resetForCompaction();
	}

	#stopAdvisorRuntime(): void {
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
		this.#advisorRecorderClosed = Promise.all(closes).then(() => {});
		this.#advisors = [];
		this.#advisorYieldQueueUnsubscribe?.();
		this.#advisorYieldQueueUnsubscribe = undefined;
	}

	/** Subscribe the advisor agent's finalized messages into the transcript recorder.
	 *  Idempotent-by-replacement: callers detach the prior feed first. Kept separate
	 *  so the re-prime path can mute the feed across an abort-driven reset. */
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

		// 1. Try promotion first
		if (await this.#promoteAdvisorContextModel(advisor, advisorModel)) {
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

		const availableModels = this.#modelRegistry.getAvailable();
		const candidates = this.#resolveCompactionModelCandidates(advisorModel, availableModels);
		if (candidates.length === 0) {
			// No compaction candidates, fallback to re-prime
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
			// Cannot prepare compaction, fallback to re-prime
			return true;
		}

		const advisorCompactionThinkingLevel: ThinkingLevel | undefined = agent.state.disableReasoning
			? ThinkingLevel.Off
			: agent.state.thinkingLevel;

		// Advisor state is in-memory-only, with no persisted SessionEntry stream,
		// so its overflow maintenance always uses an LLM summary regardless of the
		// primary session's configured compaction strategy.

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
						// The advisor's live turns route on
						// `this.agent.promptCacheKey ?? advisorProviderSessionId` (see the
						// advisor stream options). Use the same expression so its
						// overflow summary reads the prefix those turns cached.
						promptCacheKey: this.agent.promptCacheKey ?? advisorProviderSessionId,
						providerSessionState: this.#providerSessionState,
						codexCompaction,
						completeImpl: this.#sideCompleteImpl,
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

		// Tail elisions ride the preparation as pointerless markers; close them
		// out (recovery pointer, or undo) before they enter advisor memory.
		const recentMessages = await this.#resolveAdvisorTailElisions(preparation);
		agent.replaceMessages([summaryMessage, ...recentMessages]);
		return false;
	}

	/**
	 * Close out a successful advisor compaction's tail elisions before they
	 * enter advisor memory. `prepareCompaction` swaps over-budget tool results
	 * in the kept tail for pointerless markers as a side effect, and the
	 * advisor's retained tail comes from `preparation.recentMessages`, so
	 * feeding it unchanged would strand the original bytes behind a marker
	 * that names no recovery: advisor memory is in-memory and nothing else
	 * retains the pre-elision copy. The advisor's read tool resolves
	 * `artifact://` against THIS session's artifacts dir, so the offload lands
	 * on the same store the primary compaction paths use and the pointer
	 * stays live for later advisor turns. A failed offload puts the original
	 * message back instead — the next maintenance pass re-elides if the tail
	 * is still heavy, which beats a dead marker no turn can ever resolve.
	 * The replacement is always a NEW message object, never an in-place
	 * patch: `estimateTokens` caches by message identity, and the pointerless
	 * marker's estimate may already be primed from mid-pass reads.
	 */
	async #resolveAdvisorTailElisions(preparation: CompactionPreparation): Promise<AgentMessage[]> {
		const elisions = preparation.tailElisions ?? [];
		if (elisions.length === 0) return preparation.recentMessages;
		let artifactId: string | undefined;
		try {
			artifactId = await this.sessionManager.saveArtifact(renderTailElisionArtifact(elisions), "compaction-tail");
		} catch {
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

	/** Model registry for API key resolution and model discovery */
	get modelRegistry(): ModelRegistry {
		return this.#modelRegistry;
	}

	get asyncJobManager(): AsyncJobManager | undefined {
		return this.#asyncJobManager;
	}

	getAgentId(): string | undefined {
		return this.#agentId;
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
		return this.#providerSessionState;
	}

	/** Hint forwarded to provider calls that support websocket transport. */
	get preferWebsockets(): boolean | undefined {
		return this.#preferWebsockets;
	}

	getHindsightSessionState(): HindsightSessionState | undefined {
		return this.#hindsightSessionState;
	}

	/**
	 * This session's Argot codec, or `undefined` when the feature is off. Exposed
	 * so a spawning parent can hand a subagent a fork of it (the `inherit`
	 * subagent mode); the fork is detached, so the child never mutates the parent.
	 */
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

	/** TTSR manager for time-traveling stream rules */
	get ttsrManager(): TtsrManager | undefined {
		return this.#ttsrManager;
	}

	/** Secret obfuscator, when secrets are configured; /share redaction reuses it. */
	get obfuscator(): SecretObfuscator | undefined {
		return this.#obfuscator;
	}

	/** Whether the authoritative live runtime currently has secret protection enabled. */
	get secretsEnabled(): boolean {
		return this.#obfuscator !== undefined;
	}

	/** Live session-lifetime provider redactor, including disable/move tombstones. */
	obfuscateProviderText(text: string): string {
		return this.#secretRuntime?.obfuscateText(text) ?? this.#obfuscator?.obfuscate(text) ?? text;
	}

	/**
	 * Whether anything outbound still needs hiding, live value or tombstone.
	 *
	 * Read this instead of `#obfuscator?.hasSecrets()` on any redaction path.
	 * `#obfuscator` is the EXPANSION authority and is undefined the moment
	 * expansion stops (a `/secret disable`, or a cwd move off the vault), while
	 * the runtime lease deliberately keeps a redaction-only obfuscator alive
	 * across exactly those transitions. A value the model has already seen as a
	 * placeholder must never travel back to a provider as plaintext because
	 * expansion was switched off after the fact.
	 */
	get #hasProviderRedactions(): boolean {
		return this.#secretRuntime?.hasRedactions ?? this.#obfuscator?.hasSecrets() ?? false;
	}

	/**
	 * The live redaction authority, for a consumer that must hold the object.
	 *
	 * Read through a getter rather than captured at construction: a consumer that
	 * snapshots the redactor keeps redacting whatever was configured the moment it
	 * was built, so a secret added mid-session by `/secret add` never reaches it,
	 * and a session that started with no secrets at all never redacts anything.
	 *
	 * READ THIS, NOT `obfuscator`, ON ANY PATH THAT HIDES A VALUE. `obfuscator` is
	 * the expansion authority, so it is undefined after a `/secret disable` or a
	 * cwd move off the vault, and a redaction path that reads it stops redacting
	 * at exactly the moment the operator asked for less exposure, not more. Use
	 * `obfuscator` only to expand a placeholder or to mutate expansion state.
	 */
	get providerRedactor(): SecretObfuscator | undefined {
		return this.#secretRuntime?.redactionObfuscator ?? this.#obfuscator;
	}

	/** Live session-lifetime provider redactor for a whole context. */
	#obfuscateContextForProvider(context: Context): Context {
		const runtime = this.#secretRuntime;
		return runtime ? runtime.obfuscateContext(context) : obfuscateProviderContext(this.#obfuscator, context);
	}

	/** Live session-lifetime provider redactor for already-converted messages. */
	#obfuscateMessagesForProvider(messages: Message[]): Message[] {
		const runtime = this.#secretRuntime;
		if (runtime) return runtime.obfuscateMessages(messages);
		return this.#obfuscator ? obfuscateMessages(this.#obfuscator, messages) : messages;
	}

	/**
	 * Install the SDK coordinator's winning snapshot in the session view.
	 *
	 * This method is synchronous on purpose: the coordinator updates its closure
	 * authority and this view in the same commit turn.
	 */
	installSecretRuntime(runtime: SecretRuntimeLease): void {
		if (this.#secretRuntime && runtime.revision < this.#secretRuntime.revision) return;
		this.#secretRuntime = runtime;
		this.#obfuscator = runtime.expansionObfuscator;
	}

	/** Wait until every scope transition initiated before this call has settled. */
	async awaitScopeTransitionReady(): Promise<void> {
		await this.#scopeTransitionTail;
	}

	/** Admit one immutable request runtime after the winning scope is ready. */
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
			// No vault revision was ever captured on this path, so nothing here can
			// go stale and every freshness member is a no-op.
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

	/** Reload config/env/vault state in monotonic lifecycle initiation order. */
	refreshSecrets(options?: { refreshPrompt?: boolean }): Promise<void> {
		return this.#runScopeTransition(() => this.#refreshSecrets(options));
	}

	/** Whether a TTSR abort is pending (stream was aborted to inject rules) */
	get isTtsrAbortPending(): boolean {
		return this.#ttsrAbortPending;
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

	/**
	 * Cancel async jobs registered by this agent and by every agent it spawned.
	 * Used by lifecycle transitions (newSession, switchSession, handoff, dispose)
	 * so a session cleans up its own background work without touching its
	 * parent's or a sibling's jobs.
	 *
	 * DOWN the spawn tree, never up or sideways. A subagent exists to serve the
	 * agent that spawned it, so once this session is being torn down or moved to a
	 * new session, a grandchild's background job has nobody left to deliver to: it
	 * would keep running, keep spending, and report to a session that is gone.
	 * Cancelling only `ownerId` left exactly that orphan whenever a subagent had
	 * itself delegated. Reaching UP would be the old bug this scoping fixed (issue
	 * #1923): a secondary in-process session must never tear down the primary's
	 * work.
	 *
	 * Cancellation runs against this session's scoped manager. Subagents have
	 * unique agent ids and inherit the parent's manager to clean up their own
	 * jobs. A secondary in-process top-level session gets no scoped manager,
	 * because it defaults to `MAIN_AGENT_ID`; reaching through the global
	 * singleton would tear down the owning primary session's bash/task jobs at
	 * dispose time (issue #1923).
	 *
	 * No-op when no manager is reachable or this session has no agent id.
	 */
	#cancelOwnAsyncJobs(): void {
		if (!this.#agentId) return;
		const manager = this.#asyncJobManager;
		if (!manager) return;
		manager.cancelAll({ ownerId: this.#agentId });
		for (const descendant of AgentRegistry.global().descendantsOf(this.#agentId)) {
			manager.cancelAll({ ownerId: descendant });
		}
	}

	/**
	 * Re-root this session in the agent registry after it has moved to a
	 * different transcript, and release the subagents of the conversation it
	 * left.
	 *
	 * The registry is process-global and, until this existed, nothing ever told
	 * it that a conversation had ended. `/new` and `/resume` swap the transcript
	 * under the same `AgentSession`, so every subagent of the previous
	 * conversation stayed registered: the Agent Control Center listed them, `irc
	 * list` offered them as peers, and messaging one woke an agent whose replies
	 * were written into a transcript the operator had already left. That is the
	 * "agents from other sessions" symptom, and it is a leak as much as a
	 * display bug — a parked ref holds its session file, and a live one holds a
	 * whole `AgentSession`.
	 *
	 * Order matters. Release the descendants BEFORE the re-scope, so they are
	 * disposed while they still resolve as this agent's subtree; re-scoping first
	 * would leave them parented to a scope nothing walks. Their async jobs are
	 * already cancelled by the caller's `#cancelOwnAsyncJobs`, which walks the
	 * same subtree.
	 *
	 * A release that throws is logged and skipped rather than failing the
	 * session switch: a subagent that cannot be disposed must not strand the
	 * operator between two conversations.
	 */
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
							error: String(error),
						});
					}
				}),
			);
		}
		// The traffic goes whether or not anything was still registered to release.
		// Guarding this on `descendants.length` was wrong in the COMMON case: a
		// subagent that finished and aged out, or was disposed, is already
		// unregistered by the time the operator types `/new`, so the walk returns
		// nothing and the entire previous conversation's log survived in the
		// process-global bus. The new session's Comms pane then opened on the old
		// one's chatter, because every one of those lines has this still-in-scope
		// agent at one end.
		//
		// Forget this agent's own legs too. `forgetAgents` drops a line when
		// EITHER endpoint is named, and every line of the conversation that just
		// ended has either a released child or this agent on it. Bounded by the
		// ENDING scope so the purge cannot reach a line another conversation in
		// this process recorded under a recycled agent name.
		IrcBus.global().forgetAgents([...descendants, id], endingScope);
		// Standing approval grants die with the conversation they were given in.
		// "Allow bash for this session" is an answer about the work in front of
		// you, and `/new` or `/resume` replaces that work entirely; carrying the
		// grant across meant a permission granted for one task silently governed
		// the next one, on a store that is deliberately never persisted precisely
		// so it cannot outlive its context.
		this.#sessionToolApprovals.clear();
		registry.rescope(id, this.sessionManager.getSessionId?.() ?? undefined);
		logger.debug("Re-rooted the agent registry for a new conversation", {
			agentId: id,
			from: endingScope,
			to: registry.get(id)?.scope,
			released: descendants.length,
		});
	}

	/**
	 * True when a background async job owned by this agent is still running with
	 * an unsuppressed delivery, or a finished job's delivery is still queued or
	 * in flight. Either way the async-result follow-up will re-wake the loop, so
	 * a settle observed now is a scheduling pause rather than a terminal stop:
	 * stop-time passes (todo reminder, session_stop hooks) defer to the settle
	 * reached once the session is fully idle. Suppressed deliveries
	 * (acknowledged, or watched by an in-flight `job` poll) never wake the loop,
	 * so they don't count.
	 */
	#hasPendingAsyncWake(): boolean {
		const manager = this.#asyncJobManager;
		if (!manager) return false;
		const ownerFilter = this.#agentId ? { ownerId: this.#agentId } : undefined;
		return (
			manager.getRunningJobs(ownerFilter).some(job => !manager.isDeliverySuppressed(job.id)) ||
			manager.hasPendingDeliveries(ownerFilter)
		);
	}

	// =========================================================================
	// Event Subscription
	// =========================================================================

	/** Emit an event to all listeners */
	#emit(event: AgentSessionEvent): void {
		// Copy array before iteration to avoid mutation during iteration.
		const listeners = [...this.#eventListeners];
		for (const l of listeners) {
			try {
				const result = l(event) as unknown;
				// Listener may be an async function whose returned Promise we don't await;
				// attach a catch so a rejection does not become an unhandled rejection.
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
		this.#emit({ type: "notice", level, message, source });
	}

	#recordToolExecutionStart(event: Extract<AgentEvent, { type: "tool_execution_start" }>): void {
		const data: ToolExecutionStartData = {
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			startedAt: new Date().toISOString(),
		};
		// The assistant message already persists the full arguments; store only
		// the command/path projection the resume warning renders.
		//
		// REDACTED, because `event.args` are post-expansion. The assistant message
		// holds the placeholder the model wrote; this event holds what the tool was
		// actually handed, which for `#GITHUB_TOKEN#` is the credential itself. The
		// session file must never carry it: the vault is encrypted at rest and this
		// entry sits beside it in the same directory, and it travels through
		// `/share` and exports. The intent goes through the same redactor because
		// the model can quote an argument back into it.
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
			// Only pending tool calls or an abnormal teardown are noteworthy; a
			// clean dispose logs at debug so routine exits don't read as problems.
			const exitLog = pendingToolCalls.length > 0 || kind !== "normal" ? logger.warn : logger.debug;
			exitLog("Session exit recorded", {
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
		// `queued` is returned, so the failure is delivered to whoever awaits it. The tail must resolve or one
		// extension throwing would reject every later event on this session; note `then(emit, emit)` above,
		// which is what makes the queue continue rather than stall on a previous failure.
		this.#queuedExtensionEvents = queued.catch(() => {});
		return queued;
	}

	/**
	 * Emit a session event without waiting for it, when the caller genuinely cannot wait.
	 *
	 * The TTSR paths use this: the abort has to happen immediately and must not be gated on extension
	 * callbacks. But the failure still matters. `#emitSessionEvent` runs the extension handlers AND the
	 * wire-level `#emit` to subscribers, so an extension that throws stops the event reaching subscribers
	 * altogether -- the TTSR notification silently stops working, with the rule still applied and nothing
	 * saying why the client never heard about it. So the emit is detached, and the failure is reported.
	 */
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
		// Hold the wire-level agent_end until in-flight prompts unwind. Subscribers
		// (rpc-mode, ACP, Cursor) treat agent_end as the "session is idle" signal;
		// emitting while #promptInFlightCount > 0 lets a client fire its next
		// `prompt` into a session that still reports isStreaming === true. Flush
		// happens in #endInFlight / #resetInFlight. A later agent_end (e.g. from
		// an auto-compaction turn that starts before the original prompt unwinds)
		// supersedes the pending one, which is what subscribers want — they only
		// care about the final settle.
		if (event.type === "agent_end" && this.#promptInFlightCount > 0) {
			this.#pendingAgentEndEmit = event;
			return;
		}
		this.#emit(event);
	}

	// Track last assistant message for auto-compaction check
	#lastAssistantMessage: AssistantMessage | undefined = undefined;

	/** Internal handler for agent events - shared by subscribe and reconnect.
	 *
	 * `agent_end` handling schedules post-prompt recovery work such as context
	 * promotion continuations. It is invoked fire-and-forget by the agent's
	 * synchronous `#emit`, and only reaches `#checkCompaction` after several
	 * internal awaits. `prompt()` runs `#waitForPostPromptRecovery()` the instant
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
		// Same tail rule as `#queueExtensionEvent`: `promise` is handed to the slot's caller and carries the
		// failure; the tail only orders the next message's persistence and must not inherit the rejection.
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

	/**
	 * Index every message entry on the current branch by persistence key, so
	 * the mid-run-compaction planner can ask "is this turn message already on
	 * the branch?" in O(1). The set is memoized through the current leaf path
	 * and validated at use time against a (session file, leaf id) anchor.
	 *
	 * The mid-run ordering check uses key identity alone: same-key content
	 * variants are one logical message at this boundary, because otherwise a
	 * display-side rewrite can make the assistant look missing after its tool
	 * results have already persisted.
	 *
	 * Coherency is anchor-based, not invalidation-based: every branch mutation
	 * (rewind, branch switch, new session, custom-entry append) changes the
	 * session manager's leaf id or session file, so `#ensurePersistedMessageKeys`
	 * detects staleness itself and rebuilds. No mutation call site has to
	 * remember to invalidate anything.
	 *
	 * Pre-#3629 the equivalent was `sessionManager.getBranch()` called twice
	 * per turn message, each call rebuilding the path via O(n²) `unshift` and
	 * structurally JSON-comparing every entry — seconds of synchronous work
	 * per `onTurnEnd` on a long session and the load-bearing source of the
	 * `ui.loop-blocked` warnings in the bug report.
	 */
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

	/**
	 * True when {@link message} is structurally identical to a message already
	 * appended to the current branch. Uses the current branch's memoized
	 * persistence-key cache for the common missing-key case, and only walks the
	 * branch to verify content when a key hit could be a rare collision.
	 */
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

	/**
	 * On a user-interrupted (`Esc`) abort, copy the trailing thinking run into a
	 * hidden `display: false` continuity message for the next turn WITHOUT
	 * mutating the assistant message. The original thinking stays on the message
	 * so live render, reload, and Ctrl+L rebuilds keep showing it; `convertToLlm`
	 * strips the run from the provider request (incomplete/unsigned thinking is
	 * rejected on resend) when this continuity message follows the assistant turn.
	 */
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
		// One branch snapshot + one persistence-key index drives the entire
		// planning pass. Pre-#3629 this re-walked the branch and structurally
		// JSON-compared every entry per turn message, which on long sessions
		// turned each `onTurnEnd` into a seconds-long sync block (the
		// `ui.loop-blocked` warnings tagged `subagent:*` in the bug report).
		const branchKeys = this.#indexPersistedMessageKeys();
		const turnKeys = turnMessages.map(sessionMessagePersistenceKey);
		const persistedKeys = new Set<string>();
		for (let index = 0; index < turnMessages.length; index++) {
			const key = turnKeys[index];
			if (key === undefined) continue;
			// Mid-run ordering is keyed by logical identity. A persisted display
			// variant (for example, redacted/deobfuscated content) must still count;
			// otherwise the assistant can look missing while later tool results are
			// present, producing a false out-of-order skip.
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

	/**
	 * Expand one string for display, or report that it cannot be expanded. NEVER
	 * throws, for any codec or freshness reason.
	 *
	 * WHY THAT MATTERS: every caller is a display or render path, not a tool call.
	 * An exception raised while turning a stored `#HASH#` back into plaintext does
	 * not fail one operation, it unwinds whatever was rendering (the event
	 * fan-out, a TUI repaint, the agent-state rebuild after a compaction, even the
	 * constructor's first `buildDisplaySessionContext()`) and the session is gone.
	 * A placeholder left on screen literally is cosmetic, so degrading is always
	 * the right trade here.
	 *
	 * Returns the text unchanged when there is nothing to expand. The
	 * DISPLAY-RESTORABLE test comes FIRST and is the whole gate. `hasSecrets()`
	 * answers "this session has a secret", which is not the question, and
	 * `containsLivePlaceholder` answers "would expansion change this", which is no
	 * longer the question either: a vault-backed credential is deliberately NOT
	 * restorable on screen, so text whose only placeholders are withheld has
	 * nothing to expand and must not consult the vault revision or report a
	 * degraded render. Returns undefined ONLY when the text carries a restorable
	 * placeholder and expansion is unsafe: a stale captured revision, or a codec
	 * limit refusing the text.
	 */
	#tryExpandSecretsForDisplay(text: string): string | undefined {
		const obfuscator = this.#obfuscator;
		if (obfuscator === undefined || !obfuscator.containsDisplayRestorablePlaceholder(text)) return text;
		if (!this.#secretExpansionFreshForDisplay()) return undefined;
		return this.#expandLivePlaceholdersForDisplay(obfuscator, text);
	}

	/**
	 * Per-string expander for one display pass over a structured payload (a
	 * transcript, one assistant message's content), or undefined when the session
	 * has no expansion authority and the caller should skip the walk and keep its
	 * own reference.
	 *
	 * Freshness is resolved lazily, on the first string that actually carries a
	 * live placeholder, and then memoized FOR THIS PASS ONLY: the freshness probe
	 * reads the vault's revision off disk, and a transcript rebuild walks every
	 * model-authored string in the branch. A later pass resolves it again, so a
	 * refresh that landed in between is picked up.
	 */
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

	/**
	 * {@link SecretObfuscator.deobfuscateForDisplay} with a refused expansion demoted to a literal
	 * render AND reported to the operator.
	 *
	 * NOT `deobfuscate`. A stored credential must never be drawn, so the display codec restores
	 * only what may be shown and leaves a withheld placeholder standing. The two are otherwise
	 * identical, which is why this seam is the only thing that had to change to close the leak:
	 * every display path already funnels through here.
	 *
	 * The refusal arrives as UNCHANGED TEXT, not as a throw. The display codec swallows its own cap
	 * refusals by design, since its caller is drawing a frame. That is the right call and it is also
	 * why detecting the refusal is this seam's job: without the comparison a refused expansion is
	 * indistinguishable on screen from having nothing to expand, and the operator is left with a
	 * placeholder and no reason for it.
	 *
	 * PRECONDITION, and the equality check is sound ONLY because of it: every caller has already
	 * established, via `containsDisplayRestorablePlaceholder`, that this text holds a placeholder the
	 * codec would expand. Given that, identical text can only mean the codec declined. Reuse this
	 * check anywhere that precondition does not hold and it reads "refused" for the ordinary case of
	 * text with nothing to expand, which is a silent false notice on every render. Callers must keep
	 * gating; this method must not be the first thing to ask whether expansion was possible.
	 */
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
			// BACKSTOP, not a live path: the display codec is documented never to throw. Kept because
			// this is the one seam every display path funnels through, and the cost of that contract
			// changing under us is the unwound TUI this lane exists to prevent.
			this.#noteDegradedSecretDisplay(
				"A secret placeholder is shown unexpanded because the expansion was refused.",
				"Refused a secret expansion on a display path; rendering the placeholder literally",
				error,
			);
			return undefined;
		}
	}

	/**
	 * Expand one string for an INTERNAL COMPARISON against bytes on disk, or report that it cannot
	 * be expanded. Never throws.
	 *
	 * The one expansion in this file that is neither a spend nor a display, and the one that still
	 * needs the REAL value: {@link #maybeAbortStreamingEdit} matches the model's removed lines
	 * against the file's actual content, which holds the credential in cleartext. Routing it
	 * through the display codec would leave `#HASH#` in the comparison text, no removed line would
	 * ever match, and every edit touching a secret would look like a failed patch preview.
	 *
	 * Nothing expanded here may be rendered or logged. The result is compared and discarded.
	 */
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

	/**
	 * One line of model-authored text, safe to put in a log.
	 *
	 * Re-redacts through the live obfuscator, turning any expanded credential back into its
	 * placeholder. Used where a diagnostic quotes text that has ALREADY been expanded for an
	 * internal comparison: the log file outlives the terminal, so a credential written there is a
	 * longer-lived exposure than the screen leak this class of fix exists to close. Falls back to a
	 * fixed marker rather than the raw text, because a redactor that fails open is not one.
	 */
	#redactForLog(text: string): string {
		const obfuscator = this.#obfuscator;
		if (obfuscator === undefined || !obfuscator.hasSecrets()) return text;
		try {
			return obfuscator.obfuscate(text);
		} catch {
			return "<redacted: could not be safely rendered>";
		}
	}

	/**
	 * Whether a display pass may expand live placeholders, plus the recovery when
	 * it may not.
	 *
	 * A stale captured revision means the vault changed under this session, so the
	 * cached map can hold a value that has since been rotated or deleted and
	 * expanding from it would put a superseded secret on screen. Show the
	 * placeholder, tell the operator once, and start the refresh that makes the
	 * NEXT render correct. Refusing to render is never one of the options.
	 */
	#secretExpansionFreshForDisplay(): boolean {
		const runtime = this.#secretRuntime;
		if (runtime === undefined) return true;
		let fresh: boolean;
		try {
			fresh = runtime.isFreshForExpansion();
		} catch (error) {
			// Documented pure, but it reads the vault's revision off disk. An
			// unreadable vault degrades the render; it never ends it.
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

	/**
	 * Await the recovery a stale runtime needs, on a render path that happens to
	 * be async, and never fail the caller for it.
	 *
	 * The two async render sites (the ephemeral turn's final message, the
	 * transcript rebuild after a branch move) can do better than degrade: they are
	 * already inside an await, so they can wait for the vault re-read and then
	 * expand from the fresh runtime that refresh installs. A refresh that
	 * genuinely fails still only degrades, because a codec problem must not become
	 * a failed navigation or a dead recap.
	 */
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

	/**
	 * Recover a stale secret runtime out of band, so the next render expands.
	 *
	 * Single-flight because the callers are renders: a transcript rebuild reaches
	 * this from the first placeholder it walks and a repaint can run on every
	 * keystroke, while each refresh re-reads the whole vault.
	 *
	 * Goes through the PUBLIC `refreshSecrets`, not `#refreshSecrets`, so this
	 * re-read is queued on the scope-transition tail like every other one: a cwd
	 * move in flight is not raced, and a spend that runs right after a degraded
	 * render waits for this refresh through `awaitScopeTransitionReady` instead of
	 * re-reading the vault a second time. The optional system-prompt rebuild is
	 * skipped because a render must not rewrite the prompt as a side effect.
	 */
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

	/**
	 * Tell the operator that a render degraded, and log the detail.
	 *
	 * Goes through the secrets notice sink that every other machine-state
	 * condition in this subsystem already uses, rather than a second channel, so
	 * the host renders it the same way as a tightened key directory or a
	 * superseded vault binding. NEVER carries a secret value: the notice names the
	 * condition and the log carries the error text.
	 */
	#noteDegradedSecretDisplay(notice: string, logMessage: string, error?: unknown): void {
		logger.warn(logMessage, {
			sessionId: this.sessionManager.getSessionId(),
			...(error === undefined ? {} : { error: errorMessage(error) }),
		});
		noteSecretsCondition(notice);
	}

	/** Whether any model-authored string in this assistant content carries a display-restorable placeholder. */
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

	/** Whether any model-authored string in this transcript carries a display-restorable placeholder. */
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

	/**
	 * Per-string, never-throwing stand-in for `deobfuscateSessionContext` on
	 * render paths: the same transcript walk, and the same
	 * same-reference-when-nothing-changed contract.
	 */
	#deobfuscateSessionContextForDisplay(context: SessionContext): SessionContext {
		const expand = this.#displaySecretExpander();
		if (expand === undefined) return context;
		const messages = mapAgentMessageStrings(context.messages, expand);
		return messages === context.messages ? context : { ...context, messages };
	}

	/**
	 * Assistant message content in display form: secrets deobfuscated and argot
	 * handles expanded, composed in that order. Stored messages keep the
	 * obfuscated placeholders and cheap handles (the token win and the persistence
	 * contract); any surface that shows content to a person — the streamed
	 * `message_end` display event, and headless `--print`, which reads the stored
	 * message directly — must route it through here first so operators never see a
	 * raw `#HASH#` secret token or a bare `§handle`. Returns the same content
	 * reference when neither transform applies.
	 */
	displayAssistantContent(content: AssistantMessage["content"]): AssistantMessage["content"] {
		// DISPLAY PATH: the streamed `message_end` display event, the interactive
		// event fan-out, and `--print`. Degrades per string; never throws.
		const expand = this.#displaySecretExpander();
		let out =
			expand === undefined ? content : mapAssistantContentStrings(content, expand, { includeToolMetadata: true });
		if (this.#argot?.loaded) {
			out = expandAssistantContent(this.#argot, out);
		}
		return out;
	}

	/**
	 * A tool call's intent in display form, through the same two transforms as its
	 * content.
	 *
	 * The intent is a sentence the MODEL wrote about what it is doing, and the
	 * interactive working line puts it on screen the moment the call starts. That
	 * makes it a display surface with the same obligation as any other: a person
	 * reads "Reading src/db.ts to check the schema", never "Reading §db …".
	 *
	 * It needs its own pass because it does not travel with the arguments. The
	 * intent is lifted out of the arguments before the argument transform runs, so
	 * the expansion applied to every argument reaches everything except this one
	 * field, and the `tool_execution_start` event carries it verbatim.
	 */
	displayToolIntent(intent: string | undefined): string | undefined {
		if (intent === undefined || intent === "") return intent;
		// DISPLAY PATH: the working line puts this on screen the moment a tool call
		// starts, so it degrades to the literal placeholder and never throws.
		let out = this.#tryExpandSecretsForDisplay(intent) ?? intent;
		if (this.#argot?.loaded) {
			out = this.#argot.expand(out);
		}
		return out;
	}

	#processAgentEvent = async (event: AgentEvent): Promise<void> => {
		if (event.type === "tool_execution_start") {
			this.#verificationEvidence.recordToolStart(event);
		} else if (event.type === "tool_execution_end") {
			this.#verificationEvidence.recordToolEnd(event);
		}
		// Step the mid-run todo counter synchronously, BEFORE any await in this
		// handler. The agent loop's next-turn `getAsideMessages` poll can run
		// before queued microtasks drain, so `#takeMidRunTodoNudge` MUST see the
		// freshest counter — otherwise a turn that just invoked `todo` could
		// trip a spurious nudge against stale state, and a turn that just hit
		// the threshold could fail to nudge until a later turn (issue #3651).
		// Pure in-memory math — no ordering requirement vs persistence or
		// session-event fan-out. Keyed on toolResult (not the assistant toolCall
		// turn) so planned-but-aborted or permission-denied calls never count,
		// and only successful mutating tools tick — read-only exploration is
		// not progress an agent could mark done.
		if (event.type === "message_end" && event.message.role === "toolResult") {
			const { toolName, isError } = event.message;
			if (toolName === TOOL.todo) {
				this.#mutationsSinceLastTodoTouch = 0;
			} else if (!isError && MID_RUN_TODO_NUDGE_MUTATING_TOOLS[toolName]) {
				this.#mutationsSinceLastTodoTouch++;
			}
		}
		// Plan-mode internal transition: stamp `SILENT_ABORT_MARKER` on the
		// persisted message BEFORE the obfuscator's display-side copy below.
		// Invariant (must hold across refactors): this branch precedes the
		// `let displayEvent = event; ... displayEvent = { ...event, message: { ...message, content: deobfuscated } }`
		// block. After stamping, both `displayEvent.message` (via the spread)
		// and `event.message` (in-place mutation, used by SessionManager
		// persistence) carry the marker, guaranteeing streaming render and
		// history replay branch identically. The one-shot flag is consumed
		// here, scoped strictly to this aborted message_end; callers still clear it
		// in `finally` so a leaked flag cannot silence a later unrelated abort.
		if (
			event.type === "message_end" &&
			event.message.role === "assistant" &&
			event.message.stopReason === "aborted"
		) {
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

		const interruptedThinkingMessage =
			event.type === "message_end" && event.message.role === "assistant"
				? this.#demoteInterruptedThinkingOnUserInterrupt(event.message as AssistantMessage)
				: undefined;
		// `message_end` handling is fire-and-forget from agent-core. Make the
		// hidden continuity turn visible to the next prompt before any awaited
		// extension delivery or persistence can stall this handler.
		if (interruptedThinkingMessage) {
			this.agent.appendMessage(interruptedThinkingMessage);
		}

		const messageEndPersistence =
			event.type === "message_end" ? this.#createMessageEndPersistenceSlot(event.message) : undefined;

		// Deobfuscate assistant message content for display emission — the LLM echoes back
		// obfuscated placeholders, but listeners (TUI, extensions, exporters) must see real
		// values. The original event.message stays obfuscated so the persistence path below
		// writes `#HASH#` tokens to the session file; convertToLlm re-obfuscates outbound
		// traffic on the next turn. Walks text, thinking, and toolCall arguments/intent.
		// Argot expansion composes on top of secret deobfuscation on the same
		// display copy: the model echoes cheap handles in history, listeners must
		// see full text. The original event.message keeps the handles so the
		// persistence path and next-turn context stay cheap (the token win).
		let displayEvent: AgentEvent = event;
		if (event.type === "message_start" && event.message.role === "assistant") {
			// Start a fresh per-message argot stream decoder (seam 3): the live
			// preview re-renders the accumulated partial, and a handle can split
			// across deltas, so text/thinking blocks render only decoder-proved text.
			this.#argotStreamDisplay = new ArgotStreamDisplayDecoder(this.#argot);
		}
		if (
			event.type === "message_update" &&
			event.message.role === "assistant" &&
			this.#argotStreamDisplay !== undefined
		) {
			const streamEvent = event.assistantMessageEvent;
			// Decode the whole stream event, not only the accumulated content: a
			// machine consumer that reconstructs text from the delta stream alone
			// (print `--mode json`) must never see a raw §handle, and neither must one
			// reading the event's own `partial`, `content` or `toolCall` payload. The
			// decoded increments sum to the same decoded content decodeContent
			// exposes, so every view agrees and reconciles with the wholesale-expanded
			// message_end message.
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
			// The finished message expands wholesale below; drop the stream state.
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
			// All three carry a whole assistant message, and a front end is free to
			// render from any of them. `message_start` matters for a provider that
			// delivers content up front, and `turn_end` is the one a consumer reaches
			// for when it wants the settled turn — it used to hand back the raw form
			// after `message_end` had just shown the expanded one, so the same text
			// changed under the reader between two adjacent events.
			const message = event.message;
			const content = this.displayAssistantContent(message.content);
			if (content !== message.content) {
				displayEvent = { ...(displayEvent as typeof event), message: { ...message, content } };
			}
		}
		if (event.type === "agent_end") {
			// The closing event repeats the turn's messages, so it repeats every
			// handle in them unless it is expanded like the events it summarises.
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
		// The intent rides on the execution events rather than in the message
		// content, so the content-level expansion above never reaches it. Without
		// this the working line announces a call in raw handle form while the
		// transcript right beneath it shows the same call expanded.
		if (event.type === "tool_execution_start") {
			const intent = this.displayToolIntent(event.intent);
			if (intent !== event.intent) {
				displayEvent = { ...(displayEvent as typeof event), intent };
			}
		}

		if (event.type === "turn_start") {
			const usage = this.getSessionStats().tokens;
			this.#goalRuntime.onTurnStart(`turn-${++this.#goalTurnCounter}`, {
				input: usage.input,
				output: usage.output,
				cacheRead: usage.cacheRead,
				cacheWrite: usage.cacheWrite,
			});
		}

		if (event.type === "tool_execution_start") {
			this.#recordToolExecutionStart(event);
		}

		// Apply state-bearing tool results before the first awaited subscriber.
		// Agent events are delivered independently, so a later agent_end may otherwise
		// evaluate stale todo state while a slow message_end extension is still running.
		if (event.type === "message_end" && event.message.role === "toolResult") {
			const { toolName, toolCallId, details, isError } = event.message as {
				toolCallId?: string;
				toolName?: string;
				details?: { op?: string; path?: string; phases?: TodoPhase[] };
				isError?: boolean;
			};
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
		}

		try {
			await this.#emitSessionEvent(displayEvent);
		} catch (error) {
			messageEndPersistence?.release();
			throw error;
		}

		if (event.type === "turn_start") {
			this.#resetStreamingEditState();
			// TTSR: Reset buffer on turn start
			this.#ttsrManager?.resetBuffer();
		}

		// TTSR: Increment message count on turn end (for repeat-after-gap tracking)
		if (event.type === "turn_end" && this.#ttsrManager) {
			this.#ttsrManager.incrementMessageCount();
		}
		// Finalize the tool-choice queue's in-flight yield after tools have executed.
		// This must happen at turn_end (not message_end) because onInvoked handlers
		// run during tool execution, which happens between message_end and turn_end.
		if (event.type === "turn_end" && this.#toolChoiceQueue.hasInFlight) {
			const msg = event.message as AssistantMessage;
			if (msg.stopReason === "aborted" || msg.stopReason === "error") {
				this.#toolChoiceQueue.reject(msg.stopReason === "error" ? "error" : "aborted");
			} else {
				this.#toolChoiceQueue.resolve();
			}
		}
		if (event.type === "tool_execution_end") {
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
		}
		if (event.type === "tool_execution_end" && this.#isTerminalYieldToolResult(event)) {
			const alreadyTerminated = this.#synchronouslyTerminatedYieldToolCallIds.delete(event.toolCallId);
			if (!alreadyTerminated) {
				this.#markTerminalYieldToolCall(event.toolCallId);
				this.agent.abort(TERMINAL_TOOL_RESULT_ABORT_REASON);
			}
		}

		// TTSR: Check for pattern matches on assistant text/thinking and tool argument deltas
		if (event.type === "message_update" && this.#ttsrManager?.hasRules()) {
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
				// ast-grep `astCondition` rules match against the reconstructed edit/write
				// snapshot, which only exists for tool argument streams. The native worker
				// call is async, so this path is awaited and self-throttled by the manager.
				if (matchContext.source === "tool" && this.#ttsrManager?.hasAstRules()) {
					const astMatches = await this.#checkTtsrAstStream(matchContext, streamingToolCall);
					if (astMatches.length > 0 && this.#handleTtsrMatches(astMatches, matchContext, targetMessageTimestamp)) {
						return;
					}
				}
			}
		}

		if (
			event.type === "message_update" &&
			(event.assistantMessageEvent.type === "toolcall_start" ||
				event.assistantMessageEvent.type === "toolcall_delta" ||
				event.assistantMessageEvent.type === "toolcall_end")
		) {
			void this.#preCacheStreamingEditFile(event);
		}

		if (
			event.type === "message_update" &&
			(event.assistantMessageEvent.type === "toolcall_end" || event.assistantMessageEvent.type === "toolcall_delta")
		) {
			this.#maybeAbortStreamingEdit(event);
		}

		// Handle session persistence
		if (event.type === "message_end") {
			const persistMessageEnd = () => {
				// Check if this is a hook/custom message
				if (event.message.role === "hookMessage" || event.message.role === "custom") {
					// Persist as CustomMessageEntry
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
			if (messageEndPersistence) {
				await messageEndPersistence.persist(persistMessageEnd);
			} else {
				persistMessageEnd();
			}
			if (interruptedThinkingMessage) {
				this.sessionManager.appendCustomMessageEntry(
					interruptedThinkingMessage.customType,
					interruptedThinkingMessage.content,
					interruptedThinkingMessage.display,
					interruptedThinkingMessage.details,
					interruptedThinkingMessage.attribution,
				);
			}
			// Other message types (bashExecution, compactionSummary, branchSummary) are persisted elsewhere

			// Track assistant message for auto-compaction (checked on agent_end)
			if (event.message.role === "assistant") {
				this.#lastAssistantMessage = event.message;
				const assistantMsg = event.message as AssistantMessage;
				// Fold this turn's timing into per-model perf aggregates (drives the
				// /models TPS/TTFT display). Errored turns measure nothing; aborted
				// turns with reported usage are still valid throughput samples.
				if (assistantMsg.stopReason !== "error" && assistantMsg.duration !== undefined) {
					this.settings.getStorage()?.recordModelPerf(`${assistantMsg.provider}/${assistantMsg.model}`, {
						outputTokens: assistantMsg.usage.output,
						durationMs: assistantMsg.duration,
						ttftMs: assistantMsg.ttft,
					});
				}
				if (
					assistantMsg.disabledFeatures?.includes("priority") &&
					this.#serviceTierByFamily.anthropic === "priority"
				) {
					this.setServiceTierFamily("anthropic", undefined);
					this.emitNotice(
						"warning",
						`${PRIORITY_TIER_COMMAND_LABEL} rejected for this model; retried without it. It is now off.`,
						"priority",
					);
				}
				// Resolve TTSR resume gate before checking for new deferred injections.
				// Gate on #ttsrAbortPending, not stopReason: a non-TTSR abort (e.g. streaming
				// edit) also produces stopReason === "aborted" but has no continuation coming.
				// Only skip when #ttsrAbortPending is true (TTSR continuation is imminent).
				if (!this.#ttsrAbortPending) {
					this.#resolveTtsrResume();
				}
				this.#queueDeferredTtsrInjectionIfNeeded(assistantMsg);
				if (this.#handoffAbortController) {
					this.#skipPostTurnMaintenanceAssistantTimestamp = assistantMsg.timestamp;
				}
				if (
					assistantMsg.stopReason !== "error" &&
					assistantMsg.stopReason !== "aborted" &&
					!this.#isEmptyAssistantStop(assistantMsg) &&
					this.#retryAttempt > 0
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
						attempt: this.#retryAttempt,
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
			if (event.message.role === "toolResult") {
				const { toolName, details, isError, content } = event.message as {
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
				// A call the batch never dispatched, and a call an interrupt cut short,
				// both arrive here carrying isError. Neither is a verdict on the payload:
				// the board is stale because the write never landed, not because it was
				// refused, so the advice below is for a problem that does not exist. The
				// headline is also fixed per source, so two interrupts in a row read as
				// one failure repeating and retire todo for the rest of the turn over an
				// event that never happened. Leave the failure memory untouched rather
				// than clearing it: a skip is not a landed write either.
				const todoCallDidNotFail = details?.__synthetic === true || details?.__skipped === true;
				if (toolName === TOOL.todo && !todoCallDidNotFail) {
					const errorText = isError ? (content?.find(part => part.type === "text")?.text ?? "") : undefined;
					if (errorText === undefined) {
						// A landed write makes the board authoritative again.
						this.#lastTodoFailureText = undefined;
					} else {
						const repeated = errorText === this.#lastTodoFailureText;
						this.#lastTodoFailureText = errorText;
						const reminderText = [
							"<system-reminder>",
							"todo failed, so todo progress is not visible to the user and the recorded board may be stale.",
							errorText ? `Failure: ${errorText}` : "Failure: todo returned an error.",
							// Repeating "call todo again" after an identical failure asks for a
							// call that already proved impossible, and each attempt costs a turn.
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
		}

		// Check auto-retry and auto-compaction after agent completes
		if (event.type === "agent_end") {
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
			const fallbackAssistant = [...settledMessages]
				.reverse()
				.find((message): message is AssistantMessage => message.role === "assistant");
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

			// Invalidate GitHub Copilot credentials on auth failure so stale tokens
			// aren't reused on the next request
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
			// A successful `yield` in this run is terminal for execution purposes.
			// Suppress empty-stop retry, unexpected-stop retry, queued-message drain,
			// and compaction-driven continuations for the rest of this prompt cycle:
			// the executor consumed the yield as the terminal result, so a trailing
			// empty/aborted assistant stop must NOT revive the agent loop. The
			// `#yieldTerminationPending` sticky flag clears on the next `prompt()`.
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

			// One reading of "this reply is waiting on the user", shared by every
			// route below. Computed once here rather than inside each guard because
			// the bug was precisely that they disagreed: only the todo reminder
			// looked, so whether a question survived depended on which guard was
			// armed. Read before the first guard runs, so the two retry guards that
			// settle earliest see the same answer as the four that settle last.
			const settleState: SettleContinuationState = { awaitingUserAnswer: isAwaitingUserAnswer(msg) };
			// Empty-stop cleanup MUST run before any compaction continuation: an
			// empty toolUse stop must be stripped from active context + session
			// history before we schedule another turn, otherwise the next
			// Anthropic turn carries a tool_use block with no matching
			// tool_result and corrupts message history. The handler also
			// schedules its own retry, so a real empty stop never needs the
			// active-goal threshold pre-empt below.
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

			// A deliberate abort should settle the current turn, not trigger queued continuations.
			if (msg.stopReason === "aborted") {
				this.#resolveRetry();
				this.#resetSessionStopContinuationState();
				await emitAgentEndNotification();
				return;
			}
			// Fireworks Fast variants degrade to their base model on a failed turn —
			// including hard router errors the generic retry classifier rejects — so
			// run this gate before the standard retryability check.
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
				// A non-retryable hard error on a model covered by a configured
				// fallback chain: retrying the SAME model is pointless, but a
				// DIFFERENT model is a fresh chance — consult the chain before
				// surfacing the failure. #handleRetryableError bails out (no
				// backoff-retry of the failing model) when no switch happens.
				const didRetry = await this.#handleRetryableError(msg, { hardErrorFallback: true });
				if (didRetry) {
					await emitAgentEndNotification();
					return;
				}
			}
			// Classifier refusals are persisted-skipped above; also prune the trailing
			// stub from active context so the next turn's prompt does not replay it.
			// Fall through to the standard error tail so `session_stop` hooks (block,
			// continue, telemetry) still fire — matching the pre-fix flow for
			// `stopReason === "error"`.
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
			// Stop-time todo reconciliation only fires at a text-only final stop. A run
			// that ends still mid-tool-use (deadline hit, context full, etc.) skips the
			// reminder so we don't pile a follow-up onto an already in-flight turn.
			// Mid-run sync is handled separately via #takeMidRunTodoNudge so a long
			// tool-use loop still gets prodded to keep the live HUD honest (issue #3651).
			const hasToolCalls = msg.content.some(content => content.type === "toolCall");
			if (hasToolCalls) {
				await emitAgentEndNotification();
				return;
			}
			// When compaction queued recovery or hit a deliberate dead-end, skip the
			// rewind/todo/session_stop passes: any reminder or hook continuation we append
			// here would race the retry, auto-continue prompt, queued-message drain, or
			// the explicit pause that is preventing a compaction loop.
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
					mayContinueAtSettle("plan-mode-decision", settleState) &&
					(await this.#enforcePlanModeDecisionAtSettle());
				if (planModeContinuationScheduled) {
					await emitAgentEndNotification();
					return;
				}
				// Called unconditionally: its first statement consumes the served
				// tool-choice label, and skipping that leaks a `user-force` label
				// onto the next turn. The hold is a parameter instead.
				const todoContinuationScheduled = await this.#checkTodoCompletion(settleState);
				if (todoContinuationScheduled) {
					await emitAgentEndNotification();
					return;
				}
			}
			// A pending async wake means this settle is a scheduling pause, not
			// the terminal stop: the async-result delivery continues the loop and
			// the real stop settles later. Defer the session_stop hook pass until
			// the session is fully idle (the todo reminder above defers the same
			// way inside #checkTodoCompletion).
			if (this.#hasPendingAsyncWake()) {
				await emitAgentEndNotification();
				return;
			}
			// Gated BEFORE the enforcer runs: it drains the ledger's one reminder
			// as it reads it, so deferring from inside would spend the reminder it
			// meant to keep.
			if (mayContinueAtSettle("verification-evidence", settleState) && this.#enforceVerificationBeforeFinalize()) {
				await emitAgentEndNotification();
				return;
			}
			await this.#emitSessionStopEvent(settledMessages, msg);
			await emitAgentEndNotification();
		}
	};

	/** Resolve the pending retry promise */
	#resolveRetry(): void {
		if (this.#retryResolve) {
			this.#retryResolve();
			this.#retryResolve = undefined;
			this.#retryPromise = undefined;
		}
	}

	/** Create the TTSR resume gate promise if one doesn't already exist. */
	#ensureTtsrResumePromise(): void {
		if (this.#ttsrResumePromise) return;
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#ttsrResumePromise = promise;
		this.#ttsrResumeResolve = resolve;
	}

	/** Resolve and clear the TTSR resume gate. */
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
		// The task's own failure is reported wherever it was created; this only tracks completion so
		// `#postPromptTasks` drains, and a rejection here must not become an unhandled one.
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
				// Defense in depth: do not start a fresh streaming turn while any
				// context maintenance or explicit handoff is already active.
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
			// Compaction summarizes away the first-message eager preludes, so re-assert the
			// delegate-via-tasks / phased-todo reminders on this auto-resumed turn. This runs
			// at invocation (past the abort check below), so an aborted continuation queues
			// nothing; scoped to this request via prependMessages, never the shared queue.
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
	/**
	 * Wait for retry, TTSR resume, and any background continuation to settle.
	 * Loops because a TTSR continuation can trigger a retry (or vice-versa),
	 * and fire-and-forget `agent.continue()` may still be streaming after
	 * the TTSR resume gate resolves.
	 */
	async #waitForPostPromptRecovery(generation?: number): Promise<void> {
		while (true) {
			// An abort bumps #promptGeneration. When this wait runs on behalf of a
			// specific prompt turn, stop as soon as that turn has been superseded:
			// its promise must resolve on the abort, not block on a queued
			// steer/follow-up that the post-abort drain starts as a fresh turn.
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
			// Tracked post-prompt tasks cover deferred continuations scheduled from
			// event handlers. Keep the streaming fallback for direct agent activity
			// outside the scheduler.
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

	/**
	 * Resolve a rule body's template against the live session, for either delivery path.
	 *
	 * ONE owner, because there are TWO ways a rule reaches the model and only one of them used to
	 * render. A stream-interrupting rule went through here; a tool-scoped rule (`interruptMode:
	 * never` matching on a tool stream) had its RAW body folded into the tool result by
	 * `#ttsrAfterToolCall`. That is the path `cwd-reroot` always takes, so the model was shown
	 * `{{#if argot}}` markup verbatim — the exact leak `discovery/builtin-defaults.test.ts` exists to
	 * prevent, bypassed on the only path that rule uses.
	 *
	 * - `argot` gates advice to call `argot_load`, a tool that is not registered by default.
	 * - `cwd` lets a rule say where the session currently is.
	 * - `matchedPath` lets a rule name what triggered it; it is set only for a rule with a
	 *   `pathScope`, so a body that uses it must guard the reference.
	 * - `commitDrift` carries the uncommitted count and file list, and is absent when there is
	 *   nothing to report — so a rule body gated on it stays silent rather than saying "0 files".
	 */
	#renderRuleBody(rule: Rule): string {
		const argotEnabled = this.settings.get("argot.enabled") === true;
		return prompt.render(rule.content, {
			argot: argotEnabled,
			// Whether the nudge to LOAD shorthand still applies, which is a different question from
			// whether the feature is on: telling a model to load a dictionary it already loaded is
			// advice it cannot act on. `unless` does not exist in the template language, so the
			// condition a rule wants to gate on has to be passed already inverted.
			argotUnloaded: argotEnabled && this.#argot?.loaded !== true,
			cwd: this.sessionManager.getCwd(),
			matchedPath: this.#ttsrManager?.lastMatchedPath(rule.name),
			// Undefined rather than a zero count when the nudge should not fire: the gate
			// that decides is `{{#if commitDrift}}`, and a `{ count: 0 }` object is truthy.
			commitDrift: this.settings.get("git.enabled")
				? this.#commitDrift.summary(this.sessionManager.getCwd(), this.settings.get("commit.nudgeAfterFiles"))
				: undefined,
		});
	}

	/**
	 * Keep only matches that will actually say something to the model.
	 *
	 * A rule body may be entirely wrapped in a `{{#if}}` gate — `argot-load-nudge` is, because its
	 * advice is to call a tool that only exists when argot is enabled. When the gate is closed the
	 * body renders to nothing, and delivering that is worse than not firing: an empty
	 * `<system-reminder>` spends tokens, interrupts a stream on the interrupting path, marks the rule
	 * as injected so it cannot fire when the gate later opens, and tells the model that a rule was
	 * violated without saying which behaviour to change.
	 *
	 * Dropped here rather than at either delivery site, so the decision is made once, before the
	 * claim is taken and before `ttsr_triggered` is emitted. The drop is LOGGED at warn: a bundled
	 * rule that can never say anything is a packaging bug, and it must not be silent.
	 */
	#deliverableTtsrMatches(matches: Rule[]): Rule[] {
		const deliverable: Rule[] = [];
		for (const rule of matches) {
			if (this.#renderRuleBody(rule).trim().length > 0) {
				deliverable.push(rule);
				continue;
			}
			// A body wrapped in a `{{#if}}` gate rendering empty is the gate WORKING, and it happens on
			// every match for as long as the gate is closed, so it is reported at debug. A body with no
			// gate that renders empty cannot ever say anything: that is a packaging bug in the rule and
			// it is reported at warn, where an operator will see it.
			const gated = rule.content.includes("{{#if");
			const message = "TTSR rule matched but its body renders empty, not delivering";
			const fields = { ruleName: rule.name, path: rule.path, gated };
			if (gated) logger.debug(message, fields);
			else logger.warn(message, fields);
		}
		return deliverable;
	}

	/** Get TTSR injection payload and clear pending injections. */
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

	/**
	 * Render a rule's file path for model-facing TTSR injections without leaking
	 * the absolute home directory: cwd-relative when the rule lives in the
	 * project, `~`-relative when it lives under home, else the raw path.
	 */
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

	/** Tool-call id whose argument deltas triggered a TTSR match, when known. */
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
		// Dedupe against rules already bucketed for other tool calls in this
		// same assistant message so one rule attaches to exactly one tool call.
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
		// Claim the rules in the TTSR manager so subsequent deltas in this same
		// turn (e.g. a sibling tool call's argument stream) don't re-match them.
		// Persistence still happens in #ttsrAfterToolCall when the tool actually
		// produces a result we can fold the reminder into. The claim is PROVISIONAL:
		// #dropUndeliveredPerToolInjections gives it back if that never happens.
		if (newlyAdded.length > 0) {
			this.#ttsrManager?.markInjectedByNames(newlyAdded);
		}
	}

	/**
	 * Drop tool-scoped reminders that will never be delivered, and give their claims back.
	 *
	 * A tool-scoped reminder is claimed when it is bucketed and delivered later, in `afterToolCall`.
	 * A turn that is aborted or errors never reaches that hook, so the bucket has to be discarded —
	 * and the claim discarded with it. Clearing the bucket alone left the rule marked as injected
	 * with nothing ever shown to the model, and under the default `repeatMode: "once"` that is
	 * permanent for the session: one interrupted turn silently retires the rule.
	 *
	 * This is why `cwd-reroot` "just did not fire". The state that suppressed it is indistinguishable
	 * from the state after a successful injection, so nothing anywhere reported a problem.
	 */
	#dropUndeliveredPerToolInjections(): void {
		if (this.#perToolTtsrInjections.size === 0 && this.#pendingTtsrToolReminders.length === 0) return;
		const undelivered = new Set<string>();
		for (const bucket of this.#perToolTtsrInjections.values()) {
			for (const rule of bucket) undelivered.add(rule.name);
		}
		// A reminder rendered but not yet drained as an aside is undelivered too.
		// The turn dying between `afterToolCall` and the next step boundary is the
		// same loss as the turn dying before the tool ran, so it releases the same way.
		for (const reminder of this.#pendingTtsrToolReminders) {
			for (const name of reminder.rules) undelivered.add(name);
		}
		this.#perToolTtsrInjections.clear();
		this.#pendingTtsrToolReminders = [];
		this.#ttsrManager?.releaseInjectedByNames([...undelivered]);
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
		// Before the TTSR delivery below, so `commit-drift` counts the edit that just
		// landed. Recording after it would make the nudge describe the tree as it was one
		// edit ago, and it fires on exactly the tools that change that number.
		if (!ctx.isError && this.settings.get("git.enabled")) {
			this.#commitDrift.record(ctx.toolCall.name, ctx.result?.details, this.sessionManager.getCwd());
		}
		return this.#ttsrAfterToolCall(ctx);
	}

	/**
	 * `afterToolCall` hook: queue any per-tool TTSR reminders for model-only delivery.
	 *
	 * This used to PREPEND the rendered reminder into `ctx.result.content`. Two things
	 * fell out of that, both reported from one screenshot. The reminder is model-directed
	 * `<system-reminder>` markup and a tool result is a surface the user reads, so the
	 * markup was shown to them, duplicating the `Injecting rule:` banner already on screen.
	 * And on a call that ALSO errored the reminder became the first text block, which is
	 * what the TUI prints as the error headline, so the real failure was pushed out of view
	 * for the user and displaced for the model.
	 *
	 * Appending would have fixed only the second half. The interrupting path has always
	 * delivered its reminder as a `display: false` `ttsr-injection` custom message, so this
	 * takes the same channel and the two paths now differ only in timing: an aside rides the
	 * next step boundary, which is before the model's next call and after the batch in flight
	 * finishes. A steer would reach the model just as promptly but aborts the remaining tool
	 * calls in the batch, and a reminder about a call that already returned must not do that.
	 *
	 * Persistence moves with the delivery. `message_end` marks and records any
	 * `ttsr-injection` custom message, so recording here as well would double-count, and
	 * recording here at all would claim a delivery that a dying turn never makes.
	 */
	#ttsrAfterToolCall(ctx: AfterToolCallContext): AfterToolCallResult | undefined {
		const rules = this.#perToolTtsrInjections.get(ctx.toolCall.id);
		if (!rules || rules.length === 0) return undefined;
		this.#perToolTtsrInjections.delete(ctx.toolCall.id);
		// The reminder states that the tool ran. On an errored or skipped call that is
		// false, and a false statement about what just happened is worse than no reminder.
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

	/** Drain queued tool-scoped TTSR reminders as one model-only aside, if any wait. */
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
			// Tools that hadn't started by abort/error will never produce results to
			// fold injections into — drop their stale per-tool entries AND give back the
			// claims they took, or the rules stay retired for the rest of the session
			// having shown the model nothing.
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
		// Mark as injected after this custom message is delivered and persisted (handled in message_end).
		// followUp() only enqueues; resume on the next tick once streaming settles.
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

	/** Extract the tool-call block a toolcall_delta event refers to, if present. */
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

	/** Build TTSR match context for tool call argument deltas. */
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

	/**
	 * Resolve the file paths a tool call would touch for TTSR path-glob matching.
	 *
	 * Prefer the tool's own `matcherPaths` hook — it understands the wire format
	 * (hashline `[path#TAG]` section headers, apply_patch envelope markers) and
	 * surfaces paths the generic top-level argument scan never sees. Fall back
	 * to {@link #extractTtsrFilePathsFromArgs} for tools that pass paths as
	 * `path`/`paths` arguments and for tool calls whose payload has not yet
	 * streamed a header.
	 */
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

	/**
	 * Match a stream delta against TTSR rules.
	 *
	 * Tool argument streams prefer the tool's `matcherDigest` normalization — the
	 * real content the call introduces — over the raw argument delta, so rule
	 * conditions written against source text keep working regardless of the
	 * tool's wire format (hashline patches, JSON-escaped strings, ...).
	 */
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

	/** Reconstruct the tool's normalized source snapshot via its `matcherDigest`, if any. */
	#resolveTtsrMatcherDigest(toolCall: ToolCall | undefined): string | undefined {
		const tool = this.#resolveTtsrTool(toolCall);
		return tool?.matcherDigest?.(toolCall?.arguments ?? {});
	}

	/**
	 * Per-file split of a streamed call (one entry per touched file paired with
	 * the digest of only that file's added lines). Lets {@link #checkTtsrStream}
	 * and {@link #checkTtsrAstStream} evaluate each file in isolation so a
	 * path-scoped rule like `tool:edit(*.ts)` never fires on text that belongs
	 * to a sibling Markdown hunk in a multi-file payload.
	 */
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

	/**
	 * Replace `matchContext`'s `filePaths` + `streamKey` so a per-file entry
	 * gets its own glob-eligible path and its own TTSR buffer/repeat tracking
	 * (each file's stream is independent inside the same tool call).
	 */
	#perFileTtsrContext(base: TtsrMatchContext, filePath: string): TtsrMatchContext {
		const filePaths = this.#normalizeTtsrPathCandidates(filePath);
		return {
			...base,
			filePaths: filePaths.length > 0 ? filePaths : [filePath],
			streamKey: base.streamKey ? `${base.streamKey}#${filePath}` : undefined,
		};
	}

	/**
	 * Match ast-grep `astCondition` rules against the reconstructed tool snapshot.
	 *
	 * Only edit/write tool streams expose a `matcherDigest`, which is the real source
	 * the call introduces; AST matching needs that (and a language inferred from the
	 * path argument), so non-digest streams never produce AST matches.
	 */
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

	/**
	 * Route TTSR matches to either a per-tool injection or a stream-interrupting
	 * retry. Returns true when the stream was aborted and the caller should stop
	 * processing this event.
	 */
	#handleTtsrMatches(
		rawMatches: Rule[],
		matchContext: TtsrMatchContext,
		targetMessageTimestamp: number | undefined,
	): boolean {
		// A rule whose body renders to nothing is dropped before anything is claimed or emitted.
		const matches = this.#deliverableTtsrMatches(rawMatches);
		if (matches.length === 0) {
			return false;
		}
		// Decide first: a non-interrupting tool-source match attaches to the
		// specific tool call's result instead of driving a loop-wide follow-up.
		const shouldInterrupt = this.#shouldInterruptForTtsrMatch(matches, matchContext);
		const matchedToolId = this.#extractTtsrToolCallId(matchContext);
		const perToolId = shouldInterrupt ? undefined : matchedToolId;
		if (perToolId) {
			this.#addPerToolTtsrInjections(perToolId, matches);
			this.#emitSessionEventDetached({ type: "ttsr_triggered", rules: matches }, "ttsr-per-tool");
			return false;
		}

		// Queue rules for injection; mark as injected only after successful enqueue.
		this.#addPendingTtsrInjections(matches);
		if (!shouldInterrupt) {
			return false;
		}

		// Abort the stream immediately — do not gate on extension callbacks
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
		// Notify extensions (fire-and-forget, does not block abort)
		this.#emitSessionEventDetached({ type: "ttsr_triggered", rules: matches }, "ttsr-interrupt");
		// Schedule retry after a short delay
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
				// The interrupting rules are about to be injected as a system reminder; any
				// TOOL-scoped buckets from the same turn are not, so their claims go back.
				this.#dropUndeliveredPerToolInjections();
				const ttsrSettings = this.#ttsrManager?.getSettings();
				if (ttsrSettings?.contextMode === "discard") {
					// Remove the partial/aborted assistant turn from agent state
					this.agent.replaceMessages(this.agent.state.messages.slice(0, targetAssistantIndex));
				}
				// Inject TTSR rules as system reminder before retry
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

	/** Extract path-like arguments from tool call payload for TTSR glob matching. */
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

	/** Convert a path argument into stable relative/absolute candidates for glob checks. */
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
	/** Find the last assistant message in agent state (including aborted ones) */
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
		const exemptTools = this.settings
			.get("model.toolCallLoopGuard.exemptTools")
			.filter((tool): tool is string => typeof tool === "string" && tool.length > 0);
		const settingsKey = `${threshold}:${JSON.stringify(exemptTools)}`;
		if (!this.#toolCallLoopGuard || this.#toolCallLoopGuardSettingsKey !== settingsKey) {
			this.#toolCallLoopGuard = new ToolCallLoopGuard({ threshold, exemptTools });
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

	/**
	 * Whether the Gemini header-runaway guard applies to the current model: the loop
	 * guard is on (settings + `VEYYON_NO_THINKING_LOOP_GUARD`), the tool-call reminder is
	 * enabled, and the active model is a Gemini thinking model.
	 */
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

	/**
	 * Feed streamed assistant events to the Gemini header-runaway detector. Each
	 * reasoning block (`thinking_start`) re-arms a fresh detector when the guard
	 * applies; thinking deltas accumulate thought-summary headers; assistant prose
	 * or a tool call ends the run. On the threshold hit, interrupts the stream (see
	 * {@link #interruptGeminiHeaderRunaway}). Runs synchronously inside the
	 * assistant-message interceptor so the abort lands before more budget burns.
	 * Armed on `thinking_start` (not `turn_start`, which the agent loop skips for the
	 * first turn) so the very first reasoning block is guarded too.
	 */
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
		// Leaving the reasoning channel ends the run: the consecutive-header count
		// only matters within one uninterrupted stretch of reasoning.
		if (event.type === "text_start" || event.type === "toolcall_start") {
			detector.reset();
		}
	}

	/**
	 * Interrupt a Gemini reasoning stream that has emitted too many consecutive
	 * planning headers without calling a tool. Aborts the live turn, discards the
	 * stalled reasoning-only turn (so its partial, loop-fueling thinking is neither
	 * replayed nor reloaded), injects a hidden tool-call reminder, and continues.
	 * `targetTimestamp` identifies the turn being aborted so the post-prompt task
	 * can drop exactly it.
	 */
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
			// Let the aborted stream finish unwinding so continue() doesn't race it.
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
				logger.warn("gemini tool-call reminder continue failed", { error: String(err) });
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

		// `local://` URLs (e.g. local://PLAN.md for plan-mode) resolve to a real
		// on-disk artifacts path; pre-caching works as long as we ask the
		// local-protocol handler. Other internal-scheme URLs (agent://, skill://,
		// rule://, mcp://, artifact://) have no stable filesystem representation;
		// skip pre-cache entirely for those — the edit tool itself will reject
		// them through its normal dispatch path.
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
			// peekFile and other I/O can reject with ENOENT, etc. Only ToolError means
			// auto-generated detection; other failures are left for the edit tool.
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

		// The auto-generated guard runs unconditionally: editing a generated file
		// is never the user's intent, and the cost of a false-positive abort is one
		// wasted turn vs. silently corrupting a regenerated source.
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

		// File-cache priming feeds #maybeAbortStreamingEdit's removed-lines check,
		// which is the optional patch-preview verification gated by
		// edit.streamingAbort. Skip the read when the setting is off.
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
		} catch {
			// Don't cache on read errors (including ENOENT) - let the edit tool handle them
		}
	}

	/** Invalidate cache for a file after an edit completes to prevent stale data */
	#invalidateFileCacheForPath(filePath: string): void {
		const resolvedPath = this.#resolveSessionFsPath(filePath);
		if (resolvedPath === undefined) return;
		this.#streamingEditFileCache.delete(resolvedPath);
	}

	/**
	 * Resolve a path supplied to a tool to a real filesystem path.
	 *
	 * - `local://` URLs route through the local-protocol handler so they map
	 *   onto the session's on-disk artifacts directory; pre-caching, ENOENT
	 *   handling, and post-edit invalidation all work normally.
	 * - Other internal-scheme URLs (agent://, skill://, rule://, mcp://,
	 *   artifact://) have no stable filesystem path; this returns `undefined`
	 *   so callers skip filesystem-only operations.
	 * - Cwd-relative and absolute paths resolve via `resolveToCwd`.
	 */
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

	#localProtocolOptions(): LocalProtocolOptions {
		return {
			getArtifactsDir: () => this.sessionManager.getArtifactsDir(),
			getSessionId: () => this.sessionManager.getSessionId(),
		};
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
		// INTERNAL CONTROL PATH, neither a spend nor display: the expanded diff is
		// only compared against the file on disk to decide an early abort.
		// Deobfuscate so removed lines match real file content, and when a live
		// placeholder cannot be expanded from a fresh runtime, skip the check
		// outright instead of degrading: an unexpanded `#HASH#` would not match the
		// file and would abort a legitimate edit, which is worse than never
		// aborting. Never throws, because this runs inside the agent event dispatch.
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
			// Ignore ENOENT (file not found) - let the edit tool handle missing files
			// Also ignore other errors during async fallback
			if (!isEnoent(err)) {
				// Log unexpected errors but don't abort
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

	/** Emit extension events based on session events */
	async #emitExtensionEvent(event: AgentSessionEvent): Promise<void> {
		if (!this.#extensionRunner) return;
		if (event.type === "agent_start") {
			this.#turnIndex = 0;
			await this.#extensionRunner.emit({ type: "agent_start" });
			return;
		}

		if (!this.#extensionRunner.hasHandlers(event.type)) return;
		if (event.type === "agent_end") {
			// `agent_end` extension notification is emitted from the settled
			// agent_end maintenance path so `session_stop` control hooks are not
			// blocked by unrelated notification-only work.
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
			});
		} else if (event.type === "auto_retry_end") {
			await this.#extensionRunner.emit({
				type: "auto_retry_end",
				success: event.success,
				attempt: event.attempt,
				finalError: event.finalError,
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

	/**
	 * Subscribe to agent events.
	 * Session persistence is handled internally (saves messages on message_end).
	 * Multiple listeners can be added. Returns unsubscribe function for this listener.
	 */

	/**
	 * Everything that has to be re-read when the session's working directory
	 * moves, for every mode.
	 *
	 * This used to live in `InteractiveMode.applyCwdChange` and ONLY there, reached
	 * through the TUI's `cwd_changed` handler. So an SDK session, an ACP session, a
	 * headless run and every subagent re-rooted with the previous project's
	 * settings, provider exclusions, plugin roots, capabilities and system prompt
	 * still live: the base prompt states the cwd verbatim, so those modes went on
	 * naming a directory the session had left, and the model read the old project's
	 * AGENTS.md while resolving relative paths against the new one.
	 *
	 * ORDER IS LOAD-BEARING. The base system prompt is assembled from settings,
	 * capabilities and plugin roots, so it is rebuilt LAST, once every input to it
	 * has been re-scoped. `refreshBaseSystemPrompt` also invalidates the provider
	 * prompt-cache key when the content changes, so the stale prefix is not re-served.
	 *
	 * WHOSE STATE MOVES depends on who is asking. The process-global half lives in
	 * `#rescopeProcessToCwd` and runs only for the session that owns the process; a
	 * subagent re-roots itself and leaves its parent and its siblings where they are.
	 *
	 * REPEATING A DIRECTORY IS SKIPPED, and that is not an optimization: the TUI
	 * reaches this twice for one move. `setCwd` calls it and then emits
	 * `cwd_changed`, whose handler calls `applyCwdChange`, which calls it again for
	 * the same destination. Doing the work twice would reload settings, reset
	 * capabilities and rebuild the prompt a second time, and the rebuild is a full
	 * prompt-cache invalidation. The guard remembers the LAST directory rescoped,
	 * not every directory seen, so moving away and back still rescopes: what makes
	 * the second call redundant is that nothing changed in between, and something
	 * did change if another directory was rescoped meanwhile.
	 */
	rescopeToCwd(cwd: string): Promise<void> {
		return this.#runScopeTransition(() => this.#rescopeToCwd(cwd));
	}

	async #rescopeToCwd(cwd: string): Promise<void> {
		const normalizedCwd = path.resolve(cwd);
		if (this.#lastRescopedCwd === normalizedCwd) return;

		// Re-scope the Settings instance owned by THIS session before loading any
		// runtime candidate. The process singleton may be a different instance
		// (SDK/embedded and subagent sessions commonly use isolated Settings).
		await this.settings.reloadForCwd(normalizedCwd);

		// A subagent may not mutate process-global cwd/capability state, but its
		// session-owned settings, secrets, tools, prompt, and advisors still move.
		if (!this.#isSubagent) await this.#rescopeProcessToCwd(normalizedCwd);
		await this.#refreshSecrets({ refreshPrompt: false });
		await this.refreshSshTool({ activateIfAvailable: true });
		await this.refreshBaseSystemPrompt("cwd-change");
		this.#lastRescopedCwd = normalizedCwd;
	}

	/**
	 * The half of a re-root that belongs to the PROCESS, not to one session.
	 *
	 * Every line here writes state shared by everything running in this process,
	 * which is why only the session that owns the process runs it. Kept as its own
	 * method so that boundary is a thing you can see rather than a comment you have
	 * to trust: anything added here is process-global by construction, and anything
	 * session-scoped belongs in {@link AgentSession.rescopeToCwd} beside the prompt
	 * refresh.
	 *
	 * ORDER IS LOAD-BEARING with the caller's: the base system prompt is assembled
	 * from settings, capabilities and plugin roots, so it is rebuilt after all of
	 * these, once every input to it has been re-scoped.
	 */
	async #rescopeProcessToCwd(cwd: string): Promise<void> {
		// Align process project dir so status-line / discovery readers that still
		// consult getProjectDir() stay consistent with the live session root.
		setProjectDir(cwd);
		// Provider preferences are process-wide, but their source is the
		// destination scope of this session's Settings instance.
		applyProviderGlobalsFromSettings(this.settings);
		clearClaudePluginRootsCache();
		resetCapabilities();
	}

	/**
	 * Re-root the live session working directory for this session only.
	 * Updates SessionManager cwd + header, aligns process project dir, re-scopes
	 * settings/capabilities/plugins/prompt via {@link AgentSession.rescopeToCwd},
	 * emits `cwd_changed`, and injects a visible/context system note. Never writes
	 * profile `session.workdir` or other persisted settings.
	 */
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

	/**
	 * Atomically relocate session storage/artifacts and the complete cwd-derived
	 * runtime. A failed re-scope moves storage back before exposing the error.
	 */
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
		this.#wirePathRoots = normalizeRoots([...this.#wirePathRoots, cwd]);
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

	/** Cumulative outbound bytes elided by wire path relativization (TW-10). */
	get wirePathBytesSaved(): number {
		return this.#wirePathBytesSaved;
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
		return this.#thoughtSignatureBytesSaved;
	}

	subscribe(listener: AgentSessionEventListener): () => void {
		this.#eventListeners.push(listener);

		// Return unsubscribe function for this specific listener
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
		const listeners = [...this.#commandMetadataChangedListeners];
		for (const listener of listeners) {
			// `CommandMetadataChangedListener` is `() => void | Promise<void>`, so
			// the published contract INVITES an async listener, but a `catch`
			// only ever observes a SYNCHRONOUS throw. The old `void listener()`
			// discarded the promise, so a rejecting async subscriber walked past
			// the handler three lines below and reached postmortem's global
			// `unhandledRejection` hook, which prints a crash report and calls
			// `process.exit(1)`. `setMCPPromptCommands` runs on every MCP prompt
			// (re)load, reconnects included, so one bad subscriber killed a
			// working session at a moment the user did not act. Both arms now
			// land in the SAME sink with the SAME message: to an operator a
			// rejection and a throw are one greppable failure.
			try {
				// `unknown` so `instanceof` narrows cleanly off the `void` arm.
				// Only a listener that actually returned a promise allocates.
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

	/**
	 * Temporarily disconnect from agent events.
	 * User listeners are preserved and will receive events again after resubscribe().
	 * Used internally during operations that need to pause event processing.
	 */
	#disconnectFromAgent(): void {
		if (this.#unsubscribeAgent) {
			this.#unsubscribeAgent();
			this.#unsubscribeAgent = undefined;
		}
	}

	/**
	 * Reconnect to agent events after _disconnectFromAgent().
	 * Preserves all existing listeners.
	 */
	#reconnectToAgent(): void {
		if (this.#unsubscribeAgent) return; // Already connected
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

	/**
	 * Drop the provider prompt cache key this session inherited, recording why.
	 *
	 * `reason` is required for the same purpose as on `refreshBaseSystemPrompt`:
	 * every caller here is spending a full re-prefill, and a discard with no name
	 * is a cost nobody can attribute afterwards. The record is only appended when a
	 * key was actually inherited, so a session that never had one does not
	 * accumulate phantom discards.
	 */
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

	/** Every provider cache-key discard this session paid for, in order, by reason. */
	providerCacheKeyDiscards(): readonly string[] {
		// Frozen copy, matching `systemPromptInvalidations`: this is cost evidence,
		// and a reader that trimmed the live array would under-report re-prefills.
		return Object.freeze([...this.#providerCacheKeyDiscards]);
	}

	/**
	 * Set agent.sessionId from the session manager and install a dynamic
	 * metadata resolver so every Anthropic API request carries
	 * `metadata.user_id` shaped like real Claude Code's `getAPIMetadata` output:
	 * `{ session_id, account_uuid, device_id }`. `account_uuid` is included only
	 * when an Anthropic OAuth credential with a known account UUID is loaded;
	 * `device_id` is derived from both the persistent veyyon install id and that
	 * account UUID. Resolving live keeps the value in sync with auth-state changes
	 * (login/logout, token refresh that surfaces a new account UUID) without
	 * needing to re-call `#syncAgentSessionId()` on every such event.
	 */
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

	/** New session file: reset auto-recall / retain-threshold counters for the new transcript. */
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

	/**
	 * Forget what the previous conversation was told, on every path that starts a new one
	 * (`/new`, `/clear`, a session switch, a resume onto a different transcript).
	 *
	 * The backends' conversation tracking is reset so the next turn recalls afresh, and the
	 * delivered-once cache is re-derived from the transcript the session is now on.
	 *
	 * That cache is why this is not a plain reset. Recalled memories travel as a
	 * `memory-context` message at the tail rather than in the system prompt, and delivery is
	 * deduped against the last block sent, so the question the cache has to answer is "does
	 * the conversation the model will read already contain this block?" — which the messages
	 * themselves answer exactly, and the call site cannot. `/new` lands on an empty
	 * transcript, so an identical recall must be delivered again (and it IS identical in the
	 * likely case: a project's mental models do not change between two `/new`s). A fork or a
	 * switch lands on a transcript that already carries the block, so re-delivering it would
	 * put the same memories in twice. Reading the messages gets both right without a flag per
	 * caller, and it also covers a compaction that dropped the block: gone from the messages,
	 * gone from the cache, sent again.
	 *
	 * A block that was queued and never drained is dropped, because the recall it came from
	 * belonged to the conversation being left. Nothing is lost: the first prompt of the new
	 * transcript collects the current volatile context anyway.
	 *
	 * No system-prompt rebuild here. Both backends' developer instructions are static for
	 * the life of the session by contract, so a rebuild could only produce the same bytes
	 * while risking a prefix-cache invalidation for an unrelated part of the prompt.
	 */
	#resetMemoryContextForNewTranscript(): void {
		this.#resetHindsightConversationTrackingIfHindsight();
		this.#resetMnemopiConversationTrackingIfMnemopi();
		this.#pendingVolatileMemoryContext = undefined;
		this.#deliveredVolatileMemoryContext = this.#memoryContextAlreadyInTranscript();
	}

	/** The last memory block the current transcript carries, or undefined if it carries none. */
	#memoryContextAlreadyInTranscript(): string | undefined {
		for (const message of [...this.agent.state.messages].reverse()) {
			if (message.role !== "custom" || message.customType !== MEMORY_CONTEXT_MESSAGE_TYPE) continue;
			return typeof message.content === "string" ? message.content : undefined;
		}
		return undefined;
	}

	/** True once dispose() has begun; deferred background work (e.g. the deferred
	 *  MCP discovery task in sdk.ts) must not touch the session past this point. */
	get isDisposed(): boolean {
		return this.#isDisposed;
	}

	markMovedFromEmptySessionFile(sessionFile: string): void {
		this.#movedFromEmptySessionFile = path.resolve(sessionFile);
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
		this.#flushPendingIrcAsides();
		this.yieldQueue.clear();
		this.agent.setAsideMessageProvider(undefined);
		this.agent.hasIrcInterrupts = undefined;
		this.#stopAdvisorRuntime();
		this.#evalExecutionDisposing = true;
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
		this.#recordSessionExit(options.reason ?? "dispose");
		this.#cancelExitRecorder?.();
		this.#cancelExitRecorder = undefined;
		try {
			if (this.#extensionRunner?.hasHandlers("session_shutdown")) {
				await this.#extensionRunner.emit({ type: "session_shutdown" });
			}
		} catch (error) {
			logger.warn("Failed to emit session_shutdown event", { error: String(error) });
		}
		// Abort maintenance controllers before draining post-prompt work. Otherwise
		// an in-flight compaction, explicit handoff, or scheduled continuation can
		// keep awaiting a live model stream while #cancelPostPromptTasks waits for
		// its wrappers to settle. The post-prompt task's AbortSignal does not
		// propagate into the inner controllers, so abort them explicitly. Abort the
		// agent as well in case a scheduled continuation already started streaming.
		//
		// Tool work (bash/eval/python) is NOT aborted here — those have their own
		// dispose paths and shared kernels are contractually allowed to survive a
		// session's dispose.
		this.abortRetry();
		this.abortCompaction();
		const postPromptDrain = this.#cancelPostPromptTasks();
		this.agent.abort();
		await postPromptDrain;
		// Cancel jobs this agent registered so a subagent's teardown doesn't
		// leak its background bash/task work into the parent's manager. Only
		// the session that owns the manager goes on to dispose it (which itself
		// nukes any leftover jobs and pending deliveries).
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
		// Every owner-scoped subsystem that registered a disposer: the Python, Ruby and Julia
		// kernels, and the JS eval contexts, which are owner-scoped like the kernels and leaked the
		// eval subprocess across sessions for the life of the parent before they were reaped
		// (GRAN-11). This used to be four `await`s naming those four functions, which meant the
		// first one to throw skipped the rest AND the browser-tab release below. The registry runs
		// all of them and reports the failures together; see `session/owned-resources.ts`.
		try {
			await disposeOwnedResources("eval-kernel-owner", this.#evalKernelOwnerId);
		} catch (error) {
			logger.warn("Some owner-scoped resources failed to release during dispose", { error: String(error) });
		}
		// Everything keyed by the SESSION id rather than the eval-kernel owner id. Today that is the
		// browser tool's headless / spawned Chromium and worker tabs: its `tabs`/`browsers` maps are
		// module-global, shared with subagents and future sessions, so release walks by
		// `ownerSessionId` (stamped at `acquireTab` creation, never on reuse) and touches only what
		// THIS session created. The registry carries the 3s bound that keeps a broken CDP close from
		// stalling `/exit` (issue #3963).
		const browserOwnerId = this.sessionManager.getSessionId();
		if (browserOwnerId) {
			try {
				await disposeOwnedResources("session", browserOwnerId);
			} catch (error) {
				logger.warn("Some session-scoped resources failed to release during dispose", { error: String(error) });
			}
		}
		await shutdownTinyTitleClient();
		this.#releasePowerAssertion();
		// Clean up an empty session created by this session's /move so it doesn't accumulate.
		await cleanupEmptyMoveSession(this.sessionManager, this.#movedFromEmptySessionFile);
		this.#movedFromEmptySessionFile = undefined;
		await this.sessionManager.close();
		// beginDispose() stopped the advisor and captured its recorder close; await
		// it so the final advisor turn is flushed before the process may exit.
		await this.#advisorRecorderClosed;
		this.#closeAllProviderSessions("dispose");
		// Disconnect the MCP manager this session OWNS so its stdio servers are
		// not orphaned at exit. Best-effort: a failure here must never throw out
		// of dispose. Only owning (top-level) sessions provide this callback;
		// subagents reuse a parent's manager and must not tear it down. Idempotent
		// with the deferred-discovery disconnect in `createAgentSession`.
		//
		// BOUNDED: an owned manager may hold an HTTP/SSE server whose session-
		// termination DELETE blocks up to the MCP request timeout (30s default,
		// unbounded when VEYYON_MCP_TIMEOUT_MS=0), so awaiting `disconnectAll()`
		// unbounded would stall /exit and print-mode shutdown on a broken remote
		// endpoint. Race it against a short deadline — stdio close (the subprocess
		// reap this targets) completes well within the bound; a slow transport
		// close is left to finish detached. Mirrors the bounded async-job teardown.
		if (this.#disconnectOwnedMcpManager) {
			try {
				await withTimeout(
					this.#disconnectOwnedMcpManager(),
					3_000,
					"Timed out disconnecting owned MCP manager during dispose",
				);
			} catch (error) {
				logger.warn("Failed to disconnect owned MCP manager during dispose", { error: String(error) });
			}
		}
		// Flush the retain queue BEFORE clearing the session's pointer so
		// `HindsightRetainQueue.#doFlush` still sees `session.getHindsightSessionState() === state`.
		// Reversed, the spliced batch survives just long enough to fail the
		// identity check and get dropped with a `session vanished` warning.
		const hindsightState = this.getHindsightSessionState();
		await hindsightState?.flushRetainQueue();
		this.setHindsightSessionState(undefined);
		hindsightState?.dispose();
		const mnemopiState = setMnemopiSessionState(this, undefined);
		await mnemopiState?.dispose({ timeoutMs: options.mnemopiConsolidateTimeoutMs });
		// Tear down the embeddings subprocess AFTER mnemopi state.dispose:
		// consolidate-on-dispose may still call `embed()` to store the final
		// memories, and that round-trips through the worker we are about to
		// hard-kill (issue #3031).
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
					error: String(error),
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

	/** Effective thinking level applied to the agent (the resolved level when `auto`). */
	get thinkingLevel(): ThinkingLevel | undefined {
		return this.#thinkingLevel;
	}

	/** The selector the user configured: `auto` when auto mode is active, else the effective level. */
	configuredThinkingLevel(): ConfiguredThinkingLevel | undefined {
		return this.#autoThinking ? AUTO_THINKING : this.#thinkingLevel;
	}

	/** Session-only effort choice, excluding selector and saved per-model defaults. */
	get sessionThinkingOverride(): ConfiguredThinkingLevel | undefined {
		return this.#sessionThinkingOverride;
	}

	/** True when `auto` thinking mode is active. */
	get isAutoThinking(): boolean {
		return this.#autoThinking;
	}

	/** The level `auto` resolved to for the current turn (undefined until classified). */
	autoResolvedThinkingLevel(): Effort | undefined {
		return this.#autoResolvedLevel;
	}

	#serviceTierByFamily: ServiceTierByFamily = {};

	/** Live per-family service tiers (OpenAI / Anthropic / Google). */
	get serviceTierByFamily(): ServiceTierByFamily {
		return this.#serviceTierByFamily;
	}

	/** Whether agent is currently streaming a response */
	get isStreaming(): boolean {
		return this.agent.state.isStreaming || this.#promptInFlightCount > 0;
	}

	get isAborting(): boolean {
		return this.agent.isAborting;
	}

	/** Wait until streaming and deferred recovery work are fully settled. */
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

	/** Most recent assistant message in agent state. */
	getLastAssistantMessage(): AssistantMessage | undefined {
		return this.#findLastAssistantMessage();
	}
	/** Current effective system prompt blocks (includes any per-turn extension modifications) */
	get systemPrompt(): string[] {
		return this.agent.state.systemPrompt;
	}

	/** Current retry attempt (0 if not retrying) */
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

	/** Single point for invalidating cached discovery indices. Call after any change that can
	 *  affect which tools should be discoverable: registry mutations (refreshMCPTools,
	 *  refreshRpcHostTools) or active-tool mutations (#applyActiveToolsByName). */
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
		return this.#builtInToolNames.has(name);
	}

	/**
	 * Get all configured tool names (built-in via --tools or default, plus custom tools).
	 */
	getAllToolNames(): string[] {
		return Array.from(this.#toolRegistry.keys());
	}

	#wrapRuntimeTool(tool: AgentTool): AgentTool {
		const wrapped = wrapToolWithMetaNotice(tool);
		return this.#extensionRunner ? new ExtensionToolWrapper(wrapped, this.#extensionRunner) : wrapped;
	}

	/**
	 * Registers the ephemeral vibe tools and activates them alongside `baseToolNames`.
	 *
	 * @throws When this session cannot create vibe tools or the factory returns duplicate names.
	 */
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

		await this.#applyActiveToolsByName([...new Set([...baseToolNames, ...vibeToolNames])]);
	}

	/** Removes tools installed by {@link activateVibeTools} and activates `nextToolNames`. */
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

	/** Cache key for model-dependent prompt content: displayed id or hidden-policy cohort. */
	#currentPromptModelKey(): string | undefined {
		const model = this.model ? formatModelString(this.model) : undefined;
		if (!model || this.settings.get("includeModelInPrompt")) return model;
		const taskPolicy = usesCodexTaskPrompt(model) ? "task-policy:gpt-5.6" : "task-policy:default";
		// Context-file delivery is model policy too: cursor-agent models inline no context
		// files (operator layers travel as requestContext rules, repository files nowhere),
		// so switching to or from one must rebuild the prompt even when both models share
		// a task-policy cohort and this key would otherwise not change.
		return usesCursorRuleDelivery(this.model) ? `${taskPolicy}:cursor-rules` : taskPolicy;
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
	 * and the only reads of `#resolveActiveEditMode` for this purpose are the four
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
		const currentEditMode = this.#resolveActiveEditMode();
		const editModeChanged = previousEditMode !== currentEditMode && this.getActiveToolNames().includes(TOOL.edit);
		// The system prompt selects model-specific policy even when it does not display the model id.
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

	/**
	 * Flip MCP discovery on after deferred discovery learns the real tool count.
	 * UI sessions resolve `tools.discoveryMode: "auto"` before MCP servers
	 * connect, so a large MCP toolset discovered later must be able to upgrade
	 * the session from the force-activate path to the discovery path. One-way:
	 * discovery is never downgraded mid-session.
	 */
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
		const nextActive = [
			...this.#getActiveNonMCPToolNames(),
			...this.#filterSelectableMCPToolNames(nextSelectedMCPToolNames),
		];
		await this.setActiveToolsByName(nextActive);
		return [...new Set(activated)];
	}

	// ── Generic tool discovery (covers built-in + MCP + extension) ────────────

	/** Resolve effective discovery mode from the current registry size. */
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
		// For "all" mode we combine local registry entries with MCP tools.
		// For "mcp-only" mode we only return MCP tools.
		const mode = this.#resolveEffectiveDiscoveryMode();
		const activeNames = new Set(this.getActiveToolNames());
		const mcpTools = Array.from(this.#discoverableMCPTools.values()).filter(t => !activeNames.has(t.name));
		const localTools: DiscoverableTool[] = mode === "all" ? this.#collectDiscoverableLocalTools() : [];
		const allTools = [...localTools, ...mcpTools];
		return filter?.source ? allTools.filter(t => t.source === filter.source) : allTools;
	}

	/** Collect local tools the model can discover via search_tool_bm25. Restricted to definitions
	 *  whose `loadMode === "discoverable"`. Hidden/internal tools remain out of the index. Registry
	 *  source ownership distinguishes built-ins from first-party custom tools such as generate_image. */
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

	/** Invalidate the generic search index cache (call after tool set changes).
	 *  Delegates to {@link #invalidateDiscoveryCaches} so all discovery-related caches stay in sync. */
	#invalidateDiscoverableToolSearchIndex(): void {
		this.#invalidateDiscoveryCaches();
	}

	getSelectedDiscoveredToolNames(): string[] {
		// Union of MCP-selected and generic non-MCP selected. Non-MCP selections are only
		// selected while they are still active; otherwise BM25 must be able to rediscover them.
		const activeNames = new Set(this.getActiveToolNames());
		const mcpSelected = this.getSelectedMCPToolNames();
		const nonMcpSelected = Array.from(this.#selectedDiscoveredToolNames).filter(
			name => activeNames.has(name) && this.#toolRegistry.has(name) && !isMCPToolName(name),
		);
		return [...new Set([...mcpSelected, ...nonMcpSelected])];
	}

	async activateDiscoveredTools(toolNames: string[]): Promise<string[]> {
		const mcpNames = toolNames.filter(isMCPToolName);
		const nonMcpNames = toolNames.filter(name => !isMCPToolName(name));
		const activated: string[] = [];

		// Activate MCP tools via existing path
		if (mcpNames.length > 0) {
			const activatedMcp = await this.activateDiscoveredMCPTools(mcpNames);
			activated.push(...activatedMcp);
		}

		// Activate non-MCP tools (built-ins that are in the registry but not currently active)
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
				const nextActive = [...this.getActiveToolNames(), ...newlyAdded];
				await this.setActiveToolsByName(nextActive);
				this.#invalidateDiscoverableToolSearchIndex();
			}
		}

		return [...new Set(activated)];
	}

	/**
	 * Wrap a tool with a permission-gate proxy when an ACP client is connected.
	 * Only wraps tools whose name is in PERMISSION_REQUIRED_TOOLS and only when
	 * the bridge exposes `requestPermission`. No-ops for all other cases.
	 *
	 * When the user has explicitly opted into `yolo` / auto-approve behavior (via
	 * the SDK/CLI `autoApprove` flag or a configured `tools.approvalMode: yolo`),
	 * skips the gate unless the per-tool policy explicitly requires a prompt or
	 * deny. The schema default is `auto`, not `yolo`, so an explicit
	 * configuration or explicit session flag is required: default-config ACP
	 * sessions keep the client-side permission gate.
	 */
	#wrapToolForAcpPermission<T extends AgentTool>(tool: T): T {
		const bridge = this.#clientBridge;
		// Match the capability+method gating pattern used by read/write/bash.
		if (!bridge?.capabilities.requestPermission || !bridge.requestPermission) return tool;
		if (!PERMISSION_REQUIRED_TOOLS.has(tool.name)) return tool;
		// Skip the gate only on explicit yolo opt-in; honour per-tool policies
		// that require a prompt or deny (matching the normal approval wrapper).
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
					// Short-circuit on persisted decisions.
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

	/**
	 * The approval rung this session is ACTUALLY enforcing, which is not always
	 * the one stored in `tools.approvalMode`.
	 *
	 * Two things outrank the configured value and both are invisible to a caller
	 * that only reads settings: `--yolo` / `--auto-approve` forces `yolo` for the
	 * whole run, and an active plan session caps to `plan`. Every surface that
	 * NAMES the rung to the operator has to ask this instead, or it states the
	 * opposite of what the tool wrapper will do — `veyyon --yolo` plus
	 * `/permissions ask` reported "Ask all" on the status line and in the command
	 * output while every tool ran unasked.
	 *
	 * This is the same resolution the wrapper performs, called through the same
	 * function, so the label and the behaviour cannot drift.
	 */
	effectiveApprovalMode(): ApprovalMode {
		return resolveEffectiveApprovalMode(this.settings.get("tools.approvalMode"), {
			planModeActive: this.getPlanModeState()?.enabled === true,
			cliAutoApprove: this.#autoApprove,
		});
	}

	/**
	 * Whether the `/yolo` full-bypass is currently active for this session.
	 *
	 * A subagent's own flag is a COPY of the parent's, taken when the child was
	 * built, so revocation used to be partial: `/yolo`, spawn a long subagent,
	 * `/yolo off`, and the parent went back to prompting while the child kept
	 * running every bash and edit unasked until it finished. The parent probe is
	 * consulted live and can only narrow: a child whose own flag is off is never
	 * granted a bypass by a parent that has one.
	 */
	isApprovalBypassed(): boolean {
		if (!this.#approvalBypassActive) return false;
		return this.#parentApprovalBypassed?.() ?? true;
	}

	/**
	 * Turn the `/yolo` full-bypass on or off for this session. Returns the new
	 * state. Session-scoped only: never written to settings, so it always starts
	 * off in a fresh session. The next tool call reads this live via the tool
	 * context (`bypassAllApprovals`).
	 */
	setApprovalBypass(enabled: boolean): boolean {
		this.#approvalBypassActive = enabled;
		return this.#approvalBypassActive;
	}

	/**
	 * The session's standing per-tool approval decisions, handed to the tool
	 * wrapper so an "Always allow" answered once is not asked again this session.
	 *
	 * Returned as an accessor pair rather than the Map: the wrapper reads and
	 * writes exactly two operations, and handing out the collection invites a
	 * caller to clear it or iterate it into a settings file, which is the one
	 * thing this store must never do (see `#sessionToolApprovals`).
	 */
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
		// A requested name the registry does not hold is dropped, because a stale
		// selection naming a tool this build no longer ships must not fail a whole
		// session. It is LOGGED because dropping it silently is how a tool goes
		// missing for weeks: the session advertised 22 tools and sent 21, the model
		// simply never called the absent one, and nothing anywhere said a name had
		// been asked for and not found. Any future wiring defect that removes a tool
		// from the registry now leaves a record naming it.
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
		// Auto-QA tool must survive any runtime tool-set mutation.
		if (isAutoQaEnabled(this.settings) && !validToolNames.includes(TOOL.report_tool_issue)) {
			const qaTool = this.#toolRegistry.get(TOOL.report_tool_issue);
			if (qaTool) {
				tools.push(this.#wrapToolForAcpPermission(qaTool));
				validToolNames.push(TOOL.report_tool_issue);
			}
		}
		// A permutation of the tool set already on the wire keeps the order it is
		// replacing. The provider-bound `tools` array is part of the cached prompt
		// prefix, and tools are addressed by name, so their order means nothing to the
		// model and everything to the cache: reordering the same set re-serializes the
		// prefix from the tools block onward and the next request pays full input rate
		// for it. Several callers hand over a different order for an unchanged set --
		// `refreshSshTool` filters `ssh` out and re-pushes it at the tail,
		// `#restoreMCPSelectionsForSessionContext` emits every non-MCP tool ahead of
		// every MCP one, and plan/goal-mode exit replays a list saved before later
		// activations moved it. None of them intends a change, and the token count does
		// not move, which is why the cost was invisible: the provider simply served
		// fewer cached tokens than the system+tools prefix is long.
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

		// Active tool set changed → discoverable tool list (which excludes already-active tools)
		// is now stale. Invalidate before any prompt-template hook reads the discovery list.
		this.#invalidateDiscoveryCaches();

		// Rebuild base system prompt with new tool set, but only when the tool set
		// actually changed. MCP servers can reconnect at arbitrary times and call
		// `refreshMCPTools` -> `#applyActiveToolsByName` even though the resulting
		// tool list is byte-identical. Skipping the rebuild keeps the system prompt
		// stable, which is required for Anthropic prompt caching to keep hitting.
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

	/**
	 * Reload the SSH tool from disk-backed capability discovery and make the
	 * refreshed definition visible to the next model call without restarting.
	 */
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

	/**
	 * Set active tools by name.
	 * Only tools in the registry can be enabled. Unknown tool names are ignored.
	 * Also rebuilds the system prompt to reflect the new tool set.
	 * Changes take effect before the next model call.
	 */
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
	/**
	 * Rebuild the base system prompt using the current active tool set, and return
	 * the prompt now in force.
	 *
	 * The return value exists so a caller can VERIFY what the rebuild produced.
	 * The argot arm is the motivating case: it refreshes the prompt to teach the
	 * handle table, and until this returned something there was no way for the
	 * caller, a test, or an eval to confirm the table actually landed. The
	 * transcript could not answer it either, because `session_init` snapshots the
	 * prompt before the background arm ever completes.
	 *
	 * Returns the unchanged current prompt when no rebuild hook is installed.
	 */
	/**
	 * Reasons for every prefix-cache invalidation this session has caused, in
	 * order. Empty means the system prompt never changed after startup, which is
	 * the cheap case: the provider served the whole prompt from cache all session.
	 */
	systemPromptInvalidations(): readonly string[] {
		// A copy, and frozen. `readonly string[]` is a compile-time claim only:
		// returning the live array hands a caller the session's own cost evidence
		// to mutate, and a reader that trimmed or appended to it would silently
		// misreport how many times the cache was invalidated.
		return Object.freeze([...this.#baseSystemPromptInvalidations]);
	}

	/**
	 * Rebuild the base system prompt, recording `reason` when the bytes change.
	 *
	 * `reason` is REQUIRED, and that is the point. It used to default to
	 * "unspecified", and the three callers that omitted it were the frequent ones:
	 * a cwd re-root, a secrets refresh, and a memory clear. A session that
	 * re-rooted four times recorded four invalidations all reading
	 * `reason='unspecified'`, each one rewriting a ~32k-char prompt, so the
	 * recording could prove the cache had been thrown away but never which change
	 * threw it. The whole value of this evidence is attribution; a default made
	 * the unattributed case the easy one to write.
	 */
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
			// Changing the system prompt mid-session invalidates the provider's
			// prefix cache, and the next request re-reads the ENTIRE context as
			// fresh input. That is the most expensive thing a session can do
			// silently: on a measured 66-turn trace, five turns came back with
			// `cacheRead: 0` while resending 46-72k tokens each, about 8% of the
			// session bill, and nothing in the transcript said why. The
			// invalidation was already detected right here and simply never
			// recorded, so every attempt to explain the misses was guesswork.
			//
			// Recorded loudly rather than at debug, because a caller that refreshes
			// the prompt on a hot path is a cost bug, and the reason is the only
			// thing that identifies which caller it was.
			this.#baseSystemPromptInvalidations.push(reason);
			const previousChars = previousBaseSystemPrompt.join("\n\n").length;
			const nextChars = this.#baseSystemPrompt.join("\n\n").length;
			logger.warn("system prompt changed mid-session; provider prompt cache invalidated", {
				reason,
				invalidationsThisSession: this.#baseSystemPromptInvalidations.length,
				previousChars,
				nextChars,
			});
			// Also written to the transcript, not just the log. An in-memory counter
			// and a log line are invisible to anything reading a finished run, and a
			// finished run is exactly where the cost question gets asked. Without
			// this entry the bench sees `cacheRead: 0` turns and still cannot say
			// which subsystem caused them, which is the state that made these misses
			// unexplainable in the first place.
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
		// Refresh the cached signature so a subsequent `#applyActiveToolsByName` with
		// the same tool set does not re-rebuild on top of the explicit refresh we
		// just performed (and conversely, a different set forces a fresh rebuild).
		const activeTools = activeToolNames
			.map(name => this.#toolRegistry.get(name))
			.filter((tool): tool is AgentTool => tool != null);
		this.#lastAppliedToolSignature = this.#computeAppliedToolSignature(activeToolNames, activeTools);
		return this.#baseSystemPrompt;
	}

	/**
	 * Text of the volatile memory context already delivered to the model, so the
	 * same block is never sent twice. Undefined until the first delivery.
	 */
	#deliveredVolatileMemoryContext: string | undefined;
	/** Volatile memory context waiting for the next step boundary to carry it in. */
	#pendingVolatileMemoryContext: string | undefined;

	/**
	 * Collect the memory backend's volatile context for a turn that is about to
	 * start, as a message rather than a system-prompt change.
	 *
	 * Two sources feed it: `beforeAgentStartPrompt`, which is the only hook that
	 * can affect the very first answer of a session, and `buildVolatileContext`,
	 * which reports whatever the backend currently holds. Both used to be appended
	 * to the system prompt, and both therefore invalidated the provider's cache
	 * prefix and made the next request re-read the entire conversation at the
	 * uncached rate. They arrive alongside the user's message now.
	 *
	 * Returns null when there is nothing new to say. A backend that throws is
	 * logged and skipped: memory is an enhancement, and a failing recall must not
	 * take the turn with it.
	 */
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
					error: String(err),
				});
			}
		}
		if (backend.buildVolatileContext) {
			try {
				const volatileContext = await backend.buildVolatileContext(this);
				// `beforeAgentStartPrompt` caches its recall on the backend state, so the
				// same text usually comes back from both hooks on the first turn.
				if (volatileContext?.trim() && !parts.includes(volatileContext.trim())) {
					parts.push(volatileContext.trim());
				}
			} catch (err) {
				logger.debug("Memory backend buildVolatileContext failed", {
					backend: backend.id,
					error: String(err),
				});
			}
		}
		return this.#buildVolatileMemoryMessage(parts.join("\n\n"));
	}

	/**
	 * A memory-context message for `text`, or null when it is empty or unchanged.
	 *
	 * Re-sending an unchanged block would grow the context every turn for no new
	 * information, which is the cost bug this whole change is about.
	 */
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
		const backend = await resolveMemoryBackend(this.settings);
		if (!backend.buildVolatileContext) return false;
		let text: string | undefined;
		try {
			text = await backend.buildVolatileContext(this);
		} catch (err) {
			logger.debug("Memory backend buildVolatileContext failed", {
				backend: backend.id,
				reason,
				error: String(err),
			});
			return false;
		}
		const trimmed = text?.trim();
		if (!trimmed || trimmed === this.#deliveredVolatileMemoryContext) return false;
		this.#pendingVolatileMemoryContext = trimmed;
		logger.debug("memory context queued for the context tail", { reason, chars: trimmed.length });
		return true;
	}

	/** Drain the queued volatile memory context as an aside, if any is waiting. */
	#takePendingVolatileMemoryContext(): AgentMessage | null {
		const pending = this.#pendingVolatileMemoryContext;
		if (pending === undefined) return null;
		this.#pendingVolatileMemoryContext = undefined;
		return this.#buildVolatileMemoryMessage(pending);
	}

	/**
	 * Compose a stable signature for the inputs that `rebuildSystemPrompt` reads.
	 * Two calls producing identical signatures are guaranteed to produce identical
	 * system prompt bytes, so the rebuild can be skipped.
	 *
	 * The signature covers:
	 *   1. Active tool names in order (the prompt renders them in this order).
	 *   2. Active tool labels, descriptions, and wire-visible names — all are
	 *      rendered into the prompt body (see `system-prompt.md` `{{label}}: \`{{name}}\``
	 *      and `toolPromptNames` in `buildSystemPrompt`). The wire name comes from
	 *      `tool.customWireName` and overrides the internal name on the model wire
	 *      (e.g. `edit` exposes itself as `apply_patch` to GPT-5 in apply_patch mode);
	 *      a stale wire name would desync prompt guidance from actual tool routing.
	 *   3. When MCP discovery is on, every registry tool's name+label+description+
	 *      customWireName, since `rebuildSystemPrompt` summarizes discoverable MCP
	 *      tools that are not in the active set.
	 *   4. MCP server instructions text (per server), since `rebuildSystemPrompt`
	 *      embeds these in the appended prompt under "## MCP Server Instructions".
	 *      A server upgrade can change instructions while keeping tools identical.
	 *
	 * Settings-driven tool metadata is covered automatically: built-in tools that
	 * depend on settings expose `description`/`label` via getters (see `TaskTool`,
	 * `SearchToolBm25Tool`, `EditTool`), and the signature reads them live on every
	 * call - so a settings flip that mutates the rendered string differs the signature
	 * the next time `#applyActiveToolsByName` runs. Do not refactor `describeTool` to
	 * cache per-tool strings without preserving this property.
	 *
	 * Inputs NOT covered: tool input schemas; memory instructions read from disk;
	 * and SDK-init-time closure constants in `sdk.ts` (`inlineToolDescriptors`,
	 * `eagerTasks`, `intentField`, `mcpDiscoveryEnabled`). The closure-captured
	 * ones cannot change at runtime regardless of skip behavior. Secret guidance
	 * is read from the live runtime and `refreshSecrets()` explicitly rebuilds it.
	 * For everything else, callers must explicitly call `refreshBaseSystemPrompt()`
	 * after side-effecting changes; see e.g. the memory hooks and
	 * `#syncAfterModelChange`.
	 *
	 * The current calendar date IS covered (appended as a segment) because
	 * `buildSystemPrompt` injects it into the prompt body (`Today is '{{date}}'`).
	 * Without this, a session spanning midnight with only tool-stable MCP
	 * reconnects would keep yesterday's date indefinitely.
	 */
	#computeAppliedToolSignature(toolNames: string[], tools: AgentTool[]): string {
		// Order-preserving join: any reorder must produce a different signature so
		// the rebuild fires and the new tool list reaches the API.
		const nameSegment = toolNames.join("\u0001");
		const describeTool = (tool: AgentTool): string =>
			`${tool.name}=${tool.label ?? ""}|${tool.description ?? ""}|${tool.customWireName ?? ""}`;
		const descriptionSegment = tools.map(describeTool).join("\u0002");
		let registrySegment = "";
		if (this.#mcpDiscoveryEnabled) {
			// Registry iteration order is not load-bearing for the prompt content, so we
			// sort to keep the signature insensitive to incidental insertion order.
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
			// Sort by server name so transport flap order does not perturb the signature.
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
			// Force-activate every newly registered MCP tool. This path is used
			// when MCP discovery is disabled and tools arrive after initial
			// activation — without it, getSelectedMCPToolNames() returns only
			// already-active tools (circular deadlock: tools can only become
			// active if they're already active).
			const newMcpNames = mcpTools.map(t => t.name);
			const nextActive = [...new Set([...this.#getActiveNonMCPToolNames(), ...newMcpNames])];
			await this.#applyActiveToolsByName(nextActive, { previousSelectedMCPToolNames });
			return;
		}

		const nextActive = [...this.#getActiveNonMCPToolNames(), ...this.getSelectedMCPToolNames()];
		await this.#applyActiveToolsByName(nextActive, { previousSelectedMCPToolNames });
	}

	/**
	 * Replace RPC host-owned tools and refresh the active tool set before the next model call.
	 */
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

		// Registry contents changed — invalidate discovery caches so the next BM25 lookup sees
		// the new RPC-host tool set. (#applyActiveToolsByName below also invalidates, but doing
		// it here too keeps the contract local to "registry mutated".)
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

	/** Whether auto-compaction is currently running */
	get isCompacting(): boolean {
		return this.#autoCompactionAbortController !== undefined || this.#compactionAbortController !== undefined;
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
		return this.#postPromptTasks.size > 0;
	}

	/** All messages including custom types like BashExecutionMessage */
	get messages(): AgentMessage[] {
		return this.agent.state.messages;
	}

	/** Latest image attachments addressable by tools as `Image #N` or `attachment://N`. */
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
		// RENDER PATH, and also the agent-state rebuild after a compaction or a
		// history rewrite and the constructor's first MCP-selection read, so a throw
		// here does not fail one render, it fails session construction. Degrades per
		// string; never throws.
		return this.#expandArgot(this.#deobfuscateSessionContextForDisplay(this.sessionManager.buildSessionContext()));
	}

	/**
	 * Expand argot handles across a rebuilt transcript so display/export/resume
	 * matches the live message seam. No-op unless a dictionary was read this
	 * session. Composes after secret deobfuscation.
	 */
	#expandArgot(context: SessionContext): SessionContext {
		return this.#argot?.loaded ? expandSessionContext(this.#argot, context) : context;
	}

	/**
	 * Transcript for TUI display. Full history is kept for export/resume-style
	 * callers; live chat can collapse compacted history to keep the hot render
	 * surface bounded. Display-only — NEVER feed the result to
	 * `agent.replaceMessages` or a provider.
	 */
	buildTranscriptSessionContext(
		options?: Pick<BuildSessionContextOptions, "collapseCompactedHistory" | "keepDanglingToolCalls">,
	): SessionContext {
		// RENDER PATH: every TUI repaint runs this, so a throw would unwind the
		// render loop. Degrades per string; never throws.
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
		// `compact()` folds a prior legacy image-archive's plaintext into the
		// summarization prompt on the legacy-archive→summary migration, so the
		// archive's text regions must be redacted alongside the summary. Only the
		// legacy archive slot's text is rewritten; every other preserveData key —
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

	/** Redact secrets in a legacy persisted image-archive's plaintext regions
	 *  (`text`/`textHead`/`textTail`) so the legacy-archive→summary migration in
	 *  `compact()` cannot ship raw archived user/tool text to the provider. Every
	 *  non-archive key passes through byte-identical; the same reference is
	 *  returned when nothing changes. Only old sessions still carry such an archive. */
	#obfuscatePreservedArchiveText(
		preserveData: Record<string, unknown> | undefined,
	): Record<string, unknown> | undefined {
		if (!this.#hasProviderRedactions || !hasLegacyArchive(preserveData)) return preserveData;
		return redactLegacyArchiveText(preserveData, value => this.obfuscateProviderText(value));
	}

	/**
	 * DISPLAY PATH: provider text on its way to the operator, namely the streamed
	 * side-channel delta and the ephemeral turn's reply. Degrades to the literal
	 * placeholder; never throws.
	 */
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

	/** Convert session messages using the same pre-LLM pipeline as the active session. */
	async convertMessagesToLlm(messages: AgentMessage[], signal?: AbortSignal): Promise<Message[]> {
		const transformedMessages = await this.#transformContext(messages, signal);
		return await this.#convertToLlm(transformedMessages);
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
		const sessionModel = this.model;
		if (!sessionModel || this.#getModelKey(sessionModel) !== this.#getModelKey(candidate)) return undefined;
		if (!modelServesPrefixCacheHits(candidate)) return undefined;
		const llmMessages = await this.convertMessagesToLlm(this.agent.state.messages.slice(), signal);
		const context = await this.agent.buildSideRequestContext(llmMessages);
		if (!context.systemPrompt?.length || context.messages.length === 0) return undefined;
		return { sessionSystemPrompt: context.systemPrompt, sessionMessages: context.messages, tools: context.tools };
	}

	/**
	 * Apply session-level stream hooks to a direct side request.
	 *
	 * The lease is admitted before any caller/extension hook can run and is
	 * captured by the returned payload hook for the request's full lifetime.
	 */
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

		// Stamp session metadata (e.g. user_id={session_id}) onto direct-call requests so
		// they share the same session bucket as Agent.prompt-routed requests on Anthropic
		// OAuth. Caller-provided metadata wins so explicit overrides are respected.
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
		return this.#activeProviderSessionId();
	}
	getEvalSessionId(): string | null {
		if (this.#parentEvalSessionId !== undefined) return this.#parentEvalSessionId;
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
	get scopedModels(): ReadonlyArray<{
		model: Model;
		thinkingLevel?: ConfiguredThinkingLevel;
		explicitThinkingLevel?: boolean;
	}> {
		return this.#scopedModels;
	}

	/** Prompt templates */
	getPlanModeState(): PlanModeState | undefined {
		return this.#planModeState;
	}

	/** Prewalk state, if armed and active */
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
			// Drop any unconsumed forced decision so a post-plan execution turn
			// does not inherit a stale `required` tool choice.
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

	/**
	 * Rebuild checkpoint/rewind runtime state from the current branch. Handles two
	 * cases surfaced by session resume, `switchSession()` reloading the same file,
	 * and tree navigation:
	 *   - The branch's most recent checkpoint has already been rewound → restore
	 *     `#lastCompletedRewind` so a repeat `rewind` call receives the
	 *     "checkpoint already completed" recovery guidance.
	 *   - The branch's most recent checkpoint has NOT been rewound (e.g. the run
	 *     was aborted between `checkpoint` and `rewind`) → restore
	 *     `#checkpointState` so the next `rewind` call can complete the
	 *     checkpoint instead of failing with "No active checkpoint".
	 */
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

	/**
	 * Inject the plan mode context message into the conversation history.
	 */
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

	/**
	 * Resolve a role to its model AND thinking level.
	 * Unlike resolveRoleModel(), this preserves the thinking level suffix
	 * from role configuration (e.g., "anthropic/claude-sonnet-4-5:xhigh").
	 */
	resolveRoleModelWithThinking(role: string): ResolvedModelRoleValue {
		return this.#resolveRoleModelFull(role, this.#modelRegistry.getAvailable(), this.model);
	}

	/**
	 * Resolve the explicit thinking suffix that should apply when a temporary
	 * picker selects a model already assigned to a configured role.
	 */
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

	/** Replace file-based slash commands used for prompt expansion. */
	setSlashCommands(slashCommands: FileSlashCommand[]): void {
		this.#slashCommands = [...slashCommands];
	}

	/** Custom commands (TypeScript slash commands and MCP prompts) */
	get customCommands(): ReadonlyArray<LoadedCustomCommand> {
		if (this.#mcpPromptCommands.length === 0) return this.#customCommands;
		return [...this.#customCommands, ...this.#mcpPromptCommands];
	}

	/** MCP prompt commands only, for command-list metadata. */
	get mcpPromptCommands(): ReadonlyArray<LoadedCustomCommand> {
		return this.#mcpPromptCommands;
	}

	/** Update the MCP prompt commands list. Called when server prompts are (re)loaded. */
	setMCPPromptCommands(commands: LoadedCustomCommand[]): void {
		this.#mcpPromptCommands = commands;
		this.#notifyCommandMetadataChanged();
	}

	// =========================================================================
	// Prompting
	// =========================================================================

	/**
	 * Build a plan mode message.
	 * Returns null if plan mode is not enabled.
	 * @returns The plan mode message, or null if plan mode is not enabled.
	 */
	async #buildPlanReferenceMessage(): Promise<CustomMessage | null> {
		if (this.#planModeState?.enabled) return null;
		if (this.#planReferenceSent) return null;

		const planFilePath = this.#planReferencePath;
		const resolvedPlanPath = resolveLocalUrlToPath(planFilePath, this.#localProtocolOptions());
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
		const resolvedPlanPath = state.planFilePath.startsWith("local:")
			? resolveLocalUrlToPath(normalizeLocalScheme(state.planFilePath), this.#localProtocolOptions())
			: resolveToCwd(state.planFilePath, this.sessionManager.getCwd());
		const resolvedSessionPlan = resolveLocalUrlToPath(sessionPlanUrl, this.#localProtocolOptions());
		const displayPlanPath =
			state.planFilePath.startsWith("local:") || resolvedPlanPath !== resolvedSessionPlan
				? state.planFilePath
				: sessionPlanUrl;

		const planExists = fs.existsSync(resolvedPlanPath);
		// Plan mode's research step names `scout` when that agent is on offer and
		// any other enabled type otherwise, so the instruction always points at an
		// agent this session can actually spawn. It used to name a literal, which
		// is wrong for two reasons at once: the literal was `task`, a name no
		// roster has carried since the rename to `deep`, and a literal cannot
		// track a set the operator configures, so with only `sonic` enabled the
		// sentence sent the model at an agent the spawn path then refused.
		const subagentNames = enabledSubagentNames(this.#toolRegistry.get(TOOL.task));
		const researchAgent = preferredSubagentName(subagentNames, "scout"); // not-a-tool-name: agent ids
		const content = prompt.render(planModePrompts["plan-mode/active"].text, {
			planFilePath: displayPlanPath,
			planExists,
			// Gated on the name rather than on a separate emptiness test: the prose
			// that survives is exactly the prose there is a name for.
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

	/**
	 * Build a hidden companion message describing image attachments for a text-only
	 * model. Each image is saved under local:// and a vision-capable model describes
	 * it; the descriptions are returned as a `display: false` custom message (so the
	 * model reads them but the TUI does not render the blob) carrying one
	 * `<image path="local://…">…</image>` block per image. Returns `undefined` when
	 * the active model already accepts images, the feature is disabled, or no
	 * description could be produced. Never throws.
	 */
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

	/**
	 * Send a prompt to the agent.
	 * - Handles extension commands (registered via pi.registerCommand) immediately, even during streaming
	 * - Expands file-based prompt templates by default
	 * - During streaming, queues via steer() or followUp() based on streamingBehavior option
	 * - Validates model and API key before sending (when not streaming)
	 * @throws Error if streaming and no streamingBehavior specified
	 * @throws Error if no model selected or no API key available (when not streaming)
	 */
	/**
	 * Returns `false` when the command was fully handled locally (extension or
	 * custom-TS command consumed without calling the LLM). Returns `true` when
	 * the prompt was forwarded to the agent — either directly or queued as a
	 * steer/follow-up. Callers that render a UI or manage turn lifecycle (e.g.
	 * the ACP agent) use this to know whether to expect an `agent_end` event.
	 */
	async prompt(text: string, options?: PromptOptions): Promise<boolean> {
		await this.#promptRefresh;
		const expandPromptTemplates = options?.expandPromptTemplates ?? true;

		// Handle extension commands first (execute immediately, even during streaming)
		if (expandPromptTemplates && text.startsWith("/")) {
			const handled = await this.#tryExecuteExtensionCommand(text);
			if (handled) {
				return false;
			}

			// Try custom commands (TypeScript slash commands)
			const customResult = await this.#tryExecuteCustomCommand(text);
			if (customResult !== null) {
				if (customResult === "") {
					return false;
				}
				text = customResult;
			}

			// Try file-based slash commands (markdown files from commands/ directories)
			// Only if text still starts with "/" (wasn't transformed by custom command)
			if (text.startsWith("/")) {
				const parsed = parseSlashCommand(text);
				const canonicalInvocation =
					parsed === null ? text : `/${parsed.name}${parsed.args.length > 0 ? ` ${parsed.args}` : ""}`;
				text = expandSlashCommand(canonicalInvocation, this.#slashCommands);
			}
		}

		// Expand file-based prompt templates if requested
		const expandedText = expandPromptTemplates ? expandPromptTemplate(text, [...this.#promptTemplates]) : text;

		// Every resolver has now had its turn: builtins upstream in the dispatcher,
		// then extension, custom, file-based commands and prompt templates above. A
		// text that STILL reads as `/name` is a command this build does not have,
		// and forwarding it to the model is the wrong answer to a typo. It is also
		// the bug this refusal was written for: `/secret list`, typed into a build
		// that predated the command, was sent as prose and the model began grepping
		// the filesystem for secrets files. Synthetic prompts are exempt because an
		// agent-authored turn is never a user reaching for a command.
		if (expandPromptTemplates && !options?.synthetic && expandedText === text) {
			const unresolved = unresolvedSlashCommandName(text);
			// The name only. The argument tail of a miss on `/secret add` is a credential.
			if (unresolved !== undefined) throw new Error(unknownSlashCommandMessage(unresolved));
		}

		// Magic keywords ("ultrathink", "orchestrate"): append hidden system notices after the
		// user's message that steer this turn. User-authored prompts only — synthetic /
		// agent-initiated turns never trigger them.
		const keywordNotices = options?.synthetic ? [] : this.#createMagicKeywordNotices(expandedText);

		// A user-initiated prompt (typed message or the `.`/`c` continue shortcut)
		// re-enables advisor auto-resume that a prior user interrupt suppressed.
		// Agent-initiated synthetic prompts (auto-continue, plan, reminders) do not.
		if (options?.userInitiated ?? !options?.synthetic) {
			this.#verificationEvidence.startUserTurn();
			this.#advisorAutoResumeSuppressed = false;
			this.#planModeReminderCount = 0;
			this.#planModeReminderAwaitingProgress = false;
			// A user turn owns the next decision; drop a queued forced choice from
			// a reminder continuation this prompt just preempted.
			this.#toolChoiceQueue.removeByLabel("plan-mode-decision");
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
			if (options.streamingBehavior === "followUp") {
				await this.#queueUserMessage(expandedText, options?.images, "followUp");
			} else {
				await this.#queueUserMessage(expandedText, options?.images, "steer");
			}
			return true;
		}

		// Skip eager preludes when the user has already queued a directive
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
		// Text-only model + image attachment: describe via a vision model and inject the
		// description as a hidden companion (the image stays in the visible user message).
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
			// Clean up residual eager-todo directive if the prompt never consumed it
			// (e.g., compaction aborted, validation failed).
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
		const generation = this.#promptGeneration;
		try {
			// Flush any pending bash messages before the new prompt
			this.#flushPendingBashMessages();
			this.#flushPendingPythonMessages();
			this.#flushPendingIrcAsides();

			// A new user prompt does not reset stop-time reminder suppression. Replaying
			// the same unfinished list after each "continue" correction floods context.
			this.#mutationsSinceLastTodoTouch = 0;
			this.#midRunNudgeCount = 0;
			this.#resetPromptMaintenanceState();
			this.#acceptTerminalEmptyStopForPrompt = options?.acceptTerminalEmptyStop === true;

			await this.#maybeRestoreRetryFallbackPrimary();

			// Validate model
			if (!this.model) {
				// Every command named here has to work in the channel the reader is in.
				// `/login` carries no `textMode: true` in
				// `slash-commands/builtin-declarations.ts`, so it is TUI-only, and
				// `veyyon setup` hard-exits with "requires an interactive TTY" when
				// stdin or stdout is not a terminal (see `commands/setup.ts`). This error
				// reaches `--print` runs and ACP clients too, so the terminal path is
				// named separately from the interactive one and the environment variable
				// is named for the case where neither is available.
				throw new Error(
					"No model selected, so there is nothing to send the prompt to.\n\n" +
						"Fix: in an interactive veyyon session, run /login to sign in and then /model to choose a model. " +
						"From a terminal, run `veyyon auth-broker login` to sign in and `veyyon models` to see what is available. " +
						"With no terminal at all, set the provider's API key environment variable and pass `--model <provider>/<id>`.",
				);
			}

			// Validate API key
			const apiKey = await this.#modelRegistry.getApiKey(this.model, this.sessionId);
			if (!apiKey) {
				const provider = this.model.provider;
				// Distinguish "never signed in" from "signed in, but no usable token
				// right now". `hasAuth` reports whether a credential is configured
				// WITHOUT refreshing; `getApiKey` refreshes and just returned nothing.
				// So when `hasAuth` is true the credential IS stored and the token
				// could not be produced — an expired OAuth token whose refresh failed,
				// or the provider rejecting the refresh (e.g. a 403/402 for a lapsed
				// subscription). Reporting "No API key found" there reads as lost
				// credentials and pushes the user into a re-login loop; name the real
				// cause instead so a provider-side account problem is not mistaken for
				// veyyon losing the login.
				const signedIn = this.#modelRegistry.authStorage.hasAuth(provider);
				// A credential a failed refresh disabled is invisible to `hasAuth`,
				// because disabled rows are filtered out of the credential list. So
				// the user whose login was torn down looks identical to the one who
				// never signed in, and gets told to sign in with nothing saying what
				// happened to the login they had. Name the cause instead.
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

			// Check whether an aborted response left enough context pressure to require
			// in-place compaction before this prompt starts its agent loop.
			const lastAssistant = this.#findLastAssistantMessage();
			if (lastAssistant && !options?.skipCompactionCheck) {
				await this.#checkCompaction(lastAssistant, false, false);
			}

			await this.#armPlanYoloIfNeeded();

			// Build messages array (session context, eager todo prelude, then active prompt message)
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

			// Early bail-out: if a newer abort/prompt cycle started during setup,
			// return before mutating shared state (nextTurn messages, system prompt).
			if (this.#promptGeneration !== generation) {
				return;
			}

			// Inject any pending "nextTurn" messages as context alongside the user message
			for (const msg of this.#pendingNextTurnMessages) {
				messages.push(msg);
			}
			this.#pendingNextTurnMessages = [];

			// Auto-read @filepath mentions
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

			// Ahead of the user's message, not after it: the memories are what the model
			// should already know when it reads the question, which is how the eager-task
			// prelude is placed too. Position within the turn is free either way — the
			// cache prefix ends before all of it.
			const memoryContextMessage = await this.#collectVolatileMemoryContext(expandedText);
			if (memoryContextMessage) messages.unshift(memoryContextMessage);
			const beforeAgentStartSystemPrompt = this.#baseSystemPrompt;

			// Emit before_agent_start extension event
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

			// Bail out if a newer abort/prompt cycle has started since we began setup
			if (this.#promptGeneration !== generation) {
				return;
			}

			// Auto thinking: classify this real user turn and set the effective level
			// before the model request. Synthetic/tool-continuation turns (developer/
			// custom roles) and non-auto sessions are skipped. Never blocks the turn —
			// failures fall back to a concrete level inside the helper.
			if (this.#autoThinking && message.role === "user") {
				await this.#applyAutoThinkingLevel(expandedText, generation);
				if (this.#promptGeneration !== generation) {
					return;
				}
			}

			await this.#runPrePromptCompactionIfNeeded(messages);
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
				cutoffCount: this.messages.length + messages.length,
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

	/**
	 * Try to execute an extension command. Returns true if command was found and executed.
	 */
	async #tryExecuteExtensionCommand(text: string): Promise<boolean> {
		if (!this.#extensionRunner) return false;

		const parsed = parseSlashCommand(text);
		if (!parsed) return false;
		const commandName = parsed.name;
		const args = parsed.args;

		const command = this.#extensionRunner.getCommand(commandName);
		if (!command) return false;

		// Get command context from extension runner (includes session control methods)
		const ctx = this.#extensionRunner.createCommandContext();

		try {
			await command.handler(args, ctx);
			return true;
		} catch (err) {
			// Emit error via extension runner
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
			// `ExtensionContextActions.abort` is `() => void`, so the promise from
			// `this.abort()` was discarded with no rejection handler and a failing
			// abort floated to postmortem, which exits the process. `abortDetached`
			// is the shared helper for aborts no caller can await.
			abort: () => {
				abortDetached(this, "agent-session.commandContext.abort", USER_INTERRUPT_LABEL);
			},
			hasPendingMessages: () => this.queuedMessageCount > 0,
			shutdown: () => {
				// `dispose()` flushes session state. This used to fire it and call
				// `process.exit(0)` on the very next line, so the flush was
				// abandoned at its first await and anything not yet written was
				// lost. Wait for it, but bound the wait so a wedged teardown still
				// exits instead of hanging the caller forever.
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

	/**
	 * Try to execute a custom command. Returns the prompt string if found, null otherwise.
	 * If the command returns void, returns empty string to indicate it was handled.
	 */
	async #tryExecuteCustomCommand(text: string): Promise<string | null> {
		if (this.#customCommands.length === 0 && this.#mcpPromptCommands.length === 0) return null;

		const parsed = parseSlashCommand(text);
		if (!parsed) return null;
		const commandName = parsed.name;
		const argsString = parsed.args;

		// Find matching command
		const loaded =
			this.#customCommands.find(c => c.command.name === commandName) ??
			this.#mcpPromptCommands.find(c => c.command.name === commandName);
		if (!loaded) return null;

		// Get command context from extension runner (includes session control methods)
		const baseCtx = this.#createCommandContext();
		const ctx = {
			...baseCtx,
			hasQueuedMessages: baseCtx.hasPendingMessages,
		} as unknown as HookCommandContext;

		try {
			const args = parseCommandArgs(argsString);
			const result = await loaded.command.execute(args, ctx);
			// If result is a string, it's a prompt to send to LLM
			// If void/undefined, command handled everything
			//
			// A command that produced a prompt gets its declared agents granted for the
			// turn that prompt starts, so `/review` still spawns `reviewer` on a stock
			// install where every bundled specialist is disabled. Granted only for a
			// real prompt: a fire-and-forget command starts no turn, so a grant would
			// have nothing to scope it and would sit open until the next settle.
			if (typeof result === "string" && result.length > 0) {
				this.#grantAgentsForTurn(loaded.command.spawnsAgents);
			}
			return result ?? "";
		} catch (err) {
			// Emit error via extension runner
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
			return ""; // Command was handled (with error)
		}
	}

	/**
	 * Queue a steering message to interrupt the agent mid-run.
	 */
	async steer(text: string, images?: ImageContent[]): Promise<void> {
		if (text.startsWith("/")) {
			this.#throwIfExtensionCommand(text);
		}

		const expandedText = expandPromptTemplate(text, [...this.#promptTemplates]);
		await this.#queueUserMessage(expandedText, images, "steer");
	}

	/**
	 * Queue a follow-up message to process after the agent would otherwise stop.
	 * Set `options.synthetic` to enqueue a hidden developer message (agent-attributed
	 * by default) instead of a user-attributed follow-up; the plan-approval flow
	 * uses this to land its execution directive behind a queued user turn without
	 * flipping advisor auto-resume.
	 */
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
		// Synthetic branch: agent-initiated hidden developer message. Bypass
		// #queueUserMessage (which clears advisor auto-resume suppression and
		// enqueues as a user-attributed message) and place the developer message
		// directly on the follow-up queue.
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
		// A queued user message (RPC/SDK/collab steer or follow-up, or a typed message
		// while streaming) is a deliberate resume; re-enable advisor auto-resume that
		// a user interrupt suppressed.
		this.#advisorAutoResumeSuppressed = false;
		const normalizedImages = await this.#normalizeImagesForModel(images);
		const content: (TextContent | ImageContent)[] = [{ type: "text", text }];
		if (normalizedImages?.length) {
			content.push(...normalizedImages);
		}
		// Text-only model + image attachment: describe via a vision model and enqueue the
		// description as a hidden companion immediately before the user message.
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

	/**
	 * Gate for idle-path queued-message auto-continue. See `#scheduleIdleQueueDrain` for rationale.
	 */
	#canAutoContinueForFollowUp(): boolean {
		if (this.isStreaming) return false;
		if (this.isRetrying) return false;
		// A queued steer resumes from ANY tail: Agent.continue() runs #runLoop(undefined),
		// whose initial steering poll injects the steer before the first provider call, so the
		// request tail becomes the steer (valid) regardless of any injected custom / bashExecution
		// / pythonExecution record a user interrupt left as the literal transcript tail. This is
		// why a queued user steer stranded behind a preserved advisor card (or a flushed IRC aside
		// / eval execution record) still resumes — no tail-role enumeration needed.
		if (this.agent.peekSteeringQueue().length > 0) return true;
		// Follow-up-only auto-resume stays suppressed while a deliberate user interrupt is in effect
		// (#advisorAutoResumeSuppressed, cleared on the next user prompt): the user stopped, so their
		// queued follow-up waits for an explicit resume — even if an interleaving IRC wake turn has
		// since left a provider-valid tail.
		if (this.#advisorAutoResumeSuppressed) return false;
		// Follow-up-only resume has no steer to inject, so Agent.continue() continues from the
		// existing context tail — which must itself be a valid provider tail. An injected
		// non-conversational tail (advisor card → `developer`, bash/python execution) would make
		// the first model call invalid, so leave the follow-up queued for the next explicit resume.
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
				} catch {
					// Leave the hidden next-turn messages queued for the next explicit prompt.
				}
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

	/**
	 * Throw an error if the text is an extension command.
	 */
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

	/** Queue a custom message without starting a turn, matching steer/follow-up delivery. */
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

	/**
	 * Send a custom message to the session. Creates a CustomMessageEntry.
	 *
	 * Handles three cases:
	 * - Streaming: queue as steer/follow-up or store for next turn
	 * - Not streaming + triggerTurn: appends to state/session, starts new turn unless the client cannot own it
	 * - Not streaming + no trigger: appends to state/session, no turn
	 *
	 * @returns true iff this call synchronously started a new turn (awaited
	 * `agent.prompt`); false when the message was queued/appended without a turn
	 * — including when `triggerTurn` is downgraded because the client defers
	 * agent-initiated turns. Callers that must mirror the resulting `agent_end`
	 * use this to avoid acting on a turn that never ran.
	 */
	async sendCustomMessage<T = unknown>(
		message: CustomMessagePayload<T>,
		options?: {
			triggerTurn?: boolean;
			deliverAs?: "steer" | "followUp" | "nextTurn";
			queueChipText?: string;
			acceptTerminalEmptyStop?: boolean;
		},
	): Promise<boolean> {
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

		if (options?.deliverAs === "followUp") {
			await this.#queueUserMessage(text, images, "followUp");
			return;
		}
		if (options?.deliverAs === "steer") {
			await this.#queueUserMessage(text, images, "steer");
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

	/** Clear queued messages and return the user-restorable ones (text plus any attached images).
	 *  Only user-authored messages (plain user turns, `attribution:"user"` custom like `/skill`) are
	 *  returned for editor restore. Other queued messages stay in the agent-core queues so a continuing
	 *  stream still delivers them — EXCEPT on `forInterrupt` (Esc+abort), where only advisor cards are
	 *  kept (abort()'s #extractQueuedAdvisorCards preserves them as visible advice) and every other
	 *  non-user steer (hidden goal/plan/budget, IRC/extension asides) is dropped, so abort()'s
	 *  #drainStrandedQueuedMessages can't auto-resume the run the user just interrupted (the drain only
	 *  fires while agent.hasQueuedMessages()). Plain Alt+Up dequeue preserves those non-user steers. */
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

	/** Number of pending displayable messages (includes steering, follow-up, and next-turn messages).
	 *  Reflects actual queued work (advisor cards included) — feeds hasPendingMessages()/RPC and the
	 *  empty-submit abort gate. The user-restorable subset is surfaced by getQueuedMessages()/clearQueue(). */
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

	/**
	 * Pop the last queued message (steering first, then follow-up).
	 * Used by dequeue keybinding to restore messages to editor one at a time.
	 * Steps over agent-authored queued messages (advisor cards, hidden/internal steers).
	 */
	popLastQueuedMessage(): RestoredQueuedMessage | undefined {
		const steering = this.agent.peekSteeringQueue();
		const followUp = this.agent.peekFollowUpQueue();
		const lastUserIndex = (queue: readonly AgentMessage[]): number => {
			for (let i = queue.length - 1; i >= 0; i--) {
				if (isUserQueuedMessage(queue[i])) return i;
			}
			return -1;
		};
		// Notices queue immediately before their user message, so dropping the popped
		// prompt means also dropping the contiguous hidden-user companions right before
		// it — companions of other queued prompts stay put.
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
		this.#stopAdvisorRuntime();
		this.#advisorWatchdogPrompt = scope.advisorWatchdogPrompt;
		this.#advisorContextPrompt = scope.advisorContextPrompt;
		this.#advisorSharedInstructions = scope.advisorSharedInstructions;
		this.#advisorConfigs = scope.advisorConfigs;
		this.#advisorEnabled = isAdvisorProductEnabled() && (this.settings.get("advisor.enabled") as boolean);
		if (this.#advisorEnabled) this.#buildAdvisorRuntime();
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

	/**
	 * Drop every piece of todo-reminder state that describes the context being
	 * left. Called from each boundary that starts a new one: `newSession`
	 * (`/new` and `/clear` both route through it), handoff, and resume.
	 *
	 * One function rather than four copies of the same five assignments, because
	 * the copies were what let {@link #lastTodoFailureText} survive a `/new`: it
	 * was added later and never appeared in any of them, so a single failed todo
	 * write silenced every reminder for the rest of the process.
	 */
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
		);
		if (!title) return;
		if (this.sessionManager.getSessionId() !== sessionId) return;
		if (!this.settings.get("title.refreshOnReplan")) return;
		if (this.sessionManager.titleSource === "user") return;
		const setSessionName = this.sessionManager.setSessionName as SetSessionNameWithTrigger;
		await setSessionName.call(this.sessionManager, title, "auto", "replan");
	}

	/** Currently-applied {@link TITLE_SYSTEM.md} override, or undefined when the
	 *  bundled prompt is in effect. Consumed by {@link InteractiveMode} so the
	 *  first-input title path and the replan refresh share one source. */
	get titleSystemPrompt(): string | undefined {
		return this.#titleSystemPrompt;
	}

	/** Replace the title-generation system prompt override. Called by
	 *  {@link InteractiveMode.refreshTitleSystemPrompt} after the session cwd
	 *  changes (e.g. `/move` relocation) so the next replan refresh resolves
	 *  against the destination project's override. */
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

	// Auto-clear of completed/abandoned tasks was removed: the timer-driven
	// splice mutated canonical `#todoPhases` between tool calls, so the model
	// observed phase totals shrinking ("5 → 4") after marking tasks done. The
	// `tasks.todoClearDelay` setting is now inert; completed tasks survive
	// until the next explicit `todo` call removes them via `rm`/`drop`.

	/**
	 * Abort current operation and wait for agent to become idle.
	 *
	 * `reason` (e.g. `USER_INTERRUPT_LABEL`) rides the agent's `AbortController`
	 * and surfaces verbatim on the aborted assistant message's `errorMessage`, so
	 * the transcript can distinguish a deliberate user interrupt from an opaque
	 * abort. Omit it for internal/lifecycle aborts.
	 */
	async abort(options?: {
		goalReason?: "interrupted" | "internal";
		reason?: string;
		/** Internal `/compact` startup keeps the manual-compaction marker alive while aborting the active turn. */
		preserveCompaction?: boolean;
	}): Promise<void> {
		const userInterrupt = options?.reason === USER_INTERRUPT_LABEL;
		this.#pendingAbortErrorId = userInterrupt ? AIError.create(AIError.Flag.UserInterrupt) : undefined;
		if (userInterrupt) this.#advisorAutoResumeSuppressed = true;
		// Pull advisor concerns out of the steer/follow-up queues before any await so
		// the post-abort stranded-message drain can't auto-resume the run on them.
		// They are re-recorded as visible advice once the agent settles (below).
		const strandedAdvisorCards = userInterrupt ? this.#extractQueuedAdvisorCards() : [];
		// Session switch/compact paths disconnect first; explicit aborts should
		// leave any queued steer/follow-up visible for the user rather than
		// auto-starting a fresh turn during cleanup.
		this.#abortInProgress = true;
		try {
			this.abortRetry();
			this.#promptGeneration++;
			this.#scheduledHiddenNextTurnGeneration = undefined;
			if (options?.preserveCompaction) {
				// Manual `/compact` installed its own #compactionAbortController before
				// this internal abort and must keep it alive (that marker is what makes
				// isCompacting report true during startup). Any in-flight
				// auto-compaction MUST still be cancelled, though: otherwise a
				// background maintenance pass races the manual run and both
				// appendCompaction/replaceMessages, double-rewriting session history.
				this.#autoCompactionAbortController?.abort();
			} else {
				this.abortCompaction();
			}
			this.abortHandoff();
			this.abortBash();
			this.abortEval();
			const postPromptDrain = this.#cancelPostPromptTasks();
			this.agent.abort(options?.reason);
			await postPromptDrain;
			await this.agent.waitForIdle();
			await this.#goalRuntime.onTaskAborted({ reason: options?.goalReason ?? "interrupted" });
			// Clear prompt-in-flight state: waitForIdle resolves when the agent loop's finally
			// block runs, but nested prompt setup/finalizers may still be unwinding. Without this,
			// a subsequent prompt() can incorrectly observe the session as busy after an abort.
			this.#resetInFlight();
			this.#resetSessionStopContinuationState();
			this.#clearPendingSessionStopContinuations();
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
			// #pendingNextTurnMessages while the turn was still tearing down. Other
			// deferred next-turn context (non-advisor) stays queued, in order.
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

	/**
	 * Start a new session, optionally with initial messages and parent tracking.
	 * Clears all messages and starts a new session.
	 * Listeners are preserved and will continue receiving events.
	 * @param options - Optional initial messages and parent session path
	 * @returns true if completed, false if cancelled by hook
	 */
	async newSession(options?: NewSessionOptions): Promise<boolean> {
		const previousSessionFile = this.sessionFile;
		const nextDiscoverySessionToolNames = this.#mcpDiscoveryEnabled
			? [
					...this.#getActiveNonMCPToolNames(),
					...this.#filterSelectableMCPToolNames(this.#defaultSelectedMCPToolNames),
				]
			: undefined;

		// Emit session_before_switch event with reason "new" (can be cancelled)
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
			// Detach the advisor recorder feed and drain its writer BEFORE deleting the
			// old artifacts dir: `await this.abort()` only stops the primary, so a still-
			// running advisor turn could otherwise finish, emit `message_end`, and recreate
			// `<old>/__advisor.jsonl`. #resetAdvisorSessionState (after newSession) re-primes
			// the advisor and re-attaches the feed at the new session's path.
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
		// The transcript changed under this session, so its subagents belong to a
		// conversation the operator has left. Release them and re-root this ref.
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

		// Emit session_switch event with reason "new" to hooks
		if (this.#extensionRunner) {
			await this.#extensionRunner.emit({
				type: "session_switch",
				reason: "new",
				previousSessionFile,
			});
		}

		return true;
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
	async fork(): Promise<boolean> {
		const previousSessionFile = this.sessionFile;

		// Emit session_before_switch event with reason "fork" (can be cancelled)
		if (this.#extensionRunner?.hasHandlers("session_before_switch")) {
			const result = (await this.#extensionRunner.emit({
				type: "session_before_switch",
				reason: "fork",
			})) as SessionBeforeSwitchResult | undefined;

			if (result?.cancel) {
				return false;
			}
		}

		// Flush current session to ensure all entries are written
		await this.sessionManager.flush();

		// Fork the session (creates new session file with same entries)
		const forkResult = await this.sessionManager.fork();
		if (!forkResult) {
			return false;
		}

		// Copy artifacts directory if it exists
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

		// Update agent session ID
		this.#freshProviderSessionId = undefined;
		this.#adoptInheritedProviderPromptCacheKey();
		this.#syncAgentSessionId();
		this.#rekeyHindsightMemoryForCurrentSessionId();
		this.#rekeyMnemopiMemoryForCurrentSessionId();
		this.#resetMemoryContextForNewTranscript();

		// Emit session_switch event with reason "fork" to hooks
		if (this.#extensionRunner) {
			await this.#extensionRunner.emit({
				type: "session_switch",
				reason: "fork",
				previousSessionFile,
			});
		}

		return true;
	}

	// =========================================================================
	// Model Management
	// =========================================================================

	/**
	 * Set model directly.
	 * Validates that a credential source is configured (synchronously, without
	 * refreshing OAuth or running command-backed key programs). Active switches
	 * always take effect; if the current transcript is too large for the target
	 * model, the next prompt's compaction/error path owns that recovery instead
	 * of leaving the session pinned to the old model.
	 * @throws Error if no API key available for the model
	 */
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
		// One name for the slot, resolved once: the log and the store used to disagree
		// on the same write (stored `default`, logged `interactive`), so a reader of
		// the session log could not match an entry to the setting it changed.
		const slot = resolveModelSlot(role);
		this.sessionManager.appendModelChange(`${targetModel.provider}/${targetModel.id}`, slot);
		if (options?.persist) {
			this.settings.setModelRole(
				slot,
				this.#formatRoleModelValue(slot, targetModel, options.selector, options.thinkingLevel),
			);
		}
		this.settings.getStorage()?.recordModelUsage(`${targetModel.provider}/${targetModel.id}`);

		// Apply the session override, explicit selector variant, saved per-model
		// default, or model default in that order.
		this.#reapplyThinkingLevel(options?.thinkingLevel);
		await this.#syncAfterModelChange(previousEditMode);
		return { switched: true };
	}

	/**
	 * Set model temporarily (for this session only).
	 * Validates that a credential source is configured (synchronously, without
	 * refreshing OAuth or running command-backed key programs), saves to session
	 * log but NOT to settings.
	 * @throws Error if no API key available for the model
	 */
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

	/**
	 * Cycle to next/previous model.
	 * Uses scoped models (from --models flag) if available, otherwise all available models.
	 * @param direction - "forward" (default) or "backward"
	 * @returns The new model info, or undefined if only one model available
	 */
	async cycleModel(direction: "forward" | "backward" = "forward"): Promise<ModelCycleResult | undefined> {
		if (this.#scopedModels.length > 0) {
			return this.#cycleScopedModel(direction);
		}
		return this.#cycleAvailableModel(direction);
	}

	/**
	 * Resolve the configured role models in the given order plus the index of
	 * the currently active one. Roles that have no configured model, or whose
	 * configured model is not currently available, are skipped. The `default`
	 * role falls back to the active model when no explicit assignment exists.
	 *
	 * Returns `undefined` only when there is no current model or no available
	 * models at all; an empty `models` array is never returned (callers should
	 * still guard on `models.length`).
	 */
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

		// Trust the recorded role only while its resolved model still IS the
		// active model. A model switch through another surface (alt+m, retry
		// fallback, /model) or a role re-configuration leaves the recorded role
		// pointing at a model the session no longer runs; cycling from that
		// stale slot lands on the wrong neighbor and reads as a skipped entry.
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

	/**
	 * Apply a resolved role model as the active model without changing global
	 * settings. Shared with role cycling and the plan-approval model slider.
	 */
	async applyRoleModel(entry: ResolvedRoleModel): Promise<void> {
		await this.setModel(entry.model, entry.role, {
			thinkingLevel: entry.explicitThinkingLevel ? entry.thinkingLevel : undefined,
		});
	}

	/**
	 * Cycle through configured role models in a fixed order.
	 * Skips missing roles and changes only the active session model.
	 * @param roleOrder - Order of roles to cycle through (e.g., ["slow", "default", "smol"])
	 * @param direction - "forward" (default) or "backward"
	 */
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

		// Apply model
		this.#modelRegistry.clearSuppressedSelector(formatModelStringWithRouting(next.model));
		this.#clearActiveRetryFallback();
		this.#setModelWithProviderSessionReset(next.model);
		this.sessionManager.appendModelChange(`${next.model.provider}/${next.model.id}`);
		this.settings.getStorage()?.recordModelUsage(`${next.model.provider}/${next.model.id}`);

		// An unsuffixed scoped entry re-reads the current saved per-model default;
		// only an explicit scope suffix is a selector pin.
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
		// Re-apply the current thinking level (or auto) for the newly selected model
		this.#reapplyThinkingLevel();
		await this.#syncAfterModelChange(previousEditMode);

		return { model: nextModel, thinkingLevel: this.thinkingLevel, isScoped: false };
	}

	/**
	 * Get all available models with valid API keys, filtered by `enabledModels` when configured.
	 * See {@link filterAvailableModelsByEnabledPatterns} for supported pattern forms and limitations.
	 */
	getAvailableModels(): Model[] {
		const all = this.#modelRegistry.getAvailable();
		const patterns = this.settings.get("enabledModels");
		if (!patterns || patterns.length === 0) return all;
		return filterAvailableModelsByEnabledPatterns(all, patterns, this.settings);
	}

	// =========================================================================
	// Thinking Level Management
	// =========================================================================

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

	/**
	 * Write a durable default effort into the `defaultEffort` row that governs
	 * the selected model, which is the setting {@link resolveEffort} actually
	 * reads. The retired `defaultThinkingLevel` enum this replaced is consulted
	 * only when `defaultEffort` is absent, so persisting there was discarded on
	 * the next read for every profile that had a `defaultEffort` object.
	 */
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
		// A level the active model does not accept resolves to the nearest
		// supported one (or drops). Interactive entry points refuse such levels
		// outright, so a clamp here means a persisted or inherited value met a
		// model switch: name both levels instead of silently drifting (the
		// "random arbitrary effort" report, 2026-08-05).
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
		// Leaving auto must persist even when the resolved effort is unchanged (e.g.
		// auto resolved to medium, then the user pins medium): otherwise the latest
		// session entry keeps `configured: "auto"` and resume re-enables auto.
		const isChanging = wasAuto || effectiveLevel !== this.#thinkingLevel;

		this.#thinkingLevel = effectiveLevel;
		this.#applyThinkingLevelToAgent(effectiveLevel);

		// Durability is not a change notification. Pinning the level the session
		// already sits at is the ordinary way to ask for a default, so this write
		// cannot share the branch guarding event emission, the transcript entry,
		// and cache invalidation, all of which are legitimately change-gated.
		// `off` stays non-persistable: it is a state to leave, not a default.
		if (persist && effectiveLevel !== undefined && effectiveLevel !== ThinkingLevel.Off) {
			this.#persistDefaultEffort(effectiveLevel);
		}
		if (isChanging) {
			this.#clearInheritedProviderPromptCacheKey("thinking-level-change");
			this.sessionManager.appendThinkingLevelChange(effectiveLevel, effectiveLevel);
			this.#emit({ type: "thinking_level_changed", thinkingLevel: effectiveLevel });
		}
	}

	/** Apply the current session override, selector pin, or saved model default after a model switch. */
	#reapplyThinkingLevel(selectorLevel?: ConfiguredThinkingLevel): void {
		this.#activeSelectorThinkingLevel = selectorLevel;
		this.setThinkingLevel(this.#resolvedEffortForModel(this.model, selectorLevel), false, "resolved");
	}

	/**
	 * Cycle through the active model's named effort variants.
	 *
	 * Models with different provider vocabularies keep different valid lists;
	 * the shared control and ordering stay the same.
	 */
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

	/** Timeout (ms) for per-turn auto-thinking classification before falling back. */
	static readonly #AUTO_THINKING_TIMEOUT_MS = 4000;

	/**
	 * Classify the current user turn and set the effective thinking level for it.
	 * Bounded by a timeout + abort; on any failure (no smol model, timeout, parse
	 * error) it falls back to the provisional concrete level and continues. Never
	 * throws into the turn, and never clears `#autoThinking` (auto stays active).
	 */
	async #applyAutoThinkingLevel(promptText: string, generation: number): Promise<void> {
		const model = this.model;
		if (!model?.reasoning) return;
		// Models with reasoning but no controllable effort surface (devin-agent
		// Cascade routes effort via sibling model ids, not a wire param) have
		// nothing to pick — skip classification rather than discard its result.
		if (getSupportedEfforts(model).length === 0) return;

		let resolved: Effort | undefined;
		let classificationError: string | undefined;
		if (this.#magicKeywordEnabled("ultrathink") && containsUltrathink(promptText)) {
			// The user explicitly asked for maximum thinking; bypass the classifier
			// (and its xhigh auto ceiling) and jump straight to the highest
			// supported level for this model.
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
				});
			} catch (error) {
				classificationError = errorMessage(error);
			} finally {
				clearTimeout(timer);
			}
		}

		// Drop the result if the turn was aborted/superseded while classifying.
		if (this.#promptGeneration !== generation || !this.#autoThinking) return;

		const effort = resolved ?? resolveProvisionalAutoLevel(model);

		// Auto thinking exists to pick the level for you. When classification fails
		// it quietly falls back to a provisional level, so the user gets a thinking
		// budget nobody chose while the feature reports itself as on. That was a
		// `logger.debug`, which is silent (Law 10). Reported at warn, and the level
		// actually used is named, because "auto-thinking failed" without it does not
		// tell an operator what their turn ran at.
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

	/**
	 * True when the currently selected model's family is set to `priority` — the
	 * `/fast` on/off state for the active model. Returns false when no model is
	 * selected or the model exposes no service-tier family (e.g. Fireworks, which
	 * has its own Providers › Fireworks Tier toggle).
	 *
	 * For "is priority actually applied to the next request?" use
	 * {@link isFastModeActive} instead.
	 */
	isFastModeEnabled(): boolean {
		const family = this.model ? serviceTierFamily(this.model) : undefined;
		return family ? this.#serviceTierByFamily[family] === "priority" : false;
	}

	/**
	 * True when `priority` is actually realized on the wire for the currently
	 * selected model (OpenAI/Google `service_tier`, direct Anthropic fast mode,
	 * or Fireworks priority). Returns false for tiers the active model can't
	 * realize and when no model is selected.
	 */
	isFastModeActive(): boolean {
		const model = this.model;
		return !!model && realizesPriorityServiceTier(this.#effectiveServiceTier(model), model);
	}

	/**
	 * Effective wire service-tier for a request to `model`. Fireworks models take
	 * the Priority serving path only when the Providers › Fireworks Tier setting
	 * is `"priority"` (and never for `-fast` variants, whose Fast serving path is
	 * mutually exclusive with Priority). Every other model resolves the live
	 * per-family tier map down to the entry for its family.
	 */
	#effectiveServiceTier(model: Model | undefined = this.model): ServiceTier | undefined {
		if (model?.provider === "fireworks") {
			return this.settings.get("providers.fireworksTier") === "priority" && !isFireworksFastModelId(model.id)
				? "priority"
				: undefined;
		}
		if (!model) return undefined;
		return resolveModelServiceTier(this.#serviceTierByFamily, model);
	}

	/** The live per-family tier map, or `null` when empty (for session persistence). */
	#serviceTierEntry(): ServiceTierByFamily | null {
		return Object.keys(this.#serviceTierByFamily).length > 0 ? this.#serviceTierByFamily : null;
	}

	/** Set one family's tier (or clear it with `undefined`); persists the change. */
	setServiceTierFamily(family: ServiceTierFamily, tier: ServiceTier | undefined): void {
		if (this.#serviceTierByFamily[family] === tier) return;
		const next: ServiceTierByFamily = { ...this.#serviceTierByFamily };
		if (tier) next[family] = tier;
		else delete next[family];
		this.#applyServiceTierByFamily(next);
	}

	/** Replace the whole per-family tier map; persists + re-arms Anthropic fast mode. */
	#applyServiceTierByFamily(next: ServiceTierByFamily): void {
		// Re-arming Anthropic priority clears the per-session fast-mode auto-disable
		// so the next request actually carries `speed: "fast"` again.
		if (next.anthropic === "priority" && this.#serviceTierByFamily.anthropic !== "priority") {
			clearAnthropicFastModeFallback(this.#providerSessionState);
		}
		this.#serviceTierByFamily = next;
		this.sessionManager.appendServiceTierChange(this.#serviceTierEntry());
	}

	/**
	 * `/fast on|off` targets the family of the currently selected model: it sets
	 * (or clears) that family's `priority` tier. Returns `false` when the model
	 * has no service-tier family, so callers can report that fast mode is
	 * unavailable instead of claiming success.
	 */
	setFastMode(enabled: boolean): boolean {
		const family = this.model ? serviceTierFamily(this.model) : undefined;
		if (!family) {
			this.emitNotice("info", "The current model has no service-tier control for /fast to toggle.", "priority");
			return false;
		}
		if (!enabled) {
			if (this.#serviceTierByFamily[family] === "priority") this.setServiceTierFamily(family, undefined);
			return true;
		}
		this.setServiceTierFamily(family, "priority");
		return true;
	}

	toggleFastMode(): boolean {
		if (!this.setFastMode(!this.isFastModeEnabled())) return false;
		return this.isFastModeEnabled();
	}

	/**
	 * Get available thinking levels for current model.
	 */
	getAvailableThinkingLevels(): ReadonlyArray<Effort> {
		if (!this.model) return [];
		return getSupportedEfforts(this.model);
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
	 * Append plan-read protection to an operator-requested shake config so the
	 * active plan file survives alongside skill reads (the config defaults
	 * already carry skill protection). The matcher reads the current plan
	 * reference path at match time, so retitled plans are covered.
	 */
	#withPlanProtection<T extends { protectedTools: ProtectedToolMatcher[] }>(config: T): T {
		const planMatcher = createPlanReadMatcher(() => this.#planReferencePath);
		return { ...config, protectedTools: [...config.protectedTools, planMatcher] };
	}

	/**
	 * Threshold-time overflow prune: blank the oldest tool results outside the
	 * protect-recent window, plus any result its tool flagged contextually
	 * useless. Runs before the threshold comparison so a turn that pruning alone
	 * can bring back under the trigger never pays for a summarization request.
	 */
	async #pruneToolOutputs(): Promise<{ prunedCount: number; tokensSaved: number } | undefined> {
		const branchEntries = this.sessionManager.getBranch();
		const keepBoundaryId = getLatestCompactionEntry(branchEntries)?.firstKeptEntryId;
		const result = pruneToolOutputs(
			branchEntries,
			this.#withPlanProtection({
				...DEFAULT_PRUNE_CONFIG,
				pruneUseless: this.settings.getGroup("compaction").dropUseless,
				// Cache-stable boundary: never re-write the warm, already-sent prefix
				// (deep stale/age victims) or summarized-away entries every turn.
				keepBoundaryId,
				cacheWarmSuffixTokens: PRUNE_CACHE_WARM_SUFFIX_TOKENS,
			}),
		);
		if (result.prunedCount === 0) {
			return undefined;
		}

		await this.sessionManager.rewriteEntries();
		const sessionContext = this.buildDisplaySessionContext();
		this.agent.replaceMessages(sessionContext.messages);
		this.#resetAllAdvisorRuntimes();
		this.#syncTodoPhasesFromBranch();
		this.#closeCodexProviderSessionsForHistoryRewrite();
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
	 * Persists via `rewriteEntries` like every other history rewrite: the
	 * session file must match the live (pruned) context or file-based forks
	 * (`/fork`, `/tan`) and resume rebuild a divergent prefix and cold-miss the
	 * provider prompt cache.
	 */
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
				// Never re-write summarized-away entries; only flush the whole sent
				// region once the cache is genuinely cold (idle exceeds the 1h TTL).
				keepBoundaryId,
				idleFlushMs: PRUNE_IDLE_FLUSH_MS,
			}),
		);
		if (result.prunedCount === 0) {
			return undefined;
		}

		await this.sessionManager.rewriteEntries();
		const sessionContext = this.buildDisplaySessionContext();
		this.agent.replaceMessages(sessionContext.messages);
		this.#resetAllAdvisorRuntimes();
		this.#syncTodoPhasesFromBranch();
		this.#closeCodexProviderSessionsForHistoryRewrite();
		return result;
	}

	/**
	 * Strip image content blocks from every message on the current branch and
	 * persist the rewrite. Walks `SessionManager.getBranch()` in place — both
	 * `SessionMessageEntry.message` and `CustomMessageEntry.content` arrays
	 * are mutated, then `rewriteEntries` durably commits the new shape. The
	 * agent's runtime view is rebuilt from the freshly-mutated entries so any
	 * provider sessions caching message identity (Codex Responses) are torn
	 * down to force a clean replay on the next turn.
	 *
	 * No-op when the branch carries no images; returns `{ removed: 0 }` and
	 * skips the disk rewrite.
	 */
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
		await this.sessionManager.rewriteEntries();
		const sessionContext = this.buildDisplaySessionContext();
		this.agent.replaceMessages(sessionContext.messages);
		this.#resetAllAdvisorRuntimes();
		this.#closeCodexProviderSessionsForHistoryRewrite();
		return { removed };
	}

	/**
	 * Surgically reduce context by dropping heavy content ("shake").
	 *
	 * - `images` delegates to {@link dropImages}.
	 * - `elide` replaces whole tool-call results and large fenced/XML blocks
	 *   with short placeholders that embed an `artifact://` recovery link.
	 *
	 * Mutates the branch in place, persists via `rewriteEntries`, replays the
	 * rebuilt context through the agent, and tears down provider sessions that
	 * cache message identity — same rewrite contract as {@link dropImages}.
	 *
	 * No-op (zero counts) when nothing is eligible.
	 */
	async shake(mode: ShakeMode, opts: { config?: ShakeConfig; signal?: AbortSignal } = {}): Promise<ShakeResult> {
		if (mode === "images") {
			const { removed } = await this.dropImages();
			return { mode, toolResultsDropped: 0, blocksDropped: 0, imagesDropped: removed, tokensFreed: 0 };
		}

		const branchEntries = this.sessionManager.getBranch();
		const config = this.#withPlanProtection({
			...(opts.config ?? AGGRESSIVE_SHAKE_CONFIG),
			// Skip entries summarized away by the latest compaction — shaking them
			// only churns persisted history with no prompt/cache effect.
			keepBoundaryId: getLatestCompactionEntry(branchEntries)?.firstKeptEntryId,
		});
		// Heavy-content pass: large tool results and fenced/XML blocks under the
		// usual size/protect-window/savings gates. Redundancy pass: earlier
		// tool-results byte-identical to a newer one (re-read of an unchanged file,
		// re-run of the same command). A duplicate carries no unique information, so
		// it is eligible however recent it is — the two passes overlap only on the
		// same tool-result entry, which the newer pass must not re-elide.
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

	/**
	 * Offload a set of shake regions to one recovery artifact, splice their
	 * placeholders in place, persist the rewrite, and re-prime the provider /
	 * advisor views. Shared by {@link shake} and
	 * {@link dedupeRedundantToolResults} so the offload + rewrite tail lives in
	 * exactly one place. Caller guarantees `regions` is non-empty.
	 */
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

		await this.sessionManager.rewriteEntries();
		const sessionContext = this.buildDisplaySessionContext();
		this.agent.replaceMessages(sessionContext.messages);
		this.#resetAllAdvisorRuntimes();
		this.#closeCodexProviderSessionsForHistoryRewrite();

		return {
			toolResultsDropped,
			blocksDropped,
			tokensFreed: Math.max(0, originalTokens - replacementTokens),
			artifactId,
		};
	}

	/**
	 * Lossless, LLM-free reducer: elide earlier tool-results that are
	 * byte-identical to a newer one (re-read of an unchanged file, re-run of the
	 * same command). Unlike {@link shake} this touches only exact duplicates, so
	 * it is safe to run proactively on any compaction strategy — the newest copy
	 * of each result stays live and the elided copies remain recoverable via the
	 * offload artifact. Returns zero counts when nothing is redundant.
	 */
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

	/**
	 * Concatenate the original region contents into one session artifact so the
	 * agent can read them back via `artifact://<id>`. Returns `undefined` when
	 * the session is not persisted or the write fails — callers degrade to a
	 * bare placeholder.
	 */
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
			this.#disconnectFromAgent();
			await this.abort({ goalReason: "internal", preserveCompaction: true });
			if (!this.model) {
				throw new Error(
					"No model selected, so compaction has nothing to summarize with. Fix: in an interactive veyyon session run /model to choose one; from a terminal pass `--model <provider>/<id>`, or set `compaction.model` so compaction uses its own model regardless of the session's.",
				);
			}

			const compactionSettings = this.settings.getGroup("compaction");
			// The optional `/compact summary` token resolves before this point and
			// pins the sole strategy for this invocation.
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
			this.#rebasePendingContextSnapshotAfterCompaction();
			// Compaction discarded the conversation history that carried the approved
			// plan reference. Clear the sent-flag so #buildPlanReferenceMessage re-reads
			// the plan from disk and re-injects it on the next turn (issue #1246).
			this.#planReferenceSent = false;
			this.#resetAllAdvisorRuntimes();
			this.#syncTodoPhasesFromBranch();
			if (codexCompaction) {
				this.#resetCodexProviderAfterCompaction(codexCompaction);
			} else {
				this.#closeCodexProviderSessionsForHistoryRewrite();
			}

			// Get the saved compaction entry for the hook
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
			const err = error instanceof Error ? error : new Error(String(error));
			options?.onError?.(err);
			throw error;
		} finally {
			if (this.#compactionAbortController === compactionAbortController) {
				this.#compactionAbortController = undefined;
			}
			this.#reconnectToAgent();
		}
	}

	/**
	 * Ask the active memory backend for an extra-context block to splice into
	 * the compaction summary prompt. Both the manual and auto compaction paths
	 * funnel through this helper so the behaviour stays identical.
	 *
	 * Failures are swallowed: a memory backend going sideways MUST NOT block
	 * compaction (which is itself the recovery path for context overflow).
	 */
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
				error: String(err),
			});
			return undefined;
		}
	}

	/**
	 * Cancel in-progress manual or automatic context maintenance.
	 */
	abortCompaction(): void {
		this.#compactionAbortController?.abort();
		this.#autoCompactionAbortController?.abort();
		this.#handoffAbortController?.abort();
	}

	/** Trigger idle compaction through the auto-compaction flow (with UI events). */
	async runIdleCompaction(): Promise<void> {
		if (this.isStreaming || this.isCompacting) return;
		await this.#runAutoCompaction("idle", false);
	}

	/**
	 * Cancel in-progress branch summarization.
	 */
	abortBranchSummary(): void {
		this.#branchSummaryAbortController?.abort();
	}

	/**
	 * Cancel in-progress handoff generation.
	 */
	abortHandoff(): void {
		this.#handoffAbortController?.abort();
	}

	/**
	 * Check if handoff generation is in progress.
	 */
	get isGeneratingHandoff(): boolean {
		return this.#handoffAbortController !== undefined;
	}

	/**
	 * Generate a handoff document with a oneshot LLM call, then start a new session with it.
	 *
	 * @param customInstructions Optional focus for the handoff document
	 * @param options Handoff execution options
	 * @returns The handoff document text, or undefined if cancelled/failed
	 */
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

			// Build the handoff request through the SAME pipeline a live turn uses
			// (`runEphemeralTurn` / `/btw` share it) so the oneshot reads the
			// provider prompt cache the main turn populated instead of cold-missing
			// the whole prefix: identical system prompt, normalized tools, and
			// transform-/obfuscation-matched message history via
			// `convertMessagesToLlm` + `buildSideRequestContext`, plus the live turn's
			// effective provider cache key with a unique side `sessionId` so
			// OpenAI/Codex append-only state never mixes with the live turn.
			const cacheSessionId = this.sessionId;
			// The loop sends `promptCacheKey` (providerPromptCacheKey) and falls back to
			// the provider session id; providers route on `promptCacheKey ?? sessionId`.
			// Both can diverge from this.sessionId (tan/subagent/shared sessions), so
			// mirror exactly what the live turn populated the cache under.
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
			// Base system prompt, not a per-turn `before_agent_start` hook override —
			// the handoff seeds a fresh session and must not carry prompt-specific
			// hook state. Matches the prompt the old handoff path sent.
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
					// Honor the user's /model thinking selection on the handoff path.
					// Clamped per-model inside generateHandoffFromContext via
					// resolveCompactionEffort so unsupported-effort models don't trip
					// requireSupportedEffort.
					thinkingLevel: this.thinkingLevel,
				},
			);
			// Append the same deterministic `<files>` block the summary strategy gets.
			// It is machine-generated from the live messages, costs no LLM work, and is
			// byte-identical across models, so the handoff had been giving the next
			// session strictly less than a summary of the same history for no reason.
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

			// Start a new session
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
			// A handoff continues the work in a NEW transcript. The pre-handoff
			// subagents wrote into the old one and their jobs were just cancelled;
			// leaving them registered would list them under the new conversation.
			await this.#rescopeAgentRegistry();

			this.#clearCheckpointRuntimeState();
			// agent.reset() clears the core steering/follow-up queues. Preserve any queued
			// steers/follow-ups (RPC/SDK steer()/followUp() issued during the handoff, or a
			// pre-loader TUI steer) so they survive into the post-handoff session instead of
			// being silently dropped. Capture is synchronous immediately before reset and
			// restore is synchronous immediately after — no await gap — so a steer arriving
			// later (during ensureOnDisk/Bun.write below) appends to the restored queue
			// rather than being clobbered.
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

			// Inject the handoff document as a custom message
			const handoffContent = createHandoffContext(handoffText);
			this.sessionManager.appendCustomMessageEntry("handoff", handoffContent, true, undefined, "agent");
			if (carriedTodoPhases.length > 0) {
				// Todos survive a handoff through their own persisted snapshot entry, the
				// same one `/todo` writes, so a reload of the new transcript still finds them.
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

			// Rebuild agent messages from session
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
			computeNonMessageTokens(this) +
			computeStoredMessagesTokens(this, opts) +
			pendingMessages.reduce((sum, msg) => sum + estimateTokens(msg, opts), 0)
		);
	}

	#estimatePrePromptContextTokens(messages: AgentMessage[], contextWindow: number): number {
		// The local-estimate floor lives in getContextBreakdown, so this is the
		// exact number the footline gauge shows.
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

		// Auto-promote first: switching to a larger-context model avoids compacting
		// the history at all. The post-turn threshold path already promotes before
		// compacting; without this, the pre-prompt path would pre-empt promotion and
		// compact (summary) a session that should have just been promoted.
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

	/**
	 * Compact continuing tool-loop runs before the next provider request.
	 *
	 * `onTurnEnd` is the safe boundary: tool results for the just-finished turn
	 * are already paired in `activeMessages`, the live array the agent loop reads
	 * before its next model call. Before compacting, the just-finished turn is
	 * synchronously persisted if async message hooks have not reached the normal
	 * append path yet.
	 */
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

		const lastAssistant = [...activeMessages]
			.reverse()
			.find((message): message is AssistantMessage => message.role === "assistant");
		if (!lastAssistant || lastAssistant.stopReason === "aborted" || lastAssistant.stopReason === "error") return;

		if (!(await this.#persistTurnMessagesForMidRunCompaction(context))) return;

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
	 *    run compaction and retry.
	 * 4. Threshold: context over threshold, run context maintenance (no auto-retry).
	 *
	 * @param assistantMessage The assistant message to check
	 * @param skipAbortedCheck If false, include aborted messages (for pre-prompt check). Default: true
	 * @param autoContinue Whether maintenance may schedule the agent-authored continuation prompt.
	 * @returns whether compaction or recovery scheduled a retry, auto-continue, or
	 *   queued-message drain that already owns the next turn. Callers MUST skip
	 *   `session_stop` and other agent continuations when `continuationScheduled`
	 *   is true.
	 */
	async #checkCompaction(
		assistantMessage: AssistantMessage,
		skipAbortedCheck = true,
		autoContinue = true,
	): Promise<CompactionCheckResult> {
		// Skip if message was aborted (user cancelled) - unless skipAbortedCheck is false
		if (skipAbortedCheck && assistantMessage.stopReason === "aborted") return COMPACTION_CHECK_NONE;
		const contextWindow = this.model?.contextWindow ?? 0;
		const generation = this.#promptGeneration;
		// Skip overflow check if the message came from a different model.
		// This handles the case where user switched from a smaller-context model (e.g. opus)
		// to a larger-context model (e.g. codex) - the overflow error from the old model
		// shouldn't trigger compaction for the new model.
		const sameModel =
			this.model && assistantMessage.provider === this.model.provider && assistantMessage.model === this.model.id;
		// This handles the case where an error was kept after compaction (in the "kept" region).
		// The error shouldn't trigger another compaction since we already compacted.
		// Example: opus fails -> switch to codex -> compact -> switch back to opus -> opus error
		// is still in context but shouldn't trigger compaction again.
		const compactionEntry = getLatestCompactionEntry(this.sessionManager.getBranch());
		const errorIsFromBeforeCompaction =
			compactionEntry !== null && assistantMessage.timestamp < new Date(compactionEntry.timestamp).getTime();
		if (sameModel && !errorIsFromBeforeCompaction && AIError.isContextOverflow(assistantMessage, contextWindow)) {
			// Clear the failed turn from active context so the retry (or the next
			// user prompt) does not replay it. The persisted branch entry stays
			// for now: when no recovery path runs, the user-facing transcript
			// MUST keep the only assistant message explaining why the turn
			// stopped. The branch entry is dropped further down, but only on the
			// paths that actually schedule a retry/compaction.
			this.#removeAssistantMessageFromActiveContext(assistantMessage);

			// Try context promotion first - switch to a larger model and retry without compacting
			const promoted = await this.#tryContextPromotion(assistantMessage);
			if (promoted) {
				await this.#dropPersistedAssistantTurn(assistantMessage);
				// Retry on the promoted (larger) model without compacting
				this.#scheduleAgentContinue({ delayMs: 100, generation });
				return COMPACTION_CHECK_CONTINUATION;
			}

			// No promotion target available fall through to compaction
			const compactionSettings = this.settings.getGroup("compaction");
			if (!isThresholdCompactionDisabled(compactionSettings.enabled, compactionSettings.strategy as string)) {
				return await this.#runRecoveryCompactionWithRollback("overflow", assistantMessage, {
					autoContinue,
				});
			}
			// Nothing recovered the turn, and the failed message was pulled out of
			// active context above so a retry would not replay it. Put it back: it is
			// the only thing that tells the user the context is too long. Without
			// this the prompt resolves with no assistant message, no error event and
			// no branch entry, so an operator who has compaction off sees a question
			// that produced literally nothing, while every other provider failure
			// leaves its error in the transcript.
			this.#restoreFailedAssistantTurnToActiveContext(assistantMessage);
			return COMPACTION_CHECK_NONE;
		}
		// A context promotion can land while the failing call is already in
		// flight (or on a run whose loop predates the switch): the overflow
		// error then arrives stamped with the pre-promotion model while
		// `this.model` is already the promoted target. The sameModel guard
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

		// Case 3: Output-side incomplete — `response.incomplete` from OpenAI Responses
		// (and Codex) maps to stopReason === "length". The model burned its
		// `max_output_tokens` budget on reasoning/text and emitted no actionable
		// deliverable. Same recovery class as overflow: promotion if available,
		// otherwise in-place compaction.
		if (sameModel && !errorIsFromBeforeCompaction && assistantMessage.stopReason === "length") {
			// Same active-context vs persisted-history split as the overflow path
			// above: clear the dead turn from agent state so it cannot be replayed,
			// but keep it on the branch unless promotion or compaction actually runs.
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
			// Same dead end as the overflow path: the comment below is only true if
			// the truncated turn is actually still in context, and the cleanup above
			// took it out. A log line is not a diagnosis a user can read.
			this.#restoreFailedAssistantTurnToActiveContext(assistantMessage);
			logger.warn("response.incomplete with no recovery path (promotion + compaction both unavailable)", {
				model: `${assistantMessage.provider}/${assistantMessage.model}`,
			});
			return COMPACTION_CHECK_NONE;
		}

		// Stale-result pass runs every turn, before any threshold gating: it is
		// cheap (bails when no candidate) and independent of the compaction
		// setting.
		const supersedeResult = await this.#pruneStaleToolResults();

		const compactionSettings = this.settings.getGroup("compaction");
		if (isThresholdCompactionDisabled(compactionSettings.enabled, compactionSettings.strategy as string))
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
		// let a long-running `/goal` session sit above `compaction.threshold`
		// indefinitely whenever per-turn pruning saved enough to drop the
		// post-prune estimate below the user-configured trigger: the visible
		// context (anchored to the same provider billing) still showed >threshold,
		// but `shouldCompact` no-op'd (#3174). Anchor the initial trigger on the
		// last turn's billed context tokens, floored by the post-prune
		// stored-conversation estimate so a payload-compression hook still cannot
		// deflate the trigger.
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
			// Try promotion first — if a larger model is available, switch instead of compacting
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

	/**
	 * Report anything surprising about the resolved compaction threshold, once per
	 * distinct context window (so a switch to a smaller-window model re-warns).
	 *
	 * Three surprises are worth an operator's attention, and all three used to be
	 * invisible: an absolute amount capped for this model's window, a value still
	 * coming from one of the two retired keys rather than `compaction.threshold`,
	 * and a value that parsed as nothing and therefore fell back to auto.
	 */
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
			// Informational, not a warning: the amount is a legal model-independent
			// choice, and this model simply cannot reach it. Telling the operator to
			// "lower the amount" would be advice against a setting that is doing
			// exactly what its picker promises on every larger model.
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
		const lastToolCall = assistantMessage.content
			.slice()
			.reverse()
			.find((content): content is ToolCall => content.type === "toolCall");
		return lastToolCall?.name === TOOL.yield && lastToolCall.id === toolCallId;
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
		for (const entry of this.sessionManager.getBranch().slice().reverse()) {
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
				entry = branch
					.slice()
					.reverse()
					.find(
						candidate =>
							candidate.type === "message" &&
							candidate.message.role === "assistant" &&
							sessionMessagePersistenceKey(candidate.message) === pending.persistenceKey,
					);
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
				// Name the model in the operator-facing line: an empty completion is
				// a property of the model behind the turn, and switching models is
				// the recovery the user has to reach for.
				finalError: `${failure} (${assistantMessage.provider}/${assistantMessage.model})`,
			});
			this.#clearPendingRecoveredRetryErrors();
			this.#retryAttempt = 0;
			this.#resolveRetry();
			// The cycle is over, so the budget belongs to the next turn. Leaving the
			// count above the cap made the next turn that does NOT run the
			// per-prompt reset — an agent-initiated maintenance nudge, an IRC wake,
			// a queued follow-up — cap on its first empty stop with zero retries and
			// report an attempt count for requests it never made.
			this.#emptyStopRetryCount = 0;
			// Nothing this turn produced is worth keeping. An empty assistant turn
			// replays on reload and re-sends the very context that produced it (the
			// reasoning isEmptyErrorTurn already records for provider-rejection
			// turns); a toolUse stop with no tool_use block additionally corrupts
			// Anthropic history, where a later tool_result has nothing to anchor to.
			// The reminders describe a turn that has just been discarded, so they
			// are false by the time any later turn reads them.
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
				// Reasoning/thinking-only turns are not actionable: they do not
				// answer the user and do not give the agent loop a tool call to run.
				for (const content of assistantMessage.content) {
					if (content.type === "toolCall") return false;
					if (content.type === "text" && hasNonWhitespace(content.text)) return false;
				}
				return true;
			case "toolUse":
				// An orphaned toolUse stop (no tool_use block) corrupts Anthropic history:
				// a later tool_result has nothing to anchor to. Thinking alone cannot anchor
				// a tool_result, so it does not rescue a toolUse stop here.
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

	/**
	 * Drop the current cycle's turn-retry reminders from active context. Filters
	 * by object identity rather than by text: the reminder body is rendered from
	 * a prompt file, and matching on those bytes would also delete an unrelated
	 * developer message that happened to quote them.
	 */
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
		// Checked BEFORE the classifier, not after. A reply that hands the turn
		// back to the user is the shape the classifier most readily reads as a
		// turn that announced an action and stopped short of it, so asking it
		// spends a model call to be told the opposite of what the reply says. The
		// budget resets rather than carrying over: the cycle is finished, the user
		// is in the loop, and the next turn starts with its full runway.
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
			// Same reasoning as the empty-stop cap: the nudges tell the model to
			// finish a turn this cycle has just stopped trying to finish, so they are
			// false for every turn that reads them after this point.
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
		const lastMessage = messages[messages.length - 1];
		const lastAssistant: AssistantMessage | undefined = lastMessage?.role === "assistant" ? lastMessage : undefined;
		if (lastAssistant !== undefined && this.#isSameAssistantMessage(lastAssistant, assistantMessage)) {
			this.agent.replaceMessages(messages.slice(0, -1));
			return;
		}
		// A miss means the failed turn is still in active context (or was never
		// there); log just enough to explain why the identity check failed.
		logger.debug("agent active context assistant removal missed", {
			reason,
			lastRole: lastMessage?.role,
			candidateTimestamp: assistantMessage.timestamp,
			lastTimestamp: lastAssistant?.timestamp,
			candidateStopReason: assistantMessage.stopReason,
			lastStopReason: lastAssistant?.stopReason,
		});
	}

	/**
	 * Drop a recoverable assistant turn from the persisted session branch once a
	 * recovery path (context promotion or compaction) is committed. Waits for the
	 * in-flight `message_end` persistence slot first so the branch entry exists
	 * before we reparent past it. Active context removal is the caller's
	 * responsibility — recovery paths clear it eagerly so the retry never
	 * replays the failed turn, while no-recovery paths leave the persisted entry
	 * (and the user-visible transcript line) in place.
	 */
	async #dropPersistedAssistantTurn(assistantMessage: AssistantMessage): Promise<void> {
		await this.#waitForSessionMessagePersistence(assistantMessage);
		this.#discardAssistantTurn(assistantMessage);
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

	/**
	 * Restore a failed assistant turn after a recovery attempt that dropped the
	 * persisted entry and then committed nothing.
	 */
	#restoreFailedAssistantTurn(assistantMessage: AssistantMessage): void {
		if (!isEmptyErrorTurn(assistantMessage)) this.sessionManager.appendMessage(assistantMessage);
		this.#restoreFailedAssistantTurnToActiveContext(assistantMessage);
	}

	/**
	 * Put a failed assistant turn back into ACTIVE context only.
	 *
	 * The dead-end paths (no promotion target and compaction unavailable) pull the
	 * failed turn out of context eagerly so a retry cannot replay it, and then
	 * never schedule one. Only the branch is left alone there, so re-appending to
	 * the session would duplicate an entry that was never dropped; the active
	 * context is the half that has to be put back, because it is what the user
	 * reads.
	 */
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
		const branchEntry = branch
			.slice()
			.reverse()
			.find(
				entry =>
					entry.type === "message" &&
					entry.message.role === "assistant" &&
					this.#isSameAssistantMessage(entry.message, assistantMessage),
			);
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

	/**
	 * Drop an assistant turn from BOTH the live agent context and the persisted
	 * session branch (reparenting the leaf to the turn's parent), so a discarded
	 * turn does not resurface on reload. Used for empty/reasoning-only stops and
	 * the Gemini header-runaway interrupt, which must not replay a partial,
	 * loop-fueling thinking block.
	 */
	#discardAssistantTurn(assistantMessage: AssistantMessage): void {
		this.#removeAssistantMessageFromActiveContext(assistantMessage);

		const branchEntry = this.sessionManager
			.getBranch()
			.slice()
			.reverse()
			.find(
				entry =>
					entry.type === "message" &&
					entry.message.role === "assistant" &&
					this.#isSameAssistantMessage(entry.message as AssistantMessage, assistantMessage),
			);
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
			// If the continuation never runs (new prompt, dispose, compaction,
			// handoff), the forced choice must not leak onto an unrelated turn.
			onSkip: () => this.#toolChoiceQueue.removeByLabel("plan-mode-decision"),
		});
		return true;
	}

	/**
	 * Render context shared by the eager todo/task preludes. `toolRefs` resolves each
	 * tool's wire name (matching `buildSystemPrompt`'s `toolRefs`) so the reminder names
	 * the tool the model actually sees when an extension renames it; `taskBatch` gates
	 * batch-call guidance that would steer toward a failing call shape when `task.batch`
	 * is off (the flat single-spawn schema rejects `tasks`/`context`).
	 */
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

		// Only inject on the first user message of the conversation. Subsequent user
		// turns must not receive the eager todo reminder — they often correct, clarify,
		// or redirect the prior task, and forcing a brand-new todo list there is wrong.
		// When `promptText` is undefined (post-compaction re-injection) there is no fresh
		// user message to gate on, so skip the first-message and prompt-suffix checks.
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

		// Must check the active tool set, not just the registry: tool discovery
		// (tools.discoveryMode === "all") can register `todo` while hiding it from
		// the exposed tools. Forcing a named tool_choice for an inactive tool makes
		// the provider reject the request (HTTP 400).
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
		// `preferred` suggests a todo list (reminder only); `always` also forces the
		// `todo` tool on the first turn — the previous boolean-on behavior. Post-compaction
		// re-injection (`promptText === undefined`) is always reminder-only: forcing a tool
		// onto the auto-resumed turn would override the agent's in-flight action.
		if (promptText === undefined || mode === "preferred") {
			return { message };
		}
		const todoToolChoice = buildNamedToolChoice(TOOL.todo, this.model);
		if (!todoToolChoice) {
			// `always` on a model that can't be forced degrades to reminder-only (no
			// tool_choice). For `todo.eager: true` users migrated to `always`, such
			// models now receive the first-turn reminder where they previously got
			// nothing (see the CHANGELOG entry); `always ⊇ preferred` is preserved.
			logger.warn(
				"Eager todo proceeding with the reminder only because the current model does not support a forced todo tool_choice",
				{ modelApi: this.model?.api, modelId: this.model?.id },
			);
			return { message };
		}
		return { message, toolChoice: todoToolChoice };
	}

	#createEagerTaskPrelude(promptText: string | undefined): AgentMessage | undefined {
		// Resolved against the agents the live task tool will actually accept: a
		// reminder to delegate, in a session where every agent is disabled, is an
		// instruction the model can only fail to follow.
		if (!resolveDelegation(this.settings, enabledSubagentNames(this.#toolRegistry.get(TOOL.task))).required) {
			return undefined;
		}
		// Main agent only: subagents keep `task` active (the parent only filters `todo`),
		// so a salient delegate-reminder there would amplify nested fan-out. Gate on the
		// resolved agent kind, not the id, so a top-level session with a custom `agentId`
		// still gets the reminder.
		if (this.#agentKind === "sub") return undefined;
		if (this.#planModeState?.enabled) return undefined;
		// First-message-only gates are skipped post-compaction (`promptText === undefined`),
		// where there is no fresh user message to suppress the reminder for.
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

	/**
	 * Build the eager task/todo reminders to re-inject on the auto-continuation turn that
	 * follows a compaction. The first-message preludes are the oldest messages, so
	 * compaction summarizes them away and the agent silently loses the delegate-via-tasks
	 * and phased-todo guidance mid-work; this re-asserts them, reminder-only (the todo
	 * builder drops its forced tool_choice when `promptText` is undefined). Each builder
	 * still applies its own mode / agent-kind / plan-mode / tool-active / surviving-todo
	 * gates, so an empty array means nothing currently warrants a nudge.
	 */
	#buildPostCompactionEagerNudges(): AgentMessage[] {
		const nudges: AgentMessage[] = [];
		const todo = this.#createEagerTodoPrelude(undefined);
		if (todo) nudges.push(todo.message);
		const task = this.#createEagerTaskPrelude(undefined);
		if (task) nudges.push(task);
		return nudges;
	}
	/**
	 * Check if agent stopped with incomplete todos and prompt to continue.
	 *
	 * `settleState` carries the tail's single reading of "waiting on the user".
	 * This runs even when that hold is set, because the first statement consumes
	 * the served tool-choice label and skipping the call would leak it onto the
	 * next turn.
	 */
	async #checkTodoCompletion(settleState: SettleContinuationState): Promise<boolean> {
		// Skip todo reminders when the most recent turn was driven by an explicit user force —
		// the user wanted exactly that tool, not a follow-up nag about incomplete todos.
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

		// Plan mode owns convergence via #enforcePlanModeDecisionAtSettle (remind →
		// cap → yield). Todo reminders must not re-wake a turn the cap intends to
		// yield to the user. The label is already consumed above, so no leak.
		if (this.#planModeState?.enabled) {
			return false;
		}

		// Goal mode is the sole autonomous continuation owner while active. A
		// stop-time todo reminder would append a second continuation prompt and
		// race the goal continuation scheduled by the interactive mode.
		if (this.#goalModeState?.enabled === true && this.#goalModeState.goal.status === "active") {
			return false;
		}

		// Suppress within a self-continuation chain: if the agent's last turn was driven by a
		// prior reminder (and the agent took no tool-level action since), do not re-ping.
		// The agent has already acknowledged; further escalation just wastes context and
		// pressures the agent into busy-work or destructive ops (issue #2590).
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

		// The board is only as trustworthy as the last write that landed. After a
		// failed `todo` call the recorded phases are whatever survived from before
		// it, so "you stopped with N incomplete todo item(s)" would assert a count
		// the session never recorded. The todo-error reminder already told the
		// model the board may be stale; say nothing further.
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

		// Background async jobs (bash/task) owned by this agent re-wake the loop
		// when they complete: the result delivery enqueues an async-result
		// follow-up that continues the run, and todos are re-evaluated at that
		// settle. A stop with such a job in flight is a scheduling pause, not
		// abandonment, so stay silent instead of injecting duplicate context.
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
		// One full-list echo per context window. The list is worth repeating once
		// after a compaction boundary, because the model may no longer see it;
		// repeating it on every escalation inside one window is pure duplication.
		//
		// Read off the ACTIVE BRANCH, not every persisted entry: a rewind leaves
		// the abandoned path's compaction entry in the file while the model's
		// context is rebuilt without it. Keying on the file would hold the latch
		// at an id that is no longer in the window, and the echo would never come
		// back for the rest of the session.
		const compactionBoundary = getLatestCompactionEntry(this.sessionManager.getBranch())?.id ?? null;
		const echoFullList = this.#todoReminderEchoCompactionId !== compactionBoundary;
		const reminder = renderTodoContinuationReminder({
			items: incomplete,
			attempt: this.#todoReminderCount,
			maxAttempts: remindersMax,
			echoFullList,
		});
		// Spent only when a list actually goes out, so a suppressed reminder
		// leaves the allowance intact.
		if (echoFullList) this.#todoReminderEchoCompactionId = compactionBoundary;
		// Reserve before awaiting event subscribers so overlapping agent_end events
		// cannot both emit the same reminder.
		this.#lastTodoReminderFingerprint = fingerprint;
		this.#todoReminderAwaitingProgress = true;

		logger.debug("Todo completion: sending reminder", {
			incomplete: incomplete.length,
			attempt: this.#todoReminderCount,
		});

		// Emit event for UI to render notification
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

		// A stop-time reminder starts a fresh reminder runway. Without resetting
		// the mid-run counter here, a run that stopped just below the threshold
		// would spend its stale pre-reminder count and fire "Mid-run reminder 2/3"
		// after only a little post-reminder work.
		this.#mutationsSinceLastTodoTouch = 0;
		// Inject reminder and persist it so the JSONL transcript matches model context.
		this.agent.appendMessage(reminderMessage);
		this.sessionManager.appendMessage(reminderMessage);
		this.#scheduleAgentContinue({ generation: this.#promptGeneration });
		return true;
	}

	/**
	 * Build the next mid-run todo reconciliation nudge when the agent has landed
	 * {@link MID_RUN_TODO_NUDGE_MUTATION_THRESHOLD} mutating tool results without
	 * invoking the `todo` tool and incomplete items remain. Returns the hidden
	 * (`display: false`) custom message when it should fire, or `null` to skip.
	 * Called once per turn via the aside provider; mutates internal counters when
	 * it fires so the caller does not need to track delivery state.
	 *
	 * Deliberately a SEPARATE concept from {@link #checkTodoCompletion}'s
	 * stop-time reminder: this is a gentle model-only hint (no `todo_reminder`
	 * event, no TUI render, no escalation counter, own per-cycle budget), while
	 * the stop-time reminder is the user-visible escalation ladder. Without this
	 * nudge, long runs drive the live HUD to `0/N` until the final stop, then
	 * batch-flip to `N/N` (issue #3651).
	 */
	#takeMidRunTodoNudge(): AgentMessage | null {
		if (this.#mutationsSinceLastTodoTouch < MID_RUN_TODO_NUDGE_MUTATION_THRESHOLD) return null;
		if (this.#midRunNudgeCount >= MID_RUN_TODO_NUDGE_MAX_PER_CYCLE) return null;
		if (!this.settings.get("todo.enabled")) return null;
		if (!this.settings.get("todo.reminders")) return null;
		// Plan-mode runs are authoring a plan file, not implementing it; todos
		// don't apply, mirroring {@link #createEagerTodoPrelude}.
		if (this.#planModeState?.enabled) return null;
		// Tool discovery / explicit active-tool lists can hide `todo` from this
		// run while `todo.enabled` remains true (e.g. `setActiveToolsByName`
		// restricting the slate). Mirror {@link #createEagerTodoPrelude}'s
		// guard so we never ask the model to call a tool that is not in its
		// schema — the request would fabricate an unknown tool call.
		if (!this.getActiveToolNames().includes(TOOL.todo)) return null;
		// A failed `todo` write leaves the recorded board unverified, so counting
		// "incomplete items" off it would nudge about work the session cannot
		// confirm is outstanding. Same honesty rule as the stop-time reminder.
		if (this.#lastTodoFailureText !== undefined) return null;

		const incomplete = this.getTodoPhases()
			.flatMap(phase => phase.tasks)
			.filter(task => task.status === "pending" || task.status === "in_progress");
		if (incomplete.length === 0) return null;

		// Reset the mutation counter so the nudge has another full runway before
		// the next fire; #midRunNudgeCount caps total nudges per prompt cycle.
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

	/**
	 * Attempt context promotion to a larger model.
	 * Returns true if promotion succeeded (caller should retry without compacting).
	 */
	async #tryContextPromotion(assistantMessage: AssistantMessage): Promise<boolean> {
		const currentModel = this.model;
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
				error: String(error),
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

		// Re-evaluate append-only context mode — provider or setting may have changed
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

	/**
	 * Re-evaluate append-only context mode, creating or destroying the
	 * manager as needed. Called on model switch AND setting change.
	 */
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
			// Already active — invalidate prefix + log so the next turn
			// rebuilds for the current model's normalization.
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

		// `openai-completions` sessions are keyed `openai-completions:<provider>:<resolvedBaseUrl>:<modelId>`
		// and cache backend-specific decisions (strict-tools disable scopes, reasoning-effort
		// fallbacks). The resolved request base URL can differ from the catalog `model.baseUrl`
		// (Moonshot env override, Alibaba Coding Plan enterprise URL, Azure deployment URL),
		// so evict by provider prefix when the user moves away from that completions backend.
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
					error: String(error),
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
						error: String(error),
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

		// `configured-only` stops at the chain the user wrote down. With no chain
		// configured, `compaction.model` means "inherit", so the one model they
		// chose is the main model and that is where the list ends.
		const fallbackStrategy = this.settings.get("compaction.modelFallbackStrategy");
		if (fallbackStrategy === "configured-only") {
			if (configuredPatterns.length === 0) addCandidate(preferredModel ?? undefined);
			return candidates;
		}

		if (preferredModel) {
			// The compaction sibling this model's own catalog row recommends. Nobody
			// named it, so `auto` takes it only while it stays inside the provider
			// the operator DID name; a cross-provider recommendation spends someone
			// else's credit and belongs to `any-model`.
			const recommended = this.#resolveCompactionConfiguredTarget(preferredModel, availableModels);
			if (recommended && (fallbackStrategy === "any-model" || recommended.provider === preferredModel.provider)) {
				addCandidate(recommended);
			}
		}
		addCandidate(preferredModel ?? undefined);
		for (const role of SELECTABLE_MODEL_ROLE_IDS) {
			addCandidate(this.#resolveRoleModelFull(role, availableModels, preferredModel ?? undefined).model);
		}

		// The widest window among everything authenticated is the only tier that
		// can reach a provider the operator never chose for this session, and
		// compaction fires unattended: under `auto` that tier is an accidental
		// bill on an unrelated account (a Cursor session summarized on a Hugging
		// Face key and surfaced its 402 as a compaction failure). `any-model` is
		// the opt-in that keeps the historical never-fails behavior.
		if (fallbackStrategy === "any-model") {
			const sortedByContext = [...availableModels].sort((a, b) => (b.contextWindow ?? 0) - (a.contextWindow ?? 0));
			for (const model of sortedByContext) {
				if (!seen.has(this.#getModelKey(model))) {
					addCandidate(model);
					break;
				}
			}
		}

		return candidates;
	}

	/**
	 * Map each configured `compaction.model` candidate to the explicit thinking
	 * effort its selector carries (the `:level` suffix picked in settings). Only
	 * patterns that name an explicit level land here; role/main/largest-context
	 * fallbacks are absent and fall back to the session effort at run time. `auto`
	 * is treated as "no explicit level" so compact() applies its own default. The
	 * resolution mirrors {@link #resolveCompactionModelCandidates} so a candidate
	 * and its configured effort always agree.
	 */
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
	#compactionCandidateError(candidate: Model, error: unknown): Error {
		return new Error(`${this.#getModelKey(candidate)}: ${errorMessage(error)}`, { cause: error });
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
		if (!first || this.#getModelKey(first) === this.#getModelKey(used)) return;
		const reason = skipReasons.get(this.#getModelKey(first)) ?? "it could not run the summary";
		const message = `Compacted with ${used.provider}/${used.id}. ${first.provider}/${first.id} was skipped: ${reason}.`;
		if (this.#announcedCompactionFallbacks.has(message)) return;
		this.#announcedCompactionFallbacks.add(message);
		this.emitNotice("warning", message, "compaction");
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
		if (this.settings.get("compaction.remote") !== true) return undefined;
		const model = this.model;
		if (!model || !resolveServerCompactionTransport(model)) return undefined;
		const apiKey = await this.#modelRegistry.getApiKey(model, this.sessionId);
		if (!apiKey) {
			// The loader announced a remote pass from the sync half of this gate;
			// a missing credential must not downgrade to a local pass silently.
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
				this.emitNotice(
					"warning",
					`Server-side compaction failed (${message}); falling back to local compaction.`,
					"compaction",
				);
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
		// Per-candidate effort configured on `compaction.model` (its `:level`
		// suffix). A candidate without an explicit level uses the session effort.
		const configuredEffortByModel = this.#resolveConfiguredCompactionEfforts(this.#modelRegistry.getAvailable());

		// Effective window of the model RUNNING the compaction. The payload was
		// sized against the MAIN model's threshold, so a compaction model with a
		// smaller window would overflow mid-compact; skip those candidates loudly
		// instead. compaction.modelContextWindow (unset = candidate's own metadata)
		// overrides for proxies that serve a different window than advertised.
		const configuredCompactionWindow = this.settings.get("compaction.modelContextWindow");
		let summarizePayloadTokens = 0;
		let skippedForWindow = 0;
		// Why each earlier candidate was passed over, so landing further down the
		// chain can be reported with the reason rather than as a silent swap.
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
						// Effort configured on this compaction candidate wins; otherwise
						// honor the user's /model thinking selection (incl. `off`).
						// Clamped per-model inside compact() via resolveCompactionEffort
						// so unsupported-effort models (xai-oauth/grok-4.20-0309-reasoning) do not trip
						// requireSupportedEffort.
						thinkingLevel: configuredEffortByModel.get(this.#getModelKey(candidate)) ?? this.thinkingLevel,
						tools: cachePrefix?.tools ?? this.agent.state.tools,
						sessionId: this.sessionId,
						// Providers route on `promptCacheKey ?? sessionId`, and the live
						// loop sends the agent's pinned key when it has one (fork, tan,
						// shared session). Mirror it so the summarization request reads
						// the prefix the turns populated instead of cold-missing it.
						promptCacheKey: this.agent.promptCacheKey ?? this.sessionId,
						providerSessionState: this.#providerSessionState,
						// Resolve the current runtime inside the callback. compact()
						// invokes it after each credential await and immediately
						// before every local or remote physical attempt.
						obfuscateProviderText: text => this.obfuscateProviderText(text),
						// Route every summarization HTTP request through the
						// session's side-stream transport so the provider
						// concurrency cap (e.g. providers.ollama-cloud.maxConcurrency)
						// brackets compaction the same way it brackets the live
						// agent turn — without this, multiple ollama-cloud
						// subagents auto/manually compacting issued uncapped
						// summary requests in parallel (chatgpt-codex review on
						// #3751).
						completeImpl: this.#sideCompleteImpl,
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

		if (!hookCompaction && this.#extensionRunner?.hasHandlers("session.compacting")) {
			const compactMessages = preparation.messagesToSummarize.concat(preparation.turnPrefixMessages);
			const result = (await this.#extensionRunner.emit({
				type: "session.compacting",
				sessionId: this.sessionId,
				messages: compactMessages,
			})) as { context?: string[]; prompt?: string; preserveData?: Record<string, unknown> } | undefined;

			// The hook may have awaited arbitrary extension work. Sanitize its
			// raw text as soon as control returns, before any later formatting.
			hookContext = result?.context?.map(context => this.#obfuscateTextForProvider(context) ?? context);
			hookPrompt = this.#obfuscateTextForProvider(result?.prompt);
			preserveData = result?.preserveData;
		}

		const memoryBackendContext = await this.#collectMemoryBackendContext(preparation);
		if (memoryBackendContext) {
			// Memory backends are async and can race a secret-runtime refresh.
			// Resolve the authoritative runtime only after their await completes.
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

	/**
	 * Post-maintenance progress check for the context-full tail.
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
		const contextWindow = this.model?.contextWindow ?? 0;
		if (contextWindow <= 0) return true;
		const compactionSettings = this.settings.getGroup("compaction");
		const residualTokens = compactionContextTokens(
			this.getContextUsage({ contextWindow })?.tokens ?? 0,
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
	 * Does the live context still trip threshold compaction? Measured with the
	 * same convention as {@link #compactionCreatedHeadroom} (usage minus stored
	 * snapshot, against the active window) and the exact `shouldCompact`
	 * predicate the caller used to trigger this run. Used by the Tier-0 lossless
	 * dedup pass to decide whether an LLM/snap compaction is still warranted
	 * after redundant tool-results were elided. When the window is unknown we
	 * cannot evaluate the bar, so we assume it still trips and let compaction
	 * proceed (never suppress a compaction we cannot prove is unnecessary).
	 */
	#thresholdStillTrips(compactionSettings: Parameters<typeof shouldCompact>[2]): boolean {
		const contextWindow = this.model?.contextWindow ?? 0;
		if (contextWindow <= 0) return true;
		const residualTokens = compactionContextTokens(
			this.getContextUsage({ contextWindow })?.tokens ?? 0,
			this.#estimateStoredContextTokens(),
		);
		return shouldCompact(residualTokens, contextWindow, compactionSettings);
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
	 * invoke this AFTER dropping the failed assistant from `this.messages`, so
	 * the just-failed turn (which the retry prompt will not include) is excluded
	 * from the estimate.
	 *
	 * When the model/window is unknown we cannot evaluate the budget, so we
	 * optimistically allow the retry (preserving prior behavior).
	 */
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
				const result = await this.shake("elide", { signal });
				elided = result.toolResultsDropped + result.blocksDropped;
				elidedTokens = result.tokensFreed;
				if (result.artifactId) elideSink = "an artifact";
				if (elided > 0) {
					// The elide pass rewrote history; re-anchor the in-flight snapshot
					// so the caller's headroom/retry-fit re-test measures the shaken
					// context.
					this.#rebasePendingContextSnapshotAfterCompaction();
				}
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
			if (imagesDropped > 0) this.#rebasePendingContextSnapshotAfterCompaction();
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
			artifactId = await this.sessionManager.saveArtifact(renderTailElisionArtifact(elisions), "compaction-tail");
		} catch {
			artifactId = undefined;
		}
		if (artifactId) {
			const branch = this.sessionManager.getBranch();
			for (const elision of elisions) {
				// A NEW message object, never an in-place content patch:
				// estimateTokens caches by message identity, so mutating the
				// marker would leave every later estimate at the pre-pointer
				// size (same replace-not-mutate rule the elision producer
				// follows).
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
		rollbackTailElisions(this.sessionManager.getBranch(), elisions);
	}

	/** Notice fragment for a dead-end elide tier: what was freed and where it went. */
	#describeElideRescue(elided: number, tokensFreed: number, sink: string): string {
		return `elided ${formatCount("heavy block", elided)} (~${tokensFreed.toLocaleString()} tokens) to ${sink}`;
	}

	/**
	 * Internal: run automatic in-place compaction with lifecycle events.
	 *
	 * @returns whether auto-compaction scheduled a follow-up turn.
	 */
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
			const deduped = await this.dedupeRedundantToolResults();
			if (deduped.toolResultsDropped > 0) {
				if (this.#promptGeneration !== generation) return COMPACTION_CHECK_NONE;
				this.#rebasePendingContextSnapshotAfterCompaction();
				if (reason === "threshold" && !this.#thresholdStillTrips(compactionSettings)) {
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
				// Per-candidate effort configured on `compaction.model` (its `:level`
				// suffix). A candidate without an explicit level uses the session effort.
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

				// Server-side compaction first: when the session model supports it
				// and the setting is on, the provider compacts and the candidate
				// loop below is skipped entirely for this pass.
				compactResult = await this.#tryServerSideCompaction(preparation, undefined, autoCompactionSignal, {
					promptOverride: this.#obfuscateTextForProvider(compactionPrep.hookPrompt),
					extraContext: compactionPrep.hookContext,
					remoteInstructions: this.#baseSystemPrompt.join("\n\n"),
					initiatorOverride: "agent",
					codexCompaction,
				});

				// The payload was sized against the MAIN model's threshold, so a
				// candidate whose window cannot hold it overflows mid-compact. The
				// manual path has always skipped those candidates loudly (see
				// #compactWithFallbackModel); this one did not, and it is the path that
				// fires unattended on every threshold crossing and every overflow
				// recovery. Sending a request the window provably cannot hold buys a
				// guaranteed failure, and then the next candidate pays for the same span
				// again. `compaction.modelContextWindow` (unset = the candidate's own
				// metadata) overrides for proxies serving a window they do not advertise.
				const configuredCompactionWindow = this.settings.get("compaction.modelContextWindow");
				// Why each candidate before the one that ran was passed over, so the
				// unattended path can name the swap the way the manual path does.
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
						// Effort configured on this compaction candidate wins;
						// otherwise honor the user's /model thinking selection.
						// The most-fired compaction site. Clamped per-model
						// inside compact() via resolveCompactionEffort.
						thinkingLevel: configuredEffortByModel.get(this.#getModelKey(candidate)) ?? this.thinkingLevel,
						sessionSystemPrompt: cachePrefix?.sessionSystemPrompt,
						sessionMessages: cachePrefix?.sessionMessages,
						tools: cachePrefix?.tools ?? this.agent.state.tools,
						sessionId: this.sessionId,
						// Same routing rule as the manual-compaction call site above:
						// mirror the pinned key the live turns cached under.
						promptCacheKey: this.agent.promptCacheKey ?? this.sessionId,
						providerSessionState: this.#providerSessionState,
						obfuscateProviderText: text => this.obfuscateProviderText(text),
						codexCompaction,
						completeImpl: this.#sideCompleteImpl,
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
						// Keep a real reason for the failure event when every candidate is
						// skipped this way. A thrown provider error from a later candidate
						// still overwrites it (the catch assigns unconditionally).
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

							// If retry delay is too long (>30s), try next candidate instead of waiting
							const maxAcceptableDelayMs = 30_000;
							if (delayMs > maxAcceptableDelayMs && hasMoreCandidates) {
								logger.warn("Auto-compaction retry delay too long, trying next model", {
									delayMs,
									retryAfterMs,
									error: message,
									model: `${candidate.provider}/${candidate.id}`,
								});
								lastError = this.#compactionCandidateError(candidate, error);
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
			this.#rebasePendingContextSnapshotAfterCompaction();
			// Compaction discarded the conversation history that carried the approved
			// plan reference. Clear the sent-flag so #buildPlanReferenceMessage re-reads
			// the plan from disk and re-injects it on the next turn (issue #1246).
			this.#planReferenceSent = false;
			this.#resetAllAdvisorRuntimes();
			this.#syncTodoPhasesFromBranch();
			if (codexCompaction) {
				this.#resetCodexProviderAfterCompaction(codexCompaction);
			} else {
				this.#closeCodexProviderSessionsForHistoryRewrite();
			}

			// Get the saved compaction entry for the hook
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
			// Post-maintenance progress guard — evaluated BEFORE emitting
			// auto_compaction_end so the TUI rebuild triggered by that event
			// already reflects any rescue rewrite (elide / image-drop) and the
			// dead-end warning stamped on the compaction entry. The summary
			// strategy can project over budget and fall back to a context-full summary; the
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
				const messages = this.agent.state.messages;
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
						this.agent.replaceMessages(messages.slice(0, -1));
						this.#rebasePendingContextSnapshotAfterCompaction();
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
						skipElide: false,
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
				// compaction thrash, so require genuine headroom, not a bare fit. Even
				// when auto-continue is disabled, a no-headroom threshold pass must still
				// block later automatic continuations (todo reminders/session_stop hooks)
				// from re-entering the same oversized context.
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
				// Stamp the divider: the compaction bar badges the dead-end and
				// carries the full warning in its ctrl+o detail, so the pause
				// stays explained even after the notice row scrolls away.
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
				// Auto-compaction can complete while follow-up/steering/custom messages are waiting.
				// Kick the loop so queued messages are actually delivered. This remains separate
				// from the no-progress warning: pausing maintenance must not strand user input.
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
			const errorMessage = error instanceof Error ? error.message : "compaction failed";
			await this.#emitSessionEvent({
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
	 * Toggle auto-compaction setting.
	 */
	setAutoCompactionEnabled(enabled: boolean): void {
		this.settings.set("compaction.enabled", enabled);
		if (enabled && isCompactionStrategyOff(this.settings.get("compaction.strategy") as string)) {
			this.settings.override("compaction.strategy", getDefault("compaction.strategy"));
		}
	}

	/** Whether auto-compaction is enabled */
	get autoCompactionEnabled(): boolean {
		const compaction = this.settings.getGroup("compaction");
		return !isThresholdCompactionDisabled(compaction.enabled, compaction.strategy);
	}

	// =========================================================================
	// Auto-Retry
	// =========================================================================

	/**
	 * Classify retry decisions against the active session model. Test stream
	 * shims and provider adapters can emit generic assistant metadata, but retry
	 * policy belongs to the model that was actually requested for this turn.
	 */
	#classifyRetryMessage(message: AssistantMessage): number {
		const activeModel = this.model;
		if (!activeModel || message.api === activeModel.api) {
			return AIError.classifyMessage(message);
		}

		const id = AIError.classifyMessage({
			api: activeModel.api,
			errorId: message.errorId,
			errorMessage: message.errorMessage,
			errorStatus: message.errorStatus,
		});
		message.errorId = id;
		return id;
	}

	#isGenericAbortSentinel(message: AssistantMessage): boolean {
		return message.errorMessage === "Request was aborted" || message.errorMessage === "Request was aborted.";
	}

	/**
	 * Retry an empty, reason-less provider abort: a turn with no content that
	 * carries the generic sentinel (bare `abort()`), whether the provider
	 * finalized it as `stopReason: "aborted"` or leaked it as `stopReason:
	 * "error"` (a stalled/dropped stream reported as an error rather than an
	 * abort — issue #5375). Only fires while the session is neither aborting nor
	 * tearing down. A user/lifecycle abort (`#abortInProgress`), a dispose-driven
	 * abort (`#isDisposed`), or a session-induced streaming-edit guard abort
	 * (`#streamingEditAbortTriggered` — auto-generated-file guard or failed-patch
	 * preview) is deliberate and MUST settle the turn instead: routing it through
	 * retry would orphan `#retryPromise` on a continuation the guard skips
	 * (hanging the in-flight `prompt()`) or silently undo the guard's intended
	 * abort. Deliberate user interrupts (`UserInterrupt`) and silent aborts carry
	 * their own marker, not the generic sentinel, so they never match here.
	 */
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

	/**
	 * Check if an error is retryable (transient errors or usage limits).
	 * Context overflow is NOT retryable (handled by compaction instead).
	 * Usage-limit errors are retryable because the retry handler performs credential switching.
	 */
	#isRetryableError(message: AssistantMessage): boolean {
		if (message.stopReason !== "error") return false;

		const id = this.#classifyRetryMessage(message);
		// Context overflow is handled by compaction, not retry
		const contextWindow = this.model?.contextWindow ?? 0;
		if (AIError.isContextOverflow(message, contextWindow)) return false;

		if (this.#isClassifierRefusal(message)) return true;
		return AIError.retriable(id, { replayUnsafe: this.#hasReplayUnsafeToolOutput(message) });
	}
	/**
	 * Retried turns remove the failed assistant message from active context.
	 * Text/thinking-only partials are safe to discard and replay. Retained
	 * tool calls are not: a completed tool call may already have emitted its
	 * tool result after this assistant message, so replaying can duplicate work.
	 */
	#hasReplayUnsafeToolOutput(message: AssistantMessage): boolean {
		return message.content.some(block => block.type === "toolCall");
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

	/**
	 * Surface a hand-edited `tools.approvalMode` typo loudly. An unrecognized
	 * value fails closed to `ask` (see `normalizeApprovalMode`); without this
	 * warning that downgrade would be invisible, and a user who typo'd an intended
	 * safety mode could mistake the prompts for a bug. Only fires when the value is
	 * actually configured and invalid — a fresh install (no value) says nothing.
	 */
	#validateApprovalModeSetting(): void {
		if (!this.settings.isConfigured("tools.approvalMode")) return;
		const warning = validateApprovalModeSetting(this.settings.get("tools.approvalMode"));
		if (warning) {
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

	/**
	 * Map the failing model selector to the chain key that owns it, by
	 * specificity: an exact model-selector key, then a `provider/*` wildcard,
	 * then a model role whose current assignment matches, then `default`.
	 * Model-oriented keys win over roles so a chain follows the model across
	 * role reassignments.
	 */
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

		// 1. Exact model-selector keys — most specific.
		for (const key of exactModelKeys) {
			if (matchesCurrent(this.#getRetryFallbackPrimarySelector(key))) return key;
		}
		// 2. Provider wildcard (`provider/*`) — any active model of this provider.
		const wildcardKey = `${parsedCurrent.provider}/*`;
		if (Array.isArray(chains[wildcardKey])) return wildcardKey;
		// 3. Role keys — matched by the role's currently-assigned model.
		for (const key of roleKeys) {
			if (matchesCurrent(this.#getRetryFallbackPrimarySelector(key))) return key;
		}
		// 4. The default chain, when default has no explicit role primary.
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

	/**
	 * Parse one configured chain entry. A `provider/*` entry keeps the failing
	 * model's id and swaps the provider (google-antigravity/x → google/x);
	 * ids the target provider lacks are skipped by the candidate loop's
	 * registry lookup.
	 */
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
			// A wildcard key has no fixed primary: the active model is the
			// primary, followed by the configured provider-level fallbacks.
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

		// Capture the configured selector (auto-aware) so a fallback chain preserves
		// `auto` instead of collapsing it to the level it resolved to this turn.
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

	/** The active model when it is a Fireworks Fast (`-fast`) variant, else undefined. */
	#activeFireworksFastModel(): Model | undefined {
		const model = this.model;
		return model?.provider === "fireworks" && isFireworksFastModelId(model.id) ? model : undefined;
	}

	/**
	 * True when the current turn failed on a Fireworks Fast (`-fast`) model in a
	 * way that should degrade to the reliable base (Standard) model. Fast is a
	 * speed-optimized router with no SLA, so any *pre-content* failure — a
	 * transient overload/5xx or a hard "router/model not found / unsupported" —
	 * is worth retrying on the base id. Skips failures the base model shares:
	 * context overflow (compaction's job), usage limits and auth errors (same
	 * account/key), and turns that already emitted a tool call (replaying would
	 * duplicate work). Requires the base model to exist in the registry.
	 */
	#isFireworksFastFallbackEligible(message: AssistantMessage): boolean {
		const model = this.#activeFireworksFastModel();
		if (!model) return false;
		if (message.stopReason !== "error") return false;
		if (message.content.some(block => block.type === "toolCall")) return false;
		// A content refusal/sensitivity stop is the model's decision, not a route
		// failure — switching to the base model would just re-trigger it.
		if (this.#isClassifierRefusal(message)) return false;
		const id = this.#classifyRetryMessage(message);
		if (AIError.isContextOverflow(message, model.contextWindow ?? 0)) return false;
		if (AIError.is(id, AIError.Flag.UsageLimit)) return false;
		if (AIError.is(id, AIError.Flag.AuthFailed)) return false;
		return this.#modelRegistry.find("fireworks", toFireworksBaseModelId(model.id)) !== undefined;
	}

	/**
	 * True when a turn failed with a hard (non-retryable) provider error but a
	 * configured `retry.fallbackChains` entry covers the active model: the same
	 * model is not worth retrying, yet a DIFFERENT model is a fresh chance, so
	 * the chain is consulted before the error becomes final. Skips failures a
	 * model switch cannot fix or must not replay: cancellations (abort-flavored
	 * errors are not model faults), context overflow (compaction's job),
	 * classifier refusals (chain consult is handled on the retryable path with
	 * `pinFallback`), and turns that already emitted a tool call (replaying
	 * could duplicate work).
	 */
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

	/**
	 * Switch the active model from a Fireworks Fast (`-fast`) variant to its base
	 * (Standard) id and stick there for the rest of the session — the auto
	 * fallback that makes Fast a safe default. Returns false when the current
	 * model is not a fast variant, the base id is missing, or it has no key.
	 */
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
		// Restoring the primary means "the fallback is no longer needed", which is
		// only ever true between retry sequences, never inside one. The cooldown
		// that guards this is shorter than a retry budget takes to burn
		// (SERVER_ERROR suppresses for 20s; ten retries capped at
		// RETRY_BACKOFF_MAX_DELAY_MS run ~55s), so without this check the primary
		// came back mid-sequence, the next failure hopped away again on a budget
		// freshly reset to 1, and the pair cycled for as long as the fault lasted.
		// Every lap re-sent the whole prompt at full input rate.
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

		// Smart Fallback if no exact headers found
		return undefined;
	}

	/**
	 * Merge the global `retry.*` settings with any per-provider policy for the
	 * active model. With no model resolved there is nothing to key on, so the
	 * global settings stand unchanged.
	 */
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

	/**
	 * Handle retryable errors with exponential backoff, credential rotation, and
	 * model-fallback chains. Also entered for NON-retryable errors when a switch
	 * is the recovery (`fireworksFastFallback`, `hardErrorFallback`): then a
	 * successful model switch retries immediately, and a failed switch surfaces
	 * the error without a same-model backoff retry.
	 * @returns true if retry was initiated, false if max retries exceeded or disabled
	 */
	async #handleRetryableError(
		message: AssistantMessage,
		options?: { allowModelFallback?: boolean; fireworksFastFallback?: boolean; hardErrorFallback?: boolean },
	): Promise<boolean> {
		const retrySettings = this.settings.getGroup("retry");
		// A backend that runs its own agent loop remotely fails slowly and
		// expensively, so the global attempt count and backoff are resolved
		// against the active model before anything below reads them.
		const retryPolicy = this.#resolveRetryPolicy(retrySettings);
		// The Fireworks Fast→base degrade is an intrinsic model-selection safety net,
		// not a retry loop, so it runs even when the user disabled retries: it switches
		// the model once and lets the base turn proceed.
		if (!retrySettings.enabled && !options?.fireworksFastFallback) return false;
		const classifierRefusal = this.#isClassifierRefusal(message);

		const generation = this.#promptGeneration;
		this.#retryAttempt++;

		// Create retry promise on first attempt so waitForRetry() can await it
		// Ensure only one promise exists (avoid orphaned promises from concurrent calls)
		if (!this.#retryPromise) {
			const { promise, resolve } = Promise.withResolvers<void>();
			this.#retryPromise = promise;
			this.#retryResolve = resolve;
		}

		// All attempts on the current model are spent. Don't fail yet: the
		// fallback chain below gets one last consult. Credential rotation can
		// consume the entire budget without the fallback branch ever running
		// (every rotation sets switchedCredential and skips it), so without
		// this last resort a provider-wide usage cap never fails over to the
		// configured chain.
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
		// Set when a usage-limit error pinned the wait to credential
		// availability — suppresses the generic retry-after bump below.
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
				// A live usage-limit 429 on the active Codex account, with a banked
				// reset and the opt-in setting on: spend the reset and retry
				// immediately instead of waiting out the window. Runs after the
				// free sibling-switch above and before model fallback below.
				switchedCredential = true;
				delayMs = 0;
			} else {
				// No sibling credential is usable right now. Wait for whichever
				// comes first: the provider's retry-after window for the current
				// account, or the earliest moment a temporarily blocked sibling
				// frees up (e.g. a 60s post-401 block or a 5-min usage-probe
				// block) — the next attempt's getApiKey re-ranks and picks it up.
				// Without this, one short-lived sibling block escalates a
				// recoverable situation into the provider's multi-hour wait and
				// trips the fail-fast cap below.
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
			// A refusal chain stops at the retry budget: the exhausted-attempt
			// last resort is for provider failures, not classifier decisions.
			if (allowModelFallback && retrySettings.modelFallback && !(retryBudgetExhausted && classifierRefusal)) {
				if (!classifierRefusal) {
					this.#noteRetryFallbackCooldown(currentSelector, parsedRetryAfterMs, errorMessage);
				}
				switchedModel = await this.#tryRetryModelFallback(currentSelector, { pinFallback: classifierRefusal });
			}
			// Auto fallback from a Fireworks Fast variant to its base model. Independent
			// of the role-fallback setting: it's intrinsic to the Fast contract (speed
			// best-effort, degrade to Standard on failure) and triggers on hard router
			// errors the generic retry classifier would otherwise reject.
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
				// Max retries exceeded and no fallback model to switch to: emit
				// final failure and reset.
				await this.#emitSessionEvent({
					type: "auto_retry_end",
					success: false,
					attempt: this.#retryAttempt - 1,
					finalError: message.errorMessage,
				});
				this.#clearPendingRecoveredRetryErrors();
				this.#retryAttempt = 0;
				this.#resolveRetry(); // Resolve so waitForRetry() completes
				return false;
			}
			// The fallback model gets a fresh retry budget — leaving the spent
			// counter in place would exhaust it again on its first error.
			this.#retryAttempt = 1;
		}
		if (classifierRefusal && !switchedModel) {
			this.#retryAttempt = 0;
			this.#resolveRetry();
			return false;
		}
		// A fallback switch was the whole reason we entered (Fast→base degrade or
		// a hard-error chain consult) but it could not happen (e.g. no candidate
		// has a credential). Don't fall through to backing-off and retrying the
		// failing model for an error the generic classifier wouldn't retry —
		// surface it instead.
		if (
			(options?.fireworksFastFallback || options?.hardErrorFallback) &&
			!switchedModel &&
			!this.#isRetryableError(message)
		) {
			this.#retryAttempt = 0;
			this.#resolveRetry();
			return false;
		}

		// Fail-fast cap: if the provider asks us to wait longer than
		// retry.maxDelayMs and we have no fallback credential or model to
		// switch to, surface the error instead of sleeping. Defends against
		// 3-hour Anthropic rate-limit windows that would otherwise leave a
		// subagent (or interactive session) silently hung. The original
		// assistant error message is preserved in agent state so the caller
		// can act on it.
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

		// Remove the failed assistant message from active context before retrying.
		this.#removeAssistantMessageFromActiveContext(message, "auto-retry");

		// A thinking/response loop retried into identical context loops again. Inject a
		// hidden redirect so the retried turn sees a directive to break the repeated
		// pattern instead of re-sampling the same stalled reasoning.
		this.#maybeInjectThinkingLoopRedirect(id);

		// Wait with exponential backoff (abortable).
		const retryAbortController = new AbortController();
		this.#retryAbortController?.abort();
		this.#retryAbortController = retryAbortController;
		// abortRetry() can land before this assignment (same drain as auto_retry_start); the cancel is lost without this.
		if (!this.#retryPromise) {
			retryAbortController.abort();
		}
		try {
			await scheduler.wait(delayMs, { signal: retryAbortController.signal });
		} catch {
			if (this.#retryAbortController !== retryAbortController) {
				return false;
			}
			// Aborted during sleep - emit end event so UI can clean up
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

		// Retry via continue() outside the agent_end event callback chain.
		this.#scheduleAgentContinue({ delayMs: 1, generation });

		return true;
	}

	/**
	 * Inject a hidden redirect notice when a thinking/response loop is being retried, so
	 * the retried turn carries an instruction to break the repeated pattern instead of
	 * re-sampling the same stalled context. Injected on every {@link AIError.Flag.ThinkingLoop}
	 * retry (the failed assistant is dropped each attempt, so the notice does not accumulate
	 * unboundedly). No-op unless `id` carries the ThinkingLoop flag and the loop guard is
	 * enabled. The notice is generic on purpose — the detector's detail can quote raw model
	 * text, which must not be interpolated into a higher-priority developer message.
	 */
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

	/**
	 * Cancel in-progress retry.
	 */
	abortRetry(): void {
		this.#retryAbortController?.abort();
		// Note: _retryAttempt is reset in the catch block of _autoRetry
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

	/** Whether auto-retry is currently in progress */
	get isRetrying(): boolean {
		return this.#retryPromise !== undefined;
	}

	/** Whether auto-retry is enabled */
	get autoRetryEnabled(): boolean {
		return this.settings.get("retry.enabled") ?? true;
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

		const messages = this.agent.state.messages;
		const lastMsg = messages[messages.length - 1];
		if (lastMsg?.role !== "assistant") return false;

		const assistantMsg = lastMsg as AssistantMessage;
		if (assistantMsg.stopReason !== "error" && assistantMsg.stopReason !== "aborted") return false;

		// Remove the failed/aborted assistant message (same as auto-retry does before re-attempting)
		this.agent.replaceMessages(messages.slice(0, -1));

		// Reset retry budget for a fresh attempt
		this.#retryAttempt = 0;

		// Re-attempt the turn
		this.#scheduleAgentContinue({ delayMs: 1 });

		return true;
	}

	// =========================================================================
	// Bash Execution
	// =========================================================================

	async #saveBashOriginalArtifact(originalText: string): Promise<string | undefined> {
		try {
			return await this.sessionManager.saveArtifact(originalText, "bash-original");
		} catch (err) {
			// The executor only appends the `artifact://<id>` footer when an id comes back, so undefined has to
			// stay the answer here: the minimized output is still correct, it just cannot be expanded. The loss
			// is reported through the same owner the tool spill path uses, so both say the same thing.
			reportLostOutputArtifact("bash-original", err);
			return undefined;
		}
	}

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

	/**
	 * Record a bash execution result in session history.
	 * Used by executeBash and by extensions that handle bash execution themselves.
	 */
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

		// If agent is streaming, defer adding to avoid breaking tool_use/tool_result ordering
		if (this.isStreaming) {
			// Queue for later - will be flushed on agent_end
			this.#pendingBashMessages.push(bashMessage);
		} else {
			// Add to agent state immediately
			this.agent.appendMessage(bashMessage);

			// Save to session
			this.sessionManager.appendMessage(bashMessage);
		}
	}

	/**
	 * Cancel running bash command.
	 */
	abortBash(): void {
		for (const abortController of this.#bashAbortControllers) {
			abortController.abort();
		}
	}

	/** Whether a bash command is currently running */
	get isBashRunning(): boolean {
		return this.#bashAbortControllers.size > 0;
	}

	/** Whether there are pending bash messages waiting to be flushed */
	get hasPendingBashMessages(): boolean {
		return this.#pendingBashMessages.length > 0;
	}

	/**
	 * Flush pending bash messages to agent state and session.
	 * Called after agent turn completes to maintain proper message ordering.
	 */
	#flushPendingBashMessages(): void {
		if (this.#pendingBashMessages.length === 0) return;

		for (const bashMessage of this.#pendingBashMessages) {
			// Add to agent state
			this.agent.appendMessage(bashMessage);

			// Save to session
			this.sessionManager.appendMessage(bashMessage);
		}

		this.#pendingBashMessages = [];
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

			// Use the same session ID as eval's Python backend for kernel sharing.
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

	/**
	 * Track Python work started outside AgentSession.executePython so dispose can await and abort it too.
	 */
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

	/**
	 * Record a Python execution result in session history.
	 */
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

		// If agent is streaming, defer adding to avoid breaking tool_use/tool_result ordering
		if (this.isStreaming) {
			this.#pendingPythonMessages.push(pythonMessage);
		} else {
			this.agent.appendMessage(pythonMessage);
			this.sessionManager.appendMessage(pythonMessage);
		}
	}

	/**
	 * Cancel running Python execution.
	 */
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

	/** Whether a Python execution is currently running */
	get isEvalRunning(): boolean {
		return this.#evalAbortControllers.size > 0;
	}

	/** Whether there are pending Python messages waiting to be flushed */
	get hasPendingPythonMessages(): boolean {
		return this.#pendingPythonMessages.length > 0;
	}

	/**
	 * Flush pending Python messages to agent state and session.
	 */
	#flushPendingPythonMessages(): void {
		if (this.#pendingPythonMessages.length === 0) return;

		for (const pythonMessage of this.#pendingPythonMessages) {
			this.agent.appendMessage(pythonMessage);
			this.sessionManager.appendMessage(pythonMessage);
		}

		this.#pendingPythonMessages = [];
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

	/**
	 * Deliver an IRC message into this session (recipient side; called by the
	 * IrcBus). Emits the `irc_message` session event for UI cards and injects
	 * the rendered message into the model's context as an `irc:incoming`
	 * custom message:
	 *
	 * - mid-turn → queued on the aside channel and folded in at the next step
	 *   boundary (non-interrupting, like async-result deliveries) → "injected";
	 * - idle in plan mode → appended into context without waking an autonomous
	 *   turn (convergence stays user-driven) → "injected";
	 * - idle → starts a real turn with the message so the recipient wakes
	 *   → "woken".
	 *
	 * Never blocks on the recipient's turn: the wake turn is fire-and-forget.
	 *
	 * When the sender expects a reply (`send await:true`) and this session
	 * cannot produce a real reply turn in time — mid-turn with async execution
	 * disabled (the next step boundary may be gated on the sender's own batch
	 * finishing), or idle in plan mode (wake turns are suppressed) — an
	 * ephemeral side-channel auto-reply is generated from the current context
	 * (the old `respondAsBackground` path) and sent back over the bus on this
	 * agent's behalf.
	 */
	async deliverIrcMessage(msg: IrcMessage, opts?: { expectsReply?: boolean }): Promise<"injected" | "woken"> {
		if (this.#isDisposed) {
			throw new Error("Recipient session is disposed.");
		}
		// Auto-reply eligibility: the sender is blocked on an answer and this
		// session cannot produce a real reply turn in time — either mid-turn with
		// async execution disabled (no step boundary until the sender's own batch
		// ends), or idle in plan mode (autonomous wake turns are suppressed).
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
		// Plan mode: record into context but do not wake an autonomous turn.
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
		// Idle: wake a real turn so the recipient responds (shared with the stranded-aside resume).
		this.#wakeForIrc([record]);
		return "woken";
	}

	/**
	 * Generate and deliver an ephemeral auto-reply to `msg` on this agent's
	 * behalf: a no-tools side-channel turn over the current history (same
	 * pipeline as `/btw`), recorded into this session as an `irc:autoreply`
	 * aside so the model knows what was said for it, and sent back to the
	 * sender as a regular bus message (`replyTo: msg.id`) so their parked
	 * `wait`/`await:true` resolves. Failures only log — the sender then hits
	 * its normal wait timeout.
	 */
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
			// Asides drain at the next step boundary; anything left over is
			// flushed at the start of the next prompt (#flushPendingIrcAsides).
			this.#pendingIrcAsides.push(record);
			// `from` must be the id the sender addressed (msg.to) so their
			// from-filtered waiter matches.
			const receipt = await IrcBus.global().send({ from: msg.to, to: msg.from, body, replyTo: msg.id });
			if (receipt.outcome === "failed") {
				logger.warn("IRC auto-reply delivery failed", { to: msg.from, error: receipt.error });
			}
		} catch (error) {
			logger.warn("IRC auto-reply turn failed", { from: msg.from, error: String(error) });
		}
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
		void this.#emitSessionEvent({ type: "irc_message", message: record });
	}

	/**
	 * Run a single ephemeral side-channel turn against this session's current
	 * model + system prompt + history. The main turn's tool catalog is sent
	 * to preserve the prompt cache, but the model is reminded not to call
	 * tools and any tool calls are discarded. The side request
	 * does not block on, or interfere with, any in-flight main turn. The
	 * session's history and persisted state are NOT modified by this call.
	 *
	 * Used by `BtwController` (`/btw`) and `OmfgController` (`/omfg`) to share
	 * the snapshot + stream pipeline. The snapshot includes any in-flight
	 * streaming assistant text so the model sees the half-finished response
	 * rather than missing context.
	 */
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
		// Providers route on `promptCacheKey ?? sessionId`. The live loop sends the
		// agent's pinned key when it has one (fork, tan, shared session), so mirror
		// that rather than the session id or this side turn cold-misses the prefix.
		const ephemeralPromptCacheKey = this.agent.promptCacheKey ?? cacheSessionId;
		const snapshot = this.#buildEphemeralSnapshot(args.promptText);
		const llmMessages = await this.convertMessagesToLlm(snapshot, args.signal);
		const context = await this.agent.buildSideRequestContext(llmMessages);
		const options = await this.prepareSimpleStreamOptions(
			{
				apiKey: this.#modelRegistry.resolver(model, cacheSessionId),
				// Side-channel turns must not share OpenAI/Codex append-only
				// conversation state with the main agent turn: IRC and /btw can run
				// while the main turn is mid-tool-call. Keep the prompt-cache key
				// stable, but give provider routing a unique request lineage. The
				// shared provider state map is still required so Codex can allocate
				// websocket state under that side-channel session id.
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
				// A well-formed provider "done" event carries `content: AssistantContentBlock[]`,
				// but a proxy/wrapper (custom extension providers, gateway-wrapped OAuth streams,
				// see #4323) can hand back a message whose `content` was dropped or replaced with
				// `undefined`. Downstream `.content.filter` at the sanitize step below would then
				// crash the recap turn with `TypeError: undefined is not an object (evaluating
				// 'H.content.filter')`. Normalize to `[]` so the recap surfaces an empty reply
				// instead of turning a malformed side-channel response into a session-mute crash.
				const rawContent = Array.isArray(event.message.content) ? event.message.content : [];
				// RENDER PATH, and async: this reply is shown to the operator (btw,
				// omfg, the idle recap) and is never handed to a tool. Being inside an
				// await it can do better than degrade, so it waits for the vault re-read
				// a stale revision needs and then expands from the runtime that refresh
				// installs. A refresh that fails renders placeholders literally rather
				// than killing the side-channel turn.
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

	/**
	 * Build a message snapshot for an ephemeral side-channel turn.  Includes
	 * the in-flight streaming assistant message (if any) so the model sees
	 * the partial response in context, then appends the prompt as a virtual
	 * user message.
	 */
	#buildEphemeralSnapshot(promptText: string): AgentMessage[] {
		const messages = [...this.messages];
		const streaming = this.agent.state.streamMessage;
		if (streaming && streaming.role === "assistant" && Array.isArray(streaming.content)) {
			const preservedBlocks: AssistantMessage["content"] = [];
			// Preserve thinking blocks: DeepSeek-class encoders replay them as
			// `reasoning_content` and reject the request (HTTP 400) when the field
			// goes missing on a turn that previously emitted thinking.
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

	/**
	 * Persist any IRC asides that missed their step-boundary injection (the
	 * message landed after the turn's last aside drain). Called at the start
	 * of the next prompt so the model still sees them.
	 */
	#flushPendingIrcAsides(): void {
		if (this.#pendingIrcInterrupts.length === 0 && this.#pendingIrcAsides.length === 0) return;
		const records = [...this.#pendingIrcInterrupts, ...this.#pendingIrcAsides];
		this.#pendingIrcInterrupts = [];
		this.#pendingIrcAsides = [];
		for (const record of records) {
			// emitExternalEvent on message_end appends to agent state and dispatches
			// to all session listeners, which in turn handle TUI rendering and
			// sessionManager persistence via #handleAgentEvent.
			this.agent.emitExternalEvent({ type: "message_start", message: record });
			this.agent.emitExternalEvent({ type: "message_end", message: record });
		}
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
	 * Switch to a different session file.
	 * Aborts current operation, loads messages, restores model/thinking.
	 * Listeners are preserved and will continue receiving events.
	 * @returns true if switch completed, false if cancelled by hook
	 */
	switchSession(sessionPath: string): Promise<boolean> {
		return this.#runScopeTransition(() => this.#switchSession(sessionPath));
	}

	async #switchSession(sessionPath: string): Promise<boolean> {
		const previousSessionFile = this.sessionManager.getSessionFile();
		const switchingToDifferentSession = previousSessionFile
			? path.resolve(previousSessionFile) !== path.resolve(sessionPath)
			: true;
		// Emit session_before_switch event (can be cancelled)
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

		// Flush pending writes before switching so restore snapshots reflect committed state.
		await this.sessionManager.flush();
		const previousSessionState = this.sessionManager.captureState();
		// Only same-session reloads compare against the prior context to detect
		// rollback edits (`#didSessionMessagesChange` below). Building it for a
		// different-session switch is a pure waste — and on huge pre-fix sessions
		// it materializes every persisted legacy compaction frame plus the
		// `openaiRemoteCompaction.replacementHistory` payload into messages,
		// blowing the heap before the new session even loads (issue #3846). The
		// error-recovery path rebuilds the context on demand from the restored
		// state instead.
		const previousSessionContext = switchingToDifferentSession ? undefined : this.buildDisplaySessionContext();
		// switchSession replaces these arrays wholesale during load/rollback, so retaining
		// the existing message objects is sufficient and avoids structured-clone failures for
		// extension/custom metadata that is valid to persist but not cloneable.
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
		// `#inheritedProviderPromptCacheKey` only mirrors what the agent routes on;
		// the value that actually reaches the wire is `agent.promptCacheKey`. The
		// try block rewrites BOTH (clear + adopt the target header's identity), so
		// restoring only the mirror leaves a failed switch sending the target
		// session's `prompt_cache_key` for every later turn of the source session.
		const previousAgentPromptCacheKey = this.agent.promptCacheKey;
		const previousFallbackSelectedMCPToolNames = previousSessionFile
			? this.#getSessionDefaultSelectedMCPToolNames(previousSessionFile)
			: undefined;

		// Snapshot the full checkpoint runtime state: the success path calls
		// #rehydrateCheckpointRewindState(), which clears and rebuilds all four
		// fields from the target branch. On rollback every one must be restored,
		// or a failed switch leaks the target session's checkpoint state.
		const previousCheckpointState = this.#checkpointState;
		const previousPendingRewindReport = this.#pendingRewindReport;
		const previousLastCompletedRewind = this.#lastCompletedRewind;
		const previousRewoundToolResultIds = new Set(this.#rewoundToolResultIds);

		let scopeTransitionAttempted = false;

		this.agent.clearAllQueues();
		this.#pendingNextTurnMessages = [];
		this.#scheduledHiddenNextTurnGeneration = undefined;

		try {
			await this.sessionManager.setSessionFile(sessionPath);
			// `setSessionFile` normally adopts the header cwd itself. Reassert the
			// recorded directory here when it is reachable so switchSession owns
			// the complete transcript+runtime transition rather than depending on
			// how the manager was originally constructed.
			const recordedTargetCwd = this.sessionManager.getHeader()?.cwd;
			if (recordedTargetCwd && path.resolve(recordedTargetCwd) !== path.resolve(this.sessionManager.getCwd())) {
				let recordedTargetCwdReachable = false;
				try {
					recordedTargetCwdReachable = (await fs.promises.stat(recordedTargetCwd)).isDirectory();
				} catch {
					// Preserve SessionManager's moved/deleted-worktree contract:
					// an unreachable recorded cwd keeps the caller's current root.
				}
				if (recordedTargetCwdReachable) {
					// Keep mutation failures in switchSession's outer transaction;
					// only the reachability probe above is an allowed fallback.
					await this.sessionManager.setCwd(recordedTargetCwd, { validate: false });
				}
			}
			const targetCwd = this.sessionManager.getCwd();
			if (path.resolve(targetCwd) !== path.resolve(previousSessionState.cwd)) {
				scopeTransitionAttempted = true;
				await this.#rescopeToCwd(targetCwd);
				this.#wirePathRoots = normalizeRoots([...this.#wirePathRoots, targetCwd]);
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

			// Emit session_switch event to hooks
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
			// The board just came back from the branch, so every latch describing
			// the pre-switch board (including a failed write against it) is about a
			// board this session no longer holds.
			this.#resetTodoReminderStateForNewContext();
			if (switchingToDifferentSession) {
				this.#closeAllProviderSessions("session switch");
			} else if (didReloadConversationChange) {
				this.#closeAllProviderSessions("session reload");
			}

			// Restore model if saved
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
			// Restore the thinking selector. Each change persists the configured
			// selector (`auto` or a concrete level), so prefer it: an `auto` session
			// resumes in auto mode (reclassifying the next turn) instead of freezing at
			// the last resolved level. Entries written before the `configured` field
			// existed fall back to the concrete level (legacy pin-on-resume behavior).
			// With no thinking entry, fall back to the global default so fresh sessions
			// still classify their first turn.
			const restoredConfigured = sessionContext.configuredThinkingLevel;
			const restoredThinkingLevel: ConfiguredThinkingLevel | undefined =
				hasThinkingEntry || (defaultThinkingLevel === AUTO_THINKING && sessionContext.thinkingLevel !== "off")
					? restoredConfigured === AUTO_THINKING
						? AUTO_THINKING
						: (sessionContext.thinkingLevel as ThinkingLevel | undefined)
					: defaultThinkingLevel;
			if (restoredThinkingLevel === AUTO_THINKING) {
				this.#autoThinking = true;
				// Resume in auto (pending) like a fresh auto session: the next user
				// turn reclassifies. We intentionally do not seed the last resolved
				// effort, so the cold (--continue) and in-app switch paths display
				// identically as `auto` until then.
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
					error: String(error),
				});
			}
			return true;
		} catch (error) {
			this.sessionManager.restoreState(previousSessionState);
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
				// `previousSessionContext` was skipped on different-session switches to
				// avoid materializing the previous session's heavy compaction payload
				// in the success path; rebuild it here on demand from the restored
				// state so MCP selection restoration still has its inputs.
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

	/**
	 * Create a branch from a specific entry.
	 * Emits before_branch/branch session events to hooks.
	 *
	 * @param entryId ID of the entry to branch from
	 * @returns Object with:
	 *   - selectedText: The text of the selected user message (for editor pre-fill)
	 *   - cancelled: True if a hook cancelled the branch
	 */
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

		// Emit session_before_branch event (can be cancelled)
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

		// Clear pending messages (bound to old session state)
		this.#pendingNextTurnMessages = [];
		this.#scheduledHiddenNextTurnGeneration = undefined;

		// Flush pending writes before branching
		await this.sessionManager.flush();
		this.#cancelOwnAsyncJobs();

		if (!selectedEntry.parentId) {
			await this.sessionManager.newSession({
				parentSession: previousSessionFile,
				// Branching at the root user message discards the transcript but keeps
				// the system prompt and toolset, which is the bulk of the cached
				// prefix. Carry the cache identity so the re-ask reads it.
				providerPromptCacheKey:
					this.sessionManager.getHeader()?.providerPromptCacheKey ?? this.sessionManager.getSessionId(),
			});
		} else {
			this.sessionManager.createBranchedSession(selectedEntry.parentId);
		}
		this.#rehydrateCheckpointRewindState();
		this.#syncTodoPhasesFromBranch();
		this.#freshProviderSessionId = undefined;
		// A branch retains a genuine prefix of the source transcript, so the source
		// cache identity stays valid: `createBranchedSession` seeds it onto the new
		// header and this adopts it. No discard is recorded because nothing is
		// discarded — the retained prefix keeps reading the cache the source
		// populated instead of cold-missing every token of it.
		this.#adoptInheritedProviderPromptCacheKey();
		this.#syncAgentSessionId();
		this.#rekeyHindsightMemoryForCurrentSessionId();
		this.#rekeyMnemopiMemoryForCurrentSessionId();
		this.#resetMemoryContextForNewTranscript();

		// Reload messages from entries (works for both file and in-memory mode)
		const sessionContext = this.buildDisplaySessionContext();

		await this.#restoreMCPSelectionsForSessionContext(sessionContext);

		// Emit session_branch event to hooks (after branch completes)
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
		// `/btw` branches at the live leaf, so the entire retained prefix is
		// byte-identical to what the source session just cached. Adopt the branch
		// header's inherited cache identity instead of routing the next turn under
		// the freshly minted session id, which would cold-miss the whole transcript.
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

	// =========================================================================
	// Tree Navigation
	// =========================================================================

	/**
	 * Navigate to a different node in the session tree.
	 * Unlike branch() which creates a new session file, this stays in the same file.
	 *
	 * @param targetId The entry ID to navigate to
	 * @param options.summarize Whether user wants to summarize abandoned branch
	 * @param options.customInstructions Custom instructions for summarizer
	 * @returns Result with editorText (if user message) and cancelled status
	 */
	async navigateTree(
		targetId: string,
		options: { summarize?: boolean; customInstructions?: string } = {},
	): Promise<{
		editorText?: string;
		cancelled: boolean;
		aborted?: boolean;
		summaryEntry?: BranchSummaryEntry;
		/** Raw session context built during navigation — pass to renderInitialMessages to skip a second O(N) walk. */
		sessionContext?: SessionContext;
	}> {
		const oldLeafId = this.sessionManager.getLeafId();

		// No-op if already at target
		if (targetId === oldLeafId) {
			return { cancelled: false };
		}

		// Model required for summarization
		if (options.summarize && !this.model) {
			throw new Error("No model available for summarization");
		}

		const targetEntry = this.sessionManager.getEntry(targetId);
		if (!targetEntry) {
			throw new Error(`Entry ${targetId} not found`);
		}

		// Collect entries to summarize (from old leaf to common ancestor)
		const { entries: entriesToSummarize, commonAncestorId } = collectEntriesForBranchSummary(
			this.sessionManager,
			oldLeafId,
			targetId,
		);

		// Prepare event data
		const preparation: TreePreparation = {
			targetId,
			oldLeafId,
			commonAncestorId,
			entriesToSummarize,
			userWantsSummary: options.summarize ?? false,
		};

		// Set up abort controller for summarization
		this.#branchSummaryAbortController = new AbortController();
		let hookSummary: { summary: string; details?: unknown } | undefined;
		let fromExtension = false;

		// Emit session_before_tree event
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

		// Run default summarizer if needed
		let summaryText: string | undefined;
		let summaryDetails: unknown;
		if (options.summarize && entriesToSummarize.length > 0 && !hookSummary) {
			const model = this.model!;
			const apiKey = await this.#modelRegistry.getApiKey(model, this.sessionId);
			if (!apiKey) {
				throw new Error(missingCredentialsMessage(model.provider, model.id, "the branch summary model"));
			}
			await this.leaseSecretRuntime();
			const branchSummarySettings = this.settings.getGroup("branchSummary");
			const result = await generateBranchSummary(entriesToSummarize, {
				model,
				apiKey: this.#modelRegistry.resolver(model, this.sessionId),
				signal: this.#branchSummaryAbortController.signal,
				customInstructions: options.customInstructions,
				reserveTokens: branchSummarySettings.reserveTokens,
				metadata: this.agent.metadataForProvider(model.provider),
				convertToLlm,
				resolveObfuscateProviderText: () => {
					const runtime = this.#secretRuntime;
					const fallback = this.#obfuscator;
					return text => runtime?.obfuscateText(text) ?? fallback?.obfuscate(text) ?? text;
				},
				onPayload: this.#onPayload,
				telemetry: resolveTelemetry(this.agent.telemetry, this.sessionId),
				// Same per-provider concurrency cap rationale as the compaction
				// path above (chatgpt-codex review on #3751).
				completeImpl: this.#sideCompleteImpl,
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
			// Hook supplied the summary directly: the signal was only needed for the
			// session_before_tree emit above, so release it now instead of relying on
			// the unconditional clear near the end of this method.
			summaryText = hookSummary.summary;
			summaryDetails = hookSummary.details;
			this.#branchSummaryAbortController = undefined;
		} else {
			// No summarization requested (or nothing to summarize): the controller was
			// only ever used for the session_before_tree signal above, so it can be
			// released immediately rather than staying set until the method returns.
			this.#branchSummaryAbortController = undefined;
		}

		// Determine the new leaf position based on target type
		let newLeafId: string | null;
		let editorText: string | undefined;

		if (targetEntry.type === "message" && targetEntry.message.role === "user") {
			// User message: leaf = parent (null if root), text goes to editor
			newLeafId = targetEntry.parentId;
			editorText = this.#extractUserMessageText(targetEntry.message.content);
		} else if (targetEntry.type === "custom_message" && targetEntry.customType !== SKILL_PROMPT_MESSAGE_TYPE) {
			// Custom message: leaf = parent (null if root), text goes to editor
			newLeafId = targetEntry.parentId;
			editorText = contentText(targetEntry.content, { separator: "" });
		} else {
			// Non-user message (or a user-invoked skill-prompt injection): land the
			// leaf on the selected node so it stays on the active branch. Skill
			// prompts are custom_message entries but must not be re-editable — their
			// content is a large expanded body, not a user turn (issue #5374).
			newLeafId = targetId;
		}

		// Switch leaf (with or without summary)
		// Summary is attached at the navigation target position (newLeafId), not the old branch
		let summaryEntry: BranchSummaryEntry | undefined;
		if (summaryText) {
			// Create summary at target position (can be null for root)
			const summaryId = this.sessionManager.branchWithSummary(newLeafId, summaryText, summaryDetails, fromExtension);

			summaryEntry = this.sessionManager.getEntry(summaryId) as BranchSummaryEntry;
		} else if (newLeafId === null) {
			// No summary, navigating to root - reset leaf
			this.sessionManager.resetLeaf();
		} else {
			// No summary, navigating to non-root
			this.sessionManager.branch(newLeafId);
		}

		// Update agent state — build display context to populate agent messages.
		const stateContext = this.sessionManager.buildSessionContext();
		// RENDER PATH, and async: this rebuilds the agent's display state after a
		// branch move, so a throw left the TUI with no transcript at all. Await the
		// refresh a stale revision needs, then degrade per string.
		await this.#awaitSecretExpansionRefreshForRender(this.#messagesCarryLivePlaceholder(stateContext.messages));
		const displayContext = this.#deobfuscateSessionContextForDisplay(stateContext);
		await this.#restoreMCPSelectionsForSessionContext(displayContext);
		this.agent.replaceMessages(displayContext.messages);
		this.#rehydrateCheckpointRewindState();
		this.#resetAdvisorSessionState();
		this.#syncTodoPhasesFromBranch();
		this.#closeCodexProviderSessionsForHistoryRewrite();

		this.#branchSummaryAbortController = undefined;

		// Emit session_tree event; only handlers can mutate session entries, so skip
		// the emit and the context rebuild when no handlers are registered (mirrors
		// the session_before_tree guard above).
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

	/**
	 * Get all user messages from session for branch selector.
	 */
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
		// Persisted entry content arrives loosely typed here; keep the defensive
		// guard for malformed data, then delegate to the shared flattener.
		if (typeof content !== "string" && !Array.isArray(content)) return "";
		return contentText(content, { separator: "" });
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

	/**
	 * Messages the latest compaction summarized away, oldest first.
	 *
	 * They are gone from the live context by design and they are still what this
	 * session paid for, so spend accounting adds them back. Everything from the
	 * boundary forward is already in the context, so nothing is counted twice, and
	 * an earlier compaction's own summary is an ENTRY rather than a message, so a
	 * session that compacted several times counts each range once. The stored
	 * branch is also what a resume reads, so the total survives a restart.
	 */
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

	/**
	 * Get current context usage statistics.
	 * Uses the last assistant message's usage data when available,
	 * otherwise estimates tokens for all messages.
	 */
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

		// Always locate the latest real assistant-usage anchor after the last
		// compaction. Its provider-reported promptTokens is ground truth for
		// everything up to that point; only the tail after it is estimated.
		let anchorEntry: SessionMessageEntry | undefined;
		for (let i = branchEntries.length - 1; i > compactionIndex; i--) {
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

		// A real anchor supersedes the in-flight estimate only once a step of the
		// CURRENT turn has produced provider usage — i.e. it resolves at or after
		// the pending cutoff. While the turn's first response is still pending (or
		// the newest real anchor predates this turn) the pending snapshot is the
		// only thing accounting for the just-submitted prompt, so it wins. This
		// keeps a long tool turn from stacking an estimate of the entire tail on
		// top of a stale turn-start prompt.
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
			if (resolvedActiveMessages.length > pending.cutoffCount) {
				for (let i = pending.cutoffCount; i < resolvedActiveMessages.length; i++) {
					tailTokens += estimateTokens(resolvedActiveMessages[i]);
				}
			}
			usedTokens =
				pending.promptTokens +
				Math.max(0, currentNonMessageTokens - pending.nonMessageTokens) +
				tailTokens +
				pendingMessagesTokens;
		}

		if (!anchored && !pending && branchEntries.length === 0) {
			// Fallback: look for the latest assistant message with usage/snapshot in this.messages (for branchless/fake sessions in tests)
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

		// One number owns "how full is the context". Every compaction decision
		// floors the provider-anchored total by the local estimate of what the
		// session actually holds (see #estimateStoredContextTokens and the
		// compactionContextTokens call sites), because a provider reporting a
		// prompt smaller than the stored conversation must not suppress
		// compaction. The gauge did not apply that floor, so a session whose
		// provider under-reports its prompt showed "90% left" on the footline
		// while auto-compaction fired against the same window on every turn.
		// Display and decision now read the same total.
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

	/**
	 * Monotonic counter that changes whenever the in-flight pending context
	 * snapshot is set or cleared. Status-line context memoization keys on this so
	 * a value computed mid-turn cannot persist after the turn ends/aborts.
	 */
	get contextUsageRevision(): number {
		return this.#contextUsageRevision;
	}

	#setPendingContextSnapshot(snapshot: PendingContextSnapshot | undefined): void {
		this.#pendingContextSnapshot = snapshot;
		this.#contextUsageRevision++;
	}

	/**
	 * Rebase the in-flight pending context snapshot onto the current message
	 * set after a compaction (or its dead-end rescue) rewrote history mid-run.
	 * The snapshot captures the prompt as submitted at run start and lives for
	 * the whole run; once a compaction entry lands, every earlier usage anchor
	 * is hidden from {@link getContextBreakdown}, so the stale run-start figure
	 * would be reported as live context until the next provider response. That
	 * inflated residual is what the post-compaction headroom/retry-fit checks
	 * measure — a run that started above the recovery band then trips the
	 * "freed too little context" dead-end even when compaction genuinely
	 * shrank the context. No-op while no prompt is in flight.
	 */
	#rebasePendingContextSnapshotAfterCompaction(): void {
		if (!this.#pendingContextSnapshot) return;
		const nonMessageTokens = computeNonMessageTokens(this);
		const promptTokens = nonMessageTokens + this.messages.reduce((sum, msg) => sum + estimateTokens(msg), 0);
		const rebased: PendingContextSnapshot = {
			promptTokens,
			nonMessageTokens,
			cutoffCount: this.messages.length,
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
		// No-op for providers whose usage strategy lacks a header parser.
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

	/**
	 * Redeem one saved Codex rate-limit reset for a specific account, injecting
	 * the provider base URL like {@link AgentSession.fetchUsageReports}. Powers
	 * the `/usage reset` command and auto-redeem. Never throws for business
	 * outcomes — inspect the returned `code`.
	 */
	async redeemResetCredit(target: ResetCreditTarget, signal?: AbortSignal): Promise<ResetCreditRedeemOutcome> {
		return this.#modelRegistry.authStorage.redeemResetCredit({
			target,
			baseUrlResolver: provider => this.#modelRegistry.getProviderBaseUrl?.(provider),
			signal,
		});
	}

	/**
	 * List saved Codex rate-limit resets per stored account, fetched live from
	 * the dedicated credits endpoint (bypasses the usage cache). Powers the
	 * `/usage reset` account selector.
	 */
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
			logger.warn("codex-auto-reset prompt failed", { error: String(error) });
		}
		return false;
	}

	/**
	 * Auto-redeem hook for {@link AgentSession.#handleRetryableError}'s
	 * usage-limit branch. Returns `true` only when a saved Codex reset was
	 * actually spent (so the caller retries immediately). The "unset" mode is
	 * reactive but asks before spending; "yes" skips that prompt, and "no" avoids
	 * the eligibility IO entirely. The decision remains heavily gated — see
	 * `./codex-auto-reset` and the design in `local://autoreset-spec.md`.
	 * Per-account in-flight dedup lets concurrent sessions adopt one redeem
	 * instead of double-spending.
	 */
	async #maybeAutoRedeemCodexReset(coordinator = defaultCodexAutoRedeemCoordinator): Promise<boolean> {
		const cfg = this.settings.getGroup("codexResets");
		const model = this.model;
		// Cheap exits before any IO.
		if (!shouldEvaluateCodexAutoRedeem(cfg.autoRedeem) || !model || model.provider !== "openai-codex") return false;
		const authStorage = this.#modelRegistry.authStorage;
		// Capture identity BEFORE awaits: markUsageLimitReached leaves the
		// usage-limit session credential sticky, so this names the blocked account.
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
			// Commit the attempt BEFORE acting so this block can never re-enter.
			coordinator.attemptedBlockKeys.add(decision.blockKey);
			coordinator.lastAttemptAtByAccount.set(decision.accountKey, Date.now());
			const who = decision.target.email ?? decision.target.accountId ?? "the active account";
			// withScopedTimeoutSignal clears the 15s deadline the moment the redeem
			// settles, so the timer never outlives the request (a bare
			// AbortSignal.timeout would keep firing after we already have the
			// outcome). Not tied to the retry abort controller: aborting a consume
			// mid-flight leaves credit state unknown.
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
					// Best-effort refresh so the status line stops showing the
					// spent window. It is a network call on a rate-limit recovery
					// path, which is exactly when the provider is least reliable,
					// and nothing awaits it: without a handler a failed refresh
					// floated to postmortem and killed the session it had just
					// finished rescuing.
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

	/**
	 * Export session to HTML.
	 * @param outputPath Optional output path (defaults to session directory)
	 * @returns Path to exported file
	 */
	async exportToHtml(outputPath?: string): Promise<string> {
		// Public HTML export ships in the veyyon brand palette (collab-web
		// pink/purple), matching share.veyyon.dev — not the host's terminal theme.
		// Callers who want a themed export can pass `palette: "theme"` with
		// `themeName` directly to `exportSessionToHtml`.
		const { exportSessionToHtml } = await import("../export/html");
		return exportSessionToHtml(this.sessionManager, this.state, {
			outputPath,
			palette: "web",
			obfuscator: this.settings.get("share.redactSecrets") ? this.providerRedactor : undefined,
		});
	}

	// =========================================================================
	// Utilities
	// =========================================================================

	/**
	 * Get text content of last assistant message.
	 * Useful for /copy command.
	 * @returns Text content, or undefined if no assistant message exists
	 */
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
			// Skip aborted messages with no content
			if (assistantMessage.stopReason === "aborted" && assistantMessage.content.length === 0) continue;

			return assistantMessage;
		}

		return undefined;
	}
	/**
	 * Get text content of the most recent visible handoff message.
	 * Fresh handoff sessions store the handoff context as a custom message, not
	 * an assistant message, so callers that copy the "last" message can use this
	 * as a fallback before the new session has an assistant response.
	 */
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

	/**
	 * Format the entire session as plain text for clipboard export: system
	 * prompt, model/thinking config, tool inventory, and the full transcript
	 * rendered with markdown role headings (`## User`, `## Assistant`,
	 * `### Tool Call`/`### Tool Result`).
	 */
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

	/**
	 * Dump the current session's LLM-facing request context as JSON to a
	 * auto-named file in `os.tmpdir()`. This is the synchronous
	 * `convertToLlm`-boundary snapshot — system prompt, tools (wire schemas),
	 * thinking/service tier, and converted messages — with no network round-trip
	 * and no arming flag, so advisor/side requests cannot intercept it.
	 *
	 * The file persists on disk and may contain the same raw context/secrets
	 * as `/dump`; treat the path accordingly.
	 *
	 * @returns the written file path, or `undefined` when there are no messages.
	 */
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

	/**
	 * Enable or disable the advisor for this session. The setting is overridden for the session,
	 * and the runtime is started or stopped to match.
	 *
	 * @returns true when the advisor is actively running after the call.
	 */
	setAdvisorEnabled(enabled: boolean): boolean {
		this.#advisorEnabled = enabled;
		if (enabled) {
			if (this.#advisors.length > 0 && !this.#advisorRuntimeMatchesCurrentConfig()) this.#stopAdvisorRuntime();
			return this.#buildAdvisorRuntime(true);
		}
		this.#stopAdvisorRuntime();
		return false;
	}

	/**
	 * Toggle the advisor setting and start/stop the runtime accordingly.
	 *
	 * @returns true when the advisor is actively running after the call.
	 */
	toggleAdvisorEnabled(): boolean {
		return this.setAdvisorEnabled(!this.#advisorEnabled);
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
		this.#advisorConfigs = advisors;
		this.#advisorSharedInstructions = sharedInstructions;
		if (!this.#advisorEnabled) return 0;
		this.#stopAdvisorRuntime();
		this.#buildAdvisorRuntime(true);
		return this.#advisors.length;
	}

	/**
	 * Whether the advisor setting is enabled for this session.
	 */
	isAdvisorEnabled(): boolean {
		return this.#advisorEnabled;
	}

	/**
	 * Whether a live advisor agent is attached to this session. True only when
	 * `advisor.enabled` is set AND a model resolved for the `advisor` role AND
	 * the advisor applies to this agent kind — i.e. the actual runtime exists,
	 * not merely the setting. Drives the status-line badge and `/dump advisor`.
	 */
	isAdvisorActive(): boolean {
		return this.#advisors.length > 0;
	}

	/**
	 * The names of the tools available to advisors this session (the pool a
	 * `/advisor configure` editor lists). The advisor is a full agent, so this is the
	 * full built tool set; a tool whose optional factory returns null (e.g. lsp with
	 * no servers) is absent.
	 */
	getAdvisorAvailableToolNames(): string[] {
		return (this.#advisorTools ?? []).map(tool => tool.name);
	}

	/**
	 * The live advisor `Agent`, or `undefined` when no advisor runtime is
	 * attached. Surfaced for diagnostics (`/dump advisor` already serializes
	 * its transcript via {@link formatAdvisorHistoryAsText}) and so callers can
	 * verify the advisor inherits the session's provider-shaping options
	 * (`streamFn`, `promptCacheKey`, `providerSessionState`, ...).
	 */
	getAdvisorAgent(): Agent | undefined {
		return this.#advisors[0]?.agent;
	}

	/**
	 * Return structured advisor stats for the status command and TUI panel.
	 */
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

	/**
	 * Format a concise advisor status line for ACP/text output.
	 */
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

	/**
	 * Estimate the advisor's current context tokens. When the advisor has a
	 * recent non-aborted assistant message with usage, use that prompt's token
	 * count and add a trailing estimate for messages after it. Otherwise estimate
	 * every message.
	 */
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

	/**
	 * Format the advisor agent's own transcript (its system prompt, config,
	 * tools, and the markdown deltas it received plus its thinking/advise/read
	 * calls) as plain text — the advisor-side equivalent of
	 * {@link formatSessionAsText}. Returns null when no advisor is active.
	 */
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

	// =========================================================================
	// Extension System
	// =========================================================================

	/**
	 * Check if extensions have handlers for a specific event type.
	 */
	hasExtensionHandlers(eventType: string): boolean {
		return this.#extensionRunner?.hasHandlers(eventType) ?? false;
	}

	/**
	 * Get the extension runner (for setting UI context and error handlers).
	 */
	get extensionRunner(): ExtensionRunner | undefined {
		return this.#extensionRunner;
	}
}
