import * as logger from "@veyyon/utils/logger";
import { errorMessage } from "@veyyon/utils/type-guards";
import type { AgentStorage } from "../../../session/agent-storage";
import { scopedTimeoutSignal } from "../../../utils/fetch-timeout";
import { SearchProviderError, type SearchProviderId, type SearchSource } from "../../../web/search/types";
import { dateToAgeSeconds } from "../utils";

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
		reportCredentialLookupFailure(storageProviders, err);
		return null;
	}

	return null;
}

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

export const SEARCH_HARD_TIMEOUT_MS = 60_000;

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

export function resolveExternalResultUrl(
	href: string | null | undefined,
	baseUrl: string,
	ownHosts: readonly string[],
): string | undefined {
	const url = parseResultUrl(href, baseUrl);
	return url && isExternalHttpUrl(url, ownHosts) ? url.href : undefined;
}

export function parseResultUrl(href: string | null | undefined, baseUrl: string): URL | undefined {
	if (!href) return undefined;
	try {
		return new URL(href, baseUrl);
	} catch {
		return undefined;
	}
}

export function isExternalHttpUrl(url: URL, ownHosts: readonly string[]): boolean {
	if (url.protocol !== "http:" && url.protocol !== "https:") return false;
	return !ownHosts.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`));
}
