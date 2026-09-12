/**
 * WHY:
 * During search provider consolidation, shared `resolveClampedNumResults` / `resolveRequestedNumResults`
 * helpers were introduced across providers. This collapsed provider-specific input contracts:
 * 1. Low-level provider functions accepting provider-specific parameters (`num_results`) must NOT
 *    accept or resolve invented aliases (`limit`, `numSearchResults`) passed as extra fields.
 * 2. `SearchParams`-consuming functions (`searchDuckDuckGo`, `searchGoogle`, `searchMojeek`, `searchFirecrawl`,
 *    `searchPublicWeb`, `searchStartpage`, `searchSynthetic`, `searchTavily`, `searchTinyFish`, `searchXAI`,
 *    and class adapter `search()` methods) have contract `params.numSearchResults ?? params.limit`,
 *    and must NOT let an unvalidated `num_results` override canonical limit fields.
 * 3. Class adapters must correctly project `SearchParams` (`numSearchResults ?? limit`) onto the low-level
 *    provider contracts (JinaProvider, SearXNGProvider, ZaiProvider mapping to `num_results`, others passing through)
 *    and slice returned sources to the requested limit.
 * 4. Negative, zero, or fractional limit inputs must yield expected whole counts or unconstrained lists
 *    rather than back-slicing arrays from the end.
 *
 * WHAT THIS CLOSES:
 * - Registry-driven verification across all 22 members of `SEARCH_PROVIDER_ORDER`.
 * - Explicit fail-on-new-member coverage verifying every provider is accounted for in either the drivable
 *   fixture table (18 providers) or the model-grounded `NOT_DRIVABLE` set (4 providers).
 * - Enforces that extra aliases remain completely unread when limit is unset (verifying alias-fallback mutation fails).
 * - Verifies exact default, max clamp, adapter projection, and fractional/negative limit behavior per provider.
 *
 * WHAT THIS DOES NOT CATCH:
 * - Upstream engine-side ranking differences, remote markup changes, or external service rate limits.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { AuthStorage, type FetchImpl } from "@veyyon/ai";
import { SqliteAuthCredentialStore } from "@veyyon/ai/auth-storage-sqlite";
import { settings } from "../../../../src/config/settings-instance";
import type { SearchParams, SearchProvider } from "../../../../src/tools/web/search/providers/base";
import { BraveProvider, searchBrave } from "../../../../src/tools/web/search/providers/brave";
import { DuckDuckGoProvider, searchDuckDuckGo } from "../../../../src/tools/web/search/providers/duckduckgo";
import { ExaProvider, resetExaSearchThrottleForTest, searchExa } from "../../../../src/tools/web/search/providers/exa";
import {
	buildRequestBody as buildFirecrawlRequestBody,
	FirecrawlProvider,
	searchFirecrawl,
} from "../../../../src/tools/web/search/providers/firecrawl";
import { GoogleProvider, searchGoogle } from "../../../../src/tools/web/search/providers/google";
import { JinaProvider, searchJina } from "../../../../src/tools/web/search/providers/jina";
import { KagiProvider, searchKagi } from "../../../../src/tools/web/search/providers/kagi";
import { KimiProvider, searchKimi } from "../../../../src/tools/web/search/providers/kimi";
import { MojeekProvider, searchMojeek } from "../../../../src/tools/web/search/providers/mojeek";
import { ParallelProvider, searchParallel } from "../../../../src/tools/web/search/providers/parallel";
import { PublicWebProvider, searchPublicWeb } from "../../../../src/tools/web/search/providers/public";
import { SearXNGProvider, searchSearXNG } from "../../../../src/tools/web/search/providers/searxng";
import { StartpageProvider, searchStartpage } from "../../../../src/tools/web/search/providers/startpage";
import { SyntheticProvider, searchSynthetic } from "../../../../src/tools/web/search/providers/synthetic";
import {
	buildRequestBody as buildTavilyRequestBody,
	searchTavily,
	TavilyProvider,
} from "../../../../src/tools/web/search/providers/tavily";
import {
	buildTinyFishUrl,
	searchTinyFish,
	TinyFishProvider,
} from "../../../../src/tools/web/search/providers/tinyfish";
import { searchXAI, XAIProvider } from "../../../../src/tools/web/search/providers/xai";
import { searchZai, ZaiProvider } from "../../../../src/tools/web/search/providers/zai";
import {
	SEARCH_PROVIDER_ORDER,
	type SearchProviderId,
	type SearchResponse,
} from "../../../../src/tools/web/search/types";

let authStorage: AuthStorage;
let originalSearxngEndpoint: string | undefined;

beforeEach(async () => {
	authStorage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
	for (const provider of [
		"kagi",
		"brave",
		"exa",
		"firecrawl",
		"moonshot",
		"kimi-code",
		"parallel",
		"jina",
		"synthetic",
		"tavily",
		"tinyfish",
		"xai",
		"zai",
	]) {
		await authStorage.set(provider, { type: "api_key", key: `test-${provider}-key` });
	}
	originalSearxngEndpoint = process.env.SEARXNG_ENDPOINT;
	process.env.SEARXNG_ENDPOINT = "https://searx.example.org";
	try {
		settings.set("exa.searchDelayMs", 0);
	} catch {
		// Ignore if settings store is uninitialized
	}
	resetExaSearchThrottleForTest();
});

afterEach(() => {
	authStorage.close();
	if (originalSearxngEndpoint === undefined) {
		delete process.env.SEARXNG_ENDPOINT;
	} else {
		process.env.SEARXNG_ENDPOINT = originalSearxngEndpoint;
	}
});

function makeSearchParams(
	overrides: Partial<SearchParams & { fetch?: FetchImpl; num_results?: number }> = {},
): SearchParams & { fetch?: FetchImpl; num_results?: number } {
	return {
		query: "test query",
		systemPrompt: "system prompt",
		authStorage,
		sessionId: "test-session",
		...overrides,
	};
}

function withThrowingIgnoredAliases<T extends object>(target: T, ignoredKeys: string[], context: string): T {
	for (const key of ignoredKeys) {
		Object.defineProperty(target, key, {
			get() {
				throw new Error(`Unexpected property access to ignored alias '${key}' on ${context}`);
			},
			enumerable: false,
			configurable: true,
		});
	}
	return target;
}

/** Providers not drivable by a static fetch mock (model-grounded / OAuth brokers). */
const NOT_DRIVABLE: Record<string, string> = {
	anthropic: "Model-grounded Claude native search tool via Anthropic client and user metadata",
	codex: "Model-grounded OpenAI search via ChatGPT OAuth broker and client completions",
	gemini: "Model-grounded search grounding via Google Gemini client and OAuth",
	perplexity: "Model-grounded LLM provider routed through perplexity ask/chat or OpenRouter fallback",
};

interface DrivableProviderSpec {
	id: SearchProviderId;
	limitField: "num_results" | "searchParams";
	defaultLimit?: number;
	maxLimit?: number;
	clampCoveredElsewhere?: boolean;
	executeDirect: (params: Record<string, unknown>, fetchImpl: FetchImpl) => Promise<SearchResponse>;
	adapter: new () => SearchProvider;
	createFetch: () => FetchImpl;
	testInternalRequestLimits?: () => void;
}

const DDG_HTML_30 = `<html><body>${Array.from(
	{ length: 30 },
	(_, i) => `<div class="result results_links results_links_deep web-result">
		<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2F${i + 1}">Title ${i + 1}</a>
		<a class="result__snippet">Snippet ${i + 1}</a>
	</div>`,
).join("")}</body></html>`;

const GOOGLE_HTML_30 = `<html><body>${Array.from(
	{ length: 30 },
	(_, i) => `<div class="g">
		<a href="https://example.com/${i + 1}"><h3>Title ${i + 1}</h3></a>
		<div class="VwiC3b">Snippet ${i + 1}</div>
	</div>`,
).join("")}</body></html>`;

const MOJEEK_HTML_30 = `<html><body><ul class="results-standard">${Array.from(
	{ length: 30 },
	(_, i) => `<li>
		<a class="title" href="https://example.com/${i + 1}">Title ${i + 1}</a>
		<p class="s">Snippet ${i + 1}</p>
	</li>`,
).join("")}</ul></body></html>`;

const STARTPAGE_FORM_HTML = `<html><body>
	<form action="/sp/search">
		<input type="hidden" name="sc" value="test-sc-token" />
		<input type="text" name="query" />
	</form>
</body></html>`;

const STARTPAGE_RESULTS_HTML_30 = `<html><body>${Array.from(
	{ length: 30 },
	(_, i) => `<div class="result">
		<a class="result-link" href="https://example.com/${i + 1}"><h2>Title ${i + 1}</h2></a>
		<p class="description">Description ${i + 1}</p>
	</div>`,
).join("")}</body></html>`;

const PROVIDER_SPECS: Record<string, DrivableProviderSpec> = {
	kagi: {
		id: "kagi",
		limitField: "num_results",
		defaultLimit: 10,
		maxLimit: 40,
		executeDirect: (params, fetchImpl) =>
			searchKagi({
				query: "test",
				authStorage,
				fetch: fetchImpl,
				...params,
			}),
		adapter: KagiProvider,
		createFetch: () => async () =>
			new Response(
				JSON.stringify({
					data: {
						search: Array.from({ length: 50 }, (_, i) => ({
							t: 0,
							url: `https://example.com/${i + 1}`,
							title: `Title ${i + 1}`,
							snippet: `Snippet ${i + 1}`,
						})),
					},
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
	},
	brave: {
		id: "brave",
		limitField: "num_results",
		defaultLimit: 10,
		maxLimit: 20,
		executeDirect: (params, fetchImpl) =>
			searchBrave({
				query: "test",
				authStorage,
				fetch: fetchImpl,
				...params,
			}),
		adapter: BraveProvider,
		createFetch: () => async () =>
			new Response(
				JSON.stringify({
					web: {
						results: Array.from({ length: 30 }, (_, i) => ({
							url: `https://example.com/${i + 1}`,
							title: `Title ${i + 1}`,
							description: `Description ${i + 1}`,
						})),
					},
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
	},
	duckduckgo: {
		id: "duckduckgo",
		limitField: "searchParams",
		defaultLimit: 10,
		maxLimit: 20,
		executeDirect: (params, fetchImpl) =>
			searchDuckDuckGo(
				makeSearchParams({
					fetch: fetchImpl,
					...params,
				}),
			),
		adapter: DuckDuckGoProvider,
		createFetch: () => async () =>
			new Response(DDG_HTML_30, {
				status: 200,
				headers: { "content-type": "text/html" },
			}),
	},
	exa: {
		id: "exa",
		limitField: "num_results",
		defaultLimit: 10,
		maxLimit: 100,
		executeDirect: (params, fetchImpl) =>
			searchExa({
				query: "test",
				authStorage,
				fetch: fetchImpl,
				...params,
			}),
		adapter: ExaProvider,
		createFetch: () => async () =>
			new Response(
				JSON.stringify({
					results: Array.from({ length: 120 }, (_, i) => ({
						url: `https://example.com/${i + 1}`,
						title: `Title ${i + 1}`,
						text: `Text ${i + 1}`,
					})),
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
	},
	firecrawl: {
		id: "firecrawl",
		limitField: "searchParams",
		defaultLimit: 10,
		maxLimit: 100,
		executeDirect: (params, fetchImpl) =>
			searchFirecrawl(
				makeSearchParams({
					fetch: fetchImpl,
					...params,
				}),
			),
		adapter: FirecrawlProvider,
		createFetch: () => async () =>
			new Response(
				JSON.stringify({
					success: true,
					data: {
						web: Array.from({ length: 120 }, (_, i) => ({
							url: `https://example.com/${i + 1}`,
							title: `Title ${i + 1}`,
							markdown: `Markdown ${i + 1}`,
						})),
					},
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
		testInternalRequestLimits: () => {
			const bodyWithLimit = buildFirecrawlRequestBody(
				withThrowingIgnoredAliases({ query: "test", num_results: 5 }, ["limit", "numSearchResults"], "firecrawl"),
			);
			expect(bodyWithLimit.limit).toBe(5);

			const bodyDefault = buildFirecrawlRequestBody(
				withThrowingIgnoredAliases(
					{ query: "test", num_results: undefined },
					["limit", "numSearchResults"],
					"firecrawl",
				),
			);
			expect(bodyDefault.limit).toBe(10);

			const aliasOnlyBody = buildFirecrawlRequestBody({ query: "test", limit: 3, numSearchResults: 5 } as any);
			expect(aliasOnlyBody.limit).toBe(10);
		},
	},
	google: {
		id: "google",
		limitField: "searchParams",
		defaultLimit: 10,
		maxLimit: 20,
		executeDirect: (params, fetchImpl) =>
			searchGoogle(
				makeSearchParams({
					fetch: fetchImpl,
					...params,
				}),
			),
		adapter: GoogleProvider,
		createFetch: () => async () =>
			new Response(GOOGLE_HTML_30, {
				status: 200,
				headers: { "content-type": "text/html" },
			}),
	},
	jina: {
		id: "jina",
		limitField: "num_results",
		defaultLimit: undefined,
		maxLimit: undefined,
		executeDirect: (params, fetchImpl) =>
			searchJina({
				query: "test",
				authStorage,
				fetch: fetchImpl,
				...params,
			}),
		adapter: JinaProvider,
		createFetch: () => async () =>
			new Response(
				JSON.stringify({
					data: Array.from({ length: 30 }, (_, i) => ({
						url: `https://example.com/${i + 1}`,
						title: `Title ${i + 1}`,
						content: `Content ${i + 1}`,
					})),
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
	},
	kimi: {
		id: "kimi",
		limitField: "num_results",
		defaultLimit: 10,
		maxLimit: 20,
		executeDirect: (params, fetchImpl) =>
			searchKimi({
				query: "test",
				authStorage,
				fetch: fetchImpl,
				...params,
			}),
		adapter: KimiProvider,
		createFetch: () => async () =>
			new Response(
				JSON.stringify({
					search_results: Array.from({ length: 30 }, (_, i) => ({
						url: `https://example.com/${i + 1}`,
						title: `Title ${i + 1}`,
						snippet: `Snippet ${i + 1}`,
					})),
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
	},
	mojeek: {
		id: "mojeek",
		limitField: "searchParams",
		defaultLimit: 10,
		maxLimit: 20,
		executeDirect: (params, fetchImpl) =>
			searchMojeek(
				makeSearchParams({
					fetch: fetchImpl,
					...params,
				}),
			),
		adapter: MojeekProvider,
		createFetch: () => async () =>
			new Response(MOJEEK_HTML_30, {
				status: 200,
				headers: { "content-type": "text/html" },
			}),
	},
	parallel: {
		id: "parallel",
		limitField: "num_results",
		defaultLimit: 10,
		maxLimit: 40,
		executeDirect: (params, fetchImpl) =>
			searchParallel(
				{
					query: "test",
					fetch: fetchImpl,
					...params,
				},
				authStorage,
				"test-session",
			),
		adapter: ParallelProvider,
		createFetch: () => async () =>
			new Response(
				JSON.stringify({
					results: Array.from({ length: 50 }, (_, i) => ({
						url: `https://example.com/${i + 1}`,
						title: `Title ${i + 1}`,
						excerpts: [`Excerpt ${i + 1}`],
					})),
					request_id: "parallel-req-1",
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
	},
	public: {
		id: "public",
		limitField: "searchParams",
		defaultLimit: 15,
		maxLimit: 30,
		executeDirect: (params, fetchImpl) =>
			searchPublicWeb(
				makeSearchParams({
					fetch: fetchImpl,
					...params,
				}),
			),
		adapter: PublicWebProvider,
		createFetch: () => async (url: string | URL | Request) => {
			const urlStr = url.toString();
			if (urlStr.includes("startpage.com") && !urlStr.includes("/sp/search")) {
				return new Response(STARTPAGE_FORM_HTML, { status: 200, headers: { "content-type": "text/html" } });
			}
			if (urlStr.includes("startpage.com")) {
				return new Response(
					`<html><body>${Array.from(
						{ length: 30 },
						(_, i) =>
							`<div class="result"><a class="result-link" href="https://example.com/sp/${i + 1}"><h2>SP ${i + 1}</h2></a><p class="description">SP Desc ${i + 1}</p></div>`,
					).join("")}</body></html>`,
					{ status: 200, headers: { "content-type": "text/html" } },
				);
			}
			if (urlStr.includes("google.com")) {
				return new Response(
					`<html><body>${Array.from(
						{ length: 30 },
						(_, i) =>
							`<div class="g"><a href="https://example.com/g/${i + 1}"><h3>G ${i + 1}</h3></a><div class="VwiC3b">G ${i + 1}</div></div>`,
					).join("")}</body></html>`,
					{ status: 200, headers: { "content-type": "text/html" } },
				);
			}
			if (urlStr.includes("mojeek")) {
				return new Response(
					`<html><body><ul class="results-standard">${Array.from(
						{ length: 30 },
						(_, i) =>
							`<li><a class="title" href="https://example.com/m/${i + 1}">M ${i + 1}</a><p class="s">M ${i + 1}</p></li>`,
					).join("")}</ul></body></html>`,
					{ status: 200, headers: { "content-type": "text/html" } },
				);
			}
			// DuckDuckGo fallback
			return new Response(
				`<html><body>${Array.from(
					{ length: 30 },
					(_, i) => `<div class="result results_links results_links_deep web-result">
						<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fddg%2F${i + 1}">DDG ${i + 1}</a>
						<a class="result__snippet">DDG ${i + 1}</a>
					</div>`,
				).join("")}</body></html>`,
				{ status: 200, headers: { "content-type": "text/html" } },
			);
		},
	},
	searxng: {
		id: "searxng",
		limitField: "num_results",
		defaultLimit: 10,
		maxLimit: 20,
		executeDirect: (params, fetchImpl) =>
			searchSearXNG({
				query: "test",
				fetch: fetchImpl,
				...params,
			}),
		adapter: SearXNGProvider,
		createFetch: () => async () =>
			new Response(
				JSON.stringify({
					results: Array.from({ length: 30 }, (_, i) => ({
						url: `https://example.com/${i + 1}`,
						title: `Title ${i + 1}`,
						content: `Content ${i + 1}`,
					})),
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
	},
	startpage: {
		id: "startpage",
		limitField: "searchParams",
		defaultLimit: 10,
		maxLimit: 20,
		executeDirect: (params, fetchImpl) =>
			searchStartpage(
				makeSearchParams({
					fetch: fetchImpl,
					...params,
				}),
			),
		adapter: StartpageProvider,
		createFetch: () => async (url: string | URL | Request) => {
			const urlStr = url.toString();
			if (urlStr.includes("startpage.com") && !urlStr.includes("/sp/search")) {
				return new Response(STARTPAGE_FORM_HTML, { status: 200, headers: { "content-type": "text/html" } });
			}
			return new Response(STARTPAGE_RESULTS_HTML_30, {
				status: 200,
				headers: { "content-type": "text/html" },
			});
		},
	},
	synthetic: {
		id: "synthetic",
		limitField: "searchParams",
		defaultLimit: undefined,
		maxLimit: undefined,
		executeDirect: (params, fetchImpl) =>
			searchSynthetic(
				makeSearchParams({
					fetch: fetchImpl,
					...params,
				}),
			),
		adapter: SyntheticProvider,
		createFetch: () => async () =>
			new Response(
				JSON.stringify({
					results: Array.from({ length: 30 }, (_, i) => ({
						url: `https://example.com/${i + 1}`,
						title: `Title ${i + 1}`,
						text: `Text ${i + 1}`,
					})),
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
	},
	tavily: {
		id: "tavily",
		limitField: "searchParams",
		defaultLimit: 5,
		maxLimit: 20,
		executeDirect: (params, fetchImpl) =>
			searchTavily(
				makeSearchParams({
					fetch: fetchImpl,
					...params,
				}),
			),
		adapter: TavilyProvider,
		createFetch: () => async () =>
			new Response(
				JSON.stringify({
					results: Array.from({ length: 30 }, (_, i) => ({
						url: `https://example.com/${i + 1}`,
						title: `Title ${i + 1}`,
						content: `Content ${i + 1}`,
					})),
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
		testInternalRequestLimits: () => {
			const bodyWithLimit = buildTavilyRequestBody(
				withThrowingIgnoredAliases({ query: "test", num_results: 3 }, ["limit", "numSearchResults"], "tavily"),
			);
			expect(bodyWithLimit.max_results).toBe(3);

			const bodyDefault = buildTavilyRequestBody(
				withThrowingIgnoredAliases(
					{ query: "test", num_results: undefined },
					["limit", "numSearchResults"],
					"tavily",
				),
			);
			expect(bodyDefault.max_results).toBe(5);

			const aliasOnlyBody = buildTavilyRequestBody({ query: "test", limit: 2, numSearchResults: 8 } as any);
			expect(aliasOnlyBody.max_results).toBe(5);
		},
	},
	tinyfish: {
		id: "tinyfish",
		limitField: "searchParams",
		defaultLimit: 10,
		maxLimit: 20,
		executeDirect: (params, fetchImpl) =>
			searchTinyFish(
				makeSearchParams({
					fetch: fetchImpl,
					...params,
				}),
			),
		adapter: TinyFishProvider,
		createFetch: () => async (url: string | URL | Request) => {
			const parsed = new URL(url.toString());
			const page = Number(parsed.searchParams.get("page") ?? "0");
			return new Response(
				JSON.stringify({
					total_results: 30,
					page,
					results: Array.from({ length: 10 }, (_, i) => ({
						url: `https://example.com/${page * 10 + i + 1}`,
						title: `Title ${page * 10 + i + 1}`,
						snippet: `Snippet ${page * 10 + i + 1}`,
					})),
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		},
		testInternalRequestLimits: () => {
			const urlWithLimit = buildTinyFishUrl(
				withThrowingIgnoredAliases({ query: "test", num_results: 7 }, ["limit", "numSearchResults"], "tinyfish"),
			);
			expect(urlWithLimit.searchParams.get("num_results")).toBe("7");

			const urlDefault = buildTinyFishUrl(
				withThrowingIgnoredAliases(
					{ query: "test", num_results: undefined },
					["limit", "numSearchResults"],
					"tinyfish",
				),
			);
			expect(urlDefault.searchParams.get("num_results")).toBeNull();

			const aliasOnlyUrl = buildTinyFishUrl({ query: "test", limit: 3, numSearchResults: 5 } as any);
			expect(aliasOnlyUrl.searchParams.get("num_results")).toBeNull();
		},
	},
	xai: {
		id: "xai",
		limitField: "searchParams",
		defaultLimit: 10,
		maxLimit: 30,
		clampCoveredElsewhere: true,
		executeDirect: (params, fetchImpl) =>
			searchXAI(
				makeSearchParams({
					fetch: fetchImpl,
					...params,
				}),
			),
		adapter: XAIProvider,
		createFetch: () => async () =>
			new Response(
				JSON.stringify({
					output: [
						{
							type: "message",
							content: [
								{
									type: "text",
									text: "xAI response",
									annotations: Array.from({ length: 35 }, (_, i) => ({
										type: "url_citation",
										url: `https://example.com/${i + 1}`,
										title: `Title ${i + 1}`,
									})),
								},
							],
						},
					],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
	},
	zai: {
		id: "zai",
		limitField: "num_results",
		defaultLimit: 10,
		maxLimit: 20,
		clampCoveredElsewhere: true,
		executeDirect: (params, fetchImpl) =>
			searchZai({
				query: "test",
				authStorage,
				fetch: fetchImpl,
				...params,
			}),
		adapter: ZaiProvider,
		createFetch: () => async (_url, init) => {
			const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string; id?: string };
			if (body.method === "initialize") {
				return new Response(
					JSON.stringify({
						jsonrpc: "2.0",
						id: body.id,
						result: {
							protocolVersion: "2025-03-26",
							capabilities: { tools: {} },
							clientInfo: { name: "zai-test", version: "1.0.0" },
						},
					}),
					{ status: 200, headers: { "Content-Type": "application/json", "Mcp-Session-Id": "zai-session-1" } },
				);
			}
			if (body.method === "notifications/initialized") {
				return new Response(null, { status: 202 });
			}
			return new Response(
				JSON.stringify({
					jsonrpc: "2.0",
					id: body.id,
					result: {
						content: [
							{
								type: "text",
								text: JSON.stringify({
									search_result: Array.from({ length: 30 }, (_, i) => ({
										link: `https://example.com/${i + 1}`,
										title: `Title ${i + 1}`,
										content: `Content ${i + 1}`,
									})),
								}),
							},
						],
					},
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		},
	},
};

describe("registry completeness and classification", () => {
	it("asserts NOT_DRIVABLE contains exactly the model-grounded non-fetch search providers", () => {
		expect(Object.keys(NOT_DRIVABLE).sort()).toEqual(["anthropic", "codex", "gemini", "perplexity"]);
	});

	it("asserts SEARCH_PROVIDER_ORDER is fully partitioned by PROVIDER_SPECS and NOT_DRIVABLE", () => {
		const unclassified = SEARCH_PROVIDER_ORDER.filter(id => !(id in PROVIDER_SPECS) && !(id in NOT_DRIVABLE));
		expect(unclassified).toEqual([]);
	});
});

describe("registry-driven search provider limit precedence sweep", () => {
	for (const id of SEARCH_PROVIDER_ORDER) {
		const spec = PROVIDER_SPECS[id];
		if (!spec) continue;

		describe(`${id} limit resolution contract`, () => {
			it(`${id}: default cap with no limit given`, async () => {
				const fetchImpl = spec.createFetch();
				const res = await spec.executeDirect({}, fetchImpl);
				if (spec.defaultLimit !== undefined) {
					expect(res.sources.length).toBe(spec.defaultLimit);
				} else {
					expect(res.sources.length).toBeGreaterThanOrEqual(30);
				}
			});

			const maxLimit = spec.maxLimit;
			if (maxLimit !== undefined && !spec.clampCoveredElsewhere) {
				it(`${id}: clamp at max limit (${maxLimit})`, async () => {
					const fetchImpl = spec.createFetch();
					const oversized = maxLimit + 50;
					const params = spec.limitField === "num_results" ? { num_results: oversized } : { limit: oversized };
					const res = await spec.executeDirect(params, fetchImpl);
					expect(res.sources.length).toBe(maxLimit);
				});
			}

			it(`${id}: alias fields are never read (enumerable:false throwing getters)`, async () => {
				const fetchImpl = spec.createFetch();
				if (spec.limitField === "num_results") {
					// 1. When limit is explicitly set, alias fields are ignored
					const params = withThrowingIgnoredAliases(
						{ num_results: 3 },
						["limit", "numSearchResults"],
						`search ${id}`,
					);
					const res = await spec.executeDirect(params, fetchImpl);
					expect(res.sources.length).toBe(3);

					// 2. When num_results is undefined, alias fields must NOT be read as fallback
					const fallbackParams = withThrowingIgnoredAliases(
						{ num_results: undefined },
						["limit", "numSearchResults"],
						`search ${id}`,
					);
					const fallbackRes = await spec.executeDirect(fallbackParams, fetchImpl);
					if (spec.defaultLimit !== undefined) {
						expect(fallbackRes.sources.length).toBe(spec.defaultLimit);
					} else {
						expect(fallbackRes.sources.length).toBeGreaterThanOrEqual(30);
					}

					// 3. Passing limit/numSearchResults without num_results yields defaultLimit, not the alias value
					const aliasOnlyRes = await spec.executeDirect({ limit: 3, numSearchResults: 5 }, fetchImpl);
					if (spec.defaultLimit !== undefined) {
						expect(aliasOnlyRes.sources.length).toBe(spec.defaultLimit);
					} else {
						expect(aliasOnlyRes.sources.length).toBeGreaterThanOrEqual(30);
					}
				} else {
					// 1. When canonical limits are set, ignored num_results is never read
					const params = withThrowingIgnoredAliases(
						{ numSearchResults: 2, limit: 7 },
						["num_results"],
						`search ${id}`,
					);
					const res = await spec.executeDirect(params, fetchImpl);
					expect(res.sources.length).toBe(2);

					// 2. When canonical limits are undefined, num_results must NOT be read as fallback
					const fallbackParams = withThrowingIgnoredAliases(
						{ numSearchResults: undefined, limit: undefined },
						["num_results"],
						`search ${id}`,
					);
					const fallbackRes = await spec.executeDirect(fallbackParams, fetchImpl);
					if (spec.defaultLimit !== undefined) {
						expect(fallbackRes.sources.length).toBe(spec.defaultLimit);
					} else {
						expect(fallbackRes.sources.length).toBeGreaterThanOrEqual(30);
					}

					// 3. Passing num_results alone yields defaultLimit, not the alias value
					const aliasOnlyRes = await spec.executeDirect({ num_results: 3 }, fetchImpl);
					if (spec.defaultLimit !== undefined) {
						expect(aliasOnlyRes.sources.length).toBe(spec.defaultLimit);
					} else {
						expect(aliasOnlyRes.sources.length).toBeGreaterThanOrEqual(30);
					}
				}
				spec.testInternalRequestLimits?.();
			});

			it(`${id}: adapter projects numSearchResults ?? limit and slices sources`, async () => {
				const fetchImpl = spec.createFetch();
				const provider = new spec.adapter();

				const resWithBoth = await provider.search(
					makeSearchParams({
						fetch: fetchImpl,
						numSearchResults: 2,
						limit: 8,
					}),
				);
				expect(resWithBoth.sources.length).toBe(2);

				const resWithLimitOnly = await provider.search(
					makeSearchParams({
						fetch: fetchImpl,
						limit: 4,
					}),
				);
				expect(resWithLimitOnly.sources.length).toBe(4);
			});

			it(`${id}: negative, zero, and fractional limits yield expected whole counts without back-slicing`, async () => {
				const fetchImpl = spec.createFetch();

				// Negative limit
				const negParams = spec.limitField === "num_results" ? { num_results: -5 } : { limit: -5 };
				const negRes = await spec.executeDirect(negParams, fetchImpl);
				if (spec.defaultLimit !== undefined) {
					// clampNumResults(-5, default, max) -> Math.max(1, -5) = 1 (positive lower bound)
					expect(negRes.sources.length).toBe(1);
				} else {
					// applyResultLimit treats negative limit as unconstrained
					expect(negRes.sources.length).toBeGreaterThanOrEqual(30);
				}

				// Zero limit
				const zeroParams = spec.limitField === "num_results" ? { num_results: 0 } : { limit: 0 };
				const zeroRes = await spec.executeDirect(zeroParams, fetchImpl);
				if (spec.defaultLimit !== undefined) {
					expect(zeroRes.sources.length).toBe(spec.defaultLimit);
				} else {
					expect(zeroRes.sources.length).toBeGreaterThanOrEqual(30);
				}

				// Fractional limit
				const fracParams = spec.limitField === "num_results" ? { num_results: 3.7 } : { limit: 3.7 };
				const fracRes = await spec.executeDirect(fracParams, fetchImpl);
				expect(fracRes.sources.length).toBe(3);
			});
		});
	}
});
