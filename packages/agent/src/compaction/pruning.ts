/** Tool output pruning utilities for compaction. */

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
	/** Optional supersede key function (see {@link SupersedePruneConfig.supersedeKey}). */
	supersedeKey?: SupersedeKeyFn;
	/** Useless-flagged results bypass the protect window (see {@link USELESS_NOTICE}). Default true. */
	pruneUseless?: boolean;
	/** Compaction boundary: the `firstKeptEntryId` of the latest compaction on */
	keepBoundaryId?: string;
	/** Prompt-cache guard. When set, a tool result whose all-message suffix */
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

/** Maps a tool call to its supersede targets. A tool result is superseded when */
export type SupersedeKeyFn = (
	toolName: string,
	args: Record<string, unknown>,
) => string | readonly string[] | ReadonlySet<string> | undefined;

export interface SupersedePruneConfig {
	/** Supersede key function; results sharing a key supersede older ones. */
	supersedeKey?: SupersedeKeyFn;
	/** Also prune results flagged useless by their tool. Default false. */
	pruneUseless?: boolean;
	/** Prune a candidate now when all messages after it total at most this many estimated tokens. Default 8 000. */
	suffixTokenLimit?: number;
	/** Read-equivalent price of re-writing one already-cached token, used to decide */
	cacheWritePremium?: number;
	/** Turns the reclaimed tokens are assumed to survive if nothing prunes them, */
	paybackTurns?: number;
	/** Prune all candidates when the last message is at least this old: the */
	idleFlushMs?: number;
	/** Clock override for tests. */
	now?: number;
	/** Compaction boundary (`firstKeptEntryId` of the latest compaction). Entries */
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

/** Generic age-based pruning floor. Below this, blanking a result to */
const MIN_PRUNE_TOKENS = 50;

function estimatePrunedSavings(tokens: number, notice: string): number {
	const noticeTokens = Math.ceil(notice.length / 4);
	return Math.max(0, tokens - noticeTokens);
}

/** For each entry index, the estimated token total of all *message* entries */
function computeMessageSuffixTokens(entries: readonly SessionEntry[]): number[] {
	const suffix = new Array<number>(entries.length);
	let accumulated = 0;
	for (let i = entries.length - 1; i >= 0; i--) {
		suffix[i] = accumulated;
		const entry = entries[i];
		if (entry.type === "message") accumulated += estimateTokens(entry.message as AgentMessage);
	}
	return suffix;
}

interface SupersedeCandidate {
	entry: SessionMessageEntry;
	message: ToolResultMessage;
	/** Index of the entry within the `entries` array. */
	index: number;
	tokens: number;
	/** Placeholder text written over the blanked result. */
	notice: string;
}

/** Collect superseded tool results: for every unpruned, unprotected tool result */
function collectSupersededResults(
	entries: readonly SessionEntry[],
	toolCallsById: ReadonlyMap<string, AgentToolCall>,
	supersedeKey: SupersedeKeyFn,
	protectedTools: readonly ProtectedToolMatcher[],
): SupersedeCandidate[] {
	const candidates: SupersedeCandidate[] = [];
	const seenTargets = new Set<string>();
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		const message = getToolResultMessage(entry);
		if (!message || message.prunedAt !== undefined) continue;
		const toolCall = toolCallsById.get(message.toolCallId);
		if (!toolCall) continue;
		if (isProtectedToolResult(message, toolCall, protectedTools)) continue;
		// A result that carries no file content is not a read of the file it names,
		// in either direction. It must not be blanked to "[Superseded by a newer read
		// of this file]", which replaces the one fact it carries with a claim about a
		// read that did not happen; and it must not COUNT as the newer read either,
		// which is the half that loses data: the group is walked newest first, so such
		// a result marked the last real read of that path superseded and left the model
		// a pointer to a read that produced nothing.
		//
		// Two members. A placeholder for a call that never reached the tool, and a call
		// that reached it and failed. The second was unguarded: a read of a path that
		// errored blanked the earlier successful read of the same path, so the content
		// left context and only the error string remained. `collectUselessResults` below
		// already excludes `isError` for this reason.
		if (toolResultNeverRan(message.details) || message.isError === true) continue;
		const rawKey = supersedeKey(toolCall.name, toolCall.arguments as Record<string, unknown>);
		if (rawKey === undefined) continue;
		const targets: readonly string[] =
			typeof rawKey === "string" ? [rawKey] : Array.isArray(rawKey) ? rawKey : Array.from(rawKey);
		if (targets.length === 0) continue;

		// An earlier read is superseded only when EVERY target it carries is covered
		// by newer reads. A target is covered if an identical target was read later, or
		// if a selector-free read of the same base path was read later.
		const superseded = targets.every(t => {
			if (seenTargets.has(t)) return true;
			const sep = t.indexOf("\u0000");
			return sep >= 0 && seenTargets.has(t.slice(0, sep));
		});
		for (const t of targets) {
			seenTargets.add(t);
		}
		if (!superseded) continue;
		candidates.push({
			entry: entry as SessionMessageEntry,
			message,
			index: i,
			tokens: estimateTokens(message as AgentMessage),
			notice: SUPERSEDED_NOTICE,
		});
	}
	return candidates.reverse();
}

/** Collect tool results their tool flagged contextually useless (zero matches, */
function collectUselessResults(
	entries: readonly SessionEntry[],
	toolCallsById: ReadonlyMap<string, AgentToolCall>,
	protectedTools: readonly ProtectedToolMatcher[],
	exclude: ReadonlySet<ToolResultMessage>,
): SupersedeCandidate[] {
	const candidates: SupersedeCandidate[] = [];
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		const message = getToolResultMessage(entry);
		if (message?.useless !== true || message.prunedAt !== undefined || message.isError === true) continue;
		if (exclude.has(message)) continue;
		if (isProtectedToolResult(message, toolCallsById.get(message.toolCallId), protectedTools)) continue;
		const tokens = estimateTokens(message as AgentMessage);
		if (estimatePrunedSavings(tokens, USELESS_NOTICE) <= 0) continue;
		candidates.push({ entry: entry as SessionMessageEntry, message, index: i, tokens, notice: USELESS_NOTICE });
	}
	return candidates;
}

/** Deepest batch of victims whose reclaimed tokens pay for the one cache rewrite */
function chooseWorthwhileSweep(
	candidates: readonly SupersedeCandidate[],
	suffixTokens: readonly number[],
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
		const value = mass * payback - premium * (suffixTokens[candidate.index] ?? 0);
		if (value > bestValue) {
			bestValue = value;
			bestCut = i;
		}
	}
	return bestCut === candidates.length ? [] : candidates.slice(bestCut);
}

/** Prune superseded tool results (e.g. stale `read` outputs replaced by a newer */
export function pruneSupersededToolResults(entries: SessionEntry[], config: SupersedePruneConfig): PruneResult {
	const toolCallsById = collectToolCallsById(entries);
	const candidates = config.supersedeKey
		? collectSupersededResults(entries, toolCallsById, config.supersedeKey, config.protectedTools)
		: [];
	if (config.pruneUseless) {
		const exclude = new Set(candidates.map(candidate => candidate.message));
		const useless = collectUselessResults(entries, toolCallsById, config.protectedTools, exclude);
		for (let ui = 0; ui < useless.length; ui++) candidates.push(useless[ui]!);
		candidates.sort((a, b) => a.index - b.index);
	}
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
		// suffixTokens[i] = estimated tokens of all messages strictly after entry i.
		const suffixTokens = computeMessageSuffixTokens(entries);
		const eligible = candidates.filter(candidate => candidate.index >= boundaryIndex);
		// The cheap tail: a candidate whose own suffix is small is worth rewriting on
		// its own, which is the read -> edit -> read loop.
		const tail = eligible.filter(candidate => suffixTokens[candidate.index] <= suffixTokenLimit);
		// Deeper than the tail, one victim never pays for the rewrite it forces, but a
		// batch of them does. Asking the question per candidate is why a long session
		// reclaimed almost nothing: at 120k of context every candidate outside the last
		// few thousand tokens failed the test alone, while together they were most of
		// the dead weight in the window.
		const batch = chooseWorthwhileSweep(eligible, suffixTokens, config);
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
	const supersededMessages = config.supersedeKey
		? new Set(
				collectSupersededResults(entries, toolCallsById, config.supersedeKey, config.protectedTools).map(
					candidate => candidate.message,
				),
			)
		: undefined;
	const uselessMessages =
		config.pruneUseless !== false
			? new Set(
					collectUselessResults(
						entries,
						toolCallsById,
						config.protectedTools,
						supersededMessages ?? new Set(),
					).map(candidate => candidate.message),
				)
			: undefined;

	const boundaryIndex = resolveCompactionBoundaryIndex(entries, config.keepBoundaryId);
	const cacheWarmSuffixTokens = config.cacheWarmSuffixTokens;
	// All-message suffix per index, only when the cache guard is armed.
	const messageSuffix = cacheWarmSuffixTokens === undefined ? undefined : computeMessageSuffixTokens(entries);

	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		const message = getToolResultMessage(entry);
		if (!message) continue;

		const tokens = estimateTokens(message as AgentMessage);
		const isProtected = isProtectedToolResult(message, toolCallsById.get(message.toolCallId), config.protectedTools);

		if (message.prunedAt !== undefined) {
			accumulatedTokens += tokens;
			continue;
		}

		// Prompt-cache guard: a result whose all-message suffix exceeds the
		// warm-cache window sits in the already-sent cached prefix — mutating it
		// re-writes the whole suffix (cacheWrite premium). Entries before the
		// compaction boundary are summarized away (never sent). Both are skipped
		// before any prune decision, so superseded/useless cannot reach a deep,
		// still-cached copy; compaction/shake reclaim those when they rebuild.
		const inWarmPrefix =
			messageSuffix !== undefined && cacheWarmSuffixTokens !== undefined && messageSuffix[i] > cacheWarmSuffixTokens;
		if (inWarmPrefix || i < boundaryIndex) {
			accumulatedTokens += tokens;
			continue;
		}

		// Superseded and useless results bypass the age-based protect window
		// (a stale re-read copy, or a result the tool flagged as uninformative,
		// is dead weight at any age) — but only within the cache-warm tail: the
		// guard above already excluded deeper, still-cached copies.
		const superseded = supersededMessages?.has(message) ?? false;
		const useless = uselessMessages?.has(message) ?? false;
		const tooSmall = tokens < MIN_PRUNE_TOKENS;
		if (!superseded && !useless && (accumulatedTokens < config.protectTokens || isProtected || tooSmall)) {
			accumulatedTokens += tokens;
			continue;
		}

		candidates.push({ entry: entry as SessionMessageEntry, tokens, superseded, useless });
		// Dead weight being pruned away (superseded/useless) must not consume
		// the protectTokens window of the real results retained behind it.
		if (!superseded && !useless) accumulatedTokens += tokens;
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

/** Supersede targets for the `read` tool: a list of normalized target keys. */
export function readToolSupersedeKey(toolName: string, args: Record<string, unknown>): readonly string[] | undefined {
	if (toolName !== "read") return undefined;
	const path = args.path;
	if (typeof path !== "string" || path.length === 0) return undefined;
	const targets: string[] = [];
	const seen = new Set<string>();
	for (const chunk of path.split(";")) {
		const trimmed = chunk.trim();
		if (trimmed.length === 0) continue;
		if (trimmed.includes("://")) continue;
		const { path: base, sel } = splitReadSelector(trimmed);
		const target = sel === undefined ? base : `${base}\u0000${sel}`;
		if (target.length > 0 && !seen.has(target)) {
			seen.add(target);
			targets.push(target);
		}
	}
	return targets.length > 0 ? targets : undefined;
}
