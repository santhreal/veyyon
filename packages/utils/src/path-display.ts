/**
 * Browser-safe path display helpers (no node:os/node:path — safe to bundle
 * for web clients). For the homedir-aware CLI variant see coding-agent
 * tools/render-utils.ts shortenPath, which consults the real `os.homedir()`.
 */

/** `/Users/<x>` or `/home/<x>` prefix (the segment must end at `/` or EOS). */
const HOME_PREFIX_RE = /^\/(?:Users|home)\/[^/]+(?=\/|$)/;

export interface ShortenPathDisplayOptions {
	/**
	 * Middle-elide when the path has more segments than this: keep the first
	 * segment and the last two, joined by `/…/`. Omit to never elide.
	 */
	maxSegments?: number;
}

/**
 * Heuristically home-relativize a path for display: `/Users/<x>` or
 * `/home/<x>` becomes `~`, optionally middle-eliding long paths
 * ("~/…/packages/collab-web"). Display-only — never feed the result back
 * into filesystem calls.
 */
export function shortenPathDisplay(p: string, options?: ShortenPathDisplayOptions): string {
	if (typeof p !== "string" || p.length === 0) return "";
	let out = p.replace(HOME_PREFIX_RE, "~");
	const maxSegments = options?.maxSegments;
	if (maxSegments !== undefined) {
		const segs = out.split("/");
		if (segs.length > maxSegments) out = `${segs[0]}/…/${segs.slice(-2).join("/")}`;
	}
	return out;
}
