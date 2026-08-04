/**
 * Claude models served through OpenRouter must carry the Anthropic cache-control
 * format, or every turn is a full uncached prefill.
 *
 * WHY THIS SUITE EXISTS. `buildOpenAICompat` decided `cacheControlFormat` with a
 * raw `spec.id.startsWith("anthropic/")` test, while the same function had already
 * computed the correct predicate 265 lines above it as `isAnthropicModel`
 * (`modelMatchesHost(...) || isClaudeModelId(id) || isAnthropicNamespacedModelId(id)`).
 * The bundled catalog carries four alias rows spelled `~anthropic/claude-*-latest`,
 * where the leading tilde sorts them to the top of the model picker and makes them
 * the likeliest Claude-on-OpenRouter selection. `startsWith("anthropic/")` is false
 * for every one of them, so `cacheControlFormat` was `undefined`,
 * `maybeAddAnthropicCacheControl` returned before writing a breakpoint, and the
 * provider re-read the entire conversation at full input rate on every single turn.
 *
 * Nothing failed loudly. The requests succeeded, the answers were correct, and the
 * only symptom was the bill. That is why this is pinned on the resolved catalog
 * rather than on the predicate: the contract is what the model rows actually carry.
 */

import { describe, expect, it } from "bun:test";
import { buildModel } from "@veyyon/catalog/build";
import { isAnthropicNamespacedModelId, isClaudeModelId } from "@veyyon/catalog/identity";
import { getBundledModel, getBundledModels } from "@veyyon/catalog/models";
import type { ModelSpec } from "@veyyon/catalog/types";

/** Bundled OpenRouter ids the identity layer recognizes as Anthropic models. */
function claudeIdsOnOpenRouter(): string[] {
	return getBundledModels("openrouter")
		.map(model => model.id)
		.filter(id => isClaudeModelId(id) || isAnthropicNamespacedModelId(id));
}

describe("Anthropic cache control on OpenRouter", () => {
	/**
	 * The four alias rows are the regression itself. Named explicitly, because a
	 * sweep that happened to skip them would still pass the aggregate assertion
	 * below, and these are the rows a user is most likely to run.
	 */
	it.each(["~anthropic/claude-opus-latest", "~anthropic/claude-sonnet-latest", "~anthropic/claude-haiku-latest", "~anthropic/claude-fable-latest"])(
		"marks %s for Anthropic cache control despite the tilde-prefixed id",
		id => {
			const model = getBundledModel<"openrouter">("openrouter", id);

			expect(model, `${id} is missing from the bundled catalog`).toBeDefined();
			// The exact wire format, not merely "something truthy": the completions
			// path branches on this value to choose where the breakpoint goes.
			expect(model.compat.cacheControlFormat).toBe("anthropic");
			// The condition that broke it, asserted directly so the reason this row
			// is special cannot be lost: the id does NOT start with `anthropic/`.
			expect(id.startsWith("anthropic/")).toBe(false);
		},
	);

	/**
	 * Every Claude row, not a sample. The bug was a predicate that agreed with the
	 * identity layer on most ids and disagreed on a family of them, so the guard has
	 * to be the whole set or it will miss the next spelling.
	 */
	it("marks every Claude row the identity layer recognizes", () => {
		const ids = claudeIdsOnOpenRouter();

		// A vacuous pass would be worse than a failure here.
		expect(ids.length).toBeGreaterThan(20);
		const unmarked = ids.filter(id => getBundledModel<"openrouter">("openrouter", id).compat.cacheControlFormat !== "anthropic");
		expect(unmarked).toEqual([]);
	});

	/**
	 * The fix widened a condition, so the negative side has to hold: a non-Anthropic
	 * OpenRouter model must NOT be marked. Anthropic-style `cache_control` on a
	 * model that does not implement it is a wasted field at best and a 400 at worst.
	 */
	it("leaves non-Anthropic OpenRouter models unmarked", () => {
		const wronglyMarked = getBundledModels("openrouter")
			.map(model => model.id)
			.filter(id => !isClaudeModelId(id) && !isAnthropicNamespacedModelId(id))
			.filter(id => getBundledModel<"openrouter">("openrouter", id).compat.cacheControlFormat === "anthropic");

		expect(wronglyMarked).toEqual([]);
	});

	/**
	 * First-party Anthropic models reach caching through the Anthropic provider's
	 * own `cache_control` placement, not through this OpenAI-compat field. Marking
	 * them here would mean two subsystems both claiming to own the breakpoints.
	 */
	it("does not set the OpenAI-compat field for first-party Anthropic models", () => {
		const direct = getBundledModels("anthropic");

		expect(direct.length).toBeGreaterThan(0);
		for (const model of direct) {
			expect(model.api).toBe("anthropic-messages");
		}
	});
});

/**
 * A request field whose real constraint is the ENDPOINT must not be gated on the
 * provider NAME.
 *
 * WHY THIS SUITE EXISTS. `supportsObfuscationOptOut` read
 * `isOpenAIUrl || spec.provider === "openai"`, and the second clause defeats the
 * first: a caller who points an `openai` model at a proxy or at Azure still sent
 * `stream_options.include_obfuscation`, which a strict compat host rejects with a
 * 400 that fails the turn. This is the same shape as the shipped
 * `prompt_cache_breakpoint` regression, where a model-keyed predicate was trusted
 * for a decision the backend actually owns.
 *
 * Dropping the provider clause outright would have been the other bug:
 * `isOpenAIUrl` is false for an UNSET baseUrl, which is how every first-party
 * OpenAI row is spelled, so the field would have vanished for the default host.
 * Both directions are pinned here for that reason.
 */
describe("obfuscation opt-out is gated on the endpoint", () => {
	/**
	 * `ModelSpec.baseUrl` is a required string and every bundled OpenAI row spells
	 * it as `https://api.openai.com/v1`, so the host is what varies here.
	 * `isOfficialOpenAIEndpoint` additionally treats an EMPTY baseUrl as official,
	 * which is defensive for hand-built specs and is why the provider clause could
	 * not simply be deleted: `hostMatchesUrl("", "openai")` is false.
	 */
	function specAtHost(baseUrl: string): ModelSpec<"openai-responses"> {
		return {
			id: "gpt-5.6-probe",
			name: "probe",
			api: "openai-responses",
			provider: "openai",
			baseUrl,
			reasoning: true,
			input: ["text"],
			cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 8192,
			maxTokens: 2048,
		};
	}

	/** The official host keeps the field. */
	it("keeps the field for the official OpenAI host", () => {
		expect(buildModel(specAtHost("https://api.openai.com/v1")).compat.supportsObfuscationOptOut).toBe(true);
	});

	/**
	 * The regression: provider `openai` re-pointed elsewhere. Azure is called out
	 * separately because it mirrors the schema without owning it, which is exactly
	 * the case a provider-name test cannot distinguish.
	 */
	it.each([
		["a re-pointed proxy", "https://proxy.example/v1"],
		["azure", "https://example.openai.azure.com/openai/deployments/gpt-5"],
	])("drops the field for %s", (_label, baseUrl) => {
		expect(buildModel(specAtHost(baseUrl)).compat.supportsObfuscationOptOut).toBe(false);
	});
});
