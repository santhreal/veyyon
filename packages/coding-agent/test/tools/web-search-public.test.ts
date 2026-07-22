import { afterEach, describe, expect, it } from "bun:test";
import type { AuthStorage, FetchImpl } from "@veyyon/ai";
import { setExcludedSearchProviders } from "@veyyon/coding-agent/web/search/provider";
import type { SearchParams } from "@veyyon/coding-agent/web/search/providers/base";
import {
	dedupKey,
	type MergedSource,
	mergeSources,
	searchPublicWeb,
} from "@veyyon/coding-agent/web/search/providers/public";
import { SearchProviderError, type SearchProviderId, type SearchSource } from "@veyyon/coding-agent/web/search/types";

const fakeAuthStorage = {
	async getApiKey() {
		throw new Error("Public web search must not request API keys");
	},
	resolver() {
		throw new Error("Public web search must not request credential resolvers");
	},
	hasAuth() {
		throw new Error("Public web search must not check auth");
	},
} as unknown as AuthStorage;

/** Restrict the fan-out to the two engines these tests provide fixtures for. */
const NON_TEST_ENGINES: readonly SearchProviderId[] = ["ecosia", "startpage", "mojeek"];

function makeParams(query: string, fetch: FetchImpl): SearchParams {
	return {
		query,
		authStorage: fakeAuthStorage,
		systemPrompt: "Public web search test prompt",
		fetch,
	};
}

function ddgResult(url: string, title: string, snippet?: string): string {
	return `<div class="result results_links results_links_deep web-result">
		<a class="result__a" href="${url}">${title}</a>
		${snippet ? `<a class="result__snippet" href="${url}">${snippet}</a>` : ""}
	</div>`;
}

function googleResult(url: string, title: string, snippet?: string): string {
	return `<div class="MjjYud"><div class="tF2Cxc">
		<a href="${url}"><h3>${title}</h3></a>
		${snippet ? `<div data-sncf="1"><div class="VwiC3b">${snippet}</div></div>` : ""}
	</div></div>`;
}

/** Dispatch fixture bodies per engine host. */
function makeFetchMock(bodies: { ddg: string; google: string }): FetchImpl {
	return input => {
		const url = typeof input === "string" ? input : input.toString();
		if (url.includes("duckduckgo.com")) {
			return Promise.resolve(new Response(bodies.ddg, { status: 200 }));
		}
		if (url.includes("google.com")) {
			return Promise.resolve(new Response(bodies.google, { status: 200 }));
		}
		return Promise.reject(new Error(`Unexpected fetch in public web test: ${url}`));
	};
}

const GOOGLE_CHALLENGE = `<html><body>Our systems have detected unusual traffic from your computer network.</body></html>`;
const DDG_CHALLENGE = `<html><body><div class="anomaly-modal"></div></body></html>`;

afterEach(() => {
	setExcludedSearchProviders([]);
});

describe("Public Web aggregate provider", () => {
	it("consolidates engines: dedups URL variants, ranks by consensus, keeps the best snippet", async () => {
		setExcludedSearchProviders(NON_TEST_ENGINES);
		const fetchMock = makeFetchMock({
			ddg: [
				ddgResult("https://example.com/shared", "Shared result", "short"),
				ddgResult("https://a.example/one", "Alpha", "alpha snippet"),
			].join("\n"),
			google: [
				googleResult("https://www.example.com/shared/", "Shared (google)", "a much longer consolidated snippet"),
				googleResult("https://c.example/three", "Gamma", "gamma snippet"),
			].join("\n"),
		});

		const response = await searchPublicWeb(makeParams("consensus ranking", fetchMock));

		expect(response.provider).toBe("public");
		expect(response.sources).toEqual([
			// Two-engine consensus outranks single-engine results; www/trailing-slash
			// variants merge. Google merges first (higher tiebreak priority), so its
			// title/url win the equal-rank tie; the longer snippet wins regardless.
			{
				title: "Shared (google)",
				url: "https://www.example.com/shared/",
				snippet: "a much longer consolidated snippet",
			},
			{ title: "Gamma", url: "https://c.example/three", snippet: "gamma snippet" },
			{ title: "Alpha", url: "https://a.example/one", snippet: "alpha snippet" },
		]);
	});

	it("tolerates individual engine failures and returns the surviving results", async () => {
		setExcludedSearchProviders(NON_TEST_ENGINES);
		const fetchMock = makeFetchMock({
			ddg: ddgResult("https://a.example/one", "Alpha", "alpha snippet"),
			google: GOOGLE_CHALLENGE,
		});

		const response = await searchPublicWeb(makeParams("partial failure", fetchMock));

		expect(response.sources).toEqual([{ title: "Alpha", url: "https://a.example/one", snippet: "alpha snippet" }]);
	});

	it("returns at the soft deadline with delivered results and aborts stragglers", async () => {
		setExcludedSearchProviders(NON_TEST_ENGINES);
		let stragglerAborted = false;
		const fetchMock: FetchImpl = (input, init) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url.includes("duckduckgo.com")) {
				return Promise.resolve(
					new Response(ddgResult("https://a.example/one", "Alpha", "alpha snippet"), { status: 200 }),
				);
			}
			// google: hangs until the aggregate cancels it at the deadline.
			const { promise, reject } = Promise.withResolvers<Response>();
			init?.signal?.addEventListener("abort", () => {
				stragglerAborted = true;
				reject(new Error("aborted"));
			});
			return promise;
		};

		const response = await searchPublicWeb(makeParams("deadline race", fetchMock), { softMs: 50 });

		expect(response.sources).toEqual([{ title: "Alpha", url: "https://a.example/one", snippet: "alpha snippet" }]);
		expect(stragglerAborted).toBe(true);
	});

	it("waits past the soft deadline for the first success instead of returning empty", async () => {
		setExcludedSearchProviders(NON_TEST_ENGINES);
		const fetchMock: FetchImpl = async input => {
			const url = typeof input === "string" ? input : input.toString();
			if (url.includes("duckduckgo.com")) {
				await Bun.sleep(60);
				return new Response(ddgResult("https://a.example/one", "Alpha", "alpha snippet"), { status: 200 });
			}
			return new Response(GOOGLE_CHALLENGE, { status: 200 });
		};

		const response = await searchPublicWeb(makeParams("slow first success", fetchMock), { softMs: 10 });

		expect(response.sources).toEqual([{ title: "Alpha", url: "https://a.example/one", snippet: "alpha snippet" }]);
	});

	it("returns whatever it has at the hard deadline even with zero successes", async () => {
		setExcludedSearchProviders(NON_TEST_ENGINES);
		const fetchMock: FetchImpl = input => {
			const url = typeof input === "string" ? input : input.toString();
			if (url.includes("duckduckgo.com")) {
				return Promise.resolve(new Response(DDG_CHALLENGE, { status: 200 }));
			}
			// google: never settles and ignores abort — only the hard cap can end the wait.
			const { promise } = Promise.withResolvers<Response>();
			return promise;
		};

		const response = await searchPublicWeb(makeParams("hard cap", fetchMock), { softMs: 10, hardMs: 40 });

		expect(response.provider).toBe("public");
		expect(response.sources).toEqual([]);
	});

	it("fails with an aggregated provider-tagged error when every engine fails", async () => {
		setExcludedSearchProviders(NON_TEST_ENGINES);
		const fetchMock = makeFetchMock({ ddg: DDG_CHALLENGE, google: GOOGLE_CHALLENGE });

		try {
			await searchPublicWeb(makeParams("all blocked", fetchMock));
			expect.unreachable("all-engine failure should reject");
		} catch (error) {
			expect(error).toBeInstanceOf(SearchProviderError);
			const providerError = error as SearchProviderError;
			expect(providerError.provider).toBe("public");
			expect(providerError.status).toBe(503);
			expect(providerError.message).toContain("duckduckgo:");
			expect(providerError.message).toContain("google:");
		}
	});

	it("rejects when settings exclude every credential-free engine", async () => {
		setExcludedSearchProviders([...NON_TEST_ENGINES, "duckduckgo", "google"]);
		const fetchMock: FetchImpl = () => Promise.reject(new Error("no engine should be queried"));

		try {
			await searchPublicWeb(makeParams("nothing left", fetchMock));
			expect.unreachable("fully excluded fan-out should reject");
		} catch (error) {
			expect(error).toBeInstanceOf(SearchProviderError);
			expect(error).toMatchObject({ provider: "public", status: 400 });
		}
	});
});

// The aggregate's HTML-scraping engines can never emit an author/publishedDate,
// so the enrichment merges below are unreachable through searchPublicWeb's
// fixtures. These unit tests exercise the merge accumulator directly (an
// exported test seam) so the field-level merge rules are pinned with real
// values instead of only being covered end-to-end.
describe("dedupKey (canonical cross-engine URL key)", () => {
	it("drops a leading www, a trailing slash, and the fragment while preserving the query", () => {
		// All four spellings of the same page must collapse to one key.
		const canonical = dedupKey("https://example.com/page?q=1");
		expect(dedupKey("https://www.example.com/page?q=1")).toBe(canonical);
		expect(dedupKey("https://example.com/page/?q=1")).toBe(canonical);
		expect(dedupKey("https://EXAMPLE.com/page?q=1#section")).toBe(canonical);
		expect(canonical).toBe("example.com/page?q=1");
	});

	it("keeps distinct queries and distinct paths separate", () => {
		expect(dedupKey("https://example.com/page?q=1")).not.toBe(dedupKey("https://example.com/page?q=2"));
		expect(dedupKey("https://example.com/a")).not.toBe(dedupKey("https://example.com/b"));
	});

	it("does not strip the single root slash", () => {
		// A bare host keeps its "/" path; only a trailing slash on a longer path drops.
		expect(dedupKey("https://example.com/")).toBe("example.com/");
	});

	it("returns the raw string for an unparseable URL instead of throwing", () => {
		expect(dedupKey("not a url")).toBe("not a url");
	});
});

describe("mergeSources (cross-engine field consolidation)", () => {
	function src(overrides: Partial<SearchSource> & { url: string }): SearchSource {
		return { title: overrides.url, ...overrides };
	}

	it("fills author from a lower-ranked engine when the best-ranked one lacked it", () => {
		// Regression lock: author used to be the one optional field mergeSources did
		// not fill (publishedDate and ageSeconds were), so a duplicate URL that only
		// a second engine annotated with an author dropped that author silently.
		const merged = new Map<string, MergedSource>();
		mergeSources(merged, [src({ url: "https://example.com/x", author: undefined })]);
		mergeSources(merged, [src({ url: "https://example.com/x", author: "Jane Doe" })]);
		const entry = merged.get(dedupKey("https://example.com/x"));
		expect(entry?.source.author).toBe("Jane Doe");
		expect(entry?.engines).toBe(2);
	});

	it("does not overwrite an author already present on the best-ranked engine", () => {
		const merged = new Map<string, MergedSource>();
		mergeSources(merged, [src({ url: "https://example.com/x", author: "First Author" })]);
		mergeSources(merged, [src({ url: "https://example.com/x", author: "Second Author" })]);
		expect(merged.get(dedupKey("https://example.com/x"))?.source.author).toBe("First Author");
	});

	it("fills publishedDate and ageSeconds the same way author is filled", () => {
		const merged = new Map<string, MergedSource>();
		mergeSources(merged, [src({ url: "https://example.com/x" })]);
		mergeSources(merged, [src({ url: "https://example.com/x", publishedDate: "2024-01-01", ageSeconds: 42 })]);
		const entry = merged.get(dedupKey("https://example.com/x"));
		expect(entry?.source.publishedDate).toBe("2024-01-01");
		expect(entry?.source.ageSeconds).toBe(42);
	});

	it("counts cross-engine consensus and adopts the better-ranked engine's title and url", () => {
		const merged = new Map<string, MergedSource>();
		// Engine A ranks the shared URL second (rank 1); engine B ranks it first (rank 0).
		mergeSources(merged, [
			src({ url: "https://a.example/one" }),
			src({ url: "https://example.com/shared", title: "A title" }),
		]);
		mergeSources(merged, [src({ url: "https://www.example.com/shared/", title: "B title" })]);
		const entry = merged.get(dedupKey("https://example.com/shared"));
		expect(entry?.engines).toBe(2);
		expect(entry?.bestRank).toBe(0);
		// The better-ranked (rank 0) engine's title/url win.
		expect(entry?.source.title).toBe("B title");
		expect(entry?.source.url).toBe("https://www.example.com/shared/");
	});

	it("keeps the longest snippet regardless of which engine ranked the URL best", () => {
		const merged = new Map<string, MergedSource>();
		mergeSources(merged, [src({ url: "https://example.com/x", snippet: "short" })]);
		mergeSources(merged, [src({ url: "https://example.com/x", snippet: "a considerably longer snippet" })]);
		expect(merged.get(dedupKey("https://example.com/x"))?.source.snippet).toBe("a considerably longer snippet");
	});
});
