import { describe, expect, it } from "bun:test";
import { type } from "arktype";
import { modelsConfigSchemas } from "../../src/config/models-config-schema";

/**
 * WHY THIS SUITE EXISTS. The `string` keyword accepts `""`, so a models config
 * with `id: ""`, `baseUrl: ""` or `apiKey: ""` validates as far as the object
 * schema is concerned and then configures nothing, or configures the wrong
 * thing. The narrows on the model definition, the model override and the
 * provider config reject the empty string and name the key. This suite pins,
 * for every key each schema checks, that the rejection fires and states the
 * key, that two empty keys are reported in declaration order, and that a
 * non-empty value passes.
 *
 * It does not cover whitespace-only values: `" "` is accepted by design and
 * left to the code that reads the key.
 */

const { ModelsConfigSchema, ModelOverrideSchema } = modelsConfigSchemas();

function summaryOf(result: unknown): string {
	if (!(result instanceof type.errors)) throw new Error(`Expected a validation error, got ${JSON.stringify(result)}`);
	return result.summary;
}

const MODEL_KEYS = ["id", "name", "baseUrl", "contextPromotionTarget", "compactionModel"] as const;
const OVERRIDE_KEYS = ["name", "contextPromotionTarget", "compactionModel"] as const;
const PROVIDER_KEYS = ["baseUrl", "apiKey"] as const;

describe("a models config rejects an empty identifier string", () => {
	for (const key of MODEL_KEYS) {
		it(`names an empty model ${key}`, () => {
			const result = ModelsConfigSchema({ providers: { p: { models: [{ id: "m", [key]: "" }] } } });
			expect(summaryOf(result)).toContain(`${key} a non-empty string`);
		});
	}

	for (const key of OVERRIDE_KEYS) {
		it(`names an empty override ${key}`, () => {
			expect(summaryOf(ModelOverrideSchema({ [key]: "" }))).toContain(`${key} a non-empty string`);
		});
	}

	for (const key of PROVIDER_KEYS) {
		it(`names an empty provider ${key}`, () => {
			const result = ModelsConfigSchema({ providers: { p: { [key]: "" } } });
			expect(summaryOf(result)).toContain(`${key} a non-empty string`);
		});
	}

	it("reports the first empty key in declaration order", () => {
		const summary = summaryOf(ModelsConfigSchema({ providers: { p: { models: [{ id: "", baseUrl: "" }] } } }));
		expect(summary).toContain("id a non-empty string");
		expect(summary).not.toContain("baseUrl a non-empty string");
	});

	it("accepts every checked key once it is non-empty", () => {
		const result = ModelsConfigSchema({
			providers: {
				p: {
					baseUrl: "http://localhost:1",
					apiKey: "k",
					models: [
						{
							id: "m",
							name: "n",
							baseUrl: "http://localhost:2",
							contextPromotionTarget: "t",
							compactionModel: "c",
						},
					],
					modelOverrides: { m: { name: "n", contextPromotionTarget: "t", compactionModel: "c" } },
				},
			},
		});
		expect(result instanceof type.errors).toBe(false);
	});
});
