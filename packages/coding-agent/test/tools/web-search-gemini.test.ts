import { afterEach, describe, expect, it } from "bun:test";
import type { AuthStorage } from "@veyyon/ai";
import type { FetchImpl } from "@veyyon/ai/types";
import {
	buildGeminiRequestTools,
	GeminiProvider,
	geminiPerformedSearch,
	searchGemini,
} from "@veyyon/coding-agent/web/search/providers/gemini";

// A realistic grounded Cloud Code response: text PLUS groundingMetadata (a real
// Google Search grounding always carries chunks/queries). The request-shaping
// tests below only assert on the outgoing request, but `searchGemini` now rejects
// an answer that arrives with NO grounding (see the greeting test), so the shared
// fixture must look like an actual search, not a bare chat reply.
const SSE_RESPONSE =
	'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"Gemini answer"}]},"groundingMetadata":{"webSearchQueries":["latest Bun version"],"groundingChunks":[{"web":{"uri":"https://bun.sh","title":"Bun"}}],"groundingSupports":[{"segment":{"text":"Gemini answer"},"groundingChunkIndices":[0]}]}}],"modelVersion":"gemini-2.5-flash"}}\n\n';
// The bug fixture: the model answered CONVERSATIONALLY with no grounding at all.
const GREETING_SSE_RESPONSE =
	'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"Hello! How can I help you today?"}]}}],"modelVersion":"gemini-2.5-flash"}}\n\n';
const DEVELOPER_SSE_RESPONSE =
	'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"Developer answer"}]},"groundingMetadata":{"webSearchQueries":["latest Bun version"],"groundingChunks":[{"web":{"uri":"https://bun.sh","title":"Bun"}}],"groundingSupports":[{"segment":{"text":"Developer answer"},"groundingChunkIndices":[0]}]}}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":4,"totalTokenCount":7},"modelVersion":"gemini-2.5-flash"}\n\n';
const DEVELOPER_SSE_RESPONSE_WITHOUT_MODEL =
	'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"Developer answer"}]},"groundingMetadata":{"webSearchQueries":["latest Bun version"],"groundingChunks":[{"web":{"uri":"https://bun.sh","title":"Bun"}}],"groundingSupports":[{"segment":{"text":"Developer answer"},"groundingChunkIndices":[0]}]}}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":4,"totalTokenCount":7}}\n\n';
const ORIGINAL_GEMINI_SEARCH_MODEL = Bun.env.GEMINI_SEARCH_MODEL;

type CapturedRequest = {
	url: string;
	headers: Record<string, string>;
	body: Record<string, unknown> | null;
};

describe("searchGemini tools serialization", () => {
	let capturedRequest: CapturedRequest | null = null;

	const fakeAuthStorage = {
		async getOAuthAccess() {
			return {
				accessToken: "test-access-token",
				projectId: "test-project",
			};
		},
		hasOAuth() {
			return true;
		},
	} as unknown as AuthStorage;

	const apiKeyAuthStorage = {
		async getOAuthAccess() {
			return undefined;
		},
		hasOAuth() {
			return false;
		},
		hasAuth(provider: string) {
			return provider === "google";
		},
		async getApiKey(provider: string) {
			return provider === "google" ? "test-gemini-api-key" : undefined;
		},
	} as unknown as AuthStorage;

	function mockGeminiFetch(responseText = SSE_RESPONSE): FetchImpl {
		capturedRequest = null;
		return (url, init) => {
			const headers = new Headers(init?.headers);
			capturedRequest = {
				url: String(url),
				headers: Object.fromEntries(headers.entries()),
				body: init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : null,
			};
			return Promise.resolve(
				new Response(responseText, {
					status: 200,
					headers: { "Content-Type": "text/event-stream" },
				}),
			);
		};
	}

	afterEach(() => {
		capturedRequest = null;
		if (ORIGINAL_GEMINI_SEARCH_MODEL === undefined) {
			delete Bun.env.GEMINI_SEARCH_MODEL;
		} else {
			Bun.env.GEMINI_SEARCH_MODEL = ORIGINAL_GEMINI_SEARCH_MODEL;
		}
	});

	function makeParams(query: string) {
		return {
			query,
			authStorage: fakeAuthStorage,
			systemPrompt: "Gemini test prompt",
		} as const;
	}

	it("treats a standard Google developer API key as available", () => {
		const provider = new GeminiProvider();
		expect(provider.isAvailable(apiKeyAuthStorage)).toBe(true);
	});

	it("routes API key auth through the developer API with Google Search grounding", async () => {
		const fetchMock = mockGeminiFetch(DEVELOPER_SSE_RESPONSE);
		const response = await searchGemini({
			...makeParams("developer api"),
			authStorage: apiKeyAuthStorage,
			fetch: fetchMock,
		});

		expect(capturedRequest).not.toBeNull();
		expect(capturedRequest?.url).toBe(
			"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse",
		);
		expect(capturedRequest?.headers["x-goog-api-key"]).toBe("test-gemini-api-key");
		expect(capturedRequest?.body).toMatchObject({
			tools: [{ googleSearch: {} }],
		});
		expect(response).toMatchObject({
			answer: "Developer answer",
			sources: [{ title: "Bun", url: "https://bun.sh" }],
			searchQueries: ["latest Bun version"],
			usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
		});
	});

	it("uses configured developer API model and reports it when modelVersion is absent", async () => {
		const fetchMock = mockGeminiFetch(DEVELOPER_SSE_RESPONSE_WITHOUT_MODEL);
		const response = await searchGemini({
			...makeParams("developer api configured"),
			authStorage: apiKeyAuthStorage,
			geminiModel: "gemini-3.5-flash",
			fetch: fetchMock,
		});

		expect(capturedRequest?.url).toBe(
			"https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:streamGenerateContent?alt=sse",
		);
		expect(response.model).toBe("gemini-3.5-flash");
	});

	it("uses configured OAuth model in the Cloud Code request body", async () => {
		const fetchMock = mockGeminiFetch();
		await searchGemini({
			...makeParams("oauth configured"),
			geminiModel: "gemini-3.5-flash",
			fetch: fetchMock,
		});

		expect(capturedRequest?.body).toMatchObject({
			model: "gemini-3.5-flash",
		});
	});

	it("lets GEMINI_SEARCH_MODEL override the configured Gemini model", async () => {
		Bun.env.GEMINI_SEARCH_MODEL = "gemini-2.5-pro";
		const fetchMock = mockGeminiFetch();
		await searchGemini({
			...makeParams("env configured"),
			geminiModel: "gemini-3.5-flash",
			fetch: fetchMock,
		});

		expect(capturedRequest?.body).toMatchObject({
			model: "gemini-2.5-pro",
		});
	});
	it("sends default googleSearch tool when no passthrough payloads are provided", async () => {
		const fetchMock = mockGeminiFetch();
		await searchGemini({ ...makeParams("default tools"), fetch: fetchMock });

		expect(capturedRequest).not.toBeNull();
		expect(capturedRequest?.body?.request).toMatchObject({
			tools: [{ googleSearch: {} }],
		});
		expect(capturedRequest?.body).toMatchObject({
			model: "gemini-2.5-flash",
		});
	});

	it("passes through googleSearch payload into googleSearch tool", async () => {
		const fetchMock = mockGeminiFetch();
		await searchGemini({
			...makeParams("google payload"),
			google_search: { dynamicRetrievalConfig: { mode: "MODE_DYNAMIC" } },
			fetch: fetchMock,
		});

		expect(capturedRequest).not.toBeNull();
		expect(capturedRequest?.body?.request).toMatchObject({
			tools: [{ googleSearch: { dynamicRetrievalConfig: { mode: "MODE_DYNAMIC" } } }],
		});
	});

	it("includes codeExecution and urlContext tools when provided", async () => {
		const fetchMock = mockGeminiFetch();
		await searchGemini({
			...makeParams("extended tools"),
			code_execution: {},
			url_context: { allowedDomains: ["example.com"] },
			fetch: fetchMock,
		});

		expect(capturedRequest).not.toBeNull();
		expect(capturedRequest?.body?.request).toMatchObject({
			tools: [{ googleSearch: {} }, { codeExecution: {} }, { urlContext: { allowedDomains: ["example.com"] } }],
		});
	});

	// BACKLOG DOG-R2-3: a `web_search test` that came back as an Antigravity chat
	// greeting was surfaced as a "search result". The model answered without running
	// Google Search (no grounding), and the answer text alone passed the shared
	// renderable-content gate. searchGemini must instead fail loud so the provider
	// chain moves on rather than presenting ungrounded chatter as a search.
	it("fails loud when the model answers without searching, instead of surfacing the greeting", async () => {
		const fetchMock = mockGeminiFetch(GREETING_SSE_RESPONSE);
		await expect(searchGemini({ ...makeParams("test"), fetch: fetchMock })).rejects.toThrow(
			/without performing a web search/,
		);
	});
});

// A grounded response carrying THREE distinct sources, so a result-limit slice
// has something to trim (or wrongly drop). searchGemini caps sources only when a
// real positive `num_results` is given.
const THREE_SOURCE_SSE_RESPONSE =
	'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"Gemini answer"}]},"groundingMetadata":{"webSearchQueries":["q"],"groundingChunks":[{"web":{"uri":"https://a.example","title":"A"}},{"web":{"uri":"https://b.example","title":"B"}},{"web":{"uri":"https://c.example","title":"C"}}],"groundingSupports":[{"segment":{"text":"Gemini answer"},"groundingChunkIndices":[0,1,2]}]}}],"modelVersion":"gemini-2.5-flash"}}\n\n';

describe("searchGemini result-limit handling", () => {
	const oauthAuthStorage = {
		async getOAuthAccess() {
			return { accessToken: "test-access-token", projectId: "test-project" };
		},
		hasOAuth() {
			return true;
		},
	} as unknown as AuthStorage;

	function threeSourceFetch(): FetchImpl {
		return () =>
			Promise.resolve(
				new Response(THREE_SOURCE_SSE_RESPONSE, {
					status: 200,
					headers: { "Content-Type": "text/event-stream" },
				}),
			);
	}

	function run(numResults: number | undefined) {
		return searchGemini({
			query: "limit test",
			authStorage: oauthAuthStorage,
			systemPrompt: "prompt",
			num_results: numResults,
			fetch: threeSourceFetch(),
		} as Parameters<typeof searchGemini>[0]);
	}

	it("returns every grounded source when no limit is given", async () => {
		const response = await run(undefined);
		expect(response.sources.map(s => s.url)).toEqual(["https://a.example", "https://b.example", "https://c.example"]);
	});

	it("caps to the front of the list for a valid positive limit", async () => {
		const response = await run(2);
		expect(response.sources.map(s => s.url)).toEqual(["https://a.example", "https://b.example"]);
	});

	// Regression: a negative num_results used to hit `sources.slice(0, -1)`, which
	// counts from the END and silently dropped the LAST grounded source (returning
	// A + B and losing C). It must instead be treated as "no limit" and return all
	// three, never a truncated tail.
	it("does not drop trailing sources when the limit is negative", async () => {
		const response = await run(-1);
		expect(response.sources.map(s => s.url)).toEqual(["https://a.example", "https://b.example", "https://c.example"]);
	});
});

describe("geminiPerformedSearch grounding discriminator", () => {
	it("is true when any single grounding signal is present", () => {
		expect(
			geminiPerformedSearch({
				sources: [{ title: "Bun", url: "https://bun.sh" }],
				citations: [],
				searchQueries: [],
			}),
		).toBe(true);
		expect(
			geminiPerformedSearch({
				sources: [],
				citations: [{ url: "https://bun.sh", title: "Bun" }],
				searchQueries: [],
			}),
		).toBe(true);
		expect(geminiPerformedSearch({ sources: [], citations: [], searchQueries: ["latest Bun version"] })).toBe(true);
	});

	it("is false only when the model produced NO grounding at all (the greeting case)", () => {
		expect(geminiPerformedSearch({ sources: [], citations: [], searchQueries: [] })).toBe(false);
	});
});

/**
 * buildGeminiRequestTools shapes the `tools` array sent to the Gemini grounding API. It had no direct
 * test. The contract the request builder relies on:
 *   - googleSearch is ALWAYS the first tool (grounding is the whole point of this provider), defaulting
 *     to an empty config object when no google_search config is supplied, or carrying the given config;
 *   - codeExecution and urlContext are OPT-IN: each is appended only when its param is defined, in the
 *     fixed order googleSearch -> codeExecution -> urlContext.
 * A regression that dropped googleSearch would disable grounding entirely; one that always appended the
 * optional tools would send capabilities the caller did not request.
 */
describe("buildGeminiRequestTools", () => {
	it("always emits googleSearch first, defaulting to an empty config", () => {
		expect(buildGeminiRequestTools({})).toEqual([{ googleSearch: {} }]);
	});

	it("carries a provided google_search config instead of the default", () => {
		expect(buildGeminiRequestTools({ google_search: { dynamicThreshold: 0.5 } })).toEqual([
			{ googleSearch: { dynamicThreshold: 0.5 } },
		]);
	});

	it("appends codeExecution only when defined", () => {
		expect(buildGeminiRequestTools({ code_execution: { a: 1 } })).toEqual([
			{ googleSearch: {} },
			{ codeExecution: { a: 1 } },
		]);
	});

	it("appends urlContext only when defined", () => {
		expect(buildGeminiRequestTools({ url_context: { u: "z" } })).toEqual([
			{ googleSearch: {} },
			{ urlContext: { u: "z" } },
		]);
	});

	it("emits all three in the fixed order googleSearch -> codeExecution -> urlContext", () => {
		expect(buildGeminiRequestTools({ google_search: {}, code_execution: {}, url_context: {} })).toEqual([
			{ googleSearch: {} },
			{ codeExecution: {} },
			{ urlContext: {} },
		]);
	});
});
