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
	TextContent,
	Tool,
	ToolResultMessage,
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
import type { CompactionEntry, SessionEntry, SessionMessageEntry } from "./entries";
import { KEEP_NOTHING_ENTRY_ID } from "./entries";
import { CompactionCancelledError } from "./errors";
import { LEGACY_REMOTE_PRESERVE_KEYS } from "./legacy-provider-native";
import { hasLegacyArchive, legacyArchiveSourceText, stripLegacyArchive } from "./legacy-snapcompact-archive";
import { type ConvertToLlm, createBranchSummaryMessage, createCustomMessage, defaultConvertToLlm } from "./messages";
import {
	getRemoteCompactionPreserveData,
	REMOTE_COMPACTION_PRESERVE_KEY,
	stripRemoteCompactionPreserveData,
} from "./remote-compaction-entry";
import { requestRemoteCompaction } from "./remote-summarizer";
// The trigger decision moved to the module whose header owns it, and is re-exported below so no caller
// changed. What is left here is the ENGINE: the summarizer, the cut point, the provider round trip.
import {
	AUTO_COMPACTION_THRESHOLD,
	type CompactionSettings,
	DEFAULT_RESERVE_TOKENS,
	resolveThresholdTokens,
} from "./threshold";
import { collectToolCallsById, isSkillReadToolResult } from "./tool-protection";
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

	// No valid cut point anywhere in the range means nothing can be kept on a
	// boundary. Fall through with `startIndex` rather than returning: the
	// dead-end guard below turns that into "keep nothing" when the range is over
	// budget, and leaves it alone when the session is genuinely small.

	// Walk backwards from newest, accumulating estimated message sizes
	let accumulatedTokens = 0;
	let cutIndex = cutPoints.length > 0 ? cutPoints[0] : startIndex; // Default: keep from first message (not header)
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
			// Keep from the crossing entry: the budget says how much recent history
			// to keep, and the entry that reached it belongs on the kept side.
			let found = false;
			for (let c = 0; c < cutPoints.length; c++) {
				if (cutPoints[c] >= i) {
					cutIndex = cutPoints[c];
					found = true;
					break;
				}
			}
			// No valid cut point at or after the crossing entry. The budget was blown
			// inside the newest turn, which one enormous tool result is enough to do:
			// a result is never a valid cut point, because cutting there would
			// separate it from the call it answers, so nothing behind it is usable.
			//
			// The turn's own start IS a valid cut point, and keeping the newest turn
			// is now safe: prepareCompaction elides the oversized result inside the
			// kept tail, so the bulk leaves the context without taking the user's
			// latest message and the assistant's reasoning with it. Both older
			// answers were wrong. Keeping from the newest valid point, the assistant
			// message CARRYING the call, retained the whole result and freed nothing
			// however often compaction ran: a warning every turn against a full
			// gauge. Keeping nothing sent the entire newest turn, the most
			// informative part of the session, to the summarizer, bulk and all.
			//
			// No turn start inside the range means the turn's opening was summarized
			// by an earlier pass, so no cut here keeps call and result together:
			// keep nothing and let the summary stand in for the whole range.
			if (!found) {
				const turnStart = findTurnStartIndex(entries, i, startIndex);
				cutIndex = turnStart === -1 ? endIndex : turnStart;
			}
			break;
		}
	}

	// Scan backwards from cutIndex to include any non-message entries (bash, settings, etc.)
	while (cutIndex > startIndex && cutIndex < endIndex) {
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

	// Dead-end guard: a cut at `startIndex` keeps the ENTIRE range, so there is
	// nothing to summarize and `prepareCompaction` refuses — at exactly the
	// moment the session is most over budget, and silently, which surfaces to the
	// user as "Nothing to compact (session too small)" against a full gauge.
	//
	// Cut at the next valid point instead. When there is no next point the whole
	// range is one unbreakable turn, and the only way to free anything is to
	// summarize all of it and keep nothing: `endIndex` says exactly that.
	// `crossedIndex === -1` means the range fits the budget, which is a genuinely
	// small session and must still be refused.
	if (cutIndex === startIndex && crossedIndex !== -1) {
		let nextCutPoint = -1;
		for (let c = 0; c < cutPoints.length; c++) {
			if (cutPoints[c] > startIndex) {
				nextCutPoint = cutPoints[c];
				break;
			}
		}
		cutIndex = nextCutPoint === -1 ? endIndex : nextCutPoint;
	}

	// Keeping nothing has no cut entry and splits no turn: everything in the
	// range becomes history for the summary.
	if (cutIndex >= endIndex) {
		return { firstKeptEntryIndex: endIndex, turnStartIndex: -1, isSplitTurn: false };
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

/**
 * The narrower span a SERVER-SIDE pass compacts when the branch already holds
 * a server-side window this model can chain in front of it.
 *
 * The two passes need different spans over the same branch, which is why this
 * cannot be folded into the fields above. A local pass must look straight past
 * a remote entry and re-expand everything behind it, because that entry holds
 * no summary text to build on and the local summary it writes replaces the
 * window. A remote pass must do the opposite: chain the window and send only
 * what arrived after it, because the window already carries that history
 * (encrypted reasoning included) and re-sending it as plain messages pays for
 * the same span twice and grows every compaction past the last one.
 *
 * Absent when there is no such entry, or when the cut point falls before it,
 * where the window is still in the retained tail and chaining would double the
 * span it covers.
 */
export interface RemoteCompactionChain {
	/** `preserveData` of the entry whose window is being chained. */
	previousPreserveData: Record<string, unknown>;
	/** Messages after that entry, up to the cut point. */
	messagesToSummarize: AgentMessage[];
	/** Same turn prefix the local pass uses: it lies after the cut either way. */
	turnPrefixMessages: AgentMessage[];
}

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
	/**
	 * Span and window for a chained server-side pass. See {@link
	 * RemoteCompactionChain}; a local pass ignores it.
	 */
	remoteChain?: RemoteCompactionChain;
	/**
	 * Tool results elided from the retained tail to bring it under
	 * `keepRecentTokens`, largest first. Always set by `prepareCompaction`
	 * (empty when the tail already fit); absent only on hand-built fixtures.
	 * The elision is already applied to the branch entries: the caller
	 * offloads `originalText` to a recovery artifact, patches the markers
	 * with the pointer, and persists the rewrite once the pass completes.
	 */
	tailElisions?: TailElision[];
	/** File operations extracted from messagesToSummarize */
	fileOps: FileOperations;
	/** Compaction settions from settings.jsonl	*/
	settings: CompactionSettings;
}

/**
 * Preserve-data keys whose entry carries no summary text a later local pass
 * can build on. Two of them are the DEAD provider-native keys, whose payload
 * is an opaque blob nothing shipping today can read, sitting behind a
 * placeholder summary. The third is the LIVE server-side compaction key, which
 * is not dead at all: its entry simply has no summary, because the window the
 * provider returned is the artifact for that span.
 */
const NON_REUSABLE_SUMMARY_KEYS: readonly string[] = [...LEGACY_REMOTE_PRESERVE_KEYS, REMOTE_COMPACTION_PRESERVE_KEY];

/**
 * Whether a prior compaction entry carries summary text a later local pass can
 * actually build on.
 *
 * For a server-side entry the answer is always no, and that is not a defect in
 * the remote path. veyyon never writes a local summary beside a provider
 * compaction window: that would pay a model to re-summarize a span the
 * provider already compacted and leave two accounts of one range free to
 * disagree. It was rejected, not deferred, so the summary is permanently empty.
 *
 * The consequence lands here. Call such an entry reusable and
 * `prepareCompaction` adopts it as the previous compaction with a
 * `previousSummary` of "", so the span behind the window is never re-expanded,
 * and the local pass that follows strips the window on its way out. The span
 * is then neither summarized nor replayable: lost.
 *
 * So all three keys get the same treatment a legacy entry gets. Look straight
 * past the entry, re-expand the original messages behind it, and summarize
 * them locally.
 */
function hasReusableSummary(preserveData: Record<string, unknown> | undefined): boolean {
	if (!preserveData) return true;
	return !NON_REUSABLE_SUMMARY_KEYS.some(key => key in preserveData);
}

export interface CompactionPreparationOptions {
	/** Runtime-owned state messages reconstructed separately after compaction. */
	excludedCustomMessageTypes?: ReadonlySet<string>;
	/**
	 * Tokens in the provider's prompt count that belong to no session entry: the
	 * system prompt, the tool schemas, and anything else the harness prepends.
	 *
	 * Compaction scales its recent-token budget by how far the local estimate
	 * undershoots the provider's count for the same messages, and without this
	 * figure that comparison silently includes the harness, so growing the tool
	 * set shrinks how much conversation a compaction keeps. Omit it only when it
	 * is genuinely unknown; the scaling is then skipped rather than guessed.
	 */
	nonMessageTokens?: number;
	/**
	 * Context window of the model this session is running on.
	 *
	 * Compaction uses it to derive how much conversation the prompt is allowed
	 * to hold, and caps the recent-token budget there: a configured budget
	 * larger than that asks compaction to keep more than can ever fit, which is
	 * how a full session ends up reported as too small to compact. Omit it only
	 * when the window is genuinely unknown; the cap is then skipped.
	 */
	contextWindow?: number;
}

/**
 * Validate the complete result immediately before a runtime rewrites history.
 * A malformed extension result must fail before its cut point can discard the
 * live tail.
 *
 * A compaction must leave behind an artifact that stands in for the span it
 * discards, and there are exactly two legal artifacts. A local pass leaves
 * summary text. A server-side pass leaves the compacted window the provider
 * returned, and no summary. The empty summary there is correct, not a miss:
 * writing a local summary beside the window would pay a model to re-summarize
 * a span the provider already compacted and store two accounts of one range
 * free to disagree. So an empty summary is checked against the window rather
 * than rejected outright.
 */
export function assertValidCompactionResult(preparation: CompactionPreparation, result: CompactionResult): void {
	if (typeof result.summary !== "string" || result.summary.trim().length === 0) {
		// Not `key in preserveData`: a payload that fails validation cannot be
		// replayed by any reader, so it is no better than an absent one here.
		if (!getRemoteCompactionPreserveData(result.preserveData)) {
			const claimedRemote =
				result.preserveData !== undefined && REMOTE_COMPACTION_PRESERVE_KEY in result.preserveData;
			throw new Error(
				claimedRemote
					? "Compaction failed: the summary is empty and the server-side compaction window stored beside it is malformed, so nothing replaces the discarded history; history was left unchanged."
					: "Compaction failed: the generated summary is empty and no server-side compaction window was stored, so nothing replaces the discarded history; history was left unchanged.",
			);
		}
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

// ============================================================================
// Retained-tail elision
// ============================================================================

/**
 * One tool result elided from the retained tail to bring it under budget.
 *
 * The elision is already applied to the branch when the caller sees this:
 * `message` is the replacement sitting in the entry, so the caller can patch
 * its marker with the recovery pointer once `originalText` is offloaded.
 */
export interface TailElision {
	/** Id of the entry whose tool-result message was replaced. */
	entryId: string;
	/** Tool that produced the elided output. */
	toolName: string;
	/** Estimated tokens the result carried before elision. */
	tokens: number;
	/** The full original output text, for offload to a recovery artifact. */
	originalText: string;
	/** The replacement message now held by the entry. */
	message: ToolResultMessage;
}

/**
 * The marker left in place of an elided tool result: what was removed, how
 * much of it, and why, so the model never mistakes the elision for an empty
 * tool response. With an artifact id it also says where the bytes went.
 */
export function renderTailElisionMarker(toolName: string, tokens: number, artifactId?: string): string {
	const recovery = artifactId ? `; recover the full output at artifact://${artifactId}` : "";
	return `[output elided by compaction: ~${tokens} tokens of "${toolName}" output removed to keep the retained tail within budget${recovery}]`;
}

/** Render elided originals as one recovery-artifact document. */
export function renderTailElisionArtifact(elisions: readonly TailElision[]): string {
	const parts: string[] = [];
	for (let i = 0; i < elisions.length; i++) {
		const elision = elisions[i];
		parts.push(
			`### elision ${i + 1} (${elision.toolName}, ~${elision.tokens} tokens, entry ${elision.entryId})`,
			"",
			elision.originalText,
			"",
		);
	}
	return parts.join("\n");
}

/**
 * Below this estimate a result is not worth eliding: the marker that replaces
 * it costs about as much as the result itself, so eliding it would churn the
 * prompt cache for nothing.
 */
const TAIL_ELISION_MIN_TOKENS = 100;

function tailToolResultText(message: ToolResultMessage): string {
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map(block => block.text)
		.join("\n");
}

/**
 * Bring the retained tail within `budgetTokens` by eliding heavy tool output
 * inside it.
 *
 * `findCutPoint` can only cut at a turn boundary, so a kept turn can carry the
 * tail far past the budget on its own — one enormous tool result is enough —
 * and before this pass that bulk survived every compaction: the tail was
 * bounded by what the cut happened to spare, not by the budget. What leaves
 * is chosen by information density, not recency: bulk tool output (file
 * reads, command stdout) is the lowest-information content in a tail and goes
 * first, largest result first. Never candidates at any size: error results
 * (the error IS the information) and skill reads (the agent's live
 * instructions). User messages, assistant text, and the tool calls themselves
 * are never candidates by construction, because only tool-result content is
 * ever replaced.
 *
 * The entry's message object is REPLACED, never mutated: `estimateTokens`
 * caches by message identity, and a mutated message would keep reading its
 * pre-elision size. The replacement is stamped `prunedAt` so the prune and
 * shake passes treat the marker as already handled.
 */
function elideTailToolResults(
	entries: SessionEntry[],
	startIndex: number,
	endIndex: number,
	budgetTokens: number,
	excludedCustomMessageTypes?: ReadonlySet<string>,
): TailElision[] {
	if (startIndex >= endIndex) return [];

	let tailTokens = 0;
	for (let i = startIndex; i < endIndex; i++) {
		const msg = getMessageFromEntry(entries[i], excludedCustomMessageTypes);
		if (msg) tailTokens += estimateTokens(msg);
	}
	if (tailTokens <= budgetTokens) return [];

	const toolCallsById = collectToolCallsById(entries);
	interface Candidate {
		entry: SessionMessageEntry;
		message: ToolResultMessage;
		tokens: number;
	}
	const candidates: Candidate[] = [];
	for (let i = startIndex; i < endIndex; i++) {
		const entry = entries[i];
		if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
		const message = entry.message as ToolResultMessage;
		if (message.isError === true) continue;
		if (message.prunedAt !== undefined) continue;
		if (isSkillReadToolResult({ toolResult: message, toolCall: toolCallsById.get(message.toolCallId) })) continue;
		const tokens = estimateTokens(message as AgentMessage);
		if (tokens <= TAIL_ELISION_MIN_TOKENS) continue;
		candidates.push({ entry: entry as SessionMessageEntry, message, tokens });
	}
	// Largest first, regardless of recency: the biggest bulk is the lowest
	// information per token and the fastest way back under budget.
	candidates.sort((a, b) => b.tokens - a.tokens);

	const elisions: TailElision[] = [];
	for (const candidate of candidates) {
		if (tailTokens <= budgetTokens) break;
		const replacement: ToolResultMessage = {
			...candidate.message,
			content: [
				{ type: "text", text: renderTailElisionMarker(candidate.message.toolName, candidate.tokens) },
			],
			prunedAt: Date.now(),
		};
		candidate.entry.message = replacement;
		tailTokens -= Math.max(0, candidate.tokens - estimateTokens(replacement as AgentMessage));
		elisions.push({
			entryId: candidate.entry.id,
			toolName: candidate.message.toolName,
			tokens: candidate.tokens,
			originalText: tailToolResultText(candidate.message),
			message: replacement,
		});
	}
	return elisions;
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
	// Newest server-side entry ahead of that boundary, if any. The scan below
	// walks past it because a local pass cannot build on it, and that is exactly
	// the entry a REMOTE pass has to chain rather than re-read, so it is picked
	// up on the same walk instead of a second one.
	let remoteCompactionIndex = -1;
	for (let i = pathEntries.length - 1; i >= 0; i--) {
		if (pathEntries[i].type !== "compaction") continue;
		// Skip an entry whose summary a local pass cannot build on: one of the two
		// dead provider-native keys, or a live OpenAI server-side entry whose
		// artifact is the window rather than text. Re-expand the original messages
		// behind it and summarize them locally rather than stranding that span.
		const entry = pathEntries[i] as CompactionEntry;
		if (!hasReusableSummary(entry.preserveData)) {
			if (remoteCompactionIndex === -1 && getRemoteCompactionPreserveData(entry.preserveData)) {
				remoteCompactionIndex = i;
			}
			continue;
		}
		prevCompactionIndex = i;
		break;
	}
	const boundaryStart = prevCompactionIndex + 1;
	const boundaryEnd = pathEntries.length;

	const lastUsage = getLastAssistantUsage(pathEntries);
	const tokensBefore = lastUsage ? calculateContextTokens(lastUsage) : 0;
	// The configured floor asks to keep a fixed amount of recent history, and on
	// a model with less usable conversation budget than that it asks for more
	// than can ever be there. Every compactable range then estimates under the
	// budget, `findCutPoint` never crosses it, the dead-end guard is skipped
	// because the range genuinely fits, and this function returns undefined --
	// which the manual path spells "Nothing to compact (session too small)"
	// against a gauge with no room left. That is the reported symptom, and the
	// floor is what produces it.
	//
	// The ceiling is derived, not chosen: it is the space the conversation is
	// allowed to occupy at all, the compaction trigger minus everything in the
	// prompt that belongs to no entry. Keeping the whole of that is still a
	// no-op, but it puts the crossing inside the range, and the dead-end guard
	// owns the rest. Both figures come from the caller and both are optional,
	// so an unknown window or an unknown prefix means no ceiling rather than a
	// guessed one.
	//
	// Only when the trigger itself is derived from the window. An operator who
	// sets an absolute threshold has stated the trigger directly, and it may sit
	// far under the window, which makes this subtraction arbitrarily small: a
	// ceiling of a few tokens cuts inside the exchange that just finished and
	// sends the model a tool result whose call is gone. That is not a smaller
	// compaction, it is a broken one. A budget of zero or less says the prefix
	// alone already exceeds the trigger, which no amount of summarizing can fix,
	// so leave the configured budget alone and let the dead-end guard speak.
	let keepRecentTokens = settings.keepRecentTokens;
	const nonMessageTokens = options?.nonMessageTokens;
	const contextWindow = options?.contextWindow;
	if (
		settings.threshold === AUTO_COMPACTION_THRESHOLD &&
		nonMessageTokens !== undefined &&
		contextWindow !== undefined &&
		contextWindow > 0
	) {
		const conversationBudget = resolveThresholdTokens(contextWindow, settings) - nonMessageTokens;
		if (conversationBudget > 0) keepRecentTokens = Math.min(keepRecentTokens, conversationBudget);
	}
	if (lastUsage) {
		const estimatedTokens = estimateEntriesTokens(pathEntries, boundaryStart, boundaryEnd);
		// Scale the recent budget by how far the local estimate undershoots what
		// the provider actually charged for the SAME messages. The system prompt
		// and the tool schemas are in the provider's prompt count and in no entry,
		// so leaving them in makes an unrelated harness the multiplier: with the
		// same conversation, a 20k prefix cut the retained tail from everything to
		// two thirds, and a 60k prefix to under half. That is not estimate error
		// and compaction must not treat it as such. Callers that know the figure
		// pass it; when nobody does, the ratio is only trustworthy if it is not
		// dominated by content we cannot see, so an unknown prefix means no scaling.
		const conversationPromptTokens = calculatePromptTokens(lastUsage) - (nonMessageTokens ?? 0);
		// A negative count is not a small conversation, it is proof that the
		// prefix figure and the provider's prompt count disagree about what is in
		// the prompt, and the subtraction is where that shows. The scaling below
		// already ignores it, since a negative ratio is not above 1, so nothing
		// downstream needs a clamp. What it must not do is stay silent: this runs
		// every turn and hid the disagreement at the one moment both numbers were
		// in hand. Warn and carry on rather than throw.
		if (conversationPromptTokens < 0) {
			logger.warn("compaction: non-message token estimate exceeds the provider's whole prompt count", {
				nonMessageTokens,
				promptTokens: calculatePromptTokens(lastUsage),
				estimatedTokens,
			});
		}
		const ratio =
			nonMessageTokens !== undefined && estimatedTokens > 0 ? conversationPromptTokens / estimatedTokens : 0;
		if (Number.isFinite(ratio) && ratio > 1) {
			keepRecentTokens = Math.max(1, Math.floor(keepRecentTokens / ratio));
		}
	}

	const cutPoint = findCutPoint(pathEntries, boundaryStart, boundaryEnd, keepRecentTokens);

	// Get ID of first kept entry. A cut at `boundaryEnd` keeps nothing: the
	// summary replaces the whole range, which is the only way to free anything
	// when the range is one unbreakable oversized turn. The rebuild emits a
	// pre-compaction entry only once it has seen `firstKeptEntryId`, so an id
	// that matches no entry already means "keep nothing" everywhere it is read.
	const keepsNothing = cutPoint.firstKeptEntryIndex >= boundaryEnd;
	const firstKeptEntry = keepsNothing ? undefined : pathEntries[cutPoint.firstKeptEntryIndex];
	if (!keepsNothing && !firstKeptEntry?.id) {
		return undefined; // Session needs migration
	}
	const firstKeptEntryId = keepsNothing ? KEEP_NOTHING_ENTRY_ID : (firstKeptEntry as SessionEntry).id;

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

	// Nothing to summarize means compaction would be a no-op. Refuse BEFORE
	// the elision below rewrites anything: a pass that will not happen must
	// not leave its marks on the branch.
	if (messagesToSummarize.length === 0 && turnPrefixMessages.length === 0) {
		return undefined;
	}
	
	// Hard-bound the retained tail. The cut can only land on a turn boundary,
	// so one oversized kept turn — a huge file read, a long command output —
	// used to carry the tail far past the budget, and the next turn tripped
	// compaction again over the same bulk. Elide that bulk in place, largest
	// result first; user messages, assistant text, tool calls, and errors are
	// never touched.
	const tailElisions = elideTailToolResults(
		pathEntries,
		cutPoint.firstKeptEntryIndex,
		boundaryEnd,
		keepRecentTokens,
		options?.excludedCustomMessageTypes,
	);
	
	// Messages kept after compaction (recent history). Collected AFTER the
	// elision above so the retained view is the bounded one.
	const recentMessages: AgentMessage[] = [];
	for (let i = cutPoint.firstKeptEntryIndex; i < boundaryEnd; i++) {
		const msg = getMessageFromEntry(pathEntries[i], options?.excludedCustomMessageTypes);
		if (msg) recentMessages.push(msg);
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

	// The span a chained server-side pass sends: only what arrived after the
	// window, because the window already carries everything before it. Skipped
	// when the cut lands at or before that entry, where the window is still in
	// the retained tail and chaining it would send its span twice.
	let remoteChain: RemoteCompactionChain | undefined;
	if (remoteCompactionIndex >= 0 && remoteCompactionIndex < historyEnd) {
		const chainMessages: AgentMessage[] = [];
		for (let i = remoteCompactionIndex + 1; i < historyEnd; i++) {
			const msg = getMessageFromEntry(pathEntries[i], options?.excludedCustomMessageTypes);
			if (msg) chainMessages.push(msg);
		}
		remoteChain = {
			previousPreserveData: (pathEntries[remoteCompactionIndex] as CompactionEntry).preserveData ?? {},
			messagesToSummarize: chainMessages,
			turnPrefixMessages,
		};
	}

	return {
		firstKeptEntryId,
		messagesToSummarize,
		turnPrefixMessages,
		recentMessages,
		tailElisions,
		isSplitTurn: cutPoint.isSplitTurn,
		tokensBefore,
		previousSummary,
		previousPreserveData,
		remoteChain,
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
	// This function is the LOCAL pass and it always produces summary text. It is
	// what runs whenever server-side compaction does not apply, which is most of
	// the time.
	//
	// The server-side pass is live, not absent. When `compaction.remote` is on
	// and `resolveServerCompactionTransport` admits the model,
	// `compactWithProvider` calls the provider's compaction endpoint and stores
	// the window it returns under REMOTE_COMPACTION_PRESERVE_KEY, with an empty
	// summary. Admission is capability data, never a provider-name check: the
	// model must be on the OpenAI Responses wire api (Azure OpenAI Responses
	// deployments included) AND its row must report server-compaction support.
	//
	// One compaction, one artifact. That pass does not also come through here to
	// mint a local summary for the same span. Doing both was rejected, not
	// deferred: it would pay a model to redo work the provider already did and
	// leave two accounts of one range free to disagree. What follows only has to
	// keep some OTHER pass's artifact from riding forward on this entry.
	let preserveData = previousPreserveData;
	if (preserveData !== undefined) {
		const carried: Record<string, unknown> = { ...preserveData };
		// A session compacted by one of the two dead provider-native paths carries
		// an opaque payload no local code can replay. Drop it here so it is never
		// copied forward; prepareCompaction has already re-expanded the original
		// messages behind it, so the history is intact and gets summarized below.
		let dropped = false;
		for (const key of LEGACY_REMOTE_PRESERVE_KEYS) {
			if (key in carried) {
				delete carried[key];
				dropped = true;
			}
		}
		if (dropped) preserveData = Object.keys(carried).length > 0 ? carried : undefined;
	}
	// A prior REMOTE window must not ride this new local entry forward either.
	// The summary generated below covers the span that window covered, and
	// replaying the stale window beside it would double that history on every
	// rebuild. A later remote pass does not come through here at all: it mints
	// its own entry carrying only a fresh window.
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
