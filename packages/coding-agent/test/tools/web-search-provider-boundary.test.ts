import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { AuthStorage, FetchImpl } from "@veyyon/ai";
import { searchWithKagi } from "@veyyon/coding-agent/web/kagi";
import { searchDuckDuckGo } from "@veyyon/coding-agent/web/search/providers/duckduckgo";
import { resetExaSearchThrottleForTest, searchExa } from "@veyyon/coding-agent/web/search/providers/exa";
import { searchGemini } from "@veyyon/coding-agent/web/search/providers/gemini";
import { searchMojeek } from "@veyyon/coding-agent/web/search/providers/mojeek";
import { searchTavily } from "@veyyon/coding-agent/web/search/providers/tavily";

const inertAuthStorage = {} as AuthStorage;

function requestBody(init: RequestInit | undefined): string {
	return typeof init?.body === "string" ? init.body : "";
}

describe("web-search physical request confidentiality boundaries", () => {
	const originalExaKey = process.env.EXA_API_KEY;

	beforeEach(() => {
		resetExaSearchThrottleForTest();
	});

	afterEach(() => {
		if (originalExaKey === undefined) delete process.env.EXA_API_KEY;
		else process.env.EXA_API_KEY = originalExaKey;
		resetExaSearchThrottleForTest();
	});

	it("captures the browser/form family after transforming URL, form keys, values, and headers", async () => {
		const rawSecret = "FORM_SECRET_31";
		let capturedUrl = "";
		let capturedBody = "";
		let capturedHeaders = new Headers();
		const fetchImpl: FetchImpl = async (input, init) => {
			capturedUrl = String(input);
			capturedBody = requestBody(init);
			capturedHeaders = new Headers(init?.headers);
			return new Response("", { status: 200 });
		};

		await searchDuckDuckGo({
			query: `find ${rawSecret}`,
			systemPrompt: "",
			authStorage: inertAuthStorage,
			fetch: fetchImpl,
			resolveProviderTextTransform: () => text => {
				if (text === "q") return "safe_query_key";
				if (text === "Content-Type") return "X-Safe-Content-Type";
				return text.replaceAll(rawSecret, "[FORM_SAFE]");
			},
		});

		expect(capturedUrl).toBe("https://html.duckduckgo.com/html/");
		expect(new URLSearchParams(capturedBody).get("safe_query_key")).toBe("find [FORM_SAFE]");
		expect(capturedBody).not.toContain(rawSecret);
		expect(capturedHeaders.get("X-Safe-Content-Type")).toBe("application/x-www-form-urlencoded");
	});

	it("captures the browser GET family with a transformed query in the final URL", async () => {
		const rawSecret = "URL_SECRET_47";
		let capturedUrl = "";
		const fetchImpl: FetchImpl = async input => {
			capturedUrl = String(input);
			return new Response("", { status: 200 });
		};

		await searchMojeek({
			query: `lookup ${rawSecret}`,
			systemPrompt: "",
			authStorage: inertAuthStorage,
			fetch: fetchImpl,
			resolveProviderTextTransform: () => text => text.replaceAll(rawSecret, "[URL_SAFE]"),
		});

		expect(decodeURIComponent(capturedUrl)).toContain("lookup+[URL_SAFE]");
		expect(capturedUrl).not.toContain(rawSecret);
	});

	it("rebuilds an auth-retry JSON body with the sanitizer current after the 401", async () => {
		const rawSecret = "AUTH_RETRY_SECRET_59";
		let generation = 1;
		let fetchCalls = 0;
		const bodies: string[] = [];
		const authStorage = {
			resolver() {
				return async (ctx: { error: unknown }) => (ctx.error ? "refreshed-key" : "initial-key");
			},
		} as unknown as AuthStorage;
		const fetchImpl: FetchImpl = async (_input, init) => {
			bodies.push(requestBody(init));
			fetchCalls++;
			if (fetchCalls === 1) {
				generation = 2;
				return Response.json({ error: "unauthorized" }, { status: 401 });
			}
			return Response.json({ meta: { trace: "retry-ok" }, data: { search: [] } });
		};

		await searchWithKagi(
			rawSecret,
			{
				fetch: fetchImpl,
				resolveProviderTextTransform: () => text => {
					if (text === "query") return `safe_query_key_${generation}`;
					return text.replaceAll(rawSecret, `[AUTH_SAFE_${generation}]`);
				},
			},
			authStorage,
		);

		expect(bodies).toHaveLength(2);
		expect(bodies[0]).toContain('"safe_query_key_1":"[AUTH_SAFE_1]"');
		expect(bodies[1]).toContain('"safe_query_key_2":"[AUTH_SAFE_2]"');
		expect(bodies.join("\n")).not.toContain(rawSecret);
	});

	it("rebuilds the recency provider fallback from raw under the later sanitizer", async () => {
		const rawSecret = "PROVIDER_FALLBACK_SECRET_61";
		let replacement = "[PRIMARY_SAFE]";
		const bodies: string[] = [];
		const authStorage = {
			resolver() {
				return async () => "tavily-key";
			},
		} as unknown as AuthStorage;
		const fetchImpl: FetchImpl = async (_input, init) => {
			bodies.push(requestBody(init));
			if (bodies.length === 1) {
				replacement = "[FALLBACK_SAFE]";
				return Response.json({ results: [] });
			}
			return Response.json({ results: [{ title: "found", url: "https://example.test" }] });
		};

		await searchTavily({
			query: rawSecret,
			recency: "day",
			systemPrompt: "",
			authStorage,
			fetch: fetchImpl,
			resolveProviderTextTransform: () => text => text.replaceAll(rawSecret, replacement),
		});

		expect(bodies).toHaveLength(2);
		expect(bodies[0]).toContain("[PRIMARY_SAFE]");
		expect(bodies[1]).toContain("[FALLBACK_SAFE]");
		expect(bodies.join("\n")).not.toContain(rawSecret);
	});

	it("rebuilds the Exa REST-to-MCP fallback under a newly resolved sanitizer", async () => {
		const rawSecret = "EXA_FALLBACK_SECRET_73";
		process.env.EXA_API_KEY = "test-exa-key";
		let replacement = "[REST_SAFE]";
		const urls: string[] = [];
		const bodies: string[] = [];
		const fetchImpl: FetchImpl = async (input, init) => {
			urls.push(String(input));
			bodies.push(requestBody(init));
			if (urls.length === 1) {
				replacement = "[MCP_SAFE]";
				return new Response("unavailable", { status: 500 });
			}
			return Response.json({ jsonrpc: "2.0", id: "mcp-ok", result: { requestId: "ok", results: [] } });
		};

		await searchExa({
			query: rawSecret,
			fetch: fetchImpl,
			resolveProviderTextTransform: () => text => text.replaceAll(rawSecret, replacement),
		});

		expect(urls).toHaveLength(2);
		expect(urls[0]).toBe("https://api.exa.ai/search");
		expect(urls[1]).toContain("https://mcp.exa.ai/mcp");
		expect(bodies[0]).toContain("[REST_SAFE]");
		expect(bodies[1]).toContain("[MCP_SAFE]");
		expect(bodies.join("\n")).not.toContain(rawSecret);
	});

	it("rebuilds the shared streaming retry body and recursively transforms caller-owned nested keys", async () => {
		const rawSecret = "GEMINI_RETRY_SECRET_83";
		const rawNestedKey = `dynamic_${rawSecret}`;
		let generation = 1;
		const bodies: string[] = [];
		const authStorage = {
			async getOAuthAccess() {
				return undefined;
			},
			async getApiKey(provider: string) {
				return provider === "google" ? "gemini-key" : undefined;
			},
		} as unknown as AuthStorage;
		const fetchImpl: FetchImpl = async (_input, init) => {
			bodies.push(requestBody(init));
			if (bodies.length === 1) {
				generation = 2;
				return new Response("retry", { status: 503, headers: { "Retry-After": "0" } });
			}
			return new Response(
				'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"answer"}]},"groundingMetadata":{"webSearchQueries":["q"],"groundingChunks":[{"web":{"uri":"https://example.test","title":"Example"}}]}}],"modelVersion":"gemini-2.5-flash"}\n\n',
				{ status: 200, headers: { "Content-Type": "text/event-stream" } },
			);
		};

		await searchGemini({
			query: rawSecret,
			system_prompt: `system ${rawSecret}`,
			google_search: { [rawNestedKey]: { value: rawSecret } },
			authStorage,
			fetch: fetchImpl,
			resolveProviderTextTransform: () => text => text.replaceAll(rawSecret, `[GEMINI_SAFE_${generation}]`),
		});

		expect(bodies).toHaveLength(2);
		expect(bodies[0]).toContain("dynamic_[GEMINI_SAFE_1]");
		expect(bodies[0]).toContain("[GEMINI_SAFE_1]");
		expect(bodies[1]).toContain("dynamic_[GEMINI_SAFE_2]");
		expect(bodies[1]).toContain("[GEMINI_SAFE_2]");
		expect(bodies.join("\n")).not.toContain(rawSecret);
	});

	it("fails closed before send and never reflects a transform diagnostic containing raw input", async () => {
		const rawSecret = "TRANSFORM_THROW_SECRET_89";
		let fetchCalls = 0;
		const authStorage = {
			resolver() {
				return async () => "tavily-key";
			},
		} as unknown as AuthStorage;

		let failure: unknown;
		try {
			await searchTavily({
				query: rawSecret,
				systemPrompt: rawSecret,
				authStorage,
				fetch: async () => {
					fetchCalls++;
					return Response.json({ results: [] });
				},
				resolveProviderTextTransform: () => text => {
					throw new Error(`cannot sanitize ${text}`);
				},
			});
		} catch (error) {
			failure = error;
		}

		expect(fetchCalls).toBe(0);
		expect(String(failure)).toBe("Error: Tavily search confidentiality transform failed.");
		expect(String(failure)).not.toContain(rawSecret);
	});
});
