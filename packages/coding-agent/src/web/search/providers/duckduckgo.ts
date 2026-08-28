import type { AuthStorage } from "@veyyon/ai";
import { resolveProviderTextTransform, transformProviderPayload } from "../../../provider-boundary";
import type { SearchResponse, SearchSource } from "../../../web/search/types";
import { SearchProviderError } from "../../../web/search/types";
import { decodeHtmlEntities } from "../../scrapers/types";
import { clampNumResults, SEARCH_DEFAULT_NUM_RESULTS } from "../utils";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import { browserFetch } from "./browser-page";
import { classifyProviderHttpError, withHardTimeout } from "./utils";

/** DuckDuckGo's no-JS HTML search frontend. POST `q=…` to receive a static results page we can parse without a real browser. The Instant Answer API */
const DUCKDUCKGO_HTML_URL = "https://html.duckduckgo.com/html/";
const MAX_NUM_RESULTS = 20;

/** Recency → DDG `df` form param. DDG accepts single letters for the time filter; queries without a `df` value return the unfiltered default. */
const RECENCY_TO_DDG_DF: Record<NonNullable<SearchParams["recency"]>, string> = {
	day: "d",
	week: "w",
	month: "m",
	year: "y",
};

interface ParsedResult {
	title: string;
	url: string;
	snippet?: string;
}

/** Decode an HTML-encoded fragment lifted from DDG markup. Strips inline tags (the results page wraps query terms in `<b>`) first, then decodes entities */
function decodeHtmlText(value: string): string {
	return decodeHtmlEntities(value.replace(/<[^>]*>/g, " "))
		.replace(/\s+/g, " ")
		.trim();
}

/** Resolve a DDG result href back to the underlying target URL. DDG routes outbound clicks through `//duckduckgo.com/l/?uddg=<encoded>` so */
function unwrapResultUrl(href: string): string | undefined {
	if (!href) return undefined;
	const decoded = href.replace(/&amp;/gi, "&");
	const wrapMatch = decoded.match(/[?&]uddg=([^&]+)/);
	if (wrapMatch) {
		try {
			return decodeURIComponent(wrapMatch[1]);
		} catch {
			// A `uddg` payload whose percent-escapes are not valid UTF-8 is a row this scraper cannot read, and
			// there is nothing to fall back on: half a decoded URL would be worse than no result at all.
			return undefined;
		}
	}
	if (decoded.startsWith("//")) return `https:${decoded}`;
	if (decoded.startsWith("http://") || decoded.startsWith("https://")) return decoded;
	return undefined;
}

/** Walk the HTML page and pull out result blocks in document order. DDG renders each result inside a `<div class="result …">` container with */
function parseHtmlResults(html: string): ParsedResult[] {
	const results: ParsedResult[] = [];
	const blockRe =
		/<div\b[^>]*\bclass="[^"]*\bresult\b[^"]*"[^>]*>([\s\S]*?)(?=<div\b[^>]*\bclass="[^"]*\bresult\b|<div\b[^>]*\bclass="[^"]*\bnav-link\b|$)/g;
	const titleRe = /<a\b[^>]*\bclass="[^"]*\bresult__a\b[^"]*"[^>]*\bhref="([^"]+)"[^>]*>([\s\S]*?)<\/a>/;
	const snippetRe = /<(?:a|div|span)\b[^>]*\bclass="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|span)>/;
	for (const match of html.matchAll(blockRe)) {
		const block = match[1];
		const title = titleRe.exec(block);
		if (!title) continue;
		const url = unwrapResultUrl(title[1]);
		if (!url) continue;
		const titleText = decodeHtmlText(title[2]);
		if (!titleText) continue;
		const snippet = snippetRe.exec(block);
		const snippetText = snippet ? decodeHtmlText(snippet[1]) : undefined;
		results.push({ title: titleText, url, snippet: snippetText || undefined });
	}
	return results;
}

/** `true` when the page DDG returned is the bot-challenge modal instead of real results. DDG mixes status codes (200 vs 202) on these so the body */
function isAnomalyResponse(html: string): boolean {
	return html.includes("anomaly-modal") || html.includes("anomaly.js");
}

async function callDuckDuckGoHtml(params: SearchParams): Promise<string> {
	const df = params.recency ? RECENCY_TO_DDG_DF[params.recency] : undefined;

	return withHardTimeout(params.signal, async hardSignal => {
		const page = await browserFetch(
			() => {
				const boundary = "DuckDuckGo search";
				const transform = resolveProviderTextTransform(params.resolveProviderTextTransform, boundary);
				const fields = transformProviderPayload(
					{
						q: params.query,
						kl: "us-en",
						...(df ? { df } : {}),
						// Match the browser form submission shape.
						b: "",
					},
					transform,
					boundary,
				) as Record<string, string>;
				const form = new URLSearchParams(fields);
				return {
					url: transform(DUCKDUCKGO_HTML_URL),
					referer: transform("https://html.duckduckgo.com/"),
					init: {
						method: "POST",
						body: form.toString(),
					},
					headers: transformProviderPayload(
						{ "Content-Type": "application/x-www-form-urlencoded" },
						transform,
						boundary,
					) as Record<string, string>,
				};
			},
			{
				fetch: params.fetch ?? fetch,
				signal: hardSignal,
			},
		);

		const body = page.html;
		if (page.status < 200 || page.status >= 300) {
			const classified = classifyProviderHttpError("duckduckgo", page.status, body);
			if (classified) throw classified;
			throw new SearchProviderError("duckduckgo", `DuckDuckGo HTML error (${page.status})`, page.status);
		}

		if (isAnomalyResponse(body)) {
			throw new SearchProviderError(
				"duckduckgo",
				"DuckDuckGo blocked the request with a bot-detection challenge. DuckDuckGo throttles automated HTML searches from datacenter/shared-egress IPs; configure a credentialed provider such as Brave, Tavily, Exa, or Kagi for reliable web search.",
				429,
			);
		}

		return body;
	});
}

/** Execute a DuckDuckGo web search via the no-JS HTML frontend. */
export async function searchDuckDuckGo(params: SearchParams): Promise<SearchResponse> {
	const numResults = clampNumResults(
		params.numSearchResults ?? params.limit,
		SEARCH_DEFAULT_NUM_RESULTS,
		MAX_NUM_RESULTS,
	);
	const html = await callDuckDuckGoHtml(params);
	const parsed = parseHtmlResults(html);

	const sources: SearchSource[] = [];
	const seen = new Set<string>();
	for (const result of parsed) {
		if (seen.has(result.url)) continue;
		seen.add(result.url);
		sources.push({ title: result.title, url: result.url, snippet: result.snippet });
		if (sources.length >= numResults) break;
	}

	return { provider: "duckduckgo", sources };
}

/** Search provider for DuckDuckGo (no API key required). */
export class DuckDuckGoProvider extends SearchProvider {
	readonly id = "duckduckgo";
	readonly label = "DuckDuckGo";

	isAvailable(_authStorage: AuthStorage): boolean {
		return true;
	}

	isExplicitlyAvailable(_authStorage: AuthStorage): boolean {
		return true;
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchDuckDuckGo(params);
	}
}
