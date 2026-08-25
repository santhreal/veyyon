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
	 * Compaction boundary: the `firstKeptEntryId` of the latest compaction on
	 * the branch. Entries at indices BEFORE this id are summarized away and never
	 * sent to the model, so mutating them only churns persisted history without
	 * shrinking the prompt — they are skipped. Undefined = no compaction (the
	 * whole branch is sent).
	 */
	keepBoundaryId?: string;
	/**
	 * Prompt-cache guard. When set, a tool result whose all-message suffix
	 * (tokens of every message after it) EXCEEDS this is part of the warm,
	 * already-sent cache prefix: mutating it forces the provider to re-write the
	 * whole suffix (cacheWrite premium). Such results — including superseded and
	 * useless ones, which otherwise bypass {@link protectTokens} — are left for
	 * compaction/shake (which rebuild the cache anyway) to reclaim. Undefined =
	 * no cache guard (legacy: superseded/useless prune at any depth).
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
 * Maps a tool call to a supersede key. Results sharing a key form a group in
 * which every result except the newest is a supersede candidate. A key `K`
 * additionally supersedes keys with prefix `K + "\u0000"` (selector-free read
 * supersedes selector-carrying reads of the same base path). Return
 * `undefined` to exempt a call from supersede grouping.
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
	 * Turns the reclaimed tokens are assumed to survive if nothing prunes them,
	 * i.e. how many times they would be re-read before the next compaction drops
	 * them anyway. This is the other half of the trade: reclaiming M tokens saves
	 * `M * paybackTurns` reads and costs `cacheWritePremium * suffix` writes.
	 * Default 30. A backtest over 659 recorded sessions (550k turns) priced the
	 * sweep at 30, 60 and 120: 60 reclaims more in total but leaves 15 sessions
	 * worse by up to +8% because their real remaining life was shorter than the
	 * assumption; 30 leaves 2 sessions worse by at most +1.4% and still nets
	 * -0.5% of the total bill with a 0.02-point cache-hit change.
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
 * Generic age-based pruning floor. Below this, blanking a result to
 * `[Output truncated - N tokens]` recovers nothing — the placeholder itself
 * costs ~8 tokens, so a sub-floor result grows the context (and churns the
 * prompt cache) instead of shrinking it. Superseded/useless results keep their
 * own rules: useless already drops no-savings candidates, superseded prunes for
 * correctness regardless of size.
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
 * Collect superseded and useless tool-result candidates in a single backward
 * walk, merging what was two separate O(n) passes into one. A superseded
 * result (an older read whose key a newer read has already claimed) is
 * collected first; a useless result (flagged by its tool) is collected only
 * when it was not already collected as superseded. Returned in message order.
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
 * Deepest batch of victims whose reclaimed tokens pay for the one cache rewrite
 * they force, or an empty array when no batch does.
 *
 * Rewriting a message invalidates every cached token after it, so the price of a
 * sweep is set by its EARLIEST victim and is paid once, while the saving is the
 * whole batch's mass, collected on every later turn. That is why the answer is a
 * batch: `dead * paybackTurns` against `premium * suffix(earliest)`. Candidates
 * arrive in message order, so each prefix of the list is a legal cut and the best
 * one is a single scan from the deep end.
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
 * Prune superseded tool results (e.g. stale `read` outputs replaced by a newer
 * read of the same file) and, when `pruneUseless` is set, results their tool
 * flagged contextually useless. Prompt-cache-aware in three ways: a candidate
 * whose own suffix is small is rewritten on its own (the read→edit→read loop), a
 * deeper BATCH is rewritten when its combined mass pays for the one cache write
 * it forces (see {@link chooseWorthwhileSweep}), and an idle context flushes
 * everything because its cache has expired anyway.
 * Never mutates entries before `keepBoundaryId` (summarized away — not sent).
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
		const eligible = candidates.filter(candidate => candidate.index >= boundaryIndex);
		// The cheap tail: a candidate whose own suffix is small is worth rewriting on
		// its own, which is the read -> edit -> read loop.
		const tail = eligible.filter(candidate => candidate.suffixSum <= suffixTokenLimit);
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
				// Superseded and useless results bypass the age-based protect window
				// (a stale re-read copy, or a result the tool flagged as uninformative,
				// is dead weight at any age) — but only within the cache-warm tail: the
				// guard above already excluded deeper, still-cached copies.
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
					// Dead weight being pruned away (superseded/useless) must not consume
					// the protectTokens window of the real results retained behind it.
					if (!superseded && !useless) accumulatedTokens += tokens;
				}
			}
		}

		// Update suffixSum for ALL message entries (not just tool results) so the
		// next iteration's inWarmPrefix check sees the true suffix at its index.
		// estimateTokens is WeakMap-cached, so the second call for tool-result
		// entries (already called above) is O(1).
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
 * Supersede key for the `read` tool: the file path with the trailing line/raw
 * selector stripped (the read tool's own splitter grammar via
 * {@link splitReadSelector}, e.g. `src/foo.ts:50-200`, `:2-4:raw`).
 * Internal/URL-scheme paths (`skill://…`, `https://…`) are exempt.
 * Selector-free reads key on the bare path; selector-carrying reads key on
 * `path + "\u0000" + selector`, so two reads collide only when the newer is
 * selector-free or the selectors are identical (the pass's prefix rule lets a
 * bare-path read supersede selector-carrying reads of the same file).
 */
export function readToolSupersedeKey(toolName: string, args: Record<string, unknown>): string | undefined {
	if (toolName !== "read") return undefined;
	const path = args.path;
	if (typeof path !== "string" || path.length === 0) return undefined;
	if (path.includes("://")) return undefined;
	const { path: base, sel } = splitReadSelector(path);
	return sel === undefined ? base : `${base}\u0000${sel}`;
}
