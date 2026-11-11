/**
 * WHY THIS SUITE EXISTS.
 *
 * Anthropic's `/v1/models` states each model's `max_input_tokens`, `max_tokens` and `capabilities`
 * (thinking, effort levels, image input). Discovery read only `id` and `display_name`, and took every
 * other field from the bundled catalog or models.dev. A model newer than both (Claude Mythos 5.2,
 * Opus 5.5, Sonnet 5.5, Haiku 5.5, Fable 5.1/5.2, Mythos 5.1) reached the picker with a null context
 * window, `reasoning: false`, no effort ladder and text-only input. A null window turns off the context
 * bar and overflow accounting and produced a compaction notice for a "0-token model".
 *
 * THE CLASS THIS CLOSES. Any discovered Anthropic id that no reference catalogs takes the limits and
 * capabilities its entry declares, whatever the id. The cases below use ids no catalog will ever hold,
 * so they cannot pass because a bundle regeneration happened to add the model.
 *
 * WHAT IT DOES NOT CATCH. Pricing: `/v1/models` states none, so an uncatalogued model still reports a
 * zero cost. A reference that is present keeps its own limits; a wrong bundled value is not corrected
 * by the endpoint.
 */
import { describe, expect, it } from "bun:test";
import { buildModel } from "@veyyon/catalog/build";
import { Effort, THINKING_EFFORTS } from "@veyyon/catalog/effort";
import {
	anthropicModelManagerOptions,
	readAnthropicDeclaredSurface,
} from "@veyyon/catalog/provider-models/openai-compat";
import type { FetchImpl, ModelSpec } from "@veyyon/catalog/types";

const MODELS_DEV_URL = "https://models.dev/api.json";
const NOVEL_ID = "claude-novel-9-9";
const BUNDLED_ID = "claude-3-5-sonnet-20241022";

const supported = { supported: true } as const;
const unsupported = { supported: false } as const;

/** The shape `/v1/models` returns for a current model, as recorded from the live endpoint. */
function currentEntry(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		type: "model",
		id,
		display_name: "Claude Novel 9.9",
		max_input_tokens: 1_000_000,
		max_tokens: 128_000,
		capabilities: {
			effort: { ...supported, low: supported, medium: supported, high: supported, xhigh: supported, max: supported },
			image_input: supported,
			thinking: {
				...supported,
				types: { enabled: unsupported, adaptive: supported, disabled: unsupported },
			},
		},
		...overrides,
	};
}

/** Discovery against a `/v1/models` body, with models.dev unreachable so no enrichment source exists. */
async function discover(...entries: Record<string, unknown>[]): Promise<readonly ModelSpec<"anthropic-messages">[]> {
	const fetch: FetchImpl = async input => {
		if (String(input).startsWith(MODELS_DEV_URL)) return new Response("down", { status: 503 });
		return new Response(JSON.stringify({ data: entries, has_more: false }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	};
	const options = anthropicModelManagerOptions({ apiKey: "sk-test", fetch });
	if (!options.fetchDynamicModels) throw new Error("anthropic dynamic discovery is not configured");
	return (await options.fetchDynamicModels()) ?? [];
}

describe("a discovered Anthropic model takes the limits its endpoint declares", () => {
	it("gives an uncatalogued model the declared window, output cap, image input and effort ladder", async () => {
		const [spec] = await discover(currentEntry(NOVEL_ID));
		expect(spec).toMatchObject({
			id: NOVEL_ID,
			name: "Claude Novel 9.9",
			contextWindow: 1_000_000,
			maxTokens: 128_000,
			input: ["text", "image"],
			reasoning: true,
			reasoningOptions: { efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max] },
		});

		// The built row is what the picker, the context bar and compaction read.
		const model = buildModel(spec as ModelSpec<"anthropic-messages">);
		expect(model.contextWindow).toBe(1_000_000);
		expect(model.thinking?.efforts).toEqual([Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max]);
	});

	it("keeps the bundled reference's limits over the declared ones", async () => {
		const [spec] = await discover(currentEntry(BUNDLED_ID, { max_input_tokens: 999, max_tokens: 99 }));
		expect(spec?.contextWindow).toBe(200_000);
		expect(spec?.maxTokens).toBe(8_192);
	});

	// Derived from the effort contract, so a level added to THINKING_EFFORTS is covered without an edit here.
	it.each([...THINKING_EFFORTS])("reads a ladder that declares only %s", level => {
		const surface = readAnthropicDeclaredSurface(
			currentEntry(NOVEL_ID, {
				capabilities: { thinking: supported, effort: { ...supported, [level]: supported } },
			}),
		);
		expect(surface.reasoningOptions).toEqual({ efforts: [level] });
	});

	it("orders the ladder canonically and drops levels marked unsupported", () => {
		const surface = readAnthropicDeclaredSurface(
			currentEntry(NOVEL_ID, {
				capabilities: {
					thinking: supported,
					effort: { max: supported, ...supported, xhigh: unsupported, low: supported, high: supported },
				},
			}),
		);
		expect(surface.reasoningOptions).toEqual({ efforts: [Effort.Low, Effort.High, Effort.Max] });
	});

	it.each([
		["thinking unsupported", { thinking: unsupported, effort: { ...supported, high: supported } }],
		["effort unsupported", { thinking: supported, effort: { ...unsupported, high: supported } }],
		["no level supported", { thinking: supported, effort: { ...supported, high: unsupported } }],
	])("declares no ladder when %s", (_case, capabilities) => {
		const surface = readAnthropicDeclaredSurface(currentEntry(NOVEL_ID, { capabilities }));
		expect(surface.reasoningOptions).toBeUndefined();
		expect(surface.reasoning).toBe(capabilities.thinking.supported);
	});

	it("reads text-only input when image input is unsupported", () => {
		const surface = readAnthropicDeclaredSurface(
			currentEntry(NOVEL_ID, { capabilities: { image_input: unsupported } }),
		);
		expect(surface.input).toEqual(["text"]);
	});

	// Hostile or partial bodies: an unreadable field is left out, never coerced into a limit.
	it.each([
		["string limits", { max_input_tokens: "1000000", max_tokens: "128000" }],
		["non-positive limits", { max_input_tokens: 0, max_tokens: -1 }],
		["non-finite limits", { max_input_tokens: Number.NaN, max_tokens: null }],
		["capabilities not an object", { capabilities: "all" }],
		[
			"capability flags not booleans",
			{ capabilities: { thinking: { supported: "yes" }, image_input: { supported: 1 } } },
		],
	])("ignores %s", async (_case, overrides) => {
		expect(readAnthropicDeclaredSurface({ id: NOVEL_ID, ...overrides })).toEqual({});

		const [spec] = await discover({ id: NOVEL_ID, display_name: "Claude Novel 9.9", ...overrides });
		expect(spec?.contextWindow).toBeNull();
		expect(spec?.maxTokens).toBeNull();
		expect(spec?.reasoning).toBe(false);
	});
});
