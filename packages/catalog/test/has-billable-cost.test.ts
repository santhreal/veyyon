/**
 * `hasBillableCost`: does a cost object carry numbers worth using?
 *
 * WHY THIS SUITE EXISTS. Two independent copies of this predicate existed, spelled identically
 * down to the order of the four buckets: one in the catalog's model generator, deciding whether an
 * OpenAI entry can donate its pricing to the matching Codex entry, and one in the stats database,
 * deciding whether to fall back through the bundled catalog before showing a cost. Both answers
 * feed money that a user reads. A drift between them means the generator bakes a price into
 * `models.json` that the dashboard then declines to trust, or the reverse.
 *
 * The subtle part, and the reason this has a doc rather than one assertion: an all-zero cost is
 * AMBIGUOUS. A provider that publishes no pricing produces exactly the same object as a genuinely
 * free model, which is how veyyon once displayed roughly 1,500 paid models as costing nothing, and
 * why `ModelSpec.costKnown` exists. This predicate does not resolve that ambiguity and must never
 * be read as "the model is free". It answers only "look somewhere else for pricing", where being
 * wrong about a free model costs nothing because the fallback finds nothing either.
 */

import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { emptyCost, hasBillableCost } from "../src/models";

/** A published cost, in dollars per million tokens. */
const PAID = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };

describe("a cost with numbers in it", () => {
	it("is billable when every bucket is priced", () => {
		expect(hasBillableCost(PAID)).toBe(true);
	});

	/**
	 * Each bucket on its own is enough. Cache-only pricing is not hypothetical: providers publish
	 * entries where the prompt is free and only cache writes are charged, and an `input`-only check
	 * would have declared those unpriced and sent the reader to a fallback that overwrote real
	 * numbers.
	 */
	it("is billable on any single non-zero bucket", () => {
		expect(hasBillableCost({ input: 3, output: 0, cacheRead: 0, cacheWrite: 0 })).toBe(true);
		expect(hasBillableCost({ input: 0, output: 15, cacheRead: 0, cacheWrite: 0 })).toBe(true);
		expect(hasBillableCost({ input: 0, output: 0, cacheRead: 0.3, cacheWrite: 0 })).toBe(true);
		expect(hasBillableCost({ input: 0, output: 0, cacheRead: 0, cacheWrite: 3.75 })).toBe(true);
	});

	/** Prices per million tokens go far below one cent; a threshold instead of `!== 0` would eat them. */
	it("is billable at a fractional price", () => {
		expect(hasBillableCost({ input: 0.000001, output: 0, cacheRead: 0, cacheWrite: 0 })).toBe(true);
	});

	/**
	 * A negative price is not a real tariff, but a credit or a bad upstream row can produce one, and
	 * treating it as "no pricing published" would silently replace it with a fallback price. Numbers
	 * present means numbers present; validating them is a separate job.
	 */
	it("treats a negative price as present", () => {
		expect(hasBillableCost({ input: -1, output: 0, cacheRead: 0, cacheWrite: 0 })).toBe(true);
	});
});

describe("a cost with no numbers in it", () => {
	it("is not billable when every bucket is zero", () => {
		expect(hasBillableCost({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })).toBe(false);
	});

	/** `emptyCost` is what a provider installs before real costs are computed, and it must read as unpriced. */
	it("is not billable for a freshly zeroed Usage cost", () => {
		expect(hasBillableCost(emptyCost())).toBe(false);
	});

	/**
	 * `-0 !== 0` is false in JavaScript, so a negative zero from a rounding step reads as unpriced,
	 * which is the correct answer and worth pinning because `Object.is(-0, 0)` would disagree.
	 */
	it("is not billable for a negative zero", () => {
		expect(hasBillableCost({ input: -0, output: -0, cacheRead: -0, cacheWrite: -0 })).toBe(false);
	});
});

describe("the shape it accepts", () => {
	/**
	 * The parameter is structural on purpose: the generator passes `ModelSpec["cost"]`, the stats
	 * database passes its own row shape, and a `Usage` cost carries an extra `total`. A nominal
	 * parameter type is what pushed the second copy into existence in the first place.
	 */
	it("accepts a cost carrying extra fields", () => {
		const paidUsageCost = { ...PAID, total: 0 };
		const zeroUsageCost = { ...emptyCost(), total: 99 };

		expect(hasBillableCost(paidUsageCost)).toBe(true);
		expect(hasBillableCost(zeroUsageCost)).toBe(false);
	});

	/** `total` is derived, so it is deliberately NOT one of the buckets consulted. */
	it("ignores total", () => {
		const spentButUnpriced = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 12.5 };

		expect(hasBillableCost(spentButUnpriced)).toBe(false);
	});
});

describe("one owner", () => {
	/**
	 * The lock. Both former owners must import it, and neither may define its own again: a second
	 * definition is how the generator's baked prices and the dashboard's displayed prices came to be
	 * decided by two functions that only happened to agree.
	 */
	it("is defined once, and both former owners import it", async () => {
		const sources = [
			path.join(import.meta.dir, "../scripts/generate-models.ts"),
			path.join(import.meta.dir, "../../stats/src/db.ts"),
		];

		for (const file of sources) {
			const source = await Bun.file(file).text();

			expect(source).not.toContain("function hasBillableCost");
			expect(source).toContain("hasBillableCost");
		}
	});
});
