// Owners, not the `@veyyon/utils` barrel: 2 modules against 74.
import * as logger from "@veyyon/utils/logger";
import { errorMessage } from "@veyyon/utils/type-guards";
import type { AgentStorage } from "../../../session/agent-storage";
import { scopedTimeoutSignal } from "../../../utils/fetch-timeout";
import { SearchProviderError, type SearchProviderId, type SearchSource } from "../../../web/search/types";
import { dateToAgeSeconds } from "../utils";

/**
 * Search for an API credential by checking an env-derived key first,
 * then falling back to agent.db stored credentials for the given providers.
 *
 * The caller MUST supply an open {@link AgentStorage} handle so the helper
 * never reaches out to global filesystem state; both the unified web_search
 * chain and one-shot CLI calls open storage exactly once and thread it
 * through every provider.
 *
 * @param storage - Open agent storage handle
 * @param envKey - Pre-resolved environment variable value (or null)
 * @param storageProviders - Provider names to look up in AgentStorage
 */
export function findCredential(
	storage: AgentStorage | null | undefined,
	envKey: string | null | undefined,
	...storageProviders: string[]
): string | null {
	if (envKey) return envKey;
	if (!storage) return null;

	try {
		for (const provider of storageProviders) {
			const records = storage.listAuthCredentials(provider);
			for (const record of records) {
				const credential = record.credential;
				if (credential.type === "api_key" && credential.key.trim().length > 0) {
					return credential.key;
				}
				if (credential.type === "oauth" && credential.access.trim().length > 0) {
					return credential.access;
				}
			}
		}
	} catch (err) {
		// A credential store that cannot be QUERIED is not a store with no credential in it, and the caller
		// cannot tell the difference: null makes the provider report itself unavailable, so a search key the
		// user configured and pays for silently drops out of the chain and the search quietly runs on whatever
		// is left. Null is still returned, because one unreadable store must not fail the whole search.
		reportCredentialLookupFailure(storageProviders, err);
		return null;
	}

	return null;
}

/**
 * Providers already reported, so a broken store is named once rather than on every search.
 *
 * This runs per search per provider, and the failure it reports is a property of the store rather than
 * of the query, so repeating it would bury everything else in the log without adding anything.
 */
const reportedCredentialLookupFailures = new Set<string>();

function reportCredentialLookupFailure(storageProviders: string[], error: unknown): void {
	const key = storageProviders.join(",");
	if (reportedCredentialLookupFailures.has(key)) return;
	reportedCredentialLookupFailures.add(key);
	logger.warn("Stored search credentials could not be read; these providers will look unconfigured", {
		providers: key,
		error: errorMessage(error),
	});
}

/**
 * Default hard ceiling for a single web-search round-trip. 60s tolerates
 * legitimate slow LLM-mediated responses (anthropic web_search_20250305,
 * perplexity, gemini, codex) while still guaranteeing the session unfreezes
 * within a minute if Bun's `AbortSignal` fails to propagate on Windows.
 *
 * Pure search APIs (brave, exa, jina, tavily, searxng, synthetic, zai)
 * settle far faster in practice; reusing the same ceiling keeps the wiring
 * uniform without compromising correctness.
 */
export const SEARCH_HARD_TIMEOUT_MS = 60_000;

/**
 * Run a provider request under a caller signal composed with a hard timeout,
 * so the outbound `fetch()` (and the body read after it) is guaranteed to
 * settle within `ms` even when the runtime fails to propagate cancellation to
 * the underlying transport. The backing timer is cleared the moment `fn`
 * settles, so no armed timeout outlives the request.
 *
 * Bun's WinHTTP backend on Windows is known to ignore `AbortSignal` once a
 * TCP/TLS connection stalls (oven-sh/bun#15275, oven-sh/bun#18536); without
 * this safety net a stalled web-search request freezes the entire session
 * because the user's Esc is never delivered to the native layer.
 *
 * @param signal - Caller cancellation signal, if any.
 * @param ms - Hard timeout in milliseconds. Defaults to {@link SEARCH_HARD_TIMEOUT_MS}.
 */
export async function withHardTimeout<T>(
	signal: AbortSignal | undefined,
	fn: (signal: AbortSignal) => Promise<T>,
	ms: number = SEARCH_HARD_TIMEOUT_MS,
): Promise<T> {
	const timeout = scopedTimeoutSignal(ms, signal);
	try {
		return await fn(timeout.signal);
	} finally {
		timeout.cancel();
	}
}

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
): SearchSource[] {
	return sources.slice(0, numResults).map(source => ({
		title: source.title,
		url: source.url,
		snippet: source.snippet,
		publishedDate: source.publishedDate,
		ageSeconds: dateToAgeSeconds(source.publishedDate),
	}));
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
 * engine. Ecosia, Mojeek and Startpage each had a byte-identical copy of it differing only in the host
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
