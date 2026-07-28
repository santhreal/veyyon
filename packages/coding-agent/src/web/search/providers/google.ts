import type { AuthStorage } from "@veyyon/ai";
import { errorMessage } from "@veyyon/utils";
import { parseHTML } from "linkedom";
import { resolveProviderTextTransform, transformProviderPayload } from "../../../provider-boundary";
import type { SearchResponse, SearchSource } from "../../../web/search/types";
import { SearchProviderError } from "../../../web/search/types";
import { clampNumResults, collapseWhitespace, SEARCH_DEFAULT_NUM_RESULTS } from "../utils";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import type { LoadedHtmlPage } from "./browser-page";
import { browserFetch } from "./browser-page";
import { isExternalHttpUrl, parseResultUrl, withHardTimeout } from "./utils";

const GOOGLE_HOME_URL = "https://www.google.com/";

/** Hosts that belong to the engine itself, so a link back into it is not a result. Matched as the host or any subdomain. */
const GOOGLE_OWN_HOSTS: readonly string[] = ["google.com"];
const GOOGLE_SEARCH_URL = "https://www.google.com/search";
const MAX_NUM_RESULTS = 20;

const RECENCY_TO_GOOGLE_TBS: Record<NonNullable<SearchParams["recency"]>, string> = {
	day: "qdr:d",
	week: "qdr:w",
	month: "qdr:m",
	year: "qdr:y",
};
const GOOGLE_SNIPPET_SELECTORS: readonly string[] = [
	"[data-sncf='1'] .VwiC3b",
	".VwiC3b",
	".IsZvec",
	".BNeawe.s3v9rd",
	"[data-sncf='1']",
];

interface ParsedResult {
	title: string;
	url: string;
	snippet?: string;
}

function unwrapResultUrl(href: string): string | undefined {
	let url = parseResultUrl(href, GOOGLE_HOME_URL);
	if (!url) return undefined;

	// Google routes clicks through `/url?q=<target>`, so the wrapper has to be opened before the host rule
	// can be applied -- otherwise every result reads as a link back to google.com and is rejected.
	if (isGoogleHost(url.hostname) && url.pathname === "/url") {
		const target = url.searchParams.get("q") || url.searchParams.get("url");
		const unwrapped = parseResultUrl(target, GOOGLE_HOME_URL);
		if (!unwrapped) return undefined;
		url = unwrapped;
	}

	return isExternalHttpUrl(url, GOOGLE_OWN_HOSTS) ? url.href : undefined;
}

/** Whether a hostname is Google's own, for the redirect-wrapper check above. */
function isGoogleHost(hostname: string): boolean {
	return GOOGLE_OWN_HOSTS.some(host => hostname === host || hostname.endsWith(`.${host}`));
}

function findSnippet(heading: Element): string | undefined {
	const container = heading.closest(".tF2Cxc, .MjjYud, .Gx5Zad") ?? heading.parentElement?.parentElement;
	if (!container) return undefined;

	for (const selector of GOOGLE_SNIPPET_SELECTORS) {
		const text = collapseWhitespace(container.querySelector(selector)?.textContent).replace(/\s*Read more$/i, "");
		if (text) return text;
	}
	return undefined;
}

function parseHtmlResults(html: string): ParsedResult[] {
	const { document } = parseHTML(html);
	const results: ParsedResult[] = [];
	for (const heading of document.querySelectorAll("h3")) {
		const anchor = heading.closest("a");
		const href = anchor?.getAttribute("href");
		if (!href) continue;
		const url = unwrapResultUrl(href);
		if (!url) continue;
		const title = collapseWhitespace(heading.textContent);
		if (!title) continue;
		results.push({ title, url, snippet: findSnippet(heading) });
	}
	return results;
}

function buildSearchAttempt(params: SearchParams, numResults: number): { url: string; referer: string } {
	const boundary = "Google search";
	const transform = resolveProviderTextTransform(params.resolveProviderTextTransform, boundary);
	const tbs = params.recency ? RECENCY_TO_GOOGLE_TBS[params.recency] : undefined;
	const fields = transformProviderPayload(
		{
			q: params.query,
			num: String(numResults),
			hl: "en",
			gl: "us",
			udm: "14",
			pws: "0",
			...(tbs ? { tbs } : {}),
		},
		transform,
		boundary,
	) as Record<string, string>;
	const url = new URL(transform(GOOGLE_SEARCH_URL));
	for (const [key, value] of Object.entries(fields)) url.searchParams.set(key, value);
	return {
		url: url.href,
		referer: transform(GOOGLE_HOME_URL),
	};
}

function blockReason(page: LoadedHtmlPage): "javascript" | "traffic" | undefined {
	if (page.html.includes("/httpservice/retry/enablejs") && !/<h3\b/i.test(page.html)) return "javascript";
	if (
		page.status === 403 ||
		page.status === 429 ||
		page.url.includes("/sorry/") ||
		/unusual traffic|detected unusual traffic|g-recaptcha/i.test(page.html)
	) {
		return "traffic";
	}
	return undefined;
}

async function callGoogleHtml(params: SearchParams, numResults: number): Promise<string> {
	return withHardTimeout(params.signal, async signal => {
		let page: LoadedHtmlPage;
		try {
			page = await browserFetch(() => buildSearchAttempt(params, numResults), {
				fetch: params.fetch,
				signal,
				browser: {
					homeUrl: () => {
						const transform = resolveProviderTextTransform(
							params.resolveProviderTextTransform,
							"Google search",
						);
						return transform(GOOGLE_HOME_URL);
					},
					ready: { selector: "a h3" },
					shouldFallback: candidate => blockReason(candidate) !== undefined,
				},
			});
		} catch (error) {
			if (error instanceof SearchProviderError || params.signal?.aborted) throw error;
			if (signal.aborted) {
				throw new SearchProviderError("google", "Google browser search timed out.", 504);
			}
			const message = errorMessage(error);
			throw new SearchProviderError("google", `Google browser search failed: ${message}`, 503);
		}

		const blocked = blockReason(page);
		if (blocked === "traffic") {
			throw new SearchProviderError(
				"google",
				"Google blocked the browser search with an automated-traffic challenge. Try another web search provider or retry later.",
				429,
			);
		}
		if (page.status < 200 || page.status >= 300) {
			throw new SearchProviderError("google", `Google HTML error (${page.status})`, page.status);
		}
		if (blocked === "javascript") {
			throw new SearchProviderError(
				"google",
				"Google returned its JavaScript challenge instead of rendered search results.",
				429,
			);
		}
		return page.html;
	});
}

/** Execute a Google web search with fetch-first loading and a headless-browser fallback. */
export async function searchGoogle(params: SearchParams): Promise<SearchResponse> {
	const numResults = clampNumResults(
		params.numSearchResults ?? params.limit,
		SEARCH_DEFAULT_NUM_RESULTS,
		MAX_NUM_RESULTS,
	);
	const html = await callGoogleHtml(params, numResults);
	const parsed = parseHtmlResults(html);

	const sources: SearchSource[] = [];
	const seen = new Set<string>();
	for (const result of parsed) {
		if (seen.has(result.url)) continue;
		seen.add(result.url);
		sources.push({ title: result.title, url: result.url, snippet: result.snippet });
		if (sources.length >= numResults) break;
	}

	return { provider: "google", sources };
}

/** Fetch-first Google Search provider with a headless-browser fallback; no API key is required. */
export class GoogleProvider extends SearchProvider {
	readonly id = "google";
	readonly label = "Google";

	isAvailable(_authStorage: AuthStorage): boolean {
		return true;
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchGoogle(params);
	}
}
