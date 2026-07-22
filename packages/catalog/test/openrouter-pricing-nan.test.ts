import { describe, expect, it } from "bun:test";
import { openrouterModelManagerOptions } from "@veyyon/catalog/provider-models/openai-compat";

/**
 * The OpenRouter model mapper turns each entry's per-token price strings into a
 * cost-per-million figure. It used to parse them with a bare
 * `parseFloat(String(pricing?.prompt ?? "0")) * 1_000_000`, while the sibling
 * OpenRouter mapper in the same file routed the identical fields through the
 * shared `toPositiveNumber(pricing.prompt, 0)` owner. A missing field or a
 * non-numeric string (an aggregator that returns "" or "N/A") made parseFloat
 * yield NaN, and `NaN * 1_000_000` is NaN — a NaN cost then silently corrupts
 * every downstream budget/spend sum with no error. These tests pin that a
 * malformed or absent price maps to a finite 0 cost, never NaN, and that a
 * valid price still scales to per-million correctly.
 */
async function mapOpenRouterEntry(pricing: unknown): Promise<{
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}> {
	const options = openrouterModelManagerOptions({
		fetch: async () =>
			new Response(
				JSON.stringify({
					data: [
						{
							id: "vendor/model",
							name: "Vendor: Model",
							supported_parameters: ["tools"],
							architecture: { modality: "text" },
							pricing,
							context_length: 128_000,
						},
					],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
	});
	const models = await options.fetchDynamicModels?.();
	const cost = models?.[0]?.cost;
	if (cost === undefined) throw new Error("expected a mapped OpenRouter model with a cost");
	return cost;
}

describe("OpenRouter pricing never produces a NaN cost", () => {
	it("scales a valid per-token price string to cost-per-million", async () => {
		const cost = await mapOpenRouterEntry({
			prompt: "0.000003",
			completion: "0.000015",
			input_cache_read: "0.0000003",
			input_cache_write: "0.00000375",
		});
		expect(cost.input).toBeCloseTo(3, 10);
		expect(cost.output).toBeCloseTo(15, 10);
		expect(cost.cacheRead).toBeCloseTo(0.3, 10);
		expect(cost.cacheWrite).toBeCloseTo(3.75, 10);
	});

	it("maps a non-numeric price string to 0, not NaN", async () => {
		const cost = await mapOpenRouterEntry({
			prompt: "N/A",
			completion: "",
			input_cache_read: "free",
			input_cache_write: "unknown",
		});
		for (const value of Object.values(cost)) {
			expect(Number.isNaN(value)).toBe(false);
			expect(value).toBe(0);
		}
	});

	it("maps missing pricing fields to 0, not NaN", async () => {
		const cost = await mapOpenRouterEntry({});
		for (const value of Object.values(cost)) {
			expect(Number.isNaN(value)).toBe(false);
			expect(value).toBe(0);
		}
	});

	it("maps an absent pricing object to 0, not NaN", async () => {
		const cost = await mapOpenRouterEntry(undefined);
		for (const value of Object.values(cost)) {
			expect(Number.isNaN(value)).toBe(false);
			expect(value).toBe(0);
		}
	});
});
