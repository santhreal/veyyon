/**
 * Strip ALL trailing slashes ("https://host//" → "https://host").
 *
 * The one owner of base-URL trailing-slash normalization: stripping a single
 * slash (`.slice(0, -1)` / `.endsWith("/")` variants) leaves "url//" as
 * "url/", and later `${base}/${path}` joins emit "url//path". Provider
 * base-URL policy (defaults, env fallbacks, suffix trimming) stays local to
 * each provider — this is only the shared primitive underneath.
 */
export function stripTrailingSlashes(value: string): string {
	return value.replace(/\/+$/, "");
}

/**
 * True when `baseUrl` parses to a loopback, RFC1918 private-range, or `.local`
 * mDNS hostname — i.e. a host on the user's own machine or LAN (llama.cpp,
 * vLLM, sglang, LM Studio boxes). Match is on the parsed hostname only;
 * ports, paths, and unparseable URLs return false.
 */
export function hasLocalLoopbackBaseUrl(baseUrl: string | undefined): boolean {
	if (!baseUrl) return false;
	let hostname: string;
	try {
		hostname = new URL(baseUrl).hostname.toLowerCase();
	} catch {
		return false;
	}
	if (
		hostname === "localhost" ||
		hostname === "127.0.0.1" ||
		hostname === "0.0.0.0" ||
		hostname === "::1" ||
		hostname === "[::1]"
	) {
		return true;
	}
	// RFC1918 private IPv4 ranges.
	if (/^10\./.test(hostname)) return true;
	if (/^192\.168\./.test(hostname)) return true;
	if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(hostname)) return true;
	// Common ".local" mDNS hostnames used for home-LAN boxes.
	if (hostname.endsWith(".local")) return true;
	return false;
}
