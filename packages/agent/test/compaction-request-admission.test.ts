import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@veyyon/agent-core";
import {
	type CompactionPreparation,
	createFileOps,
	DEFAULT_COMPACTION_SETTINGS,
	DEFAULT_RESERVE_TOKENS,
	estimateCompactionRequestTokens,
	resolveThresholdTokens,
} from "@veyyon/agent-core/compaction";
import type { Api, Model } from "@veyyon/ai";
import { getBundledModel, getBundledModels, getBundledProviders } from "@veyyon/catalog/models";

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

/**
 * The output budget a summarization request asks for is part of what the window
 * has to hold, so a budget that ignores the window makes the request unsendable
 * on every candidate: admission refuses each one, the session never compacts,
 * and history grows past the window while a warning repeats once per turn. A
 * 16k-window model with the default reserve asked for 13107 output tokens on top
 * of ~10k of history and was refused forever.
 *
 * The vocabulary is every distinct context window the bundle publishes, so a
 * newly bundled small-window model joins this sweep without anyone editing a
 * list. The budget is read the only way a caller can see it: two admission
 * estimates over identical history, one with the reserve and one with no
 * reserve at all, whose difference is the requested output and nothing else.
 */
const MODEL_BY_WINDOW: Array<[number, Model<Api>]> = (() => {
	const byWindow = new Map<number, Model<Api>>();
	for (const provider of getBundledProviders()) {
		for (const bundled of getBundledModels(provider)) {
			const window = bundled.contextWindow ?? 0;
			if (window > 0 && !byWindow.has(window)) byWindow.set(window, bundled);
		}
	}
	return [...byWindow.entries()].sort((left, right) => left[0] - right[0]);
})();

function summarizePreparation(reserveTokens: number | undefined, split: boolean): CompactionPreparation {
	const body = user("history that has to be summarized ".repeat(40));
	return {
		firstKeptEntryId: "kept",
		messagesToSummarize: split ? [] : [body],
		turnPrefixMessages: split ? [body] : [],
		recentMessages: [],
		isSplitTurn: split,
		tokensBefore: 50_000,
		fileOps: createFileOps(),
		settings:
			reserveTokens === undefined
				? { ...DEFAULT_COMPACTION_SETTINGS }
				: { ...DEFAULT_COMPACTION_SETTINGS, reserveTokens },
	};
}

/** Requested output tokens for one summarization request, isolated from its static cost. */
function outputBudget(candidate: Model<Api>, split: boolean): number {
	return (
		estimateCompactionRequestTokens(summarizePreparation(undefined, split), candidate) -
		estimateCompactionRequestTokens(summarizePreparation(0, split), candidate)
	);
}

/** Windows whose threshold uses the whole default reserve, i.e. the ones the reserve genuinely fits. */
const ROOMY = MODEL_BY_WINDOW.filter(
	([window]) => resolveThresholdTokens(window, DEFAULT_COMPACTION_SETTINGS) === window - DEFAULT_RESERVE_TOKENS,
);

describe("summarization output budget against the candidate window", () => {
	/** Without a small window in the vocabulary the sweep below cannot fail, so state that it is there. */
	test("the bundle publishes windows on both sides of the default reserve", () => {
		expect(MODEL_BY_WINDOW.length).toBeGreaterThan(10);
		expect(MODEL_BY_WINDOW.filter(([window]) => window <= 16_000).length).toBeGreaterThan(0);
		expect(ROOMY.length).toBeGreaterThan(5);
	});

	/**
	 * A session compacts when it crosses its threshold, so the request it makes at
	 * that moment is history up to the threshold plus the output it asks for. That
	 * total has to fit the window, for every window, or compaction is impossible
	 * on that model rather than merely tight.
	 */
	test("the budget leaves room for the history that triggered compaction", () => {
		const offenders = MODEL_BY_WINDOW.filter(
			([window, candidate]) =>
				outputBudget(candidate, false) + resolveThresholdTokens(window, DEFAULT_COMPACTION_SETTINGS) > window,
		).map(([window, candidate]) => `${candidate.provider}/${candidate.id} (${window})`);

		expect(offenders).toEqual([]);
	});

	/** A split turn sends a second, smaller request; it is bounded by the same window. */
	test("the turn-prefix budget leaves the same room", () => {
		const offenders = MODEL_BY_WINDOW.filter(
			([window, candidate]) =>
				outputBudget(candidate, true) + resolveThresholdTokens(window, DEFAULT_COMPACTION_SETTINGS) > window,
		).map(([window, candidate]) => `${candidate.provider}/${candidate.id} (${window})`);

		expect(offenders).toEqual([]);
	});

	/**
	 * The bound is a floor for small windows, not a new policy for every model: a
	 * window the reserve fits in asks for exactly what it always asked for, so
	 * nobody's summaries got shorter to fix a 16k model.
	 */
	test("a window the reserve fits in asks for the full budget", () => {
		for (const [, candidate] of ROOMY) {
			expect(outputBudget(candidate, false)).toBe(Math.floor(0.8 * DEFAULT_RESERVE_TOKENS));
			expect(outputBudget(candidate, true)).toBe(Math.floor(0.5 * DEFAULT_RESERVE_TOKENS));
		}
	});
});
