// Owners, not the `@veyyon/utils` barrel: 2 modules against 74.
import * as logger from "@veyyon/utils/logger";
import { errorMessage } from "@veyyon/utils/type-guards";

/** One credential row, in the shape this package reads it. */
export interface StoredCredential {
	readonly credential:
		| { readonly type: "api_key"; readonly key: string }
		| { readonly type: "oauth"; readonly access: string };
}

/**
 * The credential store, stated as the one method this package calls.
 *
 * The agent's storage handle satisfies it structurally, so a scraper needs neither the handle's
 * class nor the credential package behind it to look a key up.
 */
export interface CredentialStore {
	listAuthCredentials(provider?: string): readonly StoredCredential[];
}

/**
 * Search for an API credential by checking an env-derived key first, then falling back to stored
 * credentials for the given providers.
 *
 * The caller MUST supply an open store so the helper never reaches out to global filesystem state;
 * both the unified web_search chain and one-shot CLI calls open storage exactly once and thread it
 * through every provider.
 *
 * @param store - Open credential store
 * @param envKey - Pre-resolved environment variable value (or null)
 * @param storageProviders - Provider names to look up in the store
 */
export function findCredential(
	store: CredentialStore | null | undefined,
	envKey: string | null | undefined,
	...storageProviders: string[]
): string | null {
	if (envKey) return envKey;
	if (!store) return null;

	try {
		for (const provider of storageProviders) {
			const records = store.listAuthCredentials(provider);
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
