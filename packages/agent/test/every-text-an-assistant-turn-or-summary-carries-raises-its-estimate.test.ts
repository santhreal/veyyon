/**
 * WHY. The compaction trigger, the pruning budget and the context meter all read
 * `estimateTokens`. A fragment the walk skips is text the provider bills and the
 * estimate never sees, so a session full of it overflows the window while the
 * meter reads it as empty. Thinking text, a tool call's name and the text blocks
 * of a legacy compaction summary were each dropped by a one-line edit with every
 * other estimator suite still green.
 *
 * WHAT IT CLOSES. Every content block an assistant turn can hold is a key of
 * `GROWTH`, typed as a `Record` over the content union, so a block type added to
 * `AssistantMessage["content"]` fails the type check here until it records which
 * of its fields the estimate counts. Each listed field is grown on a fresh
 * message and the estimate must rise. The compaction summary rows do the same
 * for its summary and each text block.
 *
 * WHAT IT DOES NOT CATCH. A new string field on an existing block type is not
 * enumerated: it needs a row in that block's list. A field counted at the wrong
 * weight (once instead of twice) still raises the estimate.
 */
import { describe, expect, it } from "bun:test";
import type { CompactionSummaryMessage } from "@veyyon/agent-core/compaction";
import { estimateTokens } from "@veyyon/agent-core/compaction";
import type { AssistantMessage } from "@veyyon/ai";

type AssistantBlock = AssistantMessage["content"][number];

const MORE = " additional reasoning about the parser boundary".repeat(40);

function assistant(block: AssistantBlock): AssistantMessage {
	return {
		role: "assistant",
		content: [block],
		timestamp: 1,
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
		stopReason: "stop",
	};
}

/** A block of each type, and for each field the estimate counts, the same block with that field grown. */
const GROWTH: {
	[K in AssistantBlock["type"]]: { base: Extract<AssistantBlock, { type: K }>; grown: Record<string, AssistantBlock> };
} = {
	text: {
		base: { type: "text", text: "answer" },
		grown: { text: { type: "text", text: `answer${MORE}` } },
	},
	thinking: {
		base: { type: "thinking", thinking: "plan", thinkingSignature: "sig" },
		grown: {
			thinking: { type: "thinking", thinking: `plan${MORE}`, thinkingSignature: "sig" },
			thinkingSignature: { type: "thinking", thinking: "plan", thinkingSignature: `sig${MORE}` },
		},
	},
	redactedThinking: {
		base: { type: "redactedThinking", data: "blob" },
		grown: { data: { type: "redactedThinking", data: `blob${MORE}` } },
	},
	toolCall: {
		base: { type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.ts" } },
		grown: {
			name: {
				type: "toolCall",
				id: "call-1",
				name: `read${MORE.replaceAll(" ", "_")}`,
				arguments: { path: "a.ts" },
			},
			arguments: { type: "toolCall", id: "call-1", name: "read", arguments: { path: `a.ts${MORE}` } },
		},
	},
	// A fallback marker is stripped before any provider request, so it bills nothing.
	fallback: {
		base: { type: "fallback", from: { model: "a" }, to: { model: "b" } },
		grown: {},
	},
};

describe("every field an assistant block carries to the provider raises its estimate", () => {
	for (const [type, { base, grown }] of Object.entries(GROWTH)) {
		for (const [field, block] of Object.entries(grown)) {
			it(`${type}.${field}`, () => {
				expect(estimateTokens(assistant(block))).toBeGreaterThan(estimateTokens(assistant(base)));
			});
		}
	}

	it("records exactly which blocks bill nothing", () => {
		const unbilled = Object.entries(GROWTH)
			.filter(([, { grown }]) => Object.keys(grown).length === 0)
			.map(([type]) => type);
		expect(unbilled).toEqual(["fallback"]);
	});
});

function summary(fields: Partial<CompactionSummaryMessage>): CompactionSummaryMessage {
	return { role: "compactionSummary", summary: "goal", tokensBefore: 0, timestamp: 1, ...fields };
}

describe("every text a compaction summary carries raises its estimate", () => {
	it("summary", () => {
		expect(estimateTokens(summary({ summary: `goal${MORE}` }))).toBeGreaterThan(estimateTokens(summary({})));
	});

	it("each text block of a legacy archive summary", () => {
		const base = summary({
			blocks: [
				{ type: "text", text: "old" },
				{ type: "text", text: "new" },
			],
		});
		const firstGrown = summary({
			blocks: [
				{ type: "text", text: `old${MORE}` },
				{ type: "text", text: "new" },
			],
		});
		const lastGrown = summary({
			blocks: [
				{ type: "text", text: "old" },
				{ type: "text", text: `new${MORE}` },
			],
		});
		expect(estimateTokens(firstGrown)).toBeGreaterThan(estimateTokens(base));
		expect(estimateTokens(lastGrown)).toBeGreaterThan(estimateTokens(base));
	});
});
