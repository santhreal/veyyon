/**
 * The static desktop browser fingerprint, and nothing else.
 *
 * This module has no imports and must keep none. It exists because `browser-headers.ts` imports
 * `header-generator`, which reads its Bayesian traffic model and a browserslist query at module
 * evaluation and costs about 19ms. Three modules wanted only a User-Agent string from that file:
 * `web/scrapers/types.ts` for the last rung of its bot-block escalation ladder, `perplexity.ts` for
 * its anonymous path, and `browser-headers.ts` itself for the non-randomized fallback. Importing a
 * string constant is enough to evaluate the module that holds it, so `web/scrapers/types.ts` put
 * the whole generator on the session startup path to read one literal.
 *
 * Splitting the literals out keeps `header-generator` on the demand path, where only
 * `buildBrowserNavigationHeaders` needs it. Adding an import here puts it back.
 */

/**
 * The Chrome major version the static fallback fingerprint claims to be.
 *
 * Stated once because a fingerprint has to be internally consistent: the `Sec-Ch-Ua` client hint and the
 * User-Agent both carry the version, and a request whose two version claims disagree is exactly what a bot
 * check looks for. They used to be two independent literals.
 */
const CHROME_FALLBACK_MAJOR_VERSION = "149";

/**
 * The desktop Chrome User-Agent used when a request should look like an ordinary browser.
 *
 * Exported because `perplexity.ts` sends it for its anonymous path and had retyped it, which made a third
 * statement of the browser version that had to agree with the two below.
 */
export const CHROME_DESKTOP_USER_AGENT = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_FALLBACK_MAJOR_VERSION}.0.0.0 Safari/537.36`;

/**
 * The same browser on Windows, for callers that want a different platform rather than a different browser.
 *
 * `web/scrapers/types.ts` uses it as the last rung of its bot-block escalation ladder, after plain curl and a
 * polite bot User-Agent. It had spelled Chrome 131 there while this module claimed 149, so the attempt that has
 * to succeed announced a browser eighteen releases stale, which is what a block keyed on old versions catches.
 */
export const CHROME_WINDOWS_USER_AGENT = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_FALLBACK_MAJOR_VERSION}.0.0.0 Safari/537.36`;

/**
 * A fallback desktop Mac Chrome navigation fingerprint matching the previous static default setup,
 * for deterministic or non-randomized calls.
 */
export const CHROME_FALLBACK_HEADERS: Record<string, string> = {
	Accept:
		"text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
	"Accept-Encoding": "gzip, deflate, br, zstd",
	"Accept-Language": "en-US,en;q=0.9",
	"Cache-Control": "max-age=0",
	Priority: "u=0, i",
	"Sec-Ch-Ua": `"Google Chrome";v="${CHROME_FALLBACK_MAJOR_VERSION}", "Chromium";v="${CHROME_FALLBACK_MAJOR_VERSION}", ";Not A Brand";v="99"`,
	"Sec-Ch-Ua-Mobile": "?0",
	"Sec-Ch-Ua-Platform": '"macOS"',
	"Sec-Fetch-Dest": "document",
	"Sec-Fetch-Mode": "navigate",
	"Sec-Fetch-Site": "none",
	"Sec-Fetch-User": "?1",
	"Upgrade-Insecure-Requests": "1",
	"User-Agent": CHROME_DESKTOP_USER_AGENT,
};
