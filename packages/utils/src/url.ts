export function trimTrailingSlashes(value: string): string {
	return value.replace(/\/+$/, "");
}

export function normalizeBaseUrl(baseUrl: string | undefined, fallback: string): string;
export function normalizeBaseUrl(baseUrl: string | undefined, fallback?: undefined): string | undefined;
export function normalizeBaseUrl(baseUrl: string | undefined, fallback?: string): string | undefined {
	const trimmed = baseUrl?.trim();
	if (trimmed) return trimmed.replace(/[/\s]+$/, "");
	return fallback;
}

export const URL_SCHEME_PREFIX_RE = /^([a-z][a-z0-9+.-]*):\/\//i;

export function hasUrlScheme(value: string): boolean {
	return URL_SCHEME_PREFIX_RE.test(value);
}

export const URI_SCHEME_PREFIX_RE = /^[a-z][a-z0-9+.-]*:/i;

export function hasUriScheme(value: string): boolean {
	return URI_SCHEME_PREFIX_RE.test(value);
}

export function urlScheme(value: string): string | null {
	const match = URL_SCHEME_PREFIX_RE.exec(value);
	return match ? match[1].toLowerCase() : null;
}

export const URL_SCHEME_ANYWHERE_RE = /[a-z][a-z0-9+.-]*:\/\//i;

export function containsUrlScheme(value: string): boolean {
	return URL_SCHEME_ANYWHERE_RE.test(value);
}
