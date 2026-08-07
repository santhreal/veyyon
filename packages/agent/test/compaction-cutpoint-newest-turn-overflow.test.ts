/**
 * A session whose NEWEST turn alone blows the keep-recent budget still compacts,
 * and actually frees something.
 *
 * `findCutPoint` walks backwards from the newest entry adding up estimated
 * tokens, and when the tally crosses the budget it looks for the closest valid
 * cut point AT OR AFTER the entry that crossed it. None exists when the budget is
 * blown inside the newest turn, and one enormous final tool result is enough: a
 * result is never a valid cut point, because cutting there would separate it from
 * the call it answers.
 *
 * Two wrong answers have been given to that, and the second is why these tests
 * are worth their length:
 *
 *  1. `cutIndex` kept its default of `cutPoints[0]`, the FIRST valid cut point,
 *     which means "keep the entire session". `prepareCompaction` had nothing to
 *     summarize and returned `undefined`, so compaction did nothing at all,
 *     silently, at precisely the moment the session was most over budget.
 *  2. Falling back to the NEWEST valid cut point, which is the assistant message
 *     CARRYING the call. That keeps the oversized result in the tail, so the
 *     session is STILL over budget once compaction finishes and the next turn
 *     asks again. Compaction reported success and freed nothing: the user watches
 *     a warning arrive every turn against a gauge that never moves, which is
 *     harder to diagnose than the silent version because it looks like it worked.
 *
 * The answer is to keep the newest TURN and elide the bulk inside it. The cut
 * lands on the turn's own start, a valid boundary, and the retained result is
 * replaced with a marker by the tail elision in `prepareCompaction`: the user's
 * latest message and the assistant's reasoning survive verbatim, the bulk of
 * tool output leaves the context, and the summarizer is never asked to ingest
 * it. Keeping nothing was the previous answer, and it threw away the most
 * informative part of the session to get rid of the least.
 *
 * The fixture is deliberately minimal — a small session plus one huge final
 * result — so a failure here points at the cut-point search and nothing else.
 */
import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@veyyon/agent-core";
import type { SessionEntry, SessionMessageEntry } from "@veyyon/agent-core/compaction";
import { DEFAULT_COMPACTION_SETTINGS, findCutPoint, prepareCompaction } from "@veyyon/agent-core/compaction";
import type { AssistantMessage, ToolResultMessage, Usage } from "@veyyon/ai";

let idCounter = 0;

const usage = (): Usage => ({
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

function messageEntry(message: AgentMessage): SessionMessageEntry {
	return { type: "message", id: `e-${idCounter++}`, parentId: null, timestamp: "2026-07-25T00:00:00.000Z", message };
}

const assistant = (content: AssistantMessage["content"]): AssistantMessage => ({
	role: "assistant",
	content,
	timestamp: 1,
	provider: "mock",
	model: "mock",
	api: "mock",
	usage: usage(),
	stopReason: "stop",
});

const toolResult = (toolCallId: string, text: string): ToolResultMessage =>
	({
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 1,
	}) as ToolResultMessage;

/**
 * Small turns, then a final turn whose tool result is larger than the whole
 * budget on its own. `tailChars` sizes that last result.
 */
function sessionEndingInAHugeResult(smallTurns: number, tailChars: number): SessionEntry[] {
	const entries: SessionEntry[] = [];
	for (let turn = 0; turn < smallTurns; turn++) {
		entries.push(messageEntry({ role: "user", content: [{ type: "text", text: `q${turn}` }], timestamp: 1 }));
		entries.push(
			messageEntry(assistant([{ type: "toolCall", id: `c${turn}`, name: "read", arguments: { path: `f${turn}` } }])),
		);
		entries.push(messageEntry(toolResult(`c${turn}`, "small")));
	}
	entries.push(messageEntry({ role: "user", content: [{ type: "text", text: "last" }], timestamp: 1 }));
	entries.push(
		messageEntry(assistant([{ type: "toolCall", id: "c-last", name: "read", arguments: { path: "big" } }])),
	);
	entries.push(messageEntry(toolResult("c-last", "x".repeat(tailChars))));
	return entries;
}

const settings = (keepRecentTokens: number) => ({ ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens });

describe("when the newest turn alone exceeds the budget", () => {
	/** THE regression. Before the fix this returned `undefined`. */
	it("still produces a preparation instead of giving up", () => {
		const prepared = prepareCompaction(sessionEndingInAHugeResult(6, 200_000), settings(1_000));

		expect(prepared).toBeDefined();
	});

	it("actually has history to summarize", () => {
		// "Defined" is not enough: a preparation that summarizes nothing is the same
		// no-op wearing a different return value.
		const prepared = prepareCompaction(sessionEndingInAHugeResult(6, 200_000), settings(1_000));

		expect(prepared!.messagesToSummarize.length).toBeGreaterThan(0);
	});

	it("cuts at the newest turn's start, keeping the turn whole", () => {
		// 21 entries: 6 small turns of 3, then user, assistant-with-call, result.
		// A tool result is never a valid cut point (cutting there orphans it), so
		// there is no boundary at or after the entry that blew the budget. The
		// turn's own start is the boundary that keeps the turn whole; the oversized
		// result inside it is the tail elision's problem, solved there, not a
		// reason to discard the user's latest message with the bulk.
		const entries = sessionEndingInAHugeResult(6, 200_000);
		const cut = findCutPoint(entries, 0, entries.length, 1_000);

		expect(cut.firstKeptEntryIndex).toBe(entries.length - 3);
		expect(cut.isSplitTurn).toBe(false);
	});

	it("elides the huge result in the tail rather than summarizing it", () => {
		// The oversized result is the reason the session is over budget, so its
		// bulk must leave the context. Summarizing it pays a model to ingest tens
		// of thousands of tokens of noise; keeping nothing throws the user's
		// latest message away with it. The turn is kept whole, the result is
		// replaced by a marker, and the original text rides the elision record
		// for the caller to offload to a recovery artifact.
		const prepared = prepareCompaction(sessionEndingInAHugeResult(6, 200_000), settings(1_000));

		expect(prepared!.recentMessages.map(m => m.role)).toEqual(["user", "assistant", "toolResult"]);
		const kept = prepared!.recentMessages[2] as ToolResultMessage;
		expect(kept.content[0].type === "text" && kept.content[0].text).toContain("elided by compaction");
		expect(JSON.stringify(prepared!.messagesToSummarize)).not.toContain("x".repeat(1_000));
		expect(prepared!.tailElisions).toHaveLength(1);
		expect(prepared!.tailElisions![0]!.originalText).toBe("x".repeat(200_000));
	});

	it("never keeps a tool result without the call it answers", () => {
		// The pairing that decides whether the next request is accepted. Keeping a
		// result whose call was summarized away earns a 400 on the very next turn,
		// and that must hold whatever the cut turns out to be.
		const prepared = prepareCompaction(sessionEndingInAHugeResult(6, 200_000), settings(1_000));
		const kept = prepared!.recentMessages;

		const firstResult = kept.findIndex(m => m.role === "toolResult");
		if (firstResult !== -1) {
			expect(kept.slice(0, firstResult).some(m => m.role === "assistant")).toBe(true);
		}
	});

	it("does not split the newest turn when the cut lands on its start", () => {
		// A split turn exists to summarize the opening of a turn whose tail is kept.
		// The cut here lands exactly ON the turn's start, so there is no prefix to
		// carve out, and claiming one would summarize the same user message twice.
		const prepared = prepareCompaction(sessionEndingInAHugeResult(6, 200_000), settings(1_000));

		expect(prepared!.isSplitTurn).toBe(false);
		expect(prepared!.turnPrefixMessages).toEqual([]);
	});

	it("holds for a range of overflow sizes", () => {
		// The failure is about which cut point exists, not about the exact size, so
		// it must not depend on one magic number.
		for (const tailChars of [20_000, 200_000, 2_000_000]) {
			const prepared = prepareCompaction(sessionEndingInAHugeResult(4, tailChars), settings(500));

			expect(prepared, `tail of ${tailChars} chars`).toBeDefined();
			expect(prepared!.messagesToSummarize.length).toBeGreaterThan(0);
		}
	});

	it("holds however much history precedes it", () => {
		for (const smallTurns of [1, 2, 10, 40]) {
			const prepared = prepareCompaction(sessionEndingInAHugeResult(smallTurns, 200_000), settings(1_000));

			expect(prepared, `${smallTurns} preceding turns`).toBeDefined();
		}
	});
});

describe("the ordinary case is unchanged", () => {
	/**
	 * The guard on the fix. A fallback that fired when it should not would start
	 * discarding history from sessions that fit their budget perfectly well.
	 */
	it("keeps everything when the session fits the budget", () => {
		const entries = sessionEndingInAHugeResult(3, 10);
		const cut = findCutPoint(entries, 0, entries.length, 1_000_000);

		expect(cut.firstKeptEntryIndex).toBe(0);
	});

	it("returns no preparation when there is nothing to summarize", () => {
		// Same session, same budget: `prepareCompaction` must still decline rather
		// than manufacture work.
		expect(prepareCompaction(sessionEndingInAHugeResult(3, 10), settings(1_000_000))).toBeUndefined();
	});

	it("cuts in the middle when the budget lands there", () => {
		// The normal path: a budget that is crossed part-way back finds a cut point
		// at or after the crossing entry, and the fallback never runs.
		const entries = sessionEndingInAHugeResult(20, 10);
		const cut = findCutPoint(entries, 0, entries.length, 40);

		expect(cut.firstKeptEntryIndex).toBeGreaterThan(0);
		expect(cut.firstKeptEntryIndex).toBeLessThan(entries.length - 1);
	});
});
