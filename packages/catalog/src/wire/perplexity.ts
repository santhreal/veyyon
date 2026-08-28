export const PERPLEXITY_WEB_ORIGIN = "https://www.perplexity.ai";

export const PERPLEXITY_NATIVE_APP_BUNDLE_ID = "ai.perplexity.mac";

export const PERPLEXITY_NATIVE_APP_USER_AGENT = "Perplexity/641 CFNetwork/1568 Darwin/25.2.0";

export const PERPLEXITY_NATIVE_APP_API_VERSION = "2.18";

export const PERPLEXITY_HEADERS = {
	API_VERSION: "X-App-ApiVersion",
	API_CLIENT: "X-App-ApiClient",
	REQUEST_ID: "X-Request-ID",
	REQUEST_REASON: "X-Perplexity-Request-Reason",
} as const;

export const PERPLEXITY_NATIVE_APP_HEADERS: Readonly<Record<string, string>> = {
	"User-Agent": PERPLEXITY_NATIVE_APP_USER_AGENT,
	[PERPLEXITY_HEADERS.API_VERSION]: PERPLEXITY_NATIVE_APP_API_VERSION,
};
