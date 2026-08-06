import { describe, expect, test } from "bun:test";
import { buildOpenAIResponsesCompat } from "@veyyon/catalog/compat/openai";

/**
 * `supportsServerCompaction` is the DATA a host carries to declare it serves
 * `POST /responses/compact` (OpenAI Compaction guide; Microsoft Learn for
 * Azure's v1 API). The compaction engine reads this flag and nothing else, so
 * a second compatible host opts in here, never in provider code.
 */
describe("supportsServerCompaction capability data", () => {
	test("the official OpenAI endpoint supports it, including an unset baseUrl", () => {
		expect(buildOpenAIResponsesCompat({ provider: "openai", name: "GPT-5", baseUrl: "" }).supportsServerCompaction).toBe(
			true,
		);
		expect(
			buildOpenAIResponsesCompat({ provider: "openai", name: "GPT-5", baseUrl: "https://api.openai.com/v1" })
				.supportsServerCompaction,
		).toBe(true);
	});

	test("Azure OpenAI supports it, keyed on the provider id (baseUrl is per-resource)", () => {
		expect(buildOpenAIResponsesCompat({ provider: "azure", name: "GPT-5", baseUrl: "" }).supportsServerCompaction).toBe(
			true,
		);
	});

	test("an openai row repointed at a proxy does not inherit support", () => {
		expect(
			buildOpenAIResponsesCompat({ provider: "openai", name: "GPT-5", baseUrl: "https://proxy.example.com/v1" })
				.supportsServerCompaction,
		).toBe(false);
	});

	test("codex stays off: its session transport owns history state", () => {
		expect(
			buildOpenAIResponsesCompat({ provider: "openai-codex", name: "GPT-5.1 Codex", baseUrl: "" })
				.supportsServerCompaction,
		).toBe(false);
	});

	test("routers and unrelated hosts stay off", () => {
		expect(
			buildOpenAIResponsesCompat({ provider: "openrouter", name: "GPT-5", baseUrl: "https://openrouter.ai/api/v1" })
				.supportsServerCompaction,
		).toBe(false);
		expect(
			buildOpenAIResponsesCompat({ provider: "github-copilot", name: "GPT-5", baseUrl: "" }).supportsServerCompaction,
		).toBe(false);
	});

	test("a compatible gateway opts in with a sparse compat override alone", () => {
		const compat = buildOpenAIResponsesCompat({
			provider: "openai",
			name: "GPT-5",
			baseUrl: "https://proxy.example.com/v1",
			compat: { supportsServerCompaction: true },
		});
		expect(compat.supportsServerCompaction).toBe(true);
	});
});
