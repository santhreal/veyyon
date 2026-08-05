import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@veyyon/agent-core";
import {
	type CompactionPreparation,
	createFileOps,
	DEFAULT_COMPACTION_SETTINGS,
	estimateCompactionRequestTokens,
} from "@veyyon/agent-core/compaction";
import { getBundledModel } from "@veyyon/catalog/models";

const model = getBundledModel("anthropic", "claude-sonnet-4-5");
if (!model) throw new Error("Expected bundled anthropic/claude-sonnet-4-5 model");

function user(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: 1 };
}

function preparation(reserveTokens: number): CompactionPreparation {
	return {
		firstKeptEntryId: "kept",
		messagesToSummarize: [user("small conversation")],
		turnPrefixMessages: [],
		recentMessages: [],
		isSplitTurn: false,
		tokensBefore: 50_000,
		fileOps: createFileOps(),
		settings: { ...DEFAULT_COMPACTION_SETTINGS, reserveTokens },
	};
}

describe("compaction request admission accounting", () => {
	/** Provider windows cover requested output as well as input, so a larger reserve must raise admission cost exactly. */
	test("includes the generated-summary token budget", () => {
		const low = estimateCompactionRequestTokens(preparation(1_000), model);
		const high = estimateCompactionRequestTokens(preparation(5_000), model);

		expect(high - low).toBe(3_200);
	});

	/** Previous summaries and hook context are physically sent and must count before a fallback model is selected. */
	test("includes previous summary, custom focus, prompt override, and hook context", () => {
		const base = preparation(1_000);
		const enriched = preparation(1_000);
		enriched.previousSummary = "prior-summary-evidence ".repeat(2_000);

		const baseTokens = estimateCompactionRequestTokens(base, model);
		const enrichedTokens = estimateCompactionRequestTokens(enriched, model, "preserve exact failures", {
			promptOverride: "custom-summary-contract ".repeat(300),
			extraContext: ["hook-context-evidence ".repeat(500)],
		});

		expect(enrichedTokens).toBeGreaterThan(baseTokens + 2_000);
	});

	/** A split turn sends two physical requests; admission must use the larger one rather than summing unrelated windows. */
	test("uses the largest physical split-turn request", () => {
		const split = preparation(2_000);
		split.isSplitTurn = true;
		split.turnPrefixMessages = [user("turn-prefix-evidence ".repeat(2_000))];

		const combined = estimateCompactionRequestTokens(split, model);
		const prefixOnly = estimateCompactionRequestTokens(
			{ ...split, messagesToSummarize: [], previousSummary: undefined },
			model,
		);

		expect(combined).toBe(prefixOnly);
	});
});
