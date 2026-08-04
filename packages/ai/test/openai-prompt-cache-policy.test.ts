import { describe, expect, it } from "bun:test";
import { formatOpenAIInputText, resolveOpenAIPromptCachePolicy } from "@veyyon/ai/providers/openai-prompt-cache";
import type { Model } from "@veyyon/ai/types";
import { buildModel } from "@veyyon/catalog/build";
import { getBundledModel } from "@veyyon/catalog/models";

const direct56 = getBundledModel("openai", "gpt-5.6-sol") as Model<"openai-responses">;
const direct55 = getBundledModel("openai", "gpt-5.5") as Model<"openai-responses">;

describe("OpenAI prompt cache policy", () => {
	/**
	 * Official GPT-5.6 Responses requests with cache affinity support explicit
	 * matching. This is the canonical direct-API capability combination, and the
	 * only one allowed to put `prompt_cache_breakpoint` on the wire.
	 */
	it("enables stable-prefix breakpoints for keyed official GPT-5.6 Responses", () => {
		const policy = resolveOpenAIPromptCachePolicy({ model: direct56, promptCacheKey: "route-key" });

		expect(policy.stablePrefixBreakpoint).toEqual({ mode: "explicit" });
		expect(formatOpenAIInputText("stable", policy)).toEqual({
			type: "input_text",
			text: "stable",
			prompt_cache_breakpoint: { mode: "explicit" },
		});
	});

	/**
	 * OpenAI-compatible proxies may reject fields introduced by newer OpenAI
	 * generations. Provider identity alone must not bypass the host boundary:
	 * `api.openai.com` is the only endpoint documented to accept the field.
	 */
	it("disables breakpoints for custom Responses endpoints", () => {
		const proxy = buildModel({ ...direct56, baseUrl: "https://proxy.example/v1" });

		expect(
			resolveOpenAIPromptCachePolicy({ model: proxy, promptCacheKey: "route-key" }).stablePrefixBreakpoint,
		).toBeUndefined();
	});

	/**
	 * A marker without a stable route key creates an isolated cache write, billed
	 * at 1.25x input with no later read to amortize it. The policy must refuse the
	 * marker even when model and endpoint capabilities match.
	 */
	it("disables breakpoints when cache affinity is absent", () => {
		expect(
			resolveOpenAIPromptCachePolicy({ model: direct56, promptCacheKey: undefined }).stablePrefixBreakpoint,
		).toBeUndefined();
	});

	/**
	 * Pre-5.6 servers reject `prompt_cache_breakpoint` with a 400 that fails the
	 * whole turn. The version capability is centralized in the policy so no
	 * serializer can send the field to an older generation.
	 */
	it("disables breakpoints for older OpenAI generations", () => {
		expect(
			resolveOpenAIPromptCachePolicy({ model: direct55, promptCacheKey: "route-key" }).stablePrefixBreakpoint,
		).toBeUndefined();
	});

	/**
	 * `prompt_cache_retention` is the pre-5.6 maximum-retention control and is
	 * deprecated from 5.6 onward, where `prompt_cache_options.ttl` governs
	 * lifetime. Sending both is contradictory, so the modern generation must get
	 * the breakpoint and no legacy retention field.
	 */
	it("separates legacy retention from modern breakpoint policy", () => {
		const legacy = resolveOpenAIPromptCachePolicy({
			model: direct55,
			promptCacheKey: "route-key",
			cacheRetention: "long",
		});
		const modern = resolveOpenAIPromptCachePolicy({
			model: direct56,
			promptCacheKey: "route-key",
			cacheRetention: "long",
		});

		expect(legacy.promptCacheRetention).toBe("24h");
		expect(legacy.stablePrefixBreakpoint).toBeUndefined();
		expect(modern.promptCacheRetention).toBeUndefined();
		expect(modern.stablePrefixBreakpoint).toEqual({ mode: "explicit" });
	});
});
