import { describe, expect, it } from "bun:test";
import { getModelPricing } from "@veyyon/catalog/models";
import MODELS from "@veyyon/catalog/models.json" with { type: "json" };

/**
 * Discovery writes `cost: {input: 0, output: 0, ...}` whenever a provider's
 * `/models` endpoint carries no pricing, which is what most of them do. The
 * model browser read that zero as "free" and told users that roughly 1,500
 * bundled models, including paid ones like `aimlapi/alibaba/qwen3-max-instruct`
 * and every NVIDIA and Cursor entry, cost nothing.
 *
 * `getModelPricing` is the one place that separates "we know it is free" from
 * "we were never told". These tests pin that distinction and, importantly, pin
 * the property of the real catalog that the distinction relies on.
 */
describe("getModelPricing", () => {
	it("calls a model with a published input price priced", () => {
		expect(getModelPricing({ id: "gpt-4o", cost: { input: 2.5, output: 10, cacheRead: 0, cacheWrite: 0 } })).toBe(
			"priced",
		);
	});

	it("calls a model priced when only the output leg is published", () => {
		// Some catalogs publish output-only pricing. Requiring both legs would
		// misfile those as unpriced.
		expect(getModelPricing({ id: "some-model", cost: { input: 0, output: 1.5, cacheRead: 0, cacheWrite: 0 } })).toBe(
			"priced",
		);
	});

	it("calls a zero-cost model unpriced when nothing marks it free", () => {
		// REGRESSION. This is the case that produced the false "free" label.
		expect(
			getModelPricing({
				id: "alibaba/qwen3-max-instruct",
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			}),
		).toBe("unpriced");
	});

	it("calls a zero-cost model free only when the id carries the :free marker", () => {
		// OpenRouter's `:free` suffix is the only free signal we have, so it is the
		// only one trusted.
		expect(
			getModelPricing({
				id: "meta-llama/llama-3.3-70b-instruct:free",
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			}),
		).toBe("free");
	});

	it("does not treat a merely free-sounding id as free", () => {
		// The marker is a suffix, not a substring. `freedom-model` is not free and
		// neither is anything that only mentions the word.
		for (const id of ["freedom-model", "free-tier-preview", "gpt-free-4", "x:free-preview"]) {
			expect(getModelPricing({ id, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })).toBe("unpriced");
		}
	});

	it("prefers the published price over the marker when both are present", () => {
		// A `:free` id that somehow carries a real price is priced. The price is the
		// stronger evidence and the marker must not override it.
		expect(
			getModelPricing({
				id: "vendor/model:free",
				cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
			}),
		).toBe("priced");
	});
});

/**
 * The `:free` id suffix is a heuristic over missing data. It is the right answer
 * for catalog entries that carry no better evidence, but it is guessing, and it
 * guesses from a field (the id) that has nothing to do with price.
 *
 * `pricing` removes the guess for everything discovery produces: each module now
 * records whether its upstream published prices at all, so a zero can be read as
 * the fact it is rather than decoded. These tests pin that the recorded fact wins
 * over the heuristic in both directions, which is the whole point of adding it.
 */
describe("getModelPricing prefers a recorded pricing fact over the id heuristic", () => {
	const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

	it("calls a zero-cost model unpriced when discovery recorded that nothing was published", () => {
		expect(getModelPricing({ id: "some/model", cost: zero, pricing: "unknown" })).toBe("unpriced");
	});

	it("does NOT call a :free id free when discovery recorded that nothing was published", () => {
		// The case the heuristic gets wrong. A provider that omits pricing entirely
		// tells us nothing about a model whose id merely ends in `:free`, and
		// announcing it as free would be a claim made on no evidence.
		expect(getModelPricing({ id: "vendor/model:free", cost: zero, pricing: "unknown" })).toBe("unpriced");
	});

	it("calls a zero-cost model free when the upstream published that zero", () => {
		// The inverse, and the reason `published` is worth distinguishing: a price
		// of zero that a provider actually stated is a real price.
		expect(getModelPricing({ id: "vendor/model", cost: zero, pricing: "published" })).toBe("free");
	});

	it("still reports priced when a published price is present, whatever the marker says", () => {
		for (const pricing of ["published", "unknown"] as const) {
			expect(getModelPricing({ id: "m", cost: { ...zero, input: 3 }, pricing })).toBe("priced");
		}
	});

	it("falls back to the id heuristic only when no pricing fact was recorded", () => {
		// Bundled catalog entries predate the field. They must keep classifying
		// exactly as they did before it existed.
		expect(getModelPricing({ id: "vendor/model:free", cost: zero })).toBe("free");
		expect(getModelPricing({ id: "vendor/model", cost: zero })).toBe("unpriced");
	});
});

/**
 * The classification above is only sound because of two properties of the
 * shipped catalog. If either stops holding, the `:free` marker stops being
 * trustworthy evidence and this whole approach needs revisiting, so they are
 * asserted directly against `models.json` rather than assumed.
 */
describe("the bundled catalog supports the free marker as evidence", () => {
	const entries: Array<{
		provider: string;
		id: string;
		model: { id: string; cost?: { input: number; output: number } };
	}> = [];
	for (const [provider, models] of Object.entries(MODELS as Record<string, Record<string, never>>)) {
		for (const [id, model] of Object.entries(models)) {
			entries.push({ provider, id, model: model as never });
		}
	}

	it("has no model that is marked :free but carries a real price", () => {
		// If this ever fails, the marker no longer means free and `getModelPricing`
		// would be labelling paid models free, the exact bug in the other direction.
		const contradictions = entries
			.filter(e => e.model.id.endsWith(":free"))
			.filter(e => (e.model.cost?.input ?? 0) > 0 || (e.model.cost?.output ?? 0) > 0)
			.map(e => `${e.provider}/${e.id}`);

		expect(contradictions).toEqual([]);
	});

	it("still classifies a large share of the catalog as unpriced, so the label matters", () => {
		// Documents the scale of the problem this fix addresses. A sharp drop here
		// means providers started publishing prices, which is good, but it also
		// means this label is doing less work and the number below should be
		// revisited rather than left as a stale claim.
		const unpriced = entries.filter(e => getModelPricing(e.model as never) === "unpriced");

		expect(unpriced.length).toBeGreaterThan(1000);
	});

	it("classifies every catalog entry as exactly one of the three states", () => {
		// No entry may fall through the classifier, including ones with a missing
		// cost object entirely.
		for (const entry of entries) {
			expect(["priced", "free", "unpriced"]).toContain(getModelPricing(entry.model as never));
		}
	});
});
