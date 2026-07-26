import * as imageGen from "../tools/image-gen";
// The LEAVES that own these, not the `../web/search` barrel. The barrel is the
// search tool: it reaches 426 modules, including the theme engine, and this file
// applies three settings. `./provider` and `./types` reach four between them.
import { setExcludedSearchProviders, setPreferredSearchProvider } from "../web/search/provider";
import { isSearchProviderId, isSearchProviderPreference } from "../web/search/types";

interface ProviderGlobalSettings {
	get(path: "providers.webSearchExclude"): unknown;
	get(path: "providers.webSearch"): unknown;
	get(path: "providers.image"): unknown;
}

export function applyProviderGlobalsFromSettings(settings: ProviderGlobalSettings): void {
	const excludedWebSearchProviders = settings.get("providers.webSearchExclude");
	if (Array.isArray(excludedWebSearchProviders)) {
		setExcludedSearchProviders(excludedWebSearchProviders.filter(isSearchProviderId));
	}

	const webSearchProvider = settings.get("providers.webSearch");
	if (typeof webSearchProvider === "string" && isSearchProviderPreference(webSearchProvider)) {
		setPreferredSearchProvider(webSearchProvider);
	}

	const imageProvider = settings.get("providers.image");
	if (imageGen.isImageProviderPreference(imageProvider)) {
		imageGen.setPreferredImageProvider(imageProvider);
	}
}
