/**
 * A bot wall or proof-of-work challenge served at HTTP 200 is refused as a
 * challenge (throwing SearchProviderError with status 429), not parsed as content
 * and not reported as "no renderable search content" (204). Genuine zero-result
 * pages at HTTP 200 cleanly resolve to empty sources. In the Public Web
 * aggregate, an engine answering with zero results does NOT abort or prematurely
 * resolve the aggregate's wait while slower engines have real results pending,
 * and all engines failing produces a truthful 503 aggregate error.
 *
 * WHY: Startpage began serving an Anubis proof-of-work interstitial at HTTP 200
 * without redirecting. If unclassified, the interstitial parsed to zero results
 * and reported success ({ sources: [] }), which downstream was indistinguishable
 * from an engine that searched and found nothing. In the Public Web fan-out, that
 * empty success ended the wait immediately, discarding slower engines that had
 * real search results on the way.
 *
 * WHAT CLASS THIS CLOSES:
 * 1. Bot challenges served with HTTP 200 being misclassified as empty content.
 * 2. Distinction between 200 challenges (throws status 429) vs genuine 200 empty
 *    results (resolves with empty sources).
 * 3. Aggregate wait truncation by fast zero-result engines, ensuring slower
 *    engines with results are merged and returned.
 * 4. Aggregate termination and hard bounds under stalled engines.
 * 5. Aggregate truthful 503 error when all candidate engines fail.
 * 6. Dynamic enumeration across all PUBLIC_ENGINE_IDS at runtime so new engines
 *    must provide both challenge and zero-result fixtures.
 *
 * WHAT IT DOES NOT CATCH:
 * Challenges whose HTML markup changes without matching any known signature,
 * or engines excluded by settings.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AuthStorage, FetchImpl } from "@veyyon/ai";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { WebSearchTool } from "@veyyon/coding-agent/web/search";
import * as providerModule from "@veyyon/coding-agent/web/search/provider";
import {
	getSearchProvider,
	setExcludedSearchProviders,
	setPreferredSearchProvider,
} from "@veyyon/coding-agent/web/search/provider";
import { PUBLIC_ENGINE_IDS, searchPublicWeb } from "@veyyon/coding-agent/web/search/providers/public";
import { StartpageProvider, searchStartpage } from "@veyyon/coding-agent/web/search/providers/startpage";
import { SearchProviderError } from "@veyyon/coding-agent/web/search/types";
import { useIsolatedAgentDir } from "../../helpers/isolated-agent-dir";
import { makeToolSession } from "../../helpers/tool-session";

useIsolatedAgentDir();

const FAKE_AUTH_STORAGE = {
	async getApiKey() {
		return undefined;
	},
	resolver() {
		return async () => undefined;
	},
	hasAuth() {
		return false;
	},
	getOAuthAccountId() {
		return undefined;
	},
} as unknown as AuthStorage;

const FAKE_SESSION: ToolSession = makeToolSession({
	authStorage: FAKE_AUTH_STORAGE,
});

/**
 * Fixtures for 200-status bot walls/challenges for all public search engines.
 * Each HTML fixture is served with HTTP status 200.
 */
const ENGINE_CHALLENGES: Record<(typeof PUBLIC_ENGINE_IDS)[number], string> = {
	startpage: `<!DOCTYPE html><html><head><script id="anubis_version" type="application/json">"v1.26.4"</script><script id="anubis_challenge" type="application/json">{"rules":{"algorithm":"fast"}}</script></head><body>Making sure you are not a bot</body></html>`,
	google: `<html><body>Our systems have detected unusual traffic from your computer network. Please solve this challenge.</body></html>`,
	duckduckgo: `<html><body><div class="anomaly-modal">Anomaly modal bot block</div></body></html>`,
	ecosia: `<html><body><script>window._cf_chl_opt={};</script><script src="/cdn-cgi/challenge-platform/h/b/orchestrate"></script></body></html>`,
	mojeek: `<html><head><title>Captcha</title></head><body><altcha-widget></altcha-widget></body></html>`,
};

/**
 * Fixtures for genuine zero-result pages served with HTTP status 200.
 */
const ENGINE_ZERO_RESULTS: Record<(typeof PUBLIC_ENGINE_IDS)[number], string> = {
	startpage: `<!DOCTYPE html><html><body><div id="main"><div class="no-results"><p>No results found for your search query.</p></div></div></body></html>`,
	google: `<!DOCTYPE html><html><body><div id="topstuff"><div class="mnr-c">Your search - query - did not match any documents.</div></div></body></html>`,
	duckduckgo: `<!DOCTYPE html><html><body><div class="results"><div class="no-results">No results found.</div></div></body></html>`,
	ecosia: `<!DOCTYPE html><html><body><div class="main-content"><p class="empty-search">No results found.</p></div></body></html>`,
	mojeek: `<!DOCTYPE html><html><body><div class="content"><p class="no-results">No results found for this search.</p></div></body></html>`,
};

/**
 * Fixtures for real results served with HTTP status 200.
 */
const ENGINE_VALID_RESULTS: Record<(typeof PUBLIC_ENGINE_IDS)[number], string> = {
	startpage: `<!DOCTYPE html><html><body><section id="main"><div class="result css-1v6ikp8"><a class="result-title result-link" href="https://example.com/startpage-hit"><h2>Startpage Hit</h2></a><p class="description">Startpage snippet</p></div></section></body></html>`,
	google: `<!DOCTYPE html><html><body><div class="tF2Cxc"><a href="https://example.com/google-hit"><h3>Google Hit</h3></a><div class="VwiC3b">Google snippet</div></div></body></html>`,
	duckduckgo: `<!DOCTYPE html><html><body><div class="result results_links"><a class="result__url" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fddg-hit"><a class="result__title">DDG Hit</a></a><a class="result__snippet">DDG snippet</a></div></body></html>`,
	ecosia: `<!DOCTYPE html><html><body><article data-test-id="organic-result"><h2 data-test-id="result-title"><a href="https://example.com/ecosia-hit">Ecosia Hit</a></h2><p data-test-id="web-result-description">Ecosia snippet</p></article></body></html>`,
	mojeek: `<!DOCTYPE html><html><body><ul class="results-standard"><li><h2><a class="title" href="https://example.com/mojeek-hit">Mojeek Hit</a></h2><p class="s">Mojeek snippet</p></li></ul></body></html>`,
};

afterEach(() => {
	vi.restoreAllMocks();
	setPreferredSearchProvider("auto");
	setExcludedSearchProviders([]);
});

describe("Startpage 200 challenge refusal and zero-result distinction", () => {
	it("refuses Anubis proof-of-work challenge served at HTTP 200 as a 429 SearchProviderError", async () => {
		const anubisHtml = ENGINE_CHALLENGES.startpage;
		const fetchMock: FetchImpl = () =>
			Promise.resolve(new Response(anubisHtml, { status: 200, headers: { "Content-Type": "text/html" } }));

		const result = Promise.resolve().then(() =>
			searchStartpage({
				query: "test query",
				systemPrompt: "",
				fetch: fetchMock,
				authStorage: FAKE_AUTH_STORAGE,
			}),
		);

		await expect(result).rejects.toBeInstanceOf(SearchProviderError);
		try {
			await result;
		} catch (error) {
			const providerError = error as SearchProviderError;
			expect(providerError.provider).toBe("startpage");
			expect(providerError.status).toBe(429);
			expect(providerError.message).toContain("CAPTCHA");
		}
	});

	it("refuses Gatsby captcha shell chunk-mapping challenge at HTTP 200", async () => {
		const gatsbyCaptchaHtml = `<!DOCTYPE html><html><head><script>window.___chunkMapping={"app":["component---src-pages-captcha-js"]};</script></head><body>Bot verification required</body></html>`;
		const fetchMock: FetchImpl = () =>
			Promise.resolve(new Response(gatsbyCaptchaHtml, { status: 200, headers: { "Content-Type": "text/html" } }));

		const result = Promise.resolve().then(() =>
			searchStartpage({
				query: "test query",
				systemPrompt: "",
				fetch: fetchMock,
				authStorage: FAKE_AUTH_STORAGE,
			}),
		);

		await expect(result).rejects.toBeInstanceOf(SearchProviderError);
		try {
			await result;
		} catch (error) {
			const providerError = error as SearchProviderError;
			expect(providerError.provider).toBe("startpage");
			expect(providerError.status).toBe(429);
		}
	});

	it("refuses challenge responses during the homepage token fetch phase", async () => {
		const fetchMock: FetchImpl = async input => {
			const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
			if (url.includes("www.startpage.com") && !url.includes("/sp/search")) {
				// Homepage returns challenge
				return new Response(ENGINE_CHALLENGES.startpage, {
					status: 200,
					headers: { "Content-Type": "text/html" },
				});
			}
			// Search endpoint also returns challenge
			return new Response(ENGINE_CHALLENGES.startpage, {
				status: 200,
				headers: { "Content-Type": "text/html" },
			});
		};

		const result = Promise.resolve().then(() =>
			searchStartpage({
				query: "test query",
				systemPrompt: "",
				fetch: fetchMock,
				authStorage: FAKE_AUTH_STORAGE,
			}),
		);

		await expect(result).rejects.toBeInstanceOf(SearchProviderError);
		try {
			await result;
		} catch (error) {
			const providerError = error as SearchProviderError;
			expect(providerError.provider).toBe("startpage");
			expect(providerError.status).toBe(429);
		}
	});

	it("cleanly returns zero results for a genuine zero-result page at HTTP 200", async () => {
		const zeroResultHtml = ENGINE_ZERO_RESULTS.startpage;
		const fetchMock: FetchImpl = () =>
			Promise.resolve(new Response(zeroResultHtml, { status: 200, headers: { "Content-Type": "text/html" } }));

		const response = await searchStartpage({
			query: "nonexistent gibberish xyz987123",
			systemPrompt: "",
			fetch: fetchMock,
			authStorage: FAKE_AUTH_STORAGE,
		});

		expect(response.provider).toBe("startpage");
		expect(response.sources).toEqual([]);
	});

	it("proves 200 challenges and 200 zero-results do NOT collapse to the same verdict", async () => {
		const challengeFetch: FetchImpl = () =>
			Promise.resolve(
				new Response(ENGINE_CHALLENGES.startpage, { status: 200, headers: { "Content-Type": "text/html" } }),
			);
		const zeroResultFetch: FetchImpl = () =>
			Promise.resolve(
				new Response(ENGINE_ZERO_RESULTS.startpage, { status: 200, headers: { "Content-Type": "text/html" } }),
			);

		let challengeVerdict: { kind: "rejected"; status?: number; error?: string } | { kind: "resolved"; count: number };
		try {
			const res = await searchStartpage({
				query: "test",
				systemPrompt: "",
				fetch: challengeFetch,
				authStorage: FAKE_AUTH_STORAGE,
			});
			challengeVerdict = { kind: "resolved", count: res.sources.length };
		} catch (e) {
			const err = e as SearchProviderError;
			challengeVerdict = { kind: "rejected", status: err.status, error: err.message };
		}

		let zeroResultVerdict:
			| { kind: "rejected"; status?: number; error?: string }
			| { kind: "resolved"; count: number };
		try {
			const res = await searchStartpage({
				query: "test",
				systemPrompt: "",
				fetch: zeroResultFetch,
				authStorage: FAKE_AUTH_STORAGE,
			});
			zeroResultVerdict = { kind: "resolved", count: res.sources.length };
		} catch (e) {
			const err = e as SearchProviderError;
			zeroResultVerdict = { kind: "rejected", status: err.status, error: err.message };
		}

		expect(challengeVerdict).toEqual({
			kind: "rejected",
			status: 429,
			error: expect.stringContaining("CAPTCHA"),
		});
		expect(zeroResultVerdict).toEqual({ kind: "resolved", count: 0 });
		expect(challengeVerdict).not.toEqual(zeroResultVerdict);
	});

	it("surfaces 429 challenge error through WebSearchTool and does NOT report 'no renderable search content' (204)", async () => {
		setPreferredSearchProvider("startpage");
		const challengeFetch: FetchImpl = () =>
			Promise.resolve(
				new Response(ENGINE_CHALLENGES.startpage, { status: 200, headers: { "Content-Type": "text/html" } }),
			);

		vi.spyOn(providerModule, "getSearchProvider").mockImplementation(async id => {
			if (id === "startpage") {
				return new (class extends StartpageProvider {
					search(params: Parameters<StartpageProvider["search"]>[0]) {
						return searchStartpage({ ...params, fetch: challengeFetch });
					}
				})();
			}
			throw new Error(`Unexpected provider request: ${id}`);
		});

		const tool = new WebSearchTool(FAKE_SESSION);
		const result = await tool.execute("call-1", { query: "search test" });

		const block = result.content[0];
		expect(block?.type).toBe("text");
		const text = block && "text" in block ? block.text : "";
		expect(text).toContain("Error:");
		expect(text).toContain("CAPTCHA challenge");
		expect(text).not.toContain("returned no renderable search content");
		expect(result.details?.error).toContain("CAPTCHA challenge");
	});

	it("reports 'no renderable search content' (204) for genuine zero-result search through WebSearchTool", async () => {
		setPreferredSearchProvider("startpage");
		const zeroResultFetch: FetchImpl = () =>
			Promise.resolve(
				new Response(ENGINE_ZERO_RESULTS.startpage, { status: 200, headers: { "Content-Type": "text/html" } }),
			);

		vi.spyOn(providerModule, "getSearchProvider").mockImplementation(async id => {
			if (id === "startpage") {
				return new (class extends StartpageProvider {
					search(params: Parameters<StartpageProvider["search"]>[0]) {
						return searchStartpage({ ...params, fetch: zeroResultFetch });
					}
				})();
			}
			throw new Error(`Unexpected provider request: ${id}`);
		});

		const tool = new WebSearchTool(FAKE_SESSION);
		const result = await tool.execute("call-2", { query: "search test" });

		const block = result.content[0];
		expect(block?.type).toBe("text");
		const text = block && "text" in block ? block.text : "";
		expect(text).toContain("Error: Startpage returned no renderable search content.");
	});
});

describe("variant space enumeration across all credential-free engines", () => {
	it("enumerates every engine in PUBLIC_ENGINE_IDS and confirms exact fixture coverage", () => {
		const recordedChallengeEngines = Object.keys(ENGINE_CHALLENGES).sort();
		const recordedZeroResultEngines = Object.keys(ENGINE_ZERO_RESULTS).sort();
		const expectedEngines = [...PUBLIC_ENGINE_IDS].sort();

		expect(recordedChallengeEngines).toEqual(expectedEngines);
		expect(recordedZeroResultEngines).toEqual(expectedEngines);
	});

	for (const id of PUBLIC_ENGINE_IDS) {
		it(`${id}: refuses HTTP 200 bot wall as challenge error`, async () => {
			const provider = await getSearchProvider(id);
			const challengeFetch: FetchImpl = () =>
				Promise.resolve(
					new Response(ENGINE_CHALLENGES[id], { status: 200, headers: { "Content-Type": "text/html" } }),
				);

			const outcome = await provider
				.search({
					query: "query-that-hits-challenge",
					systemPrompt: "",
					authStorage: FAKE_AUTH_STORAGE,
					fetch: challengeFetch,
				})
				.then(
					res => `resolved-sources-${res.sources.length}`,
					error => {
						if (error instanceof SearchProviderError && error.provider === id) {
							return `refused-${error.status}`;
						}
						return `threw-${(error as Error).constructor.name}`;
					},
				);

			expect(outcome).toMatch(/^refused-(?:429|403|503)$/);
		});

		it(`${id}: cleanly parses genuine zero-result page at HTTP 200 to empty sources`, async () => {
			const provider = await getSearchProvider(id);
			const zeroResultFetch: FetchImpl = () =>
				Promise.resolve(
					new Response(ENGINE_ZERO_RESULTS[id], { status: 200, headers: { "Content-Type": "text/html" } }),
				);

			const response = await provider.search({
				query: "query-with-zero-results",
				systemPrompt: "",
				authStorage: FAKE_AUTH_STORAGE,
				fetch: zeroResultFetch,
			});

			expect(response.provider).toBe(id);
			expect(response.sources).toEqual([]);
		});
	}
});

describe("Public Web aggregate wait semantics, termination, and bounds", () => {
	it("fast engine returning zero results does NOT end aggregate wait while slower engine has pending results", async () => {
		// Mock dispatch where:
		// - startpage returns immediately with zero results ({ sources: [] })
		// - duckduckgo and google fail immediately with challenge
		// - mojeek is controlled by a deferred promise and resolves after the soft deadline
		// - ecosia fails
		const mojeekDeferred = Promise.withResolvers<Response>();

		const multiEngineFetch: FetchImpl = async input => {
			const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();

			if (url.includes("startpage.com")) {
				if (!url.includes("/sp/search")) {
					return new Response('<form action="/sp/search"><input type="hidden" name="sc" value="token" /></form>', {
						status: 200,
						headers: { "Content-Type": "text/html" },
					});
				}
				return new Response(ENGINE_ZERO_RESULTS.startpage, {
					status: 200,
					headers: { "Content-Type": "text/html" },
				});
			}

			if (url.includes("duckduckgo.com")) {
				return new Response(ENGINE_CHALLENGES.duckduckgo, {
					status: 200,
					headers: { "Content-Type": "text/html" },
				});
			}

			if (url.includes("google.com")) {
				return new Response(ENGINE_CHALLENGES.google, {
					status: 200,
					headers: { "Content-Type": "text/html" },
				});
			}

			if (url.includes("mojeek.de")) {
				return mojeekDeferred.promise;
			}

			if (url.includes("ecosia.org")) {
				return new Response(ENGINE_CHALLENGES.ecosia, {
					status: 200,
					headers: { "Content-Type": "text/html" },
				});
			}

			return new Response("Not found", { status: 404 });
		};

		// Run aggregate with softMs: 15, hardMs: 1000
		const searchPromise = searchPublicWeb(
			{
				query: "slow search query",
				systemPrompt: "",
				authStorage: FAKE_AUTH_STORAGE,
				fetch: multiEngineFetch,
			},
			{ softMs: 15, hardMs: 1000 },
		);

		// Resolve Mojeek's response with valid results AFTER the soft deadline (15ms)
		// has expired. This ensures that the first race resolves via the soft deadline
		// and exercises the zero-result extended wait branch.
		setTimeout(() => {
			mojeekDeferred.resolve(
				new Response(ENGINE_VALID_RESULTS.mojeek, {
					status: 200,
					headers: { "Content-Type": "text/html" },
				}),
			);
		}, 35);

		const response = await searchPromise;

		expect(response.provider).toBe("public");
		expect(response.sources.length).toBeGreaterThan(0);
		expect(response.sources[0]?.url).toBe("https://example.com/mojeek-hit");
		expect(response.sources[0]?.title).toBe("Mojeek Hit");
	});

	it("terminates within hard deadline bound when all engines stall / hang", async () => {
		// All engines hang indefinitely on unsettled promises
		const hangingFetch: FetchImpl = (_input, init) => {
			const signal = init?.signal;
			const { promise, reject } = Promise.withResolvers<Response>();
			if (signal) {
				signal.addEventListener("abort", () => reject(signal.reason), { once: true });
			}
			return promise;
		};

		const startTime = Date.now();
		const response = await searchPublicWeb(
			{
				query: "hanging query",
				systemPrompt: "",
				authStorage: FAKE_AUTH_STORAGE,
				fetch: hangingFetch,
			},
			{ softMs: 10, hardMs: 40 },
		);
		const elapsed = Date.now() - startTime;

		expect(response.provider).toBe("public");
		expect(response.sources).toEqual([]);
		// Hard deadline was 40ms; must terminate in bounded window without stalling
		expect(elapsed).toBeGreaterThanOrEqual(30);
		expect(elapsed).toBeLessThan(500);
	});
	it("aborts promptly when caller abort signal fires", async () => {
		const ac = new AbortController();
		const slowFetch: FetchImpl = (_input, init) => {
			const signal = init?.signal;
			const { promise, reject } = Promise.withResolvers<Response>();
			if (signal) {
				signal.addEventListener("abort", () => reject(signal.reason), { once: true });
			}
			return promise;
		};

		const searchPromise = searchPublicWeb(
			{
				query: "aborted query",
				systemPrompt: "",
				authStorage: FAKE_AUTH_STORAGE,
				fetch: slowFetch,
				signal: ac.signal,
			},
			{ softMs: 500, hardMs: 2000 },
		);

		ac.abort(new Error("caller aborted"));

		await expect(searchPromise).rejects.toThrow("caller aborted");
	});

	it("surfaces truthful 503 aggregate error when all engines fail", async () => {
		const allFailingFetch: FetchImpl = async input => {
			const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
			if (url.includes("startpage.com")) {
				return new Response(ENGINE_CHALLENGES.startpage, {
					status: 200,
					headers: { "Content-Type": "text/html" },
				});
			}
			if (url.includes("google.com")) {
				return new Response(ENGINE_CHALLENGES.google, {
					status: 200,
					headers: { "Content-Type": "text/html" },
				});
			}
			if (url.includes("duckduckgo.com")) {
				return new Response(ENGINE_CHALLENGES.duckduckgo, {
					status: 200,
					headers: { "Content-Type": "text/html" },
				});
			}
			if (url.includes("ecosia.org")) {
				return new Response(ENGINE_CHALLENGES.ecosia, {
					status: 200,
					headers: { "Content-Type": "text/html" },
				});
			}
			if (url.includes("mojeek.de")) {
				return new Response(ENGINE_CHALLENGES.mojeek, {
					status: 200,
					headers: { "Content-Type": "text/html" },
				});
			}
			return new Response("Unknown", { status: 500 });
		};

		const searchCall = searchPublicWeb(
			{
				query: "all-engines-fail",
				systemPrompt: "",
				authStorage: FAKE_AUTH_STORAGE,
				fetch: allFailingFetch,
			},
			{ softMs: 10, hardMs: 50 },
		);

		await expect(searchCall).rejects.toBeInstanceOf(SearchProviderError);
		try {
			await searchCall;
		} catch (error) {
			const providerError = error as SearchProviderError;
			expect(providerError.provider).toBe("public");
			expect(providerError.status).toBe(503);
			expect(providerError.message).toContain("All public engines failed:");
			// All 5 engines should be enumerated in the failure message
			for (const id of PUBLIC_ENGINE_IDS) {
				expect(providerError.message).toContain(id);
			}
		}
	});
});
