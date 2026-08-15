/**
 * WHY: OAuth surfaces models.dev does not catalog (xai-oauth, openai-codex,
 * google-antigravity, google-gemini-cli) were the only providers whose runtime
 * rows carried NO declared reasoning surface: the twin knowledge lived in the
 * bundle generator (`REASONING_SURFACE_TWINS`), so it baked into models.json
 * at regen time and never reached live discovery. A model the endpoint started
 * serving the day after a regen — grok-4.6 on xai-oauth was the reported case —
 * listed with "this model does not expose configurable reasoning effort" while
 * models.dev declared [low, medium, high, xhigh] for the same weights on the
 * same host.
 *
 * The contract pinned here, per OAuth twin:
 *  1. `defaultModelsDevFallback` covers the twin (models.dev source key differs
 *     from the veyyon provider id), stamps mapped rows with the TARGET
 *     provider id and the TARGET's wire api, and carries the declared effort
 *     ladder through as `reasoningOptions`.
 *  2. Twin fallbacks are `enrichOnly`: their rows may fill surfaces on ids the
 *     endpoint actually serves (static seed, cache, or live discovery) but may
 *     NEVER introduce an id of their own. The OAuth listing is
 *     subscription-gated (xAI's /v1/models under OAuth returns ~9 rows against
 *     a ~15-row API catalog), so an additive overlay would list models that
 *     fail at request time.
 *  3. The bundle carries the declared surface for the reported ids, so the
 *     offline floor matches the live path (generator twin table).
 *
 * Not covered: cursor and devin, which models.dev does not catalog at any key;
 * their effort surfaces need endpoint-level evidence, not a models.dev twin.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveProviderModels, type ModelsDevFallback } from "@veyyon/catalog/model-manager";
import { defaultModelsDevFallback, resetModelsDevOverlayState } from "@veyyon/catalog/modelsdev-overlay";
import { Effort } from "@veyyon/catalog/effort";
import MODELS from "@veyyon/catalog/models.json" with { type: "json" };
import type { Api, ModelSpec } from "@veyyon/catalog/types";

afterEach(() => {
	vi.restoreAllMocks();
	resetModelsDevOverlayState();
});

/** A models.dev api.json payload fragment with one effort-declaring row per source provider. */
function cannedPayload(): Record<string, unknown> {
	const row = (name: string, efforts: string[]) => ({
		name,
		reasoning: true,
		tool_call: true,
		reasoning_options: [{ type: "effort", values: efforts }],
		limit: { context: 500000, output: 128000 },
		cost: { input: 1, output: 2 },
		modalities: { input: ["text"], output: ["text"] },
	});
	return {
		xai: { models: { "grok-4.6": row("Grok 4.6", ["low", "medium", "high", "xhigh"]) } },
		openai: { models: { "gpt-5.3-codex": row("GPT 5.3 Codex", ["none", "low", "medium", "high", "xhigh"]) } },
		google: { models: { "gemini-3.1-flash-lite": row("Flash Lite", ["minimal", "low", "medium", "high"]) } },
	};
}

const TWIN_EXPECTATIONS: ReadonlyArray<{
	providerId: string;
	modelId: string;
	api: string;
	efforts: readonly Effort[];
}> = [
	{
		providerId: "xai-oauth",
		modelId: "grok-4.6",
		api: "openai-responses",
		efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
	},
	{
		providerId: "openai-codex",
		modelId: "gpt-5.3-codex",
		api: "openai-codex-responses",
		efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
	},
	{
		providerId: "google-antigravity",
		modelId: "gemini-3.1-flash-lite",
		api: "google-gemini-cli",
		efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High],
	},
	{
		providerId: "google-gemini-cli",
		modelId: "gemini-3.1-flash-lite",
		api: "google-gemini-cli",
		efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High],
	},
];

describe("OAuth twin overlays", () => {
	for (const twin of TWIN_EXPECTATIONS) {
		it(`maps the models.dev ${twin.providerId} twin row with its declared ladder`, () => {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-twin-overlay-"));
			try {
				const fallback = defaultModelsDevFallback(twin.providerId, path.join(dir, "models.db"));
				expect(fallback, `${twin.providerId} has no models.dev fallback`).toBeDefined();
				const rows = fallback!.map(cannedPayload(), twin.providerId as never);
				const row = rows.find(model => model.id === twin.modelId);
				expect(row, `${twin.providerId}/${twin.modelId} not mapped`).toBeDefined();
				expect(row!.provider).toBe(twin.providerId);
				expect(row!.api).toBe(twin.api);
				expect(row!.reasoningOptions).toEqual({ efforts: twin.efforts });
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});

		it(`marks the ${twin.providerId} fallback enrich-only`, () => {
			const fallback = defaultModelsDevFallback(twin.providerId as never, path.join(os.tmpdir(), "unused.db"));
			expect(fallback?.enrichOnly).toBe(true);
		});
	}

	it("a provider with its own models.dev catalog is not enrich-only", () => {
		const fallback = defaultModelsDevFallback("opencode-zen" as never, path.join(os.tmpdir(), "unused.db"));
		expect(fallback).toBeDefined();
		expect(fallback!.enrichOnly ?? false).toBe(false);
	});
});

describe("enrich-only merge semantics", () => {
	function spec(id: string, reasoningOptions?: ModelSpec<Api>["reasoningOptions"]): ModelSpec<Api> {
		return {
			id,
			name: id,
			api: "openai-responses",
			provider: "xai-oauth",
			baseUrl: "https://api.x.ai/v1",
			reasoning: true,
			...(reasoningOptions !== undefined ? { reasoningOptions } : {}),
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 500000,
			maxTokens: 128000,
		} as ModelSpec<Api>;
	}

	it("enriches served ids with declared surfaces but never introduces an id", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-twin-merge-"));
		try {
			const overlay = {
				enrichOnly: true,
				fetch: async () => ({}),
				map: () => [
					// The live row for grok-4.6 carries no surface; the overlay declares it.
					spec("grok-4.6", { efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh] }),
					// An id the endpoint does NOT serve under OAuth: must not leak in.
					spec("grok-unserved", { efforts: [Effort.Low] }),
				],
			} as unknown as ModelsDevFallback<Api>;
			const result = await resolveProviderModels(
				{
					providerId: "xai-oauth",
					staticModels: [spec("grok-4.3", { efforts: [Effort.Low, Effort.Medium, Effort.High] })],
					fetchDynamicModels: async () => [spec("grok-4.6")],
					modelsDev: overlay,
					cacheDbPath: path.join(dir, "models.db"),
				},
				"online",
			);
			const byId = new Map(result.models.map(model => [model.id, model]));
			expect(
				byId.get("grok-4.6")?.reasoningOptions,
				"live row keeps its id and gains the declared surface",
			).toEqual({ efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh] });
			expect(byId.get("grok-4.3")?.reasoningOptions).toEqual({ efforts: [Effort.Low, Effort.Medium, Effort.High] });
			expect(byId.has("grok-unserved"), "enrich-only overlay introduced an unserved id").toBe(false);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("bundled OAuth twin surfaces", () => {
	function bundledEfforts(provider: string, id: string): unknown {
		const row = (MODELS as Record<string, Record<string, { reasoningOptions?: unknown }>>)[provider]?.[id];
		return (row?.reasoningOptions as { efforts?: unknown } | undefined)?.efforts;
	}

	it.each([
		["xai-oauth", "grok-4.6", ["low", "medium", "high", "xhigh"]],
		["google-antigravity", "gemini-3.1-flash-lite", ["minimal", "low", "medium", "high"]],
		["google-gemini-cli", "gemini-3.1-pro-preview", ["low", "medium", "high"]],
		["openai-codex", "gpt-5.3-codex", ["low", "medium", "high", "xhigh"]],
	] as const)("%s/%s bakes the declared ladder", (provider, id, expected) => {
		expect(bundledEfforts(provider, id)).toEqual(expected);
	});

	// Deliberately unpinned, both filtered out of the models.dev mapping by
	// design: xai/grok-4.20-multi-agent-0309 declares [low..xhigh] but is marked
	// tool_call: false upstream, and opencode/gemini-3-pro declares [low, high]
	// but is marked status: deprecated. Their declarations never reach a row, so
	// both stay without a surface until upstream unmarks them.
});
