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
 * The answer is to keep nothing. The summary stands in for the whole range, which
 * is the only cut available here that frees anything at all.
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

	it("keeps nothing, because no boundary leaves a tail within budget", () => {
		// 21 entries: 6 small turns of 3, then user, assistant-with-call, result.
		// A tool result is never a valid cut point (cutting there orphans it), so
		// there is no boundary at or after the entry that blew the budget.
		//
		// Falling back to the newest boundary, the assistant message CARRYING the
		// call, was the first attempt at this and it does not work: that keeps the
		// oversized result in the tail, so the session is still over budget when
		// compaction finishes and the next turn asks again. The user sees a warning
		// every turn against a gauge that never moves. `entries.length` means keep
		// nothing: the summary stands in for the whole range, which is the only cut
		// here that frees anything.
		const entries = sessionEndingInAHugeResult(6, 200_000);
		const cut = findCutPoint(entries, 0, entries.length, 1_000);

		expect(cut.firstKeptEntryIndex).toBe(entries.length);
	});

	it("summarizes the huge result rather than keeping it", () => {
		// The oversized result is the reason the session is over budget, so it has
		// to be on the summarized side. Nothing is kept in full.
		const prepared = prepareCompaction(sessionEndingInAHugeResult(6, 200_000), settings(1_000));

		expect(prepared!.recentMessages).toEqual([]);
		expect(prepared!.messagesToSummarize.map(m => m.role).slice(-2)).toEqual(["assistant", "toolResult"]);
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

	it("does not split a turn when it keeps nothing", () => {
		// A split turn exists to summarize the opening of a turn whose tail is kept.
		// With no tail kept there is no prefix to carve out, and claiming one would
		// summarize the same user message twice.
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
