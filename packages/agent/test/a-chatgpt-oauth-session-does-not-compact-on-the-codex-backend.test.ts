/**
 * A ChatGPT OAuth (codex) session does not compact server-side: the ChatGPT
 * Codex backend serves no `/responses/compact` route and returns 404 Not Found.
 *
 * WHY: `compaction.remote` defaults on, and enabling server-side compaction on
 * the Codex backend caused all compaction attempts for ChatGPT OAuth sessions
 * to fail with 404 transport errors. Codex session transport owns state and
 * deltas, and must compact locally.
 *
 * WHAT CLASS THIS CLOSES:
 * 1. A provider or host without a server-side compaction route resolving a
 *    transport and failing with 404.
 * 2. Unauthenticated compaction requests to official OpenAI endpoints.
 */
import { afterEach, describe, expect, test, vi } from "bun:test";
import { resolveServerCompactionTransport } from "@veyyon/agent-core/compaction";
import type { Model } from "@veyyon/ai";
import { buildOpenAIResponsesCompat } from "@veyyon/catalog/compat/openai";
import { getBundledModel, getBundledModels } from "@veyyon/catalog/models";
import type { ResolvedOpenAIResponsesCompat } from "@veyyon/catalog/types";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("a ChatGPT OAuth session does not compact server-side on the codex backend", () => {
	test("every bundled codex model disables supportsServerCompaction and resolves no transport", () => {
		const codexModels = getBundledModels("openai-codex");
		expect(codexModels.length).toBeGreaterThan(0);
		for (const model of codexModels) {
			const compat = model.compat as ResolvedOpenAIResponsesCompat | undefined;
			expect(compat?.supportsServerCompaction).toBe(false);
			expect(resolveServerCompactionTransport(model)).toBeUndefined();
		}
	});

	test("custom or repointed codex endpoints never inherit supportsServerCompaction", () => {
		const custom = buildOpenAIResponsesCompat({
			provider: "openai-codex",
			name: "Custom Codex",
			baseUrl: "https://chatgpt.com/backend-api/codex",
		});
		expect(custom.supportsServerCompaction).toBe(false);

		const unset = buildOpenAIResponsesCompat({
			provider: "openai-codex",
			name: "Default Codex",
			baseUrl: "",
		});
		expect(unset.supportsServerCompaction).toBe(false);
	});

	test("official OpenAI and Azure models resolve a server-side transport while codex and proxies stay off", () => {
		const official = getBundledModel("openai", "gpt-5.1");
		if (!official) throw new Error("Expected built-in openai/gpt-5.1 to exist");
		expect(resolveServerCompactionTransport(official)).toBeDefined();

		const azure = getBundledModel("azure", "gpt-4");
		if (!azure) throw new Error("Expected built-in azure/gpt-4 to exist");
		expect(resolveServerCompactionTransport(azure)).toBeDefined();

		const proxied: Model = {
			...official,
			baseUrl: "https://proxy.example.com/v1",
			compat: buildOpenAIResponsesCompat({
				provider: "openai",
				name: "GPT-5.1 via proxy",
				baseUrl: "https://proxy.example.com/v1",
			}),
		};
		expect(resolveServerCompactionTransport(proxied)).toBeUndefined();

		const anthropic = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!anthropic) throw new Error("Expected built-in anthropic/claude-sonnet-4-5 to exist");
		expect(resolveServerCompactionTransport(anthropic)).toBeUndefined();
	});
});
