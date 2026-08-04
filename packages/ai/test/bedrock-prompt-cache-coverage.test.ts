/**
 * Bedrock prompt-cache support is decided by catalog pricing, not by the id.
 *
 * WHY THIS SUITE EXISTS. `supportsBedrockPromptCaching` checks cache pricing
 * first and then falls back to substring tests on the model id
 * (`-4-`, `-4.`, `claude-3-7-sonnet`, `claude-3-5-haiku`, `claude-haiku`). Those
 * substrings match no current Claude generation: Claude 5 ships on Bedrock as
 * `us.anthropic.claude-fable-5`, which contains none of them. Support for it is
 * carried entirely by `cost.cacheRead`/`cost.cacheWrite` being populated in the
 * bundled catalog.
 *
 * That is a correct outcome resting on an invisible dependency. A catalog regen
 * that dropped cache pricing — from an upstream metadata gap, a renamed field, a
 * provider that stops publishing cache rates — would silently stop sending cache
 * points for a whole model family, and nothing would fail. It is the same shape
 * as the defect where Claude via OpenRouter failed a `startsWith("anthropic/")`
 * test under its alias rows and quietly re-read the conversation every turn: a
 * string test that a new id does not match, with cost as the only symptom.
 *
 * WHAT IS PINNED. Every bundled Bedrock Claude model that carries cache pricing
 * is detected, and the ONLY models not detected are the 2024 Claude 3 family,
 * which genuinely has no Bedrock prompt caching. The exact set is asserted, so
 * both directions fail loudly: a new family arriving unpriced, and an old model
 * gaining detection it should not have.
 */
import { describe, expect, it } from "bun:test";
import { supportsBedrockPromptCaching } from "@veyyon/ai/providers/bedrock-prompt-cache";
import type { Model } from "@veyyon/ai/types";
import { getBundledModels } from "@veyyon/catalog/models";

/**
 * Bundled Bedrock Claude models, which is where the invariant lives.
 *
 * `getBundledModels` is per-provider, so the provider id is the entry point; the
 * api filter stays as a second guard in case the provider ever serves another
 * wire format.
 */
function bedrockClaudeModels(): Array<Model<"bedrock-converse-stream">> {
	return getBundledModels("amazon-bedrock").filter(
		(model): model is Model<"bedrock-converse-stream"> =>
			model.api === "bedrock-converse-stream" && model.id.toLowerCase().includes("claude"),
	);
}

/**
 * Claude generations with no prompt caching on Bedrock. These predate the
 * feature, so being undetected is correct for them and only for them.
 */
const UNCACHEABLE_FAMILIES = ["claude-3-haiku", "claude-3-opus", "claude-3-sonnet"] as const;

describe("Bedrock prompt-cache coverage", () => {
	/** The catalog has to actually contain Bedrock Claude models, or every
	 *  assertion below passes vacuously over an empty list. */
	it("finds Bedrock Claude models to reason about", () => {
		const models = bedrockClaudeModels();
		expect(models.length).toBeGreaterThan(10);
	});

	/**
	 * The invariant that matters: pricing is the signal. A model the catalog
	 * charges cache rates for is a model the provider caches, so failing to send
	 * cache points for it means paying full input rate for a cacheable prompt.
	 */
	it("detects every Bedrock Claude model that carries cache pricing", () => {
		const priced = bedrockClaudeModels().filter(model => model.cost.cacheRead > 0 || model.cost.cacheWrite > 0);
		expect(priced.length).toBeGreaterThan(0);
		const undetected = priced.filter(model => !supportsBedrockPromptCaching(model)).map(model => model.id);
		expect(undetected).toEqual([]);
	});

	/**
	 * And the reverse, which is what catches a silent pricing regression: the only
	 * undetected models are the pre-caching Claude 3 generation. If a catalog regen
	 * drops cache pricing for a current family, that family lands in this list and
	 * this fails, instead of the loss showing up on a bill.
	 */
	it("leaves only the pre-caching Claude 3 generation undetected", () => {
		const undetected = bedrockClaudeModels()
			.filter(model => !supportsBedrockPromptCaching(model))
			.map(model => model.id);
		const unexpected = undetected.filter(
			id => !UNCACHEABLE_FAMILIES.some(family => id.toLowerCase().includes(family)),
		);
		expect(unexpected).toEqual([]);
	});

	/**
	 * Claude 5 is the concrete case the id substrings miss: `claude-fable-5`
	 * contains neither `-4-` nor `-4.` nor `claude-haiku`. Named explicitly so the
	 * suite states which family is carried by pricing alone, rather than leaving a
	 * reader to work out why the fallback list looks stale.
	 */
	it("supports Claude 5 on Bedrock, which no id substring matches", () => {
		const claude5 = bedrockClaudeModels().filter(model => /fable|mythos/.test(model.id.toLowerCase()));
		expect(claude5.length).toBeGreaterThan(0);
		for (const model of claude5) {
			const id = model.id.toLowerCase();
			expect(id.includes("-4-") || id.includes("-4.") || id.includes("claude-haiku")).toBe(false);
			expect(supportsBedrockPromptCaching(model)).toBe(true);
		}
	});
});
