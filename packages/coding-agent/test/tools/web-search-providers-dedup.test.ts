/**
 * Regression suite: web search scraper providers deduplicate result URLs
 * before applying the result limit, preserving original ordering without
 * returning duplicate entries.
 */

import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import type { FetchImpl } from "@veyyon/ai";
import { AuthStorage } from "@veyyon/ai";
import { SqliteAuthCredentialStore } from "@veyyon/ai/auth-storage-sqlite";
import type { SearchParams } from "@veyyon/coding-agent/tools/web/search/providers/base";
import { searchDuckDuckGo } from "@veyyon/coding-agent/tools/web/search/providers/duckduckgo";
import { searchGoogle } from "@veyyon/coding-agent/tools/web/search/providers/google";
import { searchMojeek } from "@veyyon/coding-agent/tools/web/search/providers/mojeek";
import { searchStartpage } from "@veyyon/coding-agent/tools/web/search/providers/startpage";
import { toSearchSources } from "@veyyon/coding-agent/tools/web/search/providers/utils";

function makeAuthStorage(): AuthStorage {
	return new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
}

function makeParams(query: string, fetch: FetchImpl, numResults = 2): SearchParams {
	return {
		query,
		authStorage: makeAuthStorage(),
		systemPrompt: "Search test prompt",
		fetch,
		numSearchResults: numResults,
	};
}

describe("web search providers URL deduplication", () => {
	it("toSearchSources preserves exact slice semantics without deduplication", () => {
		const raw = [
			{ title: "First A", url: "https://example.com/a" },
			{ title: "Second A", url: "https://example.com/a" },
			{ title: "First B", url: "https://example.com/b" },
		];

		// Limit 0 returns []
		expect(toSearchSources(raw, 0)).toEqual([]);

		// Negative limit matches slice(0, -1) behavior
		expect(toSearchSources(raw, -1)).toHaveLength(2);
		expect(toSearchSources(raw, -1)[0].url).toBe("https://example.com/a");
		expect(toSearchSources(raw, -1)[1].url).toBe("https://example.com/a");

		// NaN / undefined limits
		expect(toSearchSources(raw, Number.NaN)).toEqual([]);

		// Positive limits
		expect(toSearchSources(raw, 1)).toHaveLength(1);
		expect(toSearchSources(raw, 2)).toHaveLength(2);
		expect(toSearchSources(raw, 5)).toHaveLength(3);
	});

	it("toSearchSources deduplicates URLs when requested and respects all boundaries", () => {
		const raw = [
			{ title: "First A", url: "https://example.com/a" },
			{ title: "Second A (duplicate)", url: "https://example.com/a" },
			{ title: "First B", url: "https://example.com/b" },
			{ title: "First C", url: "https://example.com/c" },
			{ title: "Third A (duplicate)", url: "https://example.com/a" },
		];

		// Limit 0 returns []
		expect(toSearchSources(raw, 0, { deduplicate: true })).toEqual([]);

		// Negative or NaN limit returns []
		expect(toSearchSources(raw, -1, { deduplicate: true })).toEqual([]);
		expect(toSearchSources(raw, Number.NaN, { deduplicate: true })).toEqual([]);

		// Limit 1 returns only first A
		const one = toSearchSources(raw, 1, { deduplicate: true });
		expect(one).toHaveLength(1);
		expect(one[0].title).toBe("First A");

		// Limit 2 skips duplicate A and returns A, B
		const deduped = toSearchSources(raw, 2, { deduplicate: true });
		expect(deduped).toEqual([
			{
				title: "First A",
				url: "https://example.com/a",
				snippet: undefined,
				publishedDate: undefined,
				ageSeconds: undefined,
			},
			{
				title: "First B",
				url: "https://example.com/b",
				snippet: undefined,
				publishedDate: undefined,
				ageSeconds: undefined,
			},
		]);

		// Limit 3 returns A, B, C (skipping subsequent duplicate A)
		const three = toSearchSources(raw, 3, { deduplicate: true });
		expect(three).toHaveLength(3);
		expect(three.map(s => s.url)).toEqual([
			"https://example.com/a",
			"https://example.com/b",
			"https://example.com/c",
		]);
	});

	it("searchGoogle deduplicates duplicate URLs before slicing to numResults", async () => {
		const html = `<!DOCTYPE html><html><body>
			<div><a href="/url?q=https://example.com/a&amp;sa=U"><h3>First A</h3></a><div>Snippet A1</div></div>
			<div><a href="/url?q=https://example.com/a&amp;sa=U"><h3>Duplicate A</h3></a><div>Snippet A2</div></div>
			<div><a href="/url?q=https://example.com/b&amp;sa=U"><h3>First B</h3></a><div>Snippet B1</div></div>
		</body></html>`;

		const fetchMock: FetchImpl = () => Promise.resolve(new Response(html, { status: 200 }));
		const res = await searchGoogle(makeParams("test", fetchMock, 2));

		expect(res.provider).toBe("google");
		expect(res.sources).toHaveLength(2);
		expect(res.sources[0].url).toBe("https://example.com/a");
		expect(res.sources[0].title).toBe("First A");
		expect(res.sources[1].url).toBe("https://example.com/b");
		expect(res.sources[1].title).toBe("First B");
	});

	it("searchDuckDuckGo deduplicates duplicate URLs before slicing to numResults", async () => {
		const html = `<!DOCTYPE html><html><body>
			<div class="result results_links results_links_deep web-result">
				<a class="result__url" href="https://example.com/a"></a>
				<a class="result__a" href="https://example.com/a">First A</a>
				<a class="result__snippet">Snippet A1</a>
			</div>
			<div class="result results_links results_links_deep web-result">
				<a class="result__url" href="https://example.com/a"></a>
				<a class="result__a" href="https://example.com/a">Duplicate A</a>
				<a class="result__snippet">Snippet A2</a>
			</div>
			<div class="result results_links results_links_deep web-result">
				<a class="result__url" href="https://example.com/b"></a>
				<a class="result__a" href="https://example.com/b">First B</a>
				<a class="result__snippet">Snippet B1</a>
			</div>
		</body></html>`;

		const fetchMock: FetchImpl = () => Promise.resolve(new Response(html, { status: 200 }));
		const res = await searchDuckDuckGo(makeParams("test", fetchMock, 2));

		expect(res.provider).toBe("duckduckgo");
		expect(res.sources).toHaveLength(2);
		expect(res.sources[0].url).toBe("https://example.com/a");
		expect(res.sources[1].url).toBe("https://example.com/b");
	});

	it("searchMojeek deduplicates duplicate URLs before slicing to numResults", async () => {
		const html = `<!DOCTYPE html><html><body><div class="results"><ul class="results-standard">
			<li class="r1"><a class="title" href="https://example.com/a">First A</a><p class="s">Snippet A1</p></li>
			<li class="r2"><a class="title" href="https://example.com/a">Duplicate A</a><p class="s">Snippet A2</p></li>
			<li class="r3"><a class="title" href="https://example.com/b">First B</a><p class="s">Snippet B1</p></li>
		</ul></div></body></html>`;

		const fetchMock: FetchImpl = () => Promise.resolve(new Response(html, { status: 200 }));
		const res = await searchMojeek(makeParams("test", fetchMock, 2));

		expect(res.provider).toBe("mojeek");
		expect(res.sources).toHaveLength(2);
		expect(res.sources[0].url).toBe("https://example.com/a");
		expect(res.sources[1].url).toBe("https://example.com/b");
	});

	it("searchStartpage deduplicates duplicate URLs before slicing to numResults", async () => {
		const html = `<!DOCTYPE html><html><body>
			<div class="w-gl w-gl--desktop result">
				<h2><a class="result-title result-link" href="https://example.com/a">First A</a></h2>
				<p class="result-snippet">Snippet A1</p>
			</div>
			<div class="w-gl w-gl--desktop result">
				<h2><a class="result-title result-link" href="https://example.com/a">Duplicate A</a></h2>
				<p class="result-snippet">Snippet A2</p>
			</div>
			<div class="w-gl w-gl--desktop result">
				<h2><a class="result-title result-link" href="https://example.com/b">First B</a></h2>
				<p class="result-snippet">Snippet B1</p>
			</div>
		</body></html>`;

		const fetchMock: FetchImpl = () => Promise.resolve(new Response(html, { status: 200 }));
		const res = await searchStartpage(makeParams("test", fetchMock, 2));

		expect(res.provider).toBe("startpage");
		expect(res.sources).toHaveLength(2);
		expect(res.sources[0].url).toBe("https://example.com/a");
		expect(res.sources[1].url).toBe("https://example.com/b");
	});
});
