/**
 * WHY: Custom and discovery models constructed without explicit `cost` fields
 * had `model.cost` set to `undefined`. When streaming provider responses
 * reported chunk usage, `calculateCost(model, usage)` attempted to access
 * `model.cost.input`, throwing an uncaught TypeError:
 *   "undefined is not an object (evaluating 'model.cost.input')"
 * which aborted the provider stream, caused local LLM servers (e.g. llama.cpp)
 * to cancel active GPU tasks, and failed the turn with status Error.
 *
 * This suite verifies the full class of model construction boundaries (sparse
 * ModelSpec, custom config overlay, discovery mapping, and unpriced models)
 * ensure `model.cost` is always normalized with concrete numbers, and that
 * `calculateCost` safely computes zero cost without throwing.
 */
import { describe, expect, it } from "bun:test";
import { buildModel } from "../src/build";
import { calculateCost, emptyUsage, getModelPricing } from "../src/models";
import { type Api, KNOWN_APIS, type Model, type ModelSpec } from "../src/types";

describe("model cost normalization across construction boundaries", () => {
	it.each([...KNOWN_APIS])("normalizes omitted cost to zeroed defaults for api %s", api => {
		const spec: ModelSpec<Api> = {
			id: `test-model-${api}`,
			provider: "test-provider",
			api,
			name: `Test Model ${api}`,
			baseUrl: "http://127.0.0.1:8080/v1",
			reasoning: false,
			input: ["text"],
			contextWindow: 16384,
			maxTokens: 2048,
		};
		const model = buildModel(spec);
		expect(model.cost).toEqual({
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
		});

		const usage = { ...emptyUsage(), input: 15_000, output: 800, cacheRead: 5_000, cacheWrite: 0 };
		const cost = calculateCost(model, usage);
		expect(cost.input).toBe(0);
		expect(cost.output).toBe(0);
		expect(cost.cacheRead).toBe(0);
		expect(cost.cacheWrite).toBe(0);
		expect(cost.total).toBe(0);
	});

	it("preserves partial explicit cost fields and fills unstated fields with zero", () => {
		const spec: ModelSpec<"openai-completions"> = {
			id: "partial-cost-model",
			provider: "local",
			api: "openai-completions",
			name: "Partial Cost",
			baseUrl: "http://127.0.0.1:8080/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 2.5 },
			contextWindow: 16384,
			maxTokens: 2048,
		};
		const model = buildModel(spec);
		expect(model.cost).toEqual({
			input: 2.5,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
		});

		const usage = { ...emptyUsage(), input: 1_000_000, output: 500_000 };
		const cost = calculateCost(model, usage);
		expect(cost.input).toBeCloseTo(2.5, 10);
		expect(cost.output).toBe(0);
		expect(cost.total).toBeCloseTo(2.5, 10);
	});

	it("safely handles raw model objects missing cost in calculateCost", () => {
		const rawModel = {
			id: "unconstructed-model",
			provider: "local",
			api: "openai-completions",
			baseUrl: "http://127.0.0.1:8080/v1",
		} as unknown as Model<"openai-completions">;

		const usage = { ...emptyUsage(), input: 20_000, output: 1_000 };
		const cost = calculateCost(rawModel, usage);
		expect(cost.input).toBe(0);
		expect(cost.output).toBe(0);
		expect(cost.cacheRead).toBe(0);
		expect(cost.cacheWrite).toBe(0);
		expect(cost.total).toBe(0);
	});

	it("correctly identifies unpriced vs free models when cost is zeroed", () => {
		const unpriced = buildModel({
			id: "local-qwen",
			provider: "local",
			api: "openai-completions",
			name: "Local Qwen",
			baseUrl: "http://127.0.0.1:8080/v1",
			reasoning: false,
			input: ["text"],
			contextWindow: 32768,
			maxTokens: 1024,
		} as ModelSpec<"openai-completions">);

		expect(getModelPricing(unpriced)).toBe("unpriced");

		const free = buildModel({
			id: "meta-llama/llama-3-8b:free",
			provider: "openrouter",
			api: "openrouter",
			name: "Llama 3 Free",
			baseUrl: "https://openrouter.ai/api/v1",
			reasoning: false,
			input: ["text"],
			contextWindow: 8192,
			maxTokens: 2048,
		} as ModelSpec<"openrouter">);

		expect(getModelPricing(free)).toBe("free");
	});
});
