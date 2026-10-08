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
	/** Every entry the pass rewrote in place, for a caller that persists only what changed. */
	prunedEntries: SessionMessageEntry[];
}

/** Exact placeholder written over a superseded tool result. */
export const SUPERSEDED_NOTICE = "[Superseded by a newer read of this file]";

/** Exact placeholder written over an elided useless tool result. */
export const USELESS_NOTICE = "[Uneventful result elided]";

/**
 * Maps a tool call to its supersede targets. A tool result is superseded when
 * every target it carries is covered by later (newer) tool results (either by an
 * identical target or by a selector-free read of the same base path).
 * Return `undefined` to exempt a call from supersede grouping.
 */
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
	/**
	 * Hard ceiling on how much sent context a rewrite may sit behind. A
	 * candidate whose all-message suffix EXCEEDS this is never rewritten, not
	 * even as part of a batch the cache math would otherwise pay for. Undefined
	 * = no ceiling, and the batch decides on price alone.
	 *
	 * Set to 0 for a model that binds thinking blocks to their conversation
	 * prefix: there the price of an in-place edit is not a cache write, it is
	 * every thinking block recorded after the edited message, which no amount
	 * of reclaimed tokens pays back.
	 */
	cacheWarmSuffixTokens?: number;
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

/**
 * For each entry index, the estimated token total of all *message* entries
 * strictly after it — how much prompt-cache content the provider must re-write
 * (cacheWrite premium) if that entry is mutated in place. Used to keep prune
 * mutations inside the cheap-to-recache tail.
 */
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

/** A tool result chosen for blanking, and the notice written over it. */
interface PruneVictim {
	entry: SessionMessageEntry;
	message: ToolResultMessage;
	tokens: number;
	/** Placeholder text written over the blanked result. */
	notice: string;
}

interface SupersedeCandidate extends PruneVictim {
	/** Index of the entry within the array the collector walked. */
	index: number;
}

/**
 * Collect superseded tool results: for every unpruned, unprotected tool result
 * whose paired call resolves supersede targets, the result is marked superseded
 * if and only if EVERY target it carries has been covered by later tool results.
 * A target is covered by an identical target or by a selector-free read of the
 * same base path. Partial cover (e.g. later read of `a.ts` when earlier read was
 * `a.ts; b.ts`) does NOT retire the earlier result, preserving content that has
 * not been re-read.
 * Returned in message order.
 */
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
		if (!toolCall || isProtectedToolResult(message, toolCall, protectedTools)) continue;
		const targets = supersedeTargets(message, toolCall, supersedeKey);
		if (targets === undefined) continue;

		// An earlier read is superseded only when EVERY target it carries is covered
		// by newer reads. A target is covered if an identical target was read later, or
		// if a selector-free read of the same base path was read later.
		const superseded = targets.every(target => isCoveredTarget(target, seenTargets));
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

/** The targets a result's call reads, or `undefined` when the result carries no file content or the call names none. */
function supersedeTargets(
	message: ToolResultMessage,
	toolCall: AgentToolCall,
	supersedeKey: SupersedeKeyFn,
): readonly string[] | undefined {
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
	if (toolResultNeverRan(message.details) || message.isError === true) return undefined;
	const rawKey = supersedeKey(toolCall.name, toolCall.arguments as Record<string, unknown>);
	if (rawKey === undefined) return undefined;
	const targets: readonly string[] =
		typeof rawKey === "string" ? [rawKey] : Array.isArray(rawKey) ? rawKey : Array.from(rawKey);
	return targets.length === 0 ? undefined : targets;
}

/** Whether a newer read covered `target`: the same target, or a selector-free read of its base path. */
function isCoveredTarget(target: string, seenTargets: ReadonlySet<string>): boolean {
	if (seenTargets.has(target)) return true;
	const sep = target.indexOf("\u0000");
	return sep >= 0 && seenTargets.has(target.slice(0, sep));
}

/**
 * Collect tool results their tool flagged contextually useless (zero matches,
 * elapsed wait): unpruned, non-error, unprotected, not in `exclude`, and large
 * enough that blanking to {@link USELESS_NOTICE} actually saves tokens.
 * Returned in message order.
 */
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

/**
 * Prune superseded tool results (e.g. stale `read` outputs replaced by a newer
 * read of the same file) and, when `pruneUseless` is set, results their tool
 * flagged contextually useless. Prompt-cache-aware in three ways: a candidate
 * whose own suffix is small is rewritten on its own (the read→edit→read loop), a
 * deeper BATCH is rewritten when its combined mass pays for the one cache write
 * it forces (see {@link chooseWorthwhileSweep}), and an idle context flushes
 * everything because its cache has expired anyway.
 * Never mutates entries before `keepBoundaryId` (summarized away — not sent),
 * and never walks them either: every scan covers the live tail, so a turn costs
 * the same on a session with a thousand compactions behind it as on a new one.
 */
export function pruneSupersededToolResults(entries: SessionEntry[], config: SupersedePruneConfig): PruneResult {
	const boundaryIndex = resolveCompactionBoundaryIndex(entries, config.keepBoundaryId);
	const live = boundaryIndex === 0 ? entries : entries.slice(boundaryIndex);
	const toolCallsById = collectToolCallsById(entries, boundaryIndex);
	const candidates = supersedeCandidates(live, toolCallsById, config);
	if (candidates.length === 0) return { prunedCount: 0, tokensSaved: 0, prunedEntries: [] };

	// Provider cache is cold (idle exceeds the retention TTL), so re-writing
	// the sent region costs nothing.
	const toPrune = cacheIsCold(live, config) ? candidates : cacheAwareVictims(candidates, live, config);
	if (toPrune.length === 0) return { prunedCount: 0, tokensSaved: 0, prunedEntries: [] };
	return blankVictims(toPrune, prunedSavings(toPrune));
}

/** Superseded results, and useless ones when `pruneUseless` is set, in message order. */
function supersedeCandidates(
	live: readonly SessionEntry[],
	toolCallsById: ReadonlyMap<string, AgentToolCall>,
	config: SupersedePruneConfig,
): SupersedeCandidate[] {
	const candidates = config.supersedeKey
		? collectSupersededResults(live, toolCallsById, config.supersedeKey, config.protectedTools)
		: [];
	if (!config.pruneUseless) return candidates;
	const exclude = new Set(candidates.map(candidate => candidate.message));
	const useless = collectUselessResults(live, toolCallsById, config.protectedTools, exclude);
	for (let ui = 0; ui < useless.length; ui++) candidates.push(useless[ui]!);
	candidates.sort((a, b) => a.index - b.index);
	return candidates;
}

/**
 * Whether the newest message on `live` is at least `idleFlushMs` old. Called with a candidate on `live`, so the
 * newest message on the branch is on `live` too. A newest message with no timestamp is not idle.
 */
function cacheIsCold(live: readonly SessionEntry[], config: SupersedePruneConfig): boolean {
	for (let i = live.length - 1; i >= 0; i--) {
		const entry = live[i];
		if (entry.type !== "message") continue;
		const timestamp = (entry.message as AgentMessage).timestamp;
		if (typeof timestamp !== "number") return false;
		return (config.now ?? Date.now()) - timestamp >= (config.idleFlushMs ?? DEFAULT_IDLE_FLUSH_MS);
	}
	return false;
}

/** The victims worth the cache rewrite they force: the cheap tail, or a deeper batch that pays for itself if larger. */
function cacheAwareVictims(
	candidates: SupersedeCandidate[],
	live: readonly SessionEntry[],
	config: SupersedePruneConfig,
): SupersedeCandidate[] {
	const suffixTokenLimit = config.suffixTokenLimit ?? DEFAULT_SUFFIX_TOKEN_LIMIT;
	// suffixTokens[i] = estimated tokens of all messages strictly after live[i].
	const suffixTokens = computeMessageSuffixTokens(live);
	const cacheWarmSuffixTokens = config.cacheWarmSuffixTokens;
	const eligible =
		cacheWarmSuffixTokens === undefined
			? candidates
			: candidates.filter(candidate => (suffixTokens[candidate.index] ?? 0) <= cacheWarmSuffixTokens);
	// The cheap tail: a candidate whose own suffix is small is worth rewriting on
	// its own, which is the read -> edit -> read loop.
	const tail = eligible.filter(candidate => suffixTokens[candidate.index] <= suffixTokenLimit);
	// Deeper than the tail, one victim never pays for the rewrite it forces, but a
	// batch of them does. Asking the question per candidate is why a long session
	// reclaimed almost nothing: at 120k of context every candidate outside the last
	// few thousand tokens failed the test alone, while together they were most of
	// the dead weight in the window.
	const batch = chooseWorthwhileSweep(eligible, suffixTokens, config);
	return batch.length > tail.length ? batch : tail;
}

function prunedSavings(victims: readonly PruneVictim[]): number {
	let tokensSaved = 0;
	for (const victim of victims) tokensSaved += estimatePrunedSavings(victim.tokens, victim.notice);
	return tokensSaved;
}

/** Replace each victim's content with its notice, every one stamped with the same `prunedAt`. */
function blankVictims(victims: readonly PruneVictim[], tokensSaved: number): PruneResult {
	const prunedAt = Date.now();
	const prunedEntries: SessionMessageEntry[] = [];
	for (const victim of victims) {
		victim.message.content = [{ type: "text", text: victim.notice }];
		victim.message.prunedAt = prunedAt;
		prunedEntries.push(victim.entry);
	}
	return { prunedCount: prunedEntries.length, tokensSaved, prunedEntries };
}

export function pruneToolOutputs(entries: SessionEntry[], config: PruneConfig = DEFAULT_PRUNE_CONFIG): PruneResult {
	// Entries before the compaction boundary are summarized away (never sent), so
	// nothing below walks them.
	const boundaryIndex = resolveCompactionBoundaryIndex(entries, config.keepBoundaryId);
	const live = boundaryIndex === 0 ? entries : entries.slice(boundaryIndex);
	const toolCallsById = collectToolCallsById(entries, boundaryIndex);
	const victims = ageVictims(live, toolCallsById, config, deadResults(live, toolCallsById, config));
	const tokensSaved = prunedSavings(victims);
	if (tokensSaved < config.minimumSavings || victims.length === 0) {
		return { prunedCount: 0, tokensSaved: 0, prunedEntries: [] };
	}
	return blankVictims(victims, tokensSaved);
}

/** The results that are dead weight at any age: superseded by a newer read, or flagged useless by their tool. */
interface DeadResults {
	superseded: ReadonlySet<ToolResultMessage> | undefined;
	useless: ReadonlySet<ToolResultMessage> | undefined;
}

function deadResults(
	live: readonly SessionEntry[],
	toolCallsById: ReadonlyMap<string, AgentToolCall>,
	config: PruneConfig,
): DeadResults {
	const superseded = config.supersedeKey
		? new Set(
				collectSupersededResults(live, toolCallsById, config.supersedeKey, config.protectedTools).map(
					candidate => candidate.message,
				),
			)
		: undefined;
	const useless =
		config.pruneUseless !== false
			? new Set(
					collectUselessResults(live, toolCallsById, config.protectedTools, superseded ?? new Set()).map(
						candidate => candidate.message,
					),
				)
			: undefined;
	return { superseded, useless };
}

/**
 * The results an age-based prune blanks, newest first: each unprotected result behind the newest `protectTokens` of
 * output and large enough to pay for its notice, and each dead result, apart from those in the warm cache prefix.
 */
function ageVictims(
	live: readonly SessionEntry[],
	toolCallsById: ReadonlyMap<string, AgentToolCall>,
	config: PruneConfig,
	dead: DeadResults,
): PruneVictim[] {
	const warmEnd = warmPrefixEnd(live, config.cacheWarmSuffixTokens);
	const victims: PruneVictim[] = [];
	let accumulatedTokens = 0;
	for (let i = live.length - 1; i >= 0; i--) {
		const entry = live[i];
		const message = getToolResultMessage(entry);
		if (!message) continue;
		const tokens = estimateTokens(message as AgentMessage);

		// Prompt-cache guard: a result whose all-message suffix exceeds the
		// warm-cache window sits in the already-sent cached prefix — mutating it
		// re-writes the whole suffix (cacheWrite premium). It is skipped before any
		// prune decision, so superseded/useless cannot reach a deep, still-cached
		// copy; compaction/shake reclaim those when they rebuild.
		if (message.prunedAt !== undefined || i < warmEnd) {
			accumulatedTokens += tokens;
			continue;
		}

		// Superseded and useless results bypass the age-based protect window
		// (a stale re-read copy, or a result the tool flagged as uninformative,
		// is dead weight at any age) — but only within the cache-warm tail: the
		// guard above already excluded deeper, still-cached copies. Dead weight
		// being pruned away must not consume the protectTokens window of the real
		// results retained behind it.
		const notice = deadNotice(message, dead);
		if (notice !== undefined) {
			victims.push({ entry: entry as SessionMessageEntry, message, tokens, notice });
			continue;
		}
		if (
			accumulatedTokens >= config.protectTokens &&
			tokens >= MIN_PRUNE_TOKENS &&
			!isProtectedToolResult(message, toolCallsById.get(message.toolCallId), config.protectedTools)
		) {
			victims.push({ entry: entry as SessionMessageEntry, message, tokens, notice: createPrunedNotice(tokens) });
		}
		accumulatedTokens += tokens;
	}
	return victims;
}

/**
 * The index the warm cache prefix ends at: each entry before it has more than `limit` tokens of messages after it,
 * and no entry from it on does, since that suffix only shrinks toward the end. 0 when the cache guard is unarmed.
 */
function warmPrefixEnd(live: readonly SessionEntry[], limit: number | undefined): number {
	if (limit === undefined) return 0;
	let after = 0;
	for (let i = live.length - 1; i >= 0; i--) {
		if (after > limit) return i + 1;
		const entry = live[i];
		if (entry.type === "message") after += estimateTokens(entry.message as AgentMessage);
	}
	return 0;
}

/** The notice a dead result is blanked to, superseded before useless; `undefined` for a result that is not dead. */
function deadNotice(message: ToolResultMessage, dead: DeadResults): string | undefined {
	if (dead.superseded?.has(message)) return SUPERSEDED_NOTICE;
	return dead.useless?.has(message) ? USELESS_NOTICE : undefined;
}

/**
 * Supersede targets for the `read` tool: a list of normalized target keys.
 * Selector-free reads key on the bare path; selector-carrying reads key on
 * `path + "\u0000" + selector` (via {@link splitReadSelector}).
 * Multi-target reads (`a.ts; b.ts`) are split into distinct targets.
 * URL and internal schemes (`skill://…`, `https://…`) are exempt per target.
 */
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
