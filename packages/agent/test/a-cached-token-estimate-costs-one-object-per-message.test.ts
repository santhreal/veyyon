/**
 * A message whose tokens were estimated retains one cache record, whichever variants were measured.
 *
 * WHY THIS SUITE EXISTS. `estimateTokens` caches its answer per message object, and a session asks
 * it about every stored message under two option variants: the context meter measures the default
 * variant and `ContextAccounting` measures `excludeEncryptedReasoning`. The cache held a holder object
 * per message plus a `{ value, shape }` object per measured variant, so a message both callers had
 * measured retained three objects for four numbers. The cache now stores both variants in one flat
 * record of four numbers.
 *
 * The class it closes: an object the cache allocates per variant and retains for the life of the
 * message. The retained object count per message is bounded under each variant alone and under both
 * together in either order. Every cached answer is compared with the answer for a fresh copy of the
 * message, so a record that stores one variant's value in the other's slot fails here as well.
 *
 * WHAT IT DOES NOT CATCH: a retained allocation the heap does not count as an object, such as a
 * larger WeakMap table or a wider record with more numeric fields, and a re-measurement that replaces
 * the record, which leaves the retained count unchanged. `estimate-tokens-memoization.test.ts` pins
 * that a re-measurement of one variant keeps the other variant's cached answer.
 */

import { heapStats } from "bun:jsc";
import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@veyyon/agent-core";
import { estimateTokens } from "@veyyon/agent-core/compaction";
import type { AssistantMessage } from "@veyyon/ai";

const TURNS = 1000;

type EstimateOptions = { excludeEncryptedReasoning?: boolean };

const DEFAULT: EstimateOptions | undefined = undefined;
const NO_REASONING: EstimateOptions = { excludeEncryptedReasoning: true };

function assistantMessage(turn: number): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: `reasoning ${turn}`, thinkingSignature: "s".repeat(64 + (turn % 7)) },
			{ type: "text", text: `answer ${turn}` },
			{ type: "toolCall", id: `call-${turn}`, name: "read", arguments: { path: `file-${turn}.ts` } },
		],
		timestamp: turn,
		provider: "mock",
		model: "mock",
		api: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
	};
}

/** A user, assistant and tool-result message per turn: the roles a resumed session stores most. */
function conversation(): AgentMessage[] {
	const messages: AgentMessage[] = [];
	for (let turn = 0; turn < TURNS; turn++) {
		messages.push({ role: "user", content: `question ${turn}`, timestamp: turn });
		messages.push(assistantMessage(turn));
		messages.push({
			role: "toolResult",
			toolCallId: `call-${turn}`,
			toolName: "read",
			content: [{ type: "text", text: `result ${turn} `.repeat(1 + (turn % 5)) }],
			isError: false,
			timestamp: turn,
		});
	}
	return messages;
}

/** Live plain-object cells, the cell type a cache record is. */
function plainObjectCount(): number {
	return heapStats().objectTypeCounts.Object ?? 0;
}

/**
 * Plain objects still reachable after `measure` ran over `messages`, divided by the message count.
 * Strings and structures are left out: the estimator's walk flattens strings and can add structure
 * transitions, which move the total cell count by an amount unrelated to what the cache retains.
 */
function retainedObjectsPerMessage(messages: AgentMessage[], measure: (message: AgentMessage) => void): number {
	Bun.gc(true);
	const before = plainObjectCount();
	for (const message of messages) measure(message);
	Bun.gc(true);
	const after = plainObjectCount();
	return (after - before) / messages.length;
}

/** Each cached answer must equal what the estimator says about a fresh copy of the same content. */
function expectCachedMatchesFresh(messages: AgentMessage[], options: EstimateOptions | undefined): void {
	for (const message of messages) {
		expect(estimateTokens(message, options)).toBe(estimateTokens(structuredClone(message), options));
	}
}

describe("a cached token estimate", () => {
	// The tokenizer and the estimator allocate module state on their first call; pay it before any
	// measurement so the counts below hold the cache alone.
	estimateTokens(assistantMessage(-1), DEFAULT);
	estimateTokens(assistantMessage(-2), NO_REASONING);

	test.each([
		["the default variant", [DEFAULT]],
		["the excludeEncryptedReasoning variant", [NO_REASONING]],
		["both variants", [DEFAULT, NO_REASONING]],
		["both variants in the other order", [NO_REASONING, DEFAULT]],
	] as const)("retains one object per message after measuring %s", (_label, variants) => {
		const messages = conversation();
		const perMessage = retainedObjectsPerMessage(messages, message => {
			for (const options of variants) estimateTokens(message, options);
		});
		// Measured 1.00 with one flat record; a holder plus a record per variant measures 2.00 for
		// one variant and 3.00 for both.
		expect(perMessage).toBeLessThan(1.5);
		for (const options of variants) expectCachedMatchesFresh(messages, options);
	});
});
