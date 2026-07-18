import { describe, expect, it } from "bun:test";
import { FALLBACK_DIALECT, preferredDialect } from "../src/identity/dialect";

describe("preferredDialect", () => {
	it("routes each recognized family to its native tool-call dialect", () => {
		expect(preferredDialect("claude-sonnet-5")).toBe("anthropic");
		expect(preferredDialect("glm-5.1")).toBe("glm");
		expect(preferredDialect("gemini-3-pro")).toBe("gemini");
		expect(preferredDialect("gemma-3-27b-it")).toBe("gemma");
		expect(preferredDialect("kimi-k2.6")).toBe("kimi");
		expect(preferredDialect("qwen3-coder-480b")).toBe("qwen3");
		expect(preferredDialect("deepseek-v3.2")).toBe("deepseek");
		expect(preferredDialect("minimax-m2")).toBe("minimax");
	});

	it("routes OpenAI and gpt-oss families to harmony", () => {
		expect(preferredDialect("gpt-5.2")).toBe("harmony");
		expect(preferredDialect("gpt-oss-120b")).toBe("harmony");
	});

	it("falls back to xml for unknown model ids", () => {
		expect(FALLBACK_DIALECT).toBe("xml");
		expect(preferredDialect("some-unknown-model")).toBe("xml");
		expect(preferredDialect("")).toBe("xml");
	});

	it("sees through provider-namespaced ids", () => {
		expect(preferredDialect("anthropic/claude-opus-4-8")).toBe("anthropic");
	});
});
