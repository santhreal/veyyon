import { describe, expect, it } from "bun:test";
import { type CompactionPreparation, compact, DEFAULT_COMPACTION_SETTINGS } from "@veyyon/agent-core/compaction";
import type { AssistantMessage, Model, UserMessage } from "@veyyon/ai";
import { getBundledModel } from "@veyyon/catalog/models";

/**
 * LOCKS OUT: a compaction result field populated by verbatim-copying a message
 * out of the history being compacted.
 *
 * The shipped defect set a summary-side field ("macro contract") to the exact
 * text of the first user message. Nothing caught it, because every functional
 * assertion about compaction asks whether a summary is present and non-empty,
 * and a copied user message is present and non-empty. The failure is silent and
 * expensive in both directions: compaction exists to REPLACE N tokens of
 * history with a smaller artifact, so a field that re-emits one of those
 * messages byte-for-byte both inflates the artifact and lies to the model,
 * which reads a raw instruction from ten turns ago as if it were a distilled
 * standing contract.
 *
 * If this regresses: a summary field carries raw history bytes forward across
 * every subsequent compaction (they compound, because each pass folds the
 * previous summary into the next), and the model is handed a stale user
 * instruction presented as a summary conclusion.
 *
 * The assertion is structural rather than field-named on purpose. The original
 * offending field no longer exists; naming it would pin a dead shape while a
 * NEW field could reintroduce the same copy. So every string leaf of the result
 * is walked and checked against the exact bytes of every input message.
 */

const MODEL_SUMMARY = "Refactored the loader and fixed the retry path. Two files touched.";

function modelFixture(): Model {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected bundled compaction model");
	return model;
}

function userMessage(text: string): UserMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: 1 };
}

function assistantReply(text: string): AssistantMessage {
	return {
		role: "assistant",
		provider: "test",
		model: "test/compactor",
		api: "anthropic-messages",
		content: [{ type: "text", text }],
		stopReason: "stop",
		timestamp: 1,
	} as AssistantMessage;
}

/** Every string that ends up anywhere in the result, keys included. */
function stringLeaves(value: unknown, path = "$", into: Array<[string, string]> = []): Array<[string, string]> {
	if (typeof value === "string") {
		into.push([path, value]);
		return into;
	}
	if (Array.isArray(value)) {
		for (const [index, item] of value.entries()) stringLeaves(item, `${path}[${index}]`, into);
		return into;
	}
	if (value instanceof Set) {
		for (const [index, item] of [...value].entries()) stringLeaves(item, `${path}<set:${index}>`, into);
		return into;
	}
	if (value && typeof value === "object") {
		for (const [key, child] of Object.entries(value)) stringLeaves(child, `${path}.${key}`, into);
	}
	return into;
}

function preparation(overrides: Partial<CompactionPreparation> = {}): CompactionPreparation {
	return {
		firstKeptEntryId: "kept-entry",
		messagesToSummarize: [],
		turnPrefixMessages: [],
		recentMessages: [],
		isSplitTurn: false,
		tokensBefore: 100_000,
		previousSummary: undefined,
		previousPreserveData: undefined,
		fileOps: { read: new Set(), edited: new Set(), written: new Set() },
		settings: { ...DEFAULT_COMPACTION_SETTINGS },
		...overrides,
	};
}

describe("a compaction result never re-emits an input message verbatim", () => {
	it("copies no input message's bytes into any field of the result", async () => {
		// The first user message is the one the removed "macro contract" field
		// copied, so it is deliberately the longest and most quotable.
		const inputs = [
			userMessage(
				"MACRO_CONTRACT_BAIT: always run the linter before committing, never touch the vendored directory, and prefer the boring option.",
			),
			assistantReply("ASSISTANT_BODY_9f21: I ran the linter and it was clean."),
			userMessage("SECOND_USER_BAIT: now fix the retry path in loader.ts"),
		];

		const result = await compact(
			preparation({ messagesToSummarize: inputs }),
			modelFixture(),
			"test-key",
			undefined,
			undefined,
			{ completeImpl: async () => assistantReply(MODEL_SUMMARY) },
		);

		// The summary really is the model's, so this is not passing because the
		// result came back empty.
		expect(result.summary).toBe(MODEL_SUMMARY);
		expect(result.firstKeptEntryId).toBe("kept-entry");
		expect(result.tokensBefore).toBe(100_000);

		const inputTexts = [
			"MACRO_CONTRACT_BAIT: always run the linter before committing, never touch the vendored directory, and prefer the boring option.",
			"ASSISTANT_BODY_9f21: I ran the linter and it was clean.",
			"SECOND_USER_BAIT: now fix the retry path in loader.ts",
		];
		const leaves = stringLeaves(result);
		// A copy is a copy whether the field is the whole message or embeds it,
		// so both shapes fail. Reported with the path so a regression names the
		// offending field instead of "some string somewhere".
		const copies = leaves.filter(([, text]) => inputTexts.some(input => text.includes(input)));
		expect(copies).toEqual([]);

		// The control: the walker really does see the result's strings, so an
		// empty `copies` is an absence and not a walker that visited nothing.
		expect(leaves.map(([path]) => path)).toContain("$.summary");
		expect(leaves).toContainEqual(["$.summary", MODEL_SUMMARY]);
	});

	it("copies no input message's bytes into either half of a split-turn summary", async () => {
		// The split-turn path concatenates two independent model responses. The
		// merge is where a "just carry the original text across" shortcut is
		// cheapest to write, so it gets the same check.
		const historyBait = "SPLIT_HISTORY_BAIT: the deploy key rotated on Tuesday and the old one is revoked.";
		const prefixBait = "SPLIT_PREFIX_BAIT: read packages/agent/src/compaction/compaction.ts and summarize it";

		let call = 0;
		const result = await compact(
			preparation({
				messagesToSummarize: [userMessage(historyBait)],
				turnPrefixMessages: [userMessage(prefixBait)],
				isSplitTurn: true,
			}),
			modelFixture(),
			"test-key",
			undefined,
			undefined,
			{ completeImpl: async () => assistantReply(call++ === 0 ? "History distilled." : "Prefix distilled.") },
		);

		// Both halves are present and both are the model's own text.
		expect(result.summary).toContain("History distilled.");
		expect(result.summary).toContain("**Turn Context (split turn):**");
		expect(result.summary).toContain("Prefix distilled.");

		const copies = stringLeaves(result).filter(([, text]) => text.includes(historyBait) || text.includes(prefixBait));
		expect(copies).toEqual([]);
	});
});
