import type { AuthStorage, FetchImpl } from "@veyyon/ai";
import { parseHTML } from "linkedom";
import { resolveProviderTextTransform, transformProviderPayload } from "../../../provider-boundary";
import type { SearchResponse, SearchSource } from "../../../web/search/types";
import { SearchProviderError } from "../../../web/search/types";
import { clampNumResults, collapseWhitespace, SEARCH_DEFAULT_NUM_RESULTS } from "../utils";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import type { LoadedHtmlPage } from "./browser-page";
import { browserFetch } from "./browser-page";
import { classifyProviderHttpError, resolveExternalResultUrl, withHardTimeout } from "./utils";

const STARTPAGE_HOME_URL = "https://www.startpage.com/";

const STARTPAGE_OWN_HOSTS: readonly string[] = ["startpage.com"];
const STARTPAGE_SEARCH_URL = "https://www.startpage.com/sp/search";
const STARTPAGE_TRANSFORM_BOUNDARY = "Startpage search";
const MAX_NUM_RESULTS = 20;

const RECENCY_TO_STARTPAGE_WITH_DATE: Record<NonNullable<SearchParams["recency"]>, string> = {
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

function isChallengeResponse(page: LoadedHtmlPage): boolean {
	if (/\/(?:errors|captcha)\//.test(page.url) || page.url.includes("/sp/captcha")) return true;
	if (page.html.includes("component---src-pages-captcha") || page.html.includes("/sp/captcha")) return true;
	return page.html.includes('id="anubis_challenge"') || page.html.includes('id="anubis_version"');
}

function parseSearchFormInputs(html: string): Record<string, string> | undefined {
	const { document } = parseHTML(html);
	const form = document.querySelector('form[action="/sp/search"]');
	if (!form) return undefined;
	const inputs: Record<string, string> = {};
	for (const input of form.querySelectorAll('input[type="hidden"]')) {
		const name = input.getAttribute("name");
		if (name) inputs[name] = input.getAttribute("value") ?? "";
	}
	return inputs.sc ? inputs : undefined;
}

function sanitizeResultUrl(href: string | null | undefined): string | undefined {
	return resolveExternalResultUrl(href, STARTPAGE_HOME_URL, STARTPAGE_OWN_HOSTS);
}

function parseHtmlResults(html: string): ParsedResult[] {
	const { document } = parseHTML(html);
	const results: ParsedResult[] = [];
	for (const block of document.querySelectorAll("div.result")) {
		const anchor = block.querySelector("a.result-link");
		if (!anchor) continue;
		const url = sanitizeResultUrl(anchor.getAttribute("href"));
		if (!url) continue;
		const title = collapseWhitespace(anchor.querySelector("h2, h3")?.textContent ?? anchor.textContent);
		if (!title) continue;
		const snippet = collapseWhitespace(block.querySelector("p.description")?.textContent);
		results.push({ title, url, snippet: snippet || undefined });
	}
	return results;
}

async function fetchFormInputs(
	fetchImpl: FetchImpl,
	signal: AbortSignal,
	resolveTransform: SearchParams["resolveProviderTextTransform"],
): Promise<Record<string, string> | undefined> {
	let page: LoadedHtmlPage;
	try {
		page = await browserFetch(
			() => {
				const transform = resolveProviderTextTransform(resolveTransform, STARTPAGE_TRANSFORM_BOUNDARY);
				return { url: transform(STARTPAGE_HOME_URL) };
			},
			{ fetch: fetchImpl, signal },
		);
	} catch (error) {
		if (
			error instanceof Error &&
			error.message === `${STARTPAGE_TRANSFORM_BOUNDARY} confidentiality transform failed.`
		) {
			throw error;
		}
		if (signal.aborted) throw error;
		return undefined;
	}
	if (page.status < 200 || page.status >= 300 || isChallengeResponse(page)) return undefined;
	return parseSearchFormInputs(page.html);
}

async function callStartpageHtml(params: SearchParams): Promise<string> {
	return withHardTimeout(params.signal, async signal => {
		const fetchImpl = params.fetch ?? fetch;
		const withDate = params.recency ? RECENCY_TO_STARTPAGE_WITH_DATE[params.recency] : undefined;

		const formInputs = await fetchFormInputs(fetchImpl, signal, params.resolveProviderTextTransform);
		let page: LoadedHtmlPage;
		if (formInputs) {
			page = await browserFetch(
				() => {
					const transform = resolveProviderTextTransform(
						params.resolveProviderTextTransform,
						STARTPAGE_TRANSFORM_BOUNDARY,
					);
					const fields = transformProviderPayload(
						{
							...formInputs,
							query: params.query,
							...(withDate ? { with_date: withDate } : {}),
						},
						transform,
						STARTPAGE_TRANSFORM_BOUNDARY,
					) as Record<string, string>;
					const form = new URLSearchParams(fields);
					return {
						url: transform(STARTPAGE_SEARCH_URL),
						referer: transform(STARTPAGE_HOME_URL),
						init: { method: "POST", body: form.toString() },
						headers: transformProviderPayload(
							{ "Content-Type": "application/x-www-form-urlencoded" },
							transform,
							STARTPAGE_TRANSFORM_BOUNDARY,
						) as Record<string, string>,
					};
				},
				{
					fetch: fetchImpl,
					signal,
				},
			);
		} else {
			page = await browserFetch(
				() => {
					const transform = resolveProviderTextTransform(
						params.resolveProviderTextTransform,
						STARTPAGE_TRANSFORM_BOUNDARY,
					);
					const fields = transformProviderPayload(
						{
							query: params.query,
							...(withDate ? { with_date: withDate } : {}),
						},
						transform,
						STARTPAGE_TRANSFORM_BOUNDARY,
					) as Record<string, string>;
					const url = new URL(transform(STARTPAGE_SEARCH_URL));
					for (const [key, value] of Object.entries(fields)) url.searchParams.set(key, value);
					return {
						url: url.href,
						referer: transform(STARTPAGE_HOME_URL),
					};
				},
				{
					fetch: fetchImpl,
					signal,
				},
			);
		}

		if (isChallengeResponse(page)) {
			throw new SearchProviderError(
				"startpage",
				"Startpage blocked the request with a CAPTCHA challenge. Startpage rate-limits automated searches from datacenter/shared-egress IPs; try another provider such as DuckDuckGo or Mojeek, or retry later.",
				429,
			);
		}
		if (page.status < 200 || page.status >= 300) {
			const classified = classifyProviderHttpError("startpage", page.status, page.html);
			if (classified) throw classified;
			throw new SearchProviderError("startpage", `Startpage HTML error (${page.status})`, page.status);
		}
		return page.html;
	});
}

export async function searchStartpage(params: SearchParams): Promise<SearchResponse> {
	const numResults = clampNumResults(
		params.numSearchResults ?? params.limit,
		SEARCH_DEFAULT_NUM_RESULTS,
		MAX_NUM_RESULTS,
	);
	const html = await callStartpageHtml(params);
	const parsed = parseHtmlResults(html);

	const sources: SearchSource[] = [];
	const seen = new Set<string>();
	for (const result of parsed) {
		if (seen.has(result.url)) continue;
		seen.add(result.url);
		sources.push({ title: result.title, url: result.url, snippet: result.snippet });
		if (sources.length >= numResults) break;
	}

	return { provider: "startpage", sources };
}

export class StartpageProvider extends SearchProvider {
	readonly id = "startpage";
	readonly label = "Startpage";

	isAvailable(_authStorage: AuthStorage): boolean {
		return true;
	}

	isExplicitlyAvailable(_authStorage: AuthStorage): boolean {
		return true;
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchStartpage(params);
	}
}
