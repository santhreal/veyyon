/**
 * Context compaction for long sessions.
 *
 * Pure functions for compaction logic. The session manager handles I/O,
 * and after compaction the session is reloaded.
 */

import type {
	Api,
	ApiKey,
	AssistantMessage,
	CodexCompactionContext,
	Context,
	FetchImpl,
	Message,
	MessageAttribution,
	Model,
	ProviderSessionState,
	SimpleStreamOptions,
	Tool,
	Usage,
} from "@veyyon/ai";
import { withAuth } from "@veyyon/ai/auth-retry";
import { ProviderHttpError } from "@veyyon/ai/error";
import { createOpenAICodexCompactionRequestContext } from "@veyyon/ai/providers/openai-codex-responses";
import { Effort } from "@veyyon/catalog/effort";
import { preferredDialect } from "@veyyon/catalog/identity";
import { clampThinkingLevelForModel } from "@veyyon/catalog/model-thinking";
import { logger, prompt } from "@veyyon/utils";
import { instrumentedCompleteSimple } from "../instrumented-complete";
import { AGENT_PROMPTS } from "../prompts/registry";
import type { AgentTelemetry } from "../telemetry";
import { ThinkingLevel } from "../thinking";
import { countTokens } from "../tokenizer";
import type { AgentMessage } from "../types";
import {
	buildCacheAlignedCompactionContext,
	canUseCacheAlignedCompaction,
	estimateCacheAlignedRequestTokens,
} from "./cache-aligned-context";
import type { CompactionEntry, SessionEntry } from "./entries";
import { CompactionCancelledError } from "./errors";
import { LEGACY_REMOTE_PRESERVE_KEYS } from "./legacy-provider-native";
import { hasLegacyArchive, legacyArchiveSourceText, stripLegacyArchive } from "./legacy-snapcompact-archive";
import { type ConvertToLlm, createBranchSummaryMessage, createCustomMessage, defaultConvertToLlm } from "./messages";
import { requestRemoteCompaction } from "./remote-summarizer";
import { stripRemoteCompactionPreserveData } from "./remote-compaction-entry";
// The trigger decision moved to the module whose header owns it, and is re-exported below so no caller
// changed. What is left here is the ENGINE: the summarizer, the cut point, the provider round trip.
import { type CompactionSettings, DEFAULT_RESERVE_TOKENS } from "./threshold";
// The estimator moved to the module whose header owns it, and is re-exported below so no caller changed.
import { estimateTokens } from "./token-estimate";

export {
	type CompactionSettings,
	DEFAULT_COMPACTION_SETTINGS,
	DEFAULT_RESERVE_TOKENS,
	effectiveReserveTokens,
	isThresholdTokensClampedForWindow,
	resolveBudgetReserveTokens,
	resolveThresholdTokens,
	resolveThresholdWithOrigin,
	shouldCompact,
} from "./threshold";

/**
 * Re-exported from `./token-estimate`, which owns it.
 *
 * Three modules in this directory want the estimate and nothing else from this file, which reaches 395
 * modules; they name the leaf. This keeps the name every caller outside the directory already imports.
 */
export { estimateTokens } from "./token-estimate";

import {
	computeFileLists,
	createFileOps,
	extractFileOpsFromMessages,
	type FileOperations,
	SUMMARIZATION_SYSTEM_PROMPT,
	serializeConversationForSummary,
	stripReadSelector,
	transformMessagesForSummary,
	upsertFileOperations,
} from "./utils";

// ============================================================================
// File Operation Tracking
// ============================================================================

/** Details stored in CompactionEntry.details for file tracking */
export interface CompactionDetails {
	readFiles: string[];
	modifiedFiles: string[];
}

/**
 * Extract file operations from messages and previous compaction entries.
 */
function extractFileOperations(
	messages: AgentMessage[],
	entries: SessionEntry[],
	prevCompactionIndex: number,
): FileOperations {
	const fileOps = createFileOps();

	// Collect from previous compaction's details (if pi-generated)
	if (prevCompactionIndex >= 0) {
		const prevCompaction = entries[prevCompactionIndex] as CompactionEntry;
		if (!prevCompaction.fromExtension && prevCompaction.details) {
			const details = prevCompaction.details as CompactionDetails;
			if (Array.isArray(details.readFiles)) {
				for (const f of details.readFiles) fileOps.read.add(stripReadSelector(f));
			}
			if (Array.isArray(details.modifiedFiles)) {
				for (const f of details.modifiedFiles) fileOps.edited.add(f);
			}
		}
	}

	// Extract from tool calls in messages
	extractFileOpsFromMessages(messages, fileOps);

	return fileOps;
}

// ============================================================================
// Message Extraction
// ============================================================================

/**
 * Extract AgentMessage from an entry if it produces one.
 * Returns undefined for entries that don't contribute to LLM context.
 */
function getMessageFromEntry(
	entry: SessionEntry,
	excludedCustomMessageTypes?: ReadonlySet<string>,
): AgentMessage | undefined {
	if (entry.type === "message") {
		return entry.message;
	}
	if (entry.type === "custom_message") {
		if (excludedCustomMessageTypes?.has(entry.customType)) return undefined;
		return createCustomMessage(
			entry.customType,
			entry.content,
			entry.display,
			entry.details,
			entry.timestamp,
			entry.attribution,
		);
	}
	if (entry.type === "branch_summary") {
		return createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp);
	}
	return undefined;
}

/** Result from compact() - SessionManager adds uuid/parentUuid when saving */
export interface CompactionResult<T = unknown> {
	summary: string;
	/**
	 * Short PR-style summary, display only: it is the session-listing title
	 * fallback (`title: header.title ?? shortSummary`) and rides the collab and
	 * share projections. `compact()` no longer produces one, because a second
	 * model request for display text doubles compaction input cost and veyyon
	 * titles sessions from its own tiny-model titler instead. Compaction hooks
	 * and sessions written before that change still supply it, so every reader
	 * stays.
	 */
	shortSummary?: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	/** Hook-specific data (e.g., ArtifactIndex, version markers for structured compaction) */
	details?: T;
	/** Hook-provided data to persist alongside compaction entry. */
	preserveData?: Record<string, unknown>;
}

// ============================================================================
// Types
// ============================================================================

// ============================================================================
// Token calculation
// ============================================================================

/**
 * Calculate total context tokens from usage.
 * Uses the native totalTokens field when available, falls back to computing from components.
 * Provider-side orchestration tokens are billable but never replay into the
 * conversation prefix, so they are excluded from context sizing to keep
 * auto-compaction and context-promotion thresholds honest.
 */
export function calculateContextTokens(usage: Usage): number {
	const orchestration = usage.orchestration;
	const orchestrationTotal = orchestration
		? (orchestration.input ?? 0) + (orchestration.output ?? 0) + (orchestration.cacheRead ?? 0)
		: 0;
	const raw = usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
	return Math.max(0, raw - orchestrationTotal);
}

export function calculatePromptTokens(usage: Usage): number {
	const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
	if (promptTokens > 0) {
		return promptTokens;
	}
	return calculateContextTokens(usage);
}

/**
 * Get usage from an assistant message if available.
 * Skips aborted and error messages as they don't have valid usage data.
 */
function getAssistantUsage(msg: AgentMessage): Usage | undefined {
	if (msg.role === "assistant" && "usage" in msg) {
		const assistantMsg = msg as AssistantMessage;
		if (assistantMsg.stopReason !== "aborted" && assistantMsg.stopReason !== "error" && assistantMsg.usage) {
			return assistantMsg.usage;
		}
	}
	return undefined;
}

/**
 * Find the last non-aborted assistant message usage from session entries.
 */
export function getLastAssistantUsage(entries: SessionEntry[]): Usage | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "message") {
			const usage = getAssistantUsage(entry.message);
			if (usage) return usage;
		}
	}
	return undefined;
}

/**
 * Context tokens to feed the compaction decision, floored by a local estimate of
 * the stored conversation.
 *
 * The provider-reported usage is normally ground truth, but a
 * `before_provider_request` payload transform — a compression extension (e.g.
 * Headroom) or an obfuscator — can shrink the request below
 * the real stored conversation. The provider then reports deflated prompt
 * tokens, so anchoring compaction purely on that usage lets the real history
 * grow unbounded until it overflows and native compaction can no longer run.
 * Flooring by the agent's own estimate of the stored conversation keeps the
 * compaction trigger honest regardless of on-wire compression. (Display/cost
 * accounting still uses the exact provider usage; only the compaction decision
 * takes the floor.)
 */
export function compactionContextTokens(providerContextTokens: number, storedConversationEstimate: number): number {
	return Math.max(Math.max(0, providerContextTokens), Math.max(0, storedConversationEstimate));
}

// ============================================================================
// Cut point detection
// ============================================================================
function estimateEntriesTokens(entries: SessionEntry[], startIndex: number, endIndex: number): number {
	let total = 0;
	for (let i = startIndex; i < endIndex; i++) {
		const msg = getMessageFromEntry(entries[i]);
		if (msg) {
			total += estimateTokens(msg);
		}
	}
	return total;
}

/**
 * Find valid cut points: indices of user, assistant, custom, or bashExecution messages.
 * Never cut at tool results (they must follow their tool call).
 * When we cut at an assistant message with tool calls, its tool results follow it
 * and will be kept.
 * BashExecutionMessage is treated like a user message (user-initiated context).
 */
function findValidCutPoints(entries: SessionEntry[], startIndex: number, endIndex: number): number[] {
	const cutPoints: number[] = [];
	for (let i = startIndex; i < endIndex; i++) {
		const entry = entries[i];
		switch (entry.type) {
			case "message": {
				const role = entry.message.role as string;
				switch (role) {
					case "bashExecution":
					case "hookMessage":
					case "branchSummary":
					case "compactionSummary":
					case "user":
					case "assistant":
						cutPoints.push(i);
						break;
					case "toolResult":
						break;
				}
				break;
			}
			case "thinking_level_change":
			case "model_change":
			case "compaction":
			case "branch_summary":
			case "custom":
			case "custom_message":
			case "label":
		}
		// branch_summary and custom_message are user-role messages, valid cut points
		if (entry.type === "branch_summary" || entry.type === "custom_message") {
			cutPoints.push(i);
		}
	}
	return cutPoints;
}

/**
 * Find the user message (or bashExecution) that starts the turn containing the given entry index.
 * Returns -1 if no turn start found before the index.
 * BashExecutionMessage is treated like a user message for turn boundaries.
 */
export function findTurnStartIndex(entries: SessionEntry[], entryIndex: number, startIndex: number): number {
	for (let i = entryIndex; i >= startIndex; i--) {
		const entry = entries[i];
		// branch_summary and custom_message are user-role messages, can start a turn
		if (entry.type === "branch_summary" || entry.type === "custom_message") {
			return i;
		}
		if (entry.type === "message") {
			const role = entry.message.role as string;
			if (role === "user" || role === "bashExecution") {
				return i;
			}
		}
	}
	return -1;
}

export interface CutPointResult {
	/** Index of first entry to keep */
	firstKeptEntryIndex: number;
	/** Index of user message that starts the turn being split, or -1 if not splitting */
	turnStartIndex: number;
	/** Whether this cut splits a turn (cut point is not a user message) */
	isSplitTurn: boolean;
}

/**
 * Find the cut point in session entries that keeps approximately `keepRecentTokens`.
 *
 * Algorithm: Walk backwards from newest, accumulating estimated message sizes.
 * Stop when we've accumulated >= keepRecentTokens. Cut at that point.
 *
 * Can cut at user OR assistant messages (never tool results). When cutting at an
 * assistant message with tool calls, its tool results come after and will be kept.
 *
 * Returns CutPointResult with:
 * - firstKeptEntryIndex: the entry index to start keeping from
 * - turnStartIndex: if cutting mid-turn, the user message that started that turn
 * - isSplitTurn: whether we're cutting in the middle of a turn
 *
 * Only considers entries between `startIndex` and `endIndex` (exclusive).
 */
export function findCutPoint(
	entries: SessionEntry[],
	startIndex: number,
	endIndex: number,
	keepRecentTokens: number,
): CutPointResult {
	const cutPoints = findValidCutPoints(entries, startIndex, endIndex);

	if (cutPoints.length === 0) {
		return { firstKeptEntryIndex: startIndex, turnStartIndex: -1, isSplitTurn: false };
	}

	// Walk backwards from newest, accumulating estimated message sizes
	let accumulatedTokens = 0;
	let cutIndex = cutPoints[0]; // Default: keep from first message (not header)
	let crossedIndex = -1; // Entry whose tokens first pushed the tally over budget

	for (let i = endIndex - 1; i >= startIndex; i--) {
		const entry = entries[i];
		const message = getMessageFromEntry(entry);
		if (!message) continue;

		// Estimate this message's size. branch_summary and custom_message
		// entries stay in the retained tail, so their tokens must count
		// toward the recent budget too.
		const messageTokens = estimateTokens(message);
		accumulatedTokens += messageTokens;

		// Check if we've exceeded the budget
		if (accumulatedTokens >= keepRecentTokens) {
			crossedIndex = i;
			// Find the closest valid cut point at or after this entry
			let found = false;
			for (let c = 0; c < cutPoints.length; c++) {
				if (cutPoints[c] >= i) {
					cutIndex = cutPoints[c];
					found = true;
					break;
				}
			}
			// No valid cut point at or after the crossing entry. That happens when the
			// budget is blown inside the newest turn — one enormous final tool result
			// is enough — and the default `cutPoints[0]` means "keep from the very
			// first message", so the whole session would be kept and `prepareCompaction`
			// would return undefined. Compaction would then do NOTHING at precisely the
			// moment the session is most over budget, and silently. Fall back to the
			// newest valid cut point instead: it keeps the least while still landing on
			// a boundary that never separates a tool call from its result.
			if (!found) cutIndex = cutPoints[cutPoints.length - 1];
			break;
		}
	}

	// Scan backwards from cutIndex to include any non-message entries (bash, settings, etc.)
	while (cutIndex > startIndex) {
		const prevEntry = entries[cutIndex - 1];
		// Stop at session header or compaction boundaries
		if (prevEntry.type === "compaction") {
			break;
		}
		if (prevEntry.type === "message") {
			// Stop if we hit any message
			break;
		}
		// Include this non-message entry (bash, settings change, etc.)
		cutIndex--;
	}

	// Dead-end guard: if the budget was crossed only at the oldest entry and the
	// cut (plus the backward sweep) would keep the entire range, compaction has
	// nothing to summarize and dead-ends. Cut strictly after the crossing entry
	// instead: the over-budget entry gets summarized and the kept tail stays
	// within budget. Only applies when a later cut point exists.
	if (cutIndex === startIndex && crossedIndex === startIndex) {
		for (let c = 0; c < cutPoints.length; c++) {
			if (cutPoints[c] > crossedIndex) {
				cutIndex = cutPoints[c];
				break;
			}
		}
	}

	// Determine if this is a split turn
	const cutEntry = entries[cutIndex];
	const isUserMessage = cutEntry.type === "message" && cutEntry.message.role === "user";
	const turnStartIndex = isUserMessage ? -1 : findTurnStartIndex(entries, cutIndex, startIndex);

	return {
		firstKeptEntryIndex: cutIndex,
		turnStartIndex,
		isSplitTurn: !isUserMessage && turnStartIndex !== -1,
	};
}

// ============================================================================
// Summarization
// ============================================================================

const SUMMARIZATION_PROMPT = prompt.render(AGENT_PROMPTS["compaction/compaction-summary"].text);

const UPDATE_SUMMARIZATION_PROMPT = prompt.render(AGENT_PROMPTS["compaction/compaction-update-summary"].text);

const HANDOFF_DOCUMENT_PROMPT = prompt.render(AGENT_PROMPTS["compaction/handoff-document"].text);

export const AUTO_HANDOFF_THRESHOLD_FOCUS = prompt.render(
	AGENT_PROMPTS["compaction/auto-handoff-threshold-focus"].text,
);

function formatAdditionalContext(context: string[] | undefined): string {
	if (!context || context.length === 0) return "";
	const lines = context.map(line => `- ${line}`).join("\n");
	return `<additional-context>\n${lines}\n</additional-context>\n\n`;
}

/**
 * Maps the non-special `ThinkingLevel` values to their `Effort` counterparts.
 * Exhaustive over the union; throws for `Off`/`Inherit` to surface logic
 * errors in callers that forgot to filter those out. Never use a TS cast for
 * this — `ThinkingLevel` is a string-union over distinct concepts (Off /
 * Inherit are not Efforts), and a cast hides the contract.
 */
function effortFromThinkingLevel(level: ThinkingLevel): Effort {
	switch (level) {
		case ThinkingLevel.Minimal:
			return Effort.Minimal;
		case ThinkingLevel.Low:
			return Effort.Low;
		case ThinkingLevel.Medium:
			return Effort.Medium;
		case ThinkingLevel.High:
			return Effort.High;
		case ThinkingLevel.XHigh:
			return Effort.XHigh;
		case ThinkingLevel.Max:
			return Effort.Max;
		case ThinkingLevel.Off:
		case ThinkingLevel.Inherit:
			throw new Error(`effortFromThinkingLevel: ${level} must be handled by caller`);
	}
}

/**
 * Resolves the reasoning effort to send on a compaction LLM call.
 *
 * - Explicit `Off` → `undefined` (omit reasoning entirely; the user said no thinking).
 * - `undefined` / `Inherit` → historical `Effort.High` default → clamped per model
 *   (preserves current behavior for users who never touched the dial).
 * - Explicit effort → respect user choice → clamped per model.
 *
 * The clamp routes through `clampThinkingLevelForModel`, which returns
 * `undefined` for reasoning models without a thinking config — the build-time
 * encoding of `compat.supportsReasoningEffort: false` (e.g.
 * `xai-oauth/grok-4.20-0309-reasoning`). That `undefined` then flows through to the
 * openai-responses mapper, which omits the wire param — no
 * `requireSupportedEffort` throw.
 */
function resolveCompactionEffort(model: Model, level: ThinkingLevel | undefined): Effort | undefined {
	if (level === ThinkingLevel.Off) return undefined;
	const requested: Effort =
		level === undefined || level === ThinkingLevel.Inherit ? Effort.High : effortFromThinkingLevel(level);
	const clamped = clampThinkingLevelForModel(model, requested);
	if (clamped !== requested) {
		logger.warn("Compaction effort is not accepted by the model; using the nearest supported level", {
			model: `${model.provider}/${model.id}`,
			requested,
			using: clamped ?? "provider default",
		});
	}
	return clamped;
}

/**
 * Build the error thrown when an LLM summarization call ends with
 * `stopReason === "error"`. Carries the provider's HTTP `errorStatus`
 * onto a top-level `.status` field so callers (notably
 * `AgentSession.#isCompactionAuthFailure`) can branch on 401/403 without
 * regex-scraping `error.message`. The `auth_unavailable` synthetic
 * (pi-native gateway) does not populate `errorStatus`, hence the legacy
 * message-based check is still required upstream — see issue #986.
 */
function createSummarizationError(prefix: string, response: AssistantMessage, options?: SummaryOptions): Error {
	const rawDetail = response.errorMessage || "Unknown error";
	const detail = options ? sanitizeCompactionProviderText(rawDetail, options) : rawDetail;
	const text = `${prefix}: ${detail}`;
	return response.errorStatus === undefined ? new Error(text) : new ProviderHttpError(text, response.errorStatus);
}

function shouldRetryHandoffWithAutoToolChoice(response: AssistantMessage): boolean {
	if (response.errorStatus !== 400) return false;
	const message = response.errorMessage ?? "";
	return /\btool_choice\b/i.test(message) && /\bauto\b/i.test(message) && /\bsupported\b/i.test(message);
}

/**
 * Generate a summary of the conversation using the LLM.
 * If previousSummary is provided, uses the update prompt to merge.
 */
export interface SummaryOptions {
	promptOverride?: string;
	extraContext?: string[];
	remoteEndpoint?: string;
	remoteInstructions?: string;
	initiatorOverride?: MessageAttribution;
	metadata?: Record<string, unknown>;
	convertToLlm?: ConvertToLlm;
	/**
	 * Optional telemetry handle. When provided, every LLM call emitted during
	 * compaction is wrapped in an OTEL chat span tagged with
	 * `pi.gen_ai.oneshot.kind` (`compaction_summary` or
	 * `compaction_turn_prefix`). `undefined` keeps the call paths zero-cost.
	 */
	telemetry?: AgentTelemetry;
	/**
	 * Active session thinking level. Threaded from `agent-session.ts` so
	 * compaction honors the user's `/model` thinking selection instead of
	 * silently overriding it with `Effort.High` (the historical default).
	 * `undefined` / `ThinkingLevel.Inherit` falls back to that historical
	 * default; `ThinkingLevel.Off` omits reasoning entirely. See
	 * `resolveCompactionEffort` for the conversion contract.
	 */
	thinkingLevel?: ThinkingLevel;
	/** Session routing key for remote compaction transports with sticky provider sessions. */
	sessionId?: string;
	/** Prompt-cache key for remote compaction transports that support provider prefix caching. */
	promptCacheKey?: string;
	/** Mutable provider state used to keep Codex compaction on the live session identity. */
	providerSessionState?: Map<string, ProviderSessionState>;
	/** Classification shared by every provider request in this logical compaction. */
	codexCompaction?: CodexCompactionContext;
	/** Provider-visible tools for remote compaction transports that replay native tool history. */
	tools?: Tool[];
	/**
	 * The live session's system prompt. Threaded from `agent-session.ts` so the
	 * summarization request can replay the prefix the provider has already cached
	 * for this session instead of paying fresh input for a re-serialized copy of
	 * it. Absent (the default) keeps the historical request shape exactly: a
	 * standalone `SUMMARIZATION_SYSTEM_PROMPT` request over truncated text. See
	 * `./cache-aligned-context`.
	 */
	sessionSystemPrompt?: string[];
	/**
	 * The live provider-visible message array, the second half of the same
	 * plumbing. It is the WHOLE array, not the span being discarded: our
	 * message-side cache breakpoints sit on the trailing messages, so a request
	 * that stops at the cut point diverges before any breakpoint and misses.
	 */
	sessionMessages?: Message[];
	/** Optional fetch implementation threaded into remote compaction calls. */
	fetch?: FetchImpl;
	/**
	 * Live final-seam transform for provider-bound compaction text. It is
	 * intentionally invoked after credential resolution for every physical
	 * attempt; callers must resolve their current secret runtime inside it.
	 */
	obfuscateProviderText?: (text: string) => string;
	/**
	 * Optional completion transport override for host-level request wrappers
	 * (e.g. the coding-agent provider-concurrency limiter). When provided,
	 * every local summarization oneshot (`generateSummary` and
	 * `generateTurnPrefixSummary`) routes through it
	 * instead of the default `completeSimple`, so cap policies enforced on
	 * the live agent turn also bracket compaction HTTP requests.
	 */
	completeImpl?: <TApi extends Api>(
		model: Model<TApi>,
		ctx: Context,
		options: SimpleStreamOptions,
	) => Promise<AssistantMessage>;
}

function localCodexCompaction(options: SummaryOptions | undefined) {
	return createOpenAICodexCompactionRequestContext({
		context: options?.codexCompaction,
		implementation: "responses",
	});
}

function sanitizeCompactionProviderText(text: string, options: SummaryOptions | undefined): string {
	const transform = options?.obfuscateProviderText;
	if (!transform) return text;
	try {
		const sanitized = transform(text);
		if (typeof sanitized !== "string") throw new TypeError("invalid transform result");
		return sanitized;
	} catch {
		// Fail closed without reflecting the provider-bound text (or a transform
		// error that may quote it) into logs/UI.
		throw new Error("Compaction provider payload sanitization failed");
	}
}

function transformSummarySourceMessages(messages: Message[], options: SummaryOptions | undefined): Message[] {
	if (!options?.obfuscateProviderText) return messages;
	return transformMessagesForSummary(messages, text => sanitizeCompactionProviderText(text, options));
}

function throwIfCompactionCancelled(response: AssistantMessage): void {
	if (response.stopReason === "aborted") throw new CompactionCancelledError();
}

function buildCompactionProviderContext(
	systemPrompt: string,
	promptText: string,
	options: SummaryOptions | undefined,
): Context {
	// Keep authenticated provider replay state out of this transform. Only the
	// newly-authored textual request is sanitized; options.providerSessionState
	// is passed separately and remains byte-for-byte opaque.
	return {
		systemPrompt: [sanitizeCompactionProviderText(systemPrompt, options)],
		messages: [
			{
				role: "user",
				content: [{ type: "text", text: sanitizeCompactionProviderText(promptText, options) }],
				timestamp: Date.now(),
			},
		],
	};
}

function formatLegacyArchiveText(archiveText: string): string {
	return prompt.render(AGENT_PROMPTS["compaction/legacy-archive-context"].text, { archiveText });
}

function mergePreviousSummaryWithLegacyArchive(
	previousSummary: string | undefined,
	archiveText: string | undefined,
): string | undefined {
	if (!archiveText) return previousSummary;
	const archiveSummary = formatLegacyArchiveText(archiveText);
	return previousSummary ? `${previousSummary}\n\n${archiveSummary}` : archiveSummary;
}

function buildSummaryPrompt(
	currentMessages: AgentMessage[],
	model: Model,
	reserveTokens: number,
	customInstructions: string | undefined,
	previousSummary: string | undefined,
	options: SummaryOptions | undefined,
	cacheAligned: boolean,
): { promptText: string; maxTokens: number } {
	let basePrompt = previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT;
	if (options?.promptOverride) basePrompt = options.promptOverride;
	if (customInstructions) basePrompt = `${basePrompt}\n\nAdditional focus: ${customInstructions}`;

	// Cache-aligned mode replays the conversation as real messages and hands the
	// system slot back to the session, so nothing is re-serialized here and the
	// summarizer framing rides in the appended user turn instead.
	const conversationText = cacheAligned
		? undefined
		: serializeConversationForSummary(
				transformSummarySourceMessages((options?.convertToLlm ?? defaultConvertToLlm)(currentMessages), options),
				preferredDialect(model.id),
			);
	let promptText =
		conversationText === undefined
			? `${SUMMARIZATION_SYSTEM_PROMPT}\n\n`
			: `<conversation>\n${conversationText}\n</conversation>\n\n`;
	if (previousSummary) promptText += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`;
	promptText += formatAdditionalContext(options?.extraContext);
	promptText += basePrompt;
	return { promptText, maxTokens: Math.floor(0.8 * reserveTokens) };
}

export async function generateSummary(
	currentMessages: AgentMessage[],
	model: Model,
	reserveTokens: number,
	apiKey: ApiKey,
	signal?: AbortSignal,
	customInstructions?: string,
	previousSummary?: string,
	options?: SummaryOptions,
): Promise<string> {
	const sessionSystemPrompt = options?.sessionSystemPrompt;
	const sessionMessages = options?.sessionMessages;
	const cacheAligned = canUseCacheAlignedCompaction({ model, sessionSystemPrompt, sessionMessages });
	const { promptText, maxTokens } = buildSummaryPrompt(
		currentMessages,
		model,
		reserveTokens,
		customInstructions,
		previousSummary,
		options,
		cacheAligned,
	);

	if (options?.remoteEndpoint) {
		const endpoint = options.remoteEndpoint;
		const remote = await withAuth(
			apiKey,
			key => {
				// withAuth invokes this closure only after each credential
				// resolution/refresh, making this the last textual boundary before
				// every remote fetch attempt.
				const request = {
					systemPrompt: sanitizeCompactionProviderText(SUMMARIZATION_SYSTEM_PROMPT, options),
					prompt: sanitizeCompactionProviderText(promptText, options),
				};
				return requestRemoteCompaction(endpoint, request, signal, {
					fetch: options.fetch,
					model,
					apiKey: key,
					sanitizeErrorText: text => sanitizeCompactionProviderText(text, options),
				});
			},
			{ signal, missingKeyMessage: "Remote compaction credentials unavailable" },
		);
		return remote.summary;
	}

	const response = await withAuth(
		apiKey,
		async key => {
			// Build a fresh context inside the auth-attempt closure. A runtime
			// changed while credentials refreshed therefore governs this send.
			const attemptResponse = await instrumentedCompleteSimple(
				model,
				cacheAligned && sessionSystemPrompt && sessionMessages
					? buildCacheAlignedCompactionContext({
							sessionSystemPrompt,
							sessionMessages,
							tools: options?.tools,
							instruction: promptText,
							sanitize: text => sanitizeCompactionProviderText(text, options),
						})
					: buildCompactionProviderContext(SUMMARIZATION_SYSTEM_PROMPT, promptText, options),
				{
					maxTokens,
					signal,
					apiKey: key,
					reasoning: resolveCompactionEffort(model, options?.thinkingLevel),
					initiatorOverride: options?.initiatorOverride,
					metadata: options?.metadata,
					fetch: options?.fetch,
					sessionId: options?.sessionId,
					promptCacheKey: options?.promptCacheKey,
					providerSessionState: options?.providerSessionState,
					codexCompaction: localCodexCompaction(options),
				},
				{ telemetry: options?.telemetry, oneshotKind: "compaction_summary", completeImpl: options?.completeImpl },
			);
			throwIfCompactionCancelled(attemptResponse);
			if (attemptResponse.stopReason === "error") {
				throw createSummarizationError("Summarization failed", attemptResponse, options);
			}
			return attemptResponse;
		},
		{ signal },
	);

	const textContent = response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map(c => c.text)
		.join("\n");

	// An empty summary is never valid, and it is far worse than a failed request:
	// the summary REPLACES the history it summarizes, so storing an empty one
	// deletes the conversation and reports success. A model can reach this with
	// `stopReason: "stop"` by spending its whole budget on reasoning and emitting
	// no text, which was observed live on the handoff path. Fail loudly instead.
	if (textContent.trim().length === 0) {
		throw new Error(
			`Summarization returned an empty summary (stopReason: ${response.stopReason}). ` +
				`The history was NOT compacted. Retry, or lower the compaction thinking level so the ` +
				`model spends its budget on the summary instead of reasoning.`,
		);
	}

	return textContent;
}

// ============================================================================
// Handoff generation
// ============================================================================

export interface HandoffOptions {
	/** Live agent system prompt — passed verbatim so providers hit the cached prefix. */
	systemPrompt: string[];
	/** Live agent tool list — same purpose. Forced to `toolChoice: "none"`. */
	tools?: Tool[];
	customInstructions?: string;
	convertToLlm?: ConvertToLlm;
	initiatorOverride?: MessageAttribution;
	metadata?: Record<string, unknown>;
	/**
	 * File operations to append as a deterministic `<files>` block, exactly as
	 * the `summary` strategy does. This costs no LLM work and is byte-identical
	 * across models, so withholding it from handoff only made handoff worse:
	 * measured on identical input, a handoff carried 9 file paths where the
	 * summary of the same history carried 15. Omit only when the caller has no
	 * file operations to report.
	 */
	fileOps?: FileOperations;
	/**
	 * Optional telemetry handle. When provided, the handoff LLM call is
	 * wrapped in an OTEL chat span tagged with `pi.gen_ai.oneshot.kind = "handoff"`.
	 */
	telemetry?: AgentTelemetry;
	/**
	 * Active session thinking level. Threaded from `agent-session.ts` so
	 * handoff generation honors the user's `/model` thinking selection
	 * instead of silently overriding it with `Effort.High`. See
	 * `resolveCompactionEffort` for the conversion contract.
	 */
	thinkingLevel?: ThinkingLevel;
	/**
	 * Optional completion override, forwarded to `generateHandoffFromContext`.
	 * `SummaryOptions` has always carried one, so without it here a caller could
	 * instrument or stub the summary strategy but not the handoff strategy, and
	 * any measurement comparing the two would silently cover only one side.
	 */
	completeImpl?: <TApi extends Api>(
		model: Model<TApi>,
		ctx: Context,
		options: SimpleStreamOptions,
	) => Promise<AssistantMessage>;
}

export function renderHandoffPrompt(customInstructions?: string): string {
	if (!customInstructions) return HANDOFF_DOCUMENT_PROMPT;
	return prompt.render(AGENT_PROMPTS["compaction/handoff-document"].text, {
		additionalFocus: customInstructions,
	});
}

export interface HandoffFromContextOptions {
	/**
	 * Stream options mirrored from the live agent turn: `apiKey`, `signal`, the
	 * `sessionId`/`promptCacheKey` cache-routing pair, `serviceTier`, and the
	 * session's payload/response hooks. Sending the same routing + payload shape
	 * the main loop uses is what lets the handoff oneshot READ the provider
	 * prompt cache the live turn populated instead of cold-missing the whole
	 * prefix. `reasoning` and `toolChoice` are set internally and override
	 * anything provided here.
	 */
	streamOptions: SimpleStreamOptions;
	/** Optional completion transport override for host-level request wrappers. */
	completeImpl?: <TApi extends Api>(
		model: Model<TApi>,
		ctx: Context,
		options: SimpleStreamOptions,
	) => Promise<AssistantMessage>;
	/** See {@link HandoffOptions.telemetry}. */
	telemetry?: AgentTelemetry;
	/** See {@link HandoffOptions.thinkingLevel}. */
	thinkingLevel?: ThinkingLevel;
}

/**
 * Run the handoff oneshot against a fully-built provider {@link Context}.
 *
 * The caller assembles `context` exactly like a live agent turn — same system
 * prompt, normalized tools, transformed + obfuscated message history, with the
 * trailing handoff-prompt message already appended — and supplies
 * `streamOptions` that mirror the live turn's cache routing. That keeps the
 * cache-preserving context construction in the host (which owns the transform
 * pipeline) while this function centralizes the handoff request contract:
 * cache-first `toolChoice: "none"`, clamped reasoning effort, one retry for
 * auto-only `tool_choice` providers, oneshot telemetry, text-only extraction,
 * and provider-error mapping.
 */
export async function generateHandoffFromContext(
	context: Context,
	model: Model,
	options: HandoffFromContextOptions,
): Promise<string> {
	const requestOptions = {
		...options.streamOptions,
		reasoning: resolveCompactionEffort(model, options.thinkingLevel),
		toolChoice: "none" as const,
	};
	let response = await instrumentedCompleteSimple(model, context, requestOptions, {
		telemetry: options.telemetry,
		oneshotKind: "handoff",
		completeImpl: options.completeImpl,
	});
	if (response.stopReason === "error" && shouldRetryHandoffWithAutoToolChoice(response)) {
		response = await instrumentedCompleteSimple(
			model,
			context,
			{ ...requestOptions, toolChoice: "auto" },
			{ telemetry: options.telemetry, oneshotKind: "handoff", completeImpl: options.completeImpl },
		);
	}

	throwIfCompactionCancelled(response);
	if (response.stopReason === "error") {
		throw createSummarizationError("Handoff generation failed", response);
	}

	const document = response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map(c => c.text)
		.join("\n");

	// An empty document is never a valid handoff, and returning one is the worst
	// possible failure mode: the caller appends the deterministic `<files>` block,
	// the result looks like a real document, and the new session starts with a
	// file list and no goal, no decisions, and no next step. Observed live against
	// gemini-3.6-flash, which spent its budget on reasoning and emitted no text
	// while reporting `stopReason: "stop"`. Fail loudly instead.
	if (document.trim().length === 0) {
		throw new Error(
			`Handoff generation returned an empty document (stopReason: ${response.stopReason}). ` +
				`Retry the handoff, or use the \`summary\` strategy if it keeps recurring.`,
		);
	}

	return document;
}

export async function generateHandoff(
	messages: AgentMessage[],
	model: Model,
	apiKey: ApiKey,
	options: HandoffOptions,
	signal?: AbortSignal,
): Promise<string> {
	const llmMessages = (options.convertToLlm ?? defaultConvertToLlm)(messages);
	const requestMessages: Message[] = [
		...llmMessages,
		{
			role: "user",
			content: [{ type: "text", text: renderHandoffPrompt(options.customInstructions) }],
			attribution: "agent",
			timestamp: Date.now(),
		},
	];

	const document = await generateHandoffFromContext(
		{ systemPrompt: options.systemPrompt, messages: requestMessages, tools: options.tools },
		model,
		{
			streamOptions: {
				apiKey,
				signal,
				initiatorOverride: options.initiatorOverride,
				metadata: options.metadata,
			},
			telemetry: options.telemetry,
			thinkingLevel: options.thinkingLevel,
			completeImpl: options.completeImpl,
		},
	);

	// Same deterministic file block the summary strategy appends. Both strategies
	// hand the next turn the same map of what was touched.
	if (!options.fileOps) return document;
	const { readFiles, modifiedFiles } = computeFileLists(options.fileOps);
	return upsertFileOperations(document, readFiles, modifiedFiles, options.fileOps.read);
}

// ============================================================================
// Compaction Preparation (for hooks)
// ============================================================================

export interface CompactionPreparation {
	/** UUID of first entry to keep */
	firstKeptEntryId: string;
	/** Messages that will be summarized and discarded */
	messagesToSummarize: AgentMessage[];
	/** Messages that will be turned into turn prefix summary (if splitting) */
	turnPrefixMessages: AgentMessage[];
	/** Messages kept in full after compaction (recent history) */
	recentMessages: AgentMessage[];
	/** Whether this is a split turn (cut point in middle of turn) */
	isSplitTurn: boolean;
	tokensBefore: number;
	/** Summary from previous compaction, for iterative update */
	previousSummary?: string;
	/** Preserved opaque compaction payload from the previous compaction, if any. */
	previousPreserveData?: Record<string, unknown>;
	/** File operations extracted from messagesToSummarize */
	fileOps: FileOperations;
	/** Compaction settions from settings.jsonl	*/
	settings: CompactionSettings;
}

/**
 * Whether a prior compaction entry carries a summary this session can actually
 * use. Every compaction veyyon writes now holds real summary text, so the answer
 * is yes — except for entries left by the removed provider-native remote path,
 * whose payload is an opaque provider blob no local code can read or replay and
 * whose summary field is a placeholder. Those are never reusable: the caller
 * re-expands the original messages behind them and summarizes locally instead,
 * which is what recovers a session that was compacted by the old path.
 */
function hasReusableSummary(preserveData: Record<string, unknown> | undefined): boolean {
	if (!preserveData) return true;
	return !LEGACY_REMOTE_PRESERVE_KEYS.some(key => key in preserveData);
}

export interface CompactionPreparationOptions {
	/** Runtime-owned state messages reconstructed separately after compaction. */
	excludedCustomMessageTypes?: ReadonlySet<string>;
}

/**
 * Validate the complete result immediately before a runtime rewrites history.
 * A malformed extension result must fail before its cut point can discard the
 * live tail.
 */
export function assertValidCompactionResult(preparation: CompactionPreparation, result: CompactionResult): void {
	if (typeof result.summary !== "string" || result.summary.trim().length === 0) {
		throw new Error("Compaction failed: the generated summary is empty; history was left unchanged.");
	}
	if (result.firstKeptEntryId !== preparation.firstKeptEntryId) {
		throw new Error(
			`Compaction failed: firstKeptEntryId ${JSON.stringify(result.firstKeptEntryId)} does not match the safe cut point ${JSON.stringify(preparation.firstKeptEntryId)}; history was left unchanged.`,
		);
	}
	if (!Number.isFinite(result.tokensBefore) || result.tokensBefore < 0) {
		throw new Error(
			`Compaction failed: tokensBefore must be a finite non-negative number, received ${JSON.stringify(result.tokensBefore)}; history was left unchanged.`,
		);
	}
}

/**
 * Estimate the largest physical compaction request, including static prompts,
 * previous summaries, hook context, and the requested output budget. Candidate
 * admission uses this total because provider context windows cover input plus
 * generated output, not conversation messages alone.
 */
export function estimateCompactionRequestTokens(
	preparation: CompactionPreparation,
	model: Model,
	customInstructions?: string,
	options?: SummaryOptions,
): number {
	const reserveTokens = preparation.settings.reserveTokens ?? DEFAULT_RESERVE_TOKENS;
	const previousSummary = mergePreviousSummaryWithLegacyArchive(
		preparation.previousSummary,
		legacyArchiveSourceText(preparation.previousPreserveData),
	);
	const requests: number[] = [];
	const cacheAligned = canUseCacheAlignedCompaction({
		model,
		sessionSystemPrompt: options?.sessionSystemPrompt,
		sessionMessages: options?.sessionMessages,
	});
	const hasHistoryRequest =
		preparation.messagesToSummarize.length > 0 || (preparation.isSplitTurn && previousSummary !== undefined);
	if (hasHistoryRequest) {
		const built = buildSummaryPrompt(
			preparation.messagesToSummarize,
			model,
			reserveTokens,
			customInstructions,
			previousSummary,
			options,
			cacheAligned,
		);
		// A cache-aligned request is cheap, not small: the replayed window still
		// occupies the context window it is billed against at the cache-read rate.
		const inputTokens =
			cacheAligned && options?.sessionSystemPrompt && options?.sessionMessages
				? estimateCacheAlignedRequestTokens({
						sessionSystemPrompt: options.sessionSystemPrompt,
						sessionMessages: options.sessionMessages,
						instruction: built.promptText,
					})
				: countTokens([SUMMARIZATION_SYSTEM_PROMPT, built.promptText]);
		requests.push(inputTokens + built.maxTokens);
	}
	if (preparation.isSplitTurn && preparation.turnPrefixMessages.length > 0) {
		const llmMessages = (options?.convertToLlm ?? defaultConvertToLlm)(preparation.turnPrefixMessages);
		const conversationText = serializeConversationForSummary(
			transformSummarySourceMessages(llmMessages, options),
			preferredDialect(model.id),
		);
		const promptText = `<conversation>\n${conversationText}\n</conversation>\n\n${TURN_PREFIX_SUMMARIZATION_PROMPT}`;
		requests.push(countTokens([SUMMARIZATION_SYSTEM_PROMPT, promptText]) + Math.floor(0.5 * reserveTokens));
	}
	return requests.length > 0 ? Math.max(...requests) : 0;
}

export function prepareCompaction(
	pathEntries: SessionEntry[],
	settings: CompactionSettings,
	options?: CompactionPreparationOptions,
): CompactionPreparation | undefined {
	if (pathEntries.length > 0 && pathEntries[pathEntries.length - 1].type === "compaction") {
		return undefined;
	}

	let prevCompactionIndex = -1;
	for (let i = pathEntries.length - 1; i >= 0; i--) {
		if (pathEntries[i].type !== "compaction") continue;
		// Skip a compaction left by the removed provider-native remote path: its
		// summary is only an opaque placeholder, so re-expand its original messages
		// and summarize them locally rather than stranding that history.
		const entry = pathEntries[i] as CompactionEntry;
		if (!hasReusableSummary(entry.preserveData)) continue;
		prevCompactionIndex = i;
		break;
	}
	const boundaryStart = prevCompactionIndex + 1;
	const boundaryEnd = pathEntries.length;

	const lastUsage = getLastAssistantUsage(pathEntries);
	const tokensBefore = lastUsage ? calculateContextTokens(lastUsage) : 0;
	let keepRecentTokens = settings.keepRecentTokens;
	if (lastUsage) {
		const estimatedTokens = estimateEntriesTokens(pathEntries, boundaryStart, boundaryEnd);
		const promptTokens = calculatePromptTokens(lastUsage);
		const ratio = estimatedTokens > 0 ? promptTokens / estimatedTokens : 0;
		if (Number.isFinite(ratio) && ratio > 1) {
			keepRecentTokens = Math.max(1, Math.floor(keepRecentTokens / ratio));
		}
	}

	const cutPoint = findCutPoint(pathEntries, boundaryStart, boundaryEnd, keepRecentTokens);

	// Get ID of first kept entry
	const firstKeptEntry = pathEntries[cutPoint.firstKeptEntryIndex];
	if (!firstKeptEntry?.id) {
		return undefined; // Session needs migration
	}
	const firstKeptEntryId = firstKeptEntry.id;

	const historyEnd = cutPoint.isSplitTurn ? cutPoint.turnStartIndex : cutPoint.firstKeptEntryIndex;

	// Messages to summarize (will be discarded after summary)
	const messagesToSummarize: AgentMessage[] = [];
	for (let i = boundaryStart; i < historyEnd; i++) {
		const msg = getMessageFromEntry(pathEntries[i], options?.excludedCustomMessageTypes);
		if (msg) messagesToSummarize.push(msg);
	}

	// Messages for turn prefix summary (if splitting a turn)
	const turnPrefixMessages: AgentMessage[] = [];
	if (cutPoint.isSplitTurn) {
		for (let i = cutPoint.turnStartIndex; i < cutPoint.firstKeptEntryIndex; i++) {
			const msg = getMessageFromEntry(pathEntries[i], options?.excludedCustomMessageTypes);
			if (msg) turnPrefixMessages.push(msg);
		}
	}

	// Messages kept after compaction (recent history)
	const recentMessages: AgentMessage[] = [];
	for (let i = cutPoint.firstKeptEntryIndex; i < boundaryEnd; i++) {
		const msg = getMessageFromEntry(pathEntries[i], options?.excludedCustomMessageTypes);
		if (msg) recentMessages.push(msg);
	}
	// Nothing to summarize means compaction would be a no-op.
	if (messagesToSummarize.length === 0 && turnPrefixMessages.length === 0) {
		return undefined;
	}

	// Get previous summary and preserved data for iterative updates
	let previousSummary: string | undefined;
	let previousPreserveData: Record<string, unknown> | undefined;
	if (prevCompactionIndex >= 0) {
		const prevCompaction = pathEntries[prevCompactionIndex] as CompactionEntry;
		previousSummary = prevCompaction.summary;
		previousPreserveData = prevCompaction.preserveData;
	}

	// Extract file operations from messages and previous compaction
	const fileOps = extractFileOperations(messagesToSummarize, pathEntries, prevCompactionIndex);

	// Also extract file ops from turn prefix if splitting
	if (cutPoint.isSplitTurn) {
		extractFileOpsFromMessages(turnPrefixMessages, fileOps);
	}

	return {
		firstKeptEntryId,
		messagesToSummarize,
		turnPrefixMessages,
		recentMessages,
		isSplitTurn: cutPoint.isSplitTurn,
		tokensBefore,
		previousSummary,
		previousPreserveData,
		fileOps,
		settings,
	};
}

// ============================================================================
// Main compaction function
// ============================================================================

const TURN_PREFIX_SUMMARIZATION_PROMPT = prompt.render(AGENT_PROMPTS["compaction/compaction-turn-prefix"].text);

/**
 * Generate summaries for compaction using prepared data.
 * Returns CompactionResult - SessionManager adds id/parentId when saving.
 *
 * @param preparation - Pre-calculated preparation from prepareCompaction()
 * @param customInstructions - Optional custom focus for the summary
 */
export async function compact(
	preparation: CompactionPreparation,
	model: Model,
	apiKey: ApiKey,
	customInstructions?: string,
	signal?: AbortSignal,
	options?: SummaryOptions,
): Promise<CompactionResult> {
	const {
		firstKeptEntryId,
		messagesToSummarize,
		turnPrefixMessages,
		isSplitTurn,
		tokensBefore,
		previousSummary,
		previousPreserveData,
		fileOps,
		settings,
	} = preparation;

	const reserveTokens = settings.reserveTokens ?? DEFAULT_RESERVE_TOKENS;

	const summaryOptions: SummaryOptions = {
		promptOverride: options?.promptOverride,
		extraContext: options?.extraContext,
		remoteEndpoint: settings.remoteEndpoint,
		remoteInstructions: options?.remoteInstructions,
		initiatorOverride: options?.initiatorOverride,
		metadata: options?.metadata,
		convertToLlm: options?.convertToLlm,
		telemetry: options?.telemetry,
		// Honor /model thinking selection on every fan-out summarizer.
		// Without this propagation, generateSummary / generateTurnPrefixSummary
		// see options?.thinkingLevel === undefined and resolveCompactionEffort
		// silently falls back to Effort.High — the same defect e07b47ee4 fixed
		// at the call sites, leaked back in here. See resolveCompactionEffort.
		thinkingLevel: options?.thinkingLevel,
		sessionId: options?.sessionId,
		promptCacheKey: options?.promptCacheKey,
		providerSessionState: options?.providerSessionState,
		codexCompaction: options?.codexCompaction,
		tools: options?.tools,
		sessionSystemPrompt: options?.sessionSystemPrompt,
		sessionMessages: options?.sessionMessages,
		fetch: options?.fetch,
		completeImpl: options?.completeImpl,
		obfuscateProviderText: options?.obfuscateProviderText,
	};

	const previousLegacyArchiveText = legacyArchiveSourceText(previousPreserveData);
	const previousSummaryForCompaction = mergePreviousSummaryWithLegacyArchive(
		previousSummary,
		previousLegacyArchiveText,
	);
	// Provider-native compaction is deliberately absent. Compaction has exactly
	// two strategies — `summary` and `handoff` — and both produce a real,
	// readable artifact veyyon owns. Delegating history to an opaque
	// provider-side replay payload (OpenAI's /responses/compact) was removed:
	// the payload is unreadable to veyyon, dies the moment the session switches
	// provider, and left the session log carrying a placeholder in place of a
	// summary. See BACKLOG.md row 1 and the `no provider gets a private
	// compaction path` tests.
	let preserveData = previousPreserveData;
	if (preserveData !== undefined) {
		const carried: Record<string, unknown> = { ...preserveData };
		// A session compacted by the removed remote path carries an opaque payload
		// no local code can replay. Drop it here so it is never copied forward;
		// prepareCompaction has already re-expanded the original messages behind
		// it, so the history itself is intact and gets summarized locally below.
		let dropped = false;
		for (const key of LEGACY_REMOTE_PRESERVE_KEYS) {
			if (key in carried) {
				delete carried[key];
				dropped = true;
			}
		}
		if (dropped) preserveData = Object.keys(carried).length > 0 ? carried : undefined;
	}
	// A prior REMOTE window must not ride a new local entry forward either: this
	// summary covers the span the window covered, and replaying the stale window
	// beside the new summary would double that history on every rebuild. The
	// remote path re-stamps a fresh window after this function returns.
	preserveData = stripRemoteCompactionPreserveData(preserveData);

	// Generate summaries (can be parallel if both needed) and merge into one
	let summary: string;

	if (isSplitTurn && turnPrefixMessages.length > 0) {
		// Generate both summaries in parallel
		const [historyResult, turnPrefixResult] = await Promise.all([
			messagesToSummarize.length > 0 || previousSummaryForCompaction
				? generateSummary(
						messagesToSummarize,
						model,
						reserveTokens,
						apiKey,
						signal,
						customInstructions,
						previousSummaryForCompaction,
						summaryOptions,
					)
				: Promise.resolve("No prior history."),
			generateTurnPrefixSummary(turnPrefixMessages, model, reserveTokens, apiKey, signal, summaryOptions),
		]);
		// Merge into single summary
		summary = `${historyResult}\n\n---\n\n**Turn Context (split turn):**\n\n${turnPrefixResult}`;
	} else if (messagesToSummarize.length > 0) {
		// Generate history summary from messages to summarize
		summary = await generateSummary(
			messagesToSummarize,
			model,
			reserveTokens,
			apiKey,
			signal,
			customInstructions,
			previousSummaryForCompaction,
			summaryOptions,
		);
	} else if (previousSummaryForCompaction) {
		// No new messages to summarize, preserve previous summary
		summary = previousSummaryForCompaction;
	} else {
		// No messages and no previous summary
		summary = "No prior history.";
	}

	// Compute file lists and append to summary
	const { readFiles, modifiedFiles } = computeFileLists(fileOps);
	summary = upsertFileOperations(summary, readFiles, modifiedFiles, fileOps.read);

	if (!firstKeptEntryId) {
		throw new Error("First kept entry has no ID - session may need migration");
	}

	// This LLM-summary path migrated any prior legacy frame archive into the
	// summary text above; strip the now-stale archive from preserveData so it
	// cannot re-attach to the rebuilt context. Only the legacy case needs
	// stripping — a session without a prior archive carries no frames to drop.
	const finalPreserveData = hasLegacyArchive(previousPreserveData) ? stripLegacyArchive(preserveData) : preserveData;

	return {
		summary,
		firstKeptEntryId,
		tokensBefore,
		details: { readFiles, modifiedFiles } as CompactionDetails,
		preserveData: finalPreserveData,
	};
}

/**
 * Generate a summary for a turn prefix (when splitting a turn).
 */
async function generateTurnPrefixSummary(
	messages: AgentMessage[],
	model: Model,
	reserveTokens: number,
	apiKey: ApiKey,
	signal?: AbortSignal,
	options?: SummaryOptions,
): Promise<string> {
	const maxTokens = Math.floor(0.5 * reserveTokens); // Smaller budget for turn prefix

	const llmMessages = (options?.convertToLlm ?? defaultConvertToLlm)(messages);
	const conversationText = serializeConversationForSummary(
		transformSummarySourceMessages(llmMessages, options),
		preferredDialect(model.id),
	);
	const promptText = `<conversation>\n${conversationText}\n</conversation>\n\n${TURN_PREFIX_SUMMARIZATION_PROMPT}`;

	const response = await withAuth(
		apiKey,
		async key => {
			const attemptResponse = await instrumentedCompleteSimple(
				model,
				buildCompactionProviderContext(SUMMARIZATION_SYSTEM_PROMPT, promptText, options),
				{
					maxTokens,
					signal,
					apiKey: key,
					reasoning: resolveCompactionEffort(model, options?.thinkingLevel),
					initiatorOverride: options?.initiatorOverride,
					metadata: options?.metadata,
					fetch: options?.fetch,
					sessionId: options?.sessionId,
					promptCacheKey: options?.promptCacheKey,
					providerSessionState: options?.providerSessionState,
					codexCompaction: localCodexCompaction(options),
				},
				{
					telemetry: options?.telemetry,
					oneshotKind: "compaction_turn_prefix",
					completeImpl: options?.completeImpl,
				},
			);
			throwIfCompactionCancelled(attemptResponse);
			if (attemptResponse.stopReason === "error") {
				throw createSummarizationError("Turn prefix summarization failed", attemptResponse, options);
			}
			return attemptResponse;
		},
		{ signal },
	);

	return response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map(c => c.text)
		.join("\n");
}
