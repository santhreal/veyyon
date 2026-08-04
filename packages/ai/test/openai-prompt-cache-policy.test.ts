import { describe, expect, it } from "bun:test";
import {
	formatOpenAIInputText,
	isOfficialOpenAIResponsesEndpoint,
	resolveOpenAIPromptCachePolicy,
} from "@veyyon/ai/providers/openai-prompt-cache";
import type { Model, ModelSpec } from "@veyyon/ai/types";
import { buildModel } from "@veyyon/catalog/build";
import { getBundledModel } from "@veyyon/catalog/models";

const direct56 = getBundledModel("openai", "gpt-5.6-sol") as Model<"openai-responses">;
const direct55 = getBundledModel("openai", "gpt-5.5") as Model<"openai-responses">;

/**
 * Re-point a bundled official entry at a non-`openai` provider id, keeping the
 * `api.openai.com` base URL. `compat` is re-derived from the spec config so the
 * URL-keyed, provider-blind `supportsLongPromptCacheRetention` detection runs
 * again instead of inheriting the source model's resolved record.
 */
function unofficialProviderEntry(source: Model<"openai-responses">): Model<"openai-responses"> {
	return buildModel({
		...source,
		provider: "openai-compatible",
		compat: source.compatConfig,
	} as ModelSpec<"openai-responses">);
}

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

	/**
	 * Locks out the endpoint-coupled retention suppression. `24h` deprecation is a
	 * MODEL-GENERATION fact; the previous suppression also required the official
	 * endpoint, and `compat.supportsLongPromptCacheRetention` is URL-keyed and
	 * provider-blind. So a 5.6+ id served from `api.openai.com` under any provider
	 * id other than `openai` resolved `official: false`, kept the compat flag, and
	 * shipped the deprecated `prompt_cache_retention: "24h"` with no breakpoint to
	 * pair it with. If this regresses, that request carries an incoherent legacy
	 * retention field into the generation that replaced it.
	 */
	it("suppresses deprecated retention for 5.6+ ids on unofficial provider entries", () => {
		const compatibleHost = unofficialProviderEntry(direct56);

		expect(compatibleHost.compat.supportsLongPromptCacheRetention).toBe(true);
		expect(isOfficialOpenAIResponsesEndpoint(compatibleHost)).toBe(false);

		const policy = resolveOpenAIPromptCachePolicy({
			model: compatibleHost,
			promptCacheKey: "route-key",
			cacheRetention: "long",
		});

		expect(policy.promptCacheRetention).toBeUndefined();
		expect(policy.stablePrefixBreakpoint).toBeUndefined();
	});

	/**
	 * Boundary for the same fix: the generation floor is 5.6, so a pre-5.6 id on an
	 * unofficial provider entry must KEEP `24h`. Suppressing by generation must not
	 * become a blanket suppression that silently drops extended retention — that
	 * would shorten every pre-5.6 cached prefix from 24h to the default window.
	 */
	it("keeps 24h retention for pre-5.6 ids on unofficial provider entries", () => {
		const compatibleHost = unofficialProviderEntry(direct55);

		const policy = resolveOpenAIPromptCachePolicy({
			model: compatibleHost,
			promptCacheKey: "route-key",
			cacheRetention: "long",
		});

		expect(policy.promptCacheRetention).toBe("24h");
		expect(policy.stablePrefixBreakpoint).toBeUndefined();
	});

	/**
	 * A breakpoint marks the prefix ending at its own block, and the platform floor
	 * for a cacheable prefix is 1024 tokens strictly, so a blank block can never
	 * make its own marker eligible. Marking it spends a marker slot for nothing and
	 * risks the documented 400 for a breakpoint on a non-cacheable block. If this
	 * regresses, any serializer handed an empty stable prefix emits a dead marker.
	 */
	it("refuses the marker on text with no cacheable content", () => {
		const policy = resolveOpenAIPromptCachePolicy({ model: direct56, promptCacheKey: "route-key" });

		expect(policy.stablePrefixBreakpoint).toEqual({ mode: "explicit" });
		expect(formatOpenAIInputText("", policy)).toEqual({ type: "input_text", text: "" });
		expect(formatOpenAIInputText("   \n\t ", policy)).toEqual({ type: "input_text", text: "   \n\t " });
	});

	/**
	 * Boundary for the blank-text guard: one non-whitespace character is cacheable
	 * content and must still be marked, so the guard cannot widen into "short text
	 * is unmarked" and silently stop marking the stable prefix.
	 */
	it("marks text whose only content is a single non-whitespace character", () => {
		const policy = resolveOpenAIPromptCachePolicy({ model: direct56, promptCacheKey: "route-key" });

		expect(formatOpenAIInputText(" x ", policy)).toEqual({
			type: "input_text",
			text: " x ",
			prompt_cache_breakpoint: { mode: "explicit" },
		});
	});
});
