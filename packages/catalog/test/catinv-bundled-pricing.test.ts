/**
 * WHY: the arithmetic sanity of every priced row in the bundle. The model
 * browser and the stats dashboard turn `cost` into money a user reads, and
 * this package already shipped the two ends of that failure: roughly 1,500
 * paid models displayed as free (the `getModelPricing` incident pinned in
 * model-pricing.test.ts) and a NaN price baked into the bundle
 * (openrouter-pricing-nan). Classification is guarded there; the RELATIONSHIPS
 * between the four price buckets were not:
 *
 *  1. Cache pricing never stands alone. A row with any nonzero bucket must
 *     have a nonzero input price — a cache-read/write price with no token
 *     price means the generator kept a partial upstream cost object, and the
 *     dashboard would bill sessions at $0 while displaying a price.
 *  2. Reading from cache is never billed above fresh input. `cacheRead >
 *     input` inverts the one economic fact every provider honors; it means a
 *     field swap in the generator (cache_read mapped from the wrong upstream
 *     key), not a real price.
 *  3. A recorded `pricing: "published"` fact always has a nonzero bucket —
 *     the field exists to distinguish "upstream published prices" from "we
 *     were never told", and a published-but-all-zero row is that record
 *     contradicting itself.
 *
 * Sweeps collect every offender across all bundled rows and fail with the
 * full list. `output > 0` is deliberately NOT required: embedding/image rows
 * (e.g. zenmux's text-embedding-3-large) are legitimately input-only priced.
 */
import { describe, expect, it } from "bun:test";
import { hasBillableCost } from "@veyyon/catalog/models";
import MODELS from "@veyyon/catalog/models.json" with { type: "json" };

interface Row {
	label: string;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	pricing?: string;
}

function allRows(): Row[] {
	const out: Row[] = [];
	for (const [provider, section] of Object.entries(
		MODELS as Record<string, Record<string, Record<string, unknown>>>,
	)) {
		for (const [key, row] of Object.entries(section)) {
			out.push({
				label: `${provider}/${key}`,
				cost: row.cost as Row["cost"],
				pricing: row.pricing as string | undefined,
			});
		}
	}
	return out;
}

describe("the bundled catalog's pricing is internally consistent", () => {
	it("no row prices cache or output while billing input at zero", () => {
		const offenders = allRows()
			.filter(r => hasBillableCost(r.cost) && r.cost.input === 0)
			.map(r => `${r.label}: ${JSON.stringify(r.cost)}`);
		expect(offenders).toEqual([]);
	});

	it("no row bills cache reads above fresh input tokens", () => {
		const offenders = allRows()
			.filter(r => r.cost.cacheRead > 0 && r.cost.cacheRead > r.cost.input)
			.map(r => `${r.label}: cacheRead=${r.cost.cacheRead} input=${r.cost.input}`);
		expect(offenders).toEqual([]);
	});

	it("no row records pricing as published while every bucket is zero", () => {
		const offenders = allRows()
			.filter(r => r.pricing === "published" && !hasBillableCost(r.cost))
			.map(r => r.label);
		expect(offenders).toEqual([]);
	});
});
