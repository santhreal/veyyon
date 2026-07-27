import { HeaderGenerator } from "header-generator";

// Lazily instantiate the singleton header generator. Bun single-file binaries do not
// bundle header-generator's fs-loaded data_files, so construction may throw when the
// original build-time node_modules path is absent.
let generator: HeaderGenerator | undefined;
let generatorUnavailable = false;

function getHeaderGenerator(): HeaderGenerator | undefined {
	if (generatorUnavailable) return undefined;
	try {
		generator ??= new HeaderGenerator({
			browserListQuery: "last 3 versions",
			devices: ["desktop"],
			operatingSystems: ["windows", "macos", "linux"],
			locales: ["en-US", "en"],
			httpVersion: "2",
			strict: false,
		});
		return generator;
	} catch {
		generatorUnavailable = true;
		return undefined;
	}
}

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

// A fallback desktop Mac Chrome navigation fingerprint matching
// the previous static default setup for deterministic or non-randomized calls.
const CHROME_FALLBACK_HEADERS: Record<string, string> = {
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

function canonicalizeHeaderNames(headers: Record<string, string>): Record<string, string> {
	const canonicalized: Record<string, string> = {};

	for (const key in headers) {
		const value = headers[key];
		if (value === undefined) continue;

		// Retain Client Hints (sec-ch-ua*) in their standard lower-case representation
		if (key.startsWith("sec-ch-ua")) {
			canonicalized[key] = value;
			continue;
		}

		// Retain diagnostics or other HTTP/2 custom lower-case keys
		if (["dnt", "rtt", "ect"].includes(key)) {
			canonicalized[key.toUpperCase()] = value;
			continue;
		}

		// Retain HTTP/2 specific pseudo headers if any, or general standard casing overrides
		if (key === "te") {
			canonicalized.TE = value;
			continue;
		}

		// Pascalize words separated by hyphens (e.g. accept-language -> Accept-Language)
		const pascalized = key
			.split("-")
			.map(part => (part[0] ? part[0].toUpperCase() + part.slice(1).toLowerCase() : ""))
			.join("-");

		canonicalized[pascalized] = value;
	}

	return canonicalized;
}

/**
 * Build a fresh, internally consistent desktop navigation fingerprint for one HTTP request.
 * By default, this randomizes across valid modern versions of Chrome, Firefox, Edge, and Safari
 * using real-world traffic data. Set `randomized` to `false` when a fetch must preserve a
 * stable Mac Chrome identity.
 */
export function buildBrowserNavigationHeaders(options?: { randomized?: boolean }): Record<string, string> {
	const randomized = options?.randomized !== false;
	if (!randomized) {
		return { ...CHROME_FALLBACK_HEADERS };
	}

	const generator = getHeaderGenerator();
	if (!generator) {
		return { ...CHROME_FALLBACK_HEADERS };
	}

	try {
		// Generate realistic, consistent headers with the Bayesian generator
		return canonicalizeHeaderNames(generator.getHeaders());
	} catch {
		// Gracefully recover to the robust default profile on unexpected generator errors
		return { ...CHROME_FALLBACK_HEADERS };
	}
}
