import { afterEach, describe, expect, it } from "bun:test";
import type { Api } from "@veyyon/ai/types";
import {
	DISCOVERY_DEFAULT_MAX_TOKENS,
	discoveryDefaultMaxTokens,
	getOllamaContextLengthOverride,
	normalizeLiteLLMDiscoveryBaseUrl,
	normalizeOpenAIModelsListBaseUrl,
} from "@veyyon/coding-agent/config/model-discovery";

/**
 * Base-URL normalization and env-override parsing for local model discovery had
 * no direct tests. These are the functions that decide the exact URL discovery
 * calls (`/v1` suffixing) and whether a user's OLLAMA_CONTEXT_LENGTH override is
 * honored. A silent regression here breaks local-provider discovery without any
 * visible error, so each edge is pinned to a concrete value.
 */

describe("normalizeOpenAIModelsListBaseUrl", () => {
	it("falls back to the LM Studio default for empty input", () => {
		expect(normalizeOpenAIModelsListBaseUrl()).toBe("http://127.0.0.1:1234/v1");
		expect(normalizeOpenAIModelsListBaseUrl("")).toBe("http://127.0.0.1:1234/v1");
	});

	it("leaves an already-/v1 base URL unchanged", () => {
		expect(normalizeOpenAIModelsListBaseUrl("http://host:1234/v1")).toBe("http://host:1234/v1");
	});

	it("appends /v1 when the path is missing", () => {
		expect(normalizeOpenAIModelsListBaseUrl("http://host:1234")).toBe("http://host:1234/v1");
		expect(normalizeOpenAIModelsListBaseUrl("http://host:1234/")).toBe("http://host:1234/v1");
	});

	it("strips a trailing slash after an existing /v1", () => {
		expect(normalizeOpenAIModelsListBaseUrl("http://host:1234/v1/")).toBe("http://host:1234/v1");
	});

	it("appends /v1 onto a non-/v1 subpath", () => {
		expect(normalizeOpenAIModelsListBaseUrl("http://host:1234/api")).toBe("http://host:1234/api/v1");
	});

	it("returns the raw string unchanged when it is not a parseable URL", () => {
		expect(normalizeOpenAIModelsListBaseUrl("not a url")).toBe("not a url");
	});
});

describe("normalizeLiteLLMDiscoveryBaseUrl", () => {
	it("defaults to the LiteLLM proxy /v1 endpoint", () => {
		expect(normalizeLiteLLMDiscoveryBaseUrl()).toBe("http://localhost:4000/v1");
	});

	it("normalizes a supplied base URL the same way as the OpenAI list normalizer", () => {
		expect(normalizeLiteLLMDiscoveryBaseUrl("http://host:9000")).toBe("http://host:9000/v1");
	});
});

describe("discoveryDefaultMaxTokens", () => {
	it("uses the conservative 8192 cap for anthropic-messages to stay under the 3x output divisor", () => {
		expect(discoveryDefaultMaxTokens("anthropic-messages" as Api)).toBe(8192);
	});

	it("uses the standard discovery default for any other api", () => {
		expect(discoveryDefaultMaxTokens(undefined)).toBe(DISCOVERY_DEFAULT_MAX_TOKENS);
		expect(discoveryDefaultMaxTokens("openai" as Api)).toBe(DISCOVERY_DEFAULT_MAX_TOKENS);
		expect(DISCOVERY_DEFAULT_MAX_TOKENS).not.toBe(8192);
	});
});

describe("getOllamaContextLengthOverride", () => {
	const original = process.env.OLLAMA_CONTEXT_LENGTH;
	afterEach(() => {
		if (original === undefined) delete process.env.OLLAMA_CONTEXT_LENGTH;
		else process.env.OLLAMA_CONTEXT_LENGTH = original;
	});

	it("returns undefined when the env var is unset or blank", () => {
		delete process.env.OLLAMA_CONTEXT_LENGTH;
		expect(getOllamaContextLengthOverride()).toBeUndefined();
		process.env.OLLAMA_CONTEXT_LENGTH = "   ";
		expect(getOllamaContextLengthOverride()).toBeUndefined();
	});

	it("parses a positive safe integer", () => {
		process.env.OLLAMA_CONTEXT_LENGTH = "8192";
		expect(getOllamaContextLengthOverride()).toBe(8192);
	});

	it("rejects zero, negatives, non-integers, and non-numbers", () => {
		for (const bad of ["0", "-4", "12.5", "abc", "Infinity"]) {
			process.env.OLLAMA_CONTEXT_LENGTH = bad;
			expect(getOllamaContextLengthOverride()).toBeUndefined();
		}
	});
});
