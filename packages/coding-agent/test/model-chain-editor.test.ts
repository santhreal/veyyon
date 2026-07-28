import { describe, expect, it } from "bun:test";
import type { Model } from "@veyyon/ai";
import { buildModel } from "@veyyon/catalog/build";
import { Effort } from "@veyyon/catalog/effort";
import { replaceModelChainEntry } from "@veyyon/coding-agent/modes/components/settings-selector";

const models: Model[] = ["alpha", "beta", "gamma"].map(id =>
	buildModel({
		id,
		name: id,
		api: "openai-completions",
		provider: "test",
		baseUrl: "https://example.test",
		reasoning: true,
		thinking: { mode: "effort", efforts: [Effort.Low, Effort.High] },
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 10_000,
		maxTokens: 1_000,
	}),
);

describe("model chain editor", () => {
	/** Entering the first row must replace the primary model without disturbing fallback order. */
	it("replaces the first choice in place", () => {
		expect(replaceModelChainEntry(["test/alpha:low", "test/beta:high"], 0, "test/gamma:high", models)).toEqual([
			"test/gamma:high",
			"test/beta:high",
		]);
	});

	/** Editing a fallback must change only that slot instead of promoting it or replacing the primary. */
	it("replaces a fallback in place", () => {
		expect(replaceModelChainEntry(["test/alpha:low", "test/beta:high"], 1, "test/gamma:low", models)).toEqual([
			"test/alpha:low",
			"test/gamma:low",
		]);
	});

	/** Add fallback must append after every existing candidate because chain order controls runtime attempts. */
	it("appends a new fallback", () => {
		expect(replaceModelChainEntry(["test/alpha:low"], null, " test/beta:high ", models)).toEqual([
			"test/alpha:low",
			"test/beta:high",
		]);
	});

	/** One logical model must not get two consecutive attempts merely by carrying different effort suffixes. */
	it("rejects a duplicate model with a different effort", () => {
		expect(replaceModelChainEntry(["test/alpha:low", "test/beta:high"], null, "test/alpha:high", models)).toBeUndefined();
	});

	/** A stale UI index must fail closed instead of appending or corrupting a neighboring chain entry. */
	it("rejects an out-of-range replacement index", () => {
		expect(replaceModelChainEntry(["test/alpha:low"], 4, "test/beta:high", models)).toBeUndefined();
	});

	/** Blank model values cannot become empty candidates that every runtime resolver skips differently. */
	it("rejects a blank model value", () => {
		expect(replaceModelChainEntry(["test/alpha:low"], null, "   ", models)).toBeUndefined();
	});
});
