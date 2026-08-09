/**
 * WHY THIS SUITE EXISTS. The models.dev-declarations cutover (catalog commit
 * "source effort ladders and limits from models.dev declarations only") removed
 * the last identity-derived effort ladder from resolveModelThinking: a spec
 * carrying neither `thinking` nor `reasoningOptions` builds with
 * `thinking: undefined`. Every identity that used to get a fabricated ladder
 * (Codex gpt-5.x, DeepSeek, Fireworks/Zhipu GLM-5.2, xAI Grok, Anthropic
 * Claude 4.5/4.7, Xiaomi MiMo) silently lost its thinking surface, and a dozen
 * ai-package fixtures that assumed the derivation broke at once. Nothing in the
 * catalog test suite caught it, because the derivation was only ever exercised
 * through those downstream fixtures.
 *
 * This suite pins the contract at the source: bare specs for exactly those
 * identities MUST build with no fabricated ENUM ladder, and the SAME specs
 * carrying a models.dev-style `reasoningOptions` declaration MUST produce
 * exactly the declared ladder. If identity derivation ever comes back, the first
 * block fails; if the declaration path breaks, the second does.
 *
 * The one tolerated surface on a bare spec is a pure `budget` transport, and it
 * is not a fabricated vocabulary. A budget row takes a token count, so there is
 * no enum to reject and Veyyon's own effort→budget schedule decides the tiers.
 * The first block therefore accepts `thinking: undefined` OR exactly the budget
 * ladder under mode `budget`, and nothing else: a row that fabricates an
 * `effort`, `google-level`, `anthropic-adaptive` or `anthropic-budget-effort`
 * ladder from its id still fails. The expectation is read off the built model
 * rather than listed per row, so a new matrix entry cannot opt itself out.
 */
import { describe, expect, it } from "bun:test";
import { buildModel } from "@veyyon/catalog/build";
import { Effort } from "@veyyon/catalog/effort";
import type { Api, Model, ModelSpec, Provider } from "@veyyon/catalog/types";

interface MatrixEntry {
	id: string;
	api: Api;
	provider: Provider;
	baseUrl: string;
	/** Declared ladder for the positive control (mirrors the bundled models.json row). */
	declared: readonly Effort[];
}

const MATRIX: readonly MatrixEntry[] = [
	{
		id: "gpt-5.1",
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: "https://api.openai.com/v1",
		declared: [Effort.Low, Effort.Medium, Effort.High],
	},
	{
		id: "gpt-5.5",
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: "https://api.openai.com/v1",
		declared: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
	},
	{
		id: "gpt-5.6-sol",
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: "https://api.openai.com/v1",
		declared: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max],
	},
	{
		id: "deepseek-v4-pro",
		api: "openai-completions",
		provider: "deepseek",
		baseUrl: "https://api.deepseek.com/v1",
		declared: [Effort.High, Effort.Max],
	},
	{
		id: "glm-5.2",
		api: "openai-completions",
		provider: "fireworks",
		baseUrl: "https://api.fireworks.ai/inference/v1",
		declared: [Effort.High, Effort.Max],
	},
	{
		id: "glm-5.2",
		api: "openai-completions",
		provider: "zhipu-coding-plan",
		baseUrl: "https://open.bigmodel.cn/api/paas/v4",
		declared: [Effort.High, Effort.Max],
	},
	{
		id: "grok-4.3",
		api: "openai-responses",
		provider: "xai-oauth",
		baseUrl: "https://api.x.ai/v1",
		declared: [Effort.Low, Effort.Medium, Effort.High],
	},
	{
		id: "claude-sonnet-4-5",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		declared: [Effort.High, Effort.Max],
	},
	{
		id: "claude-opus-4-5",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		declared: [Effort.Low, Effort.Medium, Effort.High],
	},
	{
		id: "claude-opus-4-7",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		declared: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max],
	},
	{
		id: "mimo-v2.5-pro",
		api: "openai-completions",
		provider: "xiaomi-token-plan-sgp",
		baseUrl: "https://token-plan-sgp.xiaomi.com/v1",
		// The bundled row is toggle-only (noEffortControl); a synthetic ladder
		// here proves the declaration path produces exactly what is declared.
		declared: [Effort.Low, Effort.Medium, Effort.High],
	},
];

function bareSpec(entry: MatrixEntry): ModelSpec<Api> {
	return {
		id: entry.id,
		name: entry.id,
		api: entry.api,
		provider: entry.provider,
		baseUrl: entry.baseUrl,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 32_000,
	} as ModelSpec<Api>;
}

describe("no identity-derived thinking surface", () => {
	it.each(MATRIX.map(entry => [entry.provider, entry.id, entry] as const))(
		"fabricates no effort ladder for %s/%s from a bare spec",
		(_provider, _id, entry) => {
			const model: Model<Api> = buildModel(bareSpec(entry));
			expect(model.reasoning).toBe(true);
			if (model.thinking === undefined) return;
			expect(model.thinking.mode).toBe("budget");
			expect(model.thinking.efforts).toEqual([Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh]);
		},
	);

	it.each(MATRIX.map(entry => [entry.provider, entry.id, entry] as const))(
		"builds %s/%s with exactly the declared ladder when reasoningOptions declares one",
		(_provider, _id, entry) => {
			const model: Model<Api> = buildModel({
				...bareSpec(entry),
				reasoningOptions: { efforts: [...entry.declared] },
			});
			expect(model.thinking?.efforts).toEqual(entry.declared);
		},
	);
});
