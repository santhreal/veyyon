/**
 * Cache stability across the compaction boundary.
 *
 * Defect class: an elision that re-projects per turn — re-rendering markers,
 * re-ordering content, re-eliding on a later pass — moves the request prefix
 * after the provider has cached it, and every subsequent turn misses the
 * prompt cache. The contract: elision is a ONE-TIME mutation at the
 * compaction boundary (which rewrites history anyway), and afterwards the
 * shared span is byte-stable. Two consecutive post-compaction turns must send
 * byte-identical prefixes for the shared span, and a second compaction pass
 * must leave an already-elided marker untouched.
 */
import { describe, expect, it } from "bun:test";
import { Agent, type AgentMessage } from "@veyyon/agent-core";
import type { CompactionEntry, SessionEntry, SessionMessageEntry } from "@veyyon/agent-core/compaction";
import { DEFAULT_COMPACTION_SETTINGS, prepareCompaction } from "@veyyon/agent-core/compaction";
import type { AssistantMessage, ToolResultMessage, Usage } from "@veyyon/ai";
import { createMockModel } from "@veyyon/ai/providers/mock";

let idCounter = 0;

const usage = (): Usage => ({
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

function entry(message: AgentMessage): SessionMessageEntry {
	return { type: "message", id: `e-${idCounter++}`, parentId: null, timestamp: "2026-08-06T00:00:00.000Z", message };
}

const user = (text: string): AgentMessage => ({ role: "user", content: [{ type: "text", text }], timestamp: 1 });

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

const result = (toolCallId: string, text: string): ToolResultMessage => ({
	role: "toolResult",
	toolCallId,
	toolName: "read",
	content: [{ type: "text", text }],
	isError: false,
	timestamp: 1,
});

/** Six small turns, then a final turn whose one result dwarfs the budget. */
function sessionEndingInAHugeResult(): SessionEntry[] {
	idCounter = 0;
	const entries: SessionEntry[] = [];
	for (let turn = 0; turn < 6; turn++) {
		entries.push(entry(user(`q${turn}`)));
		entries.push(
			entry(assistant([{ type: "toolCall", id: `c${turn}`, name: "read", arguments: { path: `f${turn}` } }])),
		);
		entries.push(entry(result(`c${turn}`, "small")));
	}
	entries.push(entry(user("last")));
	entries.push(entry(assistant([{ type: "toolCall", id: "c-last", name: "read", arguments: { path: "big" } }])));
	entries.push(entry(result("c-last", "x".repeat(400_000))));
	return entries;
}

const settings = { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 10_000 };

describe("the post-compaction prefix is byte-stable", () => {
	it("two consecutive post-compaction turns send byte-identical shared prefixes", async () => {
		// The retained tail after elision becomes the live context; turn 2's
		// request is turn 1's request plus the new exchange, and the shared
		// span — the elided tail — must be the same bytes both times, or the
		// provider's cached prefix is useless from the first follow-up on.
		const prepared = prepareCompaction(sessionEndingInAHugeResult(), settings);
		expect(prepared).toBeDefined();
		expect(prepared!.tailElisions!.length).toBeGreaterThan(0);

		const mock = createMockModel({ responses: [{ content: ["answer one"] }, { content: ["answer two"] }] });
		const agent = new Agent({ streamFn: mock.stream });
		agent.replaceMessages(prepared!.recentMessages);

		await agent.prompt("follow-up one");
		await agent.prompt("follow-up two");

		expect(mock.calls.length).toBe(2);
		const tailLength = prepared!.recentMessages.length;
		const turnOnePrefix = mock.calls[0]!.context.messages.slice(0, tailLength);
		const turnTwoPrefix = mock.calls[1]!.context.messages.slice(0, tailLength);
		expect(JSON.stringify(turnTwoPrefix)).toBe(JSON.stringify(turnOnePrefix));
	});

	it("a second compaction pass never rewrites an already-elided marker", () => {
		// Re-elision is the drift vector: a marker re-rendered (new timestamp,
		// new wording, a pointer added late) is a different byte string, and the
		// cached prefix dies with it. The elided entry is stamped `prunedAt`,
		// and a later pass must skip it — object-identical, not just equal.
		const entries = sessionEndingInAHugeResult();
		const first = prepareCompaction(entries, settings);
		expect(first).toBeDefined();
		const elidedEntry = entries.find(e => e.type === "message" && e.id === first!.tailElisions![0]!.entryId)!;
		if (elidedEntry.type !== "message") throw new Error("elided entry is a message entry");
		const markerMessage = elidedEntry.message;

		// The branch as the next pass sees it: the compaction entry, the kept
		// span, and one new turn of work since.
		const branch: SessionEntry[] = [
			{
				type: "compaction",
				id: "comp-1",
				parentId: null,
				timestamp: "2026-08-06T00:01:00.000Z",
				summary: "everything so far",
				firstKeptEntryId: first!.firstKeptEntryId,
				tokensBefore: 900_000,
			} as CompactionEntry,
			...entries.slice(entries.findIndex(e => e.id === first!.firstKeptEntryId)),
			entry(user("next question")),
			entry(assistant([{ type: "toolCall", id: "c-next", name: "read", arguments: { path: "n" } }])),
			entry(result("c-next", "y".repeat(400_000))),
		];

		const second = prepareCompaction(branch, settings);
		expect(second).toBeDefined();
		// Non-vacuity: the second pass DID elide (the new turn's huge result),
		// so skipping the old marker is a decision, not an empty run.
		expect(second!.tailElisions!.length).toBeGreaterThan(0);
		// The new huge result is elided; the old marker is not a candidate.
		expect(second!.tailElisions!.map(e => e.entryId)).not.toContain(elidedEntry.id);
		expect(elidedEntry.message).toBe(markerMessage);
	});
});
