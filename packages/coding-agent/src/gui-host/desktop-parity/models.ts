/**
 * The providers the terminal can sign in to and pick a model from, and the
 * carrier that reaches each from the desktop.
 *
 * A provider is carried when the host lists it in the `Providers` section and
 * its login kind has a carrier: the window starts the login with
 * `StartProviderAuth`, answers each prompt with `SubmitAuthSecret`, opens the
 * login URL with `OpenAuthUrl`, stops it with `CancelAuthFlow`, and then picks
 * the provider's models from the `Models` section with `SelectModel`.
 */
import { getOAuthProviders } from "@veyyon/ai/oauth";
import { PROVIDER_REGISTRY } from "@veyyon/ai/registry";
import { CATALOG_PROVIDERS } from "@veyyon/catalog/provider-models/descriptors";
import type { DesktopCarrier } from "./carrier";

/** Every provider id the OAuth list, the provider registry and the catalog declare, less `disabled`. Sorted. */
export function terminalProviderIds(disabled: ReadonlySet<string>): string[] {
	const ids = new Set<string>();
	for (const provider of getOAuthProviders()) ids.add(provider.id);
	for (const provider of PROVIDER_REGISTRY) ids.add(provider.id);
	for (const provider of CATALOG_PROVIDERS) ids.add(provider.id);
	return [...ids].filter(id => !disabled.has(id)).sort();
}

/**
 * How a provider signs in: the OAuth list's credential kind (`oauth` or
 * `api-key`), `registry-login` for a registry login the OAuth list omits, or
 * `key-paste` for a provider with no login, whose key the host prompts for.
 */
export function providerLoginKind(id: string): string {
	const listed = getOAuthProviders().find(provider => provider.id === id);
	if (listed) return listed.credential;
	if (PROVIDER_REGISTRY.some(provider => provider.id === id && provider.login !== undefined)) return "registry-login";
	return "key-paste";
}

export const PROVIDER_LOGIN_CARRIERS: Readonly<Record<string, DesktopCarrier>> = {
	/** Browser or device login: `AuthFlow` holds the URL and instructions; a pasted code goes back through `SubmitAuthSecret`. */
	oauth: { action: "StartProviderAuth" },
	/** A login that prompts for a key: the host raises the prompt in `AuthFlow` and resolves it from `SubmitAuthSecret`. */
	"api-key": { action: "SubmitAuthSecret" },
	/** A provider with no login: the host stores the key `SubmitAuthSecret` sends. */
	"key-paste": { action: "SubmitAuthSecret" },
};

/** Providers the desktop does not list or cannot sign in to, with the user-facing impact. */
export const PROVIDER_GAPS: Readonly<Record<string, DesktopCarrier>> = {};

/** The carrier for one provider: its recorded gap, else its login kind's carrier, else none. */
export function providerCarrier(id: string): DesktopCarrier | undefined {
	return PROVIDER_GAPS[id] ?? PROVIDER_LOGIN_CARRIERS[providerLoginKind(id)];
}
