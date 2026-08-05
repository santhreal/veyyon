import { describe, expect, test } from "bun:test";
import * as hosts from "@veyyon/catalog/hosts";
import {
	hostMatchesUrl,
	isDashscopeCompatibleModeUrl,
	isVertexExpressOpenAIUrl,
	isVertexRawPredictUrl,
	modelMatchesHost,
} from "@veyyon/catalog/hosts";

describe("hostMatchesUrl", () => {
	test("matches OpenRouter URLs and rejects other or missing URLs", () => {
		expect(hostMatchesUrl("https://openrouter.ai/api/v1", "openrouter")).toBe(true);
		expect(hostMatchesUrl("https://api.openai.com/v1", "openrouter")).toBe(false);
		expect(hostMatchesUrl(undefined, "openrouter")).toBe(false);
	});

	test("matches Z.AI URLs case-insensitively", () => {
		expect(hostMatchesUrl("https://API.Z.AI/api/paas/v4", "zai")).toBe(true);
	});

	test("matches the Hugging Face Inference Providers router by URL", () => {
		expect(hostMatchesUrl("https://router.huggingface.co/v1", "huggingfaceRouter")).toBe(true);
		expect(hostMatchesUrl("https://api-inference.huggingface.co/v1", "huggingfaceRouter")).toBe(false);
	});

	test("keeps DeepSeek direct host narrower than DeepSeek family", () => {
		expect(hostMatchesUrl("https://api.deepseek.com/v1", "deepseekDirect")).toBe(true);
		expect(hostMatchesUrl("https://api.deepseek.com/v1", "deepseekFamily")).toBe(true);
		expect(hostMatchesUrl("https://chat.deepseek.com/api", "deepseekFamily")).toBe(true);
		expect(hostMatchesUrl("https://chat.deepseek.com/api", "deepseekDirect")).toBe(false);
	});
});

describe("modelMatchesHost", () => {
	test("matches by provider id, provider prefix, and URL-only Fireworks markers", () => {
		expect(modelMatchesHost({ provider: "openrouter", baseUrl: "https://example.com/v1" }, "openrouter")).toBe(true);
		expect(modelMatchesHost({ provider: "xiaomi-token-plan-eu", baseUrl: "https://example.com/v1" }, "xiaomi")).toBe(
			true,
		);
		expect(modelMatchesHost({ provider: "fireworks", baseUrl: "https://example.com/v1" }, "fireworks")).toBe(false);
		expect(
			modelMatchesHost({ provider: "custom", baseUrl: "https://api.fireworks.ai/inference/v1" }, "fireworks"),
		).toBe(true);
	});
});

describe("endpoint shape predicates", () => {
	test("recognizes Vertex express OpenAI-compatible URLs", () => {
		expect(
			isVertexExpressOpenAIUrl(
				"https://us-central1-aiplatform.googleapis.com/v1/projects/p/locations/us/endpoints/openapi",
			),
		).toBe(true);
		expect(
			isVertexExpressOpenAIUrl(
				"https://us-central1-aiplatform.googleapis.com/v1/projects/p/locations/us/publishers/google/models/gemini",
			),
		).toBe(false);
	});

	test("recognizes Vertex rawPredict and streamRawPredict URLs", () => {
		expect(
			isVertexRawPredictUrl(
				"https://aiplatform.googleapis.com/v1/projects/p/locations/us/publishers/anthropic/models/claude:rawPredict",
			),
		).toBe(true);
		expect(
			isVertexRawPredictUrl(
				"https://aiplatform.googleapis.com/v1/projects/p/locations/us/publishers/anthropic/models/claude:streamRawPredict",
			),
		).toBe(true);
	});

	test("requires all DashScope compatible-mode URL markers", () => {
		expect(isDashscopeCompatibleModeUrl("https://dashscope.aliyuncs.com/compatible-mode/v1")).toBe(true);
		expect(isDashscopeCompatibleModeUrl("https://example.aliyuncs.com/compatible-mode/v1")).toBe(false);
		expect(isDashscopeCompatibleModeUrl("https://dashscope.example.com/compatible-mode/v1")).toBe(false);
		expect(isDashscopeCompatibleModeUrl("https://dashscope.aliyuncs.com/api/v1")).toBe(false);
	});
});

/**
 * `hosts` once exported `isAzureDeploymentsUrl`, a `baseUrl.includes("/deployments/")`
 * one-liner with zero consumers anywhere in the tree while the only site that
 * needs the check (`openai-shared.ts`, building the Azure chat-completions URL)
 * inlined it. An extracted endpoint-shape predicate that nothing calls reads as
 * the supported way to classify an Azure deployment URL and is not one: a caller
 * reaching for it would branch on a bare path substring, so any host with a
 * `/deployments/` segment would classify as Azure. Azure classification goes
 * through the `azureOpenAI` host markers instead.
 */
describe("Azure deployment URLs classify through the azureOpenAI host, not a path predicate", () => {
	test("exposes no standalone Azure deployments path predicate", () => {
		expect("isAzureDeploymentsUrl" in hosts).toBe(false);
	});

	test("matches deployment-scoped Azure URLs by host marker", () => {
		expect(hostMatchesUrl("https://my-res.openai.azure.com/openai/deployments/gpt-5", "azureOpenAI")).toBe(true);
		expect(hostMatchesUrl("https://azure.com/openai/deployments/gpt-5", "azureOpenAI")).toBe(true);
		// A `/deployments/` segment alone is not Azure — the trap the bare
		// substring predicate would have set for its first caller.
		expect(hostMatchesUrl("https://example.com/v1/deployments/gpt-5", "azureOpenAI")).toBe(false);
		// Azure without a deployment segment still classifies.
		expect(hostMatchesUrl("https://my-res.openai.azure.com/openai/responses", "azureOpenAI")).toBe(true);
	});
});
