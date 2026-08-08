/**
 * WHY: `estimateTokens` caches by message object identity on the documented
 * assumption that agent messages are immutable once constructed
 * (packages/agent/src/compaction/token-estimate.ts:34-42). The compaction-tail
 * persist step violates that assumption: `#persistCompactionTailElisions`
 * patches the marker's content in place to add the `artifact://` recovery
 * pointer AFTER `elideTailToolResults` already estimated the marker
 * (packages/coding-agent/src/session/agent-session.ts:15861-15867 vs
 * packages/agent/src/compaction/compaction.ts:1416). Every later estimate of
 * that marker — the next compaction's tail sum, the context meter — reads the
 * pre-pointer size. This test performs the production mutation pattern
 * verbatim against a real `prepareCompaction` elision and asks the estimator
 * for the truth. It FAILS today: the cached estimate survives the rewrite.
 *
 * The same in-place-content pattern exists in pruning.ts:278 and
 * shake.ts:475, so this pins the class, not one call site.
 */
import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@veyyon/agent-core";
import type { SessionEntry, SessionMessageEntry } from "@veyyon/agent-core/compaction";
import {
	DEFAULT_COMPACTION_SETTINGS,
	estimateTokens,
	prepareCompaction,
	renderTailElisionMarker,
} from "@veyyon/agent-core/compaction";
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

describe("the marker pointer patch must not leave a stale token estimate", () => {
	it("re-estimating a pointer-patched marker reflects the new bytes", () => {
		const prepared = prepareCompaction(sessionEndingInAHugeResult(), settings);
		expect(prepared).toBeDefined();
		expect(prepared!.tailElisions!.length).toBeGreaterThan(0);
		const elision = prepared!.tailElisions![0]!;

		// The persist hunk's exact mutation: same marker object, content
		// replaced with the pointer-carrying render.
		const withPointer = renderTailElisionMarker(elision.toolName, elision.tokens, "abc123");
		elision.message.content = [{ type: "text", text: withPointer }];

		// A structurally identical fresh object is the estimator's ground truth.
		const fresh: ToolResultMessage = { ...elision.message, content: [{ type: "text", text: withPointer }] };
		expect(estimateTokens(elision.message as AgentMessage)).toBe(estimateTokens(fresh as AgentMessage));
	});
});
