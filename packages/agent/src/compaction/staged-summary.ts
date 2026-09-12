/**
 * Staged summarization: the plan for a span that is not summarized in one request.
 *
 * WHY THIS EXISTS. `generateSummary` sends the whole span to the model as one
 * request and waits for one answer. Two spans defeat that request. The first is
 * larger than the candidate's context window, which `estimateCompactionRequestTokens`
 * rejects before it is sent. The second fits the window and never answers: measured
 * 2026-09-09 on `openai-codex/gpt-6-astra`, a 234k-token session's summary request
 * received `response.created` and then nothing for the whole 300s idle ceiling, on
 * every one of nine attempts over five hours, while the session's own turns over
 * the same history streamed and completed. The summary request differs from a turn
 * in one respect: it asks for one very large answer over one very large input, with
 * no output until the model has read all of it. The local summary of the same span
 * had completed in four minutes an hour earlier, so the ceiling is not the defect;
 * the size of the single request is.
 *
 * The plan here divides the span into consecutive segments that each fit a fixed
 * budget, so every request is small, answers within seconds of being read, and runs
 * beside its siblings. The segment summaries are then merged in one request that
 * reads only summaries. A span whose segment summaries together exceed the budget
 * merges in rounds, each round folding consecutive summaries into fewer, until one
 * remains. Every request the plan produces is bounded by the segment budget plus
 * its own output, so a candidate whose window holds one segment holds the whole
 * staged compaction, whatever the span's size.
 *
 * The module is pure: it turns messages into segment texts and summaries into
 * merge groups. `compaction.ts` owns the provider round trip.
 */

import type { Message, Model } from "@veyyon/ai";
import type { Dialect } from "@veyyon/ai/dialect";
import { clampLow } from "@veyyon/utils";
import { countTokens } from "../tokenizer";
import { serializeConversationForSummary } from "./utils";

/**
 * Conversation tokens one segment request carries. Small enough that a reasoning
 * model begins its answer within the stream watchdog on a cold prompt; large enough
 * that a full window divides into a handful of segments rather than dozens.
 */
export const STAGED_SUMMARY_SEGMENT_TOKENS = 32_000;

/** Segment requests in flight at once. */
export const STAGED_SUMMARY_CONCURRENCY = 4;

/** Share of a context window one segment may occupy when the window is small. */
const SEGMENT_WINDOW_SHARE = 0.25;

/** Floor for the segment budget, so a tiny window still divides the span. */
const MIN_SEGMENT_TOKENS = 2_000;

/**
 * Conversation tokens one segment carries for this model: the fixed budget, or a
 * quarter of a window too small to hold it beside the prompts and the answer.
 */
export function stagedSegmentBudget(model: Model): number {
	const contextWindow = model.contextWindow ?? 0;
	if (contextWindow <= 0) return STAGED_SUMMARY_SEGMENT_TOKENS;
	return clampLow(Math.floor(contextWindow * SEGMENT_WINDOW_SHARE), MIN_SEGMENT_TOKENS, STAGED_SUMMARY_SEGMENT_TOKENS);
}

/** One consecutive slice of the span, serialized the way the single request serializes it. */
export interface SummarySegment {
	/** 1-based position in the span. */
	index: number;
	/** Total segment count. */
	count: number;
	/** The serialized conversation text of this segment. */
	text: string;
	/** Token estimate of `text`. */
	tokens: number;
}

/**
 * Divide provider-visible messages into consecutive segments that each stay within
 * `budgetTokens` of serialized conversation text.
 *
 * A segment never opens on a tool result: the result attaches to the assistant call
 * that produced it, even when that pushes the segment past its budget, because a
 * result with no call beside it summarizes as an output of nothing. A single message
 * larger than the budget forms a segment of its own for the same reason: the cut is
 * between messages and never inside one.
 */
export function planSummarySegments(
	messages: Message[],
	dialect: Dialect | undefined,
	budgetTokens: number,
): SummarySegment[] {
	const budget = Math.max(1, Math.floor(budgetTokens));
	const groups: Message[][] = [];
	let current: Message[] = [];
	let currentTokens = 0;
	for (const message of messages) {
		const tokens = countTokens(serializeConversationForSummary([message], dialect));
		const opensSegment = current.length > 0 && currentTokens + tokens > budget && message.role !== "toolResult";
		if (opensSegment) {
			groups.push(current);
			current = [];
			currentTokens = 0;
		}
		current.push(message);
		currentTokens += tokens;
	}
	if (current.length > 0) groups.push(current);
	return groups.map((group, position) => {
		const text = serializeConversationForSummary(group, dialect);
		return { index: position + 1, count: groups.length, text, tokens: countTokens(text) };
	});
}

/**
 * Group consecutive summaries so each group's text stays within `budgetTokens`.
 *
 * A group holds at least two summaries whenever more than one remains, so every
 * merge round strictly reduces the count and the rounds terminate; a lone summary
 * that exceeds the budget on its own is merged with its neighbour rather than
 * repeated forever.
 */
export function planMergeGroups(summaries: readonly string[], budgetTokens: number): string[][] {
	const budget = Math.max(1, Math.floor(budgetTokens));
	const groups: string[][] = [];
	let current: string[] = [];
	let currentTokens = 0;
	for (const summary of summaries) {
		const tokens = countTokens(summary);
		if (current.length >= 2 && currentTokens + tokens > budget) {
			groups.push(current);
			current = [];
			currentTokens = 0;
		}
		current.push(summary);
		currentTokens += tokens;
	}
	if (current.length > 0) groups.push(current);
	return groups;
}

/** The `<segment-summaries>` block a merge request reads. */
export function formatSegmentSummaries(summaries: readonly string[]): string {
	const parts = summaries.map((summary, position) => `<segment index="${position + 1}">\n${summary}\n</segment>`);
	return `<segment-summaries>\n${parts.join("\n\n")}\n</segment-summaries>\n\n`;
}

/**
 * Map `items` through `run` with at most `concurrency` calls in flight, preserving
 * order. The first rejection propagates once every started call has settled, so a
 * failed segment never leaves a sibling request orphaned mid-stream.
 */
export async function mapWithConcurrency<T, R>(
	items: readonly T[],
	concurrency: number,
	run: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	let failure: { error: unknown } | undefined;
	const worker = async (): Promise<void> => {
		while (next < items.length && !failure) {
			const index = next++;
			try {
				results[index] = await run(items[index] as T, index);
			} catch (error) {
				failure ??= { error };
			}
		}
	};
	const workers = Array.from({ length: clampLow(concurrency, 1, items.length) }, () => worker());
	await Promise.all(workers);
	if (failure) throw failure.error;
	return results;
}
