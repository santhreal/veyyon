/**
 * Tool output pruning utilities for compaction.
 */

import type { ToolResultMessage } from "@veyyon/ai";
import { toolResultNeverRan } from "../tool-result-never-ran";
import type { AgentMessage, AgentToolCall } from "../types";
import type { SessionEntry, SessionMessageEntry } from "./entries";
import { getToolResultMessage, resolveCompactionBoundaryIndex } from "./entries";
import { estimateTokens } from "./token-estimate";
import {
	collectToolCallsById,
	isProtectedToolResult,
	isSkillReadToolResult,
	type ProtectedToolMatcher,
} from "./tool-protection";
import { splitReadSelector } from "./utils";

export interface PruneConfig {
	/** Keep the most recent tool output tokens intact. */
	protectTokens: number;
	/** Only prune if total savings meets this threshold. */
	minimumSavings: number;
	/** Tool-result protection matchers. String entries protect every result from that tool; predicates may inspect the paired tool call. */
	protectedTools: ProtectedToolMatcher[];
	/**
	 * Optional supersede key function (see {@link SupersedePruneConfig.supersedeKey}).
	 * When provided, superseded tool results are pruned first — even inside the
	 * `protectTokens` window — before age-based victims. Absent, behavior is
	 * unchanged.
	 */
	supersedeKey?: SupersedeKeyFn;
	/** Useless-flagged results bypass the protect window (see {@link USELESS_NOTICE}). Default true. */
	pruneUseless?: boolean;
	/**
	 * Compaction boundary (`firstKeptEntryId`). Entries before it are already summarized and skipped.
	 */
	keepBoundaryId?: string;
	/**
	 * Prompt-cache guard. Tool results whose suffix exceeds this are kept to avoid cache write premiums.
	 */
	cacheWarmSuffixTokens?: number;
}

export const DEFAULT_PRUNE_CONFIG: PruneConfig = {
	protectTokens: 40_000,
	minimumSavings: 20_000,
	protectedTools: ["skill", isSkillReadToolResult],
	pruneUseless: true,
};

export interface PruneResult {
	prunedCount: number;
	tokensSaved: number;
}

/** Exact placeholder written over a superseded tool result. */
export const SUPERSEDED_NOTICE = "[Superseded by a newer read of this file]";

/** Exact placeholder written over an elided useless tool result. */
export const USELESS_NOTICE = "[Uneventful result elided]";

/**
 * Maps a tool call to a supersede key. Results sharing a key supersede older results in that group.
 */
export type SupersedeKeyFn = (toolName: string, args: Record<string, unknown>) => string | undefined;

export interface SupersedePruneConfig {
	/** Supersede key function; results sharing a key supersede older ones. */
	supersedeKey?: SupersedeKeyFn;
	/** Also prune results flagged useless by their tool. Default false. */
	pruneUseless?: boolean;
	/** Prune a candidate now when all messages after it total at most this many estimated tokens. Default 8 000. */
	suffixTokenLimit?: number;
	/**
	 * Read-equivalent price of re-writing one already-cached token, used to decide
	 * whether a batch of victims is worth the cache write it forces. Providers
	 * charge roughly 1.25x base input to write a cache entry and 0.1x to read one,
	 * so a rewritten token costs about 12.5 reads of the same token. Default 12.5.
	 */
	cacheWritePremium?: number;
	/**
	 * Estimated turns reclaimed tokens would survive before compaction. Default 30.
	 */
	paybackTurns?: number;
	/**
	 * Prune all candidates when the last message is at least this old: the
	 * provider prompt cache is then cold, so re-writing it is free. MUST exceed
	 * the cache retention (Anthropic "long" = 1h) or a still-warm prefix is busted
	 * by the flush. Default 30 min — callers on long retention override it.
	 */
	idleFlushMs?: number;
	/** Clock override for tests. */
	now?: number;
	/**
	 * Compaction boundary (`firstKeptEntryId` of the latest compaction). Entries
	 * before it are summarized away and never sent, so they are skipped in every
	 * path — including the idle flush — to avoid pointless history churn.
	 * Undefined = no compaction (the whole branch is sent).
	 */
	keepBoundaryId?: string;
	/** Tool-result protection matchers (same contract as {@link PruneConfig.protectedTools}). */
	protectedTools: ProtectedToolMatcher[];
}

const DEFAULT_SUFFIX_TOKEN_LIMIT = 8_000;
const DEFAULT_IDLE_FLUSH_MS = 30 * 60_000;
const DEFAULT_CACHE_WRITE_PREMIUM = 12.5;
const DEFAULT_PAYBACK_TURNS = 30;

function createPrunedNotice(tokens: number): string {
	return `[Output truncated - ${tokens} tokens]`;
}

/**
 * Generic age-based pruning floor. Below this, blanking output saves fewer tokens than the notice costs.
 */
const MIN_PRUNE_TOKENS = 50;

function estimatePrunedSavings(tokens: number, notice: string): number {
	const noticeTokens = Math.ceil(notice.length / 4);
	return Math.max(0, tokens - noticeTokens);
}

interface SupersedeCandidate {
	entry: SessionMessageEntry;
	message: ToolResultMessage;
	/** Index of the entry within the `entries` array. */
	index: number;
	tokens: number;
	/** Placeholder text written over the blanked result. */
	notice: string;
	/** Estimated tokens of all messages strictly after this entry's index. */
	suffixSum: number;
}

/**
 * Collect superseded and useless tool-result candidates in a single backward walk in message order.
 */
function collectPruneCandidates(
	entries: readonly SessionEntry[],
	toolCallsById: ReadonlyMap<string, AgentToolCall>,
	supersedeKey: SupersedeKeyFn | undefined,
	protectedTools: readonly ProtectedToolMatcher[],
	pruneUseless: boolean,
): SupersedeCandidate[] {
	const candidates: SupersedeCandidate[] = [];
	const seenKeys = new Set<string>();
	let suffixSum = 0;
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		const message = getToolResultMessage(entry);
		if (!message || message.prunedAt !== undefined) {
			if (entry.type === "message") suffixSum += estimateTokens(entry.message as AgentMessage);
			continue;
		}
		const toolCall = toolCallsById.get(message.toolCallId);

		// Superseded check: a newer result with the same key (or a prefix-parent
		// key) has already been seen in this backward walk.
		if (supersedeKey && toolCall) {
			if (!isProtectedToolResult(message, toolCall, protectedTools) && !toolResultNeverRan(message.details)) {
				const key = supersedeKey(toolCall.name, toolCall.arguments as Record<string, unknown>);
				if (key !== undefined) {
					const separator = key.indexOf("\u0000");
					const superseded = seenKeys.has(key) || (separator >= 0 && seenKeys.has(key.slice(0, separator)));
					seenKeys.add(key);
					if (superseded) {
						candidates.push({
							entry: entry as SessionMessageEntry,
							message,
							index: i,
							tokens: estimateTokens(message as AgentMessage),
							notice: SUPERSEDED_NOTICE,
							suffixSum,
						});
						continue;
					}
				}
			}
		}

		// Useless check: the tool itself flagged the result as carrying no
		// information worth retaining. Skipped when already collected as
		// superseded (the `continue` above).
		if (pruneUseless && message.useless === true && !message.isError) {
			if (!isProtectedToolResult(message, toolCall, protectedTools)) {
				const tokens = estimateTokens(message as AgentMessage);
				if (estimatePrunedSavings(tokens, USELESS_NOTICE) > 0) {
					candidates.push({
						entry: entry as SessionMessageEntry,
						message,
						index: i,
						tokens,
						notice: USELESS_NOTICE,
						suffixSum,
					});
				}
			}
		}

		suffixSum += estimateTokens(message as AgentMessage);
	}
	return candidates.reverse();
}

/**
 * Find the deepest batch of victims whose token savings exceed the cache rewrite cost.
 */
function chooseWorthwhileSweep(
	candidates: readonly SupersedeCandidate[],
	config: SupersedePruneConfig,
): SupersedeCandidate[] {
	const premium = config.cacheWritePremium ?? DEFAULT_CACHE_WRITE_PREMIUM;
	const payback = config.paybackTurns ?? DEFAULT_PAYBACK_TURNS;
	let mass = 0;
	let bestValue = 0;
	let bestCut = candidates.length;
	for (let i = candidates.length - 1; i >= 0; i--) {
		const candidate = candidates[i]!;
		mass += estimatePrunedSavings(candidate.tokens, candidate.notice);
		const value = mass * payback - premium * candidate.suffixSum;
		if (value > bestValue) {
			bestValue = value;
			bestCut = i;
		}
	}
	return bestCut === candidates.length ? [] : candidates.slice(bestCut);
}

/**
 * Prune superseded and useless tool results, taking into account cache rewrite costs and idle context expiration.
 */
export function pruneSupersededToolResults(entries: SessionEntry[], config: SupersedePruneConfig): PruneResult {
	const toolCallsById = collectToolCallsById(entries);
	const candidates = collectPruneCandidates(
		entries,
		toolCallsById,
		config.supersedeKey,
		config.protectedTools,
		Boolean(config.pruneUseless),
	);
	if (candidates.length === 0) return { prunedCount: 0, tokensSaved: 0 };

	const now = config.now ?? Date.now();
	let lastMessageTimestamp: number | undefined;
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "message") continue;
		const timestamp = (entry.message as AgentMessage).timestamp;
		if (typeof timestamp === "number") lastMessageTimestamp = timestamp;
		break;
	}
	const idle =
		lastMessageTimestamp !== undefined && now - lastMessageTimestamp >= (config.idleFlushMs ?? DEFAULT_IDLE_FLUSH_MS);

	const boundaryIndex = resolveCompactionBoundaryIndex(entries, config.keepBoundaryId);

	let toPrune: SupersedeCandidate[];
	if (idle) {
		// Provider cache is cold (idle exceeds the retention TTL), so re-writing
		// the sent region costs nothing. Entries before the compaction boundary
		// are summarized away and never sent — skip them to avoid pointless churn.
		toPrune = candidates.filter(candidate => candidate.index >= boundaryIndex);
	} else {
		const suffixTokenLimit = config.suffixTokenLimit ?? DEFAULT_SUFFIX_TOKEN_LIMIT;
		// Single pass: collect eligible candidates and cheap tail together.
		const eligible: SupersedeCandidate[] = [];
		const tail: SupersedeCandidate[] = [];
		for (const candidate of candidates) {
			if (candidate.index < boundaryIndex) continue;
			eligible.push(candidate);
			if (candidate.suffixSum <= suffixTokenLimit) tail.push(candidate);
		}
		// Deeper than the tail, one victim never pays for the rewrite it forces, but a
		// batch of them does. Asking the question per candidate is why a long session
		// reclaimed almost nothing: at 120k of context every candidate outside the last
		// few thousand tokens failed the test alone, while together they were most of
		// the dead weight in the window.
		const batch = chooseWorthwhileSweep(eligible, config);
		toPrune = batch.length > tail.length ? batch : tail;
	}
	if (toPrune.length === 0) return { prunedCount: 0, tokensSaved: 0 };

	const prunedAt = Date.now();
	let tokensSaved = 0;
	for (const candidate of toPrune) {
		candidate.message.content = [{ type: "text", text: candidate.notice }];
		candidate.message.prunedAt = prunedAt;
		tokensSaved += estimatePrunedSavings(candidate.tokens, candidate.notice);
	}
	return { prunedCount: toPrune.length, tokensSaved };
}

export function pruneToolOutputs(entries: SessionEntry[], config: PruneConfig = DEFAULT_PRUNE_CONFIG): PruneResult {
	let accumulatedTokens = 0;
	let tokensSaved = 0;
	let prunedCount = 0;

	const candidates: Array<{ entry: SessionMessageEntry; tokens: number; superseded: boolean; useless: boolean }> = [];
	const toolCallsById = collectToolCallsById(entries);
	const hasSupersedeKey = config.supersedeKey !== undefined;
	const pruneUseless = config.pruneUseless !== false;
	let supersededMessages: Set<ToolResultMessage> | undefined;
	let uselessMessages: Set<ToolResultMessage> | undefined;
	if (hasSupersedeKey) {
		supersededMessages = new Set();
		uselessMessages = new Set();
		const pruneCandidates = collectPruneCandidates(
			entries,
			toolCallsById,
			config.supersedeKey,
			config.protectedTools,
			pruneUseless,
		);
		for (const candidate of pruneCandidates) {
			if (candidate.notice === SUPERSEDED_NOTICE) supersededMessages.add(candidate.message);
			else uselessMessages.add(candidate.message);
		}
	}

	const boundaryIndex = resolveCompactionBoundaryIndex(entries, config.keepBoundaryId);
	const cacheWarmSuffixTokens = config.cacheWarmSuffixTokens;
	const trackSuffix = cacheWarmSuffixTokens !== undefined;
	let suffixSum = 0;

	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		const message = getToolResultMessage(entry);
		const inWarmPrefix = trackSuffix && suffixSum > (cacheWarmSuffixTokens as number);

		if (message) {
			const tokens = estimateTokens(message as AgentMessage);
			const isProtected = isProtectedToolResult(
				message,
				toolCallsById.get(message.toolCallId),
				config.protectedTools,
			);

			if (message.prunedAt !== undefined) {
				accumulatedTokens += tokens;
			} else if (inWarmPrefix || i < boundaryIndex) {
				accumulatedTokens += tokens;
			} else {
				// Superseded/useless bypass the age protect window, but only in the cache-warm tail.
				const superseded = supersededMessages?.has(message) ?? false;
				const useless =
					uselessMessages?.has(message) ??
					(!hasSupersedeKey &&
						pruneUseless &&
						message.useless === true &&
						!message.isError &&
						!isProtected &&
						estimatePrunedSavings(tokens, USELESS_NOTICE) > 0);
				const tooSmall = tokens < MIN_PRUNE_TOKENS;
				if (!superseded && !useless && (accumulatedTokens < config.protectTokens || isProtected || tooSmall)) {
					accumulatedTokens += tokens;
				} else {
					candidates.push({ entry: entry as SessionMessageEntry, tokens, superseded, useless });
					// Dead weight doesn't consume the protectTokens window.
					if (!superseded && !useless) accumulatedTokens += tokens;
				}
			}
		}

		// Update suffixSum for all message entries (estimateTokens is cached, so the second call is O(1)).
		if (trackSuffix && entry.type === "message") {
			suffixSum += estimateTokens(entry.message as AgentMessage);
		}
	}

	for (const candidate of candidates) {
		tokensSaved += estimatePrunedSavings(
			candidate.tokens,
			candidate.superseded
				? SUPERSEDED_NOTICE
				: candidate.useless
					? USELESS_NOTICE
					: createPrunedNotice(candidate.tokens),
		);
	}

	if (tokensSaved < config.minimumSavings || candidates.length === 0) {
		return { prunedCount: 0, tokensSaved: 0 };
	}

	const prunedAt = Date.now();
	for (const candidate of candidates) {
		const message = candidate.entry.message as ToolResultMessage;
		const notice = candidate.superseded
			? SUPERSEDED_NOTICE
			: candidate.useless
				? USELESS_NOTICE
				: createPrunedNotice(candidate.tokens);
		message.content = [{ type: "text", text: notice }];
		message.prunedAt = prunedAt;
		prunedCount++;
	}

	return { prunedCount, tokensSaved };
}

/**
 * Supersede key for the `read` tool: file path stripped of trailing selectors, excluding URL schemes.
 */
export function readToolSupersedeKey(toolName: string, args: Record<string, unknown>): string | undefined {
	if (toolName !== "read") return undefined;
	const path = args.path;
	if (typeof path !== "string" || path.length === 0) return undefined;
	if (path.includes("://")) return undefined;
	const { path: base, sel } = splitReadSelector(path);
	return sel === undefined ? base : `${base}\u0000${sel}`;
}
