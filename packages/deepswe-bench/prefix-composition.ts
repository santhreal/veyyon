/**
 * What a cache-read token is actually spent on, and what eliding a category of it
 * would buy.
 *
 * WHY THIS EXISTS. `cost-model.ts` answers "which billing line dominates" and the
 * answer on real runs is the prefix: across twenty baseline DeepSWE sessions,
 * 265.5M cache-read tokens and 23.7M fresh input tokens against 1.83M output
 * tokens, which prices as 85.5% of the bill spent re-reading the prompt and 14.5%
 * generating. That tells you WHERE to cut and nothing about WHAT to cut.
 *
 * This module answers the second question. It decomposes the prompt prefix by
 * category and weights each category by how many turns it sits in the prefix,
 * because that is what the provider actually bills. A 50KB tool result produced
 * on the last turn is read once. The same 50KB produced on turn three is read on
 * every turn after it, and costs proportionally more. A flat byte census cannot
 * see that difference and will point optimization effort at the wrong thing.
 *
 * The measurement that motivated this: a flat census of the conversation body put
 * thought signatures at 41.9% and tool results at 31.9%. Turn-weighted, signatures
 * are 37.4% and tool results 26.3%, with the system prompt appearing at 17.4%
 * despite being a single fixed block, because it sits in the prefix for every turn
 * of every session. The ordering survived here, but the magnitudes moved enough to
 * change what a lever is worth, and the system prompt only becomes visible at all
 * under turn weighting.
 *
 * Everything here is a pure function over already-parsed records. Reading session
 * files is the caller's job, so the arithmetic is testable without fixtures on
 * disk.
 */

import * as fs from "node:fs";
import * as path from "node:path";

// The spill substitution is measured from the functions that emit it, so a change
// to either string moves this prediction rather than leaving it stale.
import { artifactFooter, formatMiddleElisionMarker } from "@veyyon/coding-agent/session/streaming-output";
// The thinking window's boundary rule has exactly one owner: the provider code that
// applies it. Reimplementing it here would be a different lever with the same name.
import { firstRetainedAssistantIndex } from "@veyyon/ai/providers/google-shared";

import {
	type CostBreakdown,
	costShares,
	priceTokens,
	type RateCard,
	REFERENCE_RATE_CARD,
	type TokenMix,
} from "./cost-model";

/**
 * The categories a prompt prefix decomposes into.
 *
 * These are chosen to match the levers that can actually act on them, not to be a
 * tidy taxonomy. `signature` is separate from `thinking` because they are elided
 * by different settings and one is opaque provider state while the other is
 * readable text. `system` is separate from everything because it is the only
 * category a tool-discovery change can shrink.
 */
export type PrefixCategory =
	| "signature"
	| "toolResult"
	| "system"
	| "thinking"
	| "arguments"
	| "assistantText"
	| "userText";

/** Every category, in a fixed order, so reports and tests never depend on key iteration. */
export const PREFIX_CATEGORIES: readonly PrefixCategory[] = [
	"signature",
	"toolResult",
	"system",
	"thinking",
	"arguments",
	"assistantText",
	"userText",
] as const;

/**
 * Turn-weighted prefix mass, in character-turns.
 *
 * The unit is deliberately odd, and naming it honestly matters. One character
 * sitting in the prefix for one billed turn is one character-turn. A category's
 * value is therefore the integral of its size over the turns it was present for,
 * which is exactly the quantity cache reads are billed against. It is NOT a byte
 * count and must never be printed as one.
 */
export type PrefixMass = Record<PrefixCategory, number>;

/** A zeroed accumulator. Exported so a caller can fold many sessions into one total. */
export function emptyPrefixMass(): PrefixMass {
	return {
		signature: 0,
		toolResult: 0,
		system: 0,
		thinking: 0,
		arguments: 0,
		assistantText: 0,
		userText: 0,
	};
}

/** The size, in characters, that each category grew by at one point in a session. */
export type PrefixDelta = Partial<Record<PrefixCategory, number>>;

/**
 * One step in replaying a session: either the prefix grew, or a turn was billed
 * against the prefix as it stood.
 *
 * Modelling it as two distinct events rather than "a message" is the whole
 * correctness argument. The provider bills the prefix that existed BEFORE the
 * turn it generated, so a step that both grows the prefix and bills a turn is
 * ambiguous about ordering, and getting that ordering wrong silently inflates
 * every category by one turn's worth of its own contribution.
 */
export type PrefixStep = { kind: "grow"; delta: PrefixDelta } | { kind: "billedTurn" };

/**
 * Replay a session's steps and accumulate turn-weighted prefix mass.
 *
 * At every billed turn, the whole running prefix is charged once. Growth applied
 * after a turn is not charged for that turn, which is why the caller must emit the
 * `billedTurn` step BEFORE the growth from the assistant message that turn
 * produced. Getting this backwards is the one easy mistake here and it always
 * overstates, so it is pinned by test.
 *
 * Sessions fold additively: pass the previous total as `into` to accumulate across
 * a whole run rather than summing per-session shares, which would weight a
 * two-turn session the same as a two-hundred-turn one.
 */
export function accumulatePrefixMass(steps: Iterable<PrefixStep>, into: PrefixMass = emptyPrefixMass()): PrefixMass {
	const running = emptyPrefixMass();
	for (const step of steps) {
		if (step.kind === "billedTurn") {
			for (const category of PREFIX_CATEGORIES) into[category] += running[category];
			continue;
		}
		for (const category of PREFIX_CATEGORIES) running[category] += step.delta[category] ?? 0;
	}
	return into;
}

/** The sum of every category. Zero for an empty accumulator, never NaN. */
export function totalPrefixMass(mass: PrefixMass): number {
	return PREFIX_CATEGORIES.reduce((sum, category) => sum + mass[category], 0);
}

/**
 * Each category's share of the prefix, as a fraction in [0, 1].
 *
 * A zero total yields all-zero shares rather than NaN, so a report covering a
 * session that never billed a turn still prints instead of propagating NaN into
 * every downstream number.
 */
export function prefixShares(mass: PrefixMass): Record<PrefixCategory, number> {
	const total = totalPrefixMass(mass);
	const shares = emptyPrefixMass();
	if (total <= 0) return shares;
	for (const category of PREFIX_CATEGORIES) shares[category] = mass[category] / total;
	return shares;
}

/**
 * The fraction of the BILL that removing a set of prefix categories would buy, at
 * a measured cost breakdown.
 *
 * THIS IS THE CONVERSION EVERY COST CLAIM HERE DEPENDS ON, and the place a naive
 * prediction goes wrong. A category's share of the PREFIX is not its share of the
 * bill. Only the prompt-priced lines (fresh input and cache reads) shrink when the
 * prefix shrinks; output tokens are generated, not re-read, and are untouched by
 * any amount of context elision. So the prefix share must be scaled by the prompt
 * lines' share of the total.
 *
 * On the twenty-session baseline that means a lever removing 37.4% of the prefix
 * buys 37.4% x 85.5% = 32.0% of the bill, not 37.4%. Reporting the unscaled number
 * would overstate every lever by about a sixth, and would have let a lever that
 * cannot reach a 20% target look like it comfortably clears one.
 *
 * This is an UPPER BOUND and must be quoted as one. It assumes the elided bytes
 * vanish entirely, whereas a real lever usually substitutes something smaller
 * (Gemini's 33-character no-signature sentinel, an artifact pointer) and may cost
 * extra turns if the model has to recover what was removed. It also says nothing
 * about whether the model still solves the task, which is the reward gate's job
 * and the only question that can veto shipping a saving.
 */
export function predictedBillSaving(mass: PrefixMass, elided: readonly PrefixCategory[], cost: CostBreakdown): number {
	const shares = prefixShares(mass);
	const prefixFraction = elided.reduce((sum, category) => sum + shares[category], 0);
	const lines = costShares(cost);
	// Cache writes are a prompt line too: populating a cache pays for the same
	// prefix, so a smaller prefix writes less. Output alone is excluded.
	const promptShare = lines.input + lines.cacheRead + lines.cacheWrite;
	return prefixFraction * promptShare;
}

/**
 * A parsed line of a veyyon session transcript, described only as far as this
 * module reads it.
 *
 * Deliberately loose. The transcript is an append-only log that gains record
 * types over time, and a strict shape here would make an unrelated new record
 * type a hard failure in a measurement tool. Unknown records are ignored, which
 * is safe because every category below is opt-in: a record type this does not
 * know about contributes nothing rather than contributing wrongly.
 */
export interface TranscriptRecord {
	type?: string;
	systemPrompt?: string;
	tools?: unknown;
	message?: {
		role?: string;
		usage?: unknown;
		/** Present on a toolResult, linking it back to the call that produced it. */
		toolCallId?: string;
		id?: string;
		/** Some writers name the tool on the result directly rather than only on the call. */
		toolName?: string;
		content?: Array<{
			type?: string;
			text?: string;
			thinking?: string;
			thoughtSignature?: string;
			arguments?: unknown;
			/** Present on a toolCall: which tool it is, and the id its result carries back. */
			name?: string;
			toolCallId?: string;
			id?: string;
		}>;
	};
}

/**
 * Turn a parsed session transcript into the steps {@link accumulatePrefixMass}
 * replays.
 *
 * THE ORDERING RULE LIVES HERE, and it is the only subtle thing in the file. An
 * assistant message carrying `usage` is evidence that a turn was billed, and what
 * it was billed for is the prefix as it stood BEFORE that message existed. So the
 * `billedTurn` step is emitted first and the message's own content is added
 * afterwards. Reversing those two lines would charge every assistant turn for its
 * own output as though the model had read it, which inflates the signature and
 * thinking categories specifically, because those are the parts an assistant
 * message contributes.
 *
 * An assistant message with no `usage` is a replayed or synthetic turn that cost
 * nothing, so it grows the prefix without billing. That distinction is why
 * presence of `usage` is the signal rather than the role alone.
 *
 * The system prompt and the tool schemas are folded into one `system` figure,
 * because both are fixed blocks that sit in the prefix for the entire session and
 * no lever moves one without the other.
 */
export function sessionPrefixSteps(records: Iterable<TranscriptRecord>): PrefixStep[] {
	const steps: PrefixStep[] = [];
	for (const record of records) {
		if (record.type === "session_init") {
			const system = (record.systemPrompt ?? "").length + JSON.stringify(record.tools ?? []).length;
			if (system > 0) steps.push({ kind: "grow", delta: { system } });
			continue;
		}
		if (record.type !== "message") continue;
		const message = record.message;
		if (!message) continue;
		const content = message.content ?? [];
		if (message.role === "assistant") {
			if (message.usage) steps.push({ kind: "billedTurn" });
			const delta: PrefixDelta = {};
			for (const block of content) {
				if (block.type === "toolCall") {
					delta.signature = (delta.signature ?? 0) + (block.thoughtSignature ?? "").length;
					delta.arguments = (delta.arguments ?? 0) + JSON.stringify(block.arguments ?? {}).length;
				} else if (block.type === "thinking") {
					delta.thinking = (delta.thinking ?? 0) + (block.thinking ?? "").length;
				} else if (block.type === "text") {
					delta.assistantText = (delta.assistantText ?? 0) + (block.text ?? "").length;
				}
			}
			steps.push({ kind: "grow", delta });
			continue;
		}
		if (message.role === "toolResult") {
			const toolResult = content.reduce((sum, block) => sum + (block.text ?? "").length, 0);
			steps.push({ kind: "grow", delta: { toolResult } });
			continue;
		}
		if (message.role === "user") {
			const userText = content.reduce(
				(sum, block) => sum + (block.type === "text" ? (block.text ?? "").length : 0),
				0,
			);
			steps.push({ kind: "grow", delta: { userText } });
		}
	}
	return steps;
}

/**
 * Pair every billed turn's visible prefix size with the prompt tokens the
 * provider charged for it, which is the input {@link calibratePrefix} fits.
 *
 * Derived by replaying the same steps the mass accounting uses, so a calibration
 * can never be measuring a different walk of the transcript than the composition
 * it is meant to validate. A turn whose usage records no prompt tokens is skipped
 * rather than treated as zero: an absent count is unknown, and folding it in as a
 * zero would drag the fitted line toward a fabricated origin.
 */
export function prefixObservations(records: TranscriptRecord[]): PrefixObservation[] {
	const usages: number[] = [];
	for (const record of records) {
		if (record.type !== "message") continue;
		const usage = record.message?.usage as Record<string, number> | undefined;
		if (record.message?.role !== "assistant" || !usage) continue;
		usages.push((usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0));
	}
	const observations: PrefixObservation[] = [];
	let visible = 0;
	let turn = 0;
	for (const step of sessionPrefixSteps(records)) {
		if (step.kind === "billedTurn") {
			const promptTokens = usages[turn++];
			if (promptTokens) observations.push({ visibleChars: visible, promptTokens });
			continue;
		}
		for (const category of PREFIX_CATEGORIES) visible += step.delta[category] ?? 0;
	}
	return observations;
}

/** How much of a turn's prompt was served from cache, against how much of it was genuinely new. */
export interface CacheEfficiency {
	/** Prompt tokens billed at the fresh-input rate across every turn. */
	readonly uncachedTokens: number;
	/**
	 * Prompt tokens served from the prefix cache across every turn. These are the
	 * only real hits: they are the one prompt line billed BELOW the input rate.
	 */
	readonly cachedTokens: number;
	/**
	 * Prompt tokens billed as cache WRITES across every turn.
	 *
	 * Kept separate from `cachedTokens` deliberately, and the separation is the
	 * whole point of this field. A write is not a hit: it is billed ABOVE the
	 * input rate, not a quarter of it. Folding writes into the hit count makes
	 * two providers with different cache designs look identical when they are
	 * not, because a provider with an implicit cache never charges a write while
	 * one with a moving explicit breakpoint charges one every single turn. That
	 * is a difference of several times the price on the same tokens, and a
	 * combined "hit rate" hides it completely.
	 */
	readonly cacheWriteTokens: number;
	/**
	 * Tokens that were new on the turn they were charged for, estimated from the
	 * transcript's own growth at the measured character rate. This is the floor: a
	 * perfect cache would bill exactly this much at the fresh rate.
	 */
	readonly newContentTokens: number;
	/** Fresh-rate tokens beyond that floor, i.e. content re-read at 4x its cached price. */
	readonly rebilledTokens: number;
}

/** Everything billed at or above the input rate, which is everything that is not a hit. */
export function freshTokens(efficiency: CacheEfficiency): number {
	return efficiency.uncachedTokens + efficiency.cacheWriteTokens;
}

/**
 * The share of prompt tokens actually served from cache.
 *
 * Writes are in the denominator and not the numerator, because a write is a
 * token you paid a premium for, not one the cache saved you.
 */
export function cacheHitRate(efficiency: CacheEfficiency): number {
	const prompt = efficiency.cachedTokens + freshTokens(efficiency);
	return prompt > 0 ? efficiency.cachedTokens / prompt : 0;
}

/**
 * The average price actually paid per fresh token, blending input and write rates.
 *
 * A provider that routes new content through cache writes pays more per fresh
 * token than one that routes it through plain input, so the overpay on a re-read
 * has to be priced against the mix that turn really used rather than against the
 * input rate alone.
 */
export function freshRate(efficiency: CacheEfficiency, rates: RateCard): number {
	const fresh = freshTokens(efficiency);
	if (fresh <= 0) return rates.input;
	return (efficiency.uncachedTokens * rates.input + efficiency.cacheWriteTokens * rates.cacheWrite) / fresh;
}

/**
 * Measure how much of the prompt bill is content the provider had already been
 * sent, and re-read at the fresh-input rate anyway.
 *
 * WHY THIS IS WORTH ITS OWN MEASUREMENT. Every other lever in this module removes
 * something from the context and therefore risks the model's behaviour. This one
 * removes nothing: the same bytes reach the model either way, and the only thing
 * that changes is which rate they are billed at. A saving here cannot cost reward,
 * which makes it the cheapest kind of win available and worth knowing about before
 * any lever that trades context for money.
 *
 * Measured on the twenty-session DeepSWE baseline: the median turn is charged 6.5
 * times more uncached input than the content it actually added, and 83% of all
 * fresh-input tokens are re-reads. Priced, that is $4.42 of a $31.59 bill, 14.0%,
 * spent on nothing.
 *
 * The estimate is deliberately conservative about what counts as waste. New
 * content is derived from the transcript's own growth at the calibrated character
 * rate, so a turn that genuinely added a large tool result is credited for it, and
 * only the excess above that is called re-billed. Idle time is NOT the cause here
 * and should not be assumed to be: gaps before a cache-missing turn were no longer
 * than before a hit, 1.5 versus 2.1 seconds at the median.
 */
export function cacheEfficiency(records: TranscriptRecord[], charsPerToken: number): CacheEfficiency {
	let uncachedTokens = 0;
	let cachedTokens = 0;
	let cacheWriteTokens = 0;
	let newContentTokens = 0;
	let rebilledTokens = 0;
	const usages: { input: number; read: number; write: number }[] = [];
	for (const record of records) {
		if (record.type !== "message" || record.message?.role !== "assistant") continue;
		const usage = record.message.usage as Record<string, number> | undefined;
		if (!usage) continue;
		usages.push({ input: usage.input ?? 0, read: usage.cacheRead ?? 0, write: usage.cacheWrite ?? 0 });
	}
	let visible = 0;
	let lastVisible = 0;
	let turn = 0;
	for (const step of sessionPrefixSteps(records)) {
		if (step.kind === "billedTurn") {
			const usage = usages[turn++];
			if (!usage) continue;
			const added = Math.max(0, (visible - lastVisible) / charsPerToken);
			lastVisible = visible;
			// Everything not served from the cache is fresh, whether the provider
			// billed it as input or as a write. A write is the more expensive of
			// the two, so charging it to the hit column would flatter the result.
			const fresh = usage.input + usage.write;
			uncachedTokens += usage.input;
			cachedTokens += usage.read;
			cacheWriteTokens += usage.write;
			newContentTokens += Math.min(added, fresh);
			rebilledTokens += Math.max(0, fresh - added);
			continue;
		}
		for (const category of PREFIX_CATEGORIES) visible += step.delta[category] ?? 0;
	}
	return { uncachedTokens, cachedTokens, cacheWriteTokens, newContentTokens, rebilledTokens };
}

/**
 * What the re-billed tokens cost above what they would have cost as cache hits,
 * as a fraction of the total bill.
 *
 * The saving is the RATE DIFFERENCE, not the whole fresh-input line: those tokens
 * still have to be sent, they would simply be billed as cache reads. Quoting the
 * full line would overstate the lever by a factor of four, which is the same
 * mistake as quoting a prefix share as a bill share.
 */
export function rebilledCostShare(efficiency: CacheEfficiency, cost: CostBreakdown, rates: RateCard): number {
	if (cost.total <= 0) return 0;
	const overpaid = (efficiency.rebilledTokens * (freshRate(efficiency, rates) - rates.cacheRead)) / 1_000_000;
	return overpaid / cost.total;
}

/** One billed turn: the prefix we can see, against the prompt tokens the provider charged for. */
export interface PrefixObservation {
	readonly visibleChars: number;
	readonly promptTokens: number;
}

/**
 * Fit `promptTokens = visibleChars / charsPerToken + unseen` across billed turns.
 *
 * WHY THIS EXISTS. Every number in this module counts characters in a transcript,
 * and the provider bills tokens on a prompt the transcript does not fully record:
 * tool schemas are sent as a structured array while the session log stores only
 * tool names. If that hidden mass were large, every share here would be inflated
 * and every predicted saving overstated, with nothing in the output to show it.
 *
 * Regressing what the provider charged against what the transcript shows measures
 * that gap instead of assuming it away. Two numbers come out and both are
 * checkable. `charsPerToken` should land in the normal range for prose and code,
 * roughly 3.5 to 4.5; a much lower figure means real prefix mass is missing from
 * the fit. `unseenChars` is the fixed block the transcript never sees, expressed
 * in characters so it can be compared directly against the categories.
 *
 * Measured on the twenty-session baseline: 3.88 characters per token and 6,143
 * characters unseen, which adds 1.3% to the total prefix and moves the signature
 * lever's prediction from 22.7% to 22.5% of the bill. The census is sound, and
 * that is now a measurement rather than a hope.
 *
 * Returns null for fewer than two observations or for a degenerate fit (every
 * turn showing the same visible size), because a slope through one point is not a
 * calibration and reporting one would be worse than reporting nothing.
 */
export function calibratePrefix(
	observations: readonly PrefixObservation[],
): { charsPerToken: number; unseenChars: number } | null {
	const n = observations.length;
	if (n < 2) return null;
	let sx = 0;
	let sy = 0;
	let sxx = 0;
	let sxy = 0;
	for (const { visibleChars, promptTokens } of observations) {
		sx += visibleChars;
		sy += promptTokens;
		sxx += visibleChars * visibleChars;
		sxy += visibleChars * promptTokens;
	}
	const denominator = n * sxx - sx * sx;
	if (denominator === 0) return null;
	const slope = (n * sxy - sx * sy) / denominator;
	if (slope <= 0) return null;
	const intercept = (sy - slope * sx) / n;
	return { charsPerToken: 1 / slope, unseenChars: intercept / slope };
}

/**
 * What capping every inline tool result at `cap` characters would remove from the
 * prefix, in character-turns.
 *
 * This exists because the category total is misleading on its own. Tool results
 * are 26.3% of the prefix, which reads like a lever worth 22.5% of the bill, and a
 * size cap cannot get near that. The mass is spread across many mid-sized results
 * rather than concentrated in a few giants, so a cap only reaches the tail:
 * measured on the twenty-session baseline, the shipped 50KB threshold removes
 * 0.6% of the prefix, 20KB removes 2.4%, 5KB removes 6.2%, and even a brutal 1KB
 * cap that would spill most `eval` output reaches 17.5%.
 *
 * That is the answer a category total cannot give, and it is why this returns a
 * simulation rather than a share. Deciding a lever is worth building from
 * `toolResult: 26.3%` alone would spend the effort and land at a twentieth of the
 * expected saving.
 *
 * Counts only the excess above the cap, since a spilled result still leaves a
 * pointer behind. That makes the number a slight OVERestimate of the saving, which
 * is the safe direction for a lever's upper bound: the pointer's own bytes are not
 * subtracted.
 *
 * TOOLS THE SHIPPED SPILL DOES NOT TOUCH ARE EXCLUDED, and leaving them in was a
 * real error rather than a rounding one. `read` is exempt from artifact spill on
 * purpose: it is bounded by LINES, not bytes, so a byte spill would return fewer
 * lines than the caller asked for and break the one contract the tool has.
 * Simulating a cap over its output predicts a saving the shipped lever cannot
 * deliver, and `read` carried the largest mean result in the Claude baseline, so
 * the overstatement was not small.
 */
export const SPILL_EXEMPT_TOOLS: readonly string[] = ["read"];

/** Map every tool call's id to its name, so a result can be attributed to the tool that produced it. */
function toolNamesById(records: Iterable<TranscriptRecord>): Map<string, string> {
	const names = new Map<string, string>();
	for (const record of records) {
		if (record.type !== "message" || record.message?.role !== "assistant") continue;
		for (const block of record.message.content ?? []) {
			if (block.type !== "toolCall") continue;
			const id = block.toolCallId ?? block.id;
			if (typeof id === "string" && typeof block.name === "string") names.set(id, block.name);
		}
	}
	return names;
}

/**
 * What a spilled tool result costs INSTEAD of the bytes it replaces.
 *
 * A spill does not remove the elided region, it substitutes a middle-elision
 * marker and an `artifact://` footer pointing at the full output, and both ride in
 * the prefix on every later turn exactly as the elided bytes would have. This is
 * the same correction the signature simulation makes for the 33-character
 * `skip_thought_signature_validator` sentinel, and it was missing here: the
 * tool-result simulation credited the whole overflow and so read slightly
 * optimistic at every threshold.
 *
 * It is DERIVED FROM THE SHIPPED FUNCTIONS rather than pasted as a number, so a
 * change to either string moves the prediction with it. The arguments are
 * representative rather than exact (a two-digit artifact id, a three-digit elided
 * line count) because both strings vary by a character or two with the values
 * inside them, and that variance is far below the threshold being simulated.
 */
export const SPILL_SUBSTITUTION_CHARS =
	artifactFooter("12").length + formatMiddleElisionMarker(120, 4000).length + 2;

export function simulateToolResultCap(
	records: TranscriptRecord[],
	cap: number,
	exempt: readonly string[] = SPILL_EXEMPT_TOOLS,
): { removed: number; total: number; spilled: number; results: number } {
	const names = toolNamesById(records);
	const exemptSet = new Set(exempt);
	let removed = 0;
	let total = 0;
	let running = 0;
	let spilled = 0;
	let resultCount = 0;
	// Every result currently in the prefix, with whether the shipped spill can act on it.
	const results: { chars: number; cappable: boolean }[] = [];
	for (const record of records) {
		if (record.type === "session_init") {
			running += (record.systemPrompt ?? "").length + JSON.stringify(record.tools ?? []).length;
			continue;
		}
		if (record.type !== "message" || !record.message) continue;
		const message = record.message;
		const content = message.content ?? [];
		if (message.role === "assistant") {
			if (message.usage) {
				total += running + results.reduce((sum, r) => sum + r.chars, 0);
				removed += results.reduce(
					(sum, r) => sum + (r.cappable ? spillSaving(r.chars, cap) : 0),
					0,
				);
			}
			for (const block of content) {
				if (block.type === "toolCall") {
					running += JSON.stringify(block.arguments ?? {}).length;
					running += (block.thoughtSignature ?? "").length;
				} else if (block.type === "thinking") {
					running += (block.thinking ?? "").length;
				} else if (block.type === "text") {
					running += (block.text ?? "").length;
				}
			}
			continue;
		}
		if (message.role === "toolResult") {
			const chars = content.reduce((sum, block) => sum + (block.text ?? "").length, 0);
			if (chars > 0) {
				const id = message.toolCallId ?? message.id;
				const name = (typeof id === "string" ? names.get(id) : undefined) ?? message.toolName;
				const cappable = !exemptSet.has(name ?? "");
				results.push({ chars, cappable });
				resultCount += 1;
				if (cappable && spillSaving(chars, cap) > 0) spilled += 1;
			}
			continue;
		}
		if (message.role === "user") {
			running += content.reduce((sum, b) => sum + (b.type === "text" ? (b.text ?? "").length : 0), 0);
		}
	}
	return { removed, total, spilled, results: resultCount };
}

/**
 * Characters a spill actually saves on one result, or zero if it would not spill.
 *
 * The rule the shipped code follows is that a result at or under the threshold is
 * untouched. Above it, the kept window plus the marker and footer go on the wire,
 * so the saving is the overflow minus the substitution. That subtraction can make
 * the saving NEGATIVE just above the threshold, and returning zero there is not a
 * rounding convenience: a result whose overflow is smaller than the substitution
 * would cost more spilled than sent, and crediting the negative would let a tight
 * threshold silently borrow saving from results it makes worse.
 */
function spillSaving(chars: number, cap: number): number {
	if (chars <= cap) return 0;
	return Math.max(0, chars - cap - SPILL_SUBSTITUTION_CHARS);
}

/**
 * Fold every session under a run's `jobs/` directory into one prefix mass, and
 * add up the usage the same sessions reported.
 *
 * Both halves come from the same files on purpose. A composition measured on one
 * set of sessions and priced against another set's token counts would produce a
 * prediction that cannot be checked against anything, and the mismatch would be
 * invisible in the output.
 *
 * `armPrefix` selects which arm's sessions to read (`baseline__` by default),
 * because a prediction is only meaningful against the arm it would be applied to.
 * A malformed transcript line is skipped rather than fatal: these logs are written
 * by a process that can be killed mid-write, and a truncated final line must not
 * cost the whole measurement.
 */
/**
 * The inline-output caps the sweep reports, from the shipped default down to a
 * value tight enough to spill most `eval` output. Fixed rather than derived so two
 * runs' sweeps are directly comparable, and wide enough to show that the curve is
 * flat where it matters: the interesting fact is how little the large caps buy.
 */
export const CAP_SWEEP = [50_000, 20_000, 10_000, 5000, 2000, 1000] as const;

/**
 * One threshold's entry in the inline-output sweep.
 *
 * `spilled` against `results` is the RISK half of the trade and the reason this is
 * a record rather than a bare number. The saving alone says how much a threshold
 * removes; only the spill rate says how much content the model has to spend a turn
 * fetching back. The signature sweep has carried that pairing from the start, the
 * tool-result sweep did not, and the arm file for the tightest threshold described
 * its own risk as "a large share of ordinary eval output" with no figure behind it.
 */
export interface CapSweepPoint {
	/** Character-turns removed, net of the marker and footer that replace them. */
	removed: number;
	/** Results that would spill at this threshold, counted once each. */
	spilled: number;
	/** Non-empty tool results in the transcripts, spilled or not. */
	results: number;
}

/**
 * The signature length caps the sweep reports, matching `arms/sig-max4000.yml`.
 *
 * Fixed rather than derived so two runs' sweeps are directly comparable, and chosen
 * to bracket the shipped arm so the arm's own headline can be read straight off the
 * table rather than recomputed by hand.
 */
export const SIGNATURE_CAP_SWEEP = [8000, 4000, 2000, 1000] as const;

/**
 * What capping every thought signature at `cap` characters would remove from the
 * prefix, in character-turns, and how many tool calls it would touch.
 *
 * WHY THIS EXISTS AS A TESTED FUNCTION RATHER THAN A CALCULATION. The 22.7% figure
 * that justifies `arms/sig-max4000.yml` was originally worked out by hand, which
 * meant the headline number for the primary cost lever could not be reproduced from
 * the instrument, could not be re-derived on a new run, and had no test standing
 * behind it. Every other lever here is simulated; this one was asserted. That is
 * exactly the asymmetry that lets a wrong number survive, and it is how the tool
 * result cap came to be sized against a simulation of a lever the code does not
 * implement.
 *
 * A capped signature is not removed, it is REPLACED by Gemini's 33-character
 * `skip_thought_signature_validator` sentinel, so the saving per signature is its
 * length minus that, never its whole length. Ignoring the substitution would
 * overstate the lever by 33 characters per signature per turn, which over a long
 * session is not negligible.
 *
 * `touched` counts the tool calls that lose their signature, which is the honest
 * measure of how much reasoning replay the arm gives up, and the number that makes
 * a size cap and a recency window comparable: the cap reaches 22.7% of the bill by
 * touching about 15% of tool calls, where a one-message recency window reaches 32%
 * by touching 100% of history.
 */
export function simulateSignatureCap(records: TranscriptRecord[], cap: number): SignatureSimulation {
	return simulateSignatureLever(records, { kind: "sizeCap", maxLength: cap });
}

/** What a signature lever removes from the prefix, and what it gives up to get it. */
export interface SignatureSimulation {
	/** Character-turns the lever stops sending, already net of the sentinel. */
	readonly removed: number;
	/** Character-turns the prefix costs without the lever, for the same walk. */
	readonly total: number;
	/** Signatures elided on at least one billed turn. */
	readonly touched: number;
	/** Signatures present in the session, elided or not. */
	readonly signatures: number;
}

/** The 33-character sentinel Gemini accepts in place of a real thought signature. */
export const SKIP_SIGNATURE_CHARS = 33;

/**
 * How a signature lever decides, per signature, whether to send it.
 *
 * `sizeCap` keys the decision off the signature's OWN length, which never changes.
 * `retainLast` keys it off distance from the end of the conversation, which moves
 * forward by one every turn. That difference is not a detail of implementation; it
 * decides whether the lever is compatible with a prefix cache at all.
 */
export type SignatureLever =
	| { kind: "stock" }
	| { kind: "sizeCap"; maxLength: number }
	| { kind: "retainLast"; assistantMessages: number };

/**
 * A recency window over THINKING blocks rather than signatures.
 *
 * It is a separate lever kind and not a third `SignatureLever` case because the two
 * differ in what replaces the elided bytes: a dropped signature is replaced by the
 * 33-character sentinel the API requires, a dropped thinking part is replaced by
 * nothing at all. Folding it in would make the sentinel conditional inside a
 * predicate whose whole value is that it is unconditional.
 *
 * The boundary rule is the same, and that is verified rather than assumed. The
 * provider's own `firstRetainedAssistantIndex` counts back over assistant messages
 * and returns a message index, which for a block attached to an assistant message
 * is exactly "retained iff its assistant index is within the last K".
 */
export type ThinkingLever = { kind: "thinkingRetainLast"; assistantMessages: number };

/** Any lever whose cache compatibility `prefixStability` can decide. */
export type PrefixLever = SignatureLever | ThinkingLever;

/** One signature in a session, with the position that a recency rule judges it by. */
interface SignatureSite {
	/** Index of the assistant message carrying it, counted from the start. */
	readonly assistantIndex: number;
	readonly length: number;
	/**
	 * What goes on the wire in place of this item when a lever elides it.
	 *
	 * 33 for a signature, which the API replaces with
	 * `skip_thought_signature_validator`, and 0 for a thinking part, which is simply
	 * omitted. Carrying it per site rather than as a constant is what lets one
	 * predicate serve both without making the substitution conditional on the lever.
	 */
	readonly sentinel: number;
}

/** The characters a lever sends for one signature, on a turn with `total` assistant messages so far. */
function sentLength(lever: PrefixLever, site: SignatureSite, assistantMessagesSoFar: number): number {
	if (lever.kind === "stock") return site.length;
	if (lever.kind === "sizeCap") {
		return site.length > lever.maxLength ? site.sentinel : site.length;
	}
	const retainFrom = assistantMessagesSoFar - lever.assistantMessages;
	return site.assistantIndex < retainFrom ? site.sentinel : site.length;
}

/** What a lever does to the cacheable prefix, measured across a session's turns. */
export interface PrefixStability {
	/** Turns compared, i.e. one less than the number of billed turns in the session. */
	readonly comparisons: number;
	/** Comparisons where the previous turn's rendered prefix survived intact. */
	readonly stableComparisons: number;
	/**
	 * Signature characters that a turn re-rendered DIFFERENTLY from the turn before.
	 * Every byte from the first such change onward is uncacheable on that turn.
	 */
	readonly rewrittenSignatureChars: number;
	/**
	 * Characters that WERE cacheable and stop being so, summed over turns.
	 *
	 * THIS IS THE NUMBER THAT DECIDES A LEVER, and it is not the same as the
	 * rewritten characters above. A cache matches a leading run of bytes, so a single
	 * rewritten character costs everything AFTER it, not itself. A recency window
	 * rewrites very little and can still invalidate a large tail; it can equally
	 * rewrite near the end of the conversation and cost almost nothing. Only this
	 * figure separates the two cases, and it is in the same character-turn unit as
	 * the prefix mass, so it can be priced against the same bill.
	 */
	readonly invalidatedCharTurns: number;
}

/**
 * Whether a signature lever is compatible with a prefix cache, and by how much.
 *
 * WHY THIS MEASUREMENT DECIDES WHETHER A LEVER IS REAL. Every prediction elsewhere
 * in this module assumes the elided bytes simply stop being sent, so removing 22.7%
 * of the prefix saves 22.7% of the prompt lines. That assumption holds ONLY if the
 * rest of the prefix still renders byte-identically to the previous turn. A prefix
 * cache matches on an exact leading run of bytes, so a lever that rewrites a byte
 * in the MIDDLE of the history invalidates the cache from that point to the end,
 * and every byte after it is re-billed at the fresh rate. Measured on this bench
 * the fresh rate is four times the cached rate, so a lever can remove a fifth of
 * the prefix and still cost more than it saves.
 *
 * The two levers built here differ exactly on this axis, and it is not obvious from
 * their descriptions:
 *
 * - A SIZE CAP asks whether one signature is longer than the cap. A signature's
 *   length never changes, so the answer is fixed for the life of the session and
 *   the rendered prefix is byte-stable. Cache-safe by construction.
 * - A RECENCY WINDOW asks whether a signature is among the last K assistant
 *   messages. That is a moving boundary: a signature retained on this turn is
 *   history on the next and gets replaced by the sentinel, rewriting bytes already
 *   sent. Every turn invalidates the cache from the boundary onward.
 *
 * The damage from a recency window is bounded by how deep the boundary sits, which
 * is why the figure is worth measuring rather than assuming: with K=1 the rewrite
 * lands in the conversation tail that was uncached anyway, so it may cost nothing,
 * while a larger K rewrites deeper into the cached region.
 */
export function prefixStability(records: TranscriptRecord[], lever: PrefixLever): PrefixStability {
	// The prefix as an ordered list of items, in the order they reach the wire. Only
	// signature items change length under a lever; everything else is fixed, but the
	// fixed items still have to be here because they are what a rewrite invalidates.
	const items: { site: SignatureSite | null; chars: number }[] = [];
	let assistantMessages = 0;
	let previous: number[] | null = null;
	let comparisons = 0;
	let stableComparisons = 0;
	let rewrittenSignatureChars = 0;
	let invalidatedCharTurns = 0;

	const render = (): number[] =>
		items.map(item => (item.site === null ? item.chars : sentLength(lever, item.site, assistantMessages)));

	for (const record of records) {
		if (record.type === "session_init") {
			const system = (record.systemPrompt ?? "").length + JSON.stringify(record.tools ?? []).length;
			if (system > 0) items.push({ site: null, chars: system });
			continue;
		}
		if (record.type !== "message" || !record.message) continue;
		const message = record.message;
		const content = message.content ?? [];
		if (message.role === "assistant") {
			// The turn is billed against the prefix that preceded it, exactly as the mass
			// accounting does, so its own blocks are appended after the comparison.
			if (message.usage) {
				const rendered = render();
				if (previous !== null) {
					comparisons += 1;
					let firstChange = -1;
					for (let index = 0; index < previous.length; index++) {
						if (previous[index] !== rendered[index]) {
							firstChange = index;
							break;
						}
					}
					if (firstChange === -1) {
						stableComparisons += 1;
					} else {
						for (let index = firstChange; index < previous.length; index++) {
							invalidatedCharTurns += previous[index] ?? 0;
							if (previous[index] !== rendered[index]) rewrittenSignatureChars += previous[index] ?? 0;
						}
					}
				}
				previous = rendered;
			}
			// Only the category this lever acts on becomes a levered site; everything
			// else is fixed mass that a rewrite can invalidate but never changes itself.
			const leversThinking = lever.kind === "thinkingRetainLast";
			for (const block of content) {
				if (block.type === "toolCall") {
					const length = (block.thoughtSignature ?? "").length;
					if (length > 0) {
						items.push({
							site: leversThinking
								? null
								: { assistantIndex: assistantMessages, length, sentinel: SKIP_SIGNATURE_CHARS },
							chars: length,
						});
					}
					items.push({ site: null, chars: JSON.stringify(block.arguments ?? {}).length });
				} else if (block.type === "thinking") {
					const length = (block.thinking ?? "").length;
					items.push({
						site: leversThinking ? { assistantIndex: assistantMessages, length, sentinel: 0 } : null,
						chars: length,
					});
				} else if (block.type === "text") {
					items.push({ site: null, chars: (block.text ?? "").length });
				}
			}
			assistantMessages += 1;
			continue;
		}
		if (message.role === "toolResult") {
			items.push({ site: null, chars: content.reduce((sum, block) => sum + (block.text ?? "").length, 0) });
			continue;
		}
		if (message.role === "user") {
			items.push({
				site: null,
				chars: content.reduce((sum, block) => sum + (block.type === "text" ? (block.text ?? "").length : 0), 0),
			});
		}
	}
	return { comparisons, stableComparisons, rewrittenSignatureChars, invalidatedCharTurns };
}

/**
 * What ANY signature lever would remove from the prefix, in character-turns.
 *
 * WHY THIS IS ONE FUNCTION AND NOT TWO. The cap simulation and the retention
 * simulation differ only in the per-signature predicate, and that predicate already
 * has exactly one owner in `sentLength`, which `prefixStability` uses to decide
 * cache compatibility. Writing a second copy of the cap rule inside a simulator is
 * how a lever comes to be measured under one definition and cached under another,
 * and the two would then be free to drift apart without any test noticing. The cap
 * simulation is now a two-line wrapper over this, so a change to the rule reaches
 * the saving, the stability, and the sweep together.
 *
 * `removed` is already net of the 33-character `skip_thought_signature_validator`
 * sentinel that replaces an elided signature, because that is what actually goes on
 * the wire. `total` is the same prefix walk with no lever, so `removed / total` is
 * the share of the prefix the lever stops paying for.
 *
 * READ `removed` TOGETHER WITH `prefixStability`, NEVER ALONE. This function
 * measures gross bytes not sent; it cannot see that a recency window hands part of
 * that back by invalidating cached bytes behind the moving boundary. A size cap
 * gives back nothing, a `retainLast` window gives back whatever
 * `invalidatedCharTurns` says, and only the pair of numbers ranks the two.
 *
 * `touched` counts signatures elided on at least ONE billed turn, which is the
 * comparable measure of reasoning replay given up. A cap either elides a signature
 * on every turn or never, so this is just how many exceeded the cap; a recency
 * window elides nearly everything eventually, and the count says so.
 */
export function simulateSignatureLever(records: TranscriptRecord[], lever: SignatureLever): SignatureSimulation {
	let removed = 0;
	let total = 0;
	let running = 0;
	let signatures = 0;
	let assistantMessages = 0;
	const sites: SignatureSite[] = [];
	const everElided = new Set<number>();
	for (const record of records) {
		if (record.type === "session_init") {
			running += (record.systemPrompt ?? "").length + JSON.stringify(record.tools ?? []).length;
			continue;
		}
		if (record.type !== "message" || !record.message) continue;
		const message = record.message;
		const content = message.content ?? [];
		if (message.role === "assistant") {
			// The turn is billed against the prefix that preceded it, so this message's
			// own blocks are added after the accounting, exactly as the mass walk does.
			if (message.usage) {
				// `running` is the non-signature mass, billed once for this turn; the
				// signatures are billed on top of it at their unlevered length.
				total += running;
				for (let index = 0; index < sites.length; index++) {
					const site = sites[index];
					if (!site) continue;
					total += site.length;
					const sent = sentLength(lever, site, assistantMessages);
					removed += site.length - sent;
					if (sent < site.length) everElided.add(index);
				}
			}
			for (const block of content) {
				if (block.type === "toolCall") {
					const length = (block.thoughtSignature ?? "").length;
					if (length > 0) {
						sites.push({ assistantIndex: assistantMessages, length, sentinel: SKIP_SIGNATURE_CHARS });
						signatures += 1;
					}
					running += JSON.stringify(block.arguments ?? {}).length;
				} else if (block.type === "thinking") {
					running += (block.thinking ?? "").length;
				} else if (block.type === "text") {
					running += (block.text ?? "").length;
				}
			}
			assistantMessages += 1;
			continue;
		}
		if (message.role === "toolResult") {
			running += content.reduce((sum, block) => sum + (block.text ?? "").length, 0);
			continue;
		}
		if (message.role === "user") {
			running += content.reduce((sum, b) => sum + (b.type === "text" ? (b.text ?? "").length : 0), 0);
		}
	}
	return { removed, total, touched: everElided.size, signatures };
}

/**
 * What a thinking retention window would remove from the prefix, in character-turns.
 *
 * WHY IT USES THE SHIPPED PREDICATE RATHER THAN REIMPLEMENTING THE WINDOW.
 * `firstRetainedAssistantIndex` is what the Google provider actually calls to
 * decide the boundary, and its rule has a detail worth not guessing at: it counts
 * back over ASSISTANT messages but returns a MESSAGE index, so tool results and
 * user turns sitting between two assistant messages fall on whichever side the
 * assistant boundary puts them. A hand-rolled "last K messages" would be a
 * different lever wearing the same name, which is exactly how a 5 KB tool-result
 * threshold came to be simulated at nearly twice its real saving.
 *
 * Unlike a signature, elided thinking is REPLACED BY NOTHING: the provider request
 * simply omits the part, so there is no sentinel to net off. That asymmetry is the
 * reason this is a separate function rather than a third case inside the signature
 * simulator, where the sentinel is unconditional.
 *
 * READ IT WITH `prefixStability` in mind. This is a recency window, so it moves its
 * boundary forward every turn and rewrites history the same way a signature
 * retention window does. The gross figure here is not the net one.
 */
export function simulateThinkingRetention(
	records: TranscriptRecord[],
	retention: number,
): { removed: number; total: number; touched: number; blocks: number } {
	let removed = 0;
	let total = 0;
	let running = 0;
	// Message roles in wire order, which is what the shipped boundary rule reads.
	const roles: { role: string }[] = [];
	const sites: { messageIndex: number; chars: number }[] = [];
	const everElided = new Set<number>();
	for (const record of records) {
		if (record.type === "session_init") {
			running += (record.systemPrompt ?? "").length + JSON.stringify(record.tools ?? []).length;
			continue;
		}
		if (record.type !== "message" || !record.message) continue;
		const message = record.message;
		const content = message.content ?? [];
		if (message.role === "assistant") {
			if (message.usage) {
				total += running;
				const boundary = firstRetainedAssistantIndex(roles as never, retention);
				for (let index = 0; index < sites.length; index++) {
					const site = sites[index];
					if (!site) continue;
					total += site.chars;
					if (site.messageIndex < boundary) {
						removed += site.chars;
						everElided.add(index);
					}
				}
			}
			const messageIndex = roles.length;
			for (const block of content) {
				if (block.type === "toolCall") {
					running += JSON.stringify(block.arguments ?? {}).length;
					running += (block.thoughtSignature ?? "").length;
				} else if (block.type === "thinking") {
					const chars = (block.thinking ?? "").length;
					if (chars > 0) sites.push({ messageIndex, chars });
				} else if (block.type === "text") {
					running += (block.text ?? "").length;
				}
			}
			roles.push({ role: "assistant" });
			continue;
		}
		if (message.role === "toolResult") {
			running += content.reduce((sum, block) => sum + (block.text ?? "").length, 0);
			roles.push({ role: "toolResult" });
			continue;
		}
		if (message.role === "user") {
			running += content.reduce((sum, b) => sum + (b.type === "text" ? (b.text ?? "").length : 0), 0);
			roles.push({ role: "user" });
		}
	}
	return { removed, total, touched: everElided.size, blocks: sites.length };
}

/**
 * Conversation mass per session, i.e. everything in the prefix that is not the
 * fixed system prompt, divided by how many sessions produced it.
 *
 * The system prompt is the same bytes in every session and is there before the
 * agent does anything, so it is the one category that says nothing about whether
 * work happened. Excluding it makes this a measure of how much the agent actually
 * did.
 */
export function conversationMassPerSession(mass: PrefixMass, sessions: number): number {
	if (sessions <= 0) return 0;
	return (totalPrefixMass(mass) - mass.system) / sessions;
}

/** Below this share of the baseline's conversation mass, a treatment arm did not really run. */
export const COLLAPSED_CONVERSATION_SHARE = 0.1;

/**
 * Whether a treatment arm's sessions are too empty to compare compositions with.
 *
 * WHY THIS GUARD EXISTS. A composition table is a share table, so an arm whose
 * trials all died at startup reports 96.6% system prompt and 0.0% of everything
 * else, and that renders as a lever which removed every signature, every tool
 * result and all the thinking at once. It is the most impressive-looking output the
 * report can produce and it means the arm never ran. That is the same failure mode
 * as a quota-killed arm reading as a 100% cost saving, in a different table, and it
 * has to be caught in the same way: refuse, loudly, rather than print shares that
 * are arithmetically correct and completely misleading.
 *
 * The test is against the BASELINE of the same run rather than an absolute size,
 * because how much conversation a healthy session produces is a property of the
 * task set, not a constant.
 */
export function conversationCollapsed(
	baselineMass: PrefixMass,
	baselineSessions: number,
	treatedMass: PrefixMass,
	treatedSessions: number,
): boolean {
	const reference = conversationMassPerSession(baselineMass, baselineSessions);
	if (reference <= 0) return false;
	return conversationMassPerSession(treatedMass, treatedSessions) < reference * COLLAPSED_CONVERSATION_SHARE;
}

export function measureRunPrefix(
	jobsRoot: string,
	armPrefix = "baseline__",
): {
	mass: PrefixMass;
	sessions: number;
	usage: TokenMix;
	caps: Map<number, CapSweepPoint>;
	observations: PrefixObservation[];
	perSession: TranscriptRecord[][];
} {
	let mass = emptyPrefixMass();
	let sessions = 0;
	const observations: PrefixObservation[] = [];
	const perSession: TranscriptRecord[][] = [];
	const capRemoved = new Map<number, CapSweepPoint>(
		CAP_SWEEP.map(cap => [cap, { removed: 0, spilled: 0, results: 0 }]),
	);
	const usage = { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
	for (const jobName of fs.readdirSync(jobsRoot)) {
		if (!jobName.startsWith(armPrefix)) continue;
		const jobDir = path.join(jobsRoot, jobName);
		if (!fs.statSync(jobDir).isDirectory()) continue;
		for (const trialName of fs.readdirSync(jobDir)) {
			const sessionsDir = path.join(jobDir, trialName, "agent", "sessions");
			if (!fs.existsSync(sessionsDir)) continue;
			for (const file of fs.readdirSync(sessionsDir)) {
				if (!file.endsWith(".jsonl")) continue;
				sessions++;
				const records: TranscriptRecord[] = [];
				for (const line of fs.readFileSync(path.join(sessionsDir, file), "utf8").split("\n")) {
					if (line === "") continue;
					try {
						records.push(JSON.parse(line) as TranscriptRecord);
					} catch {
						// A truncated tail from a killed process. Skipping one line is right;
						// failing the run would throw away a whole measurement over it.
					}
				}
				mass = accumulatePrefixMass(sessionPrefixSteps(records), mass);
				observations.push(...prefixObservations(records));
				perSession.push(records);
				for (const cap of CAP_SWEEP) {
					const point = capRemoved.get(cap);
					const sim = simulateToolResultCap(records, cap);
					if (point) {
						point.removed += sim.removed;
						point.spilled += sim.spilled;
						point.results += sim.results;
					}
				}
				for (const record of records) {
					const u = record.message?.usage as Record<string, number> | undefined;
					if (!u) continue;
					usage.inputTokens += u.input ?? 0;
					usage.cacheReadTokens += u.cacheRead ?? 0;
					usage.cacheWriteTokens += u.cacheWrite ?? 0;
					usage.outputTokens += u.output ?? 0;
				}
			}
		}
	}
	return { mass, sessions, usage, caps: capRemoved, observations, perSession };
}

if (import.meta.main) {
	const jobsRoot = process.argv[2];
	if (!jobsRoot) {
		console.error("usage: bun prefix-composition.ts <run>/jobs [arm-prefix]");
		console.error("  Decomposes what cache-read tokens are spent on, and what eliding each part would buy.");
		process.exit(2);
	}
	const armPrefix = process.argv[3] ?? "baseline__";
	const { mass, sessions, usage, caps, observations, perSession } = measureRunPrefix(jobsRoot, armPrefix);
	const total = totalPrefixMass(mass);
	const shares = prefixShares(mass);
	console.log(`arm "${armPrefix}"  sessions ${sessions}  prefix ${total.toLocaleString()} char-turns`);
	console.log("");
	for (const category of [...PREFIX_CATEGORIES].sort((a, b) => mass[b] - mass[a])) {
		const pct = (100 * shares[category]).toFixed(1).padStart(5);
		console.log(`  ${category.padEnd(14)} ${mass[category].toLocaleString().padStart(16)}  ${pct}%`);
	}
	const cost = priceTokens(usage);
	const lines = costShares(cost);
	console.log("");
	console.log(
		`priced bill $${cost.total.toFixed(2)} at reference rates  ` +
			`(prompt lines ${(100 * (lines.input + lines.cacheRead + lines.cacheWrite)).toFixed(1)}%, ` +
			`output ${(100 * lines.output).toFixed(1)}%)`,
	);
	console.log("");
	console.log("upper bound on what eliding each part would save, as a share of the bill:");
	for (const set of [["signature"], ["thinking"], ["signature", "thinking"], ["system"], ["toolResult"]] as const) {
		const saving = predictedBillSaving(mass, set as unknown as PrefixCategory[], cost);
		console.log(`  ${set.join(" + ").padEnd(24)} ${(100 * saving).toFixed(1)}%`);
	}
	const calibration = calibratePrefix(observations);
	if (calibration) {
		// The census counts characters; the provider bills tokens on a prompt that also
		// carries tool schemas the transcript never records. Printing the fit makes that
		// gap visible instead of assumed. A chars-per-token figure well below the normal
		// 3.5-4.5 range means real prefix mass is missing and every share above is
		// inflated.
		const unseenShare = total > 0 ? (calibration.unseenChars * observations.length) / total : 0;
		console.log("");
		console.log(
			`calibration against billed tokens: ${calibration.charsPerToken.toFixed(2)} chars/token, ` +
				`${Math.round(calibration.unseenChars).toLocaleString()} chars of prefix not in the transcript ` +
				`(${(100 * unseenShare).toFixed(1)}% of the total above)`,
		);
	}
	// The one lever that removes nothing from the context, so it cannot cost reward.
	// Worth reading before any lever that trades context for money.
	if (calibration) {
		const efficiency = perSession.reduce(
			(acc, records) => {
				const e = cacheEfficiency(records, calibration.charsPerToken);
				return {
					uncachedTokens: acc.uncachedTokens + e.uncachedTokens,
					cachedTokens: acc.cachedTokens + e.cachedTokens,
					cacheWriteTokens: acc.cacheWriteTokens + e.cacheWriteTokens,
					newContentTokens: acc.newContentTokens + e.newContentTokens,
					rebilledTokens: acc.rebilledTokens + e.rebilledTokens,
				};
			},
			{ uncachedTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, newContentTokens: 0, rebilledTokens: 0 },
		);
		const share = rebilledCostShare(efficiency, cost, REFERENCE_RATE_CARD);
		const fresh = freshTokens(efficiency);
		console.log("");
		console.log("prompt cache, the lever that removes nothing from the context:");
		console.log(
			`  hit rate            ${(100 * cacheHitRate(efficiency)).toFixed(1)}%  (reads only; a write is not a hit)`,
		);
		console.log(
			`  billed fresh        ${Math.round(fresh).toLocaleString()} tokens ` +
				`(${Math.round(efficiency.uncachedTokens).toLocaleString()} input + ` +
				`${Math.round(efficiency.cacheWriteTokens).toLocaleString()} write), of which ` +
				`${Math.round(efficiency.rebilledTokens).toLocaleString()} was content already sent`,
		);
		console.log(`  paying the fresh rate on re-reads costs ${(100 * share).toFixed(1)}% of the bill, for nothing`);
		// A pooled rate over a handful of sessions can be carried by one outlier, and
		// this figure is the basis for comparing one provider's cache design against
		// another's. Print the spread so a gap between two runs can be read as signal
		// or dismissed as noise without re-deriving it by hand.
		const rates = perSession
			.map(records => cacheHitRate(cacheEfficiency(records, calibration.charsPerToken)))
			.filter(rate => rate > 0)
			.sort((a, b) => a - b);
		if (rates.length > 1) {
			const at = (q: number) => rates[Math.min(rates.length - 1, Math.floor(q * rates.length))] ?? 0;
			console.log(
				`  across ${rates.length} sessions   min ${(100 * (rates[0] ?? 0)).toFixed(1)}%` +
					`  p25 ${(100 * at(0.25)).toFixed(1)}%  median ${(100 * at(0.5)).toFixed(1)}%` +
					`  p75 ${(100 * at(0.75)).toFixed(1)}%  max ${(100 * (rates[rates.length - 1] ?? 0)).toFixed(1)}%`,
			);
		}
	}
	console.log("");
	console.log("what an inline-output CAP would actually reach, which is not the toolResult total:");
	const promptShare = lines.input + lines.cacheRead + lines.cacheWrite;
	for (const cap of CAP_SWEEP) {
		const point = caps.get(cap) ?? { removed: 0, spilled: 0, results: 0 };
		const ofPrefix = total > 0 ? point.removed / total : 0;
		const spillRate = point.results > 0 ? point.spilled / point.results : 0;
		console.log(
			`  cap ${cap.toLocaleString().padStart(6)} chars  ${(100 * ofPrefix).toFixed(1).padStart(5)}% of prefix` +
				`  ->  ${(100 * ofPrefix * promptShare).toFixed(1).padStart(5)}% of bill` +
				`   (spills ${(100 * spillRate).toFixed(0).padStart(3)}% of tool results)`,
		);
	}
	console.log("");
	// Whether each lever's saving is real or is handed straight back as cache misses.
	// How much the composition moves between sessions.
	//
	// A pooled share over a handful of sessions can be carried by one long outlier,
	// and every lever here is sized off these shares. On the Claude baseline the
	// tool-result share read 42.8% at one session and 74.0% at five, which moved the
	// lever's predicted saving by more than ten points of bill. Print the spread so a
	// share quoted from a short run carries its own uncertainty.
	if (perSession.length > 1) {
		console.log("");
		console.log("how much each share moves between sessions (a short run is not one number):");
		const perSessionShares = perSession
			.map(records => prefixShares(accumulatePrefixMass(sessionPrefixSteps(records))))
			.filter(shares => PREFIX_CATEGORIES.some(category => shares[category] > 0));
		for (const category of PREFIX_CATEGORIES) {
			const values = perSessionShares.map(shares => shares[category]).sort((a, b) => a - b);
			if (values.length === 0 || (values[values.length - 1] ?? 0) === 0) continue;
			const at = (q: number) => values[Math.min(values.length - 1, Math.floor(q * values.length))] ?? 0;
			console.log(
				`  ${category.padEnd(14)} pooled ${(100 * shares[category]).toFixed(1).padStart(5)}%` +
					`   per-session min ${(100 * (values[0] ?? 0)).toFixed(1).padStart(5)}%` +
					`  median ${(100 * at(0.5)).toFixed(1).padStart(5)}%` +
					`  max ${(100 * (values[values.length - 1] ?? 0)).toFixed(1).padStart(5)}%`,
			);
		}
	}

	// The primary signature lever, simulated rather than asserted, and net of the
	// 33-character sentinel that replaces each dropped signature.
	console.log("");
	console.log("what a SIGNATURE length cap would reach, and how much reasoning it gives up:");
	for (const cap of SIGNATURE_CAP_SWEEP) {
		const sim = perSession.reduce(
			(acc, records) => {
				const s = simulateSignatureCap(records, cap);
				return {
					removed: acc.removed + s.removed,
					touched: acc.touched + s.touched,
					signatures: acc.signatures + s.signatures,
				};
			},
			{ removed: 0, touched: 0, signatures: 0 },
		);
		const ofPrefix = total > 0 ? sim.removed / total : 0;
		const share = sim.signatures > 0 ? sim.touched / sim.signatures : 0;
		console.log(
			`  cap ${cap.toLocaleString().padStart(5)} chars  ${(100 * ofPrefix).toFixed(1).padStart(5)}% of prefix` +
				`  ->  ${(100 * ofPrefix * promptShare).toFixed(1).padStart(5)}% of bill` +
				`   (touches ${(100 * share).toFixed(0).padStart(3)}% of tool calls)`,
		);
	}

	// THE DECISION TABLE. A lever is ranked on what it saves NET of what it hands back
	// in cache misses, never on its gross saving, and the two families differ on
	// exactly that: a size cap gives back nothing while a recency window rewrites
	// history every turn. Printing gross and give-back in separate tables let a lever
	// be chosen on the first number alone, which is how a window that surrenders a
	// quarter of its saving could look like the best lever available.
	console.log("");
	console.log("what each SIGNATURE lever saves, net of the cache it invalidates:");
	const promptShareForLevers = lines.input + lines.cacheRead + lines.cacheWrite;
	const levers: { label: string; lever: SignatureLever }[] = [
		{ label: "stock", lever: { kind: "stock" } },
		{ label: "sig-max4000", lever: { kind: "sizeCap", maxLength: 4000 } },
		{ label: "sig-last1", lever: { kind: "retainLast", assistantMessages: 1 } },
		{ label: "sig-last5", lever: { kind: "retainLast", assistantMessages: 5 } },
		{ label: "sig-last8", lever: { kind: "retainLast", assistantMessages: 8 } },
	];
	for (const { label, lever } of levers) {
		const totals = perSession.reduce(
			(acc, records) => {
				const s = prefixStability(records, lever);
				const sim = simulateSignatureLever(records, lever);
				return {
					comparisons: acc.comparisons + s.comparisons,
					stableComparisons: acc.stableComparisons + s.stableComparisons,
					invalidatedCharTurns: acc.invalidatedCharTurns + s.invalidatedCharTurns,
					removed: acc.removed + sim.removed,
					touched: acc.touched + sim.touched,
					signatures: acc.signatures + sim.signatures,
				};
			},
			{ comparisons: 0, stableComparisons: 0, invalidatedCharTurns: 0, removed: 0, touched: 0, signatures: 0 },
		);
		const stable = totals.comparisons > 0 ? totals.stableComparisons / totals.comparisons : 1;
		// The invalidated tail is in the same character-turn unit as the prefix mass,
		// so it prices against the same bill: those bytes move from the cached rate to
		// the fresh rate, and the loss is the difference between the two.
		const lostShare = total > 0 ? totals.invalidatedCharTurns / total : 0;
		const rateLoss =
			(REFERENCE_RATE_CARD.input - REFERENCE_RATE_CARD.cacheRead) / Math.max(REFERENCE_RATE_CARD.input, 1e-9);
		const gross = (total > 0 ? totals.removed / total : 0) * promptShareForLevers;
		const givenBack = lostShare * promptShareForLevers * rateLoss;
		const touchedShare = totals.signatures > 0 ? totals.touched / totals.signatures : 0;
		console.log(
			`  ${label.padEnd(12)} gross ${(100 * gross).toFixed(1).padStart(5)}%` +
				`  - cache ${(100 * givenBack).toFixed(1).padStart(4)}%` +
				`  = NET ${(100 * (gross - givenBack)).toFixed(1).padStart(5)}% of bill` +
				`   |  ${(100 * stable).toFixed(0).padStart(3)}% of turns keep the prefix intact` +
				`, touches ${(100 * touchedShare).toFixed(0).padStart(3)}% of signatures`,
		);
	}

	console.log("");
	console.log("Upper bounds. A real lever substitutes something smaller rather than nothing, and");
	console.log("none of this says the model still solves the task: only the reward gate answers that.");
}
