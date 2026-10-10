/**
 * WHY: the shop finds a product by its SKU alone: a search result's link, the add-to-cart form and
 * an order line all carry only the SKU. A seeded catalog that drew one SKU for two products left the
 * second unreachable, its link opening the first, and a task whose answer it was could not be
 * completed. The first such catalog among the seeds this suite generates is seed 7774.
 *
 * The sweep generates the catalog of every seed below 30,000 and asserts no two products share a
 * SKU.
 *
 * Not caught: a repeat that only a seed past the sweep draws, were the draw-until-unused loop in the
 * generator replaced by something weaker that still holds for these seeds.
 */
import { describe, expect, it } from "bun:test";
import { Seeded } from "../../../engine/kit/seeded";
import { generateShop } from "../../../suites/browser/apps/shop/data";

describe("the shop's seeded catalog", () => {
	it("gives every product of the first 30,000 catalogs a SKU no other product has", () => {
		const repeated: number[] = [];
		for (let seed = 0; seed < 30_000; seed++) {
			const { products } = generateShop(new Seeded(seed));
			if (new Set(products.map(item => item.sku)).size !== products.length) repeated.push(seed);
		}
		expect(repeated).toEqual([]);
	});
});
