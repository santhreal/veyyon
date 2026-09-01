import { describe, expect, it } from "bun:test";
import { AUTHENTICATED_API_KEY_SENTINEL, PROVIDER_ENV_KEY_OVERRIDES } from "../src/provider-env-keys";

describe("AUTHENTICATED_API_KEY_SENTINEL", () => {
	it("is '<authenticated>'", () => {
		expect(AUTHENTICATED_API_KEY_SENTINEL).toBe("<authenticated>");
	});
});

describe("PROVIDER_ENV_KEY_OVERRIDES", () => {
	it("has anthropic as a function resolver", () => {
		expect(typeof PROVIDER_ENV_KEY_OVERRIDES.anthropic).toBe("function");
	});
	it("has amazon-bedrock as a function resolver", () => {
		expect(typeof PROVIDER_ENV_KEY_OVERRIDES["amazon-bedrock"]).toBe("function");
	});
	it("has google-vertex as a function resolver", () => {
		expect(typeof PROVIDER_ENV_KEY_OVERRIDES["google-vertex"]).toBe("function");
	});
	it("has azure-openai-responses as string", () => {
		expect(PROVIDER_ENV_KEY_OVERRIDES["azure-openai-responses"]).toBe("AZURE_OPENAI_API_KEY");
	});
	it("has brave as string", () => {
		expect(PROVIDER_ENV_KEY_OVERRIDES.brave).toBe("BRAVE_API_KEY");
	});
	it("has exa as string", () => {
		expect(PROVIDER_ENV_KEY_OVERRIDES.exa).toBe("EXA_API_KEY");
	});
	it("has firecrawl as string", () => {
		expect(PROVIDER_ENV_KEY_OVERRIDES.firecrawl).toBe("FIRECRAWL_API_KEY");
	});
	it("has jina as string", () => {
		expect(PROVIDER_ENV_KEY_OVERRIDES.jina).toBe("JINA_API_KEY");
	});
	it("has kagi as string", () => {
		expect(PROVIDER_ENV_KEY_OVERRIDES.kagi).toBe("KAGI_API_KEY");
	});
	it("has llama.cpp as string", () => {
		expect(PROVIDER_ENV_KEY_OVERRIDES["llama.cpp"]).toBe("LLAMA_CPP_API_KEY");
	});
	it("has parallel as string", () => {
		expect(PROVIDER_ENV_KEY_OVERRIDES.parallel).toBe("PARALLEL_API_KEY");
	});
	it("has perplexity as string", () => {
		expect(PROVIDER_ENV_KEY_OVERRIDES.perplexity).toBe("PERPLEXITY_API_KEY");
	});
	it("has tavily as string", () => {
		expect(PROVIDER_ENV_KEY_OVERRIDES.tavily).toBe("TAVILY_API_KEY");
	});
	it("has tinyfish as string", () => {
		expect(PROVIDER_ENV_KEY_OVERRIDES.tinyfish).toBe("TINYFISH_API_KEY");
	});
});
