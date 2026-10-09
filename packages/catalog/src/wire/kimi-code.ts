/**
 * Kimi Code region endpoints, and the API-key envelope that carries a credential's region from the
 * credential store to the request.
 *
 * Kimi Code runs two deployments: mainland China on kimi.com and every other region on kimi.ai. An
 * account belongs to one of them, and a token issued by one deployment's OAuth host is accepted only
 * by that deployment's API host. A mainland credential stores no endpoint and its API key is the bare
 * access token. A global credential stores the global API base in `apiEndpoint`, and its API key is
 * the JSON envelope `{ token, apiEndpoint }`.
 */
import { trimTrailingSlashes } from "@veyyon/utils/url";

export type KimiCodeRegion = "mainland-cn" | "global";

export interface KimiCodeRegionEndpoints {
	/** The region's name in the login's region menu. */
	readonly name: string;
	/** The site an account of the region signs in at, shown beside {@link name}. */
	readonly site: string;
	/** OAuth host of the device-code login and the token refresh. */
	readonly oauthHost: string;
	/** OpenAI-compatible API base. Usage, search and model listing are paths under it. */
	readonly baseUrl: string;
	/** Anthropic-compatible API base, without the `/v1/messages` the Anthropic SDK appends. */
	readonly anthropicBaseUrl: string;
}

/** Every region, in the order the login lists them. The first is the one an empty answer selects. */
export const KIMI_CODE_REGIONS: Readonly<Record<KimiCodeRegion, KimiCodeRegionEndpoints>> = {
	global: {
		name: "Global",
		site: "kimi.ai",
		oauthHost: "https://auth.kimi.ai",
		baseUrl: "https://api.kimi.ai/coding/v1",
		anthropicBaseUrl: "https://api.kimi.ai/coding",
	},
	"mainland-cn": {
		name: "Mainland China",
		site: "kimi.com",
		oauthHost: "https://auth.kimi.com",
		baseUrl: "https://api.kimi.com/coding/v1",
		anthropicBaseUrl: "https://api.kimi.com/coding",
	},
};

const REGIONS = Object.keys(KIMI_CODE_REGIONS) as KimiCodeRegion[];

function regionWhere(field: keyof KimiCodeRegionEndpoints, value: string): KimiCodeRegion | undefined {
	const normalized = trimTrailingSlashes(value.trim()).toLowerCase();
	return REGIONS.find(region => KIMI_CODE_REGIONS[region][field] === normalized);
}

/** The region an OAuth host belongs to, or `undefined` for a host neither deployment serves. */
export function kimiCodeRegionOfOAuthHost(oauthHost: string): KimiCodeRegion | undefined {
	return regionWhere("oauthHost", oauthHost);
}

/** The region an OpenAI-compatible API base belongs to, or `undefined` for a custom endpoint. */
export function kimiCodeRegionOfBaseUrl(baseUrl: string): KimiCodeRegion | undefined {
	return regionWhere("baseUrl", baseUrl);
}

/** The region a stored credential's `apiEndpoint` names. A credential without one is mainland. */
export function kimiCodeRegionOfApiEndpoint(apiEndpoint: string | undefined): KimiCodeRegion {
	return (apiEndpoint === undefined ? undefined : kimiCodeRegionOfBaseUrl(apiEndpoint)) ?? "mainland-cn";
}

/** The `apiEndpoint` a credential issued in `region` stores: none for mainland, the API base otherwise. */
export function kimiCodeApiEndpointOf(region: KimiCodeRegion): string | undefined {
	return region === "mainland-cn" ? undefined : KIMI_CODE_REGIONS[region].baseUrl;
}

/** The API key of a Kimi Code credential: the bare token for mainland, the JSON envelope otherwise. */
export function kimiCodeApiKey(token: string, apiEndpoint: string | undefined): string {
	const region = kimiCodeRegionOfApiEndpoint(apiEndpoint);
	if (region === "mainland-cn") return token;
	return JSON.stringify({ token, apiEndpoint: KIMI_CODE_REGIONS[region].baseUrl });
}

export interface ParsedKimiCodeApiKey {
	/** The bearer token sent in `Authorization`. */
	readonly token: string;
	/** The deployment that issued the token, or `undefined` for a plain token, which names none. */
	readonly region: KimiCodeRegion | undefined;
}

/** Read an API key written by {@link kimiCodeApiKey}. A plain token, such as `KIMI_API_KEY`, names no region. */
export function parseKimiCodeApiKey(apiKey: string): ParsedKimiCodeApiKey {
	if (apiKey.startsWith("{")) {
		let parsed: { token?: unknown; apiEndpoint?: unknown } | null;
		try {
			parsed = JSON.parse(apiKey);
		} catch {
			// Text that only looks like JSON is not an envelope; it is sent as the token, as a plain key is.
			parsed = null;
		}
		if (typeof parsed?.token === "string") {
			const apiEndpoint = typeof parsed.apiEndpoint === "string" ? parsed.apiEndpoint : undefined;
			return { token: parsed.token, region: kimiCodeRegionOfApiEndpoint(apiEndpoint) };
		}
	}
	return { token: apiKey, region: undefined };
}

export interface KimiCodeEndpoint {
	/** The bearer token sent in `Authorization`. */
	readonly apiKey: string;
	/** OpenAI-compatible API base the request goes to. */
	readonly baseUrl: string;
	/** Anthropic-compatible API base of the same deployment. */
	readonly anthropicBaseUrl: string;
}

/**
 * The bearer token and API bases a Kimi Code request uses. The deployment is the one that issued the
 * token, else the one the configured base belongs to, else mainland. An official base of either
 * deployment is replaced by the base of that deployment; a custom base, such as a proxy, is kept.
 */
export function resolveKimiCodeEndpoint(apiKey: string, baseUrl: string | undefined): KimiCodeEndpoint {
	const { token, region: issuedBy } = parseKimiCodeApiKey(apiKey);
	const configured = baseUrl?.trim() || undefined;
	const configuredRegion = configured === undefined ? undefined : kimiCodeRegionOfBaseUrl(configured);
	const endpoints = KIMI_CODE_REGIONS[issuedBy ?? configuredRegion ?? "mainland-cn"];
	return {
		apiKey: token,
		baseUrl: configured !== undefined && configuredRegion === undefined ? configured : endpoints.baseUrl,
		anthropicBaseUrl: endpoints.anthropicBaseUrl,
	};
}
