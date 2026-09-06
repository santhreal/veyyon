import { SearchProviderError, type SearchProviderId, type SearchSource } from "../types";
import { dateToAgeSeconds } from "../utils";

/**
 * Map a provider's raw source list to the unified SearchSource shape,
 * clamped to the requested result count and annotated with ageSeconds.
 */
export function toSearchSources(
	sources: ReadonlyArray<{
		title: string;
		url: string;
		snippet?: string;
		publishedDate?: string;
	}>,
	numResults: number,
	options?: { deduplicate?: boolean },
): SearchSource[] {
	if (!options?.deduplicate) {
		return sources.slice(0, numResults).map(source => ({
			title: source.title,
			url: source.url,
			snippet: source.snippet,
			publishedDate: source.publishedDate,
			ageSeconds: dateToAgeSeconds(source.publishedDate),
		}));
	}
	const max = Math.max(0, Math.floor(numResults) || 0);
	if (max === 0) return [];
	const out: SearchSource[] = [];
	const seen = new Set<string>();
	for (const source of sources) {
		if (seen.has(source.url)) continue;
		seen.add(source.url);
		out.push({
			title: source.title,
			url: source.url,
			snippet: source.snippet,
			publishedDate: source.publishedDate,
			ageSeconds: dateToAgeSeconds(source.publishedDate),
		});
		if (out.length >= max) break;
	}
	return out;
}

/**
 * Quota/auth signals across providers. Telemetry on 15.1.7/15.1.8 showed users
 * hitting credit-exhaustion and 401/402/403 responses that were surfaced as
 * raw HTTP error text. Map those into compact, provider-tagged messages so
 * the orchestrator can chain-advance cleanly and the final summary stays
 * legible when every provider rejects the request.
 *
 * Returns `null` when the response does not match a known quota/auth signal,
 * leaving the caller to throw its provider-specific fallback error.
 */
// Credit/quota exhaustion phrasing varies across providers ("credits are
// exhausted", "you have exhausted your credits", "credit limit exceeded", "out of
// credits"), so match the strong standalone signals (quota / insufficient /
// exhausted / depleted / out of credits) plus "credit(s)" within a short window of
// exhausted/exceeded/depleted in either order. The short window and the deliberate
// omission of a bare "exceeded"/"credits" keep benign bodies ("you have 5 credits
// left", "rate limit exceeded", "credits: 42 remaining") from misclassifying.
const CREDIT_BODY_PATTERN =
	/quota|insufficient|exhausted|depleted|out\s+of\s+credits?|credits?[\s\S]{0,20}?(?:exhausted|exceeded|depleted)|(?:exhausted|exceeded|depleted)[\s\S]{0,20}?credits?/i;

export function classifyProviderHttpError(
	provider: SearchProviderId,
	status: number,
	body: string,
): SearchProviderError | null {
	if (CREDIT_BODY_PATTERN.test(body)) {
		return new SearchProviderError(provider, `${provider}: credits exhausted`, status);
	}
	if (status === 402) {
		return new SearchProviderError(provider, `${provider}: 402 credits exhausted`, status);
	}
	if (status === 401) {
		return new SearchProviderError(provider, `${provider}: 401 unauthorized`, status);
	}
	if (status === 403) {
		return new SearchProviderError(provider, `${provider}: 403 forbidden`, status);
	}
	return null;
}

/**
 * Turn a scraped result anchor into an external target URL, or `undefined` when it is not one.
 *
 * This is the ONE owner of the rule every HTML search provider applies to its result anchors: resolve
 * the href against the engine's own home page, require http(s), and reject links that point back at the
 * engine. The HTML engines each had a byte-identical copy of it differing only in the host
 * list, which is how the three drifted into checking hosts three different ways -- one spelled `www.`
 * out, one matched subdomains, one did both -- for no reason anyone chose. Subdomain matching is the
 * rule here, so `images.<engine>` and `www.<engine>` are both rejected everywhere.
 *
 * `undefined` carries no failure. A page mixes navigation, verticals and paging rows into the same
 * markup as results, so most anchors offered here are legitimately not results, and an href that will
 * not parse is one of those: the throw IS the answer. Rejecting is also the safe direction, since the
 * URL that survives is handed to a fetch.
 */
export function resolveExternalResultUrl(
	href: string | null | undefined,
	baseUrl: string,
	ownHosts: readonly string[],
): string | undefined {
	const url = parseResultUrl(href, baseUrl);
	return url && isExternalHttpUrl(url, ownHosts) ? url.href : undefined;
}

/**
 * Parse a result href against a base, or `undefined` when it is not a URL at all.
 *
 * Separate from {@link resolveExternalResultUrl} for the one provider that needs the parsed URL before
 * the host rule can be applied: Google routes clicks through `/url?q=<target>`, so it has to look at the
 * wrapper before deciding what the target even is.
 */
export function parseResultUrl(href: string | null | undefined, baseUrl: string): URL | undefined {
	if (!href) return undefined;
	try {
		return new URL(href, baseUrl);
	} catch {
		// Not a URL, so not a result. See {@link resolveExternalResultUrl} on why this is not a failure.
		return undefined;
	}
}

/** Whether a parsed result URL is an http(s) link pointing away from the engine's own hosts. */
export function isExternalHttpUrl(url: URL, ownHosts: readonly string[]): boolean {
	if (url.protocol !== "http:" && url.protocol !== "https:") return false;
	return !ownHosts.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`));
}
