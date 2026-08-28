import { HeaderGenerator } from "header-generator";
import { CHROME_FALLBACK_HEADERS } from "./browser-fingerprint-constants";

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

		if (key.startsWith("sec-ch-ua")) {
			canonicalized[key] = value;
			continue;
		}

		if (["dnt", "rtt", "ect"].includes(key)) {
			canonicalized[key.toUpperCase()] = value;
			continue;
		}

		if (key === "te") {
			canonicalized.TE = value;
			continue;
		}

		const pascalized = key
			.split("-")
			.map(part => (part[0] ? part[0].toUpperCase() + part.slice(1).toLowerCase() : ""))
			.join("-");

		canonicalized[pascalized] = value;
	}

	return canonicalized;
}

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
		return canonicalizeHeaderNames(generator.getHeaders());
	} catch {
		return { ...CHROME_FALLBACK_HEADERS };
	}
}
