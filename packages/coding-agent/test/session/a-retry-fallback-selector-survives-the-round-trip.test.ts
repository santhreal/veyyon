/**
 * WHY: `retry.fallbackChains` is operator-authored text. Its keys and its values
 * are both selector strings, and the runtime has to tell three cases apart on
 * every retry — a role name, one model, and a whole provider — then re-emit the
 * base selector it parsed so the next chain lookup finds the same key. A parse
 * that silently returns a selector for unparseable text, or a format that drops
 * the provider, sends a retry to a model nobody configured.
 *
 * Closes the class: every discriminator the chain lookup depends on
 * (`isRetryFallbackModelKey`, `isRetryFallbackWildcardKey`) is asserted on both
 * sides of its boundary, and the parse/format pair is asserted to round-trip.
 *
 * Does NOT catch: which chain the retry policy picks when several keys match,
 * nor the cooldown/revert policy — those live with the retry policy itself.
 */

import { describe, expect, it } from "bun:test";
import { ThinkingLevel } from "@veyyon/agent-core";
import type { Model } from "@veyyon/ai";
import {
	formatRetryFallbackBaseSelector,
	formatRetryFallbackSelector,
	isRetryFallbackModelKey,
	isRetryFallbackWildcardKey,
	parseRetryFallbackSelector,
} from "../../src/session/agent-session-retry-fallback";

function model(provider: string, id: string): Model {
	return {
		id,
		name: id,
		provider,
		api: "openai-completions",
		baseUrl: "https://example.invalid/v1",
		contextWindow: 128_000,
		maxTokens: 8192,
		cost: { input: 0, output: 0 },
	} as Model;
}

describe("a retry fallback selector survives the round trip", () => {
	it("keeps the raw text, provider and id of a provider/model selector", () => {
		const parsed = parseRetryFallbackSelector("openai/gpt-4o-mini");

		expect(parsed).toEqual({
			raw: "openai/gpt-4o-mini",
			provider: "openai",
			id: "gpt-4o-mini",
			thinkingLevel: undefined,
		});
	});

	it("trims the operator's whitespace into the raw selector it records", () => {
		const parsed = parseRetryFallbackSelector("  openai/gpt-4o-mini  ");

		expect(parsed?.raw).toBe("openai/gpt-4o-mini");
	});

	it("reads a thinking suffix as a concrete level", () => {
		const parsed = parseRetryFallbackSelector("anthropic/claude-sonnet-4:high");

		expect(parsed?.provider).toBe("anthropic");
		expect(parsed?.id).toBe("claude-sonnet-4");
		expect(parsed?.thinkingLevel).toBe(ThinkingLevel.High);
	});

	it("returns undefined for text that names no model, instead of a half-parsed selector", () => {
		expect(parseRetryFallbackSelector("")).toBeUndefined();
		expect(parseRetryFallbackSelector("   ")).toBeUndefined();
		expect(parseRetryFallbackSelector("/")).toBeUndefined();
		expect(parseRetryFallbackSelector("/gpt-4o-mini")).toBeUndefined();
		expect(parseRetryFallbackSelector("openai")).toBeUndefined();
		expect(parseRetryFallbackSelector("openai/")).toBeUndefined();
		expect(parseRetryFallbackSelector("openai/:high")).toBeUndefined();
		expect(parseRetryFallbackSelector("openai/:max")).toBeUndefined();
	});

	it("formats a model back into the base selector a chain key is written as", () => {
		const parsed = parseRetryFallbackSelector("openai/gpt-4o-mini:low");

		expect(parsed).toBeDefined();
		if (!parsed) return;
		expect(formatRetryFallbackBaseSelector(parsed)).toBe("openai/gpt-4o-mini");
	});

	it("round-trips a formatted model selector back to the same provider and id", () => {
		const formatted = formatRetryFallbackSelector(model("openai", "gpt-4o-mini"), undefined);
		const parsed = parseRetryFallbackSelector(formatted);

		expect(parsed?.provider).toBe("openai");
		expect(parsed?.id).toBe("gpt-4o-mini");
		expect(formatRetryFallbackBaseSelector({ ...parsed!, raw: formatted })).toBe("openai/gpt-4o-mini");
	});

	it("carries a thinking level through format and back through parse", () => {
		const formatted = formatRetryFallbackSelector(model("anthropic", "claude-sonnet-4"), ThinkingLevel.High);
		const parsed = parseRetryFallbackSelector(formatted);

		expect(parsed?.thinkingLevel).toBe(ThinkingLevel.High);
		expect(formatRetryFallbackBaseSelector(parsed!)).toBe("anthropic/claude-sonnet-4");
	});

	it("tells a role-name chain key from a model-keyed one by the slash", () => {
		expect(isRetryFallbackModelKey("smol")).toBe(false);
		expect(isRetryFallbackModelKey("default")).toBe(false);
		expect(isRetryFallbackModelKey("openai/gpt-4o-mini")).toBe(true);
		expect(isRetryFallbackModelKey("openai/*")).toBe(true);
	});

	it("treats only a trailing /* as a provider wildcard key", () => {
		expect(isRetryFallbackWildcardKey("openai/*")).toBe(true);
		expect(isRetryFallbackWildcardKey("openai/gpt-4o-mini")).toBe(false);
		expect(isRetryFallbackWildcardKey("*")).toBe(false);
		expect(isRetryFallbackWildcardKey("openai/*-mini")).toBe(false);
	});

	it("consults the model lookup a caller supplies when the id is ambiguous", () => {
		const known = model("openrouter", "meta-llama/llama-3.1-70b");
		const lookup = {
			find(provider: string, id: string): Model | undefined {
				return provider === "openrouter" && id === "meta-llama/llama-3.1-70b" ? known : undefined;
			},
		};

		const parsed = parseRetryFallbackSelector("openrouter/meta-llama/llama-3.1-70b", lookup);

		expect(parsed?.provider).toBe("openrouter");
		expect(parsed?.id).toBe("meta-llama/llama-3.1-70b");
	});
});
