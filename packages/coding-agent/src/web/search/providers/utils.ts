import * as logger from "@veyyon/utils/logger";
import { errorMessage } from "@veyyon/utils/type-guards";
import type { AgentStorage } from "../../../session/agent-storage";
import { scopedTimeoutSignal } from "../../../utils/fetch-timeout";
import { SearchProviderError, type SearchProviderId, type SearchSource } from "../../../web/search/types";
import { dateToAgeSeconds } from "../utils";

/** Search for an API credential by checking an env-derived key first, then falling back to agent.db stored credentials for the given providers. */
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
		// A credential store that cannot be QUERIED is not a store with no credential in it, and the caller cannot tell the difference: null makes the provider report itself unavailable, so a search key the
		reportCredentialLookupFailure(storageProviders, err);
		return null;
	}

	return null;
}

/** Providers already reported, so a broken store is named once rather than on every search. This runs per search per provider, and the failure it reports is a property of the store rather than */
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

/** Default hard ceiling for a single web-search round-trip. 60s tolerates legitimate slow LLM-mediated responses (anthropic web_search_20250305, */
export const SEARCH_HARD_TIMEOUT_MS = 60_000;

/** Run a provider request under a caller signal composed with a hard timeout, so the outbound `fetch()` (and the body read after it) is guaranteed to */
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

/** Map a provider's raw source list to the unified SearchSource shape, clamped to the requested result count and annotated with ageSeconds. */
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

/** Quota/auth signals across providers. Telemetry on 15.1.7/15.1.8 showed users hitting credit-exhaustion and 401/402/403 responses that were surfaced as */
// Credit/quota exhaustion phrasing varies across providers ("credits are exhausted", "you have exhausted your credits", "credit limit exceeded", "out of
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

/** Turn a scraped result anchor into an external target URL, or `undefined` when it is not one. This is the ONE owner of the rule every HTML search provider applies to its result anchors: resolve */
export function resolveExternalResultUrl(
	href: string | null | undefined,
	baseUrl: string,
	ownHosts: readonly string[],
): string | undefined {
	const url = parseResultUrl(href, baseUrl);
	return url && isExternalHttpUrl(url, ownHosts) ? url.href : undefined;
}

/** Parse a result href against a base, or `undefined` when it is not a URL at all. Separate from {@link resolveExternalResultUrl} for the one provider that needs the parsed URL before */
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
