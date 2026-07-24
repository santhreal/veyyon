/**
 * Locks the recall-preserving-fallback contract of `anthropicModelManagerOptions`
 * runtime discovery (`src/provider-models/openai-compat.ts`).
 *
 * Anthropic's live `fetchDynamicModels` enriches the models it discovers from the
 * first-party `/v1/models` endpoint with metadata from TWO sources, layered:
 *   1. models.dev (`https://models.dev/api.json`) — a best-effort ENRICHMENT feed
 *      that only fills gaps for ids newer than the shipped bundle, and
 *   2. the shipped bundled catalog (`getBundledModels("anthropic")`) — the
 *      CANONICAL floor, which `buildAnthropicReferenceMap` always merges on top.
 *
 * The models.dev fetch is wrapped in `.catch(() => [])`. That swallow is safe
 * ONLY because of the layering above, and these tests exist to prove it stays
 * safe: a models.dev outage must NEVER strip bundled enrichment off a known model
 * and must NEVER drop a discovered model. If a future refactor makes models.dev
 * the recall path (e.g. stops merging the bundle), these tests fail — which is the
 * point. They are the regression guard for the Law-10 assessment that this
 * silent-looking `.catch` is a defensible best-effort degrade, not a recall bug.
 *
 * The two fetches (models.dev + `/v1/models`) share the injected `config.fetch`,
 * so each test routes by URL: models.dev is forced to fail, `/v1/models` returns a
 * controlled catalog, and we assert on the enriched result.
 */
import { describe, expect, it } from "bun:test";
import { anthropicModelManagerOptions } from "@veyyon/catalog/provider-models/openai-compat";
import type { FetchImpl } from "@veyyon/catalog/types";

const MODELS_DEV_URL = "https://models.dev/api.json";
const ANTHROPIC_MODELS_URL = "https://api.anthropic.com/v1/models";

/** A model that IS in the shipped bundle, with its canonical bundled metadata. */
const BUNDLED_ID = "claude-3-5-sonnet-20241022";
const BUNDLED_CONTEXT_WINDOW = 200_000;
const BUNDLED_MAX_TOKENS = 8_192;
const BUNDLED_COST = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } as const;

/**
 * A fetch impl that fails the models.dev request with `status` and answers the
 * anthropic `/v1/models` request with `discoveryBody`. Records every URL hit.
 */
function routedFetch(discoveryBody: unknown, opts?: { modelsDevStatus?: number; modelsDevThrows?: boolean }): {
	fetch: FetchImpl;
	urls: string[];
} {
	const urls: string[] = [];
	const fetch: FetchImpl = async input => {
		const url = String(input);
		urls.push(url);
		if (url.startsWith(MODELS_DEV_URL)) {
			if (opts?.modelsDevThrows) throw new Error("network down");
			return new Response("upstream unavailable", { status: opts?.modelsDevStatus ?? 503 });
		}
		return new Response(JSON.stringify(discoveryBody), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	};
	return { fetch, urls };
}

function discoveryPayload(...entries: Array<{ id: string; display_name?: string }>): unknown {
	return { data: entries };
}

async function discover(fetchImpl: FetchImpl) {
	const options = anthropicModelManagerOptions({ apiKey: "sk-test", fetch: fetchImpl });
	if (!options.fetchDynamicModels) throw new Error("anthropic dynamic discovery is not configured");
	return options.fetchDynamicModels();
}

describe("anthropic dynamic discovery — models.dev failure fallback", () => {
	it("keeps full bundled enrichment on a known model when models.dev is unreachable (HTTP error)", async () => {
		const { fetch, urls } = routedFetch(discoveryPayload({ id: BUNDLED_ID, display_name: "Claude 3.5 Sonnet" }), {
			modelsDevStatus: 500,
		});

		const models = await discover(fetch);

		// models.dev was actually attempted (and failed), then discovery still ran.
		expect(urls.some(u => u.startsWith(MODELS_DEV_URL))).toBe(true);
		expect(urls.some(u => u.startsWith(ANTHROPIC_MODELS_URL))).toBe(true);

		const model = models?.find(m => m.id === BUNDLED_ID);
		expect(model).toBeDefined();
		// The discovered display name wins for `name`, but every enrichment field
		// (context window, output cap, per-token cost, modalities) comes from the
		// bundle — proving the empty models.dev result did NOT degrade the spec.
		expect(model).toMatchObject({
			id: BUNDLED_ID,
			name: "Claude 3.5 Sonnet",
			api: "anthropic-messages",
			provider: "anthropic",
			contextWindow: BUNDLED_CONTEXT_WINDOW,
			maxTokens: BUNDLED_MAX_TOKENS,
			cost: BUNDLED_COST,
			input: ["text", "image"],
		});
	});

	it("keeps bundled enrichment when the models.dev fetch throws (network error, not just !ok)", async () => {
		const { fetch } = routedFetch(discoveryPayload({ id: BUNDLED_ID, display_name: "Claude 3.5 Sonnet" }), {
			modelsDevThrows: true,
		});

		const model = (await discover(fetch))?.find(m => m.id === BUNDLED_ID);

		expect(model).toMatchObject({
			id: BUNDLED_ID,
			contextWindow: BUNDLED_CONTEXT_WINDOW,
			maxTokens: BUNDLED_MAX_TOKENS,
			cost: BUNDLED_COST,
		});
	});

	it("produces the same bundled spec whether models.dev is down or returns an empty catalog", async () => {
		// The canonical guarantee, stated as a differential: for a bundled model,
		// a models.dev outage and a reachable-but-empty models.dev must yield an
		// identical enriched spec. The bundle is the floor; models.dev only adds.
		const down = routedFetch(discoveryPayload({ id: BUNDLED_ID, display_name: "Claude 3.5 Sonnet" }), {
			modelsDevStatus: 503,
		});
		const emptyModelsDev: FetchImpl = async input => {
			const url = String(input);
			if (url.startsWith(MODELS_DEV_URL)) {
				return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
			}
			return new Response(JSON.stringify(discoveryPayload({ id: BUNDLED_ID, display_name: "Claude 3.5 Sonnet" })), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		const fromDown = (await discover(down.fetch))?.find(m => m.id === BUNDLED_ID);
		const fromEmpty = (await discover(emptyModelsDev))?.find(m => m.id === BUNDLED_ID);

		expect(fromDown).toBeDefined();
		expect(fromDown).toEqual(fromEmpty);
	});

	it("still discovers a model absent from both bundle and models.dev when models.dev is down (recall preserved)", async () => {
		// A brand-new id the bundle has never heard of. With models.dev down there
		// is no enrichment source at all, yet the model must STILL be returned from
		// the live `/v1/models` list — unenriched, never dropped. This is the exact
		// recall the `.catch(() => [])` must not cost.
		const novelId = "claude-future-preview-20991231";
		const { fetch } = routedFetch(discoveryPayload({ id: novelId, display_name: "Claude Future Preview" }), {
			modelsDevStatus: 500,
		});

		const models = await discover(fetch);
		const model = models?.find(m => m.id === novelId);

		expect(model).toBeDefined();
		expect(model).toMatchObject({
			id: novelId,
			name: "Claude Future Preview",
			api: "anthropic-messages",
			provider: "anthropic",
			// No enrichment source → the discovery defaults stand (null limits),
			// but the model is present, which is the whole point.
			contextWindow: null,
			maxTokens: null,
		});
	});
});
