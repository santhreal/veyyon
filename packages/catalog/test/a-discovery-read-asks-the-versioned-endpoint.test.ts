/**
 * A catalog read asks the versioned endpoint, whatever base the operator configured.
 *
 * WHY THIS SUITE EXISTS. Anthropic's REST API lives under `/v1`, and the SDK
 * takes the host WITHOUT it: it appends `/v1/messages` itself. Both spellings of
 * the base are therefore legitimate configuration, and one of them was silently
 * fatal to discovery — `anthropicModelManagerOptions` handed the configured base
 * straight to `fetchOpenAICompatibleModels`, which appends `/models`, so a
 * provider pointed at `https://api.anthropic.com` streamed normally and asked
 * `https://api.anthropic.com/models` for its catalog. The endpoint answered 404
 * fifty-five times in the recorded logs. Nothing broke loudly: the manager fell
 * back to the bundled catalog, so the only symptom was a model list that never
 * learned anything new, and a warn line naming a URL that looked right.
 *
 * THE CLASS IT CLOSES. "A discovery read borrows the SDK's base URL and loses
 * the version segment the REST endpoint requires." The sibling readers already
 * split the two (`vercelAiGatewayModelManagerOptions` keeps `catalogBaseUrl`
 * beside `baseUrl`, and `toAnthropicDiscoveryBaseUrl` exists for exactly this);
 * the first-party Anthropic reader was the one that skipped it.
 *
 * WHAT IT DOES NOT CATCH. It asserts the URL a reader requests, not what a live
 * endpoint answers, and it covers the readers whose base is operator-configurable
 * through a `ModelManagerConfig`. A reader that hardcodes its own host cannot
 * carry this defect, and a provider whose catalog route is not `/models` at all
 * is a different contract with its own suite.
 */

import { describe, expect, it } from "bun:test";
import type { ModelManagerOptions } from "../src/model-manager";
import { anthropicModelManagerOptions, vercelAiGatewayModelManagerOptions } from "../src/provider-models/openai-compat";
import type { FetchImpl } from "../src/types";

/** A fetch that records the URL and answers an empty catalog. */
function recordingFetch(seen: string[]): FetchImpl {
	return (async (input: string | URL | Request) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		seen.push(url);
		return new Response(JSON.stringify({ data: [] }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	}) as FetchImpl;
}

/**
 * The readers whose discovery base comes from operator configuration, each built
 * for one configured base. `expected` is the catalog URL that base must produce.
 */
const READERS: Array<{
	provider: string;
	build: (baseUrl: string, fetch: FetchImpl) => ModelManagerOptions<"anthropic-messages">;
	bases: Array<{ configured: string; expected: string }>;
}> = [
	{
		provider: "anthropic",
		build: (baseUrl, fetch) => anthropicModelManagerOptions({ apiKey: "sk-test", baseUrl, fetch }),
		bases: [
			{ configured: "https://api.anthropic.com", expected: "https://api.anthropic.com/v1/models" },
			{ configured: "https://api.anthropic.com/v1", expected: "https://api.anthropic.com/v1/models" },
		],
	},
	{
		provider: "vercel-ai-gateway",
		build: (baseUrl, fetch) => vercelAiGatewayModelManagerOptions({ apiKey: "vk-test", baseUrl, fetch }),
		bases: [
			{ configured: "https://ai-gateway.vercel.sh", expected: "https://ai-gateway.vercel.sh/v1/models" },
			{
				configured: "https://ai-gateway.vercel.sh/v1",
				expected: "https://ai-gateway.vercel.sh/v1/models",
			},
		],
	},
];

describe("a discovery read asks the versioned endpoint", () => {
	for (const reader of READERS) {
		for (const base of reader.bases) {
			it(`${reader.provider} reads ${base.expected} when configured with ${base.configured}`, async () => {
				const seen: string[] = [];
				const options = reader.build(base.configured, recordingFetch(seen));
				const fetchDynamicModels = options.fetchDynamicModels;
				expect(typeof fetchDynamicModels).toBe("function");
				await fetchDynamicModels?.();
				// models.dev enrichment shares the fetch, so filter to the catalog
				// route the endpoint owns rather than pinning call order.
				const catalogReads = seen.filter(url => url.includes("/models") && !url.includes("models.dev"));
				expect(catalogReads.length).toBeGreaterThan(0);
				for (const url of catalogReads) {
					expect(url).toBe(base.expected);
				}
			});
		}
	}

	it("never asks an unversioned catalog route", async () => {
		// The defect's shape, stated once for every reader above: a `/models`
		// read whose path is not under `/v1` is the 404 that produced nothing.
		const seen: string[] = [];
		for (const reader of READERS) {
			for (const base of reader.bases) {
				const options = reader.build(base.configured, recordingFetch(seen));
				await options.fetchDynamicModels?.();
			}
		}
		const unversioned = seen.filter(url => {
			if (!url.includes("/models") || url.includes("models.dev")) return false;
			return !new URL(url).pathname.startsWith("/v1/");
		});
		expect(unversioned).toEqual([]);
	});
});
