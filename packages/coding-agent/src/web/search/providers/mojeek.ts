import type { AuthStorage } from "@veyyon/ai";
import { errorMessage, untilAborted } from "@veyyon/utils";
import { parseHTML } from "linkedom";
import type { Page } from "puppeteer-core";
import { resolveProviderTextTransform, transformProviderPayload } from "../../../provider-boundary";
import type { SearchResponse, SearchSource } from "../../../web/search/types";
import { SearchProviderError } from "../../../web/search/types";
import { clampNumResults, collapseWhitespace, SEARCH_DEFAULT_NUM_RESULTS } from "../utils";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import type { LoadedHtmlPage } from "./browser-page";
import { browserFetch } from "./browser-page";
import { classifyProviderHttpError, resolveExternalResultUrl, withHardTimeout } from "./utils";

const MOJEEK_ORIGIN = "https://www.mojeek.de";
const MOJEEK_HOME_URL = `${MOJEEK_ORIGIN}/?arc=none&lang=en&lb=en&theme=dark`;

const MOJEEK_OWN_HOSTS: readonly string[] = ["mojeek.com", "mojeek.co.uk", "mojeek.fr", "mojeek.de"];
const MOJEEK_SEARCH_URL = `${MOJEEK_ORIGIN}/search`;
const MAX_NUM_RESULTS = 20;
const CAPTCHA_SOLVE_TIMEOUT_MS = 45_000;

interface ParsedResult {
	title: string;
	url: string;
	snippet?: string;
}

function normalizeResultUrl(href: string): string | undefined {
	return resolveExternalResultUrl(href, MOJEEK_HOME_URL, MOJEEK_OWN_HOSTS);
}

function parseHtmlResults(html: string): ParsedResult[] {
	const { document } = parseHTML(html);
	const results: ParsedResult[] = [];
	for (const item of document.querySelectorAll("ul.results-standard > li")) {
		const anchor = item.querySelector("h2 a.title") ?? item.querySelector("a.title");
		const href = anchor?.getAttribute("href");
		if (!href) continue;
		const url = normalizeResultUrl(href);
		if (!url) continue;
		const title = collapseWhitespace(anchor?.textContent);
		if (!title) continue;
		const snippet = collapseWhitespace(item.querySelector("p.s")?.textContent);
		results.push({ title, url, snippet: snippet || undefined });
	}
	return results;
}

function buildSearchAttempt(params: SearchParams, numResults: number): { url: string; referer: string } {
	const boundary = "Mojeek search";
	const transform = resolveProviderTextTransform(params.resolveProviderTextTransform, boundary);
	const fields = transformProviderPayload(
		{
			q: params.query,
			t: String(numResults),
			arc: "none",
			lang: "en",
			lb: "en",
			theme: "dark",
			...(params.recency ? { since: params.recency } : {}),
		},
		transform,
		boundary,
	) as Record<string, string>;
	const url = new URL(transform(MOJEEK_SEARCH_URL));
	for (const [key, value] of Object.entries(fields)) url.searchParams.set(key, value);
	return {
		url: url.href,
		referer: transform(MOJEEK_HOME_URL),
	};
}

async function solveCaptcha(page: Page, signal: AbortSignal): Promise<void> {
	if (await untilAborted(signal, () => page.$("ul.results-standard li"))) return;

	const checkbox = await untilAborted(signal, () => page.$("altcha-widget input[type=checkbox]"));
	if (!checkbox) return;

	const navigation = page
		.waitForNavigation({ waitUntil: "domcontentloaded", timeout: CAPTCHA_SOLVE_TIMEOUT_MS })
		.catch(() => null);
	await untilAborted(signal, () => checkbox.click());
	await untilAborted(signal, () => navigation);
	await untilAborted(signal, () =>
		page.waitForSelector("ul.results-standard li", { timeout: CAPTCHA_SOLVE_TIMEOUT_MS }).catch(() => null),
	);
}

function isRobotPage(page: LoadedHtmlPage): boolean {
	return (
		(page.html.includes("altcha-widget") ||
			page.html.includes("captcha-wrap") ||
			/sending automated queries/i.test(page.html)) &&
		!page.html.includes("results-standard")
	);
}

async function callMojeekHtml(params: SearchParams, numResults: number): Promise<string> {
	return withHardTimeout(params.signal, async signal => {
		let page: LoadedHtmlPage;
		try {
			page = await browserFetch(() => buildSearchAttempt(params, numResults), {
				fetch: params.fetch,
				signal,
				randomizeHeaders: false,
				browser: {
					homeUrl: () => {
						const transform = resolveProviderTextTransform(params.resolveProviderTextTransform, "Mojeek search");
						return transform(MOJEEK_HOME_URL);
					},
					afterNavigation: solveCaptcha,
					shouldFallback: isRobotPage,
					attempts: 2,
					retryDelayMs: 1_000,
				},
			});
		} catch (error) {
			if (error instanceof SearchProviderError || params.signal?.aborted) throw error;
			if (signal.aborted) {
				throw new SearchProviderError("mojeek", "Mojeek search timed out.", 504);
			}
			const message = errorMessage(error);
			throw new SearchProviderError("mojeek", `Mojeek search failed: ${message}`, 503);
		}

		if (isRobotPage(page)) {
			throw new SearchProviderError(
				"mojeek",
				"Mojeek blocked the request with its automated-queries wall. Mojeek rate-limits scripted searches from datacenter/shared-egress IPs; retry later or configure another provider such as Brave, Tavily, Exa, or Kagi.",
				429,
			);
		}
		if (page.status < 200 || page.status >= 300) {
			const classified = classifyProviderHttpError("mojeek", page.status, page.html);
			if (classified) throw classified;
			throw new SearchProviderError("mojeek", `Mojeek HTML error (${page.status})`, page.status);
		}
		return page.html;
	});
}

export async function searchMojeek(params: SearchParams): Promise<SearchResponse> {
	const numResults = clampNumResults(
		params.numSearchResults ?? params.limit,
		SEARCH_DEFAULT_NUM_RESULTS,
		MAX_NUM_RESULTS,
	);
	const html = await callMojeekHtml(params, numResults);
	const parsed = parseHtmlResults(html);

	const sources: SearchSource[] = [];
	const seen = new Set<string>();
	for (const result of parsed) {
		if (seen.has(result.url)) continue;
		seen.add(result.url);
		sources.push({ title: result.title, url: result.url, snippet: result.snippet });
		if (sources.length >= numResults) break;
	}

	return { provider: "mojeek", sources };
}

export class MojeekProvider extends SearchProvider {
	readonly id = "mojeek";
	readonly label = "Mojeek";

	isAvailable(_authStorage: AuthStorage): boolean {
		return true;
	}

	isExplicitlyAvailable(_authStorage: AuthStorage): boolean {
		return true;
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchMojeek(params);
	}
}
