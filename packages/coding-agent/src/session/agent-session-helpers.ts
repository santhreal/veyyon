import type { Agent, AgentEvent, AgentMessage, AgentTool, StreamFn, ThinkingLevel } from "@veyyon/agent-core";
import { type CompactionResult, type SessionMessageEntry, stripLegacyArchive } from "@veyyon/agent-core/compaction";
import {
	type AssistantMessage,
	type AssistantRetryRecoveryKind,
	type CodexCompactionContext,
	type Context,
	deriveClaudeDeviceId,
	type ImageContent,
	type Message,
	type MessageAttribution,
	type Model,
	type ServiceTierByFamily,
	type SimpleStreamOptions,
	type TextContent,
	type ToolChoice,
} from "@veyyon/ai";
import type { SessionTelemetryDetail } from "@veyyon/ai/instrumentation";
import type { Effort } from "@veyyon/catalog/effort";
import { Patch } from "@veyyon/hashline";
import { getInstallId, isRecord, type postmortem } from "@veyyon/utils";
import type { ArgotSession } from "argot";
import type {
	AdviseTool,
	AdvisorConfig,
	AdvisorEmissionGuard,
	AdvisorRuntime,
	AdvisorTranscriptRecorder,
} from "../advisor";
import type { AsyncJob, AsyncJobDeliveryState, AsyncJobManager } from "../async";
import type { Rule } from "../capability/rule";
import type { CompactionEngineAction } from "../config/compaction-strategy";
import type { EffortSource } from "../config/effort-resolver";
import type { ModelRegistry } from "../config/model-registry";
import { formatModelSelectorValue, formatModelStringWithRouting, parseModelString } from "../config/model-resolver";
import type { PromptTemplate } from "../config/prompt-templates";
import type { Settings, SkillsSettings } from "../config/settings";
import type { RawSseDebugBuffer } from "../debug/raw-sse-buffer";
import { expandApplyPatchToEntries } from "../edit/modes/apply-patch";
import type { TtsrManager } from "../export/ttsr";
import type { LoadedCustomCommand } from "../extensibility/custom-commands";
import type { ExtensionRunner, ExtensionUIContext } from "../extensibility/extensions";
import type { ContextUsage } from "../extensibility/extensions/types";
import type { RecoveredRetryError } from "../extensibility/shared-events";
import type { Skill } from "../extensibility/skills";
import type { FileSlashCommand } from "../extensibility/slash-commands";
import type { Goal, GoalModeState } from "../goals/state";
import type { RetryRecoveryMode } from "../modes/retry-display";
import { theme } from "../modes/theme/theme-binding";
import { transformProviderPayload } from "../provider-boundary";
import type { SecretObfuscator } from "../secrets/obfuscator";
import { isLivePromptGate } from "../system-prompt-builder/gate-registry";
import { type ConfiguredThinkingLevel, concreteThinkingLevel } from "../thinking";
import type { TitleConversationTurn } from "../tiny/message-preproc";
import { TOOL } from "../tools/builtin-names";
import type { CompletedRewindState } from "../tools/checkpoint";
import { resolveToCwd } from "../tools/path-utils";
import type { TodoItem } from "../tools/todo";
import type { AuthStorage } from "./auth-storage";
import type { ClientBridgePermissionOption } from "./client-bridge";
import { type ContentBlockLike, contentText } from "./content-text";
import { type CustomMessage, readQueueChipText } from "./messages";
import type { OperatorNotices } from "./operator-notices";
import type { SessionEntry, SessionTitleSource } from "./session-entries";
import type { SessionManager } from "./session-manager";
import type { ShakeMode, ShakeResult } from "./shake-types";
export function customMessageContentText(content: string | (TextContent | ImageContent)[]): string {
	if (typeof content === "string") return content;
	const parts: string[] = [];
	for (const part of content) {
		if (part.type === "text") parts.push(part.text);
	}
	return parts.join("\n");
}

export function stringProperty(value: object, key: string): string | undefined {
	const field = Object.getOwnPropertyDescriptor(value, key)?.value;
	return typeof field === "string" ? field : undefined;
}

export function reportFromRewindReportContent(content: string): string {
	const marker = "\nReport:\n";
	const index = content.lastIndexOf(marker);
	const report = index >= 0 ? content.slice(index + marker.length) : content;
	return report.trim();
}

export function completedRewindFromEntry(entry: SessionEntry): CompletedRewindState | undefined {
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

export function isSuccessfulCheckpointEntry(entry: SessionEntry): entry is SessionMessageEntry & {
	message: { role: "toolResult"; toolName: "checkpoint"; isError?: false };
} {
	return (
		entry.type === "message" &&
		entry.message.role === "toolResult" &&
		entry.message.toolName === TOOL.checkpoint &&
		entry.message.isError !== true
	);
}

export function checkpointStartedAtFromEntry(entry: SessionEntry): string | undefined {
	if (!isSuccessfulCheckpointEntry(entry)) return undefined;
	const details = entry.message.details;
	if (details && typeof details === "object") {
		const startedAt = stringProperty(details, "startedAt");
		if (startedAt) return startedAt;
	}
	return entry.timestamp;
}

export function sanitizeAssistantForReparentedHistory(message: AssistantMessage): AssistantMessage {
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
export function compactionDeadEndWarning(remedies: string): string {
	return (
		"Compaction freed too little context to make progress — pausing automatic maintenance to avoid a compaction loop. " +
		`The most recent turn alone is too large to reduce further; ${remedies} or switch to a larger-context model.`
	);
}

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
export const TOOL_SHAPE_SETTING_PATHS: Readonly<Record<string, true>> = {
	"async.enabled": true,
	"subagent.isolation.mode": true,
	"subagent.maxNestedSpawnDepth": true,
};

export function rebuildsThePrompt(path: string): boolean {
	return isLivePromptGate(path) || TOOL_SHAPE_SETTING_PATHS[path] === true;
}
export const NON_WHITESPACE_RE = /\S/;

export function hasNonWhitespace(value: string): boolean {
	return NON_WHITESPACE_RE.test(value);
}
export interface RetryFallbackSelector {
	raw: string;
	provider: string;
	id: string;
	thinkingLevel: ThinkingLevel | undefined;
}
export function parseRetryFallbackSelector(
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

export function isRetryFallbackModelKey(key: string): boolean {
	return key.includes("/");
}

export function isRetryFallbackWildcardKey(key: string): boolean {
	return key.endsWith("/*");
}

export function formatRetryFallbackSelector(model: Model, thinkingLevel: ThinkingLevel | undefined): string {
	return formatModelSelectorValue(formatModelStringWithRouting(model), thinkingLevel);
}

export function formatRetryFallbackBaseSelector(selector: RetryFallbackSelector): string {
	return `${selector.provider}/${selector.id}`;
}
export const EPHEMERAL_REPLY_MAX_BYTES = 4096;
export function dedupeEphemeralReply(text: string): string {
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
		const suffix = "\n[…truncated]";
		const budget = EPHEMERAL_REPLY_MAX_BYTES - Buffer.byteLength(suffix, "utf8");
		while (Buffer.byteLength(result, "utf8") > budget) {
			result = result.slice(0, -1);
		}
		result += suffix;
	}
	return result;
}
export function isToolOrderPermutation(current: readonly string[], next: readonly string[]): boolean {
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
export function buildSessionMetadata(
	sessionId: string,
	provider: string,
	authStorage: AuthStorage | undefined,
): Record<string, unknown> {
	const userId: Record<string, string> = { session_id: sessionId };

	if (provider === "anthropic") {
		const accountUuid = authStorage?.getOAuthAccountId("anthropic", sessionId);
		if (typeof accountUuid === "string" && accountUuid.length > 0) {
			userId.account_uuid = accountUuid;

			userId.device_id = deriveClaudeDeviceId(getInstallId(), accountUuid);
		}
	}
	return { user_id: JSON.stringify(userId) };
}
export function createHandoffContext(document: string): string {
	return `<handoff-context>\n${document}\n</handoff-context>\n\nThe above is a handoff document from a previous session. Use this context to continue the work seamlessly.`;
}

export function createHandoffFileName(date = new Date()): string {
	const fileTimestamp = date.toISOString().replace(/[:.]/g, "-");
	return `handoff-${fileTimestamp}.md`;
}
export function getStringProperty(value: Record<string, unknown>, key: string): string | undefined {
	const candidate = value[key];
	return typeof candidate === "string" ? candidate : undefined;
}

export function collectStringPaths(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
export function getEditDestructiveIntent(args: unknown): { kind: "delete" | "move"; paths: string[] } | undefined {
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
		} catch {}
		try {
			const entries = expandApplyPatchToEntries({ input });
			const deleteEntry = entries.find(entry => entry.op === "delete");
			if (deleteEntry) return { kind: "delete", paths: [deleteEntry.path] };
			const moveEntry = entries.find(entry => entry.rename);
			if (moveEntry?.rename) return { kind: "move", paths: [moveEntry.path, moveEntry.rename] };
		} catch {}
	}

	return undefined;
}

export function getPermissionIntent(
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

export function extractPermissionLocations(
	args: unknown,
	cwd: string,
	explicitPaths?: string[],
): { path: string; line?: number }[] {
	if (!args || typeof args !== "object") return [];
	const a = args as Record<string, unknown>;
	const out: { path: string; line?: number }[] = [];
	const pushPath = (value: unknown) => {
		if (typeof value !== "string" || value.length === 0) return;

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
export type RestoredQueuedMessage = { text: string; images?: ImageContent[] };
export function queuedTextContent(message: AgentMessage): string | undefined {
	if (!("content" in message)) return undefined;
	const content = message.content;
	if (typeof content === "string") return content;
	return content.find((part): part is TextContent => part.type === "text")?.text;
}

export function queuedImageContent(message: AgentMessage): ImageContent[] | undefined {
	if (!("content" in message) || typeof message.content === "string") return undefined;
	const images = message.content.filter(
		(part): part is ImageContent =>
			part.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string",
	);
	return images.length > 0 ? images : undefined;
}

export function isDisplayableQueuedMessage(message: AgentMessage): boolean {
	return !(message.role === "custom" && message.display === false);
}

export function isAdvisorCard(message: AgentMessage): message is CustomMessage {
	return message.role === "custom" && message.customType === "advisor";
}

export function isTerminalTextAssistantAnswer(message: AgentMessage | undefined): message is AssistantMessage {
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

export function isUserQueuedMessage(message: AgentMessage): boolean {
	if (message.role === "user") return true;
	return message.role === "custom" && message.attribution === "user" && message.display !== false;
}
export const MAGIC_KEYWORD_NOTICE_TYPES: ReadonlySet<string> = new Set([
	"ultrathink-notice",
	"orchestrate-notice",
	"workflow-notice",
]);

export const IMAGE_ATTACHMENT_DESCRIPTION_TYPE = "image-attachment-description";
export function isHiddenUserCompanion(message: AgentMessage): boolean {
	return (
		message.role === "custom" &&
		message.attribution === "user" &&
		message.display === false &&
		(MAGIC_KEYWORD_NOTICE_TYPES.has(message.customType) || message.customType === IMAGE_ATTACHMENT_DESCRIPTION_TYPE)
	);
}

export function queueChipText(message: AgentMessage): string {
	if (message.role === "custom") {
		return readQueueChipText(message.details) ?? queuedTextContent(message) ?? "";
	}
	const text = queuedTextContent(message) ?? "";
	if (text) return text;
	return queuedImageContent(message) ? "[Image]" : "";
}

export function toRestoredQueuedMessage(message: AgentMessage): RestoredQueuedMessage {
	return { text: queueChipText(message), images: queuedImageContent(message) };
}

export function mergeLlmCompactionPreserveData(
	hookPreserveData: Record<string, unknown> | undefined,
	resultPreserveData: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
	const preserveData = { ...(hookPreserveData ?? {}), ...(resultPreserveData ?? {}) };
	return stripLegacyArchive(Object.keys(preserveData).length > 0 ? preserveData : undefined);
}
export function obfuscateProviderPayload(value: unknown, obfuscator: SecretObfuscator | undefined): unknown {
	if (!obfuscator?.hasSecrets()) return value;
	return transformProviderPayload(value, text => obfuscator.obfuscate(text), "AgentSession provider payload", {
		safeFailureDetails: true,
	});
}
export function textFromContent(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return contentText(content as readonly ContentBlockLike[], { separator: "\n\n", trimBlocks: true });
}

export function thinkingFromContent(content: unknown): string {
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (!isRecord(block) || block.type !== "thinking" || typeof block.thinking !== "string") continue;
		const thinking = block.thinking.trim();
		if (thinking) parts.push(thinking);
	}
	return parts.join("\n\n");
}

export function toolCallOpFromMessage(message: AgentMessage, toolCallId: string): string | undefined {
	if (message.role !== "assistant" || !Array.isArray(message.content)) return undefined;
	for (const block of message.content) {
		if (!isRecord(block) || block.type !== "toolCall" || block.id !== toolCallId) continue;
		return isRecord(block.arguments) ? getStringProperty(block.arguments, "op") : undefined;
	}
	return undefined;
}

export function titleConversationTurnFromMessage(message: AgentMessage): TitleConversationTurn | undefined {
	if (message.role !== "user" && message.role !== "assistant") return undefined;
	const text = textFromContent(message.content);
	const thinking = message.role === "assistant" ? thinkingFromContent(message.content) : undefined;
	if (!text && !thinking) return undefined;
	return { role: message.role, ...(text ? { text } : {}), ...(thinking ? { thinking } : {}) };
}

export const SESSION_STOP_CONTINUATION_CAP = 8;
export const PLAN_MODE_REMINDER_MAX = 3;
export const PLAN_DECISION_TOOLS = new Set<string>([TOOL.ask, TOOL.resolve]);

export const MID_RUN_TODO_NUDGE_MUTATION_THRESHOLD = 12;

export const MID_RUN_TODO_NUDGE_MAX_PER_CYCLE = 2;

export const MID_RUN_TODO_NUDGE_MUTATING_TOOLS: Record<string, true> = {
	bash: true,
	eval: true,
	edit: true,
	write: true,
	ast_edit: true,
};

export interface PendingContextSnapshot {
	promptTokens: number;
	nonMessageTokens: number;

	cutoffCount: number;

	submitted: ReadonlySet<AgentMessage>;
	detail: SessionTelemetryDetail;
	storedMessagesTokens?: number;
	tailTokens?: number;
	compactionEntryId?: string;
}

export const MID_RUN_TODO_NUDGE_MESSAGE_TYPE = "mid-run-todo-nudge";

export const MEMORY_CONTEXT_MESSAGE_TYPE = "memory-context";

export const SESSION_STATE_MESSAGE_TYPE = "session-state";

export const PREWALK_PLAN_MESSAGE_TYPE = "prewalk-plan";

export const PREWALK_CONTINUE_MESSAGE_TYPE = "prewalk-continue";

export const PREWALK_CHECKLIST_MESSAGE_TYPE = "prewalk-checklist";

export const PREWALK_ACTION_TOOLS: Record<string, true> = {
	edit: true,
	write: true,
};

export const PLAN_YOLO_HANDOFF_MESSAGE_TYPE = "plan-yolo-handoff";

export const GEMINI_HEADER_INTERRUPT_REASON = "Interrupted: emit a tool call instead of more planning";

export const GEMINI_TOOL_REMINDER_TYPE = "gemini-tool-call-reminder";

export const THINKING_LOOP_REDIRECT_TYPE = "thinking-loop-redirect";
export const TOOL_CALL_LOOP_REDIRECT_TYPE = "tool-call-loop-redirect";

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

export const UNEXPECTED_STOP_MAX_RETRIES = 3;
export const UNEXPECTED_STOP_TIMEOUT_MS = 4000;
export const EMPTY_STOP_MAX_RETRIES = 3;
export const SHUTDOWN_CONSOLIDATE_BUDGET_MS = 1_500;

export interface AgentSessionDisposeOptions {
	mnemopiConsolidateTimeoutMs?: number;

	reason?: postmortem.Reason;
}

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

export const PRUNE_CACHE_WARM_SUFFIX_TOKENS = 8_000;

export const PRUNE_IDLE_FLUSH_MS = 90 * 60_000;

export const SHUTDOWN_DISPOSE_TIMEOUT_MS = 5_000;
export type CommandMetadataChangedListener = () => void | Promise<void>;
export type AsyncJobSnapshotItem = Pick<AsyncJob, "id" | "type" | "status" | "label" | "startTime">;

export const COMPACTION_RECOVERY_BAND = 0.8;

export const SIBLING_UNBLOCK_BUFFER_MS = 1_000;

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

export interface ActiveAdvisor {
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

export interface AdvisorRuntimeDescriptor {
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

export type RetryFallbackChains = Record<string, string[]>;

export type RetryFallbackRevertPolicy = "never" | "cooldown-expiry";

export interface ActiveRetryFallbackState {
	role: string;
	originalSelector: string;
	originalThinkingLevel: ConfiguredThinkingLevel | undefined;
	lastAppliedFallbackThinkingLevel: ConfiguredThinkingLevel | undefined;
	pinned: boolean;
}

export const noOpUIContext: ExtensionUIContext = {
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

export const PERMISSION_REQUIRED_TOOLS = new Set([TOOL.bash, TOOL.edit, "delete", "move"]);

export const PERMISSION_OPTIONS: ClientBridgePermissionOption[] = [
	{ optionId: "allow_once", name: "Allow once", kind: "allow_once" },
	{ optionId: "allow_always", name: "Always allow", kind: "allow_always" },
	{ optionId: "reject_once", name: "Reject", kind: "reject_once" },
	{ optionId: "reject_always", name: "Always reject", kind: "reject_always" },
];

export const PERMISSION_OPTIONS_BY_ID = new Map(PERMISSION_OPTIONS.map(option => [option.optionId, option]));

export type MessageEndPersistenceSlot = {
	readonly promise: Promise<void>;
	persist: (persistMessage: () => void) => Promise<void>;
	release: () => void;
};
export type PendingRecoveredRetryError = {
	entryId: string;
	persistenceKey: string;
	recovery: AssistantRetryRecoveryKind;
	attempt: number;
	note: string;
};

export type PostPromptSkipReason = "aborted" | "stale-generation";

export type AgentContinueSkipReason =
	| PostPromptSkipReason
	| "session-unavailable"
	| "should-continue-false"
	| "post-restore-unavailable";

export type ScheduledAgentContinueOptions = {
	delayMs?: number;
	generation?: number;
	shouldContinue?: () => boolean;
	onSkip?: (reason: AgentContinueSkipReason) => void;
	onError?: () => void;
};

export const REPLAN_TITLE_CONTEXT_TURN_LIMIT = 6;

export type SessionNameTrigger = "replan";
export type SetSessionNameWithTrigger = (
	name: string,
	source?: SessionTitleSource,
	trigger?: SessionNameTrigger,
) => Promise<boolean>;
