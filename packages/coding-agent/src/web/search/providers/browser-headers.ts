import { HeaderGenerator } from "header-generator";
import { CHROME_FALLBACK_HEADERS } from "./browser-fingerprint-constants";

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

/** Build a fresh, internally consistent desktop navigation fingerprint for one HTTP request. By default, this randomizes across valid modern versions of Chrome, Firefox, Edge, and Safari */
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
